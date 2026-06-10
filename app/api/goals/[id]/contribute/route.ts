import { NextRequest, NextResponse } from "next/server";
import { contribute } from "@/lib/goals";

export const dynamic = "force-dynamic";

// POST: log a deposit against a goal { amount, source? }. amount is signed —
// positive deposit, negative withdrawal/correction. source labels the origin
// ('manual' default, or 'underspend:<Category>' for a budget sweep). The
// increment is atomic and clamped at 0; returns the new saved total + applied.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const goalId = Number(id);
  if (!Number.isFinite(goalId)) return NextResponse.json({ error: "valid goal id required" }, { status: 400 });

  const b = await req.json().catch(() => ({}));
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    return NextResponse.json({ error: "amount must be a non-zero number" }, { status: 400 });
  }
  const source = typeof b.source === "string" && b.source.trim() ? b.source.trim().slice(0, 64) : "manual";

  try {
    const res = contribute(goalId, amount, source);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "contribute failed" }, { status: 404 });
  }
}
