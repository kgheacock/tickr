# 01 — Dev environment

> **Status:** [implemented](https://github.com/kgheacock/tickr/pull/3) • **Depends on:** —

## Goal

Stand up a reproducible local dev stack on macOS/Linux so any contributor can
clone the repo, run one command, and have api + worker + bot + Postgres
(with Timescale) + Redis + Caddy running and reachable at
`https://local.tickr.keithheacock.com`.

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
4. **Caddyfile.** Local dev uses `local.tickr.keithheacock.com` with Caddy's
   internal CA (`tls internal`). Add `local.tickr.keithheacock.com` →
   `127.0.0.1` to `/etc/hosts`. Using a real `.com` subdomain means Google
   OAuth accepts the redirect URI; `/etc/hosts` overrides DNS so no DNS record
   is needed.
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

- [x] `./scripts/dev-up.sh` brings the full stack up without manual steps
      beyond copying `.env.example` to `.env` and editing OAuth values.
- [x] `curl -s https://local.tickr.keithheacock.com/api/v1/health` returns `200 {"ok":true}`.
- [x] `docker compose logs worker` and `docker compose logs bot` show each
      role's startup banner.
- [ ] `psql $DATABASE_URL -c "SELECT extname FROM pg_extension"` lists
      `timescaledb`.
- [ ] `redis-cli -u $REDIS_URL PING` returns `PONG`.
- [ ] CI typechecks and lints clean on a fresh PR.
- [ ] Clicking the Google OAuth start URL completes a login (requires step 4
      of the setup guide below — register the callback URI in Cloud Console).
- [ ] Clicking the GitHub OAuth start URL completes a login.

---

## Local dev setup guide

This section covers what `npm run dev` actually needs. Everything under
"One-time setup" only needs to be done once per machine.

### One-time setup

**1. `/etc/hosts` entry**

```
127.0.0.1 local.tickr.keithheacock.com
```

On macOS: `sudo sh -c 'echo "127.0.0.1 local.tickr.keithheacock.com" >> /etc/hosts'`

This routes the hostname to loopback without any DNS change. `/etc/hosts`
overrides DNS, so no record needs to be added to the real domain.

**2. Trust Caddy's local CA**

Caddy issues a cert for `local.tickr.keithheacock.com` from its internal CA.
Install that root CA into the system trust store once so browsers and `curl`
accept it without `-k`:

```bash
brew install caddy       # if not already installed
caddy trust
```

After this, `curl https://local.tickr.keithheacock.com/api/v1/health` should
return `{"ok":true}` once the stack is up.

**3. Fill in `.env`**

```bash
cp .env.example .env
```

Required values (get from 1Password / project secrets):

| Variable | Where |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Google Cloud Console → tickr-497805 → APIs & Services → Credentials |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | github.com/settings/developers → tickr OAuth App |
| `SESSION_SIGNING_KEY` | generate: `openssl rand -hex 32` |
| `FINNHUB_API_KEY` | finnhub.io dashboard |

`PUBLIC_BASE_URL=https://local.tickr.keithheacock.com` is already the default
in `.env.example`.

**4. Register OAuth redirect URIs**

The app constructs callback URIs as `${PUBLIC_BASE_URL}/api/v1/auth/{provider}/callback`.
Register these exact URLs with each provider:

| Provider | Redirect URI to register |
|---|---|
| Google | `https://local.tickr.keithheacock.com/api/v1/auth/google/callback` |
| GitHub | `https://local.tickr.keithheacock.com/api/v1/auth/github/callback` |

- **Google**: Console → tickr-497805 → APIs & Services → Credentials →
  Web Client → "Authorized redirect URIs".
- **GitHub**: github.com/settings/developers → tickr OAuth App →
  "Authorization callback URL".

### Running the stack

```bash
npm run dev          # builds images, starts all services, tails logs
```

Equivalent to:

```bash
docker compose -f compose/docker-compose.yml up --build
```

Services started: `postgres`, `redis`, `api` (ROLE=api), `worker`
(ROLE=worker), `bot` (ROLE=bot), `caddy` (HTTPS at local.tickr.keithheacock.com).

### Verifying the stack

```bash
# Health check
curl -s https://local.tickr.keithheacock.com/api/v1/health
# → {"ok":true}

# Google OAuth start — copy the Location header URL into a browser
curl -si https://local.tickr.keithheacock.com/api/v1/auth/google/start | grep -i location

# GitHub OAuth start — same
curl -si https://local.tickr.keithheacock.com/api/v1/auth/github/start | grep -i location
```

A working OAuth flow lands you at `https://local.tickr.keithheacock.com/portfolio`
with a `tickr_sid` session cookie set.
