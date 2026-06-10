// Example: seed an account with hand-entered holdings, for institutions whose
// investments Plaid can't fetch (e.g. Ally Invest). Copy, fill in YOUR account id
// (the `accounts.id` Plaid gave it — see the accounts table) and your positions
// from the brokerage's holdings screen, then run: node scripts/<your-copy>.mjs
// Idempotent — re-running upserts. Needs FINANCE_DB_PATH or ./data/finance.db.
// Keep your copy out of git: name it seed-*-holdings.mjs (gitignored) or add it
// to .gitignore yourself — it contains real positions.
import { DatabaseSync } from "node:sqlite";

const DB = process.env.FINANCE_DB_PATH ?? "./data/finance.db";
const db = new DatabaseSync(DB);

// Ensure holdings.source exists (the app adds it on boot; this lets the seed run
// standalone before the next rebuild). Idempotent.
const hasSource = db.prepare(`PRAGMA table_info(holdings)`).all().some((c) => c.name === "source");
if (!hasSource) db.exec(`ALTER TABLE holdings ADD COLUMN source TEXT NOT NULL DEFAULT 'plaid'`);

const ACCOUNT_ID = "SET_ME_plaid_account_id";

// [ticker, name, type, quantity, price(last), value(mkt), cost_basis(total)]
// Unpriced positions (blank market value at the broker) → value 0, keep qty+cost.
const HOLDINGS = [
  ["VOO", "Vanguard S&P 500 ETF", "etf", 10, 500.0, 5000.0, 4200.0],
  ["AAPL", "Apple Inc.", "equity", 5, 200.0, 1000.0, 750.0],
  ["BTC", "Bitcoin", "cryptocurrency", 0.1, null, 0, 3000.0],
];

const upSec = db.prepare(
  `INSERT INTO securities (id, ticker, name, type, is_cash_equivalent, close_price, close_price_as_of, currency, updated_at)
   VALUES (?, ?, ?, ?, 0, ?, NULL, 'USD', datetime('now'))
   ON CONFLICT(id) DO UPDATE SET ticker=excluded.ticker, name=excluded.name, type=excluded.type, close_price=excluded.close_price, updated_at=datetime('now')`
);
const upHold = db.prepare(
  `INSERT INTO holdings (account_id, security_id, quantity, institution_price, institution_value, cost_basis, currency, source, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, 'USD', 'manual', datetime('now'))
   ON CONFLICT(account_id, security_id) DO UPDATE SET
     quantity=excluded.quantity, institution_price=excluded.institution_price,
     institution_value=excluded.institution_value, cost_basis=excluded.cost_basis,
     source='manual', updated_at=datetime('now')`
);

let total = 0;
for (const [ticker, name, type, qty, price, value, cost] of HOLDINGS) {
  const slug = (ticker || name).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  const secId = `manual:${ACCOUNT_ID}:${slug}`;
  upSec.run(secId, ticker, name, type, price);
  upHold.run(ACCOUNT_ID, secId, qty, price, value, cost);
  total += value ?? 0;
}
console.log(`${HOLDINGS.length} holdings seeded, market value $${total.toFixed(2)}`);
