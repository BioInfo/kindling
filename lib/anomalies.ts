import { db } from "./db";
import { detectRecurring } from "./recurring";

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

const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = (s: string) =>
  s.toLowerCase().replace(/\s+#?\d{2,}.*$/, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const daysBetween = (a: string, b: string) =>
  Math.abs((+new Date(b + "T00:00:00Z") - +new Date(a + "T00:00:00Z")) / 86400000);
function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

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
       WHERE date(i.created_at) >= date('now', ?)`
    ).all(`-${win} days`) as unknown as { id: string }[]).map((r) => r.id)
  );

  const rows = db().prepare(
    `SELECT id, account_id, date, COALESCE(merchant, name) AS merchant, amount, category
     FROM transactions
     WHERE amount > 0 AND COALESCE(merchant, name) IS NOT NULL
       AND category NOT IN ('Transfer:Internal','CreditCardPayment')
       AND date >= date('now','-365 days') ${entityClause}
     ORDER BY date ASC`
  ).all(...(args as never[])) as unknown as Row[];

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
  const dupSeen = new Set<string>();

  for (const [k, g] of byMerchant) {
    for (let i = 0; i < g.length; i++) {
      const t = g[i];
      if (t.date < recentCut) continue;
      const prior = g.slice(0, i).map((x) => x.amount);
      if (prior.length >= 2) {
        const mean = prior.reduce((s, x) => s + x, 0) / prior.length;
        if (mean > 0 && t.amount >= mean * 2.5 && t.amount - mean >= 25) {
          out.push({ kind: "spike", key: `spike:${t.id}`, id: t.id, date: t.date, merchant: t.merchant, amount: t.amount,
            detail: `${(t.amount / mean).toFixed(1)}× your usual ${usd(mean)} at ${t.merchant}` });
        }
      } else if (prior.length === 0 && t.amount >= 250 && !freshAccounts.has(t.account_id)) {
        // Only flag a sizeable first-time charge — a small new merchant isn't an
        // anomaly, and neither is a "first charge" from an account we just linked.
        out.push({ kind: "new", key: `new:${t.id}`, id: t.id, date: t.date, merchant: t.merchant, amount: t.amount,
          detail: `First charge from ${t.merchant} (${usd(t.amount)})` });
      }
    }
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1], b = g[i];
      if (b.date < recentCut) continue;
      if (Math.abs(a.amount - b.amount) < 0.01 && daysBetween(a.date, b.date) <= 3) {
        const key = `${k}|${b.amount}|${b.date}`;
        if (!dupSeen.has(key)) {
          dupSeen.add(key);
          out.push({ kind: "duplicate", key: `duplicate:${b.id}`, id: b.id, date: b.date, merchant: b.merchant, amount: b.amount,
            detail: `Possible duplicate: ${usd(b.amount)} at ${b.merchant} on ${a.date} and ${b.date}` });
        }
      }
    }
  }

  // Recurring-derived alerts: a subscription/bill whose latest charge jumped,
  // and bills coming due in the next week. Both ride detectRecurring (same
  // entity scope) so they reuse the cadence/amount model rather than re-deriving.
  const now = today();
  const dueHorizon = addDays(now, 7);
  for (const r of detectRecurring({ entity: opts.entity })) {
    if (r.direction !== "expense") continue;

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
