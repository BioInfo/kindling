import { NextRequest, NextResponse } from "next/server";
import { listAssets, createAsset, updateAsset, deleteAsset } from "@/lib/assets";

export const dynamic = "force-dynamic";

// Tolerate "$750,000", "750,000", " 1200 " — strip currency formatting before parse.
function money(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v.replace(/[$,\s]/g, ""));
  return NaN;
}

// GET: hand-entered assets/debts + their totals.
export async function GET() {
  return NextResponse.json(listAssets());
}

// POST: add one { name, kind?, side?, value, note? }.
export async function POST(req: NextRequest) {
  const b = await req.json();
  const value = money(b.value);
  if (!b.name || typeof b.name !== "string" || !b.name.trim()) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  if (!Number.isFinite(value) || value < 0) {
    return NextResponse.json({ error: "value must be a non-negative number" }, { status: 400 });
  }
  const apr = parseApr(b.apr);
  const id = createAsset({
    name: b.name.trim(), kind: b.kind, side: b.side, value, note: b.note ?? null,
    address: b.address ?? null, vehicle: b.vehicle ?? null,
    apr, payee_match: typeof b.payee_match === "string" && b.payee_match.trim() ? b.payee_match.trim() : null,
  });
  return NextResponse.json({ ok: true, id });
}

// Accept "6.125", "6.125%", " 1.9 " → number; "" / null / junk → null.
function parseApr(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(/[%\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// PATCH: edit one { id, name?, kind?, side?, value?, note?, apr?, payee_match? }.
export async function PATCH(req: NextRequest) {
  const b = await req.json();
  const id = Number(b.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  const f: { name?: string; kind?: string; side?: "asset" | "liability"; value?: number; note?: string | null; address?: string | null; vehicle?: string | null; apr?: number | null; payee_match?: string | null } = {};
  if (typeof b.name === "string") f.name = b.name;
  if (typeof b.kind === "string") f.kind = b.kind;
  if (b.side === "asset" || b.side === "liability") f.side = b.side;
  if (b.value !== undefined && Number.isFinite(money(b.value))) f.value = money(b.value);
  if (b.note !== undefined) f.note = b.note;
  if (b.address !== undefined) f.address = b.address;
  if (b.vehicle !== undefined) f.vehicle = b.vehicle;
  if (b.apr !== undefined) f.apr = parseApr(b.apr);
  if (b.payee_match !== undefined) f.payee_match = typeof b.payee_match === "string" && b.payee_match.trim() ? b.payee_match.trim() : null;
  updateAsset(id, f);
  return NextResponse.json({ ok: true });
}

// DELETE: remove one by ?id=.
export async function DELETE(req: NextRequest) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  deleteAsset(id);
  return NextResponse.json({ ok: true });
}
