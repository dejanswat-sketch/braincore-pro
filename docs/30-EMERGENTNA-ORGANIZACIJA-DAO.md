# 30 — Emergentna organizacija i DAO: ko stvarno upravlja

> **Nivo v0.4** (swarm + A2A). Ovaj dokument opisuje **stvarno stanje koda**, ne viziju.
> Izvori tvrdnji: `config/company.json`, `config/swarm.json`, `config/autonomy.json`, `config/tenants.json`,
> `src/org/company.js`, `src/swarm/swarm.js`, `src/swarm/governance.js`, `src/swarm/safety.js`,
> `src/a2a/negotiation.js`, `src/learning/improvements.js`, `src/core/autonomy.js`,
> `src/controlplane/registry.js`, `src/server/routes-swarm.js`, `src/index.js`.
> Ugovor: `docs/DECISIONS.md` (D37–D46 važe; ovaj dokument ih ne mijenja).
>
> **Tri rečenice koje moraju stajati na početku:**
> 1. Danas je ovo **hibridna organizacija** — AI operativa, čovjek (board) drži granice, budžet i ljude.
> 2. **DAO ne postoji** ni u kodu ni u planu kao obaveza; sve što liči na „glasanje" je **savjetodavno**.
> 3. **Interni ledger je simulacija** (`note` u zapisu to i kaže) — **nema novca, nema blockchain-a, nema tokena**.
>
> Sve što je pravno u ovom dokumentu je **prijedlog za razgovor**, ne pravni savjet:
> **provjeriti sa advokatom** (i, gdje se diraju lični podaci, sa licem za zaštitu podataka).

---

## 1. Tri modela

Tri modela nisu „tri tehnologije" — to su **tri odgovora na pitanje ko snosi posljedicu**.
U kodu se to vidi kroz jednu funkciju: `autonomy.evaluate()` (`src/core/autonomy.js`) koja za svaku
procijenjenu akciju vraća `allow` / `require_approval` / `deny`. Ko stoji iza `require_approval` — to je
razlika između modela.

| Pitanje | **Klasična firma** (ljudi odlučuju) | **Hibrid** (AI operativa + ljudski board) | **DAO** (token/glasovi, smart contract izvršenje) |
|---|---|---|---|
| Ko postavlja ciljeve | Uprava / vlasnik | **Čovjek** (board), AI predlaže kroz `company.cycle()` | Predlozi + glasanje nosilaca tokena |
| Ko odlučuje o budžetu | Finansijski direktor / uprava | **Čovjek** mijenja `config/company.json`, `config/tenants.json`, `config/swarm.json`; AI pregovara (`negotiate`) | Budžet je parametar ugovora/glasanja |
| Ko izvršava | Zaposleni | **Agent** (orchestrator, patterni, alati) unutar politika i budžeta | Smart contract (deterministički, bez diskrecije) |
| Ko mijenja granice | Uprava | **Čovjek** (`requiredRole: 'owner'`: autonomija, izolacija roja, kvote, RSI nivo) | Izmjena ugovora glasanjem (često supermajority) |
| Ko snosi odgovornost | Pravno lice i imenovani organ | **Pravno lice i čovjek** (potpis, DPA, ugovor) — agent nema pravni subjektivitet | Pravno lice osnivača; često **nejasno** i predmet regulatornog spora |
| Dokaz odluke | Zapisnik, potpis | **Audit (hash-lanac) + JSONL zapisi** — vidi `docs/DECISIONS.md` D16 | On-chain zapis (transparentan, ali javan) |
| Brzina odluke | Dan–nedjelje | **Sekunde–minuti** za nizak rizik; dani za ljudsko odobrenje | Sati–dani (glasanje), sekunde (izvršenje) |
| Reverzibilnost | Visoka (odluka se mijenja) | **Visoka** (`improvements.rollback`, control plane rollback) | **Niska** (neopozivost je u prirodi izvršenja) |
| Gdje je novac | Banka, po nalogu | **Banka/procesor** — agent ne drži sredstva | Wallet / escrow contract |

### Gdje smo mi danas (bez uljepšavanja)

**Mi smo hibrid, i to strogi hibrid.** Dokazi iz koda:

| Tvrdnja | Dokaz u kodu |
|---|---|
| Agent ne mijenja svoje granice | Promjena autonomije: `POST /v1/admin/autonomy` sa `requiredRole: 'owner'` (`src/server/routes-autonomy.js`); izolacija roja, kvote, freeze i RSI nivo: `requiredRole: 'owner'` (`src/server/routes-swarm.js`) |
| Novac iznad praga uvijek čovjek | `HUMAN_ONLY = ['financial','legal','destructive','external_communication']` + `riskLevel: 'high'` → `require_approval` **na svim nivoima** (`src/core/autonomy.js`); A2A `requireHumanAboveUsd` → `awaiting_human` (`src/a2a/negotiation.js`) |
| Pravno nikad agent | `contract.signature: null` i `note` da je to „radni zapis" (`src/a2a/negotiation.js`) |
| Ljudi nikad agent | `config/company.json`, uloga `chro`: „bez odluka o ljudima — te odluke ostaju čovjeku" |
| Odluke se mogu vratiti | `improvements.rollback()` (control plane, policy override, KB) |
| Sve ostavlja trag | `audit?.append(...)` u svakoj odluci navedenoj u ovom dokumentu |

**DAO nije „sljedeći korak" — DAO je opcija sa uslovom.** Uslov je u §10 i on nije tehnološki
(„možemo li napisati smart contract") nego poslovni („postoji li treća strana koja traži on-chain
poravnanje i plaća ga"). Do tada je DAO u ovom projektu **planirano**, i to iskreno piše.

---

## 2. Šta je danas implementirano

### 2.1 Org sloj — `src/org/company.js` + `config/company.json`

Org chart je **podatak**, ne kod (D44). Sedam uloga, vezane na postojeće agente iz `config/agents/`:

| `id` | `agentId` | `reportsTo` | `budgetUsd` (deklarisano) |
|---|---|---|---|
| `ceo` | `decider` | — | 60 |
| `cro` | `sales` | `ceo` | 50 |
| `coo` | `ops` | `ceo` | 30 |
| `cfo` | `finance` | `ceo` | 25 |
| `cto` | `dev` | `ceo` | 25 |
| `chro` | `hr` | `ceo` | 15 |
| `cso` | `support` | `ceo` | 40 |

Četiri metode koje stvarno postoje:

| Funkcija | Šta radi (kod) | Ko odlučuje u praksi |
|---|---|---|
| `chart(tenantId)` | Spaja `goals.list` + `rewards.aggregate(groupBy:'agent')` + `cost.summary()` po ulozi; dodaje `autonomy.levelOf()` | **Niko** — to je pogled (read-only) |
| `cycle(tenantId, {period, topic, context})` | **Jedan** LLM poziv (`role: 'org-ceo'`, `temperature: 0.2`, `maxTokens: 900`, `json_object`) → `plan {priorities, allocation, risks, decisions_needed}`; zatim `negotiate(['cfo','cro'])` ako obje uloge postoje; zapis u `data/tenants/<id>/org/cycles-YYYY-MM.jsonl` (`type: 'org_cycle'`) | **Agent predlaže, čovjek primjenjuje** — ciklus ne mijenja nijedan cilj ni budžet |
| `negotiate(tenantId, {topic, between, maxRounds})` | Strukturisana mašina stanja: runde `1..maxRounds`, govornik naizmjenično; traži JSON `{offer:{amountUsd,terms}, reasoning, accept}`; tvrdi prekid ako `offer.amountUsd > speaker.budgetUsd` → `status: 'escalated'` + `improvements.createProposal()`; bez dogovora → eskalacija na `ceo` | **`agreed` je zapis, ne izvršenje**; iznad budžeta uloge uvijek eskalira |
| `kpis(tenantId)` | Prikazuje `kpis[]` (namjera iz configa) **pored** `measured` (ciljevi, nagrade, `budgetUsedPct`) | **Niko** — priznaje razliku između namjere i dokaza (`docs/24` §5) |

### 2.2 Swarm sloj — `src/swarm/*`

| Funkcija | Šta radi (kod) | Ko odlučuje | Ograničenje (stvarno) |
|---|---|---|---|
| `swarm.registerWorker()` | Registruje workera vezanog na agenta iz kataloga; `id = uid('wrk')`, `skills` iz agenta ili zadato | **`admin`** (ruta `POST /v1/admin/swarm/workers`) | `quotas.maxWorkers` (12) je **deklarisano, ali se ne provjerava** pri registraciji |
| `swarm.tick()` | Svaki worker uzima zadatak sa table (work stealing), izvršava kroz **isti** `orchestrator.run()`, ostavlja feromon | **Worker autonomno**, ali kroz governance | Samo `riskLevel: 'low'`; `medium`/`high` → `PolicyError` |
| `swarm.run()` | N rundi + `safety.detect()` poslije svake; prekida ako je tenant `frozen` | **`admin`** | Nema trajnog rasporeda — pokreće se rutom |
| `swarm.specialization()` | Mjeri ko je stvarno najbolji po tipu zadatka (iz završetaka) | **Niko** — mjerenje | Specijalizacija **nije** konfigurisana (to je i namjera) |
| `swarm.vote()` | Glas workera; `safety.observeVote()` + feromon; vraća `consensus()` | **`run`** rola (može agent) | Glas je **savjetodavan** i ne mijenja nijednu odluku (§4) |
| `swarm.consensus()` | Prebrojava glasove iz `safety.votes` u memoriji procesa | **Niko** | Gubi se restartom; nema kvoruma; nema žalbe |
| `governance.setIsolation()` | `open` / `contained` / `locked` / `frozen` | **`owner`** (čovjek) | Auditovano; `frozen` je kill switch |
| `governance.freeze()` / `unfreeze()` | Zaustavlja **sve** runove tenanta odmah | **`owner`** | `audit` zapis `decision: 'deny'`, `outcome: 'blocked'` |
| `governance.setQuotas()` | Mijenja kvote (pozitivne brojeve, samo poznata imena) | **`owner`** | **Globalno**, ne po tenantu: mutira zajednički `quotas` objekat (vidi §5) |
| `governance.assertCanRun()` | Provjera: izolacija → rizik → claims/min → satni trošak → `autonomy.evaluate()` | **Kod (fail-closed)** | Satni trošak se provjerava samo ako je `costUsd > 0` prosleđen — `swarm.tick()` ga **ne prosleđuje** |
| `safety.mediateMessage()` | **Jedini** kanal komunikacije workera; sumnjiv sadržaj → poruka se **ne dostavlja** | **Kod (fail-closed)** | Dozvoljeni tipovi: `MESSAGE_TYPES` (8 tipova) |
| `safety.detect()` | 5 detektora: lockstep, koordinisano glasanje, koncentracija, flooding, drift od mandata | **Kod**, incident → `alert`/`quarantine`/`freeze` | Prozor `windowMs: 600s`, `autoContain: true` |
| `safety.quarantine()` / `release()` | Isključuje workera iz rada | **`admin`** ili automatski | Kvota `maxPheromonesPerMin` se broji **globalno po tenantu**, ne po workeru (vidi §9) |

### 2.3 Inbox prijedloga — `src/learning/improvements.js`

Jedan kanal za **sve** „treba čovjek" situacije. `createProposal()` **uvijek** postavlja
`requiresHuman: true` i audit `decision: 'require_approval'`. Tipovi: `prompt`, `pattern`, `policy`,
`kb`, `action`, `tool`, `code`. Primjenjivi: prvih pet. `tool`/`code` ostaju `status: 'needs_code'` —
„ostaje kao zadatak za čovjeka".

Ko ulazi u inbox iz ovog dokumenta:

| Izvor (`source`) | Kada | `target` | `riskLevel` |
|---|---|---|---|
| `org-negotiation` | ponuda prelazi budžet uloge; ili nema dogovora u `maxRounds` | `ceo` (ili agent strane) | `medium` |
| `a2a-negotiation` | ponuda prelazi `maxAmountUsd` → `escalated` | `sales` | `high` |
| `a2a-negotiation` | `accept` iznad `requireHumanAboveUsd` → `awaiting_human` | `finance` | `high` |
| RSI / watchers / self-play | analiza nalaza (`docs/23`) | po nalazu | po nalazu |

### 2.4 A2A pregovor — `src/a2a/negotiation.js`

`defaultConstraints` iz `src/index.js`: `maxAmountUsd: 5000`, `requireHumanAboveUsd: 250`,
`maxRounds: 5`. Granice se provjeravaju **prije upisa**. Stanja:
`open → agreed | rejected | escalated | awaiting_human | expired → closed`.
`close()` traži rolu **`approve`** (novac!) i pravi `settlement` **internog** tipa + `contract` sa
`signature: null`. Detalji: `docs/25`.

### 2.5 Zbirna tabela: funkcija → ko odlučuje → ograničenje

| Funkcija (kod) | Ko odlučuje | Ograničenje |
|---|---|---|
| `company.chart()` | — (pogled) | Ne čita `/metrics`; KPI-jevi su tekst, mjerenje je posredno (`docs/24` §5) |
| `company.cycle()` | Agent predlaže; **čovjek primjenjuje** | Ne mijenja budžete, ne kreira ciljeve; neparsabilan JSON → prazan plan koji **prolazi** u zapis |
| `company.negotiate()` | Agenti (LLM), granica = `budgetUsd` uloge | `escalated` je kraj puta; nema automatskog nastavka |
| `company.kpis()` | — (prikaz) | Nema automatskog izvora (CRM/ERP/banka) |
| `swarm.tick()` / `run()` | Worker autonomno + governance | Samo `low` rizik; satni trošak se ne provjerava po zadatku |
| `swarm.vote()` / `consensus()` | — (savjet) | Ne obavezuje ništa; nema kvoruma, identiteta, žalbe |
| `governance.*` | **`owner` (čovjek)** | Kvote su globalne, ne per-tenant |
| `safety.*` | Kod, fail-closed | Detekcija radi u prozoru od 10 min; glasovi se gube restartom |
| `improvements.createProposal()` | **Čovjek** (`decide`, `apply`) | Agent može samo predložiti |
| `negotiator.open/respond` | Agent **u granicama**; iznad praga čovjek | `terms` popunjava LLM — struktura je zaštićena, sadržaj ne |
| `negotiator.close()` | **`approve` rola (čovjek)** | Poravnanje je simulacija |
| `autonomy.setLevel()` | **`owner` (čovjek)** | Nema kalibracije na stvarnom saobraćaju |

---

## 3. AI u governance-u

Granica nije „koliko je model pametan" nego **šta se smije izvršiti bez potpisa**. U kodu je ta granica
već iscrtana; ovdje je razdvajamo na četiri uloge koje agent **realno** može danas i četiri koje ne može.

### 3.1 Četiri uloge koje agenti realno mogu danas

| # | Uloga | Kako je to već u kodu | Ograničenje koje ostaje |
|---|---|---|---|
| 1 | **Analiza predloga** | RSI (`src/learning/rsi.js`) čita nagrade, greške alata, trace i ciljeve → `evidence[]`; `company.cycle()` čita portfolio ciljeva i stanje uloga | Analiza je onoliko dobra koliko su dobri ulazi; nema vanjskih podataka (CRM/ERP) |
| 2 | **Priprema odluke** | `negotiate()` proizvodi strukturisan `offer` + `transcript`; `improvements.createProposal()` pakuje `rationale`, `evidence`, `expectedImpact`, `riskLevel` | Priprema **nije** odluka: `requiresHuman: true` je tvrd |
| 3 | **Izvršenje u granicama** | `orchestrator.run()` pod politikama, per-agent i tenant budžetom, `maxSteps`/`maxWallMs`; `assertCanRun()` u roju pušta samo `low` rizik | Granice su tvrde, ali **samo ako su postavljene**; `L3` bez satnog limita troška u roju je realan rizik (§9) |
| 4 | **Mjerenje ishoda** | `rewards.record()` po runu; `goals.recordProgress()` → `progressPct` vs `expectedPct`; `cost.summary()`; `swarm.specialization()` | Mjerenje je **interno** (vlastiti ishodi), nema nezavisne provjere kvaliteta (eval harness postoji, ali nije kapija za sve) |

Zajedničko za sve četiri: **svaka ostavlja audit zapis**. To je ono što ih čini prihvatljivim u
hibridnom modelu — ne zato što su „pametne", nego zato što su **provjerljive**.

### 3.2 Četiri uloge koje agenti NE mogu (u kodu, ne u namjeri)

| # | Ne može | Zašto ne može — mehanizam | Dokaz |
|---|---|---|---|
| 1 | **Promjena sopstvenih granica** | `POST /v1/admin/autonomy` → `requiredRole: 'owner'`; izolacija roja, kvote, freeze, RSI nivo → `requiredRole: 'owner'`; izmjena politike ide kroz `policyOverrides.apply()` **samo** iz odobrenog prijedloga | `src/server/routes-autonomy.js`, `src/server/routes-swarm.js`, `src/learning/improvements.js` |
| 2 | **Raspolaganje novcem iznad praga** | `HUMAN_ONLY` sadrži `financial`; `riskLevel: 'high'` → `require_approval` na **svim** nivoima (uključujući L4); A2A `requireHumanAboveUsd` → `awaiting_human`; `close()` traži `approve` | `src/core/autonomy.js`, `src/a2a/negotiation.js` |
| 3 | **Pravno obavezujuće odluke** | `contract.signature: null` + `note` da je ugovor „radni zapis"; `legal` je u `HUMAN_ONLY` | `src/a2a/negotiation.js` |
| 4 | **Odluke o ljudima** | Nema agenta sa tim mandatom; `chro` mandat izričito isključuje odluke o ljudima; zaposlenje/otkaz/ocjena nisu ni u jednom `HUMAN_ONLY` spisku jer **nisu modelovani kao akcija agenta** | `config/company.json` |

> **Napomena o četvrtoj stavci:** to što odluke o ljudima nisu modelovane znači da ih agent ne može
> donijeti **zato što ne postoji put**, a ne zato što postoji brana. To je jeftinije i sigurnije, ali
> znači i da nema audita za tu granicu — granica je „nema funkcije", i tako treba i da ostane.

### 3.3 Siva zona (zašto je ovo teže od dvije liste)

Postoji peti slučaj koji nije ni „može" ni „ne može": **agent koji svojim izvršenjem mijenja uslove
pod kojima će se sljedeća odluka donijeti**. Primjeri iz koda:

- `swarm.specialization()` nastaje **sama** iz završenih zadataka — ako agent bira lake zadatke, izmjeri
  će se kao „ekspert", a mjerenje je stvarno (nema laži u podatku, ali ima u izboru).
- `improvements.apply(kind: 'policy')` mijenja **runtime** politiku do rollback-a. Granica je ljudska,
  ali **posljedica teče dok čovjek ne reaguje**.
- `rewards` ulaze u `chart().avgReward`, a taj broj čita **CEO prompt** u `cycle()` — pa mjerenje
  posredno oblikuje plan.

Zato §9 ima red o **zarobljavanju metrika** i §10 fazu 2 sa obaveznim vanjskim dokazom.

---

## 4. Glasanje i konsensus

### 4.1 Kako radi danas (čitaj: kako je u kodu)

```
swarm.vote({proposalId, workerId, choice})
  → validacija: proposalId + workerId + choice postoje, worker registrovan
  → ako je worker u karantinu → PolicyError
  → safety.observeVote({tenantId, workerId, proposalId, choice})   // ulaz u detekciju
  → blackboard.pheromone({type:'opportunity', payload:{proposalId, choice, rationale}})
  → consensus(tenantId, proposalId)
```

`consensus()` čita **isključivo** `safety.votes` (in-memory niz, cap 5000) i vraća:

```js
{ proposalId, votes, tally, winner, unanimous, participation, note }
```

- `winner` postoji samo ako je udio pobjedničke opcije **strogo > 0.5**; inače `null`.
- `unanimous` je `true` kada su svi glasovi ista opcija i glasova ima ≥ 1.
- `note` je **u samom podatku**: „Glasanje je savjetodavno — izvršne odluke iznad niskog rizika i dalje
  traže čovjeka (board)."

### 4.2 Nadzor glasanja — detekcija koordinisanog glasanja

Ovo je najvažniji dio ovog poglavlja i lako se previdi: **glasanje je instrumentovano kao vektor napada.**

`safety.detect()` ima pet detektora; dva se direktno tiču glasanja i koordinacije:

| Detektor | Uslov u kodu | Težina | Šta znači |
|---|---|---|---|
| `collusion_votes` | ≥ `voteCollusionMinWorkers` (3) glasa u prozoru, i `choices.size === 1` — **nijedno odstupanje** | `medium` | Koalicija glasa identično; u fer sistemu postoji šum |
| `collusion_lockstep` | par workera drži ≥ `lockstepThreshold` (0.7) sekvence preuzimanja, uz ≥ `lockstepMinCooccurrence` (4) prelaza | `high` | Dva workera se „kreću zajedno" bez dogovora — koordinacija kroz ritam |
| `resource_concentration` | jedan worker ≥ `concentrationThreshold` (0.6) preuzimanja u prozoru (min 10 preuzimanja) | `medium` | Jedan worker drži monopol na posao |
| `pheromone_flooding` | ≥ `floodingPerMin` (40) feromona po workeru u prozoru | `medium` | Zagušenje signalnog kanala |
| `mandate_drift` | zadatak sadrži fraze sa spiska (npr. `bypass`, `zaobiđi politiku`, `tajni kanal`, `ne prijavljuj`) | `high` | Zadatak traži izlazak iz mandata |
| `covert_channel_suspected` | entropija bez razmaka > `maxEntropyPerChar`, ili token > `maxTokenLength` (64), ili kontrolni znakovi | `high` → **karantin** | Sumnja na kodiran/skriveni kanal |

**Fail-closed ponašanje:** sumnjiva poruka se **ne dostavlja**; ako je nalaz `high`, otvara se incident
(`safety.jsonl`, metrike, audit sa `decision: 'deny'`), a `autoContain: true` izvršava
`quarantine` (za covert channel) ili `freeze` (kada detektor to zatraži). Karantin znači: `swarm.tick()`
preskače workera, a `swarm.vote()` baca `PolicyError`.

Detalji o tome kako je `docs/33` zamišljen: **vidi §9 i napomenu o nedostajućim dokumentima.**

### 4.3 Zašto je glasanje agenata savjetodavno (i zašto to nije kukavičluk)

Četiri razloga, svi provjerljivi u kodu:

1. **Glas nije vezan na izvršenje.** `consensus()` vraća objekat; **nijedna** linija koda ne čita
   `winner` da bi pokrenula akciju. Nema puta od „izglasano" do „izvršeno".
2. **Nema identiteta glasača.** `workerId` je `uid('wrk')` u memoriji procesa; nema potpisa, nema
   kriptografskog dokaza ko je glasao. Ko može zvati `POST /v1/admin/swarm/vote` (rola `run`) i znati
   tuđi `workerId`, može glasati u tuđe ime — jedina brana je to što karantinovani worker ne može glasati.
3. **Nema kvora ni praga za obavezujuću odluku.** `winner` traži > 50% **prisutnih** glasova; 2 od 2 je
   „pobjednik". Nema minimalne participacije, nema razlike između „niko nije glasao" i „svi su protiv".
4. **Nema žalbe ni ponavljanja.** Glas se gubi restartom (`votes` je in-memory). Nema ponovnog brojanja,
   nema roka, nema mogućnosti da manjina zatraži reviziju.

Zato je savjetodavno glasanje **ispravan izbor za v0.4**, a ne nedostatak: ono daje signal (i, kroz
detektore, rani znak koluzije) a ne prenosi odgovornost na mehanizam koji je ne može nositi.

### 4.4 Šta bi se moralo dodati za obavezujuće glasanje

Sve navedeno je **planirano** — nijedna stavka nije u kodu.

| # | Preduslov | Šta konkretno znači | Zašto bez toga ne smije biti obavezujuće |
|---|---|---|---|
| 1 | **Identitet** | Kriptografski identitet glasača (ključ po workeru/agentu) + potpis glasa | Bez toga glas nije dokazivo „čiji je" |
| 2 | **Stake ili reputacija** | Težina glasa iz stvarnih ishoda (uspješni zadaci, sporovi) ili iz uloženih sredstava | Bez cijene glasa, „1 worker = 1 glas" se kupuje registracijom workera |
| 3 | **Kvorum** | Minimalna participacija + prag po tipu odluke (npr. obična vs. izmjena granica) | Inače 2 glasa od 12 workera „odlučuju" |
| 4 | **Veto** | Izričit veto za kategorije iz `HUMAN_ONLY` i za uloge sa KPI-jem koji odluka obara (`docs/24` §7, „marža je veto") | Bez veta koalicija može izglasati odluku koja ruši tuđi KPI |
| 5 | **Žalba i rok** | Prozor za prigovor, ponovno brojanje, zapis o tome ko je uložio žalbu | Bez toga je jedna greška konačna |
| 6 | **Trajnost glasova** | Glasovi van memorije procesa (perzistentno, sa `hash`-om i vremenom) | Restart ne smije mijenjati ishod |
| 7 | **Razdvajanje predlagača i glasača** | Ko predlaže ne glasa (ili mu je glas težinski manji) | Inače predlagač „izglasa" svoj predlog |
| 8 | **Vezanje na izvršenje** | Eksplicitna funkcija `execute(consensus)` koja **provjerava** granice prije izvršenja | „Izglasano" ne smije značiti „zaobišlo politiku" |

> **Pravilo koje predlažem za svaku buduću fazu:** obavezujuće glasanje se uvodi **samo** za odluke koje
> su **već** dozvoljene na `L4` u `AUTONOMY_LEVELS` (`canActLow`, `canActMedium`) — nikad za
> `financial`, `legal`, `destructive`, `external_communication`. Ako glasanje treba da pomjeri granicu,
> to nije glasanje nego **izmjena ustava** — i to ostaje čovjeku.

---

## 5. Treasury i budžet

### 5.1 Četiri nivoa budžeta — i koji je stvarno tvrd

| Budžet | Gdje je (kod/config) | Tvrd ili display | Ko mijenja | Kako se provjerava |
|---|---|---|---|---|
| **Per-agent mjesečni** | `config/tenants.json` → `agentBudgets` → `controlPlane.setBudget()` → `data/_control/agents.json` | **TVRD** | **`owner`** (`POST /v1/admin/agents/:agentId/budget`) | `assertAgentBudget()` prije svakog runa (`src/orchestration/index.js`); preko → `PolicyError` + audit `agent_budget_block` |
| **Tenant mjesečni** | `config/tenants.json` → `budget.monthlyUsd` (za `nmq` 200, `demo-shop` 15); default iz env | **TVRD** | Čovjek u configu (+ restart) ili kontrolna ravan | `createBudget({monthlyUsd})` → `assertCanContinue()` u svakom koraku (`src/core/budget.js`) |
| **Run budžet** | `tenant.budget.runUsd` (za `nmq` 1.5) → `options.maxRunUsd` | **TVRD** | Čovjek u configu / po pozivu | `assertCanContinue()` + `maxSteps` × `PATTERN_STEP_BUDGET` + `maxWallMs` |
| **Swarm satna kvota** | `config/swarm.json` → `quotas.maxCostPerHourUsd` (2) | **TVRD, ali se ne aktivira iz `tick()`** | **`owner`** (`setQuotas`) | `assertCanRun({costUsd})` — `swarm.tick()` poziva **bez** `costUsd`, pa je provjera mrtva na tom putu |
| **Uloga (`company.json`)** | `config/company.json` → `budgetUsd` (60/50/30/25/25/15/40) | **DISPLAY (nije tvrd!)** | Čovjek u JSON-u (+ restart) | **Nema runtime provjere.** Koristi se samo za `budgetUsedPct` u `chart()`; tvrdi prekid postoji **samo** u `negotiate()` kada LLM ponudi iznad svog `budgetUsd` |
| **Swarm kvote (ne-novac)** | `maxWorkers` 12, `maxRunsPerTick` 8, `maxPheromonesPerMin` 120, `maxPeerMessagesPerMin` 60, `maxTasksOpen` 200, `maxClaimsPerWorkerPerMin` 20 | **Mješovito** | **`owner`** | `maxRunsPerTick` ✅ ulazi u `tick()`; `maxClaimsPerWorkerPerMin` ✅; pheromone/peer ✅; **`maxWorkers` se nigdje ne provjerava**; `maxTasksOpen` **se ne provjerava** u `blackboard.postTask` |

### 5.2 Ono što iz tabele slijedi (i što treba govoriti naglas)

1. **`budgetUsd` u `company.json` je namjera, ne brana.** „CRO ima 50 USD" znači: `chart()` će prikazati
   `budgetUsedPct`, i `negotiate()` će prekinuti pregovor ako **model** traži više. Stvarni limit za
   agenta `sales` dolazi iz `agentBudgets.sales = 30` (u `nmq`), ako je u kontrolnoj ravni postavljen.
2. **Mjesečna rotacija budžeta:** `assertAgentBudget()` poredi sa `cost.summary()`, a trošak se rotira po
   kalendarskom mjesecu (`usage/YYYY-MM.jsonl`). Znači: budžet se resetuje **vremenom**, ne odlukom.
3. **`setQuotas` je globalan.** Mutira zajednički `quotas` objekat u `createSwarmGovernance`; poziv za
   jedan tenant mijenja kvote **svim** tenantima u procesu. `config/swarm.json` ima `tenants.nmq.quotas`
   koji se pri startu primjenjuje istim (globalnim) putem. To je **poznata granica**, ne namjera.
4. **Trošak pregovora je trošak.** Svaka runda `negotiate()` je LLM poziv sa `costUsd`, i sabira se u
   ciklus (`record.costUsd`) i u `byAgent` uloge govornika. Pregovor koji traje je **stvarna potrošnja**,
   a ne „razgovor".
5. **Gdje nema novca:** `settlement` sa `method: 'internal'` je **simulacija** (`note` to kaže);
   `method: 'stripe'|'sepa'|'x402'` ostaje `pending` i traži adapter (`settle()` hook je ručni).
6. **Nijedna cijena modela nije u ovom dokumentu.** `PRICING` je u `src/observability/cost.js` sa
   napomenom „provjeriti kod provajdera" (D36, `priceSource` + `nmq_pricing_fallback_total`).

> **Treasury u jednoj rečenici:** tvrdi novac je na **dva** mjesta (per-agent i tenant mjesečni budžet) i
> tamo gdje je tvrd — provjerava se **prije** izvršenja. Sve ostalo (uloge, deklarisane kvote roja) je
> **namjera** koja se vidi u izvještaju, ali ne zaustavlja run.

---

## 6. Identiteti agenata

### 6.1 Šta postoji danas

| Identitet | Kako nastaje (kod) | Šta dokazuje | Šta ne dokazuje |
|---|---|---|---|
| **Tenant API ključ** | `requireAuth` + `apiKeys` (hash) u configu; `node src/cli.js keys <tenantId> [role]` | Pristup tenantu, rola (`read`/`run`/`approve`/`admin`/`owner`) | Koji **agent** je pozvao |
| **Per-agent ključ `nmqa_…`** | `controlPlane.issueAgentKey()` → `nmqa_${token(24)}`; čuva se **samo hash**; `revokeAgentKey()` postavlja `revokedAt` | Servisni identitet agenta (za MCP servere i pozadinske procese) | Ne radi kao autentikacija na gateway-u (`docs/13` §4 — poznat defekt); `scopes` se ne provjeravaju pri izvršenju |
| **A2A agent card** | `buildAgentCard()` na `/.well-known/agent.json` i `/a2a/card` | Šta **mi** izlažemo: `skills[]` iz kataloga, `limits` tenanta (rate limit, mjesečni budžet, `autonomyDefault`), `authentication.schemes: ['bearer']` | Ne dokazuje identitet **partnera** — mi vjerujemo da je partner onaj za koga se izdaje |
| **Worker ID** | `swarm.registerWorker()` → `uid('wrk')`, samo u memoriji | Ništa van procesa: to je interna ručka za feromone, kvote i glasove | Restart → novi worker ID; nema veze sa ključem |
| **`fromAgent` u A2A zadatku** | Polje u tijelu zahtjeva (`POST /a2a/tasks`) | **Ništa** — to je samodeklarisana oznaka koju upisujemo u audit (`actor: 'a2a:<fromAgent>'`) | Nije provjereno ni protiv čega |

### 6.2 Šta fali (planirano, po prioritetu)

| # | Nedostatak | Rizik | Predlog |
|---|---|---|---|
| 1 | **Potpisivanje zahtjeva** (Ed25519 ili HMAC po tijelu + timestamp) | Replay i „ne poričem": bez potpisa se ne može dokazati ko je šta poslao | `X-NMQ-Timestamp` + `X-NMQ-Signature`, verifikacija **prije** handlera; ključevi partnera u `data/tenants/<id>/` |
| 2 | **Anti-replay** (`nonce`/`jti` + kratki prozor + keš obrađenih) | Ponovljen zahtjev = dupli posao ili dupli pregovor | Prozor 5 min; za plaćanja **obavezno** idempotency key |
| 3 | **Reputacija partnera** | Nepoznat partner troši naš budžet i stvara obaveze | Skor iz stvarnih ishoda (% završenih, kašnjenja, sporovi) koji **utiče** na granice (npr. niži `requireHumanAboveUsd` za novog partnera) |
| 4 | **Revokacija na nivou roja** | Karantin je po **workeru** (`isQuarantined(workerId)`), a ključ je po **agentu** — nema jedne poluge „isključi agenta iz roja" | `swarm.revokeAgent(tenantId, agentId)`: karantin svih workera tog agenta + opoziv njegovih ključeva, u jednoj auditovanoj akciji |
| 5 | **Kriptografski identitet workera** | Worker ID je `uid()` u memoriji; glas i feromon nisu dokazivi | Ključ po workeru (Ed25519) izveden iz per-agent ključa, sa `createdAt`/`revokedAt` |
| 6 | **Provjera partnerovog card-a** | Prihvatamo samodeklarisanog partnera | Dohvatiti `/.well-known/agent.json` druge strane, provjeriti domen/TLS; za ozbiljne partnere razmjena ključeva van opsega |
| 7 | **`fromAgent` u allowlist** | Danas se allowlista provjerava samo za **pregovore** (`allowedCounterparties`); zadaci nemaju listu | `allowedAgentPeers` po tenantu (isti duh kao `allowedAgents`) |

> **Identitet u jednoj rečenici:** imamo **autentikaciju tenanta** (dobru) i **oznaku agenta** (slabu).
> Dok god je glasanje savjetodavno, to je prihvatljivo; **prije** prvog obavezujućeg glasa ili prvog
> pravog novca, identitet mora biti kriptografski.

---

## 7. Blockchain i smart contracts — realno stanje 2026

### 7.1 Iskreno o tome gdje smo

- **Interni ledger je simulacija.** `settlement.create({method:'internal'})` postavlja `status: 'settled'`
  i `note: 'Interni ledger (simulacija) — nema stvarnog prenosa novca.'` To piše **u samom podatku**.
- **Nema novca.** Nijedan zapis ne predstavlja sredstvo; `totals()` sabira **naše** brojeve.
- **Nema blockchain-a.** Nema wallet-a, nema ključa, nema mreže, nema gas-a.
- **Nema smart contract-a.** `contract.signature: null`; `close()` pravi zapis sa uslovima, ne izvršni kod.
- **Nema tokena** — i to je namjerno (`docs/25` §6: „Nikakav 'token' ni 'naš chain'").

### 7.2 Slučaj-po-slučaj: ima li smisla

| Slučaj | Ima li smisla | Zašto | Rizik |
|---|---|---|---|
| **Interni procesi** (naše poravnanje između naših uloga/tenanta) | ❌ **Ne** | Nema nepovjerenja; JSONL + baza su dovoljni; lanac dodaje latenciju i trošak | Trošak i složenost bez koristi |
| **B2B sa ugovorom i fakturom** | ❌ **Ne** | Postoji ugovor, DPA, faktura i zakonski rok plaćanja; lanac ne mijenja ni jednu obavezu | Dupli sistem evidencije |
| **Naplata pretplate klijentu** | ❌ **Ne** | Kartica/SEPA + faktura je ono što klijent i knjigovodstvo znaju | Korak nazad za korisnika |
| **Mikro-plaćanje nepoznatom trećem agentu** (plati i dobij podatak u jednom potezu) | ✅ **Da, uslovno** | Klasična kartica je za mikro-iznos preskupa; nema računa ni fakture | KYC/AML, neopozivost, volatilnost (ako nije stablecoin), računovodstvo |
| **Trustless settlement između strana koje se ne poznaju** | ✅ **Da, uslovno** | Nema zajedničkog posrednika; ono što je zapisano je izvršeno | Neopozivost; pravni status; sporovi bez nadležnosti |
| **Programabilni escrow bez posrednika** | ⚠️ **Možda** | „Plati kad se isporuči" izvršava kod — korisno kad treće lice nije dostupno | Escrow je **finansijska usluga**; traži licencu ili partnera |
| **Dokazivost i vremenska oznaka** (hash odluke van lanca) | ⚠️ **Možda, jeftino** | Hash + `ts` u hash-lancu audita **već postoji** (`docs/DECISIONS.md` D16) | Vrijednost samo ako treća strana priznaje taj dokaz |
| **Evidencija koja mora da se briše (GDPR)** | ❌ **Ne** | Nepromjenljivost je u direktnom sukobu sa pravom na brisanje; rješenje je „hash van lanca, podatak u bazi" | Pravni rizik |
| **Sve gdje je potrebna ispravka greške** | ❌ **Ne** | Neopozivost znači da typo u adresi/iznosu nema povratka | Operativni rizik |

> **Zaključak tabele:** blockchain ima smisla **samo** tamo gdje postoji **nepoznata treća strana** i
> **mikro-iznos**. Sve ostalo rješava klasičan kanal — brže, jeftinije i sa manje odgovornosti.

### 7.3 Kada bi x402/stablecoin imao smisla

Konkretno, i to je **uski** slučaj (`docs/25` §8c):

**Scenario:** naš agent treba tuđi podatak (embedding, prijevod, provjera) od **nepoznatog** agenta;
partner traži plaćanje po pozivu; iznos je mikro; nema računa, nema fakture, nema ugovora.

**Šta traži prije prvog poziva:**

| # | Preduslov | Zašto |
|---|---|---|
| 1 | **Odvojen wallet sa minimalnim saldom** i dnevnim limitom | Krađa ključa = krađa **sredstava**; minimalan saldo ograničava štetu |
| 2 | **Stablecoin, ne volatilno sredstvo** | Iznos od danas mora biti iznos od sutra; kursni rizik u knjigama je nepotreban |
| 3 | **KYC/AML provjera gdje se primjenjuje** | Primanje sredstava od nepoznatog lica povlači provjeru identiteta i porijekla sredstava; „agent plati agentu" **ne ukida** tu obavezu |
| 4 | **Tvrdi limiti u kodu, ne u promptu** | Dnevni limit u `constraints` + `awaiting_human` iznad praga; ako limit nije u kodu, nije limit |
| 5 | **Ljudsko odobrenje pri prvom punjenju i pri svakoj promjeni limita** | To su jedine dvije akcije sa trajnom posljedicom |
| 6 | **Računovodstveni tretman** (valuta, kurs, PDV, priznavanje prihoda) | Mora ući u knjige, a ne u dnevni izvještaj |
| 7 | **Pravna osnova i poreski tretman** | **Provjeriti sa advokatom i knjigovođom** — tretman kripto-imovine se razlikuje po jurisdikciji i mijenja se |
| 8 | **Reconciliation** (naš zapis ↔ wallet ↔ knjige) | Bez toga ne znamo koliko smo stvarno potrošili |
| 9 | **Idempotency + `externalRef` u zapisu** | Dupli poziv ne smije biti duplo plaćanje |

**Redoslijed koji predlažem:** prvo **Stripe/SEPA** (jer ima povrat, storno, jasan poreski tretman i
klijent ga već zna) → pa, **samo ako partner traži i plaća**, x402/stablecoin za mikro-iznose.

---

## 8. Uloga ljudi (board)

### 8.1 Šta board odlučuje (i ništa manje od toga)

| Domena | Konkretna odluka | Mehanizam u kodu |
|---|---|---|
| **Vrednosti i granice** | Koje kategorije su `HUMAN_ONLY`; nivo autonomije po tenantu/agentu; izolacija roja; kvote roja; RSI nivo | `src/core/autonomy.js` (`HUMAN_ONLY`), `POST /v1/admin/autonomy` (`owner`), `POST /v1/admin/swarm/governance/*` (`owner`) |
| **Budžet** | Tenant mjesečni, run budžet, per-agent mjesečni, deklarisani budžeti uloga | `config/tenants.json`, `POST /v1/admin/agents/:agentId/budget` (`owner`), `config/company.json` |
| **Rizik** | Odobravanje `high` rizika; zatvaranje incidenata; freeze/unfreeze; karantin | `POST /v1/approvals/:runId`, `POST /v1/admin/swarm/incidents/:id/resolve`, `/swarm/freeze`, `/swarm/quarantine` |
| **Ljudi** | Zaposlenje, otkaz, ocjena, raspored | **Nema agenta** — nema funkcije; ostaje izvan sistema |
| **Pravno** | Ugovor, DPA, uslovi, potpis partnera | `close()` traži `approve`; `contract.signature` ostaje `null` dok čovjek ne potpiše **van** sistema |
| **Promjena ponašanja agenta** | Prompt, pattern, politika, KB | `improvements.decide()` → `apply()` → `rollback()` |
| **Krajnja odgovornost** | Šta sistem **tvrdi** prema klijentu i regulatoru | Ništa u kodu ne preuzima odgovornost; zato `docs/DECISIONS.md` §0 kaže „sve pod politikom, budžetom i audit tragom" |

### 8.2 Kako izgleda sjednica

**Dnevni ritual — 10 minuta (operativno, ne strateško).** Cilj: **ništa ne čeka > 24 h**.

| Min | Šta se gleda | Odakle (ruta/fajl) | Pitanje |
|---|---|---|---|
| 0–2 | **Incidenti roja** (otvoreni, `high`) | `GET /v1/admin/swarm/incidents`, `GET /v1/admin/swarm/safety` | Ima li koluzije, covert kanala, flooding-a? |
| 2–5 | **Odobrenja koja čekaju** (`awaiting_approval`, `awaiting_human`) | `GET /v1/approvals`, `GET /v1/admin/proposals?status=proposed` | Šta blokira posao? |
| 5–8 | **Trošak vs. budžet** (tenant i top agenti) | `GET /v1/usage`, `GET /v1/admin/health` | Da li potrošnja prati vrijednost? |
| 8–10 | **Karantin i freeze stanje** | `GET /v1/admin/swarm`, `/swarm/quarantine/:workerId/release` | Koga vraćamo u rad i zašto? |

**Nedjeljni ritual — 30 minuta (strateško).** Cilj: **šest brojeva i tri liste**, ne 40 strana logova.

| Min | Šta se gleda | Odakle | Pitanje |
|---|---|---|---|
| 0–5 | Org chart i KPI-ji uloga | `GET /v1/admin/org`, `/v1/admin/org/kpis` | Koja uloga ima `goalsAtRisk > 0` i rast troška? |
| 5–10 | Ciklus i pregovori (istorija) | `GET /v1/admin/org/history?limit=20`, `data/tenants/<id>/org/cycles-YYYY-MM.jsonl` | Da li je plan bio prazan (problem sa modelom) ili stvarno prazan? |
| 10–18 | **Inbox prijedloga** (odobriti / odbiti / dopisati) | `GET /v1/admin/proposals?status=proposed` → `POST /v1/admin/proposals/:id/decide` | 1–3 odluke, ne 10 |
| 18–23 | Kvalitet i regresija | `GET /v1/admin/rewards`, `/metrics`, `POST /v1/admin/eval` | Gdje agent griješi **sistematski**? |
| 23–27 | Specijalizacija i drift roja | `GET /v1/admin/swarm/specialization`, `/swarm` (`safety.byType`) | Da li se „ekspertiza" mijenja bez odluke? |
| 27–30 | **Zapisnik i vlasnici** (1–3 stavke) | za sada ručno (`docs/24` §6) | Ko je vlasnik i do kada? |

**Ko potpisuje:** do danas **nijedan agent**. Potpis je:
(a) **ljudski** — pravni potpis van sistema (`contract.signature: null`);
(b) **tehnički** — hash-lanac audita dokazuje da zapis nije mijenjan, ali **nije** pravni potpis;
(c) **`owner` rola** — svaka izmjena granica (autonomija, izolacija, kvote, RSI nivo, budžet agenta).

> **Ritual je danas ručni** — nema rute koja ga generiše i nema zakazanog posla za njega. To je
> **planirano** (prvi „meta" posao u scheduleru), i to je pošteno reći: ritual postoji kao **obaveza
> čovjeka**, ne kao funkcija.

---

## 9. Rizici emergentne organizacije

| Rizik | Primjer (konkretan, iz našeg koda) | Detekcija (šta već postoji) | Mitigacija (šta raditi) |
|---|---|---|---|
| **Koluzija** | Tri workera glasaju identično na svaki `proposalId`; dva workera drže 80% sekvence preuzimanja (`collusion_lockstep`) | `collusion_votes` (≥ 3 glasa, `choices.size === 1`), `collusion_lockstep` (share ≥ 0.7, ≥ 4 prelaza), `resource_concentration` (≥ 0.6) — `safety.detect()`, `GET /v1/admin/swarm/safety`. Detaljno: `docs/33` (vidi napomenu ispod) | Karantin workera; promjena sastava roja; **obavezno čitanje nalaza u nedjeljnom ritualu**; prije obavezujućeg glasanja — identitet + stake (§4.4) |
| **Zarobljavanje metrika (Goodhart)** | `swarm.specialization()` nagrađuje **broj završenih** zadataka po tagu → worker koji uzima lake zadatke postaje „ekspert"; `avgReward` ulazi u CEO prompt u `cycle()` | `GET /v1/admin/swarm/specialization`, `avgReward`, `goalsAtRisk`; `rewards.js` koristi 12 signala (ne samo uspjeh) | Miješani set zadataka; mjeri se i **težina** i **ishod cilja**, ne samo broj; KPI koji se ne može ispuniti „obimom" (`docs/24` §5); periodično mijenjati šta se mjeri — i to **odlukom**, ne tiho |
| **„Tihi" rast autonomije** | `improvements.apply(kind:'policy')` mijenja runtime politiku; `policyOverrides` se merge-uje preko configa → efekat **traje** dok čovjek ne vidi | Audit `improvement_applied` (+ `rollbackInfo`), `GET /v1/admin/proposals`, `autonomy_level_changes_total` | Nedjeljni pregled **aktivnih** policy override-a; rollback je jedan poziv; nikad ne mijenjati granicu bez zapisa u zapisnik; `setLevel` ostaje `owner` |
| **Odgovornost bez potpisa** | Agent odgovori partneru cijenu/rok; partner to citira kao obavezujuću ponudu; `contract.signature: null` | `agreed` samo pod `requireHumanAboveUsd`; iznad → `awaiting_human`; `close()` traži `approve`; audit `negotiation_response` sa `decision` | Ugovorom: izlaz je **nacrt**, ne obaveza (`docs/25` §5); pisano ovlaštenje klijenta ako agent pregovara u njegovo ime |
| **Regulatorno** | Mikro-plaćanje stablecoin-om; prekogranični prenos podataka u A2A zadatku; PII u `tasks-YYYY-MM.jsonl` | Trenutno: **ništa automatski** — nema KYC/AML, nema DPA lanac u kodu, nema redakcije A2A ulaza | **Provjeriti sa advokatom** prije prvog pravog novca; DPA sa klijentom; politika čuvanja i brisanja po partneru (`docs/25` §6, „Otvorena pitanja") |
| **Prekoračenje budžeta u roju** | `swarm.tick()` poziva `assertCanRun()` **bez** `costUsd`, pa se `maxCostPerHourUsd` (2) na tom putu ne aktivira; `maxWorkers` (12) i `maxTasksOpen` (200) se ne provjeravaju | `swarm_quota_blocks_total{kind:cost}` — **neće se pojaviti** za ovaj put; trošak se vidi u `swarm.stats().costUsd` i `GET /v1/usage` | Proslijediti procijenjeni trošak u `assertCanRun`, ili provjeravati **nakon** runa i prekidati sledeći (`recordCost` već postoji); dodati provjeru `maxWorkers` i `maxTasksOpen` |
| **Globalne kvote umjesto per-tenant** | `setQuotas()` mutira zajednički objekat → promjena za jedan tenant mijenja sve u procesu | Audit `swarm_quotas_set`, `GET /v1/admin/swarm/governance` (vraća trenutne `quotas`) | Kvote po tenantu (mapa `tenantId → quotas`) ili prihvatiti kao dokumentovanu granicu; **do tada ne mijenjati kvote u toku rada drugih tenanta** |
| **Gubitak stanja pri restartu** | `safety.votes`, `claims`, `messages`, `findings`, `incidents`, `quarantined` i `workers` su **in-memory** | Nestaju restartom; ostaje samo `swarm/safety.jsonl`, `messages.jsonl`, `governance.jsonl` | Perzistirati glasove/incidente ako glasanje postaje obavezujuće (§4.4, tačka 6); do tada: restart = čist roj, i to je poznato |
| **Kvota feromona po tenantu, ne po workeru** | `assertCanPheromone({by})` koristi isti `rateWindows` ključ po tenantu za **sve** workere → flooding detektor je po workeru, a kvota po tenantu | `pheromone_flooding` (≥ 40/worker), `swarm_quota_blocks_total{kind:'pheromone'}` | Razdvojiti ključ na `tenant::worker` ili dokumentovati da je kvota zajednička (prvi worker koji „pojede" kvotu blokira ostale) |
| **Nedostajući dokumenti na koje se kod poziva** | `config/swarm.json` referencira `docs/29` i `docs/33` (koluzija), ali u `docs/` **ne postoje** fajlovi `29-*` i `33-*` (postoje do `28-AI-FRANCHISE.md`) | `Get-ChildItem docs` | Napisati `docs/33` (koluzija i nadzor roja) i uskladiti reference; do tada je §9 ovog dokumenta **jedini** opis detektora u dokumentaciji |

> **Zajednički imenilac svih rizika:** sistem je **detektivan** (nalaz, incident, audit) i **reverzibilan**
> (rollback, freeze, karantin) — ali **nije preventivan** za rizike koji nastaju iz **izbora** (koje
> zadatke worker uzima, šta ulazi u mjerenje). Zato je ljudski pregled **mehanizam**, a ne ceremonija.

---

## 10. Praktični plan (12–24 mj.)

Tri faze. Prelaz iz faze u fazu je vezan **na dokaz**, ne na kalendar. Ako dokaz izostane, faza se
**ne produžava** — obim se sužava (`docs/27` §6, pravilo „sječe se obim, ne produžava rok").

### Faza 1 (mj. 0–6): hibrid sa jasnim granicama

**Preduslov:** ništa novo se ne gradi dok sve što postoji nije **dokazano na stvarnom klijentu**.

| Šta se radi | Dokaz da je urađeno | Rizik |
|---|---|---|
| Uskladiti `VERSION`/`package.json`/`DECISIONS.md` na jedan broj | Jedan broj na tri mjesta; `node --test` prolazi | Nizak — formalnost, ali investitor to prvo pita |
| Napisati **`docs/33`** (koluzija i nadzor roja) i uskladiti reference iz `config/swarm.json` | Dokument postoji; `docs/29` referenca uklonjena ili dokument napisan | Srednji — dokument bez koda je obećanje; zato se piše **iz** `safety.js` |
| Popraviti tvrde kvote roja: `costUsd` u `assertCanRun`, `maxWorkers`, `maxTasksOpen` | Test: 13. worker se odbija; satni trošak prekida tick; board preko 200 zadataka se odbija | Srednji — mijenja ponašanje roja; ide uz test |
| Per-tenant kvote (ili eksplicitna odluka da ostaju globalne) | Odluka u `DECISIONS.md` + test da promjena za `nmq` ne mijenja `demo-shop` | Srednji |
| **Dnevni i nedjeljni ritual kao zapis** (šablon zapisnika + ko potpisuje) | 4 zapisnika u nizu postoje; svaki ima 1–3 odluke i vlasnika | Nizak |
| `budgetUsd` uloga: display ili tvrd? | Odluka zapisana; ako je tvrd — provjera u `cycle()` i `negotiate()` sa testom | Srednji — danas je **display**, i to mora pisati u dokumentu |

**KPI faze 1:** **0 incidenata izolacije tenanta**, **0 odobrenja starijih od 24 h**, **≥ 1 stvarni
org ciklus** nad stvarnim podacima (danas je „nijedan ciklus nije vođen nad stvarnim poslovanjem",
`docs/27` §1).

### Faza 2 (mj. 6–18): AI operativa sa mjerenjem

**Preduslov:** faza 1 dokazana (zapisnici + tvrde kvote + usklađena verzija).

| Šta se radi | Dokaz da je urađeno | Rizik |
|---|---|---|
| **Eval kao kapija** za svaku promjenu ponašanja (prompt/politika/KB/pattern) | Regresija > 5% **automatski odbija** prijedlog; `node scripts/eval.mjs` u CI-ju | Visok ako eval nije reprezentativan — lažna sigurnost |
| **Identitet i potpis** za A2A i glasanje (Ed25519 + anti-replay) | Test: potpisan zahtjev prolazi, nepotpisan/ponovljen se odbija | Srednji — operativna sigurnost ključeva je nova obaveza |
| **Reputacija partnera** iz stvarnih ishoda, sa uticajem na granice | Skor vidljiv u `GET /a2a/*`; nov partner ima **niži** `requireHumanAboveUsd` (dokazano testom) | Srednji — reputacija ne smije biti „ručno mijenjana" |
| **Perzistencija glasova i incidenata**; kvorum, veto, žalba (§4.4) | Glas preživi restart; ishod se ne mijenja restartom; žalba ima zapis | Visok — ovo je prvi korak ka obavezujućem glasanju, pa ide **iza** identiteta |
| **Mjerenje ishoda van sistema** (prvi konektor: Stripe/webhook za naplatu, pa support kanal) | Uplata → `goals.recordProgress()`; broj u `GET /v1/usage` se poklapa sa stvarnim izvorom | Srednji — pristup finansijskim podacima klijenta traži DPA (**provjeriti sa advokatom**) |
| **Pravo poravnanje** (Stripe ili SEPA) iza postojećeg `settle()` hook-a | ≥ 1 stvarna faktura/naplata prošla kroz A2A tok; reconciliation do centa | Visok — pravne obaveze (KYC/AML, PDV); mi **ne držimo** sredstva |
| **Org ciklus u produkciji** (iz eksperimentalnog u beta) | ≥ 1 odluka iz ciklusa **primijenjena** uz audit, po klijentu | Srednji — ciklus koji se ne primjenjuje je trošak tokena |

**KPI faze 2:** **% riješeno bez čovjeka > 60%**, **trošak modela < 15% prihoda**, **≥ 100 stvarnih
A2A zadataka/mj. sa partnerom**, **≥ 2 partnera u produkciji**.

### Faza 3 (opciono, mj. 18–24): DAO pilot — **samo ako postoji stvarna potreba trećih strana**

**Preduslov (sva tri moraju biti istinita, inače se faza ne otvara):**

1. **Treća strana traži** on-chain poravnanje (ne mi) i **plaća** ga.
2. **Pravnik potvrdi** da ne uvodimo dodatne obaveze (KYC/AML, licence, poreski tretman) —
   **provjeriti sa advokatom**.
3. Postoji **mjereni** obim mikro-plaćanja koji klasičan kanal čini skupljim (broj transakcija ×
   naknada > trošak i rizik on-chain puta). Cijene se **provjeravaju kod provajdera**, ne pretpostavljaju.

| Šta se radi (ako se faza otvori) | Dokaz | Rizik |
|---|---|---|
| Stablecoin mikro-plaćanje za **nepoznatog** trećeg agenta, odvojen wallet, dnevni limit | ≥ 1 stvarna mikro-transakcija sa `externalRef`; reconciliation | Visok: krađa ključa, neopozivost, volatilnost (ako nije stablecoin) |
| Smart contract **samo kao escrow za jedan tip posla** | Test na testnet-u + pravni pregled teksta ugovora | Visok: escrow je finansijska usluga |
| **Vlasničko glasanje** (ako uopšte) — identitet + stake/reputacija + kvorum + veto + žalba | Test: glas se ne može kupiti registracijom; veto radi; žalba mijenja ishod | Visok: ovo je ustav, ne funkcija |
| On-chain **sidrenje hash-a** odluka (bez sadržaja) | Periodični `anchor(hash)` u zapisu; podatak ostaje u bazi (GDPR) | Nizak, ako se sidri samo hash |

**KPI faze 3:** **≥ 1 partner koji traži on-chain i plaća**, **0 regulatornih nalaza**,
**reconciliation do centa**, **nijedna odluka iz `HUMAN_ONLY` nije prešla na glasanje**.

> **Ako uslov iz tačke 1 izostane, ispravan ishod je „ne radimo" — i to je uspjeh odluke, ne propust**
> (`docs/27` §6, „Blockchain bez stvarnog razloga").

---

## Otvorena pitanja

1. **Je li `budgetUsd` uloge namjera ili brana?** Danas je **display** (`chart().budgetUsedPct`) uz jedan
   tvrd prekid u `negotiate()`. Ako postaje tvrd, mora se provjeravati u `cycle()` i `negotiate()` i imati
   test — a ako ostaje display, mora to **pisati u svakom izvještaju**, da se ne čita kao limit.

2. **Smije li glas workera ikad obavezivati — i ako da, za koje odluke?** Moj predlog: samo za odluke
   koje su već dozvoljene na `L4` (`canActLow`, `canActMedium`), nikad za `HUMAN_ONLY`. Ali to je
   **ustavna** odluka i traži i identitet (§6) i kvorum/veto/žalbu (§4.4) **prije** prve obavezujuće
   odluke.

3. **Kako mjeriti „koluziju" kada je identitet slab?** Detektori rade na `workerId`-u iz memorije; ako
   glasanje postane obavezujuće, a identitet ostane `uid()`, detekcija je zaobilazna. Da li prvo
   kriptografski identitet, pa glasanje — ili glasanje ostaje savjetodavno dok identitet ne postoji?

4. **Per-tenant ili globalne kvote roja?** `setQuotas()` danas mijenja **sve** tenante u procesu
   (poznata granica). Da li uvodimo mapu po tenantu, ili prihvatamo granicu i dokumentujemo je kao
   „kvota je procesna, ne ugovorna"?

5. **Ko plaća prvi pravi novac — i čija je odgovornost?** Ako agent pregovara u ime klijenta, treba
   **pisano ovlaštenje** sa granicama (mandat i `maxAmountUsd` su tehnička, ne pravna granica
   ovlaštenja). To je pitanje za advokata, ne za kod.

6. **Šta je „dokaz" da je DAO pilot opravdan?** Moj predlog: (a) treća strana **traži** on-chain,
   (b) **plaća** ga, (c) mjereni obim mikro-plaćanja čini klasičan kanal skupljim, (d) pravnik potvrdi
   da ne uvodimo nove obaveze. Ako (a) ili (b) izostanu — faza se ne otvara, i to je odluka koja se
   **zapisuje** (kao i svaka druga).
