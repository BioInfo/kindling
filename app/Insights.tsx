"use client";

import { useState } from "react";
import { panel } from "./ui";

// Client-side mirror of the lib/insights.ts shapes. Types are redefined here
// (not imported from the server lib, which pulls in node:sqlite) — same pattern
// page.tsx uses for the Anomaly type.
export type Severity = "high" | "med" | "info" | "good";
export type InsightDrill =
  | { kind: "txn"; title: string; q?: string; category?: string; days?: number }
  | { kind: "tab"; tab: string };
export type Insight = {
  key: string;
  kind: string;
  severity: Severity;
  icon: string;
  text: string;
  meta: string | null;
  drill: InsightDrill | null;
};
export type InsightsData = { insights: Insight[]; sig: string; lede: string | null };

const COLOR: Record<Severity, string> = {
  high: "var(--bad)", // red
  med: "var(--warn-strong)",  // amber
  info: "var(--info)", // blue
  good: "var(--good)", // green
};

// The proactive feed — one ranked, dismissable card that replaces the old
// anomaly "Worth a look" panel and pulls from every surface. Dense by design
// (a phone glance), severity-sorted, each row tappable to drill where relevant.
// Mobile-first: on phone/tablet the text line truncates rather than wrapping the
// row tall; at lg: (desktop, where the max-w-5xl container is at its width) it
// shows the full text on one line. The icon + meta + × never shrink, and the
// whole card fits a 390px viewport.
export function InsightsPanel({
  data,
  onDismiss,
  onPick,
}: {
  data: InsightsData | null;
  onDismiss: (keys: string[]) => void;
  onPick: (i: Insight) => void;
}) {
  const [open, setOpen] = useState(true);
  if (!data || data.insights.length === 0) return null;
  const items = data.insights;
  const topColor = COLOR[items[0].severity]; // ranked, so [0] is the most urgent

  return (
    <section className="mb-5 rounded-xl overflow-hidden" style={{ ...panel, borderColor: topColor }}>
      <div className="flex items-center gap-2 p-3 text-sm font-semibold" style={open ? { borderBottom: "1px solid var(--border)" } : undefined}>
        <button onClick={() => setOpen((o) => !o)} className="flex flex-1 items-center gap-1.5 text-left" title={open ? "Minimize" : "Expand"}>
          <span style={{ color: "var(--muted)", width: 12, display: "inline-block" }}>{open ? "▾" : "▸"}</span>
          💡 What to know <span style={{ color: "var(--muted)" }}>· {items.length}</span>
        </button>
        {open && (
          <button
            onClick={() => onDismiss(items.map((i) => i.key))}
            className="rounded px-2 py-0.5 text-xs font-normal"
            style={{ background: "var(--bg)", color: "var(--muted)", border: "1px solid var(--border)" }}
            title="Clear everything below"
          >
            Dismiss all
          </button>
        )}
      </div>

      {open && data.lede && (
        <div className="px-3 pt-2.5 text-sm" style={{ color: "var(--muted)", fontStyle: "italic" }}>
          “{data.lede}”
        </div>
      )}

      {open && items.map((i) => (
        <div key={i.key} className="flex items-center gap-2 p-3 text-sm" style={{ borderTop: "1px solid var(--border)" }}>
          <span style={{ color: COLOR[i.severity], width: 16, textAlign: "center", flexShrink: 0 }}>{i.icon}</span>
          {i.drill ? (
            <button
              type="button"
              onClick={() => onPick(i)}
              className="flex-1 min-w-0 truncate lg:overflow-visible lg:whitespace-normal text-left"
              style={{ cursor: "pointer" }}
              title={i.text}
            >
              {i.text}
            </button>
          ) : (
            <span className="flex-1 min-w-0 truncate lg:overflow-visible lg:whitespace-normal" title={i.text}>{i.text}</span>
          )}
          {i.meta && (
            <span className="whitespace-nowrap text-xs" style={{ color: "var(--muted)", flexShrink: 0 }}>{i.meta}</span>
          )}
          <button
            onClick={() => onDismiss([i.key])}
            className="rounded px-1.5 leading-none"
            style={{ color: "var(--muted)", border: "1px solid var(--border)", flexShrink: 0 }}
            title="Dismiss this"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </section>
  );
}
