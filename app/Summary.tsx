"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import { money, panel, useChartTheme, type ChartTheme } from "./ui";

// Top-4 category line colors, from the theme's chart series.
const lines = (C: ChartTheme) => [C.accent, C.good, C.warn, C.bad];

// ── Weekly (existing) ───────────────────────────────────────────────────────
type SummaryStats = {
  period: { start: string; end: string };
  spend: { thisWeek: number; lastWeek: number; deltaPct: number | null };
  income: number;
  netWorth: { current: number; delta: number | null };
};
export type SummaryData = {
  weekStart: string; weekEnd: string;
  stats: SummaryStats; narrative: string; model: string | null; createdAt: string | null;
};

// ── Monthly ─────────────────────────────────────────────────────────────────
type MonthlyCatMove = { category: string; thisMonth: number; lastMonth: number; delta: number };
type CategoryTrend = { category: string; points: { month: string; amount: number }[] };
type MonthlyStats = {
  reportMonth: string; reportLabel: string; prevMonth: string; currentMonth: string;
  spend: { thisMonth: number; lastMonth: number; deltaPct: number | null };
  income: { thisMonth: number; lastMonth: number };
  netSavings: { thisMonth: number; lastMonth: number };
  mtdSpend: number;
  topCategories: MonthlyCatMove[];
  trendMonths: string[]; trendLabels: string[]; categoryTrends: CategoryTrend[];
  netWorth: { current: number; prior: number | null; delta: number | null; priorDate: string | null; linkedExcluded: number };
};
type MonthlyData = { month: string; stats: MonthlyStats; narrative: string; model: string | null; createdAt: string | null };

const fmtAxis = (v: number) => (Math.abs(v) >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`);

function TrendTooltip({ active, payload, label }: { active?: boolean; payload?: { name?: string; value?: number; color?: string }[]; label?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg px-2.5 py-1.5 text-xs" style={{ background: "var(--panel)", border: "1px solid var(--border)", color: "var(--text)" }}>
      <div className="mb-0.5" style={{ color: "var(--muted)" }}>{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color }} />{p.name}
          </span>
          <span>{money(p.value ?? 0)}</span>
        </div>
      ))}
    </div>
  );
}

function TrendChart({ s }: { s: MonthlyStats }) {
  const C = useChartTheme();
  const LINES = lines(C);
  const cats = s.categoryTrends.map((t) => t.category);
  if (cats.length === 0) return null;
  // One row per month: { m: "May", Category: amount, ... }
  const data = s.trendMonths.map((ym, i) => {
    const row: Record<string, number | string> = { m: (s.trendLabels[i] ?? ym).split(" ")[0] };
    for (const t of s.categoryTrends) row[t.category] = t.points[i]?.amount ?? 0;
    return row;
  });
  return (
    <div>
      <div className="mb-1 text-xs" style={{ color: "var(--muted)" }}>Category spend, last {s.trendMonths.length} months</div>
      <div style={{ width: "100%", height: 168 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 8, left: -8, bottom: 0 }}>
            <XAxis dataKey="m" tick={{ fontSize: 11, fill: C.muted }} axisLine={{ stroke: C.border }} tickLine={false} />
            <YAxis tickFormatter={fmtAxis} tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} width={44} />
            <Tooltip content={<TrendTooltip />} />
            {cats.map((c, i) => (
              <Line key={c} type="monotone" dataKey={c} stroke={LINES[i % LINES.length]} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {cats.map((c, i) => (
          <span key={c} className="flex items-center gap-1.5" style={{ color: "var(--muted)" }}>
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: LINES[i % LINES.length] }} />{c}
          </span>
        ))}
      </div>
    </div>
  );
}

function MonthlyView({ data, busy, onGenerate }: { data: MonthlyData | null; busy: boolean; onGenerate: () => void }) {
  const genBtn = (
    <button onClick={onGenerate} disabled={busy} className="rounded px-2.5 py-1 text-xs font-medium"
      style={{ background: "var(--accent-deep)", color: "white", opacity: busy ? 0.6 : 1 }}>
      {busy ? "Generating…" : data ? "Refresh" : "Generate"}
    </button>
  );
  if (!data) {
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          A month-over-month review of your last complete month, with category trend lines — written locally on your network.
        </p>
        {genBtn}
      </div>
    );
  }
  const st = data.stats;
  const d = st.spend.deltaPct;
  const up = d != null && d > 0;
  const chip = (label: string, val: ReactNode) => (
    <span className="rounded-lg px-2.5 py-1" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
      <span className="mr-1 text-xs" style={{ color: "var(--muted)" }}>{label}</span>{val}
    </span>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs" style={{ color: "var(--muted)" }}>reviewing {st.reportLabel}</span>
        {genBtn}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {chip("Spent", <>{money(st.spend.thisMonth)}{d != null ? <span style={{ color: up ? "var(--bad)" : "var(--good)" }}> {up ? "▲" : "▼"}{Math.abs(d)}%</span> : null}</>)}
        {chip("Net saved", <span style={{ color: st.netSavings.thisMonth >= 0 ? "var(--good)" : "var(--bad)" }}>{money(st.netSavings.thisMonth)}</span>)}
        {chip(`${st.currentMonth.slice(5)}/${st.currentMonth.slice(0, 4)} so far`, money(st.mtdSpend))}
      </div>
      <div className="text-sm" style={{ color: "var(--text)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{data.narrative}</div>
      <TrendChart s={st} />
      <div className="text-xs" style={{ color: "var(--muted)" }}>Written by {data.model ?? "the model"} · stays on your network</div>
    </div>
  );
}

// ── Card (toggles between week + month) ──────────────────────────────────────
export function SummaryCard({
  data, busy, onGenerate,
}: { data: SummaryData | null; busy: boolean; onGenerate: () => void }) {
  const [period, setPeriod] = useState<"week" | "month">("week");
  const [monthly, setMonthly] = useState<MonthlyData | null>(null);
  const [monthLoaded, setMonthLoaded] = useState(false);
  const [monthBusy, setMonthBusy] = useState(false);

  // Lazy-load the stored monthly review the first time the user flips to Month.
  useEffect(() => {
    if (period === "month" && !monthLoaded) {
      setMonthLoaded(true);
      fetch("/api/summary/monthly").then((r) => r.json()).then((j) => setMonthly(j.summary ?? null)).catch(() => {});
    }
  }, [period, monthLoaded]);

  const genMonthly = async () => {
    setMonthBusy(true);
    try {
      const r = await fetch("/api/summary/monthly", { method: "POST" }).then((x) => x.json());
      if (r.summary) setMonthly(r.summary);
    } finally { setMonthBusy(false); }
  };

  const seg = (
    <div className="flex overflow-hidden rounded-lg text-xs" style={{ border: "1px solid var(--border)" }}>
      {(["week", "month"] as const).map((p) => (
        <button key={p} onClick={() => setPeriod(p)} className="px-2.5 py-1"
          style={{ background: period === p ? "var(--accent-deep)" : "transparent", color: period === p ? "white" : "var(--muted)" }}>
          {p === "week" ? "Week" : "Month"}
        </button>
      ))}
    </div>
  );

  const d = data?.stats.spend.deltaPct;
  const up = d != null && d > 0;

  return (
    <section className="mb-5 rounded-xl p-4" style={panel}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">
          {period === "week" ? "Weekly summary" : "Monthly review"}
          {period === "week" && data ? <span className="text-xs font-normal" style={{ color: "var(--muted)" }}> · {data.weekStart} → {data.weekEnd}</span> : null}
        </h2>
        {seg}
      </div>

      {period === "week" ? (
        !data ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              A plain-English digest of your week, written locally by {process.env.NEXT_PUBLIC_LLM ?? "your model"} on your network.
            </p>
            <button onClick={onGenerate} disabled={busy} className="rounded px-2.5 py-1 text-xs font-medium"
              style={{ background: "var(--accent-deep)", color: "white", opacity: busy ? 0.6 : 1 }}>
              {busy ? "Generating…" : "Generate"}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                {money(data.stats.spend.thisWeek)} spent
                {d != null ? <span style={{ color: up ? "var(--bad)" : "var(--good)" }}> {up ? "▲" : "▼"}{Math.abs(d)}%</span> : null}
              </span>
              <button onClick={onGenerate} disabled={busy} className="rounded px-2.5 py-1 text-xs font-medium"
                style={{ background: "var(--accent-deep)", color: "white", opacity: busy ? 0.6 : 1 }}>
                {busy ? "Generating…" : "Refresh"}
              </button>
            </div>
            <div className="text-sm" style={{ color: "var(--text)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{data.narrative}</div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>Written by {data.model ?? "the model"} · stays on your network</div>
          </div>
        )
      ) : (
        <MonthlyView data={monthly} busy={monthBusy} onGenerate={genMonthly} />
      )}
    </section>
  );
}
