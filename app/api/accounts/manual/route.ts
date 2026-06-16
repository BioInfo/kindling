import { NextRequest, NextResponse } from "next/server";
import {
  listManualAccounts, createManualAccount, updateManualAccount, deleteManualAccount,
  MANUAL_SUBTYPES,
} from "@/lib/accounts";

export const dynamic = "force-dynamic";

// Tolerate "$12,000", "12,000", " 1200 " → number; "" / null → NaN.
function money(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v.replace(/[$,\s]/g, ""));
  return NaN;
}

// GET: manual (held-away) investment accounts + the subtype choices for the form.
export async function GET() {
  return NextResponse.json({ accounts: listManualAccounts(), subtypes: MANUAL_SUBTYPES });
}

// POST: create one { name, institution?, subtype?, balance? }.
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b.name || typeof b.name !== "string" || !b.name.trim()) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  const balance = money(b.balance);
  if (b.balance !== undefined && b.balance !== "" && (!Number.isFinite(balance) || balance < 0)) {
    return NextResponse.json({ error: "balance must be a non-negative number" }, { status: 400 });
  }
  const res = createManualAccount({
    name: b.name,
    institution: typeof b.institution === "string" ? b.institution : null,
    subtype: typeof b.subtype === "string" ? b.subtype : null,
    balance: Number.isFinite(balance) ? balance : 0,
  });
  return NextResponse.json({ ok: true, ...res });
}

// PATCH: edit one { id, name?, institution?, subtype?, balance? }. Manual accounts only.
export async function PATCH(req: NextRequest) {
  const b = await req.json();
  if (!b.id || typeof b.id !== "string") {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const f: { name?: string; institution?: string | null; subtype?: string | null; balance?: number } = {};
  if (typeof b.name === "string") f.name = b.name;
  if (b.institution !== undefined) f.institution = b.institution;
  if (typeof b.subtype === "string") f.subtype = b.subtype;
  if (b.balance !== undefined && Number.isFinite(money(b.balance))) f.balance = money(b.balance);
  const ok = updateManualAccount(b.id, f);
  if (!ok) return NextResponse.json({ error: "not a manual account" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

// DELETE: remove one by ?id= (cascades its holdings/transactions/connection event).
export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const ok = deleteManualAccount(id);
  if (!ok) return NextResponse.json({ error: "not a manual account" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
