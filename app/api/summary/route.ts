import { NextRequest, NextResponse } from "next/server";
import { latest, generate, renderEmailHtml } from "@/lib/summary";

export const dynamic = "force-dynamic";

// GET: latest stored weekly summary (+ rendered email HTML). null if none yet.
export async function GET(req: NextRequest) {
  const s = latest();
  if (!s) return NextResponse.json({ summary: null });
  const wantHtml = new URL(req.url).searchParams.get("html") === "1";
  return NextResponse.json({ summary: s, ...(wantHtml ? { emailHtml: renderEmailHtml(s) } : {}) });
}

// POST: (re)generate this week's summary — runs the SQL aggregates + the model
// narration, upserts, and returns it. Optional { model } override.
export async function POST(req: NextRequest) {
  let model: string | undefined;
  try { model = (await req.json())?.model; } catch { /* no body */ }
  try {
    const s = await generate(model);
    return NextResponse.json({ summary: s, emailHtml: renderEmailHtml(s) });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
