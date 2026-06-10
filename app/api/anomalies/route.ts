import { NextRequest, NextResponse } from "next/server";
import { detectAnomalies } from "@/lib/anomalies";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Relative spending anomalies for the last 30 days (spikes, duplicates, new merchants).
export async function GET(req: NextRequest) {
  const entity = new URL(req.url).searchParams.get("entity");
  return NextResponse.json({ anomalies: detectAnomalies({ entity }) });
}

// Dismiss one or more flags by their stable key ("<kind>:<txn-id>"). Pass a
// single key to clear one row, or every visible key to "dismiss all". Returns
// the refreshed list (entity-scoped) so the client can render without a refetch.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const keys: unknown = body?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    return NextResponse.json({ error: "keys required" }, { status: 400 });
  }
  const ins = db().prepare(`INSERT OR IGNORE INTO dismissed_anomalies (anomaly_id) VALUES (?)`);
  for (const k of keys) if (typeof k === "string" && k) ins.run(k);
  const entity = new URL(req.url).searchParams.get("entity");
  return NextResponse.json({ ok: true, anomalies: detectAnomalies({ entity }) });
}
