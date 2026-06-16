"use client";

import { useEffect, useState } from "react";
import { money, panel, prettyAccount, useModalZ } from "./ui";

export type AccountCard = {
  id: string; name: string; mask: string | null; type: string | null;
  subtype: string | null; current_balance: number | null; currency: string | null;
  institution: string | null;
};

const isLiability = (a: AccountCard) => a.type === "credit" || a.type === "loan";
// Net contribution to wealth: liabilities (cards/loans) carry a positive balance
// that's money owed, so they subtract.
const signed = (a: AccountCard) => (isLiability(a) ? -1 : 1) * (a.current_balance ?? 0);
// Clean label, de-duping the mask (Vanguard names already embed "··0958").
const acctLabel = (a: AccountCard) => {
  const base = prettyAccount(a.name);
  return a.mask && !base.includes(a.mask) ? `${base} ··${a.mask}` : base;
};

// Accounts grouped by institution: a subtotal per institution, accounts sorted by
// balance, and the $0/empty accounts tucked behind a "show" toggle. Replaces the
// old card grid (22 low-density cards) — denser, grouped, less noise. Reused on
// Overview (defaultCollapsed: just the institution subtotals) and the Account
// Details tab (expanded). Rows stay clickable into the detail modal.
export function AccountsGrid({
  accounts, onSelect, defaultCollapsed = false,
}: { accounts: AccountCard[]; onSelect: (id: string) => void; defaultCollapsed?: boolean }) {
  // Per-institution open state. Default follows defaultCollapsed; a click flips it.
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const [showEmpty, setShowEmpty] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");

  if (accounts.length === 0) {
    return <div className="rounded-xl p-6 text-center" style={{ color: "var(--muted)", ...panel }}>No accounts yet. Connect a bank.</div>;
  }

  // Search filters across name / institution / mask; grouping + balance sort follow.
  const ql = q.trim().toLowerCase();
  const visible = ql
    ? accounts.filter((a) => `${a.name} ${a.institution ?? ""} ${a.mask ?? ""}`.toLowerCase().includes(ql))
    : accounts;
  // Group → subtotal, sort accounts within by balance, groups by size.
  const byInst = new Map<string, AccountCard[]>();
  for (const a of visible) {
    const k = a.institution ?? "Other";
    const arr = byInst.get(k); if (arr) arr.push(a); else byInst.set(k, [a]);
  }
  const groups = [...byInst.entries()].map(([institution, accts]) => {
    const subtotal = accts.reduce((s, a) => s + signed(a), 0);
    const sorted = [...accts].sort((x, y) => (y.current_balance ?? 0) - (x.current_balance ?? 0));
    return { institution, accts: sorted, subtotal, empties: sorted.filter((a) => (a.current_balance ?? 0) === 0).length };
  }).sort((a, b) => Math.abs(b.subtotal) - Math.abs(a.subtotal));
  const grand = accounts.reduce((s, a) => s + signed(a), 0);

  const cur = accounts[0]?.currency ?? "USD";

  return (
    <section className="rounded-xl overflow-hidden" style={panel}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 p-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="text-sm font-semibold">Accounts <span style={{ color: "var(--muted)" }}>· {accounts.length}</span></span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search accounts…"
          className="min-w-0 flex-1 rounded px-2 py-1 text-xs sm:max-w-48" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
        <span className="text-sm font-semibold tabular-nums">{money(grand, cur)}</span>
      </div>

      {groups.length === 0 && <div className="p-6 text-center text-sm" style={{ color: "var(--muted)" }}>No accounts match “{q}”.</div>}
      {groups.map((g) => {
        const open = ql ? true : (openMap[g.institution] ?? !defaultCollapsed);
        const showZeros = showEmpty[g.institution] ?? false;
        const rows = open ? g.accts.filter((a) => showZeros || (a.current_balance ?? 0) !== 0) : [];
        return (
          <div key={g.institution} style={{ borderTop: "1px solid var(--border)" }}>
            <button type="button" onClick={() => setOpenMap((m) => ({ ...m, [g.institution]: !open }))}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
              <span style={{ color: "var(--muted)", width: 12 }}>{open ? "▾" : "▸"}</span>
              <span className="font-medium">{g.institution}</span>
              <span className="text-xs" style={{ color: "var(--muted)" }}>· {g.accts.length}</span>
              <span className="flex-1" />
              <span className="tabular-nums" style={{ color: g.subtotal < 0 ? "var(--bad)" : "var(--text)" }}>{money(g.subtotal, cur)}</span>
            </button>
            {rows.map((a) => (
              <button key={a.id} type="button" onClick={() => onSelect(a.id)}
                className="flex w-full items-center gap-2 py-1.5 pl-7 pr-3 text-left text-sm transition-opacity hover:opacity-70"
                style={{ opacity: (a.current_balance ?? 0) === 0 ? 0.5 : 1 }}>
                <span className="min-w-0 flex-1 truncate">{acctLabel(a)}</span>
                <span className="hidden shrink-0 text-xs sm:inline" style={{ color: "var(--muted)" }}>{a.subtype ?? a.type}</span>
                <span className="shrink-0 tabular-nums" style={{ minWidth: 96, textAlign: "right", color: isLiability(a) ? "var(--bad)" : "var(--text)" }}>
                  {money(a.current_balance, a.currency ?? "USD")}
                </span>
              </button>
            ))}
            {open && g.empties > 0 && !showZeros && (
              <button type="button" onClick={() => setShowEmpty((s) => ({ ...s, [g.institution]: true }))}
                className="py-1.5 pl-7 pr-3 text-left text-xs" style={{ color: "var(--muted)" }}>
                ·· {g.empties} empty ($0) · show
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

type Detail = {
  account: {
    id: string; name: string; official_name: string | null; mask: string | null;
    type: string | null; subtype: string | null; current_balance: number | null;
    available_balance: number | null; currency: string | null; updated_at: string | null;
    institution: string | null; item_status: string | null; last_synced_at: string | null;
    owner: string | null; manual?: boolean;
  };
  txns: { id: string; date: string; name: string; merchant: string | null; amount: number; currency: string | null; pending: number; category: string | null; entity: string | null }[];
  txnStats: { n: number; first: string | null; last: string | null };
  holdings: { ticker: string | null; name: string | null; type: string | null; quantity: number | null; price: number | null; value: number; cost_basis: number | null; source: string }[];
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div><div className="text-xs" style={{ color: "var(--muted)" }}>{label}</div><div className="text-sm">{children}</div></div>
);

export function AccountDetailModal({ id, onClose, onIdentify, onMerchant, onTxn }: {
  id: string; onClose: () => void;
  onIdentify?: (t: { id: string; name: string }) => void;
  onMerchant?: (name: string) => void;
  onTxn?: (id: string) => void;
}) {
  const z = useModalZ();
  const [d, setD] = useState<Detail | null>(null);
  useEffect(() => {
    setD(null);
    fetch(`/api/accounts/${encodeURIComponent(id)}`).then((r) => r.json()).then((x) => setD(x.account ? x : null));
  }, [id]);

  return (
    <div onClick={onClose} className="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      style={{ zIndex: z, background: "var(--overlay)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-3xl rounded-2xl p-5" style={{ ...panel, marginTop: "2vh" }}>
        {!d ? (
          <div className="p-6 text-center" style={{ color: "var(--muted)" }}>Loading…</div>
        ) : (
          <>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">
                  {d.account.name}{d.account.mask ? ` ··${d.account.mask}` : ""}
                  {d.account.manual && <span className="ml-2 align-middle rounded px-1.5 py-0.5 text-xs font-normal" style={{ background: "var(--bg)", color: "var(--muted)" }}>manual</span>}
                </div>
                {d.account.official_name && d.account.official_name !== d.account.name && (
                  <div className="text-xs" style={{ color: "var(--muted)" }}>{d.account.official_name}</div>
                )}
              </div>
              <button onClick={onClose} className="rounded-lg px-2 py-1 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>✕</button>
            </div>

            <div className="grid grid-cols-2 gap-3 rounded-xl p-3 sm:grid-cols-4" style={{ background: "var(--bg)" }}>
              <Field label="Balance">{money(d.account.current_balance, d.account.currency ?? "USD")}</Field>
              {d.account.available_balance != null && <Field label="Available">{money(d.account.available_balance, d.account.currency ?? "USD")}</Field>}
              <Field label="Type">{d.account.subtype ?? d.account.type ?? "—"}</Field>
              <Field label="Institution">{d.account.institution ?? "—"}</Field>
              {d.account.owner && <Field label="Owner">{d.account.owner}</Field>}
              <Field label="Transactions">{d.txnStats.n}{d.txnStats.first ? ` · since ${d.txnStats.first}` : ""}</Field>
              {d.account.last_synced_at && <Field label="Last synced">{d.account.last_synced_at.slice(0, 16).replace("T", " ")}</Field>}
              <Field label="Status">{d.account.item_status ?? "—"}</Field>
            </div>
            {!d.account.owner && (
              <div className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
                Verified account owners need Plaid&apos;s identity product (not enabled). Owner above, when shown, is inferred from the account name.
              </div>
            )}

            {d.holdings.length > 0 && (
              <div className="mt-4">
                <div className="mb-1 text-sm font-medium">Holdings</div>
                <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
                  {d.holdings.map((h, i) => (
                    <div key={i} className="flex items-center gap-2 p-2 text-sm" style={{ borderTop: i ? "1px solid var(--border)" : undefined }}>
                      <span className="flex-1 truncate">{h.ticker ? <b>{h.ticker}</b> : null} {h.name}{h.source === "manual" ? <span className="ml-1 text-xs" style={{ color: "var(--muted)" }}>· manual</span> : null}</span>
                      <span className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>{h.quantity ?? "—"}</span>
                      <span className="tabular-nums" style={{ minWidth: 90, textAlign: "right" }}>{money(h.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4">
              <div className="mb-1 text-sm font-medium">Recent transactions</div>
              {d.txns.length === 0 ? (
                <div className="rounded-xl p-4 text-center text-sm" style={{ color: "var(--muted)", background: "var(--bg)" }}>
                  No transactions for this account{d.holdings.length > 0 ? " (investment accounts often report holdings, not transactions)" : ""}.
                </div>
              ) : (
                <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
                  {d.txns.map((t, i) => (
                    <div key={t.id} className="flex items-center gap-2 p-2 text-sm" style={{ borderTop: i ? "1px solid var(--border)" : undefined }}>
                      <button type="button" onClick={() => onTxn?.(t.id)} disabled={!onTxn}
                        className="w-20 shrink-0 text-left text-xs" style={{ color: "var(--muted)" }} title={onTxn ? "Transaction details" : undefined}>{t.date}</button>
                      {onIdentify && (
                        <button onClick={() => onIdentify({ id: t.id, name: t.name })} title="AI-identify this merchant from the web"
                          className="text-xs" style={{ color: "var(--accent)" }}>✨</button>
                      )}
                      <button type="button" onClick={() => onMerchant?.(t.merchant ?? t.name)} disabled={!onMerchant}
                        className="flex-1 min-w-0 truncate text-left" title={onMerchant ? "Merchant details + edit" : undefined}>{t.merchant ?? t.name}{t.pending ? <span className="ml-1 text-xs" style={{ color: "var(--muted)" }}>· pending</span> : null}</button>
                      {t.category && <span className="hidden sm:inline text-xs" style={{ color: "var(--muted)" }}>{t.category}</span>}
                      <span className="tabular-nums" style={{ minWidth: 90, textAlign: "right", color: t.amount < 0 ? "var(--good)" : "var(--text)" }}>
                        {money(-t.amount, t.currency ?? "USD")}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
