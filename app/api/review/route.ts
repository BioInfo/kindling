import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// The "To Review" inbox: transactions most likely to be mislabeled.
// Surfaces low-confidence LLM calls AND high-value rows (where a wrong
// category matters most) that haven't been reviewed yet.
export async function GET() {
  const d = db();
  const rows = d.prepare(
    `SELECT t.id, t.date, t.name, t.merchant, t.amount, t.currency,
            t.category, t.category_source, t.confidence, t.entity, a.name AS account
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.reviewed = 0
       AND (
         t.category IS NULL
         OR t.category = 'Other'
         -- "large" only matters for AI/Plaid guesses; a rule/manual recurring bill
         -- (mortgage, payroll) is already blessed and shouldn't loiter in review.
         OR (t.category_source IN ('plaid','llm') AND (COALESCE(t.confidence,0) < 0.9 OR ABS(t.amount) >= 1000))
       )
     ORDER BY ABS(t.amount) DESC, t.date DESC
     LIMIT 100`
  ).all();
  return NextResponse.json({ review: rows, count: rows.length });
}
