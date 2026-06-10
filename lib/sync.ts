import { plaid } from "./plaid";
import { db } from "./db";
import { decrypt } from "./crypto";
import { applyRules } from "./categorize";
import { mapPfc } from "./taxonomy";
import { captureSnapshot } from "./networth";
import { syncHoldings } from "./holdings";
import { refreshEquityQuotes } from "./equity";
import { reconcileSubscriptions } from "./subscriptions";
import type { Transaction, RemovedTransaction, AccountBase } from "plaid";

// Pulls new/modified/removed transactions for every Item via the cursor-based
// /transactions/sync endpoint, applies categorization rules, and stores them.
// Returns a per-item summary. Safe to call repeatedly (cursor is persisted).
export async function syncAllItems() {
  const d = db();
  const items = d.prepare(`SELECT id, access_token, cursor FROM items WHERE status != 'error'`).all() as {
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
      while (hasMore) {
        const res = await plaid.transactionsSync({
          access_token: accessToken,
          cursor,
          count: 500,
        });
        const data = res.data;
        for (const t of data.added) { upsertTxn(t); added++; }
        for (const t of data.modified) { upsertTxn(t); modified++; }
        for (const t of data.removed) { removeTxn(t); removed++; }
        // /transactions/sync returns current balances too — refresh them so net
        // worth tracks reality, not just the snapshot taken at link time.
        for (const a of data.accounts) upsertAccount(item.id, a);
        cursor = data.next_cursor;
        hasMore = data.has_more;
      }
      d.prepare(`UPDATE items SET cursor=?, status='good', error=NULL, last_synced_at=datetime('now') WHERE id=?`)
        .run(cursor ?? null, item.id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      d.prepare(`UPDATE items SET status='error', error=? WHERE id=?`).run(msg, item.id);
    }
    results[item.id] = { added, modified, removed };
  }
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
