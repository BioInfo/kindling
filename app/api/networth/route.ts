import { NextResponse } from "next/server";
import { captureSnapshot, adjustedTrend, byAccountType } from "@/lib/networth";

export const dynamic = "force-dynamic";

// Current net worth + the connection-adjusted trend + an assets/liabilities
// breakdown. Opening the dashboard records today's point (and backfills any
// missing connection events), so the trend fills in even on days without a sync.
// The trend's change excludes accounts you merely connected this window — that's
// new visibility, not new wealth.
export async function GET() {
  const current = captureSnapshot();
  const trend = adjustedTrend(180);
  return NextResponse.json({
    current,
    series: trend.series,
    change: trend.change,
    linkedExcluded: trend.linkedExcluded,
    byType: byAccountType(),
  });
}
