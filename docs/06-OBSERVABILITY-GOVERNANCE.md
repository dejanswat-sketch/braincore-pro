# 06 — Observability i governance

> Svrha: definisati šta se loguje, kako se prati jedan run (trace/spanovi), koje metrike idu u Prometheus,
> kako se računa i naplaćuje trošak, kako rade politike, human-in-the-loop, hash-chained audit, alerti i dashboard.
> Usklađeno sa `docs/DECISIONS.md`: **D13** (6 patterna), **D14** (agenti iz `config/agents/*.json`), **D15** (governance: allow/deny,
> `riskLevel`, PII, budžet, rate limit, HITL), **D16** (trace + `/metrics` + cost tracker + hash-chained audit), **D7/D8** (JSONL u MVP-u, Postgres/Redis u produkciji),
> **D11/D12** (`tenant_id` obavezan, `data/tenants/<tenant_id>/`), **D18** (Docker/systemd/Cloudflare).
> Cijene modela se **nikad** ne tvrde kao činjenica — vidi sekciju 4 (`provjeriti kod providera`).
> U logove i metrike **nikad** ne idu vrijednosti ključeva/tokena — samo imena varijabli.

**Usklađenost sa susjednim dokumentima (provjereno):** putanje, imena tabela i imena fajlova preuzeti su iz `02-TECH-STACK.md`
(§4.1 layout, §4.2 DDL, §4.3 RLS); nazivi scope-ova (`approvals:decide`) i akcija u auditu (`handoff`, `router_decision`, `plan_trimmed`)
iz `04-ORCHESTRACIJA.md` i `08-SECURITY-COMPLIANCE.md`; taksonomija eventova i imena polja iz `05-MEMORIJA-RAG.md`.
Nazivi tabela koje ovaj dokument uvodi: `facts`, `approvals`, `policy_denials` — nisu u §4.2 i predlaže se njihovo dodavanje u kanonsku šemu.
Gdje se tabela ne uvodi, koristi se kanonska: `spans`/`traces` (ne `runs`), `cost_ledger` (ne `usage`), `audit_log` (ne `audit`).
Gdje kanonski DDL i ovaj dokument mogu da se razlikuju (kolone `events`), mjerodavan je `02-TECH-STACK.md` §4.2.

---

## 1. Šta logujemo

Svi zapisi su JSONL (jedan JSON po liniji, UTF-8 bez BOM, `\n`), append-only. Zajednička polja svakog zapisa:
`schemaVersion`, `ts` (ISO 8601 UTC), `tenantId`, `traceId`, `runId` (ako postoji), `spanId` (ako postoji), `level`.
`eventId` je `evt_` + ULID. Redoslijed polja nije ugovor; **imena polja jesu**.

| Event | Obavezna polja | Gdje ide (MVP) | Gdje ide (produkcija) | Retencija |
|---|---|---|---|---|
| `run` | `runId`, `tenantId`, `agentId`, `pattern`, `inputHash`, `status` (`started`/`ok`/`error`/`cancelled`/`awaiting_approval`), `startedAt`, `endedAt`, `durationMs`, `channel`, `sessionId`, `userId?` | `data/tenants/<id>/traces/<runId>.jsonl` (kanonski layout) | Postgres `spans` + `traces` | 365 dana |
| `step` | `runId`, `spanId`, `parentSpanId`, `name` (`router`/`plan`/`tool_select`/`llm`/`tool`/`rag`/`summarize`/`critic`), `status`, `durationMs`, `attempt`, `inputSummary`, `outputSummary` (max 512 znakova, redigovano) | `data/tenants/<id>/traces/<runId>.jsonl` | Postgres `spans` | 30 dana (puni spanovi), agregati trajno |
| `tool_call` | `runId`, `spanId`, `tool`, `riskLevel`, `scopes`, `argsRedacted`, `policyDecision` (`allow`/`deny`/`require_approval`), `source` (`builtin`/`mcp-stdio`/`mcp-http`), `attempt`, `approvedBy?` | `data/tenants/<id>/longterm/events.jsonl` (`type:"tool_call"`, vidi doc 05 §3.1) | Postgres `events` | 365 dana |
| `tool_result` | `runId`, `spanId`, `tool`, `status` (`ok`/`error`/`timeout`/`denied`), `durationMs`, `bytes`, `resultHash` (`sha256:`), `truncated`, `errorCode?`, `errorMessageRedacted?` | `data/tenants/<id>/longterm/events.jsonl` (`type:"tool_result"`) | Postgres `events` | 365 dana |
| `llm_call` | `runId`, `spanId`, `provider`, `model`, `purpose` (`answer`/`plan`/`summarize`/`extract`/`rerank`/`router`), `tokensIn`, `tokensOut`, `cachedTokens?`, `temperature`, `finishReason`, `durationMs`, `stream` (bool), `costUsdEst` | `data/tenants/<id>/traces/<runId>.jsonl` (span `llm`) | Postgres `spans` + `cost_ledger` | 365 dana (sirovi), 7 godina agregat |
| `error` | `runId?`, `spanId?`, `code` (`POLICY_DENIED`/`TOOL_TIMEOUT`/`LLM_ERROR`/`RATE_LIMIT`/`BUDGET_EXCEEDED`/`ISOLATION`/`VALIDATION`/`INTERNAL`), `message`, `stackHash` (`sha256:` prvih 5 linija stack-a), `retryable` (bool), `attempt` | `data/tenants/<id>/longterm/events.jsonl` (`kind:"error"`) + stderr logger | Postgres `events` + Sentry/Loki (opciono) | 90 dana (sirovi) |
| `approval` | `runId`, `tool`, `riskLevel`, `status` (`pending`/`approved`/`rejected`/`expired`), `requestedBy`, `approver?`, `decidedAt?`, `expiresAt`, `reason?`, `channel` (`email`/`slack`/`api`/`ui`), `argsRedacted` | `data/tenants/<id>/approvals/pending.jsonl` + `decided.jsonl` (putanja za potvrdu) | Postgres `approvals` + Redis queue za notifikacije | 365 dana (obavezno za reviziju) |
| `policy_denied` | `runId`, `agentId`, `tool`, `ruleId`, `reason`, `riskLevel`, `scopes`, `argsRedacted`, `userId?` | `data/tenants/<id>/longterm/events.jsonl` (`kind:"policy_denied"`) | Postgres `events` (za rate/abuse analizu) | 365 dana |
| `cost` | `tenantId`, `runId?`, `agentId`, `model`, `provider`, `tokensIn`, `tokensOut`, `embeddingTokens?`, `costUsd`, `pricingVersion`, `purpose` | `data/tenants/<id>/costs/YYYY-MM.json` (agregat; vidi §4) | Postgres `cost_ledger` (particionisano po mjesecu) | 7 godina (finansijski dokument) |
| `audit` | vidi §7 (hash-chained: `seq`, `prevHash`, `hash`, `actor`, `action`, `argsRedacted`, `outcome`) | `data/tenants/<id>/audit/YYYY-MM.jsonl` | Postgres `audit_log` (append-only, `REVOKE UPDATE/DELETE`) + dnevni WORM/sealed fajl | 7 godina (najmanje) |

**Pravila logovanja:**
- Nikad se ne loguje `content` cijelog prompta u produkcji (samo `inputHash` + `inputSummary` max 512 znakova, redigovano);
  pun prompt se loguje samo ako je `observability.capturePrompts=true` **i** tenant je to izričito uključio (uz PII redakciju).
- Svaki `argsRedacted` prolazi kroz `redactSecrets()`: imena/vrijednosti oblika `apiKey`, `token`, `password`, `secret`, `authorization`, `cookie`,
  kao i obrasci `sk-…`, `Bearer …`, `AKIA…`, `ghp_…`, `-----BEGIN … PRIVATE KEY-----` → `"[REDACTED]"`.
- Svaki zapis ima `tenantId`; ako `tenantId` nije poznat (npr. greška pri autentikaciji) → `tenantId: "unknown"` i zapis ide u globalni `data/_global/` (kanonski folder iz `02-TECH-STACK.md` §4.1).
- Log je append-only: nema `UPDATE`. Ispravka se radi novim zapisom (`tombstone`, vidi doc 05 §8); dozvoljen je i `type:"correction"` red (kanonski, §4.1).
- Jedan run = jedan `traceId`; svi zapisi tog runa nose isti `traceId` (omogućava `grep traceId` kroz sve fajlove).
- Rotacija: `traces/<runId>.jsonl` po runu, `audit/YYYY-MM.jsonl` i `costs/YYYY-MM.json` mjesečno (kanonski, §4.1); stariji mjeseci idu u `data/_archive/YYYY-MM/`; zapisi stariji od retencije se brišu `retention` job-om.

---

## 2. Trace i spanovi

### 2.1 Model

| Pojam | Značenje | Generiše |
|---|---|---|
| `traceId` | Jedan ulazni zahtjev kroz cijeli sistem (može sadržati više runova: npr. router → agent → subagent) | `src/core/ids.js#newTraceId()` (`tr_` + ULID) |
| `runId` | Jedno izvršavanje patterna (`POST /v1/agents/:agentId/run`) | `src/server/routes.js` (`r_` + ULID) |
| `spanId` | Jedna operacija unutar runa (LLM poziv, tool poziv, retrieve, planiranje) | `src/observability/trace.js#startSpan()` (`sp_` + ULID) |
| `parentSpanId` | Span koji je pokrenuo ovaj span (`null` za korijen runa) | `startSpan({ parent })` |
| `agentId` | Ko izvršava (`support`, `router`, `critic`, …) iz `config/agents/*.json` | Agent definicija |
| `pattern` | `router`/`sequential`/`orchestrator-worker`/`fanout-fanin`/`handoff`/`magentic` | `config/agents/<id>.json#pattern` |
| `attributes` | Proizvoljni parovi (`model`, `tool`, `k`, `chunks`, `riskLevel`, `approvalId`) — bez PII | Span |
| `status` | `ok` / `error` / `cancelled` / `awaiting_approval` | Span zatvaranje |

Pravila: span se **uvijek** zatvara (`finally`), čak i na grešci; trajanje je `Date.now()` delta (monotonični `performance.now()` u procesu);
dubina spanova max 32 (zaštita od rekurzije); LLM i tool spanovi su uvijek djeca `step` spana; span koji čeka odobrenje ostaje otvoren
sa `status:"awaiting_approval"` i mjeri se odvojeno (`approval_wait_seconds`).

### 2.2 Primjer JSON trace-a jednog `magentic` run-a

```jsonc
{
  "traceId": "tr_01J9F2K7QW3ZB4",
  "runId": "r_01J9F2M8TT1Q0C",
  "tenantId": "t_nmq",
  "agentId": "ops",
  "pattern": "magentic",
  "status": "awaiting_approval",
  "startedAt": "2026-09-29T08:11:02.100Z",
  "endedAt": "2026-09-29T08:12:00.400Z",
  "durationMs": 58300,
  "spans": [
    { "spanId": "sp_01", "parentSpanId": null,      "name": "run",         "status": "awaiting_approval", "durationMs": 58300,
      "attributes": { "inputHash": "sha256:a1b2", "sessionId": "s_01J9F2K7QW3ZB4", "channel": "api" } },
    { "spanId": "sp_02", "parentSpanId": "sp_01",   "name": "router",      "status": "ok", "durationMs": 820,
      "attributes": { "chosen": "ops", "alternatives": ["support","data"], "model": "router" } },
    { "spanId": "sp_03", "parentSpanId": "sp_01",   "name": "plan",        "status": "ok", "durationMs": 1740,
      "attributes": { "steps": 4, "model": "planner", "tokensIn": 1180, "tokensOut": 240 } },
    { "spanId": "sp_04", "parentSpanId": "sp_03",   "name": "rag.retrieve","status": "ok", "durationMs": 96,
      "attributes": { "k": 8, "returned": 3, "minScore": 0.25, "mode": "hybrid" } },
    { "spanId": "sp_05", "parentSpanId": "sp_03",   "name": "tool_call",   "status": "ok", "durationMs": 674,
      "attributes": { "tool": "orders.get", "riskLevel": "low", "policyDecision": "allow", "source": "builtin" } },
    { "spanId": "sp_06", "parentSpanId": "sp_03",   "name": "llm.answer",  "status": "ok", "durationMs": 2410,
      "attributes": { "model": "answer", "tokensIn": 3120, "tokensOut": 260, "finishReason": "tool_calls", "stream": true } },
    { "spanId": "sp_07", "parentSpanId": "sp_06",   "name": "tool_call",   "status": "awaiting_approval", "durationMs": 45560,
      "attributes": { "tool": "refunds.create", "riskLevel": "high", "policyDecision": "require_approval",
                      "approvalId": "ap_01J9F2MC", "waitMs": 45560 } }
  ],
  "usage": { "tokensIn": 4300, "tokensOut": 500, "embeddingTokens": 0, "costUsdEst": 0.0041, "pricingVersion": "2026-09-01" },
  "approvals": [ { "approvalId": "ap_01J9F2MC", "tool": "refunds.create", "status": "pending",
                   "expiresAt": "2026-09-30T08:12:00.000Z", "channel": "slack" } ],
  "summary": "ops: provjeri porudžbinu ORD-99120, pripremi refund, čeka odobrenje (visok rizik)"
}
```

Napomena: `costUsdEst` u trace-u je procjena za prikaz; tačan iznos za naplatu je `costUsd` u `costs/cost-ledger.jsonl`
(kanonski `cost_ledger.usd`). Trace je za debug, ledger je za fakturu — nikad se ne naplaćuje iz trace-a.
Isti run se u `04-ORCHESTRACIJA.md` pojavljuje kao `pattern(...) -> { output, steps[], usage, cost, traceId, approvals[] }`:
`steps[]` = `spans[]` iz JSONL-a, `cost` = `usage.costUsdEst`, `approvals[]` = istoimeni blok.

### 2.3 Kako se prikazuje

- **Waterfall** u UI-u: svaki span je red; `margin-left = dubina × 16px`; širina = `durationMs` proporcionalno ukupnom trajanju runa;
  boja po `status` (zeleno `ok`, crveno `error`, žuto `awaiting_approval`, sivo `cancelled`); isprekidana traka za `waitMs` odobrenja
  (vizuelno odvojeno od rada — čekanje čovjeka nije latencija sistema).
- Klik na span otvara `attributes` (bez PII), `inputSummary`/`outputSummary`, kao i linkove: `events?runId=…`, `usage?runId=…`, `audit?runId=…`.
- API: `GET /v1/runs/:runId` vraća isti JSON (strogo po `tenantId` iz konteksta; `404` ako run nije tog tenanta — ne `403`, da se ne otkriva postojanje).
- MVP UI: jedan HTML fajl u `public/` koji čita `GET /v1/runs/:runId` i renderuje waterfall (bez build koraka, D2).
- Export: `GET /v1/runs/:runId?format=otlp` (v2) → OpenTelemetry spans za prikaz u Tempo/Jaeger.

---

## 3. Metrike

Format: Prometheus text na `GET /metrics` (`text/plain; version=0.0.4`). Bez zavisnosti — generiše `src/observability/metrics.js` ručno.
Svaka metrika ima `HELP` i `TYPE`. Labelе su ograničene na **poznat skup vrijednosti** (kardinalnost!): `tenant`, `agent`, `model`, `tool`, `status`, `pattern`, `provider`, `code`.
Zabranjeno je stavljati `runId`, `sessionId`, `userId` u labele (eksplozija kardinalnosti) — to ide u log/trace.

```
# HELP nmq_runs_total Ukupan broj runova po tenantu/agentu/patternu i statusu
# TYPE nmq_runs_total counter
nmq_runs_total{tenant="t_nmq",agent="support",pattern="router",status="ok"} 1842
nmq_runs_total{tenant="t_nmq",agent="support",pattern="router",status="error"} 7
nmq_runs_total{tenant="t_nmq",agent="ops",pattern="magentic",status="awaiting_approval"} 12

# HELP nmq_run_duration_seconds Trajanje runa (bez čekanja na odobrenje)
# TYPE nmq_run_duration_seconds histogram
nmq_run_duration_seconds_bucket{tenant="t_nmq",agent="support",le="0.5"} 320
nmq_run_duration_seconds_bucket{tenant="t_nmq",agent="support",le="1"} 910
nmq_run_duration_seconds_bucket{tenant="t_nmq",agent="support",le="2.5"} 1500
nmq_run_duration_seconds_bucket{tenant="t_nmq",agent="support",le="8"} 1830
nmq_run_duration_seconds_bucket{tenant="t_nmq",agent="support",le="+Inf"} 1849
nmq_run_duration_seconds_sum{tenant="t_nmq",agent="support"} 2314.7
nmq_run_duration_seconds_count{tenant="t_nmq",agent="support"} 1849

# HELP nmq_tokens_total Potrošeni tokeni po smjeru, modelu i namjeni
# TYPE nmq_tokens_total counter
nmq_tokens_total{tenant="t_nmq",model="deepseek-chat",direction="in",purpose="answer"} 5120433
nmq_tokens_total{tenant="t_nmq",model="deepseek-chat",direction="out",purpose="answer"} 812004
nmq_tokens_total{tenant="t_nmq",model="summarizer",direction="in",purpose="summarize"} 40211

# HELP nmq_cost_usd_total Procijenjeni trošak u USD (po tarifi pricingVersion)
# TYPE nmq_cost_usd_total counter
nmq_cost_usd_total{tenant="t_nmq",agent="support",model="deepseek-chat",provider="deepseek"} 41.82
nmq_cost_usd_total{tenant="t_nmq",agent="ops",model="summarizer",provider="openai-compatible"} 2.10

# HELP nmq_tool_calls_total Broj poziva alata po ishodu
# TYPE nmq_tool_calls_total counter
nmq_tool_calls_total{tenant="t_nmq",tool="orders.get",status="ok",source="builtin"} 8891
nmq_tool_calls_total{tenant="t_nmq",tool="refunds.create",status="awaiting_approval"} 12

# HELP nmq_tool_errors_total Greške alata (error/timeout/denied)
# TYPE nmq_tool_errors_total counter
nmq_tool_errors_total{tenant="t_nmq",tool="crm.search",code="TOOL_TIMEOUT"} 23
nmq_tool_errors_total{tenant="t_nmq",tool="mail.send",code="POLICY_DENIED"} 4

# HELP nmq_policy_denied_total Blokirane akcije po pravilu politike
# TYPE nmq_policy_denied_total counter
nmq_policy_denied_total{tenant="t_nmq",agent="support",tool="files.delete",rule="deny_high_risk"} 6

# HELP nmq_approvals_pending Broj odobrenja koja čekaju (gauge)
# TYPE nmq_approvals_pending gauge
nmq_approvals_pending{tenant="t_nmq",riskLevel="high"} 3
nmq_approvals_pending{tenant="t_nmq",riskLevel="medium"} 1

# HELP nmq_llm_calls_total Broj LLM poziva po namjeni i ishodu
# TYPE nmq_llm_calls_total counter
nmq_llm_calls_total{tenant="t_nmq",model="deepseek-chat",purpose="answer",status="ok"} 9204
nmq_llm_calls_total{tenant="t_nmq",model="deepseek-chat",purpose="answer",status="error"} 31

# HELP nmq_errors_total Greške po kodu
# TYPE nmq_errors_total counter
nmq_errors_total{tenant="t_nmq",code="LLM_ERROR",retryable="true"} 44

# HELP nmq_pricing_missing_total Pozivi čiji model nije u data/_global/pricing.json (trošak se ne može izračunati)
# TYPE nmq_pricing_missing_total counter
nmq_pricing_missing_total{tenant="t_nmq",model="unknown-model",provider="openai-compatible"} 3

# HELP nmq_approval_requested_timestamp_seconds Unix vrijeme najstarijeg otvorenog zahtjeva za odobrenje (za "čeka > 24h")
# TYPE nmq_approval_requested_timestamp_seconds gauge
nmq_approval_requested_timestamp_seconds{tenant="t_nmq",riskLevel="high"} 1791000000

# HELP nmq_rag_retrieve_seconds Latencija RAG retrieve koraka
# TYPE nmq_rag_retrieve_seconds histogram
nmq_rag_retrieve_seconds_bucket{tenant="t_nmq",mode="hybrid",le="0.3"} 1780
nmq_rag_retrieve_seconds_bucket{tenant="t_nmq",mode="hybrid",le="+Inf"} 1902

# HELP nmq_approval_wait_seconds Koliko je run čekao na odluku čovjeka
# TYPE nmq_approval_wait_seconds histogram
nmq_approval_wait_seconds_bucket{tenant="t_nmq",riskLevel="high",le="3600"} 9
nmq_approval_wait_seconds_bucket{tenant="t_nmq",riskLevel="high",le="+Inf"} 12

# HELP nmq_budget_used_ratio Iskorišćenost budžeta tenanta u tekućem mjesecu (0..1)
# TYPE nmq_budget_used_ratio gauge
nmq_budget_used_ratio{tenant="t_nmq",period="2026-09",kind="usd"} 0.42

# HELP nmq_up Da li servis radi (1) i verzija build-a
# TYPE nmq_up gauge
nmq_up{version="0.1.0",commit="dev"} 1
```

**Labelе (dozvoljen skup):** `tenant`, `agent`, `model`, `provider`, `tool`, `status`, `code`, `pattern`, `direction`, `purpose`, `riskLevel`, `source`, `mode`, `period`, `kind`, `retryable`, `version`, `commit`.
**Zabranjeno u labelama:** `runId`, `sessionId`, `userId`, `traceId`, slobodan tekst, URL, email.

### SLO (ciljevi, ne garancije)

| SLO | Cilj | Mjeri se | Šta se radi ako se prekrši |
|---|---|---|---|
| Chat latencija (prvi token / cijeli odgovor) | **p95 < 8 s** za `support` chat bez `high` rizika | `nmq_run_duration_seconds` histogram, `histogram_quantile(0.95, …)` | Alert (sekcija 8); provjera RAG/rerank latencije i veličine prompta |
| Stopa greške | **< 1%** runova sa `status="error"` u 15 min | `nmq_runs_total{status="error"}` / ukupno | Alert P1; ako je izvor provider → failover na drugi model iz config-a |
| `high` rizik bez odobrenja | **0** izvršenih akcija bez `approval.status="approved"` | audit lanac + `nmq_tool_calls_total{status="awaiting_approval"}` | P0 incident: blokada alata za tenanta, revizija politike |
| Policy bypass | **0** poziva alata koji nije prošao `evaluate()` | test `policy.test.mjs` + `nmq_policy_denied_total` | P0: stop izdanja, popravka odmah |
| Metrike dostupnost | `/metrics` 99.9% | scrape target up | Alert P2 |
| Odobrenja | **< 5%** `high` akcija čeka > 24 h | `nmq_approvals_pending` + `nmq_approval_wait_seconds` | Eskalacija (sekcija 6) |

---

## 4. Cost tracking i naplata

### 4.1 Cijena (nikad hardkodovana kao činjenica)

Cijene **nisu** dio koda kao tvrdnja. Drže se u `data/_global/pricing.json` (kanonski: `02-TECH-STACK.md` §4.1) sa `pricingVersion` (npr. `2026-09-01`) i
**obavezno se provjeravaju kod providera** prije svake izmjene:

| Model (primjer oznake) | Provider | Cijena input / 1M tokena | Cijena output / 1M tokena | Gdje se provjerava |
|---|---|---|---|---|
| `deepseek-chat` | DeepSeek | **provjeriti kod providera** | **provjeriti kod providera** | zvanična pricing stranica DeepSeek API-ja + odgovor `usage` u API-ju |
| `deepseek-reasoner` | DeepSeek | **provjeriti kod providera** | **provjeriti kod providera** | isto |
| `embedder` (openai-compatible) | zavisno od config-a | **provjeriti kod providera** | n/a | pricing stranica izabranog providera embeddinga |
| `summarizer` (mali model) | zavisno od config-a | **provjeriti kod providera** | **provjeriti kod providera** | isto |
| `mock` | interno | 0 | 0 | nije primjenjivo (test/demo) |

Pravila: (1) svaka izmjena cijene = nova `pricingVersion`, stari zapisi zadržavaju svoju verziju (istorija se ne prepisuje);
(2) ako `usage` iz API-ja stigne sa stvarnim brojem tokena — **vjeruj njemu**, ne vlastitoj procjeni;
(3) periodično (mjesečno) uporedi izračunat trošak sa stvarnim računom providera i zabilježi odstupanje u `costs/reconciliation.jsonl`;
(4) cijene se **nikad** ne navode u dokumentaciji kao važeće bez datuma provjere.

**Gdje se cijena upisuje i gdje se provjerava:** jedini izvor istine za izračun je `data/_global/pricing.json`
(`{ "<model>": { "priceIn", "priceOut", "priceCachedIn", "priceEmbed", "provider", "checkedAt", "sourceUrl" } }`).
`checkedAt` je datum kada je vrijednost **provjerena kod providera** (zvanična pricing stranica iz kolone „Gdje se provjerava"),
`sourceUrl` je link na tu stranicu. Bez `checkedAt` starijeg od 90 dana → `pricing_stale` upozorenje u logu i na dashboardu.
Vrijednosti se nikad ne prepisuju „po sjećanju" — samo iz izvora, sa novim `pricingVersion` i zapisom u audit (`action:"pricing.update"`).

### 4.2 Formula

```
costUsd = tokensIn  / 1_000_000 * priceIn(model)
        + tokensOut / 1_000_000 * priceOut(model)
        + embeddingTokens / 1_000_000 * priceEmbed(model)
        + cachedTokens / 1_000_000 * priceCachedIn(model)     // ako provider naplaćuje keširani input drugačije
cachedTokens se NE sabira u tokensIn (inače duplo naplaćivanje)
```

Zaokruživanje: trošak po pozivu se čuva sa 8 decimala, agregati sa 6; prikaz korisniku na 2 decimale.
Cijena se računa **po pozivu** i vezuje za `tenantId` + `agentId` + `model` + `purpose` (DECISIONS DoD #5).
Ako model nije u `data/_global/pricing.json` → `costUsd = null`, zapis dobija `pricingMissing: true`, metrika `nmq_pricing_missing_total` raste i **ne** pogađa se cijena (kanonski: `cost_ledger.usd` je `NULL`, `02-TECH-STACK.md` §4.2).

### 4.3 Gdje se akumulira

```
data/tenants/<tenantId>/costs/
  cost-ledger.jsonl          # sirovi cost eventi (append-only, jedan po LLM/embedding pozivu)
  YYYY-MM.json               # mjesečni agregat (kanonski, §4.1): totals{}, byAgent{}, byModel{}, budget{}
  rollup-daily.jsonl         # { date, agentId, model, tokensIn, tokensOut, costUsd, runs }
  limits.json                # { softLimitUsd, hardLimitUsd, period, action }
  frozen/<period>.json       # zaključan mjesec (hash u audit) — poslije se ne mijenja
  reconciliation.jsonl       # poređenje sa računom providera (mjesečno)
data/_global/pricing.json    # tabela cijena svih modela (kanonski: §4.1)
```

Primjer sirovog zapisa i mjesečnog agregata:

```jsonc
// costs/cost-ledger.jsonl
{ "schemaVersion":1,"ts":"2026-09-29T08:11:12.500Z","tenantId":"t_nmq","traceId":"tr_01J9F2K7","runId":"r_01J9F2M8TT1Q0C",
  "agentId":"support","provider":"deepseek","model":"deepseek-chat","purpose":"answer",
  "tokensIn":3120,"tokensOut":260,"cachedTokens":0,"pricingVersion":"2026-09-01","costUsd":0.00041200 }

// costs/2026-09.json
{ "period":"2026-09","totals":{"runs":1849,"tokensIn":5120433,"tokensOut":812004,"costUsd":41.820000},
  "byAgent":{"support":{"costUsd":31.10},"ops":{"costUsd":8.44},"router":{"costUsd":2.28}},
  "byModel":{"deepseek-chat":{"costUsd":39.72},"summarizer":{"costUsd":2.10}},
  "budget":{"limitUsd":100.0,"usedRatio":0.4182,"state":"ok"} }
```

Rollup se pravi inkrementalno (na svakom `cost` eventu ažurira se dnevni i mjesečni zapis) i **rekonsoliduje** jednom dnevno
(3:00 po lokalnom vremenu servera) iz `cost-ledger.jsonl` — da inkrementalna greška ne ostane trajna.

### 4.4 Faktura

1. Na kraju mjeseca (1. u mjesecu u 02:00) `scripts/billing.mjs` uzima `costs/<period>.json` za svaki tenant.
2. Naplata po formuli iz ugovora: `fiksna pretplata + usage (costUsd × marža)` ili `usage + marža` — marža iz `config/tenants.json` (`billing.margin`), **ne** u kodu.
3. Generiše se `invoice-<tenant>-<period>.json` + PDF/HTML za slanje; stavke: agent, model, tokeni, količina, cijena, iznos.
4. `costs/frozen/<period>.json` se zaključava (hash u audit) — poslije toga se istorija ne mijenja; ispravke idu kao `credit` stavka.
5. Ako je tenant na `self-hosted` licenci — faktura je samo izvještaj (`reportOnly: true`), bez naplate.

### 4.5 Limiti po tenantu

```jsonc
// data/tenants/<tenantId>/costs/limits.json
{ "schemaVersion":1,"period":"month","softLimitUsd":80.0,"hardLimitUsd":100.0,"dailySoftLimitUsd":8.0,
  "softAction":"warn","hardAction":"block","graceUsd":5.0,"notify":["email","slack"] }
```

| Stanje | Prag | Šta se dešava |
|---|---|---|
| `ok` | `usedRatio < 0.8` | ništa |
| `soft` | `0.8 ≤ usedRatio < 1.0` | upozorenje vlasniku tenanta (mejl) + `nmq_budget_used_ratio` alert; agent radi normalno, u log ide `error.code="BUDGET_SOFT"` |
| `hard` | `usedRatio ≥ 1.0` | **blokada novih runova** za taj tenant: `POST /v1/agents/:id/run` → `402 { "error":"budget_exceeded", "period":"2026-09" }`; tekući runovi se dovršavaju |
| `grace` | u toku je `high` rizik akcija ili pravni rok | dozvoljeno do `graceUsd` iznad limita (samo ako `hardAction="block_with_grace"`) |

Blokada je **po tenantu**, ne globalna; admin može privremeno podići limit (`PATCH /v1/tenants/:id/costs/limits`, scope `admin:write`, upis u audit).
Nikad se ne blokira `/healthz`, `/readyz`, `/metrics`, ni `POST /v1/approvals/:runId` (čovjek mora moći završiti započeto).

---

## 5. Governance politike

### 5.1 Šema politike (JSON)

```jsonc
{
  "schemaVersion": 1,
  "tenantId": "t_nmq",
  "defaults": { "decision": "deny", "riskRequiresApproval": ["high"], "rateLimitPerMin": 60, "maxTokensPerRun": 60000 },
  "agents": {
    "support": {
      "enabled": true,
      "allow": ["orders.*", "kb.search", "refunds.*", "mail.send"],
      "deny": ["files.delete", "db.raw", "shell.*"],
      "tools": {
        "refunds.create": { "riskLevel": "high", "requiresApproval": true, "maxAmount": { "value": 20000, "currency": "RSD" }, "scopes": ["refunds:write"] },
        "mail.send":      { "riskLevel": "high", "requiresApproval": true, "allowDomains": ["@nmq.local"] }
      },
      "budget": { "usdPerDay": 10.0, "tokensPerDay": 2000000 },
      "workingHours": { "tz": "Europe/Belgrade", "mon_fri": "08:00-20:00", "sat": "10:00-16:00", "sun": null, "outsideAction": "queue" },
      "pii": { "redactBeforeLlm": true, "redactBeforeEmbed": true, "patterns": ["email","phone","jmbg","card","iban","secret"] },
      "dataScopes": ["orders:read", "kb:read", "refunds:write"],
      "forbiddenActions": ["export_all_customers", "delete_account", "change_pricing", "send_mass_mail"]
    }
  }
}
```

Značenje ključnih polja:

| Polje | Efekat |
|---|---|
| `defaults.decision` | Fail-closed: alat koji nije eksplicitno dozvoljen → `deny` |
| `allow` / `deny` | Glob uzorci (`orders.*`); **`deny` pobjeđuje `allow`** bez izuzetka |
| `riskLevel` | `low`/`medium`/`high`; dolazi iz tool definicije (`tool.riskLevel`), politika ga može **samo pooštriti** (`low`→`high`), nikad ublažiti |
| `requiresApproval` | Forsira HITL i kad `riskLevel` nije `high` |
| `scopes` | Dodatni uslov: korisnik/sesija mora imati sve navedene scope-ove |
| `budget` | Tvrdi limit po agentu; prekoračenje → `BUDGET_EXCEEDED` (ne blokira cijeli tenant) |
| `workingHours` | `outsideAction`: `queue` (izvrši u prvom terminu), `deny`, `allow` (npr. support 24/7) |
| `pii` | Redakcija prije slanja LLM-u i prije embedovanja |
| `dataScopes` | Maksimalni skup podataka koji agent smije čitati (mapira se na `acl` u RAG-u, doc 05 §8) |
| `forbiddenActions` | Imenovane akcije koje **nijedan** alat ne smije izvesti, ni sa odobrenjem |

### 5.2 Primjer `config/policies.json` sa 2 tenanta

```jsonc
{
  "schemaVersion": 1,
  "policies": {
    "t_nmq": {
      "defaults": { "decision": "deny", "riskRequiresApproval": ["high"], "rateLimitPerMin": 120, "maxTokensPerRun": 60000 },
      "agents": {
        "support": {
          "enabled": true,
          "allow": ["orders.*", "kb.search", "refunds.create", "mail.send"],
          "deny": ["files.delete", "shell.*", "db.raw"],
          "tools": {
            "refunds.create": { "riskLevel": "high", "requiresApproval": true, "maxAmount": { "value": 20000, "currency": "RSD" } },
            "mail.send": { "riskLevel": "high", "requiresApproval": true, "allowDomains": ["@nmq.local"] }
          },
          "budget": { "usdPerDay": 10.0, "tokensPerDay": 2000000 },
          "workingHours": { "tz": "Europe/Belgrade", "mon_fri": "08:00-20:00", "sat": "10:00-16:00", "sun": null, "outsideAction": "queue" },
          "pii": { "redactBeforeLlm": true, "redactBeforeEmbed": true },
          "dataScopes": ["orders:read", "kb:read", "refunds:write"],
          "forbiddenActions": ["export_all_customers", "delete_account"]
        },
        "legal": {
          "enabled": true,
          "allow": ["kb.search", "docs.read", "contracts.draft"],
          "deny": ["mail.send", "crm.write", "refunds.*"],
          "tools": { "contracts.draft": { "riskLevel": "high", "requiresApproval": true } },
          "budget": { "usdPerDay": 5.0, "tokensPerDay": 800000 },
          "workingHours": { "tz": "Europe/Belgrade", "mon_fri": "09:00-17:00", "sat": null, "sun": null, "outsideAction": "deny" },
          "pii": { "redactBeforeLlm": true, "redactBeforeEmbed": true, "citationsRequired": true },
          "dataScopes": ["kb:read", "legal:read"],
          "forbiddenActions": ["delete_account", "change_pricing"]
        }
      }
    },
    "t_demo": {
      "defaults": { "decision": "deny", "riskRequiresApproval": ["high"], "rateLimitPerMin": 20, "maxTokensPerRun": 8000 },
      "agents": {
        "support": {
          "enabled": true,
          "allow": ["kb.search", "orders.get"],
          "deny": ["refunds.*", "mail.send", "files.*", "shell.*", "db.*"],
          "tools": {},
          "budget": { "usdPerDay": 1.0, "tokensPerDay": 100000 },
          "workingHours": { "tz": "Europe/Belgrade", "mon_fri": "00:00-23:59", "sat": "00:00-23:59", "sun": "00:00-23:59", "outsideAction": "deny" },
          "pii": { "redactBeforeLlm": true, "redactBeforeEmbed": true },
          "dataScopes": ["kb:read", "orders:read"],
          "forbiddenActions": ["export_all_customers", "delete_account", "change_pricing", "send_mass_mail"]
        }
      }
    }
  }
}
```

Napomena: u `t_demo` nema akcija sa `high` rizikom — demo tenant može samo čitati. Time je demo siguran po default-u.
Politike **ne sadrže tajne**: samo imena scope-ova i limita; kredencijali alata dolaze iz DSH store-a (`get-key.mjs`) pri izvršavanju.

### 5.3 Algoritam odlučivanja

```
evaluate(policy, action) -> "allow" | "deny" | "require_approval"

ulaz:
  action = { tenantId, agentId, tool, args, riskLevel, scopes[], sessionId, userId, amount? }
  ctx    = { now, tenantBudget, agentBudget, rateCounter, workingHours, approvalCache }

1. tenant = policy.policies[action.tenantId]
   ako tenant ne postoji            -> deny("unknown_tenant")

2. agent = tenant.agents[action.agentId]
   ako agent ne postoji             -> deny("unknown_agent")
   ako agent.enabled != true        -> deny("agent_disabled")

3. ako action.tool ∈ tenant.forbiddenActions ili agent.forbiddenActions
                                    -> deny("forbidden_action")           # nepopravljivo, čak i uz odobrenje

4. ako match(action.tool, agent.deny)       -> deny("explicit_deny")      # deny pobjeđuje allow
   ako NOT match(action.tool, agent.allow)  -> deny("not_allowed")        # fail-closed (defaults.decision=deny)

5. risk = max(action.riskLevel, agent.tools[tool].riskLevel)              # politika samo pooštava
   ako risk == "high" i NOT agent.enabled_high_risk -> deny("high_risk_disabled")

6. required = agent.tools[tool].scopes ?? []
   ako NOT subset(required, action.scopes) -> deny("missing_scope:" + prvi koji fali)

7. ako agent.tools[tool].maxAmount i action.amount > maxAmount
                                    -> require_approval("amount_over_limit")   # čovjek, ne automatska blokada

8. pii: ako zahtjev nosi PII i agent.pii.redactBeforeLlm
                                    -> transformiši args (redakcija), nastavi

9. workingHours: ako now nije u agent.workingHours
     outsideAction == "deny"        -> deny("outside_hours")
     outsideAction == "queue"       -> require_approval("outside_hours_queue")  # ili queue u scheduler

10. rate limit: ako rateCounter(tenant,agent) > defaults.rateLimitPerMin
                                    -> deny("rate_limited")

11. budžet: ako tenantBudget.usedRatio >= 1.0  -> deny("budget_exceeded")
            ako agentBudget.usedUsd >= agent.budget.usdPerDay -> deny("agent_budget_exceeded")
            ako tenantBudget.usedRatio >= 0.8 -> zabilježi "BUDGET_SOFT" (upozorenje, nastavi)

12. ako risk == "high" ILI agent.tools[tool].requiresApproval
                                    -> require_approval("high_risk")

13. allow("ok")

svaki izlaz se loguje: policy_denied (za deny) ili audit (za allow/require_approval)
redoslijed je obavezan — deny provjere (3,4) idu PRIJE budžeta i odobrenja
```

Invarijante: `evaluate()` je **čista funkcija** nad politike + `ctx` (isti ulaz → isti izlaz), bez mreže i bez LLM-a;
svaki tool poziv u sistemu ide kroz `evaluate()` — nema „internog" poziva koji ga preskače (test to dokazuje);
`require_approval` **ne** izvršava alat, samo otvara `approval` zapis i pauzira run.

---

## 6. Human-in-the-loop

### 6.1 Kada se traži odobrenje

| Uslov | Primjer | Zašto čovjek |
|---|---|---|
| `riskLevel == "high"` | `refunds.create`, `files.delete`, `db.raw`, `contracts.draft` | Nepovratna ili skupa akcija |
| Akcija prelazi limit iz `maxAmount` | refund > 20.000 RSD | Finansijski rizik |
| Slanje spolja | `mail.send`, `slack.post`, `webhook.*` na eksterni domen koji nije u `allowDomains` | Reputacija, neželjena komunikacija |
| Pravni tekst | `legal` agent generiše ugovor/ponudu/izjavu | Pravna odgovornost |
| Brisanje podataka | `delete_*`, GDPR zahtjevi, brisanje dokumenata | Nepovratno |
| Promjena konfiguracije | `config.write`, `policy.update`, `pricing.update` | Sigurnost sistema |
| Van radnog vremena uz `outsideAction="queue"` | akcija u 03:00 | Poslovno pravilo, ne sigurnost |
| Anomalija | alat 3× zaredom greška, ili neobično velik broj poziva | Zaštita od petlje/abusа |

Nikad se ne traži odobrenje za: `kb.search`, `orders.get`, `docs.read`, i sve `riskLevel="low"` **osim** ako politika izričito traži.

### 6.2 Tok

```
[1] agent odluči tool koji traži odobrenje
[2] evaluate() -> require_approval
[3] run PAUZIRA (status "awaiting_approval"); stanje se serijalizuje u session/run snapshot
      - upis: approvals/pending.jsonl { approvalId, runId, tenantId, tool, argsRedacted, riskLevel, expiresAt }
      - upis: audit { action: "approval_requested", actor: agent, outcome: "pending" }
      - metrika: nmq_approvals_pending{riskLevel}++ ; span ostaje otvoren (status awaiting_approval)
      - SSE događaj klijentu: event: step { "status":"awaiting_approval", "approvalId":"ap_..." }
[4] notifikacija (paralelno, prva koja uspije je dovoljna):
      - mejl: SMTP_* iz DSH store-a; primaoci iz politike tenanta (approvers[])
      - Slack: SLACK_WEBHOOK_URL (ime ključa, ne vrijednost); blok sa dugmadima Approve/Reject
      - UI/dashboard: badge "Čekajuća odobrenja"
      - notifikacija sadrži: koji agent, koji alat, redigovane argumente, iznos, rok, link na odluku, runId
[5] odluka:  POST /v1/approvals/:runId   { "approvalId":"ap_...", "decision":"approve"|"reject", "reason":"..." }
      - autorizacija: korisnik mora imati scope `approvals:decide` (kanonski: `08-SECURITY-COMPLIANCE.md`) i pripadati tenantu (RLS + provjera)
      - idempotentno po approvalId (dvostruki klik ne izvršava dva puta)
[6a] approve -> run se NASTAVLJA od tačke pauze: alat se izvršava sa ISTIM argumentima (hash argumenata se provjerava prije izvršenja)
        - upis: tool_call { approvedBy, approvalId } + tool_result + nastavak patterna
        - audit { action: "approval_granted", actor: <korisnik>, outcome: "approved" }
[6b] reject  -> run se završava sa status "ok" i output-om koji objašnjava odbijanje korisniku (ne "error" — sistem je radio ispravno)
        - audit { action: "approval_rejected", actor: <korisnik>, outcome: "rejected" }
        - agent dobija poruku: "akcija odbijena, predloži alternativu bez te akcije"
[7] metrika: nmq_approvals_pending-- ; nmq_approval_wait_seconds observe(waitMs)
```

### 6.3 Rokovi i eskalacija

| Faza | Rok | Akcija |
|---|---|---|
| Prva notifikacija | odmah (T+0) | mejl + Slack; `expiresAt = now + approval.timeoutHours` (default 24 h) |
| Podsjetnik | T+4 h (ako nije odlučeno) | ponovna notifikacija istim kanalom, „podsjetnik 1/2" |
| Podsjetnik 2 | T+12 h | notifikacija + eskalacija na backup approvera (`approversBackup[]`) |
| Eskalacija na menadžera | T+24 h | eskalacija; metrika/alert (sekcija 8) |
| Istek | `expiresAt` (default 24 h, `high` finansije 4 h) | `status="expired"`; run se **ne** izvršava; alat se ne poziva; korisnik dobija obavještenje; `outcome: "expired"` (računa se u KPI kao neuspjeh odgovora, ne kao greška sistema) |
| Auto-approve | NIKAD po default-u | Dozvoljeno samo izričito u politici (`tools.<x>.autoApprove: true`) i samo za `riskLevel="medium"` sa `maxAmount` limitom |

Pravila: odobrenje važi **samo** za taj `approvalId` i taj hash argumenata; ako agent promijeni argumente — traži se novo odobrenje;
ako odobrenje stigne posle isteka → `409 { "error":"approval_expired" }` (ne izvršava se);
sve odluke (i one koje su odbijene) se čuvaju 365 dana jer su dokaz za reviziju.

---

## 7. Audit trail

### 7.1 Zašto hash chain

Audit log je **dokaz** (ko je, kada, šta, sa kojim ishodom). Običan JSONL se može tiho izmijeniti — zato je svaki zapis vezan za prethodni:
`hash = SHA-256(canonical(entry bez hash polja) + prevHash)`. Svaka izmjena ili brisanje zapisa u sredini lanca obara sve hash-eve poslije njega,
što se detektuje jednom komandom. Lanac je **per-tenant** i **mjesečni** (`data/tenants/<tenantId>/audit/YYYY-MM.jsonl`, kanonski iz `02-TECH-STACK.md` §4.1),
pa izolacija važi i za audit; prvi zapis u fajlu ima `prevHash = "genesis"`, a **prvi zapis novog mjeseca nosi hash poslednjeg zapisa prethodnog mjeseca**
(time se lanac ne prekida na granici mjeseca). Verifikacija je `node scripts/verify-audit.mjs`.

### 7.2 Struktura zapisa

```jsonc
{ "schemaVersion":1, "seq":4182, "ts":"2026-09-29T08:12:00.400Z",
  "tenantId":"t_nmq", "traceId":"tr_01J9F2K7", "runId":"r_01J9F2M8TT1Q0C", "spanId":"sp_07",
  "actor":{"type":"agent","id":"support"},              // type: agent | user | system | admin
  "onBehalfOf":{"type":"user","id":"u_8842"},
  "action":"tool.executed",                             // approval_requested | approval_granted | approval_rejected |
                                                        // tool.executed | policy_denied | config.changed | gdpr_delete |
                                                        // budget.blocked | admin_cross_tenant_read | login
  "target":{"tool":"refunds.create","resource":"order:ORD-99120"},
  "argsRedacted":{"orderId":"ORD-99120","amount":{"value":4990,"currency":"RSD"},"cardNumber":"[REDACTED]"},
  "argsHash":"sha256:7c1f...",                          // hash punih (neredigovanih) argumenata — dokaz da poslije nije mijenjano
  "policy":{"decision":"require_approval","ruleId":"high_risk","policyVersion":"2026-09-20"},
  "approval":{"approvalId":"ap_01J9F2MC","status":"approved","approver":"dejan@nmq.local","decidedAt":"2026-09-29T08:12:00.100Z"},
  "outcome":"success",                                  // success | error | denied | pending | expired
  "errorCode":null,
  "prevHash":"sha256:1a9c...",
  "hash":"sha256:4be2..." }
```

`canonical()` = JSON sa sortiranim ključevima, bez razmaka, UTF-8; **`hash` se ne uključuje** u izračun; `prevHash` ulazi u izračun.
`argsRedacted` u lancu + `argsHash` nad originalom: čuva se dokaz bez čuvanja tajni u čitljivom obliku.

### 7.3 Verifikacija lanca

```
verify(tenantId):
  prev = "genesis"; expectedSeq = 1
  za svaki mjesec M (rastuće), pa za svaki zapis e u data/tenants/<tenantId>/audit/<M>.jsonl (u redu):
    1. ako e.seq != expectedSeq              -> FAIL("gap u sekvenci na seq=" + expectedSeq)
    2. ako e.tenantId != tenantId            -> FAIL("tuđi tenant u lancu")
    3. ako e.prevHash != prev                -> FAIL("prekinut lanac na seq=" + e.seq)
    4. h = sha256(canonical(e bez "hash") )  -> ako h != e.hash -> FAIL("izmijenjen sadržaj na seq=" + e.seq)
    5. prev = e.hash ; expectedSeq++
  -> OK("lanac validan, " + (expectedSeq-1) + " zapisa, poslednji hash=" + prev)
```

- Pokreće se: dnevno (cron), prije svakog izvoza za reviziju, i kao test (`tests/audit.test.mjs` — test ubaci izmjenu u sredinu i očekuje FAIL).
- Rezultat verifikacije se upisuje u `audit/verify.jsonl` (`{ ts, ok, entries, lastHash, failAt? }`).
- Dodatno ojačanje (v1): dnevni `seal` — hash poslednjeg zapisa se šalje na eksternu lokaciju (npr. u git commit ili na mejl/objavljuje se),
  pa ni brisanje cijelog fajla ne prolazi nezapaženo.
- `audit/YYYY-MM.jsonl` se **nikad** ne prepisuje: `retention` job ga ne dira; zaključan mjesec se arhivira kao `.jsonl.gz` + `.sha256`.
- Postgres varijanta: `audit_log` bez `UPDATE`/`DELETE` grant-a za aplikacionu rolu; trigger koji odbija `UPDATE` i `DELETE` na tabeli `audit_log`.
- U audit ulaze i akcije iz orchestration sloja (`04-ORCHESTRACIJA.md`): `handoff`, `router_decision`, `plan_trimmed`, `tenant_mismatch`.

```sql
-- audit_log: izolacija + nepromjenljivost (uz RLS obrazac iz 02-TECH-STACK.md §4.3)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM nmq_app;   -- aplikacija smije samo INSERT i SELECT

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log je append-only: % nije dozvoljen', TG_OP;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
```

Napomena: `REVOKE` sam po sebi ne štiti od vlasnika tabele — zato i trigger (radi i ako se rola promijeni);
`verifyAudit()` čita `audit_log` u rastućem `seq` i ponavlja isti algoritam kao nad JSONL-om (jedan kod, dva izvora).

---

## 8. Alerti

| Uslov | Kanal | Prioritet | Ko reaguje | Prva akcija |
|---|---|---|---|---|
| Stopa greške > 5% u 5 min (bilo koji tenant) | Slack (#nmq-alerts) | **P1** | on-call dev | Pogledati `nmq_errors_total` po `code`; ako je provider → failover modela |
| Stopa greške > 1% u 15 min (blagi rast) | Slack | P2 | dev | Analiza trace-a, provjera providera |
| `nmq_run_duration_seconds` p95 > 8 s u 10 min | Slack | P2 | dev | Provjera RAG/rerank latencije i veličine prompta |
| Potrošnja tenanta > 80% budžeta | mejl vlasniku + Slack | P2 | vlasnik tenanta | Provjera najskupljih agenata/modela; po potrebi limit |
| Potrošnja tenanta ≥ 100% (hard blok) | mejl + Slack | **P1** | admin | Podići limit ili pustiti blokadu; obavijest korisniku |
| Neuspješan alat 3× zaredom (isti tool+tenant) | Slack | P2 | dev | Provjera MCP servera/kredencijala alata; eventualno disable alata |
| Čekajuće odobrenje > 24 h | mejl approverima + Slack | P2 | approver / menadžer | Eskalacija na backup approvera |
| Čekajuće odobrenje > 4 h za `high` finansije | mejl | P3 | approver | Podsjetnik |
| `nmq_policy_denied_total` skok > 10× baseline u 10 min | Slack | P2 | dev/security | Provjera da li agent pokušava zabranjene akcije (prompt injection?) |
| Pokušaj cross-tenant pristupa (`code=ISOLATION`) | Slack + mejl | **P0** | security | Blokada sesije/tokena, revizija log-a, incident |
| Verifikacija audit lanca FAIL | Slack + mejl | **P0** | security | Stop izdanja; forenzika; obavještavanje tenanta |
| `/metrics` scrape down > 2 min | Slack | P2 | dev | Restart servisa; provjera diska/memorije |
| Disk `data/` > 85% | Slack | P2 | dev | Retention/arhiviranje; provjera rotacije logova |
| Greška providera (429/5xx) > 20 u 5 min | Slack | P2 | dev | Backoff/failover, provjera limita kod providera |
| MCP server nedostupan > 1 min | Slack | P2 | dev | Restart MCP procesa; alat se označava `unavailable` |

Pravila: alerti su **akcioni** (svaki ima „prvu akciju"); isti alert se ne ponavlja češće od 1× u 15 min (dedup po `fingerprint`);
P0/P1 idu i na mobilni kanal; svi alerti se loguju (`alerts.jsonl`) da se posle mjeri koliko su lažni (cilj: < 20% false positive).

### 8.1 Konkretna pravila (Prometheus alerting rules)

```yaml
# infra/alerts.yml — `promtool check rules infra/alerts.yml` mora proći u CI-ju
groups:
  - name: nmq-availability
    rules:
      - alert: NmqHighErrorRate
        expr: |
          sum(rate(nmq_runs_total{status="error"}[5m])) by (tenant)
            / clamp_min(sum(rate(nmq_runs_total[5m])) by (tenant), 1) > 0.05
        for: 5m
        labels: { severity: P1, channel: slack }
        annotations:
          summary: "Stopa greške > 5% (5 min) za tenant {{ $labels.tenant }}"
          runbook: "docs/06-OBSERVABILITY-GOVERNANCE.md#8-alerti"
      - alert: NmqSlowRunsP95
        expr: histogram_quantile(0.95, sum(rate(nmq_run_duration_seconds_bucket[10m])) by (le, agent)) > 8
        for: 10m
        labels: { severity: P2, channel: slack }
        annotations: { summary: "p95 > 8 s za agenta {{ $labels.agent }}" }
      - alert: NmqMetricsDown
        expr: up{job="nmq-robot"} == 0
        for: 2m
        labels: { severity: P2, channel: slack }

  - name: nmq-governance
    rules:
      - alert: NmqCrossTenantAttempt
        expr: increase(nmq_errors_total{code="ISOLATION"}[10m]) > 0
        labels: { severity: P0, channel: "slack,email" }        # nikad se ne ignoriše, nema `for`
        annotations: { summary: "Pokušaj cross-tenant pristupa ({{ $labels.tenant }})" }
      - alert: NmqPolicyDeniedSpike
        expr: |
          sum(increase(nmq_policy_denied_total[10m])) by (tenant, rule)
            > 10 * clamp_min(sum(increase(nmq_policy_denied_total[1h] offset 1h)) by (tenant, rule) / 6, 1)
        for: 10m
        labels: { severity: P2, channel: slack }
      - alert: NmqApprovalPendingTooLong
        expr: nmq_approvals_pending{riskLevel="high"} > 0 and on(tenant)
              (time() - max(nmq_approval_requested_timestamp_seconds) by (tenant) > 86400)
        for: 5m
        labels: { severity: P2, channel: "email,slack" }
        annotations: { summary: "Odobrenje čeka > 24 h ({{ $labels.tenant }})" }   # `nmq_approval_requested_timestamp_seconds` se dodaje u v1

  - name: nmq-cost
    rules:
      - alert: NmqBudgetSoftLimit
        expr: nmq_budget_used_ratio{kind="usd"} >= 0.8 and nmq_budget_used_ratio{kind="usd"} < 1.0
        for: 15m
        labels: { severity: P2, channel: "email,slack" }
      - alert: NmqBudgetHardLimit
        expr: nmq_budget_used_ratio{kind="usd"} >= 1.0
        for: 1m
        labels: { severity: P1, channel: "email,slack" }
        annotations: { summary: "Budžet tenanta {{ $labels.tenant }} prekoračen — novi runovi blokirani (402)" }
      - alert: NmqPricingMissing
        expr: increase(nmq_pricing_missing_total[1h]) > 0
        for: 5m
        labels: { severity: P2, channel: slack }
        annotations: { summary: "Model nije u data/_global/pricing.json — trošak se ne naplaćuje" }
```

Napomena: `nmq_approval_requested_timestamp_seconds` i `nmq_pricing_missing_total` su **gauge/counter koje treba dodati**
(prva u v1, druga u MVP-u) — do tada se ta dva alerta vode iz JSONL-a (`approvals/pending.jsonl`, `cost-ledger.jsonl`) dnevnim job-om.

---

## 9. Dashboard

Prva strana (jedan ekran, bez skrolovanja za ključne brojeve):

| Panel | Šta prikazuje | Izvor |
|---|---|---|
| **Runs (24h)** | ukupno, `ok`/`error`/`awaiting_approval`, trend po satu (sparkline) | `nmq_runs_total`, `traces/<runId>.jsonl` |
| **Greške** | stopa % u 15 min, top 5 `code`, top 5 alata sa greškom | `nmq_errors_total`, `nmq_tool_errors_total` |
| **p95 latencija** | p50/p95/p99 po agentu, uz odvojen `approval_wait_seconds` | `nmq_run_duration_seconds`, `nmq_approval_wait_seconds` |
| **Trošak po tenantu** | tekući mjesec: `costUsd`, `usedRatio` budžeta, projekcija do kraja mjeseca | `costs/YYYY-MM.json`, `nmq_cost_usd_total` |
| **Top alati** | 10 najčešćih alata + greške + prosječno trajanje | `nmq_tool_calls_total` |
| **Čekajuća odobrenja** | broj, najstarije čekanje, dugmad Approve/Reject (sa scope-om) | `approvals/pending.jsonl`, `nmq_approvals_pending` |
| **Budžet** | koliko tenanta je u `ok`/`soft`/`hard` | `nmq_budget_used_ratio` |
| **Zdravlje** | `up`, verzija, DB/Redis/MCP status, disk | `/healthz`, `/readyz` |
| **Policy** | top blokirane akcije + top pravila | `nmq_policy_denied_total` |
| **Audit** | poslednja verifikacija lanca (OK/FAIL, vrijeme, broj zapisa) | `audit/verify.jsonl` |
| **Kvalitet** | % odgovora sa citatom (support/legal), `recall@3` iz regresionog seta | trace + eval izveštaj (doc 05 §9) |

Filteri na vrhu: `tenant` (obavezan izbor — nikad „svi tenanti" bez `admin:read` scope-a), vremenski raspon, agent, model, pattern.
Izolacija važi i za dashboard: korisnik tenanta vidi **samo** svoj tenant; cross-tenant prikaz je admin funkcija i upisuje se u audit.

---

## 10. Plan uvođenja

### MVP — nedjelja 1–3 (radi bez servera)

- `src/observability/trace.js`: `traceId`/`runId`/`spanId`, span stack, zatvaranje u `finally`, JSONL u `data/tenants/<id>/traces/`.
- `src/observability/metrics.js`: ručna Prometheus ekspozicija na `GET /metrics` (sve metrike iz §3, MVP verzija: brojači + nekoliko histograma sa fiksnim `le` korpama).
- `src/core/logger.js`: JSONL po eventu (§1), rotacija dnevno, `redactSecrets()` obavezno.
- `src/observability/cost.js`: `data/_global/pricing.json` + `pricingVersion`, akumulacija u `costs/cost-ledger.jsonl` + mjesečni agregat `costs/YYYY-MM.json`, `limits.json` (soft/hard).
- `src/core/policy.js`: `evaluate()` iz §5.3 + `config/policies.json` sa 2 tenanta (t_nmq, t_demo) + testovi (deny pobjeđuje, high traži odobrenje, missing scope, fail-closed).
- HITL minimalno: `approvals/pending.jsonl`, `POST /v1/approvals/:runId`, `status="awaiting_approval"`, odobrenje/odbijanje bez mejla (samo API odgovor).
- `src/observability/audit.js`: hash chain (`prevHash` + SHA-256 `canonical()`), `verifyAudit()`, test koji dokazuje detekciju izmjene.
- **Dokaz:** `node --test` zeleno; `GET /metrics` vraća tekst; audit lanac validan; politika blokira zabranjen alat (DoD #4).

### v1 — nedjelja 4–8 (operativna faza)

- Prometheus scrape + Grafana dashboard (§9 paneli po panelu), alerti iz §8 kroz Alertmanager (ili jednostavan vlastiti evaluator u MVP stilu).
- Notifikacije odobrenja: mejl (SMTP_* iz DSH store-a) + Slack webhook, podsjetnici/escalation iz §6.3 kao scheduled job.
- Postgres tabele po kanonskoj šemi (`spans`, `traces`, `events`, `cost_ledger`, `audit_log`) + `approvals`, `facts`, `policy_denials` kao dodatak; particionisanje i RLS po `02-TECH-STACK.md` §4.3.
- Billing: `scripts/billing.mjs`, `costs/frozen/<period>.json`, `invoice-*.json`, rekonsolidacija sa računom providera.
- Admin akcije kroz API sa audit tragom: izmjena limita, izmjena politike (`config.changed`), ručno odobrenje.
- Retention job za logove (traces 30 dana, longterm/events 365, costs/audit 7 godina).

### v2 — nedjelja 9–12 (skala i dokazivanje)

- OpenTelemetry export (OTLP) spanova; Tempo/Jaeger za cross-service trace (widget → gateway → MCP server).
- SLO izvještaji: mjesečni izvještaj po tenantu (dostupnost, p95, stopa greške, potrošnja budžeta, broj incidenata) — automatski generisan dokument.
- Anomaly detekcija (potrošnja po agentu, broj tool poziva, neuobičajeni sati) → predlog alerta, ne auto-blokada.
- Višeregionalnost: agregacija metrika po regionu/instanci, centralni dashboard; tenant-level „status page".
- Kvartalna revizija politika: izvještaj „koji alat je korišćen, koji je blokiran, koliko je odobrenja bilo" + predlog izmjena.
- Test otpornosti: chaos testovi (provider down, MCP down, disk pun) sa provjerom da alerti i politike reaguju ispravno.

---

## Otvorena pitanja

1. **Gdje idu trace spanovi u v1:** ostajemo li na kanonskim tabelama `spans`/`traces` u Postgresu (+ Loki za pretragu teksta) ili uvodimo ClickHouse/Tempo odmah?
   Odluka utiče na cijenu Hetznera i složenost deploy-a.
2. **Pun prompt u logu:** dozvoljavamo li `capturePrompts=true` za enterprise tenante uz PII redakciju, ili je zabranjeno bez obzira na zahtjev klijenta?
   (Utiče na mogućnost debugovanja loših odgovora.)
3. **Auto-approve za `medium` rizik:** uvodimo li ga uopšte (npr. mejl na interni domen do 50 primalaca), ili svaka akcija sa rizikom ide čovjeku?
4. **Ko je approver po default-u:** vlasnik tenanta, imenovana rola (`approvers[]` u politici), ili on-call menadžer? Šta ako tenant nema koga da imenuje?
5. **Blokada na 100% budžeta:** je li `402` prihvatljiv za krajnjeg korisnika widgeta, ili umjesto blokade treba „degradirani režim"
   (odgovori samo iz keša/kb.search bez LLM-a) i ko to bira — mi ili tenant?
6. **Audit lanac i GDPR brisanje:** brisanje korisnika ne smije obrisati audit zapise; da li u audit ostaje `userId` u čitljivom obliku
   (dokaz) ili kao `HMAC(userId, tenantSalt)` (privatnost)? Ovo mijenja mogućnost dokazivanja „ko je šta uradio".
