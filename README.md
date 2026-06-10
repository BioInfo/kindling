# Kindling

Self-hosted personal finance. Real bank data via [Plaid](https://plaid.com), all
data and AI on your own hardware, ~$0/year. A Copilot Money / Monarch replacement
built around one idea: **your financial data, and the AI that reads it, stay on
your network.**

Kindling is the daily-money companion in a small family of fire-themed finance
apps (its sibling **EmberPlan** handles FIRE planning). Kindling is what you tend
every day so the ember catches.

## What you get

- **Plaid sync** — connect banks/brokerages, cursor-based transaction sync,
  balances, investment holdings. Free tier covers 10 institutions.
- **Categorization that's yours** — Plaid's taxonomy → *your editable rules* →
  an LLM tail for the ambiguous remainder, with write-back so good calls become
  rules. A To-Review inbox, one-tap AI suggestions, propagation with undo.
- **Subscriptions** — Plaid Recurring + an in-house detector, price-hike /
  unused / trial flags, what-if-cancel ("tick rows, watch the $/mo drop"), an AI
  cut-plan, cancel guides, a charge calendar.
- **Net worth** that knows linking an account is new *visibility*, not new
  money. Manual assets/debts with AI valuation, amortizing loans, equity-grant
  vesting with live quotes.
- **Forward-looking** — cash-flow forecast, budgets, goals, tax planning view.
- **Chat with your money** — text-to-SQL over a read-only connection, with a
  validator gating every query.
- **Weekly digest** — optional plain-English email (Resend).
- **Light + dark ember themes.** Night hearth or morning paper, your pick.

## The privacy posture

- The dashboard is never public: serve it on a private network (Tailscale or
  similar). Real-time webhooks need exactly one JWT-verified public path.
- Plaid access tokens are AES-256-GCM encrypted at rest.
- The LLM is any OpenAI-compatible endpoint. Point it at a local model (Ollama,
  vLLM, LM Studio) and financial data never leaves your network; the UI flags
  which models are local vs remote.
- `finance.db` and screenshots are gitignored. Secrets live in `pass` or env,
  never in files.

## Quickstart (Plaid Sandbox)

```bash
git clone https://github.com/BioInfo/kindling && cd kindling
npm install
# secrets: either export PLAID_CLIENT_ID / PLAID_SECRET / APP_ENC_KEY,
# or store them in `pass` (api-keys/plaid-client-id, api-keys/plaid-secret-sandbox)
./run.sh dev        # http://localhost:3408
```

Open the app → **Connect a bank**. In Sandbox use Plaid's test credentials
(`user_good` / `pass_good`, any OTP), then **Sync**.

Per-deployment config (gateway URLs, model names) goes in `local.env` — see
`local.env.example`. The LLM features are best-effort: everything degrades
cleanly if no gateway is configured.

## Going to production

1. Get Plaid Production keys (free tier: 10 Items), store the secret in `pass`
   as `api-keys/plaid-secret-production`.
2. `PLAID_ENV=production ./run.sh dev` and connect real accounts.
3. For always-on serving: `start-prod.sh` builds once and serves with
   `next start` (see `deploy/` for LaunchAgent templates), behind
   `tailscale serve` or your reverse proxy of choice. Never expose it publicly.

Full architecture, security model, and design principles: [`PLAN.md`](PLAN.md).

## Stack

Next.js (App Router, TypeScript) · `node:sqlite` (no native build step) · Plaid
Node SDK · Recharts · any OpenAI-compatible LLM gateway.

## License

MIT
