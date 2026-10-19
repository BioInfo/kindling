// Subscriptions surface checks against a COPY of a real snapshot. The db is
// mutated (reconcile, merges, edits), so point FINANCE_DB_PATH at a scratch copy.
// No network: fetch is replaced before anything loads; the LLM pass gets a stub.
//   cp data/review/snapshot-YYYYMMDD.db /tmp/vs.db
//   FINANCE_DB_PATH=/tmp/vs.db PLAID_CLIENT_ID=x PLAID_SECRET=x \
//   APP_ENC_KEY=$(printf '0%.0s' {1..64}) npx tsx scripts/verify-subscriptions.mts
// SUBS_LIB=<dir> runs the same checks against another copy of lib/ (the
// pre-change code), to show which checks the old behaviour fails.
const dbPath = process.env.FINANCE_DB_PATH ?? "";
if (!dbPath || /(^|\/)finance\.db$/.test(dbPath)) throw new Error("set FINANCE_DB_PATH to a scratch copy, never finance.db");

let fetchCalls = 0;
let llmReply: ((body: { messages: { content: string }[] }) => string) | null = null;
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  fetchCalls++;
  if (!llmReply) throw new Error("network blocked in verify-subscriptions");
  const body = JSON.parse(init?.body ?? "{}");
  return new Response(JSON.stringify({ choices: [{ message: { content: llmReply(body) }, finish_reason: "stop" }] }), { status: 200 });
}) as typeof fetch;

const LIB = process.env.SUBS_LIB ?? new URL("../lib", import.meta.url).pathname;
const subsMod = await import(`${LIB}/subscriptions.ts`);
const enrichMod = await import(`${LIB}/enrich.ts`).catch(() => null);
const { db } = await import(`${LIB}/db.ts`);
const { reconcileSubscriptions, listSubscriptions, updateSubscription } = subsMod;

let fails = 0;
const ok = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!cond) fails++;
};
const check = async (label: string, fn: () => unknown | Promise<unknown>) => {
  try { await fn(); } catch (e) { ok(label, false, `threw: ${e instanceof Error ? e.message : String(e)}`); }
};
const tidy = async () => {
  if (enrichMod) return enrichMod.postSyncEnrich({ llm: false });
  await reconcileSubscriptions({ plaid: false });
  return null;
};

type Row = { id: string; merchant: string; entity: string; type: string | null; category: string | null; cadence: string;
  monthly: number; isActive: boolean; state: string; group?: string; aliases?: { merchant: string }[]; lastDate: string | null };
const view = () => listSubscriptions(null) as { subs: Row[]; monthlyTotal: number; billsMonthly?: number; obligationsMonthly?: number; transfersMonthly?: number };
const grp = (s: Row) => s.group ?? (!s.isActive ? "ended" : s.type === "obligation" ? "bills" : "subs");
const live = (s: Row) => s.state === "active" || s.state === "trial";

const first = await tidy();
const v = view();
const personal = v.subs.filter((s) => s.entity === "personal");

await check("merge", () => {
  const services: [string, RegExp][] = [
    ["Anthropic", /anthropic/i], ["Microsoft", /microsoft/i], ["Google Workspace", /google work|workspace/i],
    ["OpenAI", /openai/i], ["Vercel", /vercel/i], ["exe.dev", /exe\.?dev|^e dev$/i], ["Zoom", /zoom/i],
    ["Verizon", /verizon/i], ["PennyMac", /pennymac/i], ["Prudent Pet", /prudent pet/i], ["Prosper", /prosper/i],
    ["Kindle", /kindle/i], ["X", /^x$|x corp/i],
  ];
  for (const [name, re] of services) {
    const rows = personal.filter((s) => re.test(s.merchant));
    ok(`merged: ${name} is one row`, rows.length === 1, rows.map((r) => r.merchant).join(" + "));
  }
  const uber = db().prepare(`SELECT entity, merged_into FROM subscriptions WHERE merchant = 'Uber'`).all() as { entity: string; merged_into: string | null }[];
  ok("not merged across entities: Uber personal and business stay two rows", uber.length === 2 && uber.every((u) => !u.merged_into), uber.map((u) => u.entity).join(","));
});

await check("types", () => {
  const TYPES = new Set(["subscription", "bill", "membership", "transfer"]);
  const open = v.subs.filter((s) => grp(s) !== "ended");
  const untyped = open.filter((s) => !s.type || !TYPES.has(s.type));
  ok("rules type every live row but a short tail", untyped.length <= 3, `${untyped.length}: ${untyped.map((s) => s.merchant).join(", ")}`);
  const raw = v.subs.filter((s) => s.category && /^[A-Z_]+$/.test(s.category) && s.category.includes("_") || s.category === "OTHER");
  ok("no raw Plaid category codes on any row", raw.length === 0, raw.map((s) => `${s.merchant}=${s.category}`).join(", "));
  const vercel = personal.find((s) => /vercel/i.test(s.merchant));
  const x = personal.find((s) => /^x$|x corp/i.test(s.merchant));
  ok("Vercel and X are not Dining", vercel?.category !== "Dining" && x?.category !== "Dining", `${vercel?.category} / ${x?.category}`);
});

await check("transfers", () => {
  // The house cleaner (paid by Zelle) and the JPMorgan payment are bills by ruling.
  const re = /invest529|529|fundrise|zelle|venmo|greenlight|prosper/i;
  const rows = v.subs.filter((s) => re.test(s.merchant) && !/espericueta/i.test(s.merchant));
  const wrong = rows.filter((s) => !["transfers", "ended"].includes(grp(s)));
  ok("529, Fundrise, Zelle, Venmo, Greenlight, Prosper are transfers", rows.length >= 6 && wrong.length === 0,
    wrong.map((s) => `${s.merchant}→${grp(s)}`).join(", ") || `${rows.length} rows`);
  const heroSum = Math.round(v.subs.filter((s) => grp(s) === "subs" && live(s)).reduce((a, s) => a + s.monthly, 0) * 100) / 100;
  ok("hero = sum of live subscription rows only", Math.abs(heroSum - v.monthlyTotal) < 0.02, `${heroSum} vs ${v.monthlyTotal}`);
  const billSum = v.subs.filter((s) => grp(s) === "bills" && live(s)).reduce((a, s) => a + s.monthly, 0);
  const bills = v.billsMonthly ?? v.obligationsMonthly ?? 0;
  ok("bills total holds no transfer", Math.abs(billSum - bills) < 0.02 && rows.every((s) => grp(s) !== "bills"), `${bills}`);
  ok("transfers carry their own subtotal", typeof v.transfersMonthly === "number" && v.transfersMonthly > 0, String(v.transfersMonthly));
});

await check("annual fee", () => {
  const amex = v.subs.filter((s) => /amex membership renewal|renewal membership/i.test(s.merchant)
    || (s.aliases ?? []).some((a) => /amex membership renewal/i.test(a.merchant)));
  const a = amex[0];
  ok("AMEX renewal fee is yearly, monthly = annual/12", !!a && a.cadence === "yearly" && a.monthly < 100, a ? `${a.cadence} ${a.monthly}/mo` : "missing");
});

await check("ended", () => {
  const ended = v.subs.filter((s) => grp(s) === "ended");
  ok("lapsed rows sit in Ended", ["Hulu", "Quantconnect", "Buffer Plan"].every((m) => ended.some((s) => s.merchant === m)), ended.length + " ended");
  const stale = v.subs.filter((s) => grp(s) !== "ended" && s.lastDate && (Date.now() - Date.parse(s.lastDate)) / 864e5 > 400);
  ok("no row older than a year outside Ended", stale.length === 0, stale.map((s) => s.merchant).join(", "));
  const r = db().prepare(`SELECT is_active FROM subscriptions WHERE id = 'personal:expense:chipotle mexican grill'`).get() as { is_active: number } | undefined;
  ok("a row reconcile stops finding is ended in the table", r?.is_active === 0, JSON.stringify(r));
  ok("ended rows add nothing to the hero", !ended.some((s) => grp(s) === "subs"));
});

await check("live fixes 2026-10-18", async () => {
  type R = Row & { displayName?: string; oneOffs?: { count: number; total: number } | null; streams?: { live: boolean }[] };
  const subs = v.subs as R[];
  const find = (re: RegExp) => subs.find((s) => re.test(s.merchant) || re.test(s.displayName ?? ""));
  const rec = await import(`${LIB}/recurring.ts`);
  if (rec.isCardPayoff) {
    const pay = ["CHASE CREDIT CRD AUTOPAY", "AMEX EPAYMENT ACH PMT", "CITI AUTOPAY PAYMENT", "CAPITAL ONE CRCARDPMT", "BARCLAYCARD US CREDITCARD"];
    ok("card payoffs are recognised by descriptor", pay.every((d) => rec.isCardPayoff(d)), pay.filter((d) => !rec.isCardPayoff(d)).join(", "));
    ok("an insurance autopay filed as a card payment is not a payoff", !rec.isCardPayoff("USAA P&C AUTOPAY"));
  } else ok("isCardPayoff exists", false);
  const usaa = find(/usaa p.?c/i);
  ok("USAA P&C autopay is a live bill", usaa?.group === "bills" && (usaa?.monthly ?? 0) > 200, `${usaa?.group} ${usaa?.monthly}`);
  ok("card payoffs stay off the surface", !subs.some((s) => /credit crd autopay|amex epayment/i.test(s.merchant)));
  const exe = find(/exe\.?dev/i);
  ok("a handed-off descriptor adds nothing (exe.dev = one $20 plan)", !!exe && exe.monthly < 25, String(exe?.monthly));
  const pm = find(/pennymac/i);
  ok("PennyMac merged rows count one mortgage", !!pm && Math.abs(pm.monthly - 6843.12) < 1, String(pm?.monthly));
  const jpm = find(/jpmorgan chase ext/i);
  ok("JPMorgan Chase Ext Trnsfr is a bill", jpm?.group === "bills", String(jpm?.group));
  ok("no near-zero rows in any group", !subs.some((s) => s.monthly < 1), subs.filter((s) => s.monthly < 1).map((s) => s.merchant).join(", "));
  const ro = find(/ro health/i);
  ok("Ro Health monthly leaves out the $888 one-off", !!ro && ro.monthly < 600 && (ro.oneOffs?.total ?? 0) >= 888, `${ro?.monthly} ${JSON.stringify(ro?.oneOffs)}`);
  const kin = find(/kindle/i);
  ok("Kindle monthly leaves out book purchases", !!kin && kin.monthly < 30, `${kin?.monthly}`);
  const apple = find(/^apple/i);
  ok("Apple monthly leaves out app purchases and stopped plans", !!apple && apple.monthly < 40, String(apple?.monthly));
  const uberSubs = subs.filter((s) => /uber/i.test(s.merchant) && s.group === "subs");
  ok("Uber rides are not a subscription", uberSubs.length === 0, uberSubs.map((s) => `${s.entity} ${s.monthly}`).join(", "));
  const maria = find(/espericueta|house cleaning/i);
  ok("the house cleaner is a Home bill", maria?.group === "bills" && maria?.category === "Home" && maria?.displayName === "House cleaning (Maria)",
    `${maria?.group} ${maria?.category} ${maria?.displayName}`);
  ok("no Venmo descriptor merged into the cleaner", !(maria?.aliases ?? []).some((a) => /venmo/i.test(a.merchant)));
});


await check("user edits survive", async () => {
  const edited = v.subs.find((s) => /hetzner/i.test(s.merchant))!; // any live row will do
  const peacock = v.subs.find((s) => /peacock/i.test(s.merchant))!;
  updateSubscription(edited.id, { type: "bill", category: "Travel" });
  updateSubscription(peacock.id, { merchant: "Peacock Premium", type: "membership" });
  const xdev = db().prepare(`SELECT id FROM subscriptions WHERE merchant = 'X Developer Platform'`).get() as { id: string };
  const xroot = personal.find((s) => /^x$|x corp/i.test(s.merchant))!;
  const vercelAlias = db().prepare(`SELECT id FROM subscriptions WHERE merchant = 'Vercel' AND merged_into IS NOT NULL`).get() as { id: string } | undefined;
  ok("user merge accepted", !!subsMod.mergeSubscription?.(xdev.id, xroot.id));
  ok("unmerge accepted", !!vercelAlias && !!subsMod.unmergeSubscription?.(vercelAlias.id));
  await tidy(); await reconcileSubscriptions({ plaid: false }); await tidy();
  const after = view().subs;
  const u = after.find((s) => s.id === edited.id);
  ok("user type + category survive reconcile and enrich", u?.type === "bill" && u?.category === "Travel", `${u?.type}/${u?.category}`);
  const p = after.find((s) => s.id === peacock.id);
  ok("user rename + type survive", p?.merchant === "Peacock Premium" && p?.type === "membership", `${p?.merchant}/${p?.type}`);
  const xd = db().prepare(`SELECT merged_into FROM subscriptions WHERE id = ?`).get(xdev.id) as { merged_into: string | null };
  ok("user merge survives", xd.merged_into === xroot.id);
  const va = db().prepare(`SELECT merged_into, merge_lock FROM subscriptions WHERE id = ?`).get(vercelAlias?.id ?? "") as { merged_into: string | null; merge_lock: number } | undefined;
  ok("unmerge survives (auto pass does not re-merge)", va?.merged_into === null && va?.merge_lock === 1, JSON.stringify(va));
  const dism = db().prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE state = 'dismissed'`).get() as { n: number };
  ok("dismissed rows stay dismissed", dism.n >= 4 && !after.some((s) => /tatte|airbnb/i.test(s.merchant)), String(dism.n));
});

await check("idempotent", async () => {
  if (!enrichMod) { ok("postSyncEnrich exists", false); return; }
  const r = await enrichMod.postSyncEnrich({ llm: false });
  ok("second enrich pass changes nothing", r.merged === 0 && r.typed === 0 && r.categorized === 0 && r.errors.length === 0, JSON.stringify(r));
  ok("enrich without LLM is fast", r.ms < 2000, `${r.ms}ms`);
  const merged = (db().prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE merged_into IS NOT NULL`).get() as { n: number }).n;
  ok("descriptors are merged (this pass or an earlier one)", merged > 0, `${merged} aliases; first pass ${JSON.stringify(first)}`);
});

await check("llm batch", async () => {
  if (!enrichMod) { ok("postSyncEnrich exists", false); return; }
  db().prepare(`UPDATE subscriptions SET type = NULL, type_source = NULL WHERE merchant IN ('Nanonoble Pte. Ltd.', 'Amazon')`).run();
  const userBefore = db().prepare(`SELECT id, type FROM subscriptions WHERE type_source = 'user'`).all() as { id: string; type: string }[];
  let seen = 0;
  fetchCalls = 0;
  llmReply = (body) => {
    const items = JSON.parse(body.messages[body.messages.length - 1].content) as { id: string }[];
    seen = items.length;
    return JSON.stringify(items.map((i) => ({ id: i.id, type: "subscription", category: "Shopping" })));
  };
  const r = await enrichMod.postSyncEnrich({ llm: true });
  ok("LLM batch: one sequential call, capped at 20 rows", fetchCalls === 1 && seen > 0 && seen <= 20, `calls=${fetchCalls} rows=${seen}`);
  ok("LLM batch filled the untyped rows", (r.llm?.updated ?? 0) >= 2, JSON.stringify(r.llm));
  const userAfter = db().prepare(`SELECT id, type FROM subscriptions WHERE type_source = 'user'`).all() as { id: string; type: string }[];
  ok("LLM never overwrites a user edit", JSON.stringify(userBefore) === JSON.stringify(userAfter));
  llmReply = () => { throw new Error("gateway down"); };
  // Amazon is a registry brand now, so the rules label it; Nanonoble still goes to the LLM.
  db().prepare(`UPDATE subscriptions SET type = NULL, type_source = NULL WHERE merchant = 'Nanonoble Pte. Ltd.'`).run();
  let threw = false;
  const r2 = await enrichMod.postSyncEnrich({ llm: true }).catch(() => { threw = true; return null; });
  ok("gateway failure: enrich resolves, reports the error", !threw && !!r2 && r2.errors.length > 0, JSON.stringify(r2?.errors));
  llmReply = null;
});

await check("category-seeded noise 2026-10-18", async () => {
  type R = Row & { displayName?: string; count?: number };
  const subs = view().subs as R[];
  const name = (s: R) => s.displayName ?? s.merchant;
  const prime = subs.find((s) => /amazon prime/i.test(name(s)));
  ok("Amazon Prime is the yearly fee, not $139/mo", !!prime && prime.cadence === "yearly" && prime.monthly < 20, `${prime?.cadence} ${prime?.monthly}`);
  const single = subs.filter((s) => s.isActive && s.count === 1 && s.cadence !== "yearly");
  ok("no single-charge row is live unless yearly", !single.length, single.map(name).join(", "));
  const shop = subs.filter((s) => grp(s) === "subs" && (/^amazon$/i.test(name(s)) || /^kindle$/i.test(name(s))));
  ok("Amazon marketplace and Kindle book purchases are not subscriptions", !shop.length, shop.map((s) => `${name(s)} ${s.monthly}`).join(", "));
  const ku = subs.find((s) => /kindle unlimited/i.test(name(s)));
  ok("Kindle Unlimited stays a live subscription", !!ku && grp(ku) === "subs" && ku.monthly > 5, `${ku?.monthly}`);
  const ro = subs.find((s) => /ro health/i.test(name(s)));
  ok("Ro Health is a Healthcare bill, out of the hero", ro?.type === "bill" && ro?.category === "Healthcare" && grp(ro) !== "subs" && ro.monthly < 600, `${ro?.type} ${ro?.category} ${ro?.monthly}`);
  db().prepare(`UPDATE subscriptions SET state = 'active' WHERE merchant LIKE '%wawa%' AND state = 'dismissed'`).run();
  const rec = await import(`${LIB}/recurring.ts`);
  const wawa = (rec.detectRecurring() as { merchant: string }[]).filter((r) => /wawa/i.test(r.merchant));
  ok("Wawa store visits are not detected as recurring, even undismissed", !wawa.length, wawa.map((r) => r.merchant).join(", "));
});

await check("type override moves a row cleanly", async () => {
  const m = db().prepare(`SELECT id FROM subscriptions WHERE merchant LIKE '%ESPERICUETA%' AND merged_into IS NULL`).get() as { id: string } | undefined;
  if (!m) { ok("cleaner row present", false); return; }
  const at = () => (view().subs as Row[]).find((s) => s.id === m.id);
  updateSubscription(m.id, { type: "transfer" });
  await tidy();
  const a = at();
  ok("override to transfer lands in Transfers with a Transfer category", a?.group === "transfers" && !!a?.category?.startsWith("Transfer"), `${a?.group} ${a?.category}`);
  updateSubscription(m.id, { type: "bill" });
  await tidy();
  const b = at();
  ok("override back to bill lands in Bills with a non-transfer category", b?.group === "bills" && !b?.category?.startsWith("Transfer"), `${b?.group} ${b?.category}`);
});


const fv = view();
const by = (g: string) => fv.subs.filter((s) => grp(s) === g);
console.log(`\nsnapshot after: hero ${fv.monthlyTotal}/mo · bills ${fv.billsMonthly ?? fv.obligationsMonthly} · transfers ${fv.transfersMonthly ?? "n/a"} · rows subs ${by("subs").length} bills ${by("bills").length} transfers ${by("transfers").length} ended ${by("ended").length}`);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exitCode = fails ? 1 : 0;
