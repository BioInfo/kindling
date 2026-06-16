import { randomUUID } from "node:crypto";
import { db } from "./db";
import { syncConnectionEvents } from "./networth";

// Manual (held-away) investment accounts — brokerages/retirement Plaid can't link:
// a 529, military TSP, Coinbase, a small broker. The accounts table is Plaid-shaped
// (every row FKs an items row), so a manual account gets its OWN synthetic items row
// carrying a sentinel status='manual'. That sentinel keeps the Plaid sync paths
// (lib/sync.ts, lib/holdings.ts) from ever calling Plaid for it, while the rest of the
// app — accounts grid, net worth, holdings/allocation, account detail, the txn account
// filter — joins through items unchanged and treats it like any account.
//
// One item PER account (not one shared "Manual" item) keeps the net-worth math right:
// connection_events is keyed by item_id and freezes each item's opening signed balance,
// so creating an account reads as new visibility, not a windfall. It also lets each
// account group under its own institution name in the grid.

// Curated investment subtypes the create form offers.
export const MANUAL_SUBTYPES = [
  "brokerage", "401k", "ira", "roth", "529", "hsa", "tsp", "crypto", "other",
] as const;
export type ManualSubtype = (typeof MANUAL_SUBTYPES)[number];

export type ManualAccount = {
  id: string;
  name: string;
  institution: string | null;
  subtype: string | null;
  balance: number;
  holdingCount: number;
};

// Recompute current_balance = SUM(holdings.institution_value) for every MANUAL account
// that has at least one holding. A holding-less manual account keeps its hand-entered
// balance (value-only TSP/529). Called after a manual holding is added/removed and after
// a quote refresh, so net worth (which sums accounts.current_balance) stays honest.
export function recomputeManualAccountBalances(): void {
  db().exec(
    `UPDATE accounts
       SET current_balance = (
         SELECT COALESCE(SUM(institution_value), 0) FROM holdings WHERE account_id = accounts.id
       ),
       updated_at = datetime('now')
     WHERE item_id IN (SELECT id FROM items WHERE status = 'manual')
       AND EXISTS (SELECT 1 FROM holdings WHERE account_id = accounts.id)`
  );
}

// True if id refers to a manual (held-away) account.
function isManual(id: string): boolean {
  const r = db().prepare(
    `SELECT 1 FROM accounts a JOIN items i ON i.id = a.item_id WHERE a.id = ? AND i.status = 'manual'`
  ).get(id);
  return !!r;
}

export function createManualAccount(input: {
  name: string; institution?: string | null; subtype?: string | null; balance?: number | null;
}): { account_id: string } {
  const d = db();
  const id = `manual:${randomUUID()}`;
  const institution = input.institution?.trim() || "Manual";
  const subtype = input.subtype?.trim() || "brokerage";
  const balance = Number.isFinite(input.balance as number) ? Number(input.balance) : 0;

  // access_token is NOT NULL and never decrypted (sync excludes status='manual'); a
  // sentinel string satisfies the constraint without storing a real token.
  d.prepare(
    `INSERT INTO items (id, institution, institution_name, access_token, status)
     VALUES (?, NULL, ?, 'manual', 'manual')`
  ).run(id, institution);

  d.prepare(
    `INSERT INTO accounts (id, item_id, name, official_name, mask, type, subtype,
       current_balance, available_balance, currency, updated_at)
     VALUES (?, ?, ?, NULL, NULL, 'investment', ?, ?, NULL, 'USD', datetime('now'))`
  ).run(id, id, input.name.trim(), subtype, balance);

  // Freeze the opening value as a visibility step (INSERT OR IGNORE in the helper), so
  // adding the account doesn't draw a windfall in the net-worth trend.
  syncConnectionEvents();
  return { account_id: id };
}

export function updateManualAccount(id: string, patch: {
  name?: string; institution?: string | null; subtype?: string | null; balance?: number | null;
}): boolean {
  if (!isManual(id)) return false;
  const d = db();
  if (patch.name !== undefined && patch.name.trim()) {
    d.prepare(`UPDATE accounts SET name = ?, updated_at = datetime('now') WHERE id = ?`).run(patch.name.trim(), id);
  }
  if (patch.subtype !== undefined && patch.subtype) {
    d.prepare(`UPDATE accounts SET subtype = ?, updated_at = datetime('now') WHERE id = ?`).run(patch.subtype, id);
  }
  if (patch.institution !== undefined) {
    d.prepare(`UPDATE items SET institution_name = ? WHERE id = ?`).run(patch.institution?.trim() || "Manual", id);
  }
  // A balance edit only sticks for a holding-less account; otherwise the balance is
  // holdings-derived and a manual override would be clobbered on the next recompute.
  if (patch.balance !== undefined && Number.isFinite(patch.balance as number)) {
    const hasHoldings = d.prepare(`SELECT 1 FROM holdings WHERE account_id = ?`).get(id);
    if (!hasHoldings) {
      d.prepare(`UPDATE accounts SET current_balance = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(Number(patch.balance), id);
    }
  }
  return true;
}

export function deleteManualAccount(id: string): boolean {
  if (!isManual(id)) return false;
  // Deleting the synthetic item cascades to its account, holdings, transactions, and
  // connection_event (foreign_keys is ON).
  db().prepare(`DELETE FROM items WHERE id = ?`).run(id);
  return true;
}

export function listManualAccounts(): ManualAccount[] {
  return db().prepare(
    `SELECT a.id, a.name, COALESCE(i.institution_name, i.institution) AS institution,
            a.subtype, COALESCE(a.current_balance, 0) AS balance,
            (SELECT COUNT(*) FROM holdings h WHERE h.account_id = a.id) AS holdingCount
     FROM accounts a JOIN items i ON i.id = a.item_id
     WHERE i.status = 'manual'
     ORDER BY a.name`
  ).all() as unknown as ManualAccount[];
}
