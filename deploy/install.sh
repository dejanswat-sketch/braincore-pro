#!/usr/bin/env bash
# Braincore Pro — Hetzner (Ubuntu 22.04/24.04) installer.
#
#   sudo bash deploy/install.sh
#
# What it does:
#   1. installs Node 20, nginx, certbot and Redis (runtime only — NEVER `npm install`)
#   2. creates the `braincore` system user and /opt/braincore
#   3. copies this repository, writes env templates, installs systemd units + nginx site
#   4. starts a 3-node swarm and prints the acceptance check
#
# It does not touch DNS (do that in Hostinger hPanel) and does not run certbot for you.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/braincore
CONF_DIR=/etc/braincore
SERVICE_USER=braincore

log() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }
need_root() { [ "$(id -u)" = "0" ] || { echo "Pokreni kao root (sudo)"; exit 1; }; }

need_root

log "1/6 Paketi (Node 20, nginx, certbot, Redis) — bez npm zavisnosti"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git rsync nginx redis-server certbot python3-certbot-nginx jq
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
echo "npm je namjerno NEPOTREBAN: projekat ima dependencies: {}"

log "2/6 Korisnik i folderi"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$APP_DIR" "$CONF_DIR" /var/log/braincore "$APP_DIR/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" /var/log/braincore

log "3/6 Kod"
rsync -a --delete --exclude '.git' --exclude 'data' --exclude 'node_modules' "$REPO_DIR"/ "$APP_DIR"/
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

log "4/6 Konfiguracija"
if [ ! -f "$CONF_DIR/braincore.env" ]; then
  cp "$APP_DIR/deploy/braincore.env.example" "$CONF_DIR/braincore.env"
  SECRET="$(openssl rand -hex 32)"
  sed -i "s|^NMQ_CLUSTER_SECRET=.*|NMQ_CLUSTER_SECRET=${SECRET}|" "$CONF_DIR/braincore.env"
  ADMIN="$(openssl rand -hex 24)"
  sed -i "s|^BRAINCORE_ADMIN_KEY=.*|BRAINCORE_ADMIN_KEY=${ADMIN}|" "$CONF_DIR/braincore.env"
  echo "Napisan $CONF_DIR/braincore.env (tajne generisane; NE commit-uj ovaj fajl)."
  echo "Admin ključ je u $CONF_DIR/braincore.env (polje BRAINCORE_ADMIN_KEY)."
else
  echo "$CONF_DIR/braincore.env već postoji — ne diram ga."
fi
chmod 600 "$CONF_DIR/braincore.env"
chown root:root "$CONF_DIR/braincore.env"

# Per-node settings
cat > "$CONF_DIR/node-8001.env" <<EOF
PORT=8001
PEERS=
EOF
cat > "$CONF_DIR/node-8002.env" <<EOF
PORT=8002
PEERS=127.0.0.1:8001
EOF
cat > "$CONF_DIR/node-8003.env" <<EOF
PORT=8003
PEERS=127.0.0.1:8001,127.0.0.1:8002
EOF
chmod 640 "$CONF_DIR"/node-*.env
chown root:$SERVICE_USER "$CONF_DIR"/node-*.env

log "5/6 systemd + nginx"
install -m 644 "$APP_DIR/deploy/braincore-node@.service" /etc/systemd/system/braincore-node@.service
install -m 644 "$APP_DIR/deploy/braincore-api.service" /etc/systemd/system/braincore-api.service
systemctl daemon-reload
systemctl enable --now braincore-node@8002 braincore-node@8003
systemctl enable --now braincore-api
install -m 644 "$APP_DIR/deploy/nginx-braincore.conf" /etc/nginx/sites-available/braincore
ln -sf /etc/nginx/sites-available/braincore /etc/nginx/sites-enabled/braincore
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

log "6/6 Prijemni test (acceptance)"
sleep 5
echo "--- API (lokalno) ---"
curl -s http://127.0.0.1:8081/health | jq . || true
echo "--- Swarm status ---"
curl -s http://127.0.0.1:8081/status | jq '{nodeId, port, peersAlive, alive, tasksDone}' || true
echo "--- Task u node 1, izvršava ga najslobodniji node ---"
curl -s -X POST http://127.0.0.1:8081/task \
  -H 'content-type: application/json' \
  -d '{"type":"support.ticket","payload":{"text":"acceptance check"},"value":10}' | jq . || true
sleep 3
curl -s http://127.0.0.1:8081/tasks | jq '.done | length' || true

cat <<'NEXT'

== SLJEDEĆI KORACI (ručno) ==
1. Hostinger hPanel → DNS:
     @     A   <HOSTINGER IP>
     www   A   <HOSTINGER IP>
     api   A   <HETZNER IP>
     live  A   <HETZNER IP>
   Uključi SSL za braincore.pro / www.
2. Na Hetzneru: certbot --nginx -d api.braincore.pro -d live.braincore.pro
3. Upload site/ na Hostinger (File Manager → public_html) i zamijeni
   REPLACE_WITH_YOUR_PAYMENT_LINK svojim Stripe Payment Linkom.
4. U Stripe dashboardu dodaj webhook: https://api.braincore.pro/v1/stripe/webhook
   (događaj checkout.session.completed) i upiši STRIPE_WEBHOOK_SECRET u
   /etc/braincore/braincore.env, pa: systemctl restart braincore-api
5. Provjeri: https://live.braincore.pro (3 node-a), https://api.braincore.pro/health
NEXT
