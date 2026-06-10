import { NextResponse } from "next/server";
import { applyLoanPaydowns } from "@/lib/assets";

export const dynamic = "force-dynamic";

// Manually apply loan paydowns now (also runs automatically after each sync).
// Idempotent — only processes payments dated after each loan's last applied one.
export async function POST() {
  try {
    return NextResponse.json({ ok: true, paydowns: applyLoanPaydowns() });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
