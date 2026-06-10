#!/usr/bin/env bash
#
# Copy the CURRENT production database into the local dev Postgres.
#
# Takes a logical dump of prod over SSH (read-only pg_dump — no prod downtime),
# then restores it into the local dev stack's postgres container, replacing
# whatever is there. TimescaleDB hypertables are restored with the extension in
# "restore mode" (pre/post hooks), same as scripts/restore-drill.sh.
#
# Usage:
#   scripts/db-clone-prod.sh
#
# Env overrides:
#   SSH_HOST    prod ssh host          (default: tickr-prod)
#   KEEP_DUMP   1 = keep the dump in backups/ instead of deleting  (default: 0)
#
# Prereqs:
#   - Local dev stack postgres is running (pnpm dev / scripts/dev-up.sh).
#   - Prod reachable via `ssh $SSH_HOST` with docker access.
#
# WARNING: this DROPs and recreates the local `tickr` database. Local data is
# lost. It never writes to prod.
#
# Note: prod's DATA is restored as-is, but when api/worker restart afterwards
# they run migrations on boot — so any migrations on your local branch that
# aren't deployed to prod yet get applied, adding their (empty) tables. The end
# state is "prod data on your branch's schema", which is what dev wants.
set -euo pipefail

cd "$(dirname "$0")/.."

SSH_HOST="${SSH_HOST:-tickr-prod}"
KEEP_DUMP="${KEEP_DUMP:-0}"
DB_USER="${POSTGRES_USER:-tickr}"
DB_NAME="${POSTGRES_DB:-tickr}"
PROD_PG_CONTAINER="tickr-postgres-1"

DEV_COMPOSE=(docker compose
  -f compose/docker-compose.yml
  -f compose/docker-compose.dev.yml)

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="backups/prod-${TS}.dump.gz"

log() { echo "[db-clone-prod] $*"; }
die() { echo "[db-clone-prod] ERROR: $*" >&2; exit 1; }

mkdir -p backups

# Resolve the local postgres container id from compose.
LOCAL_PG="$("${DEV_COMPOSE[@]}" ps -q postgres 2>/dev/null || true)"
[[ -n "$LOCAL_PG" ]] || die "local postgres not running — start the dev stack first (pnpm dev)"
docker exec "$LOCAL_PG" pg_isready -U "$DB_USER" >/dev/null 2>&1 \
  || die "local postgres ($LOCAL_PG) not accepting connections"

# --- Version parity guard ------------------------------------------------------
# `timescale/timescaledb-ha:pg16` is a rolling tag, so a re-pulled local image
# can drift ahead of prod. Restoring a dump into a NEWER TimescaleDB than it was
# taken from is unsupported and can silently under-restore. Fail loudly instead.
TS_QUERY="SELECT extversion FROM pg_extension WHERE extname='timescaledb'"

log "checking TimescaleDB version parity"
PROD_TS="$(ssh "$SSH_HOST" "docker exec -i $PROD_PG_CONTAINER psql -U $DB_USER -d $DB_NAME -tAc \"$TS_QUERY\"" | tr -d '[:space:]')"
LOCAL_TS="$(docker exec -i "$LOCAL_PG" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$TS_QUERY" | tr -d '[:space:]')"
[[ -n "$PROD_TS" ]] || die "could not read prod TimescaleDB version"
log "prod=${PROD_TS}  local=${LOCAL_TS}"
[[ "$PROD_TS" == "$LOCAL_TS" ]] || die \
  "TimescaleDB version mismatch (prod ${PROD_TS} != local ${LOCAL_TS}). Restoring across versions can corrupt data. Align the local image (docker pull / pin) before retrying."

# --- 1. Dump prod over SSH (read-only) -----------------------------------------
log "dumping prod database from ${SSH_HOST} (this can take a while)..."
ssh "$SSH_HOST" "docker exec -i $PROD_PG_CONTAINER pg_dump -U $DB_USER -Fc $DB_NAME" \
  | gzip > "$DUMP"

SIZE="$(stat -f %z "$DUMP" 2>/dev/null || stat -c %s "$DUMP")"
[[ "$SIZE" -gt 1024 ]] || die "dump suspiciously small (${SIZE} bytes) — aborting before touching local DB"
log "dump ok: ${DUMP} ($(du -h "$DUMP" | cut -f1))"

# --- 2. Quiesce local writers --------------------------------------------------
# api/worker run migrations on boot and hold connections; stop them so they
# don't recreate tables between CREATE DATABASE and pg_restore, then restart.
log "stopping local api/worker/bot during restore"
"${DEV_COMPOSE[@]}" stop api worker bot >/dev/null 2>&1 || true
restart_services() {
  # `up -d` (not `start`) so the containers reattach to the compose network
  # cleanly — a plain `start` after a partial-up can leave them unable to
  # resolve sibling services (e.g. redis) by name.
  log "restarting local api/worker/bot"
  "${DEV_COMPOSE[@]}" up -d api worker bot >/dev/null 2>&1 || true
}
trap restart_services EXIT

# --- 3. Recreate the local database fresh --------------------------------------
log "recreating local database ${DB_NAME}"
docker exec -i "$LOCAL_PG" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 <<SQL
DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);
CREATE DATABASE ${DB_NAME};
SQL

# --- 4. Restore with TimescaleDB in restore mode -------------------------------
psql_t() { docker exec -i "$LOCAL_PG" psql -U "$DB_USER" -d "$DB_NAME" "$@"; }

log "putting timescaledb into restore mode"
psql_t -tAc "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();" >/dev/null \
  || log "timescaledb pre_restore unavailable — continuing with a plain restore"

log "running pg_restore"
gunzip -c "$DUMP" \
  | docker exec -i "$LOCAL_PG" pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl \
  || log "pg_restore reported warnings (often harmless for extensions) — continuing"

psql_t -tAc "SELECT timescaledb_post_restore();" >/dev/null 2>&1 \
  || log "timescaledb post_restore skipped"

# --- 5. Sanity check -----------------------------------------------------------
BARS="$(psql_t -tAc "SELECT count(*) FROM price_bar" 2>/dev/null | tr -d '[:space:]' || echo ERR)"
[[ "$BARS" =~ ^[0-9]+$ && "$BARS" -gt 0 ]] \
  || die "restore sanity check failed — price_bar has '${BARS}' rows (expected > 0)"
log "restore ok — price_bar rows: ${BARS}"

# --- 6. Cleanup ----------------------------------------------------------------
if [[ "$KEEP_DUMP" == "1" ]]; then
  log "keeping dump: ${DUMP}"
else
  rm -f "$DUMP"
fi

log "done — local ${DB_NAME} now mirrors prod"
