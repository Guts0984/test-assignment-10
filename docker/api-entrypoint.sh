#!/bin/sh
# Applies migrations and (once) seeds the database, then starts the api.
set -e
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  node node_modules/@shop/db/dist/cli.js bootstrap
fi
exec "$@"
