// Standalone verification for manual (held-away) accounts. Runs against a TEMP db
// (FINANCE_DB_PATH set by the caller) so it never touches prod finance.db.
// Exercises: create → net worth → add holdings → recompute balance → quote-path
// recompute → delete cascade → sync exclusion.
import { createManualAccount, updateManualAccount, deleteManualAccount, listManualAccounts, recomputeManualAccountBalances } from "../lib/accounts.ts";
import { addManualHolding } from "../lib/holdings.ts";
import { computeNetWorth } from "../lib/networth.ts";
import { db } from "../lib/db.ts";

const ok = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

const base = computeNetWorth().net;
console.log("baseline net:", base);

// 1. Create a value-only account with an opening balance.
const { account_id: a529 } = createManualAccount({ name: "Vanguard 529", institution: "Vanguard", subtype: "529", balance: 12000 });
ok("create value-only account", listManualAccounts().some((a) => a.id === a529));
ok("net worth += opening balance", Math.round(computeNetWorth().net - base) === 12000, `net=${computeNetWorth().net}`);

// 2. Connection event recorded (opening step frozen → no windfall in trend).
const ce = db().prepare(`SELECT net_delta FROM connection_events WHERE item_id = ?`).get(a529) as { net_delta: number } | undefined;
ok("connection event frozen at opening", ce?.net_delta === 12000, `net_delta=${ce?.net_delta}`);

// 3. Create an account, add holdings → balance tracks holdings.
const { account_id: acoin } = createManualAccount({ name: "Coinbase", institution: "Coinbase", subtype: "crypto", balance: 0 });
addManualHolding({ account_id: acoin, ticker: "BTC", name: "Bitcoin", type: "cryptocurrency", quantity: 0.5, price: 60000, value: 30000 });
addManualHolding({ account_id: acoin, name: "TSP G Fund", type: "other", value: 5000 }); // value-only lot
let coinBal = (db().prepare(`SELECT current_balance FROM accounts WHERE id = ?`).get(acoin) as { current_balance: number }).current_balance;
ok("balance = sum(holdings) after add", coinBal === 35000, `balance=${coinBal}`);

// 4. Holding-less balance edit sticks; holding-backed balance edit is ignored.
updateManualAccount(a529, { balance: 15000 });
ok("balance edit sticks on value-only acct", (db().prepare(`SELECT current_balance FROM accounts WHERE id=?`).get(a529) as { current_balance: number }).current_balance === 15000);
updateManualAccount(acoin, { balance: 999 });
ok("balance edit ignored when holdings exist", (db().prepare(`SELECT current_balance FROM accounts WHERE id=?`).get(acoin) as { current_balance: number }).current_balance === 35000);

// 5. Simulate a quote move on the holding, then recompute (the quotes path).
db().prepare(`UPDATE holdings SET institution_value = 33000 WHERE account_id = ? AND security_id LIKE '%BTC%'`).run(acoin);
recomputeManualAccountBalances();
coinBal = (db().prepare(`SELECT current_balance FROM accounts WHERE id = ?`).get(acoin) as { current_balance: number }).current_balance;
ok("recompute folds in price move", coinBal === 38000, `balance=${coinBal}`);

// 6. Manual items are excluded from the Plaid sync query.
const syncable = db().prepare(`SELECT COUNT(*) AS n FROM items WHERE status NOT IN ('error','manual')`).get() as { n: number };
const manualItems = db().prepare(`SELECT COUNT(*) AS n FROM items WHERE status='manual'`).get() as { n: number };
ok("two manual items created", manualItems.n === 2, `manual=${manualItems.n}`);
ok("manual items excluded from sync set", syncable.n === 0, `syncable=${syncable.n}`);

// 7. Delete cascades account + holdings + connection event.
deleteManualAccount(acoin);
ok("account row gone", !db().prepare(`SELECT 1 FROM accounts WHERE id=?`).get(acoin));
ok("holdings cascaded", !db().prepare(`SELECT 1 FROM holdings WHERE account_id=?`).get(acoin));
ok("connection event cascaded", !db().prepare(`SELECT 1 FROM connection_events WHERE item_id=?`).get(acoin));
deleteManualAccount(a529);
ok("net worth back to baseline after delete", Math.round(computeNetWorth().net - base) === 0, `net=${computeNetWorth().net}`);

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
