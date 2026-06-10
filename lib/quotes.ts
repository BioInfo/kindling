import { db } from "./db";

// Live quotes for hand-entered (manual) holdings — the positions Plaid can't sync
// (e.g. Ally Invest). Source: Stooq's free CSV endpoint (no key). Only tickers
// leave your network, which reveal little. Misses (delisted, crypto, odd symbols)
// are left untouched, not zeroed.

export type QuoteResult = {
  updated: { ticker: string; price: number }[];
  missed: string[];
  holdingsRepriced: number;
};

// Stooq: https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv
// → "Symbol,Date,Time,Open,High,Low,Close,Volume" then a data row; Close is N/D on miss.
export async function fetchQuote(ticker: string): Promise<number | null> {
  const sym = ticker.trim().toLowerCase();
  if (!sym) return null;
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}.us&f=sd2t2ohlcv&h&e=csv`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "kindling/1.0" } });
    clearTimeout(t);
    if (!res.ok) return null;
    const text = await res.text();
    const line = text.trim().split("\n")[1];
    if (!line) return null;
    const close = line.split(",")[6];
    if (!close || close === "N/D") return null;
    const n = Number(close);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function refreshManualQuotes(): Promise<QuoteResult> {
  const d = db();
  // Distinct tickers across manual holdings (skip cash + crypto — no clean quote).
  const tickers = (d.prepare(
    `SELECT DISTINCT s.ticker AS ticker
     FROM holdings h JOIN securities s ON s.id = h.security_id
     WHERE h.source = 'manual' AND s.ticker IS NOT NULL AND s.ticker != ''
       AND COALESCE(s.type,'') NOT IN ('cash','cryptocurrency')`
  ).all() as { ticker: string }[]).map((r) => r.ticker);

  const updated: { ticker: string; price: number }[] = [];
  const missed: string[] = [];
  let holdingsRepriced = 0;

  for (const ticker of tickers) {
    const price = await fetchQuote(ticker);
    if (price == null) { missed.push(ticker); continue; }
    updated.push({ ticker, price });
    // Update every manual security with this ticker, and reprice its holdings
    // (value = qty * price when we have a quantity; otherwise leave value alone).
    d.prepare(
      `UPDATE securities SET close_price=?, close_price_as_of=date('now'), updated_at=datetime('now')
       WHERE ticker=? AND id LIKE 'manual:%'`
    ).run(price, ticker);
    const res = d.prepare(
      `UPDATE holdings SET institution_price=?,
         institution_value = CASE WHEN quantity IS NOT NULL THEN quantity*? ELSE institution_value END,
         updated_at=datetime('now')
       WHERE source='manual' AND security_id IN (SELECT id FROM securities WHERE ticker=? AND id LIKE 'manual:%')`
    ).run(price, price, ticker);
    holdingsRepriced += Number(res.changes ?? 0);
  }

  return { updated, missed, holdingsRepriced };
}
