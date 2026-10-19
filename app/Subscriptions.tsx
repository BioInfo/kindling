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

export type SubGroup = "subs" | "bills" | "transfers" | "ended";
export type Subscription = {
  id: string; entity: string; merchant: string; merchantKey: string;
  category: string | null; type: string | null; cadence: string; intervalDays: number;
  avgAmount: number; lastAmount: number; monthly: number; count: number;
  firstDate: string | null; lastDate: string | null; nextExpected: string | null;
  isActive: boolean; priceChange: number; variableAmount: boolean;
  state: "active" | "trial" | "cancelled" | "dismissed";
  trialEnds: string | null; color: string | null; icon: string | null;
  note: string | null; workMove: string | null; source: string; plaidStreamId: string | null;
  mergedInto: string | null; typeSource: string | null; categorySource: string | null; userCadence: string | null;
  // enrichment (server-computed from the union of member charges)
  displayName: string; group: SubGroup; svcGroup: string | null;
  perCycle: number; annual: number;
  accounts: { label: string; mask: string | null; institution: string | null; last: string }[];
  history: { date: string; amount: number }[];
  lastChange: { date: string; from: number; to: number } | null;
  aliases: { id: string; merchant: string }[];
  overlapWith: { id: string; merchant: string; label: string }[];
  possibleDupOf: { id: string; merchant: string } | null;
  unlabelled: boolean;
  streams: { id: string; label: string; mask: string | null; last: string; amount: number; count: number; live: boolean }[];
  oneOffs: { count: number; total: number } | null;
};
export type SubsData = {
  subs: Subscription[];
  monthlyTotal: number; annualTotal: number; next30Total: number;
  billsMonthly: number; billsCount: number;
  transfersMonthly: number; transfersCount: number;
  endedCount: number;
  workMoveMonthly: number; workMoveCount: number;
  byCategory: { key: string; value: number; pct: number }[];
  counts: { active: number; priceHikes: number; overlaps: number; duplicates: number; unlabelled: number };
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
  // Lapsed streams (no charge in ~2 cycles) are history, not upcoming charges.
  const active = subs.filter((s) => s.group !== "ended");
  for (const s of active) {
    for (const d of occurrencesInMonth(s, monthStart, monthEnd)) {
      const arr = byDay.get(d) ?? []; arr.push({ merchant: s.displayName, amount: s.perCycle }); byDay.set(d, arr);
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

const GROUPS: { key: SubGroup; label: string; hint: string }[] = [
  { key: "subs", label: "Subscriptions", hint: "Counted in the number up top" },
  { key: "bills", label: "Bills", hint: "Mortgage, insurance, utilities: recurring, not cancellable" },
  { key: "transfers", label: "Transfers & savings", hint: "Money moved, not spent: savings, investing, family" },
  { key: "ended", label: "Ended", hint: "No charge in about two cycles, or cancelled. Not in any total" },
];

const shortDate = (d: string | null) => {
  if (!d) return "";
  const dt = new Date(d + "T00:00:00Z");
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC", ...(d.slice(0, 4) !== today().slice(0, 4) ? { year: "numeric" } : {}) });
};
const CADENCE_SHORT: Record<string, string> = { weekly: "weekly", biweekly: "every 2 wks", semimonthly: "twice a month", monthly: "monthly", quarterly: "quarterly", yearly: "yearly" };

// Initials badge: the service's identity at a glance without a network logo.
function Initials({ s, color }: { s: Subscription; color: string }) {
  const words = s.displayName.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/);
  const ini = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  return (
    <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold"
      style={{ background: color, color: "#fff" }}>{s.icon || ini}</span>
  );
}

const chip = (text: string, color = "var(--muted)") => (
  <span className="whitespace-nowrap rounded px-1.5 py-px text-[11px] font-medium" style={{ background: "var(--bg)", color }}>{text}</span>
);

// One row of the ledger: two lines, the whole row opens the detail sheet, and
// the what-if tick is its own 44px target. Work-card / dismiss / re-type live in
// the sheet, so nothing small sits next to the amount.
function SubRow({ s, color, picked, onPick, onOpen, yr }: {
  s: Subscription; color: string; picked: boolean; onPick?: () => void; onOpen: () => void; yr: boolean;
}) {
  const ended = s.group === "ended";
  const card = s.accounts[0];
  const meta = [
    CADENCE_SHORT[s.cadence] ?? s.cadence,
    card?.mask ? `••${card.mask}` : null,
    ended ? (s.lastDate ? `last ${shortDate(s.lastDate)}` : null)
      : s.nextExpected ? `${s.nextExpected < today() ? "was due" : "next"} ${shortDate(s.nextExpected)}` : null,
  ].filter(Boolean).join(" · ");
  const amt = yr ? s.annual : s.monthly;
  return (
    <div className="flex items-center gap-1 pr-3" style={{ borderTop: "1px solid var(--border)", opacity: ended ? 0.7 : 1 }}>
      {onPick ? (
        <label className="flex h-14 w-11 shrink-0 cursor-pointer items-center justify-center" title="What if I cancel this?">
          <input type="checkbox" checked={picked} onChange={onPick} className="h-5 w-5" style={{ accentColor: "var(--accent)" }}
            aria-label={`What if I cancel ${s.displayName}`} />
        </label>
      ) : <span className="w-3 shrink-0" />}
      <button onClick={onOpen} className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2 text-left">
        <Initials s={s} color={color} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-medium" style={{ textDecoration: s.state === "cancelled" ? "line-through" : undefined }}>{s.displayName}</span>
            <span className="shrink-0 tabular-nums font-medium" style={{ color: picked ? "var(--good)" : "var(--text)" }}>
              {money(amt).replace(/\.\d+$/, amt >= 100 ? "" : "$&")}<span className="text-xs font-normal" style={{ color: "var(--muted)" }}>/{yr ? "yr" : "mo"}</span>
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs" style={{ color: "var(--muted)" }}>
            <span className="truncate">{meta}</span>
            {s.state === "trial" && chip("trial", "var(--warn)")}
            {!ended && s.priceChange > 0.5 && chip(`up ${money(s.priceChange)}`, "var(--warn-strong)")}
            {!ended && s.overlapWith.length > 0 && chip(`overlaps ${s.overlapWith[0].merchant}`, "#a78bfa")}
            {s.possibleDupOf && chip("duplicate?", "var(--info)")}
            {s.aliases.length > 0 && chip(`${s.aliases.length + 1} descriptors`)}
            {s.workMove === "pending" && chip("to work card", "var(--warn)")}
            {s.unlabelled && !ended && chip("unlabelled")}
          </span>
        </span>
      </button>
    </div>
  );
}

// A collapsible drawer: header always shows count + subtotal, so the money
// picture is complete even with every drawer shut. Paginates at 10.
function GroupSection({ g, rows, open, onToggle, subtotal, children }: {
  g: (typeof GROUPS)[number]; rows: Subscription[]; open: boolean; onToggle: () => void; subtotal: string;
  children: (pageRows: Subscription[]) => React.ReactNode;
}) {
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(10);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(page, pages - 1);
  return (
    <section className="overflow-hidden rounded-xl" style={panel}>
      <button onClick={onToggle} aria-expanded={open} className="flex min-h-12 w-full items-center gap-2 px-3 py-2 text-left" title={g.hint}>
        <span className="w-4 shrink-0 text-xs" style={{ color: "var(--muted)" }}>{open ? "▾" : "▸"}</span>
        <span className="font-semibold">{g.label}</span>
        <span className="text-sm" style={{ color: "var(--muted)" }}>{rows.length}</span>
        <span className="ml-auto text-sm tabular-nums" style={{ color: g.key === "ended" ? "var(--muted)" : "var(--text)" }}>{subtotal}</span>
      </button>
      {open && (
        <>
          {rows.length === 0 && <div className="px-3 pb-4 text-sm" style={{ color: "var(--muted)" }}>Nothing here.</div>}
          {children(rows.slice(p * size, p * size + size))}
          {rows.length > 10 && <Pager page={p} pageSize={size} total={rows.length} onPage={setPage} onPageSize={(n) => { setSize(n); setPage(0); }} />}
        </>
      )}
    </section>
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
  const [open, setOpen] = useState<Record<SubGroup, boolean>>({ subs: true, bills: false, transfers: false, ended: false });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [classifying, setClassifying] = useState(false);
  const [classifyMsg, setClassifyMsg] = useState<string | null>(null);
  const [overlaps, setOverlaps] = useState<OverlapGroup[] | null>(null);
  const [olBusy, setOlBusy] = useState(false);
  const [plan, setPlan] = useState<CutPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);

  const subs = useMemo(() => data?.subs ?? [], [data]);
  const COLORS = useChartTheme().series;
  const groupColor = useMemo(() => {
    const m = new Map<string, string>();
    (data?.byCategory ?? []).forEach((c, i) => m.set(c.key, COLORS[i % COLORS.length]));
    return m;
  }, [data, COLORS]);
  const colorOf = (s: Subscription) => s.color || groupColor.get(s.svcGroup ?? "") || (s.group === "ended" ? "#94a3b8" : COLORS[(s.displayName.charCodeAt(0) || 0) % COLORS.length]);

  // One search + sort across every drawer; each drawer paginates its own slice.
  const tv = useTableView(subs, {
    searchOf: (s) => `${s.displayName} ${s.merchant} ${s.svcGroup ?? ""} ${prettyCategory(s.category)} ${s.aliases.map((a) => a.merchant).join(" ")}`,
    sorts: [
      { key: "monthly", label: "Monthly", val: (s) => s.monthly },
      { key: "next", label: "Next charge", val: (s) => s.nextExpected ?? "" },
      { key: "name", label: "Name", val: (s) => s.displayName.toLowerCase() },
      { key: "since", label: "First seen", val: (s) => s.firstDate ?? "" },
    ],
    initialSort: "monthly", pageSize: 100000,
  });
  const searching = tv.toolbar.q.trim().length > 0;
  const byGroup = (g: SubGroup) => tv.pageRows.filter((s) => s.group === g);

  if (!data) return <section className="rounded-xl p-6 text-center" style={{ color: "var(--muted)", ...panel }}>Loading…</section>;

  const counted = (s: Subscription) => s.group === "subs" && (s.state === "active" || s.state === "trial");
  const savingMo = subs.filter((s) => picked.has(s.id) && counted(s)).reduce((a, s) => a + s.monthly, 0);
  const yr = valueView === "yr";
  const k = yr ? 12 : 1;
  const heroNow = Math.max(0, data.monthlyTotal - savingMo) * k;
  const heroWas = data.monthlyTotal * k;

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const merge = async (id: string, into: string) => {
    await fetch(`/api/subscriptions/${encodeURIComponent(id)}/merge`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ into }),
    }).catch(() => {});
    reload();
  };
  const notDup = async (id: string) => {
    await fetch(`/api/subscriptions/${encodeURIComponent(id)}/merge`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notDuplicate: true }),
    }).catch(() => {});
    reload();
  };
  const toggleBill = async (id: string) => {
    await fetch(`/api/subscriptions/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "bill" }),
    }).catch(() => {});
    setPicked((p) => { const n = new Set(p); n.delete(id); return n; });
    setPlan((pl) => (pl ? { ...pl, items: pl.items.filter((i) => i.id !== id) } : pl));
    reload();
  };
  const classify = async () => {
    setClassifying(true); setClassifyMsg(null);
    const r = await fetch(`/api/subscriptions/classify${entityQ}`, { method: "POST" }).then((x) => x.json()).catch(() => null);
    setClassifying(false);
    if (r?.updated != null) { setClassifyMsg(`Labelled ${r.updated} of ${r.processed}`); reload(); }
    else setClassifyMsg("Labelling failed. The model may be cold, try again");
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
    setPlan(r ?? { headline: "Couldn't build a plan. Try again", items: [], totalMonthly: 0, totalAnnual: 0, aiUsed: false });
  };
  const tickAllPlan = () => { if (plan) setPicked((p) => new Set([...p, ...plan.items.map((i) => i.id)])); };

  // Two ended descriptors of one brand are history, not clutter worth a prompt.
  const groupOf = new Map(subs.map((s) => [s.id, s.group]));
  const entityOf = new Map(subs.map((s) => [s.id, s.entity]));
  const dups = subs.filter((s) => s.possibleDupOf && !(s.group === "ended" && groupOf.get(s.possibleDupOf.id) === "ended"));
  const seg = (v: "mo" | "yr", label: string) => (
    <button onClick={() => setValueView(v)} className="min-h-9 rounded-md px-3 text-xs font-medium"
      style={{ background: valueView === v ? "var(--accent-deep)" : "var(--bg)", color: valueView === v ? "white" : "var(--muted)", border: "1px solid var(--border)" }}>{label}</button>
  );
  const subtotal = (g: SubGroup) => {
    if (g === "ended") return "not in totals";
    const v = g === "subs" ? data.monthlyTotal : g === "bills" ? data.billsMonthly : data.transfersMonthly;
    return `${money(v * k)}/${yr ? "yr" : "mo"}`;
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Hero: the live-recompute meter. Ticking rows below drops it. */}
      <section className="rounded-xl p-4" style={panel}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm" style={{ color: "var(--muted)" }}>
              <span>Subscriptions</span>{seg("mo", "Monthly")}{seg("yr", "Annual")}
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
              <span className="hero-ember text-3xl font-semibold tracking-tight tabular-nums">{money(heroNow)}</span>
              <span className="text-sm" style={{ color: "var(--muted)" }}>/{yr ? "yr" : "mo"}</span>
              {picked.size > 0 && <span className="text-sm line-through tabular-nums" style={{ color: "var(--muted)" }}>{money(heroWas)}</span>}
            </div>
            <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
              {data.counts.active} live · next 30 days {money(data.next30Total)}
            </div>
          </div>
          <button onClick={onRefresh} disabled={refreshing} className="min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium" style={field}
            title="Re-pull recurring streams from Plaid and re-detect from your history">{refreshing ? "Refreshing…" : "Refresh"}</button>
        </div>
        {picked.size > 0 && (
          <div className="mt-2 flex items-center gap-2 text-sm font-medium" style={{ color: "var(--good)" }}>
            Cancel {picked.size}: save {money(savingMo)}/mo · {money(savingMo * 12)}/yr
            <button onClick={() => setPicked(new Set())} className="min-h-9 px-2 text-xs font-normal underline" style={{ color: "var(--muted)" }}>clear</button>
          </div>
        )}
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <button onClick={() => setOpen((o) => ({ ...o, bills: true }))} className="min-h-11 rounded-lg px-2.5 py-1.5 text-left" style={{ background: "var(--bg)" }}>
            <div style={{ color: "var(--muted)" }}>Bills · {data.billsCount}</div>
            <div className="text-sm font-medium tabular-nums">{money(data.billsMonthly * k)}/{yr ? "yr" : "mo"}</div>
          </button>
          <button onClick={() => setOpen((o) => ({ ...o, transfers: true }))} className="min-h-11 rounded-lg px-2.5 py-1.5 text-left" style={{ background: "var(--bg)" }}>
            <div style={{ color: "var(--muted)" }}>Transfers & savings · {data.transfersCount}</div>
            <div className="text-sm font-medium tabular-nums">{money(data.transfersMonthly * k)}/{yr ? "yr" : "mo"}</div>
          </button>
        </div>
        {data.workMoveCount > 0 && (
          <div className="mt-2 text-xs" style={{ color: "var(--warn)" }}>
            {data.workMoveCount} tagged for your work card · {money(data.workMoveMonthly)}/mo to move
          </div>
        )}
      </section>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={buildPlan} disabled={planBusy} className="min-h-11 rounded-lg px-3 text-sm font-semibold" style={{ background: "var(--accent-deep)", color: "white", opacity: planBusy ? 0.6 : 1 }}
          title="Overlaps, price rises and trials in one ranked cancel list">{planBusy ? "Building plan…" : "What to cut"}</button>
        <button onClick={findOverlaps} disabled={olBusy} className="min-h-11 rounded-lg px-3 text-sm font-medium" style={{ ...panel, color: "var(--accent)", opacity: olBusy ? 0.6 : 1 }}>
          {olBusy ? "Looking…" : `Overlaps${data.counts.overlaps ? ` ${data.counts.overlaps}` : ""}`}</button>
        {data.counts.unlabelled > 0 && (
          <button onClick={classify} disabled={classifying} className="min-h-11 rounded-lg px-3 text-sm font-medium" style={{ ...panel, color: "var(--accent)", opacity: classifying ? 0.6 : 1 }}
            title="The model labels the rows the rules could not">{classifying ? "Labelling…" : `Label ${data.counts.unlabelled}`}</button>
        )}
        <AddSubscription entityQ={entityQ} onAdded={reload} />
        {classifyMsg && <span className="text-xs" style={{ color: "var(--muted)" }}>{classifyMsg}</span>}
      </div>

      {/* Possible duplicates: one tap merges, one tap says they differ. */}
      {dups.length > 0 && (
        <section className="overflow-hidden rounded-xl" style={panel}>
          <div className="px-3 pt-3 text-sm font-semibold">Same service twice?</div>
          {dups.slice(0, 4).map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <button onClick={() => onSub(s.id)} className="min-h-11 min-w-0 flex-1 text-left text-sm">
                <span className="font-medium">{s.displayName}</span>
                <span style={{ color: "var(--muted)" }}> looks like {s.possibleDupOf!.merchant}{entityOf.get(s.possibleDupOf!.id) !== s.entity ? ` (${s.entity} vs ${entityOf.get(s.possibleDupOf!.id)})` : ""}</span>
              </button>
              <button onClick={() => merge(s.id, s.possibleDupOf!.id)} className="min-h-11 rounded-lg px-3 text-sm font-medium" style={{ background: "var(--accent-deep)", color: "white" }}>Merge</button>
              <button onClick={() => notDup(s.id)} className="min-h-11 rounded-lg px-3 text-sm" style={field}>Different</button>
            </div>
          ))}
        </section>
      )}

      {/* Cut plan: ticking a row flows into the hero meter (shared `picked`). */}
      {plan && (
        <section className="overflow-hidden rounded-xl" style={panel}>
          <div className="flex flex-wrap items-center justify-between gap-2 p-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="min-w-0">
              <div className="text-sm font-semibold">What to cut</div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>
                {plan.headline}{!plan.aiUsed && plan.items.length > 0 ? " · model offline, rule-based" : ""}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {plan.items.length > 0 && (
                <button onClick={tickAllPlan} className="min-h-11 rounded-lg px-3 text-xs font-medium" style={{ ...field, color: "var(--good)" }}>Tick all</button>
              )}
              <button onClick={() => setPlan(null)} className="min-h-11 px-2 text-xs" style={{ color: "var(--muted)" }}>close</button>
            </div>
          </div>
          {plan.items.length === 0 && (
            <div className="p-4 text-center text-sm" style={{ color: "var(--muted)" }}>Nothing obvious to cut. Your subscriptions look trimmed.</div>
          )}
          {plan.items.map((it, i) => {
            const on = picked.has(it.id);
            return (
              <div key={it.id} className="flex items-center gap-1 pr-3" style={{ borderTop: i ? "1px solid var(--border)" : undefined }}>
                <label className="flex h-14 w-11 shrink-0 cursor-pointer items-center justify-center">
                  <input type="checkbox" checked={on} onChange={() => toggle(it.id)} className="h-5 w-5" style={{ accentColor: "var(--accent)" }} aria-label={`What if I cancel ${it.merchant}`} />
                </label>
                <button onClick={() => onSub(it.id)} className="min-h-14 min-w-0 flex-1 py-2 text-left">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{it.merchant}</span>
                    <span className="shrink-0 text-sm tabular-nums" style={{ color: on ? "var(--good)" : "var(--text)" }}>{money(it.monthly)}/mo</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs" style={{ color: "var(--muted)" }}>
                    <span className="shrink-0 rounded px-1.5 py-px text-[11px] font-medium" style={{ background: "var(--bg)", color: KIND_COLOR[it.kind] }}>{KIND_LABEL[it.kind]}</span>
                    <span className="truncate">{it.reason}</span>
                  </span>
                </button>
                <button onClick={() => toggleBill(it.id)} className="min-h-11 shrink-0 rounded-lg px-2 text-xs" style={field}
                  title="Not a subscription: file it as a bill and drop it from this plan">Bill</button>
              </div>
            );
          })}
        </section>
      )}

      {/* Overlaps panel */}
      {overlaps && (
        <section className="overflow-hidden rounded-xl" style={panel}>
          <div className="flex items-center justify-between p-3 text-sm font-semibold" style={{ borderBottom: "1px solid var(--border)" }}>
            <span>Overlapping services</span>
            <button onClick={() => setOverlaps(null)} className="min-h-11 px-2 text-xs font-normal" style={{ color: "var(--muted)" }}>close</button>
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
                  <button key={m.id} onClick={() => onSub(m.id)} className="min-h-9 rounded px-2 text-xs" style={{ background: "var(--bg)", color: "var(--text)" }}>{m.merchant} {money(m.monthly)}</button>
                ))}
              </div>
              {g.note && <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>{g.note}</div>}
            </div>
          ))}
        </section>
      )}

      {/* View toggle: List · Calendar */}
      <div className="flex items-center gap-1.5">
        {([["list", "List"], ["calendar", "Calendar"]] as ["list" | "calendar", string][]).map(([key, label]) => (
          <button key={key} onClick={() => setPane(key)} className="min-h-11 rounded-md px-4 text-sm font-medium"
            style={{ background: pane === key ? "var(--accent-deep)" : "var(--panel)", color: pane === key ? "white" : "var(--text)", border: "1px solid var(--border)" }}>{label}</button>
        ))}
      </div>

      {pane === "calendar" ? (
        <CalendarView subs={subs} />
      ) : subs.length === 0 ? (
        <section className="rounded-xl p-6 text-center" style={{ color: "var(--muted)", ...panel }}>
          No subscriptions detected yet. Sync to pull recurring charges, or add one with + Add.
        </section>
      ) : (
        <>
          <TableToolbar {...tv.toolbar} placeholder="Search services…" />
          {GROUPS.map((g) => {
            const rows = byGroup(g.key);
            if (searching && rows.length === 0) return null;
            return (
              <GroupSection key={g.key} g={g} rows={rows} open={open[g.key] || (searching && rows.length > 0)}
                onToggle={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))} subtotal={subtotal(g.key)}>
                {(pageRows) => pageRows.map((s) => (
                  <SubRow key={s.id} s={s} color={colorOf(s)} yr={yr} picked={picked.has(s.id)}
                    onPick={counted(s) ? () => toggle(s.id) : undefined} onOpen={() => onSub(s.id)} />
                ))}
              </GroupSection>
            );
          })}
        </>
      )}

      {/* By service group: where the subscription money goes */}
      {pane === "list" && data.byCategory.length > 0 && (
        <section className="rounded-xl p-4" style={panel}>
          <div className="mb-2 text-sm font-medium">By service <span style={{ color: "var(--muted)" }}>· monthly</span></div>
          <CategoryDonut slices={data.byCategory} total={data.monthlyTotal} />
        </section>
      )}
    </div>
  );
}
