#!/bin/sh
set -e

echo "[entrypoint] Ejecutando migraciones de Prisma..."
./node_modules/.bin/prisma migrate deploy

echo "[entrypoint] Arrancando servidor..."
exec node dist/server.js
