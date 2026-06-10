import { NextRequest, NextResponse } from "next/server";
import { latestMonthly, generateMonthly } from "@/lib/summary";

export const dynamic = "force-dynamic";

// GET: latest stored monthly review (the last complete month). null if none yet.
export async function GET() {
  const s = latestMonthly();
  return NextResponse.json({ summary: s });
}

// POST: (re)generate the monthly review — runs the MoM SQL aggregates + category
// trends + the local model narration, upserts, returns it. Optional { model }.
export async function POST(req: NextRequest) {
  let model: string | undefined;
  try { model = (await req.json())?.model; } catch { /* no body */ }
  try {
    const s = await generateMonthly(model);
    return NextResponse.json({ summary: s });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
