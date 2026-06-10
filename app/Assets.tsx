"use client";

import { useState } from "react";
import { money, panel } from "./ui";

type Asset = {
  id: number; name: string; kind: string; side: "asset" | "liability";
  value: number; note: string | null;
  address: string | null; vehicle: string | null;
  est_value: number | null; est_low: number | null; est_high: number | null;
  est_note: string | null; est_as_of: string | null;
  apr: number | null; payee_match: string | null; last_paydown_date: string | null;
};
export type AssetsData = { assets: Asset[]; totalAsset: number; totalLiability: number; net: number };

const fieldStyle = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" };
const KINDS = ["real_estate", "vehicle", "cash", "other"];
// Accept "$750,000" / "750,000" — strip currency formatting before parsing.
const parseMoney = (v: string) => Number(v.replace(/[$,\s]/g, ""));
const kindLabel = (k: string) => k.replace("_", " ");

async function patch(body: Record<string, unknown>) {
  await fetch("/api/assets", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function del(id: number) { await fetch(`/api/assets?id=${id}`, { method: "DELETE" }); }

function AssetRow({ a, reload }: { a: Asset; reload: () => void }) {
  const [value, setValue] = useState(String(a.value));
  const [vinput, setVinput] = useState(a.address ?? a.vehicle ?? "");
  const [busy, setBusy] = useState(false);
  const [est, setEst] = useState<{ estimate: number; low: number | null; high: number | null; note: string | null } | null>(null);
  const [estErr, setEstErr] = useState<string | null>(null);
  const [apr, setApr] = useState(a.apr != null ? String(a.apr) : "");
  const [payee, setPayee] = useState(a.payee_match ?? "");
  const [refi, setRefi] = useState<{ marketRate: number; currentApr: number; worthIt: boolean; monthlyInterestSaved: number; annualSaved: number; asOf: string | null } | null>(null);
  const [refiBusy, setRefiBusy] = useState(false);
  const [refiErr, setRefiErr] = useState<string | null>(null);
  const isMortgage = a.side === "liability" && (a.kind === "real_estate" || /mortgage/i.test(a.name));
  const checkRefi = async () => {
    setRefiBusy(true); setRefiErr(null); setRefi(null);
    const r = await fetch(`/api/assets/refi?id=${a.id}`).then((x) => x.json()).catch(() => ({ error: "request failed" }));
    setRefiBusy(false);
    if (r.error) setRefiErr(r.error); else setRefi(r);
  };
  const color = a.side === "liability" ? "var(--bad)" : "var(--text)";
  const valuable = a.kind === "real_estate" || a.kind === "vehicle";
  const inputField = a.kind === "vehicle" ? "vehicle" : "address";
  const placeholder = a.kind === "vehicle" ? "year make model (e.g. 2023 Subaru Outback)" : "address (e.g. 123 Main St, Reston VA)";

  const commit = () => {
    const n = parseMoney(value);
    if (Number.isFinite(n) && n >= 0 && n !== a.value) patch({ id: a.id, value: n }).then(reload);
  };
  const commitInput = () => {
    const cur = a.address ?? a.vehicle ?? "";
    if (vinput.trim() !== cur) patch({ id: a.id, [inputField]: vinput.trim() || null }).then(reload);
  };
  const estimate = async () => {
    setBusy(true); setEstErr(null); setEst(null);
    const r = await fetch("/api/assets/estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: a.id }) })
      .then((x) => x.json()).catch(() => ({ error: "request failed" }));
    setBusy(false);
    if (r.error) setEstErr(r.error); else setEst(r);
  };
  const useEstimate = (v: number) => patch({ id: a.id, value: v }).then(reload);
  const commitApr = () => { const cur = a.apr != null ? String(a.apr) : ""; if (apr.trim() !== cur) patch({ id: a.id, apr: apr.trim() || null }).then(reload); };
  const commitPayee = () => { if (payee.trim() !== (a.payee_match ?? "")) patch({ id: a.id, payee_match: payee.trim() || null }).then(reload); };
  const autoOn = a.side === "liability" && a.apr != null && !!a.payee_match;

  return (
    <div className="flex flex-col gap-2 p-3" style={{ borderTop: "1px solid var(--border)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 min-w-40">
          {a.name}
          <span className="ml-2 rounded px-1.5 py-0.5 text-xs" style={{ background: "var(--bg)", color: "var(--muted)" }}>{kindLabel(a.kind)}</span>
        </span>
        <span style={{ color: "var(--muted)" }}>{a.side === "liability" ? "−$" : "$"}</span>
        <input value={value} onChange={(e) => setValue(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          inputMode="decimal" className="w-32 rounded px-2 py-0.5 text-right" style={{ ...fieldStyle, color }} />
        <button onClick={() => del(a.id).then(reload)} title="delete"
          className="rounded px-1.5 py-0.5 text-xs" style={{ background: "var(--bg)", color: "var(--bad)", border: "1px solid var(--border)" }}>×</button>
      </div>

      {valuable && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input value={vinput} onChange={(e) => setVinput(e.target.value)} onBlur={commitInput} placeholder={placeholder}
            className="flex-1 min-w-48 rounded px-2 py-1" style={fieldStyle} />
          <button onClick={estimate} disabled={busy || !vinput.trim()}
            className="rounded px-2 py-1 font-medium" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", opacity: busy || !vinput.trim() ? 0.5 : 1 }}
            title="Rough AI estimate from a web search. Sends this address/vehicle to the web. Not an appraisal.">
            {busy ? "Estimating…" : "Estimate value"}
          </button>
          {estErr && <span style={{ color: "var(--bad)" }}>{estErr}</span>}
          {est && (
            <span style={{ color: "var(--muted)" }}>
              est <b style={{ color: "var(--text)" }}>{money(est.estimate)}</b>
              {est.low != null && est.high != null ? ` (${money(est.low)}–${money(est.high)})` : ""}
              {" "}<button onClick={() => useEstimate(est.estimate).then(() => setEst(null))} className="underline" style={{ color: "var(--accent)" }}>use this</button>
            </span>
          )}
          {!est && a.est_value != null && (
            <span style={{ color: "var(--muted)" }}>last est {money(a.est_value)}{a.est_as_of ? ` · ${a.est_as_of}` : ""}</span>
          )}
        </div>
      )}
      {est?.note && <div className="text-xs" style={{ color: "var(--muted)" }}>{est.note} · rough estimate, not an appraisal</div>}

      {a.side === "liability" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span style={{ color: "var(--muted)" }}>auto-amortize:</span>
          <input value={apr} onChange={(e) => setApr(e.target.value)} onBlur={commitApr}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            placeholder="APR %" inputMode="decimal" className="w-20 rounded px-2 py-1" style={fieldStyle} />
          <input value={payee} onChange={(e) => setPayee(e.target.value)} onBlur={commitPayee}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            placeholder="payee match (e.g. Pennymac)" className="flex-1 min-w-44 rounded px-2 py-1" style={fieldStyle} />
          <span style={{ color: autoOn ? "var(--good)" : "var(--muted)" }}>
            {autoOn
              ? `on — each payment cuts principal${a.last_paydown_date ? ` · last ${a.last_paydown_date}` : " · applies on next sync"}`
              : "set APR + payee so payments reduce the balance"}
          </span>
        </div>
      )}

      {isMortgage && a.apr != null && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span style={{ color: "var(--muted)" }}>refi watch:</span>
          {refi ? (
            <span style={{ color: "var(--muted)" }}>
              today <b style={{ color: "var(--text)" }}>{refi.marketRate}%</b> vs your {refi.currentApr}%
              {refi.worthIt
                ? <> · <b style={{ color: "var(--good)" }}>~{money(refi.monthlyInterestSaved)}/mo</b> less interest ({money(refi.annualSaved)}/yr)</>
                : " · no savings"}
              {refi.asOf ? ` · ${refi.asOf}` : ""}
              {" "}<button onClick={checkRefi} className="underline" style={{ color: "var(--accent)" }}>refresh</button>
            </span>
          ) : (
            <button onClick={checkRefi} disabled={refiBusy}
              className="rounded px-2 py-1" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--accent)", opacity: refiBusy ? 0.5 : 1 }}
              title="Look up today's 30-year fixed rate and compare to this loan's APR. A generic rate query — no address or balance leaves the box.">
              {refiBusy ? "Checking…" : "Check refi rate"}
            </button>
          )}
          {refiErr && <span style={{ color: "var(--bad)" }}>{refiErr}</span>}
        </div>
      )}
    </div>
  );
}

function AddAsset({ reload }: { reload: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("real_estate");
  const [side, setSide] = useState<"asset" | "liability">("asset");
  const [value, setValue] = useState("");
  const add = async () => {
    const v = parseMoney(value);
    if (!name.trim() || !Number.isFinite(v) || v < 0) return;
    await fetch("/api/assets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), kind, side, value: v }),
    });
    setName(""); setValue(""); reload();
  };
  return (
    <div className="rounded-xl p-4" style={panel}>
      <div className="flex flex-wrap items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. Home, 2023 Subaru)"
          className="flex-1 min-w-40 rounded px-2 py-1 text-sm" style={fieldStyle} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded px-2 py-1 text-sm" style={fieldStyle}>
          {KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
        </select>
        <select value={side} onChange={(e) => setSide(e.target.value as "asset" | "liability")} className="rounded px-2 py-1 text-sm" style={fieldStyle}>
          <option value="asset">asset</option>
          <option value="liability">debt</option>
        </select>
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value $" inputMode="decimal"
          className="w-32 rounded px-2 py-1 text-sm" style={fieldStyle} />
        <button onClick={add} className="rounded px-3 py-1 text-sm font-medium" style={{ background: "var(--accent-deep)", color: "white" }}>+ Add</button>
      </div>
    </div>
  );
}

export function AssetsPanel({ data, reload }: { data: AssetsData | null; reload: () => void }) {
  if (!data) return <section className="rounded-xl p-6 text-center" style={{ color: "var(--muted)", ...panel }}>Loading…</section>;
  const assets = data.assets.filter((a) => a.side === "asset");
  const debts = data.assets.filter((a) => a.side === "liability");
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl p-3" style={panel}>
        <h2 className="font-semibold">Assets &amp; debts <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>· off-Plaid, by hand</span></h2>
        <span className="text-sm" style={{ color: "var(--muted)" }}>
          {money(data.totalAsset)} assets · <span style={{ color: "var(--bad)" }}>{money(data.totalLiability)}</span> debt · net <span style={{ color: data.net >= 0 ? "var(--good)" : "var(--bad)" }}>{money(data.net)}</span>
        </span>
      </div>

      {data.assets.length === 0 && (
        <div className="rounded-xl p-6 text-center text-sm" style={{ color: "var(--muted)", ...panel }}>
          Add a house, a car, or a debt (mortgage, car loan) — it counts toward net worth. Adding one is treated as new visibility, not growth, so the trend won&apos;t spike.
        </div>
      )}

      {assets.length > 0 && (
        <div className="rounded-xl overflow-hidden" style={panel}>
          <div className="p-3 text-sm font-medium" style={{ borderBottom: "1px solid var(--border)" }}>Assets</div>
          {assets.map((a) => <AssetRow key={a.id} a={a} reload={reload} />)}
        </div>
      )}
      {debts.length > 0 && (
        <div className="rounded-xl overflow-hidden" style={panel}>
          <div className="p-3 text-sm font-medium" style={{ borderBottom: "1px solid var(--border)" }}>Debts</div>
          {debts.map((a) => <AssetRow key={a.id} a={a} reload={reload} />)}
        </div>
      )}

      <AddAsset reload={reload} />
    </section>
  );
}
