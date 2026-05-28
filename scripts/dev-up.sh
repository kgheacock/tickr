#!/usr/bin/env bash
#
# One-shot dev stack. Brings up postgres + redis + api + worker + bot + caddy.
# Reachable at https://tickr.local once /etc/hosts maps tickr.local -> 127.0.0.1.
#
# First-run setup:
#   1. cp .env.example .env  (auto-done below if .env is missing)
#   2. Fill in OAuth + Finnhub values in .env
#   3. Add `127.0.0.1 tickr.local` to /etc/hosts
#   4. (optional) `caddy trust` to install Caddy's local root CA system-wide
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "[dev-up] .env missing — copying from .env.example"
  cp .env.example .env
  echo "[dev-up] edit .env to fill in FINNHUB_API_KEY, OAuth, and SESSION_SIGNING_KEY"
fi

exec docker compose -f compose/docker-compose.yml up --build "$@"
