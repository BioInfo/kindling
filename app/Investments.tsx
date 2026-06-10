"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import { money, panel, prettyAccount, useTableView, TableToolbar, Pager, useChartTheme } from "./ui";

// Tidy a holding name/ticker: "VANGUARD.TARGET.2050" → "Vanguard Target 2050".
function prettyHolding(ticker: string | null, name: string | null): string {
  if (ticker && !ticker.includes(".") && ticker.length <= 6) return ticker; // real symbol
  const src = name || ticker || "—";
  return src.replace(/[._]+/g, " ").replace(/\s{2,}/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bUsd\b/g, "USD").replace(/\bEtf\b/g, "ETF").trim();
}

type HoldingRow = {
  account_id: string; account: string; mask: string | null;
  security_id: string; ticker: string | null; name: string | null; type: string | null;
  quantity: number | null; price: number | null; value: number; cost_basis: number | null;
  gain: number | null; pct: number; source: string;
};
type AllocSlice = { key: string; value: number; pct: number };
type ManualAccount = { account_id: string; name: string | null; mask: string | null; institution: string | null };
export type InvestmentsData = {
  holdings: HoldingRow[];
  total: number;
  byType: AllocSlice[];
  byAccount: AllocSlice[];
  consentNeeded: { item_id: string; institution: string | null; accounts: string[] }[];
  manualAccounts: ManualAccount[];
};

const fieldStyle = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" };
const TYPES = ["equity", "etf", "mutual fund", "fixed income", "cash", "cryptocurrency", "derivative", "other"];

async function delManual(account_id: string, security_id: string) {
  await fetch(`/api/investments/manual?account_id=${encodeURIComponent(account_id)}&security_id=${encodeURIComponent(security_id)}`, { method: "DELETE" });
}

// Hand-enter a holding for accounts Plaid can't fetch (e.g. Ally Invest).
function AddHolding({ accounts, reload }: { accounts: ManualAccount[]; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [acct, setAcct] = useState(accounts[0]?.account_id ?? "");
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("equity");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [value, setValue] = useState("");
  const [cost, setCost] = useState("");
  if (accounts.length === 0) return null;

  const add = async () => {
    if (!acct || (!ticker.trim() && !name.trim())) return;
    await fetch("/api/investments/manual", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: acct, ticker: ticker.trim() || null, name: name.trim() || null, type,
        quantity: qty, price, value, cost_basis: cost }),
    });
    setTicker(""); setName(""); setQty(""); setPrice(""); setValue(""); setCost("");
    reload();
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="self-start rounded-lg px-3 py-1.5 text-sm font-medium" style={panel}>
        + Add holding manually
      </button>
    );
  }
  return (
    <div className="rounded-xl p-4" style={panel}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">Add a holding by hand</span>
        <button onClick={() => setOpen(false)} className="text-xs" style={{ color: "var(--muted)" }}>close</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={acct} onChange={(e) => setAcct(e.target.value)} className="rounded px-2 py-1 text-sm" style={fieldStyle}>
          {accounts.map((a) => <option key={a.account_id} value={a.account_id}>{a.name ?? a.account_id}{a.mask ? ` ••${a.mask}` : ""}</option>)}
        </select>
        <input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="ticker" className="w-24 rounded px-2 py-1 text-sm" style={fieldStyle} />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" className="flex-1 min-w-40 rounded px-2 py-1 text-sm" style={fieldStyle} />
        <select value={type} onChange={(e) => setType(e.target.value)} className="rounded px-2 py-1 text-sm" style={fieldStyle}>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" inputMode="decimal" className="w-20 rounded px-2 py-1 text-sm" style={fieldStyle} />
        <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="price" inputMode="decimal" className="w-24 rounded px-2 py-1 text-sm" style={fieldStyle} />
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="mkt value" inputMode="decimal" className="w-28 rounded px-2 py-1 text-sm" style={fieldStyle} />
        <input value={cost} onChange={(e) => setCost(e.target.value)} placeholder="cost basis" inputMode="decimal" className="w-28 rounded px-2 py-1 text-sm" style={fieldStyle} />
        <button onClick={add} className="rounded px-3 py-1 text-sm font-medium" style={{ background: "var(--accent-deep)", color: "white" }}>Add</button>
      </div>
    </div>
  );
}

// Chart series colors come from the active theme (CHART.series in ui.tsx).

// Shared dark tooltip for every chart on the page.
function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: AllocSlice }[] }) {
  if (!active || !payload?.length) return null;
  const s = payload[0].payload;
  return (
    <div className="rounded-lg px-2.5 py-1.5 text-xs" style={{ background: "var(--panel)", border: "1px solid var(--border)", color: "var(--text)" }}>
      <div className="font-medium">{s.key}</div>
      <div style={{ color: "var(--muted)" }}>{money(s.value)} · {Math.round(s.pct * 100)}%</div>
    </div>
  );
}

// Donut (recharts Pie with an inner radius) + a legend column beside it.
function AllocDonut({ slices, total }: { slices: AllocSlice[]; total?: number }) {
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
        {total != null && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[10px]" style={{ color: "var(--muted)" }}>total</span>
            <span className="text-xs font-semibold tabular-nums" style={{ color: "var(--text)" }}>{money(total >= 1e6 ? Math.round(total / 1e4) / 100 : total)}{total >= 1e6 ? "M" : ""}</span>
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
        {slices.map((s, i) => (
          <span key={s.key} className="flex items-center gap-1.5" style={{ color: "var(--muted)" }}>
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
            <span className="capitalize" style={{ color: "var(--text)" }}>{s.key}</span>
            <span className="ml-auto whitespace-nowrap tabular-nums">{money(s.value)} · {Math.round(s.pct * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// Sorted horizontal bar chart (accounts, top holdings). Height scales with rows.
function AllocBars({ rows }: { rows: AllocSlice[] }) {
  const C = useChartTheme();
  const COLORS = C.series;
  const short = (k: string) => (k.length > 28 ? k.slice(0, 27) + "…" : k);
  const data = rows.map((r) => ({ ...r, label: short(r.key) }));
  return (
    <div style={{ width: "100%", height: Math.max(120, data.length * 34) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} barCategoryGap={6}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" width={150} tick={{ fill: C.muted, fontSize: 11 }} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: C.border, opacity: 0.3 }} />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={18}>
            {data.map((s, i) => <Cell key={s.key} fill={COLORS[i % COLORS.length]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Opens Plaid Link in update mode for one item to grant investments consent.
// Reuses the existing access_token/accounts — no new item, no duplicates. On
// success it kicks a holdings sync, then reloads.
function EnableInvestments({ itemId, label, accounts, onDone }:
  { itemId: string; label: string | null; accounts: string[]; onDone: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // loading → fetching the update token; ready → can consent; unsupported → the
  // institution has no Plaid investments product (e.g. Ally Bank); error → other.
  const [state, setState] = useState<"loading" | "ready" | "unsupported" | "error">("loading");
  const [reason, setReason] = useState<string | null>(null);

  const fetchToken = useCallback(async () => {
    const r = await fetch("/api/link/update", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: itemId }),
    }).then((x) => x.json()).catch(() => ({ error: "request failed" }));
    if (r.link_token) { setToken(r.link_token); setState("ready"); }
    else if (r.unsupported) { setReason(r.message ?? null); setState("unsupported"); }
    else { setReason(r.error ?? null); setState("error"); }
  }, [itemId]);

  useEffect(() => { fetchToken(); }, [fetchToken]);

  const onSuccess = useCallback(async () => {
    setBusy(true);
    await fetch("/api/investments", { method: "POST" }); // pull holdings now that consent is granted
    setBusy(false);
    onDone();
  }, [onDone]);

  const { open, ready } = usePlaidLink({ token: token ?? "", onSuccess });
  const acctLine = `${accounts.length} account${accounts.length === 1 ? "" : "s"}`;

  // Institution doesn't offer Plaid investments — an honest note, not a button.
  if (state === "unsupported") {
    return (
      <div className="rounded-xl p-4" style={panel}>
        <div className="font-medium">{label ?? "Investment account"}</div>
        <div className="text-xs" style={{ color: "var(--muted)" }}>
          {acctLine} · investment holdings aren&apos;t available from this institution via Plaid.
          Balances still count toward net worth.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl p-4" style={panel}>
      <div className="flex-1 min-w-48">
        <div className="font-medium">{label ?? "Investment account"}</div>
        <div className="text-xs" style={{ color: "var(--muted)" }}>
          {acctLine} · {state === "error" ? (reason ?? "couldn’t start the consent flow — try Sync") : "needs investments access to show holdings"}
        </div>
      </div>
      <button onClick={() => open()} disabled={state !== "ready" || !ready || busy}
        className="rounded-lg px-3 py-1.5 text-sm font-medium"
        style={{ background: "var(--accent-deep)", color: "white", opacity: state === "ready" && ready && !busy ? 1 : 0.5 }}>
        {busy ? "Loading holdings…" : state === "loading" ? "Checking…" : "Enable investments"}
      </button>
    </div>
  );
}

export function InvestmentsPanel({ data, reload }: { data: InvestmentsData | null; reload: () => void }) {
  const [pricing, setPricing] = useState(false);
  const [priceMsg, setPriceMsg] = useState<string | null>(null);
  const hv = useTableView(data?.holdings ?? [], {
    searchOf: (h) => `${h.ticker ?? ""} ${h.name ?? ""} ${h.account ?? ""} ${h.type ?? ""}`,
    sorts: [
      { key: "value", label: "Value", val: (h) => h.value },
      { key: "gain", label: "Gain", val: (h) => h.gain ?? 0 },
      { key: "qty", label: "Quantity", val: (h) => h.quantity ?? 0 },
      { key: "pct", label: "% of portfolio", val: (h) => h.pct },
      { key: "name", label: "Name", val: (h) => `${h.ticker ?? ""}${h.name ?? ""}` },
    ],
    initialSort: "value", pageSize: 10,
  });
  if (!data) return <section className="rounded-xl p-6 text-center" style={{ color: "var(--muted)", ...panel }}>Loading…</section>;
  const { holdings, total, byType, byAccount, consentNeeded, manualAccounts } = data;
  const hasManual = holdings.some((h) => h.source === "manual");
  const totalGain = holdings.reduce((s, h) => s + (h.gain ?? 0), 0);
  const hasGain = holdings.some((h) => h.gain != null);
  const accountsNonZero = byAccount.filter((a) => a.value > 0).slice(0, 8).map((a) => ({ ...a, key: prettyAccount(a.key) }));
  const topHoldings = [...holdings].sort((a, b) => b.value - a.value).slice(0, 8)
    .map((h) => ({ key: prettyHolding(h.ticker, h.name), value: h.value, pct: h.pct }));
  // Biggest unrealized movers (gainers + losers), for the panel that fills the
  // old dead space. Only holdings with a known cost basis have a gain.
  const movers = holdings.filter((h) => h.gain != null).sort((a, b) => (b.gain ?? 0) - (a.gain ?? 0));
  const topMovers = [...movers.slice(0, 4), ...movers.slice(-3).filter((m) => (m.gain ?? 0) < 0)]
    .filter((m, i, arr) => arr.findIndex((x) => x.security_id === m.security_id) === i)
    .map((h) => ({ key: prettyHolding(h.ticker, h.name), gain: h.gain as number }));

  const refreshPrices = async () => {
    setPricing(true); setPriceMsg(null);
    const r = await fetch("/api/investments/quotes", { method: "POST" }).then((x) => x.json()).catch(() => null);
    setPricing(false);
    if (r?.quotes) {
      const u = r.quotes.updated.length, m = r.quotes.missed.length;
      setPriceMsg(`Updated ${u} price${u === 1 ? "" : "s"}${m ? `, ${m} not found (${r.quotes.missed.join(", ")})` : ""}`);
    }
    reload();
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl p-3" style={panel}>
        <h2 className="font-semibold">Investments</h2>
        <div className="flex items-center gap-3">
          {priceMsg && <span className="text-xs" style={{ color: "var(--muted)" }}>{priceMsg}</span>}
          <span className="text-sm" style={{ color: "var(--muted)" }}>
            {money(total)} across {holdings.length} holding{holdings.length === 1 ? "" : "s"}
          </span>
          {hasManual && (
            <button onClick={refreshPrices} disabled={pricing}
              className="rounded-lg px-3 py-1 text-sm font-medium" style={panel}
              title="Fetch live prices for hand-entered holdings. Tickers leave your network; nothing else.">
              {pricing ? "Pricing…" : "Refresh prices"}
            </button>
          )}
        </div>
      </div>

      {consentNeeded.map((c) => (
        <EnableInvestments key={c.item_id} itemId={c.item_id} label={c.institution} accounts={c.accounts} onDone={reload} />
      ))}

      {holdings.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Total value", value: money(total), color: "var(--text)" },
              { label: "Holdings", value: String(holdings.length), color: "var(--text)" },
              { label: "Accounts", value: String(accountsNonZero.length), color: "var(--text)" },
              { label: "Unrealized gain", value: hasGain ? `${totalGain >= 0 ? "+" : ""}${money(totalGain)}` : "—",
                color: hasGain ? (totalGain >= 0 ? "var(--good)" : "var(--bad)") : "var(--muted)" },
            ].map((s) => (
              <div key={s.label} className="rounded-xl p-3" style={panel}>
                <div className="text-xs" style={{ color: "var(--muted)" }}>{s.label}</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums" style={{ color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>
          <div className="grid items-stretch gap-3 md:grid-cols-2">
            <div className="rounded-xl p-4" style={panel}>
              <div className="mb-2 text-sm font-medium">By asset type</div>
              <AllocDonut slices={byType} total={total} />
            </div>
            <div className="rounded-xl p-4" style={panel}>
              <div className="mb-2 text-sm font-medium">By account</div>
              <AllocBars rows={accountsNonZero} />
            </div>
          </div>
          <div className="grid items-stretch gap-3 md:grid-cols-2">
            <div className="rounded-xl p-4" style={panel}>
              <div className="mb-2 text-sm font-medium">Top holdings</div>
              <AllocBars rows={topHoldings} />
            </div>
            <div className="rounded-xl p-4" style={panel}>
              <div className="mb-2 text-sm font-medium">Biggest movers <span style={{ color: "var(--muted)" }}>· unrealized</span></div>
              {topMovers.length === 0 ? (
                <div className="text-xs" style={{ color: "var(--muted)" }}>No cost basis on file yet — gains show once a brokerage reports it.</div>
              ) : (
                <div className="flex flex-col">
                  {topMovers.map((m) => (
                    <div key={m.key} className="flex items-center justify-between gap-2 py-1.5 text-sm" style={{ borderTop: "1px solid var(--border)" }}>
                      <span className="truncate">{m.key}</span>
                      <span className="shrink-0 tabular-nums font-medium" style={{ color: m.gain >= 0 ? "var(--good)" : "var(--bad)" }}>
                        {m.gain >= 0 ? "+" : ""}{money(m.gain)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {holdings.length === 0 && consentNeeded.length === 0 && (
        <div className="rounded-xl p-6 text-center text-sm" style={{ color: "var(--muted)", ...panel }}>
          No holdings yet. Connect a brokerage, hit Sync to pull positions, or add one by hand below.
        </div>
      )}

      <AddHolding accounts={manualAccounts} reload={reload} />

      {holdings.length > 0 && (
        <>
          <TableToolbar {...hv.toolbar} placeholder="Search ticker, name, account…" />
        <div className="rounded-xl overflow-hidden" style={panel}>
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 p-3 text-xs font-medium"
            style={{ color: "var(--muted)", borderBottom: "1px solid var(--border)" }}>
            <span>Holding{hv.total !== holdings.length ? ` (${hv.total}/${holdings.length})` : ""}</span><span className="text-right">Qty</span>
            <span className="text-right">Value</span><span className="text-right w-12">%</span>
          </div>
          {hv.pageRows.map((h) => (
            <div key={`${h.account_id}-${h.security_id}`}
              className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 p-3 text-sm"
              style={{ borderTop: "1px solid var(--border)" }}>
              <div className="min-w-0">
                <div className="truncate">
                  {h.ticker ? <span className="font-medium">{h.ticker}</span> : null}
                  {h.ticker && h.name ? " · " : null}
                  <span style={{ color: h.ticker ? "var(--muted)" : "var(--text)" }}>{h.name ?? "—"}</span>
                </div>
                <div className="text-xs" style={{ color: "var(--muted)" }}>
                  {h.type ?? "other"} · {h.account}{h.mask ? ` ••${h.mask}` : ""}
                  {h.gain != null ? (
                    <span style={{ color: h.gain >= 0 ? "var(--good)" : "var(--bad)" }}> · {h.gain >= 0 ? "+" : ""}{money(h.gain)}</span>
                  ) : null}
                  {h.source === "manual" ? (
                    <>
                      <span className="ml-1 rounded px-1 py-0.5" style={{ background: "var(--bg)", color: "var(--muted)" }}>manual</span>
                      <button onClick={() => delManual(h.account_id, h.security_id).then(reload)} title="delete holding"
                        className="ml-1" style={{ color: "var(--bad)" }}>✕</button>
                    </>
                  ) : null}
                </div>
              </div>
              <span className="text-right tabular-nums" style={{ color: "var(--muted)" }}>
                {h.quantity != null ? h.quantity.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}
              </span>
              <span className="text-right tabular-nums">{money(h.value)}</span>
              <span className="text-right tabular-nums w-12" style={{ color: "var(--muted)" }}>{Math.round(h.pct * 100)}%</span>
            </div>
          ))}
          <Pager {...hv.pager} />
        </div>
        </>
      )}
    </section>
  );
}
