# NMQ Robot na Kubernetes-u

> Zašto K8s: per-tenant izolacija (namespace, kvote, mreža), sigurnosni kontekst (read-only FS, bez
> privilegija), horizontalno skaliranje i standardni način dostave za enterprise klijente.
> **Aplikativni sandbox (`src/core/sandbox.js`) i K8s izolacija su dva različita sloja — oba trebaju.**

## Redoslijed primjene

```bash
# 0) image
docker build -f infra/Dockerfile -t nmq-robot:0.2.0 .

# 1) namespace, kvote i sigurnosni okvir
kubectl apply -f infra/k8s/base/namespace.yaml

# 2) tajne (NIKAD iz git-a) — vidi secret.example.yaml
kubectl -n nmq-system create secret generic nmq-robot-secrets \
  --from-literal=NMQ_LLM_API_KEY="$(node ~/.dsh/NMQ/get-key.mjs DEEPSEEK_API_KEY)" \
  --from-literal=NMQ_MASTER_KEY="$(openssl rand -hex 32)" \
  --from-literal=NMQ_API_KEY_PEPPER="$(openssl rand -hex 16)"

# 3) konfiguracija, RBAC i mreža
kubectl apply -f infra/k8s/base/configmap.yaml
kubectl apply -f infra/k8s/base/rbac.yaml
kubectl apply -f infra/k8s/base/networkpolicy.yaml

# 4) aplikacija
kubectl apply -f infra/k8s/base/deployment.yaml
kubectl apply -f infra/k8s/base/service.yaml
kubectl apply -f infra/k8s/base/hpa.yaml

# 5) provjera
kubectl -n nmq-system rollout status deploy/nmq-robot
kubectl -n nmq-system port-forward svc/nmq-robot 8787:80
curl -s localhost:8787/healthz && curl -s localhost:8787/readyz
```

## Izolacija po klijentu

```bash
./infra/k8s/tenant-template/provision-tenant.sh demo-shop
```

Skripta pravi namespace `nmq-<tenant>` sa:
- `ResourceQuota` i `LimitRange` (klijent ne može pojesti klaster),
- `NetworkPolicy` default-deny (samo platforma smije unutra),
- `Role`/`RoleBinding` samo za čitanje (kontrolna ravan vidi stanje, ne mijenja tuđe),
- opciono sopstveni Deployment + PVC (fizička izolacija kad klijent to traži).

## Dva režima rada

| Režim | Kako | Kada |
|---|---|---|
| **SaaS (dijeljeni proces)** | Jedan `nmq-robot` Deployment, tenant se dokazuje API ključem, podaci razdvojeni po `data/tenants/<id>/` i vektorskim filterom | Starter/Pro paket, do ~50 klijenata na 2-4 replike |
| **Izolovan proces (per-tenant)** | Sopstveni Deployment u `nmq-<tenant>` namespace-u, `NMQ_DEFAULT_TENANT=<tenant>`, `NMQ_ALLOW_ANONYMOUS=0` | Enterprise, klijent sa strogim zahtjevima ili on-prem |

## Skaliranje i scheduler (bitno)

Scheduler (persistentni agenti) koristi **fajl-lease**, ne distributed lock. Zato:

- `replicas: 1` je bezbjedno sa schedulerom u API podu.
- Ako ideš na više replika: `NMQ_SCHEDULER=0` u API-ju + `kubectl apply -f infra/k8s/base/deployment-scheduler.yaml` (1 replika).
- Za v1 (više replika scheduler-a): Postgres advisory lock ili Redis lock — vidi `docs/14` §7.

## Sigurnosni kontekst (šta je već u manifestima)

- `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `capabilities: drop: ALL`
- `seccompProfile: RuntimeDefault`, `automountServiceAccountToken: false`
- `NetworkPolicy`: default-deny, egress samo DNS + HTTPS (bez cloud metadata servisa), DB portovi eksplicitno
- `PodSecurity: restricted` na namespace-u
- Tajne kroz `Secret`/External Secrets — nikad u ConfigMap ili git

## Observability

- `infra/observability/otel-collector-config.yaml` — prima OTLP ili čita `data/_global/otel-traces.jsonl`
- `infra/observability/alerts.yml` — Prometheus pravila
- `infra/observability/grafana-dashboard.json` — operativni dashboard

## Ograničenja (iskreno)

- Nema K8s operatora (nema CRD `Agent`/`Tenant`) — provisioning je skripta.
- Nema service mesh, nema mTLS između podova.
- Scheduler nije visoko dostupan dok se ne uvede distributed lock.
- Migracije na Postgres (faza 6 u `docs/19`) još nisu odrađene — trenutno je PV sa JSONL fajlovima.
