#!/usr/bin/env bash
# Always-on launcher for Kindling (used by a LaunchAgent / service manager).
# Builds once, then serves the production build (stable — no dev hot-reload chunk
# churn, no .next collision). Secrets come from `pass` (or pre-set env).
set -uo pipefail
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:$PATH"

# Per-deployment overrides (gitignored): gateway URLs, model routing, etc.
# Use `export VAR=value` lines. See local.env.example.
[ -f ./local.env ] && . ./local.env

# --- secrets: pre-set env wins; otherwise pulled from pass ---
export PLAID_CLIENT_ID="${PLAID_CLIENT_ID:-$(pass api-keys/plaid-client-id)}"
export PLAID_ENV="${PLAID_ENV:-production}"
export PLAID_SECRET="${PLAID_SECRET:-$(pass api-keys/plaid-secret-production)}"
export APP_ENC_KEY="${APP_ENC_KEY:-$(pass api-keys/plaid-enc-key)}"
export LITELLM_BASE_URL="${LITELLM_BASE_URL:-http://localhost:4000/v1}"
export LITELLM_API_KEY="${LITELLM_API_KEY:-$(pass api-keys/litellm-vk-finance 2>/dev/null | head -1)}"
export LITESEARCH_URL="${LITESEARCH_URL:-http://localhost:8899}"
export FINANCE_DB_PATH="${FINANCE_DB_PATH:-$PWD/data/finance.db}"

# Build if missing or if ANY nested source file (under app/ or lib/) is newer than
# the last build marker. A bare "app/ -nt" misses nested edits because a directory
# mtime only changes on add/remove of direct children, not on edits to files in
# subdirs — that silently served a stale build after a route/lib edit.
if [ ! -f .next/BUILD_ID ] || [ -n "$(find app lib -type f \( -name "*.ts" -o -name "*.tsx" \) -newer .next/BUILD_ID 2>/dev/null | head -1)" ]; then
  npm run build || exit 1
fi
exec npm run start   # next start (production server)
