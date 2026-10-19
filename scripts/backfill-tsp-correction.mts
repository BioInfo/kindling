// One-off: the Military TSP balance edit $500k -> $850k on 2026-06-19 fixed the
// starting figure; record it as a correction so the trend stops counting it as
// growth. Idempotent (a second run changes nothing). Point FINANCE_DB_PATH at the
// db to fix; run against a copy first. Prints adjustedTrend before/after.
//   FINANCE_DB_PATH=... PLAID_CLIENT_ID=x PLAID_SECRET=x APP_ENC_KEY=<key> npx tsx scripts/backfill-tsp-correction.mts
import { db } from "../lib/db.ts";
import { adjustedTrend } from "../lib/networth.ts";

const ITEM = "manual:15c6b377-3c78-47f0-ac11-32963e5c369a";
const DATE = "2026-06-19", DELTA = 850000 - 500000;
const d = db();
const ev = d.prepare(`SELECT net_delta FROM connection_events WHERE item_id = ?`).get(ITEM) as { net_delta: number } | undefined;
const acct = d.prepare(`SELECT id, name, current_balance FROM accounts WHERE item_id = ?`).get(ITEM) as { id: string; name: string; current_balance: number } | undefined;
if (!ev || !acct) throw new Error(`${ITEM} not found; nothing done`);
if (ev.net_delta !== 500000) throw new Error(`opening value is ${ev.net_delta}, expected 500000; nothing done`);
console.log(`account: ${acct.name}, balance ${acct.current_balance}, opening ${ev.net_delta}`);

const show = (l: string) => { const t = adjustedTrend(180); console.log(`${l}: change=${t.change.toFixed(2)} linkedExcluded=${t.linkedExcluded.toFixed(2)}`); };
show("before");
const has = d.prepare(`SELECT 1 FROM visibility_events WHERE kind = 'correction' AND item_id = ? AND date = ?`).get(ITEM, DATE);
if (has) console.log("correction already recorded; no change");
else {
  d.prepare(`INSERT INTO visibility_events (kind, item_id, account_id, date, net_delta, label) VALUES ('correction', ?, ?, ?, ?, 'TSP starting figure')`)
    .run(ITEM, acct.id, DATE, DELTA);
  console.log(`recorded correction +${DELTA} on ${DATE}`);
}
show("after");
