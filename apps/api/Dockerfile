# syntax=docker/dockerfile:1

# Multi-stage build for the JetnineERP API. Designed to run unmodified on
# Render, Fly, Railway, or any Docker-aware host that exposes $PORT.

FROM node:22-bookworm-slim AS builder
WORKDIR /repo

# Pull pnpm via corepack so the version pins to package.json#packageManager.
RUN corepack enable

# Workspace + lockfile first, then per-package manifests, so the install
# layer caches across source-only changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY turbo.json ./
COPY tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY packages/config/package.json ./packages/config/

# devDeps are needed for the build — typescript, nest cli, etc. The runtime
# stage strips them.
ENV NODE_ENV=development
RUN pnpm install --frozen-lockfile

COPY apps/api ./apps/api
COPY packages/db ./packages/db
COPY packages/shared ./packages/shared
COPY packages/config ./packages/config

# shared first: db's seed.ts imports it (excluded from db's build, but the
# order stays correct for anything that compiles against shared's dist).
RUN pnpm --filter @jetnine/shared build
RUN pnpm --filter @jetnine/db build
RUN pnpm --filter @jetnine/api build

# Strip dev deps and prune the workspace to just what apps/api needs.
RUN pnpm --filter @jetnine/api --prod deploy /pruned

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

COPY --from=builder /pruned/package.json ./package.json
COPY --from=builder /pruned/node_modules ./node_modules
COPY --from=builder /pruned/dist ./dist
# STORIS catalog files for the one-off import job (ops-catalog-import.yml);
# the script resolves them relative to the working directory.
COPY docs/imports ./docs/imports

EXPOSE 4000
CMD ["node", "dist/main.js"]
