"use client";

import { useCallback, useEffect, useState } from "react";
import { money, panel, useModalZ } from "./ui";

// Manual (held-away) investment accounts the user maintains by hand — a 529, military
// TSP, Coinbase, a small broker Plaid can't link. Creation lives in a modal off the ⚙
// menu; the manage list lives on the Net Worth tab. Holdings are added on the
// Investments tab's existing "Add holding manually" form (this account shows up as a
// target there once it exists). Mirrors the Assets.tsx panel/row patterns.

type ManualAccount = {
  id: string; name: string; institution: string | null;
  subtype: string | null; balance: number; holdingCount: number;
};

const fieldStyle = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" };
const parseMoney = (v: string) => Number(v.replace(/[$,\s]/g, ""));
const FALLBACK_SUBTYPES = ["brokerage", "401k", "ira", "roth", "529", "hsa", "tsp", "crypto", "other"];

async function getManual(): Promise<{ accounts: ManualAccount[]; subtypes: string[] }> {
  const r = await fetch("/api/accounts/manual").then((x) => x.json()).catch(() => ({}));
  return { accounts: r.accounts ?? [], subtypes: r.subtypes ?? FALLBACK_SUBTYPES };
}

// ---- Create modal (opened from the ⚙ menu) ----
export function AddManualAccountModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const z = useModalZ();
  const [subtypes, setSubtypes] = useState<string[]>(FALLBACK_SUBTYPES);
  const [name, setName] = useState("");
  const [institution, setInstitution] = useState("");
  const [subtype, setSubtype] = useState("brokerage");
  const [balance, setBalance] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { getManual().then((d) => setSubtypes(d.subtypes)); }, []);

  const create = async () => {
    if (!name.trim()) { setErr("Name is required"); return; }
    const bal = balance.trim() ? parseMoney(balance) : 0;
    if (!Number.isFinite(bal) || bal < 0) { setErr("Balance must be a non-negative number"); return; }
    setBusy(true); setErr(null);
    const r = await fetch("/api/accounts/manual", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), institution: institution.trim() || null, subtype, balance: bal }),
    }).then((x) => x.json()).catch(() => ({ error: "request failed" }));
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    onCreated();
    onClose();
  };

  return (
    <div onClick={onClose} className="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      style={{ zIndex: z, background: "var(--overlay)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-2xl p-5" style={{ ...panel, marginTop: "4vh" }}>
        <div className="mb-1 flex items-start justify-between gap-3">
          <div className="text-lg font-semibold">Add a manual account</div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>✕</button>
        </div>
        <p className="mb-4 text-xs" style={{ color: "var(--muted)" }}>
          A held-away investment account Plaid can&apos;t link (529, TSP, Coinbase, a small broker).
          Add its holdings afterward on the Investments tab — or just enter a balance for a value-only
          account. Adding it counts as new visibility, not growth, so the trend won&apos;t spike.
        </p>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--muted)" }}>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Vanguard 529"
              className="w-full rounded px-2 py-1.5 text-sm" style={fieldStyle} />
          </label>
          <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--muted)" }}>
            Institution
            <input value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="e.g. Vanguard, TSP, Coinbase"
              className="w-full rounded px-2 py-1.5 text-sm" style={fieldStyle} />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-1 min-w-32 flex-col gap-1 text-xs" style={{ color: "var(--muted)" }}>
              Type
              <select value={subtype} onChange={(e) => setSubtype(e.target.value)} className="w-full rounded px-2 py-1.5 text-sm" style={fieldStyle}>
                {subtypes.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="flex flex-1 min-w-32 flex-col gap-1 text-xs" style={{ color: "var(--muted)" }}>
              Opening balance
              <input value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="$ (optional)" inputMode="decimal"
                className="w-full rounded px-2 py-1.5 text-sm" style={fieldStyle} />
            </label>
          </div>
          {err && <div className="text-xs" style={{ color: "var(--bad)" }}>{err}</div>}
          <div className="mt-1 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}>Cancel</button>
            <button onClick={create} disabled={busy || !name.trim()}
              className="rounded-lg px-4 py-1.5 text-sm font-medium" style={{ background: "var(--accent-deep)", color: "white", opacity: busy || !name.trim() ? 0.5 : 1 }}>
              {busy ? "Adding…" : "Add account"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Manage row ----
function ManualRow({ a, reload }: { a: ManualAccount; reload: () => void }) {
  const [name, setName] = useState(a.name);
  const [balance, setBalance] = useState(String(a.balance));
  const hasHoldings = a.holdingCount > 0;

  const patch = async (body: Record<string, unknown>) => {
    await fetch("/api/accounts/manual", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id, ...body }),
    });
    reload();
  };
  const commitName = () => { if (name.trim() && name.trim() !== a.name) patch({ name: name.trim() }); };
  const commitBalance = () => {
    if (hasHoldings) return;
    const n = parseMoney(balance);
    if (Number.isFinite(n) && n >= 0 && n !== a.balance) patch({ balance: n });
  };
  const del = async () => {
    if (!confirm(`Delete "${a.name}"? This removes its holdings too.`)) return;
    await fetch(`/api/accounts/manual?id=${encodeURIComponent(a.id)}`, { method: "DELETE" });
    reload();
  };

  return (
    <div className="flex flex-col gap-2 p-3" style={{ borderTop: "1px solid var(--border)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="flex-1 min-w-40 rounded px-2 py-1 text-sm" style={fieldStyle} />
        <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: "var(--bg)", color: "var(--muted)" }}>
          {a.subtype ?? "investment"}{a.institution ? ` · ${a.institution}` : ""}
        </span>
        <span style={{ color: "var(--muted)" }}>$</span>
        <input value={balance} onChange={(e) => setBalance(e.target.value)} onBlur={commitBalance}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          inputMode="decimal" disabled={hasHoldings} title={hasHoldings ? "Balance tracks this account's holdings" : undefined}
          className="w-32 rounded px-2 py-0.5 text-right text-sm" style={{ ...fieldStyle, opacity: hasHoldings ? 0.55 : 1 }} />
        <button onClick={del} title="delete account"
          className="rounded px-1.5 py-0.5 text-xs" style={{ background: "var(--bg)", color: "var(--bad)", border: "1px solid var(--border)" }}>×</button>
      </div>
      <div className="text-xs" style={{ color: "var(--muted)" }}>
        {hasHoldings
          ? `${a.holdingCount} holding${a.holdingCount === 1 ? "" : "s"} · balance tracks holdings (edit on the Investments tab)`
          : "value-only · edit the balance here, or add holdings on the Investments tab"}
      </div>
    </div>
  );
}

// ---- Manage panel (Net Worth tab) ----
export function ManualAccountsPanel({ onChanged }: { onChanged?: () => void }) {
  const [accounts, setAccounts] = useState<ManualAccount[] | null>(null);
  const reload = useCallback(async () => {
    const d = await getManual();
    setAccounts(d.accounts);
    onChanged?.();
  }, [onChanged]);
  useEffect(() => { reload(); }, [reload]);

  if (accounts === null) return null;
  const total = accounts.reduce((s, a) => s + a.balance, 0);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl p-3" style={panel}>
        <h2 className="font-semibold">Manual accounts <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>· held-away, by hand</span></h2>
        {accounts.length > 0 && (
          <span className="text-sm" style={{ color: "var(--muted)" }}>{accounts.length} · {money(total)}</span>
        )}
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-xl p-6 text-center text-sm" style={{ color: "var(--muted)", ...panel }}>
          No manual accounts yet. Use ⚙ → Add manual account for a 529, TSP, Coinbase, or a small
          broker Plaid can&apos;t link. It counts toward net worth.
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={panel}>
          {accounts.map((a) => <ManualRow key={a.id} a={a} reload={reload} />)}
        </div>
      )}
    </section>
  );
}
