import { db } from "./db";

// Off-Plaid assets and debts (house, car, mortgage, private holdings) that feed
// net worth by hand. See manual_assets in db.ts for the connection-aware design.

export type ManualAsset = {
  id: number; name: string; kind: string; side: "asset" | "liability";
  value: number; note: string | null; created_at: string; updated_at: string;
  address: string | null; vehicle: string | null;
  est_value: number | null; est_low: number | null; est_high: number | null;
  est_note: string | null; est_as_of: string | null;
  apr: number | null; payee_match: string | null; last_paydown_date: string | null;
};
export type AssetsView = {
  assets: ManualAsset[];
  totalAsset: number;
  totalLiability: number;
  net: number; // contribution of manual items to net worth
};

const signed = (side: string, value: number) => (side === "liability" ? -value : value);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function listAssets(): AssetsView {
  const rows = db().prepare(
    `SELECT id, name, kind, side, value, note, created_at, updated_at,
            address, vehicle, est_value, est_low, est_high, est_note, est_as_of,
            apr, payee_match, last_paydown_date
     FROM manual_assets ORDER BY side ASC, value DESC`
  ).all() as unknown as ManualAsset[];
  const totalAsset = rows.filter((r) => r.side === "asset").reduce((s, r) => s + r.value, 0);
  const totalLiability = rows.filter((r) => r.side === "liability").reduce((s, r) => s + r.value, 0);
  return { assets: rows, totalAsset, totalLiability, net: totalAsset - totalLiability };
}

export function createAsset(a: { name: string; kind?: string; side?: "asset" | "liability"; value: number; note?: string | null; address?: string | null; vehicle?: string | null; apr?: number | null; payee_match?: string | null }): number {
  const side = a.side === "liability" ? "liability" : "asset";
  const res = db().prepare(
    `INSERT INTO manual_assets (name, kind, side, value, added_signed, note, address, vehicle, apr, payee_match)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(a.name, a.kind ?? "other", side, a.value, signed(side, a.value), a.note ?? null, a.address ?? null, a.vehicle ?? null, a.apr ?? null, a.payee_match ?? null);
  return Number(res.lastInsertRowid);
}

// Edits change value/name/kind. added_signed normally stays frozen — a later
// value change is real appreciation, so it must show as organic growth, not a
// new visibility step. The exception: a value/side change on the SAME DAY the
// asset was added is still refining the initial figure (the create → estimate →
// "use this" flow, or a same-day correction), so added_signed tracks it in
// lock-step. Without this, adding a house then setting its value reads the whole
// value as appreciation and spikes the net-worth trend.
export function updateAsset(id: number, f: { name?: string; kind?: string; side?: "asset" | "liability"; value?: number; note?: string | null; address?: string | null; vehicle?: string | null; apr?: number | null; payee_match?: string | null }): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (f.name !== undefined) { sets.push("name=?"); args.push(f.name); }
  if (f.kind !== undefined) { sets.push("kind=?"); args.push(f.kind); }
  if (f.side !== undefined) { sets.push("side=?"); args.push(f.side); }
  if (f.value !== undefined) { sets.push("value=?"); args.push(f.value); }
  if (f.note !== undefined) { sets.push("note=?"); args.push(f.note); }
  if (f.address !== undefined) { sets.push("address=?"); args.push(f.address); }
  if (f.vehicle !== undefined) { sets.push("vehicle=?"); args.push(f.vehicle); }
  if (f.apr !== undefined) { sets.push("apr=?"); args.push(f.apr); }
  if (f.payee_match !== undefined) { sets.push("payee_match=?"); args.push(f.payee_match); }
  // Same-day value/side change → keep added_signed in lock-step (still the
  // initial visibility step, not appreciation). After the add day it freezes.
  if (f.value !== undefined || f.side !== undefined) {
    const cur = db().prepare(
      `SELECT side, value, date(created_at) = date('now') AS sameDay FROM manual_assets WHERE id=?`
    ).get(id) as { side: string; value: number; sameDay: number } | undefined;
    if (cur?.sameDay) {
      const sideAfter = (f.side ?? cur.side) as "asset" | "liability";
      const valueAfter = f.value ?? cur.value;
      sets.push("added_signed=?"); args.push(signed(sideAfter, valueAfter));
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at=datetime('now')");
  args.push(id);
  db().prepare(`UPDATE manual_assets SET ${sets.join(", ")} WHERE id=?`).run(...(args as never[]));
}

// Store an AI valuation estimate (advisory — does not change `value`).
export function setEstimate(id: number, e: { value: number; low?: number | null; high?: number | null; note?: string | null }): void {
  db().prepare(
    `UPDATE manual_assets SET est_value=?, est_low=?, est_high=?, est_note=?, est_as_of=date('now'), updated_at=datetime('now') WHERE id=?`
  ).run(e.value, e.low ?? null, e.high ?? null, e.note ?? null, id);
}

export function getAsset(id: number): ManualAsset | undefined {
  return db().prepare(
    `SELECT id, name, kind, side, value, note, created_at, updated_at,
            address, vehicle, est_value, est_low, est_high, est_note, est_as_of,
            apr, payee_match, last_paydown_date
     FROM manual_assets WHERE id=?`
  ).get(id) as unknown as ManualAsset | undefined;
}

export function deleteAsset(id: number): void {
  db().prepare(`DELETE FROM manual_assets WHERE id=?`).run(id);
}

export type Paydown = { id: number; name: string; payments: number; principal: number; interest: number; newBalance: number };

// Auto-amortize manual loans from detected payments. For each liability that has
// an APR + a payee match, find its payments in the feed since the last one we
// applied (or since it was added — the entered balance already reflects history),
// split each into interest (balance × apr/12) + principal in date order, and cut
// the balance by the principal. The balance change lands after the add day, so
// added_signed stays frozen and the paydown reads as organic net-worth growth
// (cash → equity), not a visibility step. Idempotent via last_paydown_date.
export function applyLoanPaydowns(): Paydown[] {
  const loans = db().prepare(
    `SELECT id, name, value, apr, payee_match, last_paydown_date, date(created_at) AS created
     FROM manual_assets
     WHERE side='liability' AND apr IS NOT NULL AND COALESCE(payee_match,'') != ''`
  ).all() as unknown as { id: number; name: string; value: number; apr: number; payee_match: string; last_paydown_date: string | null; created: string }[];

  const out: Paydown[] = [];
  for (const loan of loans) {
    // Only payments AFTER we started tracking: payments before the add date are
    // already baked into the entered balance, so counting them would double-cut.
    const since = loan.last_paydown_date ?? loan.created;
    const pays = db().prepare(
      `SELECT date, amount FROM transactions
       WHERE amount > 0 AND date > ?
         AND (name LIKE '%' || ? || '%' OR merchant LIKE '%' || ? || '%')
       ORDER BY date ASC`
    ).all(since, loan.payee_match, loan.payee_match) as unknown as { date: string; amount: number }[];
    if (pays.length === 0) continue;

    let bal = loan.value;
    let totalP = 0, totalI = 0;
    const monthlyRate = loan.apr / 100 / 12;
    for (const p of pays) {
      const interest = bal * monthlyRate;
      const principal = Math.min(bal, Math.max(0, p.amount - interest)); // never below 0; if pmt < interest, no principal
      bal = round2(bal - principal);
      totalP += principal; totalI += Math.min(interest, p.amount);
    }
    db().prepare(
      `UPDATE manual_assets SET value=?, last_paydown_date=?, updated_at=datetime('now') WHERE id=?`
    ).run(bal, pays[pays.length - 1].date, loan.id);
    out.push({ id: loan.id, name: loan.name, payments: pays.length, principal: round2(totalP), interest: round2(totalI), newBalance: bal });
  }
  return out;
}
