"use client";

import { useEffect, useState } from "react";
import { CategorySelect, EntityToggle, acctLabel, money, panel, prettyCategory, useModalZ } from "./ui";

// Full per-transaction detail + edit surface (the spec's "transaction detail /
// edit page", shipped as a modal to match the rest of the app). Edit category /
// merchant / entity / notes yourself, get AI/web context on the charge, and read
// the raw Plaid record — all in one place. Splits are deferred (see ROADMAP).

type Detail = {
  amount: number; currency: string; date: string;
  entity: string; note: string | null;
  account: string; accountMask: string | null; institution: string | null; accountSubtype: string | null;
  rawName: string; merchant: string | null; channel: string | null;
  location: string | null; storeNumber: string | null; website: string | null;
  detailedCategory: string | null; category: string | null; categorySource: string | null;
  authorizedDate: string | null; postedDate: string; pending: boolean;
};

type ScamResult = {
  verdict: "legit" | "caution" | "suspicious";
  merchant: string | null; reason: string | null; advice: string | null;
  sources: { title: string; url: string }[];
};
const VERDICT: Record<ScamResult["verdict"], { label: string; color: string }> = {
  legit: { label: "Looks legit", color: "var(--good)" },
  caution: { label: "Worth a look", color: "var(--warn)" },
  suspicious: { label: "Suspicious", color: "var(--bad)" },
};

const field = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" };

export function TxnDetailModal({
  id, onClose, onApplied, onMerchant, onIdentify,
}: {
  id: string;
  onClose: () => void;
  onApplied: () => void;                                  // reload feeds after a save
  onMerchant?: (name: string) => void;                    // open the merchant modal
  onIdentify?: (t: { id: string; name: string }) => void; // quick ✨ AI-identify
}) {
  const z = useModalZ();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState(false);

  // Editable working copy + the loaded baseline (to compute "dirty").
  const [cat, setCat] = useState<string>("");
  const [merch, setMerch] = useState("");
  const [entity, setEntity] = useState("personal");
  const [note, setNote] = useState("");
  const [base, setBase] = useState<{ cat: string; merch: string; entity: string; note: string } | null>(null);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ count: number; undo: unknown } | null>(null);

  // AI / web context (gated, reuses the scamcheck route).
  const [scam, setScam] = useState<ScamResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [scamErr, setScamErr] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  // Opt-in AI note draft (web + local LLM). Only runs on click. The result is a
  // PREVIEW the user chooses to store — it never silently overwrites the field.
  const [drafting, setDrafting] = useState(false);
  const [draftErr, setDraftErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ note: string; sources: { title: string; url: string }[] } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setD(null); setErr(false); setSaved(null); setScam(null); setScamErr(null);
    fetch(`/api/transactions/${encodeURIComponent(id)}/detail`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((x: Detail) => {
        if (!live) return;
        setD(x);
        const c = x.category ?? "", m = x.merchant ?? "", e = x.entity ?? "personal", n = x.note ?? "";
        setCat(c); setMerch(m); setEntity(e); setNote(n);
        setBase({ cat: c, merch: m, entity: e, note: n });
      })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [id]);

  const dirty = base != null && (cat !== base.cat || merch !== base.merch || entity !== base.entity || note !== base.note);

  const save = async () => {
    if (!base || !dirty) return;
    setSaving(true);
    const body: Record<string, unknown> = {};
    if (cat !== base.cat) body.category = cat;          // server sets source='manual' + propagates
    if (merch !== base.merch) body.merchant = merch.trim();
    if (entity !== base.entity) body.entity = entity;
    if (note !== base.note) body.note = note;
    const res = await fetch(`/api/transactions/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json()).catch(() => null);
    setSaving(false);
    if (res?.ok) {
      setBase({ cat, merch, entity, note });
      const prop = res.propagation;
      setSaved({ count: prop?.affected?.length ?? 0, undo: prop ?? null });
      onApplied();
    }
  };

  const undoProp = async () => {
    if (!saved?.undo) return;
    await fetch("/api/transactions/undo-propagation", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(saved.undo),
    }).catch(() => {});
    setSaved(null);
    onApplied();
  };

  const draftNote = () => {
    setDrafting(true); setDraftErr(null); setDraft(null);
    fetch(`/api/transactions/${encodeURIComponent(id)}/note-draft`, { method: "POST" })
      .then((r) => r.json())
      .then((x) => { x.error ? setDraftErr(x.error) : setDraft({ note: x.note, sources: x.sources ?? [] }); })
      .catch(() => setDraftErr("lookup failed"))
      .finally(() => setDrafting(false));
  };
  // Store the suggested text into the note field: append if there's already a
  // note, else set it. User can edit before Save.
  const useDraft = () => {
    if (!draft) return;
    setNote((cur) => (cur.trim() ? `${cur.trim()}\n${draft.note}` : draft.note));
    setDraft(null);
  };

  const runCheck = () => {
    setChecking(true); setScamErr(null);
    fetch(`/api/transactions/${encodeURIComponent(id)}/scamcheck`, { method: "POST" })
      .then((r) => r.json())
      .then((x) => { x.error ? setScamErr(x.error) : setScam(x); })
      .catch(() => setScamErr("check failed"))
      .finally(() => setChecking(false));
  };

  const title = d ? (d.merchant ?? d.rawName) : "Transaction";

  return (
    <div onClick={onClose} className="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 sm:p-8" style={{ zIndex: z, background: "var(--overlay)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-2xl p-5" style={{ ...panel, marginTop: "4vh" }}>
        {/* Header */}
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {onMerchant && d ? (
              <button onClick={() => onMerchant(d.merchant ?? d.rawName)} className="truncate text-left text-lg font-semibold hover:underline" title="View this merchant">
                {title} <span style={{ color: "var(--accent)" }}>→</span>
              </button>
            ) : (
              <div className="truncate text-lg font-semibold">{title}</div>
            )}
            {d && (
              <div className="text-xs" style={{ color: "var(--muted)" }}>
                <span style={{ color: d.amount < 0 ? "var(--good)" : "var(--text)" }}>{money(-d.amount, d.currency)}</span>
                {" · "}{d.date}{" · "}{acctLabel(d.account, d.accountMask, d.institution)}
                {d.pending ? " · pending" : ""}
              </div>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-lg px-2 py-1 text-sm" style={field}>✕</button>
        </div>

        {err && <div className="rounded-lg p-3 text-sm" style={{ color: "var(--bad)", background: "var(--bg)" }}>Couldn’t load this transaction.</div>}
        {!d && !err && <div className="p-6 text-center text-sm" style={{ color: "var(--muted)" }}>Loading…</div>}

        {d && (
          <>
            {/* Editable fields */}
            <div className="flex flex-col gap-3 rounded-xl p-3" style={{ background: "var(--bg)" }}>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span style={{ color: "var(--muted)" }}>Category</span>
                <CategorySelect value={cat || null} onChange={setCat} />
              </label>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span className="shrink-0" style={{ color: "var(--muted)" }}>Merchant</span>
                <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
                  <input value={merch} onChange={(e) => setMerch(e.target.value)} placeholder={d.rawName}
                    className="min-w-0 flex-1 rounded px-2 py-1 text-sm" style={field} />
                  {onIdentify && (
                    <button onClick={() => onIdentify({ id, name: d.rawName })} title="AI-identify this merchant from the web"
                      className="shrink-0 rounded px-1.5 py-1 text-sm" style={{ ...field, color: "var(--accent)" }}>✨</button>
                  )}
                </span>
              </label>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span style={{ color: "var(--muted)" }}>Entity</span>
                <EntityToggle value={entity} onChange={setEntity} />
              </label>
              <div className="flex flex-col gap-1 text-sm">
                <span className="flex items-center justify-between gap-2">
                  <span style={{ color: "var(--muted)" }}>Notes</span>
                  <button type="button" onClick={draftNote} disabled={drafting}
                    title="Web-search this charge + local model for context. Only the descriptor leaves your network; you choose whether to save it."
                    className="rounded px-1.5 py-0.5 text-xs" style={{ ...field, color: "var(--accent)" }}>
                    {drafting ? "Looking up…" : "✨ Get info"}
                  </button>
                </span>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Add a note (what this was for, who to split with, …)"
                  className="w-full rounded px-2 py-1 text-sm" style={field} />
                {draftErr && <span className="text-xs" style={{ color: "var(--bad)" }}>{draftErr}</span>}
                {draft && (
                  <div className="rounded-lg p-2 text-xs" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                    <div style={{ color: "var(--text)" }}>{draft.note}</div>
                    {draft.sources.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-x-2" style={{ color: "var(--muted)" }}>
                        {draft.sources.map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer" className="truncate" style={{ color: "var(--accent)", maxWidth: 160 }}>↗ {s.title || s.url}</a>)}
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      <button type="button" onClick={useDraft} className="rounded px-2 py-1" style={{ background: "var(--accent-deep)", color: "white" }}>
                        {note.trim() ? "Append to notes" : "Add to notes"}
                      </button>
                      <button type="button" onClick={() => setDraft(null)} className="rounded px-2 py-1" style={{ color: "var(--muted)" }}>Dismiss</button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Save / propagation feedback */}
            <div className="mt-3 flex items-center gap-3">
              <button onClick={save} disabled={!dirty || saving}
                className="rounded-lg px-4 py-2 text-sm font-medium" style={{ background: "var(--accent-deep)", color: "white", opacity: !dirty || saving ? 0.5 : 1 }}>
                {saving ? "Saving…" : "Save changes"}
              </button>
              {saved && (
                <span className="text-xs" style={{ color: "var(--good)" }}>
                  ✓ Saved{saved.count > 0 ? ` · applied to ${saved.count} more` : ""}
                  {saved.count > 0 && saved.undo ? <> · <button onClick={undoProp} className="underline" style={{ color: "var(--accent)" }}>Undo</button></> : null}
                </span>
              )}
            </div>

            {/* AI / web context */}
            <div className="mt-4">
              <div className="mb-1 text-xs font-medium" style={{ color: "var(--muted)" }}>AI / web context</div>
              {scam ? (
                <div className="rounded-lg p-2 text-xs" style={{ background: "var(--bg)", border: `1px solid ${VERDICT[scam.verdict].color}33` }}>
                  <span className="font-medium" style={{ color: VERDICT[scam.verdict].color }}>{VERDICT[scam.verdict].label}</span>
                  {scam.reason && <span style={{ color: "var(--text)" }}> — {scam.reason}</span>}
                  {scam.advice && <div className="mt-1" style={{ color: "var(--muted)" }}>{scam.advice}</div>}
                  {scam.sources.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-x-2" style={{ color: "var(--muted)" }}>
                      {scam.sources.map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer" className="truncate" style={{ color: "var(--accent)", maxWidth: 180 }}>{s.title || s.url}</a>)}
                    </div>
                  )}
                </div>
              ) : (
                <button type="button" onClick={runCheck} disabled={checking}
                  className="rounded px-2 py-1 text-xs" style={{ ...field, color: "var(--accent)" }}
                  title="Web-search this merchant and have the local model judge it. Only the descriptor leaves your network.">
                  {checking ? "Checking…" : "✨ Check this charge"}
                </button>
              )}
              {scamErr && <span className="ml-2 text-xs" style={{ color: "var(--bad)" }}>{scamErr}</span>}
            </div>

            {/* Raw Plaid detail */}
            <div className="mt-4">
              <button onClick={() => setShowRaw((s) => !s)} className="text-xs font-medium" style={{ color: "var(--muted)" }}>
                {showRaw ? "▾" : "▸"} Raw Plaid detail
              </button>
              {showRaw && (
                <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs" style={{ gridTemplateColumns: "auto 1fr" }}>
                  {([
                    ["Account", acctLabel(d.account, d.accountMask, d.institution)],
                    d.channel ? ["Where", d.location ? `${d.channel} · ${d.location}` : d.channel] : d.location ? ["Where", d.location] : null,
                    d.detailedCategory ? ["Detailed", d.detailedCategory] : null,
                    d.category ? ["Filed as", `${prettyCategory(d.category)}${d.categorySource ? ` (${d.categorySource})` : ""}`] : null,
                    d.authorizedDate ? ["Authorized", d.authorizedDate] : null,
                    d.rawName && d.rawName !== d.merchant ? ["Descriptor", d.rawName] : null,
                    d.website ? ["Site", <a key="w" href={d.website.startsWith("http") ? d.website : `https://${d.website}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{d.website}</a>] : null,
                  ].filter(Boolean) as [string, React.ReactNode][]).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt style={{ color: "var(--muted)" }}>{k}</dt>
                      <dd className="min-w-0 truncate">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
