import { plaid } from "./plaid";
import { db } from "./db";
import { decrypt } from "./crypto";
import { recomputeManualAccountBalances } from "./accounts";
import type { Holding as PlaidHolding, Security as PlaidSecurity } from "plaid";

// Investment holdings: the composition (tickers, shares, value) behind the
// brokerage account balances net worth already counts. Pulled per item from
// /investments/holdings/get. Items linked without investments consent surface in
// `consentNeeded` so the UI can offer a one-click re-consent (Link update mode).

export type SyncResult = {
  updated: number;                                   // items whose holdings refreshed
  consentNeeded: { item_id: string; institution: string | null }[];
  errors: { item_id: string; message: string }[];
};

// Item ids that own at least one investment-type account — the only items worth
// asking for holdings.
function investmentItems(): { id: string; institution: string | null; access_token: string }[] {
  return db().prepare(
    `SELECT DISTINCT i.id, i.institution, i.access_token
     FROM items i JOIN accounts a ON a.item_id = i.id
     WHERE a.type = 'investment' AND i.status NOT IN ('error','manual')`
  ).all() as unknown as { id: string; institution: string | null; access_token: string }[];
}

export async function syncHoldings(): Promise<SyncResult> {
  const d = db();
  const items = investmentItems();
  const result: SyncResult = { updated: 0, consentNeeded: [], errors: [] };

  const upSec = d.prepare(
    `INSERT INTO securities (id, ticker, name, type, is_cash_equivalent, close_price, close_price_as_of, currency, updated_at)
     VALUES (@id, @ticker, @name, @type, @is_cash_equivalent, @close_price, @close_price_as_of, @currency, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       ticker=excluded.ticker, name=excluded.name, type=excluded.type,
       is_cash_equivalent=excluded.is_cash_equivalent, close_price=excluded.close_price,
       close_price_as_of=excluded.close_price_as_of, currency=excluded.currency,
       updated_at=datetime('now')`
  );
  const upHold = d.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, institution_price, institution_value, cost_basis, currency, source, updated_at)
     VALUES (@account_id, @security_id, @quantity, @institution_price, @institution_value, @cost_basis, @currency, 'plaid', datetime('now'))
     ON CONFLICT(account_id, security_id) DO UPDATE SET
       quantity=excluded.quantity, institution_price=excluded.institution_price,
       institution_value=excluded.institution_value, cost_basis=excluded.cost_basis,
       currency=excluded.currency, source='plaid', updated_at=datetime('now')`
  );
  // Only clear Plaid-sourced rows — manual holdings (e.g. Ally Invest, entered by
  // hand because Plaid can't fetch them) must survive a sync.
  const clearItemHoldings = d.prepare(
    `DELETE FROM holdings WHERE source='plaid' AND account_id IN (SELECT id FROM accounts WHERE item_id = ?)`
  );

  for (const item of items) {
    try {
      const res = await plaid.investmentsHoldingsGet({ access_token: decrypt(item.access_token) });
      // Replace this item's holdings wholesale so sold/closed positions vanish.
      clearItemHoldings.run(item.id);
      for (const s of res.data.securities as PlaidSecurity[]) {
        upSec.run({
          id: s.security_id,
          ticker: s.ticker_symbol ?? null,
          name: s.name ?? null,
          type: s.type ?? null,
          is_cash_equivalent: s.is_cash_equivalent ? 1 : 0,
          close_price: s.close_price ?? null,
          close_price_as_of: s.close_price_as_of ?? null,
          currency: s.iso_currency_code ?? null,
        });
      }
      for (const h of res.data.holdings as PlaidHolding[]) {
        upHold.run({
          account_id: h.account_id,
          security_id: h.security_id,
          quantity: h.quantity ?? null,
          institution_price: h.institution_price ?? null,
          institution_value: h.institution_value ?? null,
          cost_basis: h.cost_basis ?? null,
          currency: h.iso_currency_code ?? null,
        });
      }
      result.updated++;
    } catch (e: unknown) {
      const data = (e as { response?: { data?: { error_code?: string } } })?.response?.data;
      const code = data?.error_code;
      if (code === "ADDITIONAL_CONSENT_REQUIRED" || code === "PRODUCTS_NOT_SUPPORTED" || code === "PRODUCT_NOT_READY") {
        // Not an error to surface loudly — the user just needs to grant consent
        // (or the institution can't do holdings). Offer the re-consent flow.
        result.consentNeeded.push({ item_id: item.id, institution: item.institution });
      } else {
        const message = e instanceof Error ? e.message : String(e);
        result.errors.push({ item_id: item.id, message });
      }
    }
  }
  return result;
}

// ---- Manual holdings (institutions Plaid can't fetch, e.g. Ally Invest) ----

export type ManualHolding = {
  account_id: string; ticker?: string | null; name?: string | null; type?: string | null;
  quantity?: number | null; price?: number | null; value?: number | null; cost_basis?: number | null;
};

// A stable, namespaced security_id so manual entries never collide with Plaid's,
// and are scoped per account so the same ticker in two accounts (or a ticker that
// means different things across brokerages, e.g. "BTC") doesn't conflate.
function manualSecurityId(h: ManualHolding): string {
  const slug = (h.ticker || h.name || "untitled").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `manual:${h.account_id}:${slug}`;
}

export function addManualHolding(h: ManualHolding): { account_id: string; security_id: string } {
  const d = db();
  const security_id = manualSecurityId(h);
  d.prepare(
    `INSERT INTO securities (id, ticker, name, type, is_cash_equivalent, close_price, close_price_as_of, currency, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, NULL, 'USD', datetime('now'))
     ON CONFLICT(id) DO UPDATE SET ticker=excluded.ticker, name=excluded.name,
       type=excluded.type, close_price=excluded.close_price, updated_at=datetime('now')`
  ).run(security_id, h.ticker ?? null, h.name ?? null, h.type ?? null, h.price ?? null);
  d.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, institution_price, institution_value, cost_basis, currency, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'USD', 'manual', datetime('now'))
     ON CONFLICT(account_id, security_id) DO UPDATE SET
       quantity=excluded.quantity, institution_price=excluded.institution_price,
       institution_value=excluded.institution_value, cost_basis=excluded.cost_basis,
       source='manual', updated_at=datetime('now')`
  ).run(h.account_id, security_id, h.quantity ?? null, h.price ?? null, h.value ?? null, h.cost_basis ?? null);
  // A manual (held-away) account's balance tracks its holdings — keep net worth honest.
  recomputeManualAccountBalances();
  return { account_id: h.account_id, security_id };
}

export function deleteManualHolding(account_id: string, security_id: string): void {
  db().prepare(`DELETE FROM holdings WHERE account_id=? AND security_id=? AND source='manual'`).run(account_id, security_id);
  recomputeManualAccountBalances();
}

// Investment accounts that can take manual holdings — those whose item can't be
// fetched from Plaid (no holdings rows means either consent-needed or, like Ally
// Bank, investments simply isn't offered). The form lists these as targets.
export function manualEligibleAccounts(): { account_id: string; name: string | null; mask: string | null; institution: string | null }[] {
  return db().prepare(
    `SELECT a.id AS account_id, a.name, a.mask,
            COALESCE(i.institution_name, i.institution) AS institution
     FROM accounts a JOIN items i ON a.item_id = i.id
     WHERE a.type = 'investment'
     ORDER BY a.name`
  ).all() as unknown as { account_id: string; name: string | null; mask: string | null; institution: string | null }[];
}

export type HoldingRow = {
  account_id: string; account: string; mask: string | null;
  security_id: string; ticker: string | null; name: string | null; type: string | null;
  quantity: number | null; price: number | null; value: number; cost_basis: number | null;
  gain: number | null; pct: number; // pct of total portfolio value
  source: string; // plaid | manual
};
export type AllocSlice = { key: string; value: number; pct: number };
export type Investments = {
  holdings: HoldingRow[];
  total: number;
  byType: AllocSlice[];
  byAccount: AllocSlice[];
  // Investment items with no holdings rows — either never synced or awaiting
  // investments consent. The UI offers a one-click re-consent for these.
  consentNeeded: { item_id: string; institution: string | null; accounts: string[] }[];
  // Investment accounts that can take hand-entered holdings (the form's targets).
  manualAccounts: { account_id: string; name: string | null; mask: string | null; institution: string | null }[];
};

export function listHoldings(): Investments {
  const d = db();
  const rows = d.prepare(
    `SELECT h.account_id, a.name AS account, a.mask,
            h.security_id, s.ticker, s.name, s.type,
            h.quantity, h.institution_price AS price,
            COALESCE(h.institution_value, 0) AS value, h.cost_basis, h.source
     FROM holdings h
     JOIN accounts a ON a.id = h.account_id
     JOIN securities s ON s.id = h.security_id
     ORDER BY value DESC`
  ).all() as unknown as Omit<HoldingRow, "gain" | "pct">[];

  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  const holdings: HoldingRow[] = rows.map((r) => ({
    ...r,
    gain: r.cost_basis != null ? r.value - r.cost_basis : null,
    pct: total > 0 ? r.value / total : 0,
  }));

  const sliceBy = (keyFn: (r: HoldingRow) => string): AllocSlice[] => {
    const m = new Map<string, number>();
    for (const r of holdings) m.set(keyFn(r), (m.get(keyFn(r)) ?? 0) + r.value);
    return [...m.entries()]
      .map(([key, value]) => ({ key, value, pct: total > 0 ? value / total : 0 }))
      .sort((a, b) => b.value - a.value);
  };

  // Items that need investments consent: surface only when the WHOLE item has no
  // holdings (consent is granted at the item level). Once any account under the
  // item has holdings, consent is in — so an empty $0 plan account (e.g. an
  // unfunded deferred-comp plan) must NOT keep the banner up. Excludes accounts
  // with a $0 balance from the "accounts" list so we don't dangle empties.
  const consentNeeded = (d.prepare(
    `SELECT i.id AS item_id, COALESCE(i.institution_name, i.institution) AS institution,
            GROUP_CONCAT(a.name, '||') AS accounts
     FROM items i JOIN accounts a ON a.item_id = i.id
     WHERE a.type = 'investment' AND i.status NOT IN ('error','manual')
       AND NOT EXISTS (
         SELECT 1 FROM holdings h JOIN accounts a2 ON a2.id = h.account_id
         WHERE a2.item_id = i.id)
     GROUP BY i.id`
  ).all() as unknown as { item_id: string; institution: string | null; accounts: string | null }[])
    .map((r) => ({ item_id: r.item_id, institution: r.institution, accounts: (r.accounts ?? "").split("||").filter(Boolean) }));

  return {
    holdings,
    total,
    byType: sliceBy((r) => r.type ?? "other"),
    byAccount: sliceBy((r) => r.account),
    consentNeeded,
    manualAccounts: manualEligibleAccounts(),
  };
}
