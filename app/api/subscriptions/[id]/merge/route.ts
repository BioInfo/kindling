import { NextResponse } from "next/server";
import { mergeSubscription, unmergeSubscription, markNotDuplicate } from "@/lib/subscriptions";

export const dynamic = "force-dynamic";

// POST {into: "<id>"}  fold this row into another service (survives reconcile).
// POST {notDuplicate: true}  stop flagging it as a possible duplicate.
// DELETE  unmerge this alias back into its own row; the auto pass leaves it alone.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  const body = await req.json().catch(() => ({}));
  if (body?.notDuplicate) return NextResponse.json({ ok: markNotDuplicate(id) });
  if (typeof body?.into !== "string" || !body.into) return NextResponse.json({ ok: false, error: "into required" }, { status: 400 });
  return NextResponse.json({ ok: mergeSubscription(id, body.into) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  return NextResponse.json({ ok: unmergeSubscription(id) });
}
