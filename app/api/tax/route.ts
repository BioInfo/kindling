import { NextRequest, NextResponse } from "next/server";
import { taxView, upsertProfile, type TaxProfile } from "@/lib/tax";

export const dynamic = "force-dynamic";

function money(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v.replace(/[$,\s%]/g, ""));
  return NaN;
}
const yearOf = (req: NextRequest) => {
  const y = Number(new URL(req.url).searchParams.get("year"));
  return Number.isFinite(y) && y >= 2020 && y <= 2100 ? y : new Date().getFullYear();
};

// GET: the full computed tax view for ?year= (defaults to current year).
export async function GET(req: NextRequest) {
  return NextResponse.json(taxView(yearOf(req)));
}

// POST/PATCH: upsert the year's profile. Only provided fields change.
async function upsert(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const year = Number.isFinite(Number(b.year)) ? Number(b.year) : new Date().getFullYear();
  const f: Partial<TaxProfile> = {};
  if (b.filing_status === "mfj" || b.filing_status === "single" || b.filing_status === "hoh" || b.filing_status === "mfs") f.filing_status = b.filing_status;
  if (typeof b.state === "string" && b.state.trim()) f.state = b.state.trim().toUpperCase().slice(0, 2);
  for (const k of ["prior_year_tax", "prior_year_state_tax", "est_income", "est_fed_withholding", "est_state_withholding", "se_net_income", "est_current_tax_override", "est_state_tax_override"] as const) {
    if (b[k] !== undefined && Number.isFinite(money(b[k]))) f[k] = money(b[k]);
  }
  if (b.prior_agi_over_threshold !== undefined) f.prior_agi_over_threshold = b.prior_agi_over_threshold ? 1 : 0;
  if (b.pay_periods_left !== undefined && Number.isFinite(Number(b.pay_periods_left))) f.pay_periods_left = Math.max(0, Math.round(Number(b.pay_periods_left)));
  if (b.note !== undefined) f.note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
  upsertProfile(year, f);
  return NextResponse.json({ ok: true, ...taxView(year) });
}
export async function POST(req: NextRequest) { return upsert(req); }
export async function PATCH(req: NextRequest) { return upsert(req); }
