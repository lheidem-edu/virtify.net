# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app

# libc6-compat: Next's native bits expect glibc symbols that musl does not
# provide on its own.
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:24-alpine AS builder
WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# next.config.ts reads the commit from git, which no container has. CI passes
# it in so the footer and the health endpoint can name the running revision.
ARG GIT_COMMIT_SHA=""
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA

ENV NEXT_TELEMETRY_DISABLED=1

# `next build` imports every route to collect its data, and the auth routes
# build their Better Auth instance and their database pool while being
# imported. Nothing connects — `pg` opens no socket until the first query — so
# placeholders are enough to get through the build, and the real values are
# checked at boot by src/instrumentation.ts. They must never look like
# credentials that could work.
RUN DATABASE_URL="postgres://build:build@127.0.0.1:1/build" \
    BETTER_AUTH_URL="http://localhost:3000" \
    BETTER_AUTH_SECRET="build-only-not-a-secret" \
    APP_ENCRYPTION_KEY="YnVpbGQtb25seS1wbGFjZWhvbGRlci1ub3QtYWtleSE=" \
    npm run build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runner
WORKDIR /app

RUN apk add --no-cache libc6-compat

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# `output: "standalone"` emits the server plus only the dependencies it
# actually reaches, along with the fonts and legal defaults that are read from
# disk at runtime (see outputFileTracingIncludes in next.config.ts).
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Migrations run before the server binds, so the container never serves
# traffic against a schema the code does not expect. The migrator is not part
# of the traced bundle — nothing in the app imports it — so drizzle-orm comes
# along separately. `pg` is already there, the app uses it.
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
COPY --from=builder --chown=node:node /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=deps --chown=node:node /app/node_modules/drizzle-orm ./node_modules/drizzle-orm

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exits non-zero if the migration fails, so the container is restarted rather
# than left serving against a half-migrated database.
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
