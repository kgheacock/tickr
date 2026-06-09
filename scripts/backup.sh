#!/usr/bin/env bash
#
# Nightly Postgres backup. Dumps the running prod database, ships it off-VPS
# with rclone, and prunes local copies older than 7 days. Driven by a systemd
# timer (or cron) on the host — see docs/runbook.md. TODO/12 item 6.
#
# Usage: scripts/backup.sh
#
# Requires: docker + compose plugin, rclone configured with a `tickr-backups`
# remote (env RCLONE_REMOTE overrides the remote:path). Host needs no Node/pnpm.
set -euo pipefail

cd "$(dirname "$0")/.."

SECRETS=/srv/tickr/secrets/tickr.env
BACKUP_DIR=/srv/tickr/backups
RCLONE_REMOTE="${RCLONE_REMOTE:-remote:tickr-backups}"
RETENTION_DAYS=7

COMPOSE=(docker compose
  -f compose/docker-compose.yml
  -f compose/docker-compose.prod.yml
  --env-file "$SECRETS")

log() { echo "[backup] $*"; }

# Pull DB name from the secrets file so the dump targets the right database.
# shellcheck disable=SC1090
DB_NAME="$(grep -E '^POSTGRES_DB=' "$SECRETS" | tail -1 | cut -d= -f2-)"
DB_NAME="${DB_NAME:-tickr}"
DB_USER="$(grep -E '^POSTGRES_USER=' "$SECRETS" | tail -1 | cut -d= -f2-)"
DB_USER="${DB_USER:-tickr}"

mkdir -p "$BACKUP_DIR"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/tickr-${ts}.dump.gz"

log "dumping ${DB_NAME} -> ${file}"
# -Fc custom format (compressible, restored with pg_restore); -T avoids a TTY.
"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U "$DB_USER" -Fc "$DB_NAME" \
  | gzip > "$file"

# Fail loudly if the dump is suspiciously small (e.g. pg_dump errored mid-stream).
size="$(stat -c %s "$file" 2>/dev/null || stat -f %z "$file")"
[[ "$size" -gt 1024 ]] || { echo "[backup] ERROR: dump is only ${size} bytes" >&2; exit 1; }
log "dump ok (${size} bytes)"

log "uploading to ${RCLONE_REMOTE}/"
rclone copy "$file" "${RCLONE_REMOTE}/"

log "pruning local backups older than ${RETENTION_DAYS} days"
find "$BACKUP_DIR" -type f -name 'tickr-*.dump.gz' -mtime +"$RETENTION_DAYS" -delete

log "done"
