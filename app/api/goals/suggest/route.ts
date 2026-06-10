import { NextResponse } from "next/server";
import { suggestGoals } from "@/lib/goals";

export const dynamic = "force-dynamic";

// GET: data-grounded goal proposals (emergency fund from spend, tax reserve from
// the safe-harbor gap, set-aside for the biggest upcoming equity vest). The client
// reviews + tweaks, then creates the kept ones via the existing POST /api/goals.
export async function GET() {
  return NextResponse.json(suggestGoals());
}
