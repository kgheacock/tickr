#!/usr/bin/env bash
#
# Prepare a release: bump the version to the next MINOR and land it on main so the
# deploy serves it. Run this BEFORE scripts/deploy.sh.
#
# Why before deploy: deploy.sh fast-forwards the host to origin/main and serves
# that commit, and the live health endpoint reports the version baked into the
# code. So for health to report the new version, the bump has to already be on
# main when deploy.sh runs. This script makes that commit.
#
# It reads the currently deployed version from the health endpoint, computes the
# next minor (0.0.0 -> 0.1.0, 0.1.3 -> 0.2.0), writes it into the package.json
# files in BUMP_FILES, commits just those files, and pushes to origin/main. The
# new version is printed on stdout (last line) so the operator / deploy skill can
# feed it to scripts/release-publish.sh after the deploy succeeds.
#
# Usage:
#   scripts/release-prepare.sh
#
# Env overrides:
#   HEALTH_URL  health endpoint URL   (default: https://tickr.keithheacock.com/api/v1/health)
#   BUMP_FILES  space-separated package.json paths whose "version" to set
#               (default: "package.json apps/api/package.json")
set -euo pipefail

cd "$(dirname "$0")/.."

HEALTH_URL="${HEALTH_URL:-https://tickr.keithheacock.com/api/v1/health}"
BUMP_FILES="${BUMP_FILES:-package.json apps/api/package.json}"

# Logs go to stderr so the only thing on stdout is the new version (last line).
log() { echo "[release-prepare] $*" >&2; }
die() { echo "[release-prepare] ERROR: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is required to edit package.json safely (run from your dev machine, not the VPS)"

# --- 1. Currently deployed version ---------------------------------------------
log "reading deployed version from ${HEALTH_URL}"
health="$(curl -fsS --max-time 15 "$HEALTH_URL")" || die "could not reach health endpoint ${HEALTH_URL}"
CUR="$(printf '%s' "$health" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[[ -n "$CUR" ]] || die "health response had no \"version\" field: ${health}"
CUR="${CUR#v}"
log "currently deployed version: ${CUR}"

# --- 2. Compute the next minor -------------------------------------------------
IFS='.' read -r MAJ MIN _PATCH <<<"$CUR"
[[ "$MAJ" =~ ^[0-9]+$ && "$MIN" =~ ^[0-9]+$ ]] \
  || die "deployed version '${CUR}' is not semver MAJOR.MINOR.PATCH — cannot compute next minor"
NEXT="${MAJ}.$((MIN + 1)).0"
TAG="v${NEXT}"
log "next minor version: ${NEXT}"

# --- 3. Guards -----------------------------------------------------------------
# We're about to push to main; make sure local main is clean, current, and that
# this version isn't already tagged (which would mean health/the tag are out of
# sync and we'd be re-releasing).
branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || die "on '${branch}', not main — release bumps land on main; checkout main first"

git fetch --quiet origin main
git fetch --quiet --tags origin || true
git merge-base --is-ancestor HEAD origin/main \
  || die "local main has diverged from origin/main — reconcile (git pull --rebase) before releasing"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] \
  || die "local main is behind/ahead of origin/main — sync to origin/main first so the bump sits on top of what's live"

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  die "tag ${TAG} already exists — deployed version (${CUR}) and tags are out of sync; resolve before releasing"
fi

# --- 4. Bump the version in each package.json ----------------------------------
# node rewrites only the "version" field and preserves formatting (2-space indent
# + trailing newline), so the diff is exactly the bump and nothing else.
for f in $BUMP_FILES; do
  [[ -f "$f" ]] || die "bump target '${f}' not found (set BUMP_FILES to match this repo)"
  node -e 'const fs=require("fs");const[p,v]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(p,"utf8"));j.version=v;fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");' "$f" "$NEXT"
  git add -- "$f"
  log "bumped ${f} -> ${NEXT}"
done

# Path-scoped staging above means only the package.json files are staged — any
# other working-tree changes (e.g. new scripts) are left untouched, on purpose.
if git diff --cached --quiet; then
  die "nothing to commit — files were already at ${NEXT}? (health may be stale)"
fi

# --- 5. Commit + push to main --------------------------------------------------
git commit --quiet -m "release: ${TAG}"
log "pushing release commit to origin/main ($(git rev-parse --short HEAD))"
git push --quiet origin main \
  || die "push to main rejected (branch protection? someone pushed first?) — 'git pull --rebase' and retry"

log "prepared ${TAG}. Next: run the deploy, then 'scripts/release-publish.sh ${NEXT}'"
# stdout: the new version, for the caller to capture
printf '%s\n' "$NEXT"
