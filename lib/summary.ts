import { db } from "./db";
import { chat } from "./llm";
import { computeNetWorth, adjustedTrend } from "./networth";
import { detectRecurring } from "./recurring";
import { detectAnomalies } from "./anomalies";
import { listBudgets } from "./budgets";
import { listGoals } from "./goals";
import { prettyCategory } from "./taxonomy";

// Weekly digest: deterministic SQL aggregates over the trailing 7 days, narrated
// by the local model. Same discipline as chat — every number is computed here in
// SQL and handed to the model; the model only restates them in prose, it never
// invents a figure. The budgets + goals nudges ride along as the call to action.

const SPEND_EXCLUDE = ["Transfer:Internal", "Transfer:Brokerage", "Transfer:P2P", "CreditCardPayment", "Income"];
const round2 = (n: number) => Math.round(n * 100) / 100;

export type CatMove = { category: string; thisWeek: number; lastWeek: number; delta: number };
export type SummaryStats = {
  period: { start: string; end: string };
  spend: { thisWeek: number; lastWeek: number; deltaPct: number | null };
  income: number;
  netWorth: { current: number; prior: number | null; delta: number | null; priorDate: string | null; linkedExcluded: number };
  topCategories: CatMove[];
  recurring: { count: number; monthlyExpense: number; monthlyIncome: number };
  anomalies: { detail: string; date: string }[];
  budgetsOver: { category: string; spent: number; amount: number }[];
  goals: { name: string; perMonth: number; deadline: string; behindPace: boolean }[];
  monthlySavings: number;
};

export type WeeklySummary = {
  weekStart: string;
  weekEnd: string;
  stats: SummaryStats;
  narrative: string;
  model: string | null;
  createdAt: string | null;
};

function spendBetween(start: string, end: string): number {
  const ph = SPEND_EXCLUDE.map(() => "?").join(",");
  const r = db().prepare(
    `SELECT COALESCE(SUM(amount),0) AS s FROM transactions
     WHERE amount > 0 AND COALESCE(category,'') NOT IN (${ph})
       AND date >= ? AND date <= ?`
  ).get(...SPEND_EXCLUDE, start, end) as { s: number };
  return round2(r.s ?? 0);
}

function categoryMoves(start: string, end: string, pStart: string, pEnd: string): CatMove[] {
  const ph = SPEND_EXCLUDE.map(() => "?").join(",");
  const rows = db().prepare(
    `SELECT category AS c,
       COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN amount ELSE 0 END),0) AS tw,
       COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN amount ELSE 0 END),0) AS lw
     FROM transactions
     WHERE amount > 0 AND category IS NOT NULL AND category NOT IN (${ph})
       AND date >= ?
     GROUP BY category`
  ).all(start, end, pStart, pEnd, ...SPEND_EXCLUDE, pStart) as unknown as { c: string; tw: number; lw: number }[];
  return rows
    .map((r) => ({ category: r.c, thisWeek: round2(r.tw), lastWeek: round2(r.lw), delta: round2(r.tw - r.lw) }))
    .filter((r) => r.thisWeek > 0)
    .sort((a, b) => b.thisWeek - a.thisWeek)
    .slice(0, 5);
}

function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function gatherStats(): SummaryStats {
  const end = new Date().toISOString().slice(0, 10);
  const start = addDays(end, -6);          // trailing 7 days inclusive
  const pEnd = addDays(start, -1);
  const pStart = addDays(pEnd, -6);

  const thisWeek = spendBetween(start, end);
  const lastWeek = spendBetween(pStart, pEnd);
  const deltaPct = lastWeek > 0 ? round2(((thisWeek - lastWeek) / lastWeek) * 100) : null;

  const inc = db().prepare(
    `SELECT COALESCE(SUM(-amount),0) AS s FROM transactions
     WHERE category = 'Income' AND date >= ? AND date <= ?`
  ).get(start, end) as { s: number };

  // Net worth: current vs the connection-adjusted prior point. Raw snapshots
  // include the full balance of every account linked this week, so a fresh link
  // draws a vertical step that reads as a windfall (the $2.5M "jump" from linking
  // Vanguard + Fidelity). adjustedTrend lifts the prior baseline by connections
  // that landed after it, so `delta` is organic change only; the visibility step
  // rides separately in `linkedExcluded` for the narrator to flag, never as gain.
  const nwNow = computeNetWorth().net;
  const trend = adjustedTrend(8);
  const prior = trend.series.length > 1 ? trend.series[0] : null;
  const netWorth = {
    current: round2(nwNow),
    prior: prior ? round2(prior.net) : null,
    delta: prior ? round2(nwNow - prior.net) : null,
    priorDate: prior ? prior.date : null,
    linkedExcluded: round2(trend.linkedExcluded),
  };

  const rec = detectRecurring();
  const recurring = {
    count: rec.length,
    monthlyExpense: round2(rec.filter((r) => r.direction === "expense").reduce((s, r) => s + r.monthly, 0)),
    monthlyIncome: round2(rec.filter((r) => r.direction === "income").reduce((s, r) => s + r.monthly, 0)),
  };

  const anomalies = detectAnomalies({ windowDays: 7 }).slice(0, 5).map((a) => ({ detail: a.detail, date: a.date }));

  const budgetsView = listBudgets();
  const budgetsOver = budgetsView.budgets
    .filter((b) => b.over)
    .map((b) => ({ category: b.category, spent: b.spent, amount: b.amount }));

  const goalsView = listGoals();
  const goals = goalsView.goals
    .filter((g) => g.deadline && !g.done && g.perMonth != null)
    .map((g) => ({
      name: g.name, perMonth: g.perMonth as number, deadline: g.deadline as string,
      behindPace: goalsView.monthlySavings > 0 && (g.perMonth as number) > goalsView.monthlySavings,
    }));

  return {
    period: { start, end },
    spend: { thisWeek, lastWeek, deltaPct },
    income: round2(inc.s ?? 0),
    netWorth, topCategories: categoryMoves(start, end, pStart, pEnd),
    recurring, anomalies, budgetsOver, goals, monthlySavings: goalsView.monthlySavings,
  };
}

const SYSTEM = `You write a short weekly personal-finance digest. You are given a JSON object
of already-computed figures. Use ONLY those numbers — never invent or estimate a figure not
present. Write 4 to 6 short sentences (or tight bullet lines), concrete and specific, money as
$X,XXX.XX. Structure: lead with the spending headline (this week vs last week, up or down),
then the standout category, then net worth if it moved, then flag anything over budget or any
anomaly, and close with the single most pressing goal nudge if there is one. For net worth, use
netWorth.delta as the real change — it is connection-adjusted. netWorth.linkedExcluded is the
balance of accounts just linked this week; that is newly visible money, NEVER growth — if it is
non-zero, you may note it as "$X newly linked (excluded from the change)" but never as a gain or
a jump. No preamble, no disclaimer, no markdown headers. Plain, direct, useful.`;

export async function narrate(stats: SummaryStats, model?: string): Promise<{ narrative: string; model: string }> {
  const m = model ?? process.env.FINANCE_LLM_MODEL ?? "deepseek-v4-flash";
  const narrative = await chat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(stats) },
    ],
    { maxTokens: 700, model: m },
  );
  return { narrative: narrative.trim(), model: m };
}

export function latest(): WeeklySummary | null {
  const row = db().prepare(
    `SELECT week_start, week_end, stats, narrative, model, created_at
     FROM summaries ORDER BY week_start DESC LIMIT 1`
  ).get() as { week_start: string; week_end: string; stats: string; narrative: string; model: string | null; created_at: string } | undefined;
  if (!row) return null;
  return {
    weekStart: row.week_start, weekEnd: row.week_end,
    stats: JSON.parse(row.stats) as SummaryStats,
    narrative: row.narrative, model: row.model, createdAt: row.created_at,
  };
}

export async function generate(model?: string): Promise<WeeklySummary> {
  const stats = gatherStats();
  const { narrative, model: usedModel } = await narrate(stats, model);
  db().prepare(
    `INSERT INTO summaries (week_start, week_end, stats, narrative, model)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(week_start) DO UPDATE SET
       week_end = excluded.week_end, stats = excluded.stats,
       narrative = excluded.narrative, model = excluded.model, created_at = datetime('now')`
  ).run(stats.period.start, stats.period.end, JSON.stringify(stats), narrative, usedModel);
  return { weekStart: stats.period.start, weekEnd: stats.period.end, stats, narrative, model: usedModel, createdAt: new Date().toISOString() };
}

// Branded HTML for the weekly email. Light theme (email clients render dark
// poorly); the accent stripe matches the app. Numbers come from stats; the
// narrative is the model's prose.
export function renderEmailHtml(s: WeeklySummary): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const para = esc(s.narrative).split(/\n+/).filter(Boolean).map((p) => `<p style="margin:0 0 10px">${p}</p>`).join("");
  const st = s.stats;
  const chip = (label: string, val: string, color = "#111827") =>
    `<td style="padding:8px 12px;background:#f3f4f6;border-radius:8px"><div style="font-size:11px;color:#6b7280">${label}</div><div style="font-size:16px;font-weight:600;color:${color}">${val}</div></td>`;
  const spendColor = st.spend.deltaPct != null && st.spend.deltaPct > 0 ? "#b91c1c" : "#047857";
  const deltaTxt = st.spend.deltaPct == null ? "" : ` (${st.spend.deltaPct > 0 ? "+" : ""}${st.spend.deltaPct}% vs last wk)`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#e5e7eb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#ffffff">
    <div style="height:4px;background:linear-gradient(90deg,#fbbf24,#f97316,#ef4444)"></div>
    <div style="padding:24px">
      <div style="font-size:13px;color:#6b7280;margin-bottom:2px">Kindling &middot; weekly digest</div>
      <div style="font-size:20px;font-weight:700;color:#111827;margin-bottom:16px">${s.weekStart} &rarr; ${s.weekEnd}</div>
      <table cellspacing="8" cellpadding="0" style="margin:-8px 0 16px"><tr>
        ${chip("Spent this week", money(st.spend.thisWeek) + deltaTxt, spendColor)}
        ${chip("Income", money(st.income), "#047857")}
        ${chip("Net worth", money(st.netWorth.current))}
      </tr></table>
      <div style="font-size:15px;line-height:1.55;color:#1f2937">${para}</div>
      <div style="margin-top:20px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">
        Generated locally by ${esc(s.model ?? "the model")} on your network. Numbers are computed from your own data; the model only narrates them.
      </div>
    </div>
  </div></body></html>`;
}

// ── Monthly review (month-over-month + category trends) ─────────────────────
// A monthly analog of the weekly digest. It reviews the last *complete* calendar
// month (comparing a half-finished current month to a full prior one would read
// as a fake −80% cliff), against the month before it, and ships a few months of
// per-category spend so the card can draw trend lines. Same discipline: every
// number is SQL here; the model only narrates.

function ymToNum(ym: string): number { const [y, m] = ym.split("-").map(Number); return y * 12 + (m - 1); }
function numToYm(n: number): string { return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`; }
const monthLabel = (ym: string) =>
  new Date(ym + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

export type MonthlyCatMove = { category: string; thisMonth: number; lastMonth: number; delta: number };
export type CategoryTrend = { category: string; points: { month: string; amount: number }[] };

export type MonthlyStats = {
  reportMonth: string;          // YYYY-MM reviewed (last complete month)
  reportLabel: string;          // "May 2026"
  prevMonth: string;
  currentMonth: string;         // the open month, for the "so far" glance
  spend: { thisMonth: number; lastMonth: number; deltaPct: number | null };
  income: { thisMonth: number; lastMonth: number };
  netSavings: { thisMonth: number; lastMonth: number };   // income − spend each month
  mtdSpend: number;             // current (open) month spend so far
  topCategories: MonthlyCatMove[];   // report vs prev, top by report spend
  trendMonths: string[];        // chart x-axis (YYYY-MM, oldest first)
  trendLabels: string[];        // matching "Mon YYYY" labels
  categoryTrends: CategoryTrend[];   // per top category, spend across trendMonths
  netWorth: { current: number; prior: number | null; delta: number | null; priorDate: string | null; linkedExcluded: number };
  budgetsOver: { category: string; spent: number; amount: number }[];
  goals: { name: string; perMonth: number; deadline: string; behindPace: boolean }[];
  monthlySavings: number;       // recent 30d savings rate (context for the goal nudge)
};

export type MonthlySummary = {
  month: string;
  stats: MonthlyStats;
  narrative: string;
  model: string | null;
  createdAt: string | null;
};

// Outflow (ex-transfers/CC/income) for one calendar month.
function monthSpend(ym: string): number {
  const ph = SPEND_EXCLUDE.map(() => "?").join(",");
  const r = db().prepare(
    `SELECT COALESCE(SUM(amount),0) AS s FROM transactions
     WHERE amount > 0 AND COALESCE(category,'') NOT IN (${ph})
       AND date >= ? AND date < date(?, '+1 month')`
  ).get(...SPEND_EXCLUDE, `${ym}-01`, `${ym}-01`) as { s: number };
  return round2(r.s ?? 0);
}

function monthIncome(ym: string): number {
  const r = db().prepare(
    `SELECT COALESCE(SUM(-amount),0) AS s FROM transactions
     WHERE category = 'Income' AND date >= ? AND date < date(?, '+1 month')`
  ).get(`${ym}-01`, `${ym}-01`) as { s: number };
  return round2(r.s ?? 0);
}

// Per-category spend for two months side by side, top by the report month.
function monthCatMoves(reportMonth: string, prevMonth: string): MonthlyCatMove[] {
  const ph = SPEND_EXCLUDE.map(() => "?").join(",");
  const rStart = `${reportMonth}-01`, pStart = `${prevMonth}-01`;
  const rows = db().prepare(
    `SELECT category AS c,
       COALESCE(SUM(CASE WHEN date >= ? AND date < date(?, '+1 month') THEN amount ELSE 0 END),0) AS tm,
       COALESCE(SUM(CASE WHEN date >= ? AND date < date(?, '+1 month') THEN amount ELSE 0 END),0) AS lm
     FROM transactions
     WHERE amount > 0 AND category IS NOT NULL AND category NOT IN (${ph})
       AND date >= ?
     GROUP BY category`
  ).all(rStart, rStart, pStart, pStart, ...SPEND_EXCLUDE, pStart) as unknown as { c: string; tm: number; lm: number }[];
  return rows
    .map((r) => ({ category: r.c, thisMonth: round2(r.tm), lastMonth: round2(r.lm), delta: round2(r.tm - r.lm) }))
    .filter((r) => r.thisMonth > 0)
    .sort((a, b) => b.thisMonth - a.thisMonth)
    .slice(0, 6);
}

// Spend per (category, month) across the trend window for a set of categories.
function categoryTrends(categories: string[], months: string[]): CategoryTrend[] {
  if (categories.length === 0 || months.length === 0) return [];
  const cph = categories.map(() => "?").join(",");
  const rows = db().prepare(
    `SELECT category AS c, strftime('%Y-%m', date) AS ym, SUM(amount) AS s
     FROM transactions
     WHERE amount > 0 AND category IN (${cph}) AND date >= ?
     GROUP BY category, ym`
  ).all(...categories, `${months[0]}-01`) as unknown as { c: string; ym: string; s: number }[];
  const map = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!map.has(r.c)) map.set(r.c, new Map());
    map.get(r.c)!.set(r.ym, round2(r.s ?? 0));
  }
  return categories.map((cat) => ({
    category: cat,
    points: months.map((m) => ({ month: m, amount: round2(map.get(cat)?.get(m) ?? 0) })),
  }));
}

// Net worth at the close of a calendar month: the latest snapshot dated within
// that month. Returns null if none — we don't borrow an older snapshot, so a
// month with no captured net worth simply has no comparison point.
function monthEndNet(ym: string): { date: string; net: number } | null {
  const r = db().prepare(
    `SELECT date, net FROM net_worth_snapshots
     WHERE date >= ? AND date < date(?, '+1 month') ORDER BY date DESC LIMIT 1`
  ).get(`${ym}-01`, `${ym}-01`) as { date: string; net: number } | undefined;
  return r ?? null;
}

export function gatherMonthlyStats(): MonthlyStats {
  // Report the last *complete* month; current open month is glanced separately.
  const currentMonth = (db().prepare(`SELECT strftime('%Y-%m','now') AS m`).get() as { m: string }).m;
  const reportMonth = numToYm(ymToNum(currentMonth) - 1);
  const prevMonth = numToYm(ymToNum(reportMonth) - 1);

  const thisMonth = monthSpend(reportMonth);
  const lastMonth = monthSpend(prevMonth);
  const deltaPct = lastMonth > 0 ? round2(((thisMonth - lastMonth) / lastMonth) * 100) : null;

  const incThis = monthIncome(reportMonth);
  const incLast = monthIncome(prevMonth);

  const topCategories = monthCatMoves(reportMonth, prevMonth);
  // Trend window: up to 6 months ending at the report month, but never earlier
  // than the first month with data (no run of leading empty months).
  const firstYm = (db().prepare(`SELECT strftime('%Y-%m', MIN(date)) AS m FROM transactions`).get() as { m: string | null }).m;
  const windowStart = Math.max(ymToNum(reportMonth) - 5, firstYm ? ymToNum(firstYm) : ymToNum(reportMonth) - 5);
  const trendMonths: string[] = [];
  for (let n = windowStart; n <= ymToNum(reportMonth); n++) trendMonths.push(numToYm(n));
  const trendLabels = trendMonths.map(monthLabel);
  // Chart the top 4 report-month categories so the lines stay legible.
  const trendCats = topCategories.slice(0, 4).map((c) => c.category);
  const catTrends = categoryTrends(trendCats, trendMonths);

  // Net worth MoM — organic, connection-adjusted. Only when both month-end
  // snapshots exist (the app is new; older months usually have none → null).
  const nwNow = computeNetWorth().net;
  const reportEnd = monthEndNet(reportMonth);
  const priorEnd = monthEndNet(prevMonth);
  let netWorth: MonthlyStats["netWorth"] = {
    current: round2(nwNow), prior: null, delta: null, priorDate: null, linkedExcluded: 0,
  };
  if (reportEnd && priorEnd) {
    const events = db().prepare(
      `SELECT date, net_delta FROM connection_events
       UNION ALL
       SELECT date(created_at) AS date, added_signed AS net_delta FROM manual_assets`
    ).all() as unknown as { date: string; net_delta: number }[];
    // Visibility steps that landed between the two month-ends shouldn't read as
    // organic growth — pull them out of the delta, surface separately.
    const linked = events.reduce((a, e) => (e.date > priorEnd.date && e.date <= reportEnd.date ? a + e.net_delta : a), 0);
    netWorth = {
      current: round2(nwNow),
      prior: round2(priorEnd.net),
      delta: round2(reportEnd.net - priorEnd.net - linked),
      priorDate: priorEnd.date,
      linkedExcluded: round2(linked),
    };
  }

  const budgetsView = listBudgets();
  const budgetsOver = budgetsView.budgets.filter((b) => b.over).map((b) => ({ category: b.category, spent: b.spent, amount: b.amount }));

  const goalsView = listGoals();
  const goals = goalsView.goals
    .filter((g) => g.deadline && !g.done && g.perMonth != null)
    .map((g) => ({
      name: g.name, perMonth: g.perMonth as number, deadline: g.deadline as string,
      behindPace: goalsView.monthlySavings > 0 && (g.perMonth as number) > goalsView.monthlySavings,
    }));

  return {
    reportMonth, reportLabel: monthLabel(reportMonth), prevMonth, currentMonth,
    spend: { thisMonth, lastMonth, deltaPct },
    income: { thisMonth: incThis, lastMonth: incLast },
    netSavings: { thisMonth: round2(incThis - thisMonth), lastMonth: round2(incLast - lastMonth) },
    mtdSpend: monthSpend(currentMonth),
    // Prettify category labels at the boundary (SQL above queried raw values),
    // so the chart, chips, and narration never show a raw LOAN_PAYMENTS token.
    topCategories: topCategories.map((c) => ({ ...c, category: prettyCategory(c.category) })),
    trendMonths, trendLabels,
    categoryTrends: catTrends.map((t) => ({ ...t, category: prettyCategory(t.category) })),
    netWorth, budgetsOver, goals, monthlySavings: goalsView.monthlySavings,
  };
}

const MONTHLY_SYSTEM = `You write a short monthly personal-finance review for the month named in
reportLabel. You are given a JSON object of already-computed figures. Use ONLY those numbers —
never invent or estimate. Write 4 to 6 short sentences (or tight bullet lines), concrete and
specific, money as $X,XXX.XX. Structure: lead with the month's total spend vs the prior month
(spend.thisMonth vs spend.lastMonth, up or down, with the %), then the biggest category move
(use topCategories deltas — if one category swung a lot, name it and the cause is fair game only
if obvious from the data, e.g. a tax category), then net savings for the month (netSavings.thisMonth),
then anything over budget, and close with the most pressing goal nudge if any. If netWorth.prior is
null, do not discuss net worth change. netWorth.linkedExcluded is newly linked money, NEVER growth.
Note mtdSpend only as "so far this month" context, never compared head-to-head with a full month.
No preamble, no markdown headers. Plain, direct, useful.`;

export async function narrateMonthly(stats: MonthlyStats, model?: string): Promise<{ narrative: string; model: string }> {
  const m = model ?? process.env.FINANCE_LLM_MODEL ?? "deepseek-v4-flash";
  const narrative = await chat(
    [
      { role: "system", content: MONTHLY_SYSTEM },
      { role: "user", content: JSON.stringify(stats) },
    ],
    { maxTokens: 700, model: m },
  );
  return { narrative: narrative.trim(), model: m };
}

export function latestMonthly(): MonthlySummary | null {
  const row = db().prepare(
    `SELECT month, stats, narrative, model, created_at FROM monthly_summaries ORDER BY month DESC LIMIT 1`
  ).get() as { month: string; stats: string; narrative: string; model: string | null; created_at: string } | undefined;
  if (!row) return null;
  return { month: row.month, stats: JSON.parse(row.stats) as MonthlyStats, narrative: row.narrative, model: row.model, createdAt: row.created_at };
}

export async function generateMonthly(model?: string): Promise<MonthlySummary> {
  const stats = gatherMonthlyStats();
  const { narrative, model: usedModel } = await narrateMonthly(stats, model);
  db().prepare(
    `INSERT INTO monthly_summaries (month, stats, narrative, model)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(month) DO UPDATE SET
       stats = excluded.stats, narrative = excluded.narrative,
       model = excluded.model, created_at = datetime('now')`
  ).run(stats.reportMonth, JSON.stringify(stats), narrative, usedModel);
  return { month: stats.reportMonth, stats, narrative, model: usedModel, createdAt: new Date().toISOString() };
}
