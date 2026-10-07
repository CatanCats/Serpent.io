#!/usr/bin/env bash
# Deploy the Serpent.io game server to a small Debian box that runs Caddy + systemd.
# Nothing secret lives in this repository: the host and the SSH key come from the
# environment.
#
#   SERPENT_HOST=user@host      (required) SSH login with passwordless sudo
#   SERPENT_KEY=~/.ssh/key      (required) SSH private key file (kept outside the repo)
#   SERPENT_DOMAIN=...          public name for HTTPS; default <ip-with-dashes>.sslip.io
#   SERPENT_PORT=8010           loopback port for the game server (must be free)
#
# It builds a portable x86-64 binary here, copies it to /srv/apps/serpent/, installs
# the systemd unit, adds a site block to /etc/caddy/Caddyfile (validated before
# reloading; other sites are left alone) and checks /status locally and over HTTPS.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${SERPENT_HOST:?set SERPENT_HOST=user@host}" "${SERPENT_KEY:?set SERPENT_KEY=/path/to/private/key}"
PORT="${SERPENT_PORT:-8010}"
IP="${SERPENT_HOST#*@}"
DOMAIN="${SERPENT_DOMAIN:-${IP//./-}.sslip.io}"
SSH=(ssh -i "$SERPENT_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$SERPENT_HOST")

echo "== build (portable x86-64: the server's CPU may lack newer instructions)"
(cd online/server && SERPENT_PORTABLE=1 cargo build --release)
BIN=online/server/target/release/serpent-server

echo "== upload"
./build.sh >/dev/null   # the pages it also serves (https://<domain>/ connects to itself)
scp -i "$SERPENT_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$BIN" online/deploy/serpent.service index.html offline.html "$SERPENT_HOST":/tmp/

echo "== install on $IP (port $PORT, https://$DOMAIN)"
"${SSH[@]}" sudo PORT="$PORT" DOMAIN="$DOMAIN" bash -s <<'REMOTE'
set -euo pipefail
if ss -ltn | awk '{print $4}' | grep -q ":$PORT\$" && ! systemctl is-active --quiet serpent; then
  echo "port $PORT is taken by something else: pick another SERPENT_PORT"; exit 1; fi
id serpent >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin serpent
install -d -o root -g root /srv/apps/serpent
[ -f /srv/apps/serpent/serpent-server ] && cp /srv/apps/serpent/serpent-server /srv/apps/serpent/serpent-server.prev # for rollback
install -m 755 /tmp/serpent-server /srv/apps/serpent/serpent-server
install -m 644 /tmp/index.html /tmp/offline.html /srv/apps/serpent/
sed "s/^Environment=PORT=.*/Environment=PORT=$PORT BIND=127.0.0.1 BOTS=100 WEB_ROOT=\/srv\/apps\/serpent/" /tmp/serpent.service > /etc/systemd/system/serpent.service
systemctl daemon-reload && systemctl enable --quiet serpent && systemctl restart serpent
sleep 1; curl -fsS "http://127.0.0.1:$PORT/status"; echo
BAK="/etc/caddy/Caddyfile.bak.$(date +%s)"; cp /etc/caddy/Caddyfile "$BAK"
grep -q "^$DOMAIN {" /etc/caddy/Caddyfile ||
  printf '\n# Serpent.io game server (WebSocket at /ws)\n%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT" >> /etc/caddy/Caddyfile
if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then systemctl reload caddy
else cp "$BAK" /etc/caddy/Caddyfile; echo "Caddy config did not validate: restored the previous one"; exit 1; fi
free -m | head -2; journalctl -u serpent -n 3 --no-pager
REMOTE

echo "== check over HTTPS (the certificate can take a few seconds the first time)"
for i in 1 2 3 4 5 6; do curl -fsS "https://$DOMAIN/status" && echo && break || sleep 5; done
echo "Now rebuild the pages: SERVER_URL=wss://$DOMAIN/ws ./build.sh, then commit and push."
