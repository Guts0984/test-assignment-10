#!/usr/bin/env bash
# Smoke test of the whole composed stack (nginx -> web/api -> postgres) with a hostile client.
# Needs `docker compose up -d` first. The attacker and the victim run in two separate containers,
# so nginx and the api really see two different source addresses.
set -euo pipefail
cd "$(dirname "$0")/.."
NET="$(docker compose ps -q nginx | xargs docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
run() { docker run --rm --network "$NET" -v "$PWD/scripts:/s:ro" -e BASE_URL=http://nginx node:22-alpine node /s/smoke.mjs "$1"; }
echo "network: $NET"
run attacker > /tmp/smoke-attacker.log 2>&1 &
ATT=$!
set +e
run victim 2>&1 | tee /tmp/smoke-victim.log
VIC=${PIPESTATUS[0]}
wait $ATT
ATTC=$?
cat /tmp/smoke-attacker.log
set -e
if [ "$VIC" -ne 0 ] || [ "$ATTC" -ne 0 ]; then echo "SMOKE TEST FAILED (victim=$VIC attacker=$ATTC)"; exit 1; fi
echo "SMOKE TEST PASSED"
