import { NextRequest, NextResponse } from "next/server";
import { gatherInsights, dismissInsights, ledeSig, cachedLede } from "@/lib/insights";

export const dynamic = "force-dynamic";

// The proactive "What to know" feed. Returns the ranked insights, a per-day
// signature over them, and any ALREADY-CACHED one-line lede (instant). The lede
// is generated out-of-band by POST /api/insights/lede after the cards render —
// never here — so the daily glance is instant and never cold-boot-stalls.
export async function GET(req: NextRequest) {
  const entity = new URL(req.url).searchParams.get("entity");
  const insights = gatherInsights(entity);
  const sig = ledeSig(insights);
  return NextResponse.json({ insights, sig, lede: cachedLede(sig)?.lede ?? null });
}

// Dismiss one or more insights by their stable key. Pass a single key to clear
// one, or every visible key to "dismiss all". Returns the refreshed feed
// (entity-scoped) so the client renders without a refetch.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const keys: unknown = body?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    return NextResponse.json({ error: "keys required" }, { status: 400 });
  }
  dismissInsights(keys.filter((k): k is string => typeof k === "string" && !!k));
  const entity = new URL(req.url).searchParams.get("entity");
  const insights = gatherInsights(entity);
  const sig = ledeSig(insights);
  return NextResponse.json({ ok: true, insights, sig, lede: cachedLede(sig)?.lede ?? null });
}
