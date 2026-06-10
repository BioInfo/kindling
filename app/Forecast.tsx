"use client";

import {
  Area, AreaChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { money, panel, useChartTheme } from "./ui";

export type ForecastEvent = {
  date: string; merchant: string; direction: "income" | "expense"; amount: number; cadence: string;
};
export type Discretionary = {
  dailyBurn: number; monthlyBurn: number; months: number; complete: boolean;
};
export type ForecastData = {
  startBalance: number; startDate: string; horizonDays: number;
  series: { date: string; balance: number }[];
  events: ForecastEvent[];
  endBalance: number;
  low: { date: string; balance: number };
  totalIn: number; totalOut: number; net: number; monthlyIn: number; monthlyOut: number;
  discretionary: Discretionary | null; discretionaryOut: number; included: boolean;
};

function ForecastTooltip({ active, payload }: {
  active?: boolean; payload?: { payload: { date: string; balance: number } }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg px-2.5 py-1.5 text-xs" style={{ background: "var(--panel)", border: "1px solid var(--border)", color: "var(--text)" }}>
      <div className="font-medium">{money(p.balance)}</div>
      <div style={{ color: "var(--muted)" }}>{p.date}</div>
    </div>
  );
}

// Projected-balance area: gradient fill + line, a dashed reference at today's
// starting cash, and a marked low point. Green when the horizon ends up vs
// today, red when it ends down.
function ForecastChart({ data }: { data: ForecastData }) {
  const C = useChartTheme(); // concrete hexes — Recharts can't read CSS vars in SVG attrs
  if (data.series.length < 2) return null;
  const up = data.endBalance >= data.startBalance;
  const stroke = up ? C.good : C.bad;
  const lastDate = data.series[data.series.length - 1].date;

  return (
    <div style={{ height: 180 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data.series} margin={{ top: 18, right: 10, bottom: 0, left: 10 }}>
          <defs>
            <linearGradient id="forecastFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" ticks={[data.series[0].date, lastDate]} tick={{ fill: C.muted, fontSize: 11 }}
            tickLine={false} axisLine={false} />
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Tooltip content={<ForecastTooltip />} />
          <ReferenceLine y={data.startBalance} stroke={C.accent} strokeDasharray="3 4" strokeOpacity={0.6}
            label={{ value: `today ${money(data.startBalance)}`, position: "insideTopRight", fill: C.accent, fontSize: 11 }} />
          <Area type="monotone" dataKey="balance" stroke={stroke} strokeWidth={2} fill="url(#forecastFill)"
            dot={false} isAnimationActive={false} />
          <ReferenceDot x={data.low.date} y={data.low.balance} r={3.5} fill={C.warn} stroke="none"
            label={{ value: `low ${money(data.low.balance)}`, position: "top", fill: C.warn, fontSize: 11 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ForecastPanel({
  data, days, onDays, disc, onDisc, onPick,
}: {
  data: ForecastData | null; days: number; onDays: (d: number) => void;
  disc: boolean; onDisc: (v: boolean) => void; onPick?: (merchant: string) => void;
}) {
  if (!data) return null;
  const noFlow = data.events.length === 0;
  const delta = data.endBalance - data.startBalance;
  const upcoming = data.events.slice(0, 6);
  const burn = data.discretionary;
  // The toggle reflects intent; `included` reflects whether burn data existed.
  const showingBurn = data.included;

  const dayBtn = (d: number) => (
    <button key={d} onClick={() => onDays(d)}
      className="rounded px-2 py-0.5 text-xs"
      style={{ background: days === d ? "var(--accent-deep)" : "var(--bg)", color: days === d ? "white" : "var(--muted)", border: "1px solid var(--border)" }}>
      {d}d
    </button>
  );
  const discBtn = (on: boolean, label: string) => (
    <button key={label} onClick={() => onDisc(on)}
      className="rounded px-2 py-0.5 text-xs"
      style={{ background: disc === on ? "var(--accent-deep)" : "var(--bg)", color: disc === on ? "white" : "var(--muted)", border: "1px solid var(--border)" }}>
      {label}
    </button>
  );

  return (
    <section className="mb-5 rounded-xl p-4" style={panel}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Cash flow forecast · next {days} days</h2>
        <div className="flex flex-wrap gap-2">
          {burn && (
            <div className="flex gap-1">{discBtn(false, "Scheduled")}{discBtn(true, "+ Spending")}</div>
          )}
          <div className="flex gap-1">{[30, 60, 90].map(dayBtn)}</div>
        </div>
      </div>

      {noFlow ? (
        <div className="py-6 text-center text-sm" style={{ color: "var(--muted)" }}>
          No recurring income or bills detected yet — needs a few months of history to schedule a forecast.
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span style={{ color: "var(--muted)" }}>
              Projected end <span className="font-semibold" style={{ color: "var(--text)" }}>{money(data.endBalance)}</span>
              <span style={{ color: delta >= 0 ? "var(--good)" : "var(--bad)" }}> {delta >= 0 ? "▲" : "▼"} {money(Math.abs(delta))}</span>
            </span>
            <span style={{ color: "var(--muted)" }}>Scheduled in <span style={{ color: "var(--good)" }}>{money(data.totalIn)}</span></span>
            <span style={{ color: "var(--muted)" }}>Scheduled out <span style={{ color: "var(--bad)" }}>{money(data.totalOut)}</span></span>
            {showingBurn && (
              <span style={{ color: "var(--muted)" }}>Est. spending <span style={{ color: "var(--bad)" }}>{money(data.discretionaryOut)}</span></span>
            )}
            <span style={{ color: "var(--muted)" }}>Low <span style={{ color: "var(--warn)" }}>{money(data.low.balance)}</span> on {data.low.date}</span>
          </div>

          <ForecastChart data={data} />

          <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            {showingBurn && burn ? (
              <>Scheduled paychecks + bills, plus an estimated <span style={{ color: "var(--text)" }}>{money(burn.monthlyBurn)}/mo</span> of everyday spending
              {burn.complete ? ` (median of ${burn.months} month${burn.months === 1 ? "" : "s"})` : ` (~${burn.months} mo so far)`}.
              Transfers, taxes, and scheduled bills are excluded so they aren&apos;t double-counted.</>
            ) : (
              <>Scheduled paychecks + recurring bills only. Discretionary spending isn&apos;t modeled, so the real balance trends lower.</>
            )}
          </p>

          {upcoming.length > 0 && (
            <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--border)" }}>
              <div className="mb-1.5 text-xs font-medium" style={{ color: "var(--muted)" }}>Upcoming scheduled</div>
              <div className="flex flex-col gap-1">
                {upcoming.map((e, i) => (
                  <button key={`${e.merchant}-${e.date}-${i}`} type="button"
                    onClick={onPick ? () => onPick(e.merchant) : undefined}
                    className="flex items-center gap-2 text-left text-sm"
                    style={{ cursor: onPick ? "pointer" : "default" }}
                    title={onPick ? `See ${e.merchant} transactions` : undefined}>
                    <span className="w-20 text-xs" style={{ color: "var(--muted)" }}>{e.date}</span>
                    <span className="flex-1">{e.merchant}</span>
                    <span style={{ color: e.amount >= 0 ? "var(--good)" : "var(--text)" }}>
                      {e.amount >= 0 ? "+" : "−"}{money(Math.abs(e.amount))}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
