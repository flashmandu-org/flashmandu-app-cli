#!/bin/sh
# Container boot sequence for a platform-hosted Flashmandu app.
#
# Runs database migrations and seeding BEFORE the server accepts traffic, so
# every deployed version boots on its own schema. Both steps are conditional:
#
#   - migrations: run only when the app ships a Prisma schema. Uses
#     `prisma migrate deploy` (production-safe: applies committed migrations,
#     never prompts, never resets).
#   - seeding: runs `npm run db:seed --if-present`, a no-op for apps that do
#     not define the script. Seed scripts MUST be idempotent (upsert / skip
#     existing rows) — this runs on every pod boot, including replicas and
#     restarts.
#
# `set -e` makes any failed step abort the boot: a pod that could not reach
# the schema its code expects must crash-loop visibly, not serve broken data.
set -e

if [ -f prisma/schema.prisma ]; then
  echo "[entrypoint] Running prisma migrate deploy..."
  npx prisma migrate deploy
fi

echo "[entrypoint] Running db:seed (if defined)..."
npm run db:seed --if-present

echo "[entrypoint] Starting server..."
exec npm run start
