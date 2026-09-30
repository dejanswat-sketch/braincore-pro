#!/usr/bin/env bash
# Braincore Pro — RELEASE i ROLLBACK bez npm zavisnosti.
#
#   bash deploy/release.sh                 # iz trenutnog repoa pravi novu verziju u /opt/braincore/releases/<tag>
#   bash deploy/release.sh --tag=v1.4.0
#   bash deploy/rollback.sh                # vraća symlink `current` na prethodnu verziju i restartuje servise
#
# Model: kod živi u /opt/braincore/releases/<verzija>, a /opt/braincore/current je symlink.
# `data/` je IZVAN releases (u /opt/braincore/data) — verzije se mijenjaju, podaci ne.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/braincore}"
RELEASES="$APP_DIR/releases"
CURRENT="$APP_DIR/current"
SERVICES="${SERVICES:-braincore-api braincore-node@8002 braincore-node@8003}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }

TAG=""
for a in "$@"; do case "$a" in --tag=*) TAG="${a#--tag=}";; esac; done
if [ -z "$TAG" ]; then
  TAG="$(git -C "$REPO_DIR" describe --tags --always 2>/dev/null || date -u +%Y%m%d-%H%M%S)"
fi

[ -d "$APP_DIR" ] || { echo "Nema $APP_DIR — prvo pokreni deploy/install.sh"; exit 1; }
mkdir -p "$RELEASES" "$APP_DIR/data"

log "1/5 Backup podataka (obavezno prije release-a)"
if [ -d "$APP_DIR/data" ]; then
  tar czf "$APP_DIR/backup-data-$(date -u +%Y%m%d-%H%M%S).tgz" -C "$APP_DIR" data
  echo "backup: $APP_DIR/backup-data-*.tgz"
fi

log "2/5 Kopiranje koda u releases/$TAG"
DEST="$RELEASES/$TAG"
rm -rf "$DEST"
mkdir -p "$DEST"
rsync -a --exclude '.git' --exclude 'data' --exclude 'node_modules' --exclude 'dist' "$REPO_DIR"/ "$DEST"/
echo "verzija: $DEST"

log "3/5 Symlink current → releases/$TAG"
PREV="$(readlink -f "$CURRENT" 2>/dev/null || true)"
if [ -n "$PREV" ]; then echo "$PREV" > "$APP_DIR/.previous-release"; echo "prethodna: $PREV"; fi
ln -sfn "$DEST" "$CURRENT"
chown -R braincore:braincore "$DEST" "$APP_DIR/data" 2>/dev/null || true

log "4/5 Restart servisa"
for s in $SERVICES; do
  if systemctl cat "$s" >/dev/null 2>&1; then
    systemctl restart "$s" && echo "restartovano: $s"
  fi
done
sleep 3

log "5/5 Provjera poslije release-a"
if curl -fsS --max-time 5 http://127.0.0.1:8081/health >/dev/null; then
  echo "OK: API zdravi poslije release-a ($TAG)"
else
  echo "GREŠKA: API ne odgovara — pokreni deploy/rollback.sh" >&2
  exit 2
fi
