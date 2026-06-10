"use client";

import { useEffect, useState } from "react";
import { CategorySelect, EntityToggle, acctLabel, money, panel, prettyCategory, useModalZ } from "./ui";
import type { Subscription } from "./Subscriptions";

// Per-subscription detail + edit (modal, matching TxnDetail/Merchant). Header +
// price-history bars (each charge; a hike reads as a taller last bar), the
// editable curated fields (state / type / category / merchant / entity / trial /
// note), then every member charge. All writes go through PATCH; detection never
// touches these fields.

type MemberTxn = {
  id: string; date: string; name: string; merchant: string | null; amount: number;
  currency: string | null; category: string | null;
  account: string; account_mask: string | null; account_institution: string | null;
};

const field = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" };
const STATES = ["active", "trial", "cancelled"] as const;
const TYPES = ["", "subscription", "obligation", "membership", "other"] as const;
const SWATCHES = ["var(--info)", "var(--good)", "var(--warn)", "#f472b6", "#a78bfa", "#22d3ee", "#fb923c", "#94a3b8"];

type CancelGuide = { steps: string[]; email: string; difficulty: string | null; sources: { title: string; url: string }[] };

export function SubscriptionDetailModal({
  id, onClose, onApplied, onTxn,
}: {
  id: string;
  onClose: () => void;
  onApplied: () => void;
  onTxn?: (id: string) => void;
}) {
  const z = useModalZ();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [txns, setTxns] = useState<MemberTxn[]>([]);
  const [err, setErr] = useState(false);

  const [state, setState] = useState("active");
  const [type, setType] = useState("");
  const [cat, setCat] = useState("");
  const [merch, setMerch] = useState("");
  const [entity, setEntity] = useState("personal");
  const [trialEnds, setTrialEnds] = useState("");
  const [note, setNote] = useState("");
  const [color, setColor] = useState("");
  const [icon, setIcon] = useState("");
  const [workMove, setWorkMove] = useState("");
  const [base, setBase] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // AI cancel-guide (opt-in; web + local model).
  const [guide, setGuide] = useState<CancelGuide | null>(null);
  const [guideBusy, setGuideBusy] = useState(false);
  const [guideErr, setGuideErr] = useState<string | null>(null);

  // ✨ AI-suggest the real merchant behind a cryptic name ("RENEWAL MEMBERSHIP
  // FEE" → the actual vendor). Reuses the transaction /identify route on the most
  // recent member charge: web-searches the descriptor (only it leaves your network),
  // the local model names it. Fills the Merchant field as a staged edit you review.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<{ explanation: string | null; confidence: string | null } | null>(null);
  const [suggestErr, setSuggestErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setSub(null); setErr(false); setSaved(false); setGuide(null); setGuideErr(null);
    fetch(`/api/subscriptions/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((x: { sub: Subscription; txns: MemberTxn[] }) => {
        if (!live) return;
        setSub(x.sub); setTxns(x.txns ?? []);
        const s = x.sub.state ?? "active", ty = x.sub.type ?? "", c = x.sub.category ?? "";
        const m = x.sub.merchant ?? "", e = x.sub.entity ?? "personal", tr = x.sub.trialEnds ?? "", n = x.sub.note ?? "";
        const col = x.sub.color ?? "", ic = x.sub.icon ?? "", wm = x.sub.workMove ?? "";
        setState(s); setType(ty); setCat(c); setMerch(m); setEntity(e); setTrialEnds(tr); setNote(n); setColor(col); setIcon(ic); setWorkMove(wm);
        setBase({ state: s, type: ty, category: c, merchant: m, entity: e, trial_ends: tr, note: n, color: col, icon: ic, work_move: wm });
      })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [id]);

  const cur: Record<string, string> = { state, type, category: cat, merchant: merch, entity, trial_ends: trialEnds, note, color, icon, work_move: workMove };

  const loadGuide = () => {
    setGuideBusy(true); setGuideErr(null); setGuide(null);
    fetch(`/api/subscriptions/${encodeURIComponent(id)}/cancel-guide`)
      .then((r) => r.json())
      .then((x) => { x.error ? setGuideErr(x.error) : setGuide(x); })
      .catch(() => setGuideErr("lookup failed"))
      .finally(() => setGuideBusy(false));
  };
  const suggestMerchant = async () => {
    setSuggesting(true); setSuggestErr(null); setSuggestion(null);
    const r = await fetch(`/api/subscriptions/${encodeURIComponent(id)}/identify`, { method: "POST" })
      .then((x) => x.json()).catch(() => null);
    setSuggesting(false);
    if (!r || r.error) { setSuggestErr("Couldn't identify — model may be cold, try again"); return; }
    const name = (r.suggestedName || r.merchant || "").trim();
    if (!name) { setSuggestErr("No confident match — edit the name yourself"); return; }
    setMerch(name);
    setSuggestion({ explanation: r.explanation ?? null, confidence: r.confidence ?? null });
  };

  const dirty = base != null && Object.keys(cur).some((k) => cur[k] !== base[k]);

  const save = async () => {
    if (!base || !dirty) return;
    setSaving(true);
    const body: Record<string, string> = {};
    for (const k of Object.keys(cur)) if (cur[k] !== base[k]) body[k] = cur[k];
    const res = await fetch(`/api/subscriptions/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json()).catch(() => null);
    setSaving(false);
    if (res?.ok) { setBase({ ...cur }); setSaved(true); onApplied(); }
  };

  // Price-history bars: one per charge. The last bar is amber when the latest
  // charge sits above the average (a price hike), the same signal as the row flag.
  const amts = txns.map((t) => Math.abs(t.amount));
  const max = Math.max(...amts, 1);
  const hiked = (sub?.priceChange ?? 0) > 1;

  return (
    <div onClick={onClose} className="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 sm:p-8" style={{ zIndex: z, background: "var(--overlay)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-2xl p-5" style={{ ...panel, marginTop: "4vh" }}>
        {/* Header */}
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold">{sub?.merchant ?? "Subscription"}</div>
            {sub && (
              <div className="text-xs" style={{ color: "var(--muted)" }}>
                <span className="tabular-nums" style={{ color: "var(--text)" }}>{money(sub.monthly)}/mo</span>
                {" · "}{sub.cadence}{" · "}{money(sub.lastAmount)}/charge
                {sub.firstDate ? ` · since ${sub.firstDate}` : ""}
                {!sub.isActive ? " · inactive" : ""}
              </div>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-lg px-2 py-1 text-sm" style={field}>✕</button>
        </div>

        {err && <div className="rounded-lg p-3 text-sm" style={{ color: "var(--bad)", background: "var(--bg)" }}>Couldn’t load this subscription.</div>}
        {!sub && !err && <div className="p-6 text-center text-sm" style={{ color: "var(--muted)" }}>Loading…</div>}

        {sub && (
          <>
            {/* Price history */}
            {amts.length > 1 && (
              <div className="mb-3 rounded-xl p-3" style={{ background: "var(--bg)" }}>
                <div className="mb-1.5 flex items-center justify-between text-xs" style={{ color: "var(--muted)" }}>
                  <span>Charge history</span><span>{amts.length} charges{hiked ? " · price rose" : ""}</span>
                </div>
                <div className="flex items-end gap-1" style={{ height: 56 }}>
                  {txns.map((t, i) => (
                    <div key={t.id} className="min-w-0 flex-1 rounded-t" title={`${t.date}: ${money(Math.abs(t.amount))}`}
                      style={{ height: `${Math.max(3, (Math.abs(t.amount) / max) * 100)}%`, minHeight: 2,
                        background: hiked && i === txns.length - 1 ? "var(--warn-strong)" : "var(--accent)" }} />
                  ))}
                </div>
                <div className="mt-1 flex justify-between" style={{ color: "var(--muted)", fontSize: 10 }}>
                  <span>{txns[0]?.date}</span><span>{txns[txns.length - 1]?.date}</span>
                </div>
              </div>
            )}

            {/* Editable curated fields */}
            <div className="flex flex-col gap-3 rounded-xl p-3" style={{ background: "var(--bg)" }}>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span style={{ color: "var(--muted)" }}>Status</span>
                <select value={state} onChange={(e) => setState(e.target.value)} className="rounded px-2 py-1 text-xs" style={field}>
                  {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span style={{ color: "var(--muted)" }}>Type</span>
                <select value={type} onChange={(e) => setType(e.target.value)} className="rounded px-2 py-1 text-xs" style={field}>
                  {TYPES.map((t) => <option key={t} value={t}>{t || "unset"}</option>)}
                </select>
              </label>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span style={{ color: "var(--muted)" }}>Category</span>
                <CategorySelect value={cat || null} onChange={setCat} />
              </label>
              <div className="flex flex-col gap-1 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="shrink-0" style={{ color: "var(--muted)" }}>Merchant</span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <input value={merch} onChange={(e) => setMerch(e.target.value)}
                      className="min-w-0 flex-1 rounded px-2 py-1 text-sm" style={field} />
                    <button type="button" onClick={suggestMerchant} disabled={suggesting}
                      title="AI-suggest the real merchant from the web (only the descriptor leaves your network)"
                      className="shrink-0 rounded px-1.5 py-1 text-sm" style={{ ...field, color: "var(--accent)", opacity: suggesting ? 0.6 : 1 }}>
                      {suggesting ? "…" : "✨"}
                    </button>
                  </span>
                </div>
                {suggestErr && <span className="pl-[4.5rem] text-xs" style={{ color: "var(--bad)" }}>{suggestErr}</span>}
                {suggestion && (
                  <div className="rounded-lg px-2 py-1.5 text-xs" style={{ background: "var(--bg)", color: "var(--muted)" }}>
                    <span style={{ color: "var(--accent)" }}>✨ filled in</span>
                    {suggestion.confidence ? ` · ${suggestion.confidence} confidence` : ""}. {suggestion.explanation ?? ""} <span style={{ color: "var(--text)" }}>Review &amp; Save.</span>
                  </div>
                )}
              </div>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span style={{ color: "var(--muted)" }}>Entity</span>
                <EntityToggle value={entity} onChange={setEntity} />
              </label>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span style={{ color: "var(--muted)" }} title="Tag a sub on your personal card that should move to a work card (handy mid-employer-change)">Work card</span>
                <select value={workMove} onChange={(e) => setWorkMove(e.target.value)} className="rounded px-2 py-1 text-xs" style={field}>
                  <option value="">personal (no plan)</option>
                  <option value="pending">move to work card</option>
                  <option value="moved">moved to work card</option>
                </select>
              </label>
              {state === "trial" && (
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span style={{ color: "var(--muted)" }}>Trial ends</span>
                  <input type="date" value={trialEnds} onChange={(e) => setTrialEnds(e.target.value)}
                    className="rounded px-2 py-1 text-xs" style={field} />
                </label>
              )}
              <div className="flex items-center justify-between gap-3 text-sm">
                <span style={{ color: "var(--muted)" }}>Identity</span>
                <span className="flex items-center gap-1.5">
                  <input value={icon} onChange={(e) => setIcon(e.target.value.slice(0, 2))} placeholder="🎬"
                    className="w-10 rounded px-1 py-1 text-center text-sm" style={field} title="An emoji icon for this subscription" />
                  {SWATCHES.map((c) => (
                    <button key={c} onClick={() => setColor(color === c ? "" : c)} aria-label={`colour ${c}`}
                      className="h-5 w-5 rounded-full" style={{ background: c, outline: color === c ? "2px solid var(--text)" : "none", outlineOffset: 1 }} />
                  ))}
                </span>
              </div>
              <div className="flex flex-col gap-1 text-sm">
                <span style={{ color: "var(--muted)" }}>Notes</span>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                  placeholder="Why you keep it, when to revisit, login used…"
                  className="w-full rounded px-2 py-1 text-sm" style={field} />
              </div>
            </div>

            <div className="mt-3 flex items-center gap-3">
              <button onClick={save} disabled={!dirty || saving}
                className="rounded-lg px-4 py-2 text-sm font-medium" style={{ background: "var(--accent-deep)", color: "white", opacity: !dirty || saving ? 0.5 : 1 }}>
                {saving ? "Saving…" : "Save changes"}
              </button>
              {saved && !dirty && <span className="text-xs" style={{ color: "var(--good)" }}>✓ Saved</span>}
            </div>

            {/* AI cancel-guide */}
            <div className="mt-4">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>How to cancel</span>
                {guide?.difficulty && <span className="rounded px-1.5 py-0.5 text-xs" style={{ ...field }}>{guide.difficulty}</span>}
              </div>
              {!guide && (
                <button type="button" onClick={loadGuide} disabled={guideBusy}
                  className="rounded px-2 py-1 text-xs" style={{ ...field, color: "var(--accent)" }}
                  title="Web-search how to cancel this merchant + draft an email. Only the merchant name leaves your network.">
                  {guideBusy ? "Looking up…" : "✨ Show me how to cancel"}
                </button>
              )}
              {guideErr && <span className="text-xs" style={{ color: "var(--bad)" }}>{guideErr}</span>}
              {guide && (
                <div className="rounded-lg p-3 text-sm" style={{ background: "var(--bg)" }}>
                  <ol className="ml-4 list-decimal space-y-1" style={{ color: "var(--text)" }}>
                    {guide.steps.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                  {guide.email && (
                    <div className="mt-2">
                      <div className="mb-1 flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                        Draft email
                        <button type="button" onClick={() => navigator.clipboard?.writeText(guide.email)} className="rounded px-1.5 py-0.5" style={{ ...field, color: "var(--accent)" }}>Copy</button>
                      </div>
                      <textarea readOnly value={guide.email} rows={4} className="w-full rounded px-2 py-1 text-xs" style={field} />
                    </div>
                  )}
                  {guide.sources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-x-2 text-xs" style={{ color: "var(--muted)" }}>
                      {guide.sources.map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer" className="truncate" style={{ color: "var(--accent)", maxWidth: 160 }}>↗ {s.title || s.url}</a>)}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Member charges */}
            {txns.length > 0 && (
              <>
                <div className="mt-4 text-xs font-medium" style={{ color: "var(--muted)" }}>Charges</div>
                <div className="mt-1 rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
                  {[...txns].reverse().slice(0, 24).map((t, i) => (
                    <button key={t.id} onClick={() => onTxn?.(t.id)} disabled={!onTxn}
                      className="flex w-full items-center gap-2 p-2 text-left text-sm" style={{ borderTop: i ? "1px solid var(--border)" : undefined }}
                      title={onTxn ? "Open transaction detail" : undefined}>
                      <span className="w-20 shrink-0 text-xs" style={{ color: "var(--muted)" }}>{t.date}</span>
                      <span className="min-w-0 flex-1 truncate text-xs" style={{ color: "var(--muted)" }}>
                        {acctLabel(t.account, t.account_mask, t.account_institution)}{t.category ? ` · ${prettyCategory(t.category)}` : ""}
                      </span>
                      <span className="shrink-0 tabular-nums">{money(Math.abs(t.amount), t.currency ?? "USD")}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
