# 01 — Arhitektura

> **v0.2 dopuna:** ovaj dokument opisuje sloj iz v0.1.0. Novi slojevi su dodati i opisani u
> `docs/12-MAX-ARHITEKTURA.md` (kontrolna ravan, scheduler, sandbox, OTel) i `docs/13-KONTROLNA-RAVAN.md`.
> Kod: `src/scheduler/`, `src/controlplane/`, `src/core/sandbox.js`, `src/observability/otel.js`.
> Brojevi patterna/agenata u tekstu su stanje v0.1.0.

> Kod je referenca: putanje u ovom dokumentu odgovaraju stvarnim fajlovima. Ugovor je u `DECISIONS.md`.

---

## 1. Komponente

| # | Komponenta | Fajl | Odgovornost | Ne radi |
|---|---|---|---|---|
| 1 | **Gateway** | `src/server/http.js`, `routes.js`, `stream.js` | HTTP/SSE, CORS, auth, rate limit, validacija, mapiranje grešaka, statika (widget) | ne zna za LLM ni za alate |
| 2 | **Tenancy** | `src/tenancy/store.js` | dokazivanje tenanta (API ključ), role, rate limit, kill switch, AES-256-GCM tajne | ne piše u memoriju |
| 3 | **Policy engine** | `src/core/policy.js` | `allow / deny / require_approval`, PII redakcija, uslovi po alatu | ne izvršava ništa |
| 4 | **Budget** | `src/core/budget.js` | tokeni, USD, koraci, vrijeme — fail-closed prekid | ne računa cijenu modela |
| 5 | **Orchestrator** | `src/orchestration/index.js` + 6 patterna | izbor patterna, `ctx`, raspodjela rada, sinteza | ne zove LLM direktno u agentu (samo preko `runAgent`/`helpers.callLlm`) |
| 6 | **Agenti** | `src/agents/agent.js`, `catalog.js`, `router-agent.js`, `critic.js` | petlja LLM↔alati, prompt, memorija, handoff, ocjena kvaliteta | ne znaju za HTTP |
| 7 | **Tool registry** | `src/tools/registry.js` | jedna ulazna tačka za alate: politika → budžet → izvršenje → audit → metrike | ne zna odakle alat dolazi |
| 8 | **Alati** | `src/tools/builtin.js` (21) + `mcp-*.js` | stvarne akcije i integracije | ne provjeravaju politiku same |
| 9 | **Memorija** | `src/memory/{session,longterm,vector,embeddings}.js` | sesija, istorija/facts, RAG sa citatima | ne odlučuje šta je dozvoljeno |
| 10 | **LLM** | `src/llm/{index,openai-compatible,mock}.js` | provider adapter, fallback lanac, keš, streaming | ne zna za domene |
| 11 | **Observability** | `src/observability/{trace,metrics,cost,audit}.js` | trace/span, metrike, trošak, hash-chained audit | ne mijenja tok izvršavanja |
| 12 | **Config** | `src/core/config.js` + `config/*.json` | agenti, politike, tenanti, MCP serveri, env | ne sadrži tajne vrijednosti |

Sve se spaja u `src/index.js` (`createRobot`) — jedan objekat `robot` koji sadrži sve servise.
Testovi i skripte ga pozivaju sa `overrides` (npr. mock LLM) — zato je cijeli sistem testiran bez mreže.

---

## 2. Kako komponente komuniciraju

```
klijent ──HTTP/SSE──▶ Gateway ──▶ Tenancy.authenticate() ──▶ rate limit ──▶ role check
                                                                    │
                                                                    ▼
                                            robot.orchestrator.run({tenantId, agentId, input, …})
                                                                    │
                    ┌───────────────────────────────────────────────┼───────────────────────────────┐
                    ▼                                               ▼                               ▼
            Policy.resolvePolicy()                          Tracer.startRun()                Budget.create()
                    │                                               │                               │
                    └───────────────▶ pattern.run({input, ctx}) ◀───┴───────────────────────────────┘
                                                     │
                        ┌────────────────────────────┼────────────────────────────┐
                        ▼                            ▼                            ▼
                  runAgent(spec)              helpers.callLlm()            tools.execute()
                  (LLM ↔ alati, memorija)     (planer/sinteza/kritičar)    (politika → audit → metrike)
                        │                            │                            │
                        └──────────────▶ cost.record() ──▶ data/tenants/<id>/usage/…​ ◀──┘
                                                     │
                                          Tracer.endRun() ──▶ traces + metrike
```

**Protokoli i oblici:**

| Veza | Protokol / oblik |
|---|---|
| Klijent ↔ Gateway | HTTP/JSON + SSE (`text/event-stream`), webhook POST |
| Gateway ↔ Orchestrator | direktan JS poziv, `onEvent` callback za streaming |
| Orchestrator ↔ Agent | `runAgent(spec, input, ctx) → {output, steps, usage, costUsd, approvals, handoffs}` |
| Agent ↔ LLM | OpenAI-kompatibilan `chat/completions` preko `fetch` (+ SSE za streaming) |
| Agent ↔ Alati | `tools.execute(name, args, ctx)` — JSON Schema parametri, `riskLevel` |
| Gateway ↔ MCP | JSON-RPC 2.0: `stdio` (jedna linija = jedna poruka) ili Streamable HTTP |
| Sve ↔ Memorija | `tenantId` je prvi argument svake operacije |
| Sve ↔ Observability | sinkroni pozivi (trace/metrics/cost/audit), bez uticaja na ishod |

**Ključna pravila toka:**

1. **Nijedan alat se ne izvršava mimo `tools.execute`** — politika, budžet i audit su tu, i MCP alati prolaze kroz isto.
2. **Svaki LLM poziv van agenta ide kroz `helpers.callLlm`** — inače trošak ne uđe u `cost.record` ni u budžet.
3. **`ctx` je jedini nosač stanja** — sadrži `tenantId`, `runId`, `trace`, `budget`, `policy`, `approvedTools`, `blackboard`, `signal`, `memory`, `tools`, `helpers`.
4. **Prekid iz UI-a** (`AbortSignal`) se provjerava prije klasifikacije greške, da backoff ne pokrene prekinuti poziv ponovo.

---

## 3. Multi-tenancy i izolacija

Tri nivoa, svaki nezavisan (ako jedan padne, drugi drže):

| Nivo | Kako radi | Gdje | Test |
|---|---|---|---|
| **Fizički** | Sve tenantove stvari su u `data/tenants/<tenantId>/…` (sessions, memory, vectors, audit, traces, usage, outbox, crm) | `src/core/fsx.js` + putanje u modulima | `tests/memory.test.mjs` |
| **Logički** | `tenantId` je obavezan prvi argument; vektorski zapis nosi `metadata.tenantId` koji se **normalizuje pri upisu**; upit filtrira i po bucketu i po metadata | `src/memory/vector.js` | „podmetnut dokument" test |
| **Produkcijski** | PostgreSQL RLS: `USING` + `WITH CHECK` nad `current_setting('app.tenant_id')`, `set_config(..., true)`, rola bez `BYPASSRLS` | `docs/02` §4, `docs/05` §5 | test izolacije po tenantima |

Dodatno:

- **API ključ** se čuva samo kao `sha256(pepper + ključ)`; auth vraća `{tenantId, role}` i to je jedini izvor identiteta.
- **Role**: `owner` (`*`), `admin`, `operator`, `viewer` — `requiredRole` na ruti (npr. `manage-kb`, `approve`, `run`).
- **Kill switch**: `tenants.setSuspended(id, true)` → svaki zahtjev tog tenanta dobija 403.
- **Tanent može samo da pooštri politiku** (`resolvePolicy` spaja `defaults` sa tenantom; allow liste se mogu samo suziti).
- **`allowedAgents`**: tenant može biti ograničen na podskup agenata (npr. `demo-shop` ne smije `finance`).

---

## 4. Tok jednog zahtjeva (najvažniji slučaj)

```
POST /v1/agents/sales/run  { input: "Pripremi ponudu za Prima d.o.o." }
  1. Gateway: parsira tijelo, CORS, request-id
  2. Tenancy: API ključ → tenantId=nmq, role=owner; rate limit 120/min; role smije "run"
  3. Orchestrator.run():
     a. tenant postoji, agent postoji, agent dozvoljen tenantu
     b. policy = resolvePolicy(policies, 'nmq', {agentId:'sales'})
     c. tracer.startRun() → runId, traceId
     d. cost.monthlySpent('nmq') → koliko je već potrošeno ovaj mjesec
     e. budget = createBudget({runUsd: 1.5, monthlyUsd: 200, maxSteps: 14})
     f. pattern = 'orchestrator-worker' (default agenta)
  4. Pattern:
     a. helpers.callLlm(planer) → plan sa 2 podzadatka   [budžet + trošak + span]
     b. za svaki podzadatak: runAgent(spec) → LLM ↔ alati (politika po alatu)
     c. helpers.callLlm(sinteza) → jedan finalni odgovor
  5. Agent (unutar podzadatka):
     a. RAG recall (KB + facts + skorašnji događaji) → sistem prompt
     b. loop: llm.chat(tools) → ako traži alat: tools.execute(...) → nazad u LLM
        - alat visokog rizika bez odobrenja → run staje (awaiting_approval), audit zapis
        - alat zabranjen → agent dobija "denied" i nastavlja bez njega
        - isti alat 3x sa istim argumentima → LOOP_PREVENTED
     c. upis u sesiju (PII redaktovan) i u dugoročnu memoriju
  6. Tracer.endRun() → trace na disk + metrike (trajanje, trošak, status)
  7. Odgovor: { runId, agentId, pattern, output, usage, costUsd, steps, durationMs, approvals }
```

Isti tok važi i za SSE (`/stream`): razlika je samo `onEvent` → SSE događaji (`routing`, `plan`, `worker_start`, `tool_start`, `token`, `usage`, `final`, `done`, `error`).

---

## 5. Izbor patterna

| Ulaz | Pattern | Zašto |
|---|---|---|
| Nepoznat zahtjev | `router` | prvo prepoznaj namjeru; heuristika, LLM samo ako treba |
| Jedno pitanje / jedan zadatak | `agent` | najjeftinije |
| Linearni proces | `sequential` | redoslijed je dio posla (analiza → plan → dokument) |
| Kompleksan zadatak sa podzadacima | `orchestrator-worker` | planer + workeri + sinteza |
| Isti ulaz iz više uglova | `fanout` | paralelno + spajanje (synthesis/concat/vote) |
| Specijalizacija / eskalacija | `handoff` | predaja sa razlogom, bez ping-ponga (max 3, bez ponovnog agenta) |
| Nema plana unaprijed | `magentic` | plan → akcija → refleksija → korekcija, uz kritičara |

Pattern se zadaje: eksplicitno (`{"pattern":"fanout"}`) → ili defaultom agenta (`defaultPattern` u JSON-u) → ili `router`.
Scenario se opisuje u `patternConfig` (npr. `sequential.steps`, `fanout.workers`) — **bez izmjene koda**.

---

## 6. Gdje se šta mijenja (extension points)

| Želim da… | Mijenjam | Ne diram |
|---|---|---|
| dodam agenta | novi `config/agents/<id>.json` | kod |
| promijenim ponašanje agenta | `systemPrompt`, `tools`, `maxSteps`, `temperature` u JSON-u | kod |
| dodam scenario (više koraka) | `patternConfig` | kod |
| pooštrim politiku za klijenta | `config/policies.json` → `tenants.<id>` | kod |
| dodam integraciju | `config/tools.json` → `mcpServers[]` (+ MCP server) | kod orchestratora |
| dodam internu sposobnost | novi alat u `src/tools/builtin.js` (i test) | agenti |
| zamijenim LLM | `NMQ_LLM_*` env ili `NMQ_LLM_FALLBACKS` | sve ostalo |
| pređem na Postgres/Redis | implementirati isti interfejs (`VectorStore`, `SessionStore`) | agenti i patterni |

---

## 7. Odluke koje su oblikovale arhitekturu

| Odluka | Alternativa | Zašto smo izabrali ovako |
|---|---|---|
| Vlastiti tool registry, ne framework | LangChain/CrewAI | politika, audit i budžet moraju biti **jedna** tačka; framework bi ih razbacao |
| Alati i agenti kao **podaci** | kod po agentu | uvođenje klijenta postaje konfiguracija, ne sprint |
| Fajl-skladište u MVP-u | odmah Postgres | MVP se pokreće jednom komandom, na Hostingeru i na laptopu, bez migracija |
| SSE, ne WebSocket | WS kroz proxy/CDN | SSE prolazi svuda, trivijalan klijent, dovoljno za tok odgovora |
| Hash-chained audit u fajlu | samo log | dokaz nepromjenljivosti bez skupe infrastrukture |
| `tenantId` kao prvi argument | middleware koji „postavi kontekst" | nemoguće zaboraviti ga u novom kodu — tip puca odmah |
| Mock LLM kao prva klasa | samo pravi model | demo i testovi bez troška i bez interneta; regresije se hvataju deterministički |

---

## 8. Šta arhitektura još ne pokriva (i gdje je plan)

| Nedostatak | Posljedica | Plan |
|---|---|---|
| Nema queue (sve je sinhrono u requestu) | dugi zadaci drže konekciju | v1: BullMQ/Redis ili `node:worker_threads` + `POST /v1/jobs` |
| Nema ugniježđenih patterna sa provjerom dubine | teoretski duboka rekurzija | v0.2: `ctx.depth` + `maxDepth = 2` |
| Nema dashboarda | operater vidi samo API i `journalctl` | v0.2: mali HTML dashboard na `/admin` (runs, trošak, odobrenja) |
| Nema multi-step odobrenja (4 oka) | jedan odobrava sve | v0.3: `approvalPolicy` po alatu i iznosu |
| Vektorska pretraga je brute-force | ~10k dokumenata po tenantu je gornja granica | v1: pgvector/Qdrant kroz isti interfejs |
| Nema evaluacije kvaliteta po klijentu | ne znamo da li odgovori postaju bolji | v0.3: `eval/` zlatni set + automatska ocjena |

---

## Otvorena pitanja

1. Da li dashboard gradimo u našem stack-u (bez zavisnosti) ili kao Next.js odvojen servis?
2. Queue: Redis (postoji na VPS-u) ili `node:worker_threads` bez nove infrastrukture?
3. Da li `handoff` smije prelaziti između patterna (npr. handoff unutar fanout-a) ili ostaje jedan nivo?
4. Koliko dokumenata po tenantu planiramo prije prelaska na pgvector?
5. Da li tenant smije imati sopstveni sistem prompt (white-label ton) ili samo izbor agenata?
6. Gdje ide „ljudski" inbox za odobrenja — mejl, Slack ili dashboard (ili sva tri)?
