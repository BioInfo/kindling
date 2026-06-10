"use client";

import { useEffect, useState } from "react";
import { CATEGORIES } from "@/lib/taxonomy";

export const panel = { background: "var(--panel)", border: "1px solid var(--border)" };

// ── Theme (night hearth / day hearth) ──────────────────────────────────────
// The palette lives in globals.css as CSS vars keyed by [data-theme] on <html>.
// Recharts can't resolve CSS vars in SVG attributes, so charts read concrete
// hexes from CHART below — keep both in sync with globals.css.
export type ThemeName = "dark" | "light";

export const CHART = {
  dark: {
    bg: "#0b1220", panel: "#101a2c", border: "#21314f", text: "#e9edf5", muted: "#97a3bb",
    accent: "#fb923c", accentDeep: "#ea580c", good: "#4ade80", bad: "#f87171",
    warn: "#fbbf24", info: "#60a5fa",
    series: ["#fb923c", "#fbbf24", "#4ade80", "#60a5fa", "#f472b6", "#a78bfa", "#22d3ee", "#94a3b8"],
  },
  light: {
    bg: "#faf7f2", panel: "#ffffff", border: "#e4dccd", text: "#1a2540", muted: "#5d6a84",
    accent: "#ea580c", accentDeep: "#ea580c", good: "#15803d", bad: "#b91c1c",
    warn: "#b45309", info: "#1d4ed8",
    series: ["#ea580c", "#d97706", "#15803d", "#1d4ed8", "#be185d", "#7c3aed", "#0e7490", "#475569"],
  },
} as const;
export type ChartTheme = (typeof CHART)[ThemeName];

const themeListeners = new Set<() => void>();
export function currentTheme(): ThemeName {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
export function setTheme(t: ThemeName) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("kindling-theme", t); } catch {}
  themeListeners.forEach((f) => f());
}
export function useThemeName(): ThemeName {
  const [t, setT] = useState<ThemeName>("dark");
  useEffect(() => {
    const f = () => setT(currentTheme());
    f();
    themeListeners.add(f);
    return () => { themeListeners.delete(f); };
  }, []);
  return t;
}
export function useChartTheme(): ChartTheme {
  return CHART[useThemeName()];
}

export function ThemeToggle() {
  const t = useThemeName();
  return (
    <button onClick={() => setTheme(t === "dark" ? "light" : "dark")}
      className="rounded-lg px-3 py-2 text-sm leading-none" style={panel}
      title={t === "dark" ? "Switch to light" : "Switch to dark"} aria-label="Toggle light/dark theme">
      {t === "dark" ? "☀" : "🌙"}
    </button>
  );
}

// Shared modal stacking. Every modal overlay calls useModalZ() and applies the
// returned zIndex, so a modal opened from inside another modal (charge detail
// from the subscription modal, merchant from a txn, …) always lands on top
// instead of behind. The counter only climbs; it resets on page reload.
let _modalZ = 50;
export function useModalZ(): number {
  const [z] = useState(() => ++_modalZ);
  return z;
}

export function money(n: number | null, cur = "USD") {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n);
}

// Display label for a category. Our taxonomy values pass through unchanged; any
// raw Plaid SCREAMING_SNAKE primary that survives (the ambiguous ones we leave
// in the review queue) gets Title-Cased so the UI never shows LOAN_PAYMENTS.
export function prettyCategory(c: string | null): string {
  if (!c) return "Uncategorized";
  if (!/_/.test(c) && c !== c.toUpperCase()) return c; // already a normal label
  return c.toLowerCase().split(/[_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Tidy a long account name into a short label, e.g.
// "Jane Quinn Public - Roth IRA Brokerage Account - ****0958" → "JQP Roth IRA ··0958",
// "MEGACORP SAVINGS & SECURITY PLAN" → "Megacorp Savings & Security". Shared by the
// account list + the investment charts so naming stays consistent.
export function prettyAccount(raw: string): string {
  let s = raw.replace(/\s*-\s*\*+(\d{3,4})/g, " ··$1");
  // A leading ALL-CAPS employer/issuer token reads as shouting — title-case it.
  s = s.replace(/^([A-Z]{6,})\b/, (m) => m.charAt(0) + m.slice(1).toLowerCase());
  // Owner "First Middle Last" before a dash → initials (middle initials like the
  // "Q" in "Jane Q Public" count, hence [a-z]* not [a-z]+ on the followers).
  s = s.replace(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]*\.?){1,3})\s*-\s*/g, (_m, name: string) =>
    name.split(/\s+/).map((w) => w[0]).join("") + " ");
  s = s.replace(/\bBrokerage Account\b/gi, "Brokerage").replace(/\bBrokerage\b(?=.*\bIRA\b)/gi, "")
       .replace(/\bSAVINGS & SECURITY PLAN\b/i, "Savings & Security")
       .replace(/\bSUPPLEMENTAL RETIREMENT PLAN\b/i, "Supplemental Retirement")
       .replace(/\bEXECUTIVE DEFERRED COMPENSATION PLAN\b/i, "Exec Deferred Comp")
       .replace(/\s{2,}/g, " ").trim();
  return s;
}

// Short, scannable account label for a transaction row. The owner-named
// brokerage accounts fold to initials via prettyAccount ("Jane Quinn
// Public - … - ****0958" → "JQP … ··0958"); the spending/checking/card
// accounts have generic names ("CREDIT CARD", "Spending Account"), so for those
// the INSTITUTION + mask is the real "whose" signal, e.g. "Chase ··1234".
export function acctLabel(name: string, mask?: string | null, institution?: string | null): string {
  const s = prettyAccount(name);
  if (s.includes("··")) return s;            // owner/mask already folded in
  if (institution) return mask ? `${institution} ··${mask}` : institution;
  return mask ? `${s} ··${mask}` : s;
}

export type Txn = {
  id: string; date: string; name: string; merchant: string | null;
  amount: number; currency: string | null; pending?: number;
  category: string | null; category_source: string | null; confidence?: number | null;
  entity: string; reviewed?: number;
  account: string; account_mask?: string | null; account_institution?: string | null;
};

export function CategorySelect({
  value, onChange,
}: { value: string | null; onChange: (v: string) => void }) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className="rounded px-2 py-1 text-xs"
      style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}
    >
      <option value="">uncategorized</option>
      {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
  );
}

// Minimal dependency-free line chart: scaled SVG polyline + faint area fill.
export function Sparkline({
  values, width = 260, height = 52, color = "var(--accent)",
}: { values: number[]; width?: number; height?: number; color?: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1, pad = 3;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - 2 * pad);
  const y = (v: number) => pad + (1 - (v - min) / range) * (height - 2 * pad);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${x(0).toFixed(1)},${height - pad} ${pts} ${x(values.length - 1).toFixed(1)},${height - pad}`;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block" }}>
      <polygon points={area} fill={color} opacity={0.12} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function EntityToggle({
  value, onChange,
}: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded px-2 py-1 text-xs"
      style={{ background: "var(--bg)", border: "1px solid var(--border)", color: value === "business" ? "var(--warn)" : "var(--muted)" }}
      title="personal vs business expense"
    >
      <option value="personal">personal</option>
      <option value="business">business</option>
    </select>
  );
}

// --- Reusable search + sort for any list table past ~10 rows ----------------
// Pure: filter rows by a search string over `searchOf`, then sort by `sortVal`.
export function sortFilter<T>(
  rows: T[], q: string, searchOf: (t: T) => string, sortVal: (t: T) => number | string, dir: "asc" | "desc",
): T[] {
  const ql = q.trim().toLowerCase();
  const out = ql ? rows.filter((t) => searchOf(t).toLowerCase().includes(ql)) : rows.slice();
  out.sort((a, b) => {
    const va = sortVal(a), vb = sortVal(b);
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return dir === "asc" ? c : -c;
  });
  return out;
}

// Controlled toolbar: a search box + sort-by select + a direction toggle. Parent
// owns the state and feeds it to sortFilter(). One look across every big table.
export function TableToolbar({
  q, onQ, placeholder, sortKey, onSortKey, sorts, dir, onDir, children,
}: {
  q: string; onQ: (v: string) => void; placeholder?: string;
  sortKey: string; onSortKey: (v: string) => void; sorts: { key: string; label: string }[];
  dir: "asc" | "desc"; onDir: (v: "asc" | "desc") => void; children?: React.ReactNode;
}) {
  const f = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl p-3" style={panel}>
      <input value={q} onChange={(e) => onQ(e.target.value)} placeholder={placeholder ?? "Search…"}
        className="min-w-0 flex-1 rounded px-2 py-1.5 text-sm" style={f} />
      <select value={sortKey} onChange={(e) => onSortKey(e.target.value)} title="Sort by"
        className="max-w-40 min-w-0 rounded px-2 py-1.5 text-sm" style={f}>
        {sorts.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
      <button onClick={() => onDir(dir === "desc" ? "asc" : "desc")} title="Sort direction"
        className="rounded px-2.5 py-1.5 text-sm" style={f}>{dir === "desc" ? "↓" : "↑"}</button>
      {children}
    </div>
  );
}

// Page-size options shared by every paginated table.
export const PAGE_SIZES = [10, 25, 50, 100] as const;

// Site-wide rule: any list past ~10 rows paginates. Client-side pager. When
// `onPageSize` is supplied a rows-per-page selector (10/25/50/100) is shown and
// the footer stays visible even on a single page (so you can switch back down).
export function Pager({ page, pageSize, total, onPage, onPageSize }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void;
  onPageSize?: (n: number) => void;
}) {
  if (total <= pageSize && !onPageSize) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1, to = Math.min((page + 1) * pageSize, total);
  const btn = { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" } as const;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm" style={{ borderTop: "1px solid var(--border)", color: "var(--muted)" }}>
      <span className="flex items-center gap-2">
        Showing {from}–{to} of {total}
        {onPageSize && (
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} title="Rows per page"
            className="rounded px-1.5 py-0.5 text-xs" style={btn}>
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}/page</option>)}
          </select>
        )}
      </span>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          <button onClick={() => onPage(Math.max(0, page - 1))} disabled={page === 0} className="rounded px-2 py-1" style={{ ...btn, opacity: page === 0 ? 0.4 : 1 }}>← Prev</button>
          <span>Page {page + 1} / {pages}</span>
          <button onClick={() => onPage(Math.min(pages - 1, page + 1))} disabled={page >= pages - 1} className="rounded px-2 py-1" style={{ ...btn, opacity: page >= pages - 1 ? 0.4 : 1 }}>Next →</button>
        </div>
      )}
    </div>
  );
}

// Search + sort + paginate for any fully-loaded list. Holds its own state; the
// caller renders <TableToolbar {...tv.toolbar}/>, maps tv.pageRows, then <Pager {...tv.pager}/>.
export function useTableView<T>(rows: T[], cfg: {
  searchOf: (t: T) => string;
  sorts: { key: string; label: string; val: (t: T) => number | string }[];
  initialSort?: string; initialDir?: "asc" | "desc"; pageSize?: number;
}) {
  const [pageSize, setPageSize] = useState(cfg.pageSize ?? 10);
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState(cfg.initialSort ?? cfg.sorts[0]?.key ?? "");
  const [dir, setDir] = useState<"asc" | "desc">(cfg.initialDir ?? "desc");
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [q, sortKey, dir]);
  const sorter = cfg.sorts.find((s) => s.key === sortKey) ?? cfg.sorts[0];
  const filtered = sortFilter(rows, q, cfg.searchOf, sorter ? sorter.val : () => 0, dir);
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages - 1);
  const pageRows = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);
  return {
    pageRows, total, filteredOut: rows.length - total,
    toolbar: { q, onQ: setQ, sortKey, onSortKey: setSortKey, dir, onDir: setDir, sorts: cfg.sorts.map(({ key, label }) => ({ key, label })) },
    pager: { page: safePage, pageSize, total, onPage: setPage, onPageSize: (n: number) => { setPageSize(n); setPage(0); } },
  };
}
