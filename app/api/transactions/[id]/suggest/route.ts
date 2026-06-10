import { NextResponse } from "next/server";
import { suggestCategory } from "@/lib/categorize";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// One-tap AI category suggestion for a single transaction (To-Review ✨ Suggest).
// Read-only — returns { category, confidence }. The client applies it via the
// normal PATCH path, which remembers the merchant and backfills siblings.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const s = await suggestCategory(id);
    if (!s) return NextResponse.json({ error: "no suggestion" }, { status: 404 });
    return NextResponse.json({ ok: true, ...s });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
