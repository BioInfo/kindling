"use client";

import { useEffect, useState } from "react";
import { CategorySelect, acctLabel, money, panel, prettyCategory, useModalZ, type Txn } from "./ui";

// Merchant detail + edit surface (the spec's "merchant detail / edit page",
// shipped as a modal). Keyed by the displayed merchant name. From here you can:
// (a) edit the display name yourself, (b) ask AI to suggest a clean name + tell
// you what the merchant is, (c) apply the name (and optionally a category) to
// ALL of this merchant's transactions, (d) browse those transactions. The quick
// ✨ identify modal still exists on rows; this is the fuller surface behind a
// merchant name.

type MerchantData = {
  name: string; count: number; totalOut: number; totalIn: number;
  firstDate: string | null; lastDate: string | null; category: string | null;
  monthly: { ym: string; out: number }[]; repId: string | null; txns: Txn[];
};

type Identify = {
  merchant: string | null; explanation: string | null; suggestedName: string | null;
  category: string | null; confidence: string | null; sources: { title: string; url: string }[];
};

const field = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" };

export function MerchantModal({
  name, onClose, onApplied, onTxn,
}: {
  name: string;
  onClose: () => void;
  onApplied: () => void;              // reload feeds after an apply
  onTxn?: (id: string) => void;       // open a single txn's detail modal
}) {
  const z = useModalZ();
  const [d, setD] = useState<MerchantData | null>(null);
  const [err, setErr] = useState(false);
  const [displayName, setDisplayName] = useState(name);
  const [cat, setCat] = useState<string>("");
  const [origCat, setOrigCat] = useState<string>("");

  const [ident, setIdent] = useState<Identify | null>(null);
  const [identBusy, setIdentBusy] = useState(false);
  const [identErr, setIdentErr] = useState<string | null>(null);

  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadName = (n: string) => {
    setD(null); setErr(false); setIdent(null); setApplied(null);
    fetch(`/api/merchants?name=${encodeURIComponent(n)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((x: MerchantData) => {
        setD(x); setDisplayName(x.name);
        setCat(x.category ?? ""); setOrigCat(x.category ?? "");
      })
      .catch(() => setErr(true));
  };
  useEffect(() => { loadName(name); }, [name]);

  // (b) AI suggest: reuse the per-txn identify on the representative txn.
  const aiSuggest = () => {
    if (!d?.repId) return;
    setIdentBusy(true); setIdentErr(null);
    fetch(`/api/transactions/${encodeURIComponent(d.repId)}/identify`, { method: "POST" })
      .then((r) => r.json())
      .then((x) => {
        if (x.error) { setIdentErr(x.error); return; }
        setIdent(x);
        if (x.suggestedName) setDisplayName(x.suggestedName);
        if (x.category && !cat) setCat(x.category);
      })
      .catch((e) => setIdentErr(String(e)))
      .finally(() => setIdentBusy(false));
  };

  // (c) apply name (and optionally re-file category) to ALL of this merchant's txns.
  const catChanged = cat && cat !== origCat;
  const dirty = (displayName.trim() && displayName.trim() !== name) || catChanged;
  const apply = async () => {
    if (!dirty) return;
    setApplying(true);
    const body: Record<string, unknown> = { name, rename: displayName.trim() || name };
    if (catChanged) body.category = cat;
    const res = await fetch("/api/merchants", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json()).catch(() => null);
    setApplying(false);
    if (res?.ok) {
      setApplied(res.applied ?? 0);
      onApplied();
      loadName(res.rename ?? displayName.trim()); // re-key to the new name
    }
  };

  return (
    <div onClick={onClose} className="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 sm:p-8" style={{ zIndex: z, background: "var(--overlay)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl rounded-2xl p-5" style={{ ...panel, marginTop: "3vh" }}>
        {/* Header */}
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs" style={{ color: "var(--muted)" }}>Merchant</div>
            <div className="truncate text-lg font-semibold">{d?.name ?? name}</div>
            {d && (
              <div className="text-xs" style={{ color: "var(--muted)" }}>
                {money(d.totalOut)} out · {d.count} txn{d.count === 1 ? "" : "s"}
                {d.firstDate ? ` · since ${d.firstDate}` : ""}
                {d.category ? <span className="ml-1 rounded px-1.5 py-0.5" style={{ background: "var(--bg)" }}>{prettyCategory(d.category)}</span> : null}
              </div>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-lg px-2 py-1 text-sm" style={field}>✕</button>
        </div>

        {err && <div className="rounded-lg p-3 text-sm" style={{ color: "var(--bad)", background: "var(--bg)" }}>Couldn’t load this merchant.</div>}
        {!d && !err && <div className="p-6 text-center text-sm" style={{ color: "var(--muted)" }}>Loading…</div>}

        {d && (
          <>
            {d.monthly.length > 1 && (() => {
              // Monthly outflow as bars, not a line: a steady merchant (e.g. a
              // $250/mo transfer) reads as equal bars rather than a flat line that
              // looks broken; a variable one scales honestly. Per-bar tooltip = $.
              const max = Math.max(...d.monthly.map((m) => m.out), 1);
              return (
                <div className="mb-3 rounded-xl p-3" style={{ background: "var(--bg)" }}>
                  <div className="mb-1.5 flex items-center justify-between text-xs" style={{ color: "var(--muted)" }}>
                    <span>Monthly out</span><span>{d.monthly.length} mo</span>
                  </div>
                  <div className="flex items-end gap-1" style={{ height: 56 }}>
                    {d.monthly.map((m) => (
                      <div key={m.ym} className="min-w-0 flex-1 rounded-t" title={`${m.ym}: ${money(m.out)}`}
                        style={{ height: `${Math.max(3, (m.out / max) * 100)}%`, minHeight: 2, background: "var(--accent-deep)" }} />
                    ))}
                  </div>
                  <div className="mt-1 flex justify-between" style={{ color: "var(--muted)", fontSize: 10 }}>
                    <span>{d.monthly[0].ym}</span><span>{d.monthly[d.monthly.length - 1].ym}</span>
                  </div>
                </div>
              );
            })()}

            {/* Edit name + category, apply to all */}
            <div className="flex flex-col gap-2 rounded-xl p-3" style={{ background: "var(--bg)" }}>
              <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--muted)" }}>Display name
                <span className="flex items-center gap-1.5">
                  <input value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                    className="min-w-0 flex-1 rounded px-2 py-1 text-sm" style={field} />
                  <button onClick={aiSuggest} disabled={identBusy || !d.repId} title="Ask AI to identify this merchant + suggest a clean name"
                    className="shrink-0 rounded px-2 py-1 text-sm" style={{ ...field, color: "var(--accent)" }}>{identBusy ? "…" : "✨ AI"}</button>
                </span>
              </label>
              <label className="flex items-center justify-between gap-3 text-xs" style={{ color: "var(--muted)" }}>
                <span>Category for all</span>
                <CategorySelect value={cat || null} onChange={setCat} />
              </label>
              <div className="flex items-center gap-3">
                <button onClick={apply} disabled={!dirty || applying}
                  className="rounded-lg px-4 py-2 text-sm font-medium" style={{ background: "var(--accent-deep)", color: "white", opacity: !dirty || applying ? 0.5 : 1 }}>
                  {applying ? "Applying…" : `Apply to all ${d.count}`}
                </button>
                {applied != null && <span className="text-xs" style={{ color: "var(--good)" }}>✓ Updated {applied} transaction{applied === 1 ? "" : "s"}</span>}
              </div>
            </div>

            {/* (d) AI / web info about the merchant */}
            {(ident || identErr) && (
              <div className="mt-3 rounded-xl p-3 text-sm" style={{ background: "var(--bg)" }}>
                {identErr ? <span style={{ color: "var(--bad)" }}>Couldn’t identify: {identErr}</span> : (
                  <>
                    <div className="font-medium">{ident!.merchant ?? "Unknown"}
                      {ident!.confidence && <span className="ml-2 rounded px-1.5 py-0.5 text-xs" style={{ color: "var(--muted)", border: "1px solid var(--border)" }}>{ident!.confidence} confidence</span>}
                    </div>
                    {ident!.explanation && <p className="mt-1" style={{ color: "var(--muted)" }}>{ident!.explanation}</p>}
                    {ident!.sources.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        {ident!.sources.map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>↗ {s.title.slice(0, 40)}</a>)}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Transactions for this merchant */}
            <div className="mt-4 text-xs font-medium" style={{ color: "var(--muted)" }}>Transactions</div>
            <div className="mt-1 rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
              {d.txns.map((t, i) => (
                <button key={t.id} onClick={() => onTxn?.(t.id)} disabled={!onTxn}
                  className="flex w-full items-center gap-2 p-2 text-left text-sm" style={{ borderTop: i ? "1px solid var(--border)" : undefined }}
                  title={onTxn ? "Open transaction detail" : undefined}>
                  <span className="w-20 shrink-0 text-xs" style={{ color: "var(--muted)" }}>{t.date}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="block truncate text-xs" style={{ color: "var(--muted)" }}>{acctLabel(t.account, t.account_mask, t.account_institution)}{t.category ? ` · ${prettyCategory(t.category)}` : ""}</span>
                  </span>
                  <span className="shrink-0 tabular-nums" style={{ color: t.amount < 0 ? "var(--good)" : "var(--text)" }}>{money(-t.amount, t.currency ?? "USD")}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
