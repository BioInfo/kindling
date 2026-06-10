import { db } from "./db";
import { plaid } from "./plaid";
import { decrypt } from "./crypto";
import { detectRecurring, norm } from "./recurring";
import { mapPfc } from "./taxonomy";
import { chat, extractJson } from "./llm";

// ── Subscriptions: the curated cost-reduction layer over recurring detection ──
// Detection has two sources: Plaid's recurring-transaction streams (authoritative
// status + amounts, rides the `transactions` product, no re-link) and the local
// heuristic detectRecurring() (catches what Plaid misses and tags entity). Both
// feed reconcileSubscriptions(), which UPSERTS candidates into the subscriptions
// table while preserving every user-owned field (state, type, merchant rename,
// trial date, note, color/icon, entity). Detection only refreshes amount/date/
// status columns; it never resurrects a dismissed/cancelled row. Auto-populate:
// a newly-detected stream lands as state='active' immediately.

export type SubState = "active" | "trial" | "cancelled" | "dismissed";
export type SubType = "subscription" | "obligation" | "membership" | "other" | null;

export type Subscription = {
  id: string;
  entity: string;
  merchant: string;
  merchantKey: string;
  category: string | null;
  type: SubType;
  cadence: string;
  intervalDays: number;
  avgAmount: number;
  lastAmount: number;
  monthly: number;
  count: number;
  firstDate: string | null;
  lastDate: string | null;
  nextExpected: string | null;
  isActive: boolean;
  priceChange: number;
  variableAmount: boolean;
  state: SubState;
  trialEnds: string | null;
  color: string | null;
  icon: string | null;
  note: string | null;
  workMove: string | null;   // null=personal | 'pending'=move to work card | 'moved'
  source: string;
  plaidStreamId: string | null;
};

type Candidate = {
  entity: string;
  direction: "expense" | "income";
  merchantKey: string;
  merchant: string;
  category: string | null;
  cadence: string;
  intervalDays: number;
  avgAmount: number;
  lastAmount: number;
  monthly: number;
  count: number;
  firstDate: string | null;
  lastDate: string | null;
  nextExpected: string | null;
  isActive: boolean;
  priceChange: number;
  variableAmount: boolean;
  source: "plaid" | "heuristic";
  plaidStreamId: string | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}
function daysSince(date: string): number {
  return Math.round((+new Date(today() + "T00:00:00Z") - +new Date(date + "T00:00:00Z")) / 86400000);
}
const candId = (c: { entity: string; direction: string; merchantKey: string }) =>
  `${c.entity}:${c.direction}:${c.merchantKey}`;

// Default classification so the surface is useful on day one: keep the mortgage,
// auto loan, insurance, utilities, credit-card autopays, and transfers OUT of the
// "subscriptions" hero (they're obligations, not things you cancel), while
// memberships and everything else count as discretionary recurring spend the
// hero is about. Seeded at first detection; the user can re-classify any row and
// the Phase-2 AI pass refines it. A null result is treated as a subscription.
const OBLIGATION_CATS = new Set([
  "Mortgage", "Rent", "Insurance", "Utilities", "Taxes", "Healthcare",
  "Education", "Loan", "CreditCardPayment", "Bills",
]);
// …plus recurring civic/toll bills that read like a "subscription" but can't be
// cancelled: tolls (EZ-Pass and regional brands), DMV / vehicle registration.
const OBLIGATION_RE = /mortgage|autopay|e[\s-]?payment|ach\s*pmt|credit crd|cred crd|motor finance|\bloan\b|\bp&c\b|zelle|venmo|brokerage|payroll|\b401k\b|\birs\b|\btax\b|\binvest\b|prosper|ez[\s-]?pass|e-?zpass|driveezmd|drive\s?ez\s?md|\btolls?\b|tollway|turnpike|sunpass|fastrak|\bi-?pass\b|\bdmv\b|motor vehicle/i;
const MEMBERSHIP_RE = /membership|costco|sam'?s club|\baaa\b|amazon prime|\bprime\b|\bgym\b|fitness|planet fitness|\bclub\b/i;

function classifyType(category: string | null, merchant: string, monthly: number): SubType {
  const c = category ?? "";
  if (OBLIGATION_CATS.has(c) || c.startsWith("Transfer")) return "obligation";
  if (OBLIGATION_RE.test(merchant)) return "obligation";
  if (monthly >= 1000) return "obligation"; // mortgage/rent/payroll scale — never a subscription
  if (MEMBERSHIP_RE.test(merchant)) return "membership";
  return null; // unknown → treated as a subscription in the hero
}

// Plaid recurring frequency → our cadence + a representative interval in days.
function freqToCadence(freq: string | undefined): { cadence: string; intervalDays: number } {
  switch (freq) {
    case "WEEKLY": return { cadence: "weekly", intervalDays: 7 };
    case "BIWEEKLY": return { cadence: "biweekly", intervalDays: 14 };
    case "SEMI_MONTHLY": return { cadence: "semimonthly", intervalDays: 15 };
    case "MONTHLY": return { cadence: "monthly", intervalDays: 30 };
    case "ANNUALLY": return { cadence: "yearly", intervalDays: 365 };
    default: return { cadence: "monthly", intervalDays: 30 };
  }
}

// ── Detection sources ───────────────────────────────────────────────────────

// Plaid recurring streams across every healthy item. Whole-portfolio (Plaid has
// no notion of our personal/business entity); entity is resolved later by matching
// to a heuristic candidate, defaulting to personal. Best-effort per item: a fresh
// link returns PRODUCT_NOT_READY / RECURRING_TRANSACTIONS_NOT_READY until streams
// mature — that item is skipped, never fatal, and the heuristic still covers it.
async function pullPlaidRecurring(): Promise<Candidate[]> {
  const items = db().prepare(`SELECT access_token FROM items WHERE status != 'error'`).all() as {
    access_token: string;
  }[];
  const out: Candidate[] = [];

  for (const item of items) {
    let accessToken: string;
    try { accessToken = decrypt(item.access_token); } catch { continue; }
    try {
      const res = await plaid.transactionsRecurringGet({ access_token: accessToken });
      const streams = [
        ...(res.data.outflow_streams ?? []).map((s) => ({ s, direction: "expense" as const })),
        ...(res.data.inflow_streams ?? []).map((s) => ({ s, direction: "income" as const })),
      ];
      for (const { s, direction } of streams) {
        const name = (s.merchant_name || s.description || "").trim();
        const key = norm(name);
        if (!key) continue;
        const { cadence, intervalDays } = freqToCadence(s.frequency as unknown as string);
        const avg = Math.abs(s.average_amount?.amount ?? 0);
        const last = Math.abs(s.last_amount?.amount ?? avg);
        if (avg <= 0) continue;
        const lastDate = s.last_date ?? null;
        out.push({
          entity: "personal", // resolved against heuristic candidates in reconcile
          direction,
          merchantKey: key,
          merchant: name,
          category: mapPfc(s.personal_finance_category?.primary) ?? null,
          cadence,
          intervalDays,
          avgAmount: round2(avg),
          lastAmount: round2(last),
          monthly: round2(avg * (30.44 / intervalDays)),
          count: s.transaction_ids?.length ?? 0,
          firstDate: s.first_date ?? null,
          lastDate,
          nextExpected: lastDate ? addDays(lastDate, intervalDays) : null,
          isActive: s.is_active ?? true,
          priceChange: round2(last - avg),
          variableAmount: false,
          source: "plaid",
          plaidStreamId: s.stream_id ?? null,
        });
      }
    } catch { /* stream not ready / item error — heuristic covers it */ }
  }
  return out;
}

// Heuristic candidates, tagged per entity (detectRecurring scopes by entity).
function heuristicCandidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const entity of ["personal", "business"]) {
    for (const r of detectRecurring({ entity })) {
      // No is_active from the heuristic: treat a stream as active if its last
      // charge is within ~2 cycles (plus a week of slack).
      const active = daysSince(r.lastDate) <= r.intervalDays * 2 + 7;
      out.push({
        entity,
        direction: r.direction,
        merchantKey: norm(r.merchant),
        merchant: r.merchant,
        category: r.category,
        cadence: r.cadence,
        intervalDays: r.intervalDays,
        avgAmount: r.avgAmount,
        lastAmount: r.lastAmount,
        monthly: r.monthly,
        count: r.count,
        firstDate: r.firstDate,
        lastDate: r.lastDate,
        nextExpected: r.nextExpected,
        isActive: active,
        priceChange: r.priceChange,
        variableAmount: r.variableAmount,
        source: "heuristic",
        plaidStreamId: null,
      });
    }
  }
  return out;
}

// Map a median gap to a known cadence band, defaulting to monthly (most subs).
function inferCadence(days: number): { cadence: string; intervalDays: number } {
  const bands: [string, number, number][] = [
    ["weekly", 6, 8], ["biweekly", 12, 16], ["monthly", 26, 33], ["quarterly", 82, 98], ["yearly", 350, 380],
  ];
  for (const [name, lo, hi] of bands) if (days >= lo && days <= hi) return { cadence: name, intervalDays: Math.round(days) };
  return { cadence: "monthly", intervalDays: 30 };
}

// Category-seeded candidates: a charge YOU explicitly categorized "Subscriptions"
// is a strong human signal it's a subscription, even before the recurrence
// heuristic has the 3 charges it needs (a brand-new Anthropic / exe.dev bill has
// only one). Seed those onto the surface so a user-categorized subscription shows
// up immediately; cadence is inferred from the gaps if there's more than one
// charge, else assumed monthly (the user can fix it in the detail modal). Keyed
// the SAME way detection keys, so once real recurrence is detected the rows merge
// rather than duplicate, and a later dismiss/cancel survives.
function categorySeededCandidates(): Candidate[] {
  const rows = db().prepare(
    `SELECT date, COALESCE(merchant, name) AS merchant, amount, entity
     FROM transactions
     WHERE category = 'Subscriptions' AND amount > 0 AND COALESCE(merchant, name) IS NOT NULL
       AND date >= date('now','-400 days')
     ORDER BY date ASC`
  ).all() as { date: string; merchant: string; amount: number; entity: string }[];

  const groups = new Map<string, { entity: string; merchant: string; dates: string[]; amts: number[] }>();
  for (const r of rows) {
    const key = norm(r.merchant);
    if (!key) continue;
    const id = `${r.entity}:${key}`;
    let g = groups.get(id);
    if (!g) { g = { entity: r.entity, merchant: r.merchant, dates: [], amts: [] }; groups.set(id, g); }
    g.dates.push(r.date); g.amts.push(Math.abs(r.amount));
  }

  const out: Candidate[] = [];
  for (const g of groups.values()) {
    let intervalDays = 30, cadence = "monthly";
    if (g.dates.length >= 2) {
      const gaps: number[] = [];
      for (let i = 1; i < g.dates.length; i++)
        gaps.push((+new Date(g.dates[i] + "T00:00:00Z") - +new Date(g.dates[i - 1] + "T00:00:00Z")) / 86400000);
      const gap = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
      ({ cadence, intervalDays } = inferCadence(gap));
    }
    const avg = round2(g.amts.reduce((s, x) => s + x, 0) / g.amts.length);
    const lastDate = g.dates[g.dates.length - 1];
    const lastAmt = round2(g.amts[g.amts.length - 1]);
    out.push({
      entity: g.entity, direction: "expense",
      merchantKey: norm(g.merchant), merchant: g.merchant, category: "Subscriptions",
      cadence, intervalDays, avgAmount: avg, lastAmount: lastAmt,
      monthly: round2(avg * (30.44 / intervalDays)), count: g.dates.length,
      firstDate: g.dates[0], lastDate, nextExpected: addDays(lastDate, intervalDays),
      isActive: daysSince(lastDate) <= intervalDays * 2 + 7,
      priceChange: round2(lastAmt - avg), variableAmount: false,
      source: "heuristic", plaidStreamId: null,
    });
  }
  return out;
}

// ── Reconcile (the upsert) ──────────────────────────────────────────────────

// Merge both sources and upsert. Plaid wins on amount/status/cadence when a
// stream exists; the heuristic supplies entity and variable-amount flagging.
// User-owned columns are never overwritten (state/type/merchant/note/trial_ends/
// color/icon stay; category backfills via COALESCE then is user-owned).
export async function reconcileSubscriptions(opts: { plaid?: boolean } = {}): Promise<void> {
  const merged = new Map<string, Candidate>();
  for (const c of heuristicCandidates()) merged.set(candId(c), c);

  // Fill in user-categorized "Subscriptions" charges the recurrence heuristic
  // didn't catch yet (too few charges). Heuristic/Plaid data wins where it exists.
  for (const c of categorySeededCandidates()) {
    const key = candId(c);
    if (!merged.has(key)) merged.set(key, c);
  }

  if (opts.plaid) {
    for (const p of await pullPlaidRecurring()) {
      // Find the entity a heuristic candidate already assigned to this stream
      // (try both entities); default personal if Plaid found it but we didn't.
      const personalKey = candId({ entity: "personal", direction: p.direction, merchantKey: p.merchantKey });
      const jsKey = candId({ entity: "business", direction: p.direction, merchantKey: p.merchantKey });
      const targetKey = merged.has(personalKey) ? personalKey : merged.has(jsKey) ? jsKey : personalKey;
      const existing = merged.get(targetKey);
      if (existing) {
        // Plaid is authoritative on amount/status/cadence; keep the heuristic's
        // entity + variable-amount flag.
        merged.set(targetKey, {
          ...existing,
          cadence: p.cadence,
          intervalDays: p.intervalDays,
          avgAmount: p.avgAmount,
          lastAmount: p.lastAmount,
          monthly: p.monthly,
          count: Math.max(existing.count, p.count),
          firstDate: p.firstDate ?? existing.firstDate,
          lastDate: p.lastDate ?? existing.lastDate,
          nextExpected: p.nextExpected ?? existing.nextExpected,
          isActive: p.isActive,
          priceChange: p.priceChange,
          category: existing.category ?? p.category,
          source: "plaid",
          plaidStreamId: p.plaidStreamId,
        });
      } else {
        merged.set(candId(p), p);
      }
    }
  }

  const ins = db().prepare(
    `INSERT INTO subscriptions
       (id, entity, merchant_key, merchant, plaid_stream_id, source, direction, type, category,
        cadence, interval_days, avg_amount, last_amount, monthly, count,
        first_date, last_date, next_expected, is_active, price_change, variable_amount,
        state, created_at, updated_at)
     VALUES
       (@id, @entity, @merchant_key, @merchant, @plaid_stream_id, @source, @direction, @type, @category,
        @cadence, @interval_days, @avg_amount, @last_amount, @monthly, @count,
        @first_date, @last_date, @next_expected, @is_active, @price_change, @variable_amount,
        'active', datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
        merchant_key = excluded.merchant_key,
        plaid_stream_id = COALESCE(excluded.plaid_stream_id, subscriptions.plaid_stream_id),
        source = excluded.source,
        type = COALESCE(subscriptions.type, excluded.type),
        category = COALESCE(subscriptions.category, excluded.category),
        cadence = excluded.cadence,
        interval_days = excluded.interval_days,
        avg_amount = excluded.avg_amount,
        last_amount = excluded.last_amount,
        monthly = excluded.monthly,
        count = excluded.count,
        first_date = COALESCE(subscriptions.first_date, excluded.first_date),
        last_date = excluded.last_date,
        next_expected = excluded.next_expected,
        is_active = excluded.is_active,
        price_change = excluded.price_change,
        variable_amount = excluded.variable_amount,
        updated_at = datetime('now')`
  );

  for (const c of merged.values()) {
    ins.run({
      id: candId(c),
      entity: c.entity,
      merchant_key: c.merchantKey,
      merchant: c.merchant,
      plaid_stream_id: c.plaidStreamId,
      source: c.source,
      direction: c.direction,
      type: classifyType(c.category, c.merchant, c.monthly),
      category: c.category,
      cadence: c.cadence,
      interval_days: c.intervalDays,
      avg_amount: c.avgAmount,
      last_amount: c.lastAmount,
      monthly: c.monthly,
      count: c.count,
      first_date: c.firstDate,
      last_date: c.lastDate,
      next_expected: c.nextExpected,
      is_active: c.isActive ? 1 : 0,
      price_change: c.priceChange,
      variable_amount: c.variableAmount ? 1 : 0,
    });
  }
}

// ── Read side ───────────────────────────────────────────────────────────────

type SubRow = {
  id: string; entity: string; merchant: string; merchant_key: string; direction: string; category: string | null;
  type: string | null; cadence: string | null; interval_days: number | null;
  avg_amount: number; last_amount: number; monthly: number; count: number;
  first_date: string | null; last_date: string | null; next_expected: string | null;
  is_active: number; price_change: number; variable_amount: number;
  state: string; trial_ends: string | null; color: string | null; icon: string | null;
  note: string | null; work_move: string | null; source: string; plaid_stream_id: string | null;
};

function toSub(r: SubRow): Subscription {
  return {
    id: r.id, entity: r.entity, merchant: r.merchant, merchantKey: r.merchant_key,
    category: r.category, type: (r.type as SubType) ?? null,
    cadence: r.cadence ?? "monthly", intervalDays: r.interval_days ?? 30,
    avgAmount: r.avg_amount, lastAmount: r.last_amount, monthly: r.monthly, count: r.count,
    firstDate: r.first_date, lastDate: r.last_date, nextExpected: r.next_expected,
    isActive: !!r.is_active, priceChange: r.price_change, variableAmount: !!r.variable_amount,
    state: (r.state as SubState), trialEnds: r.trial_ends, color: r.color, icon: r.icon,
    note: r.note, workMove: r.work_move, source: r.source, plaidStreamId: r.plaid_stream_id,
  };
}

// Count how many charges a stream will incur in the next `days` days (handles
// weekly/biweekly streams that hit more than once), summing the last amount.
function chargesInWindow(sub: Subscription, days: number): number {
  if (!sub.nextExpected || !sub.intervalDays) return 0;
  const end = addDays(today(), days);
  let n = 0, d = sub.nextExpected, guard = 0;
  while (d <= end && guard < 400) { if (d >= today()) n++; d = addDays(d, sub.intervalDays); guard++; }
  return n;
}

export type SubsView = {
  subs: Subscription[];                 // ALL non-dismissed expense rows (incl. obligations), with type
  monthlyTotal: number;                 // SUBSCRIPTIONS only (type != obligation) — the hero
  annualTotal: number;
  next30Total: number;                  // subscriptions only
  obligationsMonthly: number;           // mortgage/loans/insurance/bills, surfaced but not in the hero
  obligationsCount: number;
  workMoveMonthly: number;              // subs tagged 'pending' to move to a work card
  workMoveCount: number;
  byCategory: { key: string; value: number; pct: number }[]; // subscriptions only
  counts: { active: number; priceHikes: number; unused: number };
};

const isObligation = (s: Subscription) => s.type === "obligation";

// Expense subscriptions for a surface, newest-cost first. Income recurring stays
// in the Transactions › Recurring view; this surface is about cost. The hero +
// donut count SUBSCRIPTIONS (discretionary recurring spend you could cut);
// obligations (mortgage, loans, insurance, autopays) are returned in the list
// and summed separately so they don't inflate the headline.
export function listSubscriptions(entity?: string | null): SubsView {
  const where = ["direction = 'expense'", "state != 'dismissed'"];
  const args: unknown[] = [];
  if (entity && entity !== "all") { where.push("entity = ?"); args.push(entity); }
  const rows = db().prepare(
    `SELECT * FROM subscriptions WHERE ${where.join(" AND ")} ORDER BY monthly DESC`
  ).all(...(args as never[])) as unknown as SubRow[];
  const subs = rows.map(toSub);

  const counted = subs.filter((s) => s.state === "active" || s.state === "trial");
  const subsCounted = counted.filter((s) => !isObligation(s));
  const obligations = counted.filter(isObligation);

  const monthlyTotal = round2(subsCounted.reduce((s, x) => s + x.monthly, 0));
  const next30Total = round2(subsCounted.reduce((s, x) => s + chargesInWindow(x, 30) * x.lastAmount, 0));

  const catMap = new Map<string, number>();
  for (const s of subsCounted) {
    const k = s.category ?? "Uncategorized";
    catMap.set(k, (catMap.get(k) ?? 0) + s.monthly);
  }
  const byCategory = [...catMap.entries()]
    .map(([key, value]) => ({ key, value: round2(value), pct: monthlyTotal > 0 ? value / monthlyTotal : 0 }))
    .sort((a, b) => b.value - a.value);

  // Subs temporarily on the personal card that are tagged to move to a work
  // card — surfaced as a recoverable total, across both types.
  const toMove = counted.filter((s) => s.workMove === "pending");

  return {
    subs,
    monthlyTotal,
    annualTotal: round2(monthlyTotal * 12),
    next30Total,
    obligationsMonthly: round2(obligations.reduce((s, x) => s + x.monthly, 0)),
    obligationsCount: obligations.length,
    workMoveMonthly: round2(toMove.reduce((s, x) => s + x.monthly, 0)),
    workMoveCount: toMove.length,
    byCategory,
    counts: {
      active: subsCounted.length,
      priceHikes: subsCounted.filter((s) => s.priceChange > 1).length,
      unused: subsCounted.filter((s) => !s.isActive).length,
    },
  };
}

export type SubMemberTxn = {
  id: string; date: string; name: string; merchant: string | null; amount: number;
  currency: string | null; category: string | null;
  account: string; account_mask: string | null; account_institution: string | null;
};

// One subscription + its member transactions (for the detail modal's price
// history + charge list). Members are matched in JS by the SAME norm() the
// detector groups by, so the list is exactly the stream behind the row.
export function getSubscription(id: string): { sub: Subscription; txns: SubMemberTxn[] } | null {
  const row = db().prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id) as SubRow | undefined;
  if (!row) return null;
  const sub = toSub(row);
  const cands = db().prepare(
    `SELECT t.id, t.date, t.name, t.merchant, t.amount, t.currency, t.category,
            a.name AS account, a.mask AS account_mask,
            COALESCE(i.institution_name, i.institution) AS account_institution
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     LEFT JOIN items i ON i.id = a.item_id
     WHERE t.entity = ? AND ${row.direction === "expense" ? "t.amount > 0" : "t.amount < 0"}
       AND COALESCE(t.merchant, t.name) IS NOT NULL
       AND t.date >= date('now','-400 days')
     ORDER BY t.date ASC`
  ).all(sub.entity) as unknown as (SubMemberTxn & { merchant: string | null; name: string })[];
  // Match on the displayed merchant OR the raw bank descriptor — merchant_key was
  // derived from the original descriptor at detection, so a later merchant rename
  // (which changes t.merchant) must not orphan the charge history.
  const txns = cands.filter((t) => norm(t.merchant || t.name) === row.merchant_key || norm(t.name) === row.merchant_key);
  return { sub, txns };
}

// ── AI layer (local model via the gateway; same propose/refine discipline as
//    categorize.ts — read the web for cancel-guide only, never for classification) ─

const CLASSIFY_SYSTEM = `You classify a person's recurring charges so a finance app can separate the ones worth cancelling from fixed obligations. For each item return a type:
- "subscription": a discretionary recurring service the person could cancel (streaming, software, news/media, apps, AI tools, cloud storage, SaaS).
- "membership": a club / warehouse / gym / association / loyalty membership.
- "obligation": a non-discretionary recurring payment they can't simply cancel — mortgage, rent, loan, insurance, utility, tax, medical/healthcare, tuition, credit-card payment, or a transfer to savings/investments.
- "other": doesn't fit the above.
Output ONLY a JSON array, one object per input: [{"id": <the id string>, "type": <one of subscription|membership|obligation|other>}]. No prose, no markdown.`;

const TYPE_SET = new Set(["subscription", "membership", "obligation", "other"]);

// Classify the UNKNOWN tail (type IS NULL — the rule classifier already tagged the
// obvious obligations/memberships). Fills the gap, never clobbers an existing type
// (the UPDATE guards type IS NULL), so a user/rule classification always wins.
export async function classifySubscriptionTypes(): Promise<{ processed: number; updated: number }> {
  const rows = db().prepare(
    `SELECT id, merchant, category, monthly, cadence FROM subscriptions
     WHERE direction = 'expense' AND state != 'dismissed' AND type IS NULL`
  ).all() as { id: string; merchant: string; category: string | null; monthly: number; cadence: string | null }[];
  if (!rows.length) return { processed: 0, updated: 0 };

  let updated = 0;
  const BATCH = 30;
  const set = db().prepare(`UPDATE subscriptions SET type = ?, updated_at = datetime('now') WHERE id = ? AND type IS NULL`);
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const reply = await chat(
      [{ role: "system", content: CLASSIFY_SYSTEM }, { role: "user", content: JSON.stringify(batch) }],
      { maxTokens: 1400 },
    );
    const parsed = extractJson<{ id: string; type: string }[]>(reply);
    if (!Array.isArray(parsed)) continue;
    for (const p of parsed) {
      if (!p?.id || !TYPE_SET.has(p.type)) continue;
      updated += Number(set.run(p.type, p.id).changes ?? 0);
    }
  }
  return { processed: rows.length, updated };
}

const OVERLAP_SYSTEM = `You find overlapping or redundant subscriptions for one person — services that do the same job, so they could consolidate and save. Examples: multiple video-streaming services, multiple music services, multiple cloud-storage services, multiple of the same vendor, two products that solve the same need.
Given a JSON array of subscriptions, return ONLY a JSON array of GROUPS. Each group: {"label": "<plain-English shared category, e.g. Video streaming>", "ids": [<member id strings>], "note": "<one short consolidation hint>"}. Only include a group with 2 or more members. If nothing overlaps, return []. No prose, no markdown.`;

export type OverlapGroup = {
  label: string; note: string; ids: string[]; monthly: number;
  members: { id: string; merchant: string; monthly: number }[];
};

// One LLM pass over the active subscriptions → semantic redundancy groups, each
// with its combined monthly cost. Read-only; nothing is written.
export async function detectOverlaps(entity?: string | null): Promise<{ groups: OverlapGroup[] }> {
  const active = listSubscriptions(entity).subs.filter(
    (s) => (s.state === "active" || s.state === "trial") && s.type !== "obligation",
  );
  if (active.length < 2) return { groups: [] };
  const reply = await chat(
    [
      { role: "system", content: OVERLAP_SYSTEM },
      { role: "user", content: JSON.stringify(active.map((s) => ({ id: s.id, merchant: s.merchant, category: s.category, monthly: s.monthly }))) },
    ],
    { maxTokens: 1000 },
  );
  const parsed = extractJson<{ label?: string; ids?: string[]; note?: string }[]>(reply);
  if (!Array.isArray(parsed)) return { groups: [] };
  const byId = new Map(active.map((s) => [s.id, s]));
  const groups = parsed
    .map((g) => {
      const members = (g.ids ?? []).map((id) => byId.get(id)).filter(Boolean) as Subscription[];
      return {
        label: g.label ?? "Overlap", note: g.note ?? "", ids: members.map((m) => m.id),
        members: members.map((m) => ({ id: m.id, merchant: m.merchant, monthly: m.monthly })),
        monthly: round2(members.reduce((a, m) => a + m.monthly, 0)),
      };
    })
    .filter((g) => g.members.length >= 2)
    .sort((a, b) => b.monthly - a.monthly);
  return { groups };
}

// ── Cut plan: the synthesized "what to cut" savings list ─────────────────────
// One pass that turns the scattered signals (unused, price hikes, redundant
// overlaps, trials about to convert) into a single ranked cancel list with a
// recoverable-$/yr total. Hybrid: the deterministic flags below already build a
// useful plan with zero AI (so it works when the GPU is busy); the best-effort
// local-model pass reorders and writes a human reason per item, degrading to the
// deterministic plan on any model failure. Read-only — the UI ties the result
// into the existing what-if meter (ticking a row drops the hero), nothing is
// written here.

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export type CutPlanItem = {
  id: string; merchant: string; monthly: number; annual: number;
  reason: string; kind: "unused" | "hike" | "overlap" | "trial" | "low-value";
  confidence: "high" | "medium" | "low";
};
export type CutPlan = {
  headline: string; items: CutPlanItem[];
  totalMonthly: number; totalAnnual: number; aiUsed: boolean;
};

const CUT_KINDS = new Set(["unused", "hike", "overlap", "trial", "low-value"]);
const CUT_CONF = new Set(["high", "medium", "low"]);

// The deterministic signal for one sub — the floor the AI builds on / falls back
// to. Returns null for a sub with no obvious reason to cut (a healthy keeper).
function cutSignal(s: Subscription): Pick<CutPlanItem, "reason" | "kind" | "confidence"> | null {
  if (!s.isActive) return { reason: "Looks unused — no recent activity", kind: "unused", confidence: "high" };
  if (s.state === "trial") return { reason: "Free trial — will start charging", kind: "trial", confidence: "high" };
  if (s.priceChange > 1) return { reason: `Price went up ${usd(s.priceChange)}/mo`, kind: "hike", confidence: "medium" };
  return null;
}

const CUT_SYSTEM = `You are a subscription savings advisor. From a person's active recurring subscriptions, pick the ones genuinely worth cancelling and rank them best-to-cut first. Weigh: unused (flagged inactive / no recent charge), recent price increases, redundant services that overlap another in the list (cancel the weaker one, keep the best of a pair), poor value for the cost, and free trials about to convert to paid. Do NOT pad the list — only include items a reasonable person would actually cancel, and leave strong keepers out.
Return ONLY JSON:
{"headline":"<one short line, e.g. Cancel 4 to recover $612/yr>","items":[{"id":<the id string>,"reason":"<under 8 words, concrete>","kind":"<unused|hike|overlap|trial|low-value>","confidence":"<high|medium|low>"}]}
No prose, no markdown.`;

export async function buildCutPlan(entity?: string | null): Promise<CutPlan> {
  const active = listSubscriptions(entity).subs.filter(
    (s) => (s.state === "active" || s.state === "trial") && s.type !== "obligation",
  );
  if (!active.length) return { headline: "Nothing to cut", items: [], totalMonthly: 0, totalAnnual: 0, aiUsed: false };
  const byId = new Map(active.map((s) => [s.id, s]));

  // Best-effort AI ranking pass over the whole active set (so it can spot
  // overlaps too); savings always come from OUR amounts, never the model's.
  let items: CutPlanItem[] = [];
  let aiUsed = false;
  try {
    const payload = active.map((s) => ({
      id: s.id, merchant: s.merchant, category: s.category, monthly: s.monthly,
      priceIncrease: round2(s.priceChange), inactive: !s.isActive, trial: s.state === "trial",
    }));
    const reply = await chat(
      [{ role: "system", content: CUT_SYSTEM }, { role: "user", content: JSON.stringify(payload) }],
      { maxTokens: 900 },
    );
    const parsed = extractJson<{ headline?: string; items?: { id: string; reason?: string; kind?: string; confidence?: string }[] }>(reply);
    if (parsed && Array.isArray(parsed.items)) {
      const seen = new Set<string>();
      items = parsed.items
        .map((it): CutPlanItem | null => {
          const s = byId.get(it.id);
          if (!s || seen.has(it.id)) return null;
          seen.add(it.id);
          const det = cutSignal(s);
          return {
            id: s.id, merchant: s.merchant, monthly: s.monthly, annual: round2(s.monthly * 12),
            reason: (it.reason ?? "").trim().slice(0, 64) || det?.reason || "Recurring cost worth a look",
            kind: (CUT_KINDS.has(it.kind ?? "") ? it.kind : det?.kind ?? "low-value") as CutPlanItem["kind"],
            confidence: (CUT_CONF.has(it.confidence ?? "") ? it.confidence : det?.confidence ?? "medium") as CutPlanItem["confidence"],
          };
        })
        .filter((x): x is CutPlanItem => x !== null);
      if (items.length) { aiUsed = true; }
    }
  } catch { /* model down / unparseable — deterministic plan below */ }

  // Deterministic plan: every sub with a cut signal, ranked by annual savings.
  if (!items.length) {
    items = active
      .map((s): CutPlanItem | null => {
        const det = cutSignal(s);
        return det ? { id: s.id, merchant: s.merchant, monthly: s.monthly, annual: round2(s.monthly * 12), ...det } : null;
      })
      .filter((x): x is CutPlanItem => x !== null)
      .sort((a, b) => (b.confidence === a.confidence ? b.annual - a.annual : (b.confidence === "high" ? 1 : -1)));
  }

  items = items.slice(0, 8);
  // Headline is always templated from OUR totals — never the model's number
  // (the model fabricates dollar figures; per-item reasons are its only job).
  const totalMonthly = round2(items.reduce((a, i) => a + i.monthly, 0));
  const totalAnnual = round2(totalMonthly * 12);
  const headline = items.length
    ? `Cancel ${items.length} to recover ${usd(totalAnnual)}/yr`
    : "Nothing obvious to cut — nicely trimmed";
  return { headline, items, totalMonthly, totalAnnual, aiUsed };
}

// ── Manual add ──────────────────────────────────────────────────────────────
const CADENCE_DAYS: Record<string, number> = { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30, quarterly: 91, yearly: 365 };

// Hand-add a subscription Plaid didn't detect (a new annual plan, a fresh signup).
// Keyed the same way detection keys, so if real charges show up later they merge
// into this row rather than duplicating it.
export function createManualSubscription(input: { entity?: string; merchant: string; amount: number; cadence: string; category?: string | null }): string | null {
  const merchant = input.merchant.trim();
  if (!merchant) return null;
  const key = norm(merchant);
  if (!key) return null;
  const entity = input.entity && input.entity !== "all" ? input.entity : "personal";
  const cadence = CADENCE_DAYS[input.cadence] ? input.cadence : "monthly";
  const intervalDays = CADENCE_DAYS[cadence];
  const amount = Math.abs(input.amount) || 0;
  const monthly = round2(amount * (30.44 / intervalDays));
  const category = input.category && input.category.trim() ? input.category.trim() : null;
  const id = `${entity}:expense:${key}`;
  db().prepare(
    `INSERT INTO subscriptions
       (id, entity, merchant_key, merchant, source, direction, type, category, cadence, interval_days,
        avg_amount, last_amount, monthly, count, last_date, next_expected, is_active, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'manual', 'expense', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, 'active', datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
        merchant = excluded.merchant, avg_amount = excluded.avg_amount, last_amount = excluded.last_amount,
        monthly = excluded.monthly, cadence = excluded.cadence, interval_days = excluded.interval_days,
        category = COALESCE(subscriptions.category, excluded.category), state = 'active', updated_at = datetime('now')`
  ).run(
    id, entity, key, merchant, classifyType(category, merchant, monthly) ?? "subscription", category,
    cadence, intervalDays, amount, amount, monthly, today(), addDays(today(), intervalDays),
  );
  return id;
}

const EDITABLE = ["state", "type", "merchant", "category", "color", "icon", "note", "trial_ends", "entity", "work_move"] as const;

// Patch user-owned fields. Parameterized; never touches detection columns. A
// cancelled/dismissed state set here survives the next reconcile (reconcile never
// rewrites state).
export function updateSubscription(id: string, body: Record<string, unknown>): boolean {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const f of EDITABLE) {
    if (f in body) {
      const v = body[f];
      sets.push(`${f} = ?`);
      args.push(v === "" || v == null ? null : String(v));
    }
  }
  if (sets.length === 0) return false;
  sets.push("updated_at = datetime('now')");
  args.push(id);
  const res = db().prepare(`UPDATE subscriptions SET ${sets.join(", ")} WHERE id = ?`).run(...(args as never[]));
  return Number(res.changes ?? 0) > 0;
}
