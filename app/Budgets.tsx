"use client";

import { useEffect, useState } from "react";
import { money, panel, prettyCategory } from "./ui";

type Bucket = "fixed" | "flexible" | "nonmonthly";
type BudgetRow = {
  category: string; amount: number; bucket: Bucket; rollover: number;
  carryIn: number; available: number;
  spent: number; remaining: number; pct: number; pace: number; over: boolean; hot: boolean;
};
export type BudgetsData = {
  month: { month: string; dayOfMonth: number; daysInMonth: number; progress: number };
  budgets: BudgetRow[];
  totalBudget: number; totalSpent: number;
  budgetable: string[];
  buckets: string[];
};

const BUCKET_LABEL: Record<Bucket, string> = { fixed: "Fixed", flexible: "Flexible", nonmonthly: "Non-monthly" };
const BUCKET_HINT: Record<Bucket, string> = {
  fixed: "same every month — rent, insurance, subscriptions",
  flexible: "day-to-day — dining, groceries, shopping",
  nonmonthly: "lumpy / sinking funds — taxes, travel, big healthcare",
};

async function post(body: Record<string, unknown>) {
  await fetch("/api/budgets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function del(category: string) {
  await fetch(`/api/budgets?category=${encodeURIComponent(category)}`, { method: "DELETE" });
}

function barColor(r: BudgetRow): string {
  if (r.over) return "var(--bad)";
  if (r.hot) return "var(--warn)";
  return "var(--good)";
}

type Proposal = { category: string; amount: number; bucket: Bucket; basis: string; current: number | null };
type SuggestData = { windowMonths: number; proposals: Proposal[]; skippedLumpy: string[]; totalProposed: number };

// Review-before-save modal: pulls bucket-aware proposals from trailing spend,
// lets you tweak each amount or drop a row, then batch-saves the kept ones via
// the existing POST /api/budgets. Numbers come from the DB, never invented.
function SuggestModal({ entityQ, onClose, reload }: { entityQ: string; onClose: () => void; reload: () => void }) {
  const [data, setData] = useState<SuggestData | null>(null);
  const [amts, setAmts] = useState<Record<string, string>>({});
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/budgets/suggest${entityQ}`).then((r) => r.json()).then((d: SuggestData) => {
      setData(d);
      setAmts(Object.fromEntries(d.proposals.map((p) => [p.category, String(p.amount)])));
    });
  }, [entityQ]);

  const kept = (data?.proposals ?? []).filter((p) => !dropped.has(p.category));
  const total = kept.reduce((s, p) => s + (Number(amts[p.category]) || 0), 0);

  const save = async () => {
    setSaving(true);
    for (const p of kept) {
      const n = Number(amts[p.category]);
      if (Number.isFinite(n) && n >= 0) await post({ category: p.category, amount: n, bucket: p.bucket });
    }
    reload();
    onClose();
  };

  const buckets: Bucket[] = ["fixed", "flexible", "nonmonthly"];

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8" style={{ background: "var(--overlay)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-2xl p-5" style={{ ...panel, marginTop: "2vh" }}>
        <div className="mb-1 flex items-start justify-between gap-3">
          <div className="text-lg font-semibold">✨ Suggest budgets</div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>✕</button>
        </div>
        <div className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
          {data ? `From your last ${data.windowMonths} month${data.windowMonths === 1 ? "" : "s"} of spending. Tweak any number, drop what you don't want, then save. Figures come from your transactions — nothing made up.` : "Reading your spending…"}
        </div>

        {!data ? (
          <div className="p-6 text-center text-sm" style={{ color: "var(--muted)" }}>Loading…</div>
        ) : kept.length === 0 ? (
          <div className="rounded-xl p-4 text-center text-sm" style={{ color: "var(--muted)", background: "var(--bg)" }}>
            Nothing left to add.
          </div>
        ) : (
          <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
            {buckets.map((bk) => {
              const rows = kept.filter((p) => p.bucket === bk);
              if (rows.length === 0) return null;
              return (
                <div key={bk}>
                  <div className="px-3 py-1.5 text-xs font-medium" style={{ color: "var(--muted)", background: "var(--bg)", borderTop: "1px solid var(--border)" }}>
                    {BUCKET_LABEL[bk]}
                  </div>
                  {rows.map((p) => (
                    <div key={p.category} className="flex items-center gap-2 px-3 py-2 text-sm" style={{ borderTop: "1px solid var(--border)" }}>
                      <span className="flex-1 min-w-0">
                        <span className="block font-medium truncate">{prettyCategory(p.category)}</span>
                        <span className="block text-xs truncate" style={{ color: "var(--muted)" }}>
                          {p.basis}{p.current != null ? ` · now ${money(p.current)}` : ""}
                        </span>
                      </span>
                      <span className="text-sm" style={{ color: "var(--muted)" }}>$</span>
                      <input value={amts[p.category] ?? ""} onChange={(e) => setAmts({ ...amts, [p.category]: e.target.value })}
                        inputMode="decimal" className="w-20 rounded px-2 py-0.5 text-right text-sm"
                        style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
                      <button onClick={() => setDropped(new Set(dropped).add(p.category))} title="don't add this one"
                        className="rounded px-1.5 py-0.5 text-xs" style={{ background: "var(--bg)", color: "var(--bad)", border: "1px solid var(--border)" }}>×</button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {data && data.skippedLumpy.length > 0 && (
          <div className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            Skipped {data.skippedLumpy.map(prettyCategory).join(", ")} — a single large charge dominates, so there&apos;s no honest monthly target. Add those by hand if you want them.
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-sm" style={{ color: "var(--muted)" }}>Total proposed: <span style={{ color: "var(--text)" }}>{money(total)}/mo</span></span>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>Cancel</button>
            <button onClick={save} disabled={saving || kept.length === 0} className="rounded-lg px-3 py-1.5 text-sm font-medium"
              style={{ background: "var(--accent-deep)", color: "white", opacity: saving || kept.length === 0 ? 0.6 : 1 }}>
              {saving ? "Saving…" : `Save ${kept.length} budget${kept.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ r, reload }: { r: BudgetRow; reload: () => void }) {
  const [amt, setAmt] = useState(String(r.amount));
  const commit = async () => {
    const n = Number(amt);
    if (Number.isFinite(n) && n >= 0 && n !== r.amount) { await post({ category: r.category, amount: n, bucket: r.bucket, rollover: !!r.rollover }); reload(); }
  };
  const toggleRoll = async () => { await post({ category: r.category, amount: r.amount, bucket: r.bucket, rollover: !r.rollover }); reload(); };
  const pct = Math.min(100, Math.max(0, r.pct * 100));
  const color = barColor(r);
  return (
    <div className="p-3" style={{ borderTop: "1px solid var(--border)" }}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="flex-1 min-w-32 truncate font-medium">{r.category}</span>
        <span className="text-sm" style={{ color: "var(--muted)" }}>{money(r.spent)} / </span>
        <input
          value={amt} onChange={(e) => setAmt(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          inputMode="decimal" className="w-20 rounded px-2 py-0.5 text-right text-sm"
          style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
        <span className="text-xs whitespace-nowrap" style={{ color: r.over ? "var(--bad)" : "var(--muted)", textAlign: "right" }}>
          {r.over ? `${money(-r.remaining)} over` : `${money(r.remaining)} left`}
        </span>
        <button onClick={toggleRoll} title={r.rollover ? "rollover on — unspent carries to next month (tap to turn off)" : "turn on rollover — unspent (or overspent) carries to next month"}
          className="rounded px-1.5 py-0.5 text-xs" style={{ background: r.rollover ? "var(--accent-deep)" : "var(--bg)", color: r.rollover ? "white" : "var(--muted)", border: "1px solid var(--border)" }}>↻</button>
        <button onClick={async () => { await del(r.category); reload(); }} title="remove budget"
          className="rounded px-1.5 py-0.5 text-xs" style={{ background: "var(--bg)", color: "var(--bad)", border: "1px solid var(--border)" }}>×</button>
      </div>
      <div className="h-1.5 rounded-full" style={{ background: "var(--bg)" }}>
        <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      {r.rollover === 1 && (
        <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          {r.carryIn > 0 ? (
            <>↻ <span style={{ color: "var(--good)" }}>+{money(r.carryIn)} rolled in</span> · {money(r.available)} available this month</>
          ) : r.carryIn < 0 ? (
            <>↻ <span style={{ color: "var(--bad)" }}>{money(r.carryIn)} carried over</span> · {money(r.available)} available this month</>
          ) : (
            <>↻ rolls over — unspent carries to next month (nothing banked yet)</>
          )}
        </div>
      )}
    </div>
  );
}

function AddRow({ data, reload }: { data: BudgetsData; reload: () => void }) {
  const taken = new Set(data.budgets.map((b) => b.category));
  const avail = data.budgetable.filter((c) => !taken.has(c));
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const add = async () => {
    const n = Number(amount);
    if (!category || !Number.isFinite(n) || n < 0) return;
    await post({ category, amount: n }); setCategory(""); setAmount(""); reload();
  };
  if (avail.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 p-3" style={{ borderTop: "1px solid var(--border)" }}>
      <select value={category} onChange={(e) => setCategory(e.target.value)}
        className="rounded px-2 py-1 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}>
        <option value="">add a category…</option>
        {avail.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="monthly $" inputMode="decimal"
        className="w-28 rounded px-2 py-1 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
      <button onClick={add} className="rounded px-3 py-1 text-sm font-medium" style={{ background: "var(--accent-deep)", color: "white" }}>+ Add budget</button>
    </div>
  );
}

export function BudgetsPanel({ data, reload, entityQ = "" }: { data: BudgetsData | null; reload: () => void; entityQ?: string }) {
  const [showSuggest, setShowSuggest] = useState(false);
  if (!data) return <section className="rounded-xl p-6 text-center" style={{ color: "var(--muted)", ...panel }}>Loading…</section>;

  const { month } = data;
  const overall = data.totalBudget > 0 ? Math.min(100, (data.totalSpent / data.totalBudget) * 100) : 0;
  const overBudget = data.totalSpent > data.totalBudget && data.totalBudget > 0;
  const buckets: Bucket[] = ["fixed", "flexible", "nonmonthly"];

  return (
    <section className="rounded-xl overflow-hidden" style={panel}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 p-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <h2 className="font-semibold">Budgets · {month.month}</h2>
        <div className="flex items-baseline gap-3">
          <span className="text-sm" style={{ color: "var(--muted)" }}>
            <span style={{ color: overBudget ? "var(--bad)" : "var(--text)" }}>{money(data.totalSpent)}</span> of {money(data.totalBudget)} budgeted
            <span className="ml-2 text-xs">· day {month.dayOfMonth}/{month.daysInMonth}</span>
          </span>
          <button onClick={() => setShowSuggest(true)} className="rounded-lg px-2.5 py-1 text-xs font-medium"
            style={{ background: "var(--accent-deep)", color: "white" }} title="Propose budgets from your trailing spend, then review + tweak before saving">
            ✨ Suggest budgets
          </button>
        </div>
      </div>
      {showSuggest && <SuggestModal entityQ={entityQ} onClose={() => setShowSuggest(false)} reload={reload} />}

      {data.totalBudget > 0 && (
        <div className="px-3 pt-3">
          <div className="relative h-2 rounded-full" style={{ background: "var(--bg)" }}>
            <div className="h-2 rounded-full" style={{ width: `${overall}%`, background: overBudget ? "var(--bad)" : "var(--accent)" }} />
            {/* month-progress marker: where an even burn would put you today */}
            <div className="absolute top-[-2px] h-3 w-px" style={{ left: `${month.progress * 100}%`, background: "var(--muted)" }} title="today (even-burn pace)" />
          </div>
          <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>The tick marks today&apos;s pace — bars past it are running hot.</div>
        </div>
      )}

      {data.budgets.length === 0 && (
        <div className="p-6 text-center text-sm" style={{ color: "var(--muted)" }}>
          No budgets yet. Add a category below, or seed them from your spending history.
        </div>
      )}

      {buckets.map((bk) => {
        const rows = data.budgets.filter((b) => b.bucket === bk);
        if (rows.length === 0) return null;
        const sub = rows.reduce((s, r) => s + r.amount, 0);
        return (
          <div key={bk}>
            <div className="flex items-baseline justify-between px-3 py-2 text-xs font-medium"
              style={{ color: "var(--muted)", background: "var(--bg)", borderTop: "1px solid var(--border)" }}>
              <span>{BUCKET_LABEL[bk]} <span className="font-normal">· {BUCKET_HINT[bk]}</span></span>
              <span>{money(sub)}/mo</span>
            </div>
            {rows.map((r) => <Row key={r.category} r={r} reload={reload} />)}
          </div>
        );
      })}

      <AddRow data={data} reload={reload} />
    </section>
  );
}
