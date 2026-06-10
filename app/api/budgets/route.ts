import { NextRequest, NextResponse } from "next/server";
import { listBudgets, upsertBudget, deleteBudget, BUDGETABLE } from "@/lib/budgets";

export const dynamic = "force-dynamic";

// GET: budgets with this month's actuals + month meta + seed suggestions.
// Actuals respect the entity filter; targets are global.
export async function GET(req: NextRequest) {
  const entity = new URL(req.url).searchParams.get("entity"); // personal | business | null=all
  return NextResponse.json(listBudgets(entity));
}

// POST: upsert one budget { category, amount, bucket?, rollover? }.
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b.category || !(BUDGETABLE as readonly string[]).includes(b.category)) {
    return NextResponse.json({ error: "valid budgetable category required" }, { status: 400 });
  }
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return NextResponse.json({ error: "amount must be a non-negative number" }, { status: 400 });
  }
  upsertBudget(b.category, amount, b.bucket, b.rollover);
  return NextResponse.json({ ok: true });
}

// DELETE: remove a budget by ?category=.
export async function DELETE(req: NextRequest) {
  const category = new URL(req.url).searchParams.get("category");
  if (!category) return NextResponse.json({ error: "category required" }, { status: 400 });
  deleteBudget(category);
  return NextResponse.json({ ok: true });
}
