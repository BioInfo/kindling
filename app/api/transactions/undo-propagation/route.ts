import { NextRequest, NextResponse } from "next/server";
import { undoRememberMerchant, type PropagationUndo } from "@/lib/categorize";

export const dynamic = "force-dynamic";

// Revert a merchant-category propagation: restore the rule and every backfilled
// sibling row from the undo token returned by PATCH /api/transactions/[id].
export async function POST(req: NextRequest) {
  const undo = (await req.json()) as PropagationUndo | null;
  if (!undo || typeof undo.rule?.id !== "number") {
    return NextResponse.json({ error: "missing undo token" }, { status: 400 });
  }
  undoRememberMerchant(undo);
  return NextResponse.json({ ok: true });
}
