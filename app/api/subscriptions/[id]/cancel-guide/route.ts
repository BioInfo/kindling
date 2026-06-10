import { NextResponse } from "next/server";
import { getSubscription } from "@/lib/subscriptions";
import { chat, extractJson } from "@/lib/llm";

export const dynamic = "force-dynamic";

// AI cancel-guide: web-search how to cancel this merchant via the configured
// search gateway (only the merchant name leaves your network), then the local
// model drafts concrete steps + a short cancellation email you can copy. This is
// the self-hostable replacement for Rocket Money's concierge cancellation — text
// you send, not a call we place. Read-only; nothing is written.

const SEARCH = process.env.LITESEARCH_URL ?? "http://localhost:8899";

const SYSTEM = `You help someone cancel a subscription. Given the merchant name and web-search snippets, return ONLY JSON:
{
  "steps": ["<concrete step 1>", "<step 2>", "..."],
  "email": "<a short, polite cancellation request email they can send if the merchant cancels by email; empty string if cancellation is self-serve in-app>",
  "difficulty": "<easy|medium|hard>"
}
Rules: steps must be specific to how THIS merchant cancels (in-app, website account page, phone, email). If the snippets don't say, give the best general path and say so in step 1. No prose outside the JSON, no markdown.`;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = getSubscription(decodeURIComponent(id));
  if (!data) return NextResponse.json({ error: "unknown subscription" }, { status: 404 });
  const merchant = data.sub.merchant;

  let snippets: { title: string; content: string; url: string }[] = [];
  try {
    const res = await fetch(`${SEARCH}/search?q=${encodeURIComponent(`how to cancel ${merchant} subscription`)}`, {
      signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "kindling/1.0" },
    });
    if (res.ok) {
      const d = await res.json();
      snippets = (d.results ?? []).slice(0, 6).map((r: { title?: string; content?: string; url?: string }) => ({
        title: r.title ?? "", content: (r.content ?? "").slice(0, 300), url: r.url ?? "",
      }));
    }
  } catch { /* search is best-effort; the model can still give the general path */ }

  const userMsg = `Merchant: "${merchant}"
Web search snippets:
${snippets.length ? snippets.map((s, i) => `${i + 1}. ${s.title} — ${s.content}`).join("\n") : "(no results)"}`;

  let out: Record<string, unknown> | null = null;
  try {
    const reply = await chat([{ role: "system", content: SYSTEM }, { role: "user", content: userMsg }], { maxTokens: 700 });
    out = extractJson(reply);
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  if (!out) return NextResponse.json({ error: "could not parse model reply" }, { status: 502 });

  return NextResponse.json({
    merchant,
    steps: Array.isArray(out.steps) ? out.steps.slice(0, 8) : [],
    email: typeof out.email === "string" ? out.email : "",
    difficulty: out.difficulty ?? null,
    sources: snippets.map((s) => ({ title: s.title, url: s.url })).slice(0, 4),
  });
}
