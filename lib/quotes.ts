import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { db } from "./db";

// Live quotes for hand-entered (manual) holdings — the positions Plaid can't sync
// (e.g. Ally Invest). Source: Yahoo Finance (no key). Only tickers leave your
// network, which reveal little. Misses are left untouched, not zeroed.
//
// Two hard-won details (2026-06):
//   1. Stooq (the old source) retired its free /q/l/ lite quote and gated the
//      daily CSV behind a JS anti-bot wall — every symbol came back missed.
//   2. Yahoo's WAF fingerprint-blocks Node's built-in fetch (undici): every call
//      from undici returns 429 "Too Many Requests" while the SAME request via
//      curl on the SAME host/IP returns 200. So we shell out to curl, not fetch.
//
// We use Yahoo's v7 batch quote (cookie+crumb): one request returns ALL symbols,
// so a 27-ticker refresh is ~3 curl calls total (cookie, crumb, quote), far under
// any limit. Falls back to throttled v8 per-symbol chart for batch misses. Crypto
// is quoted via the -USD suffix (bare "ETH" on Yahoo is a $17 equity, not Ether).

export type QuoteResult = {
  updated: { ticker: string; price: number }[];
  missed: string[];
  holdingsRepriced: number;
};

const pexec = promisify(execFile);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const JAR = path.join(os.tmpdir(), "kindling-yahoo-cookies.txt");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One GET via curl. Returns { status, body } or null on spawn/timeout failure.
async function curlGet(url: string, opts: { writeJar?: boolean } = {}): Promise<{ status: number; body: string } | null> {
  const args = ["-s", "--max-time", "12", "-A", UA, "-w", "\n%{http_code}"];
  if (opts.writeJar) args.push("-c", JAR);
  args.push("-b", JAR, url); // -b on a missing jar simply sends no cookies
  try {
    const { stdout } = await pexec("curl", args, { maxBuffer: 16 * 1024 * 1024 });
    const i = stdout.lastIndexOf("\n");
    if (i < 0) return null;
    const status = Number(stdout.slice(i + 1).trim()) || 0;
    return { status, body: stdout.slice(0, i) };
  } catch {
    return null;
  }
}

// Cookie (in JAR) + crumb are stable for a session; cache the crumb in-process so
// repeated refreshes reuse one handshake.
let auth: { crumb: string; ts: number } | null = null;
const AUTH_TTL_MS = 60 * 60 * 1000;

async function getAuth(force = false): Promise<{ crumb: string } | null> {
  if (!force && auth && Date.now() - auth.ts < AUTH_TTL_MS) return auth;
  // fc.yahoo.com 404s but sets the consent cookie into the jar.
  await curlGet("https://fc.yahoo.com", { writeJar: true });
  const cr = await curlGet("https://query1.finance.yahoo.com/v1/test/getcrumb");
  if (!cr || cr.status !== 200) return null;
  const crumb = cr.body.trim();
  // A real crumb is a short token with no whitespace/markup; "Too Many Requests"
  // or an HTML error page is not one.
  if (!crumb || /\s/.test(crumb) || crumb.includes("<")) return null;
  auth = { crumb, ts: Date.now() };
  return auth;
}

// v8 chart, single symbol, no crumb. Fallback for anything the batch misses.
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

  let a = await getAuth();
  if (a) {
    for (let i = 0; i < uniq.length; i += 50) {
      const chunk = uniq.slice(i, i + 50);
      for (let attempt = 0; attempt < 2; attempt++) {
        const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
          chunk.join(",")
        )}&crumb=${encodeURIComponent(a!.crumb)}`;
        const res = await curlGet(url);
        // Stale crumb → refresh once and retry this chunk.
        if (res && (res.status === 401 || res.status === 403) && attempt === 0) {
          const refreshed = await getAuth(true);
          if (refreshed) { a = refreshed; continue; }
        }
        if (res && res.status === 200) {
          try {
            const j = JSON.parse(res.body) as {
              quoteResponse?: { result?: { symbol?: string; regularMarketPrice?: number }[] };
            };
            for (const row of j?.quoteResponse?.result ?? []) {
              const sym = row?.symbol?.toUpperCase();
              const p = row?.regularMarketPrice;
              if (sym && typeof p === "number" && Number.isFinite(p) && p > 0) out.set(sym, p);
            }
          } catch { /* fall through to per-symbol */ }
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
