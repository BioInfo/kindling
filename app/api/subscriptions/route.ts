import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reconcileSubscriptions, listSubscriptions, createManualSubscription } from "@/lib/subscriptions";

export const dynamic = "force-dynamic";

// GET: reconcile then return the curated subscription view (hero totals,
// per-category rollup, flag counts). The heuristic reconcile is cheap local SQL
// and runs every time; the Plaid recurring pull (network) runs only on first
// population or an explicit ?refresh=1, so opening the tab stays fast.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity");
  const refresh = url.searchParams.get("refresh") === "1";
  const hasPlaid =
    (db().prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE plaid_stream_id IS NOT NULL`).get() as { n: number }).n > 0;
  try {
    await reconcileSubscriptions({ plaid: refresh || !hasPlaid });
  } catch { /* Plaid stream pull is best-effort; the heuristic still populated */ }
  return NextResponse.json(listSubscriptions(entity));
}

// POST: two modes. With a {merchant, amount, cadence, category} body → hand-add a
// subscription. Without a body → force a full re-pull (the "Refresh" button).
export async function POST(req: Request) {
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity");
  const body = await req.json().catch(() => null);
  if (body && typeof body.merchant === "string" && body.merchant.trim()) {
    createManualSubscription({
      entity: entity ?? undefined,
      merchant: body.merchant,
      amount: Number(body.amount) || 0,
      cadence: String(body.cadence ?? "monthly"),
      category: body.category ?? null,
    });
    return NextResponse.json(listSubscriptions(entity));
  }
  try {
    await reconcileSubscriptions({ plaid: true });
  } catch { /* best-effort */ }
  return NextResponse.json(listSubscriptions(entity));
}
