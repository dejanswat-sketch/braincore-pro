# 27 — Roadmap 24 mjeseca: od agenta do AI ekonomije

> **Svrha:** strateški dokument za investitore. Odgovara na tri pitanja: **šta je stvarno napravljeno**
> (dokaz, ne tvrdnja), **šta gradimo u 24 mjeseca** (faze, dokazi, trošak) i **šta namjerno NE radimo**.
>
> **Ugovor:** ovaj dokument ne smije biti u koliziji sa `docs/DECISIONS.md`. Ako se tvrdnja ovdje razlikuje
> od koda, **kod je tačan** i ovaj dokument se ispravlja. Odluke D1–D36 iz `DECISIONS.md` §1 i §8 važe.
>
> **Pravila pisanja (važe za svaki broj i svaku tvrdnju u dokumentu):**
> 1. **Svaka finansijska brojka je „procjena"** — uz nju stoji **način na koji je izvedena**.
> 2. **Nijedna cijena modela nije činjenica** — u kodu je tabela `PRICING` (`src/observability/cost.js`) sa
>    napomenom „provjeriti!", a svaka upotreba ide uz **„provjeriti kod provajdera"** (D36: nepoznat model
>    se broji u `nmq_pricing_fallback_total`, da marža ne bi tiho pobjegla).
> 3. **Ne postoje klijenti, prihodi ni partnerstva.** Sve što je buduće piše kao **plan** ili **procjena**.
> 4. **Nikad se ne upisuju vrijednosti ključeva** — samo **imena** env varijabli.
> 5. Dokazi se navode **imenom komande/fajla**, ne opisom („radi" nije dokaz).

**Stanje verzije (provjereno na kodu, 30.09.2026):** kod deklariše `VERSION = '0.2.0'`
(`src/index.js`, `package.json`), a `docs/DECISIONS.md` §8 dokaze vodi kao „stanje v0.2.1".
**v0.3 nije oznaka u kodu** — v0.3 je *autonomni nivo* kao skup sposobnosti opisanih u ovom dokumentu
(autonomija L0–L4, ciljevi, watchers, self-improvement, self-play, RSI, AI organizacija, A2A).
Ako investitor traži „koju verziju gledam" — odgovor je: **kod 0.2.0, sposobnosti opisane kao v0.3**,
i prvi zadatak faze 0 je da se te dvije stvari usklade (`VERSION`, `package.json`, `DECISIONS.md` §7).

---

## 0. Sažetak za investitora (1 strana)

**Šta firma radi (2 rečenice).** NMQ (Dejan Milošević PR) gradi **NMQ Robot** — univerzalni, multi-tenant
AI agent koji se ugrađuje i u sajt (JS widget) i u interne procese (REST/webhook), i koji **izvršava
stvarne akcije** (mejl, faktura, CRM, ticket, izvještaj) pod politikom, budžetom i dokazivim audit tragom.
Za razliku od chat bota i od framework-a, robot ima **kontrolnu ravan, autonomiju sa nivoima, mjerenje
kvaliteta i ugrađeno učenje** — a sve to sa **nula obaveznih npm zavisnosti** (D2) i fizičkom izolacijom
podataka po klijentu (D11, D12).

**Šta je već napravljeno i dokazano (brojevi su iz koda i iz pokrenutih komandi):**

| Dokaz | Broj / ishod | Kako je provjereno |
|---|---|---|
| Testovi | **150 prolazi, 0 pada** (9 fajlova, bez mreže, bez `npm install`) | `node --test` → `tests 150 / pass 150 / fail 0` |
| Demo | **21 sekcija bez greške** (patterni, memorija, naplata, autonomija, self-improvement, A2A) | `node scripts/demo.mjs` |
| Smoke nad živim gateway-em | **21/21** | `node scripts/smoke.mjs` |
| Agenti | **19**, definisani **podacima** (`config/agents/*.json`) | `node src/cli.js agents` |
| Ulazi / orchestration patterni | **11** (`agent`, `react`, `router`, `sequential`, `orchestrator-worker`, `fanout`, `handoff`, `magentic`, `reflection`, `debate`, `team`) | `PATTERNS` u `src/orchestration/index.js` |
| Alati | **20 ugrađenih** + **3 kroz 1 MCP server** = 23 vidljiva | `node src/cli.js tools`, `GET /v1/mcp` |
| Scheduler | interval/cron/once, event triggeri, **dugoročni procesi sa checkpoint-om** (preživljava restart) | `src/scheduler/`, `tests/max.test.mjs` |
| Kontrolna ravan | deploy / rollback / pause / retire, per-agent ključ (`nmqa_…`, čuva se **samo hash**), per-agent mjesečni budžet | `src/controlplane/registry.js`, `tests/max.test.mjs`, `tests/revision.test.mjs` |
| Autonomija | **L0 assistant → L4 autonomous**; `high` rizik i kategorije `financial/legal/destructive/external_communication` traže čovjeka **na svim nivoima** | `src/core/autonomy.js`, `config/autonomy.json` |
| Self-improvement | prijedlog → **odobrenje čovjeka** → primjena → mjerenje efekta → **rollback**; A/B po run-u | `src/learning/improvements.js`, `tests/autonomy.test.mjs` |
| Self-play | proposer → solver → judge; dataset `learning/training-YYYY-MM.jsonl` za budući trening | `src/learning/selfplay.js` |
| RSI (recursive self-improvement) | analiza iz nagrada, trace-a, ciljeva i troška → **prijedlozi** (nikad automatska izmjena koda) | `src/learning/rsi.js` |
| AI organizacija | **7 uloga** (ceo, cro, coo, cfo, cto, chro, cso) sa mandatima, KPI-jevima i budžetima; ciklus + strukturisano pregovaranje | `config/company.json`, `src/org/company.js` |
| A2A | taskovi sa stanjima + SSE tok, pregovaranje sa **tvrdim granicama**, interni ledger | `src/a2a/*.js`, rute `/a2a/*` |
| Infrastruktura | Docker + compose, systemd, **K8s manifesti** (namespace/kvote/NetworkPolicy/RBAC/HPA/PDB/ExternalSecret), **18 alert pravila**, Grafana dashboard, OTel Collector config | `infra/` (`k8s/base/`, `observability/`) |
| Observability | trace/span, Prometheus metrike (**73 imena metrika u kodu**), cost tracker, **hash-chained audit** (`node src/cli.js audit-verify`) | `src/observability/*` |
| Zavisnosti | **`dependencies: {}`** — nula obaveznih paketa | `package.json` |

**Šta tražimo (procjena).** Tražimo **[IZNOS]** uz **[X]%** udjela, odnosno **[IZNOS]** u fazi 0–12 mjeseci
i **[IZNOS]** u fazi 12–24 mjeseca (dvije tranše vezane na dokaze iz §2 i §3, ne na protok vremena).
[IZNOS] se ne popunjava „osjećajem": izvodi se iz §8 (12 mjeseci troška + rezerva 3 mjeseca), a investitor
dobija **uslov za tranšu 2**: 3 plaćena klijenta i > 60% riješeno bez čovjeka (KPI faze iz §2).

**Na šta se troši (procjena, izvedeno iz §7 i §8):**

| Namjena | Udio (procjena) | Zašto baš to |
|---|---|---|
| **Ljudi** (inženjer + prva linija podrške, pa prodaja) | **60–70%** | Trošak modela je na ovom obimu mali; usko grlo su **integracije i support**, ne tokeni |
| **Prodaja i akvizicija** (put, sadržaj, demo na podacima klijenta, piloti) | **10–15%** | Bez plaćenog pilota nema nijedne druge brojke u ovom dokumentu |
| **Pravno i sigurnost** (DPA/ugovor, pen-test, GDPR osnova) | **8–12%** | Prvi plaćeni klijent traži ugovor **prije** starta, ne poslije (`docs/10` §3) |
| **Infrastruktura** (VPS, kasnije K8s, backup, monitoring) | **5–10%** | Jedan mali VPS pokriva prve klijente (`docs/09` §4); klaster je trošak **faze 2** |
| **Modeli / API** | **5–8%** | Trošak modela / prihod je cilj **< 15%** (`docs/00` §6); pravilo cijene 3–4× (§8) |
| **Rezerva** | **10%** | Rizik „1–2 osobe": bolest, odmor, izgubljen mjesec (§9) |

**Cilj za 24 mjeseca — 4 mjerljiva cilja:**

1. **Prihod:** **ARR [procjena] 300.000–600.000 EUR** u baznom scenariju, sa **≥ 40% iz kanala/enterprise**
   (ne samo direktna prodaja) — izvedeno iz broja klijenata × ARPU (tabela u §8, ne iz želje).
2. **Klijenti:** **60–80 plaćenih klijenata** na kraju 24. mjeseca (od toga **≥ 6 enterprise**), sa
   **churn < 3%/mj.** na Pro segmentu — izvedeno iz kapaciteta podrške (§7), ne iz tržišnog udjela.
3. **Kvalitet i autonomija:** **> 60% zahtjeva riješeno bez čovjeka** na prvoj vertikali i
   **trošak modela < 15% prihoda**, dokazano na **zlatnom setu** (eval harness) koji **blokira regresiju > 5%**.
4. **Ekonomija agenata:** **≥ 2 A2A partnera u produkciji** i **≥ 1.000 A2A transakcija** (zadatak ili
   poravnanje) mjesečno, sa **pravim poravnanjem** (Stripe/SEPA), a ne internim ledger-om.

**Iskreno — šta još NIJE dokazano (ovo investitori čitaju prvo, i ovo je naš najjači signal):**

| Nije dokazano | Stvarno stanje u kodu/repozitoriju |
|---|---|
| **Nijedan plaćeni klijent** — nijedan prihod, nijedan potpisan ugovor, nijedan ugovor o pilotu | Ne postoji; sve u §2–§5 je **plan** |
| **Nijedan pravi model izmjeren u produkciji** — adapter postoji, mjerenja nema | `src/llm/openai-compatible.js` postoji; zlatni set i eval izvještaj **ne postoje** |
| **Nema fine-tuninga** — nema SFT/LoRA, nema reward modela iz ljudskih ocjena | Postoji **dataset** (`learning/training-YYYY-MM.jsonl`) i **heuristički reward** (`src/learning/rewards.js`); trening je van procesa i nije rađen |
| **Nema SOC 2 / ISO 27001 / pen-testa** — nijedan nezavisni nalaz | `docs/08`, `docs/17`; u `docs/19` §3.1 eksplicitno „ne može jedna osoba" |
| **A2A poravnanje je simulacija** — interni ledger, bez novca, bez blockchain-a | `src/a2a/negotiation.js` to **samo kaže**: „Interni ledger (simulacija) — nema stvarnog prenosa novca" |
| **Nema K8s klastera** — manifesti nisu bili `kubectl apply` | `docs/19` §0 to navodi kao dokaz da manifesti nisu primijenjeni; `replicas: 1` jer nema distributed lock-a |
| **Nema Postgres/pgvector/Redis** — sve na fajl-sistemu (JSONL) | D7/D8; prelaz je plan faze 2 (§3) |
| **Integracije su interni alati + 1 MCP šablon** — nema Gmail/Shopify/Slack/CRM u produkciji | `config/tools.json`: `nmq-crm` (šablon) + `nmq-internal-http` (`enabled: false`) |
| **Nema dashboarda** — odobrenja se danas daju API pozivom (`POST /v1/approvals/:runId`) | `docs/DECISIONS.md` §7; dashboard je plan faze 1 (§2) |
| **Nema OIDC/SSO/MFA** | `docs/13` §4: „Fali: OIDC / SSO (ljudski identitet)" |
| **API ključ agenta se ne može poslati na gateway** | `docs/13` §4 — ključ je „mrtav za API"; `scopes` se ne provjeravaju pri izvršenju |
| **AI organizacija i RSI rade u demo/test režimu** | `tests/autonomy.test.mjs`, demo sekcije 19–21; nijedan stvarni ciklus nad stvarnim podacima |
| **Tim je 1–2 osobe** | `docs/19` §3.1; key-man rizik je u §9 ovog dokumenta |

---

## 1. Gdje smo sada (v0.3)

Zrelost je procijenjena **strogo**: `eksperimentalno` = radi u testu/demu, nije vidjelo ni jednog stranog
korisnika ni opterećenje; `beta` = radi i može se pokazati klijentu, ali nema mjerenja na pravim podacima,
ni sigurnosnog nalaza, ni operativne istorije; `produkcijski spremno` = ima dokaz, ima granicu, ima
runbook i može se ugovorom obećati.

| Sloj | Šta postoji | Dokaz | Zrelost |
|---|---|---|---|
| **Gateway (REST/SSE/webhook/CORS/rate limit)** | micro-router na `node:http`, 11 ulaza, webhook rute, widget | `scripts/smoke.mjs` 21/21, `tests/server.test.mjs` | **produkcijski spremno** (uz `NMQ_ALLOW_ANONYMOUS=0` i `requireAuth: true`) |
| **Multi-tenancy i izolacija** | `tenant_id` obavezan u svakoj operaciji, fizički folderi, kill switch, AES-256-GCM tajne | `tests/memory.test.mjs`, `tests/server.test.mjs`, `tests/revision.test.mjs` | **produkcijski spremno na fajl-sistemu**, ne na više replika (nema RLS) |
| **Policy + budžet + human-in-the-loop** | allow/deny/require_approval, tri nivoa budžeta (run/tenant/agent), PII redakcija, `maxToolRepeats` | `tests/policy.test.mjs`, `tests/autonomy.test.mjs` | **produkcijski spremno** (politike su fail-closed) |
| **Observability** | trace/span, 73 imena metrika, cost tracker, **hash-chained audit** + verify, OTLP/JSON izvoz | `tests/observability.test.mjs`, `node src/cli.js audit-verify`, `GET /metrics` | **produkcijski spremno u kodu**; **beta u operaciji** (nema kolektora, nema scrape-a, nema eksternog sidrenja audit lanca) |
| **Kontrolna ravan** | deploy/rollback/pause/retire, verzije + `specHash`, per-agent ključ (samo hash), per-agent budžet | `tests/max.test.mjs`, `tests/revision.test.mjs`, `GET /v1/admin/*` | **beta** — override je **globalan po agentu**, ne po tenantu (`docs/13` §3); `nmqa_…` ključ se ne prihvata na gateway-u; `lastUsedAt` se ne perzistira (`docs/13` §4, „defekt") |
| **Scheduler / persistentni agenti** | interval/cron/once, event triggeri, dugoročni procesi sa checkpoint-om, retry, fajl-lease | `tests/max.test.mjs` (7 testova), demo sekcije 12–13 | **beta** — lease **nije** distributed lock (D22); **zabranjeno** više od 1 replike (`infra/k8s/base/deployment-scheduler.yaml`) |
| **Sandbox** | nivoi `none/restricted/strict`, mrežna allowlista, FS korijeni, očišćen env za MCP podprocese | `src/core/sandbox.js`, `tests/max.test.mjs` (4 testa) | **beta** — aplikativni sloj; OS izolacija (namespaces/seccomp) je na kontejneru, **nije** primijenjena na klasteru |
| **MCP klijent** | vlastiti JSON-RPC 2.0: `stdio` + Streamable HTTP, interni šablon server (3 alata) | `tests/tools.test.mjs` (uključujući „mrtav server daje jasnu grešku") | **beta** — tačno **1** server je šablon; nema ni jedne prave eksterne integracije |
| **Memorija** | sesija, istorija/facts, vektorska baza (brute-force cosine), epizodična memorija, GDPR brisanje | `tests/memory.test.mjs`, `tests/max.test.mjs` | **beta** — brute-force pretraga; prag prelaska na pgvector je **> 20 tenanta ili > 100 MB po fajlu** (`docs/10` §1) |
| **Autonomija L0–L4** | nivoi po tenantu i agentu, `HUMAN_ONLY` kategorije, audit svake odluke, `POST /v1/admin/autonomy` | `src/core/autonomy.js`, `config/autonomy.json`, `tests/autonomy.test.mjs` | **eksperimentalno** — model je jasan i testiran, ali **nijedan nivo nije kalibrisan na stvarnom saobraćaju** |
| **Ciljevi (goals)** | cilj → podciljevi → plan → KPI → mjerenje → replan → zakazivanje poslova | `src/goals/manager.js`, demo sekcija 17 | **eksperimentalno** — mjerenje metrike je i dalje uglavnom ručno/API |
| **Watchers (proaktivnost)** | 5 tipova uslova (`metric`, `goal_status`, `reward`, `event`, `schedule`), cooldown, `maxPerDay` | `config/watchers.json`, demo sekcija 18 | **eksperimentalno** — stanje u memoriji procesa (`state`, `metricsStore`); restart gubi brojače dana |
| **Reward model** | heuristička ocjena 0–1 iz 12 signala (feedback, odobrenja, ishod, greške, citati, trošak, trajanje) | `src/learning/rewards.js`, `tests/autonomy.test.mjs` | **eksperimentalno** — **težine nisu naučene iz ljudskih ocjena**; nema dovoljno uzorka |
| **Self-improvement + A/B** | `prompt`/`pattern`/`policy`/`kb`/`action`; **obavezno odobrenje**, rollback, mjerenje efekta, A/B po run-u | `src/learning/improvements.js`, demo sekcija 19–20 | **eksperimentalno** — `tool`/`code` prijedlozi ostaju „zadatak za čovjeka" (`status: needs_code`) |
| **Self-play** | proposer → solver → judge, kurikulum po težini, dataset za SFT/DPO | `src/learning/selfplay.js`, demo sekcija 20 | **eksperimentalno** — **ne trenira model** (to i piše u kodu); dataset nije nigdje poslan na trening |
| **RSI** | analiza (nagrade, greške alata, ciljevi) → prijedlozi → audit `rsi_cycle`; mjerenje efekta (`impact`) | `src/learning/rsi.js`, rute `/v1/admin/rsi/*` | **eksperimentalno** — nivo „prompt/policy/kb/pattern"; izmjena **koda/MCP servera** je izvan dometa, i tako ostaje |
| **AI organizacija** | 7 uloga sa mandatima/KPI/budžetima, mjesečni ciklus, pregovor CFO↔CRO, eskalacija na CEO | `config/company.json`, `src/org/company.js`, demo sekcija 21 | **eksperimentalno** — nijedan ciklus nije vođen nad stvarnim poslovanjem |
| **A2A taskovi** | stanja `submitted/working/input_required/completed/failed/cancelled`, SSE tok, otkazivanje, agent card na `/.well-known/agent.json` | `src/a2a/tasks.js`, `src/a2a/card.js`, rute `/a2a/*` | **beta za protokol, eksperimentalno za ekonomiju** — nijedan spoljni agent nije pozvan |
| **A2A pregovaranje** | mašina stanja sa granicama (`maxAmountUsd`, `minUnitPriceUsd`, allowlista partnera, `requireHumanAboveUsd`), eskalacija iznad limita | `src/a2a/negotiation.js` | **eksperimentalno** — nijedan pravi partner |
| **A2A poravnanje** | interni ledger, `method: 'internal'` → `settled`; `stripe`/`x402` → `pending` (adapter ne postoji) | `src/a2a/negotiation.js` | **eksperimentalno (simulacija)** — **nema novca** |
| **K8s manifesti** | namespace + kvote + LimitRange, NetworkPolicy, RBAC, ExternalSecret, HPA (1–4), PDB, odvojen scheduler | `infra/k8s/` (`base/`, `tenant-template/`) | **eksperimentalno** — **nije primijenjeno na klaster**; `replicas: 1` jer nema distributed lock-a |
| **Alerti i dashboardi** | **18 alert pravila**, Grafana dashboard JSON, OTel Collector config, deploy-scheduler | `infra/observability/` | **eksperimentalno** — pravila nisu prošla `promtool`, nema Prometheus scrape-a ni Alertmanager-a |
| **Eval harness (zlatni set)** | — | **ne postoji** | **ne postoji** — ovo je **blokada #1** za sve tvrdnje o kvalitetu |
| **Prave integracije (Gmail/Shopify/Slack/CRM)** | — | **ne postoje** (samo interni alati i MCP šablon) | **ne postoji** |
| **Dashboard i inbox za odobrenja** | — | **ne postoje**; odobrenje ide kroz `POST /v1/approvals/:runId` | **ne postoji** |
| **Postgres + pgvector + Redis** | interfejsi spremni (`VectorStore`, memory, tenancy) | D8, D9 | **ne postoji** |
| **OIDC/SSO/MFA** | — | `docs/13` §4 | **ne postoji** |
| **SOC 2 / ISO / pen-test** | — | `docs/19` §3.1 | **ne postoji** |

**Zaključak iz tabele (bez uljepšavanja):** imamo **jedan ozbiljan inženjerski temelj** (gateway, izolacija,
politike, budžet, observability) i **jedan impresivan, ali nedokazan autonomni sloj** (autonomija, ciljevi,
učenje, organizacija, A2A). Sve što je „v0.3" je **eksperimentalno po zrelosti**, i to je glavna istina
ovog dokumenta. Prvih 6 mjeseci ne služi da se doda još sposobnosti, nego da se **taj sloj dokaže na
stvarnom klijentu** — ili da se suzi.

---

## 2. Faze 0–6 mjeseci: prvi prihod

**Cilj faze (jedna rečenica):** prvi **plaćeni** klijent na **jednoj** vertikali, sa **3–4 prave
integracije**, mjerenim kvalitetom (**eval harness**) i odobrenjima kroz **dashboard**, a ne kroz `curl`.

### 2.1 Šta gradimo (6 stvari, ništa više)

| # | Šta | Zašto baš to, baš sada |
|---|---|---|
| 1 | **Eval harness (zlatni set)** — `eval/golden.jsonl` (30–50 pitanja sa očekivanim ishodom) + `scripts/eval.mjs` koji mjeri tačnost, **citiranost**, p95 latenciju i USD/upit; `tests/eval-regression.test.mjs` koji pada ako tačnost padne **> 5%** | Bez ovoga je svaka izmjena prompta nagađanje (`docs/19` §2: „Eval prije prompt tuninga") |
| 2 | **Pravi model u produkciji + fallback** | `NMQ_LLM_PROVIDER`, `NMQ_LLM_BASE_URL`, `NMQ_LLM_MODEL`, `NMQ_LLM_API_KEY` (iz DSH store-a), `NMQ_LLM_FALLBACKS` sa **jednim testiranim** alternativnim providerom; provjera da `llmIsMock: false` na `/readyz` |
| 3 | **Prave integracije — 3 do 4, tvrdo ograničenje** | **Gmail** (čitanje + odgovor u istom thread-u), **Shopify/WooCommerce** (status narudžbine, refund), **Slack** (notifikacija + Approve/Reject dugmad), **CRM** (HubSpot/Pipedrive: kontakt, deal, note); svaka kroz `src/tools/mcp-client.js`, sa **OAuth po tenantu** (refresh, revokacija, kill switch); tajne u `data/tenants/<id>/secrets/secrets.enc.json` |
| 4 | **Dashboard + inbox za odobrenja** | server-rendered HTML + `fetch`, **bez frameworka i bez build koraka** (D2): operativni pregled, trošak/naplata, agenti, sigurnost + stranica sa listom odobrenja i dugmićima Approve/Reject (`POST /v1/approvals/:runId`, scope `approve`) |
| 5 | **Metrike koje fale + `infra/alerts.yml` u CI** | `nmq_cost_usd_total`, `nmq_pricing_missing_total`, `nmq_approvals_pending`, `nmq_approval_wait_seconds`, `nmq_budget_used_ratio`, `nmq_jobs_overdue`, `nmq_otel_export_total`, `nmq_errors_total`, `nmq_build_info`; pravila moraju proći `promtool check rules`; **redoslijed je obavezan: prvo metrika, pa alert** (alert nad nepostojećom metrikom je tiha lažna sigurnost) |
| 6 | **Usklađivanje verzije i ugovora** | `VERSION`, `package.json`, `DECISIONS.md` §7 na **jedan** broj; dashboard ruta u README; `pricing.json` van koda sa `checkedAt` i `sourceUrl` (D36) |

### 2.2 Deliverables

- `robot.<domena>` dostupan klijentu (widget + REST), sa **admin/operator** pristupom samo preko role.
- `eval/report-<datum>.md` — tačnost, % sa citatom, p50/p95, USD/upit, **baseline izmjeren prije tuninga**.
- 4 MCP servera vidljiva u `GET /v1/mcp` sa brojem alata + dokumentovan OAuth tok po tenantu u `docs/03`.
- Dashboard u produkciji + **jedno odobrenje iz pretraživača** (dokaz da `curl` nije potreban).
- `infra/alerts.yml` koji prolazi `promtool` + **testiran put** alerta do Slacka (vještački izazvan alert).
- **DPA + ugovor + SOW za pilot** (advokat) — ovo je deliverable faze, ne „poslije" (`docs/10` §3).
- Zapis prvog mjerenja u `docs/19` §7.1 (tabela sa stvarnim brojevima) i u `docs/18` §10.

### 2.3 Dokaz da je faza gotova (mjerljivo — ništa „otprilike")

| Dokaz | Prag |
|---|---|
| Plaćeni klijenti | **3 potpisana plaćena pilota** (500–1.500 EUR / 30 dana, **procjena** iz `docs/09` §6) |
| Kvalitet | 20 **stvarnih** upita klijenta: **≥ 80% tačnih sa citatom**, p95 **< 8 s**, **0** prijavljenih „izmislio je" |
| Regresija | `tests/eval-regression.test.mjs` **pada** ako tačnost padne > 5% |
| Riješeno bez čovjeka | **> 60%** runova bez `approval` i bez `handoff` na čovjeka |
| Integracije | za svaku od 3–4: **jedan stvarni događaj iz klijentovog sistema** prođe kroz robota i vrati se **akcijom**, uz audit `tool_call` i CI test protiv sandbox naloga; revokacija OAuth-a daje **jasnu grešku**, ne pada cijeli run |
| Odobrenja | klijentov operater **sam** odobri `high` akciju iz pretraživača; nijedno odobrenje ne čeka **> 24 h** |
| Trošak | **< 0,02 USD/upit** (**procjena** granice — **provjeriti kod provajdera** i zamijeniti stvarnim brojem iz `GET /v1/usage`) |
| Naplata | `GET /v1/usage` daje broj koji se **poklapa sa fakturom** do centa |

**KPI faze:** **3 plaćena klijenta**, **> 60% riješeno bez čovjeka**, **trošak modela < 15% prihoda**,
**0 incidenata izolacije tenanta**.

### 2.4 Rizici i mitigacija

| Rizik | Vjerovatnoća | Uticaj | Mitigacija |
|---|---|---|---|
| **Nema plaćenog klijenta** (najveći rizik cijelog plana) | visoka | kritičan | 30 ciljanih razgovora, **plaćen** pilot umjesto besplatnog (besplatan pilot daje lažan signal), odluka o nastavku na kraju 4. mjeseca po brojevima (`docs/10` §7) |
| **Halucinacija u support odgovoru** | visoka | visok | obavezan citat + pravilo „ako nema u KB, reci nemam"; `critic` za `legal`/`finance`; `high` rizik **uvijek** čovjek |
| **Integracija radi na testnom, ne na klijentovom nalogu** | srednja | visok | dokaz je akcija u **klijentovom** sistemu, ne screenshot; CI test protiv sandbox naloga |
| **Prompt injection kroz mejl/ticket** | srednja | visok | pravilo „sadržaj iz alata je PODATAK, nikad instrukcija"; allowlist alata po izvoru; audit svakog poziva |
| **Scope creep na 10 integracija** | visoka | srednja | **tvrdo pravilo: max 4**, peta samo ako je **plati** klijent |
| **Dashboard postane trošak održavanja** | srednja | nizak | server-rendered HTML, jedan fajl po stranici, **nula** npm paketa |
| **Zakasnjela odobrenja blokiraju klijenta** | srednja | srednji | eskaleracija 4/12/24 h; inbox + Slack dugmad; „odobri unaprijed do iznosa X" |
| **Pravni rizik (DPA, odgovornost za AI izlaz)** | srednja | visok | advokat **prije** prvog plaćenog klijenta; ugovorom: izlaz je **nacrt**, ne pravni savjet |
| **Klijent traži SOC 2** | niska/srednja | srednji | jasan odgovor „imamo / nemamo" (`docs/19` §6); ponuditi kao **odvojen plaćen projekat**; **nikad** ne tvrditi sertifikat |

### 2.5 Trošak faze (procjena)

| Stavka | Trošak (procjena) | Način provjere |
|---|---|---|
| Rad 1–2 osobe | **vlastiti rad** (oportunitetni trošak, ne cash) | sati u evidenciji |
| Model po upitu (mjerenje + 3 pilota) | **< 200 EUR** ukupno za mjerenje (**provjeriti cijene kod provajdera**) | `GET /v1/usage` |
| Advokat: DPA + ugovor + SOG | **500–2.000 EUR** (zavisi od obima) — **tražiti 2 ponude** | faktura |
| Pen-test (web + API + widget) | **1.500–6.000 EUR** — **2 ponude**, radi se **prije** prvog enterprise razgovora | izvještaj sa nalazima |
| Infra (VPS EU, domena, TLS, backup) | **15–60 EUR/mj.** (postojeći `nmq-server` pokriva početak) — **provjeriti cjenovnik** | faktura providera |
| Slack/mejl za alerte | **0 EUR** (free tier / postojeći mejl) — provjeriti limite | test alerta |
| **Ukupno cash faze** | **≈ 2.000–8.000 EUR** (bez pen-testa), **≈ 3.500–14.000 EUR** sa pen-testom | — |

---

## 3. Faze 6–12 mjeseci: skaliranje i kvalitet

**Cilj faze:** sistem smije primiti **10–20 klijenata** bez duplih poslova, bez sekvencijalnog skena nad
vektorima i **sa dokazanom izolacijom na nivou baze** — plus prvi **SFT/LoRA** trening kao **odvojen
proces** (van request puta), sa reward modelom na **ljudskim ocjenama**.

### 3.1 Šta gradimo

| # | Šta | Dokaz da je urađeno kako treba |
|---|---|---|
| 1 | **PostgreSQL 16 + pgvector** kroz **postojeće interfejse** (`VectorStore`, memory, session, longterm, audit, cost) — **bez izmjene agenata** (D9) | **Isti test set prolazi i na fajlu i na Postgresu** (parametrizovano env varijablom); tabele po kanonskoj šemi (`docs/02` §4.2): `spans`, `traces`, `events`, `cost_ledger`, `audit_log` + `approvals`, `facts`, `policy_denials` |
| 2 | **RLS `FORCE` po `tenant_id`** na svakoj tabeli + `audit_log` **bez `UPDATE`/`DELETE`** + trigger | test koji **namjerno** probija tenant kroz SQL **pada**; isti testovi izolacije kao na fajlovima |
| 3 | **Redis**: sesije (hot cache), rate limit (atomični `INCR`+`EXPIRE` umjesto in-memory mape), **queue** za duge zadatke | test: rate limit preživljava restart; queue ne gubi posao kad Redis padne (degradirani režim) |
| 4 | **Distributed lock** koji zamjenjuje fajl-lease u `src/scheduler/store.js` | **2 instance, 1000 uzastopnih tickova → posao izvršen tačno jednom**; lock **uvijek** sa TTL-om i `owner` tokenom; release samo ako je token isti; chaos test: ubij instancu usred posla i provjeri da se posao preuzme poslije TTL-a |
| 5 | **K8s po tenantu** — `tenant-template/`: namespace, `ResourceQuota`, `LimitRange`, `NetworkPolicy` **default-deny** + dozvola samo na `nmq-system` i DNS; `secret.example.yaml`; `deployment-scheduler.yaml` (1 replika) | `curl` iz tuđeg namespace-a na `nmq-robot` **ne prolazi**; `kubectl describe` pokazuje `readOnlyRootFilesystem: true`, `runAsNonRoot: true`, `drop ALL`; **0 tajni u `git log`** (provjereno skriptom) |
| 6 | **OTel Collector + Tempo + Prometheus + Grafana + Alertmanager** | trace **jednog stvarnog runa** vidljiv u Grafani kao waterfall sa `nmq.*` atributima; 18 alert pravila aktivna; **mjesečna ocjena false-positive < 20%** |
| 7 | **Migracije i backup/restore** — `infra/sql/001_init.sql`, `002_rls.sql`, `schema_migrations`, `pg_dump` + restore test | **restore iz backup-a < 30 min (mjereno i zapisano)** u `docs/compliance/RESTORE-TESTS.md` |
| 8 | **Self-play dataset → prvi SFT/LoRA trening (van procesa)** | dataset iz `learning/training-YYYY-MM.jsonl` (samo `passed: true`) → **jedan** trening na **jednom** agentu (npr. `support`); **eval prije/poslije** na istom zlatnom setu; ako lift nije mjerljiv → **ne** uvodimo fine-tune u produkciju |
| 9 | **Reward model na ljudskim ocjenama** | težine iz `src/learning/rewards.js` **kalibrisane** na ≥ 300 ljudskih ocjena (👍/👎/1–5 + odobrenja); korelacija heurističkog reward-a i ljudske ocjene **> 0,6** |
| 10 | **2 vertikale, 10–20 klijenata** | prva vertikala nosi **≥ 70%** prihoda; druga ima **≥ 2 plaćena klijenta**; **ne** treća (pravilo iz `docs/10` §3) |

### 3.2 Deliverables

- Postgres/pgvector/Redis stack (`docker compose --profile data up -d`) + migracije + test izolacije.
- Dvije instance schedulera bez duplog izvršavanja (dokaz u CI-ju).
- Klaster sa **2 tenanta** (1 stvarni, 1 testni) u odvojenim namespace-ima; HPA skalira 1→2 i vraća se.
- **Eval izvještaj sa fine-tune-om**: baseline vs SFT (tačnost, citiranost, USD/upit, latencija).
- Kalibrisan reward model + **prvi A/B pobjednik promovisan kroz kontrolnu ravan** uz audit.
- 10–20 plaćenih klijenata, od kojih **≥ 1 enterprise** (SSO nije nužan, self-hosted može biti).

### 3.3 Rizici i mitigacija

| Rizik | Vjerovatnoća | Uticaj | Mitigacija |
|---|---|---|---|
| **Postgres migracija razbije izolaciju** | niska | **kritičan** | RLS `FORCE` + test koji namjerno probija tenant; prelazak **po tenantu**, ne „svi odjednom" |
| **Distributed lock bugovi** (dupli mejlovi, dupli refundi, mrtav lock) | srednja | visok | TTL + owner token; release samo uz isti token; **idempotencija po `runId`**; alert `NmqJobsOverdue`; chaos test |
| **Dvostruko pisanje (JSONL + Postgres)** | srednja | srednji | **zabranjeno** u prelaznom periodu: jedan izvor istine po tipu podatka + `read` prekidač po tenantu |
| **K8s trošak i operativni teret za solo tim** | visoka | srednji | jedan mali klaster (ili `k3s`), sve kao manifesti u gitu; **mjeri se** nedjeljno održavanje: ako pređe limit → **vraćanje na Docker Compose je legitimna odluka** |
| **Fine-tune ne donosi ništa** | srednja | niski | trening je **van** kritičnog puta; ako lift nije mjerljiv na zlatnom setu — ostajemo na RAG + prompt + eval, i to je **u redu** |
| **Reward model uči pogrešnu stvar** | srednja | srednji | kalibracija na ljudskim ocjenama sa pragom korelacije; nikad automatska izmjena prompta bez čovjeka |
| **Trošak modela raste** | srednja | srednji | pravilo 3–4× (§8), keš, kraći kontekst, manji model za rutiranje, tvrdi budžeti (D15) |
| **Support minute rastu linearno** | visoka | srednji | self-serve dokumentacija za 5 najčešćih pitanja; **ponavljajuće pitanje = nova funkcionalnost ili dokument**, ne novi ticket |
| **Key-man rizik (1–2 osobe)** | visoka | visok | runbook za sve kritično + break-glass **van** servera; ugovorom **ne** obećavati 24/7 dok nas je 1–2 |

### 3.4 Trošak faze (procjena)

| Stavka | Trošak (procjena) | Izvođenje |
|---|---|---|
| VPS sa Postgresom + Redis | **50–150 EUR/mj.** | jedan VPS pokriva prve klijente (`docs/09` §4); **provjeriti cjenovnik** |
| K8s klaster (managed ili 3× VPS) | **30–150 EUR/mj.** | `docs/19` §3.2; alternativa `k3s` na 1–2 VPS-a (jeftinije, više našeg rada) |
| Monitoring stack (Prometheus/Tempo/Grafana) | **0 EUR** softver; **1–2 GB RAM** resursa (**procjena**, mjeri se `docker stats`) | dijele VPS |
| SFT/LoRA trening (jedan agent) | **50–500 EUR** po treningu (**procjena**; zavisi od provajdera i veličine) — **tražiti ponudu** | faktura provajdera; alternativa: vlastiti GPU sati |
| Ljudi | **1 inženjer + 0,5 podrške** (vidi §7) | **procjena 6.000–10.000 EUR/mj.** bruto troška firme |
| **Ukupno cash faze** | **≈ 70.000–130.000 EUR** za 6 mjeseci (sa ljudima) | — |

**KPI faze:** **marža > 70%**, **NPS ≥ 40**, **trošak po zahtjevu < 0,02 USD** (**procjena**, zamijeniti
stvarnim), **churn < 3%/mj.**, **10–20 klijenata**, **restore < 30 min**.

---

## 4. Faze 12–18 mjeseci: ekonomija agenata

**Cilj faze:** iz „naš robot radi za klijente" u „**naši i tuđi agenti trguju**" — sa **pravim novcem** i
**reputacijom partnera**. Ovo je faza u kojoj firma mijenja kategoriju: od SaaS alata ka **mreži agenata**.

### 4.1 Šta gradimo

| # | Šta | Dokaz da je urađeno kako treba |
|---|---|---|
| 1 | **A2A sa 2–3 prava pilot partnera** (ne demo): partner je firma ili agent-platforma sa kojom razmjenjujemo zadatke kroz `POST /a2a/tasks` i agent card na `/.well-known/agent.json` | **≥ 100 stvarnih A2A zadataka** mjesečno sa partnerom; svaki zadatak ima `state`, `runId`, `costUsd` i audit zapis |
| 2 | **Pravo poravnanje (Stripe ili SEPA virman)** — adapter iza postojećeg hook-a `createSettlement` / `settle()`; `method: 'internal'` **ostaje** za test i za internu raspodjelu | ≥ 1 **stvarna** faktura/naplata prošla kroz A2A tok; `settle()` zatvara stavku tek kad adapter vrati `externalRef`; **reconciliation** se poklapa sa bankom do centa |
| 3 | **Blockchain — SAMO ako ima stvarnog razloga** (vidi §6): odluka se donosi **na osnovu brojeva**, ne na osnovu hype-a | Ako nema partnera koji **traži** on-chain poravnanje, ili ako je cijena/komplikacija veća od koristi → **ne radimo ga** i to je uspjeh odluke, ne propust |
| 4 | **Reputacija partnera** — skor iz **stvarnih** ishoda: % završenih zadataka, prosječno vrijeme, sporovi, tačnost isporuke; skor **utiče** na granice pregovora (npr. niži `requireHumanAboveUsd` za slabijeg partnera) | skor se vidi u `GET /a2a/*`; **jedan** spor je dokumentovan i riješen kroz eskalaciju na čovjeka (dokaz da mehanizam radi) |
| 5 | **Marketplace template-a** (ne „plugin store"): gotovi recepti po vertikali (`config/agents/*.json` + `patternConfig` + politike + KB šablon + integracije) | **≥ 5 template-a** koje **klijent ili agencija sami** aktiviraju; uvođenje novog klijenta na template-u **< 3 dana** (mjereno) |
| 6 | **White-label za agencije** (vlastiti domen, brend, pod-tenanti) | **≥ 2 agencije** prodaju pod svojim brendom; agencija **sama** konfiguriše bez nas (mjereno: broj naših sati po krajnjem klijentu < 2 h) |
| 7 | **Org ciklus u produkciji** (iz eksperimentalnog u beta): mjesečni ciklus uloga, pregovor CFO↔CRO sa **stvarnim** brojevima marže | jedan **mjesečni** ciklus po klijentu sa zapisom `cycles-YYYY-MM.jsonl`; **≥ 1** odluka iz ciklusa primijenjena uz audit |

### 4.2 Deliverables

- Dokumentovan A2A ugovor sa partnerima (ko plaća, ko odgovara, šta je „isporučeno").
- **Reconciliation izvještaj**: A2A naplata ↔ banka ↔ `usage` ↔ audit.
- Reputacioni skor partnera + pravila koja iz njega slijede.
- 5+ template-a + uputstvo „novi klijent za 3 dana".
- White-label instanca sa pod-tenantima i izolacijom **dokazanom testom** (agens je tenant za sebe).

### 4.3 Rizici i mitigacija

| Rizik | Vjerovatnoća | Uticaj | Mitigacija |
|---|---|---|---|
| **Nema partnera spremnog za A2A** (ekosistem je ran) | visoka | visok | partneri se biraju iz **postojećih** klijenata/agencija, ne sa tržišta; ako nema ni 2 partnera u 3 mjeseca — A2A se **zamrzava** i energija ide u marketplace i white-label |
| **Poravnanje sa pravim novcem povlači pravne obaveze** (KYC/AML, PDV, odgovornost) | srednja | visok | novac ide kroz **postojećeg** procesora (Stripe/SEPA) — **mi ne držimo sredstva**; pravnik pregleda tok prije prve transakcije |
| **Blockchain bez razloga** (mamac) | srednja | srednji | tvrdo pravilo u §6: uvodi se samo ako **partner traži** i ako je cijena < korist; odluka se zapisuje |
| **Marketplace bez korisnika** (prazna vitrina) | srednja | srednji | marketplace kreće **tek** kad ima ≥ 20 klijenata; do tada su template-i interni alat |
| **White-label: ko odgovara za GDPR prema krajnjem klijentu** | srednja | visok | ugovorom: agencija je obrađivač prema krajnjem klijentu, mi smo pod-obrađivač; DPA lanac napisan **prije** prve agencije |
| **A2A sporovi i „ko je kriv"** | srednja | srednji | svaki zadatak ima `state`, `history`, `runId` i audit; eskalacija na čovjeka **uvijek** moguća; reputacija se ne mijenja ručno |
| **Kompleksnost raste brže od tima** | srednja | srednji | sve kroz **postojeće** interfejse; nove sposobnosti = nove JSON datoteke, ne novi servisi; ako održavanje pređe limit — **sječe se obim, ne produžava rok** |

### 4.4 Trošak faze (procjena)

| Stavka | Trošak (procjena) | Izvođenje |
|---|---|---|
| Novi inženjer (integracije + A2A) | **3.000–6.000 EUR/mj.** bruto (**procjena** za region) | tržišni raspon; provjeriti sa 2 kandidata |
| Prodaja/marketing (0,5–1 FTE) | **1.500–3.500 EUR/mj.** (**procjena**) | iz §7 |
| Pravnik (A2A ugovor, DPA lanac za agencije) | **1.000–3.000 EUR** jednokratno (**procjena**, 2 ponude) | faktura |
| Procesor plaćanja (naknade) | **procjena 2,9% + 0,30 EUR** po transakciji + **1–2%** za konverziju — **provjeriti aktuelne uslove** | izvod procesora |
| Marketplace (razvoj) | **vlastiti rad 4–6 nedjelja** | — |
| **Ukupno cash faze** | **≈ 150.000–250.000 EUR** za 6 mjeseci | — |

**KPI faze:** **% prihoda iz partnerskog kanala ≥ 25%**, **broj A2A transakcija ≥ 1.000/mj.**,
**≥ 2 agencije** u white-label-u, **vrijeme uvođenja novog klijenta na template < 3 dana**.

---

## 5. Faze 18–24 mjeseca: RSI i organizacija

**Cilj faze:** robot **predlaže izmjene sebe** (uz obavezan review i test), a **AI organizacija postaje
proizvod**: firma ne kupuje „agenta", nego **odjel** (podrška, prodaja, finansije) sa ulogama, KPI-jevima,
budžetima i izvještajima. Ulazak u enterprise segment bez tvrdnji koje ne možemo dokazati.

### 5.1 Šta gradimo

| # | Šta | Dokaz da je urađeno kako treba |
|---|---|---|
| 1 | **Automatizovana self-analiza sa EVAL-om kao kapijom** — RSI ciklus ide po rasporedu (nedjeljno), ali **nijedna promjena ne ulazi** dok ne prođe zlatni set | nedjeljni RSI ciklus sa zapisom; svaki prijedlog ima `evidence`; promjena koja **obara** zlatni set se **automatski odbija** i to je vidljivo u auditu |
| 2 | **RSI koji predlaže promjene KODA / MCP servera** (nivo 5 iz `src/learning/rsi.js`), uz **obavezan ljudski review + test** | prijedlog tipa `code`/`tool` se **ne** primjenjuje automatski: generiše se **patch predlog + test** → čovjek pregleda → PR → CI → deploy kroz kontrolnu ravan; mjeri se **vrijeme od nalaza do popravke** |
| 3 | **AI organizacija kao proizvod** — klijent kupuje „odjel": uloge (ceo/cro/coo/cfo/cto/chro/cso), mandate, KPI-jeve, budžete, mjesečni ciklus i pregovaranje o budžetu | **≥ 3 klijenta** koriste org ciklus kao **ugovorenu** funkcionalnost; mjesečni izvještaj „odjela" (ciljevi, KPI, trošak, odluke) ide klijentu automatski |
| 4 | **Enterprise: SSO (OIDC) + MFA + on-prem** | OIDC (jedan provider, `authorization_code` + PKCE) + TOTP MFA za `owner`/`admin`; `/v1/audit` pokazuje `action: login` sa SSO identitetom; **self-hosted licenca** (`docs/09` §5) sa licencnim ključem (Ed25519) i instancnim binding-om; **0 tajni u gitu** |
| 5 | **Sigurnosni paket koji ne tvrdi ništa što nemamo** | DPA, ROPA, incident plan, pristup, backup/restore dokaz — **svaka tvrdnja ima dokaz** (tabela „tvrdnja → dokaz → gdje"); pen-test izvještaj ako je plaćen; **nikad** „SOC 2 compliant" bez sertifikata |
| 6 | **Možda prvi veći klijent** (100+ zaposlenih, self-hosted ili EU-only obrada) | ako dođe: **plaćen** projekat sa jasnim granicama (mi **ne** odgovaramo za njihov server); ako ne dođe — enterprise je **kanal**, ne uslov opstanka |
| 7 | **EU-only obrada kao opcija** (Ollama/vLLM na Hetzneru) za klijente koji ne smiju kod eksternog provajdera | jedan klijent sa **lokalnim** modelom; trošak GPU-a je **poseban cjenovni razred** (`docs/09` otvoreno pitanje 5) |

### 5.2 Deliverables

- Nedjeljni RSI ciklus + **eval kao kapija** (regresija > 5% = automatsko odbijanje).
- Tok „nalaz → patch → test → review → deploy" sa mjerenjem vremena.
- Org kao proizvod: cenovnik po „odjelu", ne po agentu (`docs/09` §8: ne naplaćivati po agentu).
- SSO/MFA + self-hosted licenca + sigurnosni paket dokumenata u `docs/compliance/`.
- Godišnji ugovori za Pro/Enterprise (poboljšava cash-flow i smanjuje churn).

### 5.3 Rizici i mitigacija

| Rizik | Vjerovatnoća | Uticaj | Mitigacija |
|---|---|---|---|
| **RSI promijeni nešto pogrešno** | srednja | visok | **eval kao kapija** + obavezan review + test + rollback kroz kontrolnu ravan (već postoji: `improvements.rollback`); automatski se mijenjaju **samo** prompt/pattern/policy/KB; **kod nikad** bez čovjeka |
| **RSI proizvodi šum** (50 prijedloga koji niko ne gleda) | visoka | srednji | prijedlog bez **dokaza** i bez **očekivanog efekta** se odbacuje; nedjeljni limit; mjeri se „koliko prijedloga je primijenjeno" (cilj > 30%, inače se ciklus prigušuje) |
| **Enterprise zahtjev koji ne možemo ispuniti** (SOC 2, 24/7 SLA, on-prem pod našim uslovima) | visoka | visok | pripremljen **jasan** odgovor „imamo / nemamo"; sertifikacija = **odvojen plaćen projekat**; **ne** potpisivati što ne možemo isporučiti |
| **On-prem gubi kontrolu nad verzijama** | srednja | srednji | licenca sa **1 godinom** update-a; telemetrija **samo** uz pisanu saglasnost i **bez** podataka klijenta; ekspiracija → **read-only** (podaci ostaju klijentu) |
| **SSO integracija pojede nedjelje** | srednja | srednji | **jedan** provider, fiksni `redirect_uri`, `state` + PKCE; ako zapne > 5 dana → SSO se odgađa, API ključevi ostaju |
| **Komoditizacija (najveći strateški rizik)** | visoka | visok | ne prodajemo prompt nego **proces + izolaciju + dokaz + odjel**; ulaz u vertikalu kroz integracije koje konkurencija neće raditi za 1 klijenta |
| **Trošak modela / prihod > 30% dva mjeseca** | srednja | visok | kill-prag iz `docs/10` §5: **stop dok se cijena ili obim ne isprave**; pravilo 3–4× je ugovorno |
| **Key-man rizik** | visoka | visok | 3–5 ljudi do 24. mjeseca (§7); runbook + break-glass; kod ključnih odluka **pisani zapis** |

### 5.4 Trošak faze (procjena)

| Stavka | Trošak (procjena) | Izvođenje |
|---|---|---|
| Ljudi (3–5 FTE) | **10.000–18.000 EUR/mj.** bruto (**procjena**) | §7 |
| SOC 2 Type I / ISO 27001 priprema (ako ide) | **10.000+ EUR** (**procjena**, **tražiti ponude**) — **nije** u ovom planu kao obaveza | `docs/19` §3.2 |
| Pen-test (drugi, poslije promjena) | **1.500–6.000 EUR** (**procjena**, 2 ponude) | izvještaj |
| GPU/EU-only obrada | **poseban razred**; **provjeriti cjenovnik GPU-a** | faktura |
| **Ukupno cash faze** | **≈ 200.000–350.000 EUR** za 6 mjeseci | — |

**KPI faze:** **broj klijenata 60–80**, **ARR 300.000–600.000 EUR** (**procjena**, §8),
**% prihoda od enterprise ≥ 30%**, **% prijedloga RSI koji su primijenjeni > 30%**,
**vrijeme od nalaza do popravke < 7 dana**.

---

## 6. Šta NAMJERNO ne radimo u 24 mjeseca

Ovo nije lista „nemamo vremena" — ovo je **strateški štit**. Svaka stavka ima obrazloženje i **uslov pod
kojim bi se odluka promijenila**.

| Ne radimo | Zašto | Uslov koji bi odluku promijenio |
|---|---|---|
| **Vlastiti foundation model / pretenciozan trening** | Cijena modela po upitu je **manja od našeg vremena**; nemamo 10.000+ označenih primjera, a kvalitet se prvo rješava **RAG-om, promptom i eval-om**; model je zamjenjiv u jednom polju (D6) | Ako eval dokaže da je problem **u modelu**, a ne u KB-u — i to u formi **LoRA na jednom agentu** (§3), ne foundation model |
| **Multi-region** | Nema klijenta koji to traži; udvostručuje trošak i operativni teret; prvo **jedan region (EU)**, pa replika baze, pa tek onda drugi region | Enterprise ugovor koji **plaća** multi-region i traži pisanu obavezu RTO/RPO |
| **Service mesh (Istio/Linkerd)** | Rješava problem koji (još) nemamo: mTLS i routing između **naših** servisa. Imamo 1–2 servisa; NetworkPolicy + TLS na ingressu je dovoljno, a mesh je nova klasa incidenata | ≥ 5 mikroservisa sa potrebom za mTLS između njih i za zero-trust politikama po servisu |
| **Blockchain bez stvarnog razloga** | Poravnanje između dvije firme je **računovodstveni i pravni** problem, ne kriptografski. Stripe/SEPA rješava 95% slučajeva brže, jeftinije i sa manje odgovornosti; interni ledger **već postoji** za internu raspodjelu | Partner **traži** on-chain poravnanje, **plaća** ga, i pravnik potvrdi da ne uvodimo dodatne obaveze (KYC/AML) |
| **Potpuno autonomni novac bez čovjeka** | `high` rizik (novac, pravno, brisanje, spoljna komunikacija) traži čovjeka **na svim nivoima** — to je već u kodu (`HUMAN_ONLY` u `src/core/autonomy.js`), i to je **feature**, ne ograničenje; greška u novcu je nepovratna, a povjerenje je jedina valuta | **Nikad** kao default. Maksimalno: „unaprijed odobreno do iznosa X" **uz** dnevni/mjesečni limit i alert — i to po klijentu, uz njegov potpis |
| **gVisor / Firecracker / Kata dok ne zatreba** | Naš sandbox je **aplikativni** (`src/core/sandbox.js`) + `readOnlyRootFilesystem` + `drop ALL` + `seccomp RuntimeDefault`. Kernel-level izolacija je za **nepouzdan** kod; mi izvršavamo **naše** alate i **pinovane** MCP servere | Klijent dovodi **svoj** nepouzdan kod/plugin u naš sandbox (multi-tenant plugin execution) |
| **Kubernetes operator (vlastiti CRD)** | Problem „tenant = namespace" rješava `kubectl apply` + template (`infra/k8s/tenant-template/`); operator je proizvod u proizvodu | ≥ 50 tenanta i ručno provisionovanje postane nedjeljni posao (mjereno) |
| **Voice / telefonski kanal** | Drugi kanal, druga latencija, druga cijena; nema klijenta koji to traži u prvih 24 mjeseca | Klijent koji to **plati** kao poseban projekat |
| **Vlastiti dashboard framework / SPA** | „Moderni" frontend je 3× vremena bez vrijednosti za operatera; server-rendered HTML + `fetch` je dovoljno i **nema build korak** (D2, i zamka sa Hostinger kešom) | Samo ako se dokaže da operater ne može raditi posao u HTML-u (mjereno brojem klikova/podrške) |
| **SOC 2 / ISO 27001 sertifikacija kao uslov opstanka** | Mjeseci i desetine hiljada EUR; radimo **dokumentaciju koju možemo dokazati** i jasno kažemo šta nemamo | Klijent potpiše ugovor koji **plaća** pripremu; tada je to **odvojen projekat**, ne dio ovog plana |
| **Treća vertikala prije nego prve dvije imaju 2+ plaćena klijenta** | Pravilo iz `docs/10` §3; polovičan fokus je najsigurniji način da se izgubi postojeći napredak | Prve dvije vertikale imaju 2+ plaćena klijenta **svaka** |
| **Zamjena JSONL-a „u hodu" (dvojno pisanje svuda)** | Dvostruko pisanje je dvije istine; prelazak je **po tipu podatka** (§3) | — |
| **Naplaćivanje po tokenu kao javni cjenovnik** | Klijent vidi nepredvidiv račun i odustaje; tokeni su **interna** mjera; pretplata + fair-use + overage (`docs/09` §3, §8) | Enterprise ugovor sa **fiksiranim minimumom** i mjesečnim obračunom |

---

## 7. Tim i resursi

**Realnost danas:** **1–2 osobe** (vlasnik + po potrebi jedan izvođač). Kapacitet: **~30–35 h/nedjeljno**
rada na proizvodu, **bez** prodajnog tereta preko 20% vremena (`docs/19` §3.1). To znači da je **prodaja
fiksni blok u nedjelji** koji se ne pomjera — inače nema ni jednog plaćenog klijenta u ovom dokumentu.

| Faza | Ko je potreban (rola) | Koliko ljudi | Mjesečni trošak (procjena) | Šta se može odložiti |
|---|---|---|---|---|
| **0–3 mj.** | Osnivač: **full-stack inženjer + prodaja** (ista osoba) | **1–2** (1 + honorarni izvođač po potrebi) | **0–1.500 EUR** (honorar + alati/infra) | Dashboard „lijepa” verzija → MVP sa 4 stranice; A/B eksperimenti → samo ručno |
| **3–6 mj.** | + **1 inženjer** (integracije, MCP, OAuth) | **2** | **3.500–7.500 EUR** | Marketplace, org ciklus, RSI raspored, voice, multi-region |
| **6–12 mj.** | + **0,5–1 FTE podrška/operacije** (self-serve, ticketi, onboarding) | **2–3** | **6.000–10.000 EUR** | K8s klaster ako Compose nosi 10 klijenata; SOC 2; A2A; white-label |
| **12–18 mj.** | + **1 inženjer (A2A/integracije)** i **0,5–1 FTE prodaja/marketing** | **3–5** | **10.000–16.000 EUR** | Drugi pen-test; marketplace; EU-only GPU obrada; org kao proizvod |
| **18–24 mj.** | + **0,5–1 FTE DevOps/SRE** i **0,5 FTE data/ML** (eval, dataset, fine-tune) | **4–6** | **12.000–18.000 EUR** | Prvi veći klijent se **ne** juri aktivno — dolazi ili ne dolazi; SOC 2 samo ako je plaćen |
| **Kontinuirano** | **Vanjski**: advokat (ugovor/DPA/agencije), pen-tester, knjigovođa | po potrebi | **500–2.000 EUR** po angažovanju (**procjena**, 2 ponude) | SOC 2 konsultant (skup) — **ne** prije plaćenog zahtjeva |

**Ono što 1–2 osobe NE MOGU (i to treba reći naglas, jer određuje tempo):**

| Ne može | Zašto | Kada |
|---|---|---|
| **Penetration test** | Traži nezavisnog izvođača; rezultat se ne može sam izdati | Prije prvog enterprise razgovora sa sigurnosnim zahtjevima |
| **DPA / ugovor / pravno mišljenje** | Advokat (GDPR, prekogranični prenos, odgovornost za AI izlaz) | **Prije** prvog plaćenog klijenta — nije „poslije" |
| **SOC 2 / ISO 27001** | Sertifikacijsko tijelo + period posmatranja (mjeseci) + novac | Odvojen plaćen projekat kad postoji kupac |
| **24/7 support i on-call** | Jedna osoba ne može biti 24/7 | Ugovorom **ne** obećavati do 3+ klijenta ili do plaćene podrške |
| **Prodaja i razvoj istovremeno bez plana** | Kontekst se mijenja, oboje trpe | Fiksni prodajni blok u nedjelji (§5 `docs/10`) |
| **Druga vertikala odjednom** | Fokus | Tek kad prva ima 2+ plaćena klijenta |

---

## 8. Ekonomija i finansije

**Osnova izvođenja (sve procjene):** paketi iz `docs/09` §2 — **Starter 99–149 EUR/mj.**,
**Pro 349–599 EUR/mj.**, **Enterprise 1.200–3.500+ EUR/mj.**, plus **setup** (Starter 150–400,
Pro 500–1.500, Enterprise 2.000–8.000 EUR) i **self-hosted licenca 4.000–12.000 EUR/god.**
Pretpostavke su zapisane uz svaki broj; **mijenja ih zamjena bilo koje pretpostavke**, ne osjećaj.

**Pretpostavke (eksplicitno):**
- **ARPU po segmentu (procjena):** Starter **130 EUR/mj.**, Pro **400 EUR/mj.**, Enterprise **1.800 EUR/mj.**
  (miks pretplate + usage; iz `docs/09` §3–4).
- **Trošak modela:** cilj **< 15% prihoda**; u modelu računamo **12%** prihoda kao trošak modela
  (`docs/00` §6, `docs/09` §4). **Stvarne cijene provjeriti kod provajdera** — u kodu je tabela `PRICING`
  sa napomenom „provjeriti!".
- **Infra (procjena):** Godina 1 **50–150 EUR/mj.**, Godina 2 **300–800 EUR/mj.**, Godina 3 **800–1.500 EUR/mj.**
  (Postgres, Redis, klaster, monitoring) — **provjeriti cjenovnike**.
- **Ljudi (procjena, bruto trošak firme):** inženjer **3.000–6.000 EUR/mj.**, podrška **1.200–2.000 EUR/mj.**,
  prodaja **1.500–3.500 EUR/mj.**, DevOps **3.500–6.000 EUR/mj.**, data/ML **3.000–6.000 EUR/mj.**
  (region Srbija/BiH/CG/Hrvatska; provjeriti sa 2 kandidata).
- **Setup prihod** je prikazan odvojeno (jednokratno), jer nije ponavljajući.

### 8.1 Prihod, trošak, marža, runway — po godini (procjena)

| | **Godina 1** (mj. 1–12) | **Godina 2** (mj. 13–24) | **Godina 3** (mj. 25–36, orijentir) |
|---|---|---|---|
| **Prihod — konzervativno (procjena)** | **18.000 EUR** (3 klijenta do mj. 6, 8 do mj. 12; ARPU ≈ 200) | **95.000 EUR** (15 klijenata do mj. 18, 25 do mj. 24) | **200.000 EUR** |
| **Prihod — bazno (procjena)** | **45.000 EUR** (3 do mj. 5, 15 do mj. 12) | **230.000 EUR** (20 do mj. 15, 45 do mj. 24, 2 enterprise) | **520.000 EUR** |
| **Prihod — optimistično (procjena)** | **90.000 EUR** (1 agencija kao kanal, 25 klijenata) | **480.000 EUR** (70 klijenata, 5 enterprise, 25% iz kanala) | **900.000 EUR** |
| **Trošak modela (12% prihoda, procjena)** | 2.000–11.000 EUR | 11.000–58.000 EUR | 24.000–108.000 EUR |
| **Infra (procjena)** | 600–1.800 EUR | 3.600–9.600 EUR | 9.600–18.000 EUR |
| **Ljudi (procjena)** | 25.000–60.000 EUR (1–2 osobe, dio honorarno) | 90.000–150.000 EUR (2–4 osobe) | 160.000–260.000 EUR (4–6 osoba) |
| **Pravno/sigurnost/ostalo (procjena)** | 3.000–14.000 EUR (advokat, pen-test) | 10.000–20.000 EUR (DPA lanac, pen-test, licence) | 15.000–30.000 EUR |
| **Ukupan trošak (procjena)** | **31.000–87.000 EUR** | **115.000–238.000 EUR** | **209.000–416.000 EUR** |
| **Bruto marža po klijentu (cilj)** | **> 70%** (Starter realno 70–75%) | **> 75%** (Pro/Enterprise miks) | **> 78%** |
| **Marža na nivou firme** | **negativna** (investiranje u rast) | **bazno: oko nule do +25%**; optimistično: **+50%** | **bazno +20–35%** |
| **Runway bez investicije** | **zavisi od troška ljudi**: sa 1 osobom i minimalnim troškom **6–12 mj.**; sa 2–3 osobe **2–4 mj.** | — | — |
| **Runway sa tranšom [IZNOS]** | **[IZNOS] / mjesečni burn** — burn je **dominantno ljudi**, ne modeli | — | — |

**Runway — formula, ne osjećaj:**
`runway (mj.) = (cash + [IZNOS]) / (mjesečni trošak ljudi + infra + pravno + model)`.
Uz 1 osobu i minimalne troškove mjesečni burn je **(procjena) 1.500–3.000 EUR** → runway **6–12 mj.**;
uz 3 osobe burn je **(procjena) 9.000–13.000 EUR** → runway **2–4 mj.** bez prihoda.
**Zato je tranša 2 vezana na dokaz iz §2 (3 plaćena klijenta), a ne na protok vremena.**

### 8.2 Pravilo cijene: 3–4× trošak modela

> **Cijena usage-a = 3–4× očekivani trošak modela.**

Zašto ne 1,2×: uz trošak modela idu **retry-i i greške (+15%)**, **embedding i vektorska pretraga (+10%)**,
**support** (najveći skriveni trošak), **infrastruktura**, **naplata i devizni troškovi**, **rezerva za rast
cijena** i **neplaćanje** (`docs/09` §4). Ako je cijena 2× trošak modela — firma radi za dobrovoljce.
**Provjera u praksi:** trošak modela / prihod **< 15%** (cilj) — ako je > 30% dva mjeseca zaredom, to je
**kill-prag** (`docs/10` §5), a ne „optimizovaćemo kasnije".

### 8.3 Dva scenarija koja moramo imati napisana unaprijed

**A) Cijene modela padnu 50% (dobre vijesti — i zamka).**

| Efekat | Naša reakcija |
|---|---|
| Trošak modela / prihod pada sa 12% na ~6% → marža raste | **Ne** spuštati cijenu svima. Pad cijene modela je **naša marža** ili **novi segment** (self-serve tier 29–49 EUR/mj. sa malim obimom) |
| Konkurencija spušta cijene jer im je trošak pao | Ne takmičiti se na cijeni nego na **izvršenim akcijama + izolaciji + izvještaju** (`docs/10` §2); sidro je **plata zaposlenog**, ne pretplata na chat |
| Fine-tune postaje jeftiniji | Ubrzavamo §3 tačku 8: **LoRA na jednom agentu** je sada isplativ eksperiment (ali i dalje kroz eval kapiju) |
| Cijena po upitu postaje „ništa" | Vrijednost se **mora** mjeriti u ušteđenim satima i riješenim ticketima, ne u tokenima — inače nam cijena ide na nulu |

**B) Cijene modela porastu 3× (loše vijesti).**

| Efekat | Naša reakcija |
|---|---|
| Trošak modela / prihod skače sa 12% na **~36%** → marža pada ispod 70% | **Tvrde brave rade prvo:** `maxCostUsdRun`, dnevni/mjesečni budžet tenanta, per-agent budžet (D15) — run se prekida, **ne** pravi se gubitak |
| Heavy useri prave gubitak | Fair-use klauzula + overage cijena (poruka 0,02–0,05 EUR, run 0,15–0,50 EUR — **procjena**) + detekcija anomalije (trošak > 3× prosjek 7 dana → privremeni limit) |
| Ugovori sa fiksnom cijenom | U ugovoru **od starta**: pravo na korekciju cijene uz **30 dana** najave (`docs/10` §2) |
| Nužna optimizacija | Keš odgovora, kraći kontekst (top-k 3–5 umjesto 8), **manji model za rutiranje** (ruter ionako radi bez LLM-a kad može), fallback na jeftiniji provajder; **EU-only lokalni model** kao opcija za osjetljive klijente |
| Ako ni to ne pomogne | **Kill-prag:** trošak modela > 40% prihoda dva mjeseca → **stop dok se cijena ili obim ne isprave** (`docs/10` §5) |

**Napomena o valuti (rizik koji se lako zaboravi):** trošak modela je u **USD**, prihod je u **EUR** →
fakturisati u **EUR** gdje god je moguće (`docs/09` §9); kursni rizik se **ne** prenosi na klijenta tiho.

---

## 9. Rizici (investitorski pogled)

Vjerovatnoća i uticaj su **procjena** (niska / srednja / visoka / kritičan). „Rani signal" je **mjerljiv** —
to je ono što se vidi **prije** nego što problem postane sudbina.

| Rizik | Vjerovatnoća | Uticaj | Kako ga smanjujemo | Rani signal |
|---|---|---|---|---|
| **Nema plaćenog klijenta** (sve ostalo je teorija) | **visoka** | **kritičan** | 30 ciljanih razgovora; **plaćen** pilot (500–1.500 EUR, procjena) umjesto besplatnog; odluka o nastavku na kraju **4. mjeseca** po brojevima; plan B (pivot) napisan unaprijed (`docs/10` §7) | 0 potpisa poslije 8 razgovora; „rado bi, ali…" ponavlja se 2×; onboarding > 3 nedjelje |
| **Zavisnost od LLM provajdera** (cijena, uslovi, pristup, kvalitet preko noći) | **visoka** | **visok** | Multi-provider adapter (D6) + **jedan testirani** alternativni provider konfigurisan i povremeno provjeren (ne samo „podržano u kodu"); u ugovoru **ne** obećavati konkretan model; trošak po modelu se prati | `nmq_llm_calls_total` po modelu se ne mijenja; 429/5xx rastu; kvalitet pada poslije njihovog update-a |
| **Konkurencija: framework-i (LangGraph/CrewAI) i agencije** | **visoka** | **srednji/visok** | Ne prodajemo „agent framework" nego **proces + izolaciju + dokaz + izvještaj**; framework je naš **alat**, ne proizvod; dubina u **2 vertikale** umjesto širine; agencije su **kanal**, ne samo konkurent | Klijent kaže „ovo mogu i sam sa ChatGPT-om"; poredi sa 20 EUR/mj. pretplatom |
| **Regulatorni (EU AI Act) — obaveze za „high-risk" i za transparency** | **srednja** | **visok** | **Ugrađeno upravljanje je naš adut**, ne teret: hash-chained audit, PII redakcija, `high` rizik → čovjek, pravo na objašnjenje akcije (trace), izvoz dokaza; **ne** prodajemo autonomno pravno/medicinsko odlučivanje (`docs/00` §3) | Klijent/partner traži „AI compliance" dokument; promjena klasifikacije našeg use-case-a kao high-risk |
| **„1 osoba" rizik** (key-man: bolest, odmor, burnout, niko ne zna gdje su ključevi) | **visoka** | **visok** | Runbook za sve kritično; **break-glass** uputstvo **van** servera; pristupi u DSH store-u; **ugovorom ne obećavati 24/7**; pisani zapis ključnih odluka; prvi honorarni inženjer **odmah** u fazi 3–6 mj. | 3 nedjelje bez dana bez koda; klijent zove lično; „sve je u glavi" |
| **Komoditizacija promptova** (ono što radimo može se kopirati za vikend) | **visoka** | **srednji** | Vrijednost **nije** prompt: to su **integracije**, izolacija, politike, audit, izvještaj i organizacija; prompt je konfiguracija koja se mijenja bez deploy-a; **eval** je ono što se ne kopira | Neko objavi identičan „recept"; klijent pita „zašto ne bismo sami" |
| **Cijena tokena** (rast 3× ili kraj jeftinog režima) | **srednja** | **visok** | Tvrdi budžeti (D15), keš, kraći kontekst, manji model za rutiranje, overage + fair-use, **pravo na korekciju cijene uz 30 dana najave**; mjerenje **USD/upit** od prvog dana | USD/upit raste 2 mjeseca; trošak modela / prihod > 15% → > 30% |
| **Prodajni ciklus je dug** (B2B, 3–9 mj.; odluka čeka „gazdu") | **visoka** | **srednji** | Ciljati **odlučioca** odmah (vlasnik u maloj firmi); mali **plaćen** pilot (odluka na nivou jednog procesa); više malih klijenata umjesto jednog velikog; agencije kao skraćeni put (B2B2B); odustati od segmenata sa ciklusom > 3 mj. | Prosjek dana od razgovora do potpisa; broj „javljamo se sljedeće nedjelje" |
| **Support minute rastu linearno** | **visoka** | **srednji** | Self-serve dokumentacija i video za 5 najčešćih pitanja; **ponavljajuće pitanje = nova funkcionalnost ili dokument**, ne novi ticket; onboarding **naplaćen**; mjesečno mjerenje minuta po klijentu | Minute/klijent ne padaju poslije 2 mjeseca; isti problem kod 3 klijenta |
| **Churn na Starter segmentu** | **srednja** | **srednji** | Pretplata mora nositi vrijednost i pri malom volumenu (izvještaji, monitoring); godišnji ugovori; fokus na Pro (niži churn) | Starter churn > 8%/mj.; klijent pita „zašto plaćam" u mjesecu bez sezone |
| **Cross-tenant curenje kroz bug** | **niska** | **kritičan** | `tenantId` obavezan (fail-closed, D11); fizički folderi (D12) + RLS `FORCE` u §3; testovi izolacije u CI; nijedan upit bez `tenant_id` u `WHERE` | Test izolacije pada; odgovor sadrži tuđi podatak; zajednički keš ključ bez `tenantId` |
| **Tajna procurela u log/trace/izvještaj** | **srednja** | **visok** | Redakcija **na ulazu** u logger; nikad tajna u prompt; `stripSecrets` u audit `meta`; test „nema tajni u logovima"; vrijednosti samo iz DSH store-a | Grep po logu nalazi obrazac ključa; trace span sadrži token |
| **Preoptimizacija prije prvog klijenta** (rizik koji sami sebi pravimo) | **visoka** | **srednji** | Faze imaju **dokaz**, ne datum; lista „šta NAMJERNO ne radimo" (§6) je štit; ako faza kasni > 1 nedjelju → **sječe se obim**, ne produžava rok | Nedjelje prolaze bez razgovora sa klijentom; broj integracija raste, plaćenih korisnika nema |
| **K8s/DevOps trošak za mali tim** | **srednja** | **srednji** | Klaster ide **poslije** Postgresa i lock-a; mali klaster ili `k3s`; sve kao manifesti u gitu; **ako održavanje pređe limit → vraćanje na Docker Compose je legitimna odluka** | Nedjeljno održavanje > 2 h; faktura klastera raste bez novog klijenta |
| **Naplata u regionu (kartice, devizni priliv, PDV)** | **srednja** | **srednji** | Fakturisanje u **EUR**; Paddle/Stripe preko EU entiteta (**provjeriti uslove i naknade**); virman za Pro/Enterprise uz suspenziju poslije 15 dana; **knjigovođa prije prve fakture van zemlje** | Kasne uplate; klijent traži način plaćanja koji nemamo |
| **Investitor očekuje brže** (nesklad očekivanja) | **srednja** | **srednji** | Ovaj dokument: tranše vezane na **dokaze** (§2 KPI), ne na vrijeme; kvartalni izvještaj sa **istim** KPI tabelama iz §11; eksplicitna lista neuspjeha u §0 | Pitanja koja nisu u §11; zahtjev za funkcijama van §2–§5 |

---

## 10. Zašto sada (timing)

**1. Modeli su prvi put dovoljno dobri i jeftini za procese malih firmi.**
Tool calling, JSON izlaz i instrukcije su stabilni; trošak po upitu je **ispod 0,02 USD** za tipičan
support upit (**procjena** — **provjeriti kod provajdera**, `PRICING` u `src/observability/cost.js` je
konfiguracija, ne činjenica). To znači da je cijena jednog riješenog zahtjeva **manja od minute rada
čovjeka**. Prije 24 mjeseca to nije bilo tačno: modeli su koštali 10–50× više, a tool calling je bio
nepouzdan — a bez pouzdanog tool calling-a **ovaj proizvod ne postoji** (robot „radi", ne „priča").

**2. MCP je postao standard za spajanje agenata na alate.**
Za razliku od svake prethodne generacije „plugin API-ja", MCP je **otvoren protokol (JSON-RPC 2.0)** i
nezavisan od provajdera. Mi to ne moramo čekati — imamo **vlastiti MCP klijent** (`stdio` + Streamable
HTTP, `src/tools/mcp-*.js`), bez SDK zavisnosti, i **šablon internog servera**. Praktična posljedica:
integracija klijentovog sistema (Gmail, Shopify, Slack, CRM, interna baza) je **dani**, a ne mjeseci —
a integracije su upravo ono što komoditizaciju čini teškom.

**3. Agenti prelaze iz demoa u produkciju — i firme to sada traže.**
Tržište je 2024–2025. prošlo kroz fazu „chatbot na sajtu" i razočaranje. Ono što sada kupuje jest:
„automatizuj **ovaj** proces, izmjeri uštedu, pokaži mi šta je uradio". Naš sistem je za to napravljen:
**trace po run-u, trošak po klijentu, mjesečni izvještaj sa brojevima** i `high` rizik pod odobrenjem.
Konkurencija koja je ostala na „chat interfejsu" tu ne može odgovoriti.

**4. Firme traže mjerljive uštede, ne AI projekte.**
Ekonomski pritisak (plate, odliv kadrova, administracija) tjera firme da traže **sate**, ne tehnologiju.
Zato naš cjenovnik nije „po agentu" ni „po tokenu", nego **pretplata + fair-use + setup**, sa sidrom
**plate zaposlenog** (`docs/09` §8). Argument koji prodaje je: *„10 riješenih ticketa dnevno bez čovjeka =
X sati mjesečno"* — i to **moramo** dokazati izvještajem, ne tvrdnjom.

**5. EU AI Act i GDPR tjeraju na audit i governance — a mi ga imamo ugrađenog.**
Regulativa je za konkurenciju **trošak i odgoda** (logovi, transparentnost, ljudski nadzor, dokumentacija),
a za nas **adut**: hash-chained audit log sa `verify`, PII redakcija prije logovanja, obavezan čovjek za
`high` rizik i `HUMAN_ONLY` kategorije, izvoz dokaza i per-tenant izolacija. Kad klijent pita „kako dokazujete
šta je robot uradio", odgovor je **jedna komanda** (`node src/cli.js audit-verify`), a ne slajd.
**Iskreno:** to **nije** SOC 2 i **nije** pravno mišljenje — ali je **ono što se traži prvo**, i to imamo.

**Zaključak o tajmingu (i protivargument, da ne bude marketing):** prozor je otvoren zbog **cijene**,
**standarda (MCP)** i **regulative**; ali prozor se zatvara sa **konsolidacijom** (framework-i i veliki
igrači dolaze u vertikale). Zato je naš plan: **dokazati vrijednost na jednoj vertikali u 6 mjeseci**,
pa širiti — a ne graditi 24 mjeseca pa prodavati.

---

## 11. Kako mjerimo uspjeh

Sve vrijednosti su **ciljevi (procjena)**. „Izvješteno" znači: broj je iz sistema (`GET /v1/usage`,
`GET /metrics`, `GET /v1/admin/*`), a **ne** iz osjećaja. Isti brojevi idu investitoru svaki kvartal.

| KPI | Faza 0–6 mj. | Faza 6–12 mj. | Faza 12–18 mj. | Faza 18–24 mj. | Izvor |
|---|---|---|---|---|---|
| **Prihod (ARR, procjena)** | 20.000–50.000 EUR | 60.000–150.000 EUR | 150.000–320.000 EUR | **300.000–600.000 EUR** | fakture + `GET /v1/usage` |
| **Plaćeni klijenti** | **3** | **10–20** | **25–40** | **60–80** | CRM |
| **Enterprise klijenti** | 0 | **≥ 1** | **2–4** | **≥ 6** | ugovori |
| **Bruto marža po klijentu** | > 65% | **> 70%** | > 75% | **> 78%** | prihod − (model + infra + support minute) |
| **% riješeno bez čovjeka** | **> 60%** | > 65% | > 70% | > 70% | runovi bez `approval` i bez `handoff` |
| **Trošak po zahtjevu** | **< 0,02 USD** (**procjena**, zamijeniti stvarnim) | < 0,02 USD | < 0,02 USD | < 0,015 USD | `GET /v1/usage` / broj zahtjeva |
| **Trošak modela / prihod** | < 15% | < 15% | < 15% | < 12% | `nmq_cost_usd_total` / prihod |
| **Churn (mjesečno)** | n/a (pilot) | < 5% (Starter) / < 3% (Pro) | < 3% | **< 3%** | otkazi / aktivni |
| **NPS** | n/a (3 klijenta) | **≥ 40** | ≥ 45 | **≥ 50** | anketa + feedback u widgetu |
| **Riješeni eval (zlatni set)** | **≥ 80% sa citatom**, regresija > 5% **pada test** | ≥ 85% | ≥ 88% | **≥ 90%** | `scripts/eval.mjs` |
| **p95 latencija odgovora** | **< 8 s** | < 6 s | < 5 s | **< 5 s** | `nmq_run_duration_seconds` |
| **Odobrenja koja čekaju > 24 h** | **0** | 0 | 0 | 0 | `nmq_approvals_pending` |
| **% prihoda iz partnerskog kanala** | 0 | < 10% | **≥ 25%** | **≥ 35%** | CRM/atribucija |
| **% prihoda od enterprise** | 0 | 5–10% | 15–25% | **≥ 30%** | ugovori |
| **A2A transakcije / mj.** | 0 | 0 (priprema) | **≥ 1.000** | ≥ 3.000 | `settlements_total` + `a2a_tasks_total` |
| **RSI: % prijedloga primijenjenih** | n/a | n/a (ručno) | > 20% | **> 30%** | `improvement_*` metrike |
| **Vrijeme od nalaza do popravke** | — | < 14 dana | < 10 dana | **< 7 dana** | ticket → deploy |
| **Incidenti izolacije tenanta** | **0** | 0 | 0 | **0** | testovi + `nmq_tenant_mismatch_total` |

**Pravilo mjerenja (da KPI ne postane marketing):** svaki broj u ovoj tabeli mora imati **izvor u sistemu**
i **datum**. Ako broj nije mjerljiv — piše **„nije mjereno"**. Izmišljena ušteda se obije o glavu na
drugom sastanku (`docs/09` §7).

---

## 12. Odluke koje tražimo od investitora

Pet odluka. Svaka ima **zašto sada** i **posljedicu ako se ne donese**.

| # | Odluka | Zašto sada | Posljedica ako se ne donese |
|---|---|---|---|
| **1** | **Fokus na JEDNU vertikalu u prvih 6 mjeseci** (preporuka: **e-commerce support** — najveći volumen, najbrža vidljivost, najmanji pravni rizik) i **tvrdo** odbijanje druge prije 2+ plaćena klijenta | Bez fokusa robot je „univerzalan" i nigdje dovoljno dobar (`docs/10` §4, mamac #6); integracije se biraju po vertikali | Rasipanje na 2–3 vertikale, nijedna referenca, produžen put do prvog prihoda |
| **2** | **Budžet za pen-test + pravni paket (DPA/ugovor) PRIJE prve enterprise prodaje** — **procjena 2.000–8.000 EUR** (2 ponude za svaku stavku) | Enterprise ne prihvata „dijeljeni API ključ" i bez DPA nema prvog **plaćenog** klijenta (`docs/19` §3.2); pen-test je ulaznica u razgovor | Enterprise razgovor propada u prvoj rundi; ili (gore) potpisujemo tvrdnje koje ne možemo dokazati |
| **3** | **Blockchain za A2A poravnanje: NE u 2026.** — pravo poravnanje ide kroz **Stripe/SEPA**, interni ledger ostaje za internu raspodjelu | Poravnanje je računovodstveni/pravni problem; on-chain uvodi KYC/AML i odgovornost bez koristi za klijenta (§6); odluka mora biti **prije** nego što neko počne „jer je moderno" | Gubimo nedjelje i pravnu sigurnost na tehnologiju koja ne rješava ni jedan klijentov problem |
| **4** | **Prvi SFT/LoRA trening: DA, ali tek u fazi 6–12 mj., na JEDNOM agentu, VAN kritičnog puta, sa eval kapijom** — **procjena 50–500 EUR** po treningu (**tražiti ponudu**) | Dataset nastaje iz self-play-a (već postoji), a odluka „da/ne" mora biti na **dokazu**, ne na vjeri; fine-tune je jeftin eksperiment, ali skup ako postane cilj | Ili gubimo kvalitet koji je moguć, ili (gore) trošimo nedjelje na trening prije nego što znamo da RAG+prompt nisu dovoljni |
| **5** | **Tranše vezane na dokaze, ne na vrijeme:** tranša 2 se isplaćuje kad su ispunjeni **KPI faze 0–6 mj.** (3 plaćena klijenta, > 60% bez čovjeka, eval ≥ 80% sa citatom, 0 incidenata izolacije) | Jedini način da i mi i investitor isto mjerimo uspjeh; sprječava „još jedan mjesec" bez dokaza | Kapital se troši na aktivnost, ne na rezultat; gate postaje formalnost (§4 `docs/19`) |

**Dodatno, tražimo potvrdu dvije pretpostavke (ne odluku, nego saglasnost):**
(a) **prodajni ciklus od 3 mjeseca je realan** za naš segment (ako nije — mijenjamo segment, ne plan);
(b) **1–2 osobe su prihvatljiv rizik** uz ugovornu ogradu da **ne** obećavamo 24/7 (`docs/10` §3).

---

## Otvorena pitanja

1. **Koja je prva vertikala konačno** — e-commerce support (naša preporuka), agencije (white-label,
   B2B2B) ili knjigovodstvo (protivciklično, viša cijena po satu)? Odluka mijenja **koje 3–4 integracije
   gradimo prve** (§2) i time obim faze 0–6 mjeseci.
2. **Do kog broja klijenata ostajemo na fajl-sistemu (JSONL)**, a od kojeg je Postgres+pgvector+Redis
   obavezan? Prag iz koda je **> 20 tenanta ili > 100 MB po fajlu** (`docs/10` §1), ali prvi klijent koji
   traži **garanciju** o izolaciji i performansama mijenja redoslijed — šta je tada žrtva (dashboard,
   A2A ili fine-tune kasni)?
3. **Da li prvi A2A partneri dolaze iz naših klijenata** (firma koja već koristi robota i ima svog agenta),
   **ili sa tržišta** (agent-platforma)? Prvo je jeftinije i sigurnije, drugo je brže — i ako u 3 mjeseca
   ne nađemo **2** partnera, **zamrzavamo A2A** i idemo u marketplace/white-label (§4, rizik „nema partnera").
4. **Da li uvodimo `critic` + obavezan izvor za SVE odgovore odmah**, iako to povećava trošak i latenciju
   po run-u? Direktno dira **maržu** (§8) i **KPI „% bez čovjeka"** (§11) — i mijenja A3/A4 pretpostavke
   iz `docs/10` §6.
5. **Ko plaća pen-test, DPA i (eventualno) SOC 2 pripremu** — mi iz marže, klijent kroz **setup**, ili se
   enterprise razgovor odgađa dok ne postoji klijent koji to **plati**? Bez te odluke §12 tačka 2 je
   lista želja, a ne plan.
6. **Ko je vlasnik „gate" odluke na kraju svake faze** — mi sami, ili klijent/mentor/investitor kroz
   nedjeljni demo? Ako odlučujemo sami, rizik je da se „idemo dalje" kaže i kad uslovi nisu ispunjeni;
   ako odlučuje investitor, gate dobija **težinu**, ali i **kašnjenje** (`docs/19` otvoreno pitanje 7).
