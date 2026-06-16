import { db } from "./db";
import { fetchQuotes } from "./quotes";

// Equity compensation: RSU / option / ESPP grants that vest over time. See
// equity_grants in db.ts for the schema + the connection-aware design. Only
// VESTED value (shares you actually own today) feeds net worth; unvested is a
// future projection. Options are valued at intrinsic worth: max(0, price−strike).

export type EquityGrant = {
  id: number; employer: string | null; ticker: string | null; kind: string;
  grant_date: string; shares: number; strike: number | null;
  cliff_months: number; vest_months: number; vest_freq: string;
  last_price: number | null; price_as_of: string | null;
  vested_value_at_add: number; note: string | null;
  created_at: string; updated_at: string;
};

// Per-grant view with the derived vesting + valuation the UI needs.
export type GrantView = EquityGrant & {
  vestedShares: number; unvestedShares: number;
  perShare: number;            // current value per vested share (intrinsic for options)
  vestedValue: number; unvestedValue: number; totalValue: number;
  nextVestDate: string | null; nextVestShares: number;
  fullyVested: boolean;
  schedule: { date: string; shares: number; value: number }[]; // cumulative, for the chart
};

export type EquityView = {
  grants: GrantView[];
  vestedValue: number;     // counts toward net worth
  unvestedValue: number;   // future
  totalValue: number;      // vested + unvested at current price
  priced: boolean;         // at least one grant has a quote
  nextVest: { date: string; shares: number; value: number; ticker: string | null } | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const freqMonths = (f: string) => (f === "annual" ? 12 : f === "quarterly" ? 3 : 1);

// Whole months from `from` to `to`, not counting a month until its anniversary
// day is reached (so a grant on the 15th vests its month on the 15th).
function monthsElapsed(from: string, to: string): number {
  const f = new Date(from + "T00:00:00Z"), t = new Date(to + "T00:00:00Z");
  if (isNaN(f.getTime()) || isNaN(t.getTime())) return 0;
  let m = (t.getUTCFullYear() - f.getUTCFullYear()) * 12 + (t.getUTCMonth() - f.getUTCMonth());
  if (t.getUTCDate() < f.getUTCDate()) m -= 1;
  return Math.max(0, m);
}

// grant_date + n months, as YYYY-MM-DD (clamps to month end, e.g. Jan 31 + 1mo).
function addMonths(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

// Fraction of shares vested at a given elapsed-months count. Nothing vests
// before the cliff; at/after the cliff, value accrues at vest_freq boundaries
// up to vest_months, then 100%.
function vestedFractionAt(g: { cliff_months: number; vest_months: number; vest_freq: string }, elapsed: number): number {
  if (g.vest_months <= 0) return 1;
  if (elapsed < g.cliff_months) return 0;
  if (elapsed >= g.vest_months) return 1;
  const fm = freqMonths(g.vest_freq);
  const boundary = Math.min(g.vest_months, Math.floor(elapsed / fm) * fm);
  return Math.max(0, boundary) / g.vest_months;
}

// Value of one vested share right now. RSU/ESPP: the price. Option: intrinsic
// worth (underwater options are worth 0, not negative).
function perShareValue(g: { kind: string; strike: number | null; last_price: number | null }): number {
  const p = g.last_price ?? 0;
  if (p <= 0) return 0;
  if (g.kind === "option") return Math.max(0, p - (g.strike ?? 0));
  return p;
}

// Cumulative vested-shares + value over the grant's life, one point per vest
// boundary, for the timeline chart. Past and future vests are valued at the
// current price — it's a "value at today's price" projection, not a backtest.
function buildSchedule(g: EquityGrant): { date: string; shares: number; value: number }[] {
  const fm = freqMonths(g.vest_freq);
  const per = perShareValue(g);
  const out: { date: string; shares: number; value: number }[] = [{ date: g.grant_date, shares: 0, value: 0 }];
  for (let m = fm; m <= g.vest_months; m += fm) {
    const frac = vestedFractionAt(g, m);
    const shares = round2(frac * g.shares);
    out.push({ date: addMonths(g.grant_date, m), shares, value: round2(shares * per) });
  }
  // Ensure the terminal point is exactly 100% even if vest_months isn't a clean
  // multiple of the frequency.
  if (g.vest_months % fm !== 0) {
    out.push({ date: addMonths(g.grant_date, g.vest_months), shares: round2(g.shares), value: round2(g.shares * per) });
  }
  return out;
}

function view(g: EquityGrant, today: string): GrantView {
  const elapsed = monthsElapsed(g.grant_date, today);
  const frac = vestedFractionAt(g, elapsed);
  const vestedShares = round2(frac * g.shares);
  const unvestedShares = round2(g.shares - vestedShares);
  const per = perShareValue(g);
  const fm = freqMonths(g.vest_freq);
  const fullyVested = elapsed >= g.vest_months;
  // Next boundary strictly after now (and at least the cliff).
  let nextVestDate: string | null = null, nextVestShares = 0;
  if (!fullyVested) {
    const nextBoundary = Math.max(g.cliff_months, (Math.floor(elapsed / fm) + 1) * fm);
    const at = Math.min(nextBoundary, g.vest_months);
    nextVestDate = addMonths(g.grant_date, at);
    nextVestShares = round2((vestedFractionAt(g, at) - frac) * g.shares);
  }
  return {
    ...g,
    vestedShares, unvestedShares, perShare: round2(per),
    vestedValue: round2(vestedShares * per),
    unvestedValue: round2(unvestedShares * per),
    totalValue: round2(g.shares * per),
    nextVestDate, nextVestShares, fullyVested,
    schedule: buildSchedule(g),
  };
}

function rows(): EquityGrant[] {
  return db().prepare(
    `SELECT id, employer, ticker, kind, grant_date, shares, strike,
            cliff_months, vest_months, vest_freq, last_price, price_as_of,
            vested_value_at_add, note, created_at, updated_at
     FROM equity_grants ORDER BY grant_date DESC, id DESC`
  ).all() as unknown as EquityGrant[];
}

export function listEquity(): EquityView {
  const today = new Date().toISOString().slice(0, 10);
  const grants = rows().map((g) => view(g, today));
  const vestedValue = round2(grants.reduce((s, g) => s + g.vestedValue, 0));
  const unvestedValue = round2(grants.reduce((s, g) => s + g.unvestedValue, 0));
  const priced = grants.some((g) => g.last_price != null && g.last_price > 0);
  // Soonest upcoming vest across all grants.
  let nextVest: EquityView["nextVest"] = null;
  for (const g of grants) {
    if (!g.nextVestDate || g.nextVestShares <= 0) continue;
    if (!nextVest || g.nextVestDate < nextVest.date) {
      nextVest = { date: g.nextVestDate, shares: g.nextVestShares, value: round2(g.nextVestShares * g.perShare), ticker: g.ticker };
    }
  }
  return { grants, vestedValue, unvestedValue, totalValue: round2(vestedValue + unvestedValue), priced, nextVest };
}

// Vested equity value that feeds net worth (synchronous — uses cached prices).
export function equityVestedValue(): number {
  const today = new Date().toISOString().slice(0, 10);
  return round2(rows().reduce((s, g) => s + view(g, today).vestedValue, 0));
}

export function getGrant(id: number): EquityGrant | undefined {
  return db().prepare(
    `SELECT id, employer, ticker, kind, grant_date, shares, strike,
            cliff_months, vest_months, vest_freq, last_price, price_as_of,
            vested_value_at_add, note, created_at, updated_at
     FROM equity_grants WHERE id=?`
  ).get(id) as unknown as EquityGrant | undefined;
}

export type NewGrant = {
  employer?: string | null; ticker?: string | null; kind?: string;
  grant_date: string; shares: number; strike?: number | null;
  cliff_months?: number; vest_months?: number; vest_freq?: string;
  last_price?: number | null; note?: string | null;
};

// Create a grant. vested_value_at_add freezes the vested value as of today using
// whatever price we have, so the net-worth trend treats recording the grant as
// new visibility, not a gain (mirrors manual_assets.added_signed).
export function createGrant(g: NewGrant): number {
  const today = new Date().toISOString().slice(0, 10);
  const kind = g.kind === "option" || g.kind === "espp" ? g.kind : "rsu";
  const draft: EquityGrant = {
    id: 0, employer: g.employer ?? null, ticker: g.ticker ?? null, kind,
    grant_date: g.grant_date, shares: g.shares, strike: g.strike ?? null,
    cliff_months: g.cliff_months ?? 12, vest_months: g.vest_months ?? 48,
    vest_freq: g.vest_freq ?? "monthly", last_price: g.last_price ?? null,
    price_as_of: g.last_price != null ? today : null, vested_value_at_add: 0,
    note: g.note ?? null, created_at: today, updated_at: today,
  };
  const atAdd = view(draft, today).vestedValue;
  const res = db().prepare(
    `INSERT INTO equity_grants
       (employer, ticker, kind, grant_date, shares, strike, cliff_months,
        vest_months, vest_freq, last_price, price_as_of, vested_value_at_add, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(draft.employer, draft.ticker, kind, draft.grant_date, draft.shares, draft.strike,
        draft.cliff_months, draft.vest_months, draft.vest_freq, draft.last_price,
        draft.price_as_of, atAdd, draft.note);
  return Number(res.lastInsertRowid);
}

export function updateGrant(id: number, f: Partial<NewGrant>): void {
  const map: Record<string, unknown> = {};
  const allow = ["employer", "ticker", "kind", "grant_date", "shares", "strike", "cliff_months", "vest_months", "vest_freq", "note"] as const;
  for (const k of allow) if (f[k as keyof NewGrant] !== undefined) map[k] = f[k as keyof NewGrant];
  const keys = Object.keys(map);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k}=?`).concat("updated_at=datetime('now')");
  db().prepare(`UPDATE equity_grants SET ${sets.join(", ")} WHERE id=?`).run(...(keys.map((k) => map[k]) as never[]), id);
}

export function deleteGrant(id: number): void {
  db().prepare(`DELETE FROM equity_grants WHERE id=?`).run(id);
}

export type EquityQuoteResult = { updated: { ticker: string; price: number }[]; missed: string[]; grantsRepriced: number };

// Refresh cached prices for every distinct grant ticker (equity comp, so always
// equities — no crypto). One batched Yahoo quote call; tickers only leave your
// network. Misses are left at their last value, not zeroed.
export async function refreshEquityQuotes(): Promise<EquityQuoteResult> {
  const d = db();
  const tickers = (d.prepare(
    `SELECT DISTINCT ticker FROM equity_grants WHERE ticker IS NOT NULL AND ticker != ''`
  ).all() as { ticker: string }[]).map((r) => r.ticker);
  const updated: { ticker: string; price: number }[] = [];
  const missed: string[] = [];
  let grantsRepriced = 0;
  const prices = await fetchQuotes(tickers.map((t) => t.toUpperCase()));
  for (const ticker of tickers) {
    const price = prices.get(ticker.toUpperCase());
    if (price == null) { missed.push(ticker); continue; }
    updated.push({ ticker, price });
    const res = d.prepare(
      `UPDATE equity_grants SET last_price=?, price_as_of=date('now'), updated_at=datetime('now') WHERE ticker=?`
    ).run(price, ticker);
    grantsRepriced += Number(res.changes ?? 0);
  }
  return { updated, missed, grantsRepriced };
}
