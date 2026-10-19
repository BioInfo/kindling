import { plaid, classifyPlaidError } from "./plaid";
import { db } from "./db";
import { decrypt } from "./crypto";
import { applyRules } from "./categorize";
import { mapPfc } from "./taxonomy";
import { captureSnapshot } from "./networth";
import { syncHoldings } from "./holdings";
import { refreshEquityQuotes } from "./equity";
import { reconcileSubscriptions } from "./subscriptions";
import { dedupeMergedTransactions } from "./relink";
import type { Transaction, RemovedTransaction, AccountBase } from "plaid";

// Pulls new/modified/removed transactions for every Item via the cursor-based
// /transactions/sync endpoint, applies categorization rules, and stores them.
// Returns a per-item summary. Safe to call repeatedly (cursor is persisted).
export async function syncAllItems() {
  const d = db();
  // status='manual' = a held-away account with no Plaid token — never sync it.
  // 'error' and 're-auth' items are retried every sync: that is how a fixed
  // login (Link update mode) flips back to 'good' without manual cleanup.
  const items = d.prepare(`SELECT id, access_token, cursor FROM items WHERE status <> 'manual'`).all() as {
    id: string;
    access_token: string;
    cursor: string | null;
  }[];

  const results: Record<string, { added: number; modified: number; removed: number }> = {};

  for (const item of items) {
    const accessToken = decrypt(item.access_token);
    let cursor = item.cursor ?? undefined;
    let added = 0, modified = 0, removed = 0;
    let hasMore = true;

    try {
      // Plaid: a paginated update is only valid as a whole. Buffer every page and
      // write once has_more is false; on MUTATION_DURING_PAGINATION restart from
      // the saved cursor. A failed update stores nothing and keeps the cursor.
      let upd = { added: [] as Transaction[], modified: [] as Transaction[], removed: [] as RemovedTransaction[], accounts: [] as AccountBase[] };
      let restarts = 0;
      while (hasMore) {
        let data;
        try {
          data = (await plaid.transactionsSync({ access_token: accessToken, cursor, count: 500 })).data;
        } catch (e) {
          if (classifyPlaidError(e).code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && restarts++ < 3) {
            cursor = item.cursor ?? undefined;
            upd = { added: [], modified: [], removed: [], accounts: [] };
            continue;
          }
          throw e;
        }
        upd.added.push(...data.added); upd.modified.push(...data.modified); upd.removed.push(...data.removed);
        upd.accounts = data.accounts;
        cursor = data.next_cursor;
        hasMore = data.has_more;
      }
      d.exec("BEGIN");
      try {
        // Accounts first: a txn on an account added since link (update mode) would
        // otherwise fail its FK and wedge this item on every retry. Balances come
        // back on /transactions/sync too, so net worth tracks reality.
        for (const a of upd.accounts) upsertAccount(item.id, a);
        for (const t of upd.added) { upsertTxn(t); added++; }
        for (const t of upd.modified) { upsertTxn(t); modified++; }
        for (const t of upd.removed) { removeTxn(t); removed++; }
        d.prepare(`UPDATE items SET cursor=?, status='good', error=NULL, last_synced_at=datetime('now') WHERE id=?`)
          .run(cursor ?? null, item.id);
        d.exec("COMMIT");
      } catch (e) {
        d.exec("ROLLBACK");
        added = modified = removed = 0;
        throw e;
      }
    } catch (e: unknown) {
      const { status, message } = classifyPlaidError(e);
      d.prepare(`UPDATE items SET status=?, error=? WHERE id=?`).run(status, message, item.id);
    }
    results[item.id] = { added, modified, removed };
  }
  // History folded in from a replaced link can be re-sent by the new one.
  try { dedupeMergedTransactions(); } catch { /* best-effort; duplicates stay visible */ }
  // Refresh investment holdings too (graceful: items without investments
  // consent are skipped, not failed). Balances already came through the
  // transactions sync above; this adds the holdings composition.
  await syncHoldings();
  // Refresh equity-comp prices so vested value is current (graceful: a Stooq miss
  // or outage leaves last_price untouched, never fails the sync).
  try { await refreshEquityQuotes(); } catch { /* keep cached prices */ }
  // Record today's net worth point now that balances are fresh.
  captureSnapshot();
  // Refresh subscription detection from the freshly-synced data, pulling Plaid's
  // recurring streams too (best-effort: a stream not yet ready / outage leaves
  // the prior subscriptions untouched, never fails the sync).
  try { await reconcileSubscriptions({ plaid: true }); } catch { /* keep prior subs */ }
  return results;
}

// Upsert an account's balances from a Plaid AccountBase (link + every sync).
function upsertAccount(itemId: string, a: AccountBase) {
  db().prepare(
    `INSERT INTO accounts (id, item_id, name, official_name, mask, type, subtype,
       current_balance, available_balance, currency, updated_at)
     VALUES (@id, @item_id, @name, @official_name, @mask, @type, @subtype,
       @current_balance, @available_balance, @currency, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       current_balance = excluded.current_balance,
       available_balance = excluded.available_balance,
       name = excluded.name, official_name = excluded.official_name,
       mask = excluded.mask, type = excluded.type, subtype = excluded.subtype,
       currency = excluded.currency, updated_at = datetime('now')`
  ).run({
    id: a.account_id,
    item_id: itemId,
    name: a.name,
    official_name: a.official_name ?? null,
    mask: a.mask ?? null,
    type: a.type ?? null,
    subtype: a.subtype ?? null,
    current_balance: a.balances.current ?? null,
    available_balance: a.balances.available ?? null,
    currency: a.balances.iso_currency_code ?? null,
  });
}

function upsertTxn(t: Transaction) {
  const d = db();
  const pfcPrimary = t.personal_finance_category?.primary ?? null;
  const pfcDetailed = t.personal_finance_category?.detailed ?? null;
  // Rules first; fall back to Plaid's category. (LLM tail is Phase 4.)
  const ruled = applyRules(t.merchant_name ?? t.name, t.name);
  d.prepare(
    `INSERT INTO transactions
       (id, account_id, date, name, merchant, amount, currency, pending,
        plaid_category, plaid_detailed, category, category_source, confidence, entity, raw)
     VALUES
       (@id, @account_id, @date, @name, @merchant, @amount, @currency, @pending,
        @plaid_category, @plaid_detailed, @category, @category_source, @confidence, @entity, @raw)
     ON CONFLICT(id) DO UPDATE SET
        amount=excluded.amount, pending=excluded.pending, date=excluded.date,
        merchant=excluded.merchant, plaid_category=excluded.plaid_category,
        plaid_detailed=excluded.plaid_detailed, raw=excluded.raw`
  ).run({
    id: t.transaction_id,
    account_id: t.account_id,
    date: t.date,
    name: t.name,
    merchant: ruled.rename ?? t.merchant_name ?? null,
    amount: t.amount,
    currency: t.iso_currency_code ?? null,
    pending: t.pending ? 1 : 0,
    plaid_category: pfcPrimary,
    plaid_detailed: pfcDetailed,
    // Rule wins; else map Plaid's primary into our taxonomy when it's a safe 1:1;
    // else keep the raw primary (stays low-confidence → review queue).
    category: ruled.category ?? mapPfc(pfcPrimary) ?? pfcPrimary,
    category_source: ruled.category ? "rule" : "plaid",
    confidence: ruled.category ? 1.0 : 0.5,
    entity: ruled.entity ?? "personal",
    raw: JSON.stringify(t),
  });
}

function removeTxn(t: RemovedTransaction) {
  db().prepare(`DELETE FROM transactions WHERE id=?`).run(t.transaction_id);
}
