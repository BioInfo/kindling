import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Aggregate view of one merchant, keyed by the DISPLAYED name
// (COALESCE(NULLIF(merchant,''), name)) — the same thing the rest of the app
// treats as "the merchant", normalized by your rename rules. Backs the merchant
// detail/edit modal: headline spend + count + a monthly trend, the dominant
// category, the recent transactions, and a representative txn id so the modal
// can reuse the existing per-txn AI-identify path without its own LLM route.
//
// Name comes in as ?name= (a query param, not a path segment, so a merchant
// containing "/" or other URL-unsafe chars round-trips cleanly).

const DISPLAY = "COALESCE(NULLIF(t.merchant,''), t.name)";

export async function GET(req: NextRequest) {
  const name = (new URL(req.url).searchParams.get("name") ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const d = db();

  const agg = d.prepare(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0) AS totalOut,
            COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) AS totalIn,
            MIN(t.date) AS firstDate, MAX(t.date) AS lastDate
     FROM transactions t WHERE ${DISPLAY} = ?`
  ).get(name) as { count: number; totalOut: number; totalIn: number; firstDate: string | null; lastDate: string | null };

  if (!agg.count) return NextResponse.json({ error: "unknown merchant", name, count: 0 }, { status: 404 });

  // Dominant current category (most-used non-empty), so the modal shows what this
  // merchant is filed under and can offer to re-file every row.
  const cat = d.prepare(
    `SELECT t.category AS category, COUNT(*) AS n FROM transactions t
     WHERE ${DISPLAY} = ? AND COALESCE(t.category,'') != ''
     GROUP BY t.category ORDER BY n DESC LIMIT 1`
  ).get(name) as { category: string; n: number } | undefined;

  // Monthly net-outflow trend (last 12 calendar months present), oldest→newest,
  // for a sparkline. Outflow only (Plaid sign: + = outflow).
  const monthly = (d.prepare(
    `SELECT strftime('%Y-%m', t.date) AS ym,
            COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0) AS out
     FROM transactions t WHERE ${DISPLAY} = ?
     GROUP BY ym ORDER BY ym DESC LIMIT 12`
  ).all(name) as { ym: string; out: number }[]).reverse();

  // Recent transactions, same shape the UI's Txn rows expect (account labels).
  const txns = d.prepare(
    `SELECT t.id, t.date, t.name, t.merchant, t.amount, t.currency, t.pending,
            t.category, t.category_source, t.confidence, t.entity, t.reviewed,
            a.name AS account, a.mask AS account_mask,
            COALESCE(i.institution_name, i.institution) AS account_institution
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     LEFT JOIN items i ON i.id = a.item_id
     WHERE ${DISPLAY} = ? ORDER BY t.date DESC, t.id DESC LIMIT 100`
  ).all(name) as { id: string }[];

  return NextResponse.json({
    name,
    count: agg.count,
    totalOut: agg.totalOut,
    totalIn: agg.totalIn,
    firstDate: agg.firstDate,
    lastDate: agg.lastDate,
    category: cat?.category ?? null,
    monthly,                       // [{ ym, out }] oldest→newest
    repId: txns[0]?.id ?? null,    // most recent txn → reuse /identify
    txns,
  });
}

// Rename a merchant: apply a clean display name to EVERY transaction currently
// shown under `name` (exact displayed-name match, so it can't over-reach the way
// a fuzzy contains-rule would), optionally re-file them all to a category, and
// upsert a rename rule so future synced charges keep the name. Body:
// { name: <current display>, rename: <new name>, category?: <set on all> }.
export async function POST(req: NextRequest) {
  const b = await req.json();
  const name = String(b.name ?? "").trim();
  const rename = String(b.rename ?? "").trim();
  const category = typeof b.category === "string" && b.category.trim() ? b.category.trim() : null;
  if (!name || !rename) return NextResponse.json({ error: "name + rename required" }, { status: 400 });
  const d = db();

  // Did these rows carry a real Plaid merchant value, or only a raw descriptor?
  // That decides whether the durable rule keys off `merchant` or `name`.
  const hasMerchant = (d.prepare(
    `SELECT COUNT(*) AS n FROM transactions t WHERE ${DISPLAY} = ? AND COALESCE(t.merchant,'') != ''`
  ).get(name) as { n: number }).n > 0;
  const field = hasMerchant ? "merchant" : "name";

  // 1) Immediate apply to the exact set shown under this name. NOTE: an UPDATE
  // has no `t` alias, so the WHERE uses the UN-aliased displayed-name expression
  // (DISPLAY is `t.`-qualified for the SELECTs above and would throw here).
  const DISPLAY_UPD = "COALESCE(NULLIF(merchant,''), name)";
  const sets = ["merchant=?"];
  const args: unknown[] = [rename];
  if (category) { sets.push("category=?", "category_source='manual'", "confidence=1.0"); args.push(category); }
  args.push(name);
  const res = d.prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE ${DISPLAY_UPD} = ?`).run(...(args as never[]));

  // 2) Durable rename rule (contains-match on the original name) so future
  //    occurrences are renamed on sync. Upsert: don't pile up duplicates.
  const existing = d.prepare(`SELECT id FROM rules WHERE lower(pattern)=lower(?) AND field=? AND rename IS NOT NULL`).get(name, field) as { id: number } | undefined;
  if (existing) {
    d.prepare(`UPDATE rules SET rename=?, category=COALESCE(?, category), source='manual', priority=10 WHERE id=?`).run(rename, category, existing.id);
  } else {
    d.prepare(
      `INSERT INTO rules (match_type, pattern, field, category, rename, source, priority)
       VALUES ('contains', ?, ?, ?, ?, 'manual', 10)`
    ).run(name, field, category, rename);
  }

  return NextResponse.json({ ok: true, applied: Number(res.changes ?? 0), rename });
}
