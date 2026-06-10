import { NextRequest, NextResponse } from "next/server";
import { forecast } from "@/lib/forecast";

export const dynamic = "force-dynamic";

// Cash-flow forecast over 30 / 60 / 90 days (default 90). Discretionary burn
// layer is on by default; pass disc=0 for the scheduled-only view.
// Whole-portfolio; not entity-filtered (mirrors /api/networth).
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const days = Number(url.searchParams.get("days"));
  const discretionary = url.searchParams.get("disc") !== "0";
  return NextResponse.json(forecast({ days, discretionary }));
}
