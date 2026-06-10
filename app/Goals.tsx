"use client";

import { useEffect, useState } from "react";
import { money, panel } from "./ui";

type Contribution = { amount: number; source: string; date: string };
type UnderspendSource = { category: string; remaining: number };
type GoalRow = {
  id: number; name: string; target: number; saved: number; deadline: string | null;
  pct: number; remaining: number; done: boolean;
  monthsLeft: number | null; perMonth: number | null; overdue: boolean;
  contributions: Contribution[];
};
export type GoalsData = {
  goals: GoalRow[]; totalTarget: number; totalSaved: number; monthlySavings: number;
  underspendSources: UnderspendSource[];
};

async function patch(body: Record<string, unknown>) {
  await fetch("/api/goals", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function create(body: Record<string, unknown>) {
  await fetch("/api/goals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function del(id: number) {
  await fetch(`/api/goals?id=${id}`, { method: "DELETE" });
}
async function contribute(id: number, amount: number, source?: string) {
  await fetch(`/api/goals/${id}/contribute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount, source }) });
}

// Human-readable origin for a contribution row.
function prettySource(s: string): string {
  if (s.startsWith("underspend:")) return `${s.slice(11)} underspend`;
  if (s === "manual") return "deposit";
  if (s === "initial") return "opening balance";
  if (s === "adjustment") return "adjustment";
  return s; // free-text note
}

const fieldStyle = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" };

function GoalCard({ g, monthlySavings, underspendSources, reload }: { g: GoalRow; monthlySavings: number; underspendSources: UnderspendSource[]; reload: () => void }) {
  const [name, setName] = useState(g.name);
  const [saved, setSaved] = useState(String(g.saved));
  const [target, setTarget] = useState(String(g.target));
  const [depOpen, setDepOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [amt, setAmt] = useState("");
  const [note, setNote] = useState("");
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pct = Math.min(100, Math.max(0, g.pct * 100));
  const color = g.done ? "var(--good)" : g.overdue ? "var(--bad)" : "var(--accent)";
  const aheadOfPace = g.perMonth != null && monthlySavings > 0 && g.perMonth > monthlySavings;

  const commitName = () => { if (name.trim() && name !== g.name) { patch({ id: g.id, name }).then(reload); } };
  const commitNum = (key: "saved" | "target", val: string, prev: number) => {
    const n = Number(val);
    if (Number.isFinite(n) && n >= 0 && n !== prev) patch({ id: g.id, [key]: n }).then(reload);
  };
  const addDeposit = async () => {
    const n = Number(amt);
    if (!Number.isFinite(n) || n <= 0) return;
    setBusy(true);
    await contribute(g.id, n, pendingSource || (note.trim() || "manual"));
    setAmt(""); setNote(""); setPendingSource(null); setDepOpen(false); setBusy(false);
    reload();
  };

  return (
    <div className="rounded-xl p-4" style={panel}>
      <div className="mb-2 flex items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="flex-1 min-w-0 rounded px-2 py-1 font-medium" style={fieldStyle} />
        <input type="date" value={g.deadline ?? ""} onChange={(e) => patch({ id: g.id, deadline: e.target.value || null }).then(reload)}
          className="rounded px-2 py-1 text-xs" style={fieldStyle} title="optional deadline" />
        <button onClick={() => del(g.id).then(reload)} title="delete goal"
          className="rounded px-1.5 py-0.5 text-xs" style={{ background: "var(--bg)", color: "var(--bad)", border: "1px solid var(--border)" }}>×</button>
      </div>

      <div className="mb-1.5 h-2 rounded-full" style={{ background: "var(--bg)" }}>
        <div className="h-2 rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span style={{ color: "var(--muted)" }}>
          <input value={saved} onChange={(e) => setSaved(e.target.value)} onBlur={() => commitNum("saved", saved, g.saved)}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            inputMode="decimal" className="w-24 rounded px-2 py-0.5 text-right" style={fieldStyle} /> saved
        </span>
        <span style={{ color: "var(--muted)" }}>of
          <input value={target} onChange={(e) => setTarget(e.target.value)} onBlur={() => commitNum("target", target, g.target)}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            inputMode="decimal" className="ml-1 w-24 rounded px-2 py-0.5 text-right" style={fieldStyle} />
        </span>
        <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>{Math.round(g.pct * 100)}%</span>
      </div>

      <div className="mt-2 text-xs">
        {g.done ? (
          <span style={{ color: "var(--good)" }}>✓ Funded · {money(g.target)} reached</span>
        ) : g.overdue ? (
          <span style={{ color: "var(--bad)" }}>Past {g.deadline} · {money(g.remaining)} still needed</span>
        ) : g.perMonth != null ? (
          <span style={{ color: aheadOfPace ? "var(--warn)" : "var(--muted)" }}>
            {money(g.perMonth)}/mo to hit by {g.deadline}{g.monthsLeft != null ? ` · ${g.monthsLeft} mo left` : ""}
            {aheadOfPace ? ` · above your recent ${money(monthlySavings)}/mo` : ""}
          </span>
        ) : (
          <span style={{ color: "var(--muted)" }}>{money(g.remaining)} to go · set a deadline for a monthly target</span>
        )}
      </div>

      {/* deposit + history actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        {!g.done && (
          <button onClick={() => setDepOpen((v) => !v)} className="rounded-lg px-2.5 py-1 font-medium"
            style={{ background: depOpen ? "var(--bg)" : "var(--accent)", color: depOpen ? "var(--text)" : "white", border: "1px solid var(--border)" }}>
            {depOpen ? "Cancel" : "+ Add deposit"}
          </button>
        )}
        {g.contributions.length > 0 && (
          <button onClick={() => setHistOpen((v) => !v)} className="rounded-lg px-2 py-1"
            style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--muted)" }}>
            {g.contributions.length} deposit{g.contributions.length === 1 ? "" : "s"} {histOpen ? "▴" : "▾"}
          </button>
        )}
      </div>

      {depOpen && (
        <div className="mt-2 rounded-xl p-3" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <span style={{ color: "var(--muted)" }}>$</span>
            <input value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="amount" inputMode="decimal" autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") addDeposit(); }}
              className="w-24 rounded px-2 py-1 text-sm" style={fieldStyle} />
            <input value={note} onChange={(e) => { setNote(e.target.value); setPendingSource(null); }} placeholder="note (optional)"
              className="flex-1 min-w-32 rounded px-2 py-1 text-sm" style={fieldStyle} />
            <button onClick={addDeposit} disabled={busy} className="rounded px-3 py-1 text-sm font-medium"
              style={{ background: "var(--accent-deep)", color: "white", opacity: busy ? 0.6 : 1 }}>Add</button>
          </div>
          {pendingSource && (
            <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>funding from {prettySource(pendingSource)}</div>
          )}
          {underspendSources.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 text-xs" style={{ color: "var(--muted)" }}>Quick-fund from this month&apos;s underspend:</div>
              <div className="flex flex-wrap gap-1.5">
                {underspendSources.slice(0, 6).map((s) => (
                  <button key={s.category} onClick={() => { setAmt(String(s.remaining)); setPendingSource(`underspend:${s.category}`); setNote(""); }}
                    className="rounded-full px-2 py-0.5 text-xs" style={{ background: "var(--panel)", border: "1px solid var(--border)", color: "var(--text)" }}>
                    {s.category} · {money(s.remaining)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {histOpen && g.contributions.length > 0 && (
        <div className="mt-2 overflow-hidden rounded-xl" style={{ border: "1px solid var(--border)" }}>
          {g.contributions.map((c, i) => (
            <div key={i} className="flex items-center justify-between px-3 py-1.5 text-xs"
              style={{ borderTop: i ? "1px solid var(--border)" : "none", background: "var(--bg)" }}>
              <span style={{ color: "var(--muted)" }}>{c.date} · {prettySource(c.source)}</span>
              <span style={{ color: c.amount >= 0 ? "var(--good)" : "var(--bad)" }}>{c.amount >= 0 ? "+" : ""}{money(c.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddGoal({ reload }: { reload: () => void }) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [saved, setSaved] = useState("");
  const [deadline, setDeadline] = useState("");
  const add = async () => {
    const t = Number(target);
    if (!name.trim() || !Number.isFinite(t) || t <= 0) return;
    await create({ name, target: t, saved: Number(saved) || 0, deadline: deadline || null });
    setName(""); setTarget(""); setSaved(""); setDeadline(""); reload();
  };
  return (
    <div className="rounded-xl p-4" style={panel}>
      <div className="flex flex-wrap items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="goal name (e.g. Tax set-aside)"
          className="flex-1 min-w-40 rounded px-2 py-1 text-sm" style={fieldStyle} />
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="target $" inputMode="decimal"
          className="w-28 rounded px-2 py-1 text-sm" style={fieldStyle} />
        <input value={saved} onChange={(e) => setSaved(e.target.value)} placeholder="saved $ (opt)" inputMode="decimal"
          className="w-28 rounded px-2 py-1 text-sm" style={fieldStyle} />
        <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)}
          className="rounded px-2 py-1 text-sm" style={fieldStyle} title="optional deadline" />
        <button onClick={add} className="rounded px-3 py-1 text-sm font-medium" style={{ background: "var(--accent-deep)", color: "white" }}>+ Add goal</button>
      </div>
    </div>
  );
}

// Data-grounded suggested goals — review-before-create, mirrors the budget Suggest
// modal. Each proposal's name/target/deadline is editable; drop what you don't want;
// batch-create the kept ones via POST /api/goals. Numbers come from the DB + tax view.
type GoalProposal = { name: string; target: number; deadline: string | null; basis: string; kind: string };
type SuggestGoalsData = { proposals: GoalProposal[]; monthlySavings: number };
const KIND_LABEL: Record<string, string> = { emergency: "Emergency fund", tax: "Tax reserve", event: "Equity-vest reserve" };

function SuggestGoalsModal({ onClose, reload }: { onClose: () => void; reload: () => void }) {
  const [data, setData] = useState<SuggestGoalsData | null>(null);
  const [edits, setEdits] = useState<Record<number, { name: string; target: string; deadline: string }>>({});
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/goals/suggest").then((r) => r.json()).then((d: SuggestGoalsData) => {
      setData(d);
      setEdits(Object.fromEntries(d.proposals.map((p, i) => [i, { name: p.name, target: String(p.target), deadline: p.deadline ?? "" }])));
    });
  }, []);

  const kept = (data?.proposals ?? []).map((p, i) => ({ p, i })).filter(({ i }) => !dropped.has(i));
  const total = kept.reduce((s, { i }) => s + (Number(edits[i]?.target) || 0), 0);
  const upd = (i: number, k: "name" | "target" | "deadline", v: string) => setEdits((e) => ({ ...e, [i]: { ...e[i], [k]: v } }));

  const save = async () => {
    setSaving(true);
    for (const { i } of kept) {
      const e = edits[i]; const t = Number(e.target);
      if (e.name.trim() && Number.isFinite(t) && t > 0) await create({ name: e.name.trim(), target: t, deadline: e.deadline || null });
    }
    reload(); onClose();
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8" style={{ background: "var(--overlay)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-2xl p-5" style={{ ...panel, marginTop: "2vh" }}>
        <div className="mb-1 flex items-start justify-between gap-3">
          <div className="text-lg font-semibold">✨ Suggest goals</div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>✕</button>
        </div>
        <div className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
          {data ? "Grounded in your spending, the tax center's safe-harbor gap, and your upcoming equity vests. Tweak any field, drop what you don't want, then save. Nothing made up." : "Reading your numbers…"}
        </div>
        {!data ? (
          <div className="p-6 text-center text-sm" style={{ color: "var(--muted)" }}>Loading…</div>
        ) : kept.length === 0 ? (
          <div className="rounded-xl p-4 text-center text-sm" style={{ color: "var(--muted)", background: "var(--bg)" }}>
            {data.proposals.length === 0 ? "No suggestions right now — set up the Tax tab and tag some spending, then try again." : "Nothing left to add."}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {kept.map(({ p, i }) => (
              <div key={i} className="rounded-xl p-3" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                <div className="mb-1 flex items-center gap-2">
                  <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: "var(--panel)", color: "var(--muted)" }}>{KIND_LABEL[p.kind] ?? "Goal"}</span>
                  <button onClick={() => setDropped(new Set(dropped).add(i))} title="don't add this one"
                    className="ml-auto rounded px-1.5 py-0.5 text-xs" style={{ background: "var(--panel)", color: "var(--bad)", border: "1px solid var(--border)" }}>×</button>
                </div>
                <input value={edits[i]?.name ?? ""} onChange={(e) => upd(i, "name", e.target.value)}
                  className="mb-1 w-full rounded px-2 py-1 text-sm font-medium" style={fieldStyle} />
                <div className="mb-1 text-xs" style={{ color: "var(--muted)" }}>{p.basis}</div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm" style={{ color: "var(--muted)" }}>$</span>
                  <input value={edits[i]?.target ?? ""} onChange={(e) => upd(i, "target", e.target.value)} inputMode="decimal"
                    className="w-28 rounded px-2 py-1 text-right text-sm" style={fieldStyle} />
                  <input type="date" value={edits[i]?.deadline ?? ""} onChange={(e) => upd(i, "deadline", e.target.value)}
                    className="rounded px-2 py-1 text-sm" style={fieldStyle} title="optional deadline" />
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-sm" style={{ color: "var(--muted)" }}>Total target: <span style={{ color: "var(--text)" }}>{money(total)}</span></span>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>Cancel</button>
            <button onClick={save} disabled={saving || kept.length === 0} className="rounded-lg px-3 py-1.5 text-sm font-medium"
              style={{ background: "var(--accent-deep)", color: "white", opacity: saving || kept.length === 0 ? 0.6 : 1 }}>
              {saving ? "Adding…" : `Add ${kept.length} goal${kept.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GoalsPanel({ data, reload }: { data: GoalsData | null; reload: () => void }) {
  const [showSuggest, setShowSuggest] = useState(false);
  if (!data) return <section className="rounded-xl p-6 text-center" style={{ color: "var(--muted)", ...panel }}>Loading…</section>;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl p-3" style={panel}>
        <h2 className="font-semibold">Goals</h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm" style={{ color: "var(--muted)" }}>
            {money(data.totalSaved)} of {money(data.totalTarget)} saved
            {data.monthlySavings > 0 ? <> · saving ~<span style={{ color: "var(--good)" }}>{money(data.monthlySavings)}</span>/mo lately</> : null}
          </span>
          <button onClick={() => setShowSuggest(true)} className="rounded-lg px-2.5 py-1 text-xs font-medium"
            style={{ background: "var(--accent-deep)", color: "white" }}>✨ Suggest goals</button>
        </div>
      </div>
      {showSuggest && <SuggestGoalsModal onClose={() => setShowSuggest(false)} reload={reload} />}

      {data.goals.length === 0 && (
        <div className="rounded-xl p-6 text-center text-sm" style={{ color: "var(--muted)", ...panel }}>
          No goals yet. Add one below — a target, what you&apos;ve set aside, and an optional deadline.
        </div>
      )}

      {data.goals.map((g) => <GoalCard key={g.id} g={g} monthlySavings={data.monthlySavings} underspendSources={data.underspendSources} reload={reload} />)}

      <AddGoal reload={reload} />
    </section>
  );
}
