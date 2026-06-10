import { NextRequest, NextResponse } from "next/server";
import { getAsset, setEstimate } from "@/lib/assets";
import { chat, extractJson } from "@/lib/llm";

export const dynamic = "force-dynamic";

const SEARCH = process.env.LITESEARCH_URL ?? "http://localhost:8899";

// Best-effort AI valuation for a manual asset. For a home it searches the address;
// for a vehicle the year/make/model. NOTE: this sends the address / vehicle to a
// web search — the user opted into that. It is a rough estimate, not a Zestimate;
// `value` is not changed unless the user accepts it.
const SYSTEM = `You estimate the current market value of a personal asset from web-search snippets.
Return ONLY JSON: {"estimate": <number>, "low": <number>, "high": <number>, "note": "<1-2 sentences: basis + how rough>"}.
Be conservative and honest about uncertainty. If the snippets don't support a real estimate, widen low/high and say so in note. Numbers are plain USD (no symbols/commas).`;

export async function POST(req: NextRequest) {
  const b = await req.json();
  const id = Number(b.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  const a = getAsset(id);
  if (!a) return NextResponse.json({ error: "unknown asset" }, { status: 404 });

  let query: string;
  if (a.kind === "real_estate" && a.address) query = `${a.address} home value estimate`;
  else if (a.kind === "vehicle" && a.vehicle) query = `${a.vehicle} used car value KBB`;
  else if (a.address) query = `${a.address} value estimate`;
  else if (a.vehicle) query = `${a.vehicle} used value`;
  else return NextResponse.json({ error: a.kind === "vehicle" ? "add year/make/model first" : "add an address first" }, { status: 400 });

  let snippets: { title: string; content: string }[] = [];
  try {
    const res = await fetch(`${SEARCH}/search?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "kindling/1.0" },
    });
    if (res.ok) {
      const d = await res.json();
      snippets = (d.results ?? []).slice(0, 8).map((r: { title?: string; content?: string }) => ({ title: r.title ?? "", content: (r.content ?? "").slice(0, 300) }));
    }
  } catch { /* best-effort */ }

  const userMsg = `Asset: ${a.name} (${a.kind})
${a.address ? `Address: ${a.address}` : ""}${a.vehicle ? `Vehicle: ${a.vehicle}` : ""}
Current recorded value: $${a.value.toLocaleString()}

Web search snippets:
${snippets.length ? snippets.map((s, i) => `${i + 1}. ${s.title} — ${s.content}`).join("\n") : "(no results)"}`;

  let out: { estimate?: number; low?: number; high?: number; note?: string } | null = null;
  try {
    const reply = await chat([{ role: "system", content: SYSTEM }, { role: "user", content: userMsg }], { maxTokens: 400 });
    out = extractJson(reply);
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  const est = Number(out?.estimate);
  if (!out || !Number.isFinite(est) || est <= 0) {
    return NextResponse.json({ error: "couldn’t produce an estimate from available data" }, { status: 502 });
  }
  setEstimate(id, { value: est, low: Number(out.low) || null, high: Number(out.high) || null, note: out.note ?? null });
  return NextResponse.json({ ok: true, estimate: est, low: out.low ?? null, high: out.high ?? null, note: out.note ?? null });
}
