# 31 — RSI meta-arhitektura: kako sistem poboljšava način na koji se poboljšava

> **Nivo:** v0.4 (RSI meta-nivoi R0–R5) · **Kod:** `src/rsi/meta.js` (353 linije), `config/rsi.json`,
> `src/eval/harness.js` (192), `src/evolution/genome.js` (326), `src/learning/selfplay.js` (231),
> `src/learning/improvements.js` (361), `src/core/autonomy.js` (157), `src/learning/rsi.js` (184, v0.3)
> · **Rute:** `src/server/routes-swarm.js` (sekcija *RSI META*) · **Testovi:** `tests/swarm.test.mjs`
> (3 testa za RSI meta: „nivo mijenja samo board", „kapije blokiraju akcije iznad nivoa", „R3/R4/R5")
> · **Init:** `src/index.js` (seed iz `config/rsi.json` u `data/tenants/<id>/rsi/level.json`)
> · **Vezani dokumenti:** `docs/23` (v0.3 RSI — analiza i prijedlozi), `docs/21` (prijedlozi, odobrenje, A/B,
> rollback), `docs/22` (self-play), `docs/20` (autonomija L0–L4), `DECISIONS.md` **D42**, **D46**, **D47**
> · **Napomena o brojevima dokumenata:** `src/rsi/meta.js` u komentarima i `config/evolution.json`/
> `config/swarm.json` referenciraju `docs/32` i `docs/33` — **ta dva fajla ne postoje** u `docs/` (postoji 00–28
> i `DECISIONS.md`). Reference su namjera za buduće dokumente, ne izvor činjenica.

> **Jedna rečenica:** v0.3 je odgovarao na pitanje „**šta** treba popraviti"; v0.4 uvodi nivo na kojem sistem
> odgovara i na pitanje „**kako** se popravlja" — ali svaki odgovor ostaje **prijedlog**, jer nivo mijenja
> isključivo board i to je u kodu, ne u proceduri.

> **Status verzije (provjereno u kodu):** `src/index.js` deklariše `export const VERSION = '0.3.1'`, dok su
> moduli opisani ovdje (swarm, governance, safety, evolucija, `src/rsi/meta.js`) već u kodu i `config/*.json`
> ih zove „v0.4". To razilaženje je **poznato** i ne mijenja ništa u ovom dokumentu — ali ga ne treba
> prećutati: dokument opisuje kod, ne broj u konstanti.

---

## 1. Definicija i razlika od v0.3

### 1.1 Šta v0.3 (`src/learning/rsi.js`) stvarno radi

`createRsi()` ima tri funkcije: `analyze`, `propose`, `cycle` (+ `impact`):

| Korak | Kod | Ulaz | Izlaz |
|---|---|---|---|
| `analyze(tenantId, { sinceDays: 7 })` | `rewards.ranking` (agent, pattern), `tracer.readFromDisk` (greške alata, runovi sa greškom), `goals.portfolio().atRisk` | **naši rezultati rada** | `findings[]` sa `id`, `severity`, `area`, `subject`, `message`, `evidence`, `suggestedKind` |
| `propose(tenantId, { findings })` | `improvements.createProposal` | nalazi | prijedlozi (`kind`, `target`, `rationale`, `evidence`, `riskLevel`, `proposed: null`) |
| `cycle()` | `analyze` → `propose` + audit `rsi_cycle` | sve | nalazi + prijedlozi |
| `impact(tenantId, proposalId)` | `rewards.recent` prije/poslije `appliedAt` | primijenjen prijedlog | `delta`, verdikt |

Ključno: v0.3 **gleda rezultate rada** (nagrade, trace, ciljeve) i **predlaže izmjene artefakata** (prompt,
pattern, KB, politika, alat). Nema pojma „nivoa", nema eksperimenta, nema mjerenja kandidata. Pragovi su
fiksni (`n >= 3`, `avgReward < 0.5`), a `proposed` je `null` — čovjek ili self-play ga dopunjuje.

### 1.2 Šta v0.4 (`src/rsi/meta.js`) dodaje

| Sposobnost | v0.3 `rsi.js` | v0.4 `rsi/meta.js` |
|---|---|---|
| Izvor podataka | nagrade, trace, ciljevi | **sopstveni research log** (`rsi/research-YYYY-MM.jsonl`) + eval harness |
| Jedinica rada | nalaz (`finding`) | **nivo** (R0–R5) i **eksperiment** (`rxp_…`) sa kandidatima |
| Kapija prije radnje | nema (samo `requiresHuman` na prijedlogu) | `assertCan(level, action)` — **nivo + autonomija** |
| Mjerenje | `impact` (prije/poslije, iz produkcijskih nagrada) | `runExperiment` — **isti zlatni set za sve kandidate**, fitness, lift, verdikt |
| Odluka o promjeni | čovjek odobrava prijedlog | čovjek odobrava **i nivo** (board) i prijedlog (`improvements.decide`) |
| Predmet poboljšanja | artefakt (prompt/KB/pattern) | artefakt **i sam proces** (težine strategija, sadržaj zlatnog seta) |

### 1.3 Šta je „meta", a šta nije (iskreno)

**Jeste meta (u kodu):**

- `designExperiment` — sistem **bira strategiju** iz `strategySpace` i **pravi kandidate** (R2).
- `metaImprove` — sistem analizira **svoj** research log, rangira **strategije po prosječnom liftu** i predlaže
  promjenu težina strategija + proširenje zlatnog seta (R5). Ovo je jedini dio koji cilja **proces**, ne artefakt.
- `acquireExperience` — sistem **sebi pravi** iskustvo (self-play scenariji) umjesto da čeka saobraćaj (R3).

**Nije meta (iako se lako pobrka s njim):**

| Nešto što izgleda kao meta | Šta je stvarno | Zašto nije meta |
|---|---|---|
| `runExperiment` | **mjerenje** kandidata kroz postojeći eval harness | Ne mijenja način mjerenja; koristi `evalHarness.run` kao i evolucija |
| `promote` | **prijedlog prompta** (`improvements.createProposal`) | Predmet je `systemPrompt` agenta, tj. artefakt — isti kanal kao v0.3 `propose` |
| `adaptEnvironment` | prijedlog `prompt`/`kb` sa novim domenom/jezikom | Mijenja **okruženje rada**, ne proces poboljšavanja |
| `autoMetaPromote` | **mrtva zastavica** (vidi §6.4) | Postoji u configu i u izlazu `status`, ali **nijedan `if` je ne čita** |
| evolucija (`src/evolution/genome.js`) | paralelni mehanizam (populacija, mutacija, križanje) | RSI je **ne koristi** za pretragu; zove samo `genomeOf`, `evaluate`, `patchOf`, `settings` |

Dakle: **meta u ovom projektu znači „nivo i proces", a ne „sistem koji prepisuje sebe".** Kod ne piše kod;
jedina „meta-promjena" koja se stvarno predlaže je promjena **težina strategija** i **sadržaja eval seta** —
i to kao `kind: 'code'` prijedlog koji čovjek implementira ručno.

---

## 2. Pet nivoa autonomije poboljšavanja

Nivoi su definisani kao **podatak** u `RSI_LEVELS` (`src/rsi/meta.js`, `RSI_LEVELS`):

```js
R0: { rank: 0, name: 'none', can: [], requiresAutonomy: 'L0', human: false },
R1: { rank: 1, name: 'improvement-execution', can: ['execute_improvement', 'run_experiment'], requiresAutonomy: 'L2', human: false },
R2: { rank: 2, name: 'improvement-strategy',  can: [..., 'design_experiment'], requiresAutonomy: 'L3', human: false },
R3: { rank: 3, name: 'experience-acquisition', can: [..., 'acquire_experience'], requiresAutonomy: 'L3', human: false },
R4: { rank: 4, name: 'environment-adaptation', can: [..., 'adapt_environment'], requiresAutonomy: 'L4', human: true },
R5: { rank: 5, name: 'recursive-meta-improvement', can: [..., 'meta_improve'], requiresAutonomy: 'L4', human: true },
```

`can` je **kumulativan** (R5 sadrži sve akcije R1–R4), a `assertCan(level, action)` baca `PolicyError` ako
akcija nije u listi. Naziv kolone „šta je u kodu danas" opisuje **stvarnu implementaciju funkcije**, ne namjeru.

| Nivo | Ime | Šta smije | Tražena autonomija | Traži čovjeka | Šta je u kodu danas |
|---|---|---|---|---|---|
| **R0** | none | ništa — ni izvršenje | L0 | ne | `can: []`; sve akcije padaju na `assertCan`. **`run_experiment` je i na R0 zabranjen** (za razliku od R1) |
| **R1** | improvement-execution | izvršiti **već dizajniran** eksperiment, predložiti promociju pobjednika | L2 | ne (`human: false`) | `runExperiment` (eval sa `specPatch` po kandidatu) + `promote` (kapija lifta → `improvements.createProposal`) |
| **R2** | improvement-strategy | **sam izabrati strategiju** i sastaviti kandidate | L3 | ne | `designExperiment`: `strategy ?? cfg.strategySpace[random]`, kandidati iz mutabilnih polja genoma |
| **R3** | experience-acquisition | **sam pribaviti iskustvo** (self-play scenariji) | L3 | ne | `acquireExperience` → `selfplay.run({ rounds, solverAgent, domain, difficulty: 2 })`; dataset ostaje u tenantu |
| **R4** | environment-adaptation | predložiti prilagođavanje **okruženja** (domain/language/kb/tools) | L4 | **da** (`human: true`) | `adaptEnvironment` → prijedlog `kb` (za `kb`) ili `prompt` (za ostalo); rizik `high` samo za `tools` |
| **R5** | recursive-meta-improvement | predložiti izmjenu **samog procesa** | L4 | **da** | `metaImprove`: rangiranje strategija po prosječnom liftu + predlog proširenja zlatnog seta → `kind: 'code'` prijedlozi |

**Tri stvari koje tabela otkriva, a koje vrijedi naglasiti:**

1. **R2 i R3 su na istoj autonomiji (L3), ali nisu na istoj „težini"** — R2 bira strategiju, R3 troši novac na
   self-play cikluse. U kodu je to samo redoslijed nivoa; nema nezavisne kapije za trošak.
2. **R4/R5 traže L4, a `human: true`.** Dakle autonomija L4 („smije i srednji rizik") **ne znači** da nivo
   prelazi bez čovjeka: `setLevel` traži board, a `human` se upisuje u audit kao `decision: 'require_approval'`.
3. **Nema nivoa za „auto-apply".** Ni R5 ne primjenjuje ništa; najviši nivo znači „smije predložiti izmjenu
   procesa", ne „smije je izvesti". To nije propust nego odluka (D46) — obrazloženje u §11.

---

## 3. Kapije (najvažniji dio)

### 3.1 Kako `setLevel` provjerava autonomiju

```js
async setLevel(tenantId, level, { by = 'board', reason = null } = {}) {
  if (!RSI_LEVELS[level]) throw new ValidationError(`Nepoznat RSI nivo: ${level} …`);
  const info = RSI_LEVELS[level];
  if (info.requiresAutonomy && autonomy?.levelOf) {
    const current = autonomy.levelOf(tenantId, null);              // ⚠️ nivo TENANTA, ne agenta
    const rank = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
    if ((rank[current] ?? 0) < (rank[info.requiresAutonomy] ?? 0)) {
      throw new PolicyError(`RSI ${level} traži autonomiju najmanje ${info.requiresAutonomy} (tenant je na ${current})`, …);
    }
  }
  // ... upis level.json + history (zadnjih 30 zapisa) + metrika + audit
}
```

Redoslijed je bitan i **ne može se preskočiti**: prvo autonomija, pa RSI nivo. Test u `tests/swarm.test.mjs`
to i tvrdi: `demo-shop` je na L1, pa `setLevel('demo-shop','R2')` baca `PolicyError`; za `nmq` isti poziv
prolazi **tek poslije** `autonomy.setLevel('nmq', null, 'L3')`. Praktično: **kapija se „otvara" odozdo** —
autonomija je pod, RSI nivo je nadgradnja.

Kapije po akciji (iz `can` liste, `assertCan`):

| Akcija | Minimalni RSI nivo | Efekat ako nije dozvoljeno |
|---|---|---|
| `run_experiment` | **R1** | `PolicyError` — ni mjerenje nije dozvoljeno |
| `execute_improvement` (promocija) | **R1** | `PolicyError` — prijedlog se ne otvara |
| `design_experiment` | **R2** | `PolicyError` — sistem ne smije sam birati strategiju |
| `acquire_experience` | **R3** | `PolicyError` — nema self-play ciklusa |
| `adapt_environment` | **R4** | `PolicyError` — nema prijedloga za domen/jezik/KB/alate |
| `meta_improve` | **R5** | `PolicyError` — nema meta-analize procesa |

### 3.2 Zašto nivo mijenja ISKLJUČIVO board

- **Nivo nije sposobnost, nego ovlaštenje.** Sposobnost je u kodu; nivo određuje **koliko rizika tenant
  prihvata**. Ako bi sistem mogao sam sebi podići nivo, kapija ne bi bila kapija (D38, D46).
- **`setLevel` je jedina funkcija koja dira `level.json`.** Nema druge putanje koja mijenja nivo; seed iz
  `config/rsi.json` u `src/index.js` ide **kroz isti poziv** (`by: 'config'`), pa i on prolazi kapiju autonomije
  — i ako ne prođe, samo se loguje `rsi.seed_failed` (`catch`), nivo tenanta ostaje nepromijenjen.
- **Seed je jednokratan.** Uslov u `index.js` je `if (current.level !== level && !current.changedBy)`. Prvi
  `setLevel` postavlja `changedBy`, pa config **ne pregazi** odluku boarda pri sljedećem restartu. Config je
  početna vrijednost, ne izvor istine.
- **Ruta traži rolu `owner`.** `POST /v1/admin/rsi/level` ima `requiredRole: 'owner'`; `GET /v1/admin/rsi`
  traži samo `read`. Dakle nivo ne može podići ni `admin` ključ, a kamoli agent ključ.

### 3.3 Šta se auditira i šta ostaje na disku

| Artefakt | Putanja / polje | Sadržaj |
|---|---|---|
| Stanje nivoa | `data/tenants/<id>/rsi/level.json` | `{ level, since, changedBy, history: [...zadnjih 30] }` |
| Istorija promjena | isto, `history[]` | `{ level, by, reason, ts }` — stariji zapisi se odbacuju (`slice(-30)`) |
| Audit | `data/tenants/<id>/audit/audit.jsonl` | `action: 'rsi_level_changed'`, `decision: info.human ? 'require_approval' : 'allow'`, `outcome: 'ok'`, `args: { level, reason, requiresHuman }` |
| Metrika | Prometheus | `rsi_level_changes_total{tenant,level}` |
| Log | aplikativni log | `logger.warn('rsi.level_changed', …)` — **warn**, jer je promjena nivoa bezbjednosni događaj |
| Istraživački trag | `data/tenants/<id>/rsi/research-YYYY-MM.jsonl` | zapisi tipa `experiment_designed`, `experiment_completed`, `promotion_proposed`, `experience_acquired`, `environment_adaptation_proposed`, `meta_improvement` |

Cache nivoa je **in-memory** (`cache = new Map()`): u jednom procesu nema ponovnog čitanja fajla, a drugi
proces ne bi vidio izmjenu. To je u redu za jednu repliku (isto ograničenje kao fajl-lease, D22), ali je
pretpostavka koju treba znati.

### 3.4 Primjer: tenant na L2 ne može dobiti R2 (i to je dobra vijest)

Uzmimo tenant sa autonomijom **L2 (supervised)**. Board pokuša:

```
POST /v1/admin/rsi/level   { "level": "R2", "reason": "želimo auto-dizajn eksperimenata" }
→ 403 PolicyError: "RSI R2 traži autonomiju najmanje L3 (tenant je na L2)"
```

**Zašto je to dobra vijest, a ne bug:**

1. **R2 znači da sistem sam bira šta će mjeriti.** To troši budžet (svaki kandidat = pun zlatni set kroz LLM)
   i pomjera fokus kvaliteta bez ljudskog odabira. Tenant na L2 je izričito rekao „srednji rizik traži
   odobrenje" — automatsko dizajniranje eksperimenata je upravo aktivnost koju je taj nivo isključio.
2. **Kapija ne dozvoljava „preskakanje" kroz config.** Isti tenant ne može dobiti R2 ni seed-om iz
   `config/rsi.json` — seed ide kroz `setLevel` i tiho padne u `rsi.seed_failed`. Nema zaobilaznog puta.
3. **Redoslijed je jedini ispravan.** Da bi tenant dobio R2, board mora **svjesno** podići autonomiju na L3
   (što je druga auditovana odluka, `autonomy_level_changes_total`), pa tek onda RSI nivo. Dvije odluke,
   dva audit zapisa, dvije odgovornosti — umjesto jednog „uključi RSI".
4. **Obrnuto važi isto.** Tenant na L4 može dobiti R5, ali i tada je `human: true` u auditu
   (`decision: 'require_approval'`) — kapija autonomije je **nužan, ne dovoljan** uslov.

**Test dokaz:** `tests/swarm.test.mjs` → „RSI: nivo mijenja samo board i traži odgovarajuću autonomiju"
(demo-shop L1 → `setLevel('R2')` baca `PolicyError` sa porukom koja sadrži „traži autonomiju").

### 3.5 Dvije zamke kapije koje treba znati

1. **`autonomy.levelOf(tenantId, null)` gleda nivo tenanta, ne agenta.** Ako tenant ima `"*": "L2"`, a
   `"sales": "L3"`, RSI nivo se mjeri po **L2** i R2 je blokiran — iako agent `sales` ima L3. Kapija je
   namjerno na nivou tenanta (RSI nivo je svojstvo tenanta), ali to znači da per-agent autonomija **ne pomaže**
   pri podizanju RSI nivoa.
2. **Nivo se može i spustiti bez ikakve provjere „da li je bezbjedno".** `setLevel('R0')` prolazi (R0 traži L0,
   a svaki tenant ima ≥ L0). Nema dokumentovanog postupka za posljedice povlačenja nivoa (npr. šta sa
   eksperimentima u toku) — vidi *Otvorena pitanja*.

---

## 4. Auto-dizajn eksperimenta

### 4.1 `designExperiment` — tok

```js
async designExperiment(tenantId, { agentId, goal = 'povećati prolaznost na zlatnom setu', strategy = null, caseIds = null }) {
  assertCan(state.level, 'design_experiment');                    // R2+
  const spec = catalog.get(agentId, tenantId); if (!spec) throw new ValidationError(`Nepoznat agent: ${agentId}`);
  const chosen = strategy ?? cfg.strategySpace[Math.floor(Math.random() * cfg.strategySpace.length)];
  const base = evolution.genomeOf(tenantId, agentId);             // mutabilna polja iz spec-a agenta
  const candidates = [ /* po strategiji, vidi tabelu */ ];
  return { id: uid('rxp'), ts, tenantId, agentId, goal, strategy: chosen, caseIds,
           status: 'designed', designedBy: `rsi:${state.level}`,
           candidates: candidates.slice(0, cfg.maxCandidates).map((g, i) => ({ label: `${chosen}-${i + 1}`, genome: { ...g, tenantId } })) };
}
```

Nekoliko detalja koji se lako previde:

- **Nasumičan izbor strategije** je `Math.random()`, bez seed-a i bez ponderisanja. `metaImprove` (R5) predlaže
  **promjenu težina strategija**, ali te težine **ne postoje u kodu** — predlog je tekst za čovjeka.
- **`goal` se nigdje ne koristi** osim kao zapis u eksperimentu i research log-u. Nema funkcije cilja u pretrazi.
- **`caseIds` se prosleđuje** u `runExperiment`, pa izbor slučajeva može biti usko grlo (vidi §5.4).
- **Baza je jedan genom**, ne populacija: svi kandidati su varijacije **jednog** polazišta, bez križanja i bez
  mutacije više koraka. Evolucioni motor (`mutate`, `crossover`, `evolve`) **nije uključen** u RSI putanju.

### 4.2 Prostor strategija i kandidati (`strategySpace`)

`config/rsi.json` → `"strategySpace": ["prompt", "temperature", "maxTokens", "pattern", "self-play", "retrieval"]`.

| Strategija | Kandidati koje kod stvarno pravi | Šta mjeri (`runExperiment` → eval harness) |
|---|---|---|
| `prompt` | 2: `promptMutations[0]`, `promptMutations[1]` kao `systemPromptSuffix` | Da li dodatna instrukcija u system promptu prolazi više provjera na zlatnom setu (`passRate`) i koliko košta |
| `temperature` | 3: `0`, `0.4`, `0.8` | Stabilnost/nedeterminizam: niža temperatura obično diže `mustNotInclude`, viša može pokvariti `expectStatus` |
| `maxTokens` | 2: `400`, `1200` | Da li je odgovor odsječen (`maxTokens: 400`) ili plaća više tokena bez dobitka (`1200`) — vidi se kroz `costUsd` u fitness-u |
| `pattern` | 3: `evolution.settings.patterns.slice(0, 3)` kao `defaultPattern` (`agent`, `reflection`, `sequential`) | Da li drugi pattern daje bolji odnos prolaznosti i troška **na istim pitanjima** |
| `self-play` | 2: **bazni genom** + `promptMutations[2]` (grana `else`) | Ništa specifično za self-play — ime strategije ne odgovara sadržaju |
| `retrieval` | 2: **bazni genom** + `promptMutations[2]` (grana `else`) | Isto; nema RAG poluge (npr. `k`, filter, rerank) uopšte |

**Iskrene posljedice:**

1. **Dvije od šest strategija su „mrtve".** `self-play` i `retrieval` padaju u `else` granu i prave **identične**
   kandidate (isti bazni genom + isti `promptMutations[2]`) kao svaka druga nepoznata vrijednost. Prostor
   strategije je time efektivno **4**, ne 6 — a `metaImprove` će ih rangirati kao da su 6.
2. **`promptMutations` je lista od 6 stringova** (`DEFAULT_EVOLUTION`), a RSI koristi indekse `[0]`, `[1]`,
   `[2]` — dakle **3 od 6** postojećih mutacija, uvijek iste. Nema rotacije ni slučajnosti.
3. **`cfg.maxCandidates = 6` nikad se ne aktivira** — najveći broj kandidata iz bilo koje grane je 3. Ograničenje
   postoji, ali trenutno ne ograničava ništa.
4. **Nema validacije prostora strategija u `designExperiment`.** Nepoznata strategija (npr. `"fine-tune"`) ne
   baca grešku — tiho ulazi u `else` granu. Za razliku od `environmentTargets`, gdje nepoznat target **jeste**
   `ValidationError`. Kapija za strategije je propuštena.

---

## 5. Izvršenje i mjerenje

### 5.1 `runExperiment` — tok i veza sa eval harness-om

```js
for (const candidate of experiment.candidates) {
  const evaluated = await evolution.evaluate(tenantId, candidate.genome, { setName, caseIds, maxCases });
  results.push({ label, genome, fitness, passRate, costUsd, failures });
}
results.sort((a, b) => b.fitness - a.fitness);
const base = baseline ?? (await evolution.evaluate(tenantId, evolution.genomeOf(tenantId, experiment.agentId), {...})).fitness;
const lift = Number((winner.fitness - base).toFixed(4));
const verdict = lift >= cfg.minLift ? 'poboljšanje' : lift <= -cfg.minLift ? 'pogoršanje' : 'bez promjene';
```

`evolution.evaluate` (`src/evolution/genome.js`) radi tri stvari: `assertSafe(genome)` (zabranjena polja),
`patchOf({ ...genome, tenantId })` i `evalHarness.run(tenantId, { name, caseIds, maxCases, specPatch })`.

**`specPatch` po runu je suština:** `harness.run` prosleđuje patch u `orchestrator.run({ options: { …, specPatch } })`
za **svaki** slučaj. Katalog agenata se **ne mijenja** — kandidat živi samo u tom runu. Zato je bezbjedno
mjeriti 3 kandidata u istoj sekundi, i zato se „A/B po runu" iz `docs/21` i RSI eksperiment poklapaju u istoj
mehanici (`improvements.createExperiment` koristi isti `specPatch` kanal).

### 5.2 Fitness nije isto što i prolaznost

```
fitness = passRate − costPenaltyPerUsd × costUsd − latencyPenaltyPerSecond × (avgDurationMs/1000) − failures × 0.01
```

Sa defaultima iz `DEFAULT_EVOLUTION` (`costPenaltyPerUsd: 5`, `latencyPenaltyPerSecond: 0.002`) i kandidatom od
6 slučajeva: run koji košta 0.01 USD i traje 20 s nosi kaznu `0.05 + 0.04 + 0.06 = 0.15` — dok je
**kapija lifta 0.03**. Praktično: **kandidat sa boljom prolaznošću može izgubiti od jeftinijeg i bržeg**, a
verdikt se računa na **fitness-u**, ne na `passRate`. To je namjerno (mjeri se „kvalitet po cijeni"), ali
znači da RSI prijavljuje „bez promjene" i kad se prolaznost **popravila**, a trošak porastao.

Uz to, `runExperiment` u `results[]` čuva `fitness`, `passRate`, `costUsd`, `failures` — **ne i `avgDurationMs`**.
Latentna kazna je u fitness-u, ali se u izvještaju ne vidi koliko je iznosila.

### 5.3 Baseline, lift i verdikt

| Pojam | Kako se dobija | Napomena |
|---|---|---|
| `baselineFitness` | `evolution.evaluate` na `genomeOf(tenantId, agentId)` — **trenutni agent iz kataloga** | Ako je proslijeđen `baseline`, koristi se on; inače se mjeri **poslije** kandidata |
| `lift` | `winner.fitness − baselineFitness`, zaokruženo na 4 decimale | Raspon je realno mali; `toFixed(4)` je finiji od šuma |
| Verdikt | `lift ≥ minLift` → poboljšanje; `lift ≤ −minLift` → pogoršanje; inače bez promjene | `minLift` default `0.03` |
| `winner` | prvi poslije `sort` po `fitness` | Nema provjere **statističke značajnosti** ni ponavljanja mjerenja |

### 5.4 Zašto je isti zlatni set za sve kandidate **uslov** poređenja

`harness.run` je deterministički u pogledu **skupa slučajeva**: `set.cases.filter(!!caseIds).slice(0, maxCases)`
— dakle isti upit, isti `agentId`, iste `checks` za svakog kandidata. To je jedina stvar koja poređenje čini
smislenim:

1. **Razlika u `passRate` pripada kandidatu, ne setu.** Da kandidat A ide na 8 lakših, a B na 12 težih
   slučajeva, `lift` bi mjerio razliku u setu, a ne u kandidatu.
2. **Nema treninga na testu.** Zlatni set je fiksan i verzionisan u repou (`eval/<tenantId>.json`) — kandidati
   se **ocjenjuju** na njemu, ne treniraju. To je i razlog zašto `docs/23` §10.3 traži da self-play scenariji
   iz zlatnog seta budu **holdout**.
3. **Trošak je uporediv.** `costUsd` po kandidatu ima smisla samo ako su pitanja ista.

**Ali — iskreni problemi istog seta:**

| Problem | Dokaz iz koda | Posljedica |
|---|---|---|
| **Rezolucija veća od kapije** | Zlatni set `nmq` ima **6 slučajeva** (`eval/nmq.json`), pa je `passRate` korak **0.1667**. Putanja ruta koristi `maxCases: 6`, `runExperiment` default `8` | Prag `minLift = 0.03` je **pet puta manji** od jednog slučaja. „Lift 0.167" = jedan slučaj se preokrenuo — nije dokaz kvaliteta |
| **Set pokriva 6 od 19 agenata** | `config/agents/` ima **19** fajlova; `eval/nmq.json` cilja `support`, `ecommerce`, `finance`, `sales`, `router` — **6 agenata**, od toga 2 slučaja za `support` | Eksperiment na `creative`, `dev`, `legal`… mjeri **istim** setom koji tog agenta ne testira (kod `router` slučaja agent je `null`, pa odlučuje ruter) → `lift ≈ 0`, verdikt „bez promjene" — i to nije informacija o agentu |
| **`maxCases: 8` > veličina seta** | `harness.run` uzima `slice(0, maxCases)` | Ograničenje je trenutno bez efekta za `nmq` (6 slučajeva); postaje važno tek kad set naraste |
| **Nema podjele na setove** | `setName` default `'golden'` | Nema „validation" seta; svaki novi eval slučaj ulazi u isti set kojim se mjeri (rizik od **overfit-a na zlatni set**, vidi §10) |

---

## 6. Validacija i promocija

### 6.1 `promote` — kapija lifta → prijedlog

```js
const gate = minLift ?? cfg.minLift;                       // default 0.03
if (experiment.lift < gate) return { promoted: false, reason: `lift ${experiment.lift} je ispod kapije ${gate} …` };
const suffix = experiment.winner.genome.systemPromptSuffix ?? '';
const proposal = await improvements.createProposal(tenantId, {
  kind: 'prompt', target: agentId,
  current: spec?.systemPrompt?.slice(0, 300) ?? null,
  proposed: `${spec?.systemPrompt ?? ''}\n\n${suffix}`.trim(),
  rationale: `RSI eksperiment ${experiment.id} (strategija: ${experiment.strategy}): "${experiment.winner.label}" ima lift ${experiment.lift} …`,
  evidence: [{ experimentId, winner, lift, baseline, fitness, passRate }],
  expectedImpact: `+${(experiment.lift * 100).toFixed(1)} p.p. na zlatnom setu`,
  riskLevel: 'medium', source: 'rsi',
});
```

Lanac je: **kapija lifta → `createProposal` (`status: 'proposed'`, `requiresHuman: true`) → čovjek `decide`
(`approve`/`reject`) → `apply` → mjerenje efekta (`docs/21`)**. `promote` **ne** primjenjuje ništa;
`autoApplied: false` je u povratnoj vrijednosti, uz napomenu da primjena ide kroz human-in-the-loop.

**Tri rupe u promociji, vidljive u kodu:**

1. **Promoviše se samo `systemPromptSuffix`.** Pobjednik strategije `temperature`, `maxTokens` ili `pattern`
   ima genom u kojem je promjena u **drugom polju** — a `promote` uvijek šalje `prompt` prijedlog sa sufiksom.
   Ako je pobjednik bio bazni genom (npr. `self-play` strategija), `suffix` je `''`, pa je `proposed` **identičan
   trenutnom promptu** i prijedlog je besmislen (i prolazi kapiju lifta). Praktično: **temperature i maxTokens
   se izmjere, ali se ne mogu promovisati ovom funkcijom** — za njih bi trebao `controlPlane.deploy` sa
   `patch.temperature`/`patch.maxTokens`.
2. **`current` je skraćen na 300 znakova**, a `proposed` je pun prompt + suffix. Diff u inbox-u je zato
   **asimetričan** — čovjek vidi prvih 300 znakova „prije" i cijeli tekst „poslije".
3. **Nema veze sa `evalHarness`-om kao kapijom primjene.** `docs/23` §10.3 i D47 predviđaju da `apply` odbije
   prompt koji **nije** prošao zlatni set; u kodu `improvements.apply` za `kind: 'prompt'` provjerava samo da
   je `proposed` neprazan string (popravka iz D49) — **ne** pokreće eval. Kapija je, dakle, na **ulazu u
   prijedlog** (lift), a ne na **izlazu u produkciju**.

### 6.2 Primjer toka (iz testa, dokazivo)

`tests/swarm.test.mjs` → „RSI: kapije blokiraju akcije iznad nivoa; eksperiment se mjeri i predlaže":

1. Na R1: `designExperiment` / `acquireExperience` / `metaImprove` → `PolicyError` sa porukom
   `ne dozvoljava "design_experiment"`.
2. Na R2: `designExperiment('temperature')` → 3 kandidata sa `tenantId: 'nmq'`.
3. `runExperiment(..., { maxCases: 2 })` → `status: 'completed'`, `lift` je broj, verdikt jedan od tri.
4. `promote` sa **ručno postavljenim** `lift: 0.001` → `promoted: false` (kapija radi).
5. `promote` sa `lift: 0.25` → `promoted: true`, `autoApplied: false`, a `improvements.get(...).source === 'rsi'`.

### 6.3 `improvements` kao jedini izlaz

RSI **ne piše** u katalog, control plane ni `config/*.json`. Sve ide kroz `improvements.createProposal`, gdje
prijedlog dobija `status: 'proposed'`, `requiresHuman: true`, hash i audit zapis
(`action: 'improvement_proposed'`, `decision: 'require_approval'`, `outcome: 'pending'`). Mijenjanje config
fajlova bi zaobišlo i verzionisanje i rollback — zato `improvements.apply` koristi `controlPlane.deploy`
(nova verzija + `rollbackInfo`) ili `policyOverrides.apply` (reverzibilan override), a `kind: 'tool'`/`'code'`
završava kao `needs_code` (zadatak za čovjeka).

### 6.4 `autoMetaPromote` je `false` — i to je mrtva zastavica

U kodu postoji **samo kao vrijednost koja se čita i prijavljuje**, nikad kao uslov:

| Mjesto | Šta radi |
|---|---|
| `DEFAULT_RSI.autoMetaPromote = false` | default vrijednost |
| `config/rsi.json` → `"autoMetaPromote": false` | config vrijednost |
| `api.level()` | vraća je u izlazu |
| `api.status()` | vraća je u izlazu (za board) |
| `metaImprove` → `logger.warn('rsi.meta_improvement', { autoMetaPromote })` | samo loguje |

**Nijedan `if (cfg.autoMetaPromote)` ne postoji.** Dakle danas: postavljanje te zastavice na `true` **ne bi
ništa promijenilo** — sistem ni na R5 ne bi primijenio meta-predlog. To nije propust u bezbjednosti (safe
default), ali jeste **propust u iskrenosti interfejsa**: polje izgleda kao prekidač, a nije. Ako se ikad bude
pravio auto-apply, mora se prvo **implementirati** kapija (eval + canary + rollback, §11), pa onda zastavica.

---

## 7. Pribavljanje iskustva (R3)

### 7.1 Šta `acquireExperience` stvarno radi

```js
assertCan(state.level, 'acquire_experience');                     // R3+ (i autonomija L3 na setLevel)
const cycle = await selfplay.run(tenantId, { rounds, solverAgent: agentId, domain, difficulty: 2 });
const dataset = await selfplay.dataset(tenantId);
await logResearch(tenantId, { type: 'experience_acquired', rounds: cycle.rounds, passRate: cycle.passRate, dataset: dataset.total, costUsd: cycle.costUsd });
return { cycle: { rounds, passRate, costUsd, proposalId }, dataset: { total }, note: '… trening modela je van procesa (docs/32).' };
```

`selfplay.run` (`src/learning/selfplay.js`) za svaki round radi: **proposer** (LLM, `role: 'selfplay-proposer'`,
`temperature: 0.8`) napravi scenario, **solver** ga riješi kroz alate, **critic** ocijeni; sve se upisuje u
`data/tenants/<id>/learning/training-YYYY-MM.jsonl`, a težina ide gore/dolje po prolazu/padu (kurikulum 1–5).

**Iskustvo stvarno nastaje:** dataset se povećava, a self-play ima i svoj izlaz — ako je `passRate < 0.5`
(default `proposeBelow`), **sam otvara `kind: 'prompt'` prijedlog** i traži od LLM-a (`role: 'selfplay-improver'`)
novi system prompt iz padova. Taj `proposalId` se vraća kroz `cycle.proposalId`. Dakle R3 troši novac na
scenarije, a njegov jedini „artefakt odluke" je **prijedlog prompta** — isti kanal kao sve ostalo.

### 7.2 Dataset ostaje u tenantu

- Fizička izolacija: `data/tenants/<tenantId>/learning/training-YYYY-MM.jsonl` (D11, D12).
- `selfplay.dataset(tenantId)` čita **samo taj fajl**, po defaultu vraća **samo uspješne** primjere
  (`onlyPassed: true`, `limit: 1000`) i eksplicitno kaže: *„Format je spreman za SFT/DPO; sam trening se
  pokreće van ovog procesa."*
- Nema putanje kojom dataset jednog tenanta uđe u model drugog tenanta — ali nema ni „export" rute, pa je
  izlaz iz tenanta **ručna radnja** (operator čita fajl). To je za podatke klijenata ispravno (GDPR/DPA,
  `docs/08`, `docs/17`), ali treba biti jasno da je to **procesna**, ne tehnička brava.

### 7.3 Veza sa `docs/32` (koji ne postoji) i šta fali do stvarnog treninga

`src/rsi/meta.js` (u `acquireExperience` i `adaptEnvironment`) i config fajlovi (`evolution.json`, `swarm.json`)
referenciraju `docs/32` i `docs/33` kao dokumente o evoluciji/treningu i roju. **Ta dva fajla ne postoje** u
`docs/` (postoje `docs/22-SELF-PLAY.md` i `docs/28-AI-FRANCHISE.md`). Do stvarnog „self-improving modela" fali, po
redu:

| Korak | Stanje u kodu | Šta konkretno fali |
|---|---|---|
| 1. Dataset | ✅ `training-YYYY-MM.jsonl`, `dataset()` u SFT/DPO formatu | Odvajanje **train/validation/holdout** (zlatni set ne smije u trening) |
| 2. Trening (SFT/LoRA) | ❌ | Proces van repoa: GPU ili API fine-tune; prva prava zavisnost (D2) |
| 3. Evaluacija istreniranog modela | ⚠️ djelimično | Harness postoji i može mjeriti **model**; fali registracija novog modela kao **kandidata** u `strategySpace` |
| 4. Kontrola kvaliteta ocjenjivača | ❌ | Judge je **isti model** kao solver (korelisana greška, §10) |
| 5. Rollback modela | ❌ | `controlPlane` verzionira **agente** (prompt/pattern), ne **težine modela** |

Iskren zaključak: R3 danas proizvodi **dokaze i dataset**, ne bolji model. `notes` u kodu to i kaže — ali je
razlika između „imamo dataset" i „imamo trening" ono što razdvaja RSI od pravog self-improvementa.

---

## 8. Adaptacija na okruženje (R4)

### 8.1 Šta `adaptEnvironment` radi

```js
assertCan(state.level, 'adapt_environment');                       // R4+
if (!cfg.environmentTargets.includes(target)) throw ValidationError;   // domain | language | kb | tools
if (!value) throw ValidationError('adaptEnvironment traži "value"');
const kind = target === 'kb' ? 'kb' : 'prompt';
const proposal = await improvements.createProposal(tenantId, {
  kind, target: agentId,
  current: null,
  proposed: kind === 'kb' ? { text: String(value), source: `rsi:adapt:${target}` }
                          : `Prilagodi se novom okruženju (${target}: ${value}).\n\n${catalog.get(agentId, tenantId)?.systemPrompt ?? ''}`.trim(),
  rationale: rationale ?? `R4 environment-adaptation: novi ${target} = "${value}"`,
  evidence: [{ level: state.level, target, value }],
  expectedImpact: `rad u novom okruženju (${target})`,
  riskLevel: target === 'tools' ? 'high' : 'medium',
  source: 'rsi',
});
return { proposed: true, proposal, note: target === 'tools' ? 'Promjena alata je visok rizik — traži board (docs/33).' : 'Ide kroz odobrenje.' };
```

Mapiranje target → prijedlog:

| `target` | `kind` prijedloga | Šta se stvarno mijenja pri primjeni | `riskLevel` | Napomena |
|---|---|---|---|---|
| `domain` | `prompt` | `controlPlane.deploy` novog system prompta (tekst „Prilagodi se…") | `medium` | „Novi domen" se svodi na prompt — nema novog eval seta ni novih agenata |
| `language` | `prompt` | isto | `medium` | Nema polja za jezik u katalogu; efekat je samo tekstualan |
| `kb` | `kb` | `memory.vectors.ingest({ text, source: 'rsi:adapt:kb' })` | `medium` | Rollback briše zapise po `metadata.proposalId` (D49) |
| `tools` | `prompt` | **i dalje prompt** — `kind` je `prompt` jer `target !== 'kb'` | **`high`** | Alat se **ne** mijenja; mijenja se prompt, a rizik je visok |

**Dvije stvari koje tabela otkriva:**

1. **`target: 'tools'` ne mijenja alate.** Kod nikad ne dira `config/tools.json`, registry alata ni MCP server.
   Prijedlog je `kind: 'prompt'` sa tekstom „Prilagodi se novom okruženju (tools: …)". Visok rizik je
   postavljen **zato što namjera jeste promjena alata** — i to je ispravno konzervativno: ono što bi trebalo
   biti najrizičnije **ostaje** najrizičnije, iako ga kanal primjene ne može izvesti.
2. **`agentId: null` je dozvoljen i prolazi `createProposal`, ali pada na `apply` za `kind: 'prompt'`**
   (`catalog.has(null)` → `NotFoundError`). Za `kb` je `target: null` u redu (KB nije vezan za agenta).
   Kapija protiv `null` targeta postoji na **izlazu** (apply), ne na **ulazu** (proposal).

### 8.2 Zašto promjena ALATA traži board i `high` rizik

- **Alat je jedina tačka gdje agent dira vanjski svijet.** Prompt mijenja **kako** agent govori; alat mijenja
  **šta** može da uradi (poslan mejl, upis u CRM, plaćanje). Zato `src/evolution/genome.js` ima `tools` u
  `FORBIDDEN_FIELDS` — evolucija to polje **ne smije** dirati, a `assertSafe` baca `PolicyError`
  („to je safety invarijanta"). Isti princip važi za RSI: R4 smije **predložiti**, ne izmijeniti.
- **`autonomy.evaluate` visok rizik prevodi u `require_approval` na svim nivoima**, uključujući L4, i to bez
  izuzetka (`HUMAN_ONLY: ['financial','legal','destructive','external_communication']`). Dakle `high` nije
  „više pažnje" nego **tvrd zaustavljač**.
- **Rollback alata je najgori.** `improvements.apply` za `kind: 'tool'` završava kao `needs_code` — nema
  automatskog vraćanja zato što kod/MCP server nije pod `controlPlane` verzionisanjem. Za prompt postoji
  `controlPlane.rollback(version − 1)`; za alat ne postoji ništa.
- **Posljedice su van sistema.** Ako agent pošalje pogrešan mejl ili pogrešno upiše fakturu, „rollback" ne
  postoji (`improvements.rollback` za `action` to i kaže eksplicitno). Zato je jedina odbrana **čovjek
  prije** akcije.

---

## 9. Meta-poboljšanje (R5)

### 9.1 Šta `metaImprove` stvarno računa

```js
assertCan(state.level, 'meta_improve');                                  // R5
const log = await api.researchLog(tenantId, { limit: 200 });             // zadnjih 200 linija tekućeg mjeseca
const experiments = log.filter((e) => e.type === 'experiment_completed');
const ranked = Object.entries(groupBy(experiments, 'strategy'))
  .map(([strategy, v]) => ({ strategy, runs: v.runs, avgLift: mean(v.lifts) }))
  .sort((a, b) => b.avgLift - a.avgLift);
```

Zatim dva predloga (oba `autoApplicable: false`):

| Predlog | Uslov u kodu | Sadržaj |
|---|---|---|
| `process_change` | `best !== worst && best.strategy !== worst.strategy && best.avgLift − worst.avgLift > cfg.minLift` | „Povećaj težinu strategije X, smanji Y" + obrazloženje sa `avgLift` i brojem runova |
| `eval_extension` | `uniqueFailures.length > 0` | „Dodaj N nove provjere u zlatni set iz stvarnih padova" + prvih 6 `caseId` |

Svaki predlog se pretvara u prijedlog:

```js
await improvements.createProposal(tenantId, {
  kind: 'code', target: 'rsi', current: null, proposed: p.title, rationale: p.rationale,
  evidence: [plan.observations], expectedImpact: p.expectedImpact, riskLevel: p.riskLevel, source: 'rsi-meta',
});
```

`kind: 'code'` je tačan izbor: `improvements.APPLIABLE = ['prompt','pattern','policy','kb','action']`, pa
`code` **nikad ne može biti primijenjen automatski** — `apply` ga stavlja u `needs_code` („zadatak za čovjeka").
Time je i tehnički, a ne samo politički, isključeno da R5 mijenja proces bez čovjeka.

### 9.2 Predlog težina strategija — gdje se lomi

1. **`avgLift` je aritmetička sredina bez ikakve kontrole uzorka.** Nema minimuma `runs`, nema intervala
   pouzdanosti. Strategija sa **jednim** eksperimentom i liftom `+0.4` pobjeđuje strategiju sa **deset**
   eksperimenata i prosjekom `+0.01` — i to prolazi kapiju `0.03`. Predlog je tada šum, a izgleda kao nalaz.
2. **Težine ne postoje.** `strategySpace` je lista bez pondera, a `designExperiment` je `Math.random()`.
   Predlog „povećaj težinu" je **zahtjev za izmjenu koda**, ne izmjena podatka — i zato je `kind: 'code'`
   jedina ispravna klasifikacija.
3. **`experiments` u `observations` je broj, a ne lista** (`experiments: experiments.length`), dok `strategies`
   jeste lista. Board vidi rang, ne pojedinačne runove.
4. **Metrike su grube:** `rsi_experiments_total{strategy, phase}`, `rsi_experiment_lift{strategy}` (histogram,
   samo za pobjednika), `rsi_meta_cycles_total`, `rsi_promotions_total{result}`, `rsi_experience_cycles_total`.
   Nema metrike „predlog težina prihvaćen/odbijen".
5. **`plan.proposals` se prepisuje** na kraju (`return { ...plan, proposals: created }`), pa originalni
   `autoApplicable`/`type` ostaju samo u `created` (koji ih nosi) i u research log-u.

### 9.3 Predlog novih eval slučajeva iz padova — **danas se ne može aktivirati**

Ovo je najkonkretniji dio R5 i treba ga reći bez uljepšavanja:

- `metaImprove` traži padove u `e.failures` **iz research log-a**: `experiments.flatMap((e) => (e.failures ?? []).map((f) => f.caseId))`.
- Ali `runExperiment` u research log upisuje: `{ type: 'experiment_completed', id, tenantId, agentId, strategy, winner: winner.label, lift, verdict, baseline, passRate, costUsd }` — **nema `failures`**.
- `failures` postoje samo u **povratnoj vrijednosti** `runExperiment` (`finished.results[].failures`), koja živi
  u memoriji pozivaoca i u `POST /v1/admin/rsi/experiment` odgovoru — **ne** u `research-YYYY-MM.jsonl`.

Zaključak: `uniqueFailures` je **uvijek prazan** za eksperimente pokrenute kroz ovaj kod, pa drugi predlog
(`eval_extension`) **nikad se ne kreira**. Da proradi, dovoljna je jedna izmjena: u `logResearch` za
`experiment_completed` dodati `failures: winner.failures` (ili `results.map(r => r.failures)`). Do tada,
tvrdeći da „sistem predlaže nove eval slučajeve iz stvarnih padova", opisujemo **kod koji postoji**, ali
**putanju koja je mrtva**. To je razlika koju ovaj dokument mora zadržati.

### 9.4 Šta R5 stvarno jeste, a šta nije

| Jeste | Nije |
|---|---|
| Analiza **sopstvenog** research log-a (strategije, lift, broj runova) | Analiza sopstvenog **koda** — `metaImprove` ne čita ni jedan `.js` fajl |
| Predlog promjene **težina strategija** (tekst, `kind: 'code'`) | Primjena te promjene (nema je ni u planu) |
| Predlog **proširenja zlatnog seta** (kod postoji, putanja mrtva — §9.3) | Izmjena `eval/<tenant>.json` (nikad; zlatni set je „ugovor o kvalitetu", D47) |
| Rangiranje po **prosječnom liftu** | Statistički test, kontrola uzorka, interval pouzdanosti |
| Zapis svega u `research-YYYY-MM.jsonl` + audit kroz `improvements` | Bilo kakav auto-apply |

---

## 10. Tehnički izazovi i kako ih rješavamo

Tabela je namjerno kritična: kolona „naše rješenje danas" opisuje **ono što kod radi**, uključujući mjesta
gdje je rješenje slabo ili nepotpuno.

| Izazov | Zašto je teško | Naše rješenje danas (u kodu) | Šta bi bilo bolje |
|---|---|---|---|
| **Uska grla evaluacije** | Svaki kandidat = **pun zlatni set** kroz LLM; RSI bez evala ne postoji, a eval je najskuplji korak | `maxCases` (ruta šalje `6`, default `8`); `caseIds` za podskup; `specPatch` po runu pa nema deploy-a za mjerenje | Keširanje determinističkih provjera, paralelizacija slučajeva, „smoke" podskup za trijažu i pun set samo za pobjednika |
| **Mali uzorci** | `eval/nmq.json` ima **6 slučajeva** → korak `passRate` je `0.1667`, a kapija lifta `0.03` | Kapija je **eksplicitna i vidljiva** u `config/rsi.json` (`minLift`), verdikt se zapisuje u research log | Podići set na desetine slučajeva **prije** nego što se `minLift` smanji; tražiti ponavljanje mjerenja (npr. 3 runa istog kandidata) i prijaviti varijansu |
| **Korelacija grešaka modela** | U self-play-u `solver`, `proposer` i `critic` dijele isti provider/model; judge ocjenjuje output istog modela | `useLlmJudge` je **`false`** po defaultu (`opts.useLlmJudge ?? false`) → kritičar je deterministički tamo gdje može; `critic.review` dobija `criteria` iz scenarija | Drugi model za judge, redovna kalibracija na ljudskim ocjenama, miješanje determinističkih provjera sa LLM sudijom |
| **Goodhart** | Fitness je **fiksna formula** (`passRate − 5×costUsd − …`) sa **fiksnim** setom; optimizacija ide na formulu, ne na posao | Ciljna funkcija uključuje **trošak** (`costPenaltyPerUsd`) i **latenciju**, pa „jeftinije i kraće" nije automatski pobjeda; `promote` ima kapiju lifta | Rotacija/težine slučajeva, „teški" holdout set koji se **ne** koristi za odabir, povremena revizija zlatnog seta od čovjeka |
| **Drift** (proces uči pogrešnu stvar) | Self-play dataset nastaje iz judge-ovih verdikata; prompt se mijenja iz tog dataset-a; nova petlja mjeri istim judge-om | Zlatni set je **fiksan i u repou**, pa mjerenje ne zavisi od self-play petlje; svaka izmjena ide kroz prijedlog + audit + rollback | Vremenski „zamrznut" baseline po agentu, periodično ponovno mjerenje **istog** genoma (kontrola), praćenje `impact` poslije primjene (`docs/21`) |
| **Regresija na drugim domenima** | Zlatni set je **jedan po tenantu** i pokriva podskup agenata; poboljšanje za `support` može pokvariti `finance` | Eksperiment se mjeri na **istom** setu za sve kandidate; `setName` parametar omogućava više setova (`eval/<tenant>.<name>.json`, `harness.setFile`) | Set po agentu/domenu, „regression gate" koji traži **da nijedan postojeći set ne padne**, i holdout za svaki domen |
| **Preciznost baseline-a** | Baseline se mjeri **jednom** i to **poslije** kandidata; svaki šum u tom mjerenju ulazi pravo u `lift` | Baseline je dio izlaza (`baselineFitness`) i dokaza u prijedlogu (`evidence[].baseline`) | Mjeriti baseline **prije** i **poslije**, ponoviti 3×, koristiti medijanu; ako se baseline promijenio tokom eksperimenta — poništi eksperiment |
| **Promocija drugih polja** | Pobjednik može biti `temperature`, `maxTokens` ili `pattern`, a `promote` zna samo `prompt` | Ništa — `promote` uvijek šalje `systemPromptSuffix` kao `proposed` | Mapiranje pobjedničkog genoma u odgovarajući `kind` (`pattern`) ili u `controlPlane.deploy` patch (`temperature`, `maxTokens`); zaštita da prazan suffix ne otvori besmislen prijedlog |
| **Sekundarni efekti nivoa** | Promjena RSI nivoa mijenja **šta je dozvoljeno**, a nema kontrole nad eksperimentima u toku | `history` (30 zapisa) + audit `rsi_level_changed` + `changedBy` u `level.json` | „Drain" procedura pri snižavanju nivoa (zaustavi planirane eksperimente, zabilježi u research log), i eksplicitno polje `status` po eksperimentu koje preživljava restart |
| **Duplikati prijedloga** | `metaImprove` i `promote` mogu se pozvati više puta; svaki poziv pravi novi `uid` | `hash = sha256({kind,target,proposed}).slice(0,16)` postoji na prijedlogu | Deduplikacija po `hash`-u (isti hash → isti otvoren prijedlog), kao što `docs/23` §9.7 predlaže za v0.3 |
| **Research log je ograničen** | `researchLog` čita **samo tekući mjesec** i to `tail` sa `limit` (default 100, `metaImprove` 200) | `limit` je parametar; ruta `GET /v1/admin/rsi/research` ga izlaže | Čitati sve `research-*.jsonl` fajlove ili voditi mjesečne agregate po strategiji (isti problem kao `rewards.recent` u `docs/23` §5.4) |

---

## 11. Zašto NE auto-deploy (argumentacija)

„Auto-deploy" ovdje znači: **sistem sam primijeni svoju izmjenu** (prompt/pattern/KB ili meta-promjenu procesa)
bez čovjeka u tom trenutku. Pet razloga protiv, i svaki ima oslonac u kodu:

1. **Nema evaluacije koja je jeftinija od rizika pogrešne izmjene.** Jedina mjera je zlatni set od **6 slučajeva**
   po tenantu, sa korakom `passRate` od `0.1667`. Kapija lifta `0.03` je finija od rezolucije mjerenja — to
   nije kapija nego šum. Auto-deploy bi donosio odluke na osnovu jednog preokrenutog slučaja.
2. **Nema potpunog rollback-a.** `controlPlane.rollback` vraća **prethodnu verziju** prompta/patterna, i to je
   dobro. Ali `kind: 'action'` (akcija u svijetu) i `kind: 'tool'`/`'code'` **nemaju** automatsko vraćanje
   (`needs_code`, „akcija je već izvršena"). Auto-deploy bi nužno uključio i ono što se ne može vratiti.
3. **Uzorci su mali i korelisani.** 6 slučajeva, jedan model za solver/proposer/judge, jedan set za sve agente.
   Auto-deploy ubrzava petlju čiji je signal slabiji od njenog šuma — pogrešna izmjena se **potvrdi** istim
   slabim signalom i ostane.
4. **Promjena na meta-nivou kvari sve niže nivoe odjednom.** Ako proces poboljšavanja (težine strategija,
   sastav zlatnog seta) krene naopako, ne kvari se jedan prompt nego **svaki budući** eksperiment. Zato je
   jedini izlaz R5 `kind: 'code'` → `needs_code` → čovjek. To nije konzervativnost iz navike, nego
   **asimetrija posljedica**: naniže se greška lokalizuje, na meta-nivou se multiplikuje.
5. **Odgovornost i dokazivost.** Kod je auditovan (`rsi_level_changed`, `improvement_proposed`, `decidedBy`,
   `appliedBy`), ali „sistem je sam odlučio" nije potpis. Za GDPR/DPA obradu podataka tenanta u svrhu izmjene
   ponašanja sistema treba osnova u ugovoru (`docs/08`, `docs/17`), a za enterprise prodaju **dokaz da je
   sistem pod kontrolom** (D15, D34). Auto-deploy briše jedini element koji lomi petlju povratne sprege —
   čovjeka sa vanjskim kriterijem.

### 11.1 Uslovi pod kojima bi se smjelo **razmišljati** o auto-deploy-u

Ovo nije plan, nego **lista preduslova** — svaki je mjerljiv i nijedan danas nije ispunjen u cjelini.

| # | Uslov | Zašto baš taj uslov | Stanje u kodu danas |
|---|---|---|---|
| 1 | **Eval ≥ prag na najmanje 3 nezavisna seta** (npr. golden + domain + regression), sa dovoljno slučajeva da korak `passRate` bude manji od `minLift` | Bez toga kapija mjeri šum (§5.4, prvi red) | ❌ postoji **jedan** set po tenantu (`eval/nmq.json`, 6 slučajeva) — `setName` mehanika postoji |
| 2 | **Canary po tenantu** — izmjena ide na mali, eksplicitno određen dio saobraćaja tog tenanta | Greška pogađa dio klijenata, ne sve | ⚠️ `improvements.createExperiment` ima `splitPct` i `minSamples`; RSI ga **ne koristi** — promocija ide pravo u `controlPlane.deploy` |
| 3 | **Automatski rollback sa okidačem** (metrika/eval padne ispod praga → vrati bez čekanja čovjeka) | „Ručni rollback" u 3 sata noću je isto što i nema rollback-a | ⚠️ `improvements.rollback` **postoji**, okidača **nema** (nema watchera koji ga zove) |
| 4 | **Budžet koji je fail-closed** (eksperiment staje kad se potroši; nema „malo preko") | Automatika bez limita je finansijski rizik; svaki kandidat je pun set | ⚠️ tenant/per-agent budžet postoji (`tenants.json`), `selfplay.run` prima `maxPerScenarioUsd`, ali `acquireExperience` ga **ne prosljeđuje** |
| 5 | **Kill switch nezavisan od automatike** (jedna komanda zaustavlja sve RSI radnje) | Zadnja linija odbrane; mora raditi i ako je automatika u petlji | ⚠️ postoje `swarmGovernance.freeze` i tenant `status.json`; **RSI nivo** se ne zaustavlja kill switch-om (nema veze) |
| 6 | **30 dana bez incidenta** u režimu „predloži + čovjek primijeni", uz mjerenje da je >30% prijedloga primijenjeno | Ako čovjek odbija većinu prijedloga, automatika bi ih **izvršila** — to je dokaz da signal nije dobar | ❌ nema evidencije; KPI „% prijedloga primijenjenih" je u `docs/27` planu, ne u kodu |

Do tada: **jedina automatska radnja je analiza, mjerenje i otvaranje prijedloga.** Površina automatike je
namjerno mala — a svaka stavka iz §11.1 je **kod plus dokaz**, ne politika na papiru.

---

## 12. Roadmap RSI-a

Faze su označene **dokazom** koji mora postojati da bi faza bila gotova. Nijedna faza ne nosi cijenu ni
kalendarski rok kao činjenicu — redoslijed je ono što je obavezujuće.

| Faza | Cilj | Konkretan rad | **Dokaz da je faza gotova** |
|---|---|---|---|
| **Sada (v0.4)** | R0–R5 kao kapije, eksperiment kroz eval, sve kao prijedlog | Postojeći `src/rsi/meta.js`, `config/rsi.json`, rute `/v1/admin/rsi/*`, 3 testa u `tests/swarm.test.mjs` | Testovi prolaze; `GET /v1/admin/rsi` vraća nivo, kapije i `autoMetaPromote`; audit ima `rsi_level_changed` sa `changedBy` |
| **Sada — popravke (najbliži korak)** | Ukloniti mrtve putanje i lažne signale | (a) `failures` u research log za `experiment_completed`; (b) validacija `strategy` protiv `strategySpace`; (c) `promote` koji ne otvara prijedlog sa praznim suffixom; (d) maknuti `self-play`/`retrieval` iz `strategySpace` ili ih implementirati; (e) `avgDurationMs` u `results[]` | Novi test: eksperiment sa padom **kreira** `eval_extension` predlog; `designExperiment` sa nepoznatom strategijom baca `ValidationError`; `promote` sa baznim genomom vraća `promoted: false` sa razlogom |
| **~6 mjeseci** | Mjerenje koje ima rezoluciju | Zlatni set po domenu/agentu (desetine slučajeva), `setName` u upotrebi, ponavljanje mjerenja kandidata i baseline **prije i poslije**, medijan umjesto jednog runa | `status()` pokazuje `lift` uz mjeru rasipanja; nijedan prijedlog se ne otvara ako je razlika manja od varijanse; broj slučajeva u setu > broj kandidata |
| **~12 mjeseci** | Eval kao **kapija primjene**, ne samo ulaza | `improvements.apply` odbija/odgađa `prompt`/`pattern` bez prolaza na zlatnom setu (D47, `docs/23` §10.3); `impact` pored `ΔavgReward` prijavljuje **Δeval**; watcher za prijedloge starije od dogovorenog prozora | Test: `apply` bez evala baca `PolicyError`; izvještaj `impact` sadrži i eval deltu; prijedlog bez mjerenja je vidljiv u inbox-u |
| **~12 mjeseci (paralelno)** | R3 → stvarni trening (van procesa) | Train/validation/holdout podjela, izvoz dataseta, trening kao **vanjski korak**, registracija istreniranog modela kao **kandidata** u eksperimentu | Dokaz: isti zlatni set mjeri **dva modela**; kandidat-model prolazi kroz `runExperiment`; rollback na prethodni model je dokumentovan i izveden |
| **~24 mjeseca** | Canary + automatski rollback (uslovi §11.1, tačke 1–5) | Canary po tenantu kroz `createExperiment`/`splitPct`, automatski rollback sa okidačem, fail-closed budžet u RSI putanji, RSI kill switch | Dokaz: izmjena je puštena na dio saobraćaja, metrika je pala, sistem se **sam** vratio, i to je u auditu bez ljudske akcije. **Bez ovog dokaza nema auto-apply ni za jedan `kind`** |
| **~24 mjeseci** | Meta-nivo sa dokazom | Predlog težina strategija sa **minimumom runova i intervalom pouzdanosti**; rotacija zlatnog seta; periodično ponovno mjerenje zamrznutog baseline-a | Dokaz: predlog težina se odbija kad je uzorak mali; baseline se ne mijenja bez objašnjenja; broj „predlog → primijenjeno" > 30% (`docs/27`) |

**Šta se NAMJERNO ne radi ni u jednoj fazi:** sistem ne piše kod, ne mijenja `config/*.json`, ne dira
`FORBIDDEN_FIELDS` (`autonomy`, `budget`, `tools`, `policy`, `sandbox`…), ne mijenja zlatni set sam, i ne
primjenjuje meta-promjenu bez čovjeka.

---

## Otvorena pitanja

1. **Koji je minimalni uzorak za predlog težine strategije?** `metaImprove` danas koristi **prosječan lift bez
   minimuma runova** — jedan eksperiment sa velikim liftom može promijeniti rang. Da li uvesti `minRuns` (npr.
   najmanje 3 eksperimenta po strategiji) i prijaviti rasipanje, ili ostaviti odluku boardu uz jasniju oznaku
   „nedovoljno podataka"?
2. **Kako riješiti `failures` u research log-u, a da log ne naraste?** Predlog `eval_extension` traži `caseId`
   padova; ako se upisuju svi padovi sa svih kandidata, `research-YYYY-MM.jsonl` raste sa svakim eksperimentom.
   Da li upisivati samo padove **pobjednika**, samo `caseId` bez teksta, ili držati odvojenu „failure" agendu?
3. **Šta znači „poboljšanje" kad fitness miješa prolaznost i trošak?** Kapija lifta radi na fitness-u, pa
   kandidat sa boljom prolaznošću i većim troškom može biti proglašen „bez promjene". Da li verdikt treba
   razdvojiti (`passRate` verdikt i `cost` delta odvojeno), ili ostaviti jednu mjeru i objasniti je u inbox-u?
4. **Ko je vlasnik zlatnog seta kad sistem predlaže njegovo proširenje?** `metaImprove` predlaže nove provjere
   iz padova, a `eval/<tenant>.json` je „ugovor o kvalitetu" (D47). Ko odobrava nove slučajeve, kako se
   izbjegava da set postane „test na kojem smo već pali", i da li novi slučajevi ulaze u set **prije** ili
   **poslije** sljedećeg mjerenja?
5. **Šta se dešava sa eksperimentima u toku kad se nivo spusti (npr. R3 → R1)?** `setLevel` ne dira research log
   ni planirane eksperimente; `history` pamti promjenu, ali eksperiment nema polje stanja koje bi preživjelo
   restart. Treba li „drain" procedura i zapis u research log?
6. **Da li `setLevel` treba da bude vezan za `decision` kapiju, a ne samo za rolu `owner`?** Danas je promjena
   nivoa jedna ruta sa jednom rolom; za R4/R5 (`human: true`) audit kaže `require_approval`, ali **nema
   drugog odobrenja** — isti `owner` ključ i podiže nivo i time „odobrava". Da li uvesti dvostruku potvrdu
   (predlog + odobrenje) za R4/R5, kao što postoji za prijedloge?
