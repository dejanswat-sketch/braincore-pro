#!/usr/bin/env bash
# Braincore Pro — BENCH na pravom hostu (Hetzner). Mjeri granicu jednog hosta.
#
#   sudo bash deploy/bench-remote.sh                 # 1/3/10/25 čvorova × 15 s
#   sudo bash deploy/bench-remote.sh 1,3 10          # samo 1 i 3 čvora, 10 s svaki
#
# Zašto preko skripte: bench diže N čvorova u JEDNOM procesu na portovima 8801+ (UDP/TCP), pa ne dira
# produkcijske servise (8001-8003, 8081). Skripta koristi privremeni NMQ_DATA_DIR i gasi sve na kraju.
set -euo pipefail

APP="${APP_DIR:-/opt/braincore/current}"
NODES="${1:-1,3,10,25}"
SECONDS_PER="${2:-15}"
RATE="${RATE:-40}"
DELAY="${DELAY:-60}"
BASE_PORT="${BASE_PORT:-8851}"

log() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }

log "0/3 Provjera prije bencha (da ne diramo produkciju)"
for p in 8001 8002 8003 8081; do
  ss -lntp 2>/dev/null | grep -q ":${p}\b" && echo "  ✔ produkcijski port ${p} aktivan (bench ga ne koristi)"
done
if ss -lntu 2>/dev/null | grep -q ":${BASE_PORT}\b"; then
  echo "Port ${BASE_PORT} je zauzet — postavi BASE_PORT=<drugi> i pokreni ponovo."; exit 1
fi
command -v node >/dev/null || { echo "nema node"; exit 1; }
node -v

log "1/3 Podaci i okruženje (privremeni data dir, bez uticaja na /opt/braincore/data)"
TMP_DATA="$(mktemp -d /tmp/braincore-bench-XXXX)"
export NMQ_DATA_DIR="$TMP_DATA"
export NMQ_CLUSTER_SECRET="${NMQ_CLUSTER_SECRET:-bench-host-secret-1234567890}"
echo "  data: $TMP_DATA"

log "2/3 Bench (${NODES} čvorova, ${SECONDS_PER}s po konfiguraciji, cilj ${RATE} t/s)"
cd "$APP"
CPU0=$(awk '{print $1+$2}' /proc/uptime)
node scripts/bench.mjs --nodes="$NODES" --seconds="$SECONDS_PER" --rate="$RATE" --delay="$DELAY" --base-port="$BASE_PORT" 2>&1 | tee /tmp/braincore-bench.log
CPU1=$(awk '{print $1+$2}' /proc/uptime)

log "3/3 Rezime hosta"
echo "  /proc/uptime delta: $(awk -v a="$CPU0" -v b="$CPU1" 'BEGIN{printf "%.1f", b-a}') s (gruba mjera zauzetosti hosta)"
echo "  load average: $(awk '{print $1, $2, $3}' /proc/loadavg)"
echo "  memorija: $(free -m | awk '/Mem:/ {print $3" MB iskorišteno od "$2" MB"}')"
echo "  JSON:  docs/bench-*.json (u $APP/docs)"
echo "  tabela: docs/43-BENCHMARK.md"
echo "  log:   /tmp/braincore-bench.log"

rm -rf "$TMP_DATA"
cat <<'NEXT'

SLJEDEĆE: brojeve iz docs/43-BENCHMARK.md prepisati u case study na sajtu kao
"1 host = X task/s, 3 hosta = Y", i to samo ako je p95 u budžetu.
NEXT
