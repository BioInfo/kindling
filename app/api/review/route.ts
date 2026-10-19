import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { REVIEW_CATCHALL, REVIEW_WHERE } from "@/lib/categorize";

export const dynamic = "force-dynamic";

// The "To Review" inbox: transactions most likely to be mislabeled.
// Surfaces low-confidence LLM calls AND high-value rows (where a wrong
// category matters most) that haven't been reviewed yet.
// Paginated server-side so every row the badge counts is reachable:
//   ?limit=10&offset=0&q=&sort=amount|date|name&dir=desc|asc&filter=all|catchall
export async function GET(req: NextRequest) {
  const d = db();
  const p = new URL(req.url).searchParams;
  const limit = Math.min(Math.max(Number(p.get("limit")) || 10, 1), 500);
  const offset = Math.max(Number(p.get("offset")) || 0, 0);
  const q = (p.get("q") ?? "").trim().toLowerCase();
  const dir = p.get("dir") === "asc" ? "ASC" : "DESC";
  const sortCol = { date: "t.date", name: "lower(COALESCE(t.merchant, t.name, ''))" }[p.get("sort") ?? ""] ?? "ABS(t.amount)";
  const catchall = p.get("filter") === "catchall";

  // REVIEW_WHERE uses bare column names; scope it to t via a subquery.
  const base = `FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.id IN (SELECT id FROM transactions WHERE ${REVIEW_WHERE})`;
  const search = q ? ` AND instr(lower(COALESCE(t.merchant,'') || ' ' || COALESCE(t.name,'') || ' ' || COALESCE(t.category,'')), ?) > 0` : "";
  const seg = catchall ? ` AND t.id IN (SELECT id FROM transactions WHERE ${REVIEW_CATCHALL})` : "";
  const args = q ? [q] : [];

  const rows = d.prepare(
    `SELECT t.id, t.date, t.name, t.merchant, t.amount, t.currency,
            t.category, t.category_source, t.confidence, t.entity, a.name AS account
     ${base}${search}${seg}
     ORDER BY ${sortCol} ${dir}, t.date DESC, t.id
     LIMIT ? OFFSET ?`
  ).all(...args, limit, offset);
  const n = (extra: string) => (d.prepare(`SELECT COUNT(*) AS n ${base}${search}${extra}`).get(...args) as { n: number }).n;
  const all = n("");
  const catchallCount = n(` AND t.id IN (SELECT id FROM transactions WHERE ${REVIEW_CATCHALL})`);
  return NextResponse.json({
    review: rows, count: rows.length,
    total: catchall ? catchallCount : all, all, catchall: catchallCount, limit, offset,
  });
}
