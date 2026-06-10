import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Spend-by-category for a window, excluding internal money movement (transfers,
// CC payments) so "spending" means actual outflow. Optional entity filter.
const EXCLUDE = ["Transfer:Internal", "Transfer:Brokerage", "Transfer:P2P", "CreditCardPayment", "Income"];

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const days = Number(url.searchParams.get("days") ?? "30");
  const entity = url.searchParams.get("entity"); // personal | business | null=all

  const d = db();
  const placeholders = EXCLUDE.map(() => "?").join(",");
  const args: unknown[] = [...EXCLUDE, `-${days} days`];
  let entityClause = "";
  if (entity) { entityClause = "AND entity = ?"; args.push(entity); }

  const byCat = d.prepare(
    `SELECT category, SUM(amount) AS spent, COUNT(*) AS n
     FROM transactions
     WHERE amount > 0
       AND category NOT IN (${placeholders})
       AND date >= date('now', ?)
       ${entityClause}
     GROUP BY category
     ORDER BY spent DESC`
  ).all(...(args as never[]));

  const total = (byCat as { spent: number }[]).reduce((s, r) => s + (r.spent ?? 0), 0);
  return NextResponse.json({ days, entity: entity ?? "all", total, byCategory: byCat });
}
