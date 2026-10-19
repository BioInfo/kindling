// Recategorization checks against a FRESH temp db; no network (LLM off, no Gmail).
//   FINANCE_DB_PATH=$TMPDIR/vr.db npx tsx scripts/verify-recategorize.mts
import fs from "node:fs";
const dbPath = process.env.FINANCE_DB_PATH ?? "";
if (!dbPath || /finance\.db$/.test(dbPath)) throw new Error("set FINANCE_DB_PATH to a throwaway file");
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
delete process.env.ORDERS_GMAIL_ACCOUNT;
// config.ts requires these at import; nothing here calls Plaid or decrypts.
process.env.PLAID_CLIENT_ID ??= "x";
process.env.PLAID_SECRET ??= "x";
process.env.APP_ENC_KEY ??= "0".repeat(64);

const { db } = await import("../lib/db.ts");
const R = await import("../lib/recategorize.ts");
const O = await import("../lib/orders.ts");
const { rememberMerchantCategory } = await import("../lib/categorize.ts");

const ok = (l: string, c: boolean, extra = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${extra ? " — " + extra : ""}`); if (!c) process.exitCode = 1; };
const d = db();
O.ensureOrdersSchema();
d.exec(`INSERT INTO items (id, institution, access_token) VALUES ('I1', 'Bank', 'x');
        INSERT INTO accounts (id, item_id, name, type, subtype) VALUES ('C1', 'I1', 'Card', 'credit', 'credit card');`);
const ins = d.prepare(`INSERT INTO transactions (id, account_id, date, name, merchant, amount, plaid_category, plaid_detailed, category, category_source, confidence)
  VALUES (?, 'C1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const MKT = "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES";
ins.run("fresh", "2026-10-01", "AMAZON FRESH*AB12", "Amazon", 54.2, "GENERAL_MERCHANDISE", MKT, "Shopping", "plaid", 0.5);
ins.run("kindle", "2026-10-02", "Kindle Svcs*597DF0EO2", "Amazon Kindle", 8.49, "ENTERTAINMENT", "ENTERTAINMENT_OTHER_ENTERTAINMENT", "Groceries", "rule", 1);
ins.run("elec", "2026-10-16", "AMAZON MKTPL*5E71V19D1", "Amazon", 170.66, "GENERAL_MERCHANDISE", MKT, "Groceries", "rule", 1);
ins.run("noreceipt", "2026-10-16", "AMAZON MKTPL*ZZZ", "Amazon", 33.33, "GENERAL_MERCHANDISE", MKT, "Groceries", "rule", 1);
ins.run("manual", "2026-10-03", "AMAZON MKTPL*MAN", "Amazon", 25, "GENERAL_MERCHANDISE", MKT, "Groceries", "manual", 1);
ins.run("royalty", "2026-10-04", "AMAZON MEDIA EU S.A R.L. PAYMENT NTE*ADD", "Amazon", -75.17, "INCOME", "INCOME_CONTRACTOR", "Groceries", "rule", 1);
ins.run("cleaner", "2026-10-06", "Venmo", null, 480, "TRANSFER_OUT", "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS", "Transfer:P2P", "plaid", 0.5);
ins.run("venmo", "2026-10-07", "Venmo", null, 1289, "TRANSFER_OUT", "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS", "Transfer:P2P", "plaid", 0.5);
ins.run("jpm", "2026-09-22", "JPMorgan Chase Ext Trnsfr", null, 688.98, "OTHER", "OTHER_OTHER", "Other", "plaid", 0.5);
ins.run("prosper", "2026-09-03", "PROSPER MARKETPL EDI PYMNTS", "Prosper Marketplace - Micro-lending", 100, "LOAN_PAYMENTS", "LOAN_PAYMENTS_OTHER_PAYMENT", "Other", "plaid", 0.5);
// An electronics shipment email for the 170.66 charge.
d.prepare(`INSERT INTO order_receipts (id, source, kind, order_id, date, total, label, items, subject)
  VALUES ('m1', 'gmail', 'shipped', '114-7163212-6027432', '2026-10-15', 170.66, 'Electronics', '[]', 'Shipped 1 item: Electronics')`).run();
d.exec(`INSERT INTO rules (match_type, pattern, field, category, source, priority) VALUES ('contains', 'Amazon', 'merchant', 'Groceries', 'llm', 50)`);

// Parsers
ok("subject label, new format", O.subjectLabel("Ordered 3 items: Breakfast Cereal, Pet Supplies, and more") === "Breakfast Cereal, Pet Supplies");
ok("subject label, count format", O.subjectLabel("Ordered: ⁦9⁩ Grocery and Snack Foods items") === "Grocery and Snack Foods", String(O.subjectLabel("Ordered: ⁦9⁩ Grocery and Snack Foods items")));
ok("total from shipment text", O.parseTotal("Order #\n114-1\nTotal\n$7.20\nView") === 7.2);
ok("grand total wins", O.parseTotal("Grand Total:\n$170.66\nTotal\n$1.00") === 170.66);
ok("items parse", JSON.stringify(O.parseItems("x\nZojirushi Coffee...\nQuantity: 1\n$\n71\n99")) === JSON.stringify([{ name: "Zojirushi Coffee", qty: 1, price: 71.99 }]));
const csv = O.receiptsFromCsv(`"Order ID","Order Date","Ship Date","Product Name","Quantity","Total Owed"\n"111-1","2026-10-01T10:00:00Z","2026-10-02T01:00:00Z","USB-C Cable","1","12.50"\n"111-1","2026-10-01T10:00:00Z","2026-10-02T01:00:00Z","Dog Treats","1","7.50"`);
ok("csv: one receipt per order+ship date, summed", csv.length === 1 && csv[0].total === 20 && csv[0].items.length === 2);

const m = O.matchReceipts();
ok("receipt matched to the charge by total and date", m.matched === 1 && O.receiptForTxn("elec")?.order_id === "114-7163212-6027432");

// Full pass without the model
const run = async () => {
  const rules = R.loadRules().filter((r) => r.source !== "llm");
  const plans = await R.planRows(R.loadTxns(), { llm: false, rules });
  return { plans, changes: R.diffPlans(plans) };
};
const first = await run();
R.writeChanges(first.changes);
const get = (id: string) => d.prepare(`SELECT category, category_source AS src, merchant, confidence FROM transactions WHERE id=?`).get(id) as
  { category: string; src: string; merchant: string | null; confidence: number };

ok("Amazon Fresh -> Groceries", get("fresh").category === "Groceries", JSON.stringify(get("fresh")));
ok("Amazon Fresh keeps an honest display name", get("fresh").merchant === "Amazon Fresh");
ok("Kindle -> Subscriptions", get("kindle").category === "Subscriptions");
ok("electronics marketplace order -> Electronics (receipt)", get("elec").category === "Electronics" && get("elec").merchant === "Amazon", JSON.stringify(get("elec")));
ok("marketplace charge with no receipt -> Shopping, low confidence (To-Review)", get("noreceipt").category === "Shopping" && get("noreceipt").confidence < R.REVIEW_BELOW);
ok("manual row untouched", get("manual").category === "Groceries" && get("manual").src === "manual");
ok("KDP royalty credit -> Income", get("royalty").category === "Income");
ok("cleaner on Venmo -> Home", get("cleaner").category === "Home");
ok("other Venmo stays P2P", get("venmo").category === "Transfer:P2P");
ok("JPMorgan ext transfer counts as spending, not Transfer", !get("jpm").category.startsWith("Transfer") && get("jpm").category !== "Other", get("jpm").category);
ok("Prosper hold row untouched", get("prosper").category === "Other" && get("prosper").src === "plaid");

const second = await run();
ok("idempotent: second pass changes nothing", second.changes.length === 0, `${second.changes.length} changes`);

const audit = R.auditRules(R.loadRules(), second.plans);
ok("audit deletes the blanket Amazon rule", audit.deletes.some((x) => x.rule.pattern === "Amazon"));

// A hand pick on Amazon must not spread to every Amazon row.
ok("manual pick on a multi-category merchant writes no rule", rememberMerchantCategory("noreceipt", "Groceries") === null);

// After-sync entry point: never throws, never touches manual rows.
d.prepare(`INSERT INTO transactions (id, account_id, date, name, merchant, amount, plaid_category, plaid_detailed, category, category_source, confidence)
  VALUES ('new1', 'C1', '2026-10-17', 'Kindle Unltd*0Z5SV9O63', 'Amazon Kindle', 11.99, 'ENTERTAINMENT', 'ENTERTAINMENT_OTHER_ENTERTAINMENT', 'Entertainment', 'plaid', 0.5)`).run();
const after = await R.classifyNewTransactions({ llm: false, fetchReceipts: false });
ok("classifyNewTransactions labels a new Kindle Unlimited row", !after.error && get("new1").category === "Subscriptions" && get("new1").merchant === "Kindle Unlimited", JSON.stringify(after));
ok("classifyNewTransactions left the manual row alone", get("manual").category === "Groceries" && get("manual").src === "manual");
