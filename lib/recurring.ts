import { db } from "./db";

// Heuristic recurring detection: group transactions by normalized merchant +
// direction, keep groups with enough occurrences at a regular cadence and a
// consistent amount. Plaid sign: + = outflow (expense), - = inflow (income).

export type Recurring = {
  merchant: string;
  category: string | null;
  direction: "expense" | "income";
  cadence: string;        // weekly | biweekly | monthly | quarterly | yearly
  intervalDays: number;   // median gap between charges
  avgAmount: number;      // absolute, positive
  lastAmount: number;
  count: number;
  lastDate: string;
  firstDate: string;
  nextExpected: string;
  monthly: number;        // amount normalized to a monthly figure
  priceChange: number;    // lastAmount − avgAmount (positive = the latest charge jumped)
  variableAmount: boolean; // amount swings enough to be usage-based (e.g. AWS, OpenAI)
};

type Row = { date: string; merchant: string; amount: number; category: string | null };

const round2 = (n: number) => Math.round(n * 100) / 100;
// Normalize a merchant string for grouping: drop trailing store numbers, strip
// non-alphanumerics, collapse whitespace, lowercase. Exported so subscription
// reconciliation keys off the SAME normalization the detector groups by.
export const norm = (s: string) =>
  s.toLowerCase().replace(/\s+#?\d{2,}.*$/, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function classify(days: number): string | null {
  const bands: [string, number, number][] = [
    ["weekly", 6, 8], ["biweekly", 12, 16], ["monthly", 26, 33],
    ["quarterly", 82, 98], ["yearly", 350, 380],
  ];
  for (const [name, lo, hi] of bands) if (days >= lo && days <= hi) return name;
  return null;
}

function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

export function detectRecurring(opts: { entity?: string | null; minOccurrences?: number } = {}): Recurring[] {
  const minOcc = opts.minOccurrences ?? 3;
  const where = ["category NOT IN ('Transfer:Internal','CreditCardPayment')", "COALESCE(merchant, name) IS NOT NULL"];
  const args: unknown[] = [];
  if (opts.entity) { where.push("entity = ?"); args.push(opts.entity); }

  const rows = db().prepare(
    `SELECT date, COALESCE(merchant, name) AS merchant, amount, category
     FROM transactions
     WHERE ${where.join(" AND ")} AND date >= date('now','-400 days')
     ORDER BY date ASC`
  ).all(...(args as never[])) as unknown as Row[];

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = norm(r.merchant) + (r.amount >= 0 ? "|out" : "|in");
    if (key.startsWith("|")) continue; // unnameable
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(r);
  }

  const out: Recurring[] = [];
  for (const g of groups.values()) {
    if (g.length < minOcc) continue;
    const gaps: number[] = [];
    for (let i = 1; i < g.length; i++) {
      const a = new Date(g[i - 1].date + "T00:00:00Z").getTime();
      const b = new Date(g[i].date + "T00:00:00Z").getTime();
      gaps.push((b - a) / 86400000);
    }
    const gap = median(gaps);
    const cadence = classify(gap);
    if (!cadence) continue;

    const amts = g.map((x) => Math.abs(x.amount));
    const mean = amts.reduce((s, x) => s + x, 0) / amts.length;
    const sd = Math.sqrt(amts.reduce((s, x) => s + (x - mean) ** 2, 0) / amts.length);
    const cv = mean > 0 ? sd / mean : Infinity;
    // A fixed subscription has a near-constant amount (cv ≤ 0.35). Usage-based
    // subscriptions (AWS, OpenAI, Twilio) swing more — keep them up to cv 0.6 but
    // FLAG them so the UI can mark the amount as variable; past 0.6 it's noise
    // (groceries, dining) masquerading as a stream, so drop it.
    if (mean <= 0 || cv > 0.6) continue;

    const last = g[g.length - 1];
    out.push({
      merchant: last.merchant,
      category: last.category,
      direction: last.amount >= 0 ? "expense" : "income",
      cadence,
      intervalDays: Math.round(gap),
      avgAmount: round2(mean),
      lastAmount: round2(Math.abs(last.amount)),
      count: g.length,
      lastDate: last.date,
      firstDate: g[0].date,
      nextExpected: addDays(last.date, gap),
      monthly: round2(mean * (30.44 / gap)),
      priceChange: round2(Math.abs(last.amount) - mean),
      variableAmount: cv > 0.35,
    });
  }
  return out.sort((a, b) => b.monthly - a.monthly);
}
