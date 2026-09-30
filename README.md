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
| **Orchestrator** | `router`, `sequential`, `orchestrator-worker`, `fanout`, `handoff`, `magentic` | `src/orchestration/` |
| **Agenti** | 13 agenata definisanih **podacima** (JSON) — novi agent = novi fajl, bez koda | `config/agents/` |
| **Alati** | 21 ugrađen alat (CRM, fakture, mejl, KB, izvještaji, narudžbine, ticketi, kalkulator…) | `src/tools/builtin.js` |
| **MCP** | Vlastiti JSON-RPC 2.0 klijent: `stdio` + Streamable HTTP; šablon internog servera | `src/tools/mcp-*.js`, `mcp/` |
| **Memorija** | Sesija (klizni prozor + sažetak), istorija/facts, vektorska baza sa citatima | `src/memory/` |
| **Observability** | Trace/span, Prometheus metrike, cost tracker po tenantu/agentu/modelu, hash-chained audit | `src/observability/` |
| **Governance** | `allow / deny / require_approval`, budžet, PII redakcija, human-in-the-loop | `src/core/policy.js`, `config/policies.json` |
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
| [infra/DEPLOY.md](infra/DEPLOY.md) | Hetzner, Hostinger, Docker, Cloudflare tunnel |

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

`v0.1.0` — MVP koji radi: 70/70 testova, demo svih patterna, 13/13 smoke provjera, bez ijedne npm zavisnosti.
Vlasnik: **NMQ — Dejan Milošević PR** · Licenca: vlasnička (SaaS + self-hosted).
