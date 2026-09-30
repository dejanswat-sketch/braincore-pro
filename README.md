# NMQ Robot

**Univerzalni multi-tenant AI agent koji radi, a ne samo odgovara.**

Ugrađuje se kao JS widget u bilo koji sajt i kao REST/SSE API u bilo koji interni proces.
Sve sposobnosti dobija kroz **alate** (ugrađeni + MCP), **memoriju** (sesija + istorija + vektorska baza)
i **orchestraciju** (6 patterna). Svaka akcija je pod **politikom**, **budžetom** i **audit tragom**.

```
┌──────────────┐   ┌──────────────┐   ┌──────────────────────────────┐   ┌──────────────┐
│  Widget/SDK  │──▶│   Gateway    │──▶│        Orchestrator          │──▶│  Tool layer  │
│  REST + SSE  │   │ auth·rate    │   │ router · sequential ·        │   │ builtin (21) │
│  webhooks    │   │ tenant·CORS  │   │ orchestrator-worker · fanout │   │ MCP stdio    │
└──────────────┘   └──────────────┘   │ handoff · magentic           │   │ MCP http     │
                                      └───────────┬──────────────────┘   └──────┬───────┘
                                                  │                             │
                        ┌─────────────────────────┴───────────┐        ┌────────▼────────┐
                        │ Agenti (13) · Kritičar · Ruter      │        │ MCP serveri     │
                        │ definisani podacima (JSON)          │        │ (Gmail, Slack,  │
                        └─────────────────────────┬───────────┘        │  CRM, DB…)      │
                                                  │                    └─────────────────┘
        ┌─────────────────────────────────────────┴───────────────────────────────────────┐
        │ Memorija: sesija (JSONL) · istorija + facts · vektorska baza (RAG, po tenantu)   │
        │ Observability: trace/span · metrike · cost tracker · hash-chained audit          │
        │ Governance: allow/deny/require_approval · PII redakcija · budžet · rate limit    │
        └─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Brzi start (bez ijedne instalacije)

```bash
node --test                # 70 testova — bez mreže, bez npm install
node scripts/demo.mjs      # demo svih 6 patterna, izolacije tenanta i naplate
node scripts/serve.mjs     # gateway na http://127.0.0.1:8787  (+ demo stranica i widget)
node scripts/smoke.mjs     # 13 provjera protiv živog servera
```

Bez `NMQ_LLM_API_KEY` robot radi sa **mock LLM-om** — svi patterni, alati, memorija, politike i naplata
rade identično, samo bez pravog modela. Postavi ključ (DeepSeek) i isti kod radi produkcijski:

```bash
cp .env.example .env
# NMQ_LLM_API_KEY=<DEEPSEEK_API_KEY>   (ključ čitaj iz DSH store-a, nikad iz chata)
node scripts/serve.mjs
```

---

## Šta je unutra

| Sloj | Šta radi | Gdje |
|---|---|---|
| **Gateway** | REST + SSE streaming, webhook ulazi, CORS, auth, rate limit, `/metrics`, widget | `src/server/` |
| **Control plane** | Agent lifecycle (deploy/rollback/pause), verzije, per-agent ključevi i budžeti, audit | `src/controlplane/` |
| **Scheduler** | Persistentni agenti: `interval`/`cron`/`once`, event triggeri, dugoročni procesi sa checkpoint-om | `src/scheduler/` |
| **Orchestrator** | `agent`/`react`, `router`, `sequential`, `orchestrator-worker`, `fanout`, `handoff`, `magentic`, `reflection`, `debate`, `team` | `src/orchestration/` |
| **Agenti** | 19 agenata definisanih **podacima** (JSON) — uključujući specijalistički tim: planner, researcher, extractor, validator, decider, executor, reflector | `config/agents/` |
| **Alati** | 20 ugrađenih alata (CRM, fakture, mejl, KB, izvještaji, narudžbine, ticketi, proces, epizode…) | `src/tools/builtin.js` |
| **MCP** | Vlastiti JSON-RPC 2.0 klijent: `stdio` + Streamable HTTP; šablon internog servera | `src/tools/mcp-*.js`, `mcp/` |
| **Memorija** | Sesija, istorija/facts, **epizodična memorija** (učenje iz prošlih slučajeva), vektorska baza sa citatima | `src/memory/` |
| **Observability** | Trace/span, Prometheus metrike, cost tracker, hash-chained audit, **OTLP izvoz** | `src/observability/` |
| **Governance** | `allow / deny / require_approval`, budžet (run/tenant/agent), PII redakcija, human-in-the-loop | `src/core/policy.js`, `config/policies.json` |
| **Sandbox** | Mrežni allowlist, FS korijeni, očišćen env za MCP podprocese, limiti | `src/core/sandbox.js` |
| **Autonomija** | Nivoi **L0–L4** po tenantu i agentu; `high` rizik i novac/pravo/brisanje uvijek traže čovjeka | `src/core/autonomy.js`, `config/autonomy.json` |
| **Ciljevi** | Cilj → podciljevi → plan → KPI → mjerenje → **replan**; plan se pretvara u persistentne poslove | `src/goals/manager.js` |
| **Proaktivnost** | Watcheri: metrika, cilj, nagrada, događaj ili raspored → predlog u inbox ili samostalna akcija | `src/goals/watchers.js`, `config/watchers.json` |
| **Self-improvement** | Reward model → prijedlozi (prompt/politika/KB/pattern) → odobrenje → primjena → mjerenje → rollback; **A/B po run-u** | `src/learning/` |
| **Self-play i RSI** | Agent sam sebi pravi scenarije, rješava ih i ocjenjuje; analiza sopstvenih grešaka daje prijedloge | `src/learning/selfplay.js`, `rsi.js` |
| **AI organizacija** | CEO/CRO/COO/CFO/CTO/CHRO/CSO sa KPI-jevima, budžetima i **pregovaranjem** (CFO vs CRO) | `src/org/company.js`, `config/company.json` |
| **A2A ekonomija** | Agent card, zadaci između agenata (+SSE), pregovaranje sa tvrdim granicama, interni settlement ledger | `src/a2a/` |
| **Tenancy** | Izolacija fizički + logički, API ključevi, AES-256-GCM tajne, kill switch | `src/tenancy/store.js` |

---

## Primjeri

**1. Widget na bilo kom sajtu (jedan red):**

```html
<script src="https://robot.vasa-domena.com/widget.js"
        data-tenant="demo-shop" data-agent="support" data-auto="1"
        data-color="#ff6a00" data-title="Podrška" defer></script>
```

**2. REST poziv:**

```bash
curl -X POST http://127.0.0.1:8787/v1/agents/support/run \
  -H "content-type: application/json" \
  -d '{"input":"Status narudžbine 1042?","tenantId":"demo-shop"}'
```

**3. Streaming (SSE) — tokeni, alati i odluke u toku rada:**

```bash
curl -N -X POST http://127.0.0.1:8787/v1/run/stream \
  -H "content-type: application/json" \
  -d '{"input":"Pripremi ponudu za Prima d.o.o.","agentId":"sales"}'
```

**4. Webhook iz spoljnog sistema (mejl, Shopify, GitHub, Stripe…):**

```bash
curl -X POST http://127.0.0.1:8787/v1/hooks/shopify \
  -H "content-type: application/json" -H "x-tenant: nmq" \
  -d '{"subject":"Narudžbina 1042 kasni","body":"Kupac pita gdje je paket."}'
```

**5. Human-in-the-loop za akcije visokog rizika:**

```bash
# run stane i vrati approvals[] — akcija se NE izvršava
curl -X POST .../v1/approvals/<runId> -d '{"approve":true,"approvedBy":"dejan"}'
```

**6. Iz koda (bez HTTP-a):**

```js
import { createRobot } from './src/index.js';
const robot = await createRobot({ root: import.meta.dirname });
const res = await robot.orchestrator.run({
  tenantId: 'nmq',
  pattern: 'fanout',
  agentId: 'legal',
  input: 'Pregledaj ugovor o održavanju',
});
console.log(res.output, res.costUsd, res.approvals);
```

**7. Persistentni agent (radi sam, bez korisnika):**

```bash
# dnevni izvještaj svaki dan u 08:00
curl -X POST localhost:8787/v1/admin/jobs -H "content-type: application/json" -d '{
  "name":"dnevni izvještaj","agentId":"data","pattern":"agent",
  "input":"Napravi dnevni izvještaj o prodaji","schedule":{"type":"cron","cron":"0 8 * * 1-5"}}'

# dugoročni proces: onboarding klijenta kroz 14 dana (pamti stanje i preživljava restart)
curl -X POST localhost:8787/v1/admin/processes -H "content-type: application/json" -d '{
  "name":"onboarding Prima","agentId":"ops","stepDelayMs":86400000,
  "steps":[{"id":"d1","name":"Kickoff","input":"Uradi kickoff"},
           {"id":"d3","name":"Pristupi","input":"Dodijeli pristupe"},
           {"id":"d7","name":"Obuka","input":"Zakazi obuku"},
           {"id":"d14","name":"Provjera","input":"Provjeri zadovoljstvo"}]}'
```

**8. Agent lifecycle (kontrolna ravan) — bez restarta:**

```bash
# deploy toplijeg tona za support agenta
curl -X POST localhost:8787/v1/admin/agents/support/deploy -d '{"patch":{"temperature":0.4},"note":"topliji ton"}'
# rollback na baseline iz config-a
curl -X POST localhost:8787/v1/admin/agents/support/rollback -d '{"version":0}'
# pauza agenta koji troši previše
curl -X POST localhost:8787/v1/admin/agents/sales/status -d '{"status":"paused","reason":"budžet"}'
# per-agent ključ (service account) sa opsezima
curl -X POST localhost:8787/v1/admin/agents/executor/keys -d '{"scopes":["crm:write"]}'
```

---

## Endpointi

| Metod | Putanja | Opis |
|---|---|---|
| GET | `/healthz` `/readyz` `/metrics` | liveness, spremnost, Prometheus metrike |
| GET | `/v1/config` `/v1/agents` `/v1/agents/:id` `/v1/tools` `/v1/patterns` `/v1/mcp` | katalog (bez tajni) |
| POST | `/v1/run` `/v1/agents/:id/run` `/v1/router/run` | izvršavanje |
| POST | `/v1/run/stream` `/v1/agents/:id/stream` | SSE streaming |
| GET | `/v1/runs` `/v1/runs/:runId` | lista i detalj run-a (trace) |
| GET/POST | `/v1/approvals` `/v1/approvals/:runId` | odobrenja (human-in-the-loop) |
| POST | `/v1/kb` `/v1/kb/search` | baza znanja (RAG) |
| GET/POST | `/v1/memory/facts` `/v1/memory/history` | trajne činjenice i istorija |
| DELETE | `/v1/memory/user/:userId` | GDPR brisanje |
| POST | `/v1/hooks/:source` | ulaz iz spoljnih sistema |
| POST | `/v1/feedback` | ocjena odgovora (uči se iz nje) |
| GET | `/v1/usage` `/v1/audit` | naplata i hash-chained audit |
| GET/POST | `/v1/tenants/:id/secrets` | tajne integracija (AES-256-GCM) |
| GET | `/widget.js` `/` | embed widget i demo stranica |
| GET | `/v1/admin/health` `/v1/whoami` | stanje kontrolne ravni, scheduler-a, sandbox-a, OTel-a |
| GET/POST | `/v1/admin/agents` `/v1/admin/agents/:id/deploy` `/rollback` `/status` `/budget` | agent lifecycle (role: admin/owner) |
| POST/DELETE | `/v1/admin/agents/:id/keys/:keyId?` | per-agent ključevi (service account) |
| GET/POST | `/v1/admin/jobs` `/v1/admin/jobs/:id/run` `/pause` `/resume` `/runs` | persistentni poslovi |
| POST | `/v1/admin/processes` | dugoročni proces (koraci kroz dane) |
| GET/POST | `/v1/admin/episodes` | epizodična memorija (prošli slučajevi) |

---

## Dokumentacija

| Fajl | Sadržaj |
|---|---|
| [docs/DECISIONS.md](docs/DECISIONS.md) | **obavezujući tehnički ugovor** — čitaj prvo |
| [docs/00-VIZIJA.md](docs/00-VIZIJA.md) | šta robot jeste, šta je dodato preko osnovnog zahtjeva, roadmap |
| [docs/01-ARHITEKTURA.md](docs/01-ARHITEKTURA.md) | komponente, tokovi, multi-tenancy, donošenje odluka |
| [docs/02-TECH-STACK.md](docs/02-TECH-STACK.md) | stack po slojevima i zašto, migracioni put |
| [docs/03-MCP-INTEGRACIJE.md](docs/03-MCP-INTEGRACIJE.md) | katalog integracija u 3 talasa, auth, primjeri tokova |
| [docs/04-ORCHESTRACIJA.md](docs/04-ORCHESTRACIJA.md) | 6 patterna: kada, tok, pseudo-kod, trošak, testovi |
| [docs/05-MEMORIJA-RAG.md](docs/05-MEMORIJA-RAG.md) | tri sloja memorije, RAG pipeline, izolacija po tenantu |
| [docs/06-OBSERVABILITY-GOVERNANCE.md](docs/06-OBSERVABILITY-GOVERNANCE.md) | šta se loguje, metrike, naplata, politike, audit, alerti |
| [docs/07-MVP-PLAN.md](docs/07-MVP-PLAN.md) | plan 12 nedjelja po fazama, sa rizicima i ishodima |
| [docs/08-SECURITY-COMPLIANCE.md](docs/08-SECURITY-COMPLIANCE.md) | threat model, enkripcija, GDPR, put do SOC 2 (realno) |
| [docs/09-MONETIZACIJA.md](docs/09-MONETIZACIJA.md) | paketi, jedinična ekonomija, GTM 90 dana |
| [docs/10-RIZICI.md](docs/10-RIZICI.md) | tehnički, poslovni i rizici izgradnje + mitigacije |
| [docs/11-POKRETANJE.md](docs/11-POKRETANJE.md) | kako se pokreće, testira i deployuje |
| [docs/12-MAX-ARHITEKTURA.md](docs/12-MAX-ARHITEKTURA.md) | MAX arhitektura: slojevi, tokovi, izolacija, kada na K8s |
| [docs/13-KONTROLNA-RAVAN.md](docs/13-KONTROLNA-RAVAN.md) | lifecycle agenata, per-agent identitet i budžet, RBAC/ABAC, admin API |
| [docs/14-PERSISTENTNI-AGENTI.md](docs/14-PERSISTENTNI-AGENTI.md) | scheduler, cron, event triggeri, dugoročni procesi, leasing |
| [docs/15-EPIZODICNA-MEMORIJA.md](docs/15-EPIZODICNA-MEMORIJA.md) | robot koji uči iz svojih slučajeva (few-shot) |
| [docs/16-PATTERNI-MAX.md](docs/16-PATTERNI-MAX.md) | ReAct, Planning, Reflection, Debate, specijalistički tim |
| [docs/17-ENTERPRISE-SIGURNOST.md](docs/17-ENTERPRISE-SIGURNOST.md) | sandbox, izolacija, identitet, enkripcija, incident |
| [docs/18-OBSERVABILITY-MAX.md](docs/18-OBSERVABILITY-MAX.md) | OTel izvoz, sve metrike, alerti, dashboardi, SLO |
| [docs/19-MVP-MAX-PLAN.md](docs/19-MVP-MAX-PLAN.md) | plan 16 nedjelja: od v0.2 do enterprise spremnosti |
| [infra/DEPLOY.md](infra/DEPLOY.md) | Hetzner, Hostinger, Docker, Cloudflare tunnel |
| [infra/k8s/README.md](infra/k8s/README.md) | Kubernetes: namespace po tenantu, NetworkPolicy, RBAC, scheduler |

---

## Principi kojih se držimo

1. **Zero zavisnosti u jezgru** — `dependencies: {}`. Radi offline, bez build-a, bez supply-chain rizika, na Hostingeru bez LVE problema.
2. **Podaci, ne kod** — novi agent, novi scenario ili nova politika = novi JSON. Kod se mijenja samo za novu sposobnost.
3. **Fail-closed** — ako politika ne može dokazati da je akcija dozvoljena, ne izvršava se.
4. **Sve je mjerljivo** — svaki run ima trace, trošak, trajanje i audit zapis. Ono što se ne mjeri, ne može se naplatiti ni popraviti.
5. **Tenant je svetinja** — nijedna memorijska operacija ne prolazi bez `tenantId`, dokument nosi svoj tenant, upit filtrira po njemu.
6. **Sadržaj iz alata je podatak, nikad instrukcija** — zaštita od prompt injection-a kroz mejl, dokument ili ticket.
7. **Nikad tajne u log, config ili chat** — samo imena ključeva; vrijednosti iz DSH store-a ili `.env` (koji nije u git-u).

---

## Status

`v0.3.0` — autonomni nivo: **150/150 testova**, 19 agenata, 11 ulaza/patterna, 20 ugrađenih alata,
persistentni agenti, kontrolna ravan, autonomija **L0–L4**, **ciljevi sa KPI i replan-om**, proaktivni watcheri,
**self-improvement sa odobrenjem i A/B**, self-play i RSI, **AI organizacija (7 uloga)** i **A2A pregovaranje**
sa internim settlement ledger-om — sve bez ijedne npm zavisnosti.
Vlasnik: **NMQ — Dejan Milošević PR** · Licenca: vlasnička (SaaS + self-hosted).
