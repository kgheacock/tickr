# syntax=docker/dockerfile:1.6
#
# Single image for the backend. ROLE env var selects which entrypoint runs:
#   ROLE=api    — HTTP + WS server
#   ROLE=worker — scheduled background jobs (backfill, daily price, snapshots)
# (A ROLE=bot entrypoint was never implemented; src/index.ts handles only
#  api|worker. FS auto-managers run in-process under api/worker, not a separate
#  service — see docs/runbook.md.)
#
# Two build targets:
#   --target dev  (default) — source is bind-mounted over /app/apps/api/src by
#                 the dev compose overlay and run with `tsx watch`.
#   --target prod — self-contained: source + deps baked in, no bind mounts, no
#                 watch. Run via `tsx src/index.ts`. The repo ships its workspace
#                 packages as raw TS (`@tickr/shared-types` main = src/index.ts),
#                 so prod runs through tsx rather than a tsc → node dist step.
#
# `dev` is the last stage so a build with no `target:` (the base compose) keeps
# producing the dev image; the prod overlay opts in with `target: prod`.

FROM node:22-alpine AS base

RUN corepack enable pnpm

WORKDIR /app

# Install workspace + api manifests first so `pnpm install` is cache-friendly.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared-types/package.json ./packages/shared-types/

RUN pnpm install --frozen-lockfile

# Copy the rest. In dev compose, the source dir is bind-mounted on top of this.
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages/shared-types ./packages/shared-types

WORKDIR /app/apps/api

EXPOSE 3000

# Production image: self-contained, no source mounts, no file watcher.
FROM base AS prod
ENV NODE_ENV=production
CMD ["pnpm", "run", "start:prod"]

# Dev image (default target): tsx watch, source bind-mounted by the dev overlay.
FROM base AS dev
CMD ["pnpm", "run", "dev"]
