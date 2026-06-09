#!/usr/bin/env bash
#
# One-shot dev stack. Starts backend services in Docker, then runs the web
# dev server in the foreground at http://localhost:5173.
#
# Usage: pnpm dev [-- -y] [docker compose args]
#   -y  kill any process already on port 5173 instead of erroring
#
# After startup: docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml logs -f
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "[dev-up] .env missing — copying from .env.example"
  cp .env.example .env
  echo "[dev-up] edit .env to fill in OAuth and SESSION_SIGNING_KEY"
fi

# Strip -y from the arg list; pass the rest through to docker compose.
FORCE_PORT=false
COMPOSE_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "-y" ]]; then
    FORCE_PORT=true
  else
    COMPOSE_ARGS+=("$arg")
  fi
done

echo "[dev-up] starting backend services..."
# --renew-anon-volumes recreates the node_modules anonymous volumes so they
# stay in sync with the rebuilt image after lockfile changes.
docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml up --build --renew-anon-volumes -d ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"}

VITE_PID=""

cleanup() {
  echo ""
  echo "[dev-up] stopping..."
  [[ -n "$VITE_PID" ]] && kill "$VITE_PID" 2>/dev/null || true
  docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml stop
}
trap cleanup EXIT INT TERM

# Stream API logs in full; Caddy filtered to errors only (its JSON uses "level":"error").
docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml logs -f api >&2 &
docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml logs -f caddy \
  | grep --line-buffered '"level":"error"' >&2 &

echo "[dev-up] waiting for API on :3000..."
attempts=0
until curl -sf http://localhost:3000/api/v1/health >/dev/null 2>&1; do
  sleep 1
  attempts=$((attempts + 1))
  if [[ $attempts -ge 90 ]]; then
    echo "[dev-up] API did not become healthy after 90s — check logs above" >&2
    exit 1
  fi
done

echo "[dev-up] API ready — starting web dev server..."
if lsof -ti:5173 >/dev/null 2>&1; then
  if [[ "$FORCE_PORT" == "true" ]]; then
    lsof -ti:5173 | xargs kill -9
  else
    echo "[dev-up] port 5173 is already in use." >&2
    echo "[dev-up] stop the process or re-run with -y to kill it automatically: pnpm dev -- -y" >&2
    exit 1
  fi
fi

pnpm --filter @tickr/web run dev &
VITE_PID=$!

until curl -sf http://localhost:5173/ >/dev/null 2>&1; do
  sleep 0.5
done

echo ""
echo "[dev-up] web ready → http://localhost:5173"
echo "[dev-up]            → https://local.tickr.keithheacock.com  (if /etc/hosts is configured per setup guide)"
echo ""

wait "$VITE_PID" || true
