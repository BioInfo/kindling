import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Money-flow for a window: income sources (inflows) on the left, spending
// categories (outflows) on the right. Internal money movement is excluded on
// both sides so the flow is real income → real spending.
const NON_FLOW = ["Transfer:Internal", "Transfer:Brokerage", "Transfer:P2P", "CreditCardPayment"];

// Strip noisy bank-statement suffixes and cap length so income nodes read clean.
function cleanLabel(s: string): string {
  let out = s.split(/[~|]/)[0];                 // cut at ~ or | (ACH memo junk)
  out = out.replace(/\s+\d{3,}.*$/, "");        // drop trailing long number runs
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > 28) out = out.slice(0, 27) + "…";
  return out || s.trim();
}

function aggregate(rows: { label: string; amount: number }[], key: (s: string) => string) {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r.label), (m.get(key(r.label)) ?? 0) + r.amount);
  return [...m.entries()].map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount);
}

function topN<T extends { amount: number }>(rows: (T & { label: string })[], n: number) {
  if (rows.length <= n) return rows;
  const head = rows.slice(0, n);
  const restAmt = rows.slice(n).reduce((s, r) => s + r.amount, 0);
  return [...head, { label: "Other", amount: restAmt } as T & { label: string }];
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? "30"), 1), 730);
  const entity = url.searchParams.get("entity");
  const d = db();
  const ph = NON_FLOW.map(() => "?").join(",");
  const entityClause = entity ? "AND entity = ?" : "";
  const base: unknown[] = [...NON_FLOW, `-${days} days`];
  const args = entity ? [...base, entity] : base;

  // Inflows (amount < 0 in Plaid's sign). Bank descriptions carry noisy suffixes
  // (e.g. "PAYROLL~ Future Amount: 10390 ~ Tran: DDIR"), which would split one
  // source into many nodes — so clean + re-aggregate the label in JS.
  const rawIncome = d.prepare(
    `SELECT COALESCE(merchant, name) AS label, -amount AS amount
     FROM transactions
     WHERE amount < 0 AND category NOT IN (${ph}) AND date >= date('now', ?) ${entityClause}`
  ).all(...(args as never[])) as unknown as { label: string; amount: number }[];
  const incomeRows = aggregate(rawIncome, cleanLabel);

  // Outflows by category (actual spending).
  const spendRows = d.prepare(
    `SELECT category AS label, SUM(amount) AS amount
     FROM transactions
     WHERE amount > 0 AND COALESCE(category,'Other') NOT IN (${ph},'Income','TaxRefund')
       AND date >= date('now', ?) ${entityClause}
     GROUP BY category ORDER BY amount DESC`
  ).all(...(args as never[])) as unknown as { label: string; amount: number }[];

  const income = topN(incomeRows.filter((r) => r.amount > 0), 6);
  const spending = topN(spendRows.filter((r) => r.amount > 0), 10);
  const incomeTotal = income.reduce((s, r) => s + r.amount, 0);
  const spendTotal = spending.reduce((s, r) => s + r.amount, 0);

  return NextResponse.json({
    days, entity: entity ?? "all",
    income, spending,
    incomeTotal: Math.round(incomeTotal * 100) / 100,
    spendTotal: Math.round(spendTotal * 100) / 100,
    saved: Math.round((incomeTotal - spendTotal) * 100) / 100,
  });
}
