# syntax=docker/dockerfile:1.6
#
# Single image for the backend. ROLE env var selects which entrypoint runs:
#   ROLE=api    — HTTP + WS server
#   ROLE=worker — scheduled background jobs (backfill, daily price, snapshots)
#   ROLE=bot    — bot runner
#
# Dev cadence: bind-mount source over /app/apps/api/src and run `tsx watch`
# via the compose `command:`. Production builds are layered on in item 12.

FROM node:20-alpine

WORKDIR /app

# Install workspace + api manifests first so `npm install` is cache-friendly.
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared-types/package.json ./packages/shared-types/

RUN npm install --workspaces --include-workspace-root

# Copy the rest. In dev compose, the source dir is bind-mounted on top of this.
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages/shared-types ./packages/shared-types

WORKDIR /app/apps/api

EXPOSE 3000

CMD ["npm", "run", "dev"]
