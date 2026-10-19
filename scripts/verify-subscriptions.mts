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
  const uber = v.subs.filter((s) => /^uber$/i.test(s.merchant));
  ok("not merged across entities: Uber personal and business stay two rows", uber.length === 2, uber.map((u) => u.entity).join(","));
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
  const re = /invest529|529|fundrise|zelle|ext trnsfr|venmo|greenlight|prosper/i;
  const rows = v.subs.filter((s) => re.test(s.merchant));
  const wrong = rows.filter((s) => !["transfers", "ended"].includes(grp(s)));
  ok("529, Fundrise, Zelle, Chase ext transfer, Venmo, Greenlight, Prosper are transfers", rows.length >= 7 && wrong.length === 0,
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

await check("user edits survive", async () => {
  const uberBiz = v.subs.find((s) => /^uber$/i.test(s.merchant) && s.entity === "business")!;
  const peacock = v.subs.find((s) => /peacock/i.test(s.merchant))!;
  updateSubscription(uberBiz.id, { type: "bill", category: "Travel" });
  updateSubscription(peacock.id, { merchant: "Peacock Premium", type: "membership" });
  const xdev = db().prepare(`SELECT id FROM subscriptions WHERE merchant = 'X Developer Platform'`).get() as { id: string };
  const xroot = personal.find((s) => /^x$|x corp/i.test(s.merchant))!;
  const vercelAlias = db().prepare(`SELECT id FROM subscriptions WHERE merchant = 'Vercel' AND merged_into IS NOT NULL`).get() as { id: string } | undefined;
  ok("user merge accepted", !!subsMod.mergeSubscription?.(xdev.id, xroot.id));
  ok("unmerge accepted", !!vercelAlias && !!subsMod.unmergeSubscription?.(vercelAlias.id));
  await tidy(); await reconcileSubscriptions({ plaid: false }); await tidy();
  const after = view().subs;
  const u = after.find((s) => s.id === uberBiz.id);
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
  ok("first pass did real work", !!first && first.merged > 0, JSON.stringify(first));
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
  db().prepare(`UPDATE subscriptions SET type = NULL, type_source = NULL WHERE merchant = 'Amazon'`).run();
  let threw = false;
  const r2 = await enrichMod.postSyncEnrich({ llm: true }).catch(() => { threw = true; return null; });
  ok("gateway failure: enrich resolves, reports the error", !threw && !!r2 && r2.errors.length > 0, JSON.stringify(r2?.errors));
  llmReply = null;
});

const fv = view();
const by = (g: string) => fv.subs.filter((s) => grp(s) === g);
console.log(`\nsnapshot after: hero ${fv.monthlyTotal}/mo · bills ${fv.billsMonthly ?? fv.obligationsMonthly} · transfers ${fv.transfersMonthly ?? "n/a"} · rows subs ${by("subs").length} bills ${by("bills").length} transfers ${by("transfers").length} ended ${by("ended").length}`);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exitCode = fails ? 1 : 0;
