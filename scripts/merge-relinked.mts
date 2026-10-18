// Folds duplicate Plaid items (same institution re-linked through fresh Link)
// into the newest one. FINANCE_DB_PATH picks the db; --keep-plaid skips the
// Plaid /item/remove call (use it on a copy).
import { db } from "../lib/db.ts";
import { mergeRelinkedItem } from "../lib/relink.ts";
import { captureSnapshot } from "../lib/networth.ts";

const keepPlaid = process.argv.includes("--keep-plaid");
const newest = db().prepare(
  `SELECT i.id, i.institution_name FROM items i
   WHERE i.status <> 'manual' AND i.institution IS NOT NULL
     AND i.created_at = (SELECT MAX(created_at) FROM items j WHERE j.institution = i.institution AND j.status <> 'manual')
     AND (SELECT COUNT(*) FROM items j WHERE j.institution = i.institution AND j.status <> 'manual') > 1`
).all() as { id: string; institution_name: string }[];

for (const n of newest) {
  for (const r of await mergeRelinkedItem(n.id, { removeAtPlaid: !keepPlaid })) console.log(JSON.stringify(r));
}
const nw = captureSnapshot();
console.log("net worth now:", Math.round(nw.net), "assets", Math.round(nw.assets), "liabilities", Math.round(nw.liabilities));
