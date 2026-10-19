# Changelog

Dated history, newest first. Backlog lives in `ROADMAP.md`; current state in `README.md`.

## 2026-10-19
- Category fixes from owner review: car loan (HMF/Hyundai) to Loan Payments, Kuranda to Pets, Beacon Electrical to Home, Home Depot to Household, Ro Health to Healthcare. Rules updated so new charges follow.

## 2026-10-18
- Fold re-linked Plaid items into one, flag logged-out banks, stop scheduling lapsed recurring charges.
- Net worth trend is connection-aware per account (visibility events, manual corrections, removals not shown as losses); weekly summary uses adjusted snapshots.
- Subscriptions split into Subscriptions / Bills / Transfers / Ended, with brand merges, types and per-row detail.
- Full recategorization with Amazon receipt matching from Gmail; new categories Home, Electronics, Household, Clothing, Pets, Personal Care, Loan Payments.
- Every sync now categorizes new transactions and reconciles subscriptions with GLM 5.3 (thinking lane for judgment, fast lane for bulk).
- Security and correctness fixes: chat SQL authorizer, CSV formula injection, rule precedence, paginated To-Review, local (Eastern) dates.

## 2026-09-19
- LLM calls send `thinking: {type: disabled}`; reasoning had been consuming the whole token budget.

## 2026-08-17
- Repointed the stale gateway model alias to `deepseek-flash-latest`.

## 2026-06-18
- Weekly digest reads secrets through a non-interactive `pass` wrapper so it cannot hang on gpg pinentry.

## 2026-06-16
- Manual (held-away) investment accounts: 529, TSP, Coinbase, small brokers. One synthetic `items` row per account (`status='manual'`, skipped by Plaid sync); balance tracks holdings, else a hand-entered value.
- Manual-holding quotes moved from Stooq to Yahoo Finance (fetched via curl; Node fetch is WAF-blocked); crypto priced via `-USD`.

## 2026-06-10
- v0.1.0 public release as Kindling (renamed from Plaid Money). README with sandbox screenshots and agent-install prompt.

## 2026-06-07
- Dedicated Subscriptions tab: Plaid Recurring plus in-house detector reconciled into a curated table; type classifier (subscription vs bill); price-hike, unused and trial flags; what-if-cancel; Calendar view; overlap finder.
- AI cut-plan ("What to cut"), cancel guides, merchant identify; one-tap reclassify to bill; category-seeded subscriptions; work-card migration tag.
- Shared `useModalZ()` fixes nested modal stacking.

## 2026-06-02
- Workbench IA: Overview, Transactions (Feed / To Review / Recurring / Rules), Subscriptions, Investments, Net Worth, Planning.
- Merchant and transaction detail/edit modals; transaction notes with opt-in AI context.
- Manual category picks propagate to similar transactions with undo.
- Header net worth now uses the connection-adjusted figure.

## 2026-06-01
- App moved to the mac-mini (tailnet-only behind the shared Caddy proxy).
- Connection-aware trends (`connection_events`, `adjustedTrend()`); investment holdings via Plaid Investments; manual assets with AI valuation.
- Budgets with rollover, goals with logged deposits, weekly and monthly summaries, tax center, equity-comp tracking, proactive insights feed.
- Weekly email digest via Resend; backup of `finance.db` as a WAL-consistent snapshot.
- Chat-with-your-money (read-only validated text-to-SQL, confirm-before-write edits).

## 2026-05-31
- Plaid Link and cursor sync, LLM categorization tail with editable rules, To-Review inbox, net worth trend, recurring detection, income-to-spending Sankey, business-expense export, anomaly alerts, 30-90 day cash-flow forecast, server-side pagination.
