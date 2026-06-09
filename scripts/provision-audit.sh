#!/usr/bin/env bash
#
# Provisioning audit. Verifies a freshly-created VPS is hardened and ready for
# the first bring-up: cloud-init finished cleanly and every step from
# docs/runbook.md §1 / §1.1 actually landed. Run this BEFORE §4.
#
# Usage:
#   scripts/provision-audit.sh [user@host]      # default: deploy@49.13.210.41
#   SSH_KEY=~/.ssh/id_ed25519 scripts/provision-audit.sh deploy@49.13.210.41
#
# Read-only: it inspects, it changes nothing. Exits non-zero if any check fails.
# Needs key-based SSH access as the deploy user (NOPASSWD sudo, per the §1.1
# cloud-init). The host needs no Node/pnpm. The on-host checks live in the
# companion scripts/provision-audit.remote.sh, piped over SSH.
set -uo pipefail

cd "$(dirname "$0")/.."
REMOTE_SCRIPT="scripts/provision-audit.remote.sh"

TARGET="${1:-deploy@49.13.210.41}"
HOST="${TARGET##*@}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new)
[[ -n "${SSH_KEY:-}" ]] && SSH_OPTS+=(-i "$SSH_KEY")

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
fails=0

probe() { nc -z -G3 -w3 "$HOST" "$1" 2>/dev/null || nc -z -w3 "$HOST" "$1" 2>/dev/null; }

# --- Local: external reachability (a mini nmap) --------------------------------
bold "== External port probe ($HOST) =="
for p in 22 80 443; do
  if probe "$p"; then
    echo "  port $p: OPEN"
  else
    echo "  port $p: closed/filtered  (80/443 are expected closed until the stack is up)"
  fi
done
# Anything else reachable from outside is a finding.
for p in 5432 6379 2019 8080; do
  if probe "$p"; then
    echo "  port $p: OPEN  <-- UNEXPECTED, should never be reachable externally"
    fails=$((fails + 1))
  fi
done

# --- SSH key-only connectivity -------------------------------------------------
bold "== SSH (key-only, as $TARGET) =="
if ssh "${SSH_OPTS[@]}" "$TARGET" true 2>/dev/null; then
  echo "  [PASS] key-based SSH works (no password prompt)"
else
  echo "  [FAIL] cannot SSH to $TARGET with key-only auth — fix this first"
  bold "ABORT: cannot run remote checks"
  exit 1
fi

# Negative check: root login should be refused.
if ssh "${SSH_OPTS[@]}" "root@${HOST}" true 2>/dev/null; then
  echo "  [FAIL] root SSH login SUCCEEDED — it must be disabled"
  fails=$((fails + 1))
else
  echo "  [PASS] root SSH login refused"
fi

# --- Remote audit (piped to the VPS) -------------------------------------------
bold "== Remote host checks =="
remote_out="$(ssh "${SSH_OPTS[@]}" "$TARGET" 'bash -s' <"$REMOTE_SCRIPT")"
rc=$?
echo "$remote_out" | grep -v '^REMOTE_FAILS='
remote_fails="$(echo "$remote_out" | sed -n 's/^REMOTE_FAILS=//p')"
fails=$((fails + ${remote_fails:-$rc}))

# --- Summary -------------------------------------------------------------------
echo
if [ "$fails" -eq 0 ]; then
  bold "PROVISION AUDIT: PASS — host is ready for first bring-up (runbook §4)"
else
  bold "PROVISION AUDIT: $fails issue(s) — resolve before deploying"
fi
exit "$fails"
