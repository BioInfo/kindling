// One-off, idempotent: move every non-manual transaction whose category is not
// in the app taxonomy (raw Plaid OTHER / TRANSFER_OUT / LOAN_PAYMENTS…, and the
// legacy Food / Bills / Transport / Health labels) onto a CATEGORIES value, and
// relabel rules that still hold a legacy label. Hand-set rows
// (category_source='manual') are never touched.
//
// Dry run by default (runs inside a transaction, prints, rolls back):
//   FINANCE_DB_PATH=/path/to/copy.db npx tsx scripts/relabel-categories.mts
// Write it:
//   FINANCE_DB_PATH=data/finance.db npx tsx scripts/relabel-categories.mts --apply
const apply = process.argv.includes("--apply");
if (!process.env.FINANCE_DB_PATH) throw new Error("set FINANCE_DB_PATH explicitly");

const { db } = await import("../lib/db.ts");
const { CATEGORIES, mapPfc } = await import("../lib/taxonomy.ts");
const { applyRules } = await import("../lib/categorize.ts");

const CATS = new Set<string>(CATEGORIES);
// Unambiguous legacy labels. "Bills" is not: it covered a mortgage, a lending
// platform and an ISBN purchase, so it resolves from Plaid's detailed category.
const LEGACY: Record<string, string> = { Food: "Dining", Transport: "Transportation", Health: "Healthcare" };

const d = db();
const counts = () => new Map(
  (d.prepare(`SELECT COALESCE(category,'(null)') AS c, COUNT(*) AS n FROM transactions GROUP BY 1`).all() as
    { c: string; n: number }[]).map((r) => [r.c, r.n]),
);
const before = counts();

d.exec("BEGIN");
try {
  // --- Rules first, so rule-sourced rows re-derive from the relabelled rules.
  const rules = d.prepare(`SELECT id, pattern, field, category FROM rules WHERE category IS NOT NULL`).all() as
    { id: number; pattern: string; field: string; category: string }[];
  const setRuleCat = d.prepare(`UPDATE rules SET category=? WHERE id=?`);
  for (const r of rules) {
    if (CATS.has(r.category)) continue;
    let next: string | null = LEGACY[r.category] ?? null;
    if (!next) {
      // Most common decisive mapping among the rows this rule labelled.
      const rows = d.prepare(
        `SELECT plaid_category AS p, plaid_detailed AS dt FROM transactions WHERE category=? AND category_source='rule'
           AND instr(lower(${r.field === "name" ? "name" : "COALESCE(NULLIF(merchant,''),name)"}), lower(?)) > 0`,
      ).all(r.category, r.pattern) as { p: string | null; dt: string | null }[];
      const tally = new Map<string, number>();
      for (const x of rows) {
        const m = mapPfc(x.p, x.dt);
        if (m && m !== "Other") tally.set(m, (tally.get(m) ?? 0) + 1);
      }
      next = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    // No decisive mapping: drop the category, keep the rule's rename/entity job.
    setRuleCat.run(next, r.id);
    console.log(`rule ${r.id} "${r.pattern}": ${r.category} -> ${next ?? "(no category)"}`);
  }

  // --- Transactions.
  const rows = d.prepare(
    `SELECT id, name, json_extract(raw,'$.merchant_name') AS rawMerchant, category, category_source AS src,
            plaid_category AS p, plaid_detailed AS dt
     FROM transactions
     WHERE category IS NOT NULL AND COALESCE(category_source,'') != 'manual'`,
  ).all() as { id: string; name: string | null; rawMerchant: string | null; category: string; src: string | null; p: string | null; dt: string | null }[];
  const setTxn = d.prepare(`UPDATE transactions SET category=?, category_source=?, confidence=? WHERE id=?`);
  let moved = 0;
  for (const t of rows) {
    if (CATS.has(t.category)) continue;
    // Same inputs sync passes to applyRules.
    const ruled = t.src === "rule" ? applyRules(t.rawMerchant ?? t.name, t.name ?? "").category : undefined;
    if (ruled && CATS.has(ruled)) { setTxn.run(ruled, "rule", 1.0, t.id); moved++; continue; }
    const next = LEGACY[t.category] ?? mapPfc(t.p, t.dt) ?? "Other";
    setTxn.run(next, "plaid", 0.5, t.id);
    moved++;
  }

  const after = counts();
  const keys = [...new Set([...before.keys(), ...after.keys()])]
    .filter((k) => (before.get(k) ?? 0) !== (after.get(k) ?? 0))
    .sort((a, b) => (after.get(b) ?? 0) - (before.get(b) ?? 0) - ((after.get(a) ?? 0) - (before.get(a) ?? 0)));
  console.log(`\n${apply ? "APPLIED" : "DRY RUN"}: ${moved} transactions relabelled\n`);
  console.log("category".padEnd(22), "before".padStart(7), "after".padStart(7));
  for (const k of keys) console.log(k.padEnd(22), String(before.get(k) ?? 0).padStart(7), String(after.get(k) ?? 0).padStart(7));
  const leftover = [...after.keys()].filter((k) => k !== "(null)" && !CATS.has(k));
  console.log(`\nnon-taxonomy categories left: ${leftover.length ? leftover.map((k) => `${k}=${after.get(k)}`).join(", ") + " (manual rows)" : "none"}`);

  d.exec(apply ? "COMMIT" : "ROLLBACK");
} catch (e) {
  d.exec("ROLLBACK");
  throw e;
}
