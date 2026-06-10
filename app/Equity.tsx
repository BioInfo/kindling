"use client";

import { useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { money, panel, useChartTheme } from "./ui";

type SchedulePoint = { date: string; shares: number; value: number };
type Grant = {
  id: number; employer: string | null; ticker: string | null; kind: string;
  grant_date: string; shares: number; strike: number | null;
  cliff_months: number; vest_months: number; vest_freq: string;
  last_price: number | null; price_as_of: string | null; note: string | null;
  vestedShares: number; unvestedShares: number; perShare: number;
  vestedValue: number; unvestedValue: number; totalValue: number;
  nextVestDate: string | null; nextVestShares: number; fullyVested: boolean;
  schedule: SchedulePoint[];
};
export type EquityData = {
  grants: Grant[]; vestedValue: number; unvestedValue: number; totalValue: number;
  priced: boolean; nextVest: { date: string; shares: number; value: number; ticker: string | null } | null;
};

const fieldStyle = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" };
const KINDS = [["rsu", "RSU"], ["option", "Option"], ["espp", "ESPP"]] as const;
const FREQS = [["monthly", "Monthly"], ["quarterly", "Quarterly"], ["annual", "Annual"]] as const;
const num = (v: string) => Number(v.replace(/[$,\s]/g, ""));
const fmtDate = (d: string) => { const [y, m] = d.split("-"); return `${m}/${y.slice(2)}`; };
const shares = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

// Portfolio vesting curve: at each schedule date, sum every grant's cumulative
// vested value as of that date. A monotone step the area chart can draw.
function portfolioCurve(grants: Grant[]): { date: string; value: number }[] {
  const dates = Array.from(new Set(grants.flatMap((g) => g.schedule.map((p) => p.date)))).sort();
  return dates.map((d) => {
    let value = 0;
    for (const g of grants) {
      let v = 0;
      for (const p of g.schedule) { if (p.date <= d) v = p.value; else break; }
      value += v;
    }
    return { date: d, value: Math.round(value) };
  });
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length || !label) return null;
  return (
    <div className="rounded-lg px-2.5 py-1.5 text-xs" style={{ background: "var(--panel)", border: "1px solid var(--border)", color: "var(--text)" }}>
      <div className="font-medium">{fmtDate(label)}</div>
      <div style={{ color: "var(--muted)" }}>{money(payload[0].value)} vested</div>
    </div>
  );
}

function VestingChart({ grants }: { grants: Grant[] }) {
  const C = useChartTheme();
  const data = portfolioCurve(grants);
  if (data.length < 2) return null;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div style={{ width: "100%", height: 180 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.accent} stopOpacity={0.35} />
              <stop offset="100%" stopColor={C.accent} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: C.muted, fontSize: 10 }}
            tickLine={false} axisLine={false} minTickGap={28} />
          <YAxis tickFormatter={(v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${v}`)}
            tick={{ fill: C.muted, fontSize: 10 }} tickLine={false} axisLine={false} width={44} />
          <Tooltip content={<ChartTooltip />} />
          <ReferenceLine x={data.reduce((best, p) => (p.date <= today && p.date > best ? p.date : best), data[0].date)}
            stroke={C.muted} strokeDasharray="3 3" />
          <Area type="stepAfter" dataKey="value" stroke={C.accent} strokeWidth={2} fill="url(#eqfill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

async function patch(body: Record<string, unknown>) {
  await fetch("/api/equity", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function del(id: number) { await fetch(`/api/equity?id=${id}`, { method: "DELETE" }); }

function GrantCard({ g, reload }: { g: Grant; reload: () => void }) {
  const [editing, setEditing] = useState(false);
  const [shareStr, setShareStr] = useState(String(g.shares));
  const pct = g.shares > 0 ? Math.round((g.vestedShares / g.shares) * 100) : 0;
  const label = [g.employer, g.ticker].filter(Boolean).join(" · ") || "Grant";
  const kindLabel = g.kind === "option" ? "Option" : g.kind === "espp" ? "ESPP" : "RSU";
  const commitShares = () => {
    const n = num(shareStr);
    if (Number.isFinite(n) && n > 0 && n !== g.shares) patch({ id: g.id, shares: n }).then(reload);
  };
  return (
    <div className="rounded-xl p-4" style={panel}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">{label} <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: "var(--bg)", color: "var(--muted)" }}>{kindLabel}</span></div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>
            {shares(g.shares)} units · granted {g.grant_date}
            {g.kind === "option" && g.strike != null ? ` · strike ${money(g.strike)}` : ""}
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums">{g.last_price != null ? money(g.vestedValue) : "—"}</div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>vested value</div>
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1 flex justify-between text-xs" style={{ color: "var(--muted)" }}>
          <span>{pct}% vested · {shares(g.vestedShares)} of {shares(g.shares)}</span>
          {g.fullyVested ? <span style={{ color: "var(--good)" }}>fully vested</span>
            : g.nextVestDate ? <span>next {g.nextVestDate} · +{shares(g.nextVestShares)}</span> : null}
        </div>
        <div className="h-2 rounded-full" style={{ background: "var(--bg)" }}>
          <div className="h-2 rounded-full" style={{ width: `${pct}%`, background: "var(--accent-deep)" }} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: "var(--muted)" }}>
        <span>Unvested <span style={{ color: "var(--text)" }}>{g.last_price != null ? money(g.unvestedValue) : `${shares(g.unvestedShares)} units`}</span></span>
        {g.last_price != null && <span>Price <span style={{ color: "var(--text)" }}>{money(g.last_price)}</span>{g.price_as_of ? ` · ${g.price_as_of}` : ""}</span>}
        <span>{g.vest_freq} over {g.vest_months}mo{g.cliff_months ? `, ${g.cliff_months}mo cliff` : ""}</span>
      </div>
      {g.note && <div className="mt-1.5 text-xs" style={{ color: "var(--muted)" }}>{g.note}</div>}

      <div className="mt-3 flex items-center gap-2">
        <button onClick={() => setEditing((v) => !v)} className="rounded px-2 py-1 text-xs" style={{ background: "var(--bg)", color: "var(--muted)", border: "1px solid var(--border)" }}>
          {editing ? "close" : "edit shares"}
        </button>
        <button onClick={() => del(g.id).then(reload)} className="rounded px-2 py-1 text-xs" style={{ background: "var(--bg)", color: "var(--bad)", border: "1px solid var(--border)" }}>
          delete
        </button>
        {editing && (
          <span className="flex items-center gap-1">
            <input value={shareStr} onChange={(e) => setShareStr(e.target.value)} onBlur={commitShares}
              inputMode="decimal" className="w-24 rounded px-2 py-1 text-xs" style={fieldStyle} />
            <button onClick={commitShares} className="rounded px-2 py-1 text-xs font-medium" style={{ background: "var(--accent-deep)", color: "white" }}>save</button>
          </span>
        )}
      </div>
    </div>
  );
}

function AddGrant({ reload }: { reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [employer, setEmployer] = useState("");
  const [ticker, setTicker] = useState("");
  const [kind, setKind] = useState("rsu");
  const [grantDate, setGrantDate] = useState("");
  const [sharesStr, setSharesStr] = useState("");
  const [strike, setStrike] = useState("");
  const [cliff, setCliff] = useState("12");
  const [vest, setVest] = useState("48");
  const [freq, setFreq] = useState("monthly");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    setErr(null);
    if (!grantDate || !/^\d{4}-\d{2}-\d{2}$/.test(grantDate)) { setErr("grant date YYYY-MM-DD"); return; }
    if (!Number.isFinite(num(sharesStr)) || num(sharesStr) <= 0) { setErr("shares must be positive"); return; }
    setBusy(true);
    const r = await fetch("/api/equity", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employer, ticker, kind, grant_date: grantDate, shares: sharesStr,
        strike: kind === "option" ? strike : null, cliff_months: cliff, vest_months: vest, vest_freq: freq, note }),
    }).then((x) => x.json()).catch(() => ({ error: "request failed" }));
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setEmployer(""); setTicker(""); setGrantDate(""); setSharesStr(""); setStrike(""); setNote("");
    setOpen(false); reload();
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="self-start rounded-lg px-3 py-1.5 text-sm font-medium" style={panel}>
        + Add a grant
      </button>
    );
  }
  return (
    <div className="rounded-xl p-4" style={panel}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">Add an equity grant</span>
        <button onClick={() => setOpen(false)} className="text-xs" style={{ color: "var(--muted)" }}>close</button>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <input value={employer} onChange={(e) => setEmployer(e.target.value)} placeholder="employer" className="min-w-32 flex-1 rounded px-2 py-1 text-sm" style={fieldStyle} />
          <input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="ticker" className="w-28 rounded px-2 py-1 text-sm" style={fieldStyle} />
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded px-2 py-1 text-sm" style={fieldStyle}>
            {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex flex-col text-xs" style={{ color: "var(--muted)" }}>grant date
            <input type="date" value={grantDate} onChange={(e) => setGrantDate(e.target.value)} className="rounded px-2 py-1 text-sm" style={fieldStyle} /></label>
          <label className="flex flex-col text-xs" style={{ color: "var(--muted)" }}>shares
            <input value={sharesStr} onChange={(e) => setSharesStr(e.target.value)} placeholder="1,000" inputMode="decimal" className="w-28 rounded px-2 py-1 text-sm" style={fieldStyle} /></label>
          {kind === "option" && (
            <label className="flex flex-col text-xs" style={{ color: "var(--muted)" }}>strike
              <input value={strike} onChange={(e) => setStrike(e.target.value)} placeholder="$12.50" inputMode="decimal" className="w-24 rounded px-2 py-1 text-sm" style={fieldStyle} /></label>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex flex-col text-xs" style={{ color: "var(--muted)" }}>cliff (mo)
            <input value={cliff} onChange={(e) => setCliff(e.target.value)} inputMode="numeric" className="w-20 rounded px-2 py-1 text-sm" style={fieldStyle} /></label>
          <label className="flex flex-col text-xs" style={{ color: "var(--muted)" }}>vest (mo)
            <input value={vest} onChange={(e) => setVest(e.target.value)} inputMode="numeric" className="w-20 rounded px-2 py-1 text-sm" style={fieldStyle} /></label>
          <label className="flex flex-col text-xs" style={{ color: "var(--muted)" }}>frequency
            <select value={freq} onChange={(e) => setFreq(e.target.value)} className="rounded px-2 py-1 text-sm" style={fieldStyle}>
              {FREQS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" className="rounded px-2 py-1 text-sm" style={fieldStyle} />
        {err && <span className="text-xs" style={{ color: "var(--bad)" }}>{err}</span>}
        <button onClick={add} disabled={busy} className="self-start rounded px-3 py-1.5 text-sm font-medium" style={{ background: "var(--accent-deep)", color: "white", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Adding…" : "Add grant"}
        </button>
      </div>
    </div>
  );
}

export function EquityPanel({ data, reload }: { data: EquityData | null; reload: () => void }) {
  const [pricing, setPricing] = useState(false);
  const [priceMsg, setPriceMsg] = useState<string | null>(null);
  if (!data) return <section className="rounded-xl p-6 text-center" style={{ color: "var(--muted)", ...panel }}>Loading…</section>;
  const { grants, vestedValue, unvestedValue, totalValue, priced, nextVest } = data;

  const refreshPrices = async () => {
    setPricing(true); setPriceMsg(null);
    const r = await fetch("/api/equity/quotes", { method: "POST" }).then((x) => x.json()).catch(() => null);
    setPricing(false);
    if (r?.quotes) {
      const u = r.quotes.updated.length, m = r.quotes.missed.length;
      setPriceMsg(`Updated ${u} price${u === 1 ? "" : "s"}${m ? `, ${m} not found (${r.quotes.missed.join(", ")})` : ""}`);
    }
    reload();
  };

  const stats = [
    { label: "Total grant value", value: priced ? money(totalValue) : "—", color: "var(--text)" },
    { label: "Vested · in net worth", value: priced ? money(vestedValue) : "—", color: "var(--good)" },
    { label: "Unvested · future", value: priced ? money(unvestedValue) : "—", color: "var(--muted)" },
    { label: "Next vest", value: nextVest ? (priced ? money(nextVest.value) : `${shares(nextVest.shares)}`) : "—", color: "var(--text)",
      sub: nextVest ? nextVest.date : undefined },
  ];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl p-3" style={panel}>
        <h2 className="font-semibold">Equity comp</h2>
        <div className="flex items-center gap-3">
          {priceMsg && <span className="text-xs" style={{ color: "var(--muted)" }}>{priceMsg}</span>}
          <span className="text-sm" style={{ color: "var(--muted)" }}>{grants.length} grant{grants.length === 1 ? "" : "s"}</span>
          {grants.some((g) => g.ticker) && (
            <button onClick={refreshPrices} disabled={pricing} className="rounded-lg px-3 py-1 text-sm font-medium" style={panel}
              title="Fetch live prices for grant tickers. Tickers leave your network; nothing else.">
              {pricing ? "Pricing…" : "Refresh prices"}
            </button>
          )}
        </div>
      </div>

      {grants.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="rounded-xl p-3" style={panel}>
              <div className="text-xs" style={{ color: "var(--muted)" }}>{s.label}</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums" style={{ color: s.color }}>{s.value}</div>
              {s.sub && <div className="text-xs" style={{ color: "var(--muted)" }}>{s.sub}</div>}
            </div>
          ))}
        </div>
      )}

      {grants.length > 0 && priced && (
        <div className="rounded-xl p-4" style={panel}>
          <div className="mb-1 text-sm font-medium">Vesting value over time <span style={{ color: "var(--muted)" }}>· at current price</span></div>
          <VestingChart grants={grants} />
        </div>
      )}

      {grants.length > 0 && !priced && (
        <div className="rounded-xl p-4 text-sm" style={{ color: "var(--muted)", ...panel }}>
          Add a ticker and hit <span style={{ color: "var(--text)" }}>Refresh prices</span> to value these grants and draw the vesting timeline.
        </div>
      )}

      {grants.map((g) => <GrantCard key={g.id} g={g} reload={reload} />)}

      {grants.length === 0 && (
        <div className="rounded-xl p-6 text-center text-sm" style={{ color: "var(--muted)", ...panel }}>
          No grants yet. Add an RSU, option, or ESPP grant — vested value rolls into net worth, unvested shows as a future projection.
        </div>
      )}

      <AddGrant reload={reload} />
    </section>
  );
}
