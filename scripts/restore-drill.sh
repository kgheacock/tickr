#!/usr/bin/env bash
#
# Quarterly restore drill. Restores the most recent backup into a throwaway
# Postgres container, runs sanity queries, and writes a dated report to
# docs/restore-drills/ for the record. Proves the backups are actually
# restorable. TODO/12 item 7.
#
# Usage:
#   scripts/restore-drill.sh                       # newest local dump
#   scripts/restore-drill.sh /path/to/dump.gz      # a specific dump
#
# Pulls the newest dump from the rclone remote first if no local dump exists.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

BACKUP_DIR=/srv/tickr/backups
RCLONE_REMOTE="${RCLONE_REMOTE:-remote:tickr-backups}"
PG_IMAGE=timescale/timescaledb-ha:pg16
CONTAINER="tickr-restore-drill-$$"
REPORT_DIR="$REPO_ROOT/docs/restore-drills"

log() { echo "[restore-drill] $*"; }
die() { echo "[restore-drill] ERROR: $*" >&2; exit 1; }

# --- Resolve the dump ----------------------------------------------------------
DUMP="${1:-}"
if [[ -z "$DUMP" ]]; then
  DUMP="$(ls -t "$BACKUP_DIR"/tickr-*.dump.gz 2>/dev/null | head -1 || true)"
  if [[ -z "$DUMP" ]]; then
    log "no local dump; fetching newest from ${RCLONE_REMOTE}"
    mkdir -p "$BACKUP_DIR"
    newest="$(rclone lsf "${RCLONE_REMOTE}/" --include 'tickr-*.dump.gz' | sort | tail -1)"
    [[ -n "$newest" ]] || die "no dumps found locally or on the remote"
    rclone copy "${RCLONE_REMOTE}/${newest}" "$BACKUP_DIR/"
    DUMP="$BACKUP_DIR/$newest"
  fi
fi
[[ -f "$DUMP" ]] || die "dump not found: $DUMP"
log "restoring from $(basename "$DUMP")"

# --- Throwaway container -------------------------------------------------------
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "starting throwaway postgres ($CONTAINER)"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=tickr -e POSTGRES_PASSWORD=tickr -e POSTGRES_DB=tickr \
  "$PG_IMAGE" >/dev/null

log "waiting for it to accept connections"
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U tickr -d tickr >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$CONTAINER" pg_isready -U tickr -d tickr >/dev/null 2>&1 \
  || die "throwaway postgres never became ready"

# --- Restore -------------------------------------------------------------------
# TimescaleDB hypertables must be restored with the extension in "restore mode"
# (pre/post hooks), otherwise chunk data can be silently under-restored. See
# https://docs.timescale.com/self-hosted/latest/backup-and-restore/.
psql() { docker exec -i "$CONTAINER" psql -U tickr -d tickr "$@"; }

log "putting timescaledb into restore mode"
psql -tAc "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();" \
  >/dev/null 2>&1 || log "timescaledb pre_restore unavailable — continuing with a plain restore"

log "running pg_restore"
gunzip -c "$DUMP" \
  | docker exec -i "$CONTAINER" pg_restore -U tickr -d tickr --no-owner --no-acl \
  || log "pg_restore reported warnings (often harmless for extensions) — continuing"

psql -tAc "SELECT timescaledb_post_restore();" >/dev/null 2>&1 \
  || log "timescaledb post_restore skipped"

# --- Sanity queries ------------------------------------------------------------
q() { docker exec "$CONTAINER" psql -U tickr -d tickr -tAc "$1" 2>/dev/null || echo "ERR"; }

tables="$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
users="$(q "SELECT count(*) FROM app_user")"
bars="$(q "SELECT count(*) FROM price_bar")"
latest_bar="$(q "SELECT max(ts) FROM price_bar")"
universe="$(q "SELECT count(*) FROM universe_symbol")"

ok=true
# A successful restore must produce a schema AND non-empty price history — a
# 0-row price_bar means the hypertable restore silently failed, which is exactly
# the failure mode this drill exists to catch, so it must FAIL (not PASS).
[[ "$tables" =~ ^[0-9]+$ && "$tables" -gt 0 ]] || ok=false
[[ "$bars" =~ ^[0-9]+$ && "$bars" -gt 0 ]] || ok=false

# --- Report --------------------------------------------------------------------
mkdir -p "$REPORT_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
report="$REPORT_DIR/${stamp}.md"
{
  echo "# Restore drill — ${stamp}"
  echo
  echo "- **Dump:** \`$(basename "$DUMP")\`"
  echo "- **Image:** \`$PG_IMAGE\`"
  echo "- **Result:** $([[ "$ok" == true ]] && echo PASS || echo FAIL)"
  echo
  echo "| Check | Value |"
  echo "|---|---|"
  echo "| public tables | ${tables} |"
  echo "| app_user rows | ${users} |"
  echo "| universe_symbol rows | ${universe} |"
  echo "| price_bar rows | ${bars} |"
  echo "| latest price_bar.ts | ${latest_bar} |"
} > "$report"

log "report written: $report"
cat "$report"

[[ "$ok" == true ]] || die "sanity checks failed — see report"
log "restore drill PASSED"
