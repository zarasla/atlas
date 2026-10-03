#!/usr/bin/env bash
# Updates the GoMining Hub app on the VPS to the code in this checkout.
# Usage on the VPS:  sudo bash deploy/update.sh
#
# Replaces only the app in /opt/gomining-hub and restarts the gomining-hub service. It does not touch
# the nginx/Caddy site or HTTPS certificate, /etc/gomining-hub.env (MCP key, token) or the payout
# history in /var/lib/gomining-hub, and never touches any other service.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root."; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/gomining-hub
[ -d "$APP" ] || { echo "GoMining Hub isn't installed yet: run deploy/install.sh first."; exit 1; }

echo "== Updating app in $APP"
if command -v rsync >/dev/null; then
  rsync -a --delete --exclude node_modules --exclude .git --exclude 'data/history.json' --exclude '.env*' --exclude docs --exclude test "$SRC/" "$APP/"
else
  rm -rf "${APP:?}/src" "$APP/public" "$APP/deploy"
  cp -r "$SRC/src" "$SRC/public" "$SRC/deploy" "$SRC/package.json" "$SRC/package-lock.json" "$APP/"
  mkdir -p "$APP/data" && cp "$SRC/data/sample-snapshot.json" "$APP/data/"
fi
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$APP"
chmod -R go-w "$APP"

echo "== Restarting"
install -m 644 "$SRC/deploy/gomining-hub.service" /etc/systemd/system/gomining-hub.service
systemctl daemon-reload
systemctl restart gomining-hub
sleep 2
if curl -fsS -o /dev/null http://127.0.0.1:4173/api/market; then
  echo "== Done: dashboard updated and answering"
else
  echo "Service did not come back:"; journalctl -u gomining-hub -n 30 --no-pager; exit 1
fi
