# 11 — Pokretanje, testiranje, održavanje

> Sve komande se pokreću iz korijena projekta: `E:\NMQ-PROGRAMI\nmq-robot`
> Deploy (Hetzner, Hostinger, Docker, Cloudflare) je u [`infra/DEPLOY.md`](../infra/DEPLOY.md).

---

## 1. Prvih pet minuta

```bash
node --test                # 162 testa, bez mreže i bez npm install
node scripts/demo.mjs      # demo: 21 sekcija (patterni, persistentni poslovi, kontrolna ravan, memorija, sandbox, OTel)
node scripts/serve.mjs     # gateway na http://127.0.0.1:8787 (widget + demo stranica)
node scripts/smoke.mjs     # 31 provjera protiv živog servera (uključujući /v1/admin/* i A2A)
node scripts/eval.mjs      # zlatni set (6 pitanja) — izlazi 1 ako je ispod praga (CI)
node src/cli.js help       # sve CLI komande
```

Ako nema `NMQ_LLM_API_KEY`, robot radi sa **mock LLM-om** — sve osim kvaliteta odgovora je identično
(alati, memorija, politike, trošak se računa po cijeni pravog modela).

---

## 2. Konfiguracija

| Fajl | Šta mijenjaš | Restart? |
|---|---|---|
| `.env` | port, LLM, budžeti, allowlist, master ključ | **da** |
| `config/agents/*.json` | agenti: prompt, alati, pattern, model, limiti | da (čita se pri startu) |
| `config/policies.json` | politike: allow/deny/approval, budžet, radno vrijeme | da |
| `config/tenants.json` | tenanti, planovi, API ključevi, webhook mapiranja | da |
| `config/tools.json` | MCP serveri, podešavanja ugrađenih alata | da |
| `public/widget/nmq-robot.js` | widget | ne (servira se po zahtjevu, bez keša) |

**Tajne NIKAD ne idu u ove fajlove.** Vrijednosti idu u `.env` (nije u git-u) ili u DSH store:

```powershell
node C:\Users\Administrator\.dsh\NMQ\get-key.mjs DEEPSEEK_API_KEY   # ispisuje vrijednost
node C:\Users\Administrator\.dsh\NMQ\get-key.mjs --has DEEPSEEK_API_KEY
```

Tajne **klijenata** (OAuth tokeni) idu u `data/tenants/<id>/secrets/secrets.enc.json` preko API-ja:

```bash
curl -X POST localhost:8787/v1/tenants/nmq/secrets \
  -H "content-type: application/json" \
  -d '{"provider":"slack","value":"xoxb-..."}'
```

Šifrovanje: AES-256-GCM, ključ `scrypt(NMQ_MASTER_KEY, "nmq-tenant:<tenantId>")`, AAD `<tenantId>:v1`.

---

## 3. Česte operacije

| Želim da… | Komanda |
|---|---|
| vidim agente / alate / patterne | `node src/cli.js agents` · `tools` · `patterns` |
| pokrenem jedan zadatak iz terminala | `node src/cli.js run support "Kako da resetujem lozinku?"` |
| simuliram webhook | `node src/cli.js hook shopify "Narudžbina 1042 kasni"` |
| vidim potrošnju po tenantu | `node src/cli.js cost` |
| provjerim audit lanac | `node src/cli.js audit-verify` |
| generišem API ključ | `node src/cli.js keys nmq owner` |
| dodam znanje klijentu (RAG) | `POST /v1/kb {text, source, tags}` |
| vidim šta je robot radio | `GET /v1/runs` · `GET /v1/runs/:runId` |
| odobrim akciju visokog rizika | `GET /v1/approvals` → `POST /v1/approvals/:runId {"approve":true}` |
| uradim backup podataka | `data/tenants/**` (pokriveno restic backup-om u 04:00) |

### MAX operacije (v0.2): persistentni agenti i kontrolna ravan

| Želim da… | Komanda |
|---|---|
| zakazem posao (cron) | `POST /v1/admin/jobs -d '{"name":"dnevni","agentId":"data","input":"izvještaj","schedule":{"type":"cron","cron":"0 8 * * 1-5"}}'` |
| pokrenem posao odmah | `POST /v1/admin/jobs/:jobId/run` |
| pauziram posao koji troši | `POST /v1/admin/jobs/:jobId/pause` · nastavak: `/resume` |
| vidim istoriju izvršavanja | `GET /v1/admin/jobs/:jobId/runs` |
| pokrenem dugoročni proces | `POST /v1/admin/processes -d '{"name":"onboarding","agentId":"ops","steps":[{"id":"d1","input":"kickoff"}]}'` |
| deploy nove verzije agenta | `POST /v1/admin/agents/support/deploy -d '{"patch":{"temperature":0.4},"note":"topliji ton"}'` |
| rollback agenta | `POST /v1/admin/agents/support/rollback -d '{"version":0}'` (0 = baseline iz config-a) |
| pauziram agenta | `POST /v1/admin/agents/sales/status -d '{"status":"paused","reason":"budžet"}'` |
| postavim budžet agentu | `POST /v1/admin/agents/sales/budget -d '{"budgetUsdMonth":30}'` |
| izdam per-agent ključ | `POST /v1/admin/agents/executor/keys -d '{"scopes":["crm:write"]}'` |
| vidim epizode (učenje) | `GET /v1/admin/episodes` |
| vidim stanje kontrolne ravni | `GET /v1/admin/health` |
| ko sam (ključ/rola) | `GET /v1/whoami` |
| provjerim OTel izvoz | `data/_global/otel-traces.jsonl` (OTLP/JSON, jedna linija = run) |

### Autonomni nivo (v0.3): ciljevi, proaktivnost, samo-učenje, organizacija, A2A

| Želim da… | Komanda |
|---|---|
| vidim koliko koji agent smije sam | `GET /v1/admin/autonomy` · provjera: `POST /v1/admin/autonomy/check {"agentId":"sales","riskLevel":"medium","kind":"act"}` |
| promijenim nivo autonomije | `POST /v1/admin/autonomy {"agentId":"sales","level":"L3"}` (role: owner) |
| postavim cilj | `POST /v1/admin/goals {"title":"+15% prihoda","metric":"revenue_eur","baseline":10000,"target":11500,"deadline":"2026-12-31","owner":"cro"}` |
| razbijem cilj na plan | `POST /v1/admin/goals/:goalId/decompose` |
| upišem mjerenje | `POST /v1/admin/goals/:goalId/progress {"value":10750,"note":"oktobar"}` |
| vidim šta kasni | `GET /v1/admin/goals?portfolio=1` |
| replaniram cilj | `POST /v1/admin/goals/:goalId/replan` |
| pretvorim plan u poslove | `POST /v1/admin/goals/:goalId/schedule {"stepDelayMs":86400000}` |
| vidim proaktivna pravila | `GET /v1/admin/watchers` · ručno: `POST /v1/admin/watchers/tick` |
| pošaljem mjerenje koje watcheri prate | `POST /v1/admin/watchers/metrics {"metric":"support_tickets_open","value":57}` |
| vidim inbox prijedloga | `GET /v1/admin/proposals?status=proposed` |
| odobrim/odbijem prijedlog | `POST /v1/admin/proposals/:id/decide {"approve":true,"by":"dejan"}` |
| primijenim / vratim prijedlog | `POST /v1/admin/proposals/:id/apply` · `POST /v1/admin/proposals/:id/rollback` |
| izmjerim efekat | `GET /v1/admin/proposals/:id/impact` |
| pokrenem A/B | `POST /v1/admin/experiments {"agentId":"creative","variants":[{"name":"A","specPatch":{"temperature":0.1}},{"name":"B","specPatch":{"temperature":0.9}}]}` |
| zaključim A/B | `POST /v1/admin/experiments/:id/conclude {"promote":true}` |
| pustim self-play | `POST /v1/admin/selfplay {"rounds":5,"solverAgent":"support"}` |
| vidim dataset/kurikulum | `GET /v1/admin/selfplay/dataset` · `GET /v1/admin/selfplay/curriculum` |
| pustim RSI analizu | `POST /v1/admin/rsi/cycle {"sinceDays":7}` |
| vidim nagrade po agentu | `GET /v1/admin/rewards?groupBy=agent&sinceDays=7` |
| vidim organizaciju | `GET /v1/admin/org` · KPI: `GET /v1/admin/org/kpis` |
| pustim ciklus planiranja | `POST /v1/admin/org/cycle {"period":"month"}` |
| pregovor između uloga | `POST /v1/admin/org/negotiate {"topic":"budžet Q1","between":["cfo","cro"]}` |
| A2A karta za partnere | `GET /.well-known/agent.json` |
| pošaljem A2A zadatak | `POST /a2a/tasks {"message":"...","skillId":"support","wait":true}` |
| A2A pregovor | `POST /a2a/negotiations {"counterparty":"partner","topic":"licence","offer":{"amountUsd":200}}` → `POST /a2a/negotiations/:id/respond` → `POST /a2a/negotiations/:id/close` |
| vidim poravnanja | `GET /a2a/settlements` (interni ledger — bez stvarnog novca) |

**Napomena o autonomiji (bitno pri puštanju u rad):** `config/autonomy.json` počinje sa `default: "L1"` (agent samo predlaže).
Nivo podiži tek poslije 2–4 nedjelje mjerenja: prvo L2 za agente sa stabilnom nagradom, pa L3 za one koji vode ciljeve.
`high` rizik i kategorije `financial`/`legal`/`destructive` nikad ne idu bez čovjeka (vidi `docs/20` i `docs/26`).

---

## 4. Kako se dodaje nova stvar

### Novi agent (bez koda)

```json
// config/agents/racunovodja.json
{
  "id": "racunovodja",
  "name": "Knjigovodstveni agent",
  "domain": "finance",
  "description": "Knjiži dokumente, pravi izvještaje, provjerava PDV.",
  "systemPrompt": "Ti si knjigovodstveni agent. ...",
  "defaultPattern": "sequential",
  "patternConfig": { "steps": [{ "agent": "racunovodja", "input": "{{input}}" }] },
  "tools": ["calculator", "report_generate", "memory_search", "kb_ingest", "current_time"],
  "maxRisk": "medium",
  "routingHints": ["knjiženje", "pdv", "kontni plan", "bilans", "izvod"],
  "maxSteps": 10
}
```

→ `GET /v1/agents` odmah pokazuje agenta, ruter ga može izabrati, politika se primjenjuje automatski.

### Nova integracija (MCP)

1. Nađi ili napiši MCP server (šablon: `mcp/example-server.mjs`).
2. Dodaj ga u `config/tools.json`:

```json
{ "id": "gmail", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-gmail"],
  "enabled": true, "riskLevel": "high", "scopes": ["mail:read", "mail:send"],
  "tools": { "send_email": { "riskLevel": "high" } } }
```

3. Provjeri: `GET /v1/mcp` → alat se pojavljuje kao `gmail.send_email`.
4. Dodaj ga u `tools` liste onih agenata kojima treba; u politici odluči da li traži odobrenje.

### Nova sposobnost (kod)

Dodaj alat u `src/tools/builtin.js` (obavezno: `name`, `description`, `params` JSON Schema, `riskLevel`, `handler`)
i test u `tests/tools.test.mjs`. Nema registracije — `registerBuiltinTools` ga pokupi.

---

## 5. Testiranje i provjere prije svake izmjene

```bash
node --test                         # 162 unit/integration testa
node scripts/eval.mjs --threshold 0.9   # kvalitet na zlatnom setu (kapija prije deploya)
node scripts/demo.mjs               # end-to-end kroz sve patterne (mora proći bez greške)
node scripts/smoke.mjs              # 13 HTTP provjera
node src/cli.js audit-verify        # hash lanac mora biti ispravan
```

| Test fajl | Šta dokazuje |
|---|---|
| `tests/policy.test.mjs` | politika (deny/approval/budžet/PII) i da se zabranjen alat ne izvršava |
| `tests/memory.test.mjs` | izolacija tenanta (sesija, istorija, vektori), chunking, embeddings |
| `tests/tools.test.mjs` | registry (timeout, retry, dry-run), ugrađeni alati, MCP stdio, allowlist |
| `tests/patterns.test.mjs` | svi patterni, handoff petlja, budžet, odobrenja, sesija |
| `tests/server.test.mjs` | gateway: rute, SSE, webhook, KB izolacija, rate limit, auth |
| `tests/observability.test.mjs` | trošak, metrike, hash-chained audit (+ detekcija izmjene), tenancy, tajne |

---

## 6. Rješavanje problema

| Simptom | Uzrok | Rješenje |
|---|---|---|
| `/readyz` kaže `llmIsMock` | nema `NMQ_LLM_API_KEY` | postavi ključ u `.env` i restartuj |
| Odgovori su „[mock] …" | mock provider | isto kao gore |
| `POLICY_DENIED` u odgovoru agenta | alat nije na allow listi ili je zabranjen | `config/policies.json` → `tenants.<id>.tools` |
| `APPROVAL_REQUIRED` / `awaiting_approval` | `high` rizik ili `requireApproval` | odobri kroz `POST /v1/approvals/:runId` ili promijeni politiku |
| `BUDGET_EXCEEDED` | run/mjesečni budžet ili `maxSteps` | `config/policies.json` → `budget`, `maxSteps` |
| MCP alat ne postoji | server nije pokrenut ili `enabled: false` | `GET /v1/mcp`, log `mcp.connect_failed` |
| `http_fetch` odbija domen | allowlist | `NMQ_HTTP_ALLOWLIST=api.deepseek.com,...` |
| Widget se ne osvježava na sajtu | keš (Hostinger/CDN) | statika je `no-cache`; koristi `?v=` i provjeri `x-robot-version` |
| Na Hostingeru „node: command not found" | Node nije na PATH-u | `/opt/alt/alt-nodejs22/root/bin/node` |
| Passenger ne odgovara | `app.js` mora export-ovati server | vidi `infra/DEPLOY.md` §B |
| Testovi padaju poslije izmjene prompta | mock skripta se poziva po sistemskom promptu | ažuriraj `tests/helpers.mjs` (`smartScript`) |

---

## 7. Sigurnosna pravila pri radu (obavezno)

1. **Nikad** ne ispisuj vrijednosti ključeva u chat, log ili commit — samo imena.
2. `.env` i `data/` su u `.gitignore`; provjeri `git status` prije svakog commita.
3. Prije deploy-a: backup `data/` (restic pokriva `E:\NMQ-PROGRAMI`).
4. Poslije izmjene politike ili agenata: `node src/cli.js audit-verify` i `GET /v1/usage`.
5. U produkciji `requireAuth: true` + generisan API ključ po klijentu.
6. Novi MCP server se dodaje samo ako je kod pregledan (ili je zvanični) — MCP server je izvršni kod.

---

## Otvorena pitanja

1. Da li `scripts/smoke.mjs` ide u CI (GitHub Actions) ili se pokreće ručno prije deploy-a?
2. Da li dashboard (faza 3) mijenja CLI komande ili ih samo dopunjuje?
3. Kako čuvamo `NMQ_MASTER_KEY` na VPS-u — systemd `EnvironmentFile` sa `chmod 600` ili Docker secret?
4. Da li klijentske tajne idu u Postgres (produkcija) ili ostaju šifrovani fajlovi?
5. Koliko često rotiramo API ključeve klijenata (predlog: 6 mjeseci + pri sumnji)?
6. Da li dozvoljavamo klijentu pristup `GET /v1/audit` (transparentnost) ili samo nama?

### Swarm i RSI (v0.4): roj, evolucija, meta-nivoi

| Želim da… | Komanda |
|---|---|
| vidim stanje roja | `GET /v1/admin/swarm` · tabla: `GET /v1/admin/swarm/board` · feromoni: `GET /v1/admin/swarm/pheromones` |
| registrujem workere | `POST /v1/admin/swarm/workers {"agents":[{"agentId":"support","skills":["support","general"]}]}` |
| postavim zadatke na tablu | `POST /v1/admin/swarm/tasks {"tasks":[{"title":"Ticket","payload":{"input":"...","tag":"support"},"requiredSkills":["support"],"value":3}]}` |
| pustim roj | `POST /v1/admin/swarm/run {"rounds":3}` (jedan otkucaj: `POST /v1/admin/swarm/tick`) |
| vidim emergentnu specijalizaciju | `GET /v1/admin/swarm/specialization` |
| promijenim izolaciju roja (board) | `POST /v1/admin/swarm/governance/isolation {"level":"contained"}` — nivoi: `open`, `contained`, `locked`, `frozen` |
| promijenim kvote (per-tenant) | `POST /v1/admin/swarm/governance/quotas {"maxWorkers":8,"maxCostPerHourUsd":1}` |
| zaustavim roj (kill switch) | `POST /v1/admin/swarm/freeze {"reason":"incident-42"}` · odmrzni: `POST /v1/admin/swarm/unfreeze {"level":"contained"}` |
| vidim sigurnosne nalaze i incidente | `GET /v1/admin/swarm/safety` · `GET /v1/admin/swarm/incidents` · ručna detekcija: `POST /v1/admin/swarm/safety/detect` |
| karantin nad workerom | `POST /v1/admin/swarm/quarantine {"workerId":"wrk_..."}` · puštanje: `POST /v1/admin/swarm/quarantine/:workerId/release` |
| pošaljem (medijisanu) poruku | `POST /v1/admin/swarm/message {"from":"wrk_...","to":"wrk_...","type":"status","payload":{"text":"..."}}` |
| pustim evoluciju agenata | `POST /v1/admin/evolution/evolve {"agentId":"support","populationSize":6,"generations":3}` |
| predložim pobjednika (čovjek odobrava) | `POST /v1/admin/evolution/promote {"agentId":"support"}` — auto varijanta traži `owner` i **isključena** je |
| vidim RSI nivo i istoriju | `GET /v1/admin/rsi` · `GET /v1/admin/rsi/research` |
| promijenim RSI nivo (samo board) | `POST /v1/admin/rsi/level {"level":"R2","reason":"board odobrio"}` (traži odgovarajuću autonomiju) |
| pustim RSI eksperiment | `POST /v1/admin/rsi/experiment {"agentId":"support","strategy":"temperature","promote":true}` |
| pribavim iskustvo (R3) | `POST /v1/admin/rsi/experience {"rounds":5,"agentId":"support"}` |
| prilagodim se novom okruženju (R4) | `POST /v1/admin/rsi/adapt {"target":"domain","value":"pravo","agentId":"support"}` |
| pustim meta-analizu (R5) | `POST /v1/admin/rsi/meta` — vraća **predloge**, ne mijenja proces sam |

**Redoslijed puštanja u rad (preporuka):** `contained` izolacija + R1 nivo + `autoPromote:false` (tvornički default).
Izolaciju otvarajte (`open`) samo za tenanta kojem je mreža stvarno potrebna; RSI nivo podižite tek kad eval prolaznost pređe 80% na **pravom** modelu.

### Cross-node klaster (v0.5): roj preko više procesa/mašina

| Želim da… | Komanda |
|---|---|
| uključim klaster | `NMQ_CLUSTER=1 NMQ_CLUSTER_SECRET=<tajna> NMQ_CLUSTER_PORT=8790` (bez tajne se klaster NE pokreće) |
| koristim Redis za tablu | `NMQ_REDIS_URL=redis://127.0.0.1:6379` (bez toga: deljeni direktorijum u `data/_cluster/board`) |
| vidim stanje čvora | `GET /v1/admin/cluster` · članovi: `GET /v1/admin/cluster/members` |
| pridružim čvor klasteru | `POST /v1/admin/cluster/join {"peers":["10.0.0.2:8790"]}` (role `owner`) |
| objavim zadatak na zajedničku tablu | `POST /v1/admin/cluster/tasks {"tasks":[{"title":"...","payload":{"input":"..."},"value":3}]}` |
| pustim cross-node izvršavanje | `POST /v1/admin/cluster/run {"maxRuns":4}` (lease se produžava dok posao traje) |
| vidim tablu i feromone | `GET /v1/admin/cluster/board` |
| pošaljem poruku kroz mrežu | `POST /v1/admin/cluster/message {"from":"wrk_...","type":"status","payload":{"text":"..."}}` |
| karantin čvora | `POST /v1/admin/cluster/quarantine/:nodeId {"reason":"incident"}` · skidanje: `POST /v1/admin/cluster/release/:nodeId` (role `owner`) |

**Sigurnosna pravila:** svaka poruka je HMAC-potpisana; nepotpisan/tuđ potpis, istekao timestamp i prekoračenje rate limita se odbijaju;
ulazna poruka prolazi **istu medijaciju** kao lokalna, a karantin čvora je „sticky" (heartbeat ga ne vraća u život).
