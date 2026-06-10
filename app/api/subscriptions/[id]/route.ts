import { NextResponse } from "next/server";
import { getSubscription, updateSubscription } from "@/lib/subscriptions";

export const dynamic = "force-dynamic";

// One subscription + its member transactions (price history + charge list for
// the detail modal).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = getSubscription(decodeURIComponent(id));
  if (!data) return NextResponse.json({ error: "unknown subscription" }, { status: 404 });
  return NextResponse.json(data);
}

// Patch user-owned fields (state / type / merchant / category / note / trial_ends
// / entity / color / icon). Detection columns are never touched here.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const ok = updateSubscription(decodeURIComponent(id), body);
  return NextResponse.json({ ok });
}

// Soft delete = dismiss. The row stays (so reconcile won't re-add it) but drops
// out of the list and the totals; reconcile never resurrects a dismissed row.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = updateSubscription(decodeURIComponent(id), { state: "dismissed" });
  return NextResponse.json({ ok });
}
