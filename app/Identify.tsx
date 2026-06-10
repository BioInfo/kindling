"use client";

import { useEffect, useState } from "react";
import { panel, useModalZ } from "./ui";

// Only needs the id (to call identify) and the raw descriptor (to show). Kept
// minimal so both the main feed and the account-detail modal can trigger it.
type IdTxn = { id: string; name: string };

type Result = {
  raw: string; merchant: string | null; explanation: string | null;
  suggestedName: string | null; suggestedPattern: string; category: string | null;
  confidence: string | null; sources: { title: string; url: string }[];
};

const fieldStyle = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" };

// Click a transaction → AI looks up the cryptic descriptor (web search via the
// configured gateway) and proposes a clean name + a rename rule for all similar
// charges. Approving creates the rule with applyNow so every match is renamed.
export function IdentifyModal({ txn, onClose, onApplied }: { txn: IdTxn; onClose: () => void; onApplied: () => void }) {
  const z = useModalZ();
  const [r, setR] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  // Escape is the deliberate keyboard dismiss. There is intentionally NO
  // click-outside-to-close (see the backdrop below): this modal holds an
  // editable recommendation + a slow web/LLM lookup, so a stray backdrop click
  // shouldn't discard your edits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    setR(null); setErr(null); setDone(null);
    fetch(`/api/transactions/${encodeURIComponent(txn.id)}/identify`, { method: "POST" })
      .then((x) => x.json())
      .then((d) => {
        if (d.error) { setErr(d.error); return; }
        setR(d); setName(d.suggestedName ?? d.merchant ?? ""); setPattern(d.suggestedPattern ?? "");
      })
      .catch((e) => setErr(String(e)));
  }, [txn.id]);

  const createRule = async () => {
    if (!pattern.trim() || !name.trim()) return;
    setBusy(true);
    const res = await fetch("/api/rules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pattern: pattern.trim(), field: "name", rename: name.trim(), category: r?.category || undefined, applyNow: true }),
    }).then((x) => x.json()).catch(() => null);
    setBusy(false);
    if (res?.ok) { setDone(res.applied ?? 0); onApplied(); }
  };

  // Backdrop dims the page but does NOT close on click — only the ✕, the
  // post-apply link, or Escape dismiss. Keeps an accidental outside-click from
  // throwing away the AI result and any edits in progress.
  return (
    <div className="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 sm:p-8" style={{ zIndex: z, background: "var(--overlay)" }}>
      <div className="w-full max-w-xl rounded-2xl p-5" style={{ ...panel, marginTop: "6vh" }}>
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>Identify merchant</div>
            <div className="font-mono text-sm">{txn.name}</div>
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-sm" style={fieldStyle}>✕</button>
        </div>

        {err && <div className="rounded-lg p-3 text-sm" style={{ color: "var(--bad)", background: "var(--bg)" }}>Couldn’t identify: {err}</div>}
        {!r && !err && <div className="p-6 text-center text-sm" style={{ color: "var(--muted)" }}>Searching the web + asking the local model…</div>}

        {r && (
          <>
            <div className="rounded-xl p-3 text-sm" style={{ background: "var(--bg)" }}>
              <div className="font-medium">{r.merchant ?? "Unknown merchant"}
                {r.confidence && <span className="ml-2 rounded px-1.5 py-0.5 text-xs" style={{ color: "var(--muted)", border: "1px solid var(--border)" }}>{r.confidence} confidence</span>}
              </div>
              {r.explanation && <p className="mt-1" style={{ color: "var(--muted)" }}>{r.explanation}</p>}
              {r.sources.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  {r.sources.map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>↗ {s.title.slice(0, 40)}</a>)}
                </div>
              )}
            </div>

            <div className="mt-3 text-sm font-medium">Rename all similar charges</div>
            <div className="mt-1 flex flex-col gap-2">
              <label className="text-xs" style={{ color: "var(--muted)" }}>Display name
                <input value={name} onChange={(e) => setName(e.target.value)} className="mt-0.5 w-full rounded px-2 py-1 text-sm" style={fieldStyle} />
              </label>
              <label className="text-xs" style={{ color: "var(--muted)" }}>Match any transaction whose raw descriptor contains
                <input value={pattern} onChange={(e) => setPattern(e.target.value)} className="mt-0.5 w-full rounded px-2 py-1 font-mono text-sm" style={fieldStyle} />
              </label>
              {r.category && <div className="text-xs" style={{ color: "var(--muted)" }}>Will also set category → <b>{r.category}</b></div>}
            </div>

            {done == null ? (
              <button onClick={createRule} disabled={busy || !pattern.trim() || !name.trim()}
                className="mt-3 rounded-lg px-4 py-2 text-sm font-medium" style={{ background: "var(--accent-deep)", color: "white", opacity: busy ? 0.6 : 1 }}>
                {busy ? "Applying…" : "Create rule & rename all matching"}
              </button>
            ) : (
              <div className="mt-3 rounded-lg p-3 text-sm" style={{ background: "var(--bg)", color: "var(--good)" }}>
                ✓ Rule saved · renamed {done} transaction{done === 1 ? "" : "s"}. <button onClick={onClose} className="underline" style={{ color: "var(--accent)" }}>close</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
