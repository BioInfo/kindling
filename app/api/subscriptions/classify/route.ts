import { NextResponse } from "next/server";
import { classifySubscriptionTypes, listSubscriptions } from "@/lib/subscriptions";

export const dynamic = "force-dynamic";

// ✨ Classify: the local model labels the unknown-type tail (subscription /
// membership / obligation), so the mortgage-vs-Netflix split sharpens beyond the
// rule defaults. Never clobbers a type already set by a rule or by you.
export async function POST(req: Request) {
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity");
  let result = { processed: 0, updated: 0 };
  try {
    result = await classifySubscriptionTypes();
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  return NextResponse.json({ ...result, ...listSubscriptions(entity) });
}
