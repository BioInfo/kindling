import { NextRequest, NextResponse } from "next/server";
import { askMoney, classifyIntent, proposeEdit, proposeBatchCategories } from "@/lib/chat";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 200;

// GET: chat history (most recent 100, chronological).
export async function GET() {
  const rows = db().prepare(
    `SELECT id, role, content, model, sql, created_at
     FROM chat_messages ORDER BY id ASC LIMIT 100`
  ).all();
  return NextResponse.json({ messages: rows });
}

// POST: ask a question with a chosen model; persists both turns.
export async function POST(req: NextRequest) {
  try {
    const { question, model } = await req.json();
    if (!question || typeof question !== "string") {
      return NextResponse.json({ error: "missing question" }, { status: 400 });
    }
    const d = db();
    // Persist the user turn, but remember its id so we can roll it back if the
    // model is unreachable (don't leave an orphaned question with no answer).
    const userTurn = d.prepare(
      `INSERT INTO chat_messages (role, content, model) VALUES ('user', ?, ?)`
    ).run(question, model ?? null);

    let r;
    try {
      // Fast path: "fix/categorize my Other expenses" → batch suggestion flow.
      if (/\b(categor|fix|clean\s*up|sort)\w*\b/i.test(question) && /\b(other|uncategor)\w*\b/i.test(question)) {
        const batch = await proposeBatchCategories(model);
        if ("error" in batch) {
          r = { error: batch.error };
        } else {
          d.prepare(`INSERT INTO chat_messages (role, content, model) VALUES ('assistant', ?, ?)`)
            .run(`Suggested categories for ${batch.items.length} transactions`, model ?? null);
          return NextResponse.json({ batch });
        }
      }
      // Route: is this a question (read) or a request to change something (edit)?
      const intent = r ? "ask" : await classifyIntent(question, model);
      if (!r && intent === "edit") {
        const proposal = await proposeEdit(question, model);
        if ("error" in proposal) {
          r = { error: proposal.error };
        } else {
          // Don't write yet — return a proposal for the user to confirm.
          // Persist a short assistant note so history reads sensibly.
          d.prepare(`INSERT INTO chat_messages (role, content, model) VALUES ('assistant', ?, ?)`)
            .run(`Proposed: ${proposal.summary}`, model ?? null);
          return NextResponse.json({ proposal });
        }
      } else {
        r = await askMoney(question, model);
      }
    } catch (e: unknown) {
      d.prepare(`DELETE FROM chat_messages WHERE id=?`).run(Number(userTurn.lastInsertRowid));
      const raw = e instanceof Error ? e.message : String(e);
      const friendly = /timeout|aborted|ECONNREFUSED|fetch failed|502|503|504/i.test(raw)
        ? "The local model isn't responding (it may be cold-starting or down). Try again in a moment."
        : `Chat error: ${raw}`;
      return NextResponse.json({ error: friendly }, { status: 503 });
    }

    const answer = r.answer ?? (r.error ? `⚠ ${r.error}` : "no answer");
    d.prepare(`INSERT INTO chat_messages (role, content, model, sql) VALUES ('assistant', ?, ?, ?)`)
      .run(answer, model ?? null, r.sql ?? null);

    return NextResponse.json(r);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE: clear chat history.
export async function DELETE() {
  db().prepare(`DELETE FROM chat_messages`).run();
  return NextResponse.json({ ok: true });
}
