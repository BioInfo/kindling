# Recategorize plan

Goal: every transaction carries the category of what was bought, every rule is one
the data supports, and new rows after each sync land the same way.

## Signals, strongest first (per non-manual row)

1. **Hold list** - rows the owner left for review (Prosper, RR Bowker): untouched.
2. **User rules** (`rules.source != 'llm'`) - the owner's intent. Applied as written.
3. **Order receipts** (`lib/orders.ts`) - Amazon order/shipment emails (Gmail via
   `gogx`, read-only) or an Amazon "Your Orders" CSV in `data/`. A card charge
   matches a receipt by exact total and a date window. The receipt's Amazon
   category label ("Electronics", "Snack Foods") or item names decide the category.
4. **Descriptor rules** (`DESCRIPTOR_RULES` in `lib/recategorize.ts`) - code rules
   on the raw bank descriptor for multi-category merchants and known facts:
   Amazon Tips / Grocery Subscription -> Groceries, Kindle -> Subscriptions,
   Amazon Media EU / Amazon.com Services payments (credits) -> Income (book
   royalties), Apple.com/bill -> Subscriptions, Uber trips vs Uber One, Walmart+
   vs Walmart, Wawa fuel vs store, Costco gas, student/auto loans -> Loans,
   JPMorgan Chase Ext Trnsfr -> Loans (owner: a real payment out), cleaner
   payments -> Home.
5. **Single-category LLM rules** that survive the audit.
6. **LLM** (fast lane, batches of 20, sequential) with name, merchant, Plaid
   detailed, amount, account type. Writes category, a clean display merchant
   when Plaid gave none, and confidence. Below 0.6 -> "Other" (To-Review).
7. Fallback: `mapPfc(primary, detailed)`.

Never written: `category_source='manual'` rows. Instead `flagManualPicks()` lists
manual picks whose category disagrees with signals 3-4 or with a strong Plaid
detailed category.

## Taxonomy additions (counts measured on the 2026-10-18 copy)

Electronics, Household, Clothing, Pets, Personal Care, Loans. Each is justified
by the dry-run counts in the report; prompts and `mapPfc` read `CATEGORIES`.

## Rules audit (`scripts/audit-rules.mts`)

- Delete LLM rules on multi-category merchants (Amazon, Apple, Walmart, Costco,
  Uber, Target, Google, Wawa) - per-row signals replace them.
- Delete LLM rules whose substring is too broad (matches rows of 2+ categories
  in the data, or a pattern under 4 chars).
- Delete LLM rules duplicated or contradicted by a user rule.
- Add LLM rules only for merchants whose rows (after the pass) are 100% one
  category with 3+ rows.
- Manual rules are never deleted; suspicious ones are printed.

## Moving forward

`classifyNewTransactions({ llm })` after each sync: refresh receipts (best
effort), then run signals 3-7 on rows still `category_source='plaid'`, capped.
Never throws, never touches manual rows.

## Evidence

`scripts/recategorize-all.mts` (dry-run default, `--apply`): before/after per
category, 40 sample changes, flagged manual picks. `scripts/verify-recategorize.mts`
asserts key cases on a throwaway db.
