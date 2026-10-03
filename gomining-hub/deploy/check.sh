#!/usr/bin/env bash
# Read-only preflight: shows what the VPS already runs before anything is installed.
# Changes nothing. Usage: bash check.sh hub.gooses.online
set -u
DOMAIN="${1:-}"
echo "== OS";            . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; uname -m
echo "== Resources";     free -h | sed -n 1,2p; df -h / | tail -1
echo "== Node";          command -v node >/dev/null && node -v || echo "not installed"
echo "== Web servers";   for s in nginx caddy apache2 httpd; do systemctl is-active --quiet "$s" 2>/dev/null && echo "$s: running"; done; true
echo "== Ports 80/443/4173"; (ss -tlnp 2>/dev/null || sudo ss -tlnp) | grep -E ':(80|443|4173)\b' || echo "none in use"
echo "== Running services (bots, node, python)"
systemctl list-units --type=service --state=running --no-legend 2>/dev/null | grep -iE "bot|goose|node|python|pm2" || echo "none matched"
command -v pm2 >/dev/null && pm2 list
if [ -n "$DOMAIN" ]; then
  echo "== DNS for $DOMAIN"
  getent hosts "$DOMAIN" || echo "does not resolve yet"
  echo "== This server's public IP"; curl -s -m 5 https://api.ipify.org || echo "unknown"; echo
fi
