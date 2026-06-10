import { NextResponse } from "next/server";
import { refreshManualQuotes } from "@/lib/quotes";
import { listHoldings } from "@/lib/holdings";

export const dynamic = "force-dynamic";

// POST: refresh live prices for manual holdings, then return the updated view.
export async function POST() {
  try {
    const quotes = await refreshManualQuotes();
    return NextResponse.json({ ok: true, quotes, ...listHoldings() });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
