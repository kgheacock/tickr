# 01 — Dev environment

> **Status:** [implemented](https://github.com/kgheacock/tickr/pull/3) • **Depends on:** —

## Goal

Stand up a reproducible local dev stack on macOS/Linux so any contributor can
clone the repo, run one command, and have api + worker + bot + Postgres
(with Timescale) + Redis + Caddy running and reachable at `https://tickr.local`.

## Pre-reads

- [docs/01-architecture.md §1](../docs/01-architecture.md#1-v1-component-overview)
  — three-roles-one-image topology.
- [docs/08-deployment.md §1, §3, §7](../docs/08-deployment.md#1-topology-single-vps)
  — Compose layout, secrets, environments.

## Steps

1. **Monorepo layout.** Create the workspace skeleton:
   ```
   /apps
     /api          # Node 20 + TS, runs ROLE=api|worker|bot via env
     /web          # Vite + React + TS (scaffolded in item 11)
   /packages
     /shared-types # @tickr/shared-types (filled in item 02)
   /compose
     docker-compose.yml
     Caddyfile
   /scripts
     dev-up.sh     # one-shot: docker compose up + tail logs
   .env.example
   package.json    # workspaces: ["apps/*", "packages/*"]
   tsconfig.base.json
   ```
2. **Single TS image for the backend.** `apps/api/Dockerfile` builds once;
   the `ROLE` env var selects which entrypoint runs at container start
   (`api` | `worker` | `bot`). Use `tsx` for dev and a compiled bundle
   (esbuild or tsc) for prod.
3. **Compose stack.** `compose/docker-compose.yml` services:
   - `postgres` — image `timescale/timescaledb-ha:pg16-latest`; volume
     `tickr-pg-data`; `POSTGRES_DB=tickr`; healthcheck via `pg_isready`.
   - `redis` — image `redis:7-alpine`; no persistence; healthcheck via
     `redis-cli ping`.
   - `api` — built from `apps/api`; `ROLE=api`; depends on `postgres` +
     `redis` healthy.
   - `worker` — same image; `ROLE=worker`.
   - `bot` — same image; `ROLE=bot`.
   - `caddy` — image `caddy:2-alpine`; mounts `compose/Caddyfile`; proxies
     `/api` and `/ws` to `api`; serves `apps/web/dist` for `/`.
4. **Caddyfile.** Local dev uses `tickr.local` with Caddy's internal CA
   (`tls internal`). Add `tickr.local` → `127.0.0.1` to `/etc/hosts` (note
   in README).
5. **Env wiring.** `.env.example` lists every var consumed by the api/worker:
   `DATABASE_URL`, `REDIS_URL`, `FINNHUB_API_KEY`, `FINNHUB_WEBHOOK_SECRET`,
   `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
   `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`,
   `SESSION_SIGNING_KEY`, `ADMIN_BOOTSTRAP`, `PUBLIC_BASE_URL`, `LOG_LEVEL`.
   `ROLE` is set per-service in compose, not in `.env`. Compose loads `.env`
   via `env_file:` (path relative to the compose file).
   `FINNHUB_WEBHOOK_SECRET` is the secret Finnhub uses to sign webhook
   payloads — used by item 05 to verify inbound webhooks.
6. **One-shot dev script.** `scripts/dev-up.sh`:
   ```bash
   set -euo pipefail
   cp -n .env.example .env || true
   docker compose -f compose/docker-compose.yml up --build
   ```
7. **Workspace tooling.** Set up `tsconfig.base.json` with `strict: true`,
   ES2022 target, NodeNext modules. Add ESLint + Prettier configs scoped
   to the workspace; pre-commit hook via `lefthook` or `husky`.
8. **CI baseline.** Add `.github/workflows/ci.yml`: install, typecheck,
   lint. Tests will be added per item.

## Files to create

- `package.json`, `tsconfig.base.json`, `.eslintrc.cjs`, `.prettierrc`
- `apps/api/package.json`, `apps/api/tsconfig.json`,
  `apps/api/src/index.ts` (stub that switches on `ROLE`),
  `apps/api/Dockerfile`
- `compose/docker-compose.yml`, `compose/Caddyfile`
- `scripts/dev-up.sh`
- `.env.example`, `.gitignore`
- `.github/workflows/ci.yml`

## Definition of done

- [ ] `./scripts/dev-up.sh` brings the full stack up without manual steps
      beyond copying `.env.example` to `.env` and editing OAuth values.
- [ ] `curl -k https://tickr.local/api/health` returns `200 {"ok":true}`
      from the api stub.
- [ ] `docker compose logs worker` and `docker compose logs bot` show each
      role's startup banner.
- [ ] `psql $DATABASE_URL -c "SELECT extname FROM pg_extension"` lists
      `timescaledb`.
- [ ] `redis-cli -u $REDIS_URL PING` returns `PONG`.
- [ ] CI typechecks and lints clean on a fresh PR.
