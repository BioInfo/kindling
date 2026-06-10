# Kindling — design & architecture

A self-hosted personal finance app. Real bank data via Plaid, all data and AI on
your own hardware, ~$0/year ongoing. A Copilot Money / Monarch replacement built
around one idea: **your financial data and the AI that reads it stay on your
network.**

Kindling is the day-to-day money companion in a small family of fire-themed
finance apps (its sibling EmberPlan handles FIRE planning) — kindling is what you
tend daily so the ember catches.

---

## 1. Why it exists

- Hosted finance apps are ~$100/yr and ship your transactions to their cloud
  (and increasingly to third-party LLMs). Self-hosting is ~$0/yr: Plaid's free
  tier + your own hardware + a local model.
- Better categorization than the incumbents: Plaid's PFC taxonomy → **your own
  editable rules** (the thing Copilot won't give you) → an LLM tail for the
  ambiguous remainder, with write-back so the model's good calls become rules.
- Custom views: net worth that understands "I just linked an account" is new
  visibility, not new money; entity tags (personal vs business) on every
  transaction; subscriptions you can actually act on.

## 2. Cost reality

- **Plaid: $0.** The free tier includes 10 production Items, real data, no card.
  An Item = one login at one institution (one bank's checking+savings+card = 1
  Item), so 10 Items covers a typical household. Beyond that, Transactions bills
  around ~$0.30/Item/mo.
- **Hosting: $0.** Any always-on box (a Mac mini, a Pi 5, a NUC). Keep it
  private — Tailscale/WireGuard, never the public internet.
- **LLM: $0–cheap.** Any OpenAI-compatible endpoint. Local (Ollama, vLLM,
  LM Studio) keeps financial data on your network; a hosted model works too if
  you accept the tradeoff (the UI flags which models leave your network).

## 3. Stack

- **Next.js (App Router), TypeScript, Tailwind.** One repo. Plaid Link is JS-native.
- **SQLite** via `node:sqlite` (the built-in driver — no native build step;
  `better-sqlite3` fails to compile on recent Node).
- **Plaid Node SDK.**
- **Any OpenAI-compatible LLM gateway** (`LITELLM_BASE_URL` + `FINANCE_LLM_MODEL`).
- **Recharts** for charts.

## 4. Architecture

```
Plaid (banks)
  │  webhook: SYNC_UPDATES_AVAILABLE (optional)
  ▼
[public HTTPS pinhole → /api/webhook ONLY, Plaid-JWT-verified]
  │  (carries a signal, not data: "item X has updates")
  ▼
Next.js app on your box ── private network only ──► You (dashboard/chat)
  │
  ├─ /api/sync   → Plaid /transactions/sync (cursor) → SQLite (instant store)
  ├─ categorize  → Plaid PFC → rules table → LLM tail → write-back rules
  ├─ summarize   → LLM over aggregated SQL → in-app + optional email digest
  └─ chat        → LLM text-to-SQL → read-only finance.db → narrate
```

### Security model (financial data — strict)

- Default everything private-network-only (Tailscale serve or equivalent).
  Never expose the dashboard publicly.
- If you enable the real-time webhook, funnel **only** `/api/webhook`, gated by:
  1. **Plaid JWT verification** (`Plaid-Verification` header, ES256, against
     `/webhook_verification_key/get` + body SHA256). Drop anything unsigned.
  2. Path-only exposure (`/` and the DB never public).
  3. Webhook = signal only; the server pulls data via its own outbound Plaid call.
- Plaid `access_token`s **encrypted at rest** (AES-256-GCM, key from `pass`/env,
  never plaintext in the DB).
- Chat text-to-SQL: read-only DB connection, single-SELECT allowlist, table
  allowlist, injected LIMIT, reject any non-SELECT. The model proposes, a
  validator gates.
- Backstop nightly sync (cron/LaunchAgent) for missed webhooks, plus a staleness
  heartbeat so a broken Item never goes silent.
- Secrets live in `pass` or env vars — never in tracked files. `finance.db` is
  gitignored; real financial data never goes to any git remote.

### LLM guardrails

- Never block the sync path on the LLM: the store is instant; the LLM tail runs
  seconds later (or as a nightly batch).
- Treat the model as best-effort everywhere: every AI feature degrades cleanly
  when the gateway is down or the model is cold.
- Headline numbers are **always computed from SQL and templated** — the model
  narrates figures, it never invents them.

## 5. Feature map (shipped)

- Plaid Link connect/update, cursor sync, balances + investment holdings.
- Categorization: PFC → editable rules → LLM tail → write-back; To-Review inbox;
  manual picks propagate to similar transactions (with undo).
- Transaction feed with server-side search/filter/sort/pagination; merchant and
  transaction detail modals; per-transaction notes with opt-in AI context.
- Net worth (connection-aware trend), manual assets/debts with AI valuation,
  amortizing loans.
- Subscriptions: Plaid Recurring + an in-house detector reconciled into a curated
  table; price-hike/unused/trial flags; what-if-cancel; AI cut-plan + cancel
  guides; bills vs subscriptions split; work-card migration tags.
- Investments: holdings, allocation charts, equity-grant vesting (RSU/option/ESPP)
  with live quotes (Stooq).
- Budgets, goals, tax planning view, cash-flow forecast, Sankey money-flow,
  weekly/monthly plain-English summaries, chat-with-your-money (text-to-SQL),
  proactive insights feed, optional weekly email digest (Resend).

## 6. Design principles

- **Design with intent; don't bolt features on.** Every addition earns its
  screen space. When a surface gets cluttered, redesign it rather than patching.
- **Mobile-first.** No horizontal overflow at 375–390px, modals fit the screen,
  tap targets are finger-sized.
- **Every table** gets search + sort + filter + pagination (`useTableView` in
  `app/ui.tsx`).
- **Connection-aware everywhere.** Linking an account or backfilling history is
  new *visibility*, not new activity; every "change over time" surface excludes
  connection events.
