#!/usr/bin/env bash
# Braincore Pro — ROLLBACK na prethodnu verziju (jedna komanda, mjeri se u sekundama).
#
#   bash deploy/rollback.sh                # na verziju iz /opt/braincore/.previous-release
#   bash deploy/rollback.sh v1.2.0         # na konkretnu verziju iz releases/
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/braincore}"
RELEASES="$APP_DIR/releases"
CURRENT="$APP_DIR/current"
SERVICES="${SERVICES:-braincore-api braincore-node@8002 braincore-node@8003}"

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  TARGET="$(cat "$APP_DIR/.previous-release" 2>/dev/null || true)"
  [ -n "$TARGET" ] || { echo "Nema .previous-release — navedi verziju: rollback.sh <tag>"; exit 1; }
elif [ -d "$RELEASES/$TARGET" ]; then
  TARGET="$RELEASES/$TARGET"
fi

[ -d "$TARGET" ] || { echo "Ne postoji: $TARGET"; ls -1 "$RELEASES" 2>/dev/null; exit 1; }

START=$(date +%s)
echo "Rollback: $(readlink -f "$CURRENT") → $TARGET"
CUR="$(readlink -f "$CURRENT" 2>/dev/null || true)"
[ -n "$CUR" ] && echo "$CUR" > "$APP_DIR/.previous-release.next"
ln -sfn "$TARGET" "$CURRENT"

for s in $SERVICES; do
  if systemctl cat "$s" >/dev/null 2>&1; then
    systemctl restart "$s" && echo "restartovano: $s"
  fi
done
sleep 3

TOOK=$(( $(date +%s) - START ))
if curl -fsS --max-time 5 http://127.0.0.1:8081/health >/dev/null; then
  echo "OK: rollback završen za ${TOOK}s (cilj < 60s)"
  [ -f "$APP_DIR/.previous-release.next" ] && mv "$APP_DIR/.previous-release.next" "$APP_DIR/.previous-release"
  exit 0
fi
echo "GREŠKA: API ne odgovara ni poslije rollback-a ( ${TOOK}s ) — provjeri journalctl -u braincore-api" >&2
exit 2
