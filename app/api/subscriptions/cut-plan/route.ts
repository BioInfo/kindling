import { NextResponse } from "next/server";
import { buildCutPlan } from "@/lib/subscriptions";

export const dynamic = "force-dynamic";

// ✨ Cut plan: synthesize unused + price-hikes + overlaps + trials into one
// ranked "cancel these N, recover $X/yr" list. The local model ranks + writes a
// reason per item, but the plan degrades to a deterministic flag-based list if
// the model is cold/down — best-effort, never fatal. Read-only.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity");
  try {
    return NextResponse.json(await buildCutPlan(entity));
  } catch (e: unknown) {
    return NextResponse.json(
      { headline: "Nothing to cut", items: [], totalMonthly: 0, totalAnnual: 0, aiUsed: false, error: e instanceof Error ? e.message : String(e) },
      { status: 200 },
    );
  }
}
