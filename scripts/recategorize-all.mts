// Full recategorization pass + rules audit. Dry run by default.
//
//   FINANCE_DB_PATH=/path/copy.db npx tsx scripts/recategorize-all.mts            # dry run
//   FINANCE_DB_PATH=/path/copy.db npx tsx scripts/recategorize-all.mts --apply    # write
//   flags: --no-llm (deterministic signals only), --receipts (fetch Gmail/CSV receipts first;
//          needs ORDERS_GMAIL_ACCOUNT), --sample N (default 40)
//
// A dry run writes no transaction or rule. It does keep the receipt tables and
// the LLM answer cache, so --apply writes exactly what the dry run printed.
// Idempotent: a second --apply reports 0 changes.
//
// Never writes a category_source='manual' row and never deletes a manual rule;
// those come out as a list for the owner.
const apply = process.argv.includes("--apply");
const useLlm = !process.argv.includes("--no-llm");
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
if (!process.env.FINANCE_DB_PATH) throw new Error("set FINANCE_DB_PATH explicitly");

const { db } = await import("../lib/db.ts");
const R = await import("../lib/recategorize.ts");
const O = await import("../lib/orders.ts");
const { REVIEW_WHERE } = await import("../lib/categorize.ts");
const d = db();

if (process.argv.includes("--receipts")) {
  if (process.env.ORDERS_GMAIL_ACCOUNT) console.log("gmail receipts:", await O.fetchGmailReceipts({ sinceDays: 400 }));
  console.log("csv receipts:", O.importOrdersCsv());
}
O.ensureOrdersSchema();
console.log("receipt match:", O.matchReceipts());

const reviewBefore = (d.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${REVIEW_WHERE}`).get() as { n: number }).n;

// --- plan every row with user rules only; LLM rules are re-derived and audited
const allRules = R.loadRules();
const userRules = allRules.filter((r) => r.source !== "llm");
const rows = R.loadTxns();
const plans = await R.planRows(rows, { llm: useLlm, rules: userRules });
const changes = R.diffPlans(plans);
const byId = new Map(plans.map((p) => [p.row.id, p]));

// --- before / after per category
const before = new Map<string, number>(), after = new Map<string, number>();
const changed = new Map(changes.map((c) => [c.id, c]));
for (const p of plans) {
  const b = p.row.category ?? "(none)";
  before.set(b, (before.get(b) ?? 0) + 1);
  const a = changed.get(p.row.id)?.after.category ?? b;
  after.set(a, (after.get(a) ?? 0) + 1);
}
const cats = [...new Set([...before.keys(), ...after.keys()])].sort((x, y) => (after.get(y) ?? 0) - (after.get(x) ?? 0));
console.log(`\n== Categories (${rows.length} rows; ${changes.length} change; llm=${useLlm})`);
console.log("category".padEnd(20), "before".padStart(7), "after".padStart(7), "delta".padStart(7));
for (const c of cats) {
  const b = before.get(c) ?? 0, a = after.get(c) ?? 0;
  console.log(c.padEnd(20), String(b).padStart(7), String(a).padStart(7), (a - b > 0 ? "+" : "") + String(a - b).padStart(6));
}

// --- moves, grouped
const moves = new Map<string, number>();
for (const c of changes) {
  if (c.before.category === c.after.category) continue;
  const k = `${c.before.category ?? "(none)"} -> ${c.after.category}`;
  moves.set(k, (moves.get(k) ?? 0) + 1);
}
console.log(`\n== Category moves (${[...moves.values()].reduce((a, b) => a + b, 0)} rows; the rest change source/confidence/merchant only)`);
for (const [k, n] of [...moves.entries()].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), k);

const reasons = new Map<string, number>();
for (const c of changes) {
  const k = c.after.reason.split(":")[0].replace(/#\d+$/, "");
  reasons.set(k, (reasons.get(k) ?? 0) + 1);
}
console.log("\n== Deciding signal for changed rows:", Object.fromEntries(reasons));

// --- deterministic sample
const N = Number(arg("--sample") ?? 40);
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
const sample = changes.filter((c) => c.before.category !== c.after.category || c.before.merchant !== c.after.merchant)
  .sort((a, b) => hash(a.id) - hash(b.id)).slice(0, N);
console.log(`\n== Sample of ${sample.length} changes`);
for (const c of sample) {
  const t = byId.get(c.id)!.row;
  const m = (c.after.merchant ?? null) !== c.before.merchant ? `  merchant: ${c.before.merchant ?? "-"} -> ${c.after.merchant ?? "-"}` : "";
  console.log(`${t.date} ${String(t.amount).padStart(9)} ${(t.name ?? "").slice(0, 34).padEnd(34)} ${String(c.before.category).padEnd(16)} -> ${c.after.category.padEnd(14)} ${c.after.confidence.toFixed(2)} ${c.after.reason.slice(0, 50)}${m}`);
}

// --- manual picks to check
const flags = R.flagManualPicks(plans);
console.log(`\n== Manual picks the evidence disagrees with (${flags.length}; never written)`);
for (const f of flags) console.log(`${f.date} ${String(f.amount).padStart(9)} ${(f.name ?? "").slice(0, 40).padEnd(40)} manual=${f.manual.padEnd(16)} suggest=${f.suggested.padEnd(14)} ${f.confidence.toFixed(2)} ${f.why.slice(0, 40)}`);

// --- rules audit
const audit = R.auditRules(allRules, plans);
console.log(`\n== Rules audit: delete ${audit.deletes.length} LLM rules, add ${audit.adds.length}, flag ${audit.manualFlags.length} manual rules`);
for (const x of audit.deletes) console.log(`  delete #${x.rule.id} "${x.rule.pattern}" -> ${x.rule.category}: ${x.why}`);
for (const x of audit.adds) console.log(`  add    "${x.pattern}" -> ${x.category} (${x.rows} rows)`);
for (const x of audit.manualFlags) console.log(`  manual #${x.rule.id} "${x.rule.pattern}" -> ${x.rule.category}: ${x.why}`);

const amz = plans.filter((p) => O.AMAZON_TXN.test(`${p.row.name} ${p.row.merchant}`) && p.row.amount > 0);
console.log(`\n== Amazon-family charges: ${amz.length}; with a matched receipt: ${amz.filter((p) => p.receipt).length}`);

if (apply) {
  const n = R.writeChanges(changes);
  const r = R.applyRuleAudit(audit);
  const reviewAfter = (d.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${REVIEW_WHERE}`).get() as { n: number }).n;
  console.log(`\nAPPLIED: ${n} transactions updated; rules deleted ${r.deleted}, added ${r.added}. To-Review ${reviewBefore} -> ${reviewAfter}`);
} else {
  console.log(`\nDRY RUN: nothing written to transactions or rules. To-Review now ${reviewBefore}. Re-run with --apply.`);
}
