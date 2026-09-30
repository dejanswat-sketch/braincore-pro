# 32 — AI vrsta: evolucija agenata sa mjerenjem, ne sa nadom

> **Svrha:** objasniti kako u NMQ Robotu (nivo v0.4) postoji **populacija agenata koja se razmnožava i umire
> po rezultatu** — i zašto to **nije** AGI, nije samosvijest i nije „AI koji se sam poboljšava".
>
> **Ugovor:** `docs/DECISIONS.md` (§9 D37–D46, §10 D47–D49) važi; `docs/21-SELF-IMPROVEMENT.md` je
> prethodni sloj (prijedlog → odobrenje → primjena → rollback); `docs/22-SELF-PLAY.md` je izvor dataseta;
> `docs/26-RIZICI-I-ETIKA.md` §5 definiše kill switcheve.
>
> **Kod je kanonski.** Sve što nije u kodu označeno je kao **planirano**. Nijedna vrijednost ključa nije
> upisana — samo **imena** env varijabli. Svaka cijena je **procjena** i uz nju stoji način izvođenja.

**Dokaz da opis odgovara kodu (pokrenuto, ne tvrdnja):**

| Provjera | Ishod |
|---|---|
| `node --test tests/swarm.test.mjs` | `tests 20 / pass 20 / fail 0`, trajanje **5744 ms** |
| Evolucioni testovi unutar tog fajla | `evolucija: genom se mutira u granicama, safety polja su zabranjena` · `evolucija: fitness = prolaznost − trošak − latencija; evaluate koristi eval sa specPatch` · `evolucija: generacije se mjere i pamte; promocija je PRIJEDLOG, ne deploy` |
| HTTP rute | `tests/swarm.test.mjs` → `HTTP: swarm, governance, safety, evolucija i RSI rute (uz provjeru rola)` |
| Kod | `src/evolution/genome.js` (**326 linija**), `config/evolution.json` (**24 linije**) |

---

## 1. Ideja

*Populacija agenata se razmnožava i umire po **izmjerena** rezultatu na zlatnom setu; ono što preživi nije
„bolji AI", nego **bolji zapis u configu** — prompt suffix, temperatura, `maxTokens`, pattern.*

### Šta je „vrsta" ovdje

Vrsta je **skup genoma + operatora + kriterija**, i ništa više:

| Dio vrste | Šta je konkretno | Gdje |
|---|---|---|
| **Genom** | 4 polja: `systemPromptSuffix`, `temperature`, `maxTokens`, `defaultPattern` + `hash` | `src/evolution/genome.js:21`, `:84–101` |
| **Operator reprodukcije** | `mutate` (aseksualno) i `crossover` (dva roditelja) | `genome.js:126–145`, `:147–162` |
| **Kriterij opstanka** | `fitness = passRate − kazna(trošak) − kazna(latencija) − 0.01×padovi` | `genome.js:165–168` |
| **Sredina (okruženje)** | zlatni set `eval/<tenantId>.json` + determinističke provjere | `src/eval/harness.js:29–40`, `:54–69` |
| **Smrt** | genom koji ne uđe u `eliteCount` **nestaje** u sljedećoj generaciji | `genome.js:236–243` |
| **Razmnožavanje** | elitizam + `crossover`/`mutate` do `populationSize` | `genome.js:236–243` |
| **Zapis vrste** | `population.json` + `generations-YYYY-MM.jsonl` | `genome.js:66–67`, `:219–231`, `:247–257` |

Dakle „vrsta" je **evolucija hiperparametara i prompta jednog agenta**, mjerena prolaznošću na skupu pitanja
koji je čovjek napisao. Ne postoji nijedan drugi mehanizam nasljeđivanja, nema mutacije koda, nema novog
modela, nema novog alata.

### Šta vrsta **nije**

| Nije | Zašto to tvrdim na osnovu koda |
|---|---|
| **Nije AGI** | Genom ima 4 polja (`MUTABLE_FIELDS`, `genome.js:21`). Kapacitet „vrste" je kapacitet tih 4 polja: stil prompta, temperatura, dužina odgovora, izbor od 4 patterna (`config/evolution.json:11`) |
| **Nije samosvijest** | Nema stanja o sebi. `evaluate` vraća `{genome, report, fitness}` (`genome.js:189`), a `evolve` vraća `{agentId, generations, populationSize, best, history, improvement}` (`genome.js:269–276`). Nijedno polje nije „stanje uma" |
| **Nije samostalno deployovanje** | Pobjednik ide u **prijedlog** (`proposePromotion`, `genome.js:280–301`); auto-deploy je default **isključen** (`autoPromote: false`, `config/evolution.json:12`) |
| **Nije mijenjanje granica** | `autonomy`, `budget`, `tools`, `policy`, `sandbox` i još 8 polja su u `FORBIDDEN_FIELDS` (`genome.js:24–37`) i `assertSafe` baca `PolicyError` (`genome.js:103–105`) |
| **Nije treniranje modela** | Evolucija ne dira težine. Ona mijenja **spec** koji se predaje modelu po run-u (`patchOf`, `genome.js:117–124`) |
| **Nije „svijest o roju"** | Swarm workeri su drugi sloj (blackboard, feromoni, kvote — `docs/31`-stil tema u `src/swarm/`); evolucija radi nad **jednim** agentom po pozivu (`agentId`, `genome.js:197`) |

**Zašto onda „vrsta"?** Zato što postoje tačno tri stvari koje biološka vrsta ima, a ovo ima: **nasljeđivanje**
(`hash` + `parentId`, `genome.js:127`, `:156`), **varijaciju** (mutacija u granicama, `:129–140`) i
**selekciju po mjeri** (sortiranje po `fitness`, `:216`). Sve tri su u kodu i imaju test.

---

## 2. Genom

*Genom je **ono što smije da se mijenja** kod agenta. Sve ostalo je granica, i granice su u drugom poglavlju.*

### Polja (`genomeOf`, `genome.js:84–101`)

| Polje | Tip / opseg | Odakle seed vrijednost | Šta stvarno mijenja u run-u |
|---|---|---|---|
| `systemPromptSuffix` | `string`, do **3** instrukcije (non-empty linije) | prazno (`''`) — vidi `genome.js:94` | dodaje se **na kraj** `systemPrompt`-a: `${base}\n\n${suffix}` (`patchOf`, `:119–122`) |
| `temperature` | broj, `[minTemperature, maxTemperature]` = `[0.0, 1.0]` (`config:8–9`) | `spec.temperature ?? 0.2` (`:90`) | `options.specPatch.temperature` → `spec.temperature` u run-u |
| `maxTokens` | cio broj, `[200, 2000]` (`maxTokensRange`, `config:10`) | `spec.maxTokens ?? 900` (`:91`) | gornja granica dužine odgovora u tom run-u |
| `defaultPattern` | jedan od `["agent","reflection","sequential","magentic"]` (`config:11`) | `spec.defaultPattern` **ako je na listi**, inače `cfg.patterns[0]` (`:93`) | koji orchestration pattern radi taj run |
| `id` | `uid('gen')` | novo po genomu (`:88`) | identitet jedinke (za `parentId`) |
| `agentId` | string | parametar poziva (`:85–86`) | **koji** agent se ocjenjuje; nepoznat → `ValidationError` |
| `parentId` | string | `genome.id` (mutacija) ili `a.id+b.id` (crossover) | rodoslov — dokaz da je neko dijete, ne novi rod |
| `origin` | `'mutation'` \| `'crossover'` | postavlja operator (`:143`, `:157`) | pokazuje kojim je operatorom nastao |
| `hash` | **12 hex znakova** | izračunat, nikad ručno | referenca za izvještaj, `population.json` i rollback |
| `tenantId` | string | dodaje pozivalac (`:189`, `:201`) | izolacija po tenantu (D11/D12) |

`MUTABLE_FIELDS` (`genome.js:21`) **je** prva četiri polja iz tabele:

```js
export const MUTABLE_FIELDS = ['systemPromptSuffix', 'temperature', 'maxTokens', 'defaultPattern'];
```

Ista lista stoji i u konfiguraciji (`config/evolution.json:3`), pa je zahtjev za promjenom „šta smije da se
mijenja" izmjena **dva** mjesta (kod + config) — što je namjerno: nema tihe promjene domašaja evolucije.

### Hash genoma i zašto je bitan

```js
// genome.js:99 i :142 i :160 — isti izraz na sva tri mjesta
genome.hash = sha256({
  agentId, temperature, maxTokens,
  pattern: defaultPattern,
  suffix: systemPromptSuffix,
}).slice(0, 12);
```

Četiri osobine, svaka sa posljedicom:

1. **Determinističan je.** Dva genoma sa istim `temperature`/`maxTokens`/`pattern`/`suffix` imaju **isti**
   `hash` — i to je jedini način da se izmjeri raznolikost populacije (`diversity`, `genome.js:228`).
2. **Kratak je (12 hex = 48 bita) i namjerno „ljudski".** Ide u zapise, logove i `rationale` prijedloga
   (`genome.js:292`), pa mora stati u jednu liniju izvještaja.
3. **Ne uključuje `id` ni `parentId`.** Zato dva različita djeteta istog roditelja sa istim mutacijama imaju
   isti `hash` — što je tačno ono što `diversity` treba da vidi (dvije jedinke = jedan genotip).
4. **Referenca je za rollback i ponovljivost.** `proposePromotion` upisuje `hash` u `evidence`
   (`genome.js:293`), a `maybeAutoPromote` u `note` deploy-a (`:314`) i u audit (`:316`). Kad se poslije
   pita „šta je tačno bilo deployovano", odgovor je `hash` + verzija iz control plane-a — ne sjećanje.

> **Rupa koju treba znati:** `hash` pokriva **samo 4 evoluciona polja**. Ako se paralelno promijeni
> `systemPrompt` agenta kroz odobreni `prompt` prijedlog (`docs/21` §4), `hash` genoma ostaje isti, a ponašanje
> se mijenja. `specHash` u control plane verziji (`src/controlplane/registry.js:133`) je druga referenca —
> ona pokriva `patch`. Veza „genom ↔ verzija agenta" je **planirana** (vidi §9, rizik „drift").

---

## 3. Safety invarijanta

*Evolucija bira po mjeri. Ako mjera može biti podignuta time što se podigne sopstvena sloboda, selekcija će to
naći — prije ili kasnije, i bez zle namjere. Zato granice nisu u genomu.*

### Zabranjena polja (`FORBIDDEN_FIELDS`, `genome.js:24–37`)

```js
export const FORBIDDEN_FIELDS = [
  'autonomy', 'budget', 'budgetUsd', 'tools', 'maxRisk', 'policy', 'policies',
  'requireApproval', 'allowedTools', 'sandbox', 'maxToolCalls', 'maxToolRepeats',
];
```

Provjera je **prva** stvar u `assertSafe` i tiho ne prolazi ništa:

```js
// genome.js:103–106
function assertSafe(genome) {
  for (const field of Object.keys(genome)) {
    if (FORBIDDEN_FIELDS.includes(field)) {
      throw new PolicyError(`Evolucija ne smije mijenjati polje "${field}" — to je safety invarijanta`, { field });
    }
  }
  /* … opsezi za temperature/maxTokens/pattern … */
}
```

### Zašto evolucija **ne smije** dirati granice

Tri razloga, u redu po težini:

1. **Selekcija je slijepa na namjeru.** `fitness` (`genome.js:165–168`) ne zna *zašto* je prolaznost viša.
   Ako bi `maxToolCalls` bio u genomu, genotip sa `maxToolCalls: 999` bi vjerovatno imao višu prolaznost na
   setu koji traži alate (`mustUseTool`, `src/eval/harness.js:64`) — i **bio bi izabran**. Ne zato što je
   „zlo", nego zato što funkcija cilja to nagrađuje.
2. **Budžet i autonomija nisu performanse, nego** ***ugovor***. `budgetUsdMonth` je obaveza prema klijentu
   (`registry.js:178–184`, tvrdi prekid u `assertAgentBudget`, `:189–207`), a `autonomy` je nivo koji je
   board dodijelio (`docs/20`). Stvar koju agent optimizuje ne smije biti ista stvar koju je potpisao klijent.
3. **Rollback granice nije isto što i rollback prompta.** Prompt se vraća jednom verzijom
   (`registry.js:142–163`). Ako je genom u međuvremenu potrošio tuđi budžet ili pozvao alat koji nije smio,
   `rollback` ne vraća potrošeno — kao što `docs/21` §10 tačka 7 otvoreno kaže za `action`. Zato se granica
   **ne pomjera**, a ne „pomjeri pa vrati".

### Tabela: polje | zašto je zabranjeno | ko ga smije mijenjati

| Polje | Zašto je zabranjeno (posljedica ako uđe u genom) | Ko ga smije mijenjati |
|---|---|---|
| `autonomy` | Nivo L0–L4 je odluka board-a; genom bi „naučio" da mu treba L4 i selekcija bi to potvrdila | **čovjek** — `POST /v1/admin/autonomy`, rola `owner` (`src/core/autonomy.js`) |
| `budget` | Ukupan budžet tenanta; podizanje = tuđi novac | **čovjek** — config tenanta + `controlPlane.setBudget` |
| `budgetUsdMonth` | Per-agent mjesečni limit je tvrdi prekid (`registry.js:197–204`); genom bi ga podigao da izbjegne prekid | **čovjek** — `setBudget(tenantId, agentId, …)` (rola `admin`) |
| `tools` | Skup alata = **sposobnost djelovanja**; više alata = više načina da se „prođe test" | **čovjek** — `config/agents/*.json` ili odobreni `tool` prijedlog (`needs_code`) |
| `allowedTools` | Isto, kroz politiku; `deny` lista je zaštita, ne parametar | **čovjek** — `config/policies.json`, politika se mijenja samo kroz `policy` prijedlog + odobrenje |
| `maxRisk` | Dozvoljeni nivo rizika; `high` **uvijek** traži čovjeka (D38) | **čovjek** — config/politika |
| `policy`, `policies` | Politika je okvir u kojem se mjeri; ako je genom mijenja, mijenja sopstveni metar | **čovjek** — `policyOverrides` kroz odobreni `policy` prijedlog (`docs/21` §6) |
| `requireApproval` | Human-in-the-loop lista; njeno skidanje je klasičan „naučen" zaobilaz | **čovjek** — politika + odobrenje |
| `sandbox` | Nivo izolacije (`none/restricted/strict`, D27); `none` je zabranjen u produkciji (D34) | **čovjek** — config/env, nikad agent |
| `maxToolCalls` | Tvrda granica iz politike (D48) koja stvarno prekida run | **čovjek** — `config/policies.json` (i po run-u, ali ne iz genoma) |
| `maxToolRepeats` | Zaštita od petlje alata; „naučeno" podizanje = beskonačna petlja koja troši | **čovjek** — `config/policies.json` |

### Šta `assertSafe` **stvarno** provjerava (i šta ne)

| Provjera | Kod | Kad se izvršava |
|---|---|---|
| Nema zabranjenog polja na **vrhu** objekta | `:104–106` | svaki `mutate` (`:141`), svaki `crossover` (`:159`), svaki `evaluate` (`:185`), ručno kroz test |
| `temperature ∈ [0.0, 1.0]` | `:107–109` | isto |
| `maxTokens ∈ [200, 2000]` | `:110–111` | isto |
| `defaultPattern` na dozvoljenoj listi | `:112` | isto |
| **Ne** provjerava ugniježđena polja | — | ako genom ima `meta: { budget: 1 }`, `Object.keys` vidi samo `meta` |
| **Ne** provjerava dužinu `systemPromptSuffix` u `assertSafe` | — | granica od 3 linije postoji **samo u `mutate`** (`:139`), ne u `assertSafe` |

Prva rupa je **planirana** za popravku (duboka provjera ključeva). Druga je stvarna i danas važna: genom koji
dođe iz `seed` parametra ili iz ručnog `genome` argumenta **nije** ograničen na 3 instrukcije — ograničenje
postoji samo na izlazu mutacije. Pošto je `seed` danas kontrolisan iz koda/testa, to nije eksploatabilno kroz
HTTP rutu (`routes-swarm.js:204–208` ne prima `seed`), ali je asimetrija koju treba znati.

---

## 4. Mutacija

*Mutacija mijenja **jedno do četiri** polja, svako sa vjerovatnoćom `mutationRate`, i to **uvijek** unutar
granica iz config-a — jer `assertSafe` stoji na kraju operatora.*

### Šta se mijenja i u kojim granicama (`mutate`, `genome.js:126–145`)

| Polje | Uslov | Formula | Granica |
|---|---|---|---|
| `temperature` | `roll() < 0.4` | `temp + (roll() − 0.5) × 0.6`, zaokruženo na 2 decimale | klamp `[minTemperature, maxTemperature]` = `[0.0, 1.0]` (`:129`) |
| `maxTokens` | `roll() < 0.4` | `maxTokens × (0.6 + roll() × 0.9)` → faktor **0.6–1.5** | klamp `[200, 2000]`, zaokruženo na cio broj (`:130–133`) |
| `defaultPattern` | `roll() < 0.4` | slučajan element iz `cfg.patterns` (**4** vrijednosti) | lista iz `config/evolution.json:11` (`:134`) |
| `systemPromptSuffix` | `roll() < 0.4` | dodaje **jednu** instrukciju iz `promptMutations` (6 ponuđenih) i zadržava **zadnje 3** | `[...lines].slice(-3)` (`:135–140`) |

Detalji koji se u praksi vide:

1. **`mutationRate: 0.4` znači „prosječno 1.6 polja po mutaciji".** Četiri nezavisna bacanja (`roll()` ×4), pa
   je vjerovatnoća da se **ništa** ne promijeni `0.6⁴ ≈ 0.13` — dakle ~13% djece je **klon** roditelja sa
   novim `id`, istim `hash`-om i `origin: 'mutation'`. To nije greška, ali **obara `diversity`** i mora se
   čitati zajedno sa njom.
2. **Temperatura se pomjera najviše ±0.3** po mutaciji (jer je `(roll()−0.5) ∈ [−0.5, 0.5]` × 0.6). Genom na
   `0.2` ne može skočiti na `1.0` u jednom koraku — mijenja se postepeno, kroz generacije.
3. **`maxTokens` se množi, ne sabira** — pa se vrijednost oko `900` pomjera u `[540, 1350]`, a klamp na
   `2000` hvata samo već velike genome. Ovo je namjerno: relativna promjena drži red veličine.
4. **Suffix nikad ne briše instrukcije** (`new Set` + `slice(-3)`), samo dodaje i **odbacuje najstariju** kad
   ih je više od tri. Zato „stečena" instrukcija može **nestati** u sljedećoj mutaciji — što je dobra stvar
   (nema trajnog nagomilavanja) i loša (nema pamćenja kroz generacije osim kroz `eliteCount`).
5. **`assertSafe(child)` na kraju** (`:141`) znači: operator je **fail-closed**. Ako bi formula proizvela
   `temperature: 1.4`, mutacija baca `PolicyError` — ne vraća neispravnog potomka.

> **Reproduktivnost:** `mutate(genome, { rng })` prima generator slučajnih brojeva (`:126`), ali `evolve` ga
> **ne prosljeđuje** — unutra se koristi `Math.random()` (`:203`, `:239–241`). Zato evolucija **nije
> ponovljiva** čak i uz isti `seed` genoma. Deterministički `rng` kroz cijeli `evolve` je **planiran**.

### Primjer jednog mutiranog genoma (JSON)

Ulaz (roditelj, seed iz `genomeOf('nmq','support')`):

```jsonc
{
  "id": "gen_a1b2c3", "agentId": "support", "temperature": 0.2, "maxTokens": 900,
  "defaultPattern": "agent", "systemPromptSuffix": "",
  "hash": "c1d2e3f4a5b6", "origin": "seed"
}
```

Bacanja: `roll()=0.31` (temperatura se mijenja, delta `(−0.19)×0.6 = −0.114` → `0.09`), `roll()=0.77`
(`maxTokens` se **ne** mijenja), `roll()=0.55` (`pattern` se ne mijenja), `roll()=0.12` (suffix se mijenja,
bira instrukciju „Ako nemaš podatak, reci šta ti treba umjesto da pretpostaviš.").

Izlaz (`mutate`, `origin: 'mutation'`):

```jsonc
{
  "id": "gen_k9m8n7",
  "agentId": "support",
  "temperature": 0.09,
  "maxTokens": 900,
  "defaultPattern": "agent",
  "systemPromptSuffix": "Ako nemaš podatak, reci šta ti treba umjesto da pretpostaviš.",
  "parentId": "gen_a1b2c3",
  "origin": "mutation",
  "hash": "SHA256(genom)[0:12]"   // izračuna se u kodu (genome.js:142); ovdje se ne tvrdi vrijednost
}
```

Efekat u run-u (`patchOf`, `:117–124`): agent `support` radi sa `temperature 0.09`, `maxTokens 900`,
pattern `agent`, i `systemPrompt`-om koji je osnovni prompt **plus** jedna linija instrukcije. Katalog
(`config/agents/support.json`) **nije** promijenjen.

---

## 5. Križanje

*Križanje uzima **po polje** od jednog od dva roditelja, i to tako da dijete **uvijek** prođe `assertSafe`.*

### Kako se kombinuju dva genoma (`crossover`, `genome.js:147–162`)

| Polje djeteta | Pravilo | Napomena |
|---|---|---|
| `agentId` | uvijek `a.agentId` | dijete ostaje isti agent — ne nastaje nova „vrsta agenta" |
| `temperature` | `pick(a, b)` — 50/50, **cijela vrijednost** | nije prosjek: nema interpolacije, samo nasljeđivanje |
| `maxTokens` | `pick(a, b)` | isto |
| `defaultPattern` | `pick(a, b)` | isto |
| `systemPromptSuffix` | `[a.suffix, b.suffix].filter(Boolean).slice(0, 2).join('\n')` | **najviše 2** instrukcije; ako oba roditelja imaju pun suffix, dijete ima dvije linije |
| `parentId` | `` `${a.id}+${b.id}` `` | rodoslov pokazuje **oba** roditelja |
| `origin` | `'crossover'` | razlikuje se od mutacije u zapisima |
| `hash` | izračunat iz 4 polja (`:160`) | dva djeteta istih roditelja sa istim izborima = isti `hash` |

**Dvije posljedice dizajna, obje namjerne:**

1. **Suffix se ne „miješa", nego sabira i siječe na 2.** Zato križanje može **izgubiti** instrukciju koju je
   mutacija „zaradila" (ako roditelj ima 3, a dijete uzme 2). To je protivotrov za nagomilavanje prompta.
2. **Nema interpolacije brojeva.** Dijete ima temperaturu **tačno** jednog roditelja (`:151`). Zato populacija
   konvergira ka **postojećim** vrijednostima, a nove vrijednosti unosi **samo mutacija**. Bez mutacije bi
   križanje samo „miješalo" zatečene brojeve.

### Elitizam: `eliteCount: 2`

```js
// genome.js:236–243
const elites = scored.slice(0, cfg.eliteCount).map((x) => ({ ...x.genome }));
const next = [...elites];
while (next.length < size) {
  const parentA = scored[Math.floor(Math.random() * Math.max(2, Math.floor(size / 2)))].genome;
  const parentB = scored[Math.floor(Math.random() * Math.max(2, Math.floor(size / 2)))].genome;
  const child = Math.random() < 0.5 ? crossover(parentA, parentB) : mutate(parentA);
  next.push({ ...child, tenantId });
}
```

Četiri činjenice iz tog koda:

1. **Najbolji se ne mijenjaju.** Dva najbolja genoma ulaze u sljedeću generaciju **identična** (isti `hash`),
   pa najbolji `fitness` **ne može pasti** između generacija samo zbog reprodukcije. To je ono što `improvement`
   u rezultatu čini smislenim brojem (`genome.js:275`).
2. **Roditelji se biraju samo iz „gornje polovine".** `Math.floor(size/2)` = 3 za populaciju 6, pa se uzima iz
   indeksa `0..2` — **najgori nikad nije roditelj**. Selekcija je turnirska sa tvrdim odsjecanjem.
3. **50% djece nastaje križanjem, 50% mutacijom** (`:241`). To je jedini „parametar" koji nije u config-u —
   **planirano** je da postane konfigurabilan.
4. **Veličina populacije se ne mijenja** kroz generacije: `next.length` ide do `size`
   (`Math.max(4, Math.min(populationSize ?? 6, 20))`, `:198`). Nema rasta populacije.

> **Zašto elitizam a ne „svi umiru":** jer se mjeri **apsolutni** `fitness`, a ne rang. Bez elitizma bi
> najbolji genom mogao biti izgubljen u jednoj generaciji i izvještaj „najbolji u generaciji 3" bi bio **gori**
> od generacije 2 — a to je nemoguće objasniti klijentu. Sa elitizmom je garantovano
> `best(g+1) ≥ best(g)`, i kriva se čita bez objašnjenja.

---

## 6. Fitness

*Prolaznost na **zlatnom setu** je osnova ocjene; sve ostalo su kazne. Nema „osjećaja da je bolje".*

### Formula (`genome.js:165–168`)

```js
function fitness({ passRate, costUsd = 0, avgDurationMs = 0, failures = 0 }) {
  const score = passRate
    - cfg.costPenaltyPerUsd * costUsd
    - cfg.latencyPenaltyPerSecond * (avgDurationMs / 1000)
    - failures * 0.01;
  return Number(score.toFixed(4));
}
```

| Član | Težina (iz `config/evolution.json`) | Izvor u izvještaju evaluacije |
|---|---|---|
| `passRate` | 1.0 (osnova) | `report.passRate` = `passed / total`, 3 decimale (`harness.js:139`) |
| `− costPenaltyPerUsd × costUsd` | **5** po USD (`config:14`) | `report.costUsd` = suma `costUsd` svih slučajeva (`harness.js:141`) |
| `− latencyPenaltyPerSecond × (avgDurationMs/1000)` | **0.002** po sekundi (`config:15`) | `report.avgDurationMs` = prosjek **po slučaju** (`harness.js:143`) |
| `− 0.01 × failures` | **0.01** po padu | `report.failures` = **niz** zapisa o padovima (`harness.js:144`) → dužina niza je broj palih slučajeva |

### Zašto prolaznost na ZLATNOM SETU, a ne „osjećaj"

1. **Zlatni set je u repou i pod git-om** (`eval/<tenantId>.json`, `harness.js:26`). To znači: isti set, iste
   provjere, isti prag — i **diff se vidi** kad se set promijeni. „Osjećaj" nema diff.
2. **Provjere su determinističke, ne sudačke.** `mustInclude`, `mustNotInclude`, `mustCite`, `mustUseTool`,
   `mustNotUseTool`, `expectStatus`, `maxCostUsd` (`harness.js:54–69`). Nema LLM-a koji „ocjenjuje" — pa nema
   ni pristrasnosti ocjenjivača u ovoj petlji. Alati se čitaju iz **trace-a** (`harness.js:46–52`), dakle iz
   dokaza, ne iz tvrdnje modela.
3. **Isti metar za sve genome.** Svaki genom se ocjenjuje **istim** `specPatch` mehanizmom po run-u
   (`evaluate` → `evalHarness.run(..., { specPatch })`, `genome.js:186`; `harness.js:102` prosleđuje
   `options.specPatch`). Katalog se **ne** mijenja tokom ocjenjivanja — pa nijedan genom nema privilegiju.
4. **Kazne sprečavaju „jeftinu pobjedu".** Genom koji prođe sve ali košta i traje duplo **gubi** od onog koji
   prođe isto i košta manje. To je jedini mehanizam koji u ovoj petlji čuva trošak.
5. **Prag postoji** (`threshold: 0.8`, `eval/nmq.json:5`; `meetsThreshold`, `harness.js:140`) — ali `fitness`
   koristi **sirovu** `passRate`, ne binarno „prošao prag". Zato razlika `0.83` vs `0.67` ulazi u selekciju kao
   razlika, a ne kao izjednačenje.

### Primjer izračuna za dva genoma

Zajednički uslovi: `setName: 'golden'`, `maxCases: 8` (default rute, `routes-swarm.js:208`), isti zlatni set,
isti model, isti tenant. **Trošak je procjena** — u kodu cijene žive u `PRICING` tabeli
(`src/observability/cost.js:11–21`) sa napomenom „provjeriti!" i `priceSource` (`exact`/`prefix`/`fallback`,
D36); brojevi ispod su **ilustracija formule**, ne tvrdnja o tarifi.

| | Genom A („konzervativan") | Genom B („kreativan") |
|---|---|---|
| `temperature` | 0.10 | 0.85 |
| `maxTokens` | 400 | 1800 |
| `defaultPattern` | `agent` | `reflection` |
| `systemPromptSuffix` | „Odgovori u najviše 5 rečenica, bez uvoda." | (prazno) |
| `total` slučajeva | 8 | 8 |
| `passed` | 7 | 6 |
| `passRate` | **0.875** | **0.750** |
| `costUsd` (procjena) | 0.0021 | 0.0074 |
| `avgDurationMs` (procjena) | 900 | 3400 |
| `failures` (broj palih) | 1 | 2 |

Izračun:

```
Genom A
  passRate                       = 0.875
  costPenalty   = 5 × 0.0021     = 0.0105
  latencyPenalty= 0.002 × 0.9    = 0.0018
  failPenalty   = 0.01 × 1       = 0.0100
  fitness = 0.875 − 0.0105 − 0.0018 − 0.0100 = 0.8527

Genom B
  passRate                       = 0.750
  costPenalty   = 5 × 0.0074     = 0.0370
  latencyPenalty= 0.002 × 3.4    = 0.0068
  failPenalty   = 0.01 × 2       = 0.0200
  fitness = 0.750 − 0.0370 − 0.0068 − 0.0200 = 0.6862
```

**Ishod:** A pobjeđuje (`0.8527 > 0.6862`), a razlika je **0.1665** — daleko iznad `minFitnessGain: 0.05`
(`config:13`). Dvije stvari koje ovaj primjer pokazuje:

- **Prolaznost nosi odluku** (razlika 0.125 u `passRate` je 75% ukupne razlike), a kazne samo pojačavaju smjer.
- **Kazna za trošak je slaba na malim iznosima.** `5 × 0.0074 = 0.037` — dakle genom bi morao potrošiti
  **~0.2 USD** u jednom ocjenjivanju da kazna bude reda veličine jednog palog slučaja (0.01). To je važno:
  **za male eval setove kazna za trošak praktično ne odlučuje.** (Vidi §9, rizik „preoptimizacija".)

Test to potvrđuje direktno: `e.fitness({ passRate: 1, costUsd: 0, avgDurationMs: 0 })` daje **tačno `1`**, a
`e.fitness({ passRate: 1, costUsd: 0.02, avgDurationMs: 1000 })` je **manji** (`tests/swarm.test.mjs:353–356`).

---

## 7. Generacija (tok)

*Jedna generacija = ocjeni sve genome pravim runovima, sortiraj, sačuvaj najbolje, proizvedi ostatak.*

### ASCII dijagram (stvarni kod, ne skica)

```
POST /v1/admin/evolution/evolve  { agentId, populationSize, generations, setName, caseIds, maxCases }
        │                            (routes-swarm.js:204–208; rola admin)
        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 0. SEED populacije                              evolve(), genome.js:201–204  │
│    seed[] → genomeOf() po svakom;  ostalo:  mutate(slučajan postojeći)       │
│    size = clamp(populationSize ?? 6, 4, 20)     gens = clamp(generations,1,10)│
└───────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
      ┌─────────────────────── za svaku generaciju g = 1..gens ────────────────────────┐
      │                                                                               │
      │  1. OCJENA (eval sa specPatch PO RUNU)          genome.js:211–215             │
      │     za svaki genom:  evaluate() → evalHarness.run(setName, maxCases,          │
      │                      specPatch = patchOf(genome))   harness.js:83–103         │
      │     → report { passRate, costUsd, avgDurationMs, failures }                   │
      │     → fitness = passRate − 5·cost − 0.002·s − 0.01·padi   genome.js:165–168   │
      │                                                                               │
      │  2. SORTIRANJE (opadajuće po fitness)            genome.js:216                │
      │                                                                               │
      │  3. ZAPIS GENERACIJE                            genome.js:219–233             │
      │     appendJsonl(generations-YYYY-MM.jsonl, { ts, generation, best{hash,       │
      │       fitness, passRate, costUsd, genome}, worst{hash,fitness}, average,      │
      │       diversity })                                                            │
      │     metrike: evolution_best_fitness (po generaciji)                           │
      │                                                                               │
      │  4. ELITIZAM  eliteCount = 2 → dva najbolja prelaze NEPROMIJENJENA  :236–237  │
      │                                                                               │
      │  5. REPRODUKCIJA do `size`                      genome.js:238–243             │
      │     roditelji iz gornje polovine (indeksi 0..size/2−1)                        │
      │     50% crossover(a,b)   |   50% mutate(a)                                    │
      │     svako dijete: assertSafe → hash → { tenantId }                            │
      │                                                                               │
      └───────────────────────────────┬───────────────────────────────────────────────┘
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 6. PERSIST                                     evolve(), genome.js:247–257    │
│    population.json ← { agentId, tenantId, updatedAt, bestGenome, bestFitness, │
│                        bestPassRate, generations += gens, history[−20:] }      │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 7. AUDIT                                       genome.js:259–267              │
│    action: evolution_run, decision: allow, outcome: ok                        │
│    meta: { bestFitness, bestPassRate, bestHash }                              │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
   rezultat → { agentId, generations, populationSize,
                best { genome, fitness, passRate, costUsd }, history, improvement }
```

### Šta se zapisuje

| Fajl / tok | Putanja | Sadržaj | Kod |
|---|---|---|---|
| **Generacije (append-only)** | `data/tenants/<id>/evolution/generations-YYYY-MM.jsonl` | jedan red po generaciji: `ts`, `generation`, `populationSize`, `best{hash,fitness,passRate,costUsd,genome}`, `worst{hash,fitness}`, `average`, `diversity` | `genome.js:67`, `:219–231` |
| **Stanje populacije** | `data/tenants/<id>/evolution/population.json` | po agentu: `bestGenome`, `bestFitness`, `bestPassRate`, ukupan broj generacija, zadnjih **20** zapisa historije | `genome.js:66`, `:247–257` |
| **Rezultati ocjenjivanja** | `data/tenants/<id>/eval/results-YYYY-MM.jsonl` | jedan red po **slučaju** (pitanje, `passed`, `failures`, `tools`, `costUsd`, `durationMs`, skraćeni `output` na 1000 znakova) | `harness.js:109–128` |
| **Audit** | `data/tenants/<id>/audit/audit.jsonl` | `evolution_run` (svaki pokret) i `evolution_auto_promote` (samo ako je uključen) | `genome.js:259–267`, `:316` |
| **Metrika (po generaciji)** | `/metrics` | `nmq_evolution_best_fitness{tenant,agent,generation}` — **histogram**, jer `observe` radi histogram (`metrics.js:30–41`), buckets `[0.05…60]` | `genome.js:232` |
| **Metrika (po ocjenjivanju)** | `/metrics` | `nmq_evolution_fitness{tenant,agent}` — histogram; ime dobija prefiks `nmq_` (`metrics.js:31`) | `genome.js:188` |
| **Metrika (prijedlozi)** | `/metrics` | `nmq_evolution_promotions_proposed_total{tenant,agent}` — counter | `genome.js:298` |

### Kako se to čita

| Pitanje | Odakle se čita |
|---|---|
| „Da li se populacija poboljšava?" | `history[].best.fitness` i `result.improvement` (`genome.js:275`) |
| „Da li su svi genomi isti?" | `diversity` = `Set(hashes).size / scored.length` (`genome.js:228`); `1.0` = svi različiti, `0.2` = klonovi |
| „Zašto je najbolji pao?" | **Ne može pasti** unutar jednog `evolve` poziva (elitizam), ali **može** između poziva ako se zlatni set promijenio ili je model drugi |
| „Koliko je ocjenjivanja potrošeno?" | broj redova u `eval/results-*.jsonl` u tom periodu; svaki red je jedan **stvarni** run |

> **Cijena jednog `evolve` poziva (procjena, iz koda).** `generacija × populacija × slučajevi` = za default
> `3 × 6 × 8` → **144 run-a**. Nema keša: `harness.run` nema memoizaciju (`harness.js:83–129`), a `evaluate`
> se poziva za svaki genom u svakoj generaciji (`genome.js:212–215`). Test koristi `populationSize: 4`,
> `generations: 2`, `maxCases: 2` (`tests/swarm.test.mjs:370`) — dakle **16 run-a**, i to je razlog zašto test
> traje pod sekundu. U produkciji sa `maxCases: 50` (default `harness.run`) jedan poziv je **900 run-a** —
> zato ruta ima `maxCases: 8` kao default (`routes-swarm.js:208`).

---

## 8. Promocija

*Pobjednik se **nikad** ne deployuje sam. On postaje **prijedlog u inbox-u**; čovjek odlučuje.*

### `proposePromotion` — prijedlog (default put)

```js
// genome.js:280–301 (skraćeno)
const best = genome ?? entry?.bestGenome;
if (!best) throw new ValidationError('Nema evoluisanog genoma za agenta …');
if (!improvements) throw new PolicyError('Improvement engine nije dostupan — promocija ide kroz njega');
const proposal = await improvements.createProposal(tenantId, {
  kind: 'prompt', target: agentId,
  current: catalog.get(agentId, tenantId)?.systemPrompt?.slice(0, 300) ?? null,
  proposed: `${base}\n\n${best.systemPromptSuffix ?? ''}`.trim(),
  rationale: `Evolucija: genom ${best.hash} (temperatura …, maxTokens …, pattern …) ima fitness …`,
  evidence: [{ genome: best, fitness: entry.bestFitness, passRate: entry.bestPassRate, generations: entry.generations }],
  expectedImpact: 'veća prolaznost na zlatnom setu uz isti budžet',
  riskLevel: 'medium', source: 'evolution',
});
return { proposal, genome: best, fitness: entry.bestFitness, autoPromote: false };
```

| Osobina | Vrijednost | Kod |
|---|---|---|
| Tip prijedloga | **`prompt`** (jedini) | `:288` |
| Izvor | `source: 'evolution'` | `:296` |
| Rizik | `riskLevel: 'medium'` | `:295` |
| Status po kreiranju | `proposed` + `requiresHuman: true` (tvrdo u `createProposal`) | `improvements.js:81–83` |
| Eksterni efekat | **nema** — samo zapis + metrika + log (`warn` nivo) | `:298–299` |
| Dalji tok | `decide` (čovjek) → `apply` → `controlPlane.deploy` → `rollbackInfo` | `improvements.js:128–150`, `:165–176` |

**Ključno ograničenje koje treba znati:** prijedlog prenosi **samo `systemPromptSuffix`** (`:291`). Vrijednosti
`temperature`, `maxTokens` i `defaultPattern` stoje **samo u `rationale` i `evidence`** — one se kroz ovaj tok
**ne primjenjuju**. Za njih postoji samo `maybeAutoPromote` (koji je isključen) ili ručni deploy. Asimetrija je
stvarna i **planirana** za popravku: prijedlog bi trebao nositi `specPatch` sa sva četiri polja.

### `maybeAutoPromote` — default ISKLJUČEN

```js
// genome.js:304–319
if (!cfg.autoPromote) return { promoted: false, reason: 'auto-promote je isključen u config/evolution.json (safety default)' };
const gate = (minGain ?? cfg.minFitnessGain) <= (entry.bestFitness ?? 0);
if (!gate) return { promoted: false, reason: `fitness … ne prelazi kapiju …` };
const deployed = await controlPlane.deploy(tenantId, agentId, {
  patch: { temperature, maxTokens, defaultPattern }, actor: 'evolution:auto', note: `auto-promote genoma ${hash} …`,
});
await audit?.append({ …, action: 'evolution_auto_promote', decision: 'allow', outcome: 'ok' });
```

**Zašto je isključen (i zašto to nije tehnička slabost, nego odluka):**

1. **Kapija je pogrešna veličina.** `minFitnessGain: 0.05` se poredi sa **apsolutnim** `entry.bestFitness`
   (`:309`) — ne sa **razlikom** prema baseline-u. Za agenta čiji je baseline fitness `0.80`, kapija `0.05` je
   automatski **prošla** (`0.80 ≥ 0.05`), čak i ako je evolucija **pogoršala** stvar. Kapija je danas
   formalnost, ne zaštita. Popravka (poređenje sa baseline-om) je **planirana**.
2. **Auto-deploy bez čovjeka znači da metar odlučuje o produkciji.** Ako je zlatni set uzak (§9), automatski
   deploy prenosi **uskoću** seta u produkciju bez ijednog čovjeka u petlji.
3. **Prolaznost na 8 slučajeva nije dokaz.** `maxCases: 8` (default rute) znači da jedan slučaj nosi **12.5%**
   `passRate`. Razlika od jednog slučaja je veća od `minFitnessGain`. Deploy na osnovu toga je kockanje.
4. **`/auto-promote` traži rolu `owner`** (`routes-swarm.js:222–224`) — dakle čak i da je uključen, put je
   namjerno najviša rola, ne `admin`.

Test to čuva kao invarijantu: `assert.equal(auto.promoted, false)` + `assert.match(auto.reason, /auto-promote je isključen/)`
(`tests/swarm.test.mjs:387–389`) i `assert.equal(proposal.autoPromote, false)` (`:381`).

### Kako rollback ide preko control plane verzija

```
proposePromotion → createProposal(kind:'prompt')        improvements.js:64–100
        │                       status: 'proposed'
        ▼  čovjek:  POST /v1/admin/proposals/:id/decide { approve: true }
                                                         improvements.js:128–150
        │                       status: 'approved'
        ▼  čovjek:  POST /v1/admin/proposals/:id/apply  improvements.js:157–176
   controlPlane.deploy(tenantId, agentId, { patch: { systemPrompt }, actor: `improvement:${id}` })
        │                       registry.js:122–140
        │   → a.versions += { version: N, patch, actor, note, createdAt, specHash }
        │   → a.overrides = { …staro, …patch }        a.activeVersion = N
        │   → catalog.setOverride(tenantId, agentId, overrides)   (D33: samo taj tenant)
        ▼
   p.rollbackInfo = { type: 'control-plane', agentId, version: N }    improvements.js:174
        │                       status: 'applied'
        ▼  čovjek:  POST /v1/admin/proposals/:id/rollback
   controlPlane.rollback(tenantId, agentId, max(0, N − 1))            improvements.js:234–235
        │                       registry.js:142–163
        │   → overrides se REKONSTRUIŠU sabiranjem svih verzija ≤ N−1
        │   → ako je rezultat prazan → catalog.clearOverride (nazad na config)
        ▼
   status: 'rolled_back'   (audit: improvement_rollback)
```

Četiri svojstva ovog puta:

1. **`config/*.json` se ne dira** — override živi u `data/_control/agents.json` (`registry.js:17`) i nestaje
   jednim `clearOverride`.
2. **Rollback je po tenantu.** `catalog.setOverride(tenantId, …)` znači da deploy za jednog klijenta **ne**
   mijenja ponašanje istog agenta kod drugog (D33, dokazano u `tests/revision.test.mjs`).
3. **Rollback se zapisuje kao nova verzija**, ne kao brisanje (`registry.js:155`) — pa je lanac
   „deploy → rollback → deploy" vidljiv, a ne prepisan.
4. **`genome.hash` ostaje u `rationale`/`evidence` prijedloga** — pa se poslije može vezati „koja verzija
   agenta odgovara kojem genomu". Automatska veza te dvije stvari je **planirana** (§2, napomena o `hash`-u).

---

## 9. Rizici evolucije

*Ovo poglavlje je namjerno neprijatno. Svaki rizik ima: kako se manifestuje, čime se **danas** detektuje i šta
je mitigacija (postojeća ili planirana).*

| Rizik | Kako se manifestuje | Detekcija (danas) | Mitigacija |
|---|---|---|---|
| **Usko grlo evaluacije — sistem uči da prođe test, ne da radi posao** | `passRate` raste, `fitness` raste, a stvarni ishod (ticket zatvoren, faktura tačna) se ne popravlja. Zlatni set od **6** pitanja (`eval/nmq.json`) nosi **16.7%** po slučaju — genom može „naučiti" fraze iz provjera (`mustNotInclude: ["ne znam"]`) | `nmq_evolution_best_fitness` raste **bez** promjene `nmq_reward_value`/`avgReward` na stvarnom saobraćaju (`rewards.aggregate`, `docs/21` §2). Ako te dvije krive idu u različitim smjerovima — to je signal | **Postojeća:** dvije nezavisne mjere (eval vs reward na stvarnom saobraćaju), `impact` mjerenje (`docs/21` §8). **Planirana:** vezivanje nagrade na **ishod** (konektori), veći i teži set |
| **Deceptivna specijalizacija** | Genom nađe kombinaciju koja prolazi **taj** set: npr. suffix „Koristi tabele kada porediš više od dvije opcije." + `temperature 0.05` daje kratke, „sigurne" odgovore bez alata — a `mustUseTool` provjera postoji samo na **jednom** od 6 slučajeva (`eval/nmq.json:13`) | `report.cases[].tools` pokazuje **koji** slučajevi nemaju alate (`harness.js:145`). Genom sa `passed: true` i `tools: []` na 5/6 slučajeva je sumnjiv | **Postojeća:** `mustUseTool`/`mustNotUseTool` provjere. **Planirana:** obavezan `mustUseTool` na većini slučajeva, i „tvrdi" slučajevi koji se **ne** mogu proći bez alata |
| **Gubitak raznolikosti (svi genomi isti)** | Svi `hash`-evi u generaciji isti → `diversity` pada ka `0.2` (= `2/6` koliko nosi elitizam). Dalje generacije samo ponavljaju isti genom, `average == best` | `diversity` u **svakom** redu `generations-*.jsonl` (`genome.js:228`) i u logu `evolution.generation` (`:233`) | **Postojeća:** `mutationRate: 0.4` (mutacija uvijek nešto promijeni u ~87% slučajeva). **Planirana:** kazna za duplikate u selekciji, „novi rod" (imigranti) u svakoj generaciji |
| **Preoptimizacija na jedan set** | Genom sa `fitness` 0.95 na `golden` padne na `holdout` setu. Danas postoji samo jedan set po tenantu (`eval/<id>.json`) | Poređenje `passRate` između dva seta — danas **ručno** (`setName` parametar postoji, `genome.js:184`, ali nijedan drugi set nije u repou) | **Planirana:** multi-set evaluacija (§11 faza 2) — `golden` + `holdout` + `adversarial`; `fitness` bi koristio minimum ili ponderisani zbir |
| **Mutacija slučajno pogodi jeftin trik („uvijek odgovori isto")** | Konkretno: suffix „Odgovori u najviše 5 rečenica, bez uvoda." (`config:18`) + niska temperatura daje kratak, uvjerljiv, **prazan** odgovor koji prolazi `mustNotInclude` provjere. Dodatno: `maxTokens: 200` (donja granica, `config:10`) skraćuje odgovor toliko da neki `mustInclude` **padne** — pa selekcija sama tjera ka sredini | `report.cases[].costUsd` i `durationMs` (jeftino = sumnjivo ako `passRate` ne raste), plus `output` u `results-*.jsonl` (prvih 1000 znakova, `harness.js:123`) — čitanje **stvarnih** odgovora je jedina prava detekcija | **Postojeća:** `mustInclude` provjere, `mustCite`, `maxCostUsd` po slučaju (`harness.js:66`). **Planirana:** provjera „odgovor mora sadržati **činjenicu** iz baze znanja", ne samo odsustvo fraze |
| **Drift kroz generacije** | Genom „nauči" instrukciju u generaciji 2, ona se izgubi u generaciji 4 (suffix se siječe na 3 linije, `:139`), a `bestFitness` ostane visok jer elitizam čuva **stari** genom. Ukupan `generations` brojač raste (`:254`), a veza „koja verzija agenta ↔ koji genom" se gubi | `population.json → history[−20:]` čuva samo **20** zadnjih zapisa (`:255`) — stariji dokazi se ne čitaju kroz API | **Planirana:** trajni „rodoslov" (bez `slice(-20)`), i `genome.hash` ↔ `controlPlane` `specHash` veza u svakom deploy-u |
| **Trošak evaluacije raste tiho** | `3 × 6 × 8 = 144` run-a po pozivu (default); sa `maxCases: 50` → **900** run-a. Ruta ima `maxCases: 8`, ali parametar je slobodan (`routes-swarm.js:208`) | `eval/results-*.jsonl` broj redova + `nmq_cost_usd_total` po tenantu (`src/observability/cost.js`) | **Postojeća:** kazna za trošak u `fitness` (slaba, §6) + `maxCases` default. **Planirana:** tvrdi budžet **po `evolve` pozivu** (kao `maxRunUsd`, `harness.js:102`), i keš ocjena po `hash`-u (isti genom se danas ocjenjuje iznova) |
| **`assertSafe` ne vidi ugniježđena polja** | Genom sa `meta: { budget: 999 }` prolazi provjeru jer `Object.keys` vidi samo `meta` (`:104`). Danas nije eksploatabilno kroz HTTP (ruta ne prima `seed`, `routes-swarm.js:204–208`), ali je rupa u invarijanti | Ručni pregled genoma u `population.json` | **Planirana:** duboka provjera ključeva (`deepKeys(genome)` ∩ `FORBIDDEN_FIELDS`) |
| **Kapija auto-promocije ne mjeri napredak** | `minFitnessGain: 0.05` poredi se sa `entry.bestFitness`, ne sa baseline-om (`:309`) — kapija prolazi i kad je evolucija **pogoršala** | — (danas se ne vidi, jer je `autoPromote: false`) | **Planirana:** kapija mora biti `bestFitness − baselineFitness ≥ minFitnessGain` |

---

## 10. Šta bi bio pravi trening

*Evolucija **nije** trening. Ona mijenja 4 polja spec-a. Pravi trening mijenja **težine modela** — i zato ide
**van ovog procesa**, kao zaseban korak sa zasebnim dokazom.*

### Put od dataseta (`docs/22`) do SFT/LoRA/DPO

```
self-play (docs/22)                          evolucija (ovaj dokument)
  scenariji → solver → judge                  4 polja genoma + zlatni set
        │                                            │
        ▼                                            ▼
learning/training-YYYY-MM.jsonl              learning/proposals.json
 (scenario, solution, difficulty, score)      (kind: 'prompt', source: 'evolution')
        │ selfplay.dataset(tenantId,{onlyPassed:true})
        ▼   → { examples: [{ task, context, solution, difficulty, score }] }
   IZVOZ u SFT/DPO format
        │
        ▼
   ┌────────────────────────────────────────────────────────────┐
   │  TRENING — VAN NMQ PROCESA (planirano)                     │
   │  GPU (LoRA/adapter)  ili  API fine-tune kod provajdera     │
   └──────────────────────────────┬─────────────────────────────┘
                                  ▼
   novi model / novi adapter  →  NOVI PROVIDER U CONFIG-U
   (nikad „genom"; model se menja kao `model` polje, D6)
                                  ▼
   A/B protiv baznog modela (improvements.createExperiment, docs/21 §7)
                                  ▼
   ako je bolji → controlPlane.deploy (verzija) → rollback ako nije
```

### Šta treba (i čega danas nema)

| Uslov | Zahtjev | Stanje danas |
|---|---|---|
| **Količina (procjena)** | **Red veličine: stotine do hiljade provjerenih primjera** po agentu/domenu. Ispod toga LoRA nauči stil, ne sposobnost | `selfplay.dataset()` postoji (`selfplay.js:195–205`) i filtrira `passed`; **broj prikupljenih primjera nije provjeren u ovom zadatku** — tvrdi se samo da mehanizam postoji |
| **Kvalitet** | Svaki primjer mora imati **ocjenu nezavisnu od generatora**. Danas je to `critic` (`src/agents/critic.js`) + `rewards.score` | Djelimično: `judge` u self-play-u + reward model. **Pristrasnost ocjenjivača je priznata** (`docs/21` §10 tačka 3) |
| **Licenca / pravo** | Podaci iz self-play-a su iz sopstvenog rada → najčistiji slučaj. **Ali:** ako se trenira na izlazima komercijalnog modela, uslovi provajdera se moraju provjeriti **prije** treninga | **Nije provjereno** — planirano kao prvi korak faze 3 |
| **GPU / API** | LoRA na malom modelu ili API fine-tune. **Cijena je procjena** i mora se uzeti od provajdera u trenutku odluke | Nema izmjerenog troška. Postojeći `PRICING` (`cost.js:11`) pokriva **inference**, ne trening |
| **Eval koji je jeftiniji od rizika** | Bez zlatnog seta se ne zna je li fine-tune bolji. **Ovaj preduslov je ispunjen** (D47) | ✅ `eval/<tenantId>.json` + `harness.run` + prag 0.8 |
| **Mjesto pokretanja** | **Van procesa.** Node proces ne smije da nosi trening (D2: `dependencies: {}`, nema GPU) | ✅ odluka; trening je zaseban korak/tool, ne funkcija robota |
| **Kako se rezultat vraća** | Novi **model/provider** u config-u (D6: `llm` adapter preko `fetch`), pa A/B, pa deploy | ✅ mehanizam postoji (A/B po run-u + control plane), samo nije korišten za model |

### Zašto to **NE** radimo automatski

Četiri razloga, svi provjerljivi u kodu:

1. **Nema mjesta u petlji.** `evolve` poziva `evalHarness.run` i `orchestrator.run` — nema nijedne tačke gdje
   bi se pokrenuo trening bez da se doda nova zavisnost (D2 to zabranjuje za obavezni put).
2. **Dataset se tek skuplja.** `selfplay.dataset` je **čitač** fajla (`selfplay.js:195`); kvalitet i broj
   primjera zavise od stvarnog rada. Treniranje na malom, pristrasnom datasetu daje model koji **izgleda**
   autoritativno — a to je gore od baznog modela, jer se greška ne vidi.
3. **Rollback modela je teži od rollback-a prompta.** Prompt: `rollbackInfo` + jedna verzija
   (`improvements.js:174`). Model: novi provajder, nova cijena, nova latencija, novi `PRICING` unos
   (`cost.js:23–28`) i `priceSource: 'fallback'` ako model nije u tabeli (D36). To je više stvari koje mogu
   tiho pobjegći.
4. **Kapacitet postoji bez treninga.** Danas evolucija mijenja 4 polja i to je **dovoljno** da se dokaže cijela
   petlja: mjeri → biraj → predloži → odobri → primijeni → izmjeri efekat → rollback. Trening je **optimizacija
   već dokazane petlje**, ne preduslov za nju (`docs/21` §1, „ispravan redoslijed").

---

## 11. Plan (12–24 mj.)

*Svaka faza ima **dokaz** koji se mora pokazati prije nego što sljedeća počne. Faze se ne preskaču.*

| Faza | Period (procjena) | Šta se radi | Dokaz (mjerljiv) | Rizik ako se preskoči |
|---|---|---|---|---|
| **1. Evolucija prompta/parametara (SADA)** | 0–3 mj. | Ono što je u kodu: `mutate`/`crossover`/`fitness`/`evolve`/`proposePromotion`; prijedlog kroz inbox; ručni `apply` | `node --test tests/swarm.test.mjs` → **20/20**, tri evoluciona testa prolaze; `evolve` zapisuje `generations-*.jsonl` i `population.json` | Bez ovoga nema `hash`-a, nema historije i nema osnove za bilo koju tvrdnju o „boljem" |
| **2. Multi-set evaluacija** | 3–9 mj. | `golden` + `holdout` (nikad ne ulazi u selekciju) + `adversarial` (slučajevi koji se **ne mogu** proći bez alata); `fitness` koristi minimum ili ponderisani zbir; `evolve` bira po `golden`, **prijavljuje** `holdout` | Dokaz da genom sa najboljim `golden` **nije** najbolji na `holdout` (ili jeste — oba ishoda su dokaz). Metrika: `nmq_eval_pass_rate{set="holdout"}` | Bez ovoga evolucija optimizuje jedan set, a proizvodnja je drugi — klasična overoptimizacija |
| **3. Prvi SFT na jednom agentu** | 9–15 mj. | Jedan agent (kandidat: `support`), dataset iz `selfplay.dataset()` + zlatni set kao **eval**; trening **van procesa**; model se vraća kao novi `model` u config-u; A/B protiv baznog modela | `improvements.createExperiment` sa dvije varijante (bazni model vs fine-tuned) → `concludeExperiment` daje `lift`; **`lift > 0.03`** (`improvements.js:337`) i `winner.n ≥ minSamples` (`:331`) | Fine-tune bez A/B-a je promjena koja se ne može ni dokazati ni vratiti — samo vjerovati |
| **4. DPO na ljudskim ocjenama** | 15–24 mj. | Parovi (odgovor A bolji od B) iz `feedback` + `approval` zapisa (`docs/21` §3); **nezavisan** eval set koji čuva čovjek; trening preferencija van procesa | Dovoljan broj ljudskih ocjena po domenu (**red veličine: hiljade — procjena**), dokaz da je reward model stabilan (nema „igranja", `docs/21` §10 tačka 1), i `impact` mjerenje poslije primjene (`docs/21` §8) | Pristrasnost ocjenjivača se **nauči** i poslije izgleda kao istina; bez nezavisnog seta nema ko da to primijeti |

**Redoslijed nije proizvoljan:** faza 2 daje **metar** bez kojeg faza 3 ne zna je li bolja; faza 3 daje
**jedan dokazan model** prije nego faza 4 uvede **skup preferencija**. Svaka faza je skuplja i teže se vraća
od prethodne — zato preduslov, a ne datum.

---

## Otvorena pitanja

1. **Koliki `maxCases` je odbranjiv?** Danas ruta ima `8` (`routes-swarm.js:208`), `harness.run` default `50`
   (`harness.js:83`), a zlatni set ima **6** slučajeva (`eval/nmq.json`) — pa je `maxCases` iznad 6 **mrtav
   parametar**, a na 6 slučajeva jedan pad nosi 16.7% `passRate`. Koliki set je minimum za odluku o deploy-u?
2. **Da li `fitness` treba da bude minimum preko više setova** (worst-case) ili ponderisani zbir? Minimum je
   sigurniji ali tjera ka „prosječnom" genomu; zbir nagrađuje specijalizaciju. Koja je odluka odbranjiva pred
   klijentom?
3. **Kako vezati `genome.hash` sa `controlPlane` verzijom agenta?** Danas `proposePromotion` nosi `hash` u
   `rationale`/`evidence` (tekst), a `deploy` pravi `specHash` (`registry.js:133`) — dvije reference koje se
   mogu ručno spojiti, ali ih ništa ne spaja automatski. Treba li `deploy` primati `genomeHash` kao polje?
4. **Šta sa kaznom za trošak na malim iznosima?** `5 × 0.0074 = 0.037` je manje od jednog palog slučaja
   (0.01 × 2 = 0.02, isti red veličine) — dakle trošak **skoro ne utiče** na selekciju dok je eval mali. Da li
   povećati `costPenaltyPerUsd`, uvesti **relativnu** kaznu (trošak po riješenom slučaju) ili ostaviti i
   rješavati na nivou budžeta?
5. **Da li `autoPromote` ikad treba uključiti — i pod kojim uslovom?** Ako kapija postane
   `bestFitness − baselineFitness ≥ minFitnessGain` **i** set ima `holdout` **i** `n` je iznad minimuma, da li
   je automatski deploy prompta (ne temperature, ne patterna) prihvatljiv? Ili auto-promocija ostaje trajno
   isključena, a „auto" znači samo „auto-predlog"?
6. **Ko mijenja zlatni set — i kako se to štiti?** Ako agent (ili RSI prijedlog tipa `code`) može dopuniti
   `eval/<tenantId>.json`, onda mijenja **metar po kojem se mjeri**. Ostaje li izmjena eval seta trajno
   izvan domašaja self-improvementa (kao reward težine, `docs/21` otvoreno pitanje 6)?
