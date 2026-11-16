#!/usr/bin/env bash
# Runs the smoke test and the Playwright suite against a THROWAWAY copy of the stack:
# its own compose project (own containers, network and database volume), its own ports,
# a freshly seeded database - removed again at the end. It never touches the stack you
# develop against (`docker compose up`), so test data can never show up in your shop.
#
#   pnpm test:stack                 # smoke + e2e
#   pnpm test:stack -- --grep cart  # extra arguments go to Playwright
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${TEST_STACK_PORT:-18080}"
PG_PORT="${TEST_STACK_PG_PORT:-15433}"
ENV_TMP="$(mktemp)"

# same config as .env.example, only the host ports / origin differ
sed -e "s#^NGINX_HOST_PORT=.*#NGINX_HOST_PORT=${PORT}#" \
    -e "s#^POSTGRES_HOST_PORT=.*#POSTGRES_HOST_PORT=${PG_PORT}#" \
    -e "s#^ALLOWED_ORIGINS=.*#ALLOWED_ORIGINS=http://localhost:${PORT}#" \
    -e "s#^PUBLIC_WEB_URL=.*#PUBLIC_WEB_URL=http://localhost:${PORT}#" \
    .env.example > "$ENV_TMP"

export COMPOSE_PROJECT_NAME=shop-e2e-run
export COMPOSE_ENV_FILES="$ENV_TMP"
export ENV_FILE="$ENV_TMP"

cleanup() {
  docker compose logs --no-color --tail 80 api > /tmp/shop-e2e-api.log 2>&1 || true
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_TMP"
}
trap cleanup EXIT

# a leftover from an interrupted earlier run must not leak its data into this one
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
docker compose up --build -d --wait

./scripts/smoke-compose.sh
E2E_BASE_URL="http://localhost:${PORT}" pnpm --filter @shop/e2e e2e "$@"
