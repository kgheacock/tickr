# Contributing to tickr

This is the workshop. The [README](README.md) is the quick take on *what* tickr
is; this file is *how to build and work on it*. The design lives in
[`docs/`](docs/) (what to build) and the implementation playbooks live in
[`TODO/`](TODO/) (how each slice gets built).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node | `20.19.6` (see `.nvmrc`) | `^20.19.0 \|\| >=22.12.0`. Use `nvm use` to match. |
| pnpm | `10.11.0` | `corepack enable` picks this up from `packageManager`. |
| Docker | recent | Compose v2 plugin; also required to run the test suite (Testcontainers). |
| Caddy | 2.x | Only needed once, to trust the local CA (below). |

## One-time local setup

Everything here only needs to be done once per machine.

### 1. Route the dev hostname to loopback

The stack serves over a real `.com` subdomain so Google OAuth accepts the
redirect URI; `/etc/hosts` overrides DNS so no DNS record is needed.

```bash
sudo sh -c 'echo "127.0.0.1 local.tickr.keithheacock.com" >> /etc/hosts'
```

### 2. Trust Caddy's local CA

Caddy issues a cert for `local.tickr.keithheacock.com` from its internal CA.
Install that root once so browsers and `curl` accept it without `-k`:

```bash
brew install caddy   # if needed
caddy trust
```

### 3. Fill in `.env`

```bash
cp .env.example .env
```

`.env.example` documents every variable. The ones you must supply:

| Variable | Where to get it |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Google Cloud Console → APIs & Services → Credentials → Web Client |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | github.com/settings/developers → tickr OAuth App |
| `SESSION_SIGNING_KEY` | generate: `openssl rand -hex 32` |
| `MASSIVE_API_KEY` | massive.com dashboard (backfill) |
| `FINNHUB_API_KEY` | finnhub.io dashboard (daily price) |
| `KAGGLE_USERNAME` / `KAGGLE_API_KEY` | kaggle.com account settings (one-time bulk backfill) |
| `ADMIN_BOOTSTRAP` | `provider:subject` pairs granted admin on first login, e.g. `github:42` |

`PUBLIC_BASE_URL=https://local.tickr.keithheacock.com` is already the default.

> The OAuth app for the production domain is registered as `ticker` rather than
> `tickr` — a known typo to reconcile before any production cutover.

### 4. Register OAuth redirect URIs

The app builds callbacks as `${PUBLIC_BASE_URL}/api/v1/auth/{provider}/callback`.
Register these exact URLs with each provider:

| Provider | Redirect URI |
|---|---|
| Google | `https://local.tickr.keithheacock.com/api/v1/auth/google/callback` |
| GitHub | `https://local.tickr.keithheacock.com/api/v1/auth/github/callback` |

## Running the stack

```bash
pnpm install
pnpm run dev          # docker compose up --build, then tails logs
```

This brings up `postgres` (TimescaleDB), `redis`, the three app roles
(`api`, `worker`, `bot`), and `caddy`. Verify:

```bash
# Health
curl -s https://local.tickr.keithheacock.com/api/v1/health        # → {"ok":true}

# OAuth start — paste the Location URL into a browser to complete sign-in
curl -si https://local.tickr.keithheacock.com/api/v1/auth/google/start | grep -i location

# Extension + Redis sanity
psql "$DATABASE_URL" -c "SELECT extname FROM pg_extension"          # lists timescaledb
redis-cli -u "$REDIS_URL" PING                                      # → PONG
```

A working sign-in lands you at `/portfolio` with a `tickr_sid` cookie set.

### Bootstrap market data

Price data loads in phases (see [TODO/06](TODO/06-backfill-and-daily-price.md)):

```bash
pnpm run kaggle:backfill     # one-time historical bulk import (CSV → price_bar)
# then set BACKFILL_START_DATE=2024-07-06 so the worker's Massive job fills only the gap
```

The worker runs the Massive gap-fill and the daily Finnhub price update on its
own schedule once symbols are seeded.

## Deployment

<!-- TODO: Expand this section from the results of TODO/12-deployment.md —
     production runbook, VPS sizing, monitoring/alerting, and load-testing
     findings. The DoD of TODO/12 owns feeding those findings back here. -->

Production runs the same Compose stack on a single Hetzner VPS with Caddy-issued
TLS, off-VPS Postgres backups, and a one-command deploy. The full runbook —
first-time bring-up, secrets, backups/restore drills, sizing, monitoring, and
load-testing results — is being built in
[`TODO/12-deployment.md`](TODO/12-deployment.md) and will be summarized here once
that slice ships.

## Repository layout

```
apps/api/            # backend; one image, runs as api | worker | bot via ROLE
apps/web/            # React + Vite SPA
packages/shared-types/  # OpenAPI doc + generated TS types, shared across the wire
compose/             # docker-compose.yml + Caddyfile
schema/              # vendored upstream OpenAPI specs (finnhub, massive)
scripts/             # dev-up, kaggle-backfill, deploy, backup helpers
docs/                # design documents
TODO/                # per-slice implementation playbooks
```

pnpm workspaces (`apps/*`, `packages/*`) resolve `@tickr/shared-types` locally
via `workspace:*`.

## Common scripts

Run from the repo root unless noted.

| Command | What it does |
|---|---|
| `pnpm run dev` | Bring up the full Compose stack. |
| `pnpm run typecheck` | Recursive `tsc --noEmit` across workspaces. |
| `pnpm run lint` | ESLint over the repo. |
| `pnpm run format` / `format:check` | Prettier write / verify. |
| `pnpm run gen:types` | Regenerate `shared-types` from `openapi.yaml`. |
| `pnpm run gen:finnhub` / `gen:massive` | Regenerate vendored client types from `schema/`. |
| `pnpm run lint:openapi` | Redocly lint of the public OpenAPI doc. |
| `pnpm --filter @tickr/api run db:migrate` | Apply database migrations. |
| `pnpm --filter @tickr/api run test` | Run the api test suite (needs Docker). |

## Testing

- **Unit + integration** run under [Vitest](https://vitest.dev). Integration
  tests stand up a real Postgres (TimescaleDB) via
  [Testcontainers](https://testcontainers.com), so **Docker must be running**.
  Some auth/session unit tests also expect a reachable Redis.
- **E2E** (frontend) uses Playwright: sign in → place an order → see the fill →
  see the rank update after a forced snapshot.

```bash
pnpm --filter @tickr/api run test       # backend
```

Write tests with each slice — the playbooks in `TODO/` spell out the expected
cases per item, and the **Definition of done** checklist is the bar to clear.

## Code style & conventions

- **TypeScript everywhere**, `strict: true`, ES2022, NodeNext modules. No `any`
  in committed code.
- **ESLint + Prettier** are enforced. A [lefthook](https://lefthook.dev)
  pre-commit hook lints and format-checks staged files; `pnpm install` installs
  it via the `prepare` script.
- **Money is integer cents** on the wire and in storage; do financial math with
  `decimal.js`, never floats. Display-only conversions happen at the edge.
- **Timestamps** are UTC, ISO-8601 at the boundary.
- **Imports** — ioredis must use the *named* import (`import { Redis } from
  'ioredis'`); the default import breaks types.

## Contract & codegen discipline

Generated files are committed, and CI fails on drift:

- `packages/shared-types/src/openapi.gen.ts` is generated from `openapi.yaml`.
  Regenerate with `pnpm run gen:types` and commit the result.
- `apps/api/src/finnhub/finnhub.gen.ts` is generated from `schema/`. Regenerate
  with `pnpm run gen:finnhub`.
- Provider references are walled off: `finnhub.io` may only appear in
  `finnhub/client.ts` (CI enforces this). Keep external API surface behind its
  client module.

## CI

Every PR runs three jobs (`.github/workflows/ci.yml`):

1. **typecheck-lint** — `typecheck`, `lint`, `format:check`.
2. **test** — the api suite against a Redis service container and a cached
   TimescaleDB image.
3. **codegen-check** — regenerates the generated files and fails on any diff.

Get these green locally before pushing — they mirror the commands above.

## Workflow

1. **Pick a slice.** Work is sliced into the playbooks in [`TODO/`](TODO/), each
   sized for roughly one focused PR. Start the
   [`TODO/README.md`](TODO/README.md) — pick an item whose **Depends on** are all
   `done`, read its **Pre-reads** (the design rationale lives in `docs/`, not the
   TODO), then work the **Steps** in order.
2. **Branch** off `main` (e.g. `feature/<slice>`); don't commit to `main`.
3. **Build to the Definition of done.** Check every box before marking the item
   complete. If you hit a design gap mid-implementation, add it to
   [`docs/09-open-questions.md`](docs/09-open-questions.md) rather than deciding
   in the TODO.
4. **Open a PR.** Keep CI green. Update the item's status line in
   `TODO/README.md` to link the PR when it merges.
```
