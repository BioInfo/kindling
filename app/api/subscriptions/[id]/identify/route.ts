import { NextResponse } from "next/server";
import { getSubscription } from "@/lib/subscriptions";
import { chat, extractJson } from "@/lib/llm";

export const dynamic = "force-dynamic";

// ✨ Identify the real merchant behind a cryptic subscription name ("RENEWAL
// MEMBERSHIP FEE" → "Amex Platinum annual fee"). Mirrors the transaction
// /identify route but is keyed to the subscription: it searches the raw bank
// descriptor (a member charge's name if we have one, else the stored merchant —
// only that string leaves your network) and the local model names it. Read-only;
// the modal stages the suggested name as an edit you review and Save.

const SEARCH = process.env.LITESEARCH_URL ?? "http://localhost:8899";

const SYSTEM = `You identify the real-world merchant behind a recurring subscription's bank/card descriptor.
You are given the raw name and web-search snippets. Return ONLY JSON:
{
  "merchant": "<clean business name>",
  "explanation": "<1-2 sentences: who they are / what this recurring charge is>",
  "suggestedName": "<short display name, e.g. 'Amex Platinum - annual fee'>",
  "category": "<one of: Food, Shopping, Travel, Transport, Bills, Health, Entertainment, Income, Transfer:Internal, Subscriptions, Other>",
  "confidence": "<high|medium|low>"
}
Rules: if you can't tell who the merchant is, say so in explanation, set confidence low, and still give the best clean display name you can from the descriptor. No prose outside the JSON, no markdown.`;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = getSubscription(decodeURIComponent(id));
  if (!data) return NextResponse.json({ error: "unknown subscription" }, { status: 404 });
  const { sub, txns } = data;

  // Prefer a member charge's raw descriptor (most recent); fall back to the
  // stored merchant name when no charge is matched.
  const raw = (txns[txns.length - 1]?.name || sub.merchant || "").trim();
  if (!raw) return NextResponse.json({ error: "no name to identify" }, { status: 400 });
  const q = raw.replace(/\b\d{7,}\b/g, " ").replace(/\s+#?\d{2,}\b/g, " ").replace(/\s+/g, " ").trim() || raw;

  let snippets: { title: string; content: string; url: string }[] = [];
  try {
    const res = await fetch(`${SEARCH}/search?q=${encodeURIComponent(q + " merchant subscription charge")}`, {
      signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "kindling/1.0" },
    });
    if (res.ok) {
      const d = await res.json();
      snippets = (d.results ?? []).slice(0, 6).map((r: { title?: string; content?: string; url?: string }) => ({
        title: r.title ?? "", content: (r.content ?? "").slice(0, 300), url: r.url ?? "",
      }));
    }
  } catch { /* search is best-effort; the model can still try from the descriptor */ }

  const userMsg = `Raw subscription name: "${raw}"
Cadence: ${sub.cadence} · ${sub.lastAmount} per charge
Web search snippets:
${snippets.length ? snippets.map((s, i) => `${i + 1}. ${s.title} — ${s.content}`).join("\n") : "(no results)"}`;

  let out: Record<string, unknown> | null = null;
  try {
    const reply = await chat([{ role: "system", content: SYSTEM }, { role: "user", content: userMsg }], { maxTokens: 500 });
    out = extractJson(reply);
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  if (!out) return NextResponse.json({ error: "could not parse model reply" }, { status: 502 });

  return NextResponse.json({
    raw,
    merchant: out.merchant ?? null,
    explanation: out.explanation ?? null,
    suggestedName: out.suggestedName ?? out.merchant ?? null,
    category: out.category ?? null,
    confidence: out.confidence ?? null,
    sources: snippets.map((s) => ({ title: s.title, url: s.url })).slice(0, 4),
  });
}
