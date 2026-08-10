# Flashmandu platform-hosted app image.
#
# Built and pushed by `autohisab-business deploy --target platform`, then run on the
# tenant k3s cluster under gVisor. The platform injects configuration as
# environment variables (DATABASE_URL, FLASHMANDU_*) from a Kubernetes Secret,
# so nothing environment-specific is baked in here.
#
# Database migrations and seeding run at container boot (see
# docker-entrypoint.sh), not at deploy time — every pod starts on the current
# schema before it serves traffic. Both steps are conditional: an app without
# a prisma/ directory or a db:seed script boots straight into `next start`.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi

FROM node:20-alpine AS builder
WORKDIR /app
# Prisma's query engine is a native binary that on musl/alpine needs openssl +
# libc6-compat to load; without them generate warns and the runtime engine fails.
# Harmless for apps without Prisma, so installed unconditionally.
RUN apk add --no-cache openssl libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Guarantee these paths exist so the runner stage's COPY never fails for an
# app that ships no prisma/ or public/ directory.
RUN mkdir -p prisma public

# Prisma's client is generated from the schema at build time; without this the
# runtime import fails with "did you forget to run prisma generate".
RUN if [ -f prisma/schema.prisma ]; then npx prisma generate; fi

# `next build` may evaluate route modules that read DATABASE_URL / FLASHMANDU_*
# at import time. Syntactically valid placeholders keep the build hermetic —
# the real values arrive from the platform Secret at runtime and are never
# baked into the image.
ENV DATABASE_URL="mysql://build:build@127.0.0.1:3306/build"
ENV FLASHMANDU_API_TOKEN="build-placeholder"
ENV FLASHMANDU_WEBHOOK_SECRET="build-placeholder"
ENV FLASHMANDU_APP_SECRET="build-placeholder"
ENV FLASHMANDU_DEV_BOX_BASE_URL="https://build.example"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Same native-engine requirement as the builder: the entrypoint runs
# `prisma migrate deploy` on boot, which loads the query engine.
RUN apk add --no-cache openssl libc6-compat

# The platform's Service targets port 3000; `next start` honours $PORT.
ENV PORT=3000
EXPOSE 3000

# Run as a non-root user. gVisor already contains the workload, but a container
# that does not need root should not have it — the two are complementary.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

# The engines dir ships read-only (root-owned); chown so a non-root runtime can
# write a fetched engine if it ever needs to, and so migrate deploy never hits a
# permission error. Only present when the app depends on Prisma.
RUN if [ -d /app/node_modules/@prisma ]; then chown -R nextjs:nodejs /app/node_modules/@prisma; fi \
    && chmod +x /app/docker-entrypoint.sh

USER nextjs

ENTRYPOINT ["./docker-entrypoint.sh"]
