#!/usr/bin/env bash
# Runs checks against a THROWAWAY copy of the stack: its own compose project (own containers,
# network and database volume), its own ports, a freshly seeded database - removed at the end.
# It never touches the stack you develop against (`docker compose up`), so test data can never
# show up in your shop.
#
#   pnpm test:stack                              # smoke + nginx check + all Playwright tests
#   STACK_STEPS="e2e" pnpm test:stack tests/web  # only some steps; extra args go to Playwright
#   STACK_STEPS="smoke nginx" RELAXED=0 ...      # real production limits (see below)
#   KEEP_STACK=1 STACK_STEPS="" pnpm test:stack  # just start it and leave it running (for debugging)
#
# RELAXED=1 (default) makes the stack friendly to a test run that comes from ONE address: the per-IP
# login/API limits are raised, the reservation is 1 minute and the stub's delayed notification 5 s,
# so expiry and late payments can be tested. RELAXED=0 keeps every limit exactly as in .env.example -
# that is what the smoke and nginx checks run against.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${TEST_STACK_PORT:-18080}"
PG_PORT="${TEST_STACK_PG_PORT:-15433}"
STEPS="${STACK_STEPS-smoke nginx e2e}"
RELAXED="${RELAXED:-1}"
NAME="${TEST_STACK_NAME:-shop-e2e-run}" # several stacks can run side by side under different names/ports
ENV_TMP=".e2e-stack-${NAME}.env"

# same config as .env.example, only the host ports / origin (and, if relaxed, the limits) differ
sed -e "s#^NGINX_HOST_PORT=.*#NGINX_HOST_PORT=${PORT}#" \
    -e "s#^POSTGRES_HOST_PORT=.*#POSTGRES_HOST_PORT=${PG_PORT}#" \
    -e "s#^ALLOWED_ORIGINS=.*#ALLOWED_ORIGINS=http://localhost:${PORT}#" \
    -e "s#^PUBLIC_WEB_URL=.*#PUBLIC_WEB_URL=http://localhost:${PORT}#" \
    .env.example > "$ENV_TMP"
if [ "$RELAXED" = "1" ]; then
  {
    echo
    echo "# --- relaxed for the e2e run (see scripts/test-stack.sh) ---"
    echo "LOGIN_MAX_PER_IP=100000"
    echo "API_RATE_MAX_PER_IP=1000000"
    echo "RESERVATION_MINUTES=1"
    echo "STUB_DELAY_SECONDS=5"
  } >> "$ENV_TMP"
  # a later assignment wins in compose env files, but be explicit for readers of the file
  sed -i -e '/^LOGIN_MAX_PER_IP=30$/d' -e '/^RESERVATION_MINUTES=15$/d' -e '/^STUB_DELAY_SECONDS=30$/d' -e '/^API_RATE_MAX_PER_IP=600$/d' "$ENV_TMP"
fi

export COMPOSE_PROJECT_NAME="$NAME"
export COMPOSE_ENV_FILES="$ENV_TMP"
export ENV_FILE="$ENV_TMP"
export E2E_BASE_URL="http://localhost:${PORT}"
export E2E_WEBHOOK_SECRET="$(grep '^WEBHOOK_SECRET=' "$ENV_TMP" | cut -d= -f2- | sed 's/[[:space:]]*#.*//')"
export E2E_RELAXED="$RELAXED"

cleanup() {
  docker compose logs --no-color --tail 120 api > /tmp/shop-e2e-api.log 2>&1 || true
  if [ "${KEEP_STACK:-0}" != "1" ]; then
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -f "$ENV_TMP"
  else
    echo "stack left running: ${E2E_BASE_URL} (stop: COMPOSE_PROJECT_NAME=shop-e2e-run COMPOSE_ENV_FILES=$ENV_TMP ENV_FILE=$ENV_TMP docker compose down -v)"
  fi
}
trap cleanup EXIT

# a leftover from an interrupted earlier run must not leak its data into this one
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
docker compose up --build -d --wait

for step in $STEPS; do
  case "$step" in
    smoke) ./scripts/smoke-compose.sh ;;
    nginx) node scripts/nginx-check.mjs ;;
    e2e)   pnpm --filter @shop/e2e e2e "$@" ;;
    *)     echo "unknown step: $step" >&2; exit 2 ;;
  esac
done
