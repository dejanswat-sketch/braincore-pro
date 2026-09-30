# DECISIONS.md — obavezujući tehnički ugovor (NMQ Robot)

> **Svrha:** svaki dokument i svaki fajl koda mora da bude u skladu sa ovim odlukama.
> Ako se odluka menja — menja se **ovaj fajl prvi**, pa onda kod i ostala dokumentacija.
> Verzija: 1.0 · Datum: 2026-09-29 · Vlasnik: NMQ (Dejan Milošević PR)

---

## 0. Jedna rečenica

**NMQ Robot** je univerzalni, multi-tenant AI agent koji se ugrađuje i u sajt (JS widget) i u
interne procese (REST/webhook), a sve svoje sposobnosti dobija kroz **alate** (MCP + interna
registry), **memoriju** (sesija + istorija + vektorska baza) i **orchestraciju** (6 patterna).

Razlika od "još jednog chat bota": robot **radi** (kreira task, šalje mejl, pravi ponudu, piše u CRM,
pravi izveštaj), a ne samo odgovara. Svaka akcija je pod **politikom**, **budžetom** i **audit tragom**.

---

## 1. Tehnološke odluke (LOCKED)

| # | Odluka | Vrijednost | Zašto |
|---|---|---|---|
| D1 | Runtime | **Node.js ≥ 20 LTS** (testirano na 22 i 24), ESM (`"type": "module"`) | Isti runtime kao DSH, Hostinger Passenger i Hetzner VPS — bez dodatnog stack-a za održavanje |
| D2 | Jezgro | **ZERO obaveznih npm zavisnosti** (`dependencies: {}`) | Radi offline, bez `npm install`, bez build koraka, bez supply-chain rizika; Hostinger LVE limiti ne mogu da obore build |
| D3 | HTTP sloj | `node:http` (vlastiti micro-router) | Bez Express/Fastify; dovoljno za REST + SSE + webhook |
| D4 | Streaming | **SSE** (`text/event-stream`) + JSON; WebSocket samo kao opcija (`optionalDependencies`) | SSE radi kroz svaki proxy/CDN, trivijalan za widget |
| D5 | MCP | **Vlastiti JSON-RPC 2.0 klijent** (`src/tools/mcp-*.js`): `stdio` transport + Streamable HTTP | MCP je otvoren protokol (JSON-RPC 2.0); ne zavisimo od SDK verzija |
| D6 | LLM | Provider adapter preko `fetch` na **OpenAI-kompatibilan** API (DeepSeek, OpenAI, Groq, OpenRouter, Ollama, vLLM) + ugrađeni `mock` provider | DeepSeek je primarni (postojeći ključ); zamjena modela = promjena jednog polja u config-u |
| D7 | Baze (obavezno za MVP) | **Fajl-sistem**: JSONL (istorija/audit/trace) + JSON (config). Radi bez ijednog servera | MVP se pokreće jednom komandom; nula infrastrukture |
| D8 | Baze (produkcija, opciono) | **PostgreSQL 16 + pgvector** (RLS za tenancy), **Redis** (sesije, rate limit, queue) | Standard, jeftin na Hetzneru, RLS daje izolaciju na nivou reda |
| D9 | Vektorska memorija | Ugrađeni **brute-force cosine** (radi odmah) → kasnije `pgvector` / Qdrant adapter kroz isto interfejs | Isti interfejs `VectorStore`, zamjena bez refaktorisanja agenata |
| D10 | Embeddings | Ugrađeni **hash-embedder** (offline, determinističan, bez ključa) + `openai-compatible` embedder | Demo i testovi rade bez interneta i bez troška |
| D11 | Multi-tenancy | `tenant_id` je **obavezan** parametar svake memorijske/alatne operacije; fizička izolacija foldera/namespace-a + RLS u Postgresu | Izolacija podataka je feature #1 za enterprise prodaju |
| D12 | Izolacija na disku | `data/tenants/<tenant_id>/...` | Jednostavan backup, jednostavna selekcija, nemoguće "slučajno" pročitati tuđe |
| D13 | Orchestration | 6 patterna: `router`, `sequential`, `orchestrator-worker`, `fanout-fanin`, `handoff`, `magentic` | Pokriva 95% realnih zadataka; pattern se bira po config-u, ne po kodu |
| D14 | Agenti | 10 domenskih (sales, support, ops, finance, hr, dev, data, ecommerce, legal, creative) + `router` + `critic` + `researcher` — **definisani podacima** (`config/agents/*.json`) | Novi agent = novi JSON fajl, bez izmjene koda |
| D15 | Governance | Politike po tenantu: allow/deny alata, `riskLevel` alata, PII redakcija, budžet (tokeni/$), rate limit, **human-in-the-loop** za `high` rizik | Enterprise blocker #1: agent ne smije sve |
| D16 | Observability | Trace (spanovi) + metrike (Prometheus tekst na `/metrics`) + **cost tracker** po tenantu/agentu/modelu + **hash-chained audit log** | Naplata po usage-u i dokazivanje usklađenosti traže tačno ovo |
| D17 | Testovi | `node --test` (built-in), bez zavisnosti; svaki pattern i svaka politika ima test | Dokaz da radi, ne tvrdnja |
| D18 | Deploy | Docker + `docker-compose` (api + postgres/pgvector + redis), `systemd` unit, Cloudflare tunnel; Hostinger Passenger kao lagani tenant | Isto kao postojeća NMQ infrastruktura |
| D19 | Jezik dokumentacije | **Srpski (latinica)** + engleski tehnički termini; kod i identifikatori na engleskom | Korisnik i tim čitaju srpski; kod ostaje standardizovan |
| D20 | Licenca / model prodaje | SaaS (multi-tenant) + self-hosted enterprise licenca | Dvije linije prihoda bez dvije codebase |

---

## 2. Obavezni interfejsi (ne mijenjati bez verzije)

```js
// LLM
provider.chat({ messages, tools, temperature, maxTokens, stream, signal }) -> { text, toolCalls[], usage, model, finishReason }

// Tool
tool = { name, description, params /* JSON Schema */, riskLevel: 'low'|'medium'|'high', scopes: [], handler(args, ctx) }

// Memory
session.get(tenantId, sessionId) / append(...) / set(...)
longterm.append(tenantId, event) / search(tenantId, { query, k, filter })
vector.upsert(tenantId, { id, text, metadata, embedding? }) / query(tenantId, { text|embedding, k, filter })

// Orchestration
pattern({ input, ctx, agentId?, config }) -> { output, steps[], usage, cost, traceId, approvals[] }

// Server
POST /v1/agents/:agentId/run      -> { runId, output, steps, usage, cost }
POST /v1/agents/:agentId/stream   -> SSE (token | step | tool | done | error)
POST /v1/router/run               -> automatski izbor agenta
POST /v1/hooks/:source            -> webhook ulaz (email, slack, shopify, github...)
POST /v1/approvals/:runId         -> odobrenje/odbijanje akcije visokog rizika
GET  /v1/runs/:runId              -> stanje + trace
GET  /v1/tenants/:id/config       -> konfiguracija (bez tajni)
GET  /healthz · /readyz · /metrics · /v1/tools · /v1/agents
```

## 3. Struktura foldera (LOCKED)

```
nmq-robot/
  src/core/           config, errors, ids, events, logger, policy, budget, registry, clock
  src/llm/            provider.js, openai-compatible.js, mock.js, index.js
  src/memory/         session.js, longterm.js, vector.js, embeddings.js, index.js
  src/tools/          registry.js, builtin.js, mcp-client.js, mcp-stdio.js, mcp-http.js
  src/agents/         agent.js, catalog.js, router-agent.js, critic.js
  src/orchestration/  sequential.js, orchestrator-worker.js, fanout.js, handoff.js, magentic.js, index.js
  src/tenancy/        store.js
  src/observability/  trace.js, metrics.js, cost.js, audit.js
  src/server/         http.js, routes.js, stream.js
  public/widget/      nmq-robot.js  (embed widget, jedan fajl)
  mcp/                example-server.mjs
  config/             agents/*.json, policies.json, tenants.json, tools.json
  tests/              *.test.mjs
  scripts/            demo.mjs, serve.mjs, smoke.mjs
  infra/              Dockerfile, docker-compose.yml, nmq-robot.service, deploy-*.md
  docs/               00..11 + DECISIONS.md
  data/               (runtime; u .gitignore)
```

## 4. Definicija "urađeno" (Definition of Done)

1. `npm test` prolazi bez ijedne spoljne zavisnosti i bez interneta.
2. `node scripts/demo.mjs` pokaže sva 6 patterna + izolaciju dva tenanta + cost izvještaj.
3. `node scripts/serve.mjs` digne gateway; `curl /healthz`, `/v1/agents`, `/v1/agents/support/run` rade.
4. Politika blokira zabranjen alat i traži odobrenje za `high` rizik (dokazano testom).
5. Svaki trošak je vezan za `tenantId` + `agentId` + `model`.
6. Dokumentacija 00–10 postoji i pokriva svih 10 tačaka iz zahtjeva.

## 5. Zamke (naučene na NMQ projektima — ne ponavljati)

| Zamka | Pravilo |
|---|---|
| Hostinger LVE ubija teške build-ove | Nema build koraka; `dependencies: {}`; nikad `npm install --omit=dev` |
| Keš na Hostingeru/CDN servira stare module | Statika: `Cache-Control: no-cache` + `?v=` version bust pri deploy-u |
| `.env` u git-u | `.gitignore` prvi fajl; tajne samo kroz DSH store (`get-key.mjs`) |
| Deploy bez backup-a | Prije deploy-a backup `data/` (postojeći restic backup pokriva `E:\NMQ-PROGRAMI`) |
| Python/Node mix na serveru | Jedan runtime (Node) — bez Python mikroservisa u MVP-u |
| Agent koji "sve smije" | Svaki alat ima `riskLevel` i `scopes`; `high` uvijek traži odobrenje |
| Tiha greška u alatu | Svaki tool poziv se loguje (ulaz, izlaz, trajanje, greška) u audit log |

---

## 6. Kanonske putanje podataka (MVP v0.1.0)

**Kod je kanonski.** Dokumenti `02`, `05`, `06` i `08` su pisani paralelno i mjestimično predlažu drugačije
putanje i šemu tabela (npr. `longterm/events.jsonl`, `vectors/vectors.jsonl`, `audit/YYYY-MM.jsonl`,
`costs/YYYY-MM.json`, tabele `embeddings`/`cost_ledger`/`facts`/`approvals`/`policy_denials`).
Ta imena i šema važe **za produkcijsku fazu (PostgreSQL + pgvector)**, a u MVP-u (v0.1.0) stvarno stanje na disku je:

| Šta | Stvarna putanja (MVP, kod) |
|---|---|
| Sesije | `data/tenants/<id>/sessions/<sessionId>.jsonl` (+ `.json` snapshot) |
| Dugoročna istorija | `data/tenants/<id>/memory/events-YYYY-MM.jsonl` |
| Trajne činjenice | `data/tenants/<id>/memory/facts.json` |
| Vektorska baza | `data/tenants/<id>/vectors/docs.jsonl` (+ `docs.compact.json` pri kompakciji) |
| Trace/spanovi | `data/tenants/<id>/traces/YYYY-MM-DD.jsonl` |
| Potrošnja (naplata) | `data/tenants/<id>/usage/YYYY-MM.jsonl` |
| Audit | `data/tenants/<id>/audit/audit.jsonl` |
| Tajne klijenta | `data/tenants/<id>/secrets/secrets.enc.json` (AES-256-GCM, AAD `<id>:v1`) |
| Integracije (interna evidencija) | `data/tenants/<id>/{crm,orders,tickets,invoices}/<kind>.jsonl` |
| Izlazna komunikacija | `data/tenants/<id>/outbox/{emails,notifications}.jsonl` |
| Status tenanta (kill switch) | `data/tenants/<id>/status.json` |

Odluke koje iz ovoga slijede (i važe za oba sloja):

1. **`facts`, `approvals` i `policy_denials` nisu zasebne tabele u MVP-u** — `facts` je fajl, a odobrenja i odbijanja žive u audit logu (`action: tool_call | approval_decision`, `decision: require_approval | approved | deny`) i u dugoročnoj memoriji kao događaji tipa `approval`. U produkciji se izvode kao tabele/views iz `audit_log`.
2. **Audit je jedan append-only fajl po tenantu** (`audit/audit.jsonl`) sa hash lancem; mjesečna rotacija je planirana u v1 (`audit/YYYY-MM.jsonl`) zajedno sa nošenjem hash-a prethodnog mjeseca.
3. **Nema `data/_global/`** u MVP-u; trošak je uvijek po tenantu (`usage/`), a cijene modela su konstanta u `src/observability/cost.js` (tabela `PRICING`, sa napomenom „provjeriti kod providera"). U v1 cijene idu u `data/_global/pricing.json` sa `checkedAt` i `sourceUrl`.
4. **Ako se dokument i kod razlikuju, ispravlja se dokument** (ili se ovaj spisak ažurira zajedno sa kodom). Testovi su treći arbitar: `tests/observability.test.mjs` i `tests/memory.test.mjs` čitaju ove putanje.

---

## 7. Stanje implementacije (v0.1.0) — šta je stvarno u kodu

| Sposobnost | Status | Dokaz |
|---|---|---|
| Gateway (REST, SSE, webhook, CORS, rate limit, metrike) | ✅ | `scripts/smoke.mjs` 13/13 |
| 6 patterna + direktan agent + ruter bez LLM-a | ✅ | `tests/patterns.test.mjs` |
| 13 agenata (podaci) + 21 ugrađen alat | ✅ | `node src/cli.js agents/tools` |
| MCP klijent (stdio + HTTP) + interni MCP šablon | ✅ | `tests/tools.test.mjs` |
| Memorija: sesija, istorija/facts, RAG sa citatima | ✅ | `tests/memory.test.mjs` |
| Izolacija tenanta (fizički + logički + normalizacija metadata) | ✅ | `tests/memory.test.mjs`, `tests/server.test.mjs` |
| Politike (deny/approval/allow), budžet, `maxToolRepeats`, PII | ✅ | `tests/policy.test.mjs` |
| Human-in-the-loop kroz API (`/v1/approvals`) | ✅ | `tests/server.test.mjs` |
| Cost tracking po tenantu/agentu/modelu | ✅ | `tests/observability.test.mjs` |
| Hash-chained audit + verifikacija | ✅ | `node src/cli.js audit-verify` |
| Prometheus metrike | ✅ | `GET /metrics` |
| AES-256-GCM tajne po tenantu | ✅ | `tests/observability.test.mjs` |
| Widget za embed (Shadow DOM, SSE, feedback) | ✅ | `public/widget/nmq-robot.js`, demo stranica |
| **Dashboard** | ❌ planirano (faza 3, `07`) | — |
| **Alerti (Prometheus rules)** | ❌ planirano (faza 3) | pravila u `06` §8 |
| **Postgres + pgvector + Redis** | ❌ planirano (faza 6) | interfejsi spremni |
| **Prave integracije (Gmail, Slack, Shopify…)** | ❌ planirano (faza 2) | katalog i prioriteti u `03` |
| **Eval harness (zlatni set)** | ❌ planirano (faza 4) | — |
| **Ugniježđeni patterni sa `maxDepth`** | ❌ planirano (v0.2) | `01` §8 |

---

## 8. MAX nivo (v0.2.0) — dodatne odluke

| # | Odluka | Vrijednost | Zašto |
|---|---|---|---|
| D21 | Persistentni agenti | **Scheduler u procesu** (`src/scheduler/`): `once` / `interval` / `cron`, event triggeri, dugoročni procesi sa checkpoint-om u `data/tenants/<id>/jobs/jobs.json` | Radi bez Redisa i bez dodatne infrastrukture; posao preživljava restart |
| D22 | Leasing | Fajl-lease (`lease.owner`, `lease.until`) — **nije distributed lock** | Dovoljno za 1 repliku; za više replika ide Postgres advisory lock ili Redis (planirano, `docs/14` §7) |
| D23 | Event triggeri | `hooks` ruta emituje `hook.<source>` na bus → `scheduler.triggerEvent` pokreće poslove sa `triggers[{type:'event'}]` | Jedan webhook može i direktno da odgovori i da pokrene dugoročne procese |
| D24 | Kontrolna ravan | **U procesu** (`src/controlplane/`): verzije agenata, `deploy`/`rollback`, `pause`/`retire`, per-agent ključevi (`nmqa_`), per-agent budžet | Bez novog servisa; stanje u `data/_control/agents.json`; override se primjenjuje bez restarta |
| D25 | Agent identitet | Per-agent API ključ (hash + scopes + opoziv) pored tenant ključa | Service account za MCP servere i pozadinske procese |
| D26 | Budžet po patternu | `PATTERN_STEP_BUDGET` množi `maxSteps` (team ×6, debate ×5, reflection ×3…) | Bez toga multi-agent patterni padaju na budžetu predviđenom za jedan razgovor |
| D27 | Sandbox | Aplikativni sloj (`src/core/sandbox.js`): mrežni allowlist, FS korijeni, očišćen env za MCP podprocese, limiti. Nivoi `none/restricted/strict` | OS izolacija (namespaces, seccomp, gVisor) je na kontejneru/K8s — oba sloja trebaju |
| D28 | Epizodična memorija | `src/memory/episodic.js`: epizoda (problem → koraci → ishod → pouke) + few-shot u prompt (k≤3, ≤1500 znakova) | Robot uči iz svojih slučajeva; indeksirano u istoj vektorskoj bazi sa `metadata.kind='episode'` |
| D29 | Novi patterni | `reflection`, `debate`, `team` (+ `react` kao alias za `agent`) | Pokriva plan-act-reflect, odluke sa trade-off-ima i specijalistički tim |
| D30 | Telemetrija | **OTLP/JSON izvoz** (`src/observability/otel.js`): fajl `data/_global/otel-traces.jsonl` i/ili HTTP na `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`; greška izvoza ne ruši run | Radi bez kolektora, a spaja se na Tempo/Jaeger čim postoji |
| D31 | Tenancy u K8s | SaaS (dijeljen proces + `tenantId`) **ili** namespace po klijentu (`infra/k8s/tenant-template/`) | Dva režima za dva tipa klijenta; isti image |
| D32 | Prva zavisnost | I dalje `dependencies: {}` — uključujući scheduler, control plane, OTLP, sandbox i K8s manifeste | Nema `npm install`, nema build-a, nema supply-chain rizika |

**Stanje dokaza (v0.2.0):** `node --test` → **106/106**, `node scripts/demo.mjs` → 16 sekcija bez greške,
`node scripts/smoke.mjs` → 13/13, `node src/cli.js audit-verify` → lanac ispravan.
