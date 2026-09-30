#!/usr/bin/env bash
# Provisioninga izolovan namespace za jednog klijenta (tenanta).
#
#   ./provision-tenant.sh demo-shop
#
# Radi tri stvari:
#   1) pravi K8s namespace sa kvotama i mrežnom izolacijom (iz tenant-template)
#   2) pravi tenant zapis u robotovoj konfiguraciji (config/tenants.json) — ako ne postoji
#   3) ispisuje API ključ koji klijent dobija (prikazuje se samo jednom)
set -euo pipefail

TENANT="${1:-}"
if [[ -z "$TENANT" ]]; then
  echo "Upotreba: $0 <tenant-id>   (npr. demo-shop)" >&2
  exit 1
fi
if [[ ! "$TENANT" =~ ^[a-z0-9][a-z0-9_-]{1,31}$ ]]; then
  echo "Neispravan tenant id (dozvoljeno: mala slova, brojevi, - i _, 2-32 znaka)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
K8S_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> 1/3 K8s namespace: nmq-$TENANT"
sed "s/TENANT/$TENANT/g" "$K8S_DIR/tenant-template/tenant.yaml" | kubectl apply -f -

echo "==> 2/3 provjera tenant-a u config/tenants.json"
if grep -q "\"id\": \"$TENANT\"" "$ROOT/config/tenants.json"; then
  echo "    tenant već postoji u konfiguraciji"
else
  echo "    ⚠️  tenant NIJE u config/tenants.json — dodaj ga (id, name, plan, budget) i restartuj robota"
  echo "    primjer:"
  cat <<JSON
    {
      "id": "$TENANT",
      "name": "Klijent $TENANT",
      "plan": "pro",
      "locale": "sr",
      "timezone": "Europe/Belgrade",
      "apiKeys": [],
      "budget": { "monthlyUsd": 50, "runUsd": 0.5 },
      "agentBudgets": { "support": 10 },
      "rateLimitPerMin": 60,
      "allowedAgents": ["router", "support", "ecommerce", "ops"]
    }
JSON
fi

echo "==> 3/3 API ključ za klijenta"
node "$ROOT/src/cli.js" keys "$TENANT" owner

echo ""
echo "Gotovo. Sljedeći koraci:"
echo "  1) dodaj tenant u config/tenants.json (ako već nije) i u config/policies.json"
echo "  2) ubaci KB klijenta:  curl -X POST https://robot.../v1/kb -d '{\"text\":\"...\",\"source\":\"...\"}'"
echo "  3) daj klijentu widget snippet sa data-tenant=\"$TENANT\" i data-key=\"<ključ>\""
