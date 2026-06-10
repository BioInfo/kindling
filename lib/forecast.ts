import { db } from "./db";
import { detectRecurring } from "./recurring";

// Cash-flow forecast: project liquid cash forward from detected recurring income
// + bills, plus an optional discretionary burn layer (v2). The scheduled layer
// answers "given my known paychecks and recurring charges, where does my balance
// go and when is the low point?"; the discretionary layer adds the everyday
// variable spend scheduled-only deliberately omitted, so the line reflects real
// spending, not just dated events.
//
// Discretionary burn is built to survive dirty, short history. Internal movement
// (transfers, CC payments), income, and the lumpy fixed/one-off categories
// (taxes, mortgage, loans, insurance) are excluded; anything already modeled as a
// recurring expense is removed so it isn't double-counted; the remaining
// per-transaction amounts are winsorized at p95 to neutralize a lone large
// purchase; and the rate is the MEDIAN of fully-observed calendar months so a
// single spike month can't dominate. Falls back to a flagged partial-window
// average when no complete month exists yet.

// NOT discretionary daily burn: internal money movement, income, and lumpy
// fixed/one-off obligations. Mortgage/loans recur and ride the scheduled layer;
// taxes/insurance are lumpy non-recurring, not a smooth daily rate.
const DISC_EXCLUDE = [
  "Transfer:Internal", "Transfer:Brokerage", "Transfer:P2P", "TRANSFER_OUT",
  "CreditCardPayment", "Income",
  "Taxes", "Mortgage", "Insurance", "LOAN_PAYMENTS", "Loan Payments",
];

export type ForecastEvent = {
  date: string;
  merchant: string;
  direction: "income" | "expense";
  amount: number;   // signed: income +, expense −
  cadence: string;
};
export type ForecastPoint = { date: string; balance: number };

export type Discretionary = {
  dailyBurn: number;     // robust everyday spend per day (positive)
  monthlyBurn: number;   // dailyBurn × 30.44
  months: number;        // observed history used for the estimate
  complete: boolean;     // true = median of full months; false = partial-window avg
};

export type Forecast = {
  startBalance: number;        // liquid (depository) cash today
  startDate: string;
  horizonDays: number;
  series: ForecastPoint[];     // one point per day, today .. today+horizon
  events: ForecastEvent[];     // dated scheduled items inside the window
  endBalance: number;
  low: { date: string; balance: number };  // lowest projected point
  totalIn: number;
  totalOut: number;            // scheduled outflow only
  net: number;                 // scheduled totalIn − totalOut over the horizon
  monthlyIn: number;
  monthlyOut: number;          // scheduled recurring monthly outflow
  discretionary: Discretionary | null;  // estimated everyday burn, null if none
  discretionaryOut: number;    // dailyBurn × horizonDays, applied when included
  included: boolean;           // whether the discretionary layer was applied
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// p-th percentile (0..1) by linear interpolation; used to find the winsor cap.
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

const norm = (s: string) =>
  s.toLowerCase().replace(/\s+#?\d{2,}.*$/, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

// Robust everyday burn from the trailing window. recurringMerchants is the set
// of normalized recurring-expense merchant keys to drop (already in scheduled).
function discretionaryBurn(
  startDate: string,
  recurringMerchants: Set<string>,
): Discretionary | null {
  const windowStart = addDays(startDate, -180);
  const placeholders = DISC_EXCLUDE.map(() => "?").join(",");
  const rows = db().prepare(
    `SELECT date, COALESCE(merchant, name) AS merchant, amount
     FROM transactions
     WHERE amount > 0
       AND category NOT IN (${placeholders})
       AND date >= ? AND date <= ?
     ORDER BY date ASC`
  ).all(...(DISC_EXCLUDE as never[]), windowStart, startDate) as unknown as
    { date: string; merchant: string | null; amount: number }[];

  // Drop anything already modeled as a recurring bill so it isn't double-counted.
  const disc = rows.filter((r) => {
    const m = r.merchant ? norm(r.merchant) : "";
    return m === "" || !recurringMerchants.has(m);
  });
  if (!disc.length) return null;

  // Winsorize per-transaction at p99 so a true giant (a one-off contractor or
  // big transfer that slipped category exclusion) is clipped, while ordinary
  // large purchases survive. Everyday spend is heavy-tailed with mostly tiny
  // charges, so a lower percentile would clip legitimate $500–800 buys. The
  // median-of-complete-months below is the second, primary line of defense.
  const cap = percentile(disc.map((r) => r.amount), 0.99);
  const capped = disc.map((r) => Math.min(r.amount, cap));

  // Group winsorized spend by calendar month. A month is "complete" only when it
  // sits fully inside [windowStart, startDate] — drops the clipped oldest month
  // and the current partial month.
  const byMonth = new Map<string, number>();
  disc.forEach((r, i) => {
    const mo = r.date.slice(0, 7);
    byMonth.set(mo, (byMonth.get(mo) ?? 0) + capped[i]);
  });
  const monthFull = (mo: string) => {
    const first = `${mo}-01`;
    const [y, m] = mo.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m,0 = last day of month m
    return first >= windowStart && lastDay <= startDate;
  };
  const completeMonths = [...byMonth.entries()].filter(([mo]) => monthFull(mo));

  if (completeMonths.length >= 1) {
    const monthly = median(completeMonths.map(([, v]) => v));
    return {
      dailyBurn: round2(monthly / 30.44),
      monthlyBurn: round2(monthly),
      months: completeMonths.length,
      complete: true,
    };
  }

  // No full month yet: average the winsorized total over observed days, flagged.
  const firstDate = disc[0].date;
  const daysElapsed = Math.max(
    1,
    Math.round((Date.parse(startDate) - Date.parse(firstDate)) / 86400000),
  );
  const total = capped.reduce((s, v) => s + v, 0);
  const dailyBurn = round2(total / daysElapsed);
  return {
    dailyBurn,
    monthlyBurn: round2(dailyBurn * 30.44),
    months: round2(daysElapsed / 30.44),
    complete: false,
  };
}

function liquidCash(): number {
  const r = db().prepare(
    `SELECT COALESCE(SUM(COALESCE(available_balance, current_balance)), 0) AS cash
     FROM accounts WHERE type = 'depository'`
  ).get() as { cash: number };
  return round2(r.cash ?? 0);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

export function forecast(opts: { days?: number; discretionary?: boolean } = {}): Forecast {
  const horizonDays = [30, 60, 90].includes(opts.days ?? 0) ? (opts.days as number) : 90;
  const wantDisc = opts.discretionary !== false; // default on
  const startDate = today();
  const endDate = addDays(startDate, horizonDays);
  const startBalance = liquidCash();

  // Whole-portfolio, entity-agnostic — same as net worth. Liquid cash isn't
  // entity-tagged at the account level, so the forecast isn't either.
  const rec = detectRecurring();

  const events: ForecastEvent[] = [];
  for (const r of rec) {
    const step = Math.max(1, r.intervalDays);
    // Walk forward from the last seen charge by the cadence until we're past
    // today, then emit each occurrence that lands inside the horizon. This
    // self-corrects the stored nextExpected when it's already stale.
    let d = r.lastDate;
    let guard = 0;
    while (d <= startDate && guard < 5000) { d = addDays(d, step); guard++; }
    while (d <= endDate && guard < 5000) {
      events.push({
        date: d,
        merchant: r.merchant,
        direction: r.direction,
        amount: r.direction === "income" ? r.avgAmount : -r.avgAmount,
        cadence: r.cadence,
      });
      d = addDays(d, step); guard++;
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Estimate everyday burn from history, dropping merchants already scheduled
  // above so they aren't counted twice.
  const recurMerchants = new Set(
    rec.filter((r) => r.direction === "expense").map((r) => norm(r.merchant)),
  );
  const discretionary = discretionaryBurn(startDate, recurMerchants);
  const included = wantDisc && !!discretionary;
  const dailyBurn = included ? discretionary!.dailyBurn : 0;

  // Net change per day, then a running balance with one point per day so the
  // chart x-axis is evenly spaced. Each projected day also bleeds the estimated
  // discretionary burn when that layer is on.
  const byDate = new Map<string, number>();
  for (const e of events) byDate.set(e.date, (byDate.get(e.date) ?? 0) + e.amount);

  const series: ForecastPoint[] = [];
  let bal = startBalance;
  let low = { date: startDate, balance: startBalance };
  for (let i = 0; i <= horizonDays; i++) {
    const d = addDays(startDate, i);
    // Day 0 is today's starting balance; burn + events accrue from day 1 on.
    if (i > 0) bal = round2(bal + (byDate.get(d) ?? 0) - dailyBurn);
    series.push({ date: d, balance: bal });
    if (bal < low.balance) low = { date: d, balance: bal };
  }

  const totalIn = round2(events.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0));
  const totalOut = round2(events.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0));
  const monthlyIn = round2(rec.filter((r) => r.direction === "income").reduce((s, r) => s + r.monthly, 0));
  const monthlyOut = round2(rec.filter((r) => r.direction === "expense").reduce((s, r) => s + r.monthly, 0));
  const discretionaryOut = round2(dailyBurn * horizonDays);

  return {
    startBalance, startDate, horizonDays, series, events,
    endBalance: series[series.length - 1].balance,
    low, totalIn, totalOut, net: round2(totalIn - totalOut),
    monthlyIn, monthlyOut,
    discretionary, discretionaryOut, included,
  };
}
