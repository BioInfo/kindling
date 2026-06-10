import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat, extractJson } from "@/lib/llm";

export const dynamic = "force-dynamic";

// Identify the real-world merchant behind a cryptic bank descriptor: web-search
// the raw string via the configured search gateway (only the descriptor leaves
// your network), then have the local LLM name it, explain it, and propose a clean
// display name + a match pattern for a rename rule covering all similar charges.

const SEARCH = process.env.LITESEARCH_URL ?? "http://localhost:8899";

const SYSTEM = `You identify the merchant behind a cryptic bank/card transaction descriptor.
You are given the raw descriptor and web-search snippets. Return ONLY JSON:
{
  "merchant": "<clean business name>",
  "explanation": "<1-2 sentences: who they are / what this charge is>",
  "suggestedName": "<short display name, e.g. 'Square - Blue Bottle Coffee'>",
  "suggestedPattern": "<the STABLE identifying substring of the raw descriptor to match similar charges — NO transaction-specific digits, store numbers, dates, or phone numbers>",
  "category": "<one of: Food, Shopping, Travel, Transport, Bills, Health, Entertainment, Income, Transfer:Internal, Subscriptions, Other>",
  "confidence": "<high|medium|low>"
}
Rules: suggestedPattern must be a literal substring of the raw descriptor so a contains-match works. If unsure who the merchant is, say so in explanation, set confidence low, and still propose the best stable substring.`;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = db().prepare(`SELECT name, merchant, amount FROM transactions WHERE id=?`).get(id) as
    | { name: string; merchant: string | null; amount: number } | undefined;
  if (!t) return NextResponse.json({ error: "unknown transaction" }, { status: 404 });

  // Query the descriptor with transaction-specific noise (phones, long digit runs) trimmed.
  const q = t.name.replace(/\b\d{7,}\b/g, " ").replace(/\s+#?\d{2,}\b/g, " ").replace(/\s+/g, " ").trim() || t.name;

  let snippets: { title: string; content: string; url: string }[] = [];
  try {
    const res = await fetch(`${SEARCH}/search?q=${encodeURIComponent(q + " merchant charge")}`, {
      signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "kindling/1.0" },
    });
    if (res.ok) {
      const d = await res.json();
      snippets = (d.results ?? []).slice(0, 6).map((r: { title?: string; content?: string; url?: string }) => ({
        title: r.title ?? "", content: (r.content ?? "").slice(0, 300), url: r.url ?? "",
      }));
    }
  } catch { /* search is best-effort; the LLM can still try from the descriptor */ }

  const userMsg = `Raw descriptor: "${t.name}"
Plaid's guess at merchant: ${t.merchant ?? "(none)"}
Amount: $${Math.abs(t.amount).toFixed(2)} ${t.amount > 0 ? "(outflow)" : "(inflow)"}

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

  // Guard: the pattern must actually be a substring of the raw descriptor.
  const pat = String(out.suggestedPattern ?? "").trim();
  const safePattern = pat && t.name.toLowerCase().includes(pat.toLowerCase()) ? pat : q;

  return NextResponse.json({
    raw: t.name,
    merchant: out.merchant ?? null,
    explanation: out.explanation ?? null,
    suggestedName: out.suggestedName ?? out.merchant ?? null,
    suggestedPattern: safePattern,
    category: out.category ?? null,
    confidence: out.confidence ?? null,
    sources: snippets.map((s) => ({ title: s.title, url: s.url })).slice(0, 4),
  });
}
