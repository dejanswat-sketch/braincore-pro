#!/usr/bin/env bash
# Braincore Pro — ALERT provjera (bez npm zavisnosti).
#
#   bash deploy/alertcheck.sh            # ispiše stanje i vrati 1 ako nešto ne valja
#   bash deploy/alertcheck.sh --quiet    # samo greške (za systemd timer / cron)
#
# Instalacija kao systemd timer (svakih 5 min):
#   install -m 755 deploy/alertcheck.sh /usr/local/bin/braincore-alertcheck
#   cat >/etc/systemd/system/braincore-alert.service <<'EOF'
#   [Unit]
#   Description=Braincore Pro alert check
#   [Service]
#   Type=oneshot
#   ExecStart=/usr/local/bin/braincore-alertcheck --quiet
#   EOF
#   cat >/etc/systemd/system/braincore-alert.timer <<'EOF'
#   [Unit]
#   Description=Braincore Pro alert check every 5 minutes
#   [Timer]
#   OnBootSec=2min
#   OnUnitActiveSec=5min
#   [Install]
#   WantedBy=timers.target
#   EOF
#   systemctl enable --now braincore-alert.timer
#
# Šta gleda (pragovi se mogu prekucati env varijablama):
#   PEERS_MIN      — koliko peer-ova mora biti živo (default 1)
#   QUEUE_MAX      — preko ovoga red je pred odbacivanjem (default 450)
#   REJECT_RATE    — koliko odbijenih potpisa u 5 min je sumnjivo (default 0)
#   WEBHOOK        — ako je postavljen, šalje JSON na taj URL (npr. Slack/Discord webhook)
set -uo pipefail

API="${API:-http://127.0.0.1:8081}"
PEERS_MIN="${PEERS_MIN:-1}"
QUEUE_MAX="${QUEUE_MAX:-450}"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

say() { [ "$QUIET" = "0" ] && echo "$*"; return 0; }
fail() { echo "ALERT: $*" >&2; FAILED=1; }
FAILED=0

# 1) da li API uopšte odgovara
STATUS_JSON="$(curl -fsS --max-time 5 "$API/status" 2>/dev/null)" || { fail "API ne odgovara na $API/status"; STATUS_JSON=""; }

if [ -n "$STATUS_JSON" ]; then
  # brojevi iz JSON-a bez jq (jq nije obavezan)
  num() { printf '%s' "$STATUS_JSON" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*[0-9]*" | head -1 | grep -o '[0-9]*$'; }
  PEERS="$(num peersAlive)"; SWARM="$(num swarmTasksDone)"; TASKS="$(num tasksKnown)"
  say "peersAlive=$PEERS swarmTasksDone=$SWARM tasksKnown=$TASKS"
  [ "${PEERS:-0}" -lt "$PEERS_MIN" ] && fail "peersAlive=$PEERS < $PEERS_MIN (čvor je sam ili je mreža pukla)"
fi

# 2) Prometheus metrike (rate limit, odbijeni potpisi, red, tombstone-i)
PROM="$(curl -fsS --max-time 5 "$API/metrics?format=prom" 2>/dev/null)" || PROM=""
if [ -n "$PROM" ]; then
  val() { printf '%s' "$PROM" | grep -E "^$1 " | head -1 | awk '{print $2}'; }
  QUEUE="$(val braincore_queue_depth)"; REJ="$(val braincore_gossip_rejected_total)"; ENABLED="$(val braincore_live_clients)"
  say "queue=$QUEUE rejected_total=$REJ live_clients=$ENABLED"
  [ -n "${QUEUE:-}" ] && [ "${QUEUE%.*}" -gt "$QUEUE_MAX" ] && fail "queue_depth=$QUEUE > $QUEUE_MAX (klijenti će dobijati 429)"
  if [ -n "${REJ:-}" ] && [ "${REJ%.*}" -gt 0 ]; then
    fail "gossip_rejected_total=$REJ > 0 — neko potpisuje pogrešnim ključem (NMQ_CLUSTER_SECRET / _PREV)"
  fi
else
  say "(Prometheus format nije dostupan — preskačem metričke provjere)"
fi

# 3) systemd jedinice
for unit in braincore-api braincore-node@8002 braincore-node@8003; do
  if command -v systemctl >/dev/null 2>&1; then
    if ! systemctl is-active --quiet "$unit"; then
      # node@8002/8003 možda nisu instalirani na single-node setupu — samo API je obavezan
      [ "$unit" = "braincore-api" ] && fail "$unit nije aktivan"
    fi
  fi
done
say "systemd: provjereno"

if [ "$FAILED" = "1" ]; then
  if [ -n "${WEBHOOK:-}" ]; then
    curl -fsS --max-time 5 -X POST -H 'content-type: application/json' \
      -d "{\"text\":\"Braincore Pro ALERT: provjeri /var/log i journalctl -u braincore-api\"}" "$WEBHOOK" >/dev/null 2>&1 || true
  fi
  exit 1
fi
[ "$QUIET" = "0" ] && echo "OK: sve provjere prošle"
exit 0
