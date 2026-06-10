import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat, extractJson } from "@/lib/llm";

export const dynamic = "force-dynamic";

// Legitimacy check for a charge the user doesn't recognize: web-search the
// descriptor via the configured search gateway (only the descriptor leaves
// your network) and have the local LLM judge whether it looks like a known, legit
// merchant or something worth a closer look (free-trial conversion, gray-charge,
// lookalike, possible fraud). User-triggered, never auto-run — egress is gated
// behind an explicit click per the app's external-data posture.

const SEARCH = process.env.LITESEARCH_URL ?? "http://localhost:8899";

const SYSTEM = `You assess whether an unfamiliar bank/card charge looks legitimate.
You are given the raw descriptor, the amount, and web-search snippets. Return ONLY JSON:
{
  "verdict": "<legit|caution|suspicious>",
  "merchant": "<best guess at the real business, or null>",
  "reason": "<1-2 plain sentences: what this charge most likely is and why that verdict>",
  "advice": "<one short next step the cardholder could take, or null>"
}
Guidance:
- legit: a recognizable, established merchant/service; the descriptor and search results agree.
- caution: probably real but easy to forget or dispute — a free-trial-to-paid conversion, a
  subscription/gray charge, a payment processor (Square/Stripe/PayPal/Toast) fronting an unclear
  seller, or a thin web footprint.
- suspicious: hallmarks of fraud or a lookalike — no credible footprint, known-scam patterns,
  mismatched name/amount, or reports of fraudulent charges.
Be calm and specific. Do NOT claim certainty you don't have; when unsure prefer "caution" and say why.`;

// Internal money movement, not an external merchant charge — never a "scam".
// Short-circuit so a large transfer or a card payment doesn't cry wolf (and to
// skip needless egress).
const INTERNAL = new Set([
  "Transfer:Internal", "Transfer:Brokerage", "Transfer:P2P", "TRANSFER_OUT",
  "CreditCardPayment", "Income",
]);

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = db().prepare(`SELECT name, merchant, amount, category FROM transactions WHERE id=?`).get(id) as
    | { name: string; merchant: string | null; amount: number; category: string | null } | undefined;
  if (!t) return NextResponse.json({ error: "unknown transaction" }, { status: 404 });

  if (t.category && INTERNAL.has(t.category)) {
    const kind = t.category === "CreditCardPayment" ? "a credit-card payment"
      : t.category === "Income" ? "income"
      : "a transfer between your own accounts";
    return NextResponse.json({
      verdict: "legit", merchant: t.merchant ?? null,
      reason: `This is ${kind}, not an external merchant charge — nothing to check.`,
      advice: null, sources: [],
    });
  }

  const q = t.name.replace(/\b\d{7,}\b/g, " ").replace(/\s+#?\d{2,}\b/g, " ").replace(/\s+/g, " ").trim() || t.name;

  let snippets: { title: string; content: string; url: string }[] = [];
  try {
    const res = await fetch(`${SEARCH}/search?q=${encodeURIComponent(q + " charge legit or scam")}`, {
      signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "kindling/1.0" },
    });
    if (res.ok) {
      const d = await res.json();
      snippets = (d.results ?? []).slice(0, 6).map((r: { title?: string; content?: string; url?: string }) => ({
        title: r.title ?? "", content: (r.content ?? "").slice(0, 300), url: r.url ?? "",
      }));
    }
  } catch { /* best-effort; the model can still reason from the descriptor */ }

  const userMsg = `Raw descriptor: "${t.name}"
Plaid's guess at merchant: ${t.merchant ?? "(none)"}
Amount: $${Math.abs(t.amount).toFixed(2)} ${t.amount > 0 ? "(outflow)" : "(inflow)"}

Web search snippets:
${snippets.length ? snippets.map((s, i) => `${i + 1}. ${s.title} — ${s.content}`).join("\n") : "(no results)"}`;

  let out: Record<string, unknown> | null = null;
  try {
    const reply = await chat([{ role: "system", content: SYSTEM }, { role: "user", content: userMsg }], { maxTokens: 400 });
    out = extractJson(reply);
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  if (!out) return NextResponse.json({ error: "could not parse model reply" }, { status: 502 });

  const verdict = ["legit", "caution", "suspicious"].includes(String(out.verdict))
    ? String(out.verdict) : "caution";

  return NextResponse.json({
    verdict,
    merchant: out.merchant ?? t.merchant ?? null,
    reason: out.reason ?? null,
    advice: out.advice ?? null,
    sources: snippets.map((s) => ({ title: s.title, url: s.url })).slice(0, 3),
  });
}
