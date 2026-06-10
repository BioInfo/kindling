import { NextRequest, NextResponse } from "next/server";
import { suggestBudgets } from "@/lib/budgets";

export const dynamic = "force-dynamic";

// GET: AI-seeded budget proposals from trailing spend, bucket-aware. Numbers
// come from the DB (suggestBudgets); the client reviews + tweaks before saving
// each via the existing POST /api/budgets. Entity filter mirrors the rest of
// the budgets surface (personal | business | null=all).
export async function GET(req: NextRequest) {
  const entity = new URL(req.url).searchParams.get("entity");
  return NextResponse.json(suggestBudgets(entity));
}
