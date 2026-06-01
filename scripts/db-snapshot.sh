#!/usr/bin/env bash
#
# Take a local snapshot of the postgres volume for dev use.
# Saves a compressed tar of the named Docker volume to backups/.
# These files are .gitignored — never committed.
#
# Usage: scripts/db-snapshot.sh
#
# Postgres is stopped for the ~10s it takes to tar the volume, then restarted.
# All other services keep running.
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f compose/docker-compose.yml"
VOLUME="tickr_tickr-pg-data"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
FILE="backups/tickr-${TIMESTAMP}.tar.gz"

mkdir -p backups

echo "[db-snapshot] Stopping postgres..."
$COMPOSE stop postgres

echo "[db-snapshot] Taring volume to ${FILE} ..."
docker run --rm \
  -v "${VOLUME}:/pgdata:ro" \
  -v "$(pwd)/backups:/backup" \
  alpine tar czf "/backup/tickr-${TIMESTAMP}.tar.gz" -C /pgdata .

echo "[db-snapshot] Restarting postgres..."
$COMPOSE start postgres

SIZE=$(du -sh "$FILE" | cut -f1)
echo "[db-snapshot] Done: ${FILE} (${SIZE})"
