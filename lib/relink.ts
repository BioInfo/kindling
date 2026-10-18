import { db } from "./db";
import { plaid } from "./plaid";
import { decrypt } from "./crypto";

// Re-linking an institution through fresh Link (instead of update mode) creates a
// SECOND Plaid item with new account_ids and new transaction_ids for the same
// money, so every balance and transaction counts twice. This folds an older item
// at the same institution into the newer one:
//   - accounts pair up by mask (+ subtype), the new account is the survivor
//   - a transaction present in both keeps the NEW row (so future sync updates
//     land on it) but inherits the old row's curation (category, merchant,
//     entity, note, reviewed)
//   - old-only transactions (history older than the new item's window) move
//     onto the new account, tagged merged_from so a later backfill can dedupe
//   - manual holdings move; the old item's connection event moves too, so the
//     re-link never reads as net-worth growth
// Then the old item is deleted locally and removed at Plaid (best-effort).

type Acct = { id: string; mask: string | null; type: string | null; subtype: string | null; current_balance: number | null };
type Txn = {
  id: string; date: string; name: string | null; amount: number; merchant: string | null;
  category: string | null; category_source: string | null; confidence: number | null;
  entity: string | null; note: string | null; reviewed: number;
};

export type MergeReport = {
  into: string; from: string; institution: string | null;
  accountsMerged: number; accountsDropped: string[]; accountsKept: string[];
  txnsMatched: number; txnsMoved: number; plaidRemoved: boolean | string;
};

// Whose category wins when the two copies disagree: a hand pick beats a rule
// beats the model beats Plaid's guess.
const RANK: Record<string, number> = { manual: 3, rule: 2, llm: 1 };
const rank = (s: string | null) => RANK[s ?? ""] ?? 0;

function dayDiff(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
}

function ensureColumn() {
  const cols = db().prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "merged_from")) db().exec(`ALTER TABLE transactions ADD COLUMN merged_from TEXT`);
}

// Pair each `from` txn with an unused `into` txn: same amount, dates within 4 days
// (pending → posted can shift the date), same raw name preferred.
function pairTxns(from: Txn[], into: Txn[]): Map<string, Txn> {
  const used = new Set<string>();
  const out = new Map<string, Txn>();
  for (const o of from) {
    const cands = into.filter((n) => !used.has(n.id) && Math.abs(n.amount - o.amount) < 0.005 && dayDiff(n.date, o.date) <= 4);
    if (!cands.length) continue;
    cands.sort((x, y) => Number(y.name === o.name) - Number(x.name === o.name) || dayDiff(x.date, o.date) - dayDiff(y.date, o.date));
    used.add(cands[0].id);
    out.set(o.id, cands[0]);
  }
  return out;
}

// Copy curation from an old row onto its new twin, then drop the old row.
function absorb(oldT: Txn, newT: Txn) {
  const d = db();
  const curated = rank(oldT.category_source) > rank(newT.category_source);
  d.prepare(
    `UPDATE transactions SET
       category = CASE WHEN @curated THEN @category ELSE category END,
       category_source = CASE WHEN @curated THEN @category_source ELSE category_source END,
       confidence = CASE WHEN @curated THEN @confidence ELSE confidence END,
       merchant = COALESCE(@merchant, merchant), entity = COALESCE(@entity, entity),
       note = COALESCE(note, @note), reviewed = MAX(reviewed, @reviewed)
     WHERE id = @id`
  ).run({
    id: newT.id, curated: curated ? 1 : 0, category: oldT.category, category_source: oldT.category_source,
    confidence: oldT.confidence, merchant: oldT.merchant, entity: oldT.entity, note: oldT.note, reviewed: oldT.reviewed,
  });
  d.prepare(`DELETE FROM transactions WHERE id = ?`).run(oldT.id);
}

const txnCols = `id, date, name, amount, merchant, category, category_source, confidence, entity, note, reviewed`;

function mergeAccount(oldId: string, newId: string, fromItem: string): { matched: number; moved: number } {
  const d = db();
  const oldT = d.prepare(`SELECT ${txnCols} FROM transactions WHERE account_id = ?`).all(oldId) as unknown as Txn[];
  const newT = d.prepare(`SELECT ${txnCols} FROM transactions WHERE account_id = ? AND merged_from IS NULL`).all(newId) as unknown as Txn[];
  const pairs = pairTxns(oldT, newT);
  for (const o of oldT) { const n = pairs.get(o.id); if (n) absorb(o, n); }
  const moved = d.prepare(`UPDATE transactions SET account_id = ?, merged_from = ? WHERE account_id = ?`).run(newId, fromItem, oldId).changes;
  // Manual holdings belong to the account, not the Plaid link — carry them over.
  // Plaid holdings are re-pulled for the new item, so the old copies just go.
  d.prepare(`UPDATE OR IGNORE holdings SET account_id = ? WHERE account_id = ? AND source = 'manual'`).run(newId, oldId);
  d.prepare(`DELETE FROM holdings WHERE account_id = ?`).run(oldId);
  return { matched: pairs.size, moved: Number(moved) };
}

function pairAccounts(oldA: Acct[], newA: Acct[]): Map<string, Acct> {
  const out = new Map<string, Acct>();
  const used = new Set<string>();
  for (const o of oldA) {
    if (!o.mask) continue;
    const n = newA.find((x) => !used.has(x.id) && x.mask === o.mask && x.subtype === o.subtype)
      ?? newA.find((x) => !used.has(x.id) && x.mask === o.mask && x.type === o.type);
    if (n) { used.add(n.id); out.set(o.id, n); }
  }
  return out;
}

export async function mergeItemInto(fromItem: string, intoItem: string, opts: { removeAtPlaid?: boolean } = {}): Promise<MergeReport> {
  ensureColumn();
  const d = db();
  const from = d.prepare(`SELECT id, institution_name, access_token FROM items WHERE id = ?`).get(fromItem) as
    | { id: string; institution_name: string | null; access_token: string } | undefined;
  if (!from) throw new Error(`unknown item ${fromItem}`);
  const acctSql = `SELECT id, mask, type, subtype, current_balance FROM accounts WHERE item_id = ?`;
  const oldA = d.prepare(acctSql).all(fromItem) as unknown as Acct[];
  const newA = d.prepare(acctSql).all(intoItem) as unknown as Acct[];
  const pairs = pairAccounts(oldA, newA);
  const report: MergeReport = {
    into: intoItem, from: fromItem, institution: from.institution_name,
    accountsMerged: 0, accountsDropped: [], accountsKept: [], txnsMatched: 0, txnsMoved: 0, plaidRemoved: false,
  };

  d.exec("BEGIN");
  try {
    for (const o of oldA) {
      const n = pairs.get(o.id);
      if (n) {
        const r = mergeAccount(o.id, n.id, fromItem);
        report.txnsMatched += r.matched; report.txnsMoved += r.moved; report.accountsMerged++;
        d.prepare(`DELETE FROM accounts WHERE id = ?`).run(o.id);
        continue;
      }
      const txns = (d.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?`).get(o.id) as { n: number }).n;
      // No twin in the new link: a $0, history-less account is a closed/deselected
      // one and can go. Anything with money or history is kept, and so is the item.
      if (!o.current_balance && !txns) { d.prepare(`DELETE FROM accounts WHERE id = ?`).run(o.id); report.accountsDropped.push(o.id); }
      else report.accountsKept.push(o.id);
    }
    if (!report.accountsKept.length) {
      // Keep the original link date as the connection event (the re-link is not
      // new visibility); the new item's own event goes.
      const ev = d.prepare(`SELECT 1 FROM connection_events WHERE item_id = ?`).get(fromItem);
      if (ev) {
        d.prepare(`DELETE FROM connection_events WHERE item_id = ?`).run(intoItem);
        d.prepare(`UPDATE connection_events SET item_id = ? WHERE item_id = ?`).run(intoItem, fromItem);
      }
      d.prepare(`DELETE FROM items WHERE id = ?`).run(fromItem);
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }

  if (!report.accountsKept.length && opts.removeAtPlaid !== false) {
    try { await plaid.itemRemove({ access_token: decrypt(from.access_token) }); report.plaidRemoved = true; }
    catch (e) { report.plaidRemoved = e instanceof Error ? e.message : String(e); }
  }
  return report;
}

// After a fresh Link, fold every older item at the same institution into it.
export async function mergeRelinkedItem(newItemId: string, opts: { removeAtPlaid?: boolean } = {}): Promise<MergeReport[]> {
  const d = db();
  const row = d.prepare(`SELECT institution FROM items WHERE id = ?`).get(newItemId) as { institution: string | null } | undefined;
  if (!row?.institution) return [];
  const older = d.prepare(
    `SELECT id FROM items WHERE institution = ? AND id <> ? AND status <> 'manual' ORDER BY created_at`
  ).all(row.institution, newItemId) as { id: string }[];
  const out: MergeReport[] = [];
  for (const o of older) out.push(await mergeItemInto(o.id, newItemId, opts));
  return out;
}

// A merged-in history row can be re-sent by Plaid later (pending → posted near
// the window edge, or a historical backfill). Drop the merged copy in favour of
// the live row, keeping its curation. Run after every sync; cheap when idle.
export function dedupeMergedTransactions(): number {
  const d = db();
  const cols = d.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "merged_from")) return 0;
  const accts = d.prepare(`SELECT DISTINCT account_id FROM transactions WHERE merged_from IS NOT NULL`).all() as { account_id: string }[];
  let n = 0;
  for (const { account_id } of accts) {
    const merged = d.prepare(`SELECT ${txnCols} FROM transactions WHERE account_id = ? AND merged_from IS NOT NULL`).all(account_id) as unknown as Txn[];
    const live = d.prepare(`SELECT ${txnCols} FROM transactions WHERE account_id = ? AND merged_from IS NULL`).all(account_id) as unknown as Txn[];
    const pairs = pairTxns(merged, live);
    for (const o of merged) { const t = pairs.get(o.id); if (t) { absorb(o, t); n++; } }
  }
  return n;
}
