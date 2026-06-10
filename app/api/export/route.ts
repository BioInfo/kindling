import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// CSV export of transactions, filtered by entity + optional date range. Built for
// the business-expense / tax view, but works for any filter.
function cell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity"); // personal | business | null=all
  const from = url.searchParams.get("from");     // YYYY-MM-DD
  const to = url.searchParams.get("to");
  const d = db();

  const where: string[] = [];
  const args: unknown[] = [];
  if (entity) { where.push("t.entity = ?"); args.push(entity); }
  if (from) { where.push("t.date >= ?"); args.push(from); }
  if (to) { where.push("t.date <= ?"); args.push(to); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = d.prepare(
    `SELECT t.date, COALESCE(t.merchant, '') AS merchant, t.name,
            COALESCE(t.category, '') AS category, t.entity, t.amount,
            COALESCE(t.currency, 'USD') AS currency, a.name AS account
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     ${clause} ORDER BY t.date DESC, t.id DESC`
  ).all(...(args as never[])) as Record<string, unknown>[];

  const cols = ["date", "merchant", "name", "category", "entity", "amount", "currency", "account"];
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
  const fname = `plaid-${entity ?? "all"}-${from ?? "start"}_${to ?? "now"}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fname}"`,
    },
  });
}
