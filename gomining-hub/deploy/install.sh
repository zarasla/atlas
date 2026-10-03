#!/usr/bin/env bash
# Installs or updates GoMining Hub on a Debian/Ubuntu VPS behind your existing web server.
# Run from the gomining-hub folder on the VPS:  sudo bash deploy/install.sh hub.gooses.online
#
# What it does, and nothing else:
#   - creates a locked system user `gominghub` (no shell, no login)
#   - copies the app to /opt/gomining-hub and installs production dependencies
#   - installs and starts the gomining-hub systemd service on 127.0.0.1:4173 (not exposed)
#   - adds one site for your domain to Caddy or nginx, whichever is already running
# It never stops, edits or restarts other sites or services (e.g. the Goose Discord bot);
# the web server is only reloaded after its config test passes.
set -euo pipefail

DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "Usage: sudo bash deploy/install.sh <domain>   e.g. hub.gooses.online"; exit 1; }
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid domain: $DOMAIN"; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/gomining-hub

command -v node >/dev/null || { echo "Node.js 20+ is required: https://nodejs.org/en/download (or: curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs)"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node.js 20+ is required, found $(node -v)"; exit 1; }

echo "== User"
id gominghub >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin gominghub

echo "== App -> $APP"
mkdir -p "$APP"
# Only the files the app needs. No .git, no local history, no env files.
if command -v rsync >/dev/null; then
  rsync -a --delete --exclude node_modules --exclude .git --exclude 'data/history.json' --exclude '.env*' --exclude docs --exclude test "$SRC/" "$APP/"
else
  rm -rf "${APP:?}/src" "$APP/public" "$APP/data" "$APP/deploy"
  cp -r "$SRC/src" "$SRC/public" "$SRC/deploy" "$SRC/package.json" "$SRC/package-lock.json" "$APP/"
  mkdir -p "$APP/data" && cp "$SRC/data/sample-snapshot.json" "$APP/data/"
fi
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund)
chown -R root:root "$APP"
chmod -R go-w "$APP"

echo "== Service"
install -m 644 "$SRC/deploy/gomining-hub.service" /etc/systemd/system/gomining-hub.service
systemctl daemon-reload
systemctl enable --now gomining-hub
systemctl restart gomining-hub
sleep 2
curl -fsS -o /dev/null http://127.0.0.1:4173/api/market && echo "dashboard answering on 127.0.0.1:4173" || { echo "Service did not start:"; journalctl -u gomining-hub -n 30 --no-pager; exit 1; }

echo "== Web server"
if systemctl is-active --quiet caddy; then
  mkdir -p /etc/caddy/sites
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
  BACKUP="$(ls -t /etc/caddy/Caddyfile.bak.* | head -1)"
  sed "s/__DOMAIN__/$DOMAIN/" "$SRC/deploy/Caddyfile.example" > /etc/caddy/sites/gomining-hub.caddy
  grep -q 'import sites/\*' /etc/caddy/Caddyfile || printf '\nimport sites/*\n' >> /etc/caddy/Caddyfile
  if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    systemctl reload caddy
  else
    echo "Caddy config test failed: restoring the previous config, nothing reloaded."
    cp "$BACKUP" /etc/caddy/Caddyfile; rm -f /etc/caddy/sites/gomining-hub.caddy; exit 1
  fi
  echo "Caddy will fetch the HTTPS certificate for $DOMAIN on first request."
elif systemctl is-active --quiet nginx; then
  sed "s/__DOMAIN__/$DOMAIN/" "$SRC/deploy/nginx.conf.example" > /etc/nginx/sites-available/gomining-hub
  ln -sf /etc/nginx/sites-available/gomining-hub /etc/nginx/sites-enabled/gomining-hub
  if nginx -t; then
    systemctl reload nginx
  else
    echo "nginx config test failed: removing the new site, nothing reloaded."
    rm -f /etc/nginx/sites-enabled/gomining-hub /etc/nginx/sites-available/gomining-hub; exit 1
  fi
  if command -v certbot >/dev/null; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || echo "certbot failed: check that $DOMAIN points to this server, then run: certbot --nginx -d $DOMAIN"
  else
    echo "Install certbot for HTTPS: apt-get install -y certbot python3-certbot-nginx && certbot --nginx -d $DOMAIN"
  fi
else
  echo "No Caddy or nginx running. Easiest: apt-get install -y caddy, then re-run this script."
  echo "The dashboard is running locally on 127.0.0.1:4173 in the meantime (not reachable from outside)."
fi

echo "== Done: https://$DOMAIN"
