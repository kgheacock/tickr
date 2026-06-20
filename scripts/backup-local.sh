#!/usr/bin/env bash
#
# Versioned LOCAL backup of the production database. Reads the currently deployed
# version from the live health endpoint, takes a read-only logical dump of prod
# over SSH, and saves it to this repo's backups/ folder named after that version.
#
# This is the operator-side stand-in for an off-VPS backup. scripts/backup.sh
# ships nightly dumps off the box with rclone, but rclone is not configured on
# this host yet — so before a release we keep a versioned snapshot of the database
# on the machine running the deploy instead. Pair it with scripts/release-*.sh.
#
# Usage:
#   scripts/backup-local.sh
#
# Env overrides:
#   SSH_HOST    prod ssh alias        (default: tickr-prod)
#   HEALTH_URL  health endpoint URL   (default: https://tickr.keithheacock.com/api/v1/health)
#   POSTGRES_USER / POSTGRES_DB       (default: tickr / tickr)
#
# Read-only against prod (uses the same pg_dump-over-SSH path as db-clone-prod.sh)
# and never writes to prod. backups/ is .gitignored, so dumps are never committed.
set -euo pipefail

cd "$(dirname "$0")/.."

SSH_HOST="${SSH_HOST:-tickr-prod}"
HEALTH_URL="${HEALTH_URL:-https://tickr.keithheacock.com/api/v1/health}"
DB_USER="${POSTGRES_USER:-tickr}"
DB_NAME="${POSTGRES_DB:-tickr}"
PROD_PG_CONTAINER="tickr-postgres-1"
BACKUP_DIR=backups

log() { echo "[backup-local] $*"; }
die() { echo "[backup-local] ERROR: $*" >&2; exit 1; }

# --- 1. Currently deployed version (names the backup) --------------------------
# The dump is labelled with whatever version is live RIGHT NOW, so the file is a
# snapshot of the data that version was serving — exactly what you'd restore to if
# the upcoming release goes wrong.
log "reading deployed version from ${HEALTH_URL}"
health="$(curl -fsS --max-time 15 "$HEALTH_URL")" || die "could not reach health endpoint ${HEALTH_URL}"
VERSION="$(printf '%s' "$health" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[[ -n "$VERSION" ]] || die "health response had no \"version\" field: ${health}"
VERSION="${VERSION#v}"
log "currently deployed version: v${VERSION}"

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"   # timestamp keeps repeat backups of one version from clobbering
FILE="${BACKUP_DIR}/tickr-v${VERSION}-${TS}.dump.gz"

# --- 2. Dump prod (read-only, no downtime) -------------------------------------
log "dumping ${DB_NAME} from ${SSH_HOST} -> ${FILE} (this can take a while)"
ssh "$SSH_HOST" "docker exec -i ${PROD_PG_CONTAINER} pg_dump -U ${DB_USER} -Fc ${DB_NAME}" \
  | gzip > "$FILE"

# --- 3. Sanity-check the dump --------------------------------------------------
# A near-empty file means pg_dump errored mid-stream; fail loudly so nobody trusts
# a backup that isn't really there.
SIZE="$(stat -f %z "$FILE" 2>/dev/null || stat -c %s "$FILE")"
[[ "$SIZE" -gt 1024 ]] || die "dump suspiciously small (${SIZE} bytes) — backup not trustworthy; removed: $(rm -f "$FILE"; echo "$FILE")"
log "backup ok: ${FILE} ($(du -h "$FILE" | cut -f1))"
log "restore with: scripts/db-restore.sh (dev) or pg_restore; validate first with scripts/restore-drill.sh"
