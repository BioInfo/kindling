#!/usr/bin/env bash
# Launches Kindling. Secrets come from pre-set env vars, or from `pass` when
# available (never from tracked files). Usage: ./run.sh [dev|start]  (default: dev)
set -uo pipefail

MODE="${1:-dev}"
cd "$(dirname "$0")"

# Per-deployment overrides (gitignored): gateway URLs, model routing, etc.
# Use `export VAR=value` lines. See local.env.example.
[ -f ./local.env ] && . ./local.env

# --- secrets: pre-set env wins; otherwise pulled from pass ---
export PLAID_CLIENT_ID="${PLAID_CLIENT_ID:-$(pass api-keys/plaid-client-id)}"
PLAID_ENV="${PLAID_ENV:-sandbox}"
export PLAID_ENV
if [ -z "${PLAID_SECRET:-}" ]; then
  if [ "$PLAID_ENV" = "production" ]; then
    PLAID_SECRET="$(pass api-keys/plaid-secret-production)"
  else
    PLAID_SECRET="$(pass api-keys/plaid-secret-sandbox)"
  fi
fi
export PLAID_SECRET

# AES-256-GCM key for encrypting access tokens at rest. Generated once, kept in pass.
if [ -z "${APP_ENC_KEY:-}" ]; then
  if ! pass api-keys/plaid-enc-key >/dev/null 2>&1; then
    echo "Generating app encryption key → pass api-keys/plaid-enc-key"
    openssl rand -hex 32 | pass insert -m -f api-keys/plaid-enc-key >/dev/null
  fi
  APP_ENC_KEY="$(pass api-keys/plaid-enc-key)"
fi
export APP_ENC_KEY

# LLM — any OpenAI-compatible endpoint. Swap model with FINANCE_LLM_MODEL.
export LITELLM_BASE_URL="${LITELLM_BASE_URL:-http://localhost:4000/v1}"
export LITELLM_API_KEY="${LITELLM_API_KEY:-$(pass api-keys/litellm-vk-finance 2>/dev/null | head -1 || echo '')}"
# Optional web-search gateway for merchant identify / asset estimates / scam
# checks. Features degrade cleanly when it isn't running.
export LITESEARCH_URL="${LITESEARCH_URL:-http://localhost:8899}"

export FINANCE_DB_PATH="${FINANCE_DB_PATH:-./data/finance.db}"

echo "PLAID_ENV=$PLAID_ENV  model=${FINANCE_LLM_MODEL:-(config default)}  db=$FINANCE_DB_PATH"
exec npm run "$MODE"
