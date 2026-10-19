import { db } from "./db";
import { detectRecurring } from "./recurring";
import { addDays, daysAgo as dateNDaysAgo, daysBetween, todayLocal as today } from "./dates";

// Relative anomalies that the flat "ABS >= 1000" review rule misses: a charge
// that spiked vs a merchant's own history, a possible duplicate, a first-time
// charge from a new merchant, a recurring bill whose price just jumped, or a
// known bill coming due in the next week. Transaction-level kinds are outflows
// only (Plaid: amount > 0); hike/due are derived from recurring detection.

export type Anomaly = {
  kind: "spike" | "duplicate" | "new" | "hike" | "due";
  // `key` = "<kind>:<id>", the stable id a dismissal is recorded against. For
  // txn kinds the id is a transaction id (one txn can surface under more than
  // one kind); for hike/due it's "<merchant-norm>:<date>" so a NEW hike or a
  // NEW due-date re-fires after an old one was dismissed.
  key: string;
  id: string; date: string; merchant: string; amount: number; detail: string;
};

type Row = { id: string; account_id: string; date: string; merchant: string; amount: number; category: string | null };

// Tuning, checked against the 2026-10-18 snapshot (scripts/verify-tidy.mts).
const SPIKE_MIN_HISTORY = 2;  // prior charges before a "usual" exists
const SPIKE_RATIO = 3;        // × the merchant's median
const SPIKE_MIN_USD = 50;     // and at least this far above it
const SPIKE_OVER_MAX = 1.25;  // and above the merchant's prior high by this factor
const DUP_MIN_USD = 25;       // below this a repeat is a fare, a tip, a top-up
const DUP_HABIT_RUNS = 2;     // other same-amount close repeats = habit, not error

const isTransfer = (c: string | null) => !!c && (c.startsWith("Transfer:") || c.startsWith("TRANSFER_"));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = (s: string) =>
  s.toLowerCase().replace(/\s+#?\d{2,}.*$/, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

export function detectAnomalies(opts: { entity?: string | null; windowDays?: number } = {}): Anomaly[] {
  const win = opts.windowDays ?? 30;
  const entityClause = opts.entity ? "AND entity = ?" : "";
  const args = opts.entity ? [opts.entity] : [];

  // Accounts whose item was linked inside the window: their whole history just
  // became visible, so a "first charge from X" is an artifact of connecting, not
  // a genuine new merchant. Suppress "new" alerts for these accounts (a real
  // spike/duplicate within the window still surfaces).
  const freshAccounts = new Set(
    (db().prepare(
      `SELECT a.id FROM accounts a JOIN items i ON a.item_id = i.id
       WHERE date(i.created_at) >= ?`
    ).all(dateNDaysAgo(win)) as unknown as { id: string }[]).map((r) => r.id)
  );

  const rows = db().prepare(
    `SELECT id, account_id, date, COALESCE(merchant, name) AS merchant, amount, category
     FROM transactions
     WHERE amount > 0 AND COALESCE(merchant, name) IS NOT NULL
       AND category NOT IN ('Transfer:Internal','CreditCardPayment')
       AND date >= ? ${entityClause}
     ORDER BY date ASC`
  ).all(dateNDaysAgo(365), ...(args as never[])) as unknown as Row[];

  const byMerchant = new Map<string, Row[]>();
  for (const r of rows) {
    const k = norm(r.merchant);
    if (!k) continue;
    let arr = byMerchant.get(k);
    if (!arr) { arr = []; byMerchant.set(k, arr); }
    arr.push(r);
  }

  const recentCut = dateNDaysAgo(win);
  const out: Anomaly[] = [];

  for (const [, g] of byMerchant) {
    for (let i = 0; i < g.length; i++) {
      const t = g[i];
      if (t.date < recentCut) continue;
      const prior = g.slice(0, i).map((x) => x.amount);
      if (prior.length >= SPIKE_MIN_HISTORY) {
        // Median, not mean, and the charge must also top the merchant's own
        // prior high: a merchant whose basket swings (Amazon: $3 to $222) is
        // not spiking when it lands inside the range it already has.
        const med = median(prior);
        const hi = Math.max(...prior);
        if (med > 0 && t.amount >= med * SPIKE_RATIO && t.amount - med >= SPIKE_MIN_USD && t.amount > hi * SPIKE_OVER_MAX) {
          out.push({ kind: "spike", key: `spike:${t.id}`, id: t.id, date: t.date, merchant: t.merchant, amount: t.amount,
            detail: `${(t.amount / med).toFixed(1)}× your usual ${usd(med)} at ${t.merchant}` });
        }
      } else if (prior.length === 0 && t.amount >= 250 && !freshAccounts.has(t.account_id)) {
        // Only flag a sizeable first-time charge — a small new merchant isn't an
        // anomaly, and neither is a "first charge" from an account we just linked.
        out.push({ kind: "new", key: `new:${t.id}`, id: t.id, date: t.date, merchant: t.merchant, amount: t.amount,
          detail: `First charge from ${t.merchant} (${usd(t.amount)})` });
      }
    }
    // Duplicates: a run of same-amount charges each within 3 days of the last is
    // ONE flag, keyed on the run's second charge (a pair keeps its old key, so
    // earlier dismissals hold). Skipped: small amounts (a $3 fare twice is a
    // commute), transfers you sent (two identical P2P sends are deliberate),
    // and merchants that habitually repeat the same amount days apart.
    const runs: Row[][] = [];
    for (const t of g) {
      const run = runs[runs.length - 1];
      const last = run?.[run.length - 1];
      if (last && Math.abs(last.amount - t.amount) < 0.01 && daysBetween(last.date, t.date) <= 3) run.push(t);
      else runs.push([t]);
    }
    const repeats = runs.filter((r) => r.length >= 2);
    for (const run of repeats) {
      const a = run[0], b = run[1], z = run[run.length - 1];
      if (z.date < recentCut || b.amount < DUP_MIN_USD) continue;
      if (run.some((x) => isTransfer(x.category))) continue;
      const habitual = repeats.filter((r) => r !== run && Math.abs(r[0].amount - b.amount) < 0.01).length >= DUP_HABIT_RUNS;
      if (habitual) continue;
      const span = run.length === 2 ? `on ${a.date} and ${z.date}` : `${run.length}× between ${a.date} and ${z.date}`;
      out.push({ kind: "duplicate", key: `duplicate:${b.id}`, id: b.id, date: z.date, merchant: b.merchant, amount: b.amount,
        detail: `Possible duplicate: ${usd(b.amount)} at ${b.merchant} ${span}` });
    }
  }

  // Recurring-derived alerts: a subscription/bill whose latest charge jumped,
  // and bills coming due in the next week. Both ride detectRecurring (same
  // entity scope) so they reuse the cadence/amount model rather than re-deriving.
  const now = today();
  const dueHorizon = addDays(now, 7);
  for (const r of detectRecurring({ entity: opts.entity })) {
    if (r.direction !== "expense") continue;
    // A recurring transfer is money you move, not a bill; sub-dollar streams
    // (withholding pennies) are not worth an alert.
    if (isTransfer(r.category) || r.avgAmount < 1) continue;

    // Price hike: the most recent charge is materially above the merchant's
    // historical average. avgAmount includes the last charge, which only damps
    // the ratio, so a flag here is a real jump, never a false positive.
    if (
      r.avgAmount > 0 && r.lastAmount >= r.avgAmount * 1.15 &&
      r.lastAmount - r.avgAmount >= 2 && r.lastDate >= recentCut
    ) {
      const pct = Math.round((r.lastAmount / r.avgAmount - 1) * 100);
      out.push({
        kind: "hike", key: `hike:${norm(r.merchant)}:${r.lastDate}`, id: "",
        date: r.lastDate, merchant: r.merchant, amount: r.lastAmount,
        detail: `${r.merchant} up ${usd(r.lastAmount - r.avgAmount)} (${pct}%) — now ${usd(r.lastAmount)} vs usual ${usd(r.avgAmount)}`,
      });
    }

    // Due soon: walk the cadence forward from the last charge to the next
    // occurrence at/after today; flag if it lands inside the next 7 days.
    // A lapsed stream has no next charge to warn about.
    if (r.lapsed) continue;
    const step = Math.max(1, r.intervalDays);
    let next = r.lastDate, guard = 0;
    while (next < now && guard < 5000) { next = addDays(next, step); guard++; }
    if (next >= now && next <= dueHorizon) {
      const daysOut = Math.round((+new Date(next + "T00:00:00Z") - +new Date(now + "T00:00:00Z")) / 86400000);
      const when = daysOut === 0 ? "today" : daysOut === 1 ? "tomorrow" : `in ${daysOut} days`;
      out.push({
        kind: "due", key: `due:${norm(r.merchant)}:${next}`, id: "",
        date: next, merchant: r.merchant, amount: r.avgAmount,
        detail: `${r.merchant} due ${when} (~${usd(r.avgAmount)})`,
      });
    }
  }

  // Drop anything the user has already cleared. Filtering before the slice means
  // dismissing one flag reveals the next, rather than leaving a hole in the 20.
  const dismissed = new Set(
    (db().prepare(`SELECT anomaly_id FROM dismissed_anomalies`).all() as unknown as { anomaly_id: string }[])
      .map((r) => r.anomaly_id)
  );

  return out
    .filter((a) => !dismissed.has(a.key))
    .sort((x, y) => y.date.localeCompare(x.date) || y.amount - x.amount)
    .slice(0, 20);
}
