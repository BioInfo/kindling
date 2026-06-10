import { NextRequest, NextResponse } from "next/server";
import { listEquity, createGrant, updateGrant, deleteGrant, type NewGrant } from "@/lib/equity";
import { fetchQuote } from "@/lib/quotes";

export const dynamic = "force-dynamic";

// Tolerate "1,000", "$12.50", " 250 " → number; "" / junk → NaN.
function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v.replace(/[$,\s]/g, ""));
  return NaN;
}
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const intIn = (v: unknown, def: number, lo: number, hi: number) => {
  const n = Math.round(num(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : def;
};

// GET: every grant with derived vesting/valuation + portfolio totals.
export async function GET() {
  return NextResponse.json(listEquity());
}

// POST: add a grant. We fetch the ticker's quote up front so vested_value_at_add
// is frozen at a real price (recording the grant = new visibility, not a gain).
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const shares = num(b.shares);
  if (!b.grant_date || typeof b.grant_date !== "string" || !ISO.test(b.grant_date)) {
    return NextResponse.json({ error: "grant_date (YYYY-MM-DD) required" }, { status: 400 });
  }
  if (!Number.isFinite(shares) || shares <= 0) {
    return NextResponse.json({ error: "shares must be a positive number" }, { status: 400 });
  }
  const kind = b.kind === "option" || b.kind === "espp" ? b.kind : "rsu";
  const strike = kind === "option" ? (Number.isFinite(num(b.strike)) ? num(b.strike) : null) : null;
  const ticker = typeof b.ticker === "string" && b.ticker.trim() ? b.ticker.trim().toUpperCase() : null;
  let last_price: number | null = Number.isFinite(num(b.last_price)) && num(b.last_price) > 0 ? num(b.last_price) : null;
  if (last_price == null && ticker) { try { last_price = await fetchQuote(ticker); } catch { last_price = null; } }

  const grant: NewGrant = {
    employer: typeof b.employer === "string" && b.employer.trim() ? b.employer.trim() : null,
    ticker, kind, grant_date: b.grant_date, shares, strike,
    cliff_months: intIn(b.cliff_months, 12, 0, 600),
    vest_months: Math.max(1, intIn(b.vest_months, 48, 1, 600)),
    vest_freq: b.vest_freq === "quarterly" || b.vest_freq === "annual" ? b.vest_freq : "monthly",
    last_price, note: typeof b.note === "string" && b.note.trim() ? b.note.trim() : null,
  };
  const id = createGrant(grant);
  return NextResponse.json({ ok: true, id, priced: last_price != null });
}

// PATCH: edit one { id, ... }. Vesting params + ticker are editable; last_price
// and vested_value_at_add are managed by the quote refresh + create, not here.
export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const id = Number(b.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  const f: Partial<NewGrant> = {};
  if (typeof b.employer === "string") f.employer = b.employer.trim() || null;
  if (typeof b.ticker === "string") f.ticker = b.ticker.trim().toUpperCase() || null;
  if (b.kind === "rsu" || b.kind === "option" || b.kind === "espp") f.kind = b.kind;
  if (typeof b.grant_date === "string" && ISO.test(b.grant_date)) f.grant_date = b.grant_date;
  if (b.shares !== undefined && Number.isFinite(num(b.shares)) && num(b.shares) > 0) f.shares = num(b.shares);
  if (b.strike !== undefined) f.strike = Number.isFinite(num(b.strike)) ? num(b.strike) : null;
  if (b.cliff_months !== undefined) f.cliff_months = intIn(b.cliff_months, 12, 0, 600);
  if (b.vest_months !== undefined) f.vest_months = Math.max(1, intIn(b.vest_months, 48, 1, 600));
  if (b.vest_freq === "monthly" || b.vest_freq === "quarterly" || b.vest_freq === "annual") f.vest_freq = b.vest_freq;
  if (b.note !== undefined) f.note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
  updateGrant(id, f);
  return NextResponse.json({ ok: true });
}

// DELETE: remove one by ?id=.
export async function DELETE(req: NextRequest) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  deleteGrant(id);
  return NextResponse.json({ ok: true });
}
