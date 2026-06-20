#!/usr/bin/env bash
#
# Run a one-off backend job against the *currently deployed* code. Runs on the
# VPS (directly or over SSH) from the repo at /srv/tickr/repo.
#
# Why this exists: the prod compose pins images by tag —
#   image: ghcr.io/kgheacock/tickr-api:${TICKR_IMAGE_TAG:-local}
# so a bare `docker compose run api ...` with TICKR_IMAGE_TAG unset silently
# falls back to the stale `:local` hand-built image and runs OLD code against
# prod data (or fails on a missing script). deploy.sh sets the tag; ad-hoc
# operators forget to. This script removes the footgun by *deriving* the tag
# from the api container that's actually running, so a manual job always runs
# the same image the live stack is serving — never `:local`, never guessed.
#
# It runs the job in an isolated ephemeral container (`run --rm`), so a heavy or
# long job doesn't compete with the live request-serving api process.
#
# Usage:
#   scripts/run-job.sh <job> [extra args...]
#
# Jobs (the apps/api one-shot runners; see apps/api/package.json):
#   classify        recompute FS player classifications from price_bar
#   metadata        refresh symbol metadata
#   backfill        backfill price history
#   close-capture   capture FS session closes
#
# The host only needs Docker + the compose plugin — Node/pnpm are NOT required;
# the job runs inside the api container, like the deploy's audit/migrate steps.
set -euo pipefail

cd "$(dirname "$0")/.."

SECRETS=/srv/tickr/secrets/tickr.env
COMPOSE=(docker compose
  -f compose/docker-compose.yml
  -f compose/docker-compose.prod.yml
  --env-file "$SECRETS")

# Only well-known one-shot job runners — not arbitrary package scripts. Keeps
# this off the path to db:migrate (deploy.sh owns that) and typos.
ALLOWED_JOBS="classify metadata backfill close-capture"

log() { echo "[run-job] $*"; }
die() { echo "[run-job] ERROR: $*" >&2; exit 1; }

JOB="${1:-}"
[[ -n "$JOB" ]] || die "usage: scripts/run-job.sh <job> [args...]   (jobs: ${ALLOWED_JOBS})"
shift
[[ " $ALLOWED_JOBS " == *" $JOB "* ]] \
  || die "'${JOB}' is not an allowed job — choose one of: ${ALLOWED_JOBS}"

[[ -f "$SECRETS" ]] || die "secrets file $SECRETS not found"

# --- Derive the tag the live api container is actually running -----------------
# Same source deploy.sh uses to record the rollback image (deploy.sh:61). If the
# stack isn't up there's nothing to derive from — fail loudly rather than let
# compose default to the stale `:local` image, which is the whole point here.
IMAGE="$("${COMPOSE[@]}" ps -q api 2>/dev/null | head -1 \
  | xargs -r docker inspect -f '{{.Config.Image}}' 2>/dev/null || true)"
[[ -n "$IMAGE" ]] \
  || die "no running api container to read the deployed image from — deploy first (scripts/deploy.sh); refusing to fall back to :local"

TAG="${IMAGE##*:}"
[[ -n "$TAG" && "$TAG" != "local" ]] \
  || die "live api image is '${IMAGE}' (tag '${TAG}') — that's the stale hand-build, not a deployed SHA; deploy before running prod jobs"

log "running '${JOB}' against deployed image ${IMAGE}"
TICKR_IMAGE_TAG="$TAG" "${COMPOSE[@]}" run --rm api pnpm run "$JOB" "$@"
log "'${JOB}' finished"
