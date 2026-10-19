// Sync + relink money-path checks against a FRESH temp db, with Plaid stubbed
// (no network). FINANCE_DB_PATH must point at a throwaway file; it is wiped.
//   FINANCE_DB_PATH=$TMPDIR/vs.db PLAID_CLIENT_ID=x PLAID_SECRET=x \
//   APP_ENC_KEY=$(printf '0%.0s' {1..64}) npx tsx scripts/verify-sync.mts
import fs from "node:fs";
const dbPath = process.env.FINANCE_DB_PATH ?? "";
if (!dbPath || /finance\.db$/.test(dbPath)) throw new Error("set FINANCE_DB_PATH to a throwaway file");
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });

const { db } = await import("../lib/db.ts");
const { plaid } = await import("../lib/plaid.ts");
const { encrypt } = await import("../lib/crypto.ts");
const { syncAllItems } = await import("../lib/sync.ts");
const { dedupeMergedTransactions } = await import("../lib/relink.ts");
const { createAsset, applyLoanPaydowns, getAsset } = await import("../lib/assets.ts");

const ok = (l: string, c: boolean, extra = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${extra ? " — " + extra : ""}`); if (!c) process.exitCode = 1; };
const d = db();

// ---- Plaid stub: each sync call pops the next scripted response.
type Resp = { added?: object[]; modified?: object[]; removed?: object[]; has_more?: boolean; next_cursor: string } | Error;
let queue: Resp[] = [];
const seenCursors: (string | undefined)[] = [];
const p = plaid as unknown as Record<string, unknown>;
p.transactionsSync = async (req: { cursor?: string }) => {
  seenCursors.push(req.cursor);
  const r = queue.shift();
  if (!r) throw new Error("stub queue empty");
  if (r instanceof Error) throw r;
  return { data: { added: r.added ?? [], modified: r.modified ?? [], removed: r.removed ?? [], accounts: [acct], has_more: !!r.has_more, next_cursor: r.next_cursor } };
};
p.investmentsHoldingsGet = async () => { throw new Error("stub: no holdings"); };
p.transactionsRecurringGet = async () => { throw new Error("stub: no recurring"); };
const plaidErr = (code: string) => Object.assign(new Error("Request failed with status code 400"), { response: { data: { error_code: code, error_message: code } } });

const acct = { account_id: "A1", name: "Checking", official_name: null, mask: "1111", type: "depository", subtype: "checking", balances: { current: 1000, available: 1000, iso_currency_code: "USD" } };
const txn = (id: string, o: Record<string, unknown> = {}) => ({
  transaction_id: id, account_id: "A1", date: "2026-10-01", name: "COFFEE SHOP 123", merchant_name: "Coffee Shop",
  amount: 4.5, iso_currency_code: "USD", pending: false, pending_transaction_id: null,
  personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" }, ...o,
});
d.prepare(`INSERT INTO items (id, institution, access_token, status) VALUES ('I1', 'ins_1', ?, 'good')`).run(encrypt("access-sandbox-x"));
const row = (id: string) => d.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
const item = () => d.prepare(`SELECT cursor, status, error FROM items WHERE id = 'I1'`).get() as { cursor: string | null; status: string; error: string | null };

// 1. Pending → posted: Plaid sends the posted txn as a NEW id and removes the
//    pending one. The user's curation on the pending row must survive.
queue = [{ added: [txn("P1", { pending: true })], next_cursor: "c1" }];
await syncAllItems();
// A1 is not in accounts yet (as after update-mode adds an account): its rows must still land.
ok("txns for an account first seen in this sync are stored", !!row("P1"), JSON.stringify(item()));
d.prepare(`UPDATE transactions SET category='Business Meals', category_source='manual', entity='business', note='client coffee', reviewed=1 WHERE id='P1'`).run();
queue = [{ added: [txn("T1", { pending_transaction_id: "P1", date: "2026-10-02" })], removed: [{ transaction_id: "P1" }], next_cursor: "c2" }];
await syncAllItems();
const t1 = row("T1");
ok("pending row removed", !row("P1"));
ok("posted row keeps manual category", t1?.category === "Business Meals" && t1?.category_source === "manual", `${t1?.category}/${t1?.category_source}`);
ok("posted row keeps entity + note + reviewed", t1?.entity === "business" && t1?.note === "client coffee" && t1?.reviewed === 1);

// 2. A Plaid "modified" event must not revert a hand-edited merchant, but should
//    still refresh a merchant that was just Plaid's own name.
d.prepare(`UPDATE transactions SET merchant='Blue Bottle (office)' WHERE id='T1'`).run();
queue = [{ added: [txn("T2", { date: "2026-10-03", amount: 9 })], next_cursor: "c3" }];
await syncAllItems();
queue = [{ modified: [txn("T1", { date: "2026-10-02", merchant_name: "Coffee Shop Inc" }), txn("T2", { date: "2026-10-03", amount: 9, merchant_name: "Coffee Shop Inc" })], next_cursor: "c4" }];
await syncAllItems();
ok("modified keeps hand-edited merchant", row("T1")?.merchant === "Blue Bottle (office)", String(row("T1")?.merchant));
ok("modified refreshes a Plaid-sourced merchant", row("T2")?.merchant === "Coffee Shop Inc", String(row("T2")?.merchant));

// 3. TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION: restart the whole update from
//    the saved cursor; nothing from the aborted pages may be stored.
seenCursors.length = 0;
queue = [
  { added: [txn("GHOST", { date: "2026-10-04" })], has_more: true, next_cursor: "c5a" },
  plaidErr("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"),
  { added: [txn("T3", { date: "2026-10-04", amount: 12 })], next_cursor: "c5" },
];
await syncAllItems();
ok("restart begins at the saved cursor", seenCursors[2] === "c4", JSON.stringify(seenCursors));
ok("aborted page not stored", !row("GHOST"));
ok("restarted update stored + cursor saved", !!row("T3") && item().cursor === "c5" && item().status === "good", JSON.stringify(item()));

// 4. Any other mid-pagination failure: cursor stays put and no half update lands.
queue = [{ added: [txn("HALF", { date: "2026-10-05" })], has_more: true, next_cursor: "c6a" }, plaidErr("INTERNAL_SERVER_ERROR")];
await syncAllItems();
ok("failed update leaves cursor + data untouched", item().cursor === "c5" && !row("HALF") && item().status === "error", JSON.stringify(item()));

// 5. Relink dedupe: a PENDING row carried over from a removed item can never be
//    resolved by Plaid. Once the live link has history, an unmatched one goes.
if (!(d.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[]).some((c) => c.name === "merged_from")) d.exec(`ALTER TABLE transactions ADD COLUMN merged_from TEXT`);
d.prepare(`INSERT INTO transactions (id, account_id, date, name, amount, pending, merged_from) VALUES ('OLDPEND', 'A1', '2026-10-04', 'AMAZON', 167.63, 1, 'Iold')`).run();
d.prepare(`INSERT INTO transactions (id, account_id, date, name, amount, pending, merged_from) VALUES ('OLDPOST', 'A1', '2026-03-01', 'OLD HISTORY', 50, 0, 'Iold')`).run();
dedupeMergedTransactions();
ok("orphan merged pending row dropped", !row("OLDPEND"));
ok("merged posted history kept", !!row("OLDPOST"));

// 6. Loan paydown counts posted payments only (a pending one re-posts later).
const loan = createAsset({ name: "Car loan", side: "liability", value: 10000, apr: 0, payee_match: "AUTOLOAN" });
d.prepare(`UPDATE manual_assets SET created_at = '2026-09-01 00:00:00' WHERE id = ?`).run(loan);
d.prepare(`INSERT INTO transactions (id, account_id, date, name, amount, pending) VALUES ('LP1', 'A1', '2026-10-05', 'AUTOLOAN PMT', 500, 1)`).run();
applyLoanPaydowns();
ok("pending loan payment not applied", getAsset(loan)?.value === 10000, String(getAsset(loan)?.value));

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
