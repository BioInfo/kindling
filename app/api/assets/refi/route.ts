import { NextResponse } from "next/server";
import { getAsset } from "@/lib/assets";
import { chat, extractJson } from "@/lib/llm";

export const dynamic = "force-dynamic";

// Mortgage refi watch: look up today's 30-year fixed rate via the litesearch
// gateway, compare it to a loan's stored APR, and show roughly how much interest
// it would save at the current balance. Generic rate query — no PII leaves the
// box (no address, no balance). User-triggered. The savings figure is interest
// at today's balance (balance × rate-delta), NOT a re-amortized payment, so we
// don't have to invent a remaining term.

const SEARCH = process.env.LITESEARCH_URL ?? "http://localhost:8899";

const SYSTEM = `You read web-search snippets and extract today's average US 30-year fixed
mortgage rate. Return ONLY JSON: {"rate": <number, annual percent, e.g. 6.79>, "asOf": "<date or source phrase, or null>"}.
Use the most recent, most credible national-average figure. If the snippets disagree, pick the
clearest current national average. If you truly can't find a rate, return {"rate": null}.`;

export async function GET(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  const loan = id ? getAsset(id) : undefined;
  if (!loan || loan.side !== "liability") {
    return NextResponse.json({ error: "not a liability" }, { status: 400 });
  }
  if (loan.apr == null) {
    return NextResponse.json({ error: "no APR on this loan — add one first" }, { status: 400 });
  }

  let snippets: { title: string; content: string }[] = [];
  try {
    const res = await fetch(`${SEARCH}/search?q=${encodeURIComponent("current average 30 year fixed mortgage rate today")}`, {
      signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "kindling/1.0" },
    });
    if (res.ok) {
      const d = await res.json();
      snippets = (d.results ?? []).slice(0, 6).map((r: { title?: string; content?: string }) => ({
        title: r.title ?? "", content: (r.content ?? "").slice(0, 300),
      }));
    }
  } catch { /* best-effort */ }

  let parsed: Record<string, unknown> | null = null;
  try {
    const reply = await chat([
      { role: "system", content: SYSTEM },
      { role: "user", content: snippets.length ? snippets.map((s, i) => `${i + 1}. ${s.title} — ${s.content}`).join("\n") : "(no results)" },
    ], { maxTokens: 150 });
    parsed = extractJson(reply);
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }

  const market = parsed && typeof parsed.rate === "number" ? (parsed.rate as number) : null;
  if (market == null || market <= 0 || market > 25) {
    return NextResponse.json({ error: "couldn't read a current rate" }, { status: 502 });
  }

  const apr = loan.apr;
  const balance = loan.value;
  const delta = apr - market;                          // positive = current rate is higher
  const monthlyInterestSaved = delta > 0 ? Math.round((balance * (delta / 100)) / 12 * 100) / 100 : 0;
  const annualSaved = Math.round(monthlyInterestSaved * 12 * 100) / 100;

  return NextResponse.json({
    loan: loan.name, balance, currentApr: apr,
    marketRate: market, asOf: parsed?.asOf ?? null,
    delta: Math.round(delta * 1000) / 1000,
    worthIt: delta >= 0.5,                              // ~half a point is the rule-of-thumb trigger
    monthlyInterestSaved, annualSaved,
    note: delta > 0
      ? `Interest-only estimate at today's balance — a refi re-amortizes, so the actual payment change differs.`
      : `Your ${apr}% is at or below today's ${market}% — nothing to do.`,
  });
}
