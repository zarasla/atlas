#!/usr/bin/env bash
# Puts GoMining Hub on a domain that an older website currently uses, removing that old site.
# Usage on the VPS:  sudo bash deploy/switch-domain.sh example.com [--rotate-key]
#
# What it does:
#   1. Finds nginx sites (other than gomining-hub) that mention the domain.
#   2. Backs them up, plus their web roots under /var/www, to /root/old-site-backup-<time>.tar.gz.
#   3. Removes those sites and web roots, points gomining-hub at the domain (and www. if it resolves),
#      and gets HTTPS with certbot.
#   4. With --rotate-key, replaces the MCP access key and prints the new connector URL.
#
# Hard limits: it only reloads nginx and restarts gomining-hub. It never stops, edits or deletes
# any other service, and never deletes anything outside /etc/nginx and /var/www (so bots and apps
# under /opt are never touched). If the nginx config test fails, everything is restored.
set -euo pipefail

DOMAIN="${1:-}"
ROTATE=0
[ "${2:-}" = "--rotate-key" ] && ROTATE=1
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Usage: sudo bash deploy/switch-domain.sh <domain> [--rotate-key]"; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root."; exit 1; }

NGINX="${NGINX_DIR:-/etc/nginx}"
ENV_FILE="${ENV_FILE:-/etc/gomining-hub.env}"
OURS="$NGINX/sites-available/gomining-hub"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${BACKUP_DIR:-/root}/old-site-backup-$STAMP.tar.gz"
[ -f "$OURS" ] || { echo "GoMining Hub isn't installed yet: run deploy/install.sh first."; exit 1; }
DOMAIN_RE="${DOMAIN//./\\.}"

echo "== Old sites for $DOMAIN"
mapfile -t OLD < <(
  for f in "$NGINX"/sites-enabled/* "$NGINX"/sites-available/* "$NGINX"/conf.d/*.conf; do
    [ -e "$f" ] || continue
    real="$(readlink -f "$f")"
    [ "$real" = "$(readlink -f "$OURS")" ] && continue
    grep -qE "server_name[^;]*\\b(www\\.)?$DOMAIN_RE\\b" "$real" && echo "$f"
  done | sort -u
)
if [ "${#OLD[@]}" -eq 0 ]; then echo "none found"; else printf '  %s\n' "${OLD[@]}"; fi

# Refuse to delete a config file that also serves some other domain: that site must keep working.
for f in "${OLD[@]}"; do
  others="$(grep -oE 'server_name[^;]*' "$(readlink -f "$f")" | sed 's/server_name//' | tr ' ' '\n' \
    | grep -v '^$' | grep -vxE "(www\\.)?$DOMAIN_RE|_|localhost|default_server" || true)"
  if [ -n "$others" ]; then
    echo "STOP: $f also serves other names:"; echo "$others" | sed 's/^/    /'
    echo "Nothing was changed. Send this output to Claude to split that file safely."
    exit 1
  fi
done

# Web roots of the old sites, only under /var/www and only if no remaining site still uses them.
ROOTS=()
for f in "${OLD[@]}"; do
  while read -r root; do
    root="${root%/}"
    case "$root" in /var/www/?*) ;; *) continue ;; esac
    used=0
    for other in "$NGINX"/sites-enabled/* "$NGINX"/conf.d/*.conf; do
      [ -e "$other" ] || continue
      skip=0; for o in "${OLD[@]}"; do [ "$(readlink -f "$other")" = "$(readlink -f "$o")" ] && skip=1; done
      [ "$skip" = 1 ] && continue
      grep -q "root[[:space:]]\\+$root" "$(readlink -f "$other")" && used=1
    done
    [ "$used" = 0 ] && [ -d "$root" ] && ROOTS+=("$root")
  done < <(grep -oE '^[[:space:]]*root[[:space:]]+[^;]+' "$(readlink -f "$f")" | awk '{print $2}')
done
mapfile -t ROOTS < <(printf '%s\n' "${ROOTS[@]}" | sort -u | grep -v '^$' || true)
[ "${#ROOTS[@]}" -gt 0 ] && { echo "== Old web files"; printf '  %s\n' "${ROOTS[@]}"; }

echo "== Backup -> $BACKUP"
ITEMS=("$OURS")
for f in "${OLD[@]}"; do ITEMS+=("$f" "$(readlink -f "$f")"); done
ITEMS+=("${ROOTS[@]}")
mapfile -t ITEMS < <(printf '%s\n' "${ITEMS[@]}" | grep -v '^$' | sort -u)
# The backup must succeed before anything is removed (set -e stops the script otherwise).
tar -czf "$BACKUP" --absolute-names "${ITEMS[@]}"
chmod 600 "$BACKUP"
STAGE="$(mktemp -d)"
cp -a "$OURS" "$STAGE/gomining-hub"
for f in "${OLD[@]}"; do cp -a --parents "$f" "$STAGE/" 2>/dev/null || true; done

restore() {
  echo "nginx config test failed: restoring the previous setup, nothing reloaded."
  cp -a "$STAGE/gomining-hub" "$OURS"
  (cd "$STAGE" && find . -path ./gomining-hub -prune -o -type f -print -o -type l -print | while read -r p; do cp -a "$STAGE/$p" "/${p#./}"; done)
  exit 1
}

echo "== Removing old site config"
for f in "${OLD[@]}"; do rm -f "$f"; done
# Drop dangling links left in sites-enabled.
find "$NGINX/sites-enabled" -xtype l -delete 2>/dev/null || true

NAMES="$DOMAIN"
getent hosts "www.$DOMAIN" >/dev/null 2>&1 && NAMES="$DOMAIN www.$DOMAIN"
echo "== GoMining Hub now answers for: $NAMES"
sed -i -E "s/^([[:space:]]*server_name)[[:space:]]+[^;]*;/\\1 $NAMES;/" "$OURS"
ln -sf "$OURS" "$NGINX/sites-enabled/gomining-hub"
nginx -t || restore
systemctl reload nginx

if [ "${#ROOTS[@]}" -gt 0 ]; then echo "== Deleting old web files"; for r in "${ROOTS[@]}"; do rm -rf -- "$r"; done; fi
rm -rf "$STAGE"

echo "== HTTPS"
CERT_ARGS=(-d "$DOMAIN"); [ "$NAMES" != "$DOMAIN" ] && CERT_ARGS+=(-d "www.$DOMAIN")
certbot --nginx "${CERT_ARGS[@]}" --non-interactive --agree-tos --register-unsafely-without-email --redirect --expand \
  || echo "certbot failed: check that $DOMAIN points to this server (Cloudflare: grey cloud / DNS only), then re-run this script."

if [ "$ROTATE" = 1 ]; then
  sed -i '/^MCP_ACCESS_KEY=/d' "$ENV_FILE"
  echo "MCP_ACCESS_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  systemctl restart gomining-hub
  echo "== New MCP access key generated (the old connector URL no longer works)"
fi

KEY="$(grep '^MCP_ACCESS_KEY=' "$ENV_FILE" | cut -d= -f2)"
echo
echo "== Done"
echo "Dashboard:  https://$DOMAIN"
echo "Claude connector URL (secret, don't share it):"
echo "  https://$DOMAIN/mcp/$KEY"
echo "Backup of the old site: $BACKUP"
