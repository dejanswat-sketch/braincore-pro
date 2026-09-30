# 22 — Self-play: agent sam sebi pravi trening

> **Nivo:** v0.3.0 (autonomni nivo, `DECISIONS.md` §9) · **Kod:** `src/learning/selfplay.js` (231 linija), `src/agents/critic.js`,
> `src/learning/improvements.js`, `src/server/routes-autonomy.js` (sekcija *Self-play*), `src/agents/agent.js`
> · **Testovi:** `tests/autonomy.test.mjs` (24/24 prolazi, provjereno lokalno)
> · **Vezani dokumenti:** `DECISIONS.md` §6–§9 (posebno **D42** self-improvement bez fine-tuninga i **D46** RSI),
> `docs/00-VIZIJA.md`, `docs/04-ORCHESTRACIJA.md`, `docs/20` (nivoi autonomije L0–L4),
> `docs/21` (prijedlozi poboljšanja i mjerenje efekta), `docs/23` (RSI).
>
> **Jedna rečenica:** self-play je petlja **proposer → solver → judge** koja proizvodi (a) dokaz gdje agent pada,
> (b) dataset zapisan u `learning/training-YYYY-MM.jsonl`, (c) kurikulum i (d) prijedlog poboljšanja prompta
> koji **čovjek odobrava**. On **ne trenira model** — i to je namjerno.
>
> **Napomena o odluci:** self-play **nema** svoju `D`-odluku u `DECISIONS.md` §9 (provjereno: D37–D46 ne
> pominju self-play). Pokriven je kroz **D42** („prvo mjerenje i dokaz, pa trening") i **D46** (RSI).
> Planirano: dodati odluku koja fiksira da self-play **ne** smije deployovati ništa bez čovjeka i da dataset
> ne napušta tenant bez redakcije i pravne osnove.

---

## 1. Šta self-play jeste (i šta nije)

### 1.1 Jeste — šest stvari, sve u kodu

| # | Šta radi | Gdje je u kodu |
|---|---|---|
| 1 | **Generiše scenarije** iz domena agenta (task, kontekst, očekivani ishod, težina, provjere) | `selfplay.js` → `proposeScenario()` (LLM poziv, `role: 'selfplay-proposer'`) |
| 2 | **Rješava ih** kroz pravog agenta i njegove alate (ne kroz „simulaciju") | `selfplay.js` → `runAgent(solver, …)` sa `pattern: 'selfplay'` |
| 3 | **Ocjenjuje** rješenje determinističkim heuristikama (+ opciono LLM sudijom) | `critic.review()` u `src/agents/critic.js` |
| 4 | **Zapisuje dataset** — jedan JSONL red po scenariju, i uspješni i neuspješni | `appendJsonl(dsFile(tenantId), example)` |
| 5 | **Vodi kurikulum** — prolaz → teže, pad → lakše; izvještaj po težini i domenu | `selfplay.js` linija 126 + `curriculum()` |
| 6 | **Predlaže poboljšanje** ako je prolaznost ispod praga (nikad ne mijenja samo) | `improvements.createProposal({ kind: 'prompt', source: 'self-play' })` |

### 1.2 NIJE — treniranje modela

Ovo je najvažnija rečenica u dokumentu i u kodu je zapisana eksplicitno (komentar u `selfplay.js`, linije 13–14):

> ⚠️ Iskreno: ovo NE trenira model. Ovo proizvodi (a) dokaze gdje agent pada i (b) dataset za fine-tune
> koji se pokreće van ovog procesa (GPU/API).

**Zašto ne:** NMQ Robot je ESM projekat sa **nula obaveznih npm zavisnosti** (`DECISIONS.md` D2, D32).
U procesu nema PyTorcha, nema CUDA, nema gradijentnog koraka. Nijedna linija koda u repozitorijumu ne
radi backprop. Sam trening je **posao van sistema**: GPU mašina (vlastita ili iznajmljena) ili
**API fine-tune** kod provajdera (npr. OpenAI-kompatibilni provider). Self-play je *priprema* za taj posao.
Ovo nije slučajnost nego odluka: **D42** („Self-improvement bez fine-tuninga") propisuje redoslijed
*mjerenje → dokaz → (kad postoji dataset i eval) trening*.

### 1.3 Zašto je dataset ipak vrijedan (i bez treninga)

| Vrijednost | Objašnjenje | Status |
|---|---|---|
| **Dokaz gdje agent pada** | Svaki red nosi `issues` i `score` — vidi se *koja klasa* zadatka pada (politika povraćaja, rok, citat), ne samo „prolaznost 62%" | ✅ radi |
| **Zlatni set za eval harness** | Isti JSONL se može koristiti kao regresioni set prije svakog `deploy`-a prompta | ⚠️ planirano (`DECISIONS.md` §7: *Eval harness — ❌ planirano*) |
| **SFT/DPO materijal** | Uspješni parovi `task → solution` su gotov nadzirani signal za nadogradnju prompta/modela | ✅ format je spreman, izvozna skripta nije |
| **Ulaz za izmjenu prompta i baze znanja** | Padovi se grupišu po `issues` → konkretna rečenica u system promptu ili dokument u KB | ✅ djelimično (samo prompt, vidi §7) |
| **Mjerenje regresije** | Prolaznost po težini prije/poslije izmjene prompta je nezavisan signal od reward modela | ⚠️ planirano |

### 1.4 Šta tačno fali do pravog treninga

1. **Obim.** Trening traži red veličine više primjera nego što jedna noć proizvede (vidi §6.5 — procjena).
2. **Izlaz iz procesa.** Trening = drugi proces/druga mašina; ovdje postoji samo fajl.
3. **Kvalitetan kriterij.** Judge je danas heuristika + opciono **isti LLM** koji je rješavao zadatak (§9.1).
4. **Redakcija prije izvoza.** Dataset **ne prolazi PII redakciju** pri upisu (za razliku od epizodične memorije,
   `src/memory/episodic.js` koristi `redactPii`). Prije izvoza iz sistema to je obavezno — planirano.
5. **Pravni osnov.** Podaci tenanta se ne smiju koristiti za trening bez pokrivenog ugovora/DPA
   (`docs/08`, `docs/17`). Dataset je fizički izolovan po tenantu (`data/tenants/<id>/learning/`), ali
   izolacija nije isto što i dozvola za trening.

---

## 2. Tri uloge

| Uloga | Ko je u kodu | Šta generiše / radi | Prompt, role, parametri | Izlaz |
|---|---|---|---|---|
| **Proposer** | **Nije agent iz kataloga.** Direktan LLM poziv kroz `helpers.callLlm` | Jedan realan scenario iz domena (JSON) | `role: 'selfplay-proposer'`, `temperature: 0.8`, `maxTokens: 600`, `responseFormat: {type:'json_object'}` | `{ task, context, expected, difficulty, checks[] }` + `costUsd`, `usage` |
| **Solver** | **Agent domena iz kataloga**: `catalog.get(solverAgent, tenantId)` — default `support` | Rješava scenario kroz **alate** (kao pravi zahtjev) | `runAgent(solver, "<task>\n\nKontekst: …\n\nOčekivano: …", ctx)` sa `pattern: 'selfplay'`, `recordEpisode: false` | `{ output, status, steps, costUsd, usage }` ili `error` |
| **Judge** | `critic` (`src/agents/critic.js`) | Determinstičke heuristike (brzo, besplatno) + **opciono** LLM ocjena | `critic.review({ task, output, criteria: checks, useLlm, threshold, tenantId, ctx })` | `{ verdict: 'accept'\|'revise', score, issues[], suggestion, method }` |
| **(4) Improver** | Direktan LLM poziv — javlja se **samo** ako je prolaznost ispod `proposeBelow` | Novi system prompt iz padova | `role: 'selfplay-improver'`, `temperature: 0.2`, `maxTokens: 900` | tekst novog prompta → upisuje se u već otvoren prijedlog (`updateProposal`) |

Detalji koji se često pogrešno pretpostavljaju, a stoje u kodu:

- `proposer` **nije** `planner` agent i ne prolazi kroz orchestrator — to je jedan `callLlm` poziv.
  Prednost: jeftino i bez patterna. Nedostatak: nema alata, pa scenario ne može sam pogledati CRM ili tickete
  (osim onoga što mu se prosledi kroz `seedFailures`).
- `ctx.agentId` za **sve** pozive u ciklusu je `solverAgent` — trošak se u `usage/YYYY-MM.jsonl` knjiži na
  solver agenta sa `meta.pattern: 'selfplay'`, pa je noćni trening vidljiv u izvještaju po agentu.
- `runAgent` se zove sa `recordEpisode: false`, ali **epizoda se ipak upisuje** ako je solver koristio alate:
  uslov u `agent.js` je `spec.episodic !== false && (toolSteps.length || ctx.recordEpisode === true)`.
  Zato self-play posredno puni i epizodičnu memoriju (few-shot) — vidi zamku u §9.6.
- JSDoc `run()` navodi `{ domain, rounds, solverAgent, proposerAgent, judge, difficulty, seedFailures, maxCostUsd }`,
  a kod **stvarno koristi**: `domain`, `rounds`, `solverAgent`, `difficulty`, `seedFailures`, `threshold`,
  `proposeBelow`, `useLlmJudge`, `budget`, `trace`, `runId`, `signal`.
  `proposerAgent`, `judge` i `maxCostUsd` su **dokumentovani, a neimplementirani** (planirano: ili ih ukloniti iz
  JSDoc-a ili implementirati).

```jsonc
// Stvarni izlaz jedne runde (skraćeno) — ono što `run()` vraća pozivaocu:
{
  "domain": "support",
  "solverAgent": "support",
  "rounds": 3,
  "passes": 2,
  "passRate": 0.667,
  "finalDifficulty": 3,
  "costUsd": 0.004821,
  "usage": { "tokensIn": 5120, "tokensOut": 890 },
  "results": [
    { "task": "Kupac traži povraćaj za narudžbinu 1042", "difficulty": 3, "score": 0.85, "passed": true, "issues": [] }
  ],
  "proposalId": null
}
```

---

## 3. Scenario — JSON šema koju proposer vraća

### 3.1 Polja i kako se koriste

| Polje | Tip | Obavezno u kodu? | Kako se koristi |
|---|---|---|---|
| `task` | string | **Da** — `if (!parsed?.task) throw new ValidationError('Proposer nije vratio scenario')` | Ulaz solver agenta (prvi red prompta) i `criteria` za sudiju |
| `context` | string | Ne (`?? ''`) | Drugi red prompta solvera: `Kontekst: …` |
| `expected` | string | Ne (`?? ''`) | Treći red prompta: `Očekivano: …` (nije isto što i `checks` — ovo je *opis*, ne *provjera*) |
| `difficulty` | 1–5 | Ne — `Number(parsed.difficulty ?? difficulty)` | Upisuje se u dataset i u izvještaj kurikuluma. **Ako proposer vrati smeće, u dataset ide `NaN`** (nema validacije opsega — planirano) |
| `checks` | string[] | Ne (`?? []`) | Ide u `critic.review` kao `criteria`. **Heuristike ih ne čitaju** — koristi ih samo LLM sudija (§4.3) |

Nepoznata polja iz LLM odgovora **se ne odbacuju** — `return { ...parsed, difficulty: … }` ih zadržava u
objektu `scenario`, ali se u dataset ne upisuju (dataset ima fiksnu šemu, §6.1).

### 3.2 Proposer prompt (verbatim iz koda)

```text
Ti si proposer u self-play treningu. Napravi JEDAN realan scenario za agenta u datom domenu.
Vrati JSON: {"task":"konkretan zahtjev korisnika","context":"detalji","expected":"šta je dobar ishod","difficulty":1-5,"checks":["kako provjeriti"]}
Težina: {difficulty}/5. Scenario mora biti iz stvarnog posla, ne izmišljeni test.
[ako ima seedFailures] Uzmi u obzir oblasti gdje je agent ranije padao (dolje navedeno) — napravi varijantu tog problema.
[ako ima seedFailures] Prethodni problemi:
- {failures[0]}
- {failures[1]}
```

User poruka je uvijek tačno dva reda: `DOMEN: <domain>` i `TEŽINA: <difficulty>/5`.
`seedFailures` **nije** automatski iz prethodnog ciklusa — to je polje koje pozivalac (ili budući `curriculum`
integrator) mora poslati; danas ga ruta `/v1/admin/selfplay` ne popunjava sama.

### 3.3 Primjer scenarija — support

```json
{
  "task": "Kupac traži povraćaj za narudžbinu 1042",
  "context": "Narudžbina kasni 10 dana, kupac je platio karticom, dostava nije ni krenula.",
  "expected": "Tačan odgovor sa rokom i politikom povraćaja",
  "difficulty": 3,
  "checks": ["navodi politiku", "nudi konkretan rok"]
}
```

Zašto je ovo dobar scenario: (a) iz stvarnog posla support agenta (`config/agents/support.json` ima
`routingHints` za „refund", „reklamacija", „kasni"), (b) provjerljiv je heuristikama (dužina, ton, prisustvo
rokova), (c) pada ili prolazi u roku od jednog run-a sa `order_lookup`.

### 3.4 Primjer scenarija — sales

```json
{
  "task": "Klijent iz ugostiteljstva pita koliko košta paket za 12 lokala i traži ponudu do petka",
  "context": "Nema cjenovnik za 12+ lokala; klijent spominje i konkurenta koji nudi popust.",
  "expected": "Kvalifikovan lead (lead_score), ponuda iz stvarnih podataka i upis u CRM sa sljedećim korakom",
  "difficulty": 4,
  "checks": ["lead_score je obrazložen", "nema izmišljene cijene", "crm_upsert je pozvan", "predložen rok"]
}
```

Sales agent (`defaultPattern: orchestrator-worker`, `maxSteps: 12`) ovakav scenario rješava kroz
`lead_score` + `calculator` + `crm_upsert`, pa je i **provjera alata** moguća (danas ručno, preko `steps`
u trace-u; planirano: automatska provjera u judge-u).

> Oba primjera scenarija su **ilustracija formata** — nisu iz koda (u kodu je samo šema i test-mock koji
> vraća scenario o povraćaju za narudžbinu 1042, `tests/helpers.mjs`).

---

## 4. Ocjenjivanje

### 4.1 Kako `critic.review` daje `score`, `verdict` i `issues`

`critic.review({ task, output, context, criteria, useLlm, threshold, tenantId, ctx })`:

1. **Heuristike** (`heuristics()`) proizvode listu `issues` i `score`.
2. **Skor** = `max(0, 1 − Σ težina(issue))`, gdje su težine: `high = 0.4`, `medium = 0.15`, `low = 0.05`
   (nepoznata težina = 0.1). Zaokružuje se na dvije decimale.
3. **Verdikt (heuristika)**: `accept` **ako i samo ako** `score >= threshold` **i** nijedan issue nije `high`;
   inače `revise`.
4. **LLM sudija (opciono)** ulazi **samo** ako je `useLlm && llm && verdict === 'accept' && criteria.length`.
   Tada LLM daje `score`, a issues iz LLM-a se dodaju kao `medium`; verdikt se ponovo računa iz novog skora.
   Ako LLM padne (greška/nevalidan JSON) — **zadržava se heuristički rezultat** i loguje se
   `critic.llm_failed`.

### 4.2 Šta znači `passed` i kako se koristi `threshold`

```js
const review = await critic.review({ …, threshold: opts.threshold ?? 0.7 });
const passed = !error && review.verdict === 'accept';
```

- `passed` je **konjunkcija**: run solvera nije bacio grešku **i** sudija je prihvatio.
  Pad alata koji agent preživi (npr. `status: 'error'` u tool rezultatu) **ne** obara `passed`.
- `threshold` je **jedini** parametar kojim se pomjera strogost ocjene; default je `0.7`, a ruta ga prima iz
  body-ja (`{"threshold": 0.85}`). Test `self-play: slaba prolaznost…` koristi `threshold: 0.95` da namjerno
  proizvede padove.
- `passed` ulazi u: dataset red (`passed: true/false`), kurikulum (`byDifficulty.passRate`), odluku o
  prijedlogu (`passRate < proposeBelow`) i metrike (`selfplay_pass_rate`).

### 4.3 Tabela tipičnih problema koje kritičar hvata

| `code` | Uslov u kodu | Severity | Težina u skoru | Znači za self-play |
|---|---|---|---|---|
| `empty` | `text` je prazan | **high** | −0.40 | Run je „prošao" tehnički, a odgovora nema → odmah `revise` |
| `too_short` | dužina < 40 znakova (i neprazan) | medium | −0.15 | Klasičan pad support agenta („Ne znam.") — tačno ono što test simulira |
| `overclaim` | tekst sadrži `garantujem`, `sigurno će`, `100% `, `garantovano`, `nikad neće` | medium | −0.15 | Prodajni/support agent obećava rok ili ishod → pad |
| `missing_citations` | `context.kb` postoji **i** `context.requireCitations` **i** nema `[1]` u tekstu | medium | −0.15 | ⚠️ U self-play-u se **ne aktivira** — `selfplay.js` ne šalje `context`, pa `requireCitations` nije postavljen |
| `secret_leak` | regex na `api_key\|token\|password` + 8+ znakova | **high** | −0.40 | Odgovor sadrži nešto što liči na tajnu → `revise` + (planirano) alert |
| `off_topic` | ≥4 riječi iz zadatka dužine ≥5, a **nula** preklapanja sa odgovorom | low | −0.05 | Odgovor nije o zadatku; blag signal, rijetko sam obara run |

**Tri poštene napomene:**

1. **`criteria` (scenario `checks`) ne diraju heuristike.** Potpis `heuristics({ output, task, context, criteria })`
   prima `criteria`, ali ih tijelo funkcije ne koristi. Znači: provjere iz scenarija utiču na ocjenu
   **samo ako je uključen LLM sudija** (`useLlmJudge: true`), a on se poziva samo ako je heuristika već
   prihvatila odgovor.
2. **LLM sudija ne može popraviti lažno odbijanje heuristike** — ako heuristika kaže `revise`, LLM se ne poziva.
3. **Cijena sudije.** `useLlm: true` znači jedan dodatni LLM poziv **po scenariju** (role `critic`, kroz
   `callLlm`, dakle sa cost tracking-om). Za noćni režim to je ~2x cijena po scenariju (proposer + solver +
   sudija + povremeno improver).

---

## 5. Kurikulum

### 5.1 Pravilo „prolaz → teže, pad → lakše"

```js
// selfplay.js, linija 126 — jedina linija kurikuluma
difficulty = passed ? Math.min(5, difficulty + 1) : Math.max(1, difficulty - 1);
```

- Start je `opts.difficulty ?? 2` (ruta može poslati `{"difficulty": 3}`).
- Korak je **uvijek ±1**, nezavisno od score-a (score 0.99 i 0.71 daju isti pomak — planirano: step po rasporedu).
- U dataset se upisuje **`scenario.difficulty`** (ono što je proposer vratio), a ne interno stanje petlje.
  Ako proposer vrati 4 kad je traženo 2, kurikulum „skače" — a `finalDifficulty` u odgovoru pokazuje
  interno stanje poslije pomaka (dva različita broja u istom odgovoru; nije bug, ali zbunjuje).
- Značenje nivoa **1–5** nije definisano u kodu. Predložena interpretacija (za ljudski pregled, nije u kodu):

| Težina | Predloženo značenje | Tipičan broj koraka |
|---|---|---|
| 1 | Jedno pitanje, jedan odgovor, bez alata | 1 LLM |
| 2 | Jedan alat + odgovor (npr. `current_time`, `order_lookup`) | 2 LLM |
| 3 | 2–3 alata, uslovna logika (politika povraćaja, provjera narudžbine) | 3–4 LLM |
| 4 | Više koraka + odluka (lead_score, ponuda, upis u CRM), traži citate | 5–8 LLM |
| 5 | Eskalacija/handoff ili konfliktna pravila (refund + reklamacija + rok) | 8+ LLM |

### 5.2 `curriculum()` — izvještaj

```js
const cur = await robot.selfplay.curriculum('nmq', { limit: 500 });
// → { samples, byDifficulty, byDomain, weakDomains, recommended }
```

| Polje | Sadržaj | Napomena |
|---|---|---|
| `samples` | broj redova pročitanih iz dataset fajla | čita **tekući mjesec** (`dsFile()` default `new Date()`) |
| `byDifficulty` | `{ "1": {n, passed, passRate}, … }` | ključ je broj kao string (JSON object) |
| `byDomain` | `{ "support": {n, passed, passRate}, … }` | domen iz reda (isti za cijeli ciklus, jer `domain` je parametar ciklusa) |
| `weakDomains` | samo domeni sa `passRate < 0.6` | **drugi prag** od `proposeBelow` (0.5) — vidi §9.7 |
| `recommended` | `"vježbaj: support, sales"` ili `"nema slabih domena u uzorku"` | string za čovjeka/dashboard |

`passRate` je `null` ako je `n = 0` (filtrira se iz `weakDomains`).

### 5.3 Koje domene treba vježbati

Kurikulum **ne pokreće** ništa sam. Ispravan noćni tok (danas ručno, planirano automatizovano):

1. `GET /v1/admin/selfplay/curriculum` → pročitaj `recommended` i `weakDomains`.
2. Za svaki slab domen pozovi `POST /v1/admin/selfplay` sa `{"solverAgent": "<agent>", "rounds": 3}`.
3. Ako je prolaznost ispod `proposeBelow`, u inbox-u (`GET /v1/admin/proposals?status=proposed`) čeka
   prijedlog prompta — vidi §7.
4. Poslije odobrenja i primjene, pusti **isti** scenario set ponovo (regresija) i uporedi prolaznost.

---

## 6. Dataset za budući trening

### 6.1 Gdje se zapisuje i šta je unutra

**Putanja:** `data/tenants/<tenantId>/learning/training-YYYY-MM.jsonl` (`dsFile()`; mjesec iz `iso()` datuma).

| Polje | Tip | Napomena |
|---|---|---|
| `id` | string | `sp_…` (`uid('sp')`) |
| `ts` | ISO string | vrijeme upisa reda |
| `tenantId` | string | izolacija po tenantu je fizička (D12) |
| `domain` | string | domen ciklusa (`opts.domain ?? solver.domain`) |
| `difficulty` | 1–5 | ono što je proposer vratio |
| `scenario` | `{task, context, expected, checks[]}` | `null` za polja koja proposer nije vratio |
| `solution` | string (≤ 4000 znakova) | izlaz solvera (`String(...).slice(0, 4000)`) |
| `error` | string \| null | poruka greške solvera (ako je pao prije odgovora) |
| `score` | 0–1 | skor sudije |
| `verdict` | `accept` \| `revise` | verdikt sudije |
| `issues` | string[] | **samo poruke** (`issues.map(x => x.message)`) — kodovi (`too_short`, …) se **ne** zapisuju u dataset |
| `durationMs` | broj | trajanje solver run-a |
| `costUsd` | broj (6 decimala) | proposer + solver (sudija nije uključena u ovaj zbir!) |
| `passed` | boolean | `!error && verdict === 'accept'` |

### 6.2 `dataset()` izvoz

```js
robot.selfplay.dataset(tenantId, { onlyPassed: true, limit: 1000 })
// → { total, returned, passRate, examples: [{task, context, solution, difficulty, score}], note }
```

- Kroz HTTP: `GET /v1/admin/selfplay/dataset` → `onlyPassed: query.all !== '1'`, `limit: query.limit ?? 200`.
  Znači: **default je samo uspješni**, a sve (`?all=1`) se dobija eksplicitno — i tada `examples` miješa
  prolaze i padove bez oznake `passed` (planirano: dodati `passed` i `issues` u izvoz).
- `note` je konstantan string: *„Format je spreman za SFT/DPO; sam trening se pokreće van ovog procesa
  (GPU ili API fine-tune)."*

### 6.3 Kako se od ovoga pravi SFT dataset (konkretno)

Ciljni format (chat/SFT, kompatibilan sa većinom provajdera):

```jsonl
{"messages":[{"role":"system","content":"<system prompt agenta — aktivna verzija iz control plane-a>"},{"role":"user","content":"Kupac traži povraćaj za narudžbinu 1042\n\nKontekst: Narudžbina kasni 10 dana\n\nOčekivano: Tačan odgovor sa rokom i politikom povraćaja"},{"role":"assistant","content":"<solution iz dataset reda>"}],"meta":{"difficulty":3,"score":0.85,"domain":"support"}}
```

**Šta tačno fali da ovo radi danas:**

| Korak | Status |
|---|---|
| Uzeti samo `passed: true` redove | ✅ `dataset(onlyPassed: true)` |
| Spojiti `task + context + expected` u **istu** formu koju je solver vidio | ✅ rekonstrukcija je deterministička (isti template iz `selfplay.js`) |
| Ubaciti `system` prompt | ⚠️ **nije** u datasetu — mora se uzeti iz aktivne verzije agenta (`GET /v1/admin/agents/:id`) **u trenutku izvoza**, jer se prompt poslije mijenja |
| Redakcija PII/tajni | ❌ planirano (`redactPii` iz `src/core/policy.js`, kao u `episodic.js`) |
| Skripta za izvoz (`scripts/export-dataset.mjs`) | ❌ planirano |
| Podjela train/valid (držati 10–20% kao holdout) | ❌ planirano; bez toga se ne vidi overfit |

### 6.4 Kako se pravi DPO dataset (parovi dobar/loš)

DPO (i srodne metode) traže **par** za isti prompt: `chosen` (bolji) i `rejected` (gori):

```jsonl
{"prompt":"Kupac traži povraćaj za narudžbinu 1042\n\nKontekst: Narudžbina kasni 10 dana","chosen":"<solution iz passed=true reda>","rejected":"<solution iz passed=false reda istog task-a>","meta":{"domain":"support","difficulty":3,"chosenScore":0.85,"rejectedScore":0.45}}
```

- **Izvor parova:** isti `task` (ili semantički isti task) sa jednim `passed: true` i jednim `passed: false` redom.
- **U kodu:** funkcija za uparivanje **ne postoji** — planirano (`dataset({ pairs: true })` ili offline skripta
  koja grupira po normalizovanom `task`-u i/ili embedding sličnosti preko `memory.embedder`).
- **Pragovi za par (predlog, nije u kodu):** `chosenScore − rejectedScore ≥ 0.2` i `chosen.verdict === 'accept'`.
- **Zamka:** parovi iz istog dana i istog modela dijele sistemsku grešku sudije — zato pravilo: najmanje 20%
  `chosen` primjera mora doći iz **ljudski potvrđenih** odgovora (feedback 👍 u widgetu/API-ju), ne samo iz judge-a.

### 6.5 Gdje se trening pokreće (van procesa)

| Mjesto | Kako izgleda | Napomena |
|---|---|---|
| **Vlastiti GPU** (radna stanica ili VPS sa GPU) | JSONL → trening skripta (npr. PEFT/LoRA za open-weights model) → novi adapter/težine → servira se kroz `openai-compatible` provider | Van repozitorijuma; `DECISIONS.md` D2 zabranjuje npm zavisnosti u jezgru, ne zabranjuje odvojen trening projekat |
| **API fine-tune** kod provajdera | Upload JSONL → job → novi model ID → samo se **jedno polje** promijeni u config-u (`spec.model`, D6) | Najbrži put; trošak je van `usage/` sistema (ne vidi ga cost tracker!) |
| **Bez treninga (najjeftinije)** | Isti dataset → izmjena prompta (§7) + dopuna KB | Ovo je ono što je danas stvarno dostupno i mjerljivo |

**Preduslov — dovoljno primjera po domenu (procjena, nije izmjereno):**

| Cilj | Primjera po domenu (procjena) | Zašto ta procjena |
|---|---|---|
| Izmjena prompta iz padova | **5–20 padova** sa istom klasom problema | dovoljno da se vidi pattern u `issues` |
| Regresioni (zlatni) set | **30–50 scenarija** po domenu | pokriva tipične i granične slučajeve |
| SFT (LoRA / prompt-tuning) | **300–500 uspješnih** primjera po domenu | ispod toga model „nauči" stil, ne zadatak |
| DPO parovi | **~1000 parova** ukupno, uz ljudski potvrđene `chosen` za ≥20% | parovi su skuplji od pojedinačnih primjera |

Uz `rounds ≤ 5` po noći i prolaznost ~60%, to je red veličine **100–150 noći** za SFT prag po domenu —
zato je realan prvi korak **eval harness + prompt**, a ne fine-tune.

---

## 7. Veza sa prijedlozima poboljšanja

Ako je `passRate < (opts.proposeBelow ?? 0.5)`, self-play **sam otvara prijedlog** (ali ga **ne** primjenjuje):

```js
proposal = await improvements.createProposal(tenantId, {
  kind: 'prompt',
  target: solverAgent,                       // npr. 'support'
  current: solver.systemPrompt?.slice(0, 400) ?? null,
  proposed: null,                            // popunjava se odmah ispod
  rationale: `Self-play: prolaznost ${Math.round(passRate*100)}% u domenu "${domain}" (${failures.length}/${rounds} padova). Prompt agenta treba doradu.`,
  evidence: failures.slice(0, 5).map((f) => ({ task: f.scenario.task, score: f.score, issues: f.issues })),
  expectedImpact: 'veća prolaznost na istoj klasi zadataka',
  riskLevel: 'medium',
  source: 'self-play',
});
```

Zatim **drugi LLM poziv** (`role: 'selfplay-improver'`, `temperature: 0.2`, `maxTokens: 900`) dobija trenutni
prompt + listu padova (`- <task> → ocjena <score>; problemi: <issues>`) i vraća **samo novi system prompt**;
self-play ga upisuje u prijedlog (`updateProposal`). Ako taj poziv padne, prijedlog **ostaje** sa
`proposed: null` i loguje se `selfplay.improver_failed`.

**Lanac poslije toga (sve čovjek):**

| Korak | Ruta | Rola | Šta se mijenja |
|---|---|---|---|
| Pregled | `GET /v1/admin/proposals?status=proposed` | admin | — |
| Prijedlog detaljno | `GET /v1/admin/proposals/:id` | admin | — |
| Odluka | `POST /v1/admin/proposals/:id/decide` `{approve:true}` | **approve** | status → `approved`, upis u audit (`improvement_decision`) |
| Primjena | `POST /v1/admin/proposals/:id/apply` | admin | `controlPlane.deploy` → **nova verzija** agenta + audit; `rollbackInfo` se pamti |
| Mjerenje | `GET /v1/admin/proposals/:id/impact` | admin | prije/poslije nagrada (`docs/21`, `src/learning/rsi.js` → `impact`) |
| Vraćanje | `POST /v1/admin/proposals/:id/rollback` | admin | `controlPlane.rollback(version − 1)` |

Nijedan korak se ne izvršava automatski: `createProposal` uvijek postavlja `requiresHuman: true`, a audit
za kreiranje prijedloga ima `decision: 'require_approval'`.

**Poštene napomene (dokazi iz koda):**

- **`apply` ne provjerava da `proposed` nije `null`.** Za `kind: 'prompt'` kod radi `String(p.proposed)`, pa bi
  prijedlog bez teksta deployovao **literalni string `"null"`** kao system prompt. Isto važi za `pattern`
  (`String(p.proposed)` → `defaultPattern: "null"`). Planirano: validacija u `improvements.apply` +
  `PATCH /v1/admin/proposals/:id` ruta za dopunu teksta (ruta danas **ne postoji**, pa čovjek ne može
  popuniti `proposed` kroz API).
- **Self-play runovi ne ulaze u reward model** (zovu `runAgent` direktno, ne `orchestrator.run`, pa
  `robot.recordRunOutcome` nikad ne vidi te runove). Zato `rsi.analyze` i `impact` mjere **samo stvarne runove**,
  a ne i efekat na self-play prolaznosti. Planirano: bilježiti reward i za self-play rundu.
- **Prijedlog se otvara po ciklusu, ne po klasu problema** — dva ciklusa sa istim padovima daju **dva
  prijedloga** (nema deduplikacije po `target + kind + hash`).
- Ako je `improvements` nedostupan, petlja samo preskoči prijedlog (`if (improvements && …)`) — self-play
  i dalje radi i piše dataset.

---

## 8. Noćni režim (kako se pokreće)

### 8.1 Ruta

```http
POST /v1/admin/selfplay
Content-Type: application/json
x-tenant: nmq
Authorization: Bearer <tenant admin ključ>

{ "solverAgent": "support", "domain": "support", "rounds": 3, "difficulty": 2,
  "threshold": 0.75, "proposeBelow": 0.5, "useLlmJudge": false }
```

- Rola: **`admin`** (`requiredRole: 'admin'`, `routes-autonomy.js` linija 293).
- Body je **`opts` objekat `run()`-a** — nema posebne validacije; nepoznata polja se ignorišu.
- `rounds` se interno klampuje na **1–20**.
- Prateće rute: `GET /v1/admin/selfplay/dataset`, `GET /v1/admin/selfplay/curriculum`.

### 8.2 Dva načina da se pokrene noću

**(A) Eksterni cron/systemd timer (radi danas).** Preporučeni oblik za VPS (`nmq-server`, vidi AGENTS uputstvo):

```ini
# /etc/systemd/system/nmq-selfplay.service
[Service]
Type=oneshot
EnvironmentFile=/etc/nmq/selfplay.env      # NMQ_ADMIN_KEY=… (nikad u git!)
ExecStart=/usr/bin/curl -sS -X POST http://127.0.0.1:3000/v1/admin/selfplay \
  -H "content-type: application/json" -H "x-tenant: nmq" \
  -H "authorization: Bearer ${NMQ_ADMIN_KEY}" \
  -d '{"solverAgent":"support","rounds":3,"threshold":0.75}'

# /etc/systemd/system/nmq-selfplay.timer
[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
[Install]
WantedBy=timers.target
```

**(B) Scheduler u procesu (`schedule.cron`) — planirano, ne radi za self-play danas.** Scheduler podržava
`cron` raspored (5 polja, `src/scheduler/cron.js`, `validateCron`), a posao se kreira sa:

```json
POST /v1/admin/jobs
{ "name": "noćni self-play", "agentId": "support", "input": "…",
  "schedule": { "type": "cron", "cron": "30 2 * * *" },
  "budgetPerRunUsd": 0.5 }
```

**Ali:** izvršilac poslova uvijek ide kroz `orchestrator.run(...)` (agent × pattern). Ne postoji tip posla
`selfplay` niti alat koji poziva `selfplay.run`, pa se self-play **ne može** zakazati kroz scheduler bez
izmjene koda. Planirano: `type: 'selfplay'` u `src/scheduler/index.js` + ruta koja ga kreira.

### 8.3 Koliko rundi i koji budžet

| Parametar | Preporuka za noćni režim | Zašto |
|---|---|---|
| `rounds` | **3** (max 5) | svaka runda = 1 proposer + 1 solver run (više LLM poziva u petlji alata) + opciono sudija |
| `useLlmJudge` | `false` prvo, `true` samo za domen koji se mjeri | sudija je dodatni LLM poziv po scenariju |
| `threshold` | **0.75–0.85** | ispod 0.7 dataset se puni „prolazima" sa prekomjernim tvrdnjama |
| `proposeBelow` | 0.5 (default) | ispod toga se otvara prijedlog prompta |
| `budgetPerRunUsd` (job) | 0.2–0.5 | ograda **samo za poslove kroz orchestrator** |
| `agentBudgets` (tenant) | npr. `support: 10` | mjesečni per-agent budžet u control plane-u |

### 8.4 Kako spriječiti da noćni trening pojede mjesečni budžet — **iskreno stanje**

Šta stvarno postoji:

- **Mjesečni budžet tenanta**: `config/tenants.json` → `budget.monthlyUsd` (nmq: 200; demo-shop: 15).
  Provjerava se u `orchestrator.run` preko `createBudget({ monthlyUsd, spentThisMonthUsd: await cost.monthlySpent(tenantId) })`.
- **Per-agent mjesečni budžet**: `budgetUsdMonth` u control plane-u (`POST /v1/admin/agents/:agentId/budget`,
  rola `owner`); `assertAgentBudget` baca `PolicyError` kad je potrošeno ≥ budžet.
- **`cost.record`** se poziva za **svaki** LLM poziv (uključujući self-play), pa noćni trening **jeste**
  vidljiv u `data/tenants/<id>/usage/YYYY-MM.jsonl` i u `cost.monthlySpent`.

Šta **ne** radi (dokazano čitanjem koda):

1. `assertAgentBudget` se zove **samo** u `orchestrator.run` (`src/orchestration/index.js` linije 85 i 148).
   Self-play zove `runAgent` direktno → **per-agent budžet se ne provjerava**.
2. `runAgent` gradi budžet **samo** iz `ctx.budget` koji mu se prosledi; `options: { maxRunUsd: opts.maxPerScenarioUsd }`
   koje self-play prosleđuje **se ignorše** (`agent.js` ne čita `ctx.options`). Zato `maxPerScenarioUsd`
   danas **ne ograničava** ni jedan scenario.
3. Ruta `/v1/admin/selfplay` ne gradi budžet — `opts.budget` je `undefined` ako ga pozivalac ne pošalje
   (a kroz JSON se objekat sa metodama ne može poslati).

**Zato je danas jedina stvarna zaštita:** broj rundi, jeftin model/agent, i **monitoring**:
`nmq_selfplay_rounds_total`, `nmq_selfplay_pass_rate_*`, `usage/YYYY-MM.jsonl`, `audit` zapis
`action: 'selfplay_cycle'` sa `meta.costUsd`.

**Planirano (konkretno, za v0.3.x):** ruta gradi budžet i prosleđuje ga u `run()`:

```js
// src/server/routes-autonomy.js — planirano
handler: async ({ tenantId, body }) => {
  const tenant = config.tenant(tenantId);
  const budget = createBudget({
    runUsd: body.maxCostUsd ?? tenant.budget?.runUsd,
    monthlyUsd: tenant.budget?.monthlyUsd,
    spentThisMonthUsd: await robot.cost.monthlySpent(tenantId),
    maxSteps: (body.rounds ?? 3) * 4,
    maxWallMs: 10 * 60_000,
  });
  await robot.controlPlane?.assertAgentBudget?.(tenantId, body.solverAgent ?? 'support');
  return robot.selfplay.run(tenantId, { ...body, budget });
}
```

Time budžet prestaje da bude „dokumentovan" i postaje **fail-closed** (`budget.js` je namjerno fail-closed:
ako se ne može dokazati da je dozvoljeno — prekida se).

---

## 9. Ograničenja i zamke

1. **Model ocjenjuje sam sebe.** Proposer, solver, improver i (opciono) sudija su isti provider/model po
   default-u. Greške su **korelisane**: ono što model ne zna, ne zna ni da ocijeni. Ublažavanje: sudija na
   drugom modelu (`critic.review` prima `model`), ljudski feedback za uzorak, eksterni zlatni set.
2. **Scenario može biti nerealan.** Proposer nema alate i ne vidi stvarne tickete/narudžbine; „realan scenario"
   je tvrdnja LLM-a. Bez `seedFailures` iz stvarnih padova i bez uzorka iz produkcijskih trace-ova, dataset
   opisuje **modelovu maštu**, ne posao. Ublažavanje (planirano): puniti `seedFailures` iz
   `issues` prethodnog ciklusa i iz stvarnih `reward < 0.35` runova.
3. **Dataset se kvari ako je judge slab.** Heuristika daje 0.85 već za odgovor sa `overclaim` (medium, −0.15),
   pa uz `threshold: 0.7` takav odgovor ide u dataset kao **uspješan** i postaje SFT uzor. Loš judge → loš
   dataset → loš fine-tune; i niko to ne vidi dok se model ne pusti u rad.
4. **„Self-play bez eksternog kriterija" ojačava loše navike.** Ako se dataset koristi za trening bez holdout
   seta i bez ljudski potvrđenih primjera, model se obučava da bude sličan **svom sudiji**, a ne da rješava
   zadatak. Ovo je klasična zamka self-distilacije i razlog zašto `docs/23` §10 traži eval harness **prije**
   bilo kakve automatizacije.
5. **Jedan malformiran odgovor prekida cijeli ciklus.** `proposeScenario` baca `ValidationError` ako nema
   `task` u JSON-u, a poziv nije u `try/catch` po rundi → `run()` puca, prije nego se upiše `audit`
   `selfplay_cycle` (audit je poslije petlje). Planirano: `try/catch` po rundi + `retry: 1`.
6. **Self-play „prosipa" neprovjerena rješenja u few-shot memoriju.** Ako solver koristi alate, `agent.js`
   upisuje epizodu sa `success: status === 'ok'` — **nezavisno od verdikta sudije**. Epizoda koju je sudija
   odbio može završiti kao „uspješan prošli slučaj" u promptu (jer `memory.recall` učitava epizode). Ovo je
   najozbiljnija tiha zamka u trenutnom kodu; planirano: proslediti verdikt u epizodu
   (`recordEpisode` sa `success` iz `review.verdict === 'accept'`).
7. **Nesklad pragova.** `proposeBelow` (0.5) otvara prijedlog, `weakDomains` (0.6) preporučuje vježbanje.
   Domen sa prolaznošću 0.55 „preporučen je za vježbu", a **ne** otvara prijedlog — što je vjerovatno
   pogrešno za praksu (planirano: jedan prag u konfiguraciji).
8. **Mjesec je granica istorije.** `dsFile()` i `curriculum()` čitaju **samo tekući mjesec**; 1. u mjesecu
   kurikulum je prazan bez obzira na hiljade primjera iz prethodnog mjeseca. Planirano: čitanje svih
   `training-*.jsonl` fajlova ili indeks.
9. **Nema PII redakcije, nema kontrole pristupa datasetu.** Fajl je običan JSONL u `data/tenants/<id>/learning/`;
   `DECISIONS.md` §6 ne navodi ovu putanju (dokument treba dopuniti za v0.3).
10. **Trošak sudije nije u dataset `costUsd`.** Zbir je `proposer + solver`, bez `critic` LLM poziva i bez
    improver-a → izvještaj troška po scenariju je **niži** od stvarnog (planirano: uključiti sve pozive).

---

## 10. Testovi i dokazi

Lokalno provjereno (`node --test tests/autonomy.test.mjs`, 2026): **24 testa, 24 prolaze, 0 padova.**

| Šta je dokazano | Test / skripta |
|---|---|
| Ciklus self-play radi: 2 runde, `costUsd > 0`, dataset ima 2 reda, `examples.length ≥ 1`, `note` sadrži „fine-tune", kurikulum ima `samples = 2` i `byDifficulty` | `tests/autonomy.test.mjs` → *self-play: scenariji, dataset i kurikulum* |
| Niska prolaznost otvara prijedlog: `passRate < 0.8`, `proposalId` postoji, `kind: 'prompt'`, `source: 'self-play'`, `proposed` sadrži tekst improver-a | `tests/autonomy.test.mjs` → *self-play: slaba prolaznost stvara prijedlog sa predloženim promptom* |
| HTTP ruta radi: `POST /v1/admin/selfplay` sa `{rounds:1, solverAgent:'support'}` vraća `rounds: 1` | `tests/autonomy.test.mjs` → *HTTP: ciljevi, prijedlozi, watcheri, autonomija, org i A2A rute* |
| Ruta radi i u „pravom" serveru (smoke, ne samo unit): `prolaznost=…, težina=…` | `scripts/smoke.mjs` → *POST /v1/admin/selfplay (1 runda)* |
| Demo prikazuje cijeli tok na mock LLM-u: 3 scenarija, prolaznost, `finalDifficulty`, trošak, dataset izvoz, `curriculum.recommended` | `scripts/demo.mjs` sekcija 20 (*A/B TESTIRANJE I SELF-PLAY*) |
| Prijedlog → odobrenje → primjena → rollback (mehanika koju self-play koristi) | `tests/autonomy.test.mjs` → *self-improvement: prijedlog → odobrenje → primjena prompta → rollback* |
| Metrike postoje i imaju `nmq_` prefiks | `src/observability/metrics.js` (prefiks `nmq`); self-play emituje `selfplay_rounds_total` (counter), `selfplay_pass_rate` (histogram) |
| Audit trag ciklusa | `selfplay.js` → `audit.append({ action: 'selfplay_cycle', meta: { costUsd } })` |

**Šta NIJE dokazano (nema testa, nema mjerenja):**

| Tvrdnja | Status |
|---|---|
| Scenariji su „realni" | ❌ nema mjere realnosti (nema poređenja sa stvarnim ticketima) |
| Judge se slaže sa čovjekom (korelacija) | ❌ nema mjerenja; `docs/23` §10 predlaže zlatni set kao prvi korak |
| Dataset je dovoljan za SFT/DPO | ❌ nema izvozne skripte, nema treninga, nema evaluacije |
| Budžet štiti od prekomjerne potrošnje u self-play-u | ❌ **nije** implementirano (§8.4) |
| Kurikulum poboljšava kvalitet kroz vrijeme | ❌ nema A/B između „sa kurikulumom" i „bez" |

---

## Otvorena pitanja

1. **Koji je izvor scenarija za „realnost"?** Da li `seedFailures` puniti iz stvarnih `reward < 0.35` runova,
   iz neriješenih ticketa (kada `ticket_create` postoji u produkciji), ili iz oba — i ko to odobrava
   (jer stvarni ticketi nose PII)?
2. **Koji model smije biti sudija?** Da li uvesti obavezno **drugog** provajdera za `critic` u noćnom režimu
   (npr. jeftiniji model sa drugog API-ja) i kako onda tumačiti `score` koji nije uporediv između modela?
3. **Koliki `proposeBelow` i `weakDomains` prag** treba da važe za sve domene, ili da budu per-agent u
   `config/agents/*.json` (npr. support 0.6, sales 0.5)? Danas su dva različita hardkodovana praga.
4. **Da li dataset smije napustiti tenant granicu?** Ako se fine-tune radi na zajedničkom modelu za više
   klijenata, dataseti se moraju spojiti — koji je pravni i tehnički postupak (anonimizacija, dozvola,
   razdvajanje LoRA adaptera po tenantu)?
5. **Da li self-play i RSI treba da dijele isti „noćni budžet"** (jedan mjesečni pool za sve autonomne
   aktivnosti), ili svaki dobija svoj? Danas nijedan od njih nema budžet (§8.4).
6. **Kada se isplati prvi fine-tune** — koji broj primjera po domenu i koja izmjerena razlika u prolaznosti
   (npr. +10 procentnih poena na zlatnom setu) opravdava trošak treninga i održavanja modela?
