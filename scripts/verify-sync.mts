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

// 7. Partial relink merge: the old item has a twin account plus an unpaired $0
//    account with history. After the merge, the next sync must not bring the
//    merged account back (it did while the old item stayed alive).
const { mergeRelinkedItem } = await import("../lib/relink.ts");
const { computeNetWorth } = await import("../lib/networth.ts");
const acct2 = (id: string, mask: string, bal: number) => ({ ...acct, account_id: id, name: id, mask, balances: { current: bal, available: bal, iso_currency_code: "USD" } });
const byToken: Record<string, object[]> = {
  "tok-old": [acct2("OLD_CHK", "9999", 1000), acct2("OLD_CLOSED", "8888", 0)],
  "tok-new": [acct2("NEW_CHK", "9999", 1000)],
  "access-sandbox-x": [acct],
};
p.transactionsSync = async (req: { access_token: string }) =>
  ({ data: { added: [], modified: [], removed: [], accounts: byToken[req.access_token] ?? [], has_more: false, next_cursor: "z" } });
const insA = d.prepare(`INSERT INTO accounts (id, item_id, name, mask, type, subtype, current_balance) VALUES (?, ?, ?, ?, 'depository', 'checking', ?)`);
d.prepare(`INSERT INTO items (id, institution, access_token, status, created_at) VALUES ('IOLD', 'ins_2', ?, 'good', '2026-01-01 00:00:00')`).run(encrypt("tok-old"));
insA.run("OLD_CHK", "IOLD", "OLD_CHK", "9999", 1000); insA.run("OLD_CLOSED", "IOLD", "OLD_CLOSED", "8888", 0);
d.prepare(`INSERT INTO transactions (id, account_id, date, name, amount) VALUES ('H1', 'OLD_CLOSED', '2025-06-01', 'OLD', 10)`).run();
d.prepare(`INSERT INTO items (id, institution, access_token, status) VALUES ('INEW', 'ins_2', ?, 'good')`).run(encrypt("tok-new"));
insA.run("NEW_CHK", "INEW", "NEW_CHK", "9999", 1000);
await mergeRelinkedItem("INEW", { removeAtPlaid: false });
const nwMerged = computeNetWorth().net;
await syncAllItems();
const nwSynced = computeNetWorth().net;
ok("partial merge: next sync does not double net worth", nwSynced === nwMerged, `merged=${nwMerged} synced=${nwSynced}`);
ok("partial merge: merged account stays gone", !d.prepare(`SELECT 1 FROM accounts WHERE id = 'OLD_CHK'`).get());
ok("partial merge: unpaired history kept", !!row("H1"));

// Visibility events (B, C, A). Absent table = old code = FAIL, not a crash.
const today = new Date().toISOString().slice(0, 10);
const vis = (where: string, ...args: string[]) => {
  try { return d.prepare(`SELECT kind, date, net_delta FROM visibility_events WHERE ${where} ORDER BY id`).all(...args) as { kind: string; date: string; net_delta: number }[]; }
  catch { return []; }
};

// 8a. An account added to a linked item later (update mode) is visibility, not growth.
byToken["access-sandbox-x"] = [acct, acct2("A2", "2020", 500)];
await syncAllItems();
const a2 = vis("account_id = 'A2' AND kind = 'account'");
ok("update-mode account: own visibility step", a2.length === 1 && a2[0].net_delta === 500 && a2[0].date === today, JSON.stringify(a2));
ok("pre-existing account in a new item adds 0", vis("account_id = 'A1' AND kind = 'account'")[0]?.net_delta === 0, JSON.stringify(vis("account_id = 'A1'")));

// 8b. Re-link that also picks a never-linked account: the twin adds nothing, the
//     first-time account keeps its own step after the new item's event is dropped.
const { syncConnectionEvents } = await import("../lib/networth.ts");
d.prepare(`INSERT INTO items (id, institution, access_token, status, created_at) VALUES ('IOLD2', 'ins_3', ?, 'good', '2026-01-01 00:00:00')`).run(encrypt("tok-old2"));
insA.run("OLD2_CHK", "IOLD2", "OLD2_CHK", "7777", 1000);
syncConnectionEvents();
d.prepare(`INSERT INTO items (id, institution, access_token, status) VALUES ('INEW2', 'ins_3', ?, 'good')`).run(encrypt("tok-new2"));
insA.run("NEW2_CHK", "INEW2", "NEW2_CHK", "7777", 1000); insA.run("NEW2_SAV", "INEW2", "NEW2_SAV", "6666", 300);
syncConnectionEvents();
await mergeRelinkedItem("INEW2", { removeAtPlaid: false });
const sav = vis("account_id = 'NEW2_SAV' AND kind = 'account'");
ok("re-link: first-time account keeps +300", sav[0]?.net_delta === 300 && sav[0]?.date === today, JSON.stringify(sav));
ok("re-link: twin account adds 0", vis("account_id = 'NEW2_CHK' AND kind = 'account'")[0]?.net_delta === 0);
const ev3 = d.prepare(`SELECT date, net_delta FROM connection_events WHERE item_id = 'INEW2'`).get() as { date: string; net_delta: number } | undefined;
ok("re-link: original link event kept", ev3?.date === "2026-01-01" && ev3?.net_delta === 1000, JSON.stringify(ev3));

// 9. Deleting a manual account is lost visibility, not a loss: for a point inside
//    its life the lift is -2000 (matches today's level), before its link it is 0.
const { createManualAccount, deleteManualAccount, updateManualAccount } = await import("../lib/accounts.ts");
const { account_id: gone } = createManualAccount({ name: "Old 529", subtype: "529", balance: 2000 });
d.prepare(`UPDATE connection_events SET date = '2026-09-01' WHERE item_id = ?`).run(gone);
deleteManualAccount(gone);
const rm = vis("item_id = ? AND kind IN ('link', 'removal')", gone);
const liftAt = (pt: string) => rm.reduce((s, e) => (e.date > pt ? s + e.net_delta : s), 0);
ok("delete: link event preserved + removal recorded", rm.length === 2 && liftAt("2026-09-15") === -2000 && liftAt("2026-08-15") === 0, JSON.stringify(rm));

// 10. A manual balance edit flagged as a correction is visibility; unflagged it is growth.
const { account_id: tsp } = createManualAccount({ name: "TSP", subtype: "tsp", balance: 500000 });
updateManualAccount(tsp, { balance: 850000, correction: true } as Parameters<typeof updateManualAccount>[1]);
const corr = vis("item_id = ? AND kind = 'correction'", tsp);
ok("correction edit records +350000 today", corr.length === 1 && corr[0].net_delta === 350000 && corr[0].date === today, JSON.stringify(corr));
updateManualAccount(tsp, { balance: 900000 });
ok("plain edit records nothing", vis("item_id = ? AND kind = 'correction'", tsp).length === 1);

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
