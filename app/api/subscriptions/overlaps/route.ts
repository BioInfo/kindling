import { NextResponse } from "next/server";
import { detectOverlaps } from "@/lib/subscriptions";

export const dynamic = "force-dynamic";

// Semantic redundancy groups ("4 streaming services = $X/mo") — one local-model
// pass over the active subscriptions. Best-effort: a model outage returns [].
export async function GET(req: Request) {
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity");
  try {
    return NextResponse.json(await detectOverlaps(entity));
  } catch (e: unknown) {
    return NextResponse.json({ groups: [], error: e instanceof Error ? e.message : String(e) }, { status: 200 });
  }
}
