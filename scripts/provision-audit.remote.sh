#!/usr/bin/env bash
#
# On-host half of scripts/provision-audit.sh. Not run directly — it is piped to
# the VPS over SSH (`bash -s < this-file`). Prints PASS/FAIL/WARN lines and a
# final REMOTE_FAILS=<n> sentinel; exits with the failure count. Read-only.
set -uo pipefail

rfails=0
ok() { echo "  [PASS] $1"; }
bad() {
  echo "  [FAIL] $1"
  rfails=$((rfails + 1))
}
warn() { echo "  [WARN] $1"; }
S() { sudo -n "$@"; } # NOPASSWD sudo expected (per the §1.1 cloud-init)

# cloud-init completed without error
if command -v cloud-init >/dev/null 2>&1; then
  st="$(cloud-init status 2>/dev/null | tr -d '\n')"
  case "$st" in
  *done*) ok "cloud-init: $st" ;;
  *error*) bad "cloud-init reported an error: $st (see /var/log/cloud-init.log)" ;;
  *running*) bad "cloud-init still running: $st (re-run audit once it finishes)" ;;
  *) warn "cloud-init status unclear: '$st'" ;;
  esac
else
  warn "cloud-init not installed — provisioning may have been done manually"
fi

# OS
# shellcheck disable=SC1091
. /etc/os-release 2>/dev/null || true
case "${VERSION_ID:-}" in
12*) ok "OS: ${PRETTY_NAME:-Debian 12}" ;;
*) warn "OS is ${PRETTY_NAME:-unknown} (runbook targets Debian 12)" ;;
esac

# deploy user + groups
if id deploy >/dev/null 2>&1; then ok "user 'deploy' exists"; else bad "user 'deploy' missing"; fi
groups="$(id -nG deploy 2>/dev/null || echo '')"
echo "$groups" | grep -qw sudo && ok "deploy in 'sudo' group" || bad "deploy NOT in 'sudo' group"
echo "$groups" | grep -qw docker && ok "deploy in 'docker' group" || bad "deploy NOT in 'docker' group"

# SSH hardening (authoritative: effective sshd config)
sshd_cfg="$(S sshd -T 2>/dev/null || true)"
if [ -n "$sshd_cfg" ]; then
  echo "$sshd_cfg" | grep -qi '^permitrootlogin no' &&
    ok "sshd: PermitRootLogin no" || bad "sshd: PermitRootLogin is not 'no'"
  echo "$sshd_cfg" | grep -qi '^passwordauthentication no' &&
    ok "sshd: PasswordAuthentication no" || bad "sshd: PasswordAuthentication is not 'no'"
else
  warn "could not read effective sshd config (sudo -n failed?) — root login was checked externally"
fi

# Docker + compose plugin
docker --version >/dev/null 2>&1 && ok "docker: $(docker --version)" || bad "docker not installed"
docker compose version >/dev/null 2>&1 &&
  ok "compose plugin: $(docker compose version | head -1)" || bad "docker compose plugin missing"
[ "$(S systemctl is-active docker 2>/dev/null)" = active ] &&
  ok "docker service active" || bad "docker service not active"
docker ps >/dev/null 2>&1 &&
  ok "deploy can run docker without sudo" ||
  warn "deploy cannot run docker yet (log out/in once to pick up the docker group)"

# UFW
ufw_status="$(S ufw status verbose 2>/dev/null || true)"
echo "$ufw_status" | grep -qi 'Status: active' && ok "ufw active" || bad "ufw not active"
echo "$ufw_status" | grep -qi 'deny (incoming)' &&
  ok "ufw default deny incoming" || bad "ufw default-incoming is not deny"
for port in 22 80 443; do
  echo "$ufw_status" | grep -qE "(^|[^0-9])${port}/tcp.*ALLOW" &&
    ok "ufw allows ${port}/tcp" || bad "ufw missing allow for ${port}/tcp"
done

# Directory layout + secrets perms
for d in /srv/tickr/repo /srv/tickr/data/pg /srv/tickr/backups /srv/tickr/secrets; do
  [ -d "$d" ] && ok "dir exists: $d" || bad "dir missing: $d"
done
if [ -d /srv/tickr/secrets ]; then
  perm="$(stat -c '%a' /srv/tickr/secrets 2>/dev/null)"
  [ "$perm" = 700 ] && ok "/srv/tickr/secrets is 700" || bad "/srv/tickr/secrets is ${perm:-?} (want 700)"
  owner="$(stat -c '%U' /srv/tickr 2>/dev/null)"
  [ "$owner" = deploy ] && ok "/srv/tickr owned by deploy" || bad "/srv/tickr owned by ${owner:-?} (want deploy)"
fi

echo "REMOTE_FAILS=$rfails"
exit "$rfails"
