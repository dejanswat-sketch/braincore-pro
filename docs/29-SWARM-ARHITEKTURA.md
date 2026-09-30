# 29 — Swarm arhitektura: od orkestratora do roja

> Verzija dokumenta: 1.0 · Faza: v0.4 (decentralizovani swarm) · Vlasnik: NMQ (Dejan Milošević PR)
> Izvor istine je **kod**, ne ovaj tekst. Sve tvrdnje ispod provjerene su na fajlovima:
> `src/swarm/blackboard.js`, `src/swarm/swarm.js`, `src/swarm/governance.js`, `src/swarm/safety.js`,
> `src/server/routes-swarm.js`, `src/index.js`, `src/orchestration/index.js`, `src/agents/agent.js`,
> `src/core/autonomy.js`, `config/swarm.json`, `tests/swarm.test.mjs`.
>
> **Status implementacije:** kod swarm-a **postoji i pokriven je testovima** (`tests/swarm.test.mjs`:
> 20 testova ukupno — blackboard, swarm runtime, governance, safety i HTTP rute za swarm, plus
> evolucija i RSI), ali metapodaci projekta još stoje na
> `v0.3.1` (`package.json`, `src/index.js` → `export const VERSION = '0.3.1'`). Ovo je dokument
> **v0.4 nivoa koda**, a ne tvrdnja da je izdanje v0.4 objavljeno.
> `config/swarm.json` upućuje na `docs/29` i `docs/33`; **`docs/33` još ne postoji** — ovo je `docs/29`.

---

## 1. Zašto swarm, a ne više agenata

„Više agenata" i „swarm" nisu isto, iako oba imaju više od jednog izvršioca.

**Centralni orkestrator (ono što projekat već ima).** `src/orchestration/index.js` je jedan ulaz
(`run`) i 11 imena patterna nad 6+ implementacija (`agent`/`react`, `router`, `sequential`,
`orchestrator-worker`, `fanout`, `handoff`, `magentic`, `reflection`, `debate`, `team`). U svakom od
njih **jedan poziv odlučuje ko radi šta**: `orchestrator-worker` prvo pita LLM planer da razbije
zadatak (`maxWorkers: 5`), `fanout` unaprijed dijeli na grane, `handoff` ima lanac predaja sa
maksimumom. Znati ko je sljedeći je *posao orkestratora*, a ne posao izvršioca.

**Swarm (v0.4).** Nema planera koji dodjeljuje. Postoji **tabla** (blackboard) sa otvorenim
zadacima, i svaki worker ima tri lokalna pravila: *uzmi najvrjednije što mogu*, *uradi kroz isti
orchestrator*, *ostavi trag*. Koordinacija nije poruka — koordinacija je **stanje table**:
`blackboard.claim()` u `src/swarm/blackboard.js` i `swarm.tick()` u `src/swarm/swarm.js`.

Razlika u jednoj rečenici: kod orkestratora **raspored je odluka**, kod roja je **raspored posljedica**
toga ko je šta uzeo i kakve je tragove ostavio.

| Pitanje | Centralni orkestrator | Swarm |
|---|---|---|
| Ko odlučuje ko radi zadatak? | orkestrator (planer/LLM ili kod patterna) | worker sam, preko `claim()` |
| Gdje živi plan? | u toku izvršavanja jednog run-a | na tabli, kao red zadataka |
| Šta se dešava kad worker padne? | run pada ili se grana ponavlja | lease ističe, zadatak se vrati u `open` |
| Kako se zna šta je urađeno? | iz `result`/`steps` tog run-a | iz **artefakta** i feromona na tabli |
| Da li je izlaz predvidiv? | DA (isti ulaz → isti raspored) | NE (zavisi od reda uzimanja) |
| Latentnost dodavanja workera | linearna (orkestrator mora znati za njega) | konstanta (worker se sam registruje) |
| Trošak LLM koordinacije | po run-u (planer, sinteza, sudija) | 0 za koordinaciju; trošak je samo rad |
| Specijalizacija | konfigurisana (`config/agents/*.json`) | izmjerena (`specialization()`) |

**Šta swarm dobija:**

1. **Nema uskog grla u koordinatoru.** Nema LLM poziva „podijeli posao"; dodavanje workera ne mijenja
   ni jednu liniju koda (`POST /v1/admin/swarm/workers`).
2. **Otpornost na pad izvršioca.** `claim()` na početku svakog poziva oslobađa istekle lease-ove
   (`task_lease_expired` u `board-YYYY-MM-DD.jsonl`) i vraća zadatak u `open` sa `attempts + 1`.
3. **Specijalizacija bez konfiguracije.** `worker.tags[tag]` raste samo za uspješne završetke, a
   `specialization()` iz toga izvodi „eksperta po tagu". Niko to ne propisuje.
4. **Stigmergija.** Tragovi (`hot`, `problem`, `help`) mijenjaju **prioritet** sljedećeg claim-a.
   To je jedini „feedback" kanal i on je asinhron, a ne komanda.

**Šta swarm gubi (i to je cijena, ne detalj):**

1. **Latencija raste.** Isti zadatak kroz swarm traži najmanje jedan `claim` + `assertCanRun` +
   `orchestrator.run` + `complete` + `pheromone` + `rewards.record` — sve u nizu, po workeru.
   `maxRunsPerTick` se troši **serijski** (`for (const worker of ...)` u `tick()`), ne paralelno.
2. **Trošak je manje predvidiv.** Bez planera nema ni procjene troška unaprijed; kvota je jedina
   brana (`maxCostPerHourUsd`, mjereno kroz `governance.recordCost`).
3. **Predvidivost i reproduktivnost padaju.** Dva workera sa istim vještinama i istim tablama mogu
   uzeti različite zadatke zavisno od reda iteracije `Map`-e i sadržaja feromona u tom trenutku.
   Kada je bitan **tačan** red i **tačan** broj LLM poziva (testovi to tvrde kao ugovor),
   orkestrator je pravi alat.
4. **Nadzor je teži.** Emergentno ponašanje se ne vidi iz jednog `result` objekta. Zato postoji
   `src/swarm/safety.js` sa detektorima (lockstep, koordinisano glasanje, koncentracija, flooding,
   drift od mandata) — to je režijski trošak koji centralni orkestrator ne plaća.

**Kada swarm NIJE pravo rješenje (iskreno):**

- **Kada je posao suštinski sekvencijalan** (jedan dokument → jedno uređivanje → jedna provjera).
  Swarm tu dodaje samo latenciju, a ne propusnost.
- **Kada je važna determinističnost** (revizija, ponovljiv test, ugovoreni broj LLM poziva, „isti ulaz
  → isti izlaz" za klijenta). Onda `sequential`/`orchestrator-worker` sa fiksnim planom.
- **Kada je koordinacija sama po sebi vrijednost** (npr. potreban je jedan koherentan izvještaj sa
  zaključkom) — `team`/`debate` daju sintezu, a swarm daje **artefakte po zadatku** i nikakav
  zajednički zaključak (vidi §11).
- **Kada nema mjerljive vrijednosti zadatka.** Cijeli mehanizam prioriteta počiva na `value`.
  Ako svi zadaci imaju `value: 1`, work stealing je samo „prvi slobodan worker uzme prvi zadatak".
- **Kada nema više od jednog izvršioca.** Swarm sa jednim workerom je skuplji `sequential`.
- **Kada zadatak traži srednji/visok rizik.** `governance.assertCanRun()` **odbija** svaki
  `riskLevel` različit od `low`. Swarm po dizajnu ne radi ništa što traži čovjeka.

---

## 2. Tri sloja

Swarm nije jedan modul nego tri sloja sa jasnom podjelom odgovornosti. Nijedan sloj ne zna za
unutrašnjost drugog: blackboard ne zna za politike, governance ne zna za sadržaj zadataka, safety
gleda **ponašanje** a ne sadržaj.

| Sloj | Fajl | Odgovornost | Ključni izvoz | Stanje |
|---|---|---|---|---|
| **Blackboard** (zajedničko okruženje) | `src/swarm/blackboard.js` | zadaci, feromoni, artefakti; `claim`, `complete`, `pheromone`, `snapshot` | `createBlackboard`, `PHEROMONE_TYPES` | in-memory + append-only JSONL |
| **Governance** (granice) | `src/swarm/governance.js` | izolacioni nivoi, kvote, dozvole, kill switch, izmjene od čovjeka | `createSwarmGovernance`, `ISOLATION_LEVELS`, `DEFAULT_QUOTAS` | perzistira `data/_control/swarm.json` |
| **Safety** (nadzor) | `src/swarm/safety.js` | mediacija poruka, detekcija emergentnih obrazaca, incidenti, karantin | `createSwarmSafety`, `MESSAGE_TYPES`, `DEFAULT_SAFETY`, `entropy` | in-memory; nalazi u `safety.jsonl` |
| **Runtime** (lokalna pravila) | `src/swarm/swarm.js` | registracija workera, `tick()`, `run()`, `vote`, `consensus`, `specialization`, `stats` | `createSwarm` | in-memory `workers`, `roundStats` |
| **Rute** | `src/server/routes-swarm.js` | HTTP pristup svemu gore, sa rolama | `createSwarmRoutes` | montira se u `src/index.js` |

Sastavljanje je u `src/index.js` (§ „v0.4: swarm"): `createBlackboard` → `createSwarmGovernance`
(+ `load()` i seed iz `config.swarm.tenants`) → `createSwarmSafety` → `createSwarm(... orchestrator,
catalog, autonomy, rewards, audit ...)`. Bitno: **swarm ne izvršava ništa sam** — predaje posao
istom `orchestrator.run()` koji koristi i običan HTTP poziv. Time sve politike, budžet, memorija i
audit važe i za roj (ovo je i testirano: swarm runovi ulaze u `rewards`).

---

## 3. Blackboard: tabela, feromoni, artefakti

Tabla ima tri kolekcije (`Map` u `createBlackboard`): `tasks`, `pheromones`, `artifacts`, plus
`history` (posljednjih 5000 zapisa, `history()` vraća zadnjih 200).

### 3.1 Model zadatka (`postTask`)

Polja **tačno** kako ih `postTask({ tenantId, title, payload = {}, value = 1, requiredSkills = [],
createdBy = 'operator', deadline = null, meta = {} })` upisuje:

| Polje | Tip / default | Značenje |
|---|---|---|
| `id` | `uid('task')` | identifikator zadatka |
| `tenantId` | obavezno preko poziva | izolacija |
| `title` | obavezno (`ValidationError` ako nema) | i **izvor taga** ako nema `payload.tag` |
| `payload` | `{}` | ulaz: `payload.input` ide u agenta, `payload.tag` u specijalizaciju |
| `value` | `Number(value)`, default `1` | osnovna vrijednost; ulaz u skor claim-a |
| `requiredSkills` | `[]` | filter: worker mora imati **sve** navedene vještine |
| `createdBy` | `'operator'` (ruta šalje `auth.keyId`) | ko je otvorio zadatak |
| `deadline` | `null` | **zapisuje se, ali se ne provjerava** (nema roka u `claim`) |
| `meta` | `{}` | `meta.agentId` (koji agent radi), `meta.pattern`, `meta.riskLevel`, `meta.tag` |
| `state` | `'open'` | `open` → `claimed` → `done` / nazad u `open` |
| `claimedBy` | `null` | workerId držaoca lease-a |
| `leaseUntil` | `null` | `iso(now + defaultLeaseMs)`, default `60_000 ms` |
| `attempts` | `0` | raste pri svakom uspješnom claim-u |
| `createdAt`, `updatedAt` | `iso()` | vrijeme |

Svaki `postTask` ide u `board-<YYYY-MM-DD>.jsonl` kao `task_posted` i diže metriku
`swarm_tasks_posted_total`.

### 3.2 Feromoni

`PHEROMONE_TYPES = ['hot', 'done', 'problem', 'opportunity', 'help', 'blocked']`.

Zapis feromona: `{ id: uid('ph'), ts, tenantId, type, taskId, by, strength, ttlMs, halfLifeMs, payload }`.
`pheromone()` **baca `ValidationError`** za nepoznat tip (lista je zatvorena, nema „custom" feromona).

Opadanje je eksponencijalno, polovina za `halfLifeMs`:

```
decayedStrength(p, now) = p.strength * 0.5 ^ (age / (p.halfLifeMs ?? halfLifeMs))
```

- **`halfLifeMs`**: default na nivou blackboard-a `300_000` (5 min); može se zadati po feromonu.
- **`ttlMs`**: default `3_600_000` (1 h) u `pheromone()`, ali **`complete()` i `vote()` šalju svoje**:
  `done`/`problem` bez `ttlMs` (dakle 1 h), `help` `120_000`, `opportunity` (glas) `60_000`.
- **Brisanje**: `activePheromones()` briše feromon ako je `now - ts > (ttlMs ?? 3_600_000)` **ili**
  ako je opadajuća jačina `< 0.001`. Dodatno, izlaz se filtrira po `minStrength` (default `0.01`),
  pa feromon može biti „živ" u mapi, ali se ne vraća kroz API.
- Rezultat je sortiran opadajuće po `currentStrength`; polje se vraća i kao `strength` i kao
  `currentStrength` (isto, radi kompatibilnosti).

### 3.3 Artefakti

`complete(taskId, { workerId, result, success, tenantId })`:

- `success: true` → `state = 'done'`, `claimedBy/leaseUntil = null`, artefakt `{ taskId, workerId,
  success, result, ts }` u `artifacts` (jedan artefakt po zadatku — **prepisuje se** kod ponovnog
  završetka), feromon `done` jačine `1`.
- `success: false` → `state = 'open'` (zadatak se **vraća na tablu**), feromon `problem` jačine `1.5`.
- Artefakt je **jedini kanal** kojim drugi worker vidi šta je urađeno. Nema direktne poruke
  agent→agent kroz blackboard.

### 3.4 Tok (ASCII)

```
  operator / ruta                BLACKBOARD (tabla)                    worker (swarm.tick)
  ─────────────────              ──────────────────                    ────────────────────
  POST /v1/admin/swarm/tasks
        │ postTask()
        ├──────────────►  tasks: [ open, value=5, skills=[support] ]
        │                        │
        │                        │   ◄──── claim(workerId, {skills}) ────┐
        │                        │        (oslobodi istekle lease-ove)   │
        │                        │        score = value + boost()        │
        │                        ├──────► state=claimed, leaseUntil=+60s ─┘
        │                        │
        │                        │        assertCanRun(governance)
        │                        │        orchestrator.run(...)  ──► agent (LLM + alati + memorija)
        │                        │                                          │
        │                        │   ◄──── complete(taskId, result) ────────┘
        │                        ├──────► artifacts[taskId] = {...}
        │                        │        pheromone: done (1.0) | problem (1.5)
        │                        │        rewards.record(runId, signals)
        │                        │
        │                        │        (ako claim vrati null)
        │                        │   ◄──── pheromone: help (0.4, ttl 120s)
        │                        │
        │        GET /v1/admin/swarm/board  ──► snapshot: open/claimed/done + aktivni feromoni
        │        GET /v1/admin/swarm/pheromones ──► activePheromones(now, {type, minStrength})
```

---

## 4. Work stealing

Algoritam je u `blackboard.claim(workerId, { tenantId, skills = [], now = Date.now(), maxValue = null })`.
Nema reda čekanja, nema dodjele odozgo — **svaki worker pita tablu i uzima najbolje što može**.

Redoslijed koraka (stvarni kod):

1. **Oslobađanje isteklih lease-ova.** Prolaz kroz **sve** zadatke: ako je `state === 'claimed'` i
   `leaseUntil < now` → `state = 'open'`, `claimedBy = null`, `leaseUntil = null`, zapis
   `task_lease_expired`. Ovo radi **svaki** claim, za sve tenante (upis u log je uz `tenantId`
   pozivaoca).
2. **Feromoni u ovom trenutku.** `activePheromones(now, { tenantId })`.
3. **Filtri kandidata:** `tenantId` se poklapa · `state === 'open'` · worker ima **sve**
   `requiredSkills` (`every`) · ako je `maxValue` zadat, `value <= maxValue`.
4. **Skor:** `score = value + boost(taskId) + (attempts > 0 ? 0.2 : 0)`.
5. **Sortiranje:** opadajuće po `score`, pa **rastuće** po `createdAt` (stariji zadatak pobjeđuje
   kod izjednačenja).
6. **Prvi kandidat** → `state = 'claimed'`, `claimedBy = workerId`, `leaseUntil = iso(now + 60s)`,
   `attempts += 1`, metrika `swarm_task_claims_total`, log `task_claimed` sa `score` (3 decimale).
   Ako nema kandidata → `null` (i worker tada ostavlja `help` trag, vidi §7).

### 4.1 Efektivna vrijednost

`boost(taskId)` sabira **opadajuće** jačine feromona vezanih za taj zadatak:

```
boost = hot*2 + help − bad*1.5        gdje je bad = problem + blocked
```

| Feromon | Množilac | Efekat |
|---|---|---|
| `hot` | `× 2` | **podiže** prioritet (neko je označio da je ovo vruće) |
| `help` | `× 1` | blago podiže (neko je tražio posao oko ovog zadatka) |
| `problem` | `× 1.5` (oduzima) | **spušta** prioritet (zadatak je pucao) |
| `blocked` | `× 1.5` (oduzima) | isto; tip postoji u `PHEROMONE_TYPES`, ali **`complete()` emituje `problem`**, ne `blocked` |
| `done`, `opportunity` | `0` | ne utiču na skor claim-a |

### 4.2 Zašto nema dodjeljivanja odozgo

- **Nema globalnog znanja.** Tabla ne zna koliko worker ima snage, ni koliko je koji put potrošio.
  Dodjela bi tražila upravo to znanje — dakle centralni koordinator i njegovo usko grlo.
- **Nema pregovora.** Worker ne traži dozvolu; on **uzima**. Sukob je riješen na tabli (prvi claim
  mijenja `state`), a ne dogovorom.
- **Neuspjeh nije izuzetak.** Ako worker padne, lease istekne i zadatak se sam vrati — sistem ne
  mora znati da je worker pao.
- **Prioritet je lokalna procjena.** `claim` ne zna „zašto" je nešto `hot`; samo vidi trag i
  pridružuje mu težinu. To je definicija stigmergije (§5).

### 4.3 Primjer sa brojevima

Tabla (tenant `nmq`), `halfLifeMs = 300_000`, `now = T`:

| Zadatak | `value` | Feromon (tip, `strength`, starost) | Opadajuća jačina | `boost` | `score` |
|---|---|---|---|---|---|
| A | 5 | `hot`, 2.0, stara 300 s | `2 × 0.5¹ = 1.0` | `1.0 × 2 = 2.0` | **7.0** |
| B | 5 | `hot`, 0.5, stara 60 s | `0.5 × 0.5^0.2 ≈ 0.435` | `≈ 0.87` | **5.87** |
| C | 6 | `problem`, 4.0, stara 120 s (half-life 60 s) | `4 × 0.5² = 1.0` | `1.0 × 1.5 = 1.5` | **4.5** |

- Prvi `claim(w1, { skills: ['general'] })` → **A** (7.0).
- Drugi `claim(w2, ...)` → **B** (5.87). C ima veći `value` (6), ali ga `problem` trag obara ispod B.
- Treći `claim(w3, ...)` → **C** (4.5).
- Četvrti → `null`: nema više `open` zadataka, pa `w3` ostavlja `help` feromon jačine `0.4`
  (`ttlMs: 120_000`).

Kada isti zadatak padne, `complete(success: false)` ga vrati u `open` i `attempts` je već ≥ 1, pa
sljedeći claim ima `+0.2` — mali „drugi pokušaj" bonus da zadatak ne ostane zauvijek na dnu.

**Napomena o vještinama:** filter je `every`, ne `some`. Worker sa `skills: ['support','general']`
**ne može** uzeti zadatak koji traži `['support','legal']`. U `registerWorker` se vještine defaultuju
na `[spec.domain, agentId]` ako nisu zadate — pa „prazan" worker ipak ima dvije vještine i ne vidi
zadatke van svog domena.

---

## 5. Stigmergija u praksi

Stigmergija = **trag u okruženju mijenja ponašanje drugih**, bez poruke i bez komande. U ovom kodu
to je bukvalno jedna funkcija: `boost()` u `claim()`. Nijedan worker ne zna ime drugog workera,
nijedan ne zna šta je drugi radio — ali svi vide tablu.

Kako trag nastaje i kako se troši, u tri poteza:

1. Worker ostavi trag (`blackboard.pheromone` ili automatski iz `complete()` / `vote()` / idle poteza).
2. Trag **opada** (`decayedStrength`) i na kraju se **briše** (`ttlMs` ili jačina < 0.001).
3. Sljedeći `claim` doda `boost` u skor i time promijeni **redoslijed** uzimanja — ne zabranjuje i
   ne naređuje ništa.

| Tip feromona | Ko ga ostavlja | Kako utiče | TTL |
|---|---|---|---|
| `hot` | čovjek/ruta (`POST /v1/admin/swarm/pheromone`) ili drugi worker | `+2 × jačina` na skor zadatka → zadatak ide ranije | default 1 h (`ttlMs` nije poslan) |
| `done` | `complete(success: true)` automatski | skor `0`; **signal** drugima (i safety detektorima) da je posao završen | 1 h |
| `problem` | `complete(success: false)` automatski, jačina `1.5` | `−1.5 × jačina` → zadatak pada u prioritetu | 1 h |
| `blocked` | **niko u kodu** (tip dozvoljen, ali `complete()` emituje `problem`) | računa se u `bad` **ako** ga neko ostavi ručno preko rute | 1 h kad se ostavi |
| `opportunity` | `swarm.vote()` automatski, jačina `0.3` | skor `0`; nosi `payload: { proposalId, choice, rationale }` — vidljiv trag o glasanju | `60_000` |
| `help` | `swarm.tick()` kad `claim` vrati `null`, jačina `0.4` | `+1 × jačina` (mali) i **informacija**: `payload.skills` kaže koje vještine taj worker ima | `120_000` |

Ono što stigmergija **jeste** ovdje: promjena **prioriteta** i **vidljivost stanja**.
Ono što **nije**: nema putanja, nema mreže susjedstva, nema lokalnog širenja na susjede — svi vide
**cijelu** tablu (vidi §11).

---

## 6. Emergentna specijalizacija

Specijalizacija **nije** polje u konfiguraciji. Nema `config/swarm.json` unosa tipa „support radi
support". Ona je **mjerenje** nastalo iz stvarnih završetaka.

Kako nastaje, korak po korak:

1. `tick()` izračuna tag zadatka: `tagOf(task) = task.payload.tag ?? task.meta.tag ?? prva riječ
   naslova, malim slovima`. (Zato je `payload.tag` preporučen; bez njega tag može biti „kako" ili
   „ticket" — što je grubo, vidi §11.)
2. Ako je run uspio, `worker.tags[tag] = (worker.tags[tag] ?? 0) + 1`. **Neuspjeh ne povećava tag**
   (`+ (ok ? 1 : 0)`).
3. `specialization(tenantId)` grupiše radnike po tagu i za svaki tag vraća:
   `{ expert: { workerId, name, agentId, completed }, share, workers }`, gdje je `expert` onaj sa
   najviše završetaka, a `share = expert.completed / ukupno za taj tag` (2 decimale).

Primjer izlaza `GET /v1/admin/swarm/specialization` (oblik je iz koda; brojevi su ilustracija
jednog tick-a, ne izmjerena vrijednost projekta):

```json
{
  "tenantId": "nmq",
  "specialization": {
    "support": { "expert": { "workerId": "wrk_a1", "name": "support#1", "agentId": "support", "completed": 2 },
                 "share": 1, "workers": 1 },
    "sales":   { "expert": { "workerId": "wrk_b2", "name": "sales#2", "agentId": "sales", "completed": 1 },
                 "share": 1, "workers": 1 }
  },
  "note": "Specijalizacija NIJE konfigurisana — mjeri se iz stvarno završenih zadataka."
}
```

Uz to, `stats()` vraća `workers`, `quarantined`, `claims`, `completed`, `failed`, `costUsd`,
`board: { open, claimed, done, pheromones }`, `isolation` i `rounds`.

**Upozorenje (i pravilo):** specijalizacija se **mjeri, ne proglašava**. Izlaz je opis onoga što se
stvarno desilo, u ovom procesu, od ovog starta:

- `share` uz `workers: 1` ne znači ništa (jedan worker je uvijek 100%).
- Prag „ekspert" ne postoji: `completed: 1` protiv `completed: 0` već daje eksperta.
- Brojači žive **samo u memoriji** (`workers` je `Map` u `createSwarm`) — restart ih briše.
- Tag je grub ključ (prva riječ naslova ako nema `payload.tag`).

Ako se na osnovu ovoga donosi odluka (npr. „support worker uvijek radi tickete"), to je **odluka
čovjeka**, ne automatska posljedica roja. Kod nema nikakav automatski mehanizam koji „zaključava"
workera za tag.

---

## 7. Lokalna pravila workera

Worker nema plan. Ima **jedan otkucaj** i lokalna pravila. `swarm.tick(tenantId, { maxRuns, now })`:

```
limit = maxRuns ?? governance.quotas.maxRunsPerTick (default 8)
isolation = governance.isolationOf(tenantId)
  └─ ako je 'locked' ili 'frozen' → return { ran: 0, skipped: 'isolation' }   // fail-closed, ne dira se tabla

for worker of listWorkers(tenantId):
    if ran >= limit: break
    if safety.isQuarantined(worker.id):
        results.push({ workerId, skipped: 'quarantined' }); continue
    perWorker = min(worker.maxRunsPerTick, limit - ran)      // default maxRunsPerTick = 1
    za svaki od perWorker pokušaja:
        task = blackboard.claim(worker.id, { tenantId, skills: worker.skills, now })
        ako nema task-a:
            governance.assertCanPheromone(...)              // kvota; greška se guta
            blackboard.pheromone({ type: 'help', by: worker.id, strength: 0.4, ttlMs: 120_000,
                                   payload: { skills: worker.skills } })
            results.push({ workerId, taskId: null, idle: true }); break
        worker.claims += 1
        safety.observeClaim({ tenantId, workerId, taskId, at: now })
        ran += 1
        agentId = task.meta.agentId ?? worker.agentId
        input   = task.payload.input ?? task.title
        try:
            governance.assertCanRun({ tenantId, workerId, riskLevel: task.meta.riskLevel ?? 'low', task })
            result = orchestrator.run({ tenantId, agentId, pattern: task.meta.pattern, input,
                                        userId: `swarm:${worker.id}`,
                                        sessionId: `swarm:${tenantId}:${tagOf(task)}` })
            ok = result.status === 'ok'
            blackboard.complete(task.id, { workerId, success: ok,
                                           result: { output: String(result.output).slice(0, 2000),
                                                     runId: result.runId, status: result.status },
                                           tenantId })
            governance.recordCost(tenantId, { amountUsd: result.costUsd ?? 0, workerId })
            worker.costUsd += result.costUsd ?? 0
            worker.completed += ok ? 1 : 0 ; worker.failed += ok ? 0 : 1
            worker.tags[tagOf(task)] += ok ? 1 : 0
            rewards.record(tenantId, { runId, agentId, pattern,
                                       signals: { outcome, costUsd, durationMs, feedback } })
        catch err:
            blackboard.complete(task.id, { workerId, success: false, result: { error, code }, tenantId })
            worker.failed += 1
            log warn ('swarm.task_failed') osim kad je PolicyError
```

Ključne posljedice ovog reda:

1. **Redoslijed je obavezan:** `claim` → `safety.observeClaim` → `governance.assertCanRun` →
   `orchestrator.run` → `complete` → `recordCost` → `rewards.record`. Ako `assertCanRun` padne,
   **`complete(success: false)` se ipak izvrši** (u `catch`), pa zadatak ostaje na tabli sa
   `problem` tragom — to je namjerno: politika ne smije „pojesti" zadatak.
2. **Kvota je već potrošena pri odbijanju.** `assertCanPheromone` i `allowRate('claims', ...)` broje
   **poziv**, ne ishod. Zato `maxClaimsPerWorkerPerMin` u praksi ograničava *pokušaje*, a ne samo
   uspješna preuzimanja.
3. **Sesija je po tagu**, ne po zadatku: `sessionId = swarm:<tenantId>:<tag>`. Dva zadatka istog taga
   dijele memorijsku sesiju — to je namjerno (kontekst „support" razgovora se nastavlja), ali znači
   i da istorija raste po tagu.
4. **Kad nema posla**, worker ne stoji tiho: ostavlja `help` trag sa svojim vještinama. To drugi
   (i čovjek kroz `GET /v1/admin/swarm/pheromones?type=help`) vide kao „imam slobodne ruke".
   Ako je kvota feromona prekoračena, greška se **guta** (`catch {}`) i tick se nastavlja.
5. **`maxRunsPerTick` je serijski po workeru.** Petlja je `for ... await` — nema paralelizma.
   `maxRuns` je **gornja granica za rundu**, a `maxRunsPerTick` za pojedinog workera.

`swarm.run(tenantId, { rounds, maxRuns, detectEvery })` je tanka petlja oko `tick()`: poslije svake
`detectEvery`-te runde zove `safety.detect()`, upisuje nalaze u rundu i **prekida** ako je izolacija
postala `frozen` (`swarm.frozen_during_run`). Na kraju upisuje **jedan** audit zapis
`action: 'swarm_run'` sa ukupnim `ran`.

---

## 8. Kolektivno odlučivanje

Glasanje postoji (`vote()`, `consensus()`), ali je njegova uloga **savjetodavna** i to je u kodu
zapisano kao poruka, a ne kao moć:

```js
note: 'Glasanje je savjetodavno — izvršne odluke iznad niskog rizika i dalje traže čovjeka (board).'
```

`swarm.vote(tenantId, { proposalId, workerId, choice, rationale })`:

1. `ValidationError` ako nema `proposalId`/`workerId`/`choice`, ili ako worker nije registrovan.
2. `PolicyError` ako je worker u karantinu (`safety.isQuarantined`).
3. `safety.observeVote(...)` — glas ulazi u evidenciju koju detektori analiziraju.
4. Feromon `opportunity` (jačina `0.3`, `ttlMs: 60_000`) sa `payload: { proposalId, choice, rationale }`
   — glas je **trag na tabli**, ne poruka.
5. Vraća `consensus(tenantId, proposalId)`.

`consensus` računa iz `safety.votes` filtriranih po `proposalId` **i** `tenantId`:
`tally`, `votes` (ukupno), `winner` (samo ako je `top/total > 0.5`), `unanimous` (`>0` glasova i
tačno jedna opcija), `participation`, `note`. **Pluralitet nije pobjeda** — 40% : 35% : 25% daje
`winner: null`.

Ovo nije „AI parlament": nijedan ishod glasanja ne mijenja ni izolaciju, ni kvote, ni zadatke.
Glas je ulaz za čovjeka i za detektore (koordinisano glasanje je **nalaz**, vidi §2 safety).

| Odluka | Ko odlučuje | Gdje je u kodu |
|---|---|---|
| Koji zadatak se radi sljedeći | **worker sam** (lokalno pravilo + tragovi) | `blackboard.claim()` → `boost()` |
| Koliko se smije izvršiti u rundi | **governance** (kvota `maxRunsPerTick`) | `swarm.tick()` + `DEFAULT_QUOTAS` |
| Smije li se izvršiti zadatak (rizik, izolacija, kvote, autonomija) | **governance** (fail-closed) | `governance.assertCanRun()` |
| Da li worker smije ostaviti trag / poslati peer poruku | **governance** (kvote, izolacija) | `assertCanPheromone()`, `assertCanPeerMessage()` |
| Da li je poruka dozvoljena | **safety** (tip, sadržaj, entropija) | `safety.mediateMessage()` |
| Ide li worker u karantin | **safety** (auto ili čovjek) | `openIncident({ autoAction: { type: 'quarantine' } })`, `quarantine()` |
| Prelazak u `locked`/`frozen` i nazad | **čovjek** (rola `owner`) | `governance.setIsolation()`, `freeze()`, `unfreeze()` |
| Izmjena kvota | **čovjek** (rola `owner`) | `governance.setQuotas()` |
| Šta znači glasanje (mišljenje roja) | **savjetodavno** — ne izvršava ništa | `swarm.vote()` → `consensus()` |
| Visok rizik / novac / pravno / brisanje | **čovjek, uvijek** | `swarm` odbija sve osim `low`; `autonomy.HUMAN_ONLY` |

---

## 9. Tok jednog zadatka (dijagram)

```
 ČOVJEK / OPERATER                     RUTE (routes-swarm.js)            SWARM RUNTIME
 ──────────────────                    ──────────────────────            ─────────────
 1. POST /v1/admin/swarm/workers ────► requiredRole: admin
    { agents:[{agentId:'support',          swarm.registerWorker()
      skills:['support','general']}] }     ├─ catalog.has(agentId)?   (NotFoundError ako ne)
                                           ├─ skills default [domain, agentId]
                                           └─ metrics swarm_workers_total

 2. POST /v1/admin/swarm/tasks ──────► requiredRole: run
    { tasks:[{title:'Ticket 1',            blackboard.postTask()  ──► board-YYYY-MM-DD.jsonl
      payload:{input:'...', tag:'support'},                          ('task_posted')
      requiredSkills:['support'], value:2}] }                       metrics swarm_tasks_posted_total

 3. POST /v1/admin/swarm/run ────────► requiredRole: admin
    { rounds:1, detectEvery:1 }            swarm.run()
                                            └─ swarm.tick()
                                                ├─ isolation check (locked/frozen → skip)
                                                ├─ po workeru: safety.isQuarantined?
                                                ├─ blackboard.claim() ──► 'task_claimed'
                                                ├─ safety.observeClaim()  (za detektore)
                                                ├─ governance.assertCanRun()
                                                │     ├─ rizik != low → PolicyError
                                                │     ├─ rate limit claims/min → PolicyError
                                                │     ├─ satni trošak → PolicyError
                                                │     └─ autonomy.evaluate({kind:'act'})
                                                ├─ orchestrator.run()  ──► agent (LLM+alati+memorija)
                                                │        ↑ isti put kao običan HTTP run:
                                                │          tracer.startRun → budget → politike → PII
                                                ├─ blackboard.complete() ──► artefacts + feromon
                                                │        ('task_completed', 'done' | 'problem')
                                                ├─ governance.recordCost()
                                                └─ rewards.record(runId, signals)  ──► reward model
                                            └─ safety.detect() ──► findings (lockstep/votes/
                                                 concentration/flooding/drift) → incident?
                                            └─ audit.append({ action:'swarm_run', ... })

 4. GET /v1/admin/swarm ─────────────► requiredRole: read
    stats + safety.report + history(last 10 rundi)
```

Nakon ovoga stanje je vidljivo na tri mjesta: `GET /v1/admin/swarm/board` (tabla),
`GET /v1/admin/swarm/specialization` (mjereni tagovi) i audit/hash-lanac (`swarm_run`,
`swarm_isolation_set`, `swarm_freeze`, `swarm_quotas_set`, `swarm_incident`).

---

## 10. Rute i kako se pokreće

Sve rute su u `src/server/routes-swarm.js` i montiraju se u `src/index.js` preko
`createSwarmRoutes`. Rola se provjerava u `src/server/http.js` (`tenants.assertCan(auth.role,
route.requiredRole)`); rola dolazi iz API ključa ili per-agent ključa (`nmqa_…` — `http.js` prvo zove
`controlPlane.authenticateAgentKey`, sekcija „1) per-agent (service account) ključ").
`ROLES` (`src/tenancy/store.js`): `owner: ['*']`, `admin: [run, read, write, approve, manage-kb]`,
`operator: [run, read, approve]`, `agent: [run, read]`, `viewer: [read]`.
Posljedica za roj: per-agent ključ ima rolu `agent`, dakle **ne može** mijenjati granice roja —
`tests/swarm.test.mjs` to dokazuje (`POST /v1/admin/swarm/freeze` sa `nmqa_…` ključem → `403`).

| Metoda | Ruta | Rola | Šta radi |
|---|---|---|---|
| GET | `/v1/admin/swarm` | `read` | `stats()` + `safety.report()` + zadnjih 10 rundi |
| POST | `/v1/admin/swarm/workers` | `admin` | registracija workera (`agentId`/`agents`, `skills`, `maxRunsPerTick`) |
| POST | `/v1/admin/swarm/tasks` | `run` | otvaranje zadatka/zadataka (`tasks` ili jedan sa `title`) |
| POST | `/v1/admin/swarm/tick` | `admin` | jedan otkucaj (`maxRuns`) |
| POST | `/v1/admin/swarm/run` | `admin` | više rundi (`rounds`, `maxRuns`, `detectEvery`) + audit |
| GET | `/v1/admin/swarm/board` | `read` | `snapshot()`: open/claimed/done + aktivni feromoni |
| GET | `/v1/admin/swarm/pheromones` | `read` | aktivni feromoni (`type`, `minStrength`) + lista tipova |
| POST | `/v1/admin/swarm/pheromone` | `run` | ručno ostavljanje traga (uz `assertCanPheromone`) |
| GET | `/v1/admin/swarm/specialization` | `read` | mjereni „eksperti po tagu" |
| POST | `/v1/admin/swarm/vote` | `run` | glas workera (savjetodavno) |
| GET | `/v1/admin/swarm/consensus/:proposalId` | `read` | tally/winner/unanimous |
| GET | `/v1/admin/swarm/governance` | `read` | izolacija + kvote + `frozenReason` |
| POST | `/v1/admin/swarm/governance/isolation` | `owner` | promjena nivoa (audit) |
| POST | `/v1/admin/swarm/governance/quotas` | `owner` | promjena kvota (audit) |
| POST | `/v1/admin/swarm/freeze` | `owner` | kill switch za tenant (audit, `decision: deny`) |
| POST | `/v1/admin/swarm/unfreeze` | `owner` | odmrzavanje na nivo (default `contained`) |
| GET | `/v1/admin/swarm/safety` | `read` | nalazi po tipu/težini, incidenti, karantin |
| POST | `/v1/admin/swarm/safety/detect` | `admin` | ručno pokretanje detektora |
| GET | `/v1/admin/swarm/incidents` | `read` | incidenti (`status` default `open`) |
| POST | `/v1/admin/swarm/incidents/:id/resolve` | `admin` | zatvaranje incidenta (audit) |
| POST | `/v1/admin/swarm/quarantine` | `admin` | karantin workera |
| POST | `/v1/admin/swarm/quarantine/:workerId/release` | `admin` | izlazak iz karantina |
| POST | `/v1/admin/swarm/message` | `run` | **jedini** kanal peer komunikacije (kroz `safety.mediateMessage`) |

**Kako se pokreće (redoslijed je obavezan):**

```bash
# 1) workeri (admin) — registracija prije svega ostalog
curl -X POST localhost:8787/v1/admin/swarm/workers -H 'x-tenant: nmq' \
  -d '{"agents":[{"agentId":"support","skills":["support","general"]},{"agentId":"sales","skills":["sales","general"]}]}'
# 2) zadaci (run) — payload.tag je ono što ulazi u specijalizaciju
curl -X POST localhost:8787/v1/admin/swarm/tasks -H 'x-tenant: nmq' \
  -d '{"tasks":[{"title":"Ticket 1","payload":{"input":"Kako da resetujem lozinku?","tag":"support"},"requiredSkills":["support"],"value":2}]}'
# 3) rundi (admin) — tick/run bez workera baca ValidationError
curl -X POST localhost:8787/v1/admin/swarm/run -H 'x-tenant: nmq' -d '{"rounds":2,"detectEvery":1}'
# 4) pogled — tabla, specijalizacija, governance
curl localhost:8787/v1/admin/swarm -H 'x-tenant: nmq'
curl localhost:8787/v1/admin/swarm/specialization -H 'x-tenant: nmq'
```

Testna verzija istog toka je u `tests/swarm.test.mjs` (uključujući dokaz da **agent ključ** ne
smije zvati `/v1/admin/swarm/freeze` → `403`).

---

## 11. Ograničenja (iskreno)

Ovo nije lista „planirano", ovo je lista onoga što **kod danas ne radi**, iako možda izgleda da radi.

1. **Sve je in-process i single-node.** `tasks`, `pheromones`, `artifacts`, `workers`, `roundStats`,
   `rateWindows`, `claims`, `votes`, `incidents`, `quarantined` su `Map`/nizovi u **jednom** Node
   procesu. Nema distributed lock-a, nema cross-node claim-a, nema Redis/Postgres reda.
   Dvije replike bi imale **dvije različite table** i dva različita skupa workera — i dvije bi mogle
   izvršiti isti zadatak. (Slično ograničenje projekta je već zapisano kao D22 za fajl-lease.)
2. **Trajnost je samo audit, ne stanje.** Blackboard upisuje `board-<datum>.jsonl`, safety
   `safety.jsonl`, governance `data/_control/swarm.json` — ali **feromoni se ne rekonstruišu** iz
   loga pri startu. Poslije restarta: nema feromona, nema brojača `tags`/`claims`/`costUsd`, nema
   karantina, nema incidenata. Preživljava **samo** izolacija/freeze (`governance.load()`).
3. **`maxRunsPerTick` je serijski po workeru.** `tick()` je `for ... await` petlja. Nema
   `Promise.all`, nema semafora kao u `fanout.js`. „Paralelni" roj je zapravo sekvenca; propusnost
   raste sa brojem workera, ali latentnost jednog zadatka ne pada.
4. **Nema topologije mreže.** Ne postoje susjedstva, ni lokalno širenje traga. `activePheromones()`
   vraća **sve** feromone tenanta, pa svaki worker „vidi" cijelu tablu odjednom. To znači da nema
   prostornog usporavanja informacije — a upravo ono kod pravih swarm sistema sprečava globalne
   oscilacije.
5. **Kvote postoje, ali se ne primjenjuju sve.** U `DEFAULT_QUOTAS` stoje `maxWorkers: 12` i
   `maxTasksOpen: 200`, ali ih **nijedan kod ne provjerava**: `registerWorker()` ne broji workere, a
   `postTask()` ne broji otvorene zadatke. Stvarno se primjenjuju: `maxRunsPerTick` (u `tick()`),
   `maxClaimsPerWorkerPerMin`, `maxCostPerHourUsd`, `maxPheromonesPerMin`, `maxPeerMessagesPerMin`.
   `safety.DEFAULT_SAFETY.voteCollusionRounds: 3` se **ne koristi** u detekciji.
   `governance.canUseNetwork(tenantId)` postoji kao funkcija, ali je **niko ne zove** — komentar u
   `src/index.js` tvrdi da se mreža zaključava kad je izolacija `contained`, a ta veza **nije
   uspostavljena** (nema poziva u `sandbox` putanji).
6. **Nema QoS / prioriteta po tipu zadatka.** Postoji samo `value` + feromoni. Nema rezervacije
   kapaciteta za hitne zadatke, nema rokova (`deadline` se čuva, ali se ne provjerava u `claim`),
   nema starvation zaštite (zadatak sa trajno lošim `boost`-om može čekati beskonačno).
7. **Mjerenje specijalizacije je grubo.** `tag = payload.tag ?? meta.tag ?? prva riječ naslova
   (lowercase)`. Bez `payload.tag` naslov „Kako da resetujem lozinku?" daje tag `kako`. Nema
   normalizacije, nema sinonima, nema minimuma uzoraka, a brojači ne preživljavaju restart.
8. **`worker.tags` broji samo uspjehe**, pa neuspjesi ne postoje u specijalizaciji — worker koji je
   20 puta pao na `support` izgleda isto kao worker koji taj tag nikad nije ni vidio.
9. **`reset()` na blackboard-u briše i artefakte po `a.taskId`** (uslov u petlji je uvijek istinit
   za artefakt), pa je brisanje artefakata šire od brisanja zadataka. Radi se o „očisti tablu poslije
   incidenta" funkciji koja nije izložena nijednom rutom.
10. **Nema izvršnog kolektivnog odlučivanja.** `consensus()` vraća samo brojeve; nijedna ruta ne
    pretvara `winner` u akciju. Sve iznad niskog rizika ide čovjeku (`autonomy.HUMAN_ONLY`,
    `assertCanRun` odbija `medium`/`high`).
11. **Metapodaci izdanja nisu ažurirani.** `package.json` i `VERSION` su `0.3.1` iako swarm kod
    postoji; `docs/33` (na koji upućuju `config/swarm.json` i `src/rsi/meta.js`) ne postoji.
12. **Rate-limit prozori nisu dijeljeni između tenanta i governance-a.** `governance` drži svoje
    `rateWindows` (in-memory, klizeći prozor od 60 s za claims/feromone/peer i 1 h za trošak), a
    HTTP sloj ima **svoj** rate limit po tenantu (`tenants.rateLimit`). Dva različita brojača nad
    istim resursom — kad se jedan promijeni, drugi ne zna.

---

## 12. Šta je sljedeće

Redoslijed je po **riziku**, ne po ljepoti.

**(a) Redis/Postgres queue za cross-node claim.** Prvo `claim` treba atomsku operaciju
(`SELECT ... FOR UPDATE SKIP LOCKED` ili Redis `SET NX PX` nad `taskId`), pa onda `leaseUntil` u
bazi umjesto u `Map`. Bez ovoga swarm ostaje jedna replika. Uz to: idempotentni `complete` (danas
`artifacts.set` prepisuje artefakt) i tenant-scoped ključevi.

**(b) Feromoni u shared store sa TTL.** Feromon je idealan za Redis: `SET ph:<id> ... PX ttlMs`,
opadanje se računa u aplikaciji (`decayedStrength` se ne mijenja), a `activePheromones` čita iz
store-a sa `minStrength` filterom. Time feromoni preživljavaju restart — što je danas nemoguće
(samo se loguju).

**(c) Topologija (susedi + lokalno širenje).** `worker.neighbors` ili „vidno polje" po tagu/regiji,
pa `activePheromones` filtrira po susjedstvu umjesto da vraća sve. Cilj: informacija se širi lokalno,
a ne globalno — to je razlika između „svi vide sve" i pravog swarm ponašanja.

**(d) Kvote po tipu zadatka.** Proširiti `DEFAULT_QUOTAS` na `perTag`/`perKind` (npr. najviše N
`finance` zadataka u minuti, rezervisan kapacitet za `support`) i **uvesti provjeru `maxWorkers` i
`maxTasksOpen`**, koje danas postoje kao brojevi bez primjene.

**(e) Dashboard za tablu.** `GET /v1/admin/swarm/board` već vraća sve što treba (open/claimed/done,
aktivni feromoni sa `currentStrength`, `specialization`, incidenti). Treba samo view: tabela zadataka,
lista feromona sa opadanjem, brojači po workeru, dugmad `freeze`/`unfreeze` i kvota (role `owner`).

Uz to, kao preduslov za sve gore: **vratiti `docs/33`** (RSI/evolucija, na koji kod već upućuje),
uskladiti `VERSION`/`package.json` sa stvarnim stanjem koda i dodati testove za neimplementirane
kvote (da se „mrtva" kvota ne može ponovo tiho pojaviti).

---

## Otvorena pitanja

1. **Ko je vlasnik `value`?** Ako `value` zadaje čovjek, roj radi prioritizaciju koju je čovjek
   propisao; ako ga izvodi sistem (npr. iz cilja ili reward-a), roj počinje sam da rangira posao.
   Danas `value` dolazi iz `postTask()` preko rute — ko ga smije mijenjati i po kom osnovu?
2. **Šta tačno znači `share` u `specialization()` kao odluka?** Je li dozvoljeno da se na osnovu
   izmjerenog `expert`-a **mjenja** `skills` workera (čime mjerenje postaje uzrok), ili
   specijalizacija ostaje isključivo izvještaj čovjeku?
3. **Koliko dugo smije trajati lease?** `defaultLeaseMs = 60_000` je konstanta u blackboard-u, a
   `maxWallMs` u politici je `180_000`. Zadatak može trajati duže od lease-a; tada drugi worker
   legalno preuzme isti posao. Da li lease treba produžavati (heartbeat) i ko to plaća u trošku?
4. **Da li glasanje ikada smije biti obavezujuće?** Trenutno je `note` u kodu jasan: savjetodavno.
   Ako se ikada veže na akciju, koja je granica — samo `low` rizik, ili i to traži čovjeka?
5. **Šta je „normalan" broj nalaza iz `safety.detect()`?** Lockstep prag (`share ≥ 0.7`) i
   koncentracija (`≥ 0.6`) mogu se aktivirati i kod **zdravog** roja sa dva workera. Treba li
   „baseline" po tenantu, ili pragovi ostaju fiksni i nalazi su input za čovjeka?
6. **Kada feromon treba prestati da utiče?** Sada ga briše TTL ili jačina < 0.001, ali `hot`
   može držati zadatak na vrhu i kad je stvarno prestao biti hitan. Da li uvesti „negativni" trag
   od čovjeka (npr. `cold`) ili ručno gašenje feromona po `taskId`?
