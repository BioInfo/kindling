import { NextResponse } from "next/server";
import { syncAllItems } from "@/lib/sync";
import { applyLoanPaydowns } from "@/lib/assets";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const results = await syncAllItems();
    // After fresh transactions land, amortize any manual loan with an APR + payee
    // match: each new payment cuts principal off its balance (interest is the only
    // real net-worth cost). Best-effort — never fail a sync over it.
    let paydowns: ReturnType<typeof applyLoanPaydowns> = [];
    try { paydowns = applyLoanPaydowns(); } catch { /* non-fatal */ }
    return NextResponse.json({ ok: true, results, paydowns });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
