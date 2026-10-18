# Kindling — project instructions

Self-hosted personal finance app (Next.js App Router, TS, `node:sqlite`, Plaid). Design and security model: `PLAN.md`. State: `README.md`. Backlog: `ROADMAP.md`. History: `CHANGELOG.md`.

Read `.claude/CONTINUITY.md` first at session start (live cursor); update it at session end.

## Commit gate

Before EVERY `git commit`, run `npm run typecheck` and confirm EXIT=0. Never use `npm run build` as the gate: a live prod server holds `.next/` and a second build collides with it.

## Stack and run

- `node:sqlite`, NOT better-sqlite3 (native build fails on recent Node).
- `./run.sh dev` sources secrets from `pass` or env; `PLAID_ENV` defaults to sandbox; `PLAID_ENV=production ./run.sh dev` for real data.
- Secrets in `pass` or env, never in tracked files. Per-deployment config in `local.env` (gitignored; see `local.env.example`).
- `finance.db` and screenshots are gitignored; real financial data never goes to any git remote.
- `start-prod.sh` serves a production build, so source edits do not show until a rebuild. Verify endpoint logic against the DB instead of running `next dev` beside prod.

## Design rules

- Design and redesign with intent; do not bolt features on. When a surface is cluttered, propose 2-3 layouts rather than patching. Prefer compact and grouped over big cards, de-emphasize zero/empty rows, show group subtotals, sort by what matters.
- Mobile-first: no horizontal overflow at 375-390px, modals fit and scroll to the footer action, finger-sized tap targets. Verify changed surfaces at phone width.
- Every table gets search + sort + filter + pagination: `useTableView` + `TableToolbar` + `Pager` from `app/ui.tsx`.
- Charts are Recharts (client components, concrete hex theme constants, since Recharts cannot read CSS vars in SVG attrs). Do not add another chart lib.
- Connection-aware: linking an account or backfilling history is new visibility, not new activity. Route any "change over time" surface through `networth.ts adjustedTrend()`, never a raw snapshot subtraction.
- LLM is best-effort: every AI feature degrades cleanly when the model is cold or the gateway is down. Headline dollar figures are templated from our own totals, never the model's number.
- Money inputs must accept formatted text (`$750,000`): strip `$ ,` client and server (`parseMoney`).

@CLAUDE.local.md
