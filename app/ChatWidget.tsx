"use client";

import { useEffect, useRef, useState } from "react";
import { CATEGORIES } from "@/lib/taxonomy";

type Proposal = {
  kind: "proposal"; summary: string;
  changes: Record<string, string | boolean>; ids: string[];
  preview: { id: string; date: string; label: string; amount: number; category: string | null; entity: string }[];
};
type BatchItem = { id: string; label: string; amount: number; current: string | null; suggested: string };
type Msg = {
  id?: number; role: "user" | "assistant"; content: string;
  model?: string | null; sql?: string | null;
  proposal?: Proposal; batch?: BatchItem[]; applied?: boolean; dismissed?: boolean;
};
type ModelInfo = { id: string; label: string; location: "local" | "remote"; provider: string; blurb?: string };
type Size = "min" | "normal" | "expanded";

function money(n: number, cur = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n);
}

function shortModel(models: ModelInfo[], id: string | null | undefined) {
  return models.find((m) => m.id === id)?.label ?? (id ?? "");
}

const EXAMPLES = [
  "Biggest expenses last 30 days",
  "How much did I pay Jen this month?",
  "Total income this year",
  "Spending by category last month",
];

// Mac-style stoplight button.
function Light({ color, title, onClick, glyph }: { color: string; title: string; onClick: () => void; glyph: string }) {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      style={{
        width: 13, height: 13, borderRadius: 7, background: color, border: "none",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontSize: 9, lineHeight: 1, color: "rgba(0,0,0,.55)", fontWeight: 700,
      }}
      className="stoplight"
    >{glyph}</button>
  );
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<Size>("normal");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<string>("");
  const current = models.find((m) => m.id === model);
  const isRemote = current?.location === "remote";
  const [showSqlFor, setShowSqlFor] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/models").then((r) => r.json()).then((d) => {
      const list: ModelInfo[] = d.models ?? [];
      setModels(list);
      setModel(d.default ?? list[0]?.id ?? "");
    });
    fetch("/api/chat").then((r) => r.json()).then((d) => setMsgs(d.messages ?? []));
  }, []);

  useEffect(() => {
    if (open && size !== "min" && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [msgs, open, busy, size]);

  const send = async (override?: string) => {
    const question = (override ?? q).trim();
    if (!question || busy) return;
    setQ("");
    setMsgs((m) => [...m, { role: "user", content: question, model }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, model }),
      });
      const r = await res.json();
      if (r.batch) {
        setMsgs((m) => [...m, { role: "assistant", content: `Suggested categories for ${r.batch.items.length} transactions — tweak and apply:`, model, batch: r.batch.items }]);
      } else if (r.proposal) {
        // Edit intent: show a confirm card instead of an answer.
        setMsgs((m) => [...m, { role: "assistant", content: r.proposal.summary, model, proposal: r.proposal }]);
      } else {
        setMsgs((m) => [...m, { role: "assistant", content: r.answer ?? (r.error ? `⚠ ${r.error}` : "no answer"), model, sql: r.sql }]);
      }
    } catch (e: unknown) {
      setMsgs((m) => [...m, { role: "assistant", content: `⚠ ${e instanceof Error ? e.message : String(e)}` }]);
    }
    setBusy(false);
  };

  const applyProposal = async (idx: number, p: Proposal) => {
    const res = await fetch("/api/chat/apply", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: p.ids, changes: p.changes, summary: p.summary }),
    });
    const r = await res.json();
    setMsgs((m) => m.map((msg, i) => i === idx ? { ...msg, applied: true } : msg));
    setMsgs((m) => [...m, { role: "assistant", content: r.ok ? `✓ Updated ${r.updated} transaction${r.updated === 1 ? "" : "s"}.` : `⚠ ${r.error}` }]);
  };
  const dismissProposal = (idx: number) =>
    setMsgs((m) => m.map((msg, i) => i === idx ? { ...msg, dismissed: true } : msg));

  const setBatchCat = (msgIdx: number, itemId: string, cat: string) =>
    setMsgs((m) => m.map((msg, i) =>
      i === msgIdx && msg.batch
        ? { ...msg, batch: msg.batch.map((b) => b.id === itemId ? { ...b, suggested: cat } : b) }
        : msg));

  const applyBatchMsg = async (idx: number, items: BatchItem[]) => {
    const payload = items.map((b) => ({ id: b.id, category: b.suggested }));
    const res = await fetch("/api/chat/batch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: payload }),
    });
    const r = await res.json();
    setMsgs((m) => m.map((msg, i) => i === idx ? { ...msg, applied: true } : msg));
    setMsgs((m) => [...m, { role: "assistant", content: r.ok ? `✓ Categorized ${r.updated} transaction${r.updated === 1 ? "" : "s"}.` : `⚠ ${r.error}` }]);
  };

  const clearHistory = async () => { await fetch("/api/chat", { method: "DELETE" }); setMsgs([]); };

  // --- Launcher bubble (fully closed) ---
  if (!open) {
    return (
      <button onClick={() => { setOpen(true); setSize("normal"); }} aria-label="Open money chat"
        style={{
          position: "fixed", bottom: 20, right: 20, zIndex: 50,
          width: 56, height: 56, borderRadius: 28, background: "var(--accent-deep)", color: "white",
          boxShadow: "0 6px 20px rgba(0,0,0,.4)", fontSize: 22,
        }}>💬</button>
    );
  }

  // --- Sizing per state ---
  const dims =
    size === "min" ? { width: 280, height: 46 }
    : size === "expanded" ? { width: "min(820px, calc(100vw - 40px))", height: "calc(100vh - 40px)" }
    : { width: "min(460px, calc(100vw - 32px))", height: "min(640px, calc(100vh - 40px))" };

  return (
    <div
      style={{
        position: "fixed", bottom: 20, right: 20, zIndex: 50,
        ...dims, display: "flex", flexDirection: "column",
        background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 14,
        boxShadow: "0 10px 40px rgba(0,0,0,.5)", overflow: "hidden",
        transition: "width .18s ease, height .18s ease",
      }}
    >
      {/* title bar with Mac stoplights */}
      <div
        onDoubleClick={() => setSize(size === "expanded" ? "normal" : "expanded")}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: size === "min" ? "none" : "1px solid var(--border)", cursor: "default", flexShrink: 0 }}
      >
        <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
          <Light color="#ff5f57" title="Close" glyph="×" onClick={() => setOpen(false)} />
          <Light color="#febc2e" title={size === "min" ? "Restore" : "Minimize"} glyph="–" onClick={() => setSize(size === "min" ? "normal" : "min")} />
          <Light color="#28c840" title={size === "expanded" ? "Shrink" : "Expand"} glyph={size === "expanded" ? "▾" : "▴"} onClick={() => setSize(size === "expanded" ? "normal" : "expanded")} />
        </div>
        <span style={{ fontWeight: 600, fontSize: 13, marginLeft: 4 }}>Chat with your money</span>
        {size !== "min" && (
          <>
            <select value={model} onChange={(e) => setModel(e.target.value)}
              title={current?.blurb ?? ""}
              style={{ marginLeft: "auto", background: "var(--bg)", border: `1px solid ${isRemote ? "var(--warn-strong)" : "var(--border)"}`, color: "var(--text)", borderRadius: 6, fontSize: 11, padding: "2px 4px", maxWidth: 180 }}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.location === "local" ? "🏠 " : "☁️ "}{m.label}</option>
              ))}
            </select>
            <button onClick={clearHistory} title="Clear history" style={{ color: "var(--muted)", fontSize: 14 }}>🗑</button>
          </>
        )}
        {size === "min" && msgs.length > 0 && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted)" }}>{msgs.length} msgs</span>
        )}
      </div>

      {/* everything below the title bar hides when minimized */}
      {size !== "min" && (
        <>
          {isRemote && (
            <div style={{ background: "rgba(245,158,11,.12)", color: "var(--warn)", fontSize: 11, padding: "6px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
              ⚠ {current?.provider}: your transaction data leaves your network to answer. Pick a 🏠 Local model to keep it private.
            </div>
          )}

          <div ref={bodyRef} style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            {msgs.length === 0 && (
              <div style={{ margin: "auto", textAlign: "center", padding: 8, width: "100%", maxWidth: 380 }}>
                <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12 }}>Ask about your money, or try one:</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {EXAMPLES.map((ex) => (
                    <button key={ex} onClick={() => send(ex)} disabled={busy}
                      style={{
                        textAlign: "left", padding: "9px 12px", borderRadius: 10, fontSize: 13,
                        background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)",
                        display: "flex", alignItems: "center", gap: 8, opacity: busy ? 0.5 : 1,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
                    >
                      <span style={{ color: "var(--accent)" }}>›</span>{ex}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={m.id ?? i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: size === "expanded" ? "75%" : "88%" }}>
                <div style={{
                  padding: "9px 12px", borderRadius: 12, fontSize: 14, lineHeight: 1.5,
                  background: m.role === "user" ? "var(--accent-deep)" : "var(--bg)",
                  color: m.role === "user" ? "white" : "var(--text)",
                  border: m.role === "user" ? "none" : "1px solid var(--border)",
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                }}>{m.content}</div>
                {m.role === "assistant" && (m.sql || m.model) && (
                  <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3, paddingLeft: 2 }}>
                    {m.model ? shortModel(models, m.model) : ""}
                    {m.sql && <button onClick={() => setShowSqlFor(showSqlFor === i ? null : i)} style={{ marginLeft: 6, color: "var(--accent)" }}>{showSqlFor === i ? "hide SQL" : "show SQL"}</button>}
                  </div>
                )}
                {m.role === "assistant" && m.sql && showSqlFor === i && (
                  <pre style={{ fontSize: 11, color: "var(--muted)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 8, marginTop: 4, overflowX: "auto", whiteSpace: "pre-wrap" }}>{m.sql}</pre>
                )}
                {m.proposal && (
                  <div style={{ marginTop: 6, border: "1px solid var(--accent)", borderRadius: 10, padding: 10, background: "var(--bg)", maxWidth: 360 }}>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
                      Change: {Object.entries(m.proposal.changes).map(([k, v]) => `${k} → ${v}`).join(", ")}
                    </div>
                    {m.proposal.preview.slice(0, 4).map((p) => (
                      <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0", borderTop: "1px solid var(--border)" }}>
                        <span style={{ color: "var(--muted)" }}>{p.date}</span>
                        <span style={{ flex: 1, margin: "0 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label}</span>
                        <span>{money(-p.amount)}</span>
                      </div>
                    ))}
                    {m.proposal.preview.length > 4 && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>+{m.proposal.preview.length - 4} more</div>}
                    {!m.applied && !m.dismissed && (
                      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        <button onClick={() => applyProposal(i, m.proposal!)} style={{ flex: 1, background: "var(--accent-deep)", color: "white", borderRadius: 7, padding: "6px 0", fontSize: 13, fontWeight: 500 }}>Apply</button>
                        <button onClick={() => dismissProposal(i)} style={{ background: "var(--panel)", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: 7, padding: "6px 12px", fontSize: 13 }}>Dismiss</button>
                      </div>
                    )}
                    {m.applied && <div style={{ fontSize: 12, color: "var(--good)", marginTop: 8 }}>✓ Applied</div>}
                    {m.dismissed && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>Dismissed</div>}
                  </div>
                )}
                {m.batch && (
                  <div style={{ marginTop: 6, border: "1px solid var(--accent)", borderRadius: 10, padding: 10, background: "var(--bg)", maxWidth: size === "expanded" ? 560 : 380 }}>
                    {m.batch.map((b) => (
                      <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "5px 0", borderTop: "1px solid var(--border)" }}>
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={b.label}>{b.label}</span>
                        <span style={{ color: "var(--muted)", minWidth: 64, textAlign: "right" }}>{money(-b.amount)}</span>
                        <select value={b.suggested} disabled={m.applied}
                          onChange={(e) => setBatchCat(i, b.id, e.target.value)}
                          style={{ background: "var(--panel)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 6, fontSize: 11, padding: "2px 4px", maxWidth: 130 }}>
                          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                    ))}
                    {!m.applied && !m.dismissed && (
                      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        <button onClick={() => applyBatchMsg(i, m.batch!)} style={{ flex: 1, background: "var(--accent-deep)", color: "white", borderRadius: 7, padding: "6px 0", fontSize: 13, fontWeight: 500 }}>Apply all ({m.batch.length})</button>
                        <button onClick={() => dismissProposal(i)} style={{ background: "var(--panel)", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: 7, padding: "6px 12px", fontSize: 13 }}>Dismiss</button>
                      </div>
                    )}
                    {m.applied && <div style={{ fontSize: 12, color: "var(--good)", marginTop: 8 }}>✓ Applied</div>}
                    {m.dismissed && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>Dismissed</div>}
                  </div>
                )}
              </div>
            ))}
            {busy && <div style={{ alignSelf: "flex-start", color: "var(--muted)", fontSize: 13, padding: "8px 10px" }}><span className="typing">thinking</span></div>}
          </div>

          <div style={{ display: "flex", gap: 6, padding: 10, borderTop: "1px solid var(--border)", flexShrink: 0 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }}
              placeholder="Ask about your money…" autoFocus
              style={{ flex: 1, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 8, padding: "9px 11px", fontSize: 14, outline: "none" }} />
            <button onClick={() => send()} disabled={busy}
              style={{ background: "var(--accent-deep)", color: "white", borderRadius: 8, padding: "0 16px", fontSize: 14, fontWeight: 500, opacity: busy ? 0.6 : 1 }}>
              {busy ? "…" : "Send"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
