import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "./db";

// Order receipts: what was actually bought behind a card charge. Amazon's card
// descriptor ("AMAZON MKTPL*5A6AC2041") says nothing about the basket, so the
// receipt is the strongest category signal there is.
//
// Two inputs, one table:
//  - Gmail order/shipment confirmations, read through the `gog` CLI with a
//    read-only command allowlist. Needs ORDERS_GMAIL_ACCOUNT; does nothing without it.
//  - An Amazon "Your Orders" CSV export dropped into data/ (importOrdersCsv).
//
// A card charge matches one receipt by exact total inside a date window; Amazon
// bills per shipment, so shipment emails match more often than order emails.

export interface ReceiptItem { name: string; qty?: number; price?: number; category?: string }
export interface Receipt {
  id: string;            // gmail message id, or "csv:<order>:<ship date>"
  source: "gmail" | "csv";
  kind: "ordered" | "shipped" | "wholefoods" | "digital" | "csv";
  order_id: string | null;
  date: string;          // YYYY-MM-DD, local (ET) date of the email / shipment
  total: number | null;
  label: string | null;  // Amazon's category label(s) or the item names from the subject
  items: ReceiptItem[];
  subject: string | null;
}

let schemaReady = false;
export function ensureOrdersSchema(): void {
  if (schemaReady) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS order_receipts (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL,
      kind        TEXT NOT NULL,
      order_id    TEXT,
      date        TEXT NOT NULL,
      total       REAL,
      label       TEXT,
      items       TEXT,             -- JSON ReceiptItem[]
      subject     TEXT,
      fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_date ON order_receipts(date);
    CREATE INDEX IF NOT EXISTS idx_receipts_order ON order_receipts(order_id);
    -- A charge matches one receipt; a receipt can be paid by up to 3 charges
    -- (Amazon splits an order's charge across shipments).
    CREATE TABLE IF NOT EXISTS receipt_txns (
      txn_id      TEXT PRIMARY KEY,
      receipt_id  TEXT NOT NULL,
      how         TEXT NOT NULL      -- exact | split
    );
  `);
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Parsing (pure; exported for the verify script)

// Bidi isolates, zero-width and soft-hyphen padding Amazon sprinkles into subjects.
const INVISIBLE = /[͏­​-‏‪-‮⁦-⁩﻿]/g;

export function cleanSubject(s: string): string {
  return s.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

// "Ordered 3 items: Breakfast Cereal, Pet Supplies, and more" -> "Breakfast Cereal, Pet Supplies"
// "Ordered: 9 Grocery and Snack Foods items"                 -> "Grocery and Snack Foods"
// "Shipped: \"Collapsible Silicone...\" and 3 more items"    -> "Collapsible Silicone"
export function subjectLabel(subject: string): string | null {
  let s = cleanSubject(subject);
  s = s.replace(/^(Ordered|Shipped|Delivered|Arriving|Out for delivery)\b[^:]*:\s*/i, "");
  s = s.replace(/\s*and\s+\d+\s+more\s+items?\.?$/i, "").replace(/,?\s*and more$/i, "");
  s = s.replace(/^\d+\s+/, "").replace(/\s+items?$/i, "");
  s = s.replace(/["“”]/g, "").replace(/\.{3}|…/g, "").trim();
  return s || null;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(INVISIBLE, "")
    .replace(/[ \t]*\n\s*/g, "\n")
    .trim();
}

const money = (s: string) => Number(s.replace(/,/g, ""));

// Grand total first; a shipment email only says "Total". Amazon renders
// "Grand Total:\n$170.66"; the plain-text part says "170.66 USD".
export function parseTotal(text: string): number | null {
  const pats = [
    /\*?Grand Total:?\s*\n?\s*\$\s*([\d,]+\.\d{2})/i,
    /\*?Grand Total:?\s*\n?\s*([\d,]+\.\d{2})\s*USD/i,
    /(?:^|\n)Total\s*\n\s*\$\s*([\d,]+\.\d{2})/,
    /Payment Authorization:\s*\n?\s*\$\s*([\d,]+\.\d{2})/i,
  ];
  for (const p of pats) {
    const m = text.match(p);
    if (m) return money(m[1]);
  }
  return null;
}

export function parseOrderId(text: string): string | null {
  const m = text.match(/\b(\d{3}-\d{7}-\d{7}|D\d{2}-\d{7}-\d{7})\b/);
  return m ? m[1] : null;
}

// Item rows: a name line, then "Quantity: N", then the price split across
// lines as "$", "71", "99".
export function parseItems(text: string): ReceiptItem[] {
  const lines = text.split("\n");
  const items: ReceiptItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    const q = lines[i].match(/^Quantity:\s*(\d+)/i);
    if (!q) continue;
    const name = lines[i - 1].replace(/\.{3}|…/g, "").trim();
    let price: number | undefined;
    if (lines[i + 1] === "$" && /^\d+$/.test(lines[i + 2] ?? "") && /^\d{2}$/.test(lines[i + 3] ?? "")) {
      price = Number(`${lines[i + 2]}.${lines[i + 3]}`);
    }
    if (name) items.push({ name, qty: Number(q[1]), price });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Gmail via gog (read-only allowlist: gmail.search + gmail.get, nothing else)

const GOG_BIN = process.env.ORDERS_GOG_BIN ?? path.join(os.homedir(), "scripts", "gogx");

function gog(args: string[], timeoutMs = 60_000): Promise<string> {
  const account = process.env.ORDERS_GMAIL_ACCOUNT;
  if (!account) return Promise.reject(new Error("ORDERS_GMAIL_ACCOUNT not set"));
  const full = ["--account", account, "--enable-commands-exact", "gmail.search,gmail.get", "--no-input", ...args];
  return new Promise((resolve, reject) => {
    execFile(GOG_BIN, full, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`gog ${args[1] ?? ""}: ${String(stderr || err.message).slice(0, 300)}`));
      resolve(stdout);
    });
  });
}

interface GmailThread { id: string; date: string; from: string; subject: string }

// Which senders/subjects carry a basket and a total.
function classifyEmail(from: string, subject: string): Receipt["kind"] | null {
  const s = cleanSubject(subject);
  if (/auto-confirm@amazon\.com/i.test(from) && /^Ordered\b/i.test(s)) return "ordered";
  if (/shipment-tracking@amazon\.com/i.test(from) && /^Shipped\b/i.test(s)) return "shipped";
  if (/Whole Foods Market order has been (delivered|received)/i.test(s)) return "wholefoods";
  if (/digital-no-reply@amazon\.com/i.test(from) && /order of/i.test(s)) return "digital";
  return null;
}

const SEARCH =
  "(from:auto-confirm@amazon.com OR from:shipment-tracking@amazon.com OR from:digital-no-reply@amazon.com " +
  'OR (from:order-update@amazon.com subject:"Whole Foods Market order"))';

function b64url(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] }
function findPart(p: GmailPart | undefined, mime: string): string | null {
  if (!p) return null;
  if (p.mimeType === mime && p.body?.data) return p.body.data;
  for (const c of p.parts ?? []) {
    const r = findPart(c, mime);
    if (r) return r;
  }
  return null;
}

export function receiptFromMessage(
  id: string, kind: Receipt["kind"], subject: string, date: string,
  msg: { body?: string; message?: { payload?: GmailPart } },
): Receipt {
  const html = findPart(msg.message?.payload, "text/html");
  const text = html ? htmlToText(b64url(html)) : (msg.body ?? "");
  let items = parseItems(text);
  let label = subjectLabel(subject);
  if (kind === "digital") {
    const m = text.match(/Placed on [^\n]*\n([^\n]+)\nSold by/i);
    const title = (m?.[1]?.trim() ?? cleanSubject(subject).replace(/^.*order of\s*/i, ""))
      .replace(/["“”]/g, "").replace(/\s+is confirmed.*$/i, "").replace(/\.$/, "").replace(/&#x27;/g, "'");
    items = [{ name: title, qty: 1, category: "Kindle book" }];
    label = `Kindle book: ${title}`;
  }
  // Whole Foods "received" carries the authorization, "delivered" the final charge.
  if (kind === "wholefoods") label = "Whole Foods Market groceries";
  const total = parseTotal(text);
  return {
    id, source: "gmail", kind, order_id: parseOrderId(text), date: date.slice(0, 10),
    total: total && total > 0 ? total : null, label, items, subject: cleanSubject(subject),
  };
}

function saveReceipt(r: Receipt): void {
  db().prepare(
    `INSERT INTO order_receipts (id, source, kind, order_id, date, total, label, items, subject)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, order_id=excluded.order_id, date=excluded.date,
       total=excluded.total, label=excluded.label, items=excluded.items, subject=excluded.subject`,
  ).run(r.id, r.source, r.kind, r.order_id, r.date, r.total, r.label, JSON.stringify(r.items), r.subject);
}

// Incremental: searches from a few days before the newest stored email (or
// `sinceDays` back on the first run) and fetches only message ids not yet stored.
export async function fetchGmailReceipts(opts: { sinceDays?: number; maxFetch?: number; rescan?: boolean } = {}): Promise<{
  searched: number; fetched: number; skipped: number; errors: number; lastError: string | null;
}> {
  ensureOrdersSchema();
  const d = db();
  const newest = (d.prepare(`SELECT MAX(date) AS m FROM order_receipts WHERE source='gmail'`).get() as { m: string | null }).m;
  const since = newest && !opts.rescan
    ? new Date(new Date(newest + "T12:00:00Z").getTime() - 5 * 86_400_000)
    : new Date(Date.now() - (opts.sinceDays ?? 400) * 86_400_000);
  const after = since.toISOString().slice(0, 10).replace(/-/g, "/");
  const out = await gog(["gmail", "search", `${SEARCH} after:${after}`, "--max", "500", "--all", "-j", "--results-only"], 180_000);
  const parsed = JSON.parse(out) as GmailThread[] | { threads?: GmailThread[] };
  const threads = Array.isArray(parsed) ? parsed : parsed.threads ?? [];
  const have = new Set((d.prepare(`SELECT id FROM order_receipts`).all() as { id: string }[]).map((r) => r.id));
  let fetched = 0, skipped = 0, errors = 0;
  let lastError: string | null = null;
  const max = opts.maxFetch ?? 1000;
  for (const t of threads) {
    const kind = classifyEmail(t.from, t.subject);
    if (!kind || have.has(t.id)) { skipped++; continue; }
    if (fetched >= max) break;
    try {
      const msg = JSON.parse(await gog(["gmail", "get", t.id, "-j"]));
      saveReceipt(receiptFromMessage(t.id, kind, t.subject, t.date, msg));
      fetched++;
    } catch (e) {
      errors++;
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { searched: threads.length, fetched, skipped, errors, lastError };
}

// ---------------------------------------------------------------------------
// Amazon "Your Orders" CSV (the Gmail-free input). Accepts the privacy-request
// export (Retail.OrderHistory.1.csv: Order ID, Order Date, Ship Date, Product
// Name, Quantity, Total Owed) and the older order-report shape (Order Date,
// Order ID, Title, Category, Quantity, Item Total). One receipt per order and
// ship date, because Amazon charges the card per shipment.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

function csvDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

export function receiptsFromCsv(text: string): Receipt[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length < 2) return [];
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const col = (...names: string[]) => names.map((n) => h.indexOf(n)).find((i) => i >= 0) ?? -1;
  const cOrder = col("order id"), cDate = col("order date"), cShip = col("ship date", "shipment date");
  const cName = col("product name", "title"), cCat = col("category"), cQty = col("quantity", "original quantity");
  const cAmt = col("total owed", "item total", "total charged");
  if (cOrder < 0 || cDate < 0 || cName < 0 || cAmt < 0) throw new Error("unrecognised Amazon CSV header");
  const groups = new Map<string, Receipt>();
  for (const r of rows.slice(1)) {
    const order = r[cOrder]?.trim();
    const date = csvDate((cShip >= 0 && csvDate(r[cShip] ?? "") ? r[cShip] : r[cDate]) ?? "");
    if (!order || !date) continue;
    const amt = Number(String(r[cAmt] ?? "").replace(/[$,]/g, ""));
    const key = `csv:${order}:${date}`;
    const g = groups.get(key) ?? {
      id: key, source: "csv" as const, kind: "csv" as const, order_id: order, date, total: 0, label: null,
      items: [], subject: null,
    };
    g.items.push({ name: r[cName]?.trim() ?? "", qty: Number(r[cQty] ?? 1) || 1, price: amt || undefined,
      category: cCat >= 0 ? r[cCat]?.trim() || undefined : undefined });
    g.total = Math.round(((g.total ?? 0) + (Number.isFinite(amt) ? amt : 0)) * 100) / 100;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const cats = [...new Set(g.items.map((i) => i.category).filter(Boolean))];
    g.label = cats.length ? cats.join(", ") : g.items.map((i) => i.name).join(", ").slice(0, 200);
    if (!g.total) g.total = null;
  }
  return [...groups.values()];
}

// Imports every data/*orders*.csv (or an explicit path). Idempotent by id.
export function importOrdersCsv(file?: string): { files: number; receipts: number } {
  ensureOrdersSchema();
  const dir = path.resolve(path.dirname(process.env.FINANCE_DB_PATH ?? "./data/finance.db"));
  const files = file ? [file] : (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => /order.*\.csv$/i.test(f)).map((f) => path.join(dir, f));
  let receipts = 0;
  for (const f of files) {
    for (const r of receiptsFromCsv(fs.readFileSync(f, "utf8"))) { saveReceipt(r); receipts++; }
  }
  return { files: files.length, receipts };
}

// ---------------------------------------------------------------------------
// Matching: card charge <-> receipt. Exact total (to the cent), txn dated from
// 2 days before to 14 days after the email. Shipment-level receipts beat order
// emails (that is what the card is charged for), then the nearest date. Each
// receipt and each transaction is used at most once. Recomputed from scratch
// every run, so it is idempotent and follows pending -> posted id changes.

export const AMAZON_TXN = /amazon|amzn|kindle|whole ?foods|wholefds/i;

export function matchReceipts(): { matched: number; split: number; candidates: number; receipts: number } {
  ensureOrdersSchema();
  const d = db();
  const txns = (d.prepare(
    `SELECT id, date, amount, name, merchant FROM transactions WHERE amount > 0`,
  ).all() as { id: string; date: string; amount: number; name: string | null; merchant: string | null }[])
    .filter((t) => AMAZON_TXN.test(`${t.name ?? ""} ${t.merchant ?? ""}`));
  const recs = d.prepare(
    `SELECT id, kind, date, total FROM order_receipts WHERE total IS NOT NULL`,
  ).all() as { id: string; kind: string; date: string; total: number }[];
  const day = (s: string) => Date.parse(s + "T12:00:00Z") / 86_400_000;
  const pairs: { t: string; r: string; score: number }[] = [];
  const byCents = new Map<number, typeof recs>();
  for (const r of recs) {
    const k = Math.round(r.total * 100);
    byCents.set(k, [...(byCents.get(k) ?? []), r]);
  }
  for (const t of txns) {
    for (const r of byCents.get(Math.round(t.amount * 100)) ?? []) {
      const diff = day(t.date) - day(r.date);
      if (diff < -2 || diff > 14) continue;
      pairs.push({ t: t.id, r: r.id, score: (r.kind === "ordered" ? 100 : 0) + Math.abs(diff) });
    }
  }
  pairs.sort((a, b) => a.score - b.score || a.t.localeCompare(b.t) || a.r.localeCompare(b.r));
  const links = new Map<string, { r: string; how: "exact" | "split" }>();
  const usedR = new Set<string>();
  for (const p of pairs) {
    if (links.has(p.t) || usedR.has(p.r)) continue;
    links.set(p.t, { r: p.r, how: "exact" });
    usedR.add(p.r);
  }

  // Split charges: 2-3 still-unmatched charges posted within 3 days of each
  // other that sum to the cent to one still-unmatched receipt.
  const free = txns.filter((t) => !links.has(t.id)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const freeR = recs.filter((r) => !usedR.has(r.id)).sort((a, b) => (a.kind === "ordered" ? 1 : 0) - (b.kind === "ordered" ? 1 : 0) || a.date.localeCompare(b.date));
  const cents = (x: number) => Math.round(x * 100);
  for (const r of freeR) {
    const near = free.filter((t) => !links.has(t.id) && day(t.date) - day(r.date) >= -2 && day(t.date) - day(r.date) <= 14
      && cents(t.amount) < cents(r.total));
    let found: typeof near | null = null;
    for (let i = 0; i < near.length && !found; i++) {
      for (let j = i + 1; j < near.length && !found; j++) {
        if (Math.abs(day(near[i].date) - day(near[j].date)) > 3) continue;
        const s2 = cents(near[i].amount) + cents(near[j].amount);
        if (s2 === cents(r.total)) { found = [near[i], near[j]]; break; }
        for (let k = j + 1; k < near.length; k++) {
          if (Math.abs(day(near[i].date) - day(near[k].date)) > 3) continue;
          if (s2 + cents(near[k].amount) === cents(r.total)) { found = [near[i], near[j], near[k]]; break; }
        }
      }
    }
    if (found) for (const t of found) links.set(t.id, { r: r.id, how: "split" });
  }

  d.exec("BEGIN");
  try {
    d.exec(`DELETE FROM receipt_txns`);
    const ins = d.prepare(`INSERT INTO receipt_txns (txn_id, receipt_id, how) VALUES (?, ?, ?)`);
    for (const [t, l] of links) ins.run(t, l.r, l.how);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  const split = [...links.values()].filter((l) => l.how === "split").length;
  return { matched: links.size, split, candidates: txns.length, receipts: recs.length };
}

// The matched receipt plus what the rest of its order says: Amazon's mid-2026
// order email lists item names but a $0.00 total, while the shipment email has
// the total and only a category label, so both halves are read together.
export interface TxnReceipt {
  receipt_id: string; how: string; kind: string; order_id: string | null; date: string; total: number | null;
  labels: string[]; items: ReceiptItem[];
}
export function receiptForTxn(txnId: string): TxnReceipt | null {
  ensureOrdersSchema();
  const d = db();
  const r = d.prepare(
    `SELECT r.*, x.how FROM receipt_txns x JOIN order_receipts r ON r.id = x.receipt_id WHERE x.txn_id=?`,
  ).get(txnId) as (Omit<Receipt, "items"> & { items: string; how: string }) | undefined;
  if (!r) return null;
  const sibs = r.order_id
    ? d.prepare(`SELECT label, items FROM order_receipts WHERE order_id=? AND id != ?`).all(r.order_id, r.id) as
      { label: string | null; items: string | null }[]
    : [];
  const labels = [...new Set([r.label, ...sibs.map((s) => s.label)].filter((x): x is string => !!x))];
  const items: ReceiptItem[] = [];
  const seen = new Set<string>();
  for (const list of [r.items, ...sibs.map((s) => s.items)]) {
    for (const it of JSON.parse(list || "[]") as ReceiptItem[]) {
      const k = it.name.toLowerCase();
      if (!seen.has(k)) { seen.add(k); items.push(it); }
    }
  }
  return { receipt_id: r.id, how: r.how, kind: r.kind, order_id: r.order_id, date: r.date, total: r.total, labels, items };
}
