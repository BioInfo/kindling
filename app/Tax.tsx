"use client";

import { useState } from "react";
import { money, panel } from "./ui";

// All numbers come from /api/tax (deterministic, from your real prior-year tax +
// projections you enter). Planning aid only — every surface says confirm with the CPA.

type Quarter = { q: number; label: string; due: string; daysUntil: number; status: string; recommended: number; paid: number };
type TaxEvent = { source: string; label: string; date: string; daysUntil: number; income: number; withheldEst: number; owedEst: number; setAside: number };
type Profile = {
  year: number; filing_status: string; state: string; prior_year_tax: number; prior_year_state_tax: number;
  prior_agi_over_threshold: number; est_income: number; est_fed_withholding: number; est_state_withholding: number;
  se_net_income: number; est_current_tax_override: number; est_state_tax_override: number; pay_periods_left: number; note: string | null;
};
export type TaxData = {
  year: number; asOf: string; profile: Profile;
  safeHarbor: { multiplier: number; priorYearTax: number; targetFromPrior: number; estCurrentTax: number; targetFromCurrent: number; target: number; basis: string; projectedWithholding: number; gap: number };
  quarters: Quarter[]; stateQuarters: Quarter[];
  nextDue: { jurisdiction: string; q: number; due: string; daysUntil: number; amount: number } | null;
  w4: { gap: number; payPeriodsLeft: number; perPaycheck: number };
  bracket: { taxableEst: number; marginalRate: number; effectiveRateEst: number; totalTaxEst: number; niitApplies: boolean; addlMedicareApplies: boolean; seTaxNote: string | null };
  events: TaxEvent[];
  scheduleC: { byCategory: { category: string; amount: number }[]; totalExpense: number; income: number; net: number };
  payments: { id: number; jurisdiction: string; quarter: number | null; amount: number; paid_date: string; note: string | null }[];
  advisory: string;
};

const fieldStyle = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" };
const pct1 = (n: number) => `${(n * 100).toFixed(1)}%`;
const Card = ({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) => (
  <div className="rounded-xl p-4" style={panel}>
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {sub && <span className="text-xs" style={{ color: "var(--muted)" }}>{sub}</span>}
    </div>
    {children}
  </div>
);

function ProfileEditor({ data, reload }: { data: TaxData; reload: () => void }) {
  const p = data.profile;
  const [open, setOpen] = useState(p.prior_year_tax === 0);
  const [f, setF] = useState({
    prior_year_tax: String(p.prior_year_tax || ""), prior_year_state_tax: String(p.prior_year_state_tax || ""),
    est_income: String(p.est_income || ""), est_fed_withholding: String(p.est_fed_withholding || ""),
    est_state_withholding: String(p.est_state_withholding || ""), se_net_income: String(p.se_net_income || ""),
    est_current_tax_override: String(p.est_current_tax_override || ""), est_state_tax_override: String(p.est_state_tax_override || ""),
    pay_periods_left: String(p.pay_periods_left ?? 12), prior_agi_over_threshold: !!p.prior_agi_over_threshold,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string | boolean) => setF((s) => ({ ...s, [k]: v }));
  const save = async () => {
    setBusy(true);
    await fetch("/api/tax", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ year: data.year, ...f }) });
    setBusy(false); setOpen(false); reload();
  };
  const Row = ({ label, k, hint }: { label: string; k: keyof typeof f; hint?: string }) => (
    <label className="flex flex-col gap-0.5 text-xs" style={{ color: "var(--muted)" }}>
      {label}{hint ? <span style={{ opacity: 0.7 }}> · {hint}</span> : null}
      <input value={f[k] as string} onChange={(e) => set(k, e.target.value)} inputMode="decimal"
        className="rounded px-2 py-1 text-sm" style={fieldStyle} />
    </label>
  );
  if (!open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl p-3" style={panel}>
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          {p.filing_status.toUpperCase()} · {p.state} · prior-yr tax {money(p.prior_year_tax)} · 2026 withholding {money(p.est_fed_withholding)} · {p.pay_periods_left} paychecks left
        </span>
        <button onClick={() => setOpen(true)} className="rounded px-2 py-1 text-xs" style={{ background: "var(--bg)", color: "var(--muted)", border: "1px solid var(--border)" }}>edit inputs</button>
      </div>
    );
  }
  return (
    <div className="rounded-xl p-4" style={panel}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">Your tax inputs · {data.year}</span>
        <button onClick={() => setOpen(false)} className="text-xs" style={{ color: "var(--muted)" }}>close</button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Row label="Prior-yr federal tax" k="prior_year_tax" hint="2025 total" />
        <Row label="Prior-yr state tax" k="prior_year_state_tax" />
        <Row label="2026 income (gross)" k="est_income" />
        <Row label="2026 fed withholding" k="est_fed_withholding" hint="all W-2s" />
        <Row label="2026 state withholding" k="est_state_withholding" />
        <Row label="Self-emp net" k="se_net_income" />
        <Row label="Expected 2026 fed tax" k="est_current_tax_override" hint="normalized, ex one-time gains" />
        <Row label="Expected 2026 VA tax" k="est_state_tax_override" hint="normalized" />
        <Row label="Paychecks left" k="pay_periods_left" hint="this year" />
      </div>
      <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
        &ldquo;Expected 2026 tax&rdquo; is your realistic full-year federal tax with no one-time spikes (like last year&rsquo;s stock-sale gains). Set it and the safe-harbor target can drop to 90% of it — the penalty-proof floor without overpaying on an inflated prior year.
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
        <input type="checkbox" checked={f.prior_agi_over_threshold} onChange={(e) => set("prior_agi_over_threshold", e.target.checked)} />
        prior-year AGI over $150k (→ safe harbor is 110% of last year, not 100%)
      </label>
      <button onClick={save} disabled={busy} className="mt-3 rounded px-3 py-1.5 text-sm font-medium" style={{ background: "var(--accent-deep)", color: "white", opacity: busy ? 0.6 : 1 }}>
        {busy ? "Saving…" : "Save inputs"}
      </button>
    </div>
  );
}

function NextDue({ d }: { d: TaxData["nextDue"] }) {
  if (!d) return null;
  const urgent = d.daysUntil <= 21;
  return (
    <div className="rounded-xl p-4" style={{ ...panel, borderColor: urgent ? "var(--warn)" : "var(--border)" }}>
      <div className="text-xs" style={{ color: "var(--muted)" }}>Next payment due</div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-semibold tabular-nums">{money(d.amount)}</span>
        <span className="text-sm" style={{ color: urgent ? "var(--warn)" : "var(--text)" }}>
          {d.jurisdiction} Q{d.q} · {d.due} · {d.daysUntil === 0 ? "today" : `in ${d.daysUntil} days`}
        </span>
      </div>
    </div>
  );
}

function SafeHarbor({ s }: { s: TaxData["safeHarbor"] }) {
  const covered = s.projectedWithholding;
  const pct = s.target > 0 ? Math.min(100, (covered / s.target) * 100) : 0;
  return (
    <Card title="Safe harbor" sub={s.basis}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs" style={{ color: "var(--muted)" }}>Pay this much across the year to dodge the penalty</span>
        <span className="text-lg font-semibold tabular-nums">{money(s.target)}</span>
      </div>
      <div className="my-2 h-2 rounded-full" style={{ background: "var(--bg)" }}>
        <div className="h-2 rounded-full" style={{ width: `${pct}%`, background: pct >= 100 ? "var(--good)" : "var(--accent)" }} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: "var(--muted)" }}>
        <span>Projected withholding <span style={{ color: "var(--text)" }}>{money(covered)}</span></span>
        <span>Still need <span style={{ color: s.gap > 0 ? "var(--bad)" : "var(--good)" }}>{money(s.gap)}</span> in estimates</span>
        <span>Prior-yr tax {money(s.priorYearTax)} × {s.multiplier.toFixed(2)} = {money(s.targetFromPrior)}</span>
      </div>
      {s.target === s.targetFromCurrent && s.targetFromPrior > s.target ? (
        <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Planning around your expected tax. <span style={{ color: "var(--text)" }}>{money(s.targetFromPrior)}</span> is the zero-penalty-risk ceiling (110% of last year) — pay that if 2026 income surprises higher than planned.
        </div>
      ) : s.targetFromCurrent > 0 && s.targetFromCurrent < s.target ? (
        <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          Could be as low as <span style={{ color: "var(--text)" }}>{money(s.targetFromCurrent)}</span> (90% of this year&apos;s estimated tax) if your 2026 income lands near the projection — but the locked-in number above is the one that can&apos;t backfire.
        </div>
      ) : null}
    </Card>
  );
}

const PAYURL: Record<string, { label: string; url: string }[]> = {
  federal: [{ label: "IRS Direct Pay", url: "https://www.irs.gov/payments/direct-pay" }, { label: "EFTPS", url: "https://www.eftps.gov" }],
  Virginia: [{ label: "VA Tax (eForms)", url: "https://www.tax.virginia.gov/individual-estimated-tax-payments" }],
};
function Quarters({ title, qs, jurisdiction, year, reload }: { title: string; qs: Quarter[]; jurisdiction: string; year: number; reload: () => void }) {
  const color: Record<string, string> = { paid: "var(--good)", "due-soon": "var(--warn)", upcoming: "var(--muted)", "past-unpaid": "var(--bad)" };
  const log = async (q: Quarter) => {
    const amt = q.recommended || q.paid;
    await fetch("/api/tax/payments", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year, jurisdiction: jurisdiction === "Virginia" ? "state" : "federal", quarter: q.q, amount: amt, paid_date: new Date().toISOString().slice(0, 10) }) });
    reload();
  };
  return (
    <Card title={title} sub={PAYURL[jurisdiction]?.map((l) => l.label).join(" · ")}>
      <div className="flex flex-col gap-1.5">
        {qs.map((q) => (
          <div key={q.q} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" style={{ borderTop: "1px solid var(--border)", paddingTop: 6 }}>
            <span className="w-8 font-medium">{q.label}</span>
            <span className="text-xs" style={{ color: "var(--muted)" }}>{q.due}</span>
            <span className="text-xs" style={{ color: color[q.status] }}>
              {q.status === "paid" ? `paid ${money(q.paid)}` : q.status === "past-unpaid" ? "past" : q.daysUntil === 0 ? "due today" : `in ${q.daysUntil}d`}
            </span>
            <span className="ml-auto tabular-nums">{q.status === "paid" ? "" : money(q.recommended)}</span>
            {q.status !== "paid" && q.daysUntil >= 0 && q.recommended > 0 && (
              <button onClick={() => log(q)} className="rounded px-2 py-0.5 text-xs" style={{ background: "var(--bg)", color: "var(--muted)", border: "1px solid var(--border)" }} title="Mark this quarter paid">log</button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {PAYURL[jurisdiction]?.map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="rounded px-2 py-1 text-xs" style={{ background: "var(--bg)", color: "var(--accent)", border: "1px solid var(--border)" }}>{l.label} ↗</a>
        ))}
      </div>
    </Card>
  );
}

function W4Helper({ w4 }: { w4: TaxData["w4"] }) {
  if (w4.gap <= 0) return (
    <Card title="W-4 withholding">
      <div className="text-sm" style={{ color: "var(--good)" }}>Withholding already covers your safe harbor — no extra needed.</div>
    </Card>
  );
  return (
    <Card title="W-4 helper · the no-penalty lever">
      <div className="text-sm">
        Add <span className="font-semibold tabular-nums" style={{ color: "var(--accent)" }}>{money(w4.perPaycheck)}</span> per paycheck
        on <span className="font-medium">Form W-4 line 4(c)</span> (extra withholding), across your {w4.payPeriodsLeft} remaining paychecks.
      </div>
      <div className="mt-1.5 text-xs" style={{ color: "var(--muted)" }}>
        Why this beats a late estimate: withholding counts as paid <span style={{ color: "var(--text)" }}>evenly all year</span>, so bumping it now also cures the quarters you already missed — no timing penalty. An estimate only counts when you actually send it.
      </div>
    </Card>
  );
}

function Events({ events }: { events: TaxEvent[] }) {
  if (events.length === 0) return null;
  return (
    <Card title="Big-event planner" sub="equity vests · next ~2 yrs">
      <div className="flex flex-col gap-2">
        {events.map((e, i) => (
          <div key={i} className="text-sm" style={{ borderTop: i ? "1px solid var(--border)" : "none", paddingTop: i ? 8 : 0 }}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{e.label}</span>
              <span className="text-xs" style={{ color: "var(--muted)" }}>{e.date} · in {Math.round(e.daysUntil / 30)} mo</span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs" style={{ color: "var(--muted)" }}>
              <span>Income <span style={{ color: "var(--text)" }}>{money(e.income)}</span></span>
              <span>Withheld ~<span style={{ color: "var(--text)" }}>{money(e.withheldEst)}</span> (22%+VA)</span>
              <span>Owed ~<span style={{ color: "var(--text)" }}>{money(e.owedEst)}</span></span>
              <span>Set aside <span style={{ color: "var(--warn)" }}>{money(e.setAside)}</span></span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
        RSUs withhold federal at a flat 22% (37% over $1M), but your marginal rate is higher — the gap is what to set aside before the bill lands.
      </div>
    </Card>
  );
}

function Bracket({ b }: { b: TaxData["bracket"] }) {
  return (
    <Card title="Bracket & rate" sub="rough estimate">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { l: "Marginal", v: pct1(b.marginalRate) },
          { l: "Effective", v: b.effectiveRateEst > 0 ? pct1(b.effectiveRateEst) : "—" },
          { l: "Est. federal tax", v: b.totalTaxEst > 0 ? money(b.totalTaxEst) : "—" },
          { l: "Taxable (est)", v: b.taxableEst > 0 ? money(b.taxableEst) : "—" },
        ].map((s) => (
          <div key={s.l}>
            <div className="text-xs" style={{ color: "var(--muted)" }}>{s.l}</div>
            <div className="text-base font-semibold tabular-nums">{s.v}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        {b.niitApplies && <span className="rounded px-1.5 py-0.5" style={{ background: "var(--bg)", color: "var(--warn)" }}>NIIT 3.8% on investment income</span>}
        {b.addlMedicareApplies && <span className="rounded px-1.5 py-0.5" style={{ background: "var(--bg)", color: "var(--warn)" }}>Addl Medicare 0.9%</span>}
      </div>
      {b.seTaxNote && <div className="mt-1.5 text-xs" style={{ color: "var(--muted)" }}>{b.seTaxNote}</div>}
    </Card>
  );
}

function ScheduleC({ sc }: { sc: TaxData["scheduleC"] }) {
  if (sc.byCategory.length === 0 && sc.income === 0) return null;
  return (
    <Card title="Business · Schedule C" sub="from your entity tags, this year">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span style={{ color: "var(--muted)" }}>Income <span style={{ color: "var(--good)" }}>{money(sc.income)}</span></span>
        <span style={{ color: "var(--muted)" }}>Expenses <span style={{ color: "var(--bad)" }}>{money(sc.totalExpense)}</span></span>
        <span style={{ color: "var(--muted)" }}>Net <span style={{ color: "var(--text)" }}>{money(sc.net)}</span></span>
      </div>
      {sc.byCategory.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {sc.byCategory.slice(0, 8).map((c) => (
            <div key={c.category} className="flex justify-between text-xs" style={{ color: "var(--muted)" }}>
              <span>{c.category}</span><span className="tabular-nums" style={{ color: "var(--text)" }}>{money(c.amount)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 text-xs" style={{ color: "var(--muted)" }}>Deductible-expense candidates — tag transactions business to capture them. Your CPA confirms what qualifies.</div>
    </Card>
  );
}

function HowTo() {
  const items = [
    { t: "W-4 line 4(c)", d: "The cleanest fix for a salaried high earner: put extra per-paycheck withholding on line 4(c). It's treated as paid evenly all year, so it cures earlier shortfalls without a timing penalty." },
    { t: "How to pay estimates", d: "Federal: IRS Direct Pay (bank, no fee) or EFTPS. Virginia: tax.virginia.gov eForms. Note the quarter and tax year on each payment." },
    { t: "Safe harbor", d: "No penalty if you pay the lesser of 90% of this year's tax or 110% of last year's (AGI over $150k). Last year's number is known, so it's the reliable target." },
  ];
  return (
    <Card title="How it works">
      <div className="flex flex-col gap-2">
        {items.map((i) => (
          <div key={i.t}>
            <div className="text-sm font-medium">{i.t}</div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>{i.d}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function TaxPanel({ data, reload }: { data: TaxData | null; reload: () => void }) {
  if (!data) return <section className="rounded-xl p-6 text-center" style={{ color: "var(--muted)", ...panel }}>Loading…</section>;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl p-3" style={panel}>
        <h2 className="font-semibold">Tax · {data.year}</h2>
        <span className="text-xs" style={{ color: "var(--muted)" }}>{data.advisory}</span>
      </div>
      <ProfileEditor data={data} reload={reload} />
      <NextDue d={data.nextDue} />
      <SafeHarbor s={data.safeHarbor} />
      <W4Helper w4={data.w4} />
      <div className="grid items-start gap-3 md:grid-cols-2">
        <Quarters title="Federal quarterly plan" qs={data.quarters} jurisdiction="federal" year={data.year} reload={reload} />
        <Quarters title="Virginia quarterly plan" qs={data.stateQuarters} jurisdiction="Virginia" year={data.year} reload={reload} />
      </div>
      <Events events={data.events} />
      <Bracket b={data.bracket} />
      <ScheduleC sc={data.scheduleC} />
      <HowTo />
    </section>
  );
}
