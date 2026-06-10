"use client";

import { useEffect, useState } from "react";
import { acctLabel, money, panel, prettyCategory, useModalZ, type Txn } from "./ui";

export type DrillFilter = { title: string; category?: string; q?: string; days?: number };

// A read-only transaction list behind any Overview element: a spending category,
// a Sankey node, an alert, a feed merchant. Reuses the AccountDetail modal shell
// + row markup; fetches the filtered /api/transactions and shows a subtotal.
// Rows are entry points: the date opens the single-txn detail/edit modal, the
// merchant name opens the merchant detail/edit modal, ✨ is the quick AI-identify.
export function TxnDrillModal({
  filter, onClose, onIdentify, onMerchant, onTxn,
}: {
  filter: DrillFilter;
  onClose: () => void;
  onIdentify?: (t: { id: string; name: string }) => void;
  onMerchant?: (name: string) => void;
  onTxn?: (id: string) => void;
}) {
  const z = useModalZ();
  const [rows, setRows] = useState<Txn[] | null>(null);

  useEffect(() => {
    setRows(null);
    const p = new URLSearchParams({ limit: "200" });
    if (filter.category) p.set("category", filter.category);
    if (filter.q) p.set("q", filter.q);
    if (filter.days) p.set("days", String(filter.days));
    fetch(`/api/transactions?${p.toString()}`).then((r) => r.json()).then((x) => setRows(x.txns ?? []));
  }, [filter.category, filter.q, filter.days]);

  // Outflow subtotal (Plaid sign: + = outflow), so the header echoes the bar/node.
  const outflow = (rows ?? []).reduce((s, t) => s + (t.amount > 0 ? t.amount : 0), 0);

  return (
    <div onClick={onClose} className="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      style={{ zIndex: z, background: "var(--overlay)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl rounded-2xl p-5" style={{ ...panel, marginTop: "2vh" }}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">{filter.title}</div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>
              {rows == null ? "Loading…" : `${rows.length} transaction${rows.length === 1 ? "" : "s"}`}
              {filter.days ? ` · last ${filter.days} days` : ""}
              {rows && outflow > 0 ? ` · ${money(outflow)} out` : ""}
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>✕</button>
        </div>

        {rows == null ? (
          <div className="p-6 text-center" style={{ color: "var(--muted)" }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl p-4 text-center text-sm" style={{ color: "var(--muted)", background: "var(--bg)" }}>No matching transactions.</div>
        ) : (
          <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
            {rows.map((t, i) => (
              <div key={t.id} className="flex items-center gap-2 p-2 text-sm" style={{ borderTop: i ? "1px solid var(--border)" : undefined }}>
                <button type="button" onClick={() => onTxn?.(t.id)} disabled={!onTxn}
                  className="w-20 shrink-0 text-left text-xs" style={{ color: "var(--muted)" }} title={onTxn ? "Transaction details" : undefined}>{t.date}</button>
                {onIdentify && (
                  <button onClick={() => onIdentify({ id: t.id, name: t.name })} title="AI-identify this merchant from the web"
                    className="text-xs" style={{ color: "var(--accent)" }}>✨</button>
                )}
                <button type="button" onClick={() => onMerchant?.(t.merchant ?? t.name)} disabled={!onMerchant}
                  className="min-w-0 flex-1 text-left" title={onMerchant ? "Merchant details + edit" : undefined}>
                  <span className="block truncate">{t.merchant ?? t.name}{t.pending ? <span className="ml-1 text-xs" style={{ color: "var(--muted)" }}>· pending</span> : null}</span>
                  <span className="block truncate text-xs" style={{ color: "var(--muted)" }}>
                    {acctLabel(t.account, t.account_mask, t.account_institution)}
                    {t.category ? <span className="sm:hidden"> · {prettyCategory(t.category)}</span> : null}
                  </span>
                </button>
                {t.category && <span className="hidden sm:inline text-xs" style={{ color: "var(--muted)" }}>{prettyCategory(t.category)}</span>}
                <span className="tabular-nums" style={{ minWidth: 90, textAlign: "right", color: t.amount < 0 ? "var(--good)" : "var(--text)" }}>
                  {money(-t.amount, t.currency ?? "USD")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
