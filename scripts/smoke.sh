#!/usr/bin/env bash
#
# Post-deploy smoke test. Wired into scripts/deploy.sh; a non-zero exit triggers
# an automatic rollback. TODO/12 item 10.
#
# Checks:
#   1. GET /api/v1/health returns 200 {"ok":true}  (unauthenticated)
#   2. GET /api/v1/admin/ops shows the EOD update ran within the last 26 h.
#
# /admin/ops is admin-only and authenticated by the `tickr_sid` session cookie
# (there is no bearer/API token in v1 — see apps/api/src/auth/middleware.ts), so
# the ops check only runs when SMOKE_ADMIN_COOKIE is set to a valid admin
# session token; otherwise it is skipped with a warning. To capture one: log in
# as an admin in the browser and copy the tickr_sid cookie value.
#
# Env:
#   SMOKE_BASE_URL        default https://tickr.keithheacock.com
#   SMOKE_ADMIN_COOKIE    admin tickr_sid value (optional; enables the ops check)
#   SMOKE_MAX_LAG_SEC     default 93600 (26 h)
#   SMOKE_HEALTH_TIMEOUT  default 90 — seconds to wait for the stack to come up
#   SMOKE_HEALTH_INTERVAL default 3 — seconds between health attempts
set -euo pipefail

BASE_URL="${SMOKE_BASE_URL:-https://tickr.keithheacock.com}"
MAX_LAG="${SMOKE_MAX_LAG_SEC:-93600}"
HEALTH_TIMEOUT="${SMOKE_HEALTH_TIMEOUT:-90}"
HEALTH_INTERVAL="${SMOKE_HEALTH_INTERVAL:-3}"

log() { echo "[smoke] $*"; }
die() { echo "[smoke] FAIL: $*" >&2; exit 1; }

# --- 1. Health ----------------------------------------------------------------
# deploy.sh runs this immediately after `docker compose up -d`, which returns as
# soon as containers are *started* — not ready. Two startup windows make a
# single attempt flap: (a) the published :443 rule and Caddy's listener are
# rebound during recreate (connection refused), and (b) caddy depends on api
# with `service_started`, but the api has no healthcheck and Fastify takes a few
# seconds to listen, so Caddy briefly returns 502. So poll until ready (curl -f
# fails on refused, timeout, AND 5xx) rather than failing on the first attempt.
log "GET ${BASE_URL}/api/v1/health (waiting up to ${HEALTH_TIMEOUT}s for readiness)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
body=""
until body="$(curl -fsS --max-time 5 "${BASE_URL}/api/v1/health" 2>/dev/null)"; do
  if (( $(date +%s) >= deadline )); then
    die "health endpoint not 2xx within ${HEALTH_TIMEOUT}s"
  fi
  sleep "$HEALTH_INTERVAL"
done
echo "$body" | grep -q '"ok":true' || die "health body unexpected: $body"
log "health ok"

# --- 2. Admin ops (optional) --------------------------------------------------
if [[ -z "${SMOKE_ADMIN_COOKIE:-}" ]]; then
  log "SMOKE_ADMIN_COOKIE unset — skipping /admin/ops freshness check"
  exit 0
fi

log "GET ${BASE_URL}/api/v1/admin/ops"
ops="$(curl -fsS --max-time 10 \
  --cookie "tickr_sid=${SMOKE_ADMIN_COOKIE}" \
  "${BASE_URL}/api/v1/admin/ops")" \
  || die "/admin/ops did not return 2xx (cookie expired or not admin?)"

# eodUpdateLagSec is a number, or null before the first EOD run.
lag="$(echo "$ops" | grep -oE '"eodUpdateLagSec":[0-9]+' | grep -oE '[0-9]+' || true)"
if [[ -z "$lag" ]]; then
  log "WARN: eodUpdateLagSec is null (no EOD run yet) — acceptable on a fresh deploy"
  exit 0
fi

if (( lag > MAX_LAG )); then
  die "EOD update lag ${lag}s exceeds ${MAX_LAG}s (missed a daily run)"
fi
log "EOD update lag ${lag}s within ${MAX_LAG}s"
log "all checks passed"
