import { db } from "./db";
import { detectAnomalies } from "./anomalies";
import { forecast } from "./forecast";
import { listBudgets } from "./budgets";
import { listGoals } from "./goals";
import { taxView } from "./tax";
import { listSubscriptions } from "./subscriptions";
import { prettyCategory } from "./taxonomy";
import { chat } from "./llm";

// ── Proactive insights feed ("What to know") ────────────────────────────────
// The MOAT layer: one ranked, dismissable feed that tells you the few things
// that actually need your attention today, pulled from every surface the app
// already computes — spending anomalies, bills coming due, a subscription that
// jumped, a budget you've blown, a goal falling behind pace, a cash-flow dip,
// and the tax horizon. Every number is computed deterministically in SQL/TS
// (this file only re-shapes existing lib outputs); the only model touch is an
// optional one-line lede generated out-of-band (see narrateLede / the lede
// route), never on the critical render path. Zero egress.
//
// It REPLACES the standalone anomaly "Worth a look" card — anomalies become one
// source among many, so the Overview has one place to glance, not two.

export type Severity = "high" | "med" | "info" | "good";

// How the row drills when tapped: into the transaction list (the shared
// TxnDrillModal) or to a tab. null = not tappable (already-visible context like
// the forecast, which sits right below on the Overview).
export type InsightDrill =
  | { kind: "txn"; title: string; q?: string; category?: string; days?: number }
  | { kind: "tab"; tab: string };

export type Insight = {
  key: string;          // stable dismiss id "<kind>:<...>"; a new occurrence re-fires
  kind: string;         // for the icon map
  severity: Severity;   // → color + rank
  icon: string;
  text: string;         // the main line (tappable when drill != null)
  meta: string | null;  // small right-side label (a date, or "in 4d")
  drill: InsightDrill | null;
};

const usd = (n: number) =>
  "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const today = () => new Date().toISOString().slice(0, 10);
const daysUntil = (date: string) =>
  Math.round((+new Date(date + "T00:00:00Z") - +new Date(today() + "T00:00:00Z")) / 86400000);
const whenLabel = (d: number) => (d <= 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);

const ICON: Record<string, string> = {
  due: "◷", hike: "↗", spike: "▲", duplicate: "⧉", new: "✦",
  "budget-over": "▣", "budget-hot": "▢",
  "goal-pace": "◎", "goal-overdue": "◎",
  "forecast-low": "▽",
  "tax-due": "◷", "tax-event": "◆", "tax-ok": "✓",
  "sub-unused": "⊘", "sub-trial": "⏳",
};

const RANK: Record<Severity, number> = { high: 3, med: 2, info: 1, good: 0 };

// CSS vars so severity colors track the active theme (used in inline styles only).
export const SEVERITY_COLOR: Record<Severity, string> = {
  high: "var(--bad)",
  med: "var(--warn-strong)",
  info: "var(--info)",
  good: "var(--good)",
};

// Anomaly kind → insight severity. A due bill is urgent only when it's close;
// a duplicate charge is money possibly lost twice (high); a price hike or a
// spike is worth a look (med); a new merchant is informational (info).
function anomalySeverity(kind: string, insightDate: string): Severity {
  if (kind === "due") return daysUntil(insightDate) <= 3 ? "high" : "med";
  if (kind === "duplicate") return "high";
  if (kind === "hike" || kind === "spike") return "med";
  return "info"; // new
}

// Gather every candidate insight, drop the ones already dismissed, rank, cap.
// entity scopes the sources that are entity-aware (anomalies, budgets); the
// forecast is whole-portfolio and goals/tax are global, same as their own tabs.
export function gatherInsights(entity?: string | null): Insight[] {
  const out: Insight[] = [];

  // 1. Spending anomalies + recurring-derived bills (due / hike) — the old
  //    "Worth a look" card, now folded in. Reuse each anomaly's stable key.
  for (const a of detectAnomalies({ entity })) {
    out.push({
      key: a.key,
      kind: a.kind,
      severity: anomalySeverity(a.kind, a.date),
      icon: ICON[a.kind] ?? "•",
      text: a.detail,
      meta: a.date,
      drill: a.merchant ? { kind: "txn", title: a.merchant, q: a.merchant } : null,
    });
  }

  // 2. Budgets you've blown or are running hot this month.
  for (const b of listBudgets(entity).budgets) {
    const pct = Math.round(b.pct * 100);
    if (b.over) {
      const overBy = b.spent - b.available;
      out.push({
        key: `budget-over:${b.category}:${today().slice(0, 7)}`,
        kind: "budget-over",
        severity: overBy >= 500 ? "high" : "med",
        icon: ICON["budget-over"],
        text: `${prettyCategory(b.category)} ${pct}% — ${usd(overBy)} over budget`,
        meta: null,
        drill: { kind: "txn", title: prettyCategory(b.category), category: b.category, days: 31 },
      });
    } else if (b.hot) {
      out.push({
        key: `budget-hot:${b.category}:${today().slice(0, 7)}`,
        kind: "budget-hot",
        severity: "info",
        icon: ICON["budget-hot"],
        text: `${prettyCategory(b.category)} running hot — ${pct}% used`,
        meta: null,
        drill: { kind: "txn", title: prettyCategory(b.category), category: b.category, days: 31 },
      });
    }
  }

  // 3. Goals falling behind: required pace outruns your recent savings rate, or
  //    the deadline has passed.
  const gv = listGoals();
  for (const g of gv.goals) {
    if (g.done) continue;
    if (g.overdue) {
      out.push({
        key: `goal-overdue:${g.id}`,
        kind: "goal-overdue",
        severity: "med",
        icon: ICON["goal-overdue"],
        text: `${g.name} past deadline — ${usd(g.remaining)} to go`,
        meta: g.deadline,
        drill: { kind: "tab", tab: "goals" },
      });
    } else if (g.perMonth != null && g.perMonth > Math.max(0, gv.monthlySavings)) {
      out.push({
        key: `goal-pace:${g.id}`,
        kind: "goal-pace",
        severity: "info",
        icon: ICON["goal-pace"],
        text: `${g.name} needs ${usd(g.perMonth)}/mo · you're saving ${usd(gv.monthlySavings)}`,
        meta: null,
        drill: { kind: "tab", tab: "goals" },
      });
    }
  }

  // 4. Cash-flow dip. Only when the projected low is a genuine drawdown — going
  //    negative (urgent) or losing more than half your liquid cash. For a fat
  //    cash buffer this stays quiet, which is the point (no manufactured alarm).
  const f = forecast();
  if (f.low.balance < 0) {
    out.push({
      key: `forecast-low:${f.low.date}`,
      kind: "forecast-low",
      severity: "high",
      icon: ICON["forecast-low"],
      text: `Cash projected to go negative — ${usd(f.low.balance)} on ${f.low.date}`,
      meta: whenLabel(daysUntil(f.low.date)),
      drill: null,
    });
  } else if (f.startBalance > 0 && f.low.balance < f.startBalance * 0.5) {
    out.push({
      key: `forecast-low:${f.low.date}`,
      kind: "forecast-low",
      severity: "info",
      icon: ICON["forecast-low"],
      text: `Cash dips to ${usd(f.low.balance)} on ${f.low.date}`,
      meta: whenLabel(daysUntil(f.low.date)),
      drill: null,
    });
  }

  // 5. Tax horizon. An estimated payment coming due (urgent near the deadline),
  //    the nearest big vesting event to set money aside for, and — when nothing
  //    is owed — a single reassuring "on track" line so the feed isn't all alarm.
  const tax = taxView(new Date().getFullYear());
  if (tax.nextDue && tax.nextDue.amount > 0) {
    const d = tax.nextDue.daysUntil;
    out.push({
      key: `tax-due:${tax.nextDue.jurisdiction}:${tax.nextDue.due}`,
      kind: "tax-due",
      severity: d <= 14 ? "high" : "med",
      icon: ICON["tax-due"],
      text: `Estimated tax due: ${tax.nextDue.jurisdiction} Q${tax.nextDue.q} ${usd(tax.nextDue.amount)}`,
      meta: whenLabel(d),
      drill: { kind: "tab", tab: "tax" },
    });
  }
  const ev = tax.events.find((e) => e.setAside > 0);
  if (ev) {
    out.push({
      key: `tax-event:${ev.source}:${ev.date}`,
      kind: "tax-event",
      severity: "info",
      icon: ICON["tax-event"],
      text: `${ev.label} — set aside ${usd(ev.setAside)} for taxes`,
      meta: ev.date.slice(0, 7),
      drill: { kind: "tab", tab: "tax" },
    });
  }
  if (tax.safeHarbor.gap === 0 && !tax.nextDue) {
    out.push({
      key: `tax-ok:${tax.year}`,
      kind: "tax-ok",
      severity: "good",
      icon: ICON["tax-ok"],
      text: `${tax.year} taxes on track — withholding covers it`,
      meta: null,
      drill: { kind: "tab", tab: "tax" },
    });
  }

  // 6. Subscriptions you may have stopped using: still "active" in your list but
  //    the stream has gone quiet (Plaid is_active false / no charge in ~2 cycles)
  //    — the classic "forgot to cancel" leak. Price hikes and due-soon already
  //    arrive via the recurring anomalies above, so this adds only the unused
  //    signal (no double-counting).
  for (const s of listSubscriptions(entity).subs) {
    // A free trial converting soon — the highest-regret charge to miss.
    if (s.state === "trial" && s.trialEnds) {
      const d = daysUntil(s.trialEnds);
      if (d >= 0 && d <= 7) {
        out.push({
          key: `sub-trial:${s.id}:${s.trialEnds}`,
          kind: "sub-trial",
          severity: d <= 2 ? "high" : "med",
          icon: ICON["sub-trial"],
          text: `${s.merchant} trial converts ${whenLabel(d)} — ${usd(s.monthly)}/mo after`,
          meta: s.trialEnds,
          drill: { kind: "tab", tab: "subscriptions" },
        });
      }
    }
    if (s.state !== "active" || s.isActive || s.monthly < 1) continue;
    const quiet = s.lastDate ? -daysUntil(s.lastDate) : 0;
    out.push({
      key: `sub-unused:${s.id}:${s.lastDate ?? ""}`,
      kind: "sub-unused",
      severity: "info",
      icon: ICON["sub-unused"],
      text: `${s.merchant} looks unused${quiet > 0 ? ` — no charge in ${quiet} days` : ""} · ${usd(s.monthly)}/mo`,
      meta: s.lastDate,
      drill: { kind: "tab", tab: "subscriptions" },
    });
  }

  // Drop dismissed, rank (severity, then most recent).
  const dismissed = new Set(
    (db().prepare(`SELECT insight_id FROM dismissed_insights`).all() as unknown as { insight_id: string }[])
      .map((r) => r.insight_id)
  );
  const ranked = out
    .filter((i) => !dismissed.has(i.key))
    .sort((a, b) => RANK[b.severity] - RANK[a.severity] || (b.meta ?? "").localeCompare(a.meta ?? ""));

  // Cap the noisy anomaly kinds so a flurry of them can't crowd out the
  // cross-source insights (tax horizon, cash-flow dip, budgets, goals) that are
  // the whole point of a unified feed. Bills, duplicates, and price hikes are
  // naturally few; spikes and first-time-merchant flags are not — keep only the
  // top couple of each (by rank), then fill the glance to ten.
  const PER_KIND_CAP: Record<string, number> = { spike: 2, new: 2, "sub-unused": 3 };
  const seen: Record<string, number> = {};
  const picked: Insight[] = [];
  for (const i of ranked) {
    const cap = PER_KIND_CAP[i.kind];
    if (cap != null) {
      seen[i.kind] = (seen[i.kind] ?? 0) + 1;
      if (seen[i.kind] > cap) continue;
    }
    picked.push(i);
    if (picked.length >= 10) break;
  }
  return picked;
}

export function dismissInsights(keys: string[]): void {
  const ins = db().prepare(`INSERT OR IGNORE INTO dismissed_insights (insight_id) VALUES (?)`);
  for (const k of keys) if (typeof k === "string" && k) ins.run(k);
}

// ── One-line lede (best-effort, local model, out-of-band) ───────────────────
// A per-day signature over the visible feed: same insights on the same day →
// same sig → a cached lede, so it's generated at most once per distinct feed.
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
export function ledeSig(insights: Insight[]): string {
  return `${today()}:${djb2(insights.map((i) => i.key).sort().join("|"))}`;
}
export function cachedLede(sig: string): { lede: string; model: string | null } | null {
  const row = db().prepare(`SELECT lede, model FROM insight_lede WHERE sig = ?`).get(sig) as
    | { lede: string; model: string | null }
    | undefined;
  return row ?? null;
}

const LEDE_SYSTEM =
  "You write a single plain-English sentence summarizing a personal-finance alert feed. " +
  "Rules: one sentence, at most 22 words, no preamble, no greeting, no markdown, no em-dashes. " +
  "Restate only what the items say — never invent a number or a claim. " +
  "Lead with what needs attention; if the items are all calm, say so plainly.";

// Generate + cache the lede for a feed. Best-effort: any failure (model cold,
// model down, gateway error) returns null and caches nothing, so the cards still
// render and tomorrow's load retries cleanly. Never called on the GET path.
export async function narrateLede(insights: Insight[]): Promise<{ lede: string; model: string } | null> {
  if (insights.length === 0) return null;
  const sig = ledeSig(insights);
  const hit = cachedLede(sig);
  if (hit) return { lede: hit.lede, model: hit.model ?? "" };

  const model = process.env.FINANCE_LLM_MODEL ?? "deepseek-v4-flash";
  try {
    const raw = await chat(
      [
        { role: "system", content: LEDE_SYSTEM },
        { role: "user", content: JSON.stringify(insights.map((i) => ({ severity: i.severity, text: i.text }))) },
      ],
      // 5-minute budget (matches the weekly digest's warm budget): this runs
      // out-of-band (the cards already rendered) on the persistent prod server,
      // whose handler runs to completion even if the client navigates away — so a
      // full cold NVFP4 boot (~280s observed) finishes and caches the lede rather
      // than timing out at the UI's 90s and re-failing on every load. Once cached,
      // every GET returns it instantly until the feed changes. Off the UI path.
      { maxTokens: 80, temperature: 0, model, timeoutMs: 300_000 },
    );
    const lede = raw.trim().replace(/^["']|["']$/g, "").split("\n")[0].slice(0, 200);
    if (!lede) return null;
    db().prepare(`INSERT OR REPLACE INTO insight_lede (sig, lede, model) VALUES (?, ?, ?)`).run(sig, lede, model);
    return { lede, model };
  } catch {
    return null; // model cold / gateway down — skip the lede, cards already rendered
  }
}
