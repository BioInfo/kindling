import { NextResponse } from "next/server";
import { categorizeWithLlm } from "@/lib/categorize";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Runs the LLM categorization tail over transactions still on coarse Plaid
// categories. Off the sync path — call after sync or on demand.
export async function POST() {
  try {
    const r = await categorizeWithLlm({ limit: 200, writeRules: true });
    return NextResponse.json({ ok: true, ...r });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
