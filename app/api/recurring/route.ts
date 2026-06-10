import { NextRequest, NextResponse } from "next/server";
import { detectRecurring } from "@/lib/recurring";

export const dynamic = "force-dynamic";

// Detected recurring charges + income, with monthly-normalized totals.
export async function GET(req: NextRequest) {
  const entity = new URL(req.url).searchParams.get("entity"); // personal | business | null=all
  const all = detectRecurring({ entity });
  const expenses = all.filter((r) => r.direction === "expense");
  const income = all.filter((r) => r.direction === "income");
  return NextResponse.json({
    recurring: expenses,
    income,
    monthlyExpense: Math.round(expenses.reduce((s, r) => s + r.monthly, 0) * 100) / 100,
    monthlyIncome: Math.round(income.reduce((s, r) => s + r.monthly, 0) * 100) / 100,
  });
}
