"use client";

import { money, prettyCategory } from "./ui";

type Flow = { label: string; amount: number };
export type SankeyData = {
  income: Flow[]; spending: Flow[];
  incomeTotal: number; spendTotal: number; saved: number; days: number;
};

// Dependency-free 3-layer Sankey: income sources → a central income trunk →
// spending categories (+ Saved, or "From savings" when overspending). Link
// thickness is proportional to dollars; the trunk is fully partitioned by both
// sides so the flow is conserved.
const PALETTE = ["#f97316", "#38bdf8", "#a78bfa", "var(--warn)", "var(--good)", "var(--bad)", "var(--info)", "#f472b6", "var(--good)", "#facc15", "#22d3ee", "#c084fc"];

export function Sankey({ data, onPick }: { data: SankeyData; onPick?: (label: string, kind: "income" | "spending") => void }) {
  const left: Flow[] = [...data.income];
  const right: Flow[] = [...data.spending];
  if (data.saved > 0) right.push({ label: "Saved", amount: data.saved });
  if (data.saved < 0) left.push({ label: "From savings", amount: -data.saved });

  const trunk = Math.max(data.incomeTotal, data.spendTotal, 1);
  // Wide label gutters (~230 units each side) so long node labels like
  // "Seneca Payroll $20,639.02" / "Loan Payments $19,122.78" don't clip at the
  // viewBox edges; overflow:visible on the svg catches any remainder.
  const W = 980, VH = 340, pad = 12, nodeW = 10;
  const leftX = 230, trunkX = 490, rightX = 740;
  const gap = 6;
  const scale = (VH - gap * (Math.max(left.length, right.length) - 1)) / trunk;
  const h = (amt: number) => Math.max(amt * scale, 2);
  const H = VH + pad * 2;

  // y positions: node columns get gaps; the trunk side is continuous.
  function stack(nodes: Flow[]) {
    let nodeY = pad, trunkY = pad;
    return nodes.map((n, i) => {
      const ht = h(n.amount);
      const r = { ...n, color: PALETTE[i % PALETTE.length], nodeY, nodeH: ht, trunkY, trunkH: ht };
      nodeY += ht + gap; trunkY += ht;
      return r;
    });
  }
  const L = stack(left), R = stack(right);

  // "Saved" / "From savings" are derived totals, not a category or merchant, so
  // they aren't drillable. Everything else picks (income source or spend category).
  const pickable = (label: string) => label !== "Saved" && label !== "From savings";
  const nodeProps = (label: string, kind: "income" | "spending") =>
    onPick && pickable(label)
      ? { onClick: () => onPick(label, kind), style: { cursor: "pointer" } as const }
      : {};

  const ribbon = (x0: number, y0: number, x1: number, y1: number, ht: number, color: string, key: string) => {
    const mx = (x0 + x1) / 2;
    const d = `M ${x0},${y0} C ${mx},${y0} ${mx},${y1} ${x1},${y1} L ${x1},${y1 + ht} C ${mx},${y1 + ht} ${mx},${y0 + ht} ${x0},${y0 + ht} Z`;
    return <path key={key} d={d} fill={color} opacity={0.32} />;
  };

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", overflow: "visible" }} fontSize={11}>
      {/* ribbons first so nodes/labels sit on top */}
      {L.map((n, i) => ribbon(leftX + nodeW, n.nodeY, trunkX, n.trunkY, n.nodeH, n.color, `lr-${i}`))}
      {R.map((n, i) => ribbon(trunkX + nodeW, n.trunkY, rightX, n.nodeY, n.nodeH, n.color, `rr-${i}`))}

      {/* trunk */}
      <rect x={trunkX} y={pad} width={nodeW} height={VH} rx={2} fill="var(--accent)" />
      <text x={trunkX + nodeW / 2} y={pad - 3} textAnchor="middle" fill="var(--muted)">{money(data.incomeTotal)} in</text>

      {/* left nodes + labels */}
      {L.map((n, i) => (
        <g key={`l-${i}`} {...nodeProps(n.label, "income")}>
          <rect x={leftX} y={n.nodeY} width={nodeW} height={n.nodeH} rx={2} fill={n.color} />
          <text x={leftX - 6} y={n.nodeY + n.nodeH / 2} textAnchor="end" dominantBaseline="middle" fill="var(--text)">
            {prettyCategory(n.label)} <tspan fill="var(--muted)">{money(n.amount)}</tspan>
          </text>
        </g>
      ))}

      {/* right nodes + labels */}
      {R.map((n, i) => (
        <g key={`r-${i}`} {...nodeProps(n.label, "spending")}>
          <rect x={rightX} y={n.nodeY} width={nodeW} height={n.nodeH} rx={2} fill={n.color} />
          <text x={rightX + nodeW + 6} y={n.nodeY + n.nodeH / 2} dominantBaseline="middle" fill="var(--text)">
            {prettyCategory(n.label)} <tspan fill="var(--muted)">{money(n.amount)}</tspan>
          </text>
        </g>
      ))}
    </svg>
  );
}
