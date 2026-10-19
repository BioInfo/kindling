// Rule-precedence and alert-noise checks against a COPY of a real db. Every
// write happens inside one transaction that is rolled back, so the copy is
// unchanged afterwards. Needs the config env vars (dummy values are fine; no
// network is called):
//   FINANCE_DB_PATH=/path/to/snapshot-copy.db PLAID_CLIENT_ID=x PLAID_SECRET=x \
//   APP_ENC_KEY=$(printf '0%.0s' {1..64}) npx tsx scripts/verify-tidy.mts
const dbPath = process.env.FINANCE_DB_PATH ?? "";
if (!dbPath || /data\/finance\.db$/.test(dbPath)) throw new Error("set FINANCE_DB_PATH to a copy, never the live db");

const { db } = await import("../lib/db.ts");
const { applyRules } = await import("../lib/categorize.ts");
const { POST: createRule } = await import("../app/api/rules/route.ts");
const { NextRequest } = await import("next/server");

const ok = (l: string, c: boolean, extra = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${extra ? " — " + extra : ""}`); if (!c) process.exitCode = 1; };
const d = db();
const rule = d.prepare(`INSERT INTO rules (match_type, pattern, field, category, entity, rename, priority, source) VALUES (?,?,?,?,?,?,?,?)`);
const insTxn = d.prepare(
  `INSERT INTO transactions (id, account_id, date, name, merchant, amount, category, category_source, confidence)
   VALUES (?, (SELECT id FROM accounts LIMIT 1), '2026-01-01', ?, ?, 1, 'Shopping', 'plaid', 0.5)`,
);
const cat = (id: string) => (d.prepare(`SELECT category FROM transactions WHERE id=?`).get(id) as { category: string }).category;

d.exec("BEGIN");
try {
  // ---- Task 2: rule precedence + per-field merge.
  rule.run("contains", "zzverify llm", "merchant", "Dining", null, null, 50, "llm");
  rule.run("contains", "zzverify llm", "merchant", "Groceries", null, null, 100, "manual");
  ok("user rule (priority 100) beats LLM rule (priority 50)", applyRules("zzverify llm", "x").category === "Groceries",
    `got ${applyRules("zzverify llm", "x").category}`);

  // Real rules on the snapshot: 145 (manual, prio 10, category only) and 141
  // (manual, prio 100, rename). Both should apply.
  const jl = applyRules("Jiffy Lube", "JIFFY LUBE #1234");
  ok("Jiffy Lube: category from rule 145 and rename from rule 141 both apply", jl.category === "Transportation" && jl.rename === "Jiffy Lube",
    JSON.stringify(jl));
  // LLM rule 6 (merchant "Pennymac") used to shadow user rule 61's rename.
  const pm = applyRules("Pennymac", "PENNYMAC CASH");
  ok("PennyMac: user rule 61's rename survives LLM rule 6", pm.rename === "PennyMac Mortgage", JSON.stringify(pm));

  // ---- Task 2: "apply now" honours match type and treats % / _ literally.
  insTxn.run("zzv-1", "ZZEXACT", "zzexact");
  insTxn.run("zzv-2", "ZZEXACT PLUS", "zzexact plus");
  insTxn.run("zzv-3", "ZZAXB", "zzaxb");
  insTxn.run("zzv-4", "ZZA_B", "zza_b");
  const post = (b: object) => createRule(new NextRequest("http://local/api/rules", { method: "POST", body: JSON.stringify(b) }));
  await post({ match_type: "exact", pattern: "zzexact", category: "Travel", applyNow: true });
  ok("apply-now exact rule changes only the exact match", cat("zzv-1") === "Travel" && cat("zzv-2") === "Shopping",
    `zzexact=${cat("zzv-1")} zzexact plus=${cat("zzv-2")}`);
  await post({ match_type: "contains", pattern: "zza_b", category: "Travel", applyNow: true });
  ok("apply-now treats _ literally", cat("zzv-4") === "Travel" && cat("zzv-3") === "Shopping",
    `zza_b=${cat("zzv-4")} zzaxb=${cat("zzv-3")}`);
} finally {
  d.exec("ROLLBACK");
}
