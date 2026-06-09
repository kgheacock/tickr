# Production runbook

Operational playbook for the single-VPS tickr deployment. Topology and the
design rationale live in [08-deployment.md](08-deployment.md); this file is the
hands-on procedure. TODO/12 owns it.

> **Host requirement:** the VPS needs only Docker + the compose plugin. Node and
> pnpm are **not** installed on the host — every Node task (data audit,
> migrations, backfill) runs inside the `api` container.

- [1. Provision the VPS](#1-provision-the-vps)
  - [1.1 Hetzner Cloud "create server" options](#11-hetzner-cloud-create-server-options)
- [2. DNS + TLS](#2-dns--tls)
- [3. Production secrets](#3-production-secrets)
- [4. First-time bring-up](#4-first-time-bring-up)
- [5. Routine deploys](#5-routine-deploys)
- [6. Backups](#6-backups)
- [7. Restore drill](#7-restore-drill)
- [8. Smoke tests](#8-smoke-tests)
- [9. Security posture confirmation](#9-security-posture-confirmation)
- [10. Sizing, monitoring & load testing](#10-sizing-monitoring--load-testing)
- [11. Rollback & recovery](#11-rollback--recovery)

---

## 1. Provision the VPS

One-time, manual. Target: **Hetzner CX22** (2 vCPU / 4 GB / 40 GB) running
**Debian 12 or 13**. Larger is fine; see [§10](#10-sizing-monitoring--load-testing).
(The host only runs Docker, so the Debian point release barely matters; on
Debian 13 the `ssh` service is socket-activated, which the cloud-init handles.)

```bash
# As root, immediately after first boot:
adduser deploy && usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh

# Harden SSH: key-only, no root login. Edit /etc/ssh/sshd_config:
#   PermitRootLogin no
#   PasswordAuthentication no
systemctl restart ssh

# Firewall: only SSH + HTTP + HTTPS inbound.
apt-get update && apt-get install -y ufw
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw enable

# Docker + compose plugin (official convenience script).
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy

# Directory layout.
mkdir -p /srv/tickr/{repo,data/pg,backups,secrets}
chown -R deploy:deploy /srv/tickr
chmod 700 /srv/tickr/secrets
```

> **UFW + Docker caveat:** Docker writes its own iptables rules and can bypass
> UFW for **published** ports. The prod compose overlay publishes nothing except
> Caddy's 80/443 for exactly this reason — postgres/redis/api are reachable only
> on the internal Docker network. Verify with `nmap` in [§9](#9-security-posture-confirmation).

From here on, work as the `deploy` user.

### 1.1 Hetzner Cloud "create server" options

What to pick for each field in the Hetzner Cloud console (or `hcloud`/Terraform).
"N/A" means intentionally skip it for the v1 single-VPS topology.

| Option | Setting | Why |
|---|---|---|
| **Name** | `tickr-prod` | Hostname/console label. Use `tickr-staging` etc. if you add environments. |
| **Image** | Debian 12 or 13 | Matches §1; host only runs Docker. |
| **Type** | CX22 (shared vCPU) | See [§10](#10-sizing-monitoring--load-testing). Shared is fine for v1. |
| **Networking / Public IPv4** | **Required — enable it** | See the IPv4 note below; do **not** run IPv6-only. |
| **Firewalls** | **Create one: inbound allow TCP 22, 80, 443; deny the rest. Outbound: leave default (allow all).** See "Firewall protocols & egress" below. | The authoritative control. Unlike UFW, a Hetzner Cloud Firewall is enforced at the hypervisor **before** traffic reaches the host, so — critically — it is **not** bypassed by Docker's iptables rules. This is what actually guarantees the "`nmap` shows only 22/80/443" posture ([§9](#9-security-posture-confirmation)). Keep UFW too (defense in depth). Optionally restrict 22 to your own IP. |
| **Volumes** | N/A at launch | The 40 GB local disk covers the v1 corpus + 7 days of dumps. When disk approaches ~70% ([§10](#10-sizing-monitoring--load-testing)), attach a Hetzner Volume and move `/srv/tickr/data` onto it (resizable, no rebuild). Provision one from day one only if you want headroom early. |
| **Backups** | Optional | Hetzner's paid full-VM snapshot feature (~20% of server cost). **Not** the system of record — `scripts/backup.sh` (off-VPS `pg_dump`) is, and it satisfies the DoD. Enable Hetzner backups only if one-click whole-VM rollback for disaster recovery is worth the cost; otherwise N/A. |
| **Placement Groups** | N/A | Anti-affinity across physical hosts only matters with multiple servers. Revisit if the worker/bot is later extracted onto its own VPS. |
| **Labels** | Optional | Resource metadata for tooling (`hcloud`, Terraform). Suggested: `env=prod`, `app=tickr`. Harmless and handy if infra grows; skip for a hand-managed single box. |
| **Cloud config** | Optional (recommended) | cloud-init user-data that automates §1 for reproducible rebuilds — see below. |
| **SSH keys** | Add your public key | So the initial root login is key-only; §1 then disables root login. |

**Firewall protocols & egress.**

- **Protocol per inbound port: all TCP.** 22 (SSH) and 80 (ACME challenge +
  HTTP→HTTPS redirect) are TCP-only. 443 is TCP for HTTP/1.1 and HTTP/2 — which
  is all you need. **Open UDP 443 only if you want HTTP/3 (QUIC)**, and that also
  requires publishing it on the caddy service: add `'443:443/udp'` alongside
  `'443:443/tcp'` in the prod overlay (compose defaults a bare `443:443` to TCP).
  With UDP 443 closed, clients transparently fall back to HTTP/2 — nothing
  breaks. Recommendation for v1: **TCP only; skip HTTP/3.**
- **Outbound: leave it unrestricted (Hetzner's default).** The moment you add any
  outbound rule, Hetzner switches egress to deny-by-default, and you then have to
  chase every CDN/API IP that rotates — high operational fragility for little
  gain on a single trusted host. If you later want egress hardening (limit
  exfiltration if the box is compromised), the *minimum* the host must reach is:
  **TCP 443** (HTTPS — covers Let's Encrypt, Massive, Google/GitHub OAuth, GHCR
  image pulls, `git`-over-HTTPS, and rclone to object storage), **TCP 80** (apt +
  `get.docker.com` + ACME fallback), **UDP/TCP 53** (DNS), and **UDP 123** (NTP).
  Pinning those to specific destination IPs is impractical (CDNs rotate), so
  egress allowlisting is by-port at best — another reason to skip it for v1.

**IPv4 is required — do not run IPv6-only.** Two independent reasons: (1) a large
share of visitors are on IPv4-only networks and simply cannot reach an
`AAAA`-only host; (2) the host makes **outbound** calls to services that are
IPv4-only on common paths (GitHub/GHCR pulls, OAuth, market data), and a Hetzner
IPv6-only server has no NAT64/DNS64, so it can't reach them. A primary IPv4 is
~€0.50/month — provision **dual-stack** (IPv4 + IPv6).

Optional **cloud-init** that performs the §1 hardening on first boot (paste into
the "Cloud config" field; replace the SSH key):

```yaml
#cloud-config
users:
  - name: deploy
    # Only 'sudo' here — the 'docker' group does not exist until Docker installs
    # in runcmd below, so deploy is added to it there via usermod. (Passwordless
    # sudo is granted by the `sudo:` line regardless of group membership.)
    groups: [sudo]
    shell: /bin/bash
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    ssh_authorized_keys:
      - ssh-ed25519 AAAA... your-key
ssh_pwauth: false
disable_root: true
package_update: true
packages: [ufw]
runcmd:
  - ufw default deny incoming
  - ufw default allow outgoing
  - ufw allow 22/tcp
  - ufw allow 80/tcp
  - ufw allow 443/tcp
  - ufw --force enable
  - printf 'PermitRootLogin no\n' > /etc/ssh/sshd_config.d/10-tickr-hardening.conf
  - systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  - curl -fsSL https://get.docker.com | sh
  - usermod -aG docker deploy
  - mkdir -p /srv/tickr/repo /srv/tickr/data/pg /srv/tickr/backups /srv/tickr/secrets
  - chown -R deploy:deploy /srv/tickr
  - chmod 700 /srv/tickr/secrets
```

**Verify provisioning.** Once the server is up (give cloud-init a minute to
finish), confirm every step landed — from your workstation:

```bash
scripts/provision-audit.sh deploy@<VPS_IPv4>     # default host: deploy@49.13.210.41
```

It probes the public ports (expects only 22 open until the stack is up; flags
5432/6379/2019 if ever reachable), confirms key-only SSH with root login refused,
and checks `cloud-init status`, the `deploy` user + groups, sshd hardening,
Docker + the compose plugin, the UFW rules, and the `/srv/tickr` layout. It is
read-only and exits non-zero on any failure — green means you're clear to start
§3.

## 2. DNS + TLS

Point both hosts at the VPS. The `A` (IPv4) records are what make the site
broadly reachable; add `AAAA` (IPv6) too if you provisioned dual-stack (free
bonus — IPv6 clients get a direct path). Namecheap's Advanced DNS supports both.

```
tickr.keithheacock.com.       A      <VPS_IPv4>
tickr.keithheacock.com.       AAAA   <VPS_IPv6>     # optional, if dual-stack
www.tickr.keithheacock.com.   A      <VPS_IPv4>
www.tickr.keithheacock.com.   AAAA   <VPS_IPv6>     # optional, if dual-stack
```

TLS is automatic: `compose/Caddyfile.prod` lists the site addresses, and Caddy
obtains + renews Let's Encrypt certificates on first request. HSTS is set on the
apex host; `www` 301-redirects to the apex. No manual cert steps.

`compose/Caddyfile.prod` differs from the dev `compose/Caddyfile` only in the
site address and that it serves the prebuilt SPA from `/srv` (baked into the web
image) instead of proxying the Vite dev server.

## 3. Production secrets

```bash
# On the VPS, as deploy:
cp /srv/tickr/repo/.env.example /srv/tickr/secrets/tickr.env
chmod 600 /srv/tickr/secrets/tickr.env
# Edit it — at minimum set, for prod:
#   POSTGRES_PASSWORD     strong random
#   SESSION_SIGNING_KEY   openssl rand -hex 32
#   MASSIVE_API_KEY       production key
#   GOOGLE/GITHUB OAUTH   prod app credentials (see below)
#   ADMIN_BOOTSTRAP       your provider:subject
#   PUBLIC_BASE_URL=https://tickr.keithheacock.com
nano /srv/tickr/secrets/tickr.env
```

The file is **never committed** (it lives outside the repo) and is loaded into
containers via `env_file` in the prod overlay.

**OAuth apps are registered separately for prod**, with only
`https://tickr.keithheacock.com/api/v1/auth/google/callback` (and the github
equivalent) as the allowed redirect.

> Known issue: the production Google OAuth app currently uses the domain spelled
> `ticker`, not `tickr` — confirm the redirect URI matches the real domain
> before go-live.

## 4. First-time bring-up

```bash
git clone <repo> /srv/tickr/repo        # if not already cloned
cd /srv/tickr/repo

# Standard prod compose invocation (used throughout this runbook):
compose() {
  docker compose \
    -f compose/docker-compose.yml \
    -f compose/docker-compose.prod.yml \
    --env-file /srv/tickr/secrets/tickr.env "$@"
}

export TICKR_IMAGE_TAG="$(git rev-parse HEAD)"   # or a SHA pushed by CI

compose build                            # or `compose pull` if using GHCR images

compose run --rm api pnpm run db:migrate
compose run --rm api pnpm run db:seed:universe   # seed the universe
compose up -d
```

> **Why no data audit here (unlike a redeploy):** the audit checks the existing
> `price_bar` corpus and **fails** when there are no bars (`NO_BARS`) or no
> schema at all — both true on a fresh install. It is a guard against migrating
> a *dirty existing* corpus, so it belongs on redeploys (`scripts/deploy.sh`
> runs it before every migration), not on bootstrap. Run it once **after** the
> first backfill completes to baseline the corpus (see below).

On boot the worker starts the bootstrap backfill; once symbols are
`backfilled = true` the index bot seeds its portfolio. Watch progress:

```bash
compose logs -f worker
compose ps                               # all services should report healthy

# After backfill finishes (backfillRemaining = 0 in /admin/ops), baseline the
# corpus. Runs in the api container — the host has no Node/pnpm:
compose run --rm -v /srv/tickr/repo/scripts:/app/scripts:ro \
  api pnpm tsx /app/scripts/data-audit.ts
```

> **Note — the `bot` service:** the base compose defines a `bot` service with
> `ROLE=bot`, but `apps/api/src/index.ts` currently only handles `api` and
> `worker` and exits non-zero on any other role. Until the bot role is
> implemented (a separate slice), the `bot` container will restart-loop and the
> "bot healthy" check in TODO/12's DoD cannot pass. Either implement the role or
> drop the `bot` service from the overlay before go-live.

## 5. Routine deploys

One command, from the repo on the VPS:

```bash
cd /srv/tickr/repo && scripts/deploy.sh
```

It pre-flights (secrets present, clean tree, HEAD reachable from origin/main),
fast-forwards to `origin/main`, builds/pulls the SHA-pinned images, runs the
**data audit before migrating** (blocks on failure), migrates, brings the stack
up, then runs `scripts/smoke.sh` — **rolling back to the previous commit's image
on smoke failure**. CI (`.github/workflows/deploy.yml`) builds + pushes the
images per merge and can trigger this over SSH once `DEPLOY_ENABLED=true`.

## 6. Backups

`scripts/backup.sh` dumps the DB (`pg_dump -Fc | gzip`), `rclone copy`s it
off-VPS, and prunes local copies older than 7 days. Configure rclone once
(`rclone config` → a `remote` pointing at Hetzner Object Storage or Backblaze
B2), then schedule nightly via systemd:

```ini
# /etc/systemd/system/tickr-backup.service
[Service]
Type=oneshot
User=deploy
ExecStart=/srv/tickr/repo/scripts/backup.sh

# /etc/systemd/system/tickr-backup.timer
[Timer]
OnCalendar=*-*-* 04:30:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now tickr-backup.timer
systemctl list-timers tickr-backup.timer
```

Off-VPS retention is 7 days (`RCLONE_REMOTE` overrides the remote path).

## 7. Restore drill

Run quarterly to prove the backups restore:

```bash
cd /srv/tickr/repo && scripts/restore-drill.sh
```

It restores the newest dump (fetching from the remote if no local copy) into a
**throwaway** Postgres container, runs sanity queries (table/row counts, latest
`price_bar.ts`), tears the container down, and writes a PASS/FAIL report to
`docs/restore-drills/<timestamp>.md`. **Commit that report** for the record.

## 8. Smoke tests

`scripts/smoke.sh` checks `GET /api/v1/health` (200, unauthenticated) and,
when `SMOKE_ADMIN_COOKIE` is set, `GET /api/v1/admin/ops` for EOD-update
freshness (< 26 h). `/admin/ops` is session-cookie auth only (no API token in
v1), so capture an admin `tickr_sid` from the browser to enable that check:

```bash
SMOKE_ADMIN_COOKIE=<tickr_sid value> scripts/smoke.sh
```

deploy.sh runs it automatically and rolls back on failure.

## 9. Security posture confirmation

Run after the first deploy and after infra changes (TODO/12 item 11):

```bash
# TLS + HSTS present:
curl -sI https://tickr.keithheacock.com | grep -i strict-transport-security

# From a SEPARATE host, only 22/80/443 open (postgres/redis/api not exposed):
nmap -Pn tickr.keithheacock.com

# Secrets locked down:
ls -l /srv/tickr/secrets/tickr.env          # -rw------- (600), owner deploy

# Logs free of secrets (should print nothing):
cd /srv/tickr/repo
docker compose -f compose/docker-compose.yml -f compose/docker-compose.prod.yml \
  --env-file /srv/tickr/secrets/tickr.env logs \
  | grep -E 'MASSIVE_API_KEY|FINNHUB_API_KEY|OAUTH_CLIENT_SECRET' || echo "clean"
```

## 10. Sizing, monitoring & load testing

**VPS sizing (CX22, 2 vCPU / 4 GB).** Per-service memory caps in the prod
overlay total ~3.1 GB, leaving headroom for the kernel + page cache:

| Service  | mem cap | cpu cap | Notes |
|----------|---------|---------|-------|
| postgres | 1536 MB | 1.0     | Largest consumer; holds the `price_bar` hypertable (~16 M rows at full 15-min corpus). |
| api      | 512 MB  | 0.75    | Fastify + WS gateway. |
| worker   | 512 MB  | 0.75    | Backfill is I/O- and rate-limit-bound (~5 req/min to Massive), not CPU-bound. |
| bot      | 256 MB  | 0.25    | Idle in v1 after seeding. |
| redis    | 256 MB  | 0.5     | Cache + token bucket + queue; rebuildable. |
| caddy    | 128 MB  | 0.5     | TLS + static SPA. |

**When to scale up off the CX22:**
- Postgres working set + `price_bar` growth pushes memory pressure (watch
  `pg` cache hit ratio and swap). The full 500-symbol 15-min corpus (~16 M rows)
  fits comfortably; finer granularity or many seasons is the trigger to move to
  CX32 (4 vCPU / 8 GB).
- Sustained API p95 latency climbing under concurrent users (see load testing).
- Disk: bars are append-only; `/srv/tickr/data/pg` growth + 7 days of local
  dumps must stay under the 40 GB volume. Add a Hetzner volume before ~70% full.

**Monitoring / alerting (v1 minimum, TODO).** Observability is in-process
(structured JSON logs + `GET /admin/ops`; see [08-deployment.md §6](08-deployment.md#6-observability)).
There is **no external monitoring stack in v1.** Gaps to close before relying on
this in production:
- **Uptime/health alerting:** nothing pages on a down host. Add an external
  uptime check on `/api/v1/health` (e.g. a free Uptime-Kuma/Healthchecks.io
  monitor) — the single most important missing piece.
- **EOD-lag / backfill-stuck alerts** are designed (email/Discord webhook from
  the worker) but not wired; `/admin/ops` surfaces the numbers for manual checks
  only.
- **Backup-success alerting:** the systemd timer logs failures locally but does
  not notify. Add `OnFailure=` or a Healthchecks.io ping to `backup.sh`.

**Load testing.** Not yet performed. Before public launch, run a `k6`/`autocannon`
profile against `/api/v1/health`, the universe/prices read paths, and the WS
gateway at expected concurrency, and record p50/p95 here. Until then, CX22
sizing is an estimate from the data-model row counts, not a measured result.

## 11. Rollback & recovery

- **Automatic:** deploy.sh rolls back to the previously running image + commit on
  smoke-test failure.
- **Manual:** redeploy a known-good SHA —
  ```bash
  cd /srv/tickr/repo
  git checkout --detach <good-sha>
  TICKR_IMAGE_TAG=<good-sha> docker compose \
    -f compose/docker-compose.yml -f compose/docker-compose.prod.yml \
    --env-file /srv/tickr/secrets/tickr.env up -d
  ```
- **Data recovery:** restore the newest dump into the live DB with `pg_restore`
  (validate first with `scripts/restore-drill.sh`). Postgres is the system of
  record; Redis is rebuildable and needs no restore.
```
