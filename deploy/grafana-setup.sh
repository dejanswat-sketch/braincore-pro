#!/usr/bin/env bash
# Braincore Pro — Grafana na portu 3030 (NE DIRA port 3000 = nmq-server).
#
#   sudo bash deploy/grafana-setup.sh
#
# Šta radi:
#   1. instalira Grafana iz zvaničnog repoa
#   2. postavlja `http_port = 3030` (default 3000 je zauzet postojećim servisom!)
#   3. uključuje i pokreće servis, ispisuje šta dalje (dashboard JSON je u deploy/)
#
# Šta NE radi: ne dira nmq-server, oaa-trial, cloudflared, nginx (osim što ne mijenja ništa u njemu).
set -euo pipefail

log() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }
[ "$(id -u)" = "0" ] || { echo "Pokreni kao root (sudo)"; exit 1; }

PORT="${GRAFANA_PORT:-3030}"
if ss -lntp 2>/dev/null | grep -q ":${PORT}\b"; then
  echo "Port ${PORT} je već zauzet — postavi GRAFANA_PORT=<drugi> i pokreni ponovo."; exit 1
fi
if ss -lntp 2>/dev/null | grep -q ":3000\b"; then
  log "Napomena: port 3000 je zauzet (nmq-server) — zato Grafana ide na ${PORT}"
fi

log "1/4 Repo i instalacija"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y apt-transport-https software-properties-common wget gnupg
mkdir -p /etc/apt/keyrings
wget -q -O /etc/apt/keyrings/grafana.asc https://apt.grafana.com/gpg.key
chmod 644 /etc/apt/keyrings/grafana.asc
echo "deb [signed-by=/etc/apt/keyrings/grafana.asc] https://apt.grafana.com stable main" > /etc/apt/sources.list.d/grafana.list
apt-get update -y
apt-get install -y grafana

log "2/4 Port ${PORT}"
if ! grep -q "^http_port = ${PORT}" /etc/grafana/grafana.ini; then
  sed -i "s/^;*http_port = .*/http_port = ${PORT}/" /etc/grafana/grafana.ini
  grep -q "^http_port" /etc/grafana/grafana.ini || sed -i "/^\[server\]/a http_port = ${PORT}" /etc/grafana/grafana.ini
fi
grep -m1 "^http_port" /etc/grafana/grafana.ini

log "3/4 Servis"
systemctl daemon-reload
systemctl enable --now grafana-server
sleep 3
systemctl is-active grafana-server

log "4/4 Provjera"
curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" && echo

cat <<NEXT

Grafana je na http://127.0.0.1:${PORT} (login admin/admin — OBAVEZNO promijeni odmah).
Do nje sa interneta: nginx reverse proxy (npr. metrics.braincore.pro) ili SSH tunel:
  ssh -L ${PORT}:127.0.0.1:${PORT} root@<HETZNER_IP>   →  http://127.0.0.1:${PORT}

Dashboard: deploy/grafana-dashboard.json → Dashboards → New → Import → Upload JSON.
Izvor podataka: Prometheus (scrape http://127.0.0.1:8081/metrics?format=prom svakih 15 s)
ILI istorija koju već imaš: data/_control/metrics-history.jsonl (13 metrika, ~20 h).
NEXT