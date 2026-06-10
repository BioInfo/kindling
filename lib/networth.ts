import { db } from "./db";
import { equityVestedValue } from "./equity";

// Net worth = assets (everything that isn't a credit card or loan) minus
// liabilities (credit/loan balances, which Plaid reports as positive amounts owed).
// Same sign convention as /api/transactions' header number.

export type NetWorth = { assets: number; liabilities: number; net: number };
export type Snapshot = { date: string; assets: number; liabilities: number; net: number };
export type TypeRow = { side: "asset" | "liability"; kind: string; balance: number; n: number };
export type AdjustedPoint = { date: string; net: number; raw: number };
export type Trend = {
  // Connection-adjusted series: the latest point is the true net worth; earlier
  // points are lifted by connections that happened after them, so linking an
  // account or backfilling history doesn't draw a step that reads as growth.
  series: AdjustedPoint[];
  change: number;        // organic change across the window (connection steps removed)
  linkedExcluded: number; // sum of connection net added *inside* the window (the step we excluded)
};

export function computeNetWorth(): NetWorth {
  const r = db().prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN type IN ('credit','loan') THEN 0 ELSE current_balance END), 0) AS assets,
       COALESCE(SUM(CASE WHEN type IN ('credit','loan') THEN current_balance ELSE 0 END), 0) AS liabilities
     FROM accounts`
  ).get() as { assets: number; liabilities: number };
  // Hand-entered assets/debts (house, car, mortgage) count like any balance.
  const m = db().prepare(
    `SELECT COALESCE(SUM(CASE WHEN side='asset' THEN value ELSE 0 END), 0) AS assets,
            COALESCE(SUM(CASE WHEN side='liability' THEN value ELSE 0 END), 0) AS liabilities
     FROM manual_assets`
  ).get() as { assets: number; liabilities: number };
  // Vested equity comp = shares you actually own today (unvested is future, not
  // counted). Synchronous: uses each grant's cached last_price.
  const equity = equityVestedValue();
  const assets = (r.assets ?? 0) + (m.assets ?? 0) + equity;
  const liabilities = (r.liabilities ?? 0) + (m.liabilities ?? 0);
  return { assets, liabilities, net: assets - liabilities };
}

// Ensure every item has exactly one connection event = the signed net it added
// on its link date. net_delta is set on first observation and never overwritten
// (INSERT OR IGNORE), so it captures the jump the connection caused; balance
// movement after linking is real change and stays out of this table. Cheap and
// idempotent — safe to call on every snapshot.
export function syncConnectionEvents(): void {
  const d = db();
  const rows = d.prepare(
    `SELECT i.id AS item_id, COALESCE(i.institution_name, i.institution) AS label, date(i.created_at) AS date,
       COALESCE(SUM(CASE WHEN a.type IN ('credit','loan')
                         THEN -a.current_balance ELSE a.current_balance END), 0) AS net_delta
     FROM items i LEFT JOIN accounts a ON a.item_id = i.id
     GROUP BY i.id`
  ).all() as unknown as { item_id: string; label: string | null; date: string; net_delta: number }[];
  const ins = d.prepare(
    `INSERT INTO connection_events (item_id, date, net_delta, label)
     VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO NOTHING`
  );
  for (const r of rows) ins.run(r.item_id, r.date, r.net_delta, r.label);
}

// Record today's net worth. Idempotent per day — re-running just refreshes today's row.
export function captureSnapshot(): NetWorth {
  syncConnectionEvents();
  const nw = computeNetWorth();
  db().prepare(
    `INSERT INTO net_worth_snapshots (date, assets, liabilities, net)
     VALUES (date('now'), ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       assets = excluded.assets, liabilities = excluded.liabilities,
       net = excluded.net, created_at = datetime('now')`
  ).run(nw.assets, nw.liabilities, nw.net);
  return nw;
}

export function snapshotSeries(days = 180): Snapshot[] {
  const rows = db().prepare(
    `SELECT date, assets, liabilities, net FROM net_worth_snapshots
     WHERE date >= date('now', ?) ORDER BY date ASC`
  ).all(`-${days} days`) as unknown as Snapshot[];
  return rows;
}

// The trend the dashboard should show. Raw snapshots include the full balance of
// every linked account, so connecting an account draws a vertical step that looks
// like a windfall. We lift each historical point by the connection net that
// landed *after* it: the latest point keeps its true value, earlier points rise
// so the step flattens, and the slope reflects only money actually moving.
export function adjustedTrend(days = 180): Trend {
  const raw = snapshotSeries(days);
  // Visibility events that should not read as growth: connecting an account, and
  // adding a manual asset (house/car/debt). Both lift the prior baseline. A manual
  // asset's later value edits are NOT here (added_signed is frozen), so real
  // appreciation still shows as organic change.
  const events = (db().prepare(
    `SELECT date, net_delta FROM connection_events
     UNION ALL
     SELECT date(created_at) AS date, added_signed AS net_delta FROM manual_assets
     UNION ALL
     SELECT date(created_at) AS date, vested_value_at_add AS net_delta FROM equity_grants
     ORDER BY date ASC`
  ).all() as unknown as { date: string; net_delta: number }[]);

  const series: AdjustedPoint[] = raw.map((s) => {
    // Sum connections strictly after this point — those are visibility gains we
    // pull back into the baseline so they don't masquerade as growth.
    const lift = events.reduce((acc, e) => (e.date > s.date ? acc + e.net_delta : acc), 0);
    return { date: s.date, raw: s.net, net: s.net + lift };
  });

  let change = 0;
  let linkedExcluded = 0;
  if (series.length > 1) {
    change = series[series.length - 1].net - series[0].net;
    // The step(s) we removed inside the window: connections dated after the first
    // visible point (events on/before it are already baked into the baseline).
    const start = series[0].date;
    linkedExcluded = events.reduce((acc, e) => (e.date > start ? acc + e.net_delta : acc), 0);
  }
  return { series, change, linkedExcluded };
}

// Balances grouped into assets vs liabilities, broken down by account subtype,
// so the dashboard can show what makes up each side.
export function byAccountType(): TypeRow[] {
  return db().prepare(
    `SELECT
       CASE WHEN type IN ('credit','loan') THEN 'liability' ELSE 'asset' END AS side,
       COALESCE(subtype, type, 'other') AS kind,
       COALESCE(SUM(current_balance), 0) AS balance,
       COUNT(*) AS n
     FROM accounts
     GROUP BY side, kind
     UNION ALL
     SELECT side, kind, COALESCE(SUM(value), 0) AS balance, COUNT(*) AS n
     FROM manual_assets
     GROUP BY side, kind
     ORDER BY side ASC, balance DESC`
  ).all() as unknown as TypeRow[];
}
