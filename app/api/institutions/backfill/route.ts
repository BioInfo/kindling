import { NextResponse } from "next/server";
import { backfillInstitutionNames } from "@/lib/plaid";

export const dynamic = "force-dynamic";

// One-shot (idempotent) backfill: resolve institution_name for any item still
// showing its Plaid id, and refresh connection_events labels to match. Safe to
// re-run — only touches items missing a name.
export async function POST() {
  try {
    const resolved = await backfillInstitutionNames();
    return NextResponse.json({ ok: true, resolved });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
