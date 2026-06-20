#!/usr/bin/env bash
#
# Publish a release AFTER a successful deploy: confirm the live site is serving
# the expected version, tag the deployed commit, push the tag, and create the
# GitHub release. Run this only once scripts/deploy.sh has succeeded and the bump
# from scripts/release-prepare.sh is live.
#
# It deliberately verifies the live health endpoint before tagging — a tag that
# points at a version the site isn't actually running would lie about what
# shipped, and tags are the rollback/audit trail.
#
# Usage:
#   scripts/release-publish.sh <version>      # e.g. scripts/release-publish.sh 0.1.0
#
# Env overrides:
#   HEALTH_URL  health endpoint URL   (default: https://tickr.keithheacock.com/api/v1/health)
#
# Requires: git, and the GitHub CLI `gh` authenticated for this repo.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:?usage: scripts/release-publish.sh <version>   (e.g. 0.1.0)}"
VERSION="${VERSION#v}"
TAG="v${VERSION}"
HEALTH_URL="${HEALTH_URL:-https://tickr.keithheacock.com/api/v1/health}"

log() { echo "[release-publish] $*"; }
die() { echo "[release-publish] ERROR: $*" >&2; exit 1; }

command -v gh >/dev/null 2>&1 \
  || die "GitHub CLI (gh) not installed/authenticated — needed to create the release. See https://cli.github.com/"

# --- 1. Verify the live site serves this version -------------------------------
log "verifying ${HEALTH_URL} reports ${VERSION}"
health="$(curl -fsS --max-time 15 "$HEALTH_URL")" || die "could not reach health endpoint ${HEALTH_URL}"
live="$(printf '%s' "$health" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
live="${live#v}"
[[ "$live" == "$VERSION" ]] \
  || die "live version is '${live}', expected '${VERSION}' — the deploy may not have completed; refusing to tag"

# --- 2. Tag the deployed commit ------------------------------------------------
# origin/main is what deploy.sh serves, so that's the commit this release is.
git fetch --quiet origin main
git fetch --quiet --tags origin || true
DEPLOY_SHA="$(git rev-parse origin/main)"

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  die "tag ${TAG} already exists locally — already published? (nothing to do)"
fi

log "tagging ${DEPLOY_SHA} as ${TAG}"
git tag -a "$TAG" "$DEPLOY_SHA" -m "tickr ${TAG}"
git push origin "$TAG" || die "failed to push tag ${TAG} to origin"

# --- 3. GitHub release ---------------------------------------------------------
# Notes = commit subjects since the previous tag, so the release page shows what
# actually shipped in this version.
PREV_TAG="$(git tag --list 'v*' --sort=-v:refname | grep -vx "$TAG" | head -1 || true)"
if [[ -n "$PREV_TAG" ]]; then
  heading="Changes since ${PREV_TAG}:"
  body="$(git --no-pager log --pretty='- %s (%h)' "${PREV_TAG}..${TAG}")"
else
  heading="Initial tagged release. Recent changes:"
  body="$(git --no-pager log --pretty='- %s (%h)' -n 20 "$TAG")"
fi

log "creating GitHub release ${TAG}"
printf '%s\n\n%s\n' "$heading" "$body" \
  | gh release create "$TAG" --target "$DEPLOY_SHA" --title "$TAG" --notes-file - \
  || die "gh release create failed (is gh authenticated for this repo? does the tag already have a release?)"

url="$(gh release view "$TAG" --json url --jq .url 2>/dev/null || true)"
log "published ${TAG}${url:+ -> ${url}}"
