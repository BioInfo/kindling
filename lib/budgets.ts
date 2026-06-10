import { db } from "./db";
import { CATEGORIES } from "./taxonomy";
import { detectRecurring } from "./recurring";

// Per-category monthly budgets vs this calendar month's actual spend. Targets
// are global; actuals respect the entity filter so personal vs business read
// separately. A "pace" figure (target × month-progress) flags categories
// running hot before the month is over.

// Money-movement categories are not real spending and can't be budgeted.
const NON_BUDGETABLE = [
  "Transfer:Internal", "Transfer:Brokerage", "Transfer:P2P",
  "CreditCardPayment", "Income", "TaxRefund",
];
export const BUDGETABLE = CATEGORIES.filter((c) => !NON_BUDGETABLE.includes(c));
export const BUCKETS = ["fixed", "flexible", "nonmonthly"] as const;
export type Bucket = (typeof BUCKETS)[number];

export type BudgetRow = {
  category: string;
  amount: number;
  bucket: Bucket;
  rollover: number;
  carryIn: number;     // envelope balance carried from prior months (rollover only; 0 otherwise)
  available: number;   // amount + carryIn — what you actually have to spend this month
  spent: number;       // this calendar month, entity-filtered
  remaining: number;   // available − spent (can go negative)
  pct: number;         // spent / available, 0..(>1)
  pace: number;        // available × monthProgress — expected spend by now
  over: boolean;       // spent > available
  hot: boolean;        // spent > pace (running ahead of an even burn)
};

export type MonthMeta = { month: string; dayOfMonth: number; daysInMonth: number; progress: number };

export type BudgetsView = {
  month: MonthMeta;
  budgets: BudgetRow[];
  totalBudget: number;
  totalSpent: number;
  budgetable: string[];        // categories eligible for a budget (for the add dropdown)
  buckets: string[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Rollover ledger (v2 envelope carry) ────────────────────────────────────
// Month math on "YYYY-MM" strings — pure integer arithmetic, no Date/TZ traps.
function ymToNum(ym: string): number { const [y, m] = ym.split("-").map(Number); return y * 12 + (m - 1); }
function numToYm(n: number): string { return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`; }
function monthsInclusive(startYM: string, endYM: string): string[] {
  const a = ymToNum(startYM), b = ymToNum(endYM); const out: string[] = [];
  for (let i = a; i <= b; i++) out.push(numToYm(i));
  return out;
}

// Global outflow per (category, YYYY-MM). The envelope is one pool per category,
// so carry is computed on global spend regardless of the entity lens.
function globalMonthlySpend(): Map<string, Map<string, number>> {
  const rows = db().prepare(
    `SELECT category AS c, strftime('%Y-%m', date) AS ym, SUM(amount) AS s
     FROM transactions WHERE amount > 0 AND category IS NOT NULL
     GROUP BY category, ym`
  ).all() as unknown as { c: string; ym: string; s: number }[];
  const m = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!m.has(r.c)) m.set(r.c, new Map());
    m.get(r.c)!.set(r.ym, round2(r.s ?? 0));
  }
  return m;
}

// Fill the budget_months ledger for every rollover budget, from its creation
// month through the last fully-closed month. Idempotent: an already-frozen
// month is read (to chain carry) but never rewritten, so editing a budget's
// amount later can't retro-rewrite history. Closed-month spend comes from real
// transactions; the current (open) month is never snapshotted. Cheap — a few
// categories × a few months — so it's safe to run on every budgets read.
export function reconcileRolloverLedger(): void {
  const thisMonth = (db().prepare(`SELECT strftime('%Y-%m','now') AS m`).get() as { m: string }).m;
  const lastClosed = numToYm(ymToNum(thisMonth) - 1);
  const rb = db().prepare(
    `SELECT category, amount, strftime('%Y-%m', created_at) AS start FROM budgets WHERE rollover = 1`
  ).all() as unknown as { category: string; amount: number; start: string }[];
  if (rb.length === 0) return;

  const spendMap = globalMonthlySpend();
  const getRow = db().prepare(`SELECT carry_out FROM budget_months WHERE category = ? AND month = ?`);
  const ins = db().prepare(
    `INSERT INTO budget_months (category, month, target, spent, carry_in, carry_out) VALUES (?, ?, ?, ?, ?, ?)`
  );

  for (const b of rb) {
    if (ymToNum(b.start) > ymToNum(lastClosed)) continue; // created this month — no closed history to carry yet
    let carry = 0;
    for (const m of monthsInclusive(b.start, lastClosed)) {
      const existing = getRow.get(b.category, m) as { carry_out: number } | undefined;
      if (existing) { carry = round2(existing.carry_out); continue; }
      const spent = round2(spendMap.get(b.category)?.get(m) ?? 0);
      const carryIn = round2(carry);
      const carryOut = round2(carryIn + b.amount - spent);
      ins.run(b.category, m, round2(b.amount), spent, carryIn, carryOut);
      carry = carryOut;
    }
  }
}

// Carry entering the current (open) month = carry_out of the last-closed month's
// ledger row. reconcile fills every closed month up to last-closed, so a single
// lookup at that month is exact. 0 when the budget is younger than one month.
function currentCarryByCategory(thisMonth: string): Map<string, number> {
  const lastClosed = numToYm(ymToNum(thisMonth) - 1);
  return new Map(
    (db().prepare(`SELECT category, carry_out FROM budget_months WHERE month = ?`).all(lastClosed) as unknown as { category: string; carry_out: number }[])
      .map((r) => [r.category, round2(r.carry_out)])
  );
}

function monthMeta(): MonthMeta {
  const r = db().prepare(
    `SELECT strftime('%Y-%m','now') AS month,
            CAST(strftime('%d','now') AS INTEGER) AS dayOfMonth,
            CAST(strftime('%d', date('now','start of month','+1 month','-1 day')) AS INTEGER) AS daysInMonth`
  ).get() as { month: string; dayOfMonth: number; daysInMonth: number };
  return { ...r, progress: r.daysInMonth ? r.dayOfMonth / r.daysInMonth : 1 };
}

// This calendar month's spend per category (positive = outflow), entity-filtered.
function monthSpendByCategory(entity?: string | null): Map<string, number> {
  const args: unknown[] = [];
  let entityClause = "";
  if (entity) { entityClause = "AND entity = ?"; args.push(entity); }
  const rows = db().prepare(
    `SELECT category AS c, SUM(amount) AS spent
     FROM transactions
     WHERE amount > 0 AND category IS NOT NULL
       AND date >= date('now','start of month')
       ${entityClause}
     GROUP BY category`
  ).all(...(args as never[])) as unknown as { c: string; spent: number }[];
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.c, round2(r.spent ?? 0));
  return m;
}

function defaultBucket(category: string): Bucket {
  if (["Rent", "Mortgage", "Insurance", "Subscriptions", "Utilities"].includes(category)) return "fixed";
  if (["Taxes", "Travel", "Healthcare", "Charity", "Education"].includes(category)) return "nonmonthly";
  return "flexible";
}

export function listBudgets(entity?: string | null): BudgetsView {
  reconcileRolloverLedger();
  const month = monthMeta();
  const spend = monthSpendByCategory(entity);
  const carry = currentCarryByCategory(month.month);
  const raw = db().prepare(
    `SELECT category, amount, bucket, rollover FROM budgets`
  ).all() as unknown as { category: string; amount: number; bucket: Bucket; rollover: number }[];

  const budgets: BudgetRow[] = raw.map((b) => {
    const spent = spend.get(b.category) ?? 0;
    // Rollover categories spend out of an envelope: target + whatever carried in.
    const carryIn = b.rollover ? (carry.get(b.category) ?? 0) : 0;
    const available = round2(b.amount + carryIn);
    const pace = round2(available * month.progress);
    return {
      category: b.category, amount: b.amount, bucket: b.bucket, rollover: b.rollover,
      carryIn, available,
      spent, remaining: round2(available - spent),
      pct: available > 0 ? spent / available : 0,
      pace, over: spent > available, hot: spent > pace && spent > 0,
    };
  });
  // Group order: fixed → flexible → nonmonthly, then biggest target first.
  const order: Record<Bucket, number> = { fixed: 0, flexible: 1, nonmonthly: 2 };
  budgets.sort((a, b) => order[a.bucket] - order[b.bucket] || b.amount - a.amount);

  return {
    month, budgets,
    totalBudget: round2(budgets.reduce((s, b) => s + b.amount, 0)),
    totalSpent: round2(budgets.reduce((s, b) => s + b.spent, 0)),
    budgetable: [...BUDGETABLE],
    buckets: [...BUCKETS],
  };
}

export function upsertBudget(category: string, amount: number, bucket?: Bucket, rollover?: boolean): void {
  if (!(BUDGETABLE as readonly string[]).includes(category)) throw new Error(`not a budgetable category: ${category}`);
  const b: Bucket = bucket && (BUCKETS as readonly string[]).includes(bucket) ? bucket : defaultBucket(category);
  db().prepare(
    `INSERT INTO budgets (category, amount, bucket, rollover)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(category) DO UPDATE SET
       amount = excluded.amount, bucket = excluded.bucket,
       rollover = excluded.rollover, updated_at = datetime('now')`
  ).run(category, round2(amount), b, rollover ? 1 : 0);
}

export function deleteBudget(category: string): void {
  db().prepare(`DELETE FROM budgets WHERE category = ?`).run(category);
}

// ── Auto-budgets ──────────────────────────────────────────────────────────
// Propose a monthly target for every budgetable category that has trailing
// spend, bucket-aware so the math matches how the money actually behaves:
//   fixed      → the detected recurring charge (rent, a subscription)
//   flexible   → a robust central monthly (trimmed mean / median of monthly
//                totals) so one big month doesn't set the budget
//   nonmonthly → annualized ÷ 12 (a sinking-fund contribution)
// Categories where a single charge dominates the window (a tax payment, a
// flight) are skipped — a mean there isn't a monthly target. Every number is
// computed from the DB; the basis tag is the only label, no fabrication.

export type Proposal = {
  category: string;
  amount: number;          // proposed monthly target, tidy-rounded
  bucket: Bucket;
  basis: string;           // short rationale: "recurring", "trimmed avg of 3 mo", "annual ÷ 12"
  current: number | null;  // existing budget for this category, if any
};
export type SuggestView = {
  windowMonths: number;        // months of history actually used (capped to available)
  proposals: Proposal[];
  skippedLumpy: string[];      // categories left out — one charge dominates the window
  totalProposed: number;
};

// Trimmed mean of monthly totals: drop the high+low month when there are ≥4,
// else fall back to the median. Robust to a single hot month on a 3-mo window.
function trimmedCentral(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length >= 4) {
    const mid = s.slice(1, -1);
    return mid.reduce((a, b) => a + b, 0) / mid.length;
  }
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const tidyAmount = (n: number): number =>
  n >= 200 ? Math.round(n / 25) * 25 : Math.round(n / 5) * 5;

export function suggestBudgets(entity?: string | null, windowMonths = 6): SuggestView {
  // Honest window: never claim more history than the DB holds (~3 mo today).
  const span = db().prepare(
    `SELECT CAST((julianday('now') - julianday(MIN(date))) / 30.4 AS INTEGER) + 1 AS m
     FROM transactions WHERE amount > 0`
  ).get() as { m: number | null };
  const win = Math.max(1, Math.min(windowMonths, span?.m ?? windowMonths));

  const args: unknown[] = [];
  let entityClause = "";
  if (entity) { entityClause = "AND entity = ?"; args.push(entity); }

  // Per-category, per-month outflow totals + the biggest single charge.
  const rows = db().prepare(
    `SELECT category AS c, strftime('%Y-%m', date) AS ym,
            SUM(amount) AS mtot, MAX(amount) AS mmax
     FROM transactions
     WHERE amount > 0 AND category IS NOT NULL
       AND date >= date('now','-${win} months')
       ${entityClause}
     GROUP BY category, ym`
  ).all(...(args as never[])) as unknown as { c: string; ym: string; mtot: number; mmax: number }[];

  const byCat = new Map<string, { months: number[]; max: number; total: number }>();
  for (const r of rows) {
    if (!(BUDGETABLE as readonly string[]).includes(r.c)) continue;
    const e = byCat.get(r.c) ?? { months: [], max: 0, total: 0 };
    e.months.push(round2(r.mtot));
    e.max = Math.max(e.max, r.mmax);
    e.total += r.mtot;
    byCat.set(r.c, e);
  }

  // Detected recurring expense, normalized to a monthly figure per category.
  const recByCat = new Map<string, number>();
  for (const x of detectRecurring({ entity })) {
    if (x.direction !== "expense" || !x.category) continue;
    if (!(BUDGETABLE as readonly string[]).includes(x.category)) continue;
    recByCat.set(x.category, round2((recByCat.get(x.category) ?? 0) + x.monthly));
  }

  const current = new Map<string, number>(
    (db().prepare(`SELECT category, amount FROM budgets`).all() as unknown as { category: string; amount: number }[])
      .map((b) => [b.category, b.amount])
  );

  const proposals: Proposal[] = [];
  const skippedLumpy: string[] = [];

  for (const [cat, e] of byCat) {
    const central = round2(trimmedCentral(e.months));   // robust monthly from totals
    const recMo = recByCat.get(cat) ?? 0;
    // Recurring sets the budget only when it explains most of the category's
    // spend (a true fixed cost — rent, a subscription). A lone subscription
    // inside Dining must NOT shrink the whole Dining budget to that charge.
    const recurringDominant = recMo > 0 && central > 0 && recMo >= 0.7 * central;

    // One charge dominating the window gives no honest monthly target —
    // unless recurring already explains it (then it's a known fixed cost).
    if (e.total > 0 && e.max / e.total > 0.6 && !recurringDominant) {
      skippedLumpy.push(cat);
      continue;
    }

    let amount: number, basis: string, bucket: Bucket;
    if (recurringDominant) {
      bucket = "fixed"; amount = recMo; basis = "recurring charge";
    } else if (defaultBucket(cat) === "nonmonthly") {
      bucket = "nonmonthly"; amount = round2(e.total / win); basis = "annual ÷ 12";
    } else {
      bucket = defaultBucket(cat); amount = central;
      basis = e.months.length >= 4 ? `trimmed avg of ${e.months.length} mo` : `median of ${e.months.length} mo`;
    }
    if (amount <= 0) continue;
    proposals.push({ category: cat, amount: tidyAmount(amount), bucket, basis, current: current.get(cat) ?? null });
  }

  const order: Record<Bucket, number> = { fixed: 0, flexible: 1, nonmonthly: 2 };
  proposals.sort((a, b) => order[a.bucket] - order[b.bucket] || b.amount - a.amount);

  return {
    windowMonths: win,
    proposals,
    skippedLumpy: skippedLumpy.sort(),
    totalProposed: round2(proposals.reduce((s, p) => s + p.amount, 0)),
  };
}
