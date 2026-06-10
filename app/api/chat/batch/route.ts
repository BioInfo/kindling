import { NextRequest, NextResponse } from "next/server";
import { applyBatch } from "@/lib/chat";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Applies per-row category choices from the "fix Other" batch flow.
// Body: { items: [{id, category}, ...] }. Parameterized UPDATE per id; no LLM here.
export async function POST(req: NextRequest) {
  try {
    const { items } = await req.json();
    if (!Array.isArray(items) || !items.length) {
      return NextResponse.json({ error: "no items" }, { status: 400 });
    }
    const { updated } = applyBatch(items);
    db().prepare(`INSERT INTO chat_messages (role, content) VALUES ('assistant', ?)`)
      .run(`✓ Categorized ${updated} transaction${updated === 1 ? "" : "s"}.`);
    return NextResponse.json({ ok: true, updated });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
