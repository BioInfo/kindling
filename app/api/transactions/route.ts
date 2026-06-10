import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity"); // personal | business | null=all
  // Optional drill-down filters (used by the Overview click-throughs). Absent →
  // unchanged behavior. category = exact match; q = merchant/name substring;
  // days = trailing window.
  const category = url.searchParams.get("category");
  const q = url.searchParams.get("q");
  const days = url.searchParams.get("days");
  const account = url.searchParams.get("account"); // account id filter
  // Sort: whitelist column + direction (default newest first).
  const sortKey = url.searchParams.get("sort"); // date | amount | merchant
  const sortCol = sortKey === "amount" ? "ABS(t.amount)"
    : sortKey === "merchant" ? "lower(COALESCE(t.merchant, t.name))"
    : "t.date";
  const dir = url.searchParams.get("dir") === "asc" ? "ASC" : "DESC";
  // Pagination: clamp page size to a sane range so a bad query can't pull everything.
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50"), 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? "0"), 0);
  const d = db();

  const conds: string[] = [];
  const fargs: unknown[] = [];
  if (entity) { conds.push("t.entity = ?"); fargs.push(entity); }
  if (category) { conds.push(category === "Uncategorized" ? "(t.category IS NULL OR t.category = '')" : "t.category = ?"); if (category !== "Uncategorized") fargs.push(category); }
  if (account) { conds.push("t.account_id = ?"); fargs.push(account); }
  if (q) { conds.push("(COALESCE(t.merchant, t.name) LIKE ? OR t.name LIKE ?)"); fargs.push(`%${q}%`, `%${q}%`); }
  if (days && Number(days) > 0) { conds.push("t.date >= date('now', ?)"); fargs.push(`-${Number(days)} days`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const txns = d.prepare(
    `SELECT t.id, t.date, t.name, t.merchant, t.amount, t.currency, t.pending,
            t.category, t.category_source, t.confidence, t.entity, t.reviewed,
            a.name AS account, a.mask AS account_mask,
            COALESCE(i.institution_name, i.institution) AS account_institution
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     LEFT JOIN items i ON i.id = a.item_id
     ${where}
     ORDER BY ${sortCol} ${dir}, t.id DESC LIMIT ? OFFSET ?`
  ).all(...([...fargs, limit, offset] as never[]));

  const totalRow = d.prepare(
    `SELECT COUNT(*) AS n FROM transactions t ${where}`
  ).get(...(fargs as never[])) as unknown as { n: number };

  const accounts = d.prepare(
    `SELECT a.id, a.name, a.mask, a.type, a.subtype, a.current_balance, a.currency,
            COALESCE(i.institution_name, i.institution) AS institution
     FROM accounts a LEFT JOIN items i ON i.id = a.item_id`
  ).all();

  const netWorth = d.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type='credit' OR type='loan'
       THEN -current_balance ELSE current_balance END), 0) AS net
     FROM accounts`
  ).get() as unknown as { net: number };

  const reviewCount = d.prepare(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE reviewed = 0 AND (
       category IS NULL OR category = 'Other'
       OR (category_source IN ('plaid','llm') AND (COALESCE(confidence,0) < 0.9 OR ABS(amount) >= 1000)))`
  ).get() as unknown as { n: number };

  return NextResponse.json({
    txns, accounts, netWorth: netWorth.net, reviewCount: reviewCount.n,
    total: totalRow.n, limit, offset,
  });
}
