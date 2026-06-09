# 12 — Deployment

> **Status:** infrastructure-as-code complete; runtime DoD pending a live VPS •
> **Depends on:** 01, 03, 10, 11, 19

## Goal

Stand up the production VPS on Hetzner with the same Compose stack that
runs locally, Caddy-issued TLS, off-VPS Postgres backups with a verified
restore drill, and a one-command deploy from a fresh git pull.

## Pre-reads

- [docs/08-deployment.md §1, §3, §4, §7, §8](../docs/08-deployment.md#1-topology-single-vps)
  — topology, secrets, persistence, environments, security.
- [docs/08-deployment.md §9](../docs/08-deployment.md#9-ops-decisions) — pointer
  to the consolidated decisions in `09-open-questions.md`.

## Steps

1. **Provision the VPS.** Hetzner CX22 (or larger) running Debian 12.
   Manual setup (one-time, document in the deploy README):
   - Non-root sudo user; disable root SSH; key-only auth.
   - UFW: allow 22, 80, 443; deny everything else inbound.
   - Install `docker` + `docker compose plugin`.
   - Create `/srv/tickr/{repo,data,backups,secrets}`.
2. **DNS + TLS.** Point `tickr.example.com` (and `www`) at the VPS IP.
   Caddy in the compose stack handles TLS automatically via Let's Encrypt
   on first request; HSTS header on. `compose/Caddyfile.prod` differs
   from `Caddyfile` only in the site address — keep both in `compose/`.
3. **Production secrets.** `/srv/tickr/secrets/tickr.env` (chmod 600,
   owned by the deploy user; **never** committed). Compose loads via
   `env_file`. OAuth apps registered separately for prod with
   `https://tickr.example.com/api/v1/auth/google/callback` (and same for
   github) as the only allowed redirect.
4. **First-time bring-up.** Document in `docs/runbook.md`:
   ```bash
   git clone <repo> /srv/tickr/repo
   cp .env.example /srv/tickr/secrets/tickr.env
   # edit /srv/tickr/secrets/tickr.env
   # Run the data audit BEFORE migrating — exits non-zero on a dirty corpus.
   pnpm tsx scripts/data-audit.ts
   docker compose -f compose/docker-compose.yml \
                  -f compose/docker-compose.prod.yml \
                  --env-file /srv/tickr/secrets/tickr.env \
                  run --rm api pnpm run db:migrate
   docker compose -f compose/docker-compose.yml \
                  -f compose/docker-compose.prod.yml \
                  --env-file /srv/tickr/secrets/tickr.env up -d
   ```
5. **Deploy script.** `scripts/deploy.sh` runs on the VPS (or via SSH from
   CI): `git fetch && git checkout origin/main && docker compose build &&
   pnpm tsx scripts/data-audit.ts &&
   docker compose run --rm api pnpm run db:migrate && docker compose up -d`.
   Pre-flight checks: working tree clean; current commit reachable from
   `origin/main`; `tickr.env` exists. The data audit runs before every
   migration and blocks the deploy on a non-zero exit (see TODO/19).
6. **Backups.** `scripts/backup.sh` runs nightly via systemd timer (or
   cron) on the host:
   ```bash
   ts=$(date -u +%Y%m%dT%H%M%SZ)
   docker compose exec -T postgres pg_dump -Fc tickr \
     | gzip > /srv/tickr/backups/tickr-$ts.dump.gz
   # rclone copy to off-VPS storage (Hetzner Object Storage or B2)
   rclone copy /srv/tickr/backups/tickr-$ts.dump.gz remote:tickr-backups/
   find /srv/tickr/backups -type f -mtime +7 -delete
   ```
   Off-VPS retention: 7 days.
7. **Restore drill.** `scripts/restore-drill.sh` runs quarterly: pulls a
   recent dump, restores into a throwaway Postgres container, runs basic
   sanity queries (table counts, latest snapshot timestamp), reports
   results. Drill output committed to `docs/restore-drills/` for the
   record.
8. **Compose prod overlay.** `compose/docker-compose.prod.yml`:
   - Pins image tags (no `:latest`).
   - Removes dev `volumes` mounts of source code; uses built image only.
   - Adds restart policies (`unless-stopped`).
   - Resource limits per service (mem caps, cpu shares).
   - Postgres data on a named volume backed by `/srv/tickr/data/pg`.
9. **CI deploy artifact.** GitHub Actions builds and pushes the api
   image to a registry (GHCR) on every merge to `main`. The deploy
   script on the VPS pulls by tag (the commit SHA).
10. **Smoke tests post-deploy.** `scripts/smoke.sh` hits
    `https://tickr.example.com/api/v1/health`, asserts `200`; queries
    `/admin/ops` with a stored admin token, asserts `lastSnapshotAt` is
    within the last 26 h. Wired into the deploy script — failure rolls
    back via `docker compose down && docker compose up -d` with the
    previous SHA.
11. **Security posture confirmation** (from [docs/08-deployment.md §8](../docs/08-deployment.md#8-security-posture)):
    - TLS + HSTS on; verified via `curl -I`.
    - Postgres + Redis bound to the Docker internal network; `nmap` from
      outside shows only 22/80/443.
    - `tickr.env` permissions 600; logs free of `MASSIVE_API_KEY`,
      `FINNHUB_API_KEY`, and OAuth secrets.

## Files to create

- `compose/docker-compose.prod.yml`
- `compose/Caddyfile.prod`
- `scripts/deploy.sh`
- `scripts/backup.sh`
- `scripts/restore-drill.sh`
- `scripts/smoke.sh`
- `.github/workflows/deploy.yml`
- `docs/runbook.md`

## Definition of done

- [ ] `https://tickr.example.com` loads the SPA over Caddy-issued TLS;
      `curl -I` shows HSTS.
- [ ] `docker compose ps` shows api + worker + bot + postgres + redis +
      caddy all `healthy`.
- [ ] First-time bring-up runs the migrations, seeds the universe, the
      backfill job starts, and the index bot seeds after backfill
      completes.
- [ ] Nightly backup uploads a file to off-VPS storage; 8th-night-back
      file is deleted locally.
- [ ] Restore drill succeeds end-to-end against the most recent dump;
      log committed to `docs/restore-drills/`.
- [ ] Deploy script rolls back automatically on smoke-test failure.
- [ ] External `nmap` from a separate host shows only 22/80/443 open.
- [ ] Review the app for unsafe defaults
- [ ] Document sizing & hosting concerns surfaced during this work: monitoring
      / alerting coverage, load-testing results, and VPS resource sizing
      (CPU/mem headroom under realistic load, when to scale up off the CX22).
- [x] Feed those deployment findings back into `README.md` and
      `CONTRIBUTING.md`, replacing the placeholder deployment TODOs in each.

> The remaining unchecked boxes require the live Hetzner VPS (TLS issuance,
> `docker compose ps healthy`, nightly upload, a real restore drill, external
> `nmap`) and are verified by following `docs/runbook.md` during stand-up. The
> code, compose overlays, scripts, CI, and runbook to make each pass are in
> place and were validated locally (image builds, both prod/dev `compose config`,
> `caddy validate`, prettier, `bash -n`).

## Implementation notes & deviations from the playbook

These were chosen against the actual codebase; reviewers should weigh them:

1. **Compose split into base + dev/prod overlays.** Compose *appends* `ports`
   and `volumes` across `-f` files (no removal), so dev source-mounts and host
   port publishing could not simply be "removed" by the prod overlay. The base
   file is now deployment-neutral; a new `compose/docker-compose.dev.yml` re-adds
   the dev conveniences (`pnpm dev` passes it automatically). This is what makes
   the security DoD (`nmap` shows only 22/80/443) achievable — Docker's
   published ports bypass UFW, so postgres/redis/api must not be published at all.
2. **Prod runs via `tsx`, not `tsc → node dist`.** `@tickr/shared-types` ships
   raw TS as its `main`, and the whole repo runs on tsx; a compiled path would
   need a shared-types build refactor. The prod Dockerfile target is
   self-contained (no source mounts, no watch) and runs `tsx src/index.ts`.
3. **Data audit + migrations run in the api container, not on the host.**
   Provisioning (step 1) installs only Docker — no Node/pnpm — so the literal
   `pnpm tsx scripts/data-audit.ts` on the host won't run. `deploy.sh` mounts
   `scripts/` into the api container instead.
4. **smoke.sh `/admin/ops` check is opt-in.** `requireAdmin` is session-cookie
   only (no bearer/API token exists in v1), so the ops freshness check runs only
   when `SMOKE_ADMIN_COOKIE` is supplied. The field asserted is
   `eodUpdateLagSec` (the API's real field), not the playbook's `lastSnapshotAt`
   (which doesn't exist — item 16 re-targeted snapshot lag to the EOD cron).
5. **SPA is baked into the Caddy image** (`apps/web/Dockerfile` final stage is
   now `caddy:2-alpine` with `dist` at `/srv`) so there is no running `web`
   service — matching the `docker compose ps` list. CI pushes it as
   `ghcr.io/kgheacock/tickr-web`.
6. **Open gap — the `bot` role.** Base compose defines a `bot` service
   (`ROLE=bot`), but `apps/api/src/index.ts` only handles `api`/`worker` and
   exits non-zero otherwise, so `bot` will restart-loop and the "bot healthy"
   DoD cannot pass until the role is implemented (a separate slice). Flagged in
   the runbook.
