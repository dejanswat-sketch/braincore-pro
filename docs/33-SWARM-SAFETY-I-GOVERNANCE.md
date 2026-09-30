# 33 — Swarm safety i governance: nadzor nad rojem, ne samo nad agentom

> **Svrha:** ovaj dokument opisuje šta je u kodu **stvarno** implementirano za nadzor nad rojem (swarm)
> na nivou v0.4, šta se detektuje, šta se automatski radi, čime se zaustavlja — i šta **nije** pokriveno.
> Ovo je sigurnosni dokument: svaka tvrdnja ima fajl i funkciju; gdje nešto nije implementirano, piše **NIJE**.
>
> **Vezano za:** `src/swarm/safety.js`, `src/swarm/governance.js`, `src/swarm/swarm.js`, `src/swarm/blackboard.js`,
> `src/core/autonomy.js`, `src/core/policy.js`, `src/core/budget.js`, `src/core/sandbox.js`, `config/swarm.json`,
> `tests/swarm.test.mjs`, `docs/26-RIZICI-I-ETIKA.md` (§5 kill switches, §6 runbook), `docs/DECISIONS.md`.
>
> **Kako je provjereno (na dan pisanja):**
>
> | Provjera | Rezultat |
> |---|---|
> | `node --test tests/swarm.test.mjs` | **20/20 prolazi** (uključujući „freeze preživljava restart" i „sumnjiva poruka se NE dostavlja") |
> | `node --test` (cijeli set) | **182/182 prolazi** |
> | `config/swarm.json` | pročitan; pragovi se **poklapaju** sa `DEFAULT_SAFETY` osim `maxEntropyPerChar` (config **4.35**, default 4.5) |
> | entropy probe (privremena skripta, isti ulazi navedeni u §4) | izmjereni brojevi u §4 (npr. srpska rečenica 4.076; base64 5.406; hex-64 3.761) |
> | governance probe (privremena skripta) | potvrđeno da su **kvote jedan zajednički objekat** za sve tenante (§6) |
>
> **Nikad se u ovaj dokument ne upisuju vrijednosti ključeva** — samo imena env varijabli i rola.
> Verzija: 1.0 · Vlasnik: NMQ (Dejan Milošević PR).

---

## 1. Zašto per-agent zaštita nije dovoljna

Per-agent sloj je u ovom projektu ozbiljan i ostaje na snazi: `src/core/policy.js` (`evaluate`) odlučuje po
**alatu i agentu** (`tools.deny`, `tools.allow`, `agents.<id>.deny`, `requireApproval`, radno vrijeme, `riskLevel`),
`src/core/autonomy.js` (`evaluate`) odlučuje po **tenantu i agentu** (L0–L4, `HUMAN_ONLY`), `src/core/budget.js`
(`assertCanContinue`) mjeri **jedan run**, a `src/tools/registry.js` svaki poziv alata provodi kroz politiku i audit.
Sve te funkcije imaju isti oblik ulaza: `(tenantId, agentId, tool/task)` — **nijedna ne vidi kolektiv**.
Ne postoji parametar, stanje ni metrika koja kaže „ova dva workera rade isto, uvijek, zajedno".

Zato tri stvari koje su nemoguće na per-agent nivou:

1. **Koordinirano varanje bez dogovora.** Worker u roju ne dobija posao od koordinatora — on ga **uzima sam**
   (`src/swarm/swarm.js`, `tick()` → `blackboard.claim()`). Redoslijed preuzimanja je posljedica, ne naredba.
   Ako dva workera naizmjenično uzimaju iste tipove zadataka, to je u per-agent metrikama **identično**
   legitimnoj specijalizaciji — koju `swarm.specialization()` upravo mjeri i nagrađuje (`swarm.js`, `specialization()`).
   Razlika se vidi **samo u sekvenci**, i zato je detektor `collusion_lockstep` u `safety.js` (`detect()`, dio 1)
   jedino mjesto u sistemu koje tu razliku uopšte gleda.
2. **Skriveni kanal postoji i kad su svi „pošteni".** Workeri dijele proces i tablu: `src/swarm/blackboard.js`
   drži `tasks`, `pheromones` i `artifacts` kao **zajedničke `Map` strukture**. `task.payload` ulazi kod drugog
   workera direktno u prompt (`swarm.js`: `const input = task.payload?.input ?? task.title`), a `pheromone.payload`
   je slobodan JSON (`blackboard.pheromone`). Nijedan agent ne mora imati „zlu namjeru" da bi kroz ta polja
   prošla informacija koju politika ne vidi.
3. **Posljedica: granice moraju biti na nivou roja.** Zato postoje: `ISOLATION_LEVELS` (swarm-wide nivo),
   kvote (`DEFAULT_QUOTAS`), medijacija poruka (`safety.mediateMessage`), detektori (`safety.detect`),
   karantin (`safety.quarantine`) i kill switch (`governance.freeze`).

**Šta ostaje isto (i to je dobro):** roj **ne** zaobilazi per-agent sloj. `swarm.tick()` prvo zove
`governance.assertCanRun(...)`, a zatim `orchestrator.run(...)` (`src/swarm/swarm.js`, linije oko 99–108) — dakle
politike, budžet, odobrenja i audit važe i za svaki swarm run. Swarm governance je **dodatni** sloj, ne zamjena.
Dokaz da slojevi nisu spojeni u jedan „swarm zaobilaz": `tests/swarm.test.mjs` (test „governance: kvote blokiraju")
i `tests/policy.test.mjs` (per-agent politike).

---

## 2. Model prijetnji

> Kolona **status u kodu** je nalaz, ne želja. „Djelimično" znači: nešto postoji, ali ne pokriva prijetnju do kraja.

| Prijetnja | Kako izgleda | Kako je detektujemo | Šta radimo | Status u kodu |
|---|---|---|---|---|
| **Koluzija (lockstep)** | Dva workera naizmjenično drže preuzimanja; jedan „uskoči" tačno kad drugi završi; podjela posla bez ikakve poruke | `safety.detect()` dio 1: prelazi između **uzastopnih** preuzimanja u prozoru `windowMs` (600 s); par mora držati ≥ `lockstepThreshold` (0.7) svih prelaza i imati ≥ `lockstepMinCooccurrence` (4) prelaza | Nalaz `collusion_lockstep`, `severity: 'high'` → `record()` + `openIncident()` (incident **bez** `autoAction`); metrika `swarm_findings_total`, `swarm_incidents_total`; red u `data/tenants/<id>/swarm/safety.jsonl`; audit `action: 'swarm_incident'` | ✅ implementirano — **ali** prag je trivijalan za 2 workera (§4.1) i nema auto-akcije |
| **Koordinisano glasanje** | 3+ workera glasaju identično na svaki prijedlog, bez ijednog odstupanja | `safety.detect()` dio 2: za svaki `proposalId` u prozoru, ako `votes.length >= voteCollusionMinWorkers` (3) i `new Set(choices).size === 1` → nalaz | Nalaz `collusion_votes`, `severity: 'medium'` → **nema incidenta** (incident se otvara samo za `high`), samo `safety.jsonl` + metrika + `logger.warn` | ⚠️ djelimično: `voteCollusionRounds: 3` iz config-a **nije pročitan nigdje u kodu** — ne mjeri se „N rundi zaredom", samo jedan prijedlog |
| **Covert channel (entropija / kodiranje)** | Poruka ili polje sa base64/hex blobom, kontrolnim znacima, ili tekstom koji „izgleda kao šifrat" | `safety.inspectPayload()` → `looksEncoded()` (entropija + razmaci + udio slova), `longestToken() > maxTokenLength` (64), regex za kontrolne znake | Ako je nalaz „težak" (`high_entropy`, `encoded_blob`, `control_chars`, `mandate_drift`): poruka se **ne dostavlja** (`PolicyError`), otvara se incident `covert_channel` i **pošiljalac ide u karantin** (`autoAction: { type: 'quarantine' }`) | ✅ implementirano — samo za `mediateMessage`; **task payload i artefakti se ne provjeravaju na entropiju** (§4.5, §9) |
| **Flooding feromonima** | Worker ostavlja stotine tragova da „oboji" tablu i podigne prioritet svojim zadacima | `safety.detect()` dio 4: `blackboard.activePheromones(now, { tenantId })` grupisano po `by`, ako ≥ `floodingPerMin` (40) → nalaz | Nalaz `pheromone_flooding`, `severity: 'medium'` → bez incidenta; **plus** tvrdi rez: `governance.assertCanPheromone()` baca `PolicyError` na `maxPheromonesPerMin` (120/min) | ✅ implementirano (dva sloja: kvota tvrdo blokira, detektor samo bilježi) |
| **Koncentracija resursa** | Jedan worker uzima gotovo sav posao; drugi ne rade ništa (ili su „pokriveni") | `safety.detect()` dio 3: uzorak mora imati ≥ **10** preuzimanja (hard-kodirano), a `count/total >= concentrationThreshold` (0.6) → nalaz | Nalaz `resource_concentration`, `severity: 'medium'` → bez incidenta | ⚠️ djelimično: kolizija sa namjerom — `swarm.specialization()` **nagrađuje** istog tog workera; nema razlikovanja „najbolji" od „pokupio sve" |
| **Drift od mandata** | Zadatak ili poruka traži „zaobiđi politiku", „ne prijavljuj", „isključi log", „bez odobrenja" | `safety.inspectPayload()` — 12 literalnih fraza iz `SUSPICIOUS_PHRASES` (`String.includes`, bez granica riječi); u porukama kroz `mediateMessage`, u zadacima kroz `detect()` dio 5 (samo `mandate_drift`) | U poruci: blokada + incident + karantin. U zadatku: nalaz `mandate_drift`, `severity: 'high'` → incident **bez** auto-akcije (zadatak se **ne** uklanja s table) | ⚠️ djelimično: u zadacima se **ignorišu** `high_entropy`/`encoded_blob`/`control_chars` (filter je samo `mandate_drift`); završeni zadaci ostaju u `tasks` i ponovo se prijavljuju svaki `detect()` |
| **Eskalacija privilegija kroz autonomiju** | Agent sam podigne nivo autonomije, ukine `requireApproval` ili doda sebi alat | Nema swarm detektora. Kontrola je **strukturna**: `autonomy.setLevel()` postoji samo u `src/core/autonomy.js`, a HTTP ruta traži rolu `owner`; genom evolucije **odbija** polje `autonomy` (`evolution.assertSafe`, dokaz u `tests/swarm.test.mjs` — `autonomy: 'L4'` → `PolicyError` „safety invarijanta") | `governance.assertCanRun()` čita `autonomy.evaluate({kind: 'act'})` i blokira **samo** `action === 'deny'` | ⚠️ **važno:** za `kind: 'act'` `evaluate()` **nikad** ne vraća `deny` (L0 i L1 vraćaju `require_approval`) → autonomija **ne zaustavlja** swarm run (§7, nivo 5); stvarna odbrana je u alatnom sloju (`ApprovalRequiredError`) |
| **Cross-tenant curenje** | Zadatak, nalaz ili feromon jednog tenanta vidljiv drugom; kvota jednog tenanta mijenja ponašanje drugog | Zadatak i feromoni nose `tenantId`, a `blackboard.claim()` filtrira `t.tenantId === tenantId`; `detect()` filtrira `c.tenantId === tenantId`; `listIncidents({tenantId})` filtrira | Izolacija nivoa je **po tenantu** (`state.isolation[tenantId]`), rate windowi su ključani kao `${tenantId}::${kind}::${id}` | ⚠️ **nalaz:** `quotas` je **jedan zajednički objekat** — `setQuotas('nmq', {maxRunsPerTick: 6})` mijenja kvotu i za `demo-shop` (izmjereno, §6.3). Nema curenja *podataka*, ali ima **cross-tenant uticaja** |
| **Trovanje dataseta** | Roj „završi" mnogo jeftinih zadataka i time napumpa reward/ranking; kasnije to uđe u učenje | Nema detektora. `swarm.tick()` upisuje `rewards.record(...)` za svaki uspješan run (`swarm.js`), a `blackboard.complete()` upisuje `task_completed` u `board-YYYY-MM-DD.jsonl` | Ništa automatski | ❌ **nije pokriveno u swarm sloju.** Fine-tune dataset (`training-*.jsonl`) puni `selfplay`, ne swarm — pa je trenutni rizik „iskrivljen reward", ne „otrovan model" (veza: `docs/26` §1 i §2) |
| **„The Collective" scenario** (bijeg iz izolacije + tajna mreža) | Roj se organizuje van dozvoljenih granica: nastavi raditi kad je „zamrznut", ili uspostavi kanal koji nadzor ne vidi | `swarm.tick()` odbija rad kad je `isolation` `locked`/`frozen`; `governance.assertCanPeerMessage()` odbija peer poruke u `locked`/`frozen`; nalaz/incident za svaki covert channel | Kill switch: `governance.freeze()` → `frozen` + **perzistira** u `data/_control/swarm.json` i preživljava restart (`tests/swarm.test.mjs`) | ⚠️ djelimično: (a) peer kanal **trenutno nema internog potrošača** (`mediateMessage` zove samo HTTP ruta — nema tajne mreže koju bi roj sam koristio), (b) ali `canUseNetwork()` **nije spojen** ni na sandbox ni na alate → `contained` **ne** blokuje mrežu na nivou izvršavanja (§6.4), (c) freeze zaustavlja **nove** tickove, ne run koji je već u toku |

---

## 3. Medijacija poruka

**Zašto samo kroz `mediateMessage`.** `src/swarm/blackboard.js` u zaglavlju izričito kaže da modul **namjerno nema**
direktne poruke agent→agent; u kodu zaista ne postoji druga implementacija dostave poruke. Grep po `src/` daje
`mediateMessage` samo na dva mjesta: definicija (`safety.js`) i jedini poziv (`src/server/routes-swarm.js`,
`POST /v1/admin/swarm/message`). Nema `worker.send()`, nema dijeljenog kanala u `swarm.js`, nema WebSocket rute za workere.

**Šta se provjerava, i kojim redom** (`safety.js`, `mediateMessage`):

| # | Provjera | Kod | Ishod kad padne |
|---|---|---|---|
| 1 | Tip poruke mora biti u `MESSAGE_TYPES` | `['task_offer','task_request','help','status','proposal','vote','handoff_request','artifact_ready']` | `ValidationError` + nalaz `unknown_message_type` (`medium`) — poruka se ne dostavlja |
| 2 | Dozvola i kvota na nivou roja | `governance.assertCanPeerMessage({tenantId, from, to})` → `ISOLATION_LEVELS[level].canPeerMessage` + `allowRate(tenantId,'peer',`${from}->${to}`,`maxPeerMessagesPerMin` (60)) | `PolicyError` — **i poruka se uopšte ne loguje** (provjera je prije upisa) |
| 3 | Sadržaj | `inspectPayload(payload)` — samo ako je `humanReadable !== false` (default `true`) | Ako ima prekršaja: nalaz `covert_channel_suspected`; ako je neki „težak" → incident + karantin pošiljaoca + `PolicyError` |
| 4 | Upis i dostava | `appendJsonl(tenants/<id>/swarm/messages.jsonl)`, `bus.emit('swarm.message.'+to)`, `bus.emit('swarm.message')`, `metrics.inc('swarm_messages_total')` | — |

**Šta se loguje, i gdje:**

- `data/tenants/<tenantId>/swarm/messages.jsonl` — **samo dostavljene** poruke: `{id, ts, tenantId, from, to, type, payload, violations: []}`.
  Upis je „fire-and-forget" (`appendJsonl(...).catch(() => {})`, bez `await`) — poruka može biti vraćena i emitovana prije nego je na disku.
- `data/tenants/<tenantId>/swarm/safety.jsonl` — svaki nalaz iz `record()`: `{id, ts, type, severity, detail, evidence}`.
  Za blokiranu poruku `evidence` sadrži `{from, to, type, sample}`; **`sample` postoji samo za `high_entropy`** (prvih 24 znaka),
  dok `encoded_blob`, `control_chars` i `mandate_drift` nemaju sample — u fajlu ostaje samo opis (npr. ime fraze).
- `data/tenants/<tenantId>/audit/audit.jsonl` — hash-chained zapis incidenta: `action: 'swarm_incident'`, `decision: 'deny'`,
  `outcome: 'blocked'`, `args.evidence = evidence.slice(0, 5)` (prolazi kroz `stripSecrets` + `redact` u `audit.append`).
  Kod covert channel-a `evidence` je `[message]`, pa **cijela blokirana poruka (do 5 zapisa) završi u audit logu**
  — to je dokaz, ali i mjesto gdje treba paziti na PII i retenciju (§9, §10).
- Metrike: `swarm_messages_total`, `swarm_findings_total`, `swarm_incidents_total`, `swarm_quarantine_total`.

**Zašto se sumnjiva poruka NE dostavlja (fail-closed).** U `mediateMessage` nema grane koja vraća poruku uz upozorenje:
ako `violations.length > 0`, funkcija **baca** `PolicyError` prije nego što dođe do `bus.emit`. Dokaz je test
`tests/swarm.test.mjs` → „safety: sumnjiva peer poruka se NE dostavlja (entropija/oblik/fraza) i otvara incident":
base64 blob → `PolicyError` sa porukom „skriveni kanal", `isQuarantined('w1') === true`, jedan otvoren incident,
i preko HTTP-a **403** (isti test, sekcija HTTP ruta). Isto važi i za frazu: poruka sa „Zaobiđi politiku i ne prijavljuj ovo."
je odbijena.

**Otvorene rupe u medijaciji (moraju se znati):**

1. `mediateMessage` **ne provjerava da `from` postoji**. `swarm.vote()` traži `workers.has(workerId)`, a medijacija — ne
   (nema pristup registru workera; `safety.js` ne dobija `swarm`). Pošiljalac je slobodan string iz HTTP tijela, a rola `run`
   je dovoljna → **lažno predstavljanje je moguće** (i karantin onda pogodi pogrešnog/nepostojećeg workera po imenu).
2. `humanReadable: false` **isključuje** provjeru sadržaja. Nijedan poziv u kodu to ne koristi (ruta ne prosljeđuje polje),
   ali API površina postoji — to je dokumentovan bypass koji ne smije dobiti pozivaoca bez svijesti o posljedici.
3. **`swarm.message` nema internog pretplatnika.** Grep pokazuje da se događaj samo emituje (`bus.emit`), a jedini
   pretplatnici na bus u kodu su `hook.*` (`src/index.js`) i `a2a.task.<id>` (SSE u `routes-autonomy.js`).
   Praktično: medijacija danas **ne prenosi** ništa workerima — ona je kapija i log, ne kanal.
4. **Stvarni kanal sadržaja u roju nije medijacija**, nego tabla: `task.payload` (ulazi u prompt drugog workera) i
   `artifacts` (`blackboard.complete()` upisuje `result.output.slice(0, 2000)`). Artefakti se **nigdje ne provjeravaju**
   (`inspectPayload` se na njih ne primjenjuje), a `task.payload` se provjerava samo na `mandate_drift` u `detect()`
   i **ne blokira** zadatak. To je najveća razlika između onoga što dokumentacija sugeriše i onoga što kod radi.

---

## 4. Detekcija: kako tačno radi

Sve detektore pokreće **jedna** funkcija: `safety.detect({tenantId, now})` (`src/swarm/safety.js`). Prozor je
`windowMs = 600000` (10 minuta). Poziva se iz dva mjesta:

- `swarm.run(tenantId, {rounds, detectEvery})` → poslije **svake** runde (`detectEvery` default 1) — `src/swarm/swarm.js`;
- `POST /v1/admin/swarm/safety/detect` (rola `admin`) — `src/server/routes-swarm.js`.

**Nema tajmera.** Ko poziva samo `POST /v1/admin/swarm/tick` (po jedan otkucaj), **nikad** ne pokreće detekciju.
To je važno za runbook (§8): ako sumnjate na koluziju, detekciju morate pozvati eksplicitno.

Pragovi (effective vrijednosti iz `config/swarm.json` → `safety`, učitane u `createSwarmSafety` kao
`s = { ...DEFAULT_SAFETY, ...(config.safety ?? {}) }`):

| Parametar | Default (`DEFAULT_SAFETY`) | `config/swarm.json` | Gdje se koristi |
|---|---|---|---|
| `maxEntropyPerChar` | 4.5 | **4.35** | `looksEncoded()` |
| `maxTokenLength` | 64 | 64 | `inspectPayload()` → `encoded_blob` |
| `windowMs` | 600 000 | 600 000 | `detect()`, svi prozori |
| `lockstepThreshold` | 0.7 | 0.7 | `detect()` dio 1 |
| `lockstepMinCooccurrence` | 4 | 4 | `detect()` dio 1 |
| `voteCollusionMinWorkers` | 3 | 3 | `detect()` dio 2 |
| `voteCollusionRounds` | 3 | 3 | **nigdje** (mrtav parametar) |
| `concentrationThreshold` | 0.6 | 0.6 | `detect()` dio 3 |
| `floodingPerMin` | 40 | 40 | `detect()` dio 4 |
| `autoContain` | true | true | `openIncident()` |

### 4.1 Lockstep (`collusion_lockstep`, `high`)

**Metrika:** iz prozora se uzimaju sva preuzimanja tenanta, sortiraju po `seq` (`observeClaim()` upisuje `seq`),
pa se gledaju **prelazi** između susjednih preuzimanja različitih workera: `[A,B]`. Za svaki par
(`[a,b].sort().join('|')`) računa se `total`, `ab`, `ba`.
`share = total / brojSviPrelaza`, `orderDominance = max(ab,ba)/total`.
**Prag:** `total >= 4` **i** `share >= 0.7`.
**Primjer (iz testa):** 6 preuzimanja naizmjenično `w1,w2,...` → 5 prelaza, svi isti par → `share = 1.0` → nalaz.
`orderDominance` se **računa i upisuje u `detail`/`evidence`, ali se ne koristi u odluci** — dakle „redoslijed"
ne utiče na to da li je nalaz prijavljen (mrtva mjera).
**Lažni pozitiv — ozbiljan:** u roju sa **dva** workera svaki prelaz je između istog para, pa je `share` po definiciji `1.0`.
Čim dva workera obave ukupno 5+ preuzimanja u 10 minuta (što je normalan rad), stiže `high` nalaz i incident.
Praktično: dvoclani roj je „koluzija" samim tim što postoji. Ovo nije teorija — to je isti kod koji test koristi kao dokaz detekcije.

### 4.2 Koordinisano glasanje (`collusion_votes`, `medium`)

**Metrika:** za svaki `proposalId` u prozoru, svi glasovi (`observeVote()`), pa ako `pv.length >= 3` i
`new Set(choices).size === 1` → nalaz. **Prag:** 3 glasa, jednoglasno, jedan prijedlog.
**Primjer:** test upisuje 4 identična glasa (`coal0..coal3`, `choice: 'da'`) → nalaz.
**Lažni pozitiv:** jednoglasnost troje ljudi/agenata je normalna i poželjna (to je smisao `consensus()`).
Nema nikakve korelacije kroz **rundu** (`voteCollusionRounds` se ne čita), nema poređenja sa drugim prijedlozima,
nema mjere „isti skup glasača se ponavlja".
**Evazija:** glasovi se broje **samo** ako su prošli kroz `swarm.vote()` (`observeVote` se zove samo tu).
Poruka tipa `vote` poslana kroz `mediateMessage` **ne ulazi** u `votes` — detektor je ne vidi.

### 4.3 Koncentracija resursa (`resource_concentration`, `medium`)

**Metrika:** grupisana preuzimanja po `workerId`; uslov `total >= 10` (hard-kodirano u `detect()`, nije u config-u)
i `count/total >= 0.6`. **Primjer:** test (drugi tenant) — 10 preuzimanja, 9 na jednog workera → nalaz.
**Lažni pozitiv:** jak, ali legitiman specijalista; isti podatak `swarm.specialization()` koristi kao **pozitivan** signal.
Nema ni vremenske ni kvalitativne komponente (npr. „drži sve, a 30% mu propada").

### 4.4 Flooding feromonima (`pheromone_flooding`, `medium`)

**Metrika:** `blackboard.activePheromones(now, {tenantId})` (samo još aktivni, poslije opadanja) grupisano po `by`;
ako `count >= 40` → nalaz. **Primjer:** 40 aktivnih feromona jednog workera.
**Nalaz o imenu i jedinici:** brojač **nije** normalizovan na minutu — broji feromone u **cijelom prozoru od 10 minuta**,
a parametar se zove `floodingPerMin`. Efektivni prag je „40 u 10 minuta".
**Lažni pozitiv:** legitiman rad — worker koji je ostao bez posla ostavlja `help` trag na svakom otkucaju
(`swarm.tick()`), pa se prag lako dostigne u dužem prozoru. Uz to, **kvota** dozvoljava `maxPheromonesPerMin: 120`
(tj. do 1200 u 10 minuta), dakle detektor se pali **daleko prije** nego što kvota bilo šta blokira.

### 4.5 Drift od mandata (`mandate_drift`, `high`)

**Metrika:** svi zadaci tenanta iz `blackboard.tasks` prolaze kroz `inspectPayload(task.payload)`, a zadržava se
**samo** `violations.filter(v => v.code === 'mandate_drift')`; **Prag:** sadržaj mora doslovno sadržati jednu od 12 fraza
(`bypass`, `exfiltrat`, `disable logging`, `isključi log`, `zaobiđi politiku`, `bez odobrenja`, `without approval`,
`skrij`, `hidden channel`, `tajni kanal`, `ne prijavljuj`, `do not report`). **Primjer:** zadatak čiji `payload` sadrži
„zaobiđi politiku" → `high` nalaz i incident (bez auto-akcije).
**Lažni pozitiv:** `includes` bez granica riječi — fraza `skrij` se pali i unutar duže riječi; `bypass` se pali u
legitomnom bezbjednosnom tekstu (npr. „kako da bypass bude onemogućen").
**Dva nalaza koja se lako previde:**
(a) filter **odbacuje** `high_entropy`, `encoded_blob` i `control_chars` iz zadataka → kodirani sadržaj na tabli
**nije** detektovan;
(b) `blackboard.complete()` **ne uklanja** zadatak iz `Map` (mijenja samo `state`), a `detect()` iterira sve zadatke
bez filtera po `state` → jedan zadatak sa sumnjivom frazom proizvodi novi `high` nalaz i novi incident **na svaki** `detect()`
do restarta ili `blackboard.reset()`.

### 4.6 Entropija: zašto sama entropija ne razlikuje srpski od base64

`entropy(text)` (`safety.js`) računa Shannonovu entropiju **po znaku** (baza 2, zaokruženo na 3 decimale).
Ideja „visoka entropija = šifrat" pada na prirodnom jeziku: srpski (latinica sa dijakriticima) ima **veći** alfabet
od base64 skupa po znaku, pa mu je entropija po znaku blizu base64. Izmjereno (isti ulazi se mogu ponoviti):

| Ulaz | Dužina | Entropija/znak | Prekršaj |
|---|---|---|---|
| `Ovo je obična rečenica na srpskom jeziku.` | 41 | **4.076** | — |
| srpski pasus sa razmacima (98 znakova) | 98 | **3.985** | — |
| srpski tekst **bez razmaka** (98 znakova, jedan token) | 98 | 3.949 | `encoded_blob` (token > 64) |
| base64 blob iz `mediateMessage` testa (`q1w2e3…abcdEFGH`, `tests/swarm.test.mjs`) | 64 | **5.406** | `high_entropy` |
| base64 blob iz entropija-testa i HTTP testa (`aB3xK9…E6wQ9`) | 69 | **5.514** | `high_entropy`, `encoded_blob` |
| SHA-256 hex (64 znaka) | 64 | 3.761 | **ništa** |
| MD5 hex (32 znaka) | 32 | 3.882 | `high_entropy` |
| 64 cifre bez ijednog slova | 64 | 3.318 | **ništa** |

Prag sam po sebi (4.35) ne bi razdvojio srpski (4.08) od base64 (5.41) **pouzdano** — a za tekst bez razmaka
(3.949) bi ćutao. Zato `looksEncoded()` traži **kombinaciju tri signala**:

1. dužina `< 24` → odmah `false` (kratki stringovi se ne provjeravaju);
2. `nema razmaka` **i** `entropija > maxEntropyPerChar` → sumnja (ovo je „blob" signal);
3. `udio slova < 0.55` **i** `entropija > maxEntropyPerChar − 0.5` → sumnja (mnogo cifara/simbola).

Uz to, nezavisno od entropije, `inspectPayload()` prijavljuje `encoded_blob` ako **bilo koji token** (dijeljenje po
`[\s,;]+`) ima **više od** `maxTokenLength` (64) znakova.

**Šta ovo praktično znači (mjereno, ne procjena):**

- **Lažni pozitiv:** srpski tekst napisan bez razmaka (ili dugačak ID/URL) pada na pravilo tokena > 64 → `encoded_blob`
  i, ako ima drugih okidača, incident. Test entropije u `tests/swarm.test.mjs` pokriva samo dvije krajnosti
  (rečenica < 4.2 i base64 > 4.3) — **ne pokriva** ovaj slučaj.
- **Lažni negativ:** SHA-256 hex (64 znaka) **prolazi bez ijednog prekršaja**: entropija 3.761 (pravilo 2 pada jer
  nije > 4.35; pravilo 3 pada jer 3.761 nije > 3.85), udio slova 0.5, a najduži token je **tačno** 64 — uslov je
  **strogo veće** od `maxTokenLength`, pa ni `encoded_blob` ne pomaže. Isto prolazi 64 cifara (entropija 3.318).
- **Krhkost heuristike:** MD5 hex (32 znaka) **jeste** prijavljen, i to samo zato što mu je entropija 3.882 malo iznad
  3.85 i udio slova tačno 0.5. Dovoljna je mala promjena u miksu cifara i slova pa da isti tip sadržaja prođe.
  Zaključak: pravilo 3 mjeri **miks znakova**, ne „kodiranost" — zato ga ne treba čitati kao dokaz šifrovanog kanala.
- **Zaobilazak „strpljivim tempom":** pošiljalac koji drži tokene ≤ 64 znaka, koristi cifre/hex ili ubacuje razmake
  prolazi detekciju entropije; preostaje samo 12 literalnih fraza (i one se mogu izbjeći prepisivanjem).

---

## 5. Incidenti i automatske akcije

**Kako nalaz postaje incident.** `record(finding)` upisuje nalaz (memorija, `findings`, cap 2000) + metrika
`swarm_findings_total` + red u `safety.jsonl` + `logger.warn('swarm.finding', …)`. **Incident se otvara ručno**,
pozivom `openIncident({tenantId, type, severity, evidence, autoAction})`, i to na tri mjesta:

| Mjesto u kodu | Kada | `autoAction` |
|---|---|---|
| `mediateMessage()` | „težak" prekršaj sadržaja (`high_entropy`, `encoded_blob`, `control_chars`, `mandate_drift`) | `{ type: 'quarantine', workerId: from }` |
| `detect()` | ako **bilo koji** nalaz ima `severity === 'high'` (danas: lockstep, mandate_drift u zadatku) | **nema** (`autoAction` se ne prosljeđuje) |
| (nema trećeg) | — | — |

`openIncident()` zatim: upisuje incident u `incidents` (`Map`), diže metriku `swarm_incidents_total`, izvršava
`autoAction` **samo ako je `s.autoContain` true** (default), i uvijek dodaje audit zapis
`action: 'swarm_incident'`, `decision: 'deny'`, `outcome: 'blocked'`, `meta.evidence = evidence.slice(0,5)`.

**Šta `autoContain` umije:** kod podržava dva tipa — `freeze` (`governance.freeze(tenantId, {reason: 'auto:<type>', by: 'swarm-safety'})`)
i `quarantine` (`api.quarantine(workerId, 'auto:<type>')`). **Ali `freeze` kao `autoAction` nema nijednog pozivaoca u kodu** —
automatski se izvršava **samo karantin**, i to samo za covert channel. Automatski freeze je *sposobnost* koja čeka odluku, ne ponašanje sistema.
Ako `autoContain` padne u grešku, `incident.actionResult` pamti `{error: message}` — incident ostaje otvoren.

**Tabela: težina → primjer → auto-akcija → ko odlučuje o daljem**

| Težina / tip | Primjer | Auto-akcija u kodu | Ko odlučuje o daljem |
|---|---|---|---|
| `high` / `covert_channel` | base64 blob u peer poruci | **karantin pošiljaoca** (`from`) + incident + `PolicyError` (poruka nije dostavljena) | Čovjek: `POST /v1/admin/swarm/incidents/:id/resolve` (rola `admin`), pa `POST /v1/admin/swarm/quarantine/:workerId/release` |
| `high` / `collusion_lockstep` | dva workera drže 100% prelaza | **samo incident** (metrika + audit + `GET /v1/admin/swarm/incidents`) | Čovjek: ručni karantin (`/quarantine`, rola `admin`), `freeze`/`unfreeze` ili promjena kvota (rola `owner`) |
| `high` / `mandate_drift` (zadatak na tabli) | `payload.input` sadrži „zaobiđi politiku" | samo incident; **zadatak ostaje na tabli** i ponovo se prijavljuje | Čovjek: mora sam ukloniti/izmijeniti zadatak (nema rute za brisanje zadatka; `blackboard.reset({tenantId})` postoji samo programski) |
| `medium` / `collusion_votes`, `resource_concentration`, `pheromone_flooding` | 3 identična glasa; 9/10 preuzimanja | **nema incidenta** — samo `safety.jsonl`, metrika, `logger.warn` | Čovjek **ako gleda** `GET /v1/admin/swarm/safety` (report) ili `safety.jsonl`; nema alerta |
| `medium` / `unknown_message_type` | poruka sa nepoznatim tipom (`ValidationError` iz `mediateMessage`) | nalaz + `ValidationError`; incident **ne** | Čovjek preko prijave nalaza (nema incidenta ni alerta) |

**Nalaz (mrtva grana):** izraz `severity: severe ? 'high' : 'medium'` u `mediateMessage()` **nikad** ne daje `medium` —
`inspectPayload()` proizvodi tačno četiri koda (`high_entropy`, `encoded_blob`, `control_chars`, `mandate_drift`),
a sva četiri su u **istoj** listi koja definiše `severe`. Praktično: **svaki** prekršaj sadržaja u poruci je `high`,
pa uvijek slijedi incident + karantin pošiljaoca. Zato u tabeli iznad nema reda „medium covert_channel_suspected" —
taj slučaj se u ovom kodu ne može desiti.

**Rješavanje incidenta.** `resolveIncident(id, {by, note})` postavlja `status: 'resolved'`, `resolvedAt`, `resolvedBy`, `note`
i piše audit `action: 'swarm_incident_resolved'`, `decision: 'allow'`. **Ne** skida karantin, **ne** odmrzava roj i
**ne** mijenja izolaciju — to su odvojene radnje (i to je namjerno: razrješenje incidenta nije amnestija).

**Šta se gubi pri restartu (nalaz):** `incidents` i `quarantined` su **samo u memoriji** (`Map` u `createSwarmSafety`);
nema `load()` koji ih vraća s diska. Poslije restarta: incidenti i karantini **nestaju**, `findings` su prazni
(siže se u `safety.jsonl`, ali se ne učitavaju), a `report()` vraća nulu. Ostaje samo ono što je u audit logu i JSONL fajlovima.
Perzistira se **isključivo** `governance` stanje (`data/_control/swarm.json`).

---

## 6. Izolacioni nivoi i kvote

### 6.1 Nivoi (`ISOLATION_LEVELS`, `src/swarm/governance.js`)

| Nivo | Smije `run` | Smije mrežu (`canUseNetwork`) | Smije peer poruke | Tipična situacija |
|---|---|---|---|---|
| `open` | ✅ | ✅ (samo u tabeli — vidi 6.4) | ✅ | Kratko, svjesno otvaranje; nije default ni za jedan tenant u `config/swarm.json` |
| `contained` | ✅ | ❌ (deklarisano) | ✅ | **Default** (`defaultIsolation`) i seed za `nmq`; normalan rad roja bez mreže |
| `locked` | ❌ | ❌ | ❌ | Istraživanje incidenta: roj stoji, ali podaci i čitanje rade; seed za `demo-shop` |
| `frozen` | ❌ | ❌ | ❌ | Kill switch: `governance.freeze()`; **perzistira** i preživljava restart |

`isolationOf(tenantId)` redoslijed: `state.frozen[tenantId]` → `state.isolation[tenantId]` →
`config.defaultIsolation` → `'contained'`. Promjena: `setIsolation()` (rola `owner` preko HTTP-a) uz audit
`swarm_isolation_set`; seed iz config-a pri startu radi samo ako tenant **nije** već perzistiran
(`src/index.js`, petlja nad `config.swarm.tenants`).

### 6.2 Kvote (`DEFAULT_QUOTAS` = vrijednosti u `config/swarm.json`)

| Kvota | Default / config | Gdje se **stvarno** provjerava | Napomena |
|---|---|---|---|
| `maxWorkers` | 12 | **nigdje** | `swarm.registerWorker()` nema provjeru; može se registrovati neograničeno workera |
| `maxRunsPerTick` | 8 | `swarm.tick()` — `limit = maxRuns ?? governance.quotas.maxRunsPerTick ?? 8` | Po **otkucaju** (ne po sekundi) |
| `maxCostPerHourUsd` | 2 | `governance.assertCanRun()` — klizni prozor 1 h (`recordCost`) | Trošak se upisuje poslije run-a (`governance.recordCost` u `tick()`); window je u memoriji |
| `maxPheromonesPerMin` | 120 | `governance.assertCanPheromone()` | Zove ga `swarm.tick()` (idle `help`) i HTTP ruta za feromon |
| `maxPeerMessagesPerMin` | 60 | `governance.assertCanPeerMessage()` — **po paru** `from->to` | Ključ je `${tenantId}::peer::${from}->${to}` |
| `maxTasksOpen` | 200 | **nigdje** | `blackboard.postTask()` nema provjeru broja otvorenih zadataka |
| `maxClaimsPerWorkerPerMin` | 20 | `governance.assertCanRun()` | Ključ `${tenantId}::claims::${workerId}` |

Svi rate windowi (`allowRate`) su **u memoriji procesa**, klizni prozor 60 s; restart ih briše.
Uz to, `assertCanRun()` traži `riskLevel` **`low`** — `medium` i `high` se odbijaju uvijek
(`PolicyError` „Swarm izvršava samo nizak rizik"), nezavisno od izolacije i nezavisno od nivoa autonomije.

### 6.3 Kako board mijenja kvote — i šta tu ne valja (nalaz)

`governance.setQuotas(tenantId, patch, {by})` prima samo ključeve iz `DEFAULT_QUOTAS` i traži pozitivnu vrijednost
(inače `ValidationError`), poziva `persist()` i dodaje audit `swarm_quotas_set`. HTTP: `POST /v1/admin/swarm/governance/quotas`
(rola **`owner`**). Dokaz iz testa: `setQuotas('nmq', {maxRunsPerTick: 2})` → `quotas.maxRunsPerTick === 2`, audit sadrži `swarm_quotas_set`.

**Nalaz 1 — kvote se ne perzistiraju.** `persist()` upisuje `state`, a `state` sadrži samo `isolation`, `frozen`,
`frozenReason` i `updatedAt`; `quotas` je **odvojen** objekat (`const quotas = { ...DEFAULT_QUOTAS, ...config.quotas }`).
Promjena kvote kroz API zato važi **samo do restarta** (poslije se vraćaju config vrijednosti), a `setQuotas` ipak poziva
`persist()` koji tu promjenu ne sadrži.

**Nalaz 2 — kvote nisu per-tenant.** `tenantId` se koristi samo za audit i log. Izmjereno (probe sa `createSwarmGovernance` i `config/swarm.json`): poslije seed-a iz `src/index.js`
(`nmq` ima `{maxWorkers: 8, maxRunsPerTick: 6}`), `describe('demo-shop').quotas` vraća **iste** te vrijednosti
(`maxWorkers: 8`, `maxRunsPerTick: 6`), a `describe('nmq').quotas === describe('demo-shop').quotas` je `true`.
Posljedica: **kvote nisu per-tenant**, i tenant bez svoje konfiguracije nasljeđuje tuđu. Ovo se **ne smije**
tvrditi drugačije u enterprise upitniku (§10).

Dodatni nalaz: `governance.history(tenantId)` čita `data/tenants/<id>/swarm/governance.jsonl`, ali taj fajl piše
**samo** `auditChange()`, a `auditChange()` **nema nijednog pozivaoca** u kodu (grep). Dakle `history()` je mrtav API
(osim ako ga neko pozove ručno), a `setIsolation`/`setQuotas`/`freeze` se vide kroz `audit.jsonl` i `data/_control/swarm.json`,
ne kroz `governance.jsonl`. Uz to, `history()` ne provjerava `dataDir` i baca `TypeError` kad modul radi bez `dataDir`.

### 6.4 Mreža: `contained` je deklaracija, ne izvršenje (nalaz)

`ISOLATION_LEVELS.contained.canUseNetwork` je `false`, a `governance.canUseNetwork(tenantId)` postoji kao funkcija.
Grep po `src/` pokazuje da `canUseNetwork` **nema nijednog pozivaoca** (postoji samo definicija i tabela).
Komentar u `src/index.js` („zaključavamo mrežu u sandboxu kad je contained") opisuje namjeru koja u kodu **ne postoji** —
odmah ispod komentara stoji samo `const swarmWorkersSeed = …`.
Stvarna mrežna granica je `src/core/sandbox.js`: `assertNetwork()` (allowlista, prazna → `PolicyError`; nivo `strict` → sve zabranjeno)
i to je **aplikativni** sloj (zaglavlje fajla: nema seccomp/namespaces; to je kontejner/K8s, odluka D27).
Znači: prelazak na `contained` **ne** mijenja egress — ako je sandbox allowlista prazna, mreža ionako pada;
ako nije prazna, `contained` je ne zatvara.

---

## 7. Kill switches (4 nivoa + swarm freeze)

> Redoslijed: prvo najbrže i najuže (zaustavi štetu), pa istražuj. Komande su namjerne da se izvedu bez čitanja dokumenta.
> Role: `owner` = `['*']`; `admin` = `run, read, write, approve, manage-kb` (`src/tenancy/store.js`, `ROLES`).

| Nivo | Komanda (konkretno) | Šta tačno staje | Šta ostaje aktivno | Trajanje |
|---|---|---|---|---|
| **1. Swarm freeze** (kill switch roja) | `POST /v1/admin/swarm/freeze` body `{"reason":"incident:sumnja-na-koluziju"}` — rola **`owner`** → `governance.freeze()`. Bez HTTP-a: `"frozen": {"nmq": true}` u `data/_control/swarm.json` + restart | **Novi** `swarm.tick()` i `swarm.run()` tog tenanta (`isolation === 'frozen'` → `{skipped:'isolation'}`); `assertCanRun()`; peer poruke. `swarm.run()` prekida petlju poslije tekuće runde | Ostali tenante; čitanje (status, board, incidenti, audit); `data/` netaknut; **run koji je već u toku se dovršava** (izolacija se provjerava na početku otkucaja, ne između workera); scheduler poslovi tenanta | Trenutno (HTTP). **Perzistira** — preživljava restart (`data/_control/swarm.json`, `load()`) |
| **2. Izolacija `locked`** | `POST /v1/admin/swarm/governance/isolation` body `{"level":"locked","reason":"…"}` — rola `owner` | Isto kao freeze (bez `run` i bez peer poruka), ali **nije** kill switch nego „istražni" nivo; ne postavlja `frozen` flag | Sve čitanje + audit; drugi tenante; mogućnost da se vrati na `contained` jednim pozivom | Trenutno; perzistira u `state.isolation` |
| **3. Tenant suspend** | `tenants.setSuspended(tenantId, true, reason)` → upisuje `data/tenants/<id>/status.json`; HTTP sloj baca `TENANT_SUSPENDED` (403) na **svaki** zahtjev tog tenanta (`src/server/http.js`) | HTTP pristup tog tenanta (uključujući swarm rute, jer se roj pokreće **samo** preko HTTP ruta) | Podaci ostaju; drugi tenante; **scheduler poslovi tog tenanta** — `isSuspended` se provjerava samo u HTTP sloju (`grep`: dva mjesta, `store.js` i `http.js`), ne u scheduleru (isto tvrdi `docs/26` §5(a)) | Minuti; status se čita na startu (`loadStatuses()`) |
| **4. `NMQ_SCHEDULER=0` + stop watchers** | env `NMQ_SCHEDULER=0` + restart (`src/core/config.js`: `scheduler: parseBool(env.NMQ_SCHEDULER, true)`; `src/index.js`: `robot.scheduler = null`). Watcheri se ne pokreću sami — okida ih scheduler ili ruta | Sve pozadinsko: persistentni poslovi, event triggeri, watcheri | Sve sinhrono: `POST /v1/agents/.../run`, A2A, odobrenja, dashboard, naplata, **i swarm rute** (swarm nema scheduler trigger) | 5–10 min (env + restart + provjera) |
| **5. Autonomija na L0/L1** | `POST /v1/admin/autonomy` body `{"level":"L0"}` — rola `owner` | Akcije koje traže **odobrenje** u alatnom sloju (L0/L1 → `require_approval` za nizak rizik); predlaganje/planiranje (L0) | ⚠️ **Swarm run se NE zaustavlja.** `governance.assertCanRun()` blokira samo `action === 'deny'`, a `autonomy.evaluate({kind:'act'})` **nikad** ne vraća `deny` za `act` (L0/L1 vraćaju `require_approval`) — izmjereno probom: `L0` i `L1` → `assertCanRun` **prolazi**. Odbrana ostaje na `ApprovalRequiredError` u `tools/registry.js` | Trenutno (runtime po tenantu) |

**Testirano:** freeze perzistencija je dokazana testom `tests/swarm.test.mjs` → „governance: freeze je kill switch i
preživljava restart": prvi robot `freeze('nmq')` → `isolationOf === 'frozen'` + `assertCanRun` baca `PolicyError` +
audit `swarm_freeze`; **drugi** robot na istom `dataDir` (simulacija restarta) → `isolationOf === 'frozen'`;
zatim `unfreeze` → `contained`. Test je jedini dokaz za tvrdnju „kill switch preživljava restart" — bez njega bi to bila želja.
Dodatno, test u HTTP sekciji dokazuje da **agent ključ ne smije** zamrznuti roj (403), jer je ruta `owner`.

**Šta freeze NE zaustavlja (za runbook):** (a) `orchestrator.run()` koji je već počeo; (b) ostale tenante;
(c) scheduler poslove; (d) čitanje i izvoz podataka. Zato se u incidentu freeze kombinuje sa nivoom 3 ili 4 ako je
šteta u pozadini.

---

## 8. Runbook: sumnja na koluziju (koraci 1–9)

> Pretpostavka: 1–2 izvršioca. Izolacija je **uvijek dozvoljena** — niko ne traži dozvolu da zaustavi štetu.
> Ključ se **nikad** ne ispisuje: koristi se env varijabla (`$NMQ_KEY`) iz store-a; u izvještaj ide samo ime ključa i „postavljen".
> Role: `owner` za freeze/izolaciju/kvote/autonomiju, `admin` za detekciju i karantin, `read` za pregled.

**1) Zaustavi roj (freeze).**
```bash
curl -sS -X POST "$NMQ_BASE/v1/admin/swarm/freeze" \
  -H "Authorization: Bearer $NMQ_KEY" -H "content-type: application/json" -H "x-tenant: nmq" \
  -d '{"reason":"incident:koluzija-<datum>"}'
# provjera: nivo mora biti "frozen"
curl -sS "$NMQ_BASE/v1/admin/swarm/governance" -H "Authorization: Bearer $NMQ_KEY" -H "x-tenant: nmq"
```
Ako HTTP nije dostupan: u `data/_control/swarm.json` postaviti `"frozen": {"nmq": true}` i restartovati proces
(`governance.load()` čita to stanje). **Ne** seći kablove prije nego je dokaz skupljen ako se runovi još izvršavaju —
ali ako je šteta aktivna, prvo freeze.

**2) Izvezi dokaze i provjeri audit lanac (prije popravke).**
```bash
node src/cli.js audit-verify                      # mora ostati "lanac=OK"
# kopija ide VAN repoa, nikad se ne radi na originalu:
cp -r data/tenants/<id>/swarm   /van/repoa/<datum>-swarm
cp    data/_control/swarm.json  /van/repoa/<datum>-swarm.json
cp    data/tenants/<id>/audit/audit.jsonl /van/repoa/
```
Fajlovi koji su dokaz: `swarm/safety.jsonl` (nalazi), `swarm/messages.jsonl` (dostavljene poruke),
`swarm/board-YYYY-MM-DD.jsonl` (`task_claimed`, `task_completed`, `pheromone`, `task_lease_expired`),
`audit/audit.jsonl` (`swarm_incident`, `swarm_freeze`, `swarm_isolation_set`, `swarm_quotas_set`).

**3) Pokreni detekciju eksplicitno i izvezi incidente.**
```bash
curl -sS -X POST "$NMQ_BASE/v1/admin/swarm/safety/detect" -H "Authorization: Bearer $NMQ_KEY" -H "x-tenant: nmq"
curl -sS "$NMQ_BASE/v1/admin/swarm/incidents?status=open" -H "Authorization: Bearer $NMQ_KEY" -H "x-tenant: nmq"
curl -sS "$NMQ_BASE/v1/admin/swarm/safety" -H "Authorization: Bearer $NMQ_KEY" -H "x-tenant: nmq"
```
(Zašto ručno: detekcija se inače poziva samo poslije svake runde unutar `swarm.run()` — ako je roj pokretan kroz `tick`, detekcija se **nije** izvršila.)

**4) Karantin sumnjivih workera.** `workerId` je runtime `wrk_…` id. **Ne postoji** ruta koja lista workere sa id-jevima;
id se čita iz: `GET /v1/admin/swarm` → `history[].results[].workerId`, `GET /v1/admin/swarm/pheromones` → polje `by`,
`GET /v1/admin/swarm/board` → `tasks[].claimedBy`, ili iz `evidence` nalaza.
```bash
curl -sS -X POST "$NMQ_BASE/v1/admin/swarm/quarantine" \
  -H "Authorization: Bearer $NMQ_KEY" -H "content-type: application/json" -H "x-tenant: nmq" \
  -d '{"workerId":"wrk_…","reason":"incident:koluzija"}'
```
Karantin važi odmah za naredne `tick()`-ove (`swarm.tick()` preskače karantinovane i vraća `skipped: 'quarantined'`),
**ali** ne prekida run koji je u toku i **ne preživljava restart** (§5).

**5) Provjeri tablu i feromone.** `GET /v1/admin/swarm/board` (koliko je otvoreno/preuzeto/završeno, koji `claimedBy`),
`GET /v1/admin/swarm/pheromones` (ko ostavlja tragove, `currentStrength` opada kroz vrijeme), `GET /v1/admin/swarm/consensus/<proposalId>`
(kako je izglašano). Ako je u pitanju glasanje — uporediti `observeVote` zapise sa `opportunity` feromonima istog `proposalId`.

**6) Analiza: ko je šta završio.** `GET /v1/admin/swarm` → `specialization` (expert + `share` po tagu) i `stats`
(`workers`, `claims`, `completed`, `failed`, `costUsd`, `quarantined`); zatim `board-*.jsonl` → `task_completed`
(`workerId`, `success`) i `swarm/history` u odgovoru (`rounds[].results[]` sa `runId`, `status`, `ms`).
**Ograničenje:** `blackboard.artifacts` (stvarni izlazi, do 2000 znakova) **nema HTTP rutu** — vide se samo kroz proces;
za dubinsku analizu sadržaja ide se u `data/` i trace/usage fajlove tenanta.

**7) Odluka: vratiti ili promijeniti pravila.** Vraćanje: `POST /v1/admin/swarm/unfreeze` body `{"level":"contained"}`
ili `{"level":"locked"}` ako istraga traje. Promjena: `POST /v1/admin/swarm/governance/quotas` (`owner`) i/ili
izmjena `config/swarm.json` (`safety.*` pragovi) + **restart** — `safety` settings se čitaju pri konstrukciji
(`createSwarmSafety`) i **ne** mijenjaju se kroz HTTP; kvote se mijenjaju u runtime, ali **globalno** (§6.3).
Ako je sumnja vezana za pozadinske akcije: i nivo 4 iz §7 (`NMQ_SCHEDULER=0`) i/ili tenant suspend.

**8) Obavijesti klijenta ako treba** (obavezna je ako je bilo vanjske komunikacije, novca ili podataka o ljudima).
Šablon (skraćena verzija šablona iz `docs/26` §6, prilagođen roju):

```
Naslov: Obavještenje o incidentu — [kratak opis] — [datum i vrijeme]

1. ŠTA SE DESILO
   [npr. "Roj agenata je 12.11. u 14:05–14:40 izvršio N zadataka pod obrascima koji odstupaju od uobičajenog;
   roj je zamrznut u 14:47." Bez "moguće", bez "potencijalno".]

2. OBIM
   [Broj zadataka, broj workera, period, da li je bilo vanjske komunikacije ili troška. Ako ne znamo tačno:
   "znamo da je najmanje N, tačan broj utvrđujemo".]

3. ŠTA SMO URADILI (i kada)
   ["14:47 zamrznut roj; 15:02 izvezeni audit i swarm logovi; 15:20 karantin za 2 workera; ..."]

4. ŠTA VI TREBA DA URADITE
   [Konkretno: provjeriti [X], ne odgovarati kupcima po šablonu dok ne potvrdimo, javiti nam ako primijetite [Y].]

5. ŠTA ĆEMO URADITI
   [Ispravka (prag/kvote/karantin) + regresioni test + rok. Bez obećanja koje ne možemo ispuniti.]

6. ŠTA NE TVRDIMO
   ["Ne tvrdimo da je uzrok otklonjen dok ne prođe regresioni test i 48 h bez ponavljanja."]

Kontakt: [ime, telefon, mejl]. Izvještaj sa korijenom uzroka: [rok].
```

**9) Zapiši pouku i izmijeni kvote/pragove.** Incident fajl `docs/incidents/YYYY-MM-DD-<slug>.md` sa 5×„zašto",
vlasnikom i rokom za svaku akciju; zatim: (a) novi ili izmijenjen test u `tests/swarm.test.mjs` koji dokazuje da rupa
ne postoji (pravilo iz `docs/26` §6 korak 7); (b) izmjena `config/swarm.json` (pragovi) **ili** `POST …/governance/quotas`
(kvote) **ili** `setIsolation` (nivo); (c) ako je procedura zakazala — izmjena **ovog** dokumenta.
Provjera da nije pokvaren lanac dokaza: `node src/cli.js audit-verify` i `node --test` moraju ostati zeleni.
**Pouka iz koda:** promjena `safety` pragova ne važi bez restarta, a promjena kvota važi odmah **za sve tenante** —
ako je cilj bio „samo ovaj klijent", to se danas ne može.

---

## 9. Šta NIJE pokriveno (iskreno)

1. **Nema cross-node nadzora — sve je single-node.** `governance` drži stanje u jednom procesu
   (`state` + `rateWindows` + `data/_control/swarm.json`), a detekcija radi nad **in-memory** nizovima `claims`/`votes`
   (`safety.js`, cap 5000). Sa više replika: `freeze` se perzistira i druga replika ga vidi **tek poslije restarta**
   (nema watcher fajla), kvote i rate limiti su po replici, a svaka replika vidi samo **svoja** preuzimanja → lockstep
   između replika je **nevidljiv**. Isto važi i za `NMQ_SCHEDULER` (D22: fajl-lease nije distributed lock).
2. **Nema kriptografskog identiteta agenata ni potpisa poruka.** `workerId` je običan runtime id (`uid('wrk')`,
   `src/core/ids.js`); `mediateMessage` ne provjerava da `from` postoji niti da pošiljalac ima pravo da se tako zove
   (§3, rupa 1). Svaka tvrdnja tipa „dokazano je ko je poslao poruku" bila bi **netačna**.
3. **Nema reputacije partnera.** U A2A pregovoru `counterparty` je slobodan string, a `allowedCounterparties` je
   default `['*']` (nalaz iz `docs/26` §2); swarm sloj nasljeđuje taj problem i ne dodaje mu ništa.
4. **Nema detekcije koluzije kroz SADRŽAJ — samo obrasci i forme.** Detektori gledaju: sekvencu preuzimanja,
   broj identičnih glasova, udio preuzimanja, broj feromona i 12 literalnih fraza + entropiju. **Nema** semantičke
   analize, nema LLM sudije, nema poređenja „da li se dva nalaza poklapaju po značenju". Sporazum ispisan prirodnim
   jezikom, koji nije ni „lockstep" ni jedna od 12 fraza, **prolazi**.
5. **Nema formalne verifikacije.** Nijedna invarijanta (npr. „kvota je per-tenant", „zadatak sa `mandate_drift`
   se ne izvršava", „zamrznut roj ne izvršava nijedan run") nije dokazana model-checkingom; dokazi su isključivo
   testovi u `tests/swarm.test.mjs` (20 testova za cijeli v0.4 swarm sloj).
6. **Nema mrežne izolacije na nivou procesa — samo aplikativni sandbox.** `src/core/sandbox.js` sam kaže da nije
   OS-level (nema seccomp/namespaces/gVisor; to je kontejner/K8s, D27), a `canUseNetwork()` iz governance-a **nije**
   spojen na sandbox (§6.4).
7. **Pragovi su heuristički i zaobilaze se „strpljivim tempom".** Konkretno: 40 feromona u 10 min (ne u minuti),
   tokeni ≤ 64 znaka, hex/cifre sa niskom entropijom prolaze (§4.6), glasovi se broje samo kroz `swarm.vote()`,
   lockstep traži ≥ 4 prelaza u prozoru, koncentracija traži ≥ 10 preuzimanja. Roj koji radi malo i polako — ne vidi se.
8. **Nema alerta, retencije ni učitavanja stanja.** `infra/observability/alerts.yml` **ne sadrži** nijedno pravilo sa
   `swarm` (grep: nema poklapanja) → medium nalazi žive samo u `safety.jsonl` i metrici. Nema politike retencije za
   `safety.jsonl`/`messages.jsonl`/`board-*.jsonl` (mogu sadržati tekst kupca iz `task.payload`), a swarm JSONL logovi
   **nisu** hash-chained (za razliku od `audit.jsonl` — `appendJsonl` u `src/core/fsx.js` je običan append).
9. **Nema per-tenant kvota i nema ograničenja broja workera/zadataka** (§6.2, §6.3) — dvije deklarisane kvote
   (`maxWorkers`, `maxTasksOpen`) se ne provjeravaju nigdje.
10. **Nema automatskog pokretanja roja** — swarm nema scheduler/watcher trigger; pokreće se isključivo ljudskom/HTTP
    akcijom (`POST /v1/admin/swarm/tick|run`). To trenutno **smanjuje** rizik „The Collective", ali i znači da
    „roj radi sam" u ovom kodu još nije istina.

---

## 10. Regulativa i dokazivanje

> **Ovo nije pravno mišljenje.** Okvir je preuzet iz `docs/26` §8 (EU AI Act, GDPR); sve što se tiče našeg slučaja
> **provjeriti sa advokatom** prije nego se bilo šta tvrdi klijentu, u upitniku ili u ugovoru.
> Nikad ne pisati „EU AI Act compliant", „GDPR compliant", „SOC 2", „pen-tested".

**Šta od ovoga pomaže kod EU AI Act Article 50 (transparentnost) i human oversight-a:**

| Zahtjev (duh) | Šta stvarno imamo u swarm sloju | Kako se dokazuje | Iskreno ograničenje |
|---|---|---|---|
| **Art. 50 — transparentnost** (da se zna da je AI i šta radi) | Widget prikazuje korake/alate/cjenu (postoji od ranije); swarm **ne** komunicira sa krajnjim kupcem — on proizvodi zadatke koje izvršavaju agenti kroz isti orchestrator | `public/widget/nmq-robot.js`; tragovi u `data/tenants/<id>/traces/` | Roj nema svoj kanal prema kupcu, pa nema ni nove obaveze — **ali** nema ni oznake „ovo je pripremio roj agenata" u internim izvještajima. Ako klijent objavljuje AI sadržaj, obaveza je **njegova** (deployer) i mora stajati u ugovoru |
| **Art. 12/19 — record-keeping i logovi** | Hash-chained audit pokriva **odluke**: `swarm_incident`, `swarm_incident_resolved`, `swarm_freeze`, `swarm_unfreeze`, `swarm_isolation_set`, `swarm_quotas_set`, `swarm_run` (`audit.append` u `governance.js`, `safety.js`, `swarm.js`) | `node src/cli.js audit-verify` → lanac OK; `tests/swarm.test.mjs` provjerava prisustvo `swarm_freeze` i `swarm_quotas_set` u auditu | **Radni** logovi roja (`board-*.jsonl`, `safety.jsonl`, `messages.jsonl`) **nisu** u hash lancu i nemaju retenciju → ne mogu se ponuditi kao neoboriv dokaz, samo kao operativni trag |
| **Art. 14 — ljudski nadzor i „stop dugme"** | Freeze/izolacija/kvote/RSI nivo traže rolu **`owner`** (HTTP rute u `routes-swarm.js`); agent ključ **ne može** zamrznuti roj (dokazano: 403 u `tests/swarm.test.mjs`); freeze je perzistentan i preživljava restart | Test „freeze … preživljava restart"; test rola u HTTP sekciji | Freeze ne zaustavlja run u toku, ne zaustavlja scheduler poslove, a **autonomija L0/L1 ne zaustavlja roj** (§7, nivo 5) — „stop dugme" mora biti freeze/izolacija, ne autonomija |
| **Art. 26 — obaveze deployer-a (klijenta)** | Klijent dobija: izvoz incidenta, izvoz poruka, izvoz table, audit lanac i kill switch proceduru (§8) | Ovaj dokument + `docs/26` §5–§6 | Bez ugovorne obaveze klijenta da gasi roj i čuva logove, ovo ostaje naša dobra volja |
| **Enterprise due diligence** (audit lanac, incidenti, kill switch, izolacija po tenantu) | Ima: audit lanac sa verifikacijom, tabela incidenata, testirani kill switch, izolacioni nivo **po tenantu** | `node src/cli.js audit-verify`, `tests/swarm.test.mjs` | **Izolacija po tenantu važi za nivo, ne za kvote** (§6.3) — u upitniku se smije tvrditi „izolacija nivoa po tenantu", a **ne** „kvote i budžet po tenantu". Nema pen-testa, nema SOC 2, nema cross-node nadzora (§9) |

**Za GDPR/DPA:** `task.payload` i `messages.jsonl` mogu sadržati lične podatke iz klijentskih procesa.
Prije prvog plaćenog pilota: upisati ta dva fajla u ROPA-u, odrediti rok čuvanja i način brisanja
(danas **ne postoji** retention ni brisanje po subjektu za swarm logove) — i **provjeriti sa advokatom**.

---

## 11. Roadmap sigurnosti

> Svaka faza ima **dokaz da radi** — test, fajl ili mjerenje. Faza bez dokaza nije faza, nego želja.

| Faza | Šta se dodaje | Dokaz da radi |
|---|---|---|
| **S1 — kvote po tenantu + dvije mrtve kvote** | `quotas` postaje `Map` po `tenantId` (ili `state.quotas[tenantId]` sa fallback-om na default); provjera `maxWorkers` u `registerWorker()` i `maxTasksOpen` u `postTask()`; perzistencija kvota | Novi test: `setQuotas('nmq', {maxRunsPerTick: 2})` **ne** mijenja `describe('demo-shop')`; `registerWorker` baca `PolicyError` na 13. workeru (config 12); `postTask` baca na 201. otvorenom zadatku |
| **S2 — mrežna granica spojena na izolaciju** | `governance.canUseNetwork(tenantId)` se poziva u putu izvršavanja alata (uz `sandbox.assertNetwork`): `contained`/`locked`/`frozen` → nema egress-a, bez obzira na allowlistu; ukloniti netačan komentar u `src/index.js` ili ga zamijeniti kodom | Test: sa sandbox allowlistom `['example.com']` i izolacijom `contained`, `http_fetch` baca `PolicyError`; sa `open` prolazi (mock) |
| **S3 — identitet i potpis poruka** | Per-worker ključ (HMAC) ili potpis kroz postojeći per-agent ključ (`nmqa_…`, D25); `mediateMessage` provjerava (a) da `from` postoji u registru workera, (b) da potpis odgovara `from`; `humanReadable:false` se uklanja ili traži `owner` | Test: `mediateMessage({from:'wrk_tudji'})` bez potpisa → `PolicyError`; sa potpisom → prolazi; lažni `from` → 403/`PolicyError` |
| **S4 — inspekcija sadržaja na tabli i u artefaktima** | `inspectPayload` se primjenjuje i na `task.payload` (svi kodovi, ne samo `mandate_drift`) i na `artifact.result`; `high` nalaz **blokira** `claim()`/`complete()`; semantika: `detect()` filtrira po `state !== 'done'` da se stari nalazi ne ponavljaju | Test: zadatak sa base64 blobom se **ne** može preuzeti (`encoded_blob`); završen sumnjiv zadatak se ne prijavljuje dvaput; artefakt sa kontrolnim znacima → nalaz |
| **S5 — perzistencija incidenata i karantina + alerti** | `incidents`/`quarantined` se upisuju u `data/tenants/<id>/swarm/incidents.jsonl` i `quarantine.json` i **učitavaju** na startu; Prometheus pravila za `swarm_incidents_total{severity="high"}` i `swarm_findings_total{type="collusion_lockstep"}`; retencija swarm logova | Test: robot 1 otvori incident i karantin → robot 2 na istom `dataDir` ih vidi; `infra/observability/alerts.yml` sadrži `NmqSwarmIncidentHigh` (i pravilo je lint-ovano) |
| **S6 — cross-node nadzor** | Roj prestaje biti single-node: `claims`/`votes` i governance stanje idu kroz zajednički store (Redis/Postgres) ili se usvaja „jedna replika za roj" uz **distributed lock** (nadogradnja D22); freeze se propagira kroz zajedničko stanje, ne kroz fajl | Chaos test sa 2 procesa: koluzija između replika se detektuje; `freeze` na replici A zaustavlja tick na replici B bez restarta; dokaz: nijedan tick nije izvršen poslije freeze-a na nijednoj replici |
| **S7 — reputacija i granice partnera** | `allowedCounterparties` bez `['*']` u produkciji; reputacija partnera (istorija ishoda, odbijanja, spori pregovori) i njeno korištenje u A2A granicama | Test: partner van allowliste → `PolicyError`; partner sa istorijom prevara → `requireHumanAboveUsd` se obara na niži prag |
| **S8 — chaos i canary izolacija za koluziju** | `tests/security/collusion.test.mjs`: skriptovani „koludirajući" workeri (naizmjenično preuzimanje, identično glasanje, flooding) koji **moraju** biti detektovani; canary izolacija za tenanta (poseban proces/namespace) kao mjesto gdje se sumnjivi roj pušta da se posmatra bez uticaja na produkciju | Test suite zelen na svakom commit-u; canary tenant ima odvojen `dataDir` i dokaz da ne vidi produkcijske zadatke (`claim` vraća `null` za tuđe zadatke — već važi, ali se mora testirati za canary) |
| **S9 — eksterni pen-test** | Red-team roja: pokušaji (a) lažnog `from`, (b) covert channel-a bez fraza i sa niskom entropijom, (c) postepenog floodinga ispod praga, (d) izlaska iz `contained` | Pisani nalaz + zatvorene stavke sa testovima; **do tada se nigdje ne tvrdi** „pen-tested" |

---

## Otvorena pitanja

1. **Šta je ispravna semantika lockstep-a za roj od dva workera?** Danas dva workera po definiciji daju `share = 1.0`
   i `high` incident (§4.1). Da li uvodimo minimalan broj workera (npr. ≥ 3), `orderDominance` kao uslov, ili
   „koluzija" zahteva da par drži posao **i** da mu kvalitet opada?
2. **Da li je „samo incident, bez auto-akcije" prihvatljivo za `high` koluziju?** Kod podržava `autoAction: {type:'freeze'}`
   u `openIncident()`, ali ga nijedan pozivalac ne koristi (§5). Koja je najmanja automatska akcija koja ne može naškoditi
   (karantin **para**? zamrzavanje **tenanta**? samo obavještenje sa obaveznim potpisom čovjeka u 15 min)?
3. **Kvote: per-tenant ili zajednička ekonomija?** Danas je jedan objekat za sve (§6.3). Ako se razdvaja — ko plaća
   `maxCostPerHourUsd` i da li jedan klijent smije svojim kvotama da „pojede" kapacitet drugom?
4. **Kako detektovati koluziju kroz sadržaj, a da sudija ne postane nova meta?** LLM sudija unutar `detect()` unosi
   trošak, latenciju i sopstveni surface za prompt injection; da li je prihvatljivo da sudija radi **asinhrono** (offline
   analiza `messages.jsonl`/`board-*.jsonl`) i da samo proizvodi nalaze bez automatske akcije?
5. **Karantin i incidenti: perzistirati ili ne?** Danas se gube restartom (§5). Ako se perzistiraju — kako se rješava
   „zaboravljen karantin" (worker koji nikad nije pušten) i ko ga smije pustiti bez novog incidenta?
6. **Koji od swarm logova su lični podaci i koliko se čuvaju?** `task.payload`, `messages.jsonl` i `artifact.output`
   mogu sadržati tekst kupca; danas nema retention-a, nema brisanja po subjektu i nema potpisa zapisa. Prije prvog
   plaćenog pilota: odluka o retenciji, upis u ROPA i — **provjeriti sa advokatom**.
