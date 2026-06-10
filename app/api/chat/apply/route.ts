import { NextRequest, NextResponse } from "next/server";
import { applyEdit } from "@/lib/chat";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Applies a confirmed edit proposal. The body comes from a proposal the chat
// produced; we only ever pass ids + whitelisted changes to applyEdit (which runs
// a parameterized UPDATE). The LLM is not in this path at all.
export async function POST(req: NextRequest) {
  try {
    const { ids, changes, summary } = await req.json();
    if (!Array.isArray(ids) || !ids.length || typeof changes !== "object") {
      return NextResponse.json({ error: "missing ids or changes" }, { status: 400 });
    }
    const { updated } = applyEdit(ids, changes);
    const note = `✓ Applied: ${summary ?? "change"} (${updated} transaction${updated === 1 ? "" : "s"})`;
    db().prepare(`INSERT INTO chat_messages (role, content) VALUES ('assistant', ?)`).run(note);
    return NextResponse.json({ ok: true, updated });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
