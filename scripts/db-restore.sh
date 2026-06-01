#!/usr/bin/env bash
#
# Restore postgres from a local snapshot created by db-snapshot.sh.
# Tears down the entire stack, wipes the volume, restores from tar, and exits.
# Run `scripts/dev-up.sh` (or `pnpm run dev`) afterwards to bring the stack back up.
#
# Usage:
#   scripts/db-restore.sh                          # restore latest snapshot
#   scripts/db-restore.sh backups/tickr-X.tar.gz   # restore specific file
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f compose/docker-compose.yml"
VOLUME="tickr_tickr-pg-data"

# Resolve snapshot file
FILE="${1:-}"
if [[ -z "$FILE" ]]; then
  FILE=$(ls -t backups/tickr-*.tar.gz 2>/dev/null | head -1 || true)
  if [[ -z "$FILE" ]]; then
    echo "[db-restore] No snapshot found in backups/. Run scripts/db-snapshot.sh first."
    exit 1
  fi
  echo "[db-restore] Using latest snapshot: ${FILE}"
fi

# Resolve to absolute path so the docker volume mount works regardless of cwd
FILE_ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
if [[ ! -f "$FILE_ABS" ]]; then
  echo "[db-restore] File not found: ${FILE_ABS}"
  exit 1
fi

echo "[db-restore] Restoring from $(basename "$FILE_ABS") ..."

echo "[db-restore] Bringing down all services..."
$COMPOSE down

echo "[db-restore] Removing existing volume..."
docker volume rm "$VOLUME" 2>/dev/null || true

echo "[db-restore] Restoring data into new volume..."
docker run --rm \
  -v "${VOLUME}:/pgdata" \
  -v "$(dirname "$FILE_ABS"):/backup:ro" \
  alpine tar xzf "/backup/$(basename "$FILE_ABS")" -C /pgdata

echo "[db-restore] Done. Run 'pnpm run dev' to bring the stack back up."
