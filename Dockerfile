# =============================================================================
# Flux - production image.
# =============================================================================
# The image carries more than a web server: `scripts/` and `db/` are copied in
# too, because the benchmark IS the deliverable of this project and it has to be
# runnable against the containerised database:
#
#   docker compose run --rm bench
#
# That is why this is a plain `next start` image rather than a Next.js
# standalone one - standalone traces only what the server needs, and would drop
# the ledger's SQL files and the benchmark's dependency on lib/.
# =============================================================================

# --- 1. full dependency tree, used only to build ----------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- 2. the Next.js build ---------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- 3. runtime dependencies only -------------------------------------------
# Separate from stage 1 so the dev/build packages never reach the final image.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- 4. the image that actually ships ---------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build     /app/.next        ./.next
COPY package.json next.config.mjs jsconfig.json ./
COPY lib     ./lib
COPY db      ./db
COPY scripts ./scripts

# `bench.mjs` writes docs/benchmark-results.md. The process runs unprivileged,
# so the directory has to exist and be owned by it before the write.
RUN mkdir -p docs && chown -R node:node /app/docs

USER node
EXPOSE 3000

# Called directly rather than through npm so that the Next.js server is PID 1
# and receives SIGTERM from `docker compose down` without a shell in between.
CMD ["node", "node_modules/next/dist/bin/next", "start"]
