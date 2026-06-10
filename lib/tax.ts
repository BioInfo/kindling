import { db } from "./db";
import { listEquity } from "./equity";

// Tax planning — deterministic. The actionable number (safe-harbor target) is built
// from the user's REAL prior-year tax, not bracket math, so it's exact. Bracket /
// effective-rate / SE estimates are labeled approximations. Everything is a planning
// aid; the user confirms with their CPA. Nothing here leaves your network.

const round2 = (n: number) => Math.round(n * 100) / 100;
const round0 = (n: number) => Math.round(n);

// ---- 2026 federal constants (tax year 2026). Marginal-rate determination at high
// income is robust to small threshold drift; the bracket card is labeled an estimate.
// Edit here if the published IRS figures differ. ----
const FED_BRACKETS_MFJ_2026: [number, number][] = [
  [0, 0.10], [24800, 0.12], [100800, 0.22], [211100, 0.24],
  [403550, 0.32], [512450, 0.35], [768700, 0.37],
];
const STD_DEDUCTION = { mfj: 32200, single: 16100, hoh: 24150, mfs: 16100 } as const;
const NIIT_RATE = 0.038, NIIT_THRESHOLD_MFJ = 250000;          // statutory, not indexed
const ADDL_MEDICARE_RATE = 0.009, ADDL_MEDICARE_THRESHOLD_MFJ = 250000;
const FED_SUPP_RATE = 0.22;        // flat supplemental withholding under $1M aggregate
const FED_SUPP_RATE_OVER_1M = 0.37;
const VA_TOP_RATE = 0.0575;        // Virginia top marginal (kicks in ~$17k, so ≈ flat for high earners)
const SAFE_HARBOR_HIGH = 1.10;     // prior AGI > $150k MFJ
const SAFE_HARBOR_LOW = 1.00;

export type TaxProfile = {
  year: number; filing_status: string; state: string;
  prior_year_tax: number; prior_year_state_tax: number; prior_agi_over_threshold: number;
  est_income: number; est_fed_withholding: number; est_state_withholding: number;
  se_net_income: number; est_current_tax_override: number; est_state_tax_override: number; pay_periods_left: number; note: string | null;
  created_at: string; updated_at: string;
};
export type TaxPayment = { id: number; year: number; jurisdiction: string; quarter: number | null; amount: number; paid_date: string; note: string | null };

function fedTaxOn(taxable: number): number {
  let tax = 0;
  for (let i = 0; i < FED_BRACKETS_MFJ_2026.length; i++) {
    const [lo, rate] = FED_BRACKETS_MFJ_2026[i];
    const hi = i + 1 < FED_BRACKETS_MFJ_2026.length ? FED_BRACKETS_MFJ_2026[i + 1][0] : Infinity;
    if (taxable > lo) tax += (Math.min(taxable, hi) - lo) * rate;
  }
  return tax;
}
function marginalRate(taxable: number): number {
  let r = FED_BRACKETS_MFJ_2026[0][1];
  for (const [lo, rate] of FED_BRACKETS_MFJ_2026) if (taxable >= lo) r = rate;
  return r;
}

function fedDeadlines(year: number) {
  return [
    { q: 1, due: `${year}-04-15` }, { q: 2, due: `${year}-06-15` },
    { q: 3, due: `${year}-09-15` }, { q: 4, due: `${year + 1}-01-15` },
  ];
}
// Virginia's Q1 estimate is due May 1 (not April 15); the rest align with federal.
function vaDeadlines(year: number) {
  return [
    { q: 1, due: `${year}-05-01` }, { q: 2, due: `${year}-06-15` },
    { q: 3, due: `${year}-09-15` }, { q: 4, due: `${year + 1}-01-15` },
  ];
}
const today = () => new Date().toISOString().slice(0, 10);
function daysBetween(from: string, to: string): number {
  const a = new Date(from + "T00:00:00Z").getTime(), b = new Date(to + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

// ---------- profile + payments ----------
const DEFAULT_PROFILE = (year: number): TaxProfile => ({
  year, filing_status: "mfj", state: "VA", prior_year_tax: 0, prior_year_state_tax: 0,
  prior_agi_over_threshold: 1, est_income: 0, est_fed_withholding: 0, est_state_withholding: 0,
  se_net_income: 0, est_current_tax_override: 0, est_state_tax_override: 0, pay_periods_left: 12, note: null, created_at: "", updated_at: "",
});

export function getProfile(year: number): TaxProfile {
  const r = db().prepare(`SELECT * FROM tax_profile WHERE year=?`).get(year) as unknown as TaxProfile | undefined;
  return r ?? DEFAULT_PROFILE(year);
}

export function upsertProfile(year: number, f: Partial<TaxProfile>): void {
  const cur = db().prepare(`SELECT year FROM tax_profile WHERE year=?`).get(year);
  if (!cur) {
    const d = { ...DEFAULT_PROFILE(year), ...f };
    db().prepare(
      `INSERT INTO tax_profile (year, filing_status, state, prior_year_tax, prior_year_state_tax,
         prior_agi_over_threshold, est_income, est_fed_withholding, est_state_withholding,
         se_net_income, est_current_tax_override, est_state_tax_override, pay_periods_left, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(year, d.filing_status, d.state, d.prior_year_tax, d.prior_year_state_tax,
          d.prior_agi_over_threshold, d.est_income, d.est_fed_withholding, d.est_state_withholding,
          d.se_net_income, d.est_current_tax_override, d.est_state_tax_override, d.pay_periods_left, d.note);
    return;
  }
  const cols = ["filing_status", "state", "prior_year_tax", "prior_year_state_tax", "prior_agi_over_threshold",
    "est_income", "est_fed_withholding", "est_state_withholding", "se_net_income", "est_current_tax_override", "est_state_tax_override", "pay_periods_left", "note"] as const;
  const sets: string[] = [], args: unknown[] = [];
  for (const c of cols) if (f[c as keyof TaxProfile] !== undefined) { sets.push(`${c}=?`); args.push(f[c as keyof TaxProfile]); }
  if (sets.length === 0) return;
  sets.push("updated_at=datetime('now')");
  args.push(year);
  db().prepare(`UPDATE tax_profile SET ${sets.join(", ")} WHERE year=?`).run(...(args as never[]));
}

export function listPayments(year: number): TaxPayment[] {
  return db().prepare(`SELECT * FROM tax_payments WHERE year=? ORDER BY paid_date ASC, id ASC`).all(year) as unknown as TaxPayment[];
}
export function addPayment(p: { year: number; jurisdiction?: string; quarter?: number | null; amount: number; paid_date: string; note?: string | null }): number {
  const res = db().prepare(
    `INSERT INTO tax_payments (year, jurisdiction, quarter, amount, paid_date, note) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(p.year, p.jurisdiction === "state" ? "state" : "federal", p.quarter ?? null, p.amount, p.paid_date, p.note ?? null);
  return Number(res.lastInsertRowid);
}
export function deletePayment(id: number): void { db().prepare(`DELETE FROM tax_payments WHERE id=?`).run(id); }

// ---------- the computed view ----------
export type Quarter = { q: number; label: string; due: string; daysUntil: number; status: "paid" | "due-soon" | "upcoming" | "past-unpaid"; recommended: number; paid: number };
export type TaxEvent = { source: string; label: string; date: string; daysUntil: number; income: number; withheldEst: number; owedEst: number; setAside: number };

export type TaxView = {
  year: number; asOf: string; profile: TaxProfile;
  safeHarbor: {
    multiplier: number; priorYearTax: number; targetFromPrior: number;
    estCurrentTax: number; targetFromCurrent: number; target: number; basis: string;
    projectedWithholding: number; gap: number;
  };
  quarters: Quarter[]; stateQuarters: Quarter[];
  nextDue: { jurisdiction: string; q: number; due: string; daysUntil: number; amount: number } | null;
  w4: { gap: number; payPeriodsLeft: number; perPaycheck: number };
  bracket: { taxableEst: number; marginalRate: number; effectiveRateEst: number; totalTaxEst: number; niitApplies: boolean; addlMedicareApplies: boolean; seTaxNote: string | null };
  events: TaxEvent[];
  scheduleC: { byCategory: { category: string; amount: number }[]; totalExpense: number; income: number; net: number };
  payments: TaxPayment[];
  advisory: string;
};

export function taxView(year: number): TaxView {
  const asOf = today();
  const profile = getProfile(year);
  const mfj = profile.filing_status === "mfj";
  const stdDed = STD_DEDUCTION[(profile.filing_status as keyof typeof STD_DEDUCTION)] ?? STD_DEDUCTION.mfj;

  // --- bracket / current-year tax estimate (rough; the safe-harbor path below is exact) ---
  const taxableEst = Math.max(0, profile.est_income - stdDed);
  const ordinaryTax = fedTaxOn(taxableEst);
  const niitApplies = mfj && profile.est_income > NIIT_THRESHOLD_MFJ;
  const addlMedicareApplies = mfj && profile.est_income > ADDL_MEDICARE_THRESHOLD_MFJ;
  // A pinned override wins over the rough bracket calc — this is how a normalized
  // estimate that strips one-time gains (e.g. a year's stock-sale cap gains) becomes
  // the basis for the 90%-of-current safe-harbor path. Else fall back to the
  // ordinary-bracket estimate on est_income.
  const estCurrentTax = profile.est_current_tax_override > 0 ? round0(profile.est_current_tax_override) : round0(ordinaryTax);
  const mRate = marginalRate(taxableEst);

  // --- payments already made (federal) ---
  const fedPaid = listPayments(year).filter((p) => p.jurisdiction === "federal").reduce((s, p) => s + p.amount, 0);
  const statePaid = listPayments(year).filter((p) => p.jurisdiction === "state").reduce((s, p) => s + p.amount, 0);

  // --- safe harbor (federal) ---
  const mult = profile.prior_agi_over_threshold ? SAFE_HARBOR_HIGH : SAFE_HARBOR_LOW;
  const targetFromPrior = round0(profile.prior_year_tax * mult);
  const targetFromCurrent = round0(estCurrentTax * 0.9);
  // The IRS lets you off with the LESSER of 110%-of-prior or 90%-of-current. But the
  // 90%-current path only holds if this year's tax estimate is right — fragile when
  // it's a projection. So target the CERTAIN prior-year number (it's a known figure,
  // guarantees safe harbor regardless of how the year lands); the 90%-current figure
  // rides along as an informational "could be as low as" so you can pay less if your
  // income genuinely comes in lower.
  // Default to the certain prior-year number. BUT when the user has pinned an
  // expected-tax override, they've given a real current-year estimate (not a rough
  // auto-calc), so the lower 90%-of-current path becomes a legitimate planning
  // target — the IRS lets you pay the lesser. Plan around it; keep the prior-year
  // figure visible as the zero-penalty-risk ceiling for an income surprise.
  let target = targetFromPrior;
  let basis = mult === 1.1 ? "110% of last year (locked-in)" : "100% of last year (locked-in)";
  if (profile.est_current_tax_override > 0 && targetFromCurrent > 0 && targetFromCurrent < targetFromPrior) {
    target = targetFromCurrent;
    basis = "90% of your expected tax";
  }
  const projectedWithholding = profile.est_fed_withholding;
  const gap = Math.max(0, round0(target - projectedWithholding - fedPaid));

  // --- quarterly plan (federal): spread the remaining gap across quarters still open ---
  const buildQuarters = (deadlines: { q: number; due: string }[], totalNeeded: number, paidByQ: Map<number, number>): Quarter[] => {
    const openQs = deadlines.filter((d) => daysBetween(asOf, d.due) >= 0);
    const perOpen = openQs.length > 0 ? totalNeeded / openQs.length : 0;
    return deadlines.map((d) => {
      const du = daysBetween(asOf, d.due);
      const paid = paidByQ.get(d.q) ?? 0;
      const isOpen = du >= 0;
      const recommended = isOpen ? round0(perOpen) : 0;
      let status: Quarter["status"];
      if (paid > 0) status = "paid";
      else if (!isOpen) status = "past-unpaid";
      else if (du <= 21) status = "due-soon";
      else status = "upcoming";
      return { q: d.q, label: `Q${d.q}`, due: d.due, daysUntil: du, status, recommended, paid };
    });
  };
  const fedPaidByQ = new Map<number, number>();
  for (const p of listPayments(year)) if (p.jurisdiction === "federal" && p.quarter) fedPaidByQ.set(p.quarter, (fedPaidByQ.get(p.quarter) ?? 0) + p.amount);
  const statePaidByQ = new Map<number, number>();
  for (const p of listPayments(year)) if (p.jurisdiction === "state" && p.quarter) statePaidByQ.set(p.quarter, (statePaidByQ.get(p.quarter) ?? 0) + p.amount);

  const quarters = buildQuarters(fedDeadlines(year), gap, fedPaidByQ);

  // state safe harbor — same shape as federal: default to prior-year × multiplier,
  // but a pinned expected-state-tax override unlocks the lower 90%-of-current path
  // (so an inflated prior year, e.g. one-time cap-gains taxed by VA, stops driving
  // the estimate). Withholding that already covers expected tax → zero estimates.
  const stateTargetPrior = round0(profile.prior_year_state_tax * mult);
  const stateTargetCurrent = profile.est_state_tax_override > 0 ? round0(profile.est_state_tax_override * 0.9) : 0;
  const stateTarget = (stateTargetCurrent > 0 && stateTargetCurrent < stateTargetPrior) ? stateTargetCurrent : stateTargetPrior;
  const stateGap = Math.max(0, round0(stateTarget - profile.est_state_withholding - statePaid));
  const stateQuarters = buildQuarters(vaDeadlines(year), stateGap, statePaidByQ);

  // --- next due across both jurisdictions ---
  const upcoming: { jurisdiction: string; q: number; due: string; daysUntil: number; amount: number }[] = [];
  for (const q of quarters) if (q.daysUntil >= 0 && q.status !== "paid") upcoming.push({ jurisdiction: "federal", q: q.q, due: q.due, daysUntil: q.daysUntil, amount: q.recommended });
  for (const q of stateQuarters) if (q.daysUntil >= 0 && q.status !== "paid") upcoming.push({ jurisdiction: "Virginia", q: q.q, due: q.due, daysUntil: q.daysUntil, amount: q.recommended });
  upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
  const nextDue = upcoming[0] ?? null;

  // --- W-4 alternative: cover the federal gap via extra per-paycheck withholding.
  // Withholding counts as paid evenly all year, so this also cures earlier quarters
  // (no timing penalty) — unlike a late estimate. ---
  const perPaycheck = profile.pay_periods_left > 0 ? round2(gap / profile.pay_periods_left) : 0;

  // --- big-event planner: upcoming equity vests as supplemental-income events ---
  const equity = listEquity();
  const events: TaxEvent[] = [];
  for (const g of equity.grants) {
    if (g.last_price == null) continue;
    for (const pt of g.schedule) {
      const du = daysBetween(asOf, pt.date);
      if (du < 0 || du > 760) continue;            // next ~2 years
      // incremental shares vesting AT this point (cumulative diff from the prior point)
      const idx = g.schedule.indexOf(pt);
      const prev = idx > 0 ? g.schedule[idx - 1].value : 0;
      const income = round0(pt.value - prev);
      if (income <= 0) continue;
      const suppRate = income > 1_000_000 ? FED_SUPP_RATE_OVER_1M : FED_SUPP_RATE;
      const withheldEst = round0(income * suppRate + income * VA_TOP_RATE);  // fed supplemental + VA
      const niit = niitApplies ? income * NIIT_RATE : 0;
      const owedEst = round0(income * mRate + income * VA_TOP_RATE + niit);  // marginal fed + VA (+NIIT)
      events.push({
        source: "equity", label: `${[g.employer, g.ticker].filter(Boolean).join(" ")} vest`.trim() || "Equity vest",
        date: pt.date, daysUntil: du, income, withheldEst, owedEst, setAside: Math.max(0, round0(owedEst - withheldEst)),
      });
    }
  }
  events.sort((a, b) => a.daysUntil - b.daysUntil);

  // --- Business Schedule-C: outflows tagged business, grouped by category (deductible candidates) ---
  const scRows = db().prepare(
    `SELECT COALESCE(category,'Uncategorized') AS category, COALESCE(SUM(amount),0) AS amount
     FROM transactions WHERE entity='business' AND amount > 0 AND date >= ? GROUP BY category ORDER BY amount DESC`
  ).all(`${year}-01-01`) as unknown as { category: string; amount: number }[];
  const scIncomeRow = db().prepare(
    `SELECT COALESCE(-SUM(amount),0) AS income FROM transactions WHERE entity='business' AND amount < 0 AND date >= ?`
  ).get(`${year}-01-01`) as { income: number };
  const totalExpense = round2(scRows.reduce((s, r) => s + r.amount, 0));
  const income = round2(scIncomeRow.income ?? 0);

  return {
    year, asOf, profile,
    safeHarbor: { multiplier: mult, priorYearTax: profile.prior_year_tax, targetFromPrior, estCurrentTax, targetFromCurrent, target, basis, projectedWithholding, gap },
    quarters, stateQuarters, nextDue,
    w4: { gap, payPeriodsLeft: profile.pay_periods_left, perPaycheck },
    bracket: {
      taxableEst: round0(taxableEst), marginalRate: mRate, effectiveRateEst: profile.est_income > 0 ? round2(estCurrentTax / profile.est_income) : 0,
      totalTaxEst: estCurrentTax, niitApplies, addlMedicareApplies,
      seTaxNote: profile.se_net_income > 0
        ? `Self-emp net ~${round0(profile.se_net_income).toLocaleString()}: ~2.9% Medicare (+0.9% over $250k) applies; the 12.4% Social Security portion is likely capped out by your W-2 wages. CPA confirms.`
        : null,
    },
    events, scheduleC: { byCategory: scRows.map((r) => ({ category: r.category, amount: round2(r.amount) })), totalExpense, income, net: round2(income - totalExpense) },
    payments: listPayments(year),
    advisory: "Planning estimates only — confirm with Heuberger Carlson before you file or pay.",
  };
}
