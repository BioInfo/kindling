import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { db } from "./db";

// Live quotes for hand-entered (manual) holdings — the positions Plaid can't sync
// (e.g. Ally Invest). Source: Yahoo Finance (no key). Only tickers leave your
// network, which reveal little. Misses are left untouched, not zeroed.
//
// Three hard-won details (2026-06):
//   1. Stooq (the old source) retired its free /q/l/ lite quote and gated the
//      daily CSV behind a JS anti-bot wall — every symbol came back missed.
//   2. Yahoo's WAF fingerprint-blocks Node's built-in fetch (undici): every call
//      from undici returns 429 "Too Many Requests" while the SAME request via
//      curl on the SAME host/IP returns 200. So we shell out to curl, not fetch.
//   3. Yahoo's v8 chart is per-symbol (firing 27 back-to-back trips a burst
//      limit) and v7 quote needs a rate-limited cookie+crumb handshake. The
//      `spark` endpoint is batch AND crumbless — one request returns all symbols
//      with no handshake — so that's the primary path.
//
// Crypto is quoted via the -USD suffix (bare "ETH" on Yahoo is a $17 equity).

export type QuoteResult = {
  updated: { ticker: string; price: number }[];
  missed: string[];
  holdingsRepriced: number;
};

const pexec = promisify(execFile);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Absolute path: under launchd a child process's PATH is not reliably propagated,
// so a bare "curl" can ENOENT. macOS ships system curl at /usr/bin/curl; fall back
// to bare name elsewhere.
const CURL = existsSync("/usr/bin/curl") ? "/usr/bin/curl" : "curl";

// One GET via curl. Returns { status, body } or null on spawn/timeout failure.
async function curlGet(url: string): Promise<{ status: number; body: string } | null> {
  try {
    const { stdout } = await pexec(
      CURL,
      ["-s", "--max-time", "12", "-A", UA, "-w", "\n%{http_code}", url],
      { maxBuffer: 16 * 1024 * 1024 }
    );
    const i = stdout.lastIndexOf("\n");
    if (i < 0) return null;
    const status = Number(stdout.slice(i + 1).trim()) || 0;
    return { status, body: stdout.slice(0, i) };
  } catch {
    return null;
  }
}

// v8 chart, single symbol. Fallback for anything the batch misses.
async function fetchChart(yahooSym: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=1d`;
  const res = await curlGet(url);
  if (!res || res.status !== 200) return null;
  try {
    const data = JSON.parse(res.body) as {
      chart?: { result?: { meta?: { regularMarketPrice?: number } }[] | null };
    };
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

// Batch quotes for already-Yahoo-formatted symbols (crypto carries -USD).
// Returns a map keyed by the symbol as passed in (uppercased).
export async function fetchQuotes(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uniq = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!uniq.length) return out;

  // Primary: spark batch (crumbless). One request per 50-symbol chunk.
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(
      chunk.join(",")
    )}&range=1d&interval=1d`;
    const res = await curlGet(url);
    if (!res || res.status !== 200) continue;
    try {
      const j = JSON.parse(res.body) as {
        spark?: { result?: { symbol?: string; response?: { meta?: { regularMarketPrice?: number } }[] }[] };
      };
      for (const row of j?.spark?.result ?? []) {
        const sym = row?.symbol?.toUpperCase();
        const p = row?.response?.[0]?.meta?.regularMarketPrice;
        if (sym && typeof p === "number" && Number.isFinite(p) && p > 0) out.set(sym, p);
      }
    } catch {
      /* fall through to per-symbol */
    }
  }

  // Anything spark didn't return: throttled v8 per-symbol so we stay under the
  // burst limit.
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
    const sym = is_crypto === 1 ? `${ticker.toUpperCase()}-USD` : ticker.toUpperCase();
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
