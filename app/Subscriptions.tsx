"use client";

import { useMemo, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { money, panel, prettyCategory, useTableView, TableToolbar, Pager, useChartTheme } from "./ui";
import { CATEGORIES } from "@/lib/taxonomy";

// The Subscriptions surface: a leak ledger. Every row is money leaving on a
// clock; the job is to make the invisible recurring drip visible and cuttable.
// Signature element = the live-recompute $/mo hero (tick "what if I cancel" rows
// and the hero drops to show the savings). Phase 2 adds the AI layer (classify,
// overlap detection, cancel-guide); Phase 3 adds the calendar, manual add, and
// per-sub colour/icon identity. Matches the existing Plaid system throughout.

export type Subscription = {
  id: string; entity: string; merchant: string; merchantKey: string;
  category: string | null; type: string | null; cadence: string; intervalDays: number;
  avgAmount: number; lastAmount: number; monthly: number; count: number;
  firstDate: string | null; lastDate: string | null; nextExpected: string | null;
  isActive: boolean; priceChange: number; variableAmount: boolean;
  state: "active" | "trial" | "cancelled" | "dismissed";
  trialEnds: string | null; color: string | null; icon: string | null;
  note: string | null; workMove: string | null; source: string; plaidStreamId: string | null;
};
export type SubsData = {
  subs: Subscription[];
  monthlyTotal: number; annualTotal: number; next30Total: number;
  obligationsMonthly: number; obligationsCount: number;
  workMoveMonthly: number; workMoveCount: number;
  byCategory: { key: string; value: number; pct: number }[];
  counts: { active: number; priceHikes: number; unused: number };
};
type OverlapGroup = { label: string; note: string; ids: string[]; monthly: number; members: { id: string; merchant: string; monthly: number }[] };
type CutPlanItem = { id: string; merchant: string; monthly: number; annual: number; reason: string; kind: "unused" | "hike" | "overlap" | "trial" | "low-value"; confidence: "high" | "medium" | "low" };
type CutPlan = { headline: string; items: CutPlanItem[]; totalMonthly: number; totalAnnual: number; aiUsed: boolean };

// Per-cut-reason accent — matches the insight-strip palette (unused blue, hike
// amber, overlap violet, trial yellow, low-value grey).
const KIND_COLOR: Record<CutPlanItem["kind"], string> = {
  unused: "var(--info)", hike: "var(--warn-strong)", overlap: "#a78bfa", trial: "var(--warn)", "low-value": "#94a3b8",
};
const KIND_LABEL: Record<CutPlanItem["kind"], string> = {
  unused: "unused", hike: "price ↑", overlap: "redundant", trial: "trial", "low-value": "low value",
};

// Chart series colors come from the active theme (CHART.series in ui.tsx).
const field = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" };
const today = () => new Date().toISOString().slice(0, 10);
function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + Math.round(days)); return d.toISOString().slice(0, 10);
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: { key: string; value: number; pct: number } }[] }) {
  if (!active || !payload?.length) return null;
  const s = payload[0].payload;
  return (
    <div className="rounded-lg px-2.5 py-1.5 text-xs" style={{ background: "var(--panel)", border: "1px solid var(--border)", color: "var(--text)" }}>
      <div className="font-medium">{prettyCategory(s.key)}</div>
      <div style={{ color: "var(--muted)" }}>{money(s.value)}/mo · {Math.round(s.pct * 100)}%</div>
    </div>
  );
}

function CategoryDonut({ slices, total }: { slices: { key: string; value: number; pct: number }[]; total: number }) {
  const COLORS = useChartTheme().series;
  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0" style={{ width: 132, height: 132 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="key" innerRadius={42} outerRadius={64} paddingAngle={1} stroke="none">
              {slices.map((s, i) => <Cell key={s.key} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px]" style={{ color: "var(--muted)" }}>per mo</span>
          <span className="text-xs font-semibold tabular-nums" style={{ color: "var(--text)" }}>{money(total)}</span>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
        {slices.slice(0, 7).map((s, i) => (
          <span key={s.key} className="flex items-center gap-1.5" style={{ color: "var(--muted)" }}>
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
            <span style={{ color: "var(--text)" }}>{prettyCategory(s.key)}</span>
            <span className="ml-auto whitespace-nowrap tabular-nums">{money(s.value)} · {Math.round(s.pct * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const badge = (text: string, color = "var(--muted)") => (
  <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: "var(--bg)", color }}>{text}</span>
);

// Charge occurrences for one stream landing inside a given month.
function occurrencesInMonth(s: Subscription, monthStart: string, monthEnd: string): string[] {
  const step = Math.max(1, s.intervalDays || 30);
  const base = s.nextExpected || s.lastDate;
  if (!base) return [];
  let d = base;
  let guard = 0;
  while (d > monthStart && guard < 400) { d = addDays(d, -step); guard++; }
  const out: string[] = [];
  guard = 0;
  while (d <= monthEnd && guard < 400) { if (d >= monthStart) out.push(d); d = addDays(d, step); guard++; }
  return out;
}

// A charge calendar: which days the card gets hit this month, and the month total.
function CalendarView({ subs }: { subs: Subscription[] }) {
  const [offset, setOffset] = useState(0); // months from current
  const now = new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const year = base.getUTCFullYear(), month = base.getUTCMonth();
  const monthStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month + 1).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay(); // 0=Sun
  const label = base.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  // date → charges
  const byDay = new Map<string, { merchant: string; amount: number }[]>();
  const active = subs.filter((s) => s.state === "active" || s.state === "trial");
  for (const s of active) {
    for (const d of occurrencesInMonth(s, monthStart, monthEnd)) {
      const arr = byDay.get(d) ?? []; arr.push({ merchant: s.merchant, amount: s.lastAmount }); byDay.set(d, arr);
    }
  }
  const monthTotal = [...byDay.values()].flat().reduce((a, c) => a + c.amount, 0);
  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const dayKey = (n: number) => `${year}-${String(month + 1).padStart(2, "0")}-${String(n).padStart(2, "0")}`;
  const isToday = (n: number) => dayKey(n) === today();

  const navBtn = (txt: string, on: () => void) => (
    <button onClick={on} className="rounded px-2 py-1 text-sm" style={field}>{txt}</button>
  );

  return (
    <section className="rounded-xl p-3" style={panel}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">{navBtn("‹", () => setOffset((o) => o - 1))}<span className="text-sm font-semibold">{label}</span>{navBtn("›", () => setOffset((o) => o + 1))}</div>
        <span className="text-sm" style={{ color: "var(--muted)" }}>{money(monthTotal)} this month</span>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px]" style={{ color: "var(--muted)" }}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i} className="py-0.5">{d}</div>)}
        {cells.map((n, i) => {
          if (n == null) return <div key={`b${i}`} />;
          const charges = byDay.get(dayKey(n)) ?? [];
          const sum = charges.reduce((a, c) => a + c.amount, 0);
          return (
            <div key={n} className="flex min-h-[42px] flex-col items-center rounded p-0.5"
              title={charges.length ? charges.map((c) => `${c.merchant}: ${money(c.amount)}`).join("\n") : undefined}
              style={{ background: charges.length ? "var(--bg)" : "transparent", border: isToday(n) ? "1px solid var(--accent)" : "1px solid transparent" }}>
              <span className="text-[11px]" style={{ color: isToday(n) ? "var(--accent-deep)" : "var(--text)" }}>{n}</span>
              {charges.length > 0 && (
                <span className="mt-0.5 rounded px-1 text-[9px] tabular-nums" style={{ background: "var(--accent-deep)", color: "white" }}>{money(sum).replace(/\.\d+/, "")}</span>
              )}
            </div>
          );
        })}
      </div>
      {/* chronological list of this month's charges */}
      <div className="mt-3 flex flex-col gap-1">
        {[...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, cs]) => (
          <div key={d} className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
            <span className="w-20 shrink-0 tabular-nums">{d}</span>
            <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{cs.map((c) => c.merchant).join(", ")}</span>
            <span className="shrink-0 tabular-nums">{money(cs.reduce((a, c) => a + c.amount, 0))}</span>
          </div>
        ))}
        {byDay.size === 0 && <div className="py-4 text-center text-sm" style={{ color: "var(--muted)" }}>No charges projected this month.</div>}
      </div>
    </section>
  );
}

function AddSubscription({ entityQ, onAdded }: { entityQ: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState("monthly");
  const [category, setCategory] = useState("Subscriptions");
  const add = async () => {
    if (!merchant.trim() || !amount) return;
    await fetch(`/api/subscriptions${entityQ}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchant: merchant.trim(), amount: Number(amount), cadence, category }),
    }).catch(() => {});
    setMerchant(""); setAmount(""); setOpen(false); onAdded();
  };
  if (!open) return <button onClick={() => setOpen(true)} className="rounded-lg px-3 py-1.5 text-sm font-medium" style={panel}>+ Add</button>;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl p-3" style={panel}>
      <input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="Service (e.g. Netflix)" className="min-w-40 flex-1 rounded px-2 py-1 text-sm" style={field} />
      <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="amount" inputMode="decimal" className="w-24 rounded px-2 py-1 text-sm" style={field} />
      <select value={cadence} onChange={(e) => setCadence(e.target.value)} className="rounded px-2 py-1 text-sm" style={field}>
        {["weekly", "biweekly", "monthly", "quarterly", "yearly"].map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <select value={category} onChange={(e) => setCategory(e.target.value)} className="max-w-36 rounded px-2 py-1 text-sm" style={field}>
        {CATEGORIES.map((c) => <option key={c} value={c}>{prettyCategory(c)}</option>)}
      </select>
      <button onClick={add} className="rounded px-3 py-1 text-sm font-medium" style={{ background: "var(--accent-deep)", color: "white" }}>Add</button>
      <button onClick={() => setOpen(false)} className="text-xs" style={{ color: "var(--muted)" }}>cancel</button>
    </div>
  );
}

export function Subscriptions({
  data, reload, onSub, onRefresh, refreshing, entityQ,
}: {
  data: SubsData | null;
  reload: () => void;
  onSub: (id: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  entityQ: string;
}) {
  const [valueView, setValueView] = useState<"mo" | "yr">("mo");
  const [pane, setPane] = useState<"list" | "calendar">("list");
  const [seg, setSeg] = useState<"subs" | "bills" | "work" | "all">("subs");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [classifying, setClassifying] = useState(false);
  const [classifyMsg, setClassifyMsg] = useState<string | null>(null);
  const [overlaps, setOverlaps] = useState<OverlapGroup[] | null>(null);
  const [olBusy, setOlBusy] = useState(false);
  const [plan, setPlan] = useState<CutPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);

  const subs = useMemo(() => data?.subs ?? [], [data]);
  const rows = useMemo(
    () => subs.filter((s) =>
      seg === "all" ? true
        : seg === "bills" ? s.type === "obligation"
        : seg === "work" ? s.workMove === "pending"
        : s.type !== "obligation"),
    [subs, seg],
  );
  const COLORS = useChartTheme().series;
  const catColor = useMemo(() => {
    const m = new Map<string, string>();
    (data?.byCategory ?? []).forEach((c, i) => m.set(c.key, COLORS[i % COLORS.length]));
    return m;
  }, [data, COLORS]);

  const tv = useTableView(rows, {
    searchOf: (s) => `${s.merchant} ${prettyCategory(s.category)}`,
    sorts: [
      { key: "monthly", label: "Monthly", val: (s) => s.monthly },
      { key: "amount", label: "Charge", val: (s) => s.lastAmount },
      { key: "next", label: "Next charge", val: (s) => s.nextExpected ?? "" },
      { key: "name", label: "Name", val: (s) => s.merchant },
    ],
    initialSort: "monthly", pageSize: 10,
  });

  if (!data) return <section className="rounded-xl p-6 text-center" style={{ color: "var(--muted)", ...panel }}>Loading…</section>;

  const counted = (s: Subscription) => (s.state === "active" || s.state === "trial") && s.type !== "obligation";
  const savingMo = subs.filter((s) => picked.has(s.id) && counted(s)).reduce((a, s) => a + s.monthly, 0);
  const adjMo = Math.max(0, data.monthlyTotal - savingMo);
  const heroNow = (picked.size ? adjMo : data.monthlyTotal) * (valueView === "mo" ? 1 : 12);
  const heroWas = valueView === "mo" ? data.monthlyTotal : data.annualTotal;

  const strip: { id?: string; icon: string; color: string; text: string }[] = [];
  for (const s of subs) if (counted(s) && s.priceChange > 1) strip.push({ id: s.id, icon: "↗", color: "var(--warn-strong)", text: `${s.merchant} up ${money(s.priceChange)} — now ${money(s.lastAmount)}` });
  for (const s of subs) if (s.state === "active" && !s.isActive && s.monthly >= 1 && s.type !== "obligation") strip.push({ id: s.id, icon: "⊘", color: "var(--info)", text: `${s.merchant} looks unused · ${money(s.monthly)}/mo` });
  const topCat = data.byCategory[0];
  if (topCat && topCat.pct >= 0.4) strip.push({ icon: "▣", color: "#a78bfa", text: `${prettyCategory(topCat.key)} is ${Math.round(topCat.pct * 100)}% of recurring spend` });

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const dismiss = async (id: string) => {
    await fetch(`/api/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    setPicked((p) => { const n = new Set(p); n.delete(id); return n; });
    reload();
  };
  // One-tap "this is a bill, not a subscription" — flip type obligation ⇄
  // subscription. Setting obligation moves it to the Bills segment and drops it
  // out of the hero, the cut-plan, and the what-if meter (those all exclude
  // obligations). Survives the next reconcile (type is user-owned).
  const toggleBill = async (s: Subscription) => {
    const next = s.type === "obligation" ? "subscription" : "obligation";
    await fetch(`/api/subscriptions/${encodeURIComponent(s.id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: next }),
    }).catch(() => {});
    if (next === "obligation") {
      setPicked((p) => { const n = new Set(p); n.delete(s.id); return n; });
      setPlan((pl) => (pl ? { ...pl, items: pl.items.filter((i) => i.id !== s.id) } : pl));
    }
    reload();
  };
  // One-tap tag/untag a sub to move to a work card (pending ⇄ off).
  const toggleWork = async (s: Subscription) => {
    const next = s.workMove === "pending" ? "" : "pending";
    await fetch(`/api/subscriptions/${encodeURIComponent(s.id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ work_move: next }),
    }).catch(() => {});
    reload();
  };
  const classify = async () => {
    setClassifying(true); setClassifyMsg(null);
    const r = await fetch(`/api/subscriptions/classify${entityQ}`, { method: "POST" }).then((x) => x.json()).catch(() => null);
    setClassifying(false);
    if (r?.updated != null) { setClassifyMsg(`Classified ${r.updated} of ${r.processed}`); reload(); }
    else setClassifyMsg("Classify failed — model may be cold, try again");
  };
  const findOverlaps = async () => {
    setOlBusy(true);
    const r = await fetch(`/api/subscriptions/overlaps${entityQ}`).then((x) => x.json()).catch(() => null);
    setOlBusy(false);
    setOverlaps(r?.groups ?? []);
  };
  const buildPlan = async () => {
    setPlanBusy(true);
    const r: CutPlan | null = await fetch(`/api/subscriptions/cut-plan${entityQ}`).then((x) => x.json()).catch(() => null);
    setPlanBusy(false);
    setPlan(r ?? { headline: "Couldn't build a plan — try again", items: [], totalMonthly: 0, totalAnnual: 0, aiUsed: false });
  };
  // Tick every plan row into the what-if meter (the hero recomputes live).
  const tickAllPlan = () => { if (plan) setPicked((p) => new Set([...p, ...plan.items.map((i) => i.id)])); };

  const valBtn = (v: "mo" | "yr", label: string) => (
    <button onClick={() => setValueView(v)} className="rounded-md px-2.5 py-1 text-xs font-medium"
      style={{ background: valueView === v ? "var(--accent-deep)" : "var(--bg)", color: valueView === v ? "white" : "var(--muted)", border: "1px solid var(--border)" }}>{label}</button>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Hero — the live-recompute meter */}
      <section className="rounded-xl p-4" style={panel}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm" style={{ color: "var(--muted)" }}>
              Subscriptions {valBtn("mo", "Monthly")}{valBtn("yr", "Annual")}
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="hero-ember text-3xl font-semibold tracking-tight tabular-nums">{money(heroNow)}</span>
              <span className="text-sm" style={{ color: "var(--muted)" }}>/{valueView === "mo" ? "mo" : "yr"}</span>
              {picked.size > 0 && <span className="text-sm line-through tabular-nums" style={{ color: "var(--muted)" }}>{money(heroWas)}</span>}
            </div>
            <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
              {data.counts.active} active · next 30 days {money(data.next30Total)}
              {valueView === "mo" ? <> · {money(data.annualTotal)}/yr</> : <> · {money(data.monthlyTotal)}/mo</>}
            </div>
            {data.obligationsCount > 0 && (
              <div className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}
                title="Mortgage, loans, insurance, autopays and transfers — recurring, but not subscriptions you'd cancel. In the Bills tab, excluded from the number above.">
                + {money(data.obligationsMonthly)}/mo in bills &amp; loans ({data.obligationsCount}) · not counted above
              </div>
            )}
            {data.workMoveCount > 0 && (
              <button onClick={() => setSeg("work")} className="mt-0.5 block text-left text-xs hover:underline" style={{ color: "var(--warn)" }}
                title="Subscriptions on your personal card tagged to move to your work card">
                💼 {data.workMoveCount} tagged for your work card · {money(data.workMoveMonthly)}/mo to move
              </button>
            )}
            {picked.size > 0 && (
              <div className="mt-1.5 text-sm font-medium" style={{ color: "var(--good)" }}>
                Cancel {picked.size}: save {money(savingMo)}/mo · {money(savingMo * 12)}/yr
                <button onClick={() => setPicked(new Set())} className="ml-2 text-xs font-normal underline" style={{ color: "var(--muted)" }}>clear</button>
              </div>
            )}
          </div>
          <button onClick={onRefresh} disabled={refreshing} className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium" style={panel}
            title="Re-pull recurring streams from Plaid + re-detect from your history">{refreshing ? "Refreshing…" : "↻ Refresh"}</button>
        </div>
      </section>

      {/* Action row: AI + add */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={buildPlan} disabled={planBusy} className="rounded-lg px-3 py-1.5 text-sm font-semibold" style={{ background: "var(--accent-deep)", color: "white", opacity: planBusy ? 0.6 : 1 }}
          title="Synthesize unused, price hikes, overlaps and trials into one ranked cancel list">{planBusy ? "Building plan…" : "✨ What to cut"}</button>
        <button onClick={classify} disabled={classifying} className="rounded-lg px-3 py-1.5 text-sm font-medium" style={{ ...panel, color: "var(--accent)", opacity: classifying ? 0.6 : 1 }}
          title="Local model sorts the unknown ones into subscription / membership / bill">{classifying ? "Classifying…" : "✨ Classify"}</button>
        <button onClick={findOverlaps} disabled={olBusy} className="rounded-lg px-3 py-1.5 text-sm font-medium" style={{ ...panel, color: "var(--accent)", opacity: olBusy ? 0.6 : 1 }}
          title="Find redundant services you could consolidate">{olBusy ? "Looking…" : "⧉ Find overlaps"}</button>
        <AddSubscription entityQ={entityQ} onAdded={reload} />
        {classifyMsg && <span className="text-xs" style={{ color: "var(--muted)" }}>{classifyMsg}</span>}
      </div>

      {/* Cut plan — the synthesized "what to cut" recommendation. Ticking a row
          flows into the what-if meter in the hero (shared `picked` set). */}
      {plan && (
        <section className="rounded-xl overflow-hidden" style={panel}>
          <div className="flex flex-wrap items-center justify-between gap-2 p-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="min-w-0">
              <div className="text-sm font-semibold">✨ What to cut</div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>
                {plan.headline}{!plan.aiUsed && plan.items.length > 0 ? " · model offline, rule-based" : ""}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {plan.items.length > 0 && (
                <button onClick={tickAllPlan} className="rounded-md px-2.5 py-1 text-xs font-medium" style={{ background: "var(--bg)", color: "var(--good)", border: "1px solid var(--border)" }}
                  title="Add every row to the what-if meter">Tick all</button>
              )}
              <button onClick={() => setPlan(null)} className="text-xs" style={{ color: "var(--muted)" }}>close</button>
            </div>
          </div>
          {plan.items.length === 0 && (
            <div className="p-4 text-center text-sm" style={{ color: "var(--muted)" }}>Nothing obvious to cut — your subscriptions look trimmed.</div>
          )}
          {plan.items.map((it, i) => {
            const on = picked.has(it.id);
            return (
              <div key={it.id} className="flex flex-wrap items-center gap-2 p-3" style={{ borderTop: i ? "1px solid var(--border)" : undefined, opacity: on ? 1 : 0.92 }}>
                <input type="checkbox" checked={on} onChange={() => toggle(it.id)} title="What if I cancel this?" className="shrink-0" style={{ accentColor: "var(--accent)" }} />
                <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "var(--bg)", color: KIND_COLOR[it.kind] }}>{KIND_LABEL[it.kind]}</span>
                <button onClick={() => onSub(it.id)} className="min-w-0 flex-1 text-left font-medium hover:underline" title="Subscription detail — incl. how to cancel">{it.merchant}</button>
                <span className="min-w-0 basis-full truncate pl-6 text-xs sm:basis-auto sm:pl-0" style={{ color: "var(--muted)" }} title={it.reason}>{it.reason}</span>
                <span className="ml-auto shrink-0 text-sm tabular-nums" style={{ color: on ? "var(--good)" : "var(--text)" }}>{money(it.monthly)}/mo</span>
                <button onClick={() => { const f = subs.find((x) => x.id === it.id); if (f) toggleBill(f); }} className="shrink-0 rounded px-1.5 leading-none"
                  title="Not a subscription — it's a bill (move to Bills, drop from this plan)" style={{ border: "1px solid var(--border)", background: "var(--bg)", color: "var(--muted)" }}>🧾</button>
              </div>
            );
          })}
          {plan.items.length > 0 && (
            <div className="p-3 text-xs" style={{ borderTop: "1px solid var(--border)", color: "var(--muted)" }}>
              Tick rows to see the savings land in the meter up top, then open a row for one-tap ✨ cancel steps.
            </div>
          )}
        </section>
      )}

      {/* Overlaps panel */}
      {overlaps && (
        <section className="rounded-xl overflow-hidden" style={panel}>
          <div className="flex items-center justify-between p-3 text-sm font-semibold" style={{ borderBottom: "1px solid var(--border)" }}>
            <span>⧉ Overlapping services</span>
            <button onClick={() => setOverlaps(null)} className="text-xs font-normal" style={{ color: "var(--muted)" }}>close</button>
          </div>
          {overlaps.length === 0 && <div className="p-4 text-center text-sm" style={{ color: "var(--muted)" }}>No obvious overlaps. Nicely consolidated.</div>}
          {overlaps.map((g, i) => (
            <div key={i} className="p-3" style={{ borderTop: i ? "1px solid var(--border)" : undefined }}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{g.label} <span style={{ color: "var(--muted)" }}>· {g.members.length} services</span></span>
                <span className="tabular-nums" style={{ color: "var(--warn-strong)" }}>{money(g.monthly)}/mo</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {g.members.map((m) => (
                  <button key={m.id} onClick={() => onSub(m.id)} className="rounded px-1.5 py-0.5 text-xs hover:underline" style={{ background: "var(--bg)", color: "var(--text)" }}>{m.merchant} {money(m.monthly)}</button>
                ))}
              </div>
              {g.note && <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>{g.note}</div>}
            </div>
          ))}
        </section>
      )}

      {/* Insight strip */}
      {strip.length > 0 && (
        <section className="rounded-xl overflow-hidden" style={panel}>
          <div className="p-3 text-sm font-semibold" style={{ borderBottom: "1px solid var(--border)" }}>💡 What to know</div>
          {strip.slice(0, 5).map((c, i) => (
            <div key={i} className="flex items-center gap-2 p-3 text-sm" style={{ borderTop: i ? "1px solid var(--border)" : undefined }}>
              <span style={{ color: c.color, width: 16, textAlign: "center", flexShrink: 0 }}>{c.icon}</span>
              {c.id ? <button onClick={() => onSub(c.id!)} className="min-w-0 flex-1 truncate text-left hover:underline" title={c.text}>{c.text}</button>
                : <span className="min-w-0 flex-1 truncate" title={c.text}>{c.text}</span>}
            </div>
          ))}
        </section>
      )}

      {/* Category donut */}
      {data.byCategory.length > 0 && (
        <section className="rounded-xl p-4" style={panel}>
          <div className="mb-2 text-sm font-medium">By category <span style={{ color: "var(--muted)" }}>· monthly equivalent</span></div>
          <CategoryDonut slices={data.byCategory} total={data.monthlyTotal} />
        </section>
      )}

      {/* View toggle: List · Calendar */}
      <div className="flex items-center gap-1.5">
        {([["list", "List"], ["calendar", "Calendar"]] as ["list" | "calendar", string][]).map(([k, label]) => (
          <button key={k} onClick={() => setPane(k)} className="rounded-md px-3 py-1.5 text-sm font-medium"
            style={{ background: pane === k ? "var(--accent-deep)" : "var(--panel)", color: pane === k ? "white" : "var(--text)", border: "1px solid var(--border)" }}>{label}</button>
        ))}
      </div>

      {pane === "calendar" ? (
        <CalendarView subs={subs} />
      ) : (
        <>
          {subs.length > 0 && <TableToolbar {...tv.toolbar} placeholder="Search subscriptions…" />}
          <section className="rounded-xl overflow-hidden" style={panel}>
            <div className="flex flex-wrap items-center justify-between gap-2 p-3" style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="flex flex-wrap items-center gap-1.5">
                {([["subs", `Subscriptions ${data.counts.active}`], ["bills", `Bills ${data.obligationsCount}`], ["work", `→ Work ${data.workMoveCount}`], ["all", "All"]] as [typeof seg, string][]).map(([k, label]) => (
                  <button key={k} onClick={() => setSeg(k)} className="rounded-md px-2.5 py-1 text-xs font-medium"
                    style={{ background: seg === k ? "var(--accent-deep)" : "var(--bg)", color: seg === k ? "white" : "var(--muted)", border: "1px solid var(--border)" }}>{label}</button>
                ))}
              </div>
              <span className="text-sm" style={{ color: "var(--muted)" }}>
                {seg === "bills" ? <>{money(data.obligationsMonthly)}/mo</>
                  : seg === "work" ? <>{money(data.workMoveMonthly)}/mo to move</>
                  : seg === "all" ? <>{money(data.monthlyTotal + data.obligationsMonthly)}/mo</>
                  : <>{money(data.monthlyTotal)}/mo across {data.counts.active}</>}
              </span>
            </div>
            {subs.length === 0 && (
              <div className="p-6 text-center" style={{ color: "var(--muted)" }}>
                No subscriptions detected yet. Hit Sync to pull recurring charges, or add one with + Add.
              </div>
            )}
            {subs.length > 0 && rows.length === 0 && <div className="p-6 text-center" style={{ color: "var(--muted)" }}>Nothing in this view.</div>}
            {tv.pageRows.map((s) => {
              const inactive = !s.isActive || s.state === "cancelled";
              const dot = s.color || catColor.get(s.category ?? "Uncategorized") || "var(--muted)";
              return (
                <div key={s.id} className="flex flex-wrap items-center gap-2 p-3" style={{ borderTop: "1px solid var(--border)", opacity: inactive ? 0.65 : 1 }}>
                  <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} title="What if I cancel this?" className="shrink-0" style={{ accentColor: "var(--accent)" }} />
                  {s.icon ? <span className="shrink-0 text-sm leading-none">{s.icon}</span> : <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: dot }} />}
                  <button onClick={() => onSub(s.id)} className="min-w-0 flex-1 text-left font-medium hover:underline"
                    style={{ textDecoration: inactive ? "line-through" : undefined }} title="Subscription detail">{s.merchant}</button>
                  {badge(s.cadence)}
                  {s.category ? <span className="text-xs" style={{ color: "var(--muted)" }}>{prettyCategory(s.category)}</span> : null}
                  {s.variableAmount ? badge("variable") : null}
                  {s.state === "trial" ? badge("trial", "var(--warn)") : null}
                  {s.priceChange > 1 ? badge(`↗ ${money(s.priceChange)}`, "var(--warn-strong)") : null}
                  {inactive ? badge("inactive") : <span className="text-xs" style={{ color: "var(--muted)" }}>next {s.nextExpected ?? "—"}</span>}
                  {s.workMove === "moved" ? badge("✓ work") : null}
                  <span className="text-sm tabular-nums" style={{ minWidth: 90, textAlign: "right" }}>{money(s.monthly)}/mo</span>
                  <button onClick={() => toggleBill(s)} className="shrink-0 rounded px-1.5 leading-none"
                    title={s.type === "obligation" ? "Filed as a bill — tap to make it a subscription again" : "Not a subscription? Mark it a bill (moves to Bills, out of the hero)"}
                    style={{ border: "1px solid var(--border)", background: s.type === "obligation" ? "var(--info-bg)" : "var(--bg)", color: s.type === "obligation" ? "#000" : "var(--muted)" }}>🧾</button>
                  <button onClick={() => toggleWork(s)} className="shrink-0 rounded px-1.5 leading-none"
                    title={s.workMove === "pending" ? "Tagged to move to your work card — tap to untag" : "Tag to move to your work card"}
                    style={{ border: "1px solid var(--border)", background: s.workMove === "pending" ? "var(--warn-bg)" : "var(--bg)", color: s.workMove === "pending" ? "#000" : "var(--muted)" }}>💼</button>
                  <button onClick={() => dismiss(s.id)} className="shrink-0 rounded px-1.5 leading-none" style={{ color: "var(--muted)", border: "1px solid var(--border)" }} title="Not a subscription / hide" aria-label="Dismiss">×</button>
                </div>
              );
            })}
            <Pager {...tv.pager} />
          </section>
        </>
      )}
    </div>
  );
}
