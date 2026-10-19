import { NextResponse } from "next/server";
import { classifyNewTransactions } from "@/lib/recategorize";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The Transactions tab's AI categorize: the same per-transaction classifier the
// sync runs (receipts, descriptor rules, then the model) over rows still on
// Plaid's category. Never touches manual picks.
export async function POST() {
  const r = await classifyNewTransactions({ llm: true, maxRows: 200 });
  if (r.error) return NextResponse.json({ error: r.error }, { status: 500 });
  return NextResponse.json({ ok: true, processed: r.considered, updated: r.changed, rulesAdded: 0 });
}
