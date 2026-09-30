# 12 — MAX arhitektura (v0.2): kontrolna ravan nad agentima

> Ovaj dokument nadograđuje `01-ARHITEKTURA.md` (v0.1.0) i ne ponavlja ga. Sve putanje su provjerene
> protiv koda u ovom repou. Ako se dokument i kod razlikuju — **kod je kanonski** (`DECISIONS.md` §6.4).
> Dokazi za tvrdnje iz ovog dokumenta: `tests/max.test.mjs`, `scripts/smoke.mjs`.

MAX nivo (v0.2) dodaje četiri stvari koje v0.1.0 nije imao:

1. **Kontrolna ravan** (`src/controlplane/registry.js`) — verzije agenata, per-agent identitet, per-agent budžet.
2. **Persistentni agent** (`src/scheduler/`) — poslovi po rasporedu/događaju i dugoročni procesi sa checkpointom.
3. **Aplikativni sandbox** (`src/core/sandbox.js`) — granice za alate i MCP podprocese.
4. **OTLP izvoz** (`src/observability/otel.js`) — tragovi u OTLP/JSON obliku (fajl ili endpoint).

Sve četiri su isključivo na `node:*` modulima: `dependencies: {}` i dalje važi (`DECISIONS.md` D2).

---

## 1. Mapiranje na klasične slojeve

| Sloj | Šta ga u NMQ Robotu implementira (tačne putanje) | Šta je namjerno izostavljeno i zašto | Kada se uvodi |
|---|---|---|---|
| **Edge / Gateway** | `src/server/http.js` (micro-router, CORS, `x-request-id`, `readBody`, rate limit, mapiranje grešaka), `src/server/routes.js` (javne rute + SSE + webhook), `src/server/stream.js`, `public/widget/nmq-robot.js` | Nema API gateway-a (Kong/Envoy), WAF-a, CDN pravila u kodu, ni service mesh-a. Jedan proces na jednoj adresi je dovoljan za MVP; Cloudflare tunnel i nginx Ingress rade TLS i limit (`infra/k8s/base/service.yaml`) | Reverse proxy odmah (tunnel/Ingress); API gateway tek ako uvedemo više nezavisnih servisa |
| **Control Plane** | `src/controlplane/registry.js` (lifecycle, `keys[]`, `budgetUsdMonth`, `assertAgentBudget`, `authenticateAgentKey`), `src/server/routes-admin.js` (`/v1/admin/*`), stanje u `data/_control/agents.json` | Nema odvojenog servisa, ni vlastite baze, ni UI-a. Deli proces sa data plane-om — vidi §6 | Odvojen servis tek kad treba više replika API-ja sa istim stanjem (v1) |
| **Orchestration** | `src/orchestration/index.js` (`run`, `PATTERNS`), patterni `sequential.js`, `orchestrator-worker.js`, `fanout.js`, `handoff.js`, `magentic.js`, `reflection.js`, `debate.js`, `team.js`, `helpers.js` (`callLlm`) | Nema reda poslova (queue) — sve je u requestu ili u scheduler tick-u; nema DAG engine-a (Temporal/Airflow); nema ugniježđenih patterna (`maxDepth`) — planirano u v0.3 | Queue: kad dugi poslovi počnu da drže HTTP konekcije ili treba multi-worker raspodjela |
| **MCP / Tool** | `src/tools/registry.js` (jedina ulazna tačka: politika → budžet → izvršenje → audit → metrike), `src/tools/builtin.js` (20 ugrađenih alata — `DECISIONS.md` §7 navodi 21, što je nesklad u dokumentaciji, ne u kodu), `src/tools/mcp-client.js`, `mcp-stdio.js`, `mcp-http.js`, `mcp/example-server.mjs`, konfiguracija `config/tools.json` | Nema MCP gateway-a (jedan proces = jedan MCP klijent po serveru), nema marketplace-a alata, nema per-tool verzionisanja | MCP gateway kad broj servera pređe ono što jedan proces drži u `clients` mapi |
| **Memory** | `src/memory/` — `session.js` (sesija), `longterm.js` (istorija + `facts.json`), `vector.js` (brute-force cosine + `docs.jsonl`), `embeddings.js` (hash-embedder), `episodic.js` (epizode problem→rješenje) | Nema vektorske baze kao servisa (Qdrant/pgvector) i nema Redis-a za sesije. Fajl-skladište je dovoljno do ~10k dokumenata po tenantu (`01` §8) | pgvector/Qdrant kad brute-force pretraga pređe budžet latencije; Redis kad treba deljeni rate limit i sesije preko replika |
| **Model** | `src/llm/index.js` (adapter + fallback lanac + keš), `openai-compatible.js` (fetch na `/chat/completions`), `mock.js`, cijene u `src/observability/cost.js` (`PRICING`) | Nema LLM gateway-a, semantičkog keša, ni vlastitog modela; nema automatskog izbora modela po cijeni (osim `fastModel` u config-u) | LLM gateway/keš kad budu ≥2 providera u produkciji sa različitim limitima |
| **Infra** | `infra/Dockerfile`, `infra/docker-compose.yml`, `infra/nmq-robot.service`, `infra/k8s/base/{namespace,deployment,service,configmap}.yaml`, `infra/DEPLOY.md` | Nema K8s operatora, Helm charta, service mesh-a, ni `infra/k8s/tenant-template/` — namespace manifest ga pominje u komentaru, ali **šablon još ne postoji** | Operator/Helm kad broj tenant-namespace-a pređe desetak; vidi §7 |

---

## 2. Tokovi

### (a) Zahtjev korisnika kroz gateway do agenta

```
klijent (widget / curl / sistem)
   │  POST /v1/agents/support/run   { input, sessionId?, tenantId? }
   ▼
[1] src/server/http.js
     ├─ CORS, OPTIONS → 204
     ├─ readBody() + query params
     ├─ extractKey(req): Authorization: Bearer … | x-api-key
     ├─ tenants.authenticate({ apiKey, tenantHint: x-tenant|body.tenantId|query.tenant })
     │     → src/tenancy/store.js  (sha256(pepper+ključ), timingSafeEqual)
     ├─ isSuspended → 403 TENANT_SUSPENDED
     ├─ rateLimit(tenantId, perMin)   (in-memory sliding window)
     └─ assertCan(role, route.requiredRole)   (npr. 'run' za /run)
   ▼
[2] src/server/routes.js  → robot.orchestrator.run({ tenantId, agentId, input, onEvent? })
   ▼
[3] src/orchestration/index.js :: run()
     ├─ config.tenant(), catalog.get(), assertAgentAllowed(tenant.allowedAgents)
     ├─ controlPlane.assertAgentBudget(tenantId, agentId)   → pauza / mjesečni budžet
     ├─ policy = resolvePolicy(policies, tenantId, { agentId })   → src/core/policy.js
     ├─ tracer.startRun() → runId/traceId                         → src/observability/trace.js
     ├─ cost.monthlySpent(tenantId) → createBudget()              → src/core/budget.js
     └─ izbor patterna: options.pattern → agent.defaultPattern → 'router'
   ▼
[4] pattern (npr. src/orchestration/orchestrator-worker.js)
     └─ runAgent(spec, input, ctx)  → src/agents/agent.js
          ├─ memory.recall() (RAG + facts + epizode)
          ├─ tools.specsFor({ policy, agentId, scopes, maxRisk })
          └─ petlja LLM ↔ alati: tools.execute(name,args,ctx) → src/tools/registry.js
   ▼
[5] odgovor: { runId, agentId, pattern, output, usage, costUsd, steps, durationMs, approvals }
    (SSE varijanta: isti tok + onEvent → /v1/agents/:id/stream, src/server/stream.js)
```

Za svaki korak je odgovoran tačno jedan fajl; nijedan sloj ne preskače prethodni. Alat se **ne može**
izvršiti mimo `src/tools/registry.js` (`execute`) — ni ugrađeni ni MCP (`01` §2, pravilo 1).

### (b) Lifecycle agenta: deploy → verzija → rollback → pause

```
POST /v1/admin/agents/support/deploy { patch:{temperature:0.9}, note:"topliji ton" }
   │  requiredRole: 'admin'  → src/server/http.js assertCan
   ▼
src/server/routes-admin.js
   ├─ validacija: body.patch mora biti objekat (ValidationError → 400)
   └─ cp().deploy(tenantId, agentId, { patch, note, actor: auth.keyId })
        │
        ▼
      src/controlplane/registry.js :: deploy()
        ├─ tenants.has(tenantId) → NotFoundError (404)
        ├─ catalog.get(agentId) — ako agent ne postoji, traži se patch.systemPrompt
        ├─ a.overrides = { ...a.overrides, ...patch }      (zakrpe se SABIRAJU)
        ├─ version = a.activeVersion + 1                    (monotono raste)
        ├─ a.versions.push({ version, patch, actor, note, createdAt, specHash })
        ├─ await persist()   → data/_control/agents.json
        ├─ catalog.setOverride(agentId, a.overrides)        → PRIMIJENJENO ODMAH (bez restarta)
        ├─ metrics.inc('controlplane_deploys_total')
        └─ auditLifecycle({ action: 'agent_deploy', meta:{ version, fields, note } })
             → data/tenants/<id>/audit/audit.jsonl (hash lanac)

POST /v1/admin/agents/support/rollback { version: 1 }
   └─ cp().rollback()
        ├─ version===0 → { patch: {} } = povratak na config baseline (catalog.clearOverride)
        ├─ version==null → a.versions.at(-2) (prethodna verzija)
        ├─ accumulated = Object.assign({}, ...versions.filter(v => v.version <= target.version).patch)
        ├─ a.versions.push({ version: target.version, actor:'rollback', note:'rollback sa vN' })
        ├─ persist() + catalog.setOverride/clearOverride
        └─ audit({ action: 'agent_rollback', meta:{ from, to } })

POST /v1/admin/agents/support/status { status: 'paused' | 'active' | 'retired' }
   └─ cp().setStatus()
        ├─ status='active' + ima overrides → catalog.setOverride (vraća zakrpe)
        ├─ status!='active'               → catalog.clearOverride (agent se vraća na config)
        └─ audit({ action: 'agent_paused' | 'agent_active' | 'agent_retired' })

pauzirani agent se odbija prije LLM poziva:
   src/orchestration/index.js → controlPlane.assertAgentBudget() → PolicyError
   (dokaz: tests/max.test.mjs → „control plane: pauziran agent ne može da se pokrene")
```

### (c) Persistentni posao: scheduler → orchestrator → checkpoint → sljedeći korak

```
POST /v1/admin/jobs { agentId, input, schedule:{type:'interval'|'cron'|'once', everyMs|cron} }
   └─ src/server/routes-admin.js → sched().createJob()
        └─ src/scheduler/index.js :: createJob()
             ├─ job = { id: uid('job'), schedule, triggers[], retry:{max:2,backoffMs:5000}, enabled:true, status:'pending', runs:0 }
             ├─ nextRunAt = runNow ? now() : computeNextRun() (interval/cron preko src/scheduler/cron.js)
             ├─ store.upsert()  → data/tenants/<id>/jobs/jobs.json   (SNAPSHOT STANJA)
             └─ audit({ action: 'job_create' })

tick (setInterval, tickMs = NMQ_SCHEDULER_TICK_MS, default 1000):
   src/scheduler/index.js :: tick()
     ├─ for tenantId of store.tenantsWithJobs()      ← IN-MEMORY lista (vidi §4, zamka restarta)
     ├─ store.list(tenantId, { enabledOnly:true })   → isDue(job)
     ├─ acquireLease(tenantId, jobId)                 → lease:{owner: process.pid, until: now+60s}
     ├─ active < maxConcurrent (default 3)
     └─ runJob(...) — namjerno bez await (tick ne čeka izvršenje)

runJob():
   ├─ ako je job.type==='process': uzmi prvi korak koji nije u process.done
   ├─ robot.orchestrator.run({ tenantId, agentId, pattern, input, sessionId:`job_<id>`, userId:`job:<id>` })
   │     (isti put kao (a): politika, budžet, trace, cost, audit)
   ├─ update: runs++, lastRunId, totalCostUsd, lastStatus
   ├─ process: done.push(stepIndex), state='in_progress'|'awaiting_final', log (zadnjih 20)
   ├─ nextRunAt = preostali koraci ? now + stepDelayMs : null   ← CHECKPOINT
   ├─ releaseLease() → store.upsert() → jobs.json               ← PREŽIVLJAVA RESTART
   ├─ store.appendRun() → data/tenants/<id>/jobs/runs-YYYY-MM.jsonl
   └─ audit({ action: 'job_run' | 'job_run_manual' })

greška: attempts++, status 'retrying' (retry.max, eksponencijalni backoff min(600000, backoffMs·2^(attempts-1))),
        'blocked' za PolicyError, 'failed' poslije maxAttempts; enabled=false; audit outcome:'error'
odobrenje: ako run završi sa awaiting_approval → status 'waiting_approval', nextRunAt=null (raspored se
        zaustavlja da se posao ne izvrši dvaput), pausedReason; nastavak: POST /v1/admin/jobs/:id/resume
događaj: POST /v1/hooks/:source → robot.bus.emit('hook.<source>') → scheduler.triggerEvent()
dokaz:   tests/max.test.mjs (interval, tick, pauza/resume, event trigger, checkpoint, retry)
```

---

## 3. Protokoli i ugovori

| Veza | Protokol | Oblik poruke | Gdje je definisano u kodu |
|---|---|---|---|
| Klijent ↔ Gateway | HTTP/1.1 + JSON, SSE za stream | `{ input, sessionId?, options? }` → `{ runId, output, usage, costUsd, steps, approvals }`; SSE događaji `routing|plan|worker_start|tool_start|token|usage|final|done|error` | `src/server/http.js`, `src/server/routes.js`, `src/server/stream.js` |
| Klijent → identitet | Bearer token / `x-api-key` + `x-tenant` | hash `sha256(pepper + ključ)`; povrat `{ tenantId, role, keyId, auth }` | `src/tenancy/store.js` (`authenticate`), `src/server/http.js` (`extractKey`) |
| Kontrolna ravan ↔ klijent | HTTP/JSON pod `/v1/admin/*` | `{ patch }`, `{ version }`, `{ status, reason }`, `{ budgetUsdMonth }`, `{ scopes, label, role }` | `src/server/routes-admin.js` |
| Gateway ↔ Orchestrator | direktan JS poziv + `onEvent(event)` callback | `run(req) → { runId, agentId, pattern, output, usage, costUsd, approvals, handoffs }` | `src/orchestration/index.js` |
| Orchestrator ↔ Agent | direktan JS poziv | `runAgent(spec, input, ctx) → { output, steps, usage, costUsd, status, approvals, handoffs }` | `src/agents/agent.js` |
| Agent ↔ LLM | OpenAI-kompatibilan `chat/completions` preko `fetch` (+ SSE stream) | `{ messages, tools, temperature, maxTokens, stream, signal }` → `{ text, toolCalls[], usage, model, finishReason }` | `src/llm/openai-compatible.js`, ugovor u `DECISIONS.md` §2 |
| Agent ↔ Alati | direktan JS poziv (JSON Schema parametri) | `tools.execute(name,args,ctx) → { tool, riskLevel, durationMs, attempt, result }` | `src/tools/registry.js` |
| Gateway ↔ MCP server | JSON-RPC 2.0: `stdio` (jedna linija = jedna poruka) ili Streamable HTTP | `initialize` → `tools/list` → `tools/call`; alat se registruje kao `<serverId>.<toolName>` | `src/tools/mcp-client.js`, `mcp-stdio.js`, `mcp-http.js` |
| Webhook → event bus | in-process event bus (`on/emit`) | `bus.emit('hook.<source>', event)` i `bus.emit('hook.*', event)`; scheduler sluša `triggers[{type:'event', event:'hook.shopify'}]` | `src/core/events.js`, `src/server/routes.js` (`/v1/hooks/:source`), `src/scheduler/index.js` (`triggerEvent`) |
| Scheduler ↔ stanje posla | fajl-snapshot + JSONL (nema mreže) | `jobs.json` (snapshot), `runs-YYYY-MM.jsonl` (istorija), `lease:{owner,until}` | `src/scheduler/store.js` |
| Scheduler ↔ Orchestrator | direktan JS poziv | isti `orchestrator.run` ugovor kao za HTTP | `src/scheduler/index.js` → `src/orchestration/index.js` |
| Sloj ↔ Memorija | direktan JS poziv, `tenantId` prvi argument | `recall()`, `session.get/append`, `vector.upsert/query`, `episodic.record/similar` | `src/memory/*.js` |
| Sloj ↔ Trošak | direktan JS poziv (sinhron, ne mijenja ishod) | `{ tenantId, agentId, runId, model, usage }` → `usage/YYYY-MM.jsonl` | `src/observability/cost.js` |
| Sloj ↔ Audit | direktan JS poziv, append-only | `{ ts, seq, tenantId, actor, action, tool, args, decision, outcome, prevHash, hash, meta }` | `src/observability/audit.js` |
| Sloj ↔ Trace/OTel | sinhron upis + OTLP/JSON izvoz | `resourceSpans[].scopeSpans[].spans[]` sa atributima `nmq.tenant`, `nmq.agent`, `nmq.run_id`, `nmq.cost_usd` | `src/observability/trace.js`, `src/observability/otel.js` |
| Nadzor | Prometheus tekst + JSON health | `GET /metrics`, `GET /healthz`, `GET /readyz`, `GET /v1/admin/health` | `src/observability/metrics.js`, `src/server/routes.js`, `src/server/routes-admin.js` |

---

## 4. „Uvek uključen" agent

Agent je „uvek uključen" kroz tri nezavisna mehanizma:

1. **Scheduler** (`src/scheduler/index.js`) — `setInterval(tick, NMQ_SCHEDULER_TICK_MS)`, tick uzima
   dospjele poslove (`once|interval|cron`) i pokreće ih **bez čekanja** (`runJob` se ne await-uje).
   Ograničenje istovremenosti: `maxConcurrent = 3`, plus in-process `runningJobs` set.
2. **Event bus** (`src/core/events.js`) — webhook (`POST /v1/hooks/:source`) emituje `hook.<source>`;
   posao sa `triggers:[{type:'event'}]` se pokreće odmah, van rasporeda.
3. **Dugoročni procesi** (`type:'process'`) — posao sa `steps[]` pamti `done[]`, `state`, `log[]`,
   `nextRunAt`; svaki tick izvršava **jedan** korak, tako da proces može da traje danima
   (npr. onboarding: dan 1 kickoff → dan 3 pristupi → dan 7 obuka).

### Šta tačno preživljava restart procesa

| Preživljava (fajl) | Sadržaj | Ko ga čita poslije restarta |
|---|---|---|
| `data/tenants/<id>/jobs/jobs.json` | svi poslovi: `schedule`, `process.done/state/log`, `nextRunAt`, `runs`, `totalCostUsd`, `retry`, `enabled` | `src/scheduler/store.js` (`load`) |
| `data/tenants/<id>/jobs/runs-YYYY-MM.jsonl` | istorija izvršavanja (runId, status, trajanje, trošak) | `src/scheduler/store.js` (`listRuns`) |
| `data/_control/agents.json` | `activeVersion`, `overrides`, `versions[]`, `keys[]` (hash), `budgetUsdMonth`, `status` | `src/controlplane/registry.js` (`load`) |
| `data/tenants/<id>/status.json` | kill switch tenanta | `src/tenancy/store.js` (`loadStatuses`) |
| `data/tenants/<id>/sessions/*.jsonl`, `memory/*`, `vectors/*` i epizode (`src/memory/episodic.js`) | memorija, facts, RAG, epizode | `src/memory/*` |
| `data/tenants/<id>/audit/audit.jsonl` | hash-lanac akcija | `src/observability/audit.js` |
| `data/tenants/<id>/usage/YYYY-MM.jsonl` | potrošnja za mjesečni budžet | `src/observability/cost.js` |
| `data/tenants/<id>/traces/YYYY-MM-DD.jsonl`, `data/_global/otel-traces.jsonl` | spanovi i OTLP izvoz | `src/observability/trace.js`, `otel.js` |

Pri restartu `controlPlane.load()` **ponovo primjenjuje** `overrides` na katalog — ali samo za agente
čiji je `status === 'active'` (`src/controlplane/registry.js`, `load()`). Pauziran agent poslije restarta
ostaje bez zakrpa, što je namjerno: pauza znači „vrati se na config".

### Šta NE preživljava (in-memory stanje) — iskreno

| Ne preživljava | Gdje živi | Posljedica |
|---|---|---|
| `store.tenantsWithJobs()` — lista tenanta sa poslovima | `cache` u `src/scheduler/store.js` | **Zamka:** poslije restarta tick vidi praznu listu i ne pokreće ništa dok se tenant ne učita. A `load(tenantId)` se poziva iz `createJob`, `list`, `get`, `upsert` — dakle prvi `GET /v1/admin/jobs` (ili `POST /run`, ili ponovno kreiranje posla) „probudi" raspored. `createRobot` ne radi warm-up. |
| `active`, `runningJobs`, `maxConcurrent` | `src/scheduler/index.js` | Brojači se resetuju; posao koji je bio u toku se ne nastavlja (nema queue, nema replay-a). |
| `lease:{owner,until}` iz `jobs.json` | *preživljava kao fajl*, ali `owner` je stari PID | Ako je proces ubijen usred posla, lease blokira izvršenje do 60 s (`DEFAULT_LEASE_MS`), pa je posao „izgubljen" jedan ciklus. |
| rate-limit prozori | `rates` u `src/tenancy/store.js` | Poslije restarta limit kreće od nule (nije sigurnosni problem, jeste tačnost). |
| `heads` hash-lanca audita | `src/observability/audit.js` | Kešira se po tenantu (`tenantId → {seq, hash}`); poslije restarta prvi `append` učita zadnji zapis iz fajla — a `readJsonl` **čita cio fajl** pa reže rep (`src/core/fsx.js`), dakle inicijalizacija je O(veličina audit fajla), ne O(1). |
| Zahtjevi u toku (HTTP ili job) | proces | Prekidaju se; nema perzistentnog „in-flight" stanja, pa se ne nastavljaju automatski. |
| **Odobrenja koja čekaju** (`pendingApprovals` Map, TTL 24 h) | `src/server/routes.js` | Poslije restarta zahtjev za odobrenje **ne postoji** (`POST /v1/approvals/:runId` → 404). Nema fajla sa stanjem odobrenja. |
| Keš LLM-a i `overrides` u katalogu prije `load()` | `src/llm/*`, `src/agents/catalog.js` | Prazni; `load()` ih rekonstruiše iz `agents.json` (kad je agent `active`). |

---

## 5. Granice izolacije

Četiri nivoa, svaki nezavisan:

**1. Proces (jedan Node proces, više tenanta).** Izolacija je *logička*: `tenantId` je prvi argument
svake memorijske/alatne operacije, putanje su `data/tenants/<tenantId>/…`, a vektorski zapis nosi
`metadata.tenantId` koji se normalizuje pri upisu (`src/memory/vector.js`). Jedan proces znači: dijeljeni
heap, dijeljeni event loop, dijeljeni CPU. Greška u zajedničkom modulu može pogoditi sve tenant-e.

**2. Aplikativni sandbox (`src/core/sandbox.js`).** Nivoi `none | restricted | strict`. Šta tačno blokira:

- `assertNetwork(url)` — u `strict` **svaka** spoljna mreža je zabranjena; u `restricted` prolazi samo
  host sa `networkAllowlist` (prazan allowlist = zabranjeno sve, `PolicyError`);
  `http_fetch` zove `ctx.sandbox.assertNetwork(url)` čak i kad je alat već odobren od politike.
- `assertPath(target, {mode})` — `path.resolve` + provjera da je putanja unutar `fsReadRoots`/`fsWriteRoots`
  (izlaz preko `..` se odbija); u `strict` je svaki **upis** zabranjen.
- `scrubEnv(extra)` — podproces dobija samo `PATH`, `HOME`, `LANG`, `TZ`, `NODE_ENV`, ključeve iz
  `envAllowlist` i eksplicitni `extra`. Tajne hosta koje nisu na listi **ne** prelaze granicu
  (dokaz: `tests/max.test.mjs` — MCP probe ne vidi `NMQ_MASTER_KEY`).
- `assertCanSpawn(command)` — ako je `allowChildProcess:false`, pokretanje MCP podprocesa se odbija.
- `limits()` — `maxMemoryMb` i `maxTimeoutMs` (koristi ih MCP klijent pri `requestTimeoutMs`).
- Alat-level timeout: `withTimeout` u `src/tools/registry.js` (race sa `AbortController`, default 20 s).

⚠️ Dva iskrena detalja: (a) `config/tools.json` stavlja `SLACK_BOT_TOKEN`, `NOTION_TOKEN`, `GITHUB_TOKEN`,
`HUBSPOT_TOKEN`, `SHOPIFY_TOKEN`, `STRIPE_SECRET_KEY` **u `envAllowlist`** — to su tajne koje tada *jesu*
vidljive MCP podprocesu; lista je namjerna, ali je treba suziti po serveru. (b) `assertPath` se poziva iz
alata koji ga zovu; to nije OS-level zabrana (nema seccomp/namespaces).

**Provjereno u ovom okruženju (procesni nivo):** zakrpa kataloga nije per-tenant. Mjerenje sa mock LLM-om:

```
createRobot({ dataDir: <temp> })            // tenanti: nmq, demo-shop
controlPlane.deploy('nmq','support',{ patch:{ temperature: 0.9 } })
catalog.get('support').temperature          → 0.9
// isti proces, drugi tenant, bez ijedne njegove akcije:
catalog.get('support').temperature          → 0.9   (prije deploy-a bilo je 0.2)
```

`src/agents/catalog.js` drži `overrides` kao `Map<agentId, patch>` — **jednu** zakrpu po agentu za cio
proces. Zato `§8` (tačka 5) nije teorijska: multi-tenant deploy je danas **nesiguran** bez izmjene ključa
mape na `tenantId:agentId`. Izolacija **podataka** nije pogođena (memorija/audit/trošak ostaju po
`tenantId`); pogođena je izolacija **ponašanja** agenta.

**3. K8s (`infra/k8s/base/`).** `namespace.yaml` (Namespace `nmq-system` sa
`pod-security.kubernetes.io/enforce: restricted`, `ResourceQuota`, `LimitRange`), `deployment.yaml`
(`runAsNonRoot`, `runAsUser 1000`, `seccompProfile: RuntimeDefault`, `readOnlyRootFilesystem: true`,
`capabilities.drop: [ALL]`, `allowPrivilegeEscalation: false`, `automountServiceAccountToken: false`,
probe `/healthz` i `/readyz`, `replicas: 1`), `service.yaml` (ClusterIP + Ingress sa SSE-safe anotacijama
`proxy-buffering: off`, `proxy-read-timeout: 3600`), `configmap.yaml` (nesekretna konfiguracija +
`ExternalSecret`). **NetworkPolicy i per-tenant namespace šablon još ne postoje** (vidi §7).

**4. Baza (RLS, planirano).** `docs/02` §4 i `docs/05` §5 opisuju PostgreSQL RLS
(`current_setting('app.tenant_id')`, `set_config(..., true)`, rola bez `BYPASSRLS`). U kodu **nije
implementirano** — MVP je fajl-skladište (`DECISIONS.md` D7), a interfejsi (`VectorStore`, `SessionStore`)
su pripremljeni za zamjenu.

| Prijetnja | Koji nivo je blokira | Šta ostaje neblokirano |
|---|---|---|
| Agent pročita tuđe fajlove | Sandbox `assertPath` (+ fizičke putanje po tenantu) | Alat koji ne zove `assertPath`; symlink/TOCTOU; `level: 'none'` u produkciji |
| Agent izađe na proizvoljan domen (exfiltracija) | Sandbox `assertNetwork` + allowlist; `strict` zabranjuje sve | Alati koji ne prolaze kroz `http_fetch` (npr. MCP server sa sopstvenim mrežnim pristupom) |
| Tajne hosta dođu u podproces | Sandbox `scrubEnv` | Ključevi **koji su na `envAllowlist`** u `config/tools.json` (npr. `STRIPE_SECRET_KEY`) |
| Zloupotreba privilegija u kontejneru | K8s `securityContext` + `restricted` PSA + drop ALL | Kernel 0-day; nema gVisor/Firecracker (vidi §6) |
| Tenant potroši budžet drugog tenanta | Tenant budžet (`src/core/budget.js`) + per-agent budžet (`assertAgentBudget`) | Dijeljeni proces: jedan tenant može da zauzme event loop/CPU (nema cgroup po tenantu) |
| Tenant pozove agenta koji mu nije dozvoljen | `assertAgentAllowed` (`allowedAgents`) u `src/orchestration/index.js` | Direktan poziv `runAgent` iz koda (mimo orchestratora) — ne postoji preko API-ja |
| Alat visokog rizika bez odobrenja | `evaluate()` → `require_approval` + `assertAllowed` u `src/tools/registry.js` | `approvedTools` koji dospije iz pogrešnog run-a (provjera je po imenu alata, ne po argumentima) |
| MCP server vidi tuđe podatke | Ništa u kodu — MCP server je jedna instanca po procesu | MCP server nije tenant-aware; izolacija mu se mora zadati konfiguracijom (`cwd`, env, odvojen proces) |
| Modifikacija audit zapisa | Hash-lanac (`src/observability/audit.js` + `audit-verify`) | Nema WORM storage-a; onaj ko ima FS pristup može da prepiše cijeli fajl (lanac tada puca, ali ne sprječava) |
| Preuzimanje agent ključa | `sha256` + `safeEqual`, opoziv (`revokedAt`) | Agent ključ nije vezan na mrežu/identitet (nema mTLS, nema OIDC); nema IAM uslova po IP-u |

---

## 6. Odluke MAX nivoa (i alternative)

| Odluka | Alternativa | Zašto ovako |
|---|---|---|
| Vlastiti scheduler u procesu (`src/scheduler/index.js`) | Redis + BullMQ / Agenda / pg-boss | Nula infrastrukture i nula zavisnosti (D2); poslovi su već vezani na `tenantId` i fajl-stanje; tick od 1 s je dovoljan za agentske poslove. Cijena: nije distributed — vidi §8 |
| Fajl-lease (`lease:{owner,until}` u `jobs.json`) | Redis `SET NX PX` / Postgres `SELECT … FOR UPDATE` | Radi bez servera i dovoljno je za 1 repliku; lease sprečava duplo izvršavanje u istom procesu i daje 60 s zaštite. Cijena: nije atomski na nivou fajl-sistema (nema `flock`) |
| Kontrolna ravan **u istom procesu** (`src/controlplane/registry.js`) | Odvojen servis (REST/gRPC) + sopstvena baza | `assertAgentBudget` se poziva sinhrono u `orchestrator.run` — u-procesu je nula mrežnih skokova i nula dodatnih kvarova. Cijena: stanje nije deljeno između replika |
| Stanje u fajlu (`data/_control/agents.json`) | PostgreSQL (tabela `agents`, `agent_versions`, `agent_keys`) | MVP bez servera; `load()`/`persist()` je trivijalan; lako se backup-uje restic-om. Cijena: nema transakcija, nema konkurentnog upisa iz više procesa |
| **Globalni** `catalog.setOverride` (po `agentId`, ne po tenantu) | Override po `(tenantId, agentId)` | Implementirano je prostije i **to je poznato ograničenje**: `agents.json` čuva override po tenantu, ali `src/agents/catalog.js` ima samo `overrides: Map<agentId, patch>`. Deploy za jedan tenant mijenja agenta za sve tenant-e u tom procesu. Za pravi multi-tenant override treba `Map<tenantId:agentId, patch>` + tenant u `catalog.get(id, {tenantId})` |
| OTLP izvoz u **fajl** (`data/_global/otel-traces.jsonl`) + opcioni POST | OTel Collector kao obavezan servis | Radi bez kolektora i bez zavisnosti; kolektor se dodaje kasnije kao `filelog` receiver. Cijena: bez batching-a/retry-a i bez garantovanog prijema |
| Aplikativni sandbox (`src/core/sandbox.js`) | gVisor / Firecracker / seccomp profil po alatu | Radi na Hostingeru, Windows-u i VPS-u bez kernel podrške; daje jasnu grešku i sprječava najčešće zloupotrebe. Cijena: nije sigurnosna granica prema zlonamjernom kodu — zato K8s `restricted` + drop ALL |
| Audit u jednom append-only fajlu po tenantu | syslog/WORM/S3 Object Lock | `sha256` lanac + `audit-verify` dokazuju nepromjenljivost bez infrastrukture. Cijena: nema eksternog sidrenja hash-a (npr. dnevni hash u odvojenom store-u) |
| `node:http` micro-router | Express/Fastify | D3: nula zavisnosti; ruta je podatak (`{method, path, requiredRole, handler}`), pa je RBAC čitljiv iz tabele |
| Metrike u memoriji + `GET /metrics` | Prometheus klijent biblioteka | Format je tekst (`src/observability/metrics.js`); scrape radi bez zavisnosti. Cijena: nema histogram kvantila iz kutije (postoji `observe`) |

---

## 7. Kada prelaziti na Kubernetes

**Okidači (bilo koji je dovoljan):**

| Okidač | Konkretan prag | Zašto tada |
|---|---|---|
| Broj aktivnih tenanta | > 20 aktivnih tenanta **ili** > 3 tenant-a koja traže izolaciju resursa | Dijeljeni proces počinje da miješa CPU/event loop; `ResourceQuota`/`LimitRange` po namespace-u rješava „bučnog susjeda" |
| CPU / latencija | Prosječan CPU > 60% jednog jezgra ili p95 latencija run-a > 25 s | Horizontalno skaliranje API replika; ali tada **scheduler mora u zaseban Deployment sa 1 replikom** (komentar u `infra/k8s/base/deployment.yaml`) |
| Zahtjev klijenta za per-tenant izolacijom | Ugovor/DPA traži odvojen namespace, mrežnu politiku ili odvojen Secret | Per-tenant namespace + NetworkPolicy + ServiceAccount po agentu |
| On-prem / data residency | Klijent traži da podaci ne izlaze iz njegove infrastrukture | On-prem K8s (isti manifesti), `NMQ_DATA_DIR` na njegovom PVC-u, bez Cloudflare tunela |
| Potreba za cron/HPA/secret rotacijom | Traži se automatsko skaliranje ili rotacija tajni | `CronJob` (npr. `audit-verify`), `HPA`, `ExternalSecret` (već pripremljen u `configmap.yaml`) |
| Multi-region ili blue/green sa nula prekida | Zahtjev za rolling deploy bez preskakanja poslova | Deployment `strategy: RollingUpdate` sa `maxUnavailable: 0` (već postavljeno) + odvojen scheduler |

**Šta se mijenja u kodu kad se pređe:**

1. **Scheduler.** `store.tenantsWithJobs()` (in-memory `cache`) mora se zamijeniti čitanjem direktorijuma
   `data/tenants/*/jobs/jobs.json` pri startu, inače raspored ne radi u novom podu (§4). Za više replika:
   lease u Redis-u ili Postgres-u umjesto fajl-lease-a; `maxConcurrent` postaje pravi worker pool.
2. **Kontrolna ravan.** `persist()`/`load()` nad `agents.json` mora preći na Postgres (jedna instanca,
   optimističko zaključavanje po `updatedAt`), ili kontrolna ravan ostaje u jednom podu sa 1 replikom.
3. **Override po tenantu.** `src/agents/catalog.js` — `overrides` mapa dobija ključ `tenantId:agentId`
   i `catalog.get(id, { tenantId })`; bez toga per-tenant deploy ostaje nemoguć.
4. **Rate limit i sesije.** `src/tenancy/store.js` (`rates` Map) → Redis; inače limit važi po podu.
5. **MCP podprocesi.** U K8s su to kontejneri istog poda ili odvojeni servisi; `sandbox.scrubEnv` ostaje,
   ali se dodaje `NetworkPolicy` po namespace-u.
6. **Audit i trajanje.** PVC (već u `deployment.yaml`, `nmq-robot-data`, 10Gi) + `ReadWriteOnce` znači
   **jedna** replika koja piše; za više replika treba RWX ili baza.
7. **`infra/k8s/tenant-template/`** — dodati namespace, ServiceAccount, Role/RoleBinding, NetworkPolicy,
   ResourceQuota i Secret po klijentu (šablon je danas samo pomenut u komentaru `namespace.yaml`).

---

## 8. Ograničenja trenutne verzije

1. **Jedan proces.** API, scheduler, kontrolna ravan i MCP klijent žive u istom Node procesu; restart
   prekida sve u toku.
2. **Scheduler nije distributed-lock nego fajl-lease.** `lease:{owner: pid, until: now+60s}`; dva procesa
   nad istim `data/` direktorijumom mogu da se potuku (nema `flock`, nema atomskog `rename` protokola).
3. **Nema queue.** Dug zadatak drži HTTP konekciju ili scheduler slot; nema retry queue-a, DLQ-a, ni
   prioriteta između poslova.
4. **Restart „gubi" raspored dok se tenant ne učita** (`store.tenantsWithJobs()` je in-memory; vidi §4).
5. **Override u katalogu nije per-tenant** — deploy jednog klijenta mijenja agenta za sve tenant-e u procesu.
6. **Nema OIDC/SSO, ni mTLS, ni SCIM.** Tenant identitet je API ključ (hash); per-agent ključevi
   (`nmqa_…`) postoje u kontrolnoj ravni, ali **`src/server/http.js` ih ne koristi** — gateway zove samo
   `tenants.authenticate`, pa je `authenticateAgentKey` za sada dostupan programski i u testovima
   (`tests/max.test.mjs`), a ne kao način prijave na API.
7. **Nema K8s operatora, Helm charta, ni per-tenant namespace šablona**; `NetworkPolicy` ne postoji.
8. **Nema RLS-a** — izolacija baze je planirana (`docs/02` §4), trenutno je fizička po folderu.
9. **Odobrenja koja čekaju ne preživljavaju restart** (`pendingApprovals` je `Map` u `src/server/routes.js`,
   TTL 24 h) — poslije restarta `POST /v1/approvals/:runId` vraća 404.
10. **Nema dashboarda**; operater koristi `/v1/admin/*`, `journalctl` i `GET /metrics`.
11. **Cijene modela su konstanta u kodu** (`src/observability/cost.js`, `PRICING`) — moraju se ručno
    provjeravati; nema `data/_global/pricing.json` sa `checkedAt`.
12. **`process_update` dobija `jobId` iz konteksta** — scheduler ga prosljeđuje kroz
    `options.jobId` (+ `patternConfig.jobId`), a `src/orchestration/index.js` ga stavlja u
    `ctx.jobId = options.jobId ?? options.patternConfig?.jobId ?? null`. Alat i dalje prihvata
    `args.jobId` kao jači izvor (`args.jobId ?? ctx.jobId`), pa ručno pokretanje van joba mora
    proslijediti `jobId`.
13. **MCP HTTP zaglavlja se ne interpolišu** — `"Bearer ${NMQ_INTERNAL_MCP_TOKEN}"` u `config/tools.json`
    ostaje literalni string (`src/tools/mcp-http.js` ne radi interpolaciju env varijabli).
14. **Nema evaluacije kvaliteta** (zlatni set) i nema alert pravila, iako metrike postoje.
15. **Nema brisanja istorije/retention politike** za `traces/`, `usage/`, `runs-*.jsonl` — rastu dok se
    nešto ne obriše ručno.
16. **Broj ugrađenih alata je 20** (`src/tools/builtin.js`), a `DECISIONS.md` §7 tvrdi 21 — treba
    uskladiti jedan od dva dokumenta (kod je kanonski).

---

## Otvorena pitanja

1. Da li override u katalogu uvodimo per-tenant odmah (`Map<tenantId:agentId, patch>`) ili kontrolna
   ravan ostaje „jedan tenant = jedan proces" do v1? Prvo je tačnije, drugo je jeftinije.
2. Da li scheduler selimo u zaseban proces/Deployment (jedna replika) prije nego što uopšte uključimo
   više replika API-ja — ili uvodimo Redis lease odmah i držimo jedan Deployment?
3. Kako rješavamo „buđenje" poslova poslije restarta: warm-up skeniranjem `data/tenants/*/jobs/` pri
   `createRobot`, ili čitanjem direktorijuma u `tenantsWithJobs()`?
4. Da li per-agent ključ (`nmqa_…`) treba da bude prihvaćen i na HTTP gateway-u (uz `agentId` u kontekstu)
   ili ostaje samo za MCP servere i service account-e? Ako da — koja rola i koji `scopes` idu uz njega?
5. `envAllowlist` u `config/tools.json` trenutno propušta tajne (Slack/Stripe/GitHub) svakom MCP podprocesu.
   Da li taj spisak postaje **per-MCP-server** (`mcpServers[].envAllowlist`) i ko ga odobrava?
6. Kada uvodimo OTel Collector umjesto fajla i da li tada brišemo `data/_global/otel-traces.jsonl`
   (koji je u suprotnosti sa `DECISIONS.md` §6.3 — „nema `data/_global/` u MVP-u", ali ga OTel izvoz
   danas stvarno pravi)?
