import { db } from "./db";

// Live quotes for hand-entered (manual) holdings — the positions Plaid can't sync
// (e.g. Ally Invest). Source: Yahoo Finance's public chart endpoint (no key). Only
// tickers leave your network, which reveal little. Misses (delisted, odd symbols)
// are left untouched, not zeroed.
//
// Was Stooq's CSV endpoint until 2026-06; Stooq retired the free /q/l/ lite quote
// (now serves a "page does not exist" stub) and gated the daily CSV behind a JS
// anti-bot wall, so every symbol came back missed. Yahoo's v8 chart endpoint is
// public (no crumb/cookie like the v10 quoteSummary route) and covers equities,
// ETFs, mutual funds, and crypto via the -USD suffix.

export type QuoteResult = {
  updated: { ticker: string; price: number }[];
  missed: string[];
  holdingsRepriced: number;
};

// Yahoo: https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d
// → JSON; price at chart.result[0].meta.regularMarketPrice. For crypto pass
// { crypto: true } so we query BTC-USD, not the same-named "BTC"/"ETH" equity
// (bare "ETH" on Yahoo is a $17 stock, not Ethereum).
export async function fetchQuote(
  ticker: string,
  opts: { crypto?: boolean } = {}
): Promise<number | null> {
  const sym = ticker.trim().toUpperCase();
  if (!sym) return null;
  const yahooSym = opts.crypto ? `${sym}-USD` : sym;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=1d`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    // Yahoo 429s the default fetch UA; a browser UA gets the public JSON.
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: { result?: { meta?: { regularMarketPrice?: number } }[] | null };
    };
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

export async function refreshManualQuotes(): Promise<QuoteResult> {
  const d = db();
  // Distinct tickers across manual holdings, with a crypto flag (true if ANY row
  // for that ticker is typed cryptocurrency — BTC/ETH carry both a crypto and an
  // etf-typed row; both are the coin and want the -USD quote). Skip cash only.
  const tickers = d.prepare(
    `SELECT s.ticker AS ticker,
            MAX(CASE WHEN COALESCE(s.type,'') = 'cryptocurrency' THEN 1 ELSE 0 END) AS is_crypto
     FROM holdings h JOIN securities s ON s.id = h.security_id
     WHERE h.source = 'manual' AND s.ticker IS NOT NULL AND s.ticker != ''
       AND COALESCE(s.type,'') != 'cash'
     GROUP BY s.ticker`
  ).all() as { ticker: string; is_crypto: number }[];

  const updated: { ticker: string; price: number }[] = [];
  const missed: string[] = [];
  let holdingsRepriced = 0;

  for (const { ticker, is_crypto } of tickers) {
    const price = await fetchQuote(ticker, { crypto: is_crypto === 1 });
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
