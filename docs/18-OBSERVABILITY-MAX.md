# 18 — Observability MAX: OTel, metrike, alerti, SLO

> **Svrha:** podići postojeći observability sloj (doc `06`, kod u `src/observability/`) na nivo na kojem se
> **incident dijagnostikuje iz podataka**, **trošak dokazuje iz fakture**, a **SLO može potpisati ugovorom**.
> Ovaj dokument se **nadograđuje** na `docs/06-OBSERVABILITY-GOVERNANCE.md` — ne mijenja ga. Sve što je tamo
> opisano kao „planirano" ovdje dobija stanje: šta je **stvarno u kodu danas (v0.2)**, šta je **rupa**, i šta
> je **plan** (`docs/19-MVP-MAX-PLAN.md`).
>
> **Ugovor:** `docs/DECISIONS.md` §6 (kanonske putanje) i §7 (stanje implementacije) su mjerodavni.
> Gdje se ovaj dokument razlikuje od `06`, **kod je istina** (`DECISIONS.md` §6, pravilo 4).
> Vrijednosti cijena i verzija se **nikad** ne tvrde kao činjenica — piše „procjena" i **kako se provjerava**.
> U dokument ne idu **vrijednosti** ključeva — samo **imena** env varijabli.

**Provjereno na kodu (v0.2, `nmq-robot@0.1.0`, `node --test` = 106/106 prolazi):**
`src/observability/otel.js` (115 linija), `metrics.js` (91), `trace.js` (133), `cost.js` (99), `audit.js` (88),
`src/scheduler/index.js`, `src/controlplane/registry.js`, `src/server/routes.js`, `src/server/routes-admin.js`.

---

## 1. Tri stuba

| Stub | Šta imamo | Gdje je u kodu | Gdje završava (fajl / endpoint) | Šta fali |
|---|---|---|---|---|
| **Trace** (spanovi) | Jedan run = jedan `runId` + `traceId`; spanovi za LLM, alat, korak patterna; span stack po dubini | `src/observability/trace.js` (`startRun`, `span`, `endRun`), `src/orchestration/*` (otvaraju spanove), `src/agents/agent.js`, `src/tools/registry.js` | `data/tenants/<id>/traces/YYYY-MM-DD.jsonl` (jedan JSON po runu, svi spanovi unutra); čitanje: `GET /v1/runs/:runId`, `GET /v1/runs` | Nema čitanja sa diska kroz API (`tracer.get` gleda **samo memoriju**, max 500 runova); nema span-perzistencije po spanu; nema `W3C traceparent` (nema propagacije kroz MCP/HTTP poziv); nema `format=otlp` na `GET /v1/runs/:runId` |
| **Metrike** | 39 imenovanih metrika (counter/gauge/histogram) + 2 auto-metrike, ručni Prometheus tekst | `src/observability/metrics.js` (`inc`/`set`/`observe`/`render`), pozivi rasuti po `src/**` (vidi §4) | `GET /metrics` (`text/plain; version=0.0.4`), bez auth i bez rate limita | Nema `# HELP` teksta po metrici (samo `"<ime> (counter)"`), nema Prometheus scrape config-a u repou, nema SLO/error-budget metrika, nema `nmq_up`/`nmq_build_info` |
| **Logovi** | Strukturirani JSONL na stdout, redakcija tajni **na ulazu**, `child()` bindings | `src/core/logger.js` (`redact`, `redactDeep`, `createLogger`) | `process.stdout` → `journalctl -u nmq-robot` (systemd) / `docker logs` (json-file, 10 MB × 5) | Nema centralizovanog log store-a (Loki), nema korelacije `traceId` ↔ log linija u jednom upitu, nema `log level` po tenantu, nema rotacije (oslanja se na journald/docker) |
| **Cost / naplata** | Trošak po `tenantId + agentId + model + runId` po pozivu, mjesečni agregat | `src/observability/cost.js` (`PRICING`, `priceFor`, `computeCost`, `createCostTracker`) | `data/tenants/<id>/usage/YYYY-MM.jsonl`; `GET /v1/usage?month=YYYY-MM` | Cijene su **konstanta u kodu** (`PRICING`), nema `pricingVersion`/`checkedAt`/`sourceUrl`; nema `data/_global/pricing.json`; nepoznat model se **ne prijavljuje** nego se naplaćuje po `fallback` tarifi (vidi §8) |
| **Audit (dokaz)** | Hash-chain po tenantu, `verify()` prolazi kroz cijeli lanac, redakcija argumenata | `src/observability/audit.js` | `data/tenants/<id>/audit/audit.jsonl`; `GET /v1/audit`, `node src/cli.js audit-verify` | Fajl je **jedan** (nema mjesečne rotacije iz `06` §7.1); `verify.jsonl` (dnevni zapis verifikacije) se ne piše; nema eksternog „seal"-a (hash van servera) |
| **Lifecycle / poslovi** | Metrike deploy-a, rollback-a, pauze, budžeta i poslova; admin snapshot | `src/controlplane/registry.js`, `src/scheduler/index.js`, `src/server/routes-admin.js` | `GET /v1/admin/health`, `GET /v1/admin/jobs`, metrike iz §4 | Nema gauge-a „koliko poslova kasni" (`jobs_overdue`), nema metrike trajanja posla, nema per-agent `budget_used_ratio` |
| **Izvoz (OTLP)** | `resourceSpans` po runu u OTLP/JSON, dva režima (fajl ILI HTTP) | `src/observability/otel.js` | `data/_global/otel-traces.jsonl` i/ili `POST ${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` | Nema batčovanja, nema retry-a, nema `resourceSpans` grupisанja više runova; nema izvoza **metrika** kroz OTLP (samo trace) |

**Zaključak u jednoj rečenici:** trace, metrike, logovi, cost i audit **postoje i rade** (dokazano testovima
`tests/observability.test.mjs`, `tests/max.test.mjs` sekcija OTel), ali **nijedan stub još nije spojen na
vanjski sistem** (Prometheus/Tempo/Loki/Grafana/Alertmanager). Sve u ovom dokumentu je zato podijeljeno na
„**radi danas**" i „**plan**".

---

## 2. Trace i spanovi

### 2.1 Model

| Pojam | Značenje u kodu | Generiše | Primjer |
|---|---|---|---|
| `runId` | Jedno izvršavanje patterna za tenant | `src/observability/trace.js#startRun` → `uid('run')` | `run_01J9F2M8TT1Q0C…` |
| `traceId` | Lanac kroz više runova (npr. router → agent → pod-agent) | `startRun`: ako ima `parentRunId` → **preuzima** `traceId` roditelja, inače nov `uid('trace')` | `trace_01J9F2K7QW3ZB4…` |
| `parentRunId` | Veza pod-run ↔ roditelj (nested patterni) | prosljeđuje pozivalac | `run_…` ili `null` |
| `spanId` | Jedna operacija unutar runa | `span(run, name, attrs)` → `uid('span')` | `span_01J9F2K9AA…` |
| `parentSpanId` | **Posljednji otvoreni span** u `run.spans` (stek, ne eksplicitni roditelj) | `span()`: `run.spans.at(-1)?.spanId ?? null` | prvi span ima `null` |
| `name` | Naziv operacije (slobodan string, konvencija `llm:*`, `tool:*`, ime patterna) | pozivalac | `llm:support`, `tool:order_lookup`, `sequential` |
| `attrs` | Proizvoljni parovi, **sanitizovani** (string skraćen na 500 znakova, objekat → JSON string) | `sanitize()` u `trace.js` | `{ step: 1, model: 'deepseek-chat' }` |
| `status` | `ok` (default), `error` (preko `fail()` ili `end(attrs,'error')`) | `span.end()` / `span.fail()` | `ok` |
| `durationMs` | `Date.now()` delta (od `span()` do `end()/fail()`) | tracer | `820` |

**Pravila koja kod stvarno sprovodi:**

1. `parentSpanId` je **stek**, ne graf: span koji se otvori unutar drugog spana (u istom `run.spans` nizu)
   dobija zadnji span kao roditelja. Zato **redoslijed otvaranja spanova određuje oblik trace-a** —
   ako pattern otvori dva spana paralelno (`fanout`), oba dobijaju istog „zadnjeg" roditelja.
2. Memorija tracera je ograničena: `MAX_RUNS_IN_MEMORY = 500`. Kad se prekorači, briše se **najstariji
   završeni** run (`status !== 'running'`).
3. `endRun()` je jedina tačka koja: (a) inkrementira `nmq_runs_finished_total`, (b) smanjuje `nmq_runs_active`,
   (c) bilježi `nmq_run_duration_seconds` i `nmq_run_cost_usd`, (d) **upisuje run na disk**, (e) poziva OTel izvoz.
   Sve pet stvari se dešavaju u istoj funkciji — to je jedina „istina" o kraju runa.
4. Ako upis na disk padne, run **ne pada**: greška ide u `logger.warn('trace.persist_failed')`.
5. Spanovi se **ne pišu** dok run traje; na disku postoje samo **završeni** runovi. Zato „gdje je run sada"
   može da odgovori samo memorija (`GET /v1/runs/:runId`) — poslije restarta procesa **ne može**.

### 2.2 Šta je span u praksi

| Vrsta spana | Ko ga otvara | Tipični `attrs` | Zašto je koristan |
|---|---|---|---|
| **Korijen runa** (implicitno: sam run) | `startRun` (run nije span, ali OTel izvoz dodaje `agent.run <pattern>` kao korijenski span) | `input` (skraćeno na 2000 znakova), `sessionId`, `userId`, `parentRunId` | Ulaz u trace; veza na sesiju/korisnika |
| **LLM poziv** | `src/llm/index.js` (wrap) i `src/orchestration/helpers.js#callLlm` | `provider`, `model`, `purpose`/`role`, `tokensIn`, `tokensOut` | Latencija i trošak po modelu; osnov za p95 i za fakturu |
| **Alat (tool)** | `src/tools/registry.js` (oko `handler`) | `tool`, `riskLevel`, `policyDecision`, `source` (`builtin`/`mcp-stdio`/`mcp-http`) | Dokaz šta je robot **stvarno uradio**; veza na audit |
| **MCP poziv** | `src/tools/mcp-client.js` | `server`, `tool`, `transport` | Kada je „greška alata" zapravo tuđi server |
| **Korak patterna** | `sequential`, `orchestrator-worker`, `fanout`, `handoff`, `magentic`, `reflection`, `debate`, `team` | `edge`, `step`, `stage`, `role`, `verdict` | Vidi se gdje pattern troši vrijeme (planiranje vs. izvršavanje) |
| **RAG retrieve** | `src/memory/vector.js` / agent petlja | `k`, `returned`, `minScore` | Zašto odgovor nema citat |
| **Kritičar / refleksija** | `src/agents/critic.js`, `src/orchestration/reflection.js` | `verdict`, `method` | Kvalitet, ne samo latencija |
| **Human-in-the-loop** | run ostaje `awaiting_approval` | `approvalId`, `waitMs` (planirano) | Odvaja **ljudsko čekanje** od **latencije sistema** |

### 2.3 Primjer stvarnog zapisa (oblik iz koda)

Ovo je **tačan oblik** koji `endRun()` upisuje u `data/tenants/<id>/traces/YYYY-MM-DD.jsonl`
(polja iz `startRun`/`endRun`/`span`; vrijednosti su ilustracija):

```jsonc
{
  "runId": "run_01J9F2M8TT1Q0C",
  "traceId": "trace_01J9F2K7QW3ZB4",
  "parentRunId": null,
  "tenantId": "t_nmq",
  "agentId": "ops",
  "pattern": "sequential",
  "sessionId": "s_01J9F2K7QW3ZB4",
  "userId": "job:nightly-report",
  "input": "Pripremi dnevni izvještaj za juče",
  "startedAt": "2026-09-29T08:11:02.100Z",
  "endedAt": "2026-09-29T08:12:00.400Z",
  "status": "ok",
  "error": null,
  "usage": { "tokensIn": 4300, "tokensOut": 500 },
  "costUsd": 0.0041,
  "output": "Izvještaj je spreman…",
  "spans": [
    { "spanId": "span_01", "name": "llm:planner",  "parentSpanId": null,      "startedAt": "2026-09-29T08:11:02.110Z", "durationMs": 1740, "status": "ok",    "attrs": { "role": "plan", "model": "deepseek-chat", "tokensIn": 1180, "tokensOut": 240 } },
    { "spanId": "span_02", "name": "rag.retrieve", "parentSpanId": "span_01", "startedAt": "2026-09-29T08:11:03.860Z", "durationMs": 96,   "status": "ok",    "attrs": { "k": 8, "returned": 3 } },
    { "spanId": "span_03", "name": "tool:order_lookup", "parentSpanId": "span_02", "startedAt": "2026-09-29T08:11:03.960Z", "durationMs": 674, "status": "ok", "attrs": { "tool": "order_lookup", "riskLevel": "low", "policyDecision": "allow", "source": "builtin" } },
    { "spanId": "span_04", "name": "llm:answer",   "parentSpanId": "span_03", "startedAt": "2026-09-29T08:11:04.640Z", "durationMs": 2410, "status": "ok",    "attrs": { "role": "answer", "model": "deepseek-chat", "tokensIn": 3120, "tokensOut": 260 } },
    { "spanId": "span_05", "name": "tool:invoice_create", "parentSpanId": "span_04", "startedAt": "2026-09-29T08:11:07.060Z", "durationMs": 51200, "status": "error", "attrs": { "tool": "invoice_create", "riskLevel": "high", "policyDecision": "require_approval", "error": "ApprovalRequiredError: …" } }
  ]
}
```

**Napomena o razlici prema `docs/06` §2.2:** `06` prikazuje bogatiji (planirani) oblik — `approvals[]`,
`waitMs`, `errorCode`, `pricingVersion`. Kod v0.2 upisuje **samo gore navedena polja**. Odobrenja žive u
audit logu (`action: approval_decision`) i u memoriji procesa (`pendingApprovals` u `src/server/routes.js`),
**ne** u trace zapisu. To je rupa #1 za operativni rad (vidi §5, alert „odobrenje > 24 h") i prva stvar
koju treba popraviti u fazi 3 plana `19`.

### 2.4 Kako se čita

| Način | Komanda / endpoint | Ograničenje |
|---|---|---|
| Živi run (u memoriji) | `GET /v1/runs/:runId` (tenant iz `x-tenant`/ključa) | Samo zadnjih ~500 runova i **samo do restarta** |
| Lista živih runova | `GET /v1/runs?limit=20` | Isto; vraća i runove sa `status: "running"` |
| Sa diska (bez API-ja) | `grep '"runId":"run_…"' data/tenants/<id>/traces/2026-09-29.jsonl` | Ručno; nema endpoint-a |
| Cijeli dan | `cat data/tenants/<id>/traces/2026-09-29.jsonl \| jq .` | Fajl raste sa brojem runova u danu |
| Izvoz u Tempo/Jaeger | `data/_global/otel-traces.jsonl` → Collector → Tempo | Vidi §3 |

**404, ne 403:** `GET /v1/runs/:runId` baca `NotFoundError` ako run nije u memoriji — za tuđi `runId`
**takođe 404**, čime se ne otkriva postojanje tuđeg runa (usklađeno sa `06` §2.3).
Međutim, u kodu **nema eksplicitne provjere `run.tenantId === tenantId`** — izolacija se trenutno oslanja
na to da je `tracer.get()` memorijski i da se ključevi tenant-a razlikuju. To je **nalaz** i ide u
fazu 2 plana `19` kao tvrdi test (vidi §5, alert „cross-tenant").

---

## 3. OTLP izvoz

### 3.1 Šta `src/observability/otel.js` tačno proizvodi

`createOtelExporter({ dataDir, file, endpoint, headers, serviceName, serviceVersion, logger, fetchImpl })`
vraća `{ enabled, exported (getter), exportRun(run), traceFile }`. `exportRun()` je **sinhrono čist**
u smislu da ne baca grešku i ne blokira run (vidi §3.5).

**Struktura payload-a (OTLP/JSON, `resourceSpans`):**

```
{ resourceSpans: [ { resource: { attributes: [...] }, scopeSpans: [ { scope: { name: 'nmq-robot' }, spans: [...] } ] } ] }
```

| Nivo | Atribut | Vrijednost / izvor |
|---|---|---|
| `resource` | `service.name` | `serviceName` (default `nmq-robot`) |
| `resource` | `service.version` | `serviceVersion` (iz `createRobot` → `VERSION` iz `src/index.js`) |
| `resource` | `nmq.tenant` | `run.tenantId` |
| `resource` | `deployment.environment` | `NMQ_ENV` → `NODE_ENV` → `'production'` |
| svaki span | `nmq.agent` | `run.agentId ?? 'unknown'` |
| svaki span | `nmq.pattern` | `run.pattern ?? 'agent'` |
| svaki span | `nmq.run_id` | `run.runId` |
| svaki span | `nmq.status` | `s.status ?? 'ok'` |
| svaki span | `nmq.<ključ>` | svaki par iz `s.attrs` → prefiks `nmq.` (broj → `doubleValue`, bool → `boolValue`, ostalo → `stringValue`) |
| **korijenski span** | `gen_ai.system` | `'nmq-robot'` |
| korijenski span | `gen_ai.request.model` | `run.model ?? 'unknown'` |
| korijenski span | `nmq.tenant` | `run.tenantId` |
| korijenski span | `nmq.cost_usd` | `run.costUsd ?? 0` (`doubleValue`) |
| korijenski span | `nmq.tokens_in` / `nmq.tokens_out` | `run.usage.tokensIn` / `tokensOut` (`intValue`) |
| korijenski span | `nmq.status` | `run.status ?? 'ok'` |

**ID konverzija (bitno za Tempo/Jaeger):** `hex(id)` briše sve što nije `[a-f0-9]`, dopunjava nulama i siječe
na **32** znaka (`traceId`); `spanId(id)` isto na **16** znakova. Naši ID-jevi su `trace_<ULID>` / `span_<ULID>`
— ULID je Crockford base32 i **sadrži slova van `a–f`** (`G`–`Z`). Ta slova se **brišu**, pa je izvedeni
`traceId` **gubitnički** (dva različita ULID-a mogu dati isti hex). To **nije** problem za prikaz i za
`grep` po runu, ali **jeste** za korelaciju sa drugim servisima i za deduplikaciju u Tempo-u.
**Rupa #2** (popravka: `sha256(ulid)` prvih 16 bajtova, ili prelazak na pravi hex `traceId` — vidi `## Otvorena pitanja`).

**Vremena:** `startTimeUnixNano = <ms>000000`, `endTimeUnixNano = <startMs + durationMs>000000`.
Kod koristi `new Date(run.startedAt).getTime()` (ISO string iz `clock.iso()`), a trajanje **span-a** je
`span.durationMs`, dok je trajanje korijenskog spana `endedAt - startedAt`. Status: `error` → `code: 2`,
sve ostalo → `code: 1` (OK). `kind` je uvijek `1` (SPAN_KIND_INTERNAL) — imamo jedan proces, pa je to tačno
za v0.2; ako se doda odvojen proces za MCP server, `kind` za njega ide u `3` (CLIENT).

### 3.2 Dva režima

| Režim | Kako se uključuje | Gdje podaci idu | Prednosti | Nedostaci |
|---|---|---|---|---|
| **Fajl** | `NMQ_OTEL_FILE=1` (default; `otelFile` iz `envConfig`) → `file: true` | `data/_global/otel-traces.jsonl`, **jedna linija = jedan OTLP payload** (append preko `appendText`) | Radi bez ijednog servisa; preživljava restart; može se poslati ručno ili `filelog` receiver-om | Raste neograničeno (nema rotacije); čita se samo alatom |
| **HTTP** | `OTEL_EXPORTER_OTLP_ENDPOINT` postavljen → `endpoint` ≠ `''` | `POST <endpoint>/v1/traces` (`content-type: application/json`, `+ NMQ_OTEL_HEADERS` kao JSON) | Direktno u Collector → Tempo/Jaeger/Grafana | Ako endpoint padne, span **nije** nigdje (nema retry-a, nema queue) |

**Mogu i oba istovremeno** (`file: true` **i** `endpoint` postavljen) — tada je fajl **lokalni WAL/backup**,
a HTTP primarni put. To je preporučeni režim u produkciji (vidi §3.4).

**Imena env varijabli koje izvoz koristi (samo imena):**
`NMQ_OTEL_FILE`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `NMQ_OTEL_HEADERS`, `NMQ_ENV`, `NODE_ENV`.
(`NMQ_OTEL_HEADERS` je JSON objekat sa zaglavljima — npr. `Authorization` za managed Tempo; **vrijednost
se nikad ne piše u dokument, repo ni log**.)

### 3.3 Kako se povezuje na OTel Collector + Tempo/Jaeger

Tok: `nmq-robot` → (`OTLP/HTTP` i/ili fajl) → **Collector** → **Tempo** (trace store) → **Grafana** (prikaz).
Metrike idu **drugim putem**: `Prometheus` scrape-uje `GET /metrics`. Ovo dvoje se spajaju u Grafani kroz
`exemplars`/`trace_id` (tek kad popravimo rupu #2 i dodamo pravi `traceparent`).

**Primjer `otel-collector-config.yaml` — varijanta A: prima OTLP (preporučeno):**

```yaml
# fajl -> infra/observability/otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318        # nmq-robot POST-uje na /v1/traces
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  memory_limiter:
    check_interval: 2s
    limit_percentage: 75
    spike_limit_percentage: 20
  batch:
    send_batch_size: 512
    timeout: 5s
  # Privatnost: skini atribute koji mogu nositi sadržaj, a nisu potrebni u trace store-u.
  attributes/scrub:
    actions:
      - key: nmq.input
        action: delete
      - key: nmq.output
        action: delete

exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  debug:
    verbosity: basic

service:
  telemetry:
    logs:
      level: info
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, attributes/scrub, batch]
      exporters: [otlp/tempo, debug]
```

**Varijanta B: čita fajl koji `nmq-robot` već piše (`filelog` receiver, ako nema mrežnog puta):**

```yaml
receivers:
  filelog/otel-jsonl:
    include: ['/data/_global/otel-traces.jsonl']
    start_at: beginning
    include_file_path: true
    operators:
      # jedna linija = { ts, resourceSpans: [...] } → izvuci samo resourceSpans kao JSON
      - type: json_parser
        parse_from: body
        parse_to: attributes
      - type: move
        from: attributes.resourceSpans
        to: body
```

> **Napomena (provjeriti pri uvođenju):** `filelog` je prvenstveno **log** receiver — OTLP/JSON iz fajla se
> najlakše ubaci kroz `otlpjson` tip, a tačan naziv operatora/tipa zavisi od verzije Collector-a.
> **Provjera:** `otelcol --config <fajl> validate` (ili `otelcol-contrib`) mora proći **prije** deploy-a;
> ako ne prođe, koristi varijantu A (HTTP) koja ne zavisi od verzije operatora. Ovu tvrdnju **ne** treba
> uzimati kao činjenicu bez te komande.

**Minimalni `docker-compose.observability.yml` (skica, imena servisa su ugovor za config iznad):**
`otel-collector` (portovi `4317`/`4318` **samo na `127.0.0.1`** ako nije u klasteru), `tempo`
(`/var/tempo` volume), `prometheus` (scrape `nmq-robot:8787/metrics`, `rule_files: [/etc/prometheus/alerts.yml]`),
`grafana` (datasource: Prometheus + Tempo), `alertmanager` (Slack/mejl receiver).
Sve zajedno je **procjena 1–2 GB RAM** na malom VPS-u — prije kupovine provjeriti sa `docker stats` na
testnom okruženju, ne vjerovati procjeni.

### 3.4 Zašto greška u izvozu ne ruši run

Kod to rješava **na tri mjesta**, i to je namjerno (test `otel: greška u izvozu ne ruši run`):

1. **`trace.js`:** `if (otel?.exportRun) await otel.exportRun(run);` — poziv je **zadnji** u `endRun()`,
   poslije upisa na disk. Greška iz izvoza **ne može** pokvariti zapis runa.
2. **`otel.js`:** cijelo tijelo `exportRun()` je u `try { … } catch { logger.warn('otel.export_error') ; return null }`.
   HTTP odgovor `!res.ok` se **ne** baca dalje — samo `logger.warn('otel.export_failed', { status })`.
3. **`exported` brojač** se inkrementira **prije** HTTP poziva, pa je „koliko runova je prošlo kroz izvoz"
   vidljivo u `GET /v1/admin/health` (`otel: { enabled, exported }`) čak i kad endpoint stalno pada.
   **Rupa:** brojač ne razlikuje „poslano" od „prihvaćeno" — za SLO izvoza treba **dvije** metrike
   (`nmq_otel_export_total{result="ok|error"}`), što je plan (vidi §4, „metrike koje treba dodati").

**Pravilo:** izvoz telemetrije je **best-effort** i nikad nije na kritičnom putu korisnikovog odgovora.
Isto pravilo važi i za upis trace-a na disk (`trace.persist_failed` je `warn`, ne `error`).

---

## 4. Kompletna lista metrika

Format: Prometheus tekst na `GET /metrics` (`src/observability/metrics.js`). Prefiks je `nmq` i dodaje se
**automatski** u `inc/set/observe` (`prefix = 'nmq'`), pa u kodu stoji `metrics.inc('runs_total', …)`,
a na izlazu `nmq_runs_total`.

> **Ispravka spiska iz zahtjeva (kod je istina):**
> `nmq_runs_total` **postoji** ali se **ne** inkrementira po `status` — inkrementira se **jednom po uspješnom
> HTTP runu** u `src/server/routes.js` (bez `status` labele). Uspjeh/neuspjeh po statusu vodi
> `nmq_runs_finished_total` (iz `trace.js`). **Ne postoji** `nmq_runs_finished_total{status}` na istom
> mjestu kao `nmq_runs_total` — to su dvije različite metrike iz dva različita sloja.
> Takođe: na `nmq_llm_calls_total` labele su `provider`, `model`, `status` (**bez `tenant`**), a na
> `nmq_tokens_total` labela za smjer je **`type`** (`in`/`out`), **ne** `direction` kako predlaže `06` §3.

### 4.1 Metrike koje su stvarno u kodu (v0.2) — 39 imenovanih

| Ime metrike | Tip | Labele | Šta znači | Gdje se inkrementira (fajl) |
|---|---|---|---|---|
| `nmq_runs_total` | counter | `tenant`, `agent`, `pattern` | Svaki **prihvaćen** run kroz HTTP/API (bez statusa) | `src/server/routes.js` |
| `nmq_runs_started_total` | counter | `tenant`, `agent`, `pattern` | Run je otvoren u tracer-u (uključuje i interne/pod-runove) | `src/observability/trace.js` |
| `nmq_runs_finished_total` | counter | `tenant`, `agent`, `status` | Završeni runovi po statusu (`ok`/`error`/…) — **osnov za stopu greške** | `src/observability/trace.js` |
| `nmq_runs_active` | gauge | — (bez labela!) | Broj runova koji su trenutno otvoreni | `src/observability/trace.js` |
| `nmq_run_duration_seconds` | histogram | `tenant`, `agent`, `pattern` | Trajanje runa (bucket-i: `0.05 0.1 0.25 0.5 1 2 5 10 30 60`) | `src/observability/trace.js` |
| `nmq_run_cost_usd` | histogram | `tenant`, `agent` | Trošak po runu u USD (isti bucket-i!) — koristi se i kao `inc` u `src/orchestration/index.js` | `src/observability/trace.js`, `src/orchestration/index.js` |
| `nmq_span_errors_total` | counter | `tenant`, `name` | Span završen sa statusom ≠ `ok` | `src/observability/trace.js` |
| `nmq_tool_calls_total` | counter | `tenant`, `tool`, `status` (`ok`/`error`) | Pozivi alata po ishodu | `src/tools/registry.js` |
| `nmq_tool_errors_total` | counter | `tenant`, `tool` | Greške alata (bez `code` labele!) | `src/tools/registry.js` |
| `nmq_tool_duration_seconds` | histogram | `tool` | Trajanje izvršenja alata (**bez `tenant`**) | `src/tools/registry.js` |
| `nmq_policy_denied_total` | counter | `tenant`, `tool`, `agentId` | Alat odbijen politikom (`deny`) | `src/tools/registry.js` |
| `nmq_approvals_required_total` | counter | `tenant`, `tool` | Alat je tražio ljudsko odobrenje | `src/tools/registry.js` |
| `nmq_llm_calls_total` | counter | `provider`, `model`, `status` | LLM pozivi po ishodu (**bez `tenant`**) | `src/llm/index.js` |
| `nmq_llm_duration_seconds` | histogram | `provider`, `model` | Trajanje LLM poziva | `src/llm/index.js` |
| `nmq_llm_cache_hits_total` | counter | `tenant` | LLM odgovor iz keša (nema troška) | `src/llm/index.js` |
| `nmq_tokens_total` | counter | `provider`, **`type`** (`in`/`out`) | Tokeni po smjeru (**nema `model`, nema `tenant`** — vidi §4.3) | `src/llm/index.js` |
| `nmq_pattern_llm_calls_total` | counter | `pattern`, `role` | LLM poziv iz pattern helpera (planer, sinteza, sudija) | `src/orchestration/helpers.js` |
| `nmq_router_decisions_total` | counter | `method` (`heuristic`/`llm`/`fallback`), `agent` | Kako je ruter izabrao agenta | `src/agents/router-agent.js` |
| `nmq_critic_reviews_total` | counter | `verdict`, `method` | Ocjene kritičara | `src/agents/critic.js` |
| `nmq_agent_runs_total` | counter | `tenant`, `agent`, `status` | Run na nivou agenta (niže od HTTP sloja) | `src/agents/agent.js` |
| `nmq_mcp_calls_total` | counter | `server`, `tool` | Poziv MCP alata | `src/tools/mcp-client.js` |
| `nmq_mcp_errors_total` | counter | `server`, `tool` | Greška MCP alata | `src/tools/mcp-client.js` |
| `nmq_http_fetch_total` | counter | `tenant`, `status` | Izlazni HTTP iz alata `http_fetch` (po status kodu) | `src/tools/builtin.js` |
| `nmq_http_errors_total` | counter | `code`, `status` | HTTP greška gateway-a po kodu greške i statusu | `src/server/http.js` |
| `nmq_rate_limited_total` | counter | `tenant` | Odbijen zahtjev zbog rate limita | `src/server/http.js` |
| `nmq_feedback_total` | counter | `tenant`, `rating` | 👍/👎 povratna informacija | `src/server/routes.js` |
| `nmq_jobs_runs_total` | counter | `tenant`, `job`, `reason` (`schedule`/`event`/`manual`) | Pokretanje posla | `src/scheduler/index.js` |
| `nmq_jobs_finished_total` | counter | `tenant`, `job`, `status` | Posao završen (status iz orchestratora) | `src/scheduler/index.js` |
| `nmq_jobs_failed_total` | counter | `tenant`, `job`, `code` | Posao pao / blokiran (poslije retry-a) | `src/scheduler/index.js` |
| `nmq_jobs_active` | gauge | — | Broj poslova koji se trenutno izvršavaju | `src/scheduler/index.js` |
| `nmq_jobs_created_total` | counter | `tenant` | Novi posao (**bez `job` labele**) | `src/scheduler/index.js` |
| `nmq_jobs_triggered_total` | counter | `tenant`, `job`, `event` | Posao pokrenut webhook događajem | `src/scheduler/index.js` |
| `nmq_jobs_waiting_approval_total` | counter | `tenant`, `job` | Posao stao na odobrenje | `src/scheduler/index.js` |
| `nmq_controlplane_deploys_total` | counter | `tenant`, `agent` | Deploy nove verzije agenta | `src/controlplane/registry.js` |
| `nmq_controlplane_rollbacks_total` | counter | `tenant`, `agent` | Rollback agenta | `src/controlplane/registry.js` |
| `nmq_controlplane_status_changes_total` | counter | `tenant`, `agent`, `status` | `active`/`paused`/`retired` promjena | `src/controlplane/registry.js` |
| `nmq_controlplane_blocked_total` | counter | `tenant`, `agent`, `reason` (`paused`/`retired`/`budget`) | Run odbijen u kontrolnoj ravni | `src/controlplane/registry.js` |
| `nmq_controlplane_deploy_requests_total` | counter | `tenant`, `agent` | Zahtjev za deploy kroz API (prije validacije/izvršenja) | `src/server/routes-admin.js` |
| `nmq_agent_key_auth_total` | counter | `tenant`, `agent` | Uspješna autentikacija per-agent ključem | `src/controlplane/registry.js` |

**Auto-metrike koje generiše `render()` (nemaju `inc`/`set` u kodu):**

| Ime | Tip | Značenje |
|---|---|---|
| `nmq_uptime_seconds` | (bez `# TYPE`!) | Sekunde od podizanja procesa (`Date.now() - startedAt`) |
| `nmq_process_rss_bytes` | (bez `# TYPE`!) | RSS memorija procesa |

> **Rupa #3:** ove dvije linije idu **bez** `# HELP`/`# TYPE` zaglavlja (upisuju se direktno u `render()`),
> a `nmq_process_rss_bytes` nema tip — Prometheus će ih prihvatiti, ali `promtool`/alerti nad njima su
> krhki. Popravka: pretvoriti ih u `set('uptime_seconds', …)` i `set('process_rss_bytes', …)`.

### 4.2 Iz zahtjeva — šta **ne postoji** (i šta koristiti umjesto)

| Traženo ime | Stanje u kodu | Šta koristiti / šta dodati |
|---|---|---|
| `nmq_runs_total{status}` | Ne postoji sa `status` labelom | `nmq_runs_finished_total{status}` za stopu greške; `nmq_runs_total` za volumen |
| `nmq_run_cost_usd` kao counter | Postoji kao **histogram** | Za sumu troška po tenantu koristiti `GET /v1/usage` (izvor istine) ili dodati `nmq_cost_usd_total` counter |
| `nmq_tokens_total{direction}` | Labela je **`type`**, ne `direction` | `nmq_tokens_total{type="in"|"out"}` |
| `nmq_errors_total{code,retryable}` | **Ne postoji** | Greške po kodu: `nmq_http_errors_total{code}`; greške alata: `nmq_tool_errors_total` |
| `nmq_approvals_pending` (gauge) | **Ne postoji** | Za sada iz `GET /v1/approvals` (memorija) + audit; dodati gauge u fazi 3 |
| `nmq_approval_requested_timestamp_seconds` | **Ne postoji** | Isto — bez njega nema pouzdanog alarma „odobrenje > 24 h" (samo procjena iz audita) |
| `nmq_budget_used_ratio{kind}` | **Ne postoji** | `GET /v1/usage` + `controlPlane.list()` (`budgetUsedPct`); dodati gauge |
| `nmq_pricing_missing_total` | **Ne postoji** (nepoznat model se naplaćuje po `fallback`, tiho!) | Dodati counter + `logger.warn('cost.pricing_fallback')` — **prioritet**, jer tiho pogrešna cijena = pogrešna faktura |
| `nmq_up{version,commit}` | **Ne postoji** | `/healthz` vraća `version`; za Prometheus dodati `nmq_build_info{version}` gauge |
| `nmq_errors_total{code="ISOLATION"}` | **Ne postoji** (nema tog koda greške u kodu) | Cross-tenant se za sada ne detektuje metrikom — vidi §5 alert (radi se iz audita/testova) |
| `nmq_rag_retrieve_seconds` | **Ne postoji** kao metrika (RAG latencija je u spanu) | Dodati histogram ili mjeriti iz `nmq_tool_duration_seconds{tool="memory_search"}` |

### 4.3 Pravila za labele (kardinalnost)

- **Zabranjeno u labelama:** `runId`, `sessionId`, `userId`, `traceId`, `spanId`, slobodan tekst, URL, mejl,
  `jobId` koji nije iz ograničenog skupa, i **bilo koja vrijednost koja dolazi od korisnika**.
- **`nmq_runs_active` i `nmq_jobs_active` su globalne** (bez `tenant` labele). Za gauge po tenantu treba
  mapa aktivnih po tenantu — **rupa #4** (danas ne možemo odgovoriti „koliko runova vrti tenant X").
- **`nmq_tool_duration_seconds` i `nmq_llm_*` nemaju `tenant`** → ne mogu se filtrirati po klijentu na
  dashboardu. Za per-tenant latenciju alata koristiti spanove iz trace-a (Tempo) ili dodati `tenant` labelu
  (uz rizik rasta kardinalnosti — broj tenanta × broj alata; prihvatljivo do ~100 tenanta).
- **`tenant` labela nedostaje i na `nmq_tokens_total`** → trošak po tenantu **ne treba** računati iz metrika,
  nego iz `cost.summary()` (`GET /v1/usage`). Metrike su za operaciju, `usage/` je za novac.

### 4.4 Metrike koje treba dodati (prioritet za fazu 3 plana `19`)

| Nova metrika | Tip | Labele | Zašto |
|---|---|---|---|
| `nmq_cost_usd_total` | counter | `tenant`, `agent`, `model`, `provider` | Suma troška koja se **ne** resetuje restartom (histogram se gubi) |
| `nmq_pricing_missing_total` | counter | `tenant`, `model`, `provider` | Tiho pogrešna cijena → pogrešna faktura |
| `nmq_approvals_pending` | gauge | `tenant`, `riskLevel` | Bez ovoga nema alerta za zaglavljena odobrenja |
| `nmq_approval_wait_seconds` | histogram | `tenant`, `riskLevel` | Odvaja ljudsko čekanje od latencije sistema |
| `nmq_budget_used_ratio` | gauge | `tenant`, `agent`, `kind` (`usd`/`tokens`) | Soft/hard limit iz `06` §4.5 |
| `nmq_jobs_overdue` | gauge | `tenant`, `job` | Posao koji je trebao da se pokrene a nije (scheduler stoji) |
| `nmq_otel_export_total` | counter | `result` (`ok`/`error`), `mode` (`file`/`http`) | Bez ovoga ne znamo da izvoz tiho ne radi |
| `nmq_errors_total` | counter | `tenant`, `code`, `retryable` | Grupisanje grešaka po kodu (danas samo `http_errors_total`) |
| `nmq_build_info` | gauge | `version`, `commit` | Koja verzija radi u produkciji |

---

## 5. Alerti

Svi alerti su **akcioni** (svaki ima „šta raditi"), dedup po `fingerprint` (1× u 15 min), a P0/P1 idu i na
mobilni kanal. Kanal `#nmq-alerts` = Slack; `email` = `approvers[]` iz politike tenanta / vlasnik.

> **Stanje:** datoteke `infra/alerts.yml` **nema** u repou (provjereno: `infra/` sadrži `Dockerfile`,
> `docker-compose.yml`, `nmq-robot.service`, `DEPLOY.md`, `k8s/`). Alerti ispod su **plan**; oni koji
> koriste metrike koje još ne postoje (§4.4) **ne mogu** se aktivirati prije nego se te metrike dodaju.
> Pravilo: svaki alert mora proći `promtool check rules` u CI-ju **prije** nego ide u produkciju.

| # | Alert | Uslov (PromQL) | Trajanje (`for`) | Kanal | Prioritet | Šta raditi |
|---|---|---|---|---|---|---|
| 1 | `NmqHighErrorRate` | `sum(rate(nmq_runs_finished_total{status="error"}[5m])) by (tenant) / clamp_min(sum(rate(nmq_runs_finished_total[5m])) by (tenant), 0.001) > 0.05` | 5m | Slack | **P1** | Pogledaj `nmq_span_errors_total` i top `code` u `nmq_http_errors_total`; ako je izvor provider → failover model (`NMQ_LLM_FALLBACKS`) |
| 2 | `NmqErrorRateCreep` | `sum(rate(nmq_runs_finished_total{status="error"}[15m])) by (tenant) / clamp_min(sum(rate(nmq_runs_finished_total[15m])) by (tenant), 0.001) > 0.01` | 15m | Slack | P2 | Analiza 3 uzorka trace-a (`GET /v1/runs?limit=3`); provjeri LLM provider i MCP |
| 3 | `NmqSlowChatP95` | `histogram_quantile(0.95, sum(rate(nmq_run_duration_seconds_bucket{agent="support"}[10m])) by (le, tenant)) > 8` | 10m | Slack | P2 | Provjeri RAG latenciju (`tool_duration_seconds{tool="memory_search"}`) i veličinu prompta (`tokens_total{type="in"}`) |
| 4 | `NmqSlowJobsP95` | `histogram_quantile(0.95, sum(rate(nmq_run_duration_seconds_bucket[30m])) by (le, agent)) > 30` | 15m | Slack | P2 | Nađi koji agent/pattern; provjeri da li posao čeka odobrenje (tada nije latencija sistema) |
| 5 | `NmqTenantBudgetSoft` | `nmq_budget_used_ratio{kind="usd"} >= 0.8 and nmq_budget_used_ratio{kind="usd"} < 1.0` | 15m | email + Slack | P2 | Vlasnik tenanta: koji agent/model troši; ponudi keš/manji model; provjeri `job` sa najvećim troškom |
| 6 | `NmqTenantBudgetHard` | `nmq_budget_used_ratio{kind="usd"} >= 1.0` | 1m | email + Slack | **P1** | Odluka: podići limit (`POST /v1/admin/agents/:agentId/budget`) ili pustiti blokadu; obavijesti klijenta |
| 7 | `NmqAgentBudgetBlock` | `increase(nmq_controlplane_blocked_total{reason="budget"}[15m]) > 0` | 5m | Slack | P2 | Agent je potrošio mjesečni budžet → povećaj budžet ili suzi zadatak (klijent ne smije ostati bez odgovora bez objašnjenja) |
| 8 | `NmqCostPerTenantSpike` | `sum(increase(nmq_cost_usd_total[1h])) by (tenant) > 3 * clamp_min(sum(increase(nmq_cost_usd_total[1h] offset 1d)) by (tenant) / 24, 0.0001)` | 10m | Slack | P2 | Anomalija potrošnje: nađi `agentId`/`model`; privremeni limit; provjeri petlju (`maxToolRepeats`) |
| 9 | `NmqCostPerAgentHigh` | `sum(increase(nmq_cost_usd_total[6h])) by (tenant, agent) > 5 * clamp_min(avg_over_time(sum(increase(nmq_cost_usd_total[6h])) by (tenant, agent)[7d:6h]), 0.001)` | 30m | Slack | P3 | Skup agent → provjeri prompt i broj koraka; predlog manjeg modela za taj agent |
| 10 | `NmqJobsFailing` | `sum(increase(nmq_jobs_failed_total[30m])) by (job) > 3` | 10m | Slack | **P1** | Posao pada u petlji (retry iscrpljen) → pogledaj `GET /v1/admin/jobs/:jobId/runs`, `code` iz metrike, isključi posao dok se ne popravi |
| 11 | `NmqJobsOverdue` | `nmq_jobs_overdue > 0` | 15m | Slack | P2 | Scheduler ne radi ili je posao zaglavio na lease-u → `GET /v1/admin/health` (`scheduler.running`, `scheduler.active`) |
| 12 | `NmqApprovalPending24h` | `time() - nmq_approval_requested_timestamp_seconds > 86400 and nmq_approvals_pending > 0` | 5m | email + Slack | P2 | Eskalacija na backup approvera; ako niko ne odgovara → pravilo „odobri unaprijed do iznosa X" |
| 13 | `NmqLlmProviderDown` | `sum(increase(nmq_llm_calls_total{status="error"}[5m])) by (provider, model) > 20` | 5m | Slack | **P1** | Backoff/failover na `NMQ_LLM_FALLBACKS`; provjeri kvotu i status stranicu providera; ako traje — degradirani režim (odgovor iz KB bez LLM-a) |
| 14 | `NmqMcpServerDown` | `sum(increase(nmq_mcp_errors_total[5m])) by (server) > 5 or absent(nmq_mcp_calls_total)` | 5m | Slack | P2 | Restartuj MCP proces; označi alate tog servera kao `unavailable`; provjeri OAuth token i allowlist |
| 15 | `NmqPolicyDeniedSpike` | `sum(increase(nmq_policy_denied_total[10m])) by (tenant, tool) > 10 * clamp_min(sum(increase(nmq_policy_denied_total[1h] offset 1h)) by (tenant, tool) / 6, 1)` | 10m | Slack | P2 | Da li agent pokušava zabranjeno (prompt injection kroz mejl/dokument)? Provjeri audit `policy_denied` + izvor ulaza |
| 16 | `NmqCrossTenantAttempt` | `increase(nmq_errors_total{code="ISOLATION"}[10m]) > 0` **ili** `increase(nmq_http_errors_total{code="FORBIDDEN"}[10m]) > 20` | 0 (bez `for`) | Slack + email | **P0** | Blokada sesije/ključa, revizija audita, incident; obavijesti tenanta ako je bilo pristupa |
| 17 | `NmqAuditChainBroken` | vlastiti exporter iz `GET /v1/audit` (`verify.ok == false`) → `nmq_audit_verify_ok == 0` | 0 | Slack + email | **P0** | Stop izdanja; forenzika; utvrdi koji `seq` je prvi loš (`firstBadSeq` iz odgovora) |
| 18 | `NmqMetricsDown` | `up{job="nmq-robot"} == 0` | 2m | Slack | P2 | Restart servisa (`systemctl restart nmq-robot`); provjeri disk/memoriju |
| 19 | `NmqDiskAlmostFull` | `node_filesystem_avail_bytes{mountpoint="/data"} / node_filesystem_size_bytes{mountpoint="/data"} < 0.15` | 10m | Slack | P2 | Retention/arhiviranje (`traces/`, `usage/`, `otel-traces.jsonl`); provjeri da nema runaway fajla |
| 20 | `NmqOtelExportFailing` | `increase(nmq_otel_export_total{result="error"}[15m]) > 5` | 10m | Slack | P3 | Izvoz je best-effort (runovi ne padaju) — provjeri endpoint i Collector; lokalni fajl ostaje kao WAL |
| 21 | `NmqPricingMissing` | `increase(nmq_pricing_missing_total[1h]) > 0` | 5m | Slack | P2 | Model nije u tabeli cijena → **trošak je procjena**; ažuriraj cijenu (sa datumom i izvorom) prije fakture |

**Pravilo o P0 alertima:** P0 se **nikad** ne „gasi" bez pisanog zapisa u audit
(`action: incident_review`). Alert koji se ponavlja a nije incident mijenja se **pragom**, ne ignorisanjem.

---

## 6. Dashboardi

Četiri dashboarda. Paneli su navedeni sa **upitom** (PromQL) i **izvorom**. Svi imaju obavezan filter
`tenant` (osim sigurnosnog, koji je admin-only) — nikad „svi tenanti" bez `admin:read` scope-a.

### (a) Operativni dashboard — „da li robot radi sada"

| Panel | Upit / izvor | Tip |
|---|---|---|
| Runs (24 h) | `sum(increase(nmq_runs_total[24h])) by (pattern)` + `sum(increase(nmq_runs_finished_total[24h])) by (status)` | stat + sparkline |
| Aktivni runovi | `nmq_runs_active` (+ `nmq_jobs_active`) | stat |
| Stopa greške (15 min) | `sum(rate(nmq_runs_finished_total{status="error"}[15m])) / clamp_min(sum(rate(nmq_runs_finished_total[15m])), 0.001)` | gauge sa pragom 1% / 5% |
| p50/p95/p99 latencija | `histogram_quantile(0.95, sum(rate(nmq_run_duration_seconds_bucket[10m])) by (le, agent))` | timeseries |
| Top 5 grešaka | `topk(5, sum(increase(nmq_span_errors_total[1h])) by (name))` + `topk(5, nmq_http_errors_total)` | tabela |
| Top 5 alata | `topk(5, sum(increase(nmq_tool_calls_total[1h])) by (tool))` | tabela |
| Greške alata | `sum(increase(nmq_tool_errors_total[1h])) by (tool)` | bargauge |
| Čekajuća odobrenja | `nmq_approvals_pending` + lista iz `GET /v1/approvals` | stat + tabela sa dugmićima |
| Poslovi | `nmq_jobs_active`, `sum(increase(nmq_jobs_finished_total[24h])) by (status)`, `sum(increase(nmq_jobs_failed_total[6h])) by (job)` | stat + tabela |
| Zdravlje | `up{job="nmq-robot"}`, `GET /readyz` (`llmIsMock`, `agents`, `tools`), `GET /v1/admin/health` (`otel.exported`, `scheduler.running`) | stat |
| RAG / citati | iz trace-a u Tempo (`nmq.returned`), + `nmq_tool_duration_seconds{tool="memory_search"}` | timeseries |

### (b) Trošak / naplata — „koliko košta i koliko naplatiti"

| Panel | Upit / izvor | Tip |
|---|---|---|
| Trošak po tenantu (mjesec) | `sum(increase(nmq_cost_usd_total[30d])) by (tenant)` **ili** `GET /v1/usage?month=YYYY-MM` (`summary.usd`) | stat + tabela |
| Trošak po agentu | `sum by (agent) (increase(nmq_cost_usd_total[30d]))` / `summary.byAgent` | bargauge |
| Trošak po modelu | `sum by (model) (increase(nmq_cost_usd_total[30d]))` / `summary.byModel` | pie |
| Trend (dnevno) | `sum(increase(nmq_cost_usd_total[1d])) by (tenant)` | timeseries |
| Projekcija do kraja mjeseca | `summary.usd / day_of_month * days_in_month` (iz `usage/`) | stat + „procjena" oznaka |
| Budžet | `nmq_budget_used_ratio{kind="usd"}` po tenantu i agentu | gauge 0–100% |
| Trošak po runu | `histogram_quantile(0.5, sum(rate(nmq_run_cost_usd_bucket[1d])) by (le, tenant))` | timeseries |
| Cijena vs. trošak (marža) | ručni panel: `prihod (config/tenants.json:billing) / summary.usd` | stat (crveno ispod 3×) |
| Keš | `sum(increase(nmq_llm_cache_hits_total[1d])) by (tenant)` | stat |

### (c) Agenti — „šta je deploy-ovano i koliko smije"

| Panel | Upit / izvor | Tip |
|---|---|---|
| Deploy/rollback | `sum(increase(nmq_controlplane_deploys_total[7d])) by (agent)`, `nmq_controlplane_rollbacks_total` | timeseries |
| Status agenta | `nmq_controlplane_status_changes_total` + `GET /v1/admin/agents` (`status`, `activeVersion`) | tabela |
| Pauze/penzionisanja | `sum(increase(nmq_controlplane_blocked_total[24h])) by (reason)` | bargauge |
| Budžet po agentu | `GET /v1/admin/agents` → `budgetUsedPct`, `spendUsd` | tabela sa pragom |
| Agent ključevi | `sum(increase(nmq_agent_key_auth_total[24h])) by (agent)` + `keys` iz `GET /v1/admin/agents` | tabela |
| Poslovi po agentu | `sum(increase(nmq_jobs_runs_total[24h])) by (job, reason)` | tabela |
| Verzije | `nmq_build_info` + `service.version` iz Tempo resursa | stat |

### (d) Sigurnost — „da li neko pokušava nešto što ne smije"

| Panel | Upit / izvor | Tip |
|---|---|---|
| Odbijene politike | `topk(10, sum(increase(nmq_policy_denied_total[24h])) by (tool))` | tabela |
| Odbijeno po agentu | `sum(increase(nmq_policy_denied_total[24h])) by (agentId)` | bargauge |
| Tražena odobrenja | `sum(increase(nmq_approvals_required_total[24h])) by (tool)` | tabela |
| Cross-tenant | `increase(nmq_http_errors_total{code="FORBIDDEN"}[24h])` | stat (crveno ako > 0) |
| Audit lanac | `GET /v1/audit` → `verify.ok`, `checked`, `head`; upis poslednje verifikacije u `audit/verify.jsonl` | stat + tabela |
| Rate limit | `sum(increase(nmq_rate_limited_total[1h])) by (tenant)` | timeseries |
| Agent ključevi (revokacije) | audit `agent_key_issued`/`agent_key_revoked` iz `GET /v1/audit` | tabela |
| Tajne (metapodaci) | `GET /v1/tenants/:id/secrets` (samo imena providera, **nikad vrijednosti**) | tabela |

**Izolacija dashboarda:** korisnik tenanta vidi **samo svoj** tenant; cross-tenant prikaz je admin funkcija i
upisuje se u audit (`action: admin_cross_tenant_read`).

---

## 7. SLO i error budget

SLO je **cilj**, ne garancija. Mjeri se iz metrika (ili iz `usage/` kad metrika ne postoji), a svaki SLO ima
**vlasnika** i **definisan ishod** kad se probije.

| SLO | Cilj | Mjerenje | Error budget (30 dana) | Šta radimo kad se probije |
|---|---|---|---|---|
| **Dostupnost gateway-a** | ≥ 99,5% (Starter/Pro, procjena) · ≥ 99,9% (Enterprise, procjena) | `1 - (up == 0 vrijeme / ukupno vrijeme)` iz `up{job="nmq-robot"}`; alternativa: `GET /healthz` svakih 30 s iz vanjskog monitora | 99,5% → **3 h 39 min**; 99,9% → **43 min** | P2/P1 alert; ako je uzrok deploy → rollback; ako je uzrok VPS → restart + zapis u incident log |
| **p95 latencija chat-a** | < 8 s (`support`, bez `high` rizika) | `histogram_quantile(0.95, sum(rate(nmq_run_duration_seconds_bucket{agent="support"}[10m])) by (le))` | „budžet" je **5% runova** iznad 8 s u 30 dana | Alert P2 → provjera RAG/prompt; keš odgovora; manji model za rutiranje; ako traje 3 dana → ulazimo u „zamrznuti feature" režim |
| **p95 latencija poslova** | < 30 s po pokretanju posla (bez čekanja na odobrenje) | `histogram_quantile(0.95, sum(rate(nmq_run_duration_seconds_bucket[30m])) by (le, agent))` | 5% iznad 30 s | Provjeri da posao ne čeka odobrenje; ako čeka → to je problem **odobrenja**, ne latencije |
| **Stopa grešaka** | < 1% (`status="error"`) u 15 min | `nmq_runs_finished_total{status="error"}` / ukupno | **1%** runova u 30 dana = ~7 h rada „u minusu" pri 1000 runova/dan | Alert P1/P2 → analiza `code`; ako je provider → failover; ako je alat → disable alata |
| **`high` rizik bez odobrenja** | **0** izvršenih akcija bez `approval_decision: approved` | audit lanac (`action: tool_call` vs. `approval_decision`) + test `policy.test.mjs` | nema budžeta — ovo je **P0** | Blokada alata za tenanta, revizija politike, incident |
| **Odobrenja** | < 5% `high` akcija čeka > 24 h | `nmq_approval_wait_seconds` (kad se doda); do tada iz `approvals` u auditu | 5% | Eskalacija na backup approvera; predlog „unaprijed odobreno do iznosa X" |
| **Tačnost/citiranost (kvalitet)** | ≥ 80% tačnih odgovora sa citatom na zlatnom setu (30–50 pitanja) | eval harness (faza 1 plana `19`), izvještaj po izmjeni prompta | regresija > 5% blokira merge | Vraćanje prompta/KB; analiza 👎 feedback-a (`nmq_feedback_total`) |
| **Metrike dostupnost** | `/metrics` scrape 99,9% | `up{job="nmq-robot"}` | 43 min | Alert P2 → restart; provjera diska i memorije |

**Kako se error budget koristi (pravilo, ne samo broj):**

1. Ako je **budžet potrošen > 50%** u prvoj polovini mjeseca → **nema novih feature-a** dok se ne stabilizuje;
   radi se samo na pouzdanosti.
2. Ako je budžet potrošen **100%** → zamrzavamo izdanja (osim sigurnosnih popravki) i radimo post-mortem
   sa zapisom u `docs/`.
3. Ako je budžet **neiskorišćen** tri mjeseca zaredom → SLO je preblag; pooštravamo ga (SLO koji ništa ne
   mijenja je dekoracija).
4. Mjesečni SLO izvještaj po tenantu (dostupnost, p95, greške, % odobrenja, trošak) je dio `docs/09` §7
   mjesečnog izvještaja klijentu — **isti brojevi**, ne dvije istine.

---

## 8. Cost tracking i naplata

### 8.1 Kako trošak nastaje (stvarni kod)

```
provider odgovori → { usage: { promptTokens, completionTokens } }
  → cost.computeCost(model, usage)          // src/observability/cost.js
      usd = (tokensIn / 1e6) * price.in + (tokensOut / 1e6) * price.out   // zaokruženo na 8 decimala
  → cost.record({ tenantId, agentId, runId, model, usage, provider, meta })
  → appendJsonl data/tenants/<tenantId>/usage/YYYY-MM.jsonl
```

Cijena dolazi iz **konstante `PRICING` u `src/observability/cost.js`** (USD za 1M tokena):

| Model (ključ u kodu) | `in` (procjena) | `out` (procjena) | Napomena |
|---|---|---|---|
| `deepseek-chat` | 0,27 | 1,10 | Primarni model iz `config`/`NMQ_LLM_MODEL` |
| `deepseek-reasoner` | 0,55 | 2,19 | Reasoning; skuplji output |
| `gpt-4o-mini` | 0,15 | 0,60 | Fallback opcija |
| `gpt-4o` | 2,50 | 10,00 | Skuplja opcija |
| `gpt-4.1-mini` | 0,40 | 1,60 | Fallback opcija |
| `llama-3.3-70b-versatile` | 0,59 | 0,79 | Groq |
| `qwen2.5:14b` | 0 | 0 | Lokalno (Ollama) — nema novčanog troška |
| `mock` | 0 | 0 | Testovi i demo |
| *(nepoznat model)* | **1,00** | **3,00** | `fallback` u `priceFor()` — **tiha procjena** |

> ⚠️ **Ove brojke su PROCJENA i ne smiju se koristiti kao činjenica.** U kodu stoji komentar
> „provjeriti!". **Kako se provjerava:** zvanična pricing stranica providera + polje `usage` iz stvarnog
> API odgovora, pa upis sa datumom provjere. Ako se broj u kodu razlikuje od zvaničnog — **faktura je
> pogrešna**, i to je jedini bug koji direktno pravi novčani gubitak.
> **Popravka (faza 3 plana `19`):** prebaciti tabelu u `data/_global/pricing.json` sa
> `{ priceIn, priceOut, priceCachedIn, priceEmbed, provider, checkedAt, sourceUrl, pricingVersion }`,
> a nepoznat model → `costUsd = null` + `nmq_pricing_missing_total` (nikad tiho pogađanje).
> Ovo je već opisano u `docs/06` §4.1–§4.2 — kod još nije na tom nivou.

### 8.2 Veza tenant ↔ agent ↔ model

Veza postoji **u svakom zapisu** `usage/YYYY-MM.jsonl`:

```jsonc
{ "ts": "2026-09-29T08:11:12.500Z", "tenantId": "t_nmq", "agentId": "support", "runId": "run_…",
  "provider": "llm", "model": "deepseek-chat", "tokensIn": 3120, "tokensOut": 260, "usd": 0.00041200 }
```

`summary(tenantId, { month })` vraća: `{ month, usd, tokensIn, tokensOut, calls, byAgent, byModel }`
(sve zaokruženo na 6 decimala). **Ne postoji** `runId`-level faktura i **ne postoji** veza na `purpose`
(plan/answer/summarize) — to je rupa #5: cijena je tačna po `tenant+agent+model`, ali **ne možemo reći
koliko košta rutiranje** (za razliku od `06` §4.3).

### 8.3 Kako iz troška nastaje faktura

| Korak | Šta se koristi | Stanje |
|---|---|---|
| 1. Zbir mjeseca | `cost.summary(tenantId, { month })` preko `GET /v1/usage?month=YYYY-MM` | ✅ radi |
| 2. Provjera cijena | tabela `PRICING` + `checkedAt` (planirano) | ⚠️ cijene bez datuma provjere |
| 3. Marža | **3–4× stvarni trošak modela** (`docs/09` §4) | ✅ pravilo postoji u dokumentaciji |
| 4. Faktura | `invoice-<tenant>-<period>.json` — stavke: agent, model, tokeni, iznos | ❌ nema `scripts/billing.mjs` |
| 5. Zamrzavanje mjeseca | `costs/frozen/<period>.json` + hash u audit | ❌ nije implementirano |
| 6. Rekonsolidacija | poređenje sa računom providera (`reconciliation.jsonl`) | ❌ nije implementirano |

**Formula naplate (iz `docs/09` §3–§4):** `fiksna pretplata (EUR/mj.) + usage`, pri čemu je
**usage cijena = 3–4× stvarni trošak modela**, a setup je jednokratna stavka.
**Zašto 3–4× a ne 1,2×:** uz trošak modela idu retry-i i greške (procjena +15%), embedding/vektor
(procjena +10%), support (najveći skriveni trošak), infrastruktura, naplata i devizni troškovi,
rezerva za rast cijena providera i neplaćanje. Ako je marža 2×, firma radi za dobrovoljce.
**Provjera marže (obavezno mjesečno):** `trošak modela / prihod` — cilj **< 15%**, a > 30% znači da je
paket pogrešno dimenzionisan (`docs/09` §4, A4 u `docs/10` §6).

### 8.4 Kako alerti štite maržu

| Zaštita | Mehanizam | Alert |
|---|---|---|
| Tenantski budžet (soft/hard) | `config/policies.json` budget + `budget.js` → blokada novih runova | #5 `NmqTenantBudgetSoft`, #6 `NmqTenantBudgetHard` |
| Per-agent budžet | `controlPlane.assertAgentBudget` → `PolicyError` prije runa | #7 `NmqAgentBudgetBlock` |
| Anomalija potrošnje | Rast troška > 3× dnevni prosjek | #8 `NmqCostPerTenantSpike` |
| Skup agent | Trošak agenta iznad 7-dnevnog prosjeka | #9 `NmqCostPerAgentHigh` |
| Pogrešna cijena | Nepoznat model u tabeli | #21 `NmqPricingMissing` |
| Petlja (retry/ponavljanje alata) | `maxSteps`, `maxToolCalls`, `maxToolRepeats`, `maxCostUsdRun` u `src/core/budget.js` | posredno #4 i #8 |

**Pravilo:** nijedan klijent **ne može** napraviti gubitak koji nije predviđen ugovorom — tvrdi limit je u
kodu, ne u dobroj volji. Ali blokada **nikad** ne smije biti tiha: korisnik dobija jasnu poruku
(`402 budget_exceeded` + period), a vlasnik tenanta dobija alert **prije** blokade (na 80%).

---

## 9. Retencija i privatnost telemetrije

### 9.1 Koliko se šta čuva

| Podatak | Putanja | Predložena retencija | Stanje u kodu |
|---|---|---|---|
| Trace (kompletan run sa spanovima) | `data/tenants/<id>/traces/YYYY-MM-DD.jsonl` | **30 dana** (sirovi) | ❌ nema retention job-a |
| `otel-traces.jsonl` (OTLP izvoz) | `data/_global/otel-traces.jsonl` | **7–14 dana** (dublje u Tempo-u) | ❌ raste neograničeno |
| Metrike | Prometheus TSDB | **15 dana** lokalno / 13 mjeseci ako treba godišnji trend (procjena: zavisi od veličine TSDB) | ❌ nema Prometheus-a |
| Logovi | `journalctl` / `docker json-file` | **14–30 dana** | ⚠️ docker: 10 MB × 5 fajlova; journald po sistemskom pravilu |
| Audit (hash-chain) | `data/tenants/<id>/audit/audit.jsonl` | **7 godina** (dokaz) | ⚠️ fajl postoji, **nema rotacije** ni arhiviranja |
| Potrošnja / naplata | `data/tenants/<id>/usage/YYYY-MM.jsonl` | **7 godina** (finansijski dokument) | ⚠️ raste po mjesecu (to je i prednost) |
| Sesije | `data/tenants/<id>/sessions/*.jsonl` | 30 dana (Starter) … 12 mj. (Pro) | ❌ nema retention job-a |
| Epizode (episodic) | `data/tenants/<id>/memory/episodes.jsonl` | 12 mjeseci ili dok traje ugovor | ❌ nema retention job-a |
| Poslovi (jobs) | `data/tenants/<id>/jobs/jobs.json`, `runs-YYYY-MM.jsonl` | 12 mjeseci za `runs-*` | ❌ nema retention job-a |

**Pravilo rotacije:** retention job je **jedan** (`scripts/retention.mjs`, planirano) koji čita listu iz
`config/retention.json` — nikad „ručno brisanje" i nikad `rm` po folderu.
**Audit se nikad ne briše** retention job-om; on se **arhivira** (`.jsonl.gz` + `.sha256`) i hash lanca se
nastavlja (poslednji zapis prethodnog fajla ulazi u prvi zapis novog).

### 9.2 Šta je PII u telemetriji i kako se redaktuje

| Mjesto | Šta može biti PII | Zaštita danas (kod) | Rupa |
|---|---|---|---|
| Logovi (`logger.js`) | Bilo koje polje u `fields` (ime, mejl, telefon, broj kartice) | `redact()` + `redactDeep()` na **ulazu**: uzorci `sk-…`, `gh[pousr]_…`, JWT `eyJ…`, `api_key/token/password/secret = …`, privatni ključevi; dubina ≤ 6 | **Ne redaktuje imejl/telefon/JMBG/IBAN** — samo tajne! PII u logu ostaje |
| Trace (`trace.js`) | `input` (do 2000 znakova!), `output` (do 4000), `attrs` (500) | Skraćivanje (`truncate`) | Skraćivanje **nije** redakcija — imejl u prvih 20 znakova ostaje |
| Audit (`audit.js`) | `args` i `meta` | `stripSecrets()` + `redact()` prije upisa; `sha256(stableStringify(body))` lanac | Imejl/telefon u `args` ostaju; audit je **dokaz** pa se ne smije brisati |
| Metrike | Ne smiju sadržati PII po pravilu (§4.3) | Labele su ograničen skup | Nema tehničke zabrane — može se „slučajno" staviti `userId` u labelu (code review) |
| OTel izvoz | Prenosi `s.attrs` **i** `resource` atribute | Ništa se dodatno ne redaktuje | Ako je PII ušao u `attrs`, izašao je i u Collector/Tempo → redakcija na Collector-u (`attributes/scrub`, §3.3) |
| `usage/*.jsonl` | Samo brojevi tokena i `usd` (+ `runId`, `agentId`) | Nema PII po konstrukciji | Ako se u `meta` doda korisnički sadržaj — postaje PII |
| Widget (`public/widget/nmq-robot.js`) | Tekst korisnikovog pitanja | Ide u run `input` | Isto kao trace |

**Preporučena pravila (plan):**
1. Uvesti `redactPii()` (imejl, telefon, JMBG, IBAN, broj kartice) **pored** `redact()` i pozvati ga u
   `logger.redactDeep`, `audit.safeArgs` i u `trace.sanitize` — jedan redaktor, tri mjesta.
2. `input`/`output` u trace-u: default **hash + prvih 200 znakova**, pun tekst samo ako
   `tenant.observability.capturePrompts === true` (uz PII redakciju i zapis u audit da je uključeno).
3. Zabraniti `userId`, `sessionId`, `runId` u labelama metrika **testom** (test koji skenira `metrics.inc/set`
   pozive i pada ako labela nije u dozvoljenom skupu) — jeftinije od code review-a.
4. Sva tri mjesta (log, trace, audit) moraju imati **isti** test korpus: `tests/no-pii-in-telemetry.test.mjs`
   sa 10 uzoraka (imejl, telefon, JMBG, IBAN, kartica, token, ključ, JWT, URL sa tokenom, ime+prezime).

### 9.3 Šta bi GDPR zahtijevao za logove (i šta bismo morali dokazati)

| Zahtjev | Šta to znači za telemetriju | Naša obaveza / dokaz |
|---|---|---|
| **Svrha i minimalizacija** (čl. 5) | Ne logovati sadržaj ako nije potreban; logovati `hash`, ne tekst | Odluka o `capturePrompts`, zapisana u `docs/08`; default **isključeno** |
| **Rok čuvanja** | Svaki tip telemetrije ima definisan rok i **job** koji ga sprovodi | `config/retention.json` + `retention.mjs` + zapis u audit (`action: retention_run`) |
| **Pravo na pristup / prenosivost** (čl. 15, 20) | Na zahtjev „koje podatke imate o meni" moramo izvući: sesije, trace, epizode, feedback | `GET /v1/memory/user/:userId` (postoji) + izvoz iz trace-a po `userId` (planirano) |
| **Pravo na brisanje** (čl. 17) | Brisanje korisnika iz sesija/memorije/trace-a — **ali audit lanac se ne smije obrisati** | Postoji `DELETE /v1/memory/user/:userId`; za audit: umjesto brisanja → **pseudonimizacija** (`userId` → `HMAC(userId, tenantSalt)`), dokaz ostaje |
| **Evidencija obrade (ROPA)** (čl. 30) | Spisak: koja telemetrija, svrha, rok, kome se šalje (Tempo? Slack? mejl?) | Tabela iz §9.1 je osnova ROPA-e; svaki **novi** izvoz (npr. Tempo van EU) unosi se u ROPA |
| **Prenos van EU** (čl. 44–49) | Ako Collector/Tempo/Slack nisu u EU, treba pravni osnov | Izabrati EU regione; u dokumentu **ne tvrditi** gdje servis hostuje bez provjere |
| **Sigurnost obrade** (čl. 32) | Telemetrija je append-only, sa kontrolom pristupa; tajne redaktovane | `audit` append-only hash-chain; `data/` van git-a; `no-cache` za statiku; pristup po tenantu |
| **Obavještavanje o incidentu** (čl. 33/34) | Ako telemetrija procure (npr. log sa PII) — to je incident | Runbook u `docs/08` §9; alert na „tajna u logu" (planirano) |

**Iskreno:** NMQ Robot **danas nije** GDPR-spreman za osjetljive klijente — nema retention job-a, nema PII
redakcije (samo redakcija tajni) i nema DPA/ROPA paketa. To nije stav „kasnije", to je **uslov za prvog
plaćenog klijenta** (`docs/10` §3, „Licence, ugovori, DPA, PDV").

---

## 10. Operativni dnevni ritam

Ritam je namjerno **kratak i fiksan** — ako traje duže, neće se raditi.

### Dnevno — 5 minuta (ujutro, uz kafu)

1. `GET /readyz` → `ok: true`, `llmIsMock: false`, broj agenata/alata kako se očekuje.
2. `GET /v1/admin/health` → `scheduler.running`, `scheduler.active`, `otel.exported` (da li raste?).
3. `GET /v1/usage` → trošak juče vs. prosjek; ako je > 2× prosjek → pogledaj koji agent/model (alert #8).
4. `GET /v1/approvals` → ima li nešto što čeka > 4 h (ručno, dok nema gauge-a i alerta #12).
5. Alerti u `#nmq-alerts` → samo P0/P1 zahtijevaju akciju istog dana; P2/P3 idu u nedjeljni pregled.
6. Ako je bio deploy: `POST /v1/...` smoke (`node scripts/smoke.mjs` → 13/13) + `audit-verify`.

**Zapis:** jedan red u dnevnik (datum, brojevi, šta je urađeno) — bez toga se „dnevni ritam" izgubi poslije 2 nedjelje.

### Nedjeljno — 30 minuta (petak)

1. **Trend (15 min):** broj runova, stopa greške, p95, trošak po tenantu/agentu/modelu — uporedi sa prošlom nedjeljom.
2. **Kvalitet (5 min):** svi 👎 iz `feedback_total`/feedback fajla; svaki 👎 bez komentara → pitati klijenta.
3. **Sigurnost (5 min):** `nmq_policy_denied_total` (novi obrasci?), `nmq_approvals_required_total`,
   cross-tenant (`FORBIDDEN`) = mora biti 0; audit lanac: `verify.ok === true`.
4. **Kapacitet (5 min):** veličina `data/`, najveći fajlovi, rast `otel-traces.jsonl`, disk %;
   ako disk > 80% → retention/arhiviranje.

**Pravilo:** svaki 👎 i svaki P2 alert dobija **jednu** odluku: (a) popravka, (b) izmjena praga,
(c) „ne radimo" sa razlogom. Ništa ne ostaje „viđeno".

### Mjesečno — 1 sat (prvi radni dan u mjesecu)

1. **SLO izvještaj (20 min):** dostupnost, p95 chat/poslovi, stopa grešaka, % odobrenja, error budget
   potrošen/popušten → isti brojevi idu klijentu (`docs/09` §7).
2. **Naplata (15 min):** `summary` po tenantu, marža (`trošak/prihod`), rekonsolidacija sa računom providera
   (**provjeriti cijene kod providera** i ažurirati tabelu sa datumom!), anomalije, heavy useri.
3. **Metrike i alerti (10 min):** koji alert je bio lažan (cilj < 20% false positive), koji nije bio
   akcioniran; koji panel na dashboardu niko nije otvorio → briše se.
4. **Retencija i privatnost (10 min):** da li retention job radi, koliko podataka je arhivirano, ima li PII
   u novim logovima (uzorak od 100 linija), da li je ROPA ažurna.
5. **Registar rizika (5 min):** ažuriranje `docs/10` (rizik koji nije ažuriran je zaboravljen) + zapis
   u `CHANGELOG`.

---

## Otvorena pitanja

1. **`traceId` koji OTel izvoz izvodi je gubitnički** (ULID → hex briše slova `g–z`). Prelazimo na pravi
   128-bitni hex `traceId` od početka (mijenja `uid('trace')` i sve testove), ili u izvozu računamo
   `sha256(runId)` i time **odvojimo** interni i OTel ID? Drugo je jeftinije, ali dvije istine o istom runu.
2. **Metrike po tenantu ili ne:** dodajemo li `tenant` labelu na `nmq_llm_*` i `nmq_tool_duration_seconds`
   (kardinalnost × broj tenanta) ili per-tenant latenciju čitamo isključivo iz trace-a u Tempo-u?
   Odluka mijenja i cijenu TSDB-a i to koliko dashboard može sam.
3. **PII u trace-u:** ostaje li današnje ponašanje (skraćivanje `input`/`output` na 2000/4000 znakova),
   ili prelazimo na `hash + 200 znakova` po default-u? Drugo je sigurnije ali ubija mogućnost debugovanja
   lošeg odgovora bez `capturePrompts` uključenog.
4. **Retencija trace-a 30 dana:** je li to dovoljno za klijenta koji traži „dokaži mi šta je robot uradio
   1. marta"? Ako nije, treba li trace (ili samo `span` sa `tool_call`) čuvati 7 godina kao audit —
   i ko plaća taj disk?
5. **Ko je vlasnik alerta van radnog vremena** (P0/P1 u 03:00) dok je tim jedna osoba — prihvatamo li
   „best-effort" i jasno to pišemo u ugovor (bez 24/7 SLA), ili uvodimo plaćeni on-call tek sa 3+ klijenta?
6. **Gdje živi observability stack** (Prometheus+Tempo+Grafana+Alertmanager): na istom VPS-u kao robot
   (jeftino, ali pad VPS-a gasi i monitoring — ne vidiš da si pao), ili na drugom hostu (dodatni trošak,
   ali pravi „izvan sistema" pogled)? Bez te odluke SLO za dostupnost je nemjerljiv.
