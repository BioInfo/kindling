import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { PFC_MAP } from "./taxonomy";

// node:sqlite is built into Node 26 — no native compile, no ABI issues.
// Its API (exec/prepare/run/get/all) matches better-sqlite3 closely.

let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  const dir = path.dirname(config.db.path);
  fs.mkdirSync(dir, { recursive: true });
  const d = new DatabaseSync(config.db.path);
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("PRAGMA foreign_keys = ON");
  migrate(d);
  _db = d;
  return d;
}

function migrate(d: DatabaseSync) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id              TEXT PRIMARY KEY,          -- Plaid item_id
      institution     TEXT,
      access_token    TEXT NOT NULL,             -- AES-256-GCM encrypted
      cursor          TEXT,                      -- transactions/sync cursor
      status          TEXT NOT NULL DEFAULT 'good', -- good | error | re-auth
      error           TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      last_synced_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id              TEXT PRIMARY KEY,          -- Plaid account_id
      item_id         TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      name            TEXT,
      official_name   TEXT,
      mask            TEXT,
      type            TEXT,
      subtype         TEXT,
      current_balance REAL,
      available_balance REAL,
      currency        TEXT,
      updated_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id              TEXT PRIMARY KEY,          -- Plaid transaction_id
      account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      date            TEXT NOT NULL,             -- YYYY-MM-DD
      name            TEXT,                      -- raw description
      merchant        TEXT,                      -- Plaid merchant_name
      amount          REAL NOT NULL,             -- Plaid sign: + = outflow
      currency        TEXT,
      pending         INTEGER NOT NULL DEFAULT 0,
      plaid_category  TEXT,                      -- Plaid PFC primary
      plaid_detailed  TEXT,                      -- Plaid PFC detailed
      category        TEXT,                      -- YOUR final category
      category_source TEXT,                      -- plaid | rule | llm | manual
      confidence      REAL,
      entity          TEXT DEFAULT 'personal',   -- personal | business
      reviewed        INTEGER NOT NULL DEFAULT 0,
      raw             TEXT,                      -- full Plaid JSON
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_txn_reviewed ON transactions(reviewed);

    -- First-class, editable rules (the thing Copilot won't give you).
    CREATE TABLE IF NOT EXISTS rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      match_type  TEXT NOT NULL DEFAULT 'contains', -- contains | regex | exact
      pattern     TEXT NOT NULL,                     -- matched against name/merchant
      field       TEXT NOT NULL DEFAULT 'merchant',  -- merchant | name
      category    TEXT,
      entity      TEXT,
      rename      TEXT,                              -- override displayed merchant
      priority    INTEGER NOT NULL DEFAULT 100,
      source      TEXT NOT NULL DEFAULT 'manual',    -- manual | llm
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Free-form financial context for the chat layer (Phase 4).
    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      note        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Persistent chat history for the floating money-chat widget.
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      role        TEXT NOT NULL,             -- user | assistant
      content     TEXT NOT NULL,
      model       TEXT,                      -- which model answered
      sql         TEXT,                      -- the SELECT it ran (transparency)
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-category monthly budget targets. One row per category. The bucket tag
    -- powers Monarch-style grouping (fixed = rent/insurance, flexible = the
    -- day-to-day, nonmonthly = lumpy sinking-fund categories like taxes/travel);
    -- ignore it and you just get a flat category budget. rollover is stored for a
    -- future cross-month carry; v1 doesn't carry balances yet.
    CREATE TABLE IF NOT EXISTS budgets (
      category    TEXT PRIMARY KEY,          -- one of the taxonomy spend categories
      amount      REAL NOT NULL,             -- monthly target, positive dollars
      bucket      TEXT NOT NULL DEFAULT 'flexible', -- fixed | flexible | nonmonthly
      rollover    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Weekly LLM-narrated digest. One row per trailing-7-day period (keyed by
    -- the period start). stats is the deterministic SQL aggregate the model
    -- narrated from; narrative is its prose. Regenerating the same period upserts.
    CREATE TABLE IF NOT EXISTS summaries (
      week_start  TEXT PRIMARY KEY,          -- period start YYYY-MM-DD
      week_end    TEXT NOT NULL,
      stats       TEXT NOT NULL,             -- JSON of computed aggregates
      narrative   TEXT NOT NULL,             -- the model's prose digest
      model       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Monthly review digest. One row per reviewed calendar month (the last
    -- *complete* month, keyed YYYY-MM). Same shape as summaries: deterministic
    -- month-over-month SQL aggregates + category trend series in stats, the
    -- local model's prose in narrative. Regenerating the same month upserts.
    CREATE TABLE IF NOT EXISTS monthly_summaries (
      month       TEXT PRIMARY KEY,          -- reviewed month YYYY-MM (last complete)
      stats       TEXT NOT NULL,             -- JSON of MoM aggregates + category trends
      narrative   TEXT NOT NULL,
      model       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Savings goals: a named target, how much is set aside so far, and an
    -- optional deadline. saved is tracked manually (edit it as you fund the
    -- goal), deliberately not auto-linked to an account, since one savings
    -- account usually backs several goals at once. The monthly nudge is derived
    -- (remaining / months left), not stored.
    CREATE TABLE IF NOT EXISTS goals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      target      REAL NOT NULL,             -- goal amount, positive dollars
      saved       REAL NOT NULL DEFAULT 0,   -- running total (kept = SUM of contributions)
      deadline    TEXT,                      -- optional YYYY-MM-DD
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Append-only deposit log behind goals.saved (v2). Every change to a goal's
    -- saved total writes a signed row here in the same transaction, so
    -- SUM(amount) per goal always equals goals.saved — a deposit (+), a manual
    -- correction (adjustment), an opening balance, or a sweep from a category's
    -- underspend (source = 'underspend:<Category>'). ON DELETE CASCADE clears a
    -- goal's history with the goal (foreign_keys is ON).
    CREATE TABLE IF NOT EXISTS goal_contributions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id     INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      amount      REAL NOT NULL,             -- signed: + deposit, − withdrawal/correction
      source      TEXT NOT NULL DEFAULT 'manual', -- manual | adjustment | initial | underspend:<Category> | note
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One row per day: net worth over time, for the trend chart. Upserted on
    -- every sync and whenever the dashboard is opened (last write of the day wins).
    CREATE TABLE IF NOT EXISTS net_worth_snapshots (
      date        TEXT PRIMARY KEY,          -- YYYY-MM-DD
      assets      REAL NOT NULL,             -- sum of non-credit/loan balances
      liabilities REAL NOT NULL,             -- sum of credit/loan balances (positive)
      net         REAL NOT NULL,             -- assets - liabilities
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Connection events. Linking an account (or backfilling its history) makes
    -- money appear that you already had — a change in VISIBILITY, not wealth.
    -- One row per item records the signed net it added on its link date, so the
    -- net-worth trend can subtract these steps and show only organic change.
    -- net_delta is fixed at first observation (the jump the link caused); later
    -- balance movement on that item is real and is NOT captured here.
    CREATE TABLE IF NOT EXISTS connection_events (
      item_id     TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      date        TEXT NOT NULL,             -- YYYY-MM-DD the item was linked
      net_delta   REAL NOT NULL,             -- signed net the item added (assets +, liabilities −)
      label       TEXT,                      -- institution, for the UI note
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Securities held in investment accounts. Shared, not user-specific; keyed
    -- by Plaid security_id. close_price is the last market close Plaid has.
    CREATE TABLE IF NOT EXISTS securities (
      id                TEXT PRIMARY KEY,    -- Plaid security_id
      ticker            TEXT,
      name              TEXT,
      type              TEXT,                -- equity | etf | mutual fund | fixed income | cash | cryptocurrency | derivative | other
      is_cash_equivalent INTEGER NOT NULL DEFAULT 0,
      close_price       REAL,
      close_price_as_of TEXT,
      currency          TEXT,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- A holding = an account's position in a security. One row per
    -- (account, security). institution_value is what Plaid reports the position
    -- is worth; it is the source of truth for the holdings table and allocation.
    CREATE TABLE IF NOT EXISTS holdings (
      account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      security_id       TEXT NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
      quantity          REAL,
      institution_price REAL,
      institution_value REAL,               -- position value as reported
      cost_basis        REAL,
      currency          TEXT,
      source            TEXT NOT NULL DEFAULT 'plaid', -- plaid | manual
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, security_id)
    );
    CREATE INDEX IF NOT EXISTS idx_holdings_account ON holdings(account_id);

    -- Off-Plaid assets and debts entered by hand: a house, a car, a mortgage,
    -- private holdings. They feed net worth like any account balance. added_signed
    -- freezes the asset's signed value at the moment it was added, so the net-worth
    -- trend treats "I added my house" as new visibility, not a windfall, same
    -- rule as connection_events. Later edits to value flow through as real change.
    CREATE TABLE IF NOT EXISTS manual_assets (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      kind         TEXT NOT NULL DEFAULT 'other',   -- real_estate | vehicle | cash | other
      side         TEXT NOT NULL DEFAULT 'asset',   -- asset | liability
      value        REAL NOT NULL,                   -- current positive magnitude
      added_signed REAL NOT NULL,                   -- signed value at add (asset:+, liability:−), fixed
      note         TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Dismissed anomalies. detectAnomalies() recomputes flags on every load, so a
    -- "reviewed" flag has to persist by a stable id, not a row. anomaly_id is
    -- "<kind>:<txn-id>" — the same key the UI dismisses by — so dismissing a spike
    -- doesn't also hide a duplicate that happens to share the transaction.
    CREATE TABLE IF NOT EXISTS dismissed_anomalies (
      anomaly_id    TEXT PRIMARY KEY,
      dismissed_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- "What to know" insights feed (the proactive MOAT layer). Dismissals are
    -- keyed by the same stable "<kind>:<id>" scheme as dismissed_anomalies, but
    -- the feed spans more sources (bills due, budget overage, goal pace, forecast
    -- low, tax horizon) than the anomaly card it replaces, so it keeps its own
    -- table — clearing a budget-overage insight shouldn't resurrect a dismissed
    -- spending anomaly and vice-versa. A new occurrence re-fires (date is in the key).
    CREATE TABLE IF NOT EXISTS dismissed_insights (
      insight_id    TEXT PRIMARY KEY,
      dismissed_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Cache for the best-effort local-qwen one-line lede over the insights feed.
    -- Keyed by a per-day signature (date + hash of the visible insight keys) so a
    -- lede is generated once per distinct feed per day, not on every Overview load
    -- — this keeps the daily glance instant and dodges the NVFP4 cold-boot stall
    -- (the lede is generated out-of-band by the client after the cards render, and
    -- skipped entirely when the model gateway is down; see app/api/insights/lede).
    CREATE TABLE IF NOT EXISTS insight_lede (
      sig         TEXT PRIMARY KEY,            -- "<YYYY-MM-DD>:<hash-of-insight-keys>"
      lede        TEXT NOT NULL,
      model       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Closed-month ledger for ROLLOVER budgets (v2 envelope carry). One row per
    -- (category, fully-closed month). An underspent month banks its surplus into
    -- the next month's available budget; an overspent month carries a deficit.
    -- target/spent are FROZEN the first time a closed month is reconciled, so a
    -- later edit to the budget amount never rewrites history. carry_out =
    -- carry_in + target − spent, and chains into the next month's carry_in.
    -- Only rollover=1 budgets get rows; flat budgets reset every month and never
    -- appear here. Carry anchors at the budget's creation month (no fabricated
    -- pre-budget surplus) — see lib/budgets.ts reconcileRolloverLedger().
    CREATE TABLE IF NOT EXISTS budget_months (
      category    TEXT NOT NULL,            -- budgetable taxonomy category
      month       TEXT NOT NULL,            -- YYYY-MM, always a fully-closed month
      target      REAL NOT NULL,            -- budget amount as it stood at close
      spent       REAL NOT NULL,            -- actual outflow that month (global)
      carry_in    REAL NOT NULL,            -- envelope balance entering the month
      carry_out   REAL NOT NULL,            -- carry_in + target − spent
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (category, month)
    );

    -- Equity compensation grants (RSUs / options / ESPP) — the comp-tracking
    -- surface no consumer app does well. A grant vests over time from grant_date:
    -- a cliff (cliff_months) releases its block, then shares vest every vest_freq
    -- until vest_months. last_price is the cached quote for ticker (refreshed via
    -- the Refresh button + on sync) so net worth stays synchronous. Only VESTED
    -- value (shares you actually own) counts toward net worth; unvested is future.
    -- vested_value_at_add freezes the vested value the moment the grant was
    -- recorded, so adding a grant reads as new VISIBILITY, not a windfall — the
    -- same connection-aware rule as manual_assets.added_signed (see adjustedTrend).
    -- For options, value is intrinsic: shares × max(0, price − strike).
    CREATE TABLE IF NOT EXISTS equity_grants (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      employer      TEXT,                          -- employer name
      ticker        TEXT,                          -- public ticker, for live pricing
      kind          TEXT NOT NULL DEFAULT 'rsu',   -- rsu | option | espp
      grant_date    TEXT NOT NULL,                 -- YYYY-MM-DD
      shares        REAL NOT NULL,                 -- total granted shares/units
      strike        REAL,                          -- option strike (NULL for RSU/ESPP)
      cliff_months  INTEGER NOT NULL DEFAULT 12,   -- 0 = no cliff
      vest_months   INTEGER NOT NULL DEFAULT 48,   -- total vest period
      vest_freq     TEXT NOT NULL DEFAULT 'monthly', -- monthly | quarterly | annual
      last_price    REAL,                          -- cached quote for ticker
      price_as_of   TEXT,                          -- date of last_price
      vested_value_at_add REAL NOT NULL DEFAULT 0, -- frozen vested value at create (visibility step)
      note          TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Tax planning profile, one row per tax year. The inputs the app can't derive
    -- from Plaid data: filing status, state, the PRIOR-year tax (drives the
    -- safe-harbor target — the one number that kills the recurring underpayment
    -- penalty), and projections only the user knows (this year's withholding,
    -- gross income, self-employment net, pay periods left). Everything downstream
    -- (safe harbor, quarterly plan, W-4 suggestion, bracket estimate) is computed
    -- deterministically in lib/tax.ts from these + the equity grants + the txn
    -- entity tags. All planning estimates — the user confirms with their CPA.
    CREATE TABLE IF NOT EXISTS tax_profile (
      year                INTEGER PRIMARY KEY,        -- tax year, e.g. 2026
      filing_status       TEXT NOT NULL DEFAULT 'mfj',-- mfj | single | hoh | mfs
      state               TEXT NOT NULL DEFAULT 'VA',
      prior_year_tax      REAL NOT NULL DEFAULT 0,    -- prior-year TOTAL federal tax (safe-harbor base)
      prior_year_state_tax REAL NOT NULL DEFAULT 0,   -- prior-year total state tax
      prior_agi_over_threshold INTEGER NOT NULL DEFAULT 1, -- AGI>150k MFJ → 110% safe harbor, else 100%
      est_income          REAL NOT NULL DEFAULT 0,    -- projected current-year gross (bracket/effective estimate)
      est_fed_withholding REAL NOT NULL DEFAULT 0,    -- projected full-year federal withholding (all W-2s)
      est_state_withholding REAL NOT NULL DEFAULT 0,  -- projected full-year state withholding
      se_net_income       REAL NOT NULL DEFAULT 0,    -- self-employment net, for SE-tax flag
      est_current_tax_override REAL NOT NULL DEFAULT 0,-- pinned expected total fed tax (overrides the bracket calc when >0; lets a normalized estimate that strips one-time gains drive the 90%-of-current safe-harbor path)
      pay_periods_left    INTEGER NOT NULL DEFAULT 12,-- remaining paychecks this year (W-4 4c math)
      note                TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Estimated-tax payments the user has actually made, so the quarterly plan can
    -- net them out and the safe-harbor gap stays honest. One row per payment.
    CREATE TABLE IF NOT EXISTS tax_payments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      year         INTEGER NOT NULL,
      jurisdiction TEXT NOT NULL DEFAULT 'federal',   -- federal | state
      quarter      INTEGER,                           -- 1-4 (null = a one-off / extension payment)
      amount       REAL NOT NULL,                     -- positive dollars paid
      paid_date    TEXT NOT NULL,                     -- YYYY-MM-DD
      note         TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tax_payments_year ON tax_payments(year, jurisdiction);

    -- Curated subscription/recurring-charge state. detectRecurring() + Plaid's
    -- recurring streams generate CANDIDATES on every reconcile; this table holds
    -- the durable, user-owned layer on top so a dismiss, a re-classification, a
    -- rename, a trial date, or a note survives the next sync. id is a stable
    -- "<direction>:<merchant_key>" so reconcile upserts the same row and never
    -- clobbers the user fields. Detection refreshes the amount/date/status
    -- columns; it never rewrites state/type/merchant/note/trial_ends/color/icon,
    -- and never resurrects a dismissed/cancelled row (state is only set by the
    -- user via PATCH). category backfills once (COALESCE) then is user-owned.
    CREATE TABLE IF NOT EXISTS subscriptions (
      id            TEXT PRIMARY KEY,            -- "<direction>:<merchant_key>"
      entity        TEXT NOT NULL DEFAULT 'personal',
      merchant_key  TEXT NOT NULL,               -- norm() of the merchant, the match key
      merchant      TEXT NOT NULL,               -- display name (curated; defaults to detected)
      plaid_stream_id TEXT,                       -- set when matched to a Plaid recurring stream
      source        TEXT NOT NULL DEFAULT 'heuristic', -- plaid | heuristic | manual
      direction     TEXT NOT NULL DEFAULT 'expense',   -- expense | income
      type          TEXT,                         -- subscription | obligation | membership | other (AI/user)
      category      TEXT,
      cadence       TEXT,                         -- weekly | biweekly | monthly | quarterly | yearly
      interval_days INTEGER,
      avg_amount    REAL NOT NULL DEFAULT 0,
      last_amount   REAL NOT NULL DEFAULT 0,
      monthly       REAL NOT NULL DEFAULT 0,      -- amount normalized to a monthly figure
      count         INTEGER NOT NULL DEFAULT 0,
      first_date    TEXT,
      last_date     TEXT,
      next_expected TEXT,
      is_active     INTEGER NOT NULL DEFAULT 1,   -- Plaid is_active / not aged out
      price_change  REAL NOT NULL DEFAULT 0,      -- last_amount − avg_amount (>0 = hike)
      variable_amount INTEGER NOT NULL DEFAULT 0, -- usage-based (amount swings)
      state         TEXT NOT NULL DEFAULT 'active', -- active | trial | cancelled | dismissed
      trial_ends    TEXT,
      color         TEXT,
      icon          TEXT,
      note          TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_subs_state ON subscriptions(state);
    CREATE INDEX IF NOT EXISTS idx_subs_key ON subscriptions(merchant_key);
  `);

  // node:sqlite has no IF NOT EXISTS for columns, so probe pragma and ALTER once.
  const addCol = (table: string, col: string, decl: string) => {
    const has = (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
    if (!has) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  };
  addCol("holdings", "source", "TEXT NOT NULL DEFAULT 'plaid'");
  // Human-readable institution name (e.g. "Ally Bank"), resolved from the Plaid
  // institution_id at link time. `institution` still holds the id; the UI shows
  // COALESCE(institution_name, institution).
  addCol("items", "institution_name", "TEXT");
  // Valuation inputs + last AI estimate for manual assets (house address, vehicle
  // make/model/year). The estimate is advisory; `value` only changes when the user
  // accepts it. est_as_of dates the lookup so a stale estimate is obvious.
  for (const [c, t] of [
    ["address", "TEXT"], ["vehicle", "TEXT"], ["est_value", "REAL"], ["est_low", "REAL"],
    ["est_high", "REAL"], ["est_note", "TEXT"], ["est_as_of", "TEXT"],
    // Auto-amortize a manual loan: store its APR (%) and a payee substring that
    // identifies its payment in the feed; each detected payment splits into
    // interest (bal × apr/12) + principal, and principal cuts the balance.
    // last_paydown_date is the last payment date applied (idempotency cursor).
    ["apr", "REAL"], ["payee_match", "TEXT"], ["last_paydown_date", "TEXT"],
  ] as const) addCol("manual_assets", c, t);
  // Pinned expected current-year federal + state tax (added after tax_profile shipped).
  addCol("tax_profile", "est_current_tax_override", "REAL NOT NULL DEFAULT 0");
  addCol("tax_profile", "est_state_tax_override", "REAL NOT NULL DEFAULT 0");
  // Free-form per-transaction note (the txn detail/edit surface). Distinct from
  // the global `memories` table — this rides on the row itself.
  addCol("transactions", "note", "TEXT");
  // Work-card migration tag on a subscription — flags subs temporarily on a
  // personal card that belong on a work card (useful mid-employer-change).
  // null = personal, 'pending' = move when ready, 'moved' = already moved.
  addCol("subscriptions", "work_move", "TEXT");

  // One-time-ish backfill of the Plaid-PFC leak: older rows synced before the
  // mapPfc() fallback kept the raw primary as their category (FOOD_AND_DRINK,
  // ENTERTAINMENT, …). Re-map only rows still holding the raw label to the same
  // taxonomy value sync now uses. Idempotent: after the first pass category no
  // longer equals plaid_category, so it's a no-op. Self-heals any future leak.
  const fix = d.prepare(`UPDATE transactions SET category = ? WHERE category = ? AND plaid_category = ?`);
  for (const [pfc, cat] of Object.entries(PFC_MAP)) fix.run(cat, pfc, pfc);
}
