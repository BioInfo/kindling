import { NextResponse } from "next/server";
import { refreshEquityQuotes, listEquity } from "@/lib/equity";

export const dynamic = "force-dynamic";

// POST: refresh live prices for every grant ticker (Stooq), then return the
// updated equity view. Tickers leave your network; nothing else.
export async function POST() {
  try {
    const quotes = await refreshEquityQuotes();
    return NextResponse.json({ ok: true, quotes, ...listEquity() });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
