import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Everything we know about one account: metadata, balances, institution, the
// owner we can infer from the account name (Plaid's identity product, which
// returns verified owners, isn't enabled), recent transactions, and holdings if
// it's an investment account.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();

  const account = d.prepare(
    `SELECT a.id, a.name, a.official_name, a.mask, a.type, a.subtype,
            a.current_balance, a.available_balance, a.currency, a.updated_at,
            COALESCE(i.institution_name, i.institution) AS institution, i.status AS item_status, i.last_synced_at
     FROM accounts a JOIN items i ON a.item_id = i.id WHERE a.id = ?`
  ).get(id) as Record<string, unknown> | undefined;
  if (!account) return NextResponse.json({ error: "unknown account" }, { status: 404 });

  // Owner heuristic: brokerage account names embed the owner ("Jane Quinn
  // Public - Brokerage Account - ****0958"). Take the leading segment if it
  // reads like a person's name. Generic names ("Spending Account") yield null.
  const nm = String(account.name ?? "");
  const lead = nm.split(" - ")[0]?.trim() ?? "";
  const owner = /^[A-Z][a-z]+(?:\s+[A-Z][a-z.]+){1,3}/.test(lead) ? lead : null;

  const txns = d.prepare(
    `SELECT id, date, name, merchant, amount, currency, pending, category, entity
     FROM transactions WHERE account_id = ? ORDER BY date DESC, id DESC LIMIT 100`
  ).all(id) as unknown[];

  const txnStats = d.prepare(
    `SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM transactions WHERE account_id = ?`
  ).get(id) as { n: number; first: string | null; last: string | null };

  const holdings = d.prepare(
    `SELECT s.ticker, s.name, s.type, h.quantity, h.institution_price AS price,
            COALESCE(h.institution_value,0) AS value, h.cost_basis, h.source
     FROM holdings h JOIN securities s ON s.id = h.security_id
     WHERE h.account_id = ? ORDER BY value DESC`
  ).all(id) as unknown[];

  return NextResponse.json({ account: { ...account, owner }, txns, txnStats, holdings });
}
