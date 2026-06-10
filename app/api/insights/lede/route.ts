import { NextRequest, NextResponse } from "next/server";
import { gatherInsights, narrateLede } from "@/lib/insights";

export const dynamic = "force-dynamic";

// Out-of-band one-line lede over the current feed. The client calls this AFTER
// the cards have rendered, so a cold model boot (~30-60s) or a gateway outage never
// blocks the Overview — it just means the lede shows up a few seconds late, or
// not at all. Best-effort by design: returns { lede: null } on any model
// failure, and caches a successful result for the rest of the day (per feed sig).
export async function POST(req: NextRequest) {
  const entity = new URL(req.url).searchParams.get("entity");
  const insights = gatherInsights(entity);
  const r = await narrateLede(insights);
  return NextResponse.json({ lede: r?.lede ?? null, model: r?.model ?? null });
}
