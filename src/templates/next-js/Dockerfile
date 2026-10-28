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
# a prisma/ directory or a db:seed script boots straight into the server.
#
# The runtime image is Next's `output: 'standalone'` bundle (see next.config.js):
# only the traced server (.next/standalone), .next/static, public/, prisma/ and the
# entrypoint are copied. The full node_modules and .next/cache never ship, which
# keeps the image a fraction of the size. The Prisma CLI and tsx, which the boot
# sequence needs for `migrate deploy` and the seed, are installed once into a
# separate /opt/tools dir at the exact versions the app resolved at build time.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# The @flashmandu/app-bridge{,-ui} packages are not on the public registry yet, so
# the lockfile pins them as `file:vendor/*.tgz`. Without the tarballs in this stage
# `npm ci` fails with ENOENT on the vendor path. The glob is a no-op for an app
# that vendors nothing.
COPY vendor*/ ./vendor/
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi

FROM node:22-alpine AS builder
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

# Boot-time tools: the exact installed versions of the Prisma CLI and tsx (empty
# when the app uses neither), written as npm specs for the `tools` stage.
RUN node -e "const fs=require('fs');const s=[];for(const n of ['prisma','tsx']){try{s.push(n+'@'+require('/app/node_modules/'+n+'/package.json').version)}catch{}}fs.writeFileSync('/app/.runtime-tools',s.join(' '))"

# Install only those tools, away from the app's node_modules, so the runner can
# copy them without dragging the build toolchain along. openssl lets the Prisma
# installer detect the musl platform and fetch the right engines.
FROM node:22-alpine AS tools
RUN apk add --no-cache openssl libc6-compat
WORKDIR /tools
COPY --from=builder /app/.runtime-tools ./.runtime-tools
RUN mkdir -p node_modules \
    && if [ -s .runtime-tools ]; then \
         npm init -y >/dev/null && npm install --no-audit --no-fund --omit=dev $(cat .runtime-tools); \
       fi

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Same native-engine requirement as the builder: the entrypoint runs
# `prisma migrate deploy` on boot, which loads the query engine.
RUN apk add --no-cache openssl libc6-compat

# The platform's Service targets port 3000; the standalone server honours $PORT.
ENV PORT=3000
EXPOSE 3000

# Run as a non-root user. gVisor already contains the workload, but a container
# that does not need root should not have it — the two are complementary.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Prisma CLI + tsx for the entrypoint (empty dir for an app that uses neither).
COPY --from=tools --chown=nextjs:nodejs /tools/node_modules /opt/tools/node_modules
ENV PATH="/opt/tools/node_modules/.bin:${PATH}"

# The standalone server (server.js + only the node_modules it traces), then the
# static assets and public/ it deliberately does not copy itself. `.next/cache`
# is never copied. package.json is tiny and lets the entrypoint run the app's own
# `db:seed` script.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs --chmod=755 /app/docker-entrypoint.sh ./docker-entrypoint.sh

# Next may write its runtime cache (ISR, image optimizer) here; it ships empty.
RUN mkdir -p /app/.next/cache && chown nextjs:nodejs /app/.next/cache

USER nextjs

ENTRYPOINT ["./docker-entrypoint.sh"]
