# Kindling — project instructions

Self-hosted personal finance app. Architecture and security model in `PLAN.md`.

**Read first at session start:** [`.claude/CONTINUITY.md`](.claude/CONTINUITY.md) — tactical
session handoff (status, in-flight, ▶ START HERE). Update it at session end. It's the live
cursor; `ROADMAP.md` is the backlog and `docs/NEXT-SESSION.md` is the session-history archive.

## Commit gate (hard rule)

Before EVERY `git commit`, run `npm run typecheck` (`tsc --noEmit`) and confirm
**EXIT=0**. Do NOT use `npm run build` as the gate: if an always-on prod server
holds a `.next/` build, a second `next build` collides with it. Typecheck is the
gate; `build` only happens during a deliberate prod rebuild.

## Stack

- Next.js (App Router, TS), `node:sqlite` (NOT better-sqlite3 — native build
  fails on recent Node).
- Run: `./run.sh dev` (sources keys from `pass` or env; PLAID_ENV defaults to
  sandbox; `PLAID_ENV=production ./run.sh dev` for real data).
- Secrets in `pass` or env, never in tracked files. Per-deployment config in
  `local.env` (gitignored, see `local.env.example`).
- `finance.db` and screenshots are gitignored — real financial data never goes
  to any git remote.

## Production serving

`start-prod.sh` builds once and serves with `next start` (no hot reload), so
source edits do NOT show up until a rebuild. To iterate without touching prod,
verify endpoint logic directly against the DB — don't run `next dev` alongside
prod (shared `.next/` collides).

## Design principles (standing)

- **Design and redesign with intent; don't bolt features on.** Every addition
  earns its screen space and reduces cognitive load. When a surface gets
  cluttered, step back and redesign (propose 2-3 layout options) rather than
  patching around it. Compact/grouped over big cards; de-emphasize zero/empty
  rows; show group subtotals; sort by what matters.
- **Mobile-first.** No horizontal overflow at 375–390px, modals fit the screen
  and stay scrollable to the footer action, tap targets finger-sized. Verify
  changed surfaces at phone width before calling them done.
- **Every table gets search + sort + filter + pagination** — wire `useTableView`
  + `TableToolbar` + `Pager` from `app/ui.tsx`; don't ship a bare list.
- **Charts are Recharts** (client components; use concrete hex theme constants —
  Recharts can't read CSS vars in SVG attrs). Don't add another chart lib.
- **Connection-aware:** linking an account / backfilling history is new
  *visibility*, not new activity. Any "change over time" surface must exclude
  connection events (route net-worth deltas through `networth.ts adjustedTrend()`,
  never a raw snapshot subtraction).
- **LLM is best-effort:** every AI feature degrades cleanly when the model is
  cold or the gateway is down. Headline $ figures are always templated from our
  own totals, never the model's number.

@CLAUDE.local.md
