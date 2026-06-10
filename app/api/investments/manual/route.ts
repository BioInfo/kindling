import { NextRequest, NextResponse } from "next/server";
import { addManualHolding, deleteManualHolding, manualEligibleAccounts } from "@/lib/holdings";

export const dynamic = "force-dynamic";

// GET: investment accounts that can take hand-entered holdings (form targets).
export async function GET() {
  return NextResponse.json({ accounts: manualEligibleAccounts() });
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  // Tolerate "$1,282.55", "1,282.55" — strip currency formatting.
  const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : null;
};

// POST: add/update a manual holding on an investment account.
// { account_id, ticker?, name?, type?, quantity?, price?, value?, cost_basis? }
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b.account_id || typeof b.account_id !== "string") {
    return NextResponse.json({ error: "account_id required" }, { status: 400 });
  }
  if (!b.ticker && !b.name) {
    return NextResponse.json({ error: "ticker or name required" }, { status: 400 });
  }
  const res = addManualHolding({
    account_id: b.account_id,
    ticker: b.ticker ?? null,
    name: b.name ?? null,
    type: b.type ?? null,
    quantity: num(b.quantity),
    price: num(b.price),
    value: num(b.value),
    cost_basis: num(b.cost_basis),
  });
  return NextResponse.json({ ok: true, ...res });
}

// DELETE: remove a manual holding by ?account_id=&security_id=.
export async function DELETE(req: NextRequest) {
  const u = new URL(req.url).searchParams;
  const account_id = u.get("account_id");
  const security_id = u.get("security_id");
  if (!account_id || !security_id) {
    return NextResponse.json({ error: "account_id and security_id required" }, { status: 400 });
  }
  deleteManualHolding(account_id, security_id);
  return NextResponse.json({ ok: true });
}
