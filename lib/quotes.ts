import { db } from "./db";

// Live quotes for hand-entered (manual) holdings — the positions Plaid can't sync
// (e.g. Ally Invest). Source: Yahoo Finance (no key). Only tickers leave your
// network, which reveal little. Misses are left untouched, not zeroed.
//
// Was Stooq's CSV endpoint until 2026-06; Stooq retired the free /q/l/ lite quote
// (now a "page does not exist" stub) and gated the daily CSV behind a JS anti-bot
// wall, so every symbol came back missed.
//
// Yahoo has TWO endpoints and the difference matters at batch size:
//   - v8 chart (per symbol, no auth) trips a short-window burst limit — firing 27
//     back-to-back gets the first symbol then 429s the rest.
//   - v7 quote (batch, cookie+crumb) returns ALL symbols in ONE request, so a
//     27-ticker refresh is 1 quote call (plus a cached cookie/crumb handshake),
//     far under any limit.
// So we batch via v7 and fall back to throttled v8 per-symbol only for what the
// batch misses. Crypto is quoted via the -USD suffix (bare "ETH" on Yahoo is a
// $17 equity, not Ethereum).

export type QuoteResult = {
  updated: { ticker: string; price: number }[];
  missed: string[];
  holdingsRepriced: number;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Cookie + crumb are stable for a session; cache them in-process so repeated
// refreshes reuse one handshake instead of re-fetching every time.
let auth: { cookie: string; crumb: string; ts: number } | null = null;
const AUTH_TTL_MS = 60 * 60 * 1000;

async function getAuth(force = false): Promise<{ cookie: string; crumb: string } | null> {
  if (!force && auth && Date.now() - auth.ts < AUTH_TTL_MS) return auth;
  try {
    // fc.yahoo.com 404s but sets the consent cookie we need for the crumb.
    const c = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": UA },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    const cookie = (c.headers.getSetCookie?.() ?? [])
      .map((x) => x.split(";")[0])
      .join("; ");
    if (!cookie) return null;
    const cr = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, Cookie: cookie, Accept: "text/plain,*/*" },
      signal: AbortSignal.timeout(8000),
    });
    if (!cr.ok) return null;
    const crumb = (await cr.text()).trim();
    if (!crumb || crumb.includes("<")) return null; // HTML error page, not a crumb
    auth = { cookie, crumb, ts: Date.now() };
    return auth;
  } catch {
    return null;
  }
}

// v8 chart, single symbol, no auth. Fallback for anything the batch misses.
async function fetchChart(yahooSym: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=1d`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json", Connection: "close" },
      signal: AbortSignal.timeout(8000),
    });
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Batch quotes for a set of already-Yahoo-formatted symbols (crypto carries its
// -USD suffix). Returns a map keyed by the symbol as passed in (uppercased).
export async function fetchQuotes(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uniq = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!uniq.length) return out;

  let a = await getAuth();
  if (a) {
    for (let i = 0; i < uniq.length; i += 50) {
      const chunk = uniq.slice(i, i + 50);
      for (let attempt = 0; attempt < 2; attempt++) {
        const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
          chunk.join(",")
        )}&crumb=${encodeURIComponent(a!.crumb)}`;
        try {
          const res = await fetch(url, {
            headers: { "User-Agent": UA, Cookie: a!.cookie, Accept: "application/json" },
            signal: AbortSignal.timeout(10000),
          });
          // Stale crumb → refresh once and retry this chunk.
          if ((res.status === 401 || res.status === 403) && attempt === 0) {
            const refreshed = await getAuth(true);
            if (refreshed) { a = refreshed; continue; }
          }
          if (res.ok) {
            const j = (await res.json()) as {
              quoteResponse?: { result?: { symbol?: string; regularMarketPrice?: number }[] };
            };
            for (const row of j?.quoteResponse?.result ?? []) {
              const sym = row?.symbol?.toUpperCase();
              const p = row?.regularMarketPrice;
              if (sym && typeof p === "number" && Number.isFinite(p) && p > 0) out.set(sym, p);
            }
          }
        } catch {
          /* fall through to per-symbol */
        }
        break;
      }
    }
  }

  // Anything the batch couldn't return (auth failed, symbol absent from v7):
  // throttled v8 per-symbol so we stay under the burst limit.
  const remaining = uniq.filter((s) => !out.has(s));
  for (const s of remaining) {
    const p = await fetchChart(s);
    if (p != null) out.set(s, p);
    if (remaining.length > 1) await sleep(300);
  }
  return out;
}

// Single-symbol convenience (equity-comp callers). opts.crypto → -USD suffix.
export async function fetchQuote(
  ticker: string,
  opts: { crypto?: boolean } = {}
): Promise<number | null> {
  const base = ticker.trim().toUpperCase();
  if (!base) return null;
  const sym = opts.crypto ? `${base}-USD` : base;
  const m = await fetchQuotes([sym]);
  return m.get(sym) ?? null;
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

  // Map the Yahoo symbol we query back to the DB ticker (BTC-USD → BTC).
  const symToTicker = new Map<string, string>();
  for (const { ticker, is_crypto } of tickers) {
    const sym = (is_crypto === 1 ? `${ticker.toUpperCase()}-USD` : ticker.toUpperCase());
    symToTicker.set(sym, ticker);
  }

  const prices = await fetchQuotes([...symToTicker.keys()]);

  const updated: { ticker: string; price: number }[] = [];
  const missed: string[] = [];
  let holdingsRepriced = 0;

  for (const [sym, ticker] of symToTicker) {
    const price = prices.get(sym);
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
