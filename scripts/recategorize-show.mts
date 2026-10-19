// Print planned changes for chosen moves, for spot checks. Reads the LLM cache,
// so it is free after a dry run; writes nothing to transactions or rules.
//   FINANCE_DB_PATH=... npx tsx scripts/recategorize-show.mts "Insurance->CreditCardPayment" "Transfer:Internal->*"
//   FINANCE_DB_PATH=... npx tsx scripts/recategorize-show.mts --random 20
if (!process.env.FINANCE_DB_PATH) throw new Error("set FINANCE_DB_PATH explicitly");
const R = await import("../lib/recategorize.ts");
const rules = R.loadRules().filter((r) => r.source !== "llm");
const plans = await R.planRows(R.loadTxns(), { llm: true, rules, maxLlmCalls: 0 });
const changes = R.diffPlans(plans).filter((c) => c.before.category !== c.after.category);
const byId = new Map(plans.map((p) => [p.row.id, p]));
const ri = process.argv.indexOf("--random");
let pick = changes;
if (ri > 0) {
  const n = Number(process.argv[ri + 1] ?? 20);
  const seed = (s: string) => [...s].reduce((h, ch) => (h * 131 + ch.charCodeAt(0)) >>> 0, 11);
  pick = [...changes].sort((a, b) => seed(a.id) - seed(b.id)).slice(0, n);
} else {
  const pats = process.argv.slice(2).map((p) => p.split("->"));
  pick = changes.filter((c) => pats.some(([a, b]) => (a === "*" || a === c.before.category) && (b === "*" || b === c.after.category)));
}
for (const c of pick) {
  const p = byId.get(c.id)!, t = p.row;
  const rc = p.receipt ? ` | receipt: ${p.receipt.labels.join(" / ")} ${p.receipt.items.slice(0, 3).map((i) => i.name).join("; ")}` : "";
  console.log(`${t.date} ${String(t.amount).padStart(9)} ${(t.name ?? "").slice(0, 38).padEnd(38)} ${(t.merchant ?? "-").slice(0, 20).padEnd(20)} ${t.plaid_detailed ?? ""} | ${c.before.category} -> ${c.after.category} ${c.after.confidence} ${c.after.reason}${rc}`.slice(0, 260));
}
console.log(`${pick.length} of ${changes.length} category changes`);
