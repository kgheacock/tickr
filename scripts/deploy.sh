#!/usr/bin/env bash
#
# One-command production deploy. Runs on the VPS (directly or over SSH from CI)
# from the repo at /srv/tickr/repo. Fast-forwards to origin/main, builds the
# pinned images, runs the pre-migration data audit, migrates, brings the stack
# up, and smoke-tests it — rolling back to the previously deployed commit if the
# smoke test fails. See docs/runbook.md and TODO/12.
#
# Usage: scripts/deploy.sh
#
# The host only needs Docker + the compose plugin — Node/pnpm are NOT required.
# The data audit and migrations run inside the api container, not on the host.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

SECRETS=/srv/tickr/secrets/tickr.env
COMPOSE=(docker compose
  -f compose/docker-compose.yml
  -f compose/docker-compose.prod.yml
  --env-file "$SECRETS")

log() { echo "[deploy] $*"; }
die() { echo "[deploy] ERROR: $*" >&2; exit 1; }

# --- Pre-flight checks (TODO/12 item 5) ----------------------------------------
[[ -f "$SECRETS" ]] || die "secrets file $SECRETS not found (chmod 600, owned by deploy user)"
[[ -z "$(git status --porcelain)" ]] || die "working tree is dirty — commit or clean before deploying"

# Refuse to deploy with the dev-only auth bypass enabled. TICKR_DEV_AUTH gates
# the POST /auth/dev-login backdoor (see apps/api/src/roles/api.ts); set to any
# non-empty value in the prod secrets it would mint real sessions for anyone.
if grep -Eq '^[[:space:]]*TICKR_DEV_AUTH[[:space:]]*=[[:space:]]*[^[:space:]]' "$SECRETS"; then
  die "TICKR_DEV_AUTH is set in $SECRETS — the dev auth bypass must never be enabled in production; remove it before deploying"
fi

log "fetching origin/main..."
git fetch --quiet origin main

PREV_SHA="$(git rev-parse HEAD)"
# Current commit must be reachable from origin/main (no local divergence).
git merge-base --is-ancestor HEAD origin/main \
  || die "HEAD ($PREV_SHA) is not reachable from origin/main — refusing to deploy"

# Record the image tag currently serving, for rollback. Empty on first deploy.
PREV_IMAGE="$("${COMPOSE[@]}" ps -q api 2>/dev/null | head -1 \
  | xargs -r docker inspect -f '{{.Config.Image}}' 2>/dev/null || true)"

NEW_SHA="$(git rev-parse origin/main)"
log "deploying ${NEW_SHA} (was ${PREV_SHA})"
git checkout --quiet --detach "$NEW_SHA"
export TICKR_IMAGE_TAG="$NEW_SHA"

rollback() {
  echo "[deploy] !!! rolling back to ${PREV_SHA} (image: ${PREV_IMAGE:-<none>})" >&2
  git checkout --quiet --detach "$PREV_SHA" || true
  if [[ -n "$PREV_IMAGE" ]]; then
    export TICKR_IMAGE_TAG="${PREV_IMAGE##*:}"
    "${COMPOSE[@]}" up -d || true
  else
    echo "[deploy] no previous image recorded — leaving stack down for manual recovery" >&2
  fi
  die "deploy failed; rolled back"
}

# --- Build pinned images -------------------------------------------------------
log "building images (tag ${NEW_SHA})..."
"${COMPOSE[@]}" build || rollback

# --- Data audit BEFORE migrating (TODO/12 item 5, TODO/19) ---------------------
# Runs inside the api container (has tsx + pg + DATABASE_URL pointing at the
# postgres service). A non-zero exit blocks the deploy.
log "running pre-migration data audit..."
"${COMPOSE[@]}" run --rm \
  -v "$REPO_ROOT/scripts:/app/scripts:ro" \
  api pnpm tsx /app/scripts/data-audit.ts \
  || die "data audit failed — aborting BEFORE any migration (no rollback needed)"

# --- Migrate + bring up --------------------------------------------------------
log "running migrations..."
"${COMPOSE[@]}" run --rm api pnpm run db:migrate || rollback

log "starting services..."
"${COMPOSE[@]}" up -d || rollback

# --- Smoke test, roll back on failure (TODO/12 item 10) ------------------------
log "smoke-testing..."
scripts/smoke.sh || rollback

log "deploy succeeded — now serving ${NEW_SHA}"
