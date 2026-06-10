import { NextRequest, NextResponse } from "next/server";
import { addPayment, deletePayment, taxView } from "@/lib/tax";

export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function money(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v.replace(/[$,\s]/g, ""));
  return NaN;
}

// POST: log an estimated-tax payment { year, jurisdiction?, quarter?, amount, paid_date }.
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const year = Number(b.year);
  const amount = money(b.amount);
  if (!Number.isFinite(year)) return NextResponse.json({ error: "year required" }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "amount must be positive" }, { status: 400 });
  const paid_date = typeof b.paid_date === "string" && ISO.test(b.paid_date) ? b.paid_date : new Date().toISOString().slice(0, 10);
  const quarter = b.quarter && Number(b.quarter) >= 1 && Number(b.quarter) <= 4 ? Number(b.quarter) : null;
  addPayment({ year, jurisdiction: b.jurisdiction === "state" ? "state" : "federal", quarter, amount, paid_date, note: b.note ?? null });
  return NextResponse.json({ ok: true, ...taxView(year) });
}

// DELETE: remove a payment by ?id= (returns the refreshed view for ?year=).
export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  const year = Number(url.searchParams.get("year")) || new Date().getFullYear();
  if (!Number.isFinite(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  deletePayment(id);
  return NextResponse.json({ ok: true, ...taxView(year) });
}
