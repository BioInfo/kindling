import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat, extractJson } from "@/lib/llm";

export const dynamic = "force-dynamic";

// Opt-in AI note draft for a transaction. User-triggered only (never auto-run):
// web-search the descriptor via the configured search gateway (only the
// descriptor leaves your network) and have the LOCAL model write a short, factual
// note for the user's own records. Grounded — it must not invent specifics it
// can't see. Internal movement / income skips egress entirely.

const SEARCH = process.env.LITESEARCH_URL ?? "http://localhost:8899";

const SYSTEM = `You write a SHORT factual note for one of the user's own bank/card transactions, for their records.
You are given the descriptor, merchant, amount, date, category, account, and (maybe) web snippets. Return ONLY JSON:
{ "note": "<one or two plain sentences>", "confidence": "<high|medium|low>" }
Rules:
- State what the charge most likely is, grounded in the descriptor + snippets. Identify the merchant/service plainly.
- You MAY note if it looks recurring (e.g. a monthly subscription/transfer) only if the descriptor/category supports it.
- Do NOT invent amounts, dates, account numbers, people, or purposes you can't see. Vague-but-true beats specific-but-guessed.
- No marketing language. No first person. Just the note.`;

const INTERNAL: Record<string, string> = {
  "Transfer:Internal": "Transfer between your own accounts.",
  "Transfer:Brokerage": "Transfer into a brokerage/investment account.",
  "Transfer:P2P": "Peer-to-peer transfer.",
  "CreditCardPayment": "Credit-card payment.",
  "Income": "Income deposit.",
};

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = db().prepare(
    `SELECT t.name, t.merchant, t.amount, t.date, t.category,
            a.name AS account, COALESCE(i.institution_name, i.institution) AS institution
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     LEFT JOIN items i ON i.id = a.item_id WHERE t.id=?`
  ).get(id) as
    | { name: string; merchant: string | null; amount: number; date: string; category: string | null; account: string; institution: string | null }
    | undefined;
  if (!t) return NextResponse.json({ error: "unknown transaction" }, { status: 404 });

  // Internal movement / income: a plain factual note, no egress, no model call.
  if (t.category && INTERNAL[t.category]) {
    const dir = t.amount > 0 ? "out of" : "into";
    return NextResponse.json({
      note: `${INTERNAL[t.category]} $${Math.abs(t.amount).toFixed(2)} ${dir} ${t.institution ?? t.account}.`,
      sources: [],
    });
  }

  const q = t.name.replace(/\b\d{7,}\b/g, " ").replace(/\s+#?\d{2,}\b/g, " ").replace(/\s+/g, " ").trim() || t.name;

  let snippets: { title: string; content: string; url: string }[] = [];
  try {
    const res = await fetch(`${SEARCH}/search?q=${encodeURIComponent(q + " merchant")}`, {
      signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "kindling/1.0" },
    });
    if (res.ok) {
      const d = await res.json();
      snippets = (d.results ?? []).slice(0, 6).map((r: { title?: string; content?: string; url?: string }) => ({
        title: r.title ?? "", content: (r.content ?? "").slice(0, 300), url: r.url ?? "",
      }));
    }
  } catch { /* best-effort; model can still reason from the descriptor */ }

  const userMsg = `Descriptor: "${t.name}"
Merchant: ${t.merchant ?? "(none)"}
Amount: $${Math.abs(t.amount).toFixed(2)} ${t.amount > 0 ? "(outflow)" : "(inflow)"}
Date: ${t.date}
Category: ${t.category ?? "(none)"}
Account: ${t.institution ?? t.account}

Web search snippets:
${snippets.length ? snippets.map((s, i) => `${i + 1}. ${s.title} — ${s.content}`).join("\n") : "(no results)"}`;

  let out: Record<string, unknown> | null = null;
  try {
    const reply = await chat([{ role: "system", content: SYSTEM }, { role: "user", content: userMsg }], { maxTokens: 200 });
    out = extractJson(reply);
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  const note = out && typeof out.note === "string" ? out.note.trim() : null;
  if (!note) return NextResponse.json({ error: "could not draft a note" }, { status: 502 });

  return NextResponse.json({ note, sources: snippets.map((s) => ({ title: s.title, url: s.url })).slice(0, 3) });
}
