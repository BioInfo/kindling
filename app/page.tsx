"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { panel, money, prettyCategory, CategorySelect, EntityToggle, Sparkline, sortFilter, useTableView, TableToolbar, Pager, ThemeToggle, type Txn } from "./ui";
import { CATEGORIES } from "@/lib/taxonomy";
import type { PropagationUndo } from "@/lib/categorize";
import { Sankey, type SankeyData } from "./Sankey";
import { ForecastPanel, type ForecastData } from "./Forecast";
import { BudgetsPanel, type BudgetsData } from "./Budgets";
import { GoalsPanel, type GoalsData } from "./Goals";
import { SummaryCard, type SummaryData } from "./Summary";
import { InvestmentsPanel, type InvestmentsData } from "./Investments";
import { EquityPanel, type EquityData } from "./Equity";
import { AssetsPanel, type AssetsData } from "./Assets";
import { TaxPanel, type TaxData } from "./Tax";
import { InsightsPanel, type InsightsData, type Insight } from "./Insights";
import { AccountsGrid, AccountDetailModal } from "./AccountDetail";
import { IdentifyModal } from "./Identify";
import { MerchantModal } from "./Merchant";
import { TxnDetailModal } from "./TxnDetail";
import { TxnDrillModal, type DrillFilter } from "./TxnDrill";
import { Subscriptions, type SubsData } from "./Subscriptions";
import { SubscriptionDetailModal } from "./SubscriptionDetail";

type Account = {
  id: string; name: string; mask: string | null; type: string | null;
  subtype: string | null; current_balance: number | null; currency: string | null;
  institution: string | null;
};
type Rule = {
  id: number; match_type: string; pattern: string; field: string;
  category: string | null; entity: string | null; rename: string | null;
  priority: number; source: string;
};
type CatRow = { category: string; spent: number; n: number };
type NetWorthData = {
  current: { assets: number; liabilities: number; net: number };
  series: { date: string; net: number }[];
  change: number;          // connection-adjusted (organic) change across the window
  linkedExcluded: number;  // balances connected this window, excluded from change
  byType: { side: "asset" | "liability"; kind: string; balance: number; n: number }[];
};
type Recurring = {
  merchant: string; category: string | null; direction: "expense" | "income";
  cadence: string; intervalDays: number; avgAmount: number; lastAmount: number;
  count: number; lastDate: string; nextExpected: string; monthly: number;
};
type RecurringData = { recurring: Recurring[]; income: Recurring[]; monthlyExpense: number; monthlyIncome: number };
type Tab = "overview" | "transactions" | "subscriptions" | "networth" | "review" | "rules" | "recurring" | "budgets" | "goals" | "investments" | "equity" | "assets" | "accounts" | "tax";
type TxnView = "feed" | "review" | "recurring" | "rules";
type FeedSort = "date" | "amount" | "merchant";

function LinkButton({ onLinked }: { onLinked: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/link/token", { method: "POST" }).then((r) => r.json()).then((d) => setToken(d.link_token ?? null));
  }, []);
  const onSuccess = useCallback(async (public_token: string) => {
    await fetch("/api/link/exchange", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_token }),
    });
    onLinked();
  }, [onLinked]);
  const { open, ready } = usePlaidLink({ token: token ?? "", onSuccess });
  return (
    <button onClick={() => open()} disabled={!ready || !token}
      className="rounded-lg px-4 py-2 font-medium"
      style={{ background: "var(--accent-deep)", color: "white", opacity: ready && token ? 1 : 0.5 }}>
      + Connect a bank
    </button>
  );
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("overview");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [netWorth, setNetWorth] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);
  const [reviewRows, setReviewRows] = useState<Txn[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [recurring, setRecurring] = useState<RecurringData | null>(null);
  const [budgets, setBudgets] = useState<BudgetsData | null>(null);
  const [goals, setGoals] = useState<GoalsData | null>(null);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [investments, setInvestments] = useState<InvestmentsData | null>(null);
  const [equity, setEquity] = useState<EquityData | null>(null);
  const [assets, setAssets] = useState<AssetsData | null>(null);
  const [tax, setTax] = useState<TaxData | null>(null);
  const [subs, setSubs] = useState<SubsData | null>(null);
  const [subDetailId, setSubDetailId] = useState<string | null>(null);
  const [subsBusy, setSubsBusy] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [identifyTxn, setIdentifyTxn] = useState<{ id: string; name: string } | null>(null);
  const [merchantName, setMerchantName] = useState<string | null>(null); // merchant detail/edit modal
  const [txnDetailId, setTxnDetailId] = useState<string | null>(null);    // single-txn detail/edit modal
  const [drill, setDrill] = useState<DrillFilter | null>(null);
  const [spend, setSpend] = useState<{ total: number; byCategory: CatRow[] }>({ total: 0, byCategory: [] });
  const [nw, setNw] = useState<NetWorthData | null>(null);
  const [sankey, setSankey] = useState<SankeyData | null>(null);
  const [forecast, setForecast] = useState<ForecastData | null>(null);
  const [forecastDays, setForecastDays] = useState(90);
  const [forecastDisc, setForecastDisc] = useState(true);
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [entity, setEntity] = useState<string>("all");
  const [busy, setBusy] = useState<string | null>(null);
  // Confirmation for a merchant-category propagation (inline strip + Undo).
  const [propNotice, setPropNotice] = useState<{ merchant: string; category: string; count: number; undo: PropagationUndo } | null>(null);
  // To-Review: filter (all vs the uncategorized/Other catch-all) + per-row AI-suggest in-flight set.
  const [reviewFilter, setReviewFilter] = useState<"all" | "catchall">("all");
  const [suggesting, setSuggesting] = useState<Record<string, boolean>>({});
  // Transactions workbench: which sub-view, and the feed search/sort/filter controls.
  const [txnView, setTxnView] = useState<TxnView>("feed");
  const [invView, setInvView] = useState<"holdings" | "equity">("holdings");
  const [revPage, setRevPage] = useState(0); // To-Review client pagination (10/page)
  const [revQ, setRevQ] = useState(""); const [revSort, setRevSort] = useState<"amount" | "date" | "name">("amount"); const [revDir, setRevDir] = useState<"asc" | "desc">("desc");
  const [feedQ, setFeedQ] = useState("");        // search box (immediate)
  const [feedQDeb, setFeedQDeb] = useState("");  // debounced → drives the fetch
  const [feedCat, setFeedCat] = useState("");    // category filter ("" = all)
  const [feedAcct, setFeedAcct] = useState("");  // account-id filter ("" = all)
  const [feedSort, setFeedSort] = useState<FeedSort>("date");
  const [feedDir, setFeedDir] = useState<"desc" | "asc">("desc");
  // Overview keeps a recent-activity feed (recent ~100, searchable/sortable client-side).
  const [ovTxns, setOvTxns] = useState<Txn[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [PAGE_SIZE, setPageSize] = useState(10); // rows/page, user-selectable (10/25/50/100)
  const [revPageSize, setRevPageSize] = useState(10); // To-Review rows/page

  const entityArg = entity === "all" ? "" : `&entity=${entity}`; // append to an existing query
  const entityQ = entity === "all" ? "" : `?entity=${entity}`;   // start a fresh query

  // Reset to the first page whenever the entity filter changes.
  useEffect(() => { setPage(0); }, [entity]);
  // Debounce the feed search box so we don't refetch on every keystroke.
  useEffect(() => { const t = setTimeout(() => setFeedQDeb(feedQ.trim()), 300); return () => clearTimeout(t); }, [feedQ]);
  // Any feed filter/sort change (or rows-per-page change) resets to page 1.
  useEffect(() => { setPage(0); }, [feedQDeb, feedCat, feedAcct, feedSort, feedDir, PAGE_SIZE]);
  // To-Review pagination resets when its segment filter / search / sort / size changes.
  useEffect(() => { setRevPage(0); }, [reviewFilter, revQ, revSort, revDir, revPageSize]);

  const insightQ = entityArg ? `?${entityArg.slice(1)}` : "";
  // Generate the one-line lede out-of-band: fire AFTER the cards are on screen,
  // patch it in only if it comes back (a cold model boot / gateway outage returns
  // null, and the feed already rendered). Never blocks the Overview.
  const loadLede = useCallback(async () => {
    try {
      const r = await fetch(`/api/insights/lede${insightQ}`, { method: "POST" }).then((x) => x.json());
      if (r.lede) setInsights((cur) => (cur ? { ...cur, lede: r.lede } : cur));
    } catch { /* best-effort — leave the cards as-is */ }
  }, [insightQ]);
  const loadInsights = useCallback(async () => {
    const r = await fetch(`/api/insights${insightQ}`).then((x) => x.json());
    setInsights({ insights: r.insights ?? [], sig: r.sig ?? "", lede: r.lede ?? null });
    if (!r.lede && (r.insights ?? []).length > 0) void loadLede(); // no cached lede → generate it
  }, [insightQ, loadLede]);
  // Clear one insight (× on a row) or all of them (Dismiss all). The POST returns
  // the refreshed, entity-scoped feed, so use it directly — no second round-trip.
  const dismissInsightsFn = useCallback(async (keys: string[]) => {
    if (keys.length === 0) return;
    const r = await fetch(`/api/insights${insightQ}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    }).then((x) => x.json());
    setInsights({ insights: r.insights ?? [], sig: r.sig ?? "", lede: r.lede ?? null });
  }, [insightQ]);

  // Compact recent feed for the Overview (10/page). Also the source of truth for
  // account list / net worth / review badge, since the route returns them.
  const loadOverviewFeed = useCallback(async () => {
    const e = entity === "all" ? "" : `&entity=${entity}`;
    const r = await fetch(`/api/transactions?limit=100${e}`).then((x) => x.json());
    setOvTxns(r.txns ?? []);
    setAccounts(r.accounts ?? []); setNetWorth(r.netWorth ?? 0); setReviewCount(r.reviewCount ?? 0);
  }, [entity]);

  // The full Transactions-tab feed: server-side search / sort / filter + pagination.
  const loadFeed = useCallback(async () => {
    const p = new URLSearchParams();
    p.set("limit", String(PAGE_SIZE)); p.set("offset", String(page * PAGE_SIZE));
    if (entity !== "all") p.set("entity", entity);
    if (feedQDeb) p.set("q", feedQDeb);
    if (feedCat) p.set("category", feedCat);
    if (feedAcct) p.set("account", feedAcct);
    if (feedSort !== "date") p.set("sort", feedSort);
    if (feedDir !== "desc") p.set("dir", feedDir);
    const r = await fetch(`/api/transactions?${p.toString()}`).then((x) => x.json());
    setTxns(r.txns ?? []); setTotal(r.total ?? 0);
    setAccounts(r.accounts ?? []); setNetWorth(r.netWorth ?? 0); setReviewCount(r.reviewCount ?? 0);
  }, [entity, page, PAGE_SIZE, feedQDeb, feedCat, feedAcct, feedSort, feedDir]);

  // Dashboard aggregates (whole-portfolio / 30-day), independent of the feeds.
  const load = useCallback(async () => {
    await loadOverviewFeed();
    const s = await fetch(`/api/spending?days=30${entityArg}`).then((x) => x.json());
    setSpend({ total: s.total ?? 0, byCategory: s.byCategory ?? [] });
    const n = await fetch(`/api/networth`).then((x) => x.json());
    setNw(n.current ? n : null);
    const sk = await fetch(`/api/sankey?days=30${entityArg}`).then((x) => x.json());
    setSankey(sk.income ? sk : null);
    await loadInsights();
    const sm = await fetch(`/api/summary`).then((x) => x.json());
    setSummary(sm.summary ?? null);
  }, [loadOverviewFeed, entityArg, loadInsights]);

  // Recent-activity table on the Overview: search/sort/paginate the recent window.
  const ovView = useTableView(ovTxns, {
    searchOf: (t) => `${t.merchant ?? ""} ${t.name ?? ""} ${t.category ?? ""}`,
    sorts: [
      { key: "date", label: "Date", val: (t) => t.date },
      { key: "amount", label: "Amount", val: (t) => Math.abs(t.amount) },
      { key: "merchant", label: "Merchant", val: (t) => t.merchant ?? t.name ?? "" },
    ],
    initialSort: "date", pageSize: 10,
  });

  const loadReview = useCallback(async () => {
    const r = await fetch("/api/review").then((x) => x.json());
    setReviewRows(r.review ?? []);
  }, []);
  const loadRules = useCallback(async () => {
    const r = await fetch("/api/rules").then((x) => x.json());
    setRules(r.rules ?? []);
  }, []);
  const loadRecurring = useCallback(async () => {
    const r = await fetch(`/api/recurring${entityQ}`).then((x) => x.json());
    setRecurring(r);
  }, [entityQ]);
  // Forecast is whole-portfolio (liquid cash isn't entity-tagged), so it tracks
  // the horizon toggle, not the entity filter.
  const loadForecast = useCallback(async () => {
    const r = await fetch(`/api/forecast?days=${forecastDays}&disc=${forecastDisc ? 1 : 0}`).then((x) => x.json());
    setForecast(r.series ? r : null);
  }, [forecastDays, forecastDisc]);
  // Budget targets are global; the actual bars reflect the entity filter.
  const loadBudgets = useCallback(async () => {
    const r = await fetch(`/api/budgets${entityQ}`).then((x) => x.json());
    setBudgets(r.budgets ? r : null);
  }, [entityQ]);
  // Goals are whole-portfolio (a target/saved/deadline), not entity-scoped.
  const loadGoals = useCallback(async () => {
    const r = await fetch(`/api/goals`).then((x) => x.json());
    setGoals(r.goals ? r : null);
  }, []);
  // Investments are whole-portfolio (holdings + allocation), not entity-scoped.
  const loadInvestments = useCallback(async () => {
    const r = await fetch(`/api/investments`).then((x) => x.json());
    setInvestments(r.holdings !== undefined ? r : null);
  }, []);
  // Equity comp (RSU/option/ESPP grants) — whole-portfolio, not entity-scoped.
  const loadEquity = useCallback(async () => {
    const r = await fetch(`/api/equity`).then((x) => x.json());
    setEquity(r.grants !== undefined ? r : null);
  }, []);
  // Manual off-Plaid assets/debts (house, car, mortgage) — whole-portfolio.
  const loadAssets = useCallback(async () => {
    const r = await fetch(`/api/assets`).then((x) => x.json());
    setAssets(r.assets !== undefined ? r : null);
  }, []);
  // Tax planning — whole-household, year-keyed; not entity-scoped.
  const loadTax = useCallback(async () => {
    const r = await fetch(`/api/tax`).then((x) => x.json());
    setTax(r.safeHarbor !== undefined ? r : null);
  }, []);
  // Subscriptions — entity-scoped curated recurring-cost view. GET reconciles
  // (cheap heuristic always; Plaid pull on first load), POST forces a full re-pull.
  const loadSubscriptions = useCallback(async () => {
    const r = await fetch(`/api/subscriptions${entityQ}`).then((x) => x.json());
    setSubs(r.subs !== undefined ? r : null);
  }, [entityQ]);
  const refreshSubscriptions = useCallback(async () => {
    setSubsBusy(true);
    const r = await fetch(`/api/subscriptions${entityQ}`, { method: "POST" }).then((x) => x.json()).catch(() => null);
    if (r?.subs !== undefined) setSubs(r);
    setSubsBusy(false);
  }, [entityQ]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadForecast(); }, [loadForecast]);
  // The Transactions feed loads when that tab is open and on any page/filter change.
  useEffect(() => { if (tab === "transactions") loadFeed(); }, [tab, loadFeed]);
  useEffect(() => {
    if (tab === "transactions") { loadReview(); loadRules(); loadRecurring(); }
    if (tab === "budgets") loadBudgets();
    if (tab === "goals") loadGoals();
    if (tab === "investments") { loadInvestments(); loadEquity(); }
    if (tab === "networth") loadAssets();
    if (tab === "tax") loadTax();
    if (tab === "subscriptions") loadSubscriptions();
  }, [tab, loadReview, loadRules, loadRecurring, loadBudgets, loadGoals, loadInvestments, loadEquity, loadAssets, loadTax, loadSubscriptions]);

  const exportCsv = () => {
    const a = document.createElement("a");
    a.href = `/api/export${entity === "all" ? "" : `?entity=${entity}`}`;
    a.click();
  };

  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); await fn(); setBusy(null); };
  const sync = () => run("sync", async () => { await fetch("/api/sync", { method: "POST" }); await load(); await loadForecast(); await loadFeed(); await loadSubscriptions(); });
  const aiCat = () => run("ai", async () => { await fetch("/api/categorize", { method: "POST" }); await load(); await loadFeed(); loadReview(); });
  const genSummary = () => run("summary", async () => {
    const r = await fetch("/api/summary", { method: "POST" }).then((x) => x.json());
    if (r.summary) setSummary(r.summary);
  });

  const patchTxn = async (id: string, body: Record<string, unknown>) => {
    const r = await fetch(`/api/transactions/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return r.json().catch(() => ({}));
  };
  // Apply a propagated category to sibling rows wherever they live (a sibling can
  // be in the feed or the review list), without a full reload.
  const applyPropagationLocally = (ids: Set<string>, category: string) => {
    const patch = (t: Txn) => (ids.has(t.id) ? { ...t, category, category_source: "rule" } : t);
    setTxns((prev) => prev.map(patch));
    setReviewRows((prev) => prev.map(patch));
  };
  const editTxn = (rows: Txn[], setRows: (t: Txn[]) => void) =>
    async (id: string, field: "category" | "entity", val: string) => {
      setRows(rows.map((t) => (t.id === id ? { ...t, [field]: val } : t)));
      const res = await patchTxn(id, { [field]: val });
      const prop = res?.propagation as PropagationUndo | null | undefined;
      if (field === "category" && prop) {
        if (prop.affected.length > 0) applyPropagationLocally(new Set(prop.affected.map((a) => a.id)), val);
        setPropNotice({ merchant: prop.merchant, category: val, count: prop.affected.length, undo: prop });
      }
    };
  const undoPropagation = async () => {
    if (!propNotice) return;
    await fetch("/api/transactions/undo-propagation", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(propNotice.undo),
    });
    setPropNotice(null);
    await load();
    if (tab === "transactions") { await loadReview(); await loadFeed(); }
  };
  const markReviewed = async (id: string) => {
    setReviewRows(reviewRows.filter((t) => t.id !== id));
    setReviewCount(Math.max(0, reviewCount - 1));
    await patchTxn(id, { reviewed: true });
  };
  // One-tap AI suggestion for a To-Review row → applies via the normal edit path
  // (so it remembers the merchant + backfills siblings, with Undo).
  const suggestTxn = async (id: string) => {
    setSuggesting((s) => ({ ...s, [id]: true }));
    try {
      const r = await fetch(`/api/transactions/${id}/suggest`, { method: "POST" }).then((x) => x.json());
      if (r?.category) await editTxn(reviewRows, setReviewRows)(id, "category", r.category);
    } finally {
      setSuggesting((s) => { const n = { ...s }; delete n[id]; return n; });
    }
  };
  // Auto-dismiss the propagation confirmation after a few seconds.
  useEffect(() => {
    if (!propNotice) return;
    const t = setTimeout(() => setPropNotice(null), 6000);
    return () => clearTimeout(t);
  }, [propNotice]);

  const tabBtn = (t: Tab, label: string, badge?: number) => (
    <button onClick={() => setTab(t)}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium${tab === t ? " btn-ember" : ""}`}
      style={tab === t ? undefined : { background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)" }}>
      {label}{badge ? <span className="ml-1.5 rounded-full px-1.5 text-xs" style={{ background: tab === t ? "rgba(255,255,255,.25)" : "var(--bg)" }}>{badge}</span> : null}
    </button>
  );

  // A dropdown grouping related tabs. The trigger highlights when one of its
  // items is the active tab; the badge (e.g. To-Review count) rides on the trigger.
  const tabMenu = (id: string, label: string, items: { t: Tab; label: string; badge?: number }[]) => {
    const activeInGroup = items.some((it) => it.t === tab);
    const groupBadge = items.reduce((s, it) => s + (it.badge ?? 0), 0);
    const open = openMenu === id;
    return (
      <div className="relative">
        <button onClick={() => setOpenMenu(open ? null : id)}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium${activeInGroup ? " btn-ember" : ""}`}
          style={activeInGroup ? undefined : { background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)" }}>
          {label}
          {groupBadge ? <span className="rounded-full px-1.5 text-xs" style={{ background: activeInGroup ? "rgba(255,255,255,.25)" : "var(--bg)" }}>{groupBadge}</span> : null}
          <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpenMenu(null)} />
            <div className="absolute left-0 z-20 mt-1 min-w-44 overflow-hidden rounded-lg" style={{ ...panel, boxShadow: "0 8px 24px rgba(0,0,0,.5)" }}>
              {items.map((it) => (
                <button key={it.t} onClick={() => { setTab(it.t); setOpenMenu(null); }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm"
                  style={{ background: tab === it.t ? "var(--accent-deep)" : "transparent", color: tab === it.t ? "white" : "var(--text)" }}>
                  {it.label}
                  {it.badge ? <span className="rounded-full px-1.5 text-xs" style={{ background: "var(--bg)", color: "var(--muted)" }}>{it.badge}</span> : null}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <main className="mx-auto max-w-5xl overflow-x-hidden p-4 pb-24 sm:p-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Kindling" className="h-7 w-auto rounded-lg sm:h-8" />
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            {/* Use the authoritative full net worth (computeNetWorth: accounts +
                manual assets/liabilities + vested equity), matching the Net worth
                panel. `netWorth` from /api/transactions is accounts-only and was
                showing a different, smaller number in the header. */}
            Net worth <span className="hero-ember font-semibold">{money(nw?.current.net ?? netWorth)}</span> · {accounts.length} accounts
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={entity} onChange={(e) => setEntity(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm" style={panel} title="Filter by personal vs business">
            <option value="all">All</option><option value="personal">Personal</option><option value="business">Business</option>
          </select>
          <ThemeToggle />
          <button onClick={sync} disabled={!!busy} className="rounded-lg px-4 py-2 font-medium" style={panel}>{busy === "sync" ? "Syncing…" : "Sync"}</button>
          {/* Everything occasional lives behind one ⚙ menu to keep the header calm. */}
          <div className="relative">
            <button onClick={() => setOpenMenu(openMenu === "settings" ? null : "settings")}
              className="rounded-lg px-3 py-2 text-lg leading-none" style={panel} title="Settings" aria-label="Settings">⚙</button>
            {openMenu === "settings" && (
              <div className="absolute right-0 z-20 mt-1 min-w-56 overflow-hidden rounded-lg p-1" style={{ ...panel, boxShadow: "0 8px 24px rgba(0,0,0,.5)" }}>
                <div className="px-1 py-1"><LinkButton onLinked={() => { setOpenMenu(null); sync(); }} /></div>
                <button onClick={() => { setOpenMenu(null); setTab("networth"); }}
                  className="block w-full rounded px-3 py-2 text-left text-sm" style={{ color: "var(--text)" }}>Manage accounts</button>
                <button onClick={() => { setOpenMenu(null); exportCsv(); }}
                  className="block w-full rounded px-3 py-2 text-left text-sm" style={{ color: "var(--text)" }}>
                  Export CSV{entity === "business" ? " (business)" : ""}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="mb-4 flex flex-wrap gap-2">
        {tabBtn("overview", "Overview")}
        {tabBtn("transactions", "Transactions", reviewCount)}
        {tabBtn("subscriptions", "Subscriptions")}
        {tabBtn("investments", "Investments")}
        {tabBtn("networth", "Net Worth")}
        {tabMenu("planning", "Planning", [{ t: "budgets", label: "Budgets" }, { t: "goals", label: "Goals" }, { t: "tax", label: "Tax" }])}
      </nav>

      {propNotice && (
        <div className="mb-4 flex items-center gap-3 rounded-lg px-3 py-2 text-sm"
          style={{ ...panel, borderLeft: "3px solid var(--good)" }}>
          <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>
            <span style={{ color: "var(--good)" }}>✓</span>{" "}
            {propNotice.count > 0
              ? <>Set <b>{propNotice.merchant}</b> to {prettyCategory(propNotice.category)} · applied to {propNotice.count} more</>
              : <>Remembered <b>{propNotice.merchant}</b> as {prettyCategory(propNotice.category)} for next time</>}
          </span>
          <button onClick={undoPropagation} className="shrink-0 underline" style={{ color: "var(--accent)" }}>Undo</button>
          <button onClick={() => setPropNotice(null)} className="shrink-0 px-1" style={{ color: "var(--muted)" }} aria-label="Dismiss">×</button>
        </div>
      )}

      {tab === "overview" && (
        <>
          {/* Order = what you'd want first: the number, then what needs you, then
              the briefing, the forward look, the breakdowns, accounts, activity. */}
          {nw && <NetWorthPanel nw={nw} onExpand={() => setTab("networth")} />}
          <InsightsPanel data={insights} onDismiss={dismissInsightsFn}
            onPick={(i: Insight) => {
              if (!i.drill) return;
              if (i.drill.kind === "tab") setTab(i.drill.tab as Tab);
              else setDrill({ title: i.drill.title, q: i.drill.q, category: i.drill.category, days: i.drill.days });
            }} />
          <SummaryCard data={summary} busy={busy === "summary"} onGenerate={genSummary} />
          <ForecastPanel data={forecast} days={forecastDays} onDays={setForecastDays}
            disc={forecastDisc} onDisc={setForecastDisc}
            onPick={(merchant) => setDrill({ title: merchant, q: merchant })} />

          {spend.byCategory.length > 0 && (
            <section className="mb-5 rounded-xl p-4" style={panel}>
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="font-semibold">Spending · last 30 days</h2>
                <span className="text-sm" style={{ color: "var(--muted)" }}>{money(spend.total)} total</span>
              </div>
              <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                {spend.byCategory.map((c) => {
                  const pct = spend.total > 0 ? (c.spent / spend.total) * 100 : 0;
                  return (
                    <button key={c.category} type="button"
                      onClick={() => setDrill({ title: prettyCategory(c.category), category: c.category, days: 30 })}
                      className="mb-2 block w-full text-left"
                      title={`See ${prettyCategory(c.category)} transactions`}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span>{prettyCategory(c.category)} <span style={{ color: "var(--muted)" }}>({c.n})</span></span>
                        <span>{money(c.spent)}</span>
                      </div>
                      <div className="h-1.5 rounded-full" style={{ background: "var(--bg)" }}>
                        <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: "var(--accent-deep)" }} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {sankey && (sankey.incomeTotal > 0 || sankey.spendTotal > 0) && (
            <section className="mb-5 rounded-xl p-4" style={panel}>
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="font-semibold">Money flow · last 30 days</h2>
                <span className="text-sm" style={{ color: sankey.saved >= 0 ? "var(--good)" : "var(--bad)" }}>
                  {sankey.saved >= 0 ? `${money(sankey.saved)} saved` : `${money(-sankey.saved)} over`}
                </span>
              </div>
              <Sankey data={sankey} onPick={(label, kind) =>
                setDrill(kind === "spending"
                  ? { title: prettyCategory(label), category: label, days: 30 }
                  : { title: label, q: label, days: 30 })} />
            </section>
          )}

          <div className="mb-5"><AccountsGrid accounts={accounts} onSelect={setDetailId} defaultCollapsed /></div>

          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold">Recent activity</h2>
            <button onClick={() => { setTxnView("feed"); setTab("transactions"); }} className="text-sm font-medium" style={{ color: "var(--accent)" }}>View all →</button>
          </div>
          <div className="mb-3"><TableToolbar {...ovView.toolbar} placeholder="Search recent activity…" /></div>
          <TxnTable rows={ovView.pageRows} onEdit={editTxn(ovTxns, setOvTxns)}
            page={ovView.pager.page} pageSize={ovView.pager.pageSize} total={ovView.pager.total} onPage={ovView.pager.onPage} onPageSize={ovView.pager.onPageSize}
            onIdentify={setIdentifyTxn} onMerchant={setMerchantName} onTxn={setTxnDetailId} />
        </>
      )}

      {tab === "transactions" && (
        <div className="flex flex-col gap-3">
          {/* Sub-view switch + the one AI-categorize action, all in one toolbar. */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl p-2" style={panel}>
            {([["feed", "Feed"], ["review", `To Review${reviewCount ? ` (${reviewCount})` : ""}`], ["recurring", "Recurring"], ["rules", "Rules"]] as [TxnView, string][]).map(([k, label]) => (
              <button key={k} onClick={() => setTxnView(k)} className="rounded-md px-3 py-1.5 text-sm font-medium"
                style={{ background: txnView === k ? "var(--accent-deep)" : "var(--bg)", color: txnView === k ? "white" : "var(--muted)", border: "1px solid var(--border)" }}>{label}</button>
            ))}
            <button onClick={aiCat} disabled={!!busy} className="ml-auto rounded-md px-3 py-1.5 text-sm font-medium"
              style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", opacity: busy === "ai" ? 0.6 : 1 }}>
              {busy === "ai" ? "Thinking…" : "✨ AI categorize"}
            </button>
          </div>

          {txnView === "feed" && (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-xl p-3" style={panel}>
                <input value={feedQ} onChange={(e) => setFeedQ(e.target.value)} placeholder="Search merchant or description…"
                  className="min-w-0 flex-1 rounded px-2 py-1.5 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
                <select value={feedCat} onChange={(e) => setFeedCat(e.target.value)} title="Category"
                  className="max-w-40 min-w-0 rounded px-2 py-1.5 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}>
                  <option value="">All categories</option>
                  <option value="Uncategorized">Uncategorized</option>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{prettyCategory(c)}</option>)}
                </select>
                <select value={feedAcct} onChange={(e) => setFeedAcct(e.target.value)} title="Account"
                  className="max-w-40 min-w-0 rounded px-2 py-1.5 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}>
                  <option value="">All accounts</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.mask ? ` ··${a.mask}` : ""}</option>)}
                </select>
                <select value={feedSort} onChange={(e) => setFeedSort(e.target.value as FeedSort)} title="Sort by"
                  className="max-w-40 min-w-0 rounded px-2 py-1.5 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}>
                  <option value="date">Date</option><option value="amount">Amount</option><option value="merchant">Merchant</option>
                </select>
                <button onClick={() => setFeedDir((dn) => (dn === "desc" ? "asc" : "desc"))} title="Sort direction"
                  className="rounded px-2.5 py-1.5 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}>{feedDir === "desc" ? "↓" : "↑"}</button>
                {(feedQ || feedCat || feedAcct || feedSort !== "date" || feedDir !== "desc") && (
                  <button onClick={() => { setFeedQ(""); setFeedCat(""); setFeedAcct(""); setFeedSort("date"); setFeedDir("desc"); }}
                    className="max-w-40 min-w-0 rounded px-2 py-1.5 text-sm" style={{ color: "var(--muted)" }}>Clear</button>
                )}
              </div>
              <TxnTable rows={txns} onEdit={editTxn(txns, setTxns)} page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} onPageSize={setPageSize}
                onIdentify={setIdentifyTxn} onMerchant={setMerchantName} onTxn={setTxnDetailId} />
            </>
          )}

          {txnView === "review" && (() => {
            const catchall = reviewRows.filter((t) => !t.category || t.category === "Other");
            const base = reviewFilter === "catchall" ? catchall : reviewRows;
            const shown = sortFilter(
              base, revQ,
              (t) => `${t.merchant ?? ""} ${t.name ?? ""} ${t.category ?? ""}`,
              (t) => revSort === "date" ? t.date : revSort === "name" ? (t.merchant ?? t.name ?? "") : Math.abs(t.amount),
              revDir,
            );
            const fld = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" };
            const seg = (key: "all" | "catchall", label: string, n: number) => (
              <button onClick={() => setReviewFilter(key)} className="rounded-md px-2.5 py-1 text-xs font-medium"
                style={{ background: reviewFilter === key ? "var(--accent-deep)" : "var(--bg)", color: reviewFilter === key ? "white" : "var(--muted)", border: "1px solid var(--border)" }}>
                {label} <span style={{ opacity: 0.7 }}>{n}</span>
              </button>
            );
            return (
              <section className="rounded-xl overflow-hidden" style={panel}>
                <div className="p-3" style={{ borderBottom: "1px solid var(--border)" }}>
                  <div className="text-sm" style={{ color: "var(--muted)" }}>
                    Uncategorized, &ldquo;Other&rdquo;, and unsure AI guesses (plus big AI-guessed charges). Tap ✨ to let AI pick, or set it yourself — similar charges follow.
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {seg("all", "All", reviewRows.length)}
                    {seg("catchall", "Uncategorized & Other", catchall.length)}
                    <input value={revQ} onChange={(e) => setRevQ(e.target.value)} placeholder="Search…"
                      className="ml-auto min-w-0 flex-1 rounded px-2 py-1 text-xs sm:max-w-44 sm:flex-none" style={fld} />
                    <select value={revSort} onChange={(e) => setRevSort(e.target.value as "amount" | "date" | "name")} title="Sort by"
                      className="rounded px-2 py-1 text-xs" style={fld}>
                      <option value="amount">Amount</option><option value="date">Date</option><option value="name">Name</option>
                    </select>
                    <button onClick={() => setRevDir((d) => d === "desc" ? "asc" : "desc")} title="Sort direction"
                      className="rounded px-2 py-1 text-xs" style={fld}>{revDir === "desc" ? "↓" : "↑"}</button>
                  </div>
                </div>
                {shown.length === 0 && <div className="p-6 text-center" style={{ color: "var(--muted)" }}>
                  {reviewRows.length === 0 ? "Nothing to review. 🎉" : "None in this filter. 🎉"}
                </div>}
                {shown.slice(revPage * revPageSize, revPage * revPageSize + revPageSize).map((t) => (
                  <div key={t.id} className="flex flex-wrap items-center gap-2 p-3" style={{ borderTop: "1px solid var(--border)" }}>
                    <button type="button" onClick={() => setTxnDetailId(t.id)} className="text-xs w-20 text-left hover:underline" style={{ color: "var(--muted)" }} title="Transaction details">{t.date}</button>
                    <button type="button" onClick={() => setMerchantName(t.merchant ?? t.name)} className="flex-1 min-w-40 text-left hover:underline" title="Merchant details + edit">{t.merchant ?? t.name}</button>
                    <span className="text-sm" style={{ color: t.amount > 0 ? "var(--text)" : "var(--good)", minWidth: 90, textAlign: "right" }}>{money(-t.amount, t.currency ?? "USD")}</span>
                    <button onClick={() => suggestTxn(t.id)} disabled={!!suggesting[t.id]}
                      title="Let AI pick a category for this charge (and apply to similar)"
                      className="rounded px-2 py-1 text-xs" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", opacity: suggesting[t.id] ? 0.6 : 1 }}>
                      {suggesting[t.id] ? "…" : "✨ Suggest"}
                    </button>
                    <CategorySelect value={t.category} onChange={(v) => editTxn(reviewRows, setReviewRows)(t.id, "category", v)} />
                    <EntityToggle value={t.entity} onChange={(v) => editTxn(reviewRows, setReviewRows)(t.id, "entity", v)} />
                    <button onClick={() => markReviewed(t.id)} className="rounded px-2 py-1 text-xs" style={{ background: "var(--accent-deep)", color: "white" }}>✓ Reviewed</button>
                  </div>
                ))}
                <Pager page={revPage} pageSize={revPageSize} total={shown.length} onPage={setRevPage} onPageSize={setRevPageSize} />
              </section>
            );
          })()}

          {txnView === "recurring" && <RecurringPanel data={recurring} />}

          {txnView === "rules" && <RulesPanel rules={rules} reload={loadRules} />}
        </div>
      )}

      {tab === "subscriptions" && (
        <Subscriptions data={subs} reload={loadSubscriptions} onSub={setSubDetailId}
          onRefresh={refreshSubscriptions} refreshing={subsBusy} entityQ={entityQ} />
      )}

      {tab === "networth" && (
        <div className="flex flex-col gap-5">
          {nw && <NetWorthPanel nw={nw} />}
          <div>
            <h2 className="mb-2 font-semibold">Accounts</h2>
            <AccountsGrid accounts={accounts} onSelect={setDetailId} />
          </div>
          <AssetsPanel data={assets} reload={loadAssets} />
        </div>
      )}

      {tab === "budgets" && <BudgetsPanel data={budgets} reload={loadBudgets} entityQ={entityQ} />}

      {tab === "goals" && <GoalsPanel data={goals} reload={loadGoals} />}

      {tab === "investments" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 rounded-xl p-2" style={panel}>
            {([["holdings", "Holdings"], ["equity", "Equity comp"]] as ["holdings" | "equity", string][]).map(([k, label]) => (
              <button key={k} onClick={() => setInvView(k)} className="rounded-md px-3 py-1.5 text-sm font-medium"
                style={{ background: invView === k ? "var(--accent-deep)" : "var(--bg)", color: invView === k ? "white" : "var(--muted)", border: "1px solid var(--border)" }}>{label}</button>
            ))}
          </div>
          {invView === "holdings" && <InvestmentsPanel data={investments} reload={loadInvestments} />}
          {invView === "equity" && <EquityPanel data={equity} reload={loadEquity} />}
        </div>
      )}

      {tab === "tax" && <TaxPanel data={tax} reload={loadTax} />}

      {detailId && <AccountDetailModal id={detailId} onClose={() => setDetailId(null)} onIdentify={setIdentifyTxn} onMerchant={setMerchantName} onTxn={setTxnDetailId} />}
      {drill && <TxnDrillModal filter={drill} onClose={() => setDrill(null)} onIdentify={setIdentifyTxn} onMerchant={setMerchantName} onTxn={setTxnDetailId} />}
      {identifyTxn && <IdentifyModal txn={identifyTxn} onClose={() => setIdentifyTxn(null)} onApplied={() => { load(); loadFeed(); }} />}
      {txnDetailId && <TxnDetailModal id={txnDetailId} onClose={() => setTxnDetailId(null)} onApplied={() => { load(); loadFeed(); }} onMerchant={setMerchantName} onIdentify={setIdentifyTxn} />}
      {merchantName && <MerchantModal name={merchantName} onClose={() => setMerchantName(null)} onApplied={() => { load(); loadFeed(); }} onTxn={setTxnDetailId} />}
      {subDetailId && <SubscriptionDetailModal id={subDetailId} onClose={() => setSubDetailId(null)} onApplied={() => { loadSubscriptions(); load(); }} onTxn={setTxnDetailId} />}
    </main>
  );
}

function RecurringPanel({ data }: { data: RecurringData | null }) {
  const rv = useTableView(data?.recurring ?? [], {
    searchOf: (r) => `${r.merchant} ${r.category ?? ""}`,
    sorts: [
      { key: "monthly", label: "Monthly", val: (r) => r.monthly },
      { key: "amount", label: "Amount", val: (r) => r.avgAmount },
      { key: "next", label: "Next date", val: (r) => r.nextExpected },
      { key: "name", label: "Name", val: (r) => r.merchant },
    ],
    initialSort: "monthly", pageSize: 10,
  });
  if (!data) return <section className="rounded-xl p-6 text-center" style={{ color: "var(--muted)", ...panel }}>Loading…</section>;
  const badge = (c: string) => (
    <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: "var(--bg)", color: "var(--muted)" }}>{c}</span>
  );
  const Row = ({ r }: { r: Recurring }) => (
    <div className="flex flex-wrap items-center gap-2 p-3" style={{ borderTop: "1px solid var(--border)" }}>
      <span className="flex-1 min-w-40 font-medium">{r.merchant}</span>
      {badge(r.cadence)}
      {r.category ? <span className="text-xs" style={{ color: "var(--muted)" }}>{r.category}</span> : null}
      <span className="text-xs" style={{ color: "var(--muted)" }}>next {r.nextExpected}</span>
      <span className="text-sm" style={{ minWidth: 80, textAlign: "right" }}>{money(r.avgAmount)}</span>
      <span className="text-xs" style={{ color: "var(--muted)", minWidth: 90, textAlign: "right" }}>{money(r.monthly)}/mo</span>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      {data.recurring.length > 0 && <TableToolbar {...rv.toolbar} placeholder="Search recurring…" />}
      <section className="rounded-xl overflow-hidden" style={panel}>
        <div className="flex flex-wrap items-baseline justify-between gap-2 p-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <h2 className="font-semibold">Recurring charges</h2>
          <span className="text-sm" style={{ color: "var(--muted)" }}>
            {money(data.monthlyExpense)}/mo across {data.recurring.length}
            {data.monthlyIncome > 0 ? <> · income {money(data.monthlyIncome)}/mo</> : null}
          </span>
        </div>
        {data.recurring.length === 0 && (
          <div className="p-6 text-center" style={{ color: "var(--muted)" }}>
            No recurring charges detected yet. Needs a few months of history to spot a cadence.
          </div>
        )}
        {rv.pageRows.map((r) => <Row key={`e-${r.merchant}-${r.intervalDays}`} r={r} />)}
        <Pager {...rv.pager} />
        {data.income.length > 0 && (
          <>
            <div className="p-3 text-xs font-medium" style={{ color: "var(--muted)", borderTop: "1px solid var(--border)", background: "var(--bg)" }}>Recurring income</div>
            {data.income.map((r) => <Row key={`i-${r.merchant}-${r.intervalDays}`} r={r} />)}
          </>
        )}
      </section>
    </div>
  );
}

function NetWorthPanel({ nw, onExpand }: { nw: NetWorthData; onExpand?: () => void }) {
  const { current, series } = nw;
  const net = series.map((s) => s.net);
  // Change is connection-adjusted server-side: connecting an account or
  // backfilling history is new visibility, not growth, so it's pulled out.
  const change = nw.change;
  const up = change >= 0;
  const linked = nw.linkedExcluded ?? 0;
  const assets = nw.byType.filter((t) => t.side === "asset");
  const liabs = nw.byType.filter((t) => t.side === "liability");
  return (
    <section className="mb-5 rounded-xl p-4" style={panel}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <button type="button" onClick={onExpand} className="block text-left"
            style={{ cursor: onExpand ? "pointer" : "default" }} title={onExpand ? "See accounts behind this" : undefined}>
            <div className="text-sm" style={{ color: "var(--muted)" }}>Net worth {onExpand ? "›" : ""}</div>
            <div className="hero-ember text-3xl font-semibold tracking-tight">{money(current.net)}</div>
          </button>
          {series.length > 1 && (
            <div className="mt-1 text-xs" style={{ color: up ? "var(--good)" : "var(--bad)" }}>
              {up ? "▲" : "▼"} {money(Math.abs(change))} over {series.length} days
            </div>
          )}
          {Math.abs(linked) >= 1 && (
            <div className="mt-0.5 text-xs" style={{ color: "var(--muted)" }} title="Connecting an account or backfilling history makes money you already had visible — it isn't a change in net worth, so it's excluded from the figure above.">
              {money(linked)} newly linked · excluded from change
            </div>
          )}
          <div className="mt-2 flex gap-4 text-sm">
            <span style={{ color: "var(--muted)" }}>Assets <span style={{ color: "var(--good)" }}>{money(current.assets)}</span></span>
            <span style={{ color: "var(--muted)" }}>Liabilities <span style={{ color: "var(--bad)" }}>{money(current.liabilities)}</span></span>
          </div>
        </div>
        <div className="min-w-[200px] flex-1" style={{ maxWidth: 320 }}>
          <Sparkline values={net} color={up ? "var(--good)" : "var(--bad)"} />
          {series.length > 1 && (
            <div className="flex justify-between text-xs" style={{ color: "var(--muted)" }}>
              <span>{series[0].date}</span><span>{series[series.length - 1].date}</span>
            </div>
          )}
        </div>
      </div>
      {nw.byType.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 border-t pt-3 text-xs" style={{ borderColor: "var(--border)" }}>
          {assets.map((t) => (
            <span key={`a-${t.kind}`} className="rounded px-1.5 py-0.5" style={{ background: "var(--bg)", color: "var(--muted)" }}>
              {t.kind} <span style={{ color: "var(--text)" }}>{money(t.balance)}</span>
            </span>
          ))}
          {liabs.map((t) => (
            <span key={`l-${t.kind}`} className="rounded px-1.5 py-0.5" style={{ background: "var(--bg)", color: "var(--bad)" }}>
              {t.kind} <span>−{money(t.balance)}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function TxnTable({
  rows, onEdit, page, pageSize, total, onPage, onPageSize, onIdentify, onMerchant, onTxn,
}: {
  rows: Txn[]; onEdit: (id: string, f: "category" | "entity", v: string) => void;
  page: number; pageSize: number; total: number; onPage: (p: number) => void;
  onPageSize?: (n: number) => void;     // rows-per-page selector (10/25/50/100)
  onIdentify: (t: Txn) => void;
  onMerchant: (name: string) => void;   // merchant name → merchant detail/edit
  onTxn: (id: string) => void;          // date → single-txn detail/edit
}) {
  return (
    <section className="rounded-xl overflow-hidden" style={panel}>
      {/* Mobile: stacked, inline-editable cards. The 5-col table clips Category/
          Entity/Amount off a phone, so below sm we restack (merchant + amount on
          top, date + the live category/entity controls below). */}
      <div className="sm:hidden">
        {rows.map((t) => (
          <div key={t.id} className="p-3" style={{ borderTop: "1px solid var(--border)" }}>
            <div className="flex items-center gap-2">
              <button onClick={() => onIdentify(t)} title="AI-identify this merchant from the web"
                className="shrink-0 text-xs" style={{ color: "var(--accent)" }}>✨</button>
              <button type="button" onClick={() => onMerchant(t.merchant ?? t.name)} className="min-w-0 flex-1 truncate text-left hover:underline"
                title="Merchant details + edit">{t.merchant ?? t.name}</button>
              <span className="shrink-0 tabular-nums" style={{ color: t.amount > 0 ? "var(--text)" : "var(--good)" }}>{money(-t.amount, t.currency ?? "USD")}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => onTxn(t.id)} className="inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs hover:underline" style={{ color: "var(--accent)", border: "1px solid var(--border)" }} title="View transaction details">{t.date} <span aria-hidden style={{ opacity: 0.8 }}>ⓘ</span></button>
              {t.pending ? <span className="text-xs" style={{ color: "var(--muted)" }}>· pending</span> : null}
              <CategorySelect value={t.category} onChange={(v) => onEdit(t.id, "category", v)} />
              <EntityToggle value={t.entity} onChange={(v) => onEdit(t.id, "entity", v)} />
            </div>
          </div>
        ))}
        {rows.length === 0 && <div className="p-6 text-center" style={{ color: "var(--muted)" }}>No transactions. Connect a bank, then Sync.</div>}
      </div>

      {/* Desktop: full table. table-fixed + per-column widths so the merchant
          cell truncates to ONE line (a long Zelle descriptor used to wrap). */}
      <table className="hidden w-full table-fixed text-sm sm:table">
        <thead><tr style={{ color: "var(--muted)" }} className="text-left">
          <th className="w-32 p-3 font-medium">Date</th><th className="p-3 font-medium">Merchant</th>
          <th className="w-44 p-3 font-medium">Category</th><th className="w-28 p-3 font-medium">Entity</th>
          <th className="w-28 p-3 text-right font-medium">Amount</th>
        </tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} style={{ borderTop: "1px solid var(--border)" }}>
              <td className="p-3 align-middle">
                <button type="button" onClick={() => onTxn(t.id)} className="inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 hover:underline" style={{ color: "var(--accent)", border: "1px solid var(--border)" }} title="View transaction details">{t.date} <span aria-hidden style={{ opacity: 0.8 }}>ⓘ</span></button>
              </td>
              <td className="p-3 align-middle">
                <div className="flex min-w-0 items-center gap-1.5">
                  <button onClick={() => onIdentify(t)} title="AI-identify this merchant from the web"
                    className="shrink-0 text-xs" style={{ color: "var(--accent)" }}>✨</button>
                  <button type="button" onClick={() => onMerchant(t.merchant ?? t.name)} className="min-w-0 flex-1 truncate text-left hover:underline"
                    title={t.merchant ?? t.name}>{t.merchant ?? t.name}</button>
                  {t.pending ? <span className="shrink-0 text-xs" style={{ color: "var(--muted)" }}>pending</span> : null}
                </div>
              </td>
              <td className="p-3 align-middle"><CategorySelect value={t.category} onChange={(v) => onEdit(t.id, "category", v)} /></td>
              <td className="p-3 align-middle"><EntityToggle value={t.entity} onChange={(v) => onEdit(t.id, "entity", v)} /></td>
              <td className="p-3 text-right align-middle tabular-nums" style={{ color: t.amount > 0 ? "var(--text)" : "var(--good)" }}>{money(-t.amount, t.currency ?? "USD")}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="p-6 text-center" style={{ color: "var(--muted)" }}>No transactions. Connect a bank, then Sync.</td></tr>}
        </tbody>
      </table>
      <Pager page={page} pageSize={pageSize} total={total} onPage={onPage} onPageSize={onPageSize} />
    </section>
  );
}

function RulesPanel({ rules, reload }: { rules: Rule[]; reload: () => void }) {
  const [pattern, setPattern] = useState(""); const [category, setCategory] = useState(""); const [applyNow, setApplyNow] = useState(true);
  const rv = useTableView(rules, {
    searchOf: (r) => `${r.pattern} ${r.category ?? ""} ${r.source} ${r.field}`,
    sorts: [
      { key: "priority", label: "Priority", val: (r) => r.priority },
      { key: "pattern", label: "Pattern", val: (r) => r.pattern },
      { key: "category", label: "Category", val: (r) => r.category ?? "" },
      { key: "source", label: "Source", val: (r) => r.source },
    ],
    initialSort: "priority", initialDir: "asc", pageSize: 10,
  });
  const field = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" };
  const add = async () => {
    if (!pattern || !category) return;
    await fetch("/api/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pattern, category, applyNow }) });
    setPattern(""); setCategory(""); reload();
  };
  const del = async (id: number) => { await fetch(`/api/rules/${id}`, { method: "DELETE" }); reload(); };
  return (
    <section className="rounded-xl overflow-hidden" style={panel}>
      <div className="flex flex-wrap items-center gap-2 p-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="merchant contains… (e.g. VENMO)"
          className="flex-1 min-w-40 rounded px-2 py-1 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
        <CategorySelect value={category} onChange={setCategory} />
        <label className="flex items-center gap-1 text-xs" style={{ color: "var(--muted)" }}>
          <input type="checkbox" checked={applyNow} onChange={(e) => setApplyNow(e.target.checked)} /> apply to existing
        </label>
        <button onClick={add} className="rounded px-3 py-1 text-sm font-medium" style={{ background: "var(--accent-deep)", color: "white" }}>+ Add rule</button>
      </div>
      {rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 p-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <input value={rv.toolbar.q} onChange={(e) => rv.toolbar.onQ(e.target.value)} placeholder="Search rules…"
            className="flex-1 min-w-40 rounded px-2 py-1 text-sm" style={field} />
          <select value={rv.toolbar.sortKey} onChange={(e) => rv.toolbar.onSortKey(e.target.value)} title="Sort by"
            className="max-w-40 min-w-0 rounded px-2 py-1 text-sm" style={field}>
            {rv.toolbar.sorts.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <button onClick={() => rv.toolbar.onDir(rv.toolbar.dir === "desc" ? "asc" : "desc")} title="Sort direction"
            className="rounded px-2.5 py-1 text-sm" style={field}>{rv.toolbar.dir === "desc" ? "↓" : "↑"}</button>
        </div>
      )}
      {rules.length === 0 && <div className="p-6 text-center" style={{ color: "var(--muted)" }}>No rules yet. The AI writes some automatically; add your own above.</div>}
      {rv.pageRows.map((r) => (
        <div key={r.id} className="flex items-center gap-2 p-3 text-sm" style={{ borderTop: "1px solid var(--border)" }}>
          <span className="text-xs rounded px-1.5 py-0.5" style={{ background: "var(--bg)", color: "var(--muted)" }}>{r.source}</span>
          <span style={{ color: "var(--muted)" }}>{r.field} {r.match_type}</span>
          <span className="font-mono">{r.pattern}</span>
          <span style={{ color: "var(--muted)" }}>→</span>
          <span>{r.category}{r.entity ? ` · ${r.entity}` : ""}{r.rename ? ` · "${r.rename}"` : ""}</span>
          <button onClick={() => del(r.id)} className="ml-auto rounded px-2 py-0.5 text-xs" style={{ background: "var(--bg)", color: "var(--bad)", border: "1px solid var(--border)" }}>delete</button>
        </div>
      ))}
      <Pager {...rv.pager} />
    </section>
  );
}
