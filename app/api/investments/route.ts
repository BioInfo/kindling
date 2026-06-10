import { NextResponse } from "next/server";
import { listHoldings, syncHoldings } from "@/lib/holdings";

export const dynamic = "force-dynamic";

// GET: current holdings + allocation + which items still need investments consent.
export async function GET() {
  return NextResponse.json(listHoldings());
}

// POST: refresh holdings from Plaid, then return the updated view + sync result.
export async function POST() {
  try {
    const sync = await syncHoldings();
    return NextResponse.json({ ok: true, sync, ...listHoldings() });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
