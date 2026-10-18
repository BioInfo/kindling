import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Health of every Plaid connection, for the "needs reconnect" banner.
// stale = no successful sync in 3 days even though the status still says good.
export async function GET() {
  const rows = db().prepare(
    `SELECT i.id, COALESCE(i.institution_name, i.institution) AS institution, i.status, i.error, i.last_synced_at,
       (SELECT COUNT(*) FROM accounts a WHERE a.item_id = i.id) AS accounts,
       (i.last_synced_at IS NULL OR i.last_synced_at < datetime('now', '-3 days')) AS stale
     FROM items i WHERE i.status <> 'manual' ORDER BY institution`
  ).all() as unknown as {
    id: string; institution: string | null; status: string; error: string | null;
    last_synced_at: string | null; accounts: number; stale: number;
  }[];
  return NextResponse.json({
    connections: rows.map((r) => ({ ...r, stale: !!r.stale })),
  });
}
