#!/usr/bin/env bash
# Levanta la infraestructura de test, el stub del mfa-service y el core real,
# y ejecuta Cypress contra la API. Uso: ./e2e/run-e2e.sh  (desde backend/)
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose -f docker-compose.test.yml up -d --wait
set -a; . ./.env.test; set +a
export PORT=3100 OUTBOX_POLL_MS=200 MFA_SERVICE_URL=http://localhost:58081 NODE_ENV=test
npx prisma migrate deploy >/dev/null

LOGS=$(mktemp -d)
npx ts-node --transpile-only src/server.ts >"$LOGS/core.log" 2>&1 &
CORE=$!
CORE_URL=http://localhost:3100 PORT=58081 npx ts-node --transpile-only test/stubs/mfa-stub.ts >"$LOGS/mfa.log" 2>&1 &
STUB=$!
trap 'kill $CORE $STUB 2>/dev/null || true' EXIT

for i in $(seq 1 60); do curl -sf http://localhost:3100/health >/dev/null && break; sleep 1; done
curl -sf http://localhost:3100/health >/dev/null || { echo "El core no arrancó:"; cat "$LOGS/core.log"; exit 1; }

# VS Code exporta ELECTRON_RUN_AS_NODE, que impide arrancar el Electron de Cypress
cd e2e && env -u ELECTRON_RUN_AS_NODE npx cypress run "$@"
