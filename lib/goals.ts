import { db } from "./db";
import { listBudgets } from "./budgets";
import { taxView } from "./tax";

// Savings goals with derived progress + a monthly contribution nudge. `saved` is
// the running total; v2 funds it by *logging deposits* (atomic increments) into
// goal_contributions rather than overwriting the number, so SUM(contributions)
// always equals saved and you get a deposit history. The nudge — how much per
// month to hit the deadline — is computed against months remaining, and the view
// reports your recent actual savings rate so the nudge reads as reachable or not.

export type Goal = { id: number; name: string; target: number; saved: number; deadline: string | null };
export type Contribution = { amount: number; source: string; date: string };
export type UnderspendSource = { category: string; remaining: number };

export type GoalRow = Goal & {
  pct: number;          // saved / target, 0..1 (clamped for display upstream)
  remaining: number;    // max(0, target − saved)
  done: boolean;
  monthsLeft: number | null;  // whole months to deadline (>=0), null if no deadline
  perMonth: number | null;    // remaining / monthsLeft to hit the deadline
  overdue: boolean;     // past deadline and not done
  contributions: Contribution[];  // recent deposit log, newest first
};

export type GoalsView = {
  goals: GoalRow[];
  totalTarget: number;
  totalSaved: number;
  monthlySavings: number;   // recent income − spend (last 30d, depository, ex-transfers)
  underspendSources: UnderspendSource[];  // budget categories under budget this month (quick-fund)
};

const round2 = (n: number) => Math.round(n * 100) / 100;

// Run fn inside a SQLite transaction so a deposit's UPDATE goals + INSERT log
// land together (single connection, single-threaded — BEGIN/COMMIT is enough).
function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN");
  try { const r = fn(); d.exec("COMMIT"); return r; }
  catch (e) { d.exec("ROLLBACK"); throw e; }
}

// Whole months from today to a YYYY-MM-DD deadline, floored at 0. Uses day-count
// / 30.44 so a 6-week deadline reads as ~1 month, not 0.
function monthsUntil(deadline: string): number {
  const d = new Date(deadline + "T00:00:00Z").getTime();
  const now = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
  const days = (d - now) / 86400000;
  return Math.max(0, Math.floor(days / 30.44));
}

// Recent monthly savings = inflow − outflow over the last 30 days on depository
// accounts, excluding internal money movement. Same exclusion set as /spending.
function recentMonthlySavings(): number {
  const r = db().prepare(
    `SELECT COALESCE(-SUM(t.amount), 0) AS net
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE a.type = 'depository'
       AND t.date >= date('now','-30 days')
       AND COALESCE(t.category,'') NOT IN
         ('Transfer:Internal','Transfer:Brokerage','Transfer:P2P','CreditCardPayment')`
  ).get() as { net: number };
  return round2(r.net ?? 0);
}

// Recent deposit log for one goal, newest first (ordered by id so same-day
// deposits keep their order). amount is signed; source labels the origin.
export function recentContributions(goalId: number, limit = 6): Contribution[] {
  return db().prepare(
    `SELECT amount, source, substr(created_at, 1, 10) AS date
     FROM goal_contributions WHERE goal_id = ? ORDER BY id DESC LIMIT ?`
  ).all(goalId, limit) as unknown as Contribution[];
}

// Budget categories under budget for the current month — candidates to sweep
// into a goal. Reuses the budgets view (remaining = available − spent), positive
// only, biggest first. Empty when there are no budgets or nothing's left.
export function underspendSources(): UnderspendSource[] {
  return listBudgets(null).budgets
    .filter((b) => b.remaining > 0.01)
    .sort((a, b) => b.remaining - a.remaining)
    .map((b) => ({ category: b.category, remaining: round2(b.remaining) }));
}

export function listGoals(): GoalsView {
  const rows = db().prepare(
    `SELECT id, name, target, saved, deadline FROM goals ORDER BY
       CASE WHEN deadline IS NULL THEN 1 ELSE 0 END, deadline ASC, id ASC`
  ).all() as unknown as Goal[];

  const today = new Date().toISOString().slice(0, 10);
  const goals: GoalRow[] = rows.map((g) => {
    const remaining = round2(Math.max(0, g.target - g.saved));
    const done = g.saved >= g.target;
    const monthsLeft = g.deadline ? monthsUntil(g.deadline) : null;
    const overdue = !!g.deadline && g.deadline < today && !done;
    let perMonth: number | null = null;
    if (g.deadline && !done) perMonth = monthsLeft && monthsLeft > 0 ? round2(remaining / monthsLeft) : remaining;
    return {
      ...g,
      pct: g.target > 0 ? g.saved / g.target : 0,
      remaining, done, monthsLeft, perMonth, overdue,
      contributions: recentContributions(g.id),
    };
  });

  return {
    goals,
    totalTarget: round2(goals.reduce((s, g) => s + g.target, 0)),
    totalSaved: round2(goals.reduce((s, g) => s + g.saved, 0)),
    monthlySavings: recentMonthlySavings(),
    underspendSources: underspendSources(),
  };
}

// Log a deposit (or signed withdrawal/sweep) against a goal. The increment is
// done in SQL — MAX(0, saved + Δ) — so it's atomic and can't drive saved below
// zero; the contribution row records the *applied* delta (after the clamp) so
// SUM(contributions) stays equal to saved. Returns the new total + what actually
// applied (0 if the goal was already at 0 and Δ was negative).
export function contribute(goalId: number, amount: number, source = "manual"): { saved: number; applied: number } {
  const delta = round2(amount);
  return tx(() => {
    const before = db().prepare(`SELECT saved FROM goals WHERE id = ?`).get(goalId) as { saved: number } | undefined;
    if (!before) throw new Error("goal not found");
    db().prepare(`UPDATE goals SET saved = MAX(0, ROUND(saved + ?, 2)), updated_at = datetime('now') WHERE id = ?`).run(delta, goalId);
    const after = round2((db().prepare(`SELECT saved FROM goals WHERE id = ?`).get(goalId) as { saved: number }).saved);
    const applied = round2(after - before.saved);
    if (applied !== 0) db().prepare(`INSERT INTO goal_contributions (goal_id, amount, source) VALUES (?, ?, ?)`).run(goalId, applied, source);
    return { saved: after, applied };
  });
}

export function createGoal(name: string, target: number, saved = 0, deadline?: string | null): number {
  const s = round2(Math.max(0, saved));
  return tx(() => {
    const info = db().prepare(
      `INSERT INTO goals (name, target, saved, deadline) VALUES (?, ?, ?, ?)`
    ).run(name.trim(), round2(target), s, deadline || null);
    const id = Number(info.lastInsertRowid);
    // Seed the log with the opening balance so SUM(contributions) == saved.
    if (s > 0) db().prepare(`INSERT INTO goal_contributions (goal_id, amount, source) VALUES (?, ?, 'initial')`).run(id, s);
    return id;
  });
}

export function updateGoal(id: number, fields: { name?: string; target?: number; saved?: number; deadline?: string | null }): void {
  tx(() => {
    // A direct edit of the saved total is logged as an 'adjustment' delta so the
    // contribution history stays complete (deposits are the normal path).
    if (fields.saved !== undefined) {
      const cur = db().prepare(`SELECT saved FROM goals WHERE id = ?`).get(id) as { saved: number } | undefined;
      if (cur) {
        const next = round2(Math.max(0, fields.saved));
        const delta = round2(next - cur.saved);
        if (delta !== 0) {
          db().prepare(`UPDATE goals SET saved = ?, updated_at = datetime('now') WHERE id = ?`).run(next, id);
          db().prepare(`INSERT INTO goal_contributions (goal_id, amount, source) VALUES (?, ?, 'adjustment')`).run(id, delta);
        }
      }
    }
    const sets: string[] = [];
    const args: unknown[] = [];
    if (fields.name !== undefined) { sets.push("name = ?"); args.push(fields.name.trim()); }
    if (fields.target !== undefined) { sets.push("target = ?"); args.push(round2(fields.target)); }
    if (fields.deadline !== undefined) { sets.push("deadline = ?"); args.push(fields.deadline || null); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    args.push(id);
    db().prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = ?`).run(...(args as never[]));
  });
}

export function deleteGoal(id: number): void {
  db().prepare(`DELETE FROM goals WHERE id = ?`).run(id);
}

// ---- AI-style suggested goals, grounded in real data (mirrors suggestBudgets) ----
// Three data-grounded proposals that tie the app's own surfaces together: an
// emergency fund sized from actual spending, a tax reserve from the tax center's
// safe-harbor gap, and a set-aside for the biggest upcoming equity vest (the
// supplemental-withholding shortfall). Numbers come from the DB / tax view — never
// invented. The client reviews + tweaks before creating any via POST /api/goals.
export type GoalProposal = { name: string; target: number; deadline: string | null; basis: string; kind: string };
export type SuggestGoalsView = { proposals: GoalProposal[]; monthlySavings: number };

export function suggestGoals(): SuggestGoalsView {
  const proposals: GoalProposal[] = [];
  const existing = new Set((db().prepare(`SELECT lower(name) AS n FROM goals`).all() as { n: string }[]).map((r) => r.n));
  const has = (n: string) => existing.has(n.toLowerCase());

  // 1. Emergency fund = 6 × a ROBUST monthly outflow. Use the median of the last 6
  // full months' depository outflow (median resists one-time spikes like the April
  // tax payment), excluding internal money movement + lumpy Taxes. Mortgage/loans
  // stay in — they're real monthly obligations an emergency fund must cover.
  const monthRows = db().prepare(
    `SELECT strftime('%Y-%m', t.date) AS ym, SUM(t.amount) AS spent
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE a.type = 'depository' AND t.amount > 0
       AND t.date >= date('now','-6 months') AND t.date < strftime('%Y-%m-01','now')
       AND COALESCE(t.category,'') NOT IN ('Transfer:Internal','Transfer:Brokerage','Transfer:P2P','CreditCardPayment','Taxes')
     GROUP BY ym ORDER BY ym`
  ).all() as { ym: string; spent: number }[];
  const months = monthRows.map((r) => r.spent).sort((a, b) => a - b);
  const monthlySpend = months.length ? (months.length % 2 ? months[(months.length - 1) / 2] : (months[months.length / 2 - 1] + months[months.length / 2]) / 2) : 0;
  if (monthlySpend > 0 && !has("emergency fund")) {
    proposals.push({
      name: "Emergency fund", target: Math.round((monthlySpend * 6) / 1000) * 1000, deadline: null, kind: "emergency",
      basis: `6 months of ~$${Math.round(monthlySpend).toLocaleString()}/mo (median, ex one-time)`,
    });
  }

  // 2 & 3 from the tax view (skip silently if no tax profile is set up yet).
  const year = new Date().getFullYear();
  try {
    const tv = taxView(year);
    if (tv.safeHarbor.gap > 0 && !has(`${year} tax reserve`)) {
      proposals.push({
        name: `${year} tax reserve`, target: Math.round(tv.safeHarbor.gap), deadline: `${year}-12-31`, kind: "tax",
        basis: `${year} estimated-tax gap to your safe-harbor target`,
      });
    }
    const big = [...tv.events].sort((a, b) => b.setAside - a.setAside)[0];
    if (big && big.setAside > 0 && !has(`${big.label} tax`)) {
      proposals.push({
        name: `${big.label} tax`, target: Math.round(big.setAside), deadline: big.date, kind: "event",
        basis: `set aside for the ${big.date} vest — withholding falls ~$${Math.round(big.setAside).toLocaleString()} short`,
      });
    }
  } catch { /* tax profile not configured — skip the tax-derived suggestions */ }

  return { proposals, monthlySavings: recentMonthlySavings() };
}
