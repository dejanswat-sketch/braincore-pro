# 16 — MAX patterni: ReAct, Reflection, Planning, Debate, Team

> Ovaj dokument je **izvršni opis onoga što je stvarno u kodu** na dan pisanja (`src/orchestration/*`, `src/agents/*`).
> Izvor istine za odluke je `docs/DECISIONS.md`; za postojeće patterne `docs/04-ORCHESTRACIJA.md`.
> Ovaj dokument **ne mijenja** ni jednu odluku — on opisuje MAX sloj (11 ulaza) koji je dodat povrh 6 patterna iz D13.
> Verzija: 1.0 · Vlasnik: NMQ (Dejan Milošević PR).
>
> **Dokaz, ne tvrdnja:** svi brojevi LLM poziva u §8 su **izmjereni** mock providerom
> (`tests/helpers.mjs` → `buildTestRobot({ script: smartScript() })`), a ne procjena. Gdje je nešto planirano, piše **planirano**.
> Cijene modela se **ne prepisuju** u ovaj dokument — žive u `PRICING` tabeli `src/observability/cost.js`.

---

## 1. Katalog ulaza

`PATTERNS` u `src/orchestration/index.js` ima **11 imena** i test `tests/patterns.test.mjs` ih provjerava
(`assert.deepEqual(PATTERNS, [...])`). Prvih sedam je iz D13 (`agent` + 6 patterna), zadnja četiri su MAX sloj.

| Ime | Šta radi | Tipičan broj LLM poziva (izmjereno) | Latencija | Trošak | Kada ga birati |
|---|---|---|---|---|---|
| `agent` | Jedan agent: LLM → alat → LLM … dok ne prestane da traži alate. „Nulti pattern" | 1 (bez alata) · 2 (jedan tool loop) | 1–2 poziva, najkraća | 1× | Kada je posao za jednog specijalistu i nema planiranja |
| `react` | **Alias za `agent`** (`patterns.react = patterns.agent`) — isto ponašanje, eksplicitnije ime | isto kao `agent` | isto | isto | Kada tim želi da u config-u piše „react" jer je to mentalni model |
| `router` | Klasifikuje ulaz i bira agenta; 3 sloja: keyword (0 LLM) → embedding (0 LLM) → LLM fallback | 0 (heuristic) ili 1 (LLM sloj) | < 50 ms bez LLM-a | ~0 ili 1× mali | Uvijek kad `agentId` nije poznat (widget, webhook) |
| `sequential` | Linearni pipeline: koraci `n → n+1`, `failFast` default | 2 (2 agent koraka + 1 tool korak u testu) | suma koraka (serijski) | (n − m)× gdje je m broj tool koraka | Procesi sa fiksnim redoslijedom (obrada računa, onboarding) |
| `orchestrator-worker` | Planer → do 5 workera → sinteza; worker pad **ne** obara run | 4 (1 planer + 2 workera + 1 sinteza) | serijski: Σ; `parallel: true`: ≈ max + sinteza | (k + 2)× | Kompleksan zadatak sa 3–5 nezavisnih djelova |
| `fanout` | Isti ulaz, k grana paralelno, pa merge (`synthesis`/`concat`/`vote`) | 4 (3 grane + 1 fan-in) | ≈ max(grana), ne suma | (k + 1)× i plaća se neiskorišteno | Nezavisni uglovi ili verifikacija; latencija kritična |
| `handoff` | Predaja kontrole drugom agentu; tvrda zaštita od petlje | 1 po agentu u lancu | serijski, h × trajanje agenta | (h + 1)× | Kad specijalizacija stvarno mijenja kvalitet |
| `magentic` | Petlja plan → akcija → refleksija → korekcija | 2 (1 plan + 1 agent; critic heuristika) · **3** sa `useLlmCritic: true` | najduža (i ciklusa) | ≈ 2–3× po iteraciji, najskuplji | Istraživanje/dijagnostika bez poznatog plana |
| `reflection` | act → critique → revise, do `maxRounds`; vraća **najbolju** verziju (`keepBest`) | 2 po rundi (agent + eventualni tool loop); 2 runde = 4 | 2× po rundi | 2× po rundi | Ponude, pravni tekst, javni odgovori — kvalitet ispred cijene |
| `debate` | Debaeri sa stavovima → N rundi → sudija | `debaeri × runde + 1` (2×2 → **5**, 3×2 → **7**) | linearno raste sa `debaeri × runde` | (d × r) + 1 | Odluke sa trade-off-ima, gdje jednostranost jednog modela škodi |
| `team` | 7 specijalističkih uloga + team-lead sinteza | **8** (plan, research, extract, validate, decide, execute, reflect + team-lead) | najduža linearna (7 koraka + sinteza) | 8× (ili 5× sa `skip` od 3 uloge) | Zadatak „od početka do kraja" sa provjerama |

**Zašto `react` postoji ako je alias:** u `PATTERNS` je **eksplicitno** naveden (test to traži), a u
`createOrchestrator` se dodjeljuje **istom objektu** kao `agent`. Znači: nema drugog koda, nema drugog troška,
nema druge putanje — samo ime koje odgovara literaturi (ReAct = reason + act).

**Važno svojstvo svih 11 ulaza:** svaki pattern na kraju ide kroz `runAgent` iz `src/agents/agent.js`.
To je **jedina** tačka koja razgovara sa LLM-om i alatima, pa se politika (`assertAllowed`), budžet
(`ctx.budget`), audit i trace primjenjuju **identično** bez obzira koji je pattern izabran. Patterni se
razlikuju po **tome koliko puta i u kom rasporedu** zovu tu jednu tačku.

---

## 2. ReAct (`react` = `agent`)

**Ideja:** model naizmenično **razmišlja** (reason) i **djeluje** (act), a rezultat alata se vraća u kontekst
(observe). Petlja staje kad model vrati odgovor **bez** tool call-a.

### Pseudo-kod petlje (vjerno `src/agents/agent.js`)

```js
const maxSteps   = spec.maxSteps ?? config.env.maxSteps;   // tvrdi broj iteracija
const maxRepeats = spec.maxToolRepeats ?? 3;               // isti alat + isti args
const repeats = new Map();
let step = 0, status = 'ok', output = '';

while (step < maxSteps) {
  // 1) BUDŽET — prije poziva, fail-closed
  const estimate = cost.estimate({ promptChars: JSON.stringify(messages).length, maxOutTokens: spec.maxTokens ?? 900, model });
  ctx.budget?.assertCanContinue({ estimatedUsd: estimate, label: `agent:${spec.id}` });
  ctx.budget?.addStep();
  step += 1;

  // 2) REASON — LLM dobija system prompt + istoriju sesije + tool sheme (samo dozvoljene)
  const res = await llm.chat({ messages, tools: toolSpecs, temperature: spec.temperature ?? 0.2, maxTokens: spec.maxTokens ?? 900, model, signal: ctx.signal, tenantId });

  // 3) TROŠAK — svaki poziv se naplaćuje i upisuje (D16)
  const rec = await cost.record({ tenantId, agentId: spec.id, runId: ctx.runId, model: res.model, usage: res.usage, provider: res.provider, meta: { pattern: ctx.pattern } });
  ctx.budget?.spend({ usd: rec.usd, tokensIn: rec.tokensIn, tokensOut: rec.tokensOut });
  if (res.text) output = res.text;

  // 4) OBSERVE/STOP — nema tool call-a → gotovo
  if (!res.toolCalls?.length) { ctx.onEvent?.({ type: 'final', text: output }); break; }

  // 5) ACT — svaki tool call ide kroz tool registry (validacija → politika → budžet → izvršenje → audit)
  messages.push({ role: 'assistant', content: res.text ?? '', tool_calls: res.toolCalls.map(toOpenAiToolCall) });
  for (const tc of res.toolCalls) {
    const signature = `${tc.name}:${JSON.stringify(tc.arguments ?? {})}`;
    const seen = (repeats.get(signature) ?? 0) + 1;
    repeats.set(signature, seen);
    if (seen > maxRepeats) {                        // LOOP_PREVENTED
      status = 'loop_prevented';
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: JSON.stringify({ status: 'loop_prevented', reason: `Alat "${tc.name}" je već pozvan ${maxRepeats}x — prestani da ga ponavljaš i odgovori korisniku.` }) });
      stopAfterTools = true;
      continue;
    }
    const result = await tools.execute(tc.name, tc.arguments, { ...ctx, agentId: spec.id, policy, budget: ctx.budget, session });
    messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: stringifyToolResult(result.result) });
  }
  if (stopAfterTools) break;
}
if (step >= maxSteps && !output) { status = 'max_steps'; output = 'Zadatak nije završen u dozvoljenom broju koraka.'; }
```

### Kako se petlja prekida — pet nezavisnih brava

| Brava | Gdje | Vrijednost | Efekat |
|---|---|---|---|
| `maxSteps` | `spec.maxSteps` ili `config.env.maxSteps` (`NMQ_MAX_STEPS`, default 12) | 4–10 po agentu iz `config/agents/*.json` | `status: 'max_steps'` + tekst „Zadatak nije završen…" |
| `maxToolRepeats` | `spec.maxToolRepeats ?? 3` | 3 | `status: 'loop_prevented'`, alat se **ne** izvršava, model dobija instrukciju da prestane |
| Budžet run-a | `ctx.budget.assertCanContinue()` (`src/core/budget.js`) | `maxSteps`, `maxWallMs` (180 s), `runUsd`, `monthlyUsd`, `maxTokens` | `BudgetExceededError` (`BUDGET_EXCEEDED`, HTTP 402) — **fail-closed** |
| Skaliranje koraka po patternu | `PATTERN_STEP_BUDGET` u `src/orchestration/index.js` | `agent`/`react`: 1 · `router`/`sequential`: 2 · `orchestrator-worker`/`fanout`/`handoff`/`magentic`/`reflection`: 3 · `debate`: 5 · `team`: 6 | `maxSteps = baseMaxSteps × PATTERN_STEP_BUDGET[pattern]`; kod `router`-a se preračuna na izabrani pattern (`budget.setMaxSteps`) |
| Politička odluka | `tools.execute` → `evaluate()` (`src/core/policy.js`) | `deny` / `require_approval` | `POLICY_DENIED` (alat se ne izvršava, model dobija `{status:'denied'}`) ili `APPROVAL_REQUIRED` → `status: 'awaiting_approval'` i run staje |
| `AbortSignal` | `ctx.signal` → `llm.chat({ signal })` | UI „Stop" / timeout | `AbortError` (nije retryable) |

**Ključna razlika između `LOOP_PREVENTED` i `POLICY_DENIED`:**

- `LOOP_PREVENTED` je **zaštita od modela koji se vrti u krug** — alat je dozvoljen, ali se isti poziv sa istim
  argumentima ponavlja. Poruka ide **modelu**, ne korisniku, i run se nastavlja (ili staje uz `status`).
- `POLICY_DENIED` je **zaštita od agenta koji smije previše** — alat se nikad ne izvršava, zapis ide u audit
  (`decision: 'deny', outcome: 'blocked'`) i metrika `policy_denied_total`.

### Šta agent radi poslije petlje (i što to znači za pattern koji ga zove)

`runAgent` poslije petlje **uvijek** upisuje: korisničku poruku i izlaz u sesiju, dva događaja u dugoročnu
memoriju (`user_message`, `agent_message`), zapis za svako čekajuće odobrenje tipa `approval`, i — **ako je bilo
uspješnih tool poziva** — epizodu u epizodičnu memoriju (`problem → actions → solution → outcome`).
Zato patterni koji zovu agenta 8× (npr. `team`) proizvode 8 epizoda i 16 događaja u memoriji; to je korisno za
učenje, ali ima cijenu u I/O-u i u rastu `episodes.jsonl`.

**ReAct u odnosu na `reflection`:** ReAct **ne ocjenjuje** svoj izlaz. Ako model vrati samouvjereno pogrešan
odgovor bez ijednog tool call-a, petlja se završava poslije **jednog** LLM poziva i nitko to ne provjeri.
Reflection je upravo taj sloj iznad ReActa.

---

## 3. Planning (Plan-Act i Plan-Act-Reflect-Repeat)

Postoje **tri** planning porodice u kodu i lako ih je pomiješati. Razlika je u tome **ko pravi plan** i
**šta se radi kad plan ne uspije**.

### 3.1 `orchestrator-worker` — planer → workeri → sinteza (Plan-and-Execute)

- **Planer:** jedan LLM poziv (`role: 'magentic-planner'` ili `'planner'` u zavisnosti od patterna; u
  orchestrator-worker je to `helpers.callLlm(ctx, { role: 'planner', ... })`) koji vraća
  `{ goal, subtasks: [{ agent, goal }] }`. Tvrdo se trimuje na `maxWorkers` (default **5**), a svaki
  nepostojeći agent se **odbacuje** (`catalog.has(s.agent)`).
- **Ako je `config.workers` zadat — planer se preskače** (`plan.source === 'config'`, 0 LLM poziva za plan).
  To je determinizam za ponovljive procese i testove.
- **Workeri:** svaki je pun `runAgent` (dakle i on može imati svoju ReAct petlju i svoje alate).
  Pad workera se hvata i pretvara u `{ ok: false, error, code }` — **run se ne obara**.
- **Sinteza:** 1 LLM poziv (`role: 'synthesizer'`) ako je uspješan **više od jednog** workera; ako je uspio
  tačno jedan i `synthesize !== true`, njegov izlaz se vraća direktno (ušteda 1 poziv).
- **Nema talasa i nema `dependsOn`** — podzadaci su ravan spisak. Ako je 2. podzadatak zavisan od 1.,
  taj zadatak **nije** za ovaj pattern (vidi „Otvorena pitanja" u `04-ORCHESTRACIJA.md`).

### 3.2 `magentic` — plan → akcija → refleksija → korekcija (Plan-Act-Reflect-Repeat)

- **Plan pravi isti LLM koji izvršava** (nema odvojenog planera kao agenta): `role: 'magentic-planner'`,
  `maxTokens: 400`, „najviše 4 koraka".
- U **drugoj i svakoj daljoj iteraciji** plan dobija: originalni zadatak + prethodni `output` +
  **listu problema iz refleksije** (`iterations.at(-1)?.review?.issues`). Korekcija je time implicitna —
  nema posebnog „revise" poziva.
- **Refleksija** je `critic.review()`: heuristike (0 LLM) uvijek, LLM ocjena samo ako je `useLlmCritic: true`
  **i** heuristika već `accept` **i** zadata su `criteria`.
- **Zaustavljanje:** `accept`, `maxIterations` (default 3, tvrdo ≤ 6), ili stagnacija
  (`review.score <= lastScore` dva puta → `maxStagnant: 2`), ili budžet/abort.

### 3.3 `team` — fiksne uloge (Plan-Act sa obaveznim provjerama)

Plan nije „planer koji odlučuje šta će se raditi" nego **fiksni lanac uloga**: plan → research → extract →
validate → decide → execute → reflect, pa team-lead sinteza. Detalji u §6.

### Tabela odluke: koji planning pattern

| Pitanje | `orchestrator-worker` | `magentic` | `team` |
|---|---|---|---|
| Ko pravi plan? | Odvojen LLM poziv (planer); ili `config.workers` bez LLM-a | Isti agent koji izvršava (kratki plan u 4 koraka) | Fiksna lista uloga (`DEFAULT_STAGES`), plan je **prvi korak**, ne meta-plan |
| Koliko LLM poziva (izmjereno) | 4 (1 plan + 2 workera + 1 sinteza) | 2 (1 plan + 1 akcija), 3 sa LLM criticom | 8 (7 uloga + sinteza) |
| Da li je poznat skup koraka unaprijed? | Ne — planer ga izmišlja; `config.workers` daje determinizam | Ne — plan se prepisuje svaku iteraciju | Da — uloge su u kodu (`DEFAULT_STAGES`) |
| Da li se pattern sam ispravlja? | Ne; sinteza samo spoji i **navede** šta je palo | **Da** — refleksija → problemi → nova iteracija | Ne; `validate` provjerava podatke, `reflect` piše post-mortem |
| Kada ga birati | Zadatak se prirodno dijeli na 3–5 nezavisnih djelova | Cilj jasan, put nepoznat (dijagnostika, istraživanje) | Proces sa provjerama i odgovornošću (ponuda, zahtjev, odluka) |
| Šta je najveći rizik | Planer izmisli agente (odbacuje ih `catalog.has`) i trošak raste sa k | Petlja bez napretka (branjeno `stagnant` + `maxIterations`) | Cijena: 8 poziva i 8 epizoda u memoriji za svaki poziv |

---

## 4. Reflection

**Tok (`src/orchestration/reflection.js`):** `act → critique → revise → (ponovi) → vrati najbolju verziju`.

```js
const maxRounds = Math.max(1, Math.min(config.maxRounds ?? 2, 5));   // TVRDA granica 5
const threshold = config.threshold ?? 0.75;
let best = { output: '', score: -1, round: 0 };
let currentInput = task;

for (let i = 0; i < maxRounds; i += 1) {
  const res = await runAgent(spec, currentInput, { ...ctx, pattern: 'reflection' });   // ACT
  const review = await critic.review({ task, output: res.output, criteria: config.criteria ?? [],
                                       useLlm: config.useLlmCritic ?? false, threshold, tenantId: ctx.tenantId, ctx,
                                       model: config.criticModel });                    // CRITIQUE
  rounds.push({ round: i + 1, output: res.output, score: review.score, verdict: review.verdict, issues: review.issues, suggestion: review.suggestion });

  if (review.score > best.score) best = { output: res.output, score: review.score, round: i + 1 };   // PAMTI NAJBOLJE
  if (review.verdict === 'accept') break;                                                            // RANO STAJANJE
  if (i < maxRounds - 1) currentInput = [task, '', `Prethodni odgovor je ocijenjen kao nedovoljan (ocjena ${review.score}).`,
      review.issues.length ? `Problemi:\n${review.issues.map((x) => `- ${x.message}`).join('\n')}` : '',
      review.suggestion ? `Uputstvo: ${review.suggestion}` : '',
      'Napiši POPRAVLJENU verziju odgovora, bez objašnjavanja šta si mijenjao.'].filter(Boolean).join('\n');   // REVISE
}

const final = config.keepBest === false ? rounds.at(-1) : best;   // keepBest je DEFAULT true
```

### Kriteriji i prag

`critic.review()` (`src/agents/critic.js`) prvo radi **determinističke heuristike** (0 LLM poziva, < 5 ms):

| Kod | Težina | Značenje |
|---|---|---|
| `empty` | high (0.40) | prazan odgovor |
| `too_short` (< 40 znakova) | medium (0.15) | prekratko da bude korisno |
| `overclaim` („garantujem", „100% ", „nikad neće") | medium (0.15) | pravni i reputacijski rizik |
| `missing_citations` | medium (0.15) | traži se `[1]` a nema ga (samo ako je `context.kb` i `requireCitations`) |
| `secret_leak` (`api_key: …`) | high (0.40) | cure ključevi |
| `off_topic` | low (0.05) | nijedan ključni pojam iz zadatka |

`score = max(0, 1 − Σ težina)`; `verdict = score >= threshold && nema high issue ? 'accept' : 'revise'`.
LLM ocjena se poziva **samo ako je heuristika već `accept`** i `criteria.length > 0` — dakle LLM critic je
„drugo mišljenje" za već dobre odgovore, a ne način da se popravi očigledno loš odgovor.

**`threshold` — izbor u praksi:**

| `threshold` | Efekat | Kada |
|---|---|---|
| 0.60–0.70 | skoro svaka verzija prolazi; jeftino, malo popravki | interni nacrti |
| **0.75 (default)** | traži se jedan solidan odgovor; tipično 1 dodatna runda | ponude, izvještaji |
| 0.85–0.95 | skoro uvijek se ide na `maxRounds` (test u `tests/max.test.mjs` koristi 0.95 da dokaže 2 runde) | javni/pravni tekst |

**`keepBest: true` (default) je bitna odluka:** vraća se verzija sa **najvećim skorom**, a ne zadnja.
Bez toga bi „popravka" mogla vratiti **gori** odgovor i sistem bi ga poslao korisniku kao bolji.

### Kada se reflection isplati, a kada ne

| Isplati se | Ne isplati se |
|---|---|
| Ponuda, predlog, pravni tekst, javni odgovor — greška je skupa | Chat podrška i FAQ — odgovor je kratak, greška je jeftina |
| Izvještaj koji klijent čita i na osnovu njega odlučuje | Interna klasifikacija / rutiranje |
| Kada se kriteriji mogu napisati (`criteria: [...]`) | Kada nema kriterija → heuristike hvataju samo mehaničke greške |
| Kad je `maxRounds: 2` (jedna popravka) dovoljno | Kad se `maxRounds` diže na 4–5 bez mjerenja napretka (`improvement` stagnira) |

**Zamka koju treba znati:** `useLlmCritic: false` (default) znači da `accept` **ne** tvrdi da je odgovor tačan —
tvrdi samo da nema mehaničkih problema. Ako se na osnovu `accepted: true` donosi poslovna odluka, `criteria` i
`useLlmCritic: true` su **obavezni**.

---

## 5. Debate

**Tok (`src/orchestration/debate.js`):** debaeri sa eksplicitnim stavovima → N rundi → neutralni sudija.

```js
const rounds = Math.max(1, Math.min(config.rounds ?? 2, 4));                      // TVRDA granica 4
const debaters = (config.debaters ?? []).filter((d) => catalog.get(d.agent));     // nepostojeći se odbacuju
if (debaters.length < 2) { /* skip: ponaša se kao jedan agent, bez pada */ }

for (let r = 1; r <= rounds; r += 1) {
  const current = [];
  for (const d of debaters) {
    const prompt = [
      `TEMA: ${task}`, '',
      `Ti zastupaš stav: ${d.stance ?? 'neutralno'}.`,
      r === 1
        ? 'Iznesi svoje argumente (3-5 tačaka), sa brojkama i rizicima. Kratko i konkretno.'
        : `Ovo je runda ${r}. Prethodne argumente drugih strana imaš ispod. Odgovori na najjači protivargument i dopuni svoj stav. Ako te je druga strana uvjerila u nečemu, priznaj to eksplicitno.\n\nARGUMENTI PROTIVNIKA:\n${previousRound}`,
      'Ne ponavljaj opšte fraze. Na kraju napiši jednu rečenicu: "Moj zaključak: ...".',
    ].join('\n');
    const res = await runAgent(spec, prompt, { ...ctx, agentId: spec.id, pattern: 'debate' });
    transcript.push({ round: r, agent: spec.id, stance: d.stance ?? null, text: res.output });
    current.push(`### ${spec.id} (${d.stance ?? 'neutralno'})\n${res.output}`);
  }
  previousRound = current.join('\n\n');
}
```

### Kako debater vidi protivargumente

`previousRound` je **jedan string** koji sadrži **sve istaknute argumente iz prethodne runde**, sa
zaglavljem `### <agent> (<stav>)`. Dvije posljedice koje treba znati:

1. **Debater ne zna ko je šta rekao po rundama** — vidi samo prethodnu rundu, formatiranu kao tekst.
   Ako je debater u prethodnoj rundi bio `finance (za)`, to piše u zaglavlju, pa model može atribuirati tvrdnju.
2. **Prompt sadrži i sopstvene prethodne argumente** (jer su i oni u `previousRound`). To je namjerno
   (model treba da ostane konzistentan), ali troši kontekst i može dovesti do ponavljanja — zato prompt
   eksplicitno kaže „Ne ponavljaj opšte fraze".

**Sudija** nije debater: `config.judge` (default `'critic'`) se koristi **samo za ime u rezultatu**
(`judge: judgeSpec?.id ?? 'helpers'`), a odluku donosi `helpers.callLlm({ role: 'debate-judge' })` — dakle
**trošak sudije je naplaćen** i ide kroz budžet (`callLlm` zove `cost.record` + `budget.spend`).
Rasprava se sudiji šalje skraćena: `${previousRound.slice(0, 9000)}`.

### Trošak

**Formula: `broj_debatera × runde + 1`.** Izmjereno mock-om:

| Konfiguracija | LLM poziva | Napomena |
|---|---|---|
| 2 debatera × 1 runda | 3 | najjeftinija upotreba |
| 2 debatera × 2 runde | **5** | izmjereno (`finance` vs `legal`) |
| 3 debatera × 2 runde | **7** | izmjereno (`finance`, `legal`, `ops`) |
| 3 debatera × 4 runde | 13 | gornja granica dozvoljenog |

Uz to: svaki debater je **pun agent** (može pozvati alate → +1 poziv po tool loop-u), pa je stvarni broj
poziva ≥ formula. Zato `rounds: 2` i 2–3 debatera treba da bude default u praksi.

### Kada koristiti, a koje su zamke

**Koristiti kada:**

- Odluka ima **trade-off** koji se ne može svesti na jedno pitanje: „da li uvesti funkciju", „koji paket
  preporučiti", „isplati li se ugovor", „koji prevoznik".
- Postoji **strukturna jednostranost** — npr. `finance` gleda samo cijenu, `legal` samo rizik; debate tjera
  svakog da odgovori na najjači protivargument.
- Kriteriji odluke nisu formalizovani (inače je `decider` sa `criteria` jeftiniji).

**Zamke:**

| Zamka | Zašto se dešava | Kako se brani |
|---|---|---|
| **Grupa se složi oko pogrešnog** | Svi debaeri su isti model sa istim podacima → korelirana greška; sudija „potvrdi" konsenzus | Različiti agenti (različiti promptovi/domene) i eksplicitan stav; sudija ima instrukciju da kaže ako su argumenti **izjednačeni** |
| Sudija nagradi dužinu | Modeli preferiraju duže tekstove | System prompt sudije: „Odluči na osnovu argumenata, ne na osnovu toga ko je duže pisao." |
| Debaeri se ne pomjere | Runda 2 ponavlja rundu 1 | Prompt traži odgovor na **najjači protivargument** i eksplicitno priznanje ako je druga strana uvjerila |
| Trošak eksplodira | `debaeri × runde` raste linearno, a svaki debater je agent | Tvrde granice: `rounds ≤ 4`, `debaters` iz config-a, budžet run-a |
| Sudija padne | LLM greška | `verdict = "Sudija nije dostupan. Argumenti strana: …"` — **transparentno**, ne tiho |
| Manje od 2 debatera | Config greška ili agent ne postoji | `skipped: 'nedovoljno debatera (min 2)'`, ponaša se kao jedan agent (bez pada) |

---

## 6. Specijalistički tim (`team`)

`team` je jedini pattern koji **ima fiksne uloge u kodu** (`DEFAULT_STAGES` u `src/orchestration/team.js`).
Redoslijed je obavezan, a svaka uloga je zaseban agent iz `config/agents/*.json`.

### 7 uloga iz `DEFAULT_STAGES`

| # | Uloga | Agent | Alati koje smije (iz config-a) | `maxRisk` / `maxSteps` | Šta proizvodi |
|---|---|---|---|---|---|
| 1 | `plan` | `planner` | `make_plan`, `memory_search`, `report_generate`, `calculator`, `current_time`, `json_query` | low / 4 | Numerisan plan: korak, ko ga radi, kako se zna da je gotov + pretpostavke, rizici, alternativni put |
| 2 | `research` | `researcher` | `http_fetch`, `memory_search`, `kb_ingest`, `report_generate`, `calculator`, `current_time`, `json_query` | medium / 10 | Nalazi sa **izvorima**; ono što nema izvor ide u sekciju „Neprovjereno" |
| 3 | `extract` | `extractor` | `json_query`, `calculator`, `memory_search`, `report_generate`, `current_time` | low / 4 | **JSON** polja sa citatom izvora; `null` + `nedostaje[]` za ono čega nema |
| 4 | `validate` | `validator` | `calculator`, `memory_search`, `json_query`, `current_time`, `report_generate` | low / 5 | Tri sekcije: POTVRĐENO / NIJE POTVRĐENO / PROTIVRJEČNO (bez popravljanja podataka) |
| 5 | `decide` | `decider` | `calculator`, `memory_search`, `report_generate`, `make_plan`, `json_query`, `current_time` | medium / 5 | ODLUKA + kriteriji + opcije + šta bi odluku promijenilo + sljedeći korak sa rokom |
| 6 | `execute` | `executor` | `crm_upsert`, `crm_get`, `ticket_create`, `order_lookup`, `email_send`, `invoice_create`, `notify`, `process_update`, `report_generate`, `http_fetch`, `calculator`, `current_time`, `json_query` | **high** / 10 | Stvarne akcije kroz alate + tačan izvještaj (ID-evi zapisa, šta nije uspjelo); `email_send` i `invoice_create` traže odobrenje |
| 7 | `reflect` | `reflector` (**`optional: true`**) | `episode_record`, `memory_search`, `calculator`, `current_time`, `report_generate`, `json_query` | low / 4 | Post-mortem + pouke upisane u epizodičnu memoriju (`episode_record`) |

> **Napomena o alatima:** tabela navodi **maksimum** iz `config/agents/*.json`. Stvarni spisak po pozivu je
> presjek tri filtera: `spec.tools` (`allowsTool`), politika tenanta (`evaluate` u `tools.specsFor`) i
> `spec.maxRisk`. `executor` ima `maxRisk: high`, pa mu `email_send`/`invoice_create` **stoje u promptu** —
> ali sa oznakom `traži odobrenje`, i `tools.execute` ih **neće** izvršiti bez odobrenja.

### `skip`, custom `stages`, `blackboard`, sinteza

```js
const stages = (config.stages ?? DEFAULT_STAGES).filter((s) => !(config.skip ?? []).includes(s.role));
const available = stages.filter((s) => catalog.get(s.agent));
const missing = stages.filter((s) => !catalog.get(s.agent)).map((s) => s.agent);
const blackboard = { input: task, ...(ctx.blackboard ?? {}) };

for (const stage of available) {
  const vars = { ...blackboard, previous: results.at(-1)?.output ?? task };
  const stageInput = interpolateDeep(stage.input, vars);      // {{input}}, {{plan}}, {{research}}, {{extract}}…
  const res = await runAgent(spec, stageInput, { ...ctx, agentId: spec.id, pattern: 'team', blackboard,
                                                 options: { ...ctx.options, maxRunUsd: config.maxStageUsd ?? ctx.options?.maxRunUsd } });
  blackboard[stage.role] = res.output;                        // KLJUČ JE IME ULOGE, ne ime agenta
  results.push({ role: stage.role, agent: spec.id, ok: true, output: res.output, status: res.status, costUsd: res.costUsd, chars: res.output.length });
}
```

- **`skip: ['research', 'extract', 'validate']`** — uloge se preskaču **prije** interpolacije, pa
  `{{research}}` u kasnijem koraku ostaje nepopunjen token (a ne prazan string uz grešku). Test
  `team poštuje skip listu` to dokazuje.
- **Custom `stages`** — niz `{ role, agent, input }`; `role` je ključ u `blackboard`-u, pa je ugovor:
  **ime uloge = ime varijable** u `{{...}}`. Ako agent iz `stages` ne postoji, ide u `missingAgents[]`
  i **ne izvršava se** (test provjerava `missingAgents: ['nema-me']`).
- **`blackboard` između koraka** — `interpolateDeep()` popunjava `{{input}}`, `{{plan}}`, `{{research}}`,
  `{{extract}}`, `{{validate}}`, `{{decide}}`, `{{execute}}` i `{{previous}}` (izlaz prethodnog koraka).
  U rezultatu se vraća samo **spisak ključeva** (`blackboardKeys`), ne cijeli sadržaj — da odgovor ne nosi
  7 punih tekstova.
- **Team-lead sinteza** — poslije svih uloga, **jedan** LLM poziv (`role: 'team-lead'`) pravi JEDAN odgovor:
  zaključak, ključne činjenice, odluka/akcija i šta ostaje otvoreno; ako je nešto palo, to mora pisati u jednoj
  rečenici. Ulazi se trimuju na 9000 znakova. `synthesize: false` gasi sintezu (tada je izlaz zadnji uspješan korak).
- **Pad koraka:** `optional: true` → blackboard dobija `''` i tim ide dalje; bez `optional` →
  `config.failFast !== false` (default) **baca** i run pada; sa `failFast: false` u blackboard ide
  `"Korak <role> nije uspio: <poruka>"` i ostale uloge se izvršavaju.
- **`maxStageUsd`** se prosljeđuje kao `options.maxRunUsd` **agentu** — to je limit po koraku, ali
  **`team` ne provjerava zbir**; zajednički `ctx.budget` i dalje važi za cijeli run.

### Konkretan primjer: 7 koraka i realni alati (tenant `agencija`, zadatak „Pripremi ponudu za Prima d.o.o.")

```
input: "Pripremi ponudu za Prima d.o.o. (nabavka 200 laptopova + 3 godine podrške)"

[1] plan      planner      tool make_plan → plan: 1) provjeri potrebe i budžet  2) izračunaj cijenu
                                        3) provjeri pravne uslove  4) napiši ponudu  5) pošalji
                           (0 dodatnih LLM poziva ako model ne zove alat)
[2] research  researcher   tool http_fetch("https://api.deepseek.com/…")? NE — domen mora biti na allowlisti;
                           u praksi: memory_search (istorija sa Primom) + kb_ingest (cjenovnik) →
                           nalazi sa izvorima; javni podaci o klijentu idu u „Neprovjereno" ako nema linka
[3] extract   extractor    tool json_query nad cjenovnikom → { "model_laptop": null, "kolicina": 200,
                           "podrska_godine": 3, "nedostaje": ["model_laptop","rok_isporuke"] }
[4] validate  validator    tool calculator (200 × jedinična cijena + 3 × podrška, PDV 20%) →
                           POTVRĐENO: količina; NIJE POTVRĐENO: model i rok; PROTIVRJEČNO: —
[5] decide    decider      ODLUKA: ponuditi 2 opcije (osnovna/premium) · KRITERIJI: cijena, rok, garancija
                           · ŠTA BI PROMIJENILO ODLUKU: ako klijent traži isporuku < 30 dana · SLJEDEĆI KORAK: 3 dana
[6] execute   executor     tool invoice_create → APPROVAL_REQUIRED (high) → approvals[] = [invoice_create],
                           status: 'awaiting_approval'; mejl se NE šalje (email_send je isto requireApproval)
[7] reflect   reflector    tool episode_record → pouka: "Prije izrade ponude traži model i rok isporuke"
                           + post-mortem u 5 tačaka
[sinteza]     (team-lead)  JEDAN odgovor: zaključak, cijene, otvorene stavke, i eksplicitno
                           "izvršenje čeka odobrenje fakture"
```

Izmjereno mock-om: **8 LLM poziva** (7 uloga + sinteza), `costUsd` raste sa svakim korakom.
Sa `skip: ['research','extract','validate']` izmjereno je **5**.

### Kada tim nije potreban (trošak!)

| Situacija | Bolji izbor | Zašto |
|---|---|---|
| Pitanje ima jedan odgovor iz baze znanja | `agent` (ReAct) | 1–2 poziva umjesto 8 |
| Zadatak je linearan i bez provjera | `sequential` | isti broj koraka, **bez** sinteze i bez fiksnih uloga |
| Potrebna je samo validacija postojećeg teksta | `reflection` sa `criteria` | 2–4 poziva, ciljano |
| Zadatak se grana na nezavisne djelove | `orchestrator-worker` | sinteza samo spaja; nema `reflect` koraka koji se plaća |
| Potrebna je odluka sa trade-off-ima | `debate` ili `decider` u `agent` patternu | `decider` kao jedan agent je najjeftiniji za odluku |
| Ponavlja se 100× dnevno (npr. klasifikacija tiketa) | `router` + `agent` | 8× trošak na svakom tiketu nije održiv |

---

## 7. Multi-agent bez haosa

Pravila koja se **stvarno** drže u kodu (i koja treba držati pri svakoj izmjeni):

1. **Jedan `runId` za cijeli zadatak.** `tracer.startRun()` se zove **jednom** u `orchestrator.run()`;
   svi patterni, agenti i alati dobijaju taj isti `ctx.runId`. Zato je trošak (D16) vezan za jedan run i
   `/v1/runs/:runId` vraća cijeli trace — nema „5 runova" za jedan korisnički zahtjev.
2. **`ctx` se grana plitko** (`{ ...ctx, agentId, pattern }`), pa `budget`, `signal`, `trace` i `blackboard`
   ostaju **zajednički**. Posljedica: trošak radnika se slijeva u **jedan** budžet run-a.
   **Zamka:** pošto je `blackboard` isti objekat, dva workera koja pišu isti `outputKey` — zadnji pobjeđuje.
   U `fanout`-u se zato čita `workers[i].output`, **ne** blackboard.
3. **`blackboard` je jedini kanal stanja.** Nijedan modul ne čita globalne varijable ni fajlove da bi saznao
   „gdje smo"; `team` piše `blackboard[role]`, `sequential` piše `blackboard[step.outputKey]`, `handoff` nosi
   kontekst u **payload**-u (a ne u blackboard-u). Servisi (`llm`, `tools`, `tracer`, `cost`) su izvan `ctx`
   — dobijaju se fabrikom `createXPattern(services)`.
4. **Zabrana rekurzije bez granice.** Ugniježđavanje patterna je dozvoljeno (`04-ORCHESTRACIJA` §1 propisuje
   dubinu 2), ali **provjera dubine (`depth > 2` → `NESTED_DEPTH_EXCEEDED`) još nije u kodu**
   (`04-ORCHESTRACIJA.md` §12, nalaz #5). Do tada: pattern koji zove agenta koji interno pokreće drugi pattern
   **nema tvrdu granicu** — jedina brava je budžet run-a. Ovo je otvoreno pitanje, ne tvrdnja da je riješeno.
5. **`maxWorkers` / `concurrency` su tvrdi.** `orchestrator-worker` trimuje plan na `maxWorkers` (default 5);
   `fanout` drži `concurrency` u `[1, 8]` i izvršava kroz `runWithConcurrency()` (N fiksnih radnika nad
   zajedničkim kursorom), pa **nema** 20 istovremenih poziva na jedan API ključ.
   **Isto važi za `maxSteps`:** budžet se skalira po patternu (`PATTERN_STEP_BUDGET`:
   `agent`/`react` 1, `router`/`sequential` 2, `orchestrator-worker`/`fanout`/`handoff`/`magentic`/`reflection` 3,
   `debate` 5, `team` 6) — bez toga bi `team` (7 specijalista + sinteza) pao na koraku predviđenom za
   jedan razgovor. Kod `router`-a se množitelj **preračuna** (`budget.setMaxSteps(base × faktor)`) čim se
   zna konačni pattern, pa `router: 2` ne ograničava izabranog agenta.
6. **`handoff` se ne miješa sa `team`.** `handoff` je za „zadatak mijenja nadležnost" (podrška → naplata → tehnički),
   `team` je za „jedan zadatak, više uloga, jedan vlasnik". Ako `executor` u timu pozove `handoff` alat,
   `team` ga samo **zabilježi** (`handoffs[]`) i **ne predaje kontrolu** — kontrola ostaje u timu.
7. **`team` vs `handoff` — pravilo odluke:**

| Pitanje | `team` | `handoff` |
|---|---|---|
| Koliko vlasnika zadatka? | Jedan (team-lead, sinteza na kraju) | Kontrola se **predaje** specijalisti |
| Da li je redoslijed fiksan? | Da (`DEFAULT_STAGES`, može `skip`/custom) | Ne — zavisi od toga kome agent preda |
| Kako se brani od petlje? | Nema petlje (linearno) | `visited[]` + `maxHandoffs` (default 3, tvrdo ≤ 6) |
| Kada je bolji | Proces sa provjerama i odgovornošću | Kad specijalizacija stvarno mijenja kvalitet |
| Trošak | 7 uloga + sinteza (fiksno) | h + 1 po agentu, ali raste ako agent predaje dalje |

---

## 8. Trošak i latencija po patternu

**Metod:** `tests/helpers.mjs` → `buildTestRobot({ script: smartScript() })` (mock provider, 0 USD, bez mreže).
Brojevi su **izmjereni**, ne procijenjeni. „Steps" je `res.steps` iz orkestratora (broj `budget.addStep()`
poziva: LLM pozivi **i** tool pozivi).

| Pattern (konfiguracija) | LLM poziva | `steps` | `costUsd` (mock) | Latencija |
|---|---|---|---|---|
| `agent` (support, koristi `memory_search`) | 2 | 3 | 0.000525 | ≈ 2 × trajanje poziva + 1 alat |
| `react` (isti agent) | 2 | 3 | 0.000525 | isto kao `agent` |
| `router` (heuristic + agent sa alatom) | 3 | 3 | 0.000525 | router: 0 LLM; ostatak kao `agent` |
| `sequential` (2 agent koraka + 1 tool korak) | 2 | 3 | 0.000525 | ∑ koraka (serijski) |
| `orchestrator-worker` (2 workera) | 4 | 4 | 0.00105 | ∑ workera + sinteza |
| `fanout` (3 grane) | 4 | 4 | 0.00105 | ≈ max(grana) + sinteza |
| `handoff` (1 agent, bez predaje) | 1 | 1 | 0.000262 | 1 × trajanje agenta |
| `magentic` (1 iteracija, heuristički critic) | 2 | 2 | 0.000525 | plan + akcija |
| `magentic` + `useLlmCritic: true` | 3 | 3 | 0.000525 | + 1 poziv kritičara |
| `reflection` (`maxRounds: 2`) | 2 po rundi → do 4 | 4 | ≈ 0.00105 | 2 × po rundi (serijski) |
| `debate` (3 debatera × 2 runde) | **7** | 7 | 0.001837 | 6 poziva + sudija, serijski |
| `debate` (2 debatera × 2 runde) | **5** | 5 | — | 4 + sudija |
| `team` (svih 7 uloga) | **8** | 8 | 0.002099 | 7 koraka + sinteza, serijski |
| `team` (`skip: research, extract, validate`) | **5** | 5 | 0.001312 | 4 koraka + sinteza |

**Kako čitati ovu tabelu (i gdje je zamka):**

- „LLM poziva = 2" kod `agent`-a **nije** 2 poziva po pravilu: mock script prvo traži `memory_search`
  (1 poziv + 1 alat), pa tek onda daje odgovor (2. poziv). Agent koji ne koristi alat ima **1** poziv.
  Zato je **pravi** broj poziva `1 + broj tool loop-ova`; `steps` je uvijek veći ili jednak broju LLM poziva.
- `costUsd` u tabeli je **mock cijena** (mock model ima `PRICING.mock = { in: 0, out: 0 }`, ali testovi
  koriste `deepseek-chat` pricing kroz `spec.model` u `buildTestRobot`). Služi samo za **relativno poređenje**,
  ne za naplatu. Za stvarne cijene: `PRICING` u `src/observability/cost.js` (i napomena „provjeriti kod providera").
- Latencija: `handoff`, `sequential`, `team`, `reflection`, `debate` su **serijski** (latencija raste linearno).
  `fanout` i `orchestrator-worker` sa `parallel: true` imaju latenciju ≈ **max(grana)**, ne sumu — ali trošak
  je isti (paralelizacija **ne** smanjuje cijenu, samo vrijeme).

### 4 pravila za smanjenje troška

1. **Izaberi najmanji pattern koji zadatak stvarno traži.** Poredak po cijeni (izmjereno):
   `handoff`/`agent` (1–2) < `sequential`/`magentic` (2) < `router` heuristic (0 LLM + agent) <
   `fanout`/`orchestrator-worker` (4) < `reflection` (do 4) < `debate` (5–7) < `team` (**8**).
   `team` na zadatku koji jedan agent može da odradi je **4–8× skuplji** bez mjerljivog dobitka.
2. **`criteria` + `useLlmCritic` samo gdje se isplati.** Heuristički critic je besplatan i hvata
   `empty`, `too_short`, `secret_leak`, `overclaim`, `off_topic`. LLM critic dodaje **1 poziv po rundi** —
   uključivati ga tamo gdje tačnost nosi novac (ponude, pravni tekst), ne u chat podršci.
3. **Skrati prelazne rezultate.** `helpers.condense(value, 2500)` (tvrdi rez za jedan unos) i
   `condenseList(items, 6000–7000)` (za listu prije sinteze) su već dostupni; debate reže raspravu na
   9000 znakova, team na 9000. Bez toga prompt raste sa svakom rundom i trošak raste **kvadratno**.
4. **Isključi uloge/iteracije koje ne mijenjaju odluku, i mjeri.** `skip` u `team` (5 umjesto 8),
   `maxRounds: 2` u `reflection`, `rounds: 2` i 2–3 debatera u `debate`, `maxIterations: 2` u `magentic`
   (`config/agents/researcher.json` već ima `maxIterations: 2`). Svaka ušteda se **mora** dokazati testom
   (broj LLM poziva je dio ugovora) — inače je tiha promjena kvaliteta.

---

## 9. Testiranje patterna

| Pattern | Šta test dokazuje | Gdje je test |
|---|---|---|
| svi (11 imena) | `PATTERNS` ima tačno 11 ulaza, u tačnom redu | `tests/patterns.test.mjs` (`postoji 11 ulaza (agent/react + ruter + 8 patterna)`) |
| `agent` | izlaz, `costUsd > 0`, `usage.tokensIn > 0`, trace postoji, trošak po agentu u `cost.summary` | `tests/patterns.test.mjs` |
| `react` | alias radi istu petlju kao `agent`, `status: 'ok'` | `tests/max.test.mjs` (`react je alias za agent petlju`) |
| `router` | bira agenta **bez LLM-a** (`method: 'heuristic'`) i koristi `defaultPattern` izabranog agenta | `tests/patterns.test.mjs` |
| `sequential` | redoslijed koraka, 3 koraka (2 agenta + 1 alat), output = zadnji korak | `tests/patterns.test.mjs` |
| `orchestrator-worker` | plan se trimuje, workeri rade, sinteza spaja, `workersOk` tačan | `tests/patterns.test.mjs` |
| `fanout` | 3 grane se izvrše, `workers[]` sadrži tačne agente, sinteza radi; **pad jedne grane ne obara run** (`failed.length === 1`) | `tests/patterns.test.mjs` |
| `handoff` | lanac predaje (`handoffChain`, `visited`, `resolvedBy`) i **zaštita od ping-ponga** | `tests/patterns.test.mjs` |
| `magentic` | iteracije postoje, `finalReview.score` je broj, izlaz nije prazan | `tests/patterns.test.mjs` |
| `reflection` | loš prvi odgovor → **druga runda**, `score` raste, `improvement > 0`, vraća se popravljena verzija | `tests/max.test.mjs` |
| `debate` | `rounds`, broj debatera, `transcript.length === debateri × runde`, `positions`, izlaz sudije | `tests/max.test.mjs` |
| `debate` (degenerisan slučaj) | sa 1 debaterom **ne pada** — `skipped: 'nedovoljno debatera (min 2)'`, ponaša se kao agent | `tests/max.test.mjs` |
| `team` | svih 6 prvih uloga u redu (`plan, research, extract, validate, decide, execute`), svaki korak `ok`, `costUsd > 0` | `tests/max.test.mjs` |
| `team` (`skip` i custom `stages`) | `skip` uklanja uloge; nepoznat agent ide u `missingAgents` i **ne izvršava se** | `tests/max.test.mjs` |
| Patterni + sandbox | `strict` sandbox blokira `http_fetch` i kad je alat odobren (`POLICY_DENIED`) | `tests/max.test.mjs` (`agent ne smije pozvati alat koji je van njegovog sandboxa`) |
| Patterni + politika | zabranjen alat daje `POLICY_DENIED` bez pada run-a; `high` rizik daje `awaiting_approval` i **ne izvršava** akciju | `tests/patterns.test.mjs` |
| Patterni + budžet | `maxRunUsd` blizu 0 → `BUDGET_EXCEEDED` | `tests/patterns.test.mjs` |
| Patterni + izolacija | `allowedAgents` blokira tuđeg agenta; nepoznat tenant → `NOT_FOUND` | `tests/patterns.test.mjs` |

**Pravilo koje treba držati pri svakoj izmjeni patterna:** **broj LLM poziva je dio ugovora.**
`assert.equal(llm.callCount, N)` u testu je jedina odbrana od tihe regresije troška (najčešća regresija u
multi-agent sistemima je „još jedan poziv po grani"). Ako se pattern mijenja namjerno, mijenja se i broj u testu —
u **istom** commit-u.

---

## 10. Šta fali

Ovo je iskren spisak onoga što MAX sloj **još nema**. Ništa od navedenog nije u kodu.

1. **Pravi DAG (talasi i `dependsOn`).** `orchestrator-worker` prima **ravan** spisak podzadataka; nema
   zavisnosti („cijena se računa **poslije** istraživanja"). Posljedica: ili se sve radi paralelno (i planer
   mora sam da pogodi redoslijed u tekstu `goal`-a), ili se koristi `sequential` i gubi paralelizam.
   Predlog: `subtasks[].dependsOn: [index]` + izvršavanje po nivoima (`topological levels`), uz tvrdi
   `maxLevels` i detekciju ciklusa (`PLAN_CYCLE` je već predviđen u klasifikaciji grešaka u `04` §9).
2. **Paralelni `team`.** Sve 7 uloga je **serijski**. Uloge `research` i `extract` (i dijelom `validate`)
   nemaju međusobnu zavisnost i mogle bi ići paralelno, što bi latenciju skratilo sa 7 na ~4 koraka.
   Predlog: `stages[].parallel: true` grupa + `runWithConcurrency()` iz `fanout.js` (već postoji i dokazan je).
3. **Debate sa glasanjem publike.** Sada postoji **jedan** sudija. Ne postoji:
   (a) glasanje **više sudija** (`judges: [...]` → većina), (b) glasanje debatera o tuđim argumentima,
   (c) „publika" koja ocjenjuje kvalitet argumenata bez odlučivanja. Kod odluka sa visokim ulogom,
   jedan sudija je jedna tačka otkaza (i jedan korelirani model).
4. **Evaluator tim (nezavisna verifikacija kao pattern).** `critic` ocjenjuje **tekst**, ne **ishod**:
   ne postoji pattern koji poslije izvršenja provjerava stvarni efekat (npr. „da li je faktura stvarno
   upisana i da li je iznos tačan"). `validate` u `team` provjerava **podatke prije** odluke, ne rezultat poslije.
   Predlog: `evaluator` korak koji dobija `execute` izlaz + očekivanja iz `decide` i vraća `verdict` sa dokazima.
5. **Cijena kao dio odluke patterna (auto-izbor po budžetu).** Danas pattern bira pozivalac (`req.pattern`)
   ili `defaultPattern` agenta — **nikad** budžet. Nema `patternPolicy` koji bi rekao:
   „ako je `budget.remainingUsd() < 0.05`, `team` se degradira u `sequential`" ili
   „ako je mjesečna potrošnja > 80% limita, `debate` je zabranjen". Postoji `assertAgentBudget` u control plane-u
   (tvrdi prekid), ali nema **degradacije** koja bi zadatak ipak završila jeftinijim patternom.
6. **Trajni `blackboard` i nastavak prekinutog run-a.** `blackboard` živi samo u memoriji run-a; poslije
   `AbortError` ili `BUDGET_EXCEEDED` nema `/v1/runs/:runId/resume`. Kod `team` to znači da se 7 koraka
   plaća **iznova** ako zadnji korak padne.
7. **Mjerena latencija i cijena po patternu u produkciji.** Metrike postoje
   (`pattern_llm_calls_total`, `run_cost_usd`, `tool_duration_seconds`), ali nema izvještaja
   „prosječan broj LLM poziva po patternu u zadnjih 7 dana" — bez toga se regresija troška vidi tek na računu.

---

## Otvorena pitanja

1. **`react` kao alias — da li ostaje alias ili postaje pravi ReAct?** Danas je `patterns.react = patterns.agent`
   (identičan objekat). Ako ReAct treba da se razlikuje (npr. eksplicitni `Thought/Action/Observation` format u
   promptu ili obavezan „thought" korak), to je **novi** pattern i novi test — a time i nova cijena?
2. **`keepBest` vs „zadnja verzija"** — default je `keepBest: true` (vraća najbolji skor). U praksi
   korisnik često želi **zadnju** verziju jer je „najsvježija" (model je vidio kritiku). Koji je pravilan
   default za ponude: najbolji skor ili zadnja iteracija, i treba li `keepBest` biti **per-tenant** config?
3. **Debate: koliko sudija?** Jedan sudija je jeftin, ali je jedna tačka otkaza i jedan korelirani model.
   Da li uvodimo 3 sudije sa većinom (trošak +2 poziva) ili glasanje debatera (trošak +0, ali slabija
   nezavisnost)? I mora li sudija biti **drugi** model od debatera da bi uopšte imao smisla?
4. **`team`: `maxStageUsd` po koraku ili zajednički budžet?** Danas se `maxStageUsd` prosljeđuje agentu kao
   `maxRunUsd`, a zajednički `ctx.budget` važi za sve. Da li `team` treba da ima **svoj** ukupni limit
   (npr. `maxTeamUsd`) i da **preskoči** `reflect`/sintezu ako je blizu limita?
5. **`team` i `handoff` u jednom zadatku** — ako `executor` pozove `handoff` alat, `team` ga samo zabilježi.
   Da li je to željeno (tim ostaje vlasnik) ili treba dozvoliti **izlazak** iz tima uz `visited[]` zaštitu?
   Odgovor mijenja semantiku `handoffs[]` u rezultatu.
6. **Auto-degradacija po budžetu** — da li se uvodi `patternPolicy` (mapa „kad je budžet nizak, koristi
   jeftiniji pattern") i ako da, ko ga kontroliše: tenant admin, NMQ, ili sam agent? Degradacija mijenja
   **kvalitet** odgovora bez pitanja korisnika, pa zahtijeva eksplicitno odobrenje u politici.
7. **Dubina ugniježđavanja** — `NESTED_DEPTH_EXCEEDED` je propisan u `04` §1 i §12, ali **nije u kodu**.
   Da li se uvodi prije nego se pojavi prvi tenant koji ugnijezdi `team` unutar `fanout`-a (i time
   eksponencijalno potroši budžet), ili ostaje samo budžet kao brana?
