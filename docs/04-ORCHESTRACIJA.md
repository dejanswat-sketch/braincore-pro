# 04 — Orchestracija: 6 patterna

> **v0.2 dopuna:** dodati su `reflection`, `debate` i `team` (plus `react` kao alias za `agent` petlju) —
> opis u `docs/16-PATTERNI-MAX.md`. `PATTERNS` sada ima **11 imena**, a budžet koraka se množi po patternu
> (`PATTERN_STEP_BUDGET` u `src/orchestration/index.js`, odluka D26 u `DECISIONS.md` §8).
> Ovaj dokument ostaje tačan za prvih 6 patterna.

> Dokument je **izvršni ugovor** za `src/orchestration/` i `src/agents/`.
> Izvor istine je `docs/DECISIONS.md` (D13, D14, D15, D16, D17).
> Verzija: 1.1 · Datum: 2026-09-29 · Vlasnik: NMQ (Dejan Milošević PR)
> **v1.1:** usklađeno sa stvarnim kodom (`src/orchestration/*.js`, `src/agents/*.js`) — potpisi, config
> ključevi i oblici rezultata su provjereni u kodu, ne pretpostavljeni.

**Fajlovi na koje se ovaj dokument odnosi:**

| Putanja | Odgovornost | Status |
|---|---|---|
| `src/orchestration/index.js` | ulaz `createOrchestrator()` / `run()`, registry `PATTERNS`, izbor patterna, trace, budžet | postoji |
| `src/orchestration/sequential.js` | `createSequentialPattern()` — linearni pipeline, `failFast` | postoji |
| `src/orchestration/orchestrator-worker.js` | `createOrchestratorWorkerPattern()` — planer → workeri → sinteza | postoji (vidi §12 zamku) |
| `src/orchestration/fanout.js` | `createFanoutPattern()` + `runWithConcurrency()` + `condenseList()` | postoji |
| `src/orchestration/handoff.js` | `createHandoffPattern()` — predaja kontrole, zaštita od petlje | postoji |
| `src/orchestration/magentic.js` | `createMagenticPattern()` — plan → akcija → refleksija | postoji |
| `src/orchestration/helpers.js` | `callLlm()` (budžet + cost + span), `parseJson()`, `condense()`, `render()` | postoji |
| `src/agents/agent.js` | `createAgentRunner()` — jedan agent, `allowsTool()`, `buildSystemPrompt()` | postoji |
| `src/agents/catalog.js` | učitavanje `config/agents/*.json`, `routingTable()`, `toolsFor()` | postoji |
| `src/agents/router-agent.js` | `createRouter().classify()` — keyword + embedding + LLM fallback | postoji |
| `src/agents/critic.js` | `createCritic().review()` — heuristike + opciona LLM ocjena | postoji |

**Stil koda (obavezno):** patterni su **fabrike** koje vraćaju `{ name, run }`, a ne gotove funkcije.
Razlog: pattern dobija servise (llm, tools, tracer, cost, catalog) jednom, pri dizanju servera, a ne na svaki poziv.

```js
// src/orchestration/index.js — stvarni oblik
export const PATTERNS = ['agent', 'router', 'sequential', 'orchestrator-worker', 'fanout', 'handoff', 'magentic'];

export function createOrchestrator(services) {
  const patterns = {
    agent: { name: 'agent', run: async ({ input, ctx }) => { /* jedan agent, bez patterna */ } },
    sequential: createSequentialPattern(services),
    'orchestrator-worker': createOrchestratorWorkerPattern(services),
    fanout: createFanoutPattern(services),
    handoff: createHandoffPattern(services),
    magentic: createMagenticPattern(services),
  };
  return { run, patterns, helpers, PATTERNS };
}
```

`PATTERNS` sadrži **7 imena** (`agent` + 6 patterna iz D13). `agent` je "nulti pattern": jedan agent, jedan
odgovor, bez orchestriranja. Služi kao fallback kada agent nema `defaultPattern` i kao najjeftiniji put.

**Ugovor sa DECISIONS §2:** javni interfejs prema serveru i widgetu je `orchestrator.run(req)` i on vraća
oblik iz ugovora (`output`, `steps`, `usage`, `costUsd`, `traceId`, `approvals`). Patterni interno vraćaju
bogatiji oblik (`results`, `workers`, `iterations`, `transcript`) — **mapiranje radi `run()`**, ne patterni.

---

## 1. Kako se pattern bira

Pattern se **nikad ne bira u kodu** (`if (task.type === 'x')`) — bira se config-om i jednim redom u `index.js`:

```js
const requestedPattern = req.pattern && PATTERNS.includes(req.pattern) ? req.pattern : null;
const agentSpec        = agentId ? catalog.get(agentId) : null;
const initialPattern   = requestedPattern ?? agentSpec?.defaultPattern ?? 'router';
```

### Tabela odluke

| Vrsta zadatka | Pattern | Zašto | Primjer iz prakse |
|---|---|---|---|
| Jedno pitanje, jedan odgovor, jedan agent | `agent` | Najjeftinije — nema planiranja, sinteze ni rutiranja | "Koje je radno vrijeme?" → `support` direktno |
| Nepoznat ulaz, ne zna se koji agent | `router` | 0–1 LLM poziv sprečava da pogrešan agent potroši budžet | Widget na `nomorequiet.com`: "gdje je moja narudžba?" → `support` |
| Linearni proces, koraci se ne mogu preskočiti | `sequential` | Deterministički redoslijed, `failFast`, 1 poziv po koraku | Ulazni račun: parse → extract → validate → summarize → store |
| Veliki zadatak koji se razbija na podzadatke | `orchestrator-worker` | Planer vidi cjelinu, workeri su mali i specijalizovani | "Pripremi ponudu za klijenta" (istraživanje + cijene + pravni + pisac) |
| Isti ulaz treba analizirati iz više uglova | `fanout` | Paralelno → latencija ≈ max(grana), ne suma | Analiza ugovora: pravni + finansijski + komercijalni ugao |
| Zadatak prelazi domen (support → naplata → tehnički) | `handoff` | Specijalista radi svoj dio bolje od generaliste | "Ne mogu da se ulogujem, a i račun je pogrešan" |
| Nema plana unaprijed, cilj je istraživački | `magentic` | Petlja sama gradi plan i ispravlja se na osnovu refleksije | "Istraži zašto je prodaja pala i predloži 3 akcije" |

**Redoslijed provjere (stvarni kod, `run()` u `index.js`):**

1. `req.pattern` — ako je u `PATTERNS`, koristi se (override pozivaoca, npr. dugme u admin panelu).
2. Ako nema `agentId` → `router` (jer nema čije `defaultPattern` da se koristi).
3. Inače → `agentSpec.defaultPattern` iz `config/agents/<id>.json`.
4. Ako je izabran `router`, poslije klasifikacije se koristi `chosen.defaultPattern` (a ako je i on `router`,
   onda `agent` — da ne nastane beskonačno rutiranje).

```js
if (initialPattern === 'router') {
  routing     = await services.router.classify(input, { tenantId, useLlm: options.useLlmRouter !== false, signal, model: options.routerModel });
  const chosen = catalog.get(routing.agentId) ?? catalog.get('support');
  usedPattern  = chosen.defaultPattern && chosen.defaultPattern !== 'router' ? chosen.defaultPattern : 'agent';
  ctx.agentId  = chosen.id;
  ctx.pattern  = usedPattern;
  run0.agentId = chosen.id;           // trace nosi KONAČNOG agenta, ne 'router'
  run0.pattern = usedPattern;
  onEvent?.({ type: 'routing', ...routing, pattern: usedPattern });
}
```

**Config po patternu dolazi iz agenta:** `patternConfigFor(spec, pattern, options)` spaja
`spec.patternConfig` (iz `config/agents/<id>.json`) sa `options.patternConfig` (iz REST poziva).
Redoslijed: **options pobjeđuje config agenta**. Time tenant može za jedan poziv pojačati npr. `maxWorkers`.

### Hijerarhija

```
                       ┌───────────────────────────────────────────┐
  POST /v1/router/run  │  router-agent.js → classify()             │
  ili widget/webhook   │  1. keyword hits  (0 LLM)                 │
        ──────────────►│  2. embedding cosine (0 LLM, hash-embedder)│
                       │  3. LLM classify (samo ako je < 0.45)     │
                       └───────────────────┬───────────────────────┘
                                           │ { agentId, confidence, method, candidates }
                                           ▼
                       ┌───────────────────────────────────────────┐
                       │  agents/catalog.js → config/agents/*.json │
                       │  defaultPattern, tools[], riskLevel,      │
                       │  routingHints[], patternConfig            │
                       └───────────────────┬───────────────────────┘
                                           │ agentId + spec
                                           ▼
                       ┌───────────────────────────────────────────┐
                       │  orchestration/index.js → run()           │
                       │  pattern = req.pattern                    │
                       │         ?? spec.defaultPattern            │
                       │         ?? 'router'                       │
                       └───────────────────┬───────────────────────┘
        ┌──────────┬──────────┬────────────┼──────────┬──────────┬──────────┐
        ▼          ▼          ▼            ▼          ▼          ▼          ▼
      agent   sequential  orch-worker    fanout    handoff   magentic   (router → agent)
        │          │          │            │          │          │
        └──────────┴──────────┴─── ctx ────┴──────────┴──────────┘
                                    │
                                    └── svaki pattern poziva `runAgent(spec, input, {...ctx, agentId, pattern})`
                                        → agent.js je JEDINA tačka koja priča sa LLM-om i alatima
```

**Tri odluke koje hijerarhija sprovodi:**

- **Router bira agenta, ne pattern.** `classify()` ne izvršava nijedan alat i ne piše u memoriju — vraća
  `{ agentId, confidence, reason, method, candidates[] }`. Zato je testabilan bez ijednog tool poziva.
- **Agent bira pattern po default-u iz config-a.** `config/agents/support.json` → `defaultPattern`,
  naprimjer `handoff`; `sales.json` → `sequential`; `legal.json` → `fanout`; `creative.json` →
  `orchestrator-worker`; `data.json` → `magentic`; `router.json` → `router`.
  Vrijednosti su **podatak** — nova kombinacija agent × pattern ne zahtijeva izmjenu koda (D14).
- **Ugniježđavanje: dozvoljeno je, tvrda granica dubine 2.** Pattern poziva agenta, agent može u svom
  `patternConfig`-u imati drugi pattern (npr. `sales` → `sequential` → korak `legal` koji interno radi `fanout`).
  Dubina 3+ se odbija kao `NESTED_DEPTH_EXCEEDED` (fatal, ne retryable). Razlog: dubina 3 čini trace
  nečitljivim, a budžet nepredvidivim (5 workera × 5 grana × 5 koraka = 125 LLM poziva iz jednog zahtjeva).
  **Stanje u kodu:** granica dubine je propisana ovim dokumentom i mora se provjeravati u `index.js`
  (`run()` prima `depth`, default 1, i odbija `depth > 2`); u v1.0 koda provjera još ne postoji — vidi §12.

---

## 2. Router

**Kada se koristi:** uvijek kao **prvi korak kod nepoznatog ulaza** — widget poruka, webhook (email, Shopify,
GitHub issue, Slack), glasovni transkript, interni "quick action". Ako pozivalac zna `agentId`
(`POST /v1/agents/support/run`), router se **preskače** i štedi se do 1 LLM poziv.

**Tok:**

```
ulaz (tekst)  ──►  keyword hits  ──►  embedding cosine  ──►  spoj (0.5/0.5)  ──►  odluka
                        │                    │                    │                  │
                  0 LLM poziva         0 LLM poziva      score ≥ 0.45 ?      DA → agent
                  (routingHints)       (hash-embedder)         │             NE → LLM classify
                                                              │                  │
                                                              └── method: 'heuristic'
                                                                                 └── method: 'llm'
                                                                                     ili 'fallback'
```

**Pseudo-kod (`src/agents/router-agent.js`) — vjerno stvarnom kodu:**

```js
export function createRouter({ catalog, llm, embedder, logger, metrics } = {}) {
  const agents = catalog.all();

  // SLOJ 1 — keyword, 0 LLM poziva, deterministički
  function keywordScores(input) {
    const text = ` ${String(input ?? '').toLowerCase()} `;
    const words = new Set(text.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
    return agents.map((a) => {
      let hits = 0, total = 0;
      for (const hint of a.routingHints ?? []) {
        total += 1;
        const h = hint.toLowerCase();
        if (h.includes(' ')) { if (text.includes(h)) hits += 1.5; }         // fraza vrijedi 1.5
        else if (words.has(h) || text.includes(` ${h}`) || text.includes(`${h} `)) hits += 1;
      }
      const score = total ? Math.min(1, hits / Math.max(2, Math.ceil(total * 0.35))) : 0;
      return { agentId: a.id, score, hits, hints: total };
    });
  }

  // SLOJ 2 — embedding: poredi ulaz sa "name + description + routingHints" svakog agenta
  async function embeddingScores(input) {
    if (!embedder) return [];
    const withDesc = agents.filter((a) => a.description);
    const [qvec, ...avec] = await embedder.embed([
      String(input ?? ''),
      ...withDesc.map((a) => `${a.name}. ${a.description} ${(a.routingHints ?? []).join(', ')}`),
    ]);
    return withDesc.map((a, i) => ({ agentId: a.id, score: Math.max(0, cosineSimilarity(qvec, avec[i])) }));
  }

  // SLOJ 3 — LLM, samo ako su prva dva sloja neodlučna; JSON izlaz, temperature 0
  async function llmClassify(input, { tenantId, model, signal } = {}) {
    const table = catalog.routingTable().map((a) => `- ${a.id} (${a.domain}): ${a.description}`).join('\n');
    const res = await llm.chat({
      model, temperature: 0, maxTokens: 200, responseFormat: { type: 'json_object' }, signal, tenantId,
      messages: [
        { role: 'system', content: `Ti si ruter. Izaberi TAČNO JEDNOG agenta i vrati JSON
          {"agentId":"...","confidence":0-1,"reason":"kratko"}. Ako nijedan ne odgovara, vrati "support".\n\nAgenti:\n${table}` },
        { role: 'user', content: String(input ?? '').slice(0, 2000) },
      ],
    });
    const parsed = safeJson(res.text);
    if (parsed?.agentId && catalog.has(parsed.agentId)) {
      return { agentId: parsed.agentId, confidence: clamp01(parsed.confidence ?? 0.7), method: 'llm', usage: res.usage };
    }
    return null;                                              // model je izmislio agenta → ignoriši
  }

  return {
    async classify(input, { tenantId, useLlm = true, minConfidence = 0.45, model, signal } = {}) {
      const kw = keywordScores(input);
      const em = await embeddingScores(input).catch(() => []);          // embedding NIKAD ne obara rutiranje

      const merged = new Map();
      for (const s of kw) merged.set(s.agentId, { agentId: s.agentId, keyword: s.score, embedding: 0, score: s.score * 0.7 });
      for (const s of em) {
        const cur = merged.get(s.agentId) ?? { agentId: s.agentId, keyword: 0, embedding: 0, score: 0 };
        cur.embedding = s.score;
        cur.score = cur.keyword * 0.5 + s.score * 0.5;                   // keyword i embedding po pola
        merged.set(s.agentId, cur);
      }
      const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
      const top = ranked[0] ?? null;

      if (top && top.score >= minConfidence) {
        metrics?.inc('router_decisions_total', { method: 'heuristic', agent: top.agentId });
        return { agentId: top.agentId, confidence: top.score, method: 'heuristic', candidates: ranked.slice(0, 4),
                 reason: `keyword/embedding skor ${top.score}` };
      }
      if (useLlm && llm) {
        try {
          const res = await llmClassify(input, { tenantId, model, signal });
          if (res) { metrics?.inc('router_decisions_total', { method: 'llm', agent: res.agentId }); return { ...res, candidates: ranked.slice(0, 4) }; }
        } catch (err) { logger?.warn?.('router.llm_failed', { error: err.message }); }   // LLM pad ≠ pad rutiranja
      }
      const fallback = top?.agentId ?? 'support';
      metrics?.inc('router_decisions_total', { method: 'fallback', agent: fallback });
      return { agentId: fallback, confidence: top?.score ?? 0, method: 'fallback', candidates: ranked.slice(0, 4),
               reason: 'nema jasnog poklapanja → fallback' };
    },
    scores: keywordScores,
  };
}
```

**Kako se radi klasifikacija BEZ LLM-a (mora raditi offline — D2/D10):**

- **Keyword sloj** je uvijek prvi. Ulaz se tokenizuje Unicode-svjesno (`\p{L}\p{N}`, pa rade i `č/ć/ž/š/đ`),
  riječi kraće od 3 znaka se odbacuju. Fraza ("dupla naplata") vrijedi 1.5, pojedinačna riječ 1.
  Score se normalizuje preko broja hint-ova agenta → agent sa 20 hint-ova ne pobjeđuje samim brojem riječi.
- **Embedding sloj** koristi `hash-embedder` (offline, deterministički, bez ključa, D10) i poređenje sa
  opisom agenta. Prag odluke je `minConfidence = 0.45` **nad spojenim skorom**, ne nad embeddingom posebno.
- **Nema `clarify` u v1.0.** Umjesto pitanja korisniku, kod radi fallback: najbolji kandidat ako postoji,
  inače `support`. Ako se uvede `clarify`, mora biti nova vrijednost `method: 'clarify'` i nova metrika —
  inače se tiho mijenja UX widgeta.
- **Pragovi su parametri, ne konstante:** `minConfidence` je argument `classify()` i dolazi iz config-a;
  mijenjanje praga ne zahtijeva izmjenu routera.

**Mjerenje tačnosti rutiranja (`/metrics` + zlatni set):**

| Metrika | Definicija | Cilj |
|---|---|---|
| `router_accuracy_top1` | udio tačnih prvih izbora na zlatnom setu (≥ 200 označenih ulaza) | ≥ 0.90 |
| `router_accuracy_top3` | tačan agent među 3 kandidata (koliko ih `candidates[]` nosi) | ≥ 0.97 |
| `router_llm_share` | udio odluka sa `method: 'llm'` | ≤ 0.35 |
| `router_fallback_share` | udio odluka sa `method: 'fallback'` | ≤ 0.05 |
| `router_override_rate` | korisnik je ručno promijenio agenta | ≤ 0.05 |
| `router_cost_per_1k` | trošak rutiranja na 1000 zahtjeva (samo LLM sloj se plaća) | ≤ $0.05 |

Metrika koja već postoji u kodu je `router_decisions_total{method, agent}`, pa se udjeli slojeva računaju iz nje.
Zlatni set živi u `tests/fixtures/router-golden.jsonl`; regresija se hvata testom `router-accuracy.test.mjs`
(tačnost < 0.88 → test pada). Svaka `override` odluka se dopisuje u zlatni set — router uči iz pogrešaka
bez fine-tuninga. **Zamka:** zlatni set se mora čuvati po jeziku/kanalu; miješanje email-upita i chat-upita
daje lažno nisku tačnost jer je stil drugačiji.

---

## 3. Sequential pipeline

**Kada se koristi:** linearni procesi gdje izlaz koraka `n` ide u korak `n+1`. Tipični NMQ slučajevi:
obrada dokumenta (parse → extract → validate → summarize → store), onboarding klijenta (potvrda podataka →
provjera registra → kreiranje naloga → dobrodošlica), mjesečno knjigovodstvo (uvoz naloga → kontiranje →
kontrola bilansa → izvještaj).

**Dijagram toka:**

```
input ──► [1] parse ──► [2] extract ──► [3] validate ──► [4] summarize ──► [5] store ──► output
             │             │                │                 │              │
             ▼             ▼                ▼                 ▼              ▼
      blackboard.parse  .fields       .validated        .summary      .storedRef
             │
             └── greška ──► failFast !== false  → prekid (throw), results[] nosi { ok:false, code }
                        └─ failFast === false  → upiši "Korak N nije uspio: ..." u `previous` i idi dalje
```

**Pseudo-kod (`src/orchestration/sequential.js`) — vjerno stvarnom kodu:**

```js
import { interpolate } from '../core/config-utils.js';

export function createSequentialPattern({ runAgent, catalog, tools, helpers, logger }) {
  async function run({ input, ctx, config = {} }) {
    const steps = config.steps ?? [];
    if (!steps.length) {                                   // nema koraka → ponašaj se kao `agent`
      const spec = catalog.get(ctx.agentId) ?? catalog.get('support');
      const res = await runAgent(spec, input, ctx);
      return { output: res.output, results: [res], usage: res.usage, costUsd: res.costUsd, approvals: res.approvals ?? [] };
    }

    const results = [], outputs = [], approvals = [], handoffs = [];
    let previous = typeof input === 'string' ? input : JSON.stringify(input);
    const usage = { tokensIn: 0, tokensOut: 0 };
    let costUsd = 0;

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      // varijable za interpolaciju: {{input}}, {{previous}}, {{step}}, {{total}}
      const vars = { input: String(input), previous, step: i + 1, total: steps.length };

      if (step.tool) {                                     // TOOL korak — nema LLM-a, nema troška modela
        const args = JSON.parse(interpolate(JSON.stringify(step.args ?? {}), vars));
        ctx.onEvent?.({ type: 'step_start', kind: 'tool', name: step.tool, index: i + 1 });
        const res = await tools.execute(step.tool, args, { ...ctx, agentId: step.agent ?? ctx.agentId });
        previous = typeof res.result === 'string' ? res.result : JSON.stringify(res.result);
        results.push({ kind: 'tool', name: step.tool, ok: true, output: previous, durationMs: res.durationMs });
        outputs.push(previous);
        if (step.outputKey) ctx.blackboard[step.outputKey] = previous;
        ctx.onEvent?.({ type: 'step_end', kind: 'tool', name: step.tool, index: i + 1, ok: true });
        continue;
      }

      const spec = catalog.get(step.agent ?? ctx.agentId);  // AGENT korak
      if (!spec) throw new Error(`sequential: nepoznat agent "${step.agent}"`);
      const stepInput = interpolate(step.input ?? '{{previous}}', vars);
      try {
        const res = await runAgent(spec, stepInput, { ...ctx, agentId: spec.id, pattern: 'sequential' });
        previous = res.output;
        outputs.push(previous);
        results.push({ kind: 'agent', agentId: spec.id, ok: true, output: res.output, usage: res.usage, costUsd: res.costUsd });
        usage.tokensIn += res.usage?.tokensIn ?? 0;
        usage.tokensOut += res.usage?.tokensOut ?? 0;
        costUsd += res.costUsd ?? 0;
        approvals.push(...(res.approvals ?? []));
        handoffs.push(...(res.handoffs ?? []));
        if (step.outputKey) ctx.blackboard[step.outputKey] = previous;
      } catch (err) {
        results.push({ kind: 'agent', agentId: spec.id, ok: false, error: err.message, code: err.code });
        if (config.failFast !== false) throw err;           // FAIL-FAST je default
        previous = `Korak ${i + 1} nije uspio: ${err.message}`;   // CONTINUE-ON-ERROR
        outputs.push(previous);
      }
    }
    return { output: outputs.at(-1) ?? '', results, usage, costUsd: Number(costUsd.toFixed(6)), approvals, handoffs, stepsCount: steps.length };
  }
  return { name: 'sequential', run };
}
```

**Prekid na grešci — dvije politike, eksplicitno u config-u (`failFast`):**

| Politika | Config | Efekat | Primjer |
|---|---|---|---|
| fail-fast (**default**, `failFast !== false`) | `{ failFast: true }` ili izostavljeno | Greška se propagira; `results[]` nosi korake **do** pada; izlaz se ne vraća kao uspjeh | `validate` pao → ne upisuj u bazu, ne šalji klijentu |
| continue-on-error | `{ failFast: false }` | U `previous` se upiše tekst greške, pipeline nastavlja sa sljedećim korakom | SEO prijedlog nije stigao → pošalji izvještaj bez njega, uz napomenu |

**Važno:** greška se **ne** vraća korisniku kao "uspješno"; tekst `Korak N nije uspio: ...` ulazi u sljedeći
korak, pa finalni izlaz **mora** sadržati tu rečenicu. Ako je korak `store`, `failFast` mora ostati `true` —
inače podaci "uspješno" obrađeni, a nisu upisani (validacija config-a u `catalog.js` to treba odbiti).

**Prenos stanja (`ctx.blackboard`):** koraci **ne** primaju prethodni rezultat kroz lance argumenata
(inače nastaje "snowball" objekat koji niko ne razumije). Pravila:

- `previous` = izlaz prethodnog koraka, kao **string** (uzak, tipiziran kontrakt koraka).
- `{{input}}`, `{{previous}}`, `{{step}}`, `{{total}}` su jedine dozvoljene varijable u `step.input`/`step.args`
  (`interpolate()` iz `src/core/config-utils.js`). Nikakav JS se ne evaluira — nema `eval` u config-u.
- `ctx.blackboard[step.outputKey]` je **opcionalno** i služi samo za slučajeve gdje kasniji korak nije
  susjedni (npr. `store` čita `blackboard.extract`). Nikad se ne čita "redom".
- Redoslijed upisa je deterministički → snapshot `results[]` je stabilan u testovima.

**Primjer toka: 4 koraka i 3 alata (ulazni račun dobavljača, tenant `knjigovodja`)**

```
input:  PDF račun (blob://tenants/knjigovodja/2026-09/racun-118.pdf)
[1] tool  doc.parse              → { text, pages: 1 }                            (riskLevel: low)
[2] agent finance                → { pib, broj, datum, iznos: 120000, pdv: 0 }   (JSON schema u promptu)
[3] tool  registry.lookupPib     → { naziv, adresa, uSistemuPdv: true }          (riskLevel: low)
[4] agent data                   → pravilo (ne LLM): pdv === 0 && iznos > 100000 → PDV_MISMATCH
[5] tool  ledger.proposeKnjizenje→ konto 4700, duguje 120000                        (riskLevel: medium)
output:  { status: 'blocked', reason: 'PDV_MISMATCH', forHuman: 'proknjižiti ručno', stepsCount: 5 }
config:  { failFast: true, steps: [
           { tool: 'doc.parse', args: { path: '{{input}}' }, outputKey: 'parsed' },
           { agent: 'finance', input: 'Izvuci polja iz računa: {{previous}}' },
           { tool: 'registry.lookupPib', args: { pib: '{{previous}}' } },
           { agent: 'data', input: 'Provjeri PDV logiku: {{previous}}' },
           { tool: 'ledger.proposeKnjizenje', args: { nalaz: '{{previous}}' } } ] }
```

**Šta može da pođe naopako:**

- **Predugačak `previous`** — korak 2 vrati 200 KB JSON-a, pa korak 4 pukne na kontekstu.
  Zaštita: `helpers.condense(value, 2500)` prije nego rezultat uđe u sljedeći korak (`helpers.js` to već nudi).
- **`failFast: false` na `store` koraku** — tiho preskočen upis. Zaštita: validacija config-a u `catalog.js`
  odbija `failFast: false` ako je zadnji korak `store`-tipa (alat sa `riskLevel: medium|high`).
- **Nedeterminizam u promptu** (vrijeme, "danas") — isti ulaz daje drugi izlaz → snapshot test pada bez regresije.
  Zaštita: vrijeme ide u prompt samo kroz injektovani `clock`.
- **Dvostruko izvršenje pri retry-u** — timeout pa ponovni `email_send`. Zaštita: `ctx.runId + ':' + stepIndex`
  kao idempotency key; alati sa `riskLevel: high` ga moraju poštovati.
- **Interpolacija u `step.args`** — `JSON.parse(interpolate(...))` puca ako `previous` sadrži navodnike.
  Zaštita: escapovanje u `interpolate()`; test sa `previous` koji sadrži `"` i `\`.

---

## 4. Orchestrator-worker

**Kada se koristi:** kompleksan zadatak koji **nije linearan** i razbija se na podzadatke koji se mogu raditi
nezavisno (ili u dva talasa). Tipično: priprema ponude, strategija nastupa, migracija podataka,
kampanja (sadržaj + budžet + publika + pravni).

**Tok:**

```
                    ┌──────────────────────────────────────────────┐
   input ───► PLAN  │ makePlan(): LLM planer (1 poziv) ILI config  │
                    │ { goal, subtasks: [{ agent, goal }], source }│
                    └───────────────┬──────────────────────────────┘
                                    │  max 5 workera; agent MORA postojati u catalog-u
                 ┌──────────┬───────┼────────┬──────────┐
                 ▼          ▼       ▼        ▼          ▼
              worker1    worker2  worker3  worker4   worker5
              (agent A)  (agent B) (agent A) (agent C) (agent A)
                 │          │       │        │          │     parallel:false → SERIJSKI (default)
                 └──────────┴───────┴────────┴──────────┘     parallel:true  → Promise.all
                                    │ SAKUPLJANJE: [{ index, agent, ok, output, usage, costUsd }]
                                    ▼
                    ┌──────────────────────────────────────────────┐
                    │ SINTEZA (1 LLM poziv) — spaja uspjele workere│
                    │ 1 worker i synthesize !== true → bez sinteze │
                    └───────────────┬──────────────────────────────┘
                                    ▼
                        output + workers[] + plan + costUsd
```

**Ograničenja (tvrda, u kodu — ne u promptu):**

| Ograničenje | Vrijednost | Gdje se provjerava |
|---|---|---|
| `maxWorkers` | **5** (default) | `makePlan()` — i u promptu i u `.slice(0, maxWorkers)` nad odgovorom modela |
| `parallel` | `false` (default → serijski) | `run()` — `config.parallel ? Promise.all : for-petlja` |
| `synthesize` | `true` ako je > 1 uspješan worker | `run()` — 1 worker bez `synthesize` vraća svoj izlaz direktno (štedi 1 poziv) |
| `synthesisMaxTokens` | 900 | `helpers.callLlm()` |
| `workers` | ako je zadat u config-u, **planer se preskače** | `makePlan()` — deterministički plan za testove i ponovljive procese |
| validacija agenta | `catalog.has(s.agent)` | `.filter()` — izmišljen agent se odbacuje, ne izvršava |

**Pseudo-kod (`src/orchestration/orchestrator-worker.js`) — vjerno stvarnom kodu:**

```js
import { condenseList } from './fanout.js';        // ⚠ vidi §12: kod još importuje './parallel.js' (ne postoji)

export function createOrchestratorWorkerPattern({ runAgent, catalog, helpers, logger }) {
  async function makePlan(input, ctx, cfg) {
    if (Array.isArray(cfg.workers) && cfg.workers.length) {
      return { goal: String(input), subtasks: cfg.workers, source: 'config' };   // bez LLM-a
    }
    const maxWorkers = cfg.maxWorkers ?? 5;
    const table = catalog.routingTable().map((a) => `- ${a.id} (${a.domain}): ${a.description}`).join('\n');
    try {
      const res = await helpers.callLlm(ctx, {
        role: 'planner', temperature: 0, maxTokens: 700, responseFormat: { type: 'json_object' },
        messages: [
          { role: 'system', content: [
              `Ti si planer. Razbij zadatak na najviše ${maxWorkers} podzadataka.`,
              'Vrati JSON: {"goal":"...","subtasks":[{"agent":"<id sa spiska>","goal":"konkretan zadatak"}]}',
              'Pravila: koristi SAMO agente sa spiska; svaki podzadatak mora biti samostalan i provjerljiv.',
              '', 'Agenti:', table ].join('\n') },
          { role: 'user', content: String(input).slice(0, 4000) },
        ],
      });
      const parsed = helpers.parseJson(res.text, null);
      const subtasks = (parsed?.subtasks ?? [])
        .filter((s) => s?.goal && catalog.has(s.agent))        // izmišljen agent se ODBACUJE
        .slice(0, maxWorkers)                                  // TVRDI trim
        .map((s) => ({ agent: s.agent, goal: s.goal }));
      if (subtasks.length) return { goal: parsed?.goal ?? String(input), subtasks, source: 'llm' };
    } catch (err) { logger?.warn?.('orchestrator.plan_failed', { error: err.message }); }
    return { goal: String(input), subtasks: [{ agent: ctx.agentId ?? 'support', goal: String(input) }], source: 'fallback' };
  }

  async function run({ input, ctx, config = {} }) {
    const plan = await makePlan(input, ctx, config);
    ctx.onEvent?.({ type: 'plan', goal: plan.goal, subtasks: plan.subtasks, source: plan.source });
    const approvals = [], handoffs = [];                          // skupljaju se iz svih workera

    const delegate = async (sub, index) => {
      const spec = catalog.get(sub.agent);
      if (!spec) return { index, agent: sub.agent, ok: false, error: `nepoznat agent ${sub.agent}` };
      try {
        const res = await runAgent(spec, sub.goal, { ...ctx, agentId: spec.id, pattern: 'orchestrator-worker' });
        approvals.push(...(res.approvals ?? []));                 // odobrenja se skupljaju za cijeli run
        handoffs.push(...(res.handoffs ?? []));
        return { index, agent: spec.id, goal: sub.goal, ok: true, output: res.output, usage: res.usage, costUsd: res.costUsd };
      } catch (err) {
        return { index, agent: spec.id, goal: sub.goal, ok: false, error: err.message, code: err.code };
      }
    };

    // Worker pad NIKAD ne obara cijeli run: greška se vraća kao { ok:false } i ide u sintezu kao "nije uspjelo"
    const results = config.parallel
      ? await Promise.all(plan.subtasks.map((s, i) => delegate(s, i)))
      : await (async () => { const out = []; for (let i = 0; i < plan.subtasks.length; i += 1) out.push(await delegate(plan.subtasks[i], i)); return out; })();

    const workers = results.filter((r) => r.ok);
    const usage = { tokensIn: 0, tokensOut: 0 };
    let costUsd = 0;
    for (const w of workers) { usage.tokensIn += w.usage?.tokensIn ?? 0; usage.tokensOut += w.usage?.tokensOut ?? 0; costUsd += w.costUsd ?? 0; }

    let output = '';
    if (workers.length === 1 && config.synthesize !== true) output = workers[0].output;
    else if (workers.length) {
      try {
        const synth = await helpers.callLlm(ctx, {
          role: 'synthesizer', temperature: 0.2, maxTokens: config.synthesisMaxTokens ?? 900,
          messages: [
            { role: 'system', content: 'Ti si orchestrator. Spoji rezultate podzadataka u JEDAN jasan odgovor. Ako neki podzadatak nije uspio, navedi to kratko i predloži sljedeći korak.' },
            { role: 'user', content: `ZADATAK: ${plan.goal}\n\nREZULTATI:\n${condenseList(workers.map((w) => `### ${w.agent} — ${w.goal}\n${w.output}`), 6000)}` },
          ],
        });
        output = synth.text || condenseList(workers.map((w) => w.output), 4000);
        usage.tokensIn += synth.usage.tokensIn; usage.tokensOut += synth.usage.tokensOut; costUsd += synth.costUsd;
      } catch (err) {                                          // sinteza pala → ipak vrati nešto korisno
        logger?.warn?.('orchestrator.synthesis_failed', { error: err.message });
        output = condenseList(workers.map((w) => `### ${w.agent}\n${w.output}`), 4000);
      }
    } else output = 'Nijedan podzadatak nije uspio. Provjeri dozvole alata i budžet.';

    return { output, plan, workers: results, workersOk: workers.length, usage, costUsd: Number(costUsd.toFixed(6)), approvals, handoffs };
  }
  return { name: 'orchestrator-worker', run, makePlan };
}
```

**Primjer: "pripremi ponudu za klijenta" (tenant `agencija`, agent `sales`)**

```
config: { maxWorkers: 5, parallel: true, patternConfig iz sales.json }

plan (source: 'llm'):
  t0 research  → researcher: istraži klijenta, djelatnost, javne podatke, konkurenciju
  t1 pricing   → finance:    izračunaj cijenu iz cjenovnika + marža
  t2 legal     → legal:      provjeri rokove, garancije, GDPR klauzule
  t3 refs      → sales:      izvuci 2 referentna projekta iz CRM-a (slična djelatnost)
  t4 writer    → creative:   napiši ponudu (uvod, rješenje, cijena, rokovi, uslovi)

parallel: true → svih 5 idu istovremeno (nema talasa/dependsOn u v1.0 — vidi §12)
t2 padne (legal alat nije dozvoljen politikom) → workers[2].ok = false, run NASTAVLJA
synthesis: spoji 4 rezultata, eksplicitno navede "pravna provjera nije završena"
output: ponuda.md + lista otvorenih stavki; workersOk: 4, costUsd ≈ cijena 5 agenata + sinteza
```

**Šta može da pođe naopako:**

- **Planer izmisli agente/alate** koji ne postoje → `catalog.has()` i `filter()` ih odbacuju;
  ako sve otpadne, plan je `fallback` (jedan agent radi cijeli zadatak) i to je vidljivo u `plan.source`.
- **Eksplozija broja workera** (model vrati 23 podzadatka) → trim na `maxWorkers` (5). Bez toga jedan zahtjev
  pojede mjesečni budžet tenanta.
- **`parallel: true` bez semafora** → 5 istovremenih poziva na isti ključ → 429 na tri workera.
  U v1.0 `Promise.all` nema limit konkurentnosti; koristi `runWithConcurrency()` iz `fanout.js`.
- **Sinteza prelazi kontekst** — 5 workera × 30 KB = 150 KB → `condenseList(..., 6000)` je obavezan (postoji).
- **Serijski default je spor ali siguran** — 5 agenata serijski = 5× latencija; za latenciju postoji `fanout`.
- **`workers` u config-u preskače planer** — ako je taj config pogrešan, nema LLM-a koji bi to ispravio;
  zato `workers` u config-u ide samo za **ponovljive** procese (i to je prednost: determinizam u testovima).

---

## 5. Fan-out / fan-in

**Kada se koristi:** isti ulaz, **više nezavisnih uglova**, nijedan ne zavisi od drugog. Klasično:
tehnička + poslovna + kreativna analiza; analiza ugovora; višemodelno glasanje; verifikacija odgovora.

**Dijagram toka:**

```
                              ┌─ worker 0 legal (angle: "rizici")    ─┐
 input ──► fan-out ──┬────────┼─ worker 1 finance (angle: "cijena")  ─┼────► fan-in  ──► merge
                     │        └─ worker 2 commercial (angle: "tržište")─┘        │
                     │  runWithConcurrency(tasks, concurrency ≤ 8)               │
                     └─ svaki worker dobija ISTI ulaz + "\n\nUgao analize: <angle>"
                                                                                 ▼
                       merge: 'synthesis' (LLM) | 'concat' (tekst) | 'vote' (glasanje)
                       pad grane → { ok:false } u `failed[]`, ostale ulaze u merge
```

**Paralelno u Node-u bez ijedne zavisnosti (D2) — `runWithConcurrency()`:**

```js
// src/orchestration/fanout.js — N fiksnih "radnika" koji vuku zadatke iz zajedničkog kursora.
// Prednost nad semaforom: nema Promise lanaca po zadatku, a redoslijed rezultata je očuvan (results[index]).
export async function runWithConcurrency(tasks, limit = 4) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (cursor < tasks.length) {
      const index = cursor; cursor += 1;
      try { results[index] = await tasks[index](); }
      catch (err) { results[index] = { ok: false, error: err?.message ?? String(err) }; }   // pad grane NE baca dalje
    }
  });
  await Promise.all(workers);
  return results;
}
```

**Pseudo-kod (`src/orchestration/fanout.js`) — vjerno stvarnom kodu:**

```js
export function createFanoutPattern({ runAgent, catalog, helpers, logger }) {
  async function run({ input, ctx, config = {} }) {
    const workers = Array.isArray(config.workers) && config.workers.length
      ? config.workers                                   // [{ agent, angle }]
      : [{ agent: ctx.agentId, angle: 'general' }];      // default: sam agent, jedan "ugao"
    const concurrency = Math.max(1, Math.min(config.concurrency ?? 4, 8));   // TVRDI limit 8
    const merge = config.merge ?? (workers.length > 1 ? 'synthesis' : 'concat');

    ctx.onEvent?.({ type: 'fanout_start', count: workers.length, concurrency, merge });

    const tasks = workers.map((w, index) => async () => {
      const spec = catalog.get(w.agent);
      if (!spec) return { index, agent: w.agent, ok: false, error: `nepoznat agent ${w.agent}` };
      const angle = w.angle ? `\n\nUgao analize: ${w.angle}` : '';
      try {
        const res = await runAgent(spec, `${String(input)}${angle}`, { ...ctx, agentId: spec.id, pattern: 'fanout' });
        return { index, agent: spec.id, angle: w.angle ?? null, ok: true, output: res.output, usage: res.usage, costUsd: res.costUsd };
      } catch (err) {
        logger?.warn?.('fanout.worker_failed', { agent: spec.id, error: err.message });
        return { index, agent: spec.id, ok: false, error: err.message, code: err.code };   // NIKAD se ne baca dalje
      }
    });

    const settled = await runWithConcurrency(tasks, concurrency);   // ekvivalent allSettled + semafor
    const ok = settled.filter((r) => r?.ok);
    const failed = settled.filter((r) => r && !r.ok);

    let output = '';
    if (!ok.length) output = 'Svi paralelni agenti su pali. Provjeri dozvole alata, budžet i dostupnost modela.';
    else if (merge === 'vote') {
      const counts = new Map();
      for (const r of ok) { const key = String(r.output).trim().toLowerCase().slice(0, 200); counts.set(key, (counts.get(key) ?? 0) + 1); }
      const [[winner, votes]] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      output = `${ok.find((r) => norm(r.output) === winner)?.output ?? ''}\n\n_(glasova: ${votes}/${ok.length})_`;
    } else if (merge === 'concat') {
      output = condenseList(ok.map((r) => `### ${r.agent}${r.angle ? ` (${r.angle})` : ''}\n${r.output}`), 6000);
    } else {
      try {
        const synth = await helpers.callLlm(ctx, {
          role: 'fanin-synthesis', temperature: 0.2, maxTokens: config.synthesisMaxTokens ?? 900,
          messages: [
            { role: 'system', content: 'Spoji paralelne analize: gdje se slažu, gdje se razilaze, zaključak i 2-3 preporuke. Navedi koji agent tvrdi šta.' },
            { role: 'user', content: `PITANJE: ${String(input)}\n\nANALIZE:\n${condenseList(ok.map((r) => `### ${r.agent}${r.angle ? ` (${r.angle})` : ''}\n${r.output}`), 7000)}` },
          ],
        });
        output = synth.text || condenseList(ok.map((r) => r.output), 4000);
      } catch (err) {                                   // sinteza pala → degradiraj na concat, ne padaj
        logger?.warn?.('fanout.synthesis_failed', { error: err.message });
        output = condenseList(ok.map((r) => `### ${r.agent}\n${r.output}`), 4000);
      }
    }
    return { output, workers: settled, failed: failed.map((f) => ({ agent: f.agent, error: f.error })), merge, usage, costUsd, approvals, handoffs };
  }
  return { name: 'fanout', run };
}
```

**Spajanje rezultata — tri strategije (`config.merge`):**

| Strategija | Kako | Kad | Zamka |
|---|---|---|---|
| `concat` | tekstualno spajanje sa `### agent (angle)` zaglavljima, `condenseList(..., 6000)` | kad je korisniku bitno da vidi **svaki** ugao (interni izvještaj) | izlaz raste linearno sa brojem grana; nema zaključka |
| `vote` | normalizovan izlaz (trim + lower + prvih 200 znakova) = 1 glas; prikazuje `_(glasova: k/n)_` | klasifikacija, da/ne odluke, verifikacija | svi pogriješe isto (korelirana greška) → dodaj granu sa drugim modelom |
| `synthesis` (**default** kad je > 1 grana) | 1 LLM poziv spaja nalaze, traži slaganje i razilaženje | narativni izlaz (analiza, izvještaj) | halucinacija preko grana → prompt zabranjuje tvrdnje kojih nema u ulazima |

**Šta ako jedan worker padne:**

1. Pad grane se **hvata unutar zadatka** i pretvara u `{ ok: false, error, code }` — `runWithConcurrency`
   nikad ne prekida ostale grane (ekvivalent `Promise.allSettled`, samo bez alokacije Promise nizova).
2. `failed[]` nosi `{ agent, error }` i to je u rezultatu — pad je **vidljiv**, ne tih.
3. Ako padnu **sve** grane, izlaz je eksplicitna rečenica "Svi paralelni agenti su pali..." (**ne** prazan string,
   ne "prosjek" izmišljenih podataka).
4. Ako padne grana a `merge: 'synthesis'`, sinteza dobija samo uspjele grane i **mora** navesti šta nedostaje
   (to je u system promptu sinteze).
5. Kod `merge: 'vote'`, glasovi se računaju **samo iz uspjelih** grana, a imenilac je `ok.length` — korisnik
   vidi da je glasalo 2/3, ne 3/3.

**Primjer: analiza ugovora iz 3 ugla (tenant `agencija`)**

```
input: ugovor.pdf (24 str) → prethodni korak ga je već parsirao (dijeljeni parse = 1× trošak)
config: { concurrency: 3, merge: 'synthesis', workers: [
  { agent: 'legal',    angle: 'rizične klauzule: automatsko produženje, nadležnost, odgovornost, kazne' },
  { agent: 'finance',  angle: 'rok plaćanja 60 dana, PDV, ukupna vrijednost, indeksacija, penali' },
  { agent: 'sales',    angle: 'tržišna pravičnost cijene, isključivost, pravo na raskid' } ] }

sve 3 grane paralelno (concurrency 3) → legal padne (alat nije dozvoljen politikom)
failed: [{ agent: 'legal', error: 'POLICY_DENIED' }], merge: 'synthesis' sa 2 grane
output:  { rizici: 4 (2 visoka), preporuke: 3, napomena: 'PRAVNA ANALIZA NIJE ZAVRŠENA' }
klijent dobija izvještaj sa EKSPLICITNOM napomenom da pravni ugao fali — ne potpisuje se naslijepo
```

**Šta može da pođe naopako:**

- **Rate limit** — 5-8 paralelnih poziva na isti ključ → 429. Zaštita: `concurrency` ≤ 4 za jedan ključ
  (limit je tvrdo 8, ali to je gornja granica, ne preporuka) + retry sa backoff-om u LLM adapteru.
- **Dugački ulazi × N** — 24 str × 5 grana = 5× tokeni za isti tekst. Zaštita: `parse` **jednom**, pa grane
  dobijaju već parsiran tekst (fanout ne parsira sam).
- **Trošak bez svijesti** — fan-out plaća i ono što ne iskoristi. Zaštita: procjena troška prije fan-out-a
  (`cost.estimate()` × broj grana) i odbijanje ako prelazi `budget.remainingUsd()`.
- **`vote` sa istim modelom** — korelirana greška daje samouvjereno pogrešan odgovor. Zaštita: bar jedna grana
  ide na drugi model ili drugi prompt.
- **Sinteza "popravi" pad grane** — model izmisli pravni nalaz koji nije postojao. Zaštita: system prompt
  sinteze zabranjuje tvrdnje kojih nema u ulazima + `failed[]` ide u izlaz.

---

## 6. Peer-to-peer handoff

**Kada se koristi:** zadatak prirodno prelazi između **specijalizovanih agenata** i nijedan nije "šef".
Klasično: `support → billing → technical`, `sales → legal → finance`, `ecommerce → ops → support`.
Handoff je jedini pattern gdje **kontrola mijenja vlasnika** — zato ima najstroža pravila.

**Kako se predaje kontrola:** agent tokom svog rada vrati `handoff` u rezultatu
(`{ toAgent, reason, summary }`, vidi `src/agents/agent.js` — `handoffs.push({ fromAgent, toAgent, reason, summary })`).
Pattern čita **prvi** handoff iz rezultata i predaje kontrolu. Nema implicitnog prelaza i nema pozivanja
drugog agenta direktno — sve ide kroz rezultat agenta, pa je svaki prelaz vidljiv u `transcript`-u i trace-u.

```js
// ugovor koji agent ispunjava (agent.js) — handoff je PODATAK u rezultatu, ne side-effect
res.handoffs = [{ fromAgent: 'support', toAgent: 'billing', reason: 'dupla naplata za isti period', summary: '...' }];
```

**Zaštita od "ping-pong" petlje (tvrda pravila u `handoff.js`):**

| Pravilo | Vrijednost | Efekat kršenja |
|---|---|---|
| Maksimalan broj predaja | **3** (config), tvrdo ≤ 6 | `status: 'max_handoffs'`, u izlaz ide "(Prekinuto: dostignut maksimum od N predaja.)" |
| Agent koji je **već bio u lancu** se ne posjećuje ponovo | `visited[]` | `status: 'handoff_loop'`, "(Prekinuto: agent X je već bio uključen — spriječena petlja.)" |
| Nepoznat agent | `catalog.get(toAgent)` | `status: 'handoff_unknown'`, "(Agent X ne postoji.)" |
| Obavezan kontekst za sljedećeg | `reason` + `summary` + zadnjih 1500 znakova prethodnog odgovora | sljedeći agent dobija "Originalni zadatak / Predao ti je agent X / Razlog / Sažetak / Prethodni odgovor" |
| `includeTranscript: false` | prethodni odgovor se izostavlja | štedi kontekst kad je sažetak dovoljan |
| Instrukcija protiv lanca | "Ne predaji dalje osim ako je zaista neophodno." | u promptu svakog sljedećeg agenta |

**Dijagram i pseudo-kod (`src/orchestration/handoff.js`) — vjerno stvarnom kodu:**

```
input ──► [support]  ──handoff(to: billing, reason: "dupla naplata")──►  [billing]
              │  ▲                                                          │
              │  └── ZABRANJENO: billing → support (support ∈ visited[])    │ handoff(to: technical)
   visited=[support]                                                  visited=[s, billing]
                                                                              ▼
                                                                      [technical] visited=[s,b,t]
                                                                              │ handoff #4
                                                                              ▼
                                                              status: 'max_handoffs' + "(Prekinuto…)"
```

```js
export function createHandoffPattern({ runAgent, catalog, helpers, logger }) {
  async function run({ input, ctx, config = {} }) {
    const maxHandoffs = Math.max(1, Math.min(config.maxHandoffs ?? 3, 6));   // TVRDA granica 6
    const visited = [], transcript = [], approvals = [], handoffChain = [];
    const usage = { tokensIn: 0, tokensOut: 0 };
    let costUsd = 0;

    let current = catalog.get(config.entry ?? ctx.agentId) ?? catalog.get('support');
    let payload = String(input);
    let output = '', status = 'ok';

    for (let i = 0; i <= maxHandoffs; i += 1) {
      visited.push(current.id);
      const res = await runAgent(current, payload, { ...ctx, agentId: current.id, pattern: 'handoff' });
      usage.tokensIn += res.usage?.tokensIn ?? 0; usage.tokensOut += res.usage?.tokensOut ?? 0;
      costUsd += res.costUsd ?? 0; approvals.push(...(res.approvals ?? []));
      output = res.output;
      transcript.push({ agent: current.id, output: res.output, status: res.status, costUsd: res.costUsd });

      const handoff = (res.handoffs ?? [])[0];                  // samo PRVI handoff se poštuje
      if (!handoff) return { output, transcript, handoffChain, resolvedBy: current.id, handoffs: handoffChain.length, visited, usage, costUsd, approvals };

      if (i === maxHandoffs)          { status = 'max_handoffs';    output += `\n\n_(Prekinuto: dostignut maksimum od ${maxHandoffs} predaja.)_`; break; }
      if (visited.includes(handoff.toAgent)) { status = 'handoff_loop';   output += `\n\n_(Prekinuto: agent ${handoff.toAgent} je već bio uključen — spriječena petlja.)_`; break; }
      const next = catalog.get(handoff.toAgent);
      if (!next)                      { status = 'handoff_unknown'; output += `\n\n_(Agent ${handoff.toAgent} ne postoji.)_`; break; }

      handoffChain.push({ from: current.id, to: next.id, reason: handoff.reason, summary: handoff.summary });
      ctx.onEvent?.({ type: 'handoff', from: current.id, to: next.id, reason: handoff.reason });
      payload = [
        `Originalni zadatak: ${String(input)}`, '',
        `Predao ti je agent ${current.id}. Razlog: ${handoff.reason}`,
        handoff.summary ? `Sažetak konteksta: ${handoff.summary}` : '',
        config.includeTranscript === false ? '' : `\nPrethodni odgovor agenta ${current.id}:\n${String(res.output).slice(0, 1500)}`,
        `\nTi si sada nadležan (${next.id}). Ne predaji dalje osim ako je zaista neophodno.`,
      ].filter(Boolean).join('\n');
      current = next;
    }
    return { output, transcript, handoffChain, resolvedBy: null, status, handoffs: handoffChain.length, visited, usage, costUsd, approvals };
  }
  return { name: 'handoff', run };
}
```

**Napomena o odobrenju u lancu:** ako agent u lancu pozove alat sa `high` rizikom, `assertAllowed()` iz
`src/core/policy.js` baca `ApprovalRequiredError` (`APPROVAL_REQUIRED`, HTTP 409). Handoff tu grešku **ne guta** —
run se pauzira, `approvals[]` dobija zapis, a klijent odgovara preko `POST /v1/approvals/:runId`.
Zato `approvals` putuje kroz cijeli lanac (`approvals.push(...res.approvals)` u svakom koraku).

**Primjer toka sa 3 agenta (tenant `ecommerce`, kanal: chat widget)**

```
1) support   ulaz: "Ne mogu da uđem u nalog, a vidim da mi je račun duplo naplaćen."
             → reset lozinke (tool: auth.resetLink, low) → handoff(to: 'billing',
               reason: 'Korisnik prijavljuje duplu naplatu za isti period (2 transakcije).')
2) billing   → payments.list (medium): 2 naplate, ista narudžba, razlika 4 min
             → payments.refund → APPROVAL_REQUIRED (high) → approvals[] = [refund]
             → handoff(to: 'technical', reason: 'Dvostruka naplata je posljedica duplog POST-a na checkout.')
3) technical → reprodukuje bug (nema idempotency key), otvara issue, predlaže fix → NE predaje dalje
rezultat: handoffs: 2, visited: ['support','billing','technical'], resolvedBy: 'technical',
          approvals: [refund], transcript: 3 unosa, costUsd ≈ 3 agenta
```

**Šta može da pođe naopako:**

- **Ping-pong** A→B→A→B… → `visited.includes()` to odbija i upisuje `status: 'handoff_loop'`;
  svaki pokušaj se loguje (`handoff.loop_prevented`). Metrika: `handoff_loop_total`.
- **Gubitak konteksta** — lanac od 3 agenta, korisnik ponavlja istu stvar 3×. Zaštita: `reason` + `summary` +
  1500 znakova prethodnog odgovora se automatski ubacuju u prompt sljedećeg agenta.
- **Handoff kao izgovor** — agent preda dalje bez ijednog tool poziva. Zaštita: metrika
  `handoff_excuse_total` (broj predaja bez prethodnog tool poziva); ako > 30% → revizija prompta agenta.
- **Cirkularni trošak** — 3 agenta × pun prompt = 3× tokeni. Zaštita: `includeTranscript: false` +
  `summary` obavezan + keširanje statičkih dijelova prompta (§11).
- **Nema vlasnika** — poslije 3 predaje nitko nije odgovoran. Zaštita: `resolvedBy: null` + `status` +
  poruka u izlazu; `run()` to prikazuje kao `needsHuman` u API odgovoru.
- **Više handoff-a u jednom rezultatu** — poštuje se samo prvi (`(res.handoffs ?? [])[0]`); ostali se tiho
  ignorišu. Ako agent vrati dva, to je greška prompta i mora se logovati.

---

## 7. Magentic / open-ended

**Kada se koristi:** cilj je jasan, ali **plan nije** — istraživanje, dijagnostika, "zašto" pitanja, strategija.
Nikad za operativne zadatke sa poznatim koracima (tamo je `sequential` višestruko jeftiniji).

**Petlja:**

```
input ──► PLAN ──► ACT ──► REFLECT ──► (korekcija) ──┬──► (nova iteracija: plan dobija listu problema)
          LLM      agent    critic.review()           │
         (400 tok)  (alati)  heuristike + opc. LLM     └──► IZLAZ + finalReview
         ▲                                                        │
         └──── zaustavljanje: maxIterations (3, tvrdo ≤ 6) ───────┘
               | verdict 'accept' | score stagnira 2× (maxStagnant)
               | budžet (assertCanContinue) | abort iz UI-a
```

**`critic` agent i njegov kriterij (`src/agents/critic.js`):**

Critic **ne piše odgovor**. Prvo radi **determinističke heuristike** (brzo, besplatno), pa opcionu LLM ocjenu.
Vraća `{ verdict: 'accept'|'revise', score: 0..1, issues[], suggestion, method: 'heuristic'|'llm' }`.

| Provjera (heuristika) | Kod | Težina | Značenje |
|---|---|---|---|
| Prazan odgovor | `empty` | **high** (0.4) | nema šta da se prikaže |
| Odgovor < 40 znakova | `too_short` | medium (0.15) | prekratko da bude korisno |
| Pretjerane tvrdnje ("garantujem", "100%", "nikad neće") | `overclaim` | medium | pravni i reputacijski rizik |
| Nema citata `[1]` a odgovor se oslanja na KB | `missing_citations` | medium | nedokazane tvrdnje |
| Liči na tajnu (`api_key: ...`) | `secret_leak` | **high** | cure ključevi (D15) |
| Nema nijednog ključnog pojma iz zadatka | `off_topic` | low (0.05) | odgovor nije o pitanju |

`score = max(0, 1 − Σ težina)`; `verdict = score >= threshold && nema high issue ? 'accept' : 'revise'`.
LLM ocjena se poziva **samo ako je heuristika već `accept`** i ako su zadati `criteria` — dakle LLM critic
je "druga mišljenje" za već dobre odgovore, a ne način da se popravi očigledno loš odgovor.

**Pravila zaustavljanja (sva se provjeravaju u petlji):**

| Uslov | Granica (config) | Efekat |
|---|---|---|
| Broj iteracija | `maxIterations` = 3 (tvrdo ≤ 6) | izlaz je zadnji `output` + `finalReview` |
| Prihvaćeno | `review.verdict === 'accept'` | `break` odmah (štedi iteracije) |
| Stagnacija | `review.score <= lastScore` dva puta (`maxStagnant` = 2) | `break` uz log `magentic.stagnant_stop` |
| Prag kvaliteta | `threshold` = 0.7 | ulazi u `verdict` izračun |
| Budžet | `assertCanContinue()` u `helpers.callLlm()` | `BudgetExceededError` → `run()` ga vraća kao grešku; djelimični nalaz je u `iterations[]` |
| Abort iz UI-a | `ctx.signal` | `llm.chat` baca `AbortError` → run se prekida, trošak do prekida se naplaćuje |
| `high` risk akcija | politika (D15) | `ApprovalRequiredError` → `approvals[]` + pauza na `/v1/approvals/:runId` |

**Pseudo-kod (`src/orchestration/magentic.js`) — vjerno stvarnom kodu:**

```js
export function createMagenticPattern({ runAgent, catalog, helpers, critic, logger }) {
  async function run({ input, ctx, config = {} }) {
    const maxIterations = Math.max(1, Math.min(config.maxIterations ?? 3, 6));   // TVRDA granica 6
    const threshold = config.threshold ?? 0.7;
    const spec = catalog.get(ctx.agentId) ?? catalog.get('support');
    const task = String(input);

    const iterations = [];
    let output = '', lastScore = -1, stagnant = 0;

    for (let i = 0; i < maxIterations; i += 1) {
      ctx.onEvent?.({ type: 'magentic_iteration', iteration: i + 1, max: maxIterations });

      // 1) PLAN — kratak eksplicitni plan (max 4 koraka); u novoj iteraciji dobija listu problema
      let planText = '';
      try {
        const plan = await helpers.callLlm(ctx, {
          role: 'magentic-planner', temperature: 0.1, maxTokens: 400,
          messages: [
            { role: 'system', content: 'Napravi kratak plan u najviše 4 koraka: šta provjeriti, koje alate pozvati, kako ćeš znati da je gotovo.' },
            { role: 'user', content: i === 0 ? task
                : `${task}\n\nPrethodni rezultat:\n${output}\n\nProblemi iz refleksije:\n${issuesText(iterations.at(-1))}` },
          ],
        });
        planText = plan.text;
      } catch (err) { logger?.warn?.('magentic.plan_failed', { error: err.message }); }   // bez plana se ide dalje

      // 2) ACT — agent izvršava, plan je u kontekstu
      const res = await runAgent(spec, planText ? `${task}\n\nPlan:\n${planText}` : task, { ...ctx, agentId: spec.id, pattern: 'magentic' });
      output = res.output;

      // 3) REFLECT — critic
      const review = await critic.review({ task, output, criteria: config.criteria ?? [],
        useLlm: config.useLlmCritic ?? false,      // LLM critic je OPCIONO (default: samo heuristike)
        threshold, tenantId: ctx.tenantId, signal: ctx.signal });
      iterations.push({ iteration: i + 1, plan: planText, output, review, costUsd: res.costUsd });

      if (review.verdict === 'accept') break;
      if (review.score <= lastScore) { stagnant += 1; if (stagnant >= (config.maxStagnant ?? 2)) break; }
      else stagnant = 0;
      lastScore = review.score;
      // 4) KOREKCIJA je implicitna: nova iteracija planira sa listom problema iz review.issues
    }

    const finalReview = iterations.at(-1)?.review ?? { verdict: 'unknown', score: 0, issues: [] };
    return { output, iterations: iterations.map((it) => ({ iteration: it.iteration, score: it.review.score, verdict: it.review.verdict, issues: it.review.issues.length })),
             finalReview, accepted: finalReview.verdict === 'accept', usage: sumUsage(iterations), costUsd: round6(costUsd), approvals, handoffs: [] };
  }
  return { name: 'magentic', run };
}
```

**Primjer: "Istraži zašto je prodaja pala i predloži 3 akcije" (tenant `ecommerce`, agent `data`)**

```
config: { maxIterations: 3, threshold: 0.7, useLlmCritic: true,
          criteria: ['tačnost', 'konkretne brojke', 'akcioni plan'] }

iteracija 1  plan: "1) revenue Q1 vs Q2  2) po kanalu  3) churn  4) 3 akcije"
             act:  analytics.revenue → -18%; analytics.byChannel → email -31%, paid -22%, repeat -27%
             reflect: score 0.55, verdict 'revise',
                      issues: ['off_topic'? ne] → 'nema uzroka, samo simptomi'
iteracija 2  plan (sa problemima): "1) poveži kašnjenje isporuke sa churn-om  2) kvantifikuj  3) akcije"
             act:  support.tickets('isporuka kasni') → 3× više u Q2; analytics.churn(repeat) → -27%
                   analytics.correlation(delayDays, repeatRate) → r = -0.62
             reflect: score 0.85 ≥ 0.7, nema high issue → verdict 'accept' → BREAK
output:  uzrok = kašnjenje isporuke → odliv repeat kupaca; 3 akcije sa vlasnikom i rokom:
         1) SLA na 48h (ops, 14 dana)  2) kampanja povratka za 1.200 kupaca (marketing, 7 dana)
         3) drugi prevoznik (ops, 30 dana)
finalReview.accepted: true, method: 'llm', iterations: 2 od 3 dozvoljene
```

**Šta može da pođe naopako:**

- **Petlja bez napretka sa malim varijacijama** → `stagnant` brojač (2× bez porasta score-a) + tvrdi
  `maxIterations`. Bez toga: 6 iteracija × (plan + agent + critic) = do 18 LLM poziva za isti odgovor.
- **Critic preblag** — heuristike ne mogu ocijeniti "tačnost"; bez `useLlmCritic: true` i `criteria`,
  `accept` znači samo "nema mehaničkih problema". Zaštita: za istraživačke zadatke **obavezno**
  `useLlmCritic: true` i barem 2 kriterija; mjeri se `critic_reviews_total{verdict, method}`.
- **Critic preoštar** — `threshold` 0.7 sa `secret_leak`/`empty` nikad ne daje `accept` → sagorijeva budžet.
  Zaštita: `maxIterations` ≤ 3 za produkciju; high issue se prikazuje čovjeku, ne pokušava se "popraviti".
- **LLM critic poziva LLM unutar LLM poziva** — `critic.review` poziva `llm.chat` **direktno**, ne kroz
  `helpers.callLlm`, pa taj poziv **nije** u `cost.record` ni u `budget.spend`. To je stvarni rizik naplate
  (§12) — cost tracker i budžet ga ne vide.
- **Akumulacija konteksta** — svaka iteracija nosi prethodni `output`; sa 3 iteracije i dugim odgovorima
  prompt raste. Zaštita: `condense(output, 2500)` prije nego ide u sljedeći plan.
- **`high` risk akcija** u toku istraživanja (npr. `payments.refund`) → bez odobrenja se ne izvršava;
  run pauzira i **ne** nastavlja "optimistično".

---

## 8. Zajednički kontekst (blackboard)

`ctx` je **jedini** način da pattern/agent/tool dođe do stanja. Nijedan modul ne čita `process.env`,
globalne varijable, niti fajlove direktno. Ovo je **stvarni** `ctx` iz `src/orchestration/index.js`:

```js
const ctx = {
  tenantId,        // OBAVEZNO na svakoj memory/tool operaciji (D11) — nikad iz tijela zahtjeva "ako postoji"
  agentId,         // agent koji izvršava; `router` ga prepisuje konačnim izborom PRIJE poziva patterna
  userId,          // krajnji korisnik (rate limit, personalizacija); null za webhook
  sessionId,       // razgovor; nosi kratkoročnu memoriju
  runId,           // jedinstven po izvršavanju — idempotency, /v1/runs/:runId, approvals, cost.record
  trace,           // run objekat iz tracer.startRun(): { runId, traceId, spans[], ... } (D16)
  budget,          // createBudget(): assertCanContinue(), addStep(), spend({usd,tokensIn,tokensOut}), state, remainingUsd()
  policy,          // resolvePolicy() (src/core/policy.js): tools.allow/deny/requireApproval, risk, pii, maxSteps
  signal,          // AbortSignal (UI stop, timeout, shutdown) — ide u llm.chat i tools.execute
  pattern,         // ime patterna koji trenutno izvršava — ide u cost.record meta i metrike
  approvedTools,   // Set odobrenih alata za ovaj run (odgovor na APPROVAL_REQUIRED)
  blackboard,      // akumulirano stanje po `outputKey` (vidi dolje)
  onEvent,         // callback za SSE: step_start, step_end, worker_start, plan, handoff, magentic_iteration…
  monthlySpentUsd, // potrošnja tenanta u tekućem mjesecu (ulaz u budžet, D16)
};
```

**Servisi se ne stavljaju u `ctx`** — patterni ih dobijaju kroz fabriku (`createXPattern(services)`), a ne
kroz kontekst. U `ctx` idu **samo po-run podaci**. To sprječava da se servis slučajno zamijeni u sredini run-a.

`ctx` se grana plitko: `{ ...ctx, agentId: spec.id, pattern: 'sequential' }`. Time worker dijeli **isti**
`budget`, `signal`, `trace` i `blackboard` sa roditeljem — trošak se slijeva u jedan budžet run-a, a trace
ostaje jedan (D16). **Zamka:** plitko grananje znači da `blackboard` *je* dijeljen objekat; ako dva workera
pišu isti `outputKey` u `fanout`-u, zadnji pobjeđuje. Za fanout koristiti `workers[i].output`, ne blackboard.

**Šta je zabranjeno stavljati u `ctx` (i u `blackboard`):**

| Zabranjeno | Zašto | Šta umjesto toga |
|---|---|---|
| API ključevi, tokeni, lozinke, connection string-ovi | cure u trace, u LLM prompt i u audit log | alati čitaju tajne sami (DSH store / env na serveru); u `ctx` samo **ime** ref-a |
| Sirovi PII (JMBG, broj lične karte, IBAN, telefon) | multi-tenant izolacija + GDPR | `redactPii(text)` iz `src/core/policy.js` **prije** prompta i **prije** upisa |
| Podaci o kartici (PAN/CVV) | nikad ne ulaze u sistem | referenca na payment provider (`providerRef`) |
| Cijeli transkript / sirov HTML / binarni sadržaj | eksplozija konteksta i trošak | `helpers.condense(value, 2500)` + handle na blob |
| Tuđi `tenantId` u bilo kojem obliku | izolacija (D11/D12) | `tenantId` isključivo iz autentifikovanog zahtjeva |
| Stanje između dva run-a | run je jedinica izolacije i naplate | trajna memorija kroz `longterm`/`vector` (**napomena:** u v1.0 `ctx` ne nosi `memory`/`vector` — dodaje se u `services`, vidi §12) |
| Servisi (llm, tools, tracer) | run mora biti reproduktivan sa istim servisima od početka do kraja | `createXPattern(services)` |

**Skraćivanje velikih rezultata (`summarize before store`) — postojeća funkcija `helpers.condense()`:**

```js
// src/orchestration/helpers.js — STVARNA implementacija (ne LLM, ne trošak, deterministički)
function condense(value, max = 2500) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[skraćeno ${text.length - max} znakova]`;
}
```

Pravila:

- **Tvrdi rez:** 2500 znakova po unosu koji ide u sljedeći korak/plan; `condenseList(items, 6000–7000)` za
  listu rezultata prije sinteze.
- **Skraćivanje je vidljivo:** sufiks `…[skraćeno N znakova]` je u tekstu — model (i čovjek) zna da je ostatak
  odsječen, pa ne izmišlja ono što ne vidi.
- **Skraćivanje ne poziva LLM** (za razliku od "summarize before store" u §DECISIONS): jeftinije je i
  deterministički, pa snapshot testovi ne padaju. LLM sažimanje se uvodi samo ako se pokaže da odsječeni
  rep sadrži odluke — tada ide kroz `helpers.callLlm({ role: 'summarizer' })` da ostane u budžetu.
- **PII se redaktuje prije skraćivanja** i prije nego tekst uđe u prompt.

---

## 9. Budžet, prekid i greške

**Budžet — svaki pattern ga poštuje na isti način.** `ctx.budget` je `createBudget({ runUsd, monthlyUsd,
spentThisMonthUsd, maxSteps, maxTokens, maxWallMs })` iz `src/core/budget.js`. Provjera je **fail-closed**:
ako se ne može dokazati da je akcija dozvoljena — prekid.

| Pattern | Kako ograničava | Ponašanje na iscrpljenju |
|---|---|---|
| `agent` | `assertCanContinue({ estimatedUsd, label: 'agent:<id>' })` + `addStep()` prije svakog LLM poziva | `BUDGET_EXCEEDED` (402) prije poziva; alat se ne izvršava |
| `router` | `maxTokens: 200` u LLM sloju; keyword/embedding sloj je besplatan | LLM sloj se ne poziva; ide `method: 'fallback'` |
| `sequential` | svaki korak ide kroz `runAgent`/`tools.execute`; LLM koraci troše budžet | `BUDGET_EXCEEDED` u sredini → `results[]` nosi korake do pada |
| `orchestrator-worker` | `callLlm` za planer i sintezu + po jedan budžet-poziv po workeru | planer trim na 5; ako ni za jedan worker nema → prekid **prije** delegiranja |
| `fanout` | svaka grana troši iz **istog** budžeta (`{...ctx}` dijeli `budget`) | prva grana koja pređe limit baca; ostale grane su već potrošile (zato procjena prije) |
| `handoff` | trošak ide u zajednički budžet run-a, ne po agentu | lanac se prekida; `approvals` i `transcript` ostaju |
| `magentic` | `callLlm` za plan; `critic.review` (LLM) **ne** ide kroz budžet (rizik, §12) | `BUDGET_EXCEEDED` → `iterations[]` nosi sve do prekida |

```js
// src/core/budget.js — STVARNA provjera (redoslijed je bitan: prvo najjeftinije)
ctx.budget.assertCanContinue({ estimatedUsd, label });
// 1) steps >= maxSteps                  → BudgetExceededError({ limit: 'maxSteps' })
// 2) elapsed > maxWallMs                → BudgetExceededError({ limit: 'maxWallMs' })
// 3) usd + estimatedUsd > runUsd        → BudgetExceededError({ limit: 'runUsd' })
// 4) spentThisMonthUsd + usd + est. > monthlyUsd → BudgetExceededError({ limit: 'monthlyUsd' })  // tenant limit
// 5) tokensIn + tokensOut >= maxTokens  → BudgetExceededError({ limit: 'maxTokens' })
// Kod: 'BUDGET_EXCEEDED', HTTP 402. classifyError() je svrstava u 'policy' → NE ponavlja se.
```

**Jedan helper za sve LLM pozive van agenta — `helpers.callLlm()`:** provjeri budžet → `addStep()` →
`llm.chat` → `cost.record()` → `budget.spend(...)` → span `llm:<role>` → metrika `pattern_llm_calls_total`.
Zato patterni **nikad** ne pozivaju `ctx.llm` direktno: inače trošak i span nisu zabilježeni.

```js
// src/orchestration/helpers.js — STVARNO (skraćeno)
async function callLlm(ctx, { messages, tools = [], temperature = 0.1, maxTokens = 700, model, responseFormat, role = 'pattern' }) {
  const estimate = cost.estimate({ promptChars: JSON.stringify(messages).length, maxOutTokens: maxTokens, model: model ?? 'default' });
  ctx.budget?.assertCanContinue({ estimatedUsd: estimate, label: role });
  ctx.budget?.addStep();
  const span = ctx.trace ? tracer.span(ctx.trace, `llm:${role}`, { model: model ?? 'default' }) : null;
  try {
    const res = await llm.chat({ messages, tools, temperature, maxTokens, model, responseFormat, signal: ctx.signal, tenantId: ctx.tenantId });
    const rec = await cost.record({ tenantId: ctx.tenantId, agentId: ctx.agentId ?? role, runId: ctx.runId,
                                    model: res.model, usage: res.usage, provider: res.provider, meta: { pattern: ctx.pattern, role } });
    ctx.budget?.spend({ usd: rec.usd, tokensIn: rec.tokensIn, tokensOut: rec.tokensOut });
    metrics?.inc('pattern_llm_calls_total', { pattern: ctx.pattern ?? '-', role });
    return { text: res.text ?? '', toolCalls: res.toolCalls ?? [], usage: { tokensIn: rec.tokensIn, tokensOut: rec.tokensOut }, costUsd: rec.usd, model: res.model };
  } catch (err) { span?.fail(err); throw err; }
}
```

**`AbortSignal` (`ctx.signal`) — prekid iz UI-a:**

- `POST /v1/agents/:agentId/stream` (SSE); widget ima dugme Stop → server poziva `controller.abort()` na istom
  `AbortSignal`-u koji nosi `ctx.signal`; kroz `{ ...ctx }` signal stiže do svakog patterna i agenta.
- Signal ide **u dubinu**: `llm.chat({ signal })`, `tools.execute(..., { ...ctx })`, `sleep()` u retry-u.
  Provjera je u adapteru **prije** svakog chunk-a stream-a (vidi `src/llm/mock.js` i `openai-compatible.js`).
- Na abort: **ne** se prijavljuje kvar korisniku; emituje se SSE događaj, `results[]`/`iterations[]` i
  `blackboard` se **zadržavaju**, a trošak do prekida se naplaćuje (`budget.spend` je već izvršen za gotove pozive).
- Tvrdi timeout (`maxWallMs`, default 180 s) koristi isti mehanizam → jedan kod za "stop" i "timeout".
- **Abort nije retryable:** `isAbort(err)` se provjerava **prije** `classifyError()`; inače bi backoff
  ponovo pokrenuo prekinuti poziv.

**Klasifikacija grešaka i retry — stvarne klase i `classifyError()` iz `src/core/errors.js`:**

| Klasa (`classifyError`) | Klase / kodovi | Retry | Kako se prikazuje |
|---|---|---|---|
| `retryable` | `LlmError` (`LLM_ERROR`, 502), `ToolError` (`TOOL_ERROR`, 502), `TimeoutError` (`TIMEOUT`, 504), 429/5xx/`ECONNRESET` | DA, exponential + full jitter (adapter: `maxRetries` 2) | korisnik ne vidi; u `results[]` stoji `ok: false` samo ako su svi pokušaji pali |
| `policy` | `PolicyError` (`POLICY_DENIED`, 403), `ApprovalRequiredError` (`APPROVAL_REQUIRED`, 409), `BudgetExceededError` (`BUDGET_EXCEEDED`, 402) | NE (osim poslije odobrenja) | jasno ljudski: "Ova akcija traži odobrenje." / "Nemate pristup ovom alatu." |
| `fatal` | `AuthError` (`UNAUTHORIZED`, 401), `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `NESTED_DEPTH_EXCEEDED`, `PLAN_CYCLE` | NE | `{ error: { code, message, details } }` + `runId` za podršku |

```js
import { classifyError, isAbort, NmqError } from '../core/errors.js';

async function withRetry(fn, { retries = 2, base = 250, max = 4000, signal, onRetry }) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await fn(); }
    catch (err) {
      if (isAbort(err)) throw err;                       // abort NIJE retryable — ide odmah na vrh
      const cls = classifyError(err);                    // 'policy' | 'retryable' | 'fatal'
      if (cls !== 'retryable' || attempt >= retries) throw Object.assign(err, { cls, attempts: attempt + 1 });
      const delay = Math.min(max, base * 2 ** attempt) * (0.5 + Math.random() / 2);   // exponential + FULL jitter
      onRetry?.({ attempt: attempt + 1, delay, code: err.code });
      await sleep(delay, signal);                        // sleep koji poštuje AbortSignal
    }
  }
}
```

**Kako se greška prikazuje korisniku:** nikad stack trace i nikad sirov providerski tekst.
Svaka greška nosi `code` (stabilan, za podršku i metrike), `status` (HTTP), `userMessage` (lokalizovan,
bez detalja) i `runId`. Kod `policy` korisnik dobija **akciju** ("Zatraži odobrenje"), kod `fatal` dobija
`runId` za podršku, kod `retryable` istrošenog retry-a "trenutno ne mogu, pokušajte ponovo" + `runId`.
U SSE toku: `event: error` sa `{ code, userMessage, runId, partial }` — `partial` nikad ne izgleda kao
konačan odgovor. U patternima koji nastavljaju poslije pada grane (`fanout`, `orchestrator-worker`), pad
**nije** greška run-a: `failed[]`/`ok: false` je u izlazu i korisnik mora vidjeti šta fali.

---

## 10. Determinizam i testiranje

**Princip:** svaki pattern se testira **bez LLM-a i bez mreže** (D17, `node --test`).
`createMockProvider` iz `src/llm/mock.js` je prvi građanin, ne pomoćna stvar.

```js
// tests/orchestration/sequential.test.mjs — stvarni API, bez ijedne mreže
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockProvider } from '../../src/llm/mock.js';

const llm = createMockProvider({
  script: [
    { text: '{"pib":"100234567","iznos":120000,"pdv":0}' },        // korak: ekstrakcija
    { text: 'Sažetak: dobavljač, 120000 RSD, PDV 0.' },            // korak: summarize
    { toolCalls: [{ name: 'handoff', arguments: { to: 'billing', reason: 'dupla naplata za isti period' } }] },
  ],
});

test('sequential: fail-fast prekida na 3. koraku', async () => {
  const ctx = await makeTestCtx({ llm, tenantId: 'knjigovodja' });   // mock clock + fiksni runId
  await assert.rejects(
    () => sequential.run({ input: 'racun.pdf', ctx, config: { failFast: true, steps: STEPS_3 } }),
    (err) => err.code === 'TOOL_ERROR',
  );
  assert.equal(llm.callCount, 2);                                    // TAČAN broj poziva je dio ugovora
  assert.equal(ctx.budget.state.steps, 2);
});
```

Determinizam se obezbjeđuje sa: `createMockProvider` (skriptovani `text`/`toolCalls`, `callCount`, `reset()`),
**fiksni `clock`** (`src/core/clock.js`), fiksni `runId`/seed (`src/core/ids.js`), hash-embedder
(offline, deterministički, D10), `temperature` koji patterni eksplicitno postavljaju (0–0.2) i
isključen jitter u backoff-u za testove. LLM fallback lanac i keš (`src/llm/index.js`) se u testovima
isključuju (`NMQ_ALLOW_MOCK_FALLBACK=0`, `chat({ cache: false })`) da svaki test vidi tačno svoje pozive.

**Tabela test scenarija (najmanje 3 po patternu):**

| # | Test fajl | Pattern | Scenario | Očekivanje |
|---|---|---|---|---|
| 1 | `router-keyword.test.mjs` | router | "gdje je moja narudžba" sa `routingHints` | `method: 'heuristic'`, **0** LLM poziva, `agentId: support` |
| 2 | `router-embedding.test.mjs` | router | parafraza bez ključne riječi | `method: 'heuristic'`, score ≥ `minConfidence`, 0 LLM poziva |
| 3 | `router-llm-fallback.test.mjs` | router | svi skorovi < 0.45 + mock LLM | `method: 'llm'`, tačno 1 LLM poziv |
| 4 | `router-invented-agent.test.mjs` | router | LLM vrati `agentId: "ne_postoji"` | odbačeno, `method: 'fallback'`, `agentId` postoji |
| 5 | `router-accuracy.test.mjs` | router | zlatni set ≥ 200 ulaza | `top1 ≥ 0.88` inače test pada |
| 6 | `seq-happy.test.mjs` | sequential | 4 koraka (2 agenta + 2 alata) | redoslijed `results[]`, `output` = zadnji korak, `costUsd > 0` |
| 7 | `seq-failfast.test.mjs` | sequential | korak 3 baca, `failFast: true` | korak 4 se **ne** izvršava, greška propagira |
| 8 | `seq-continue.test.mjs` | sequential | `failFast: false`, korak 2 pao | pipeline završava, `output` sadrži "Korak 2 nije uspio" |
| 9 | `seq-interpolate.test.mjs` | sequential | `previous` sadrži `"` i `\` | `interpolate` + `JSON.parse` ne pucaju |
| 10 | `seq-tool-policy.test.mjs` | sequential | alat nije dozvoljen politikom | `POLICY_DENIED`, alat nije izvršen, `results[].ok === false` |
| 11 | `ow-plan-trim.test.mjs` | orch-worker | planer vrati 9 podzadataka | izvršeno tačno `maxWorkers` (5), ostali odbačeni |
| 12 | `ow-invented-agent.test.mjs` | orch-worker | planer vrati nepostojećeg agenta | `.filter()` ga odbaci; `plan.subtasks` bez njega |
| 13 | `ow-config-workers.test.mjs` | orch-worker | `config.workers` zadat | `plan.source === 'config'`, **0** LLM poziva za plan |
| 14 | `ow-worker-fail.test.mjs` | orch-worker | 1 od 3 workera baca | `workersOk: 2`, sinteza radi, ostatak u izlazu |
| 15 | `ow-no-synthesis.test.mjs` | orch-worker | 1 worker, `synthesize` nije `true` | **nema** sinteza poziva (ušteda 1 LLM poziv) |
| 16 | `fan-parallel.test.mjs` | fanout | 3 grane, `concurrency: 3` | 3 poziva, `workers.length === 3`, redoslijed očuvan |
| 17 | `fan-one-fails.test.mjs` | fanout | grana 1 baca | `ok.length === 2`, `failed[0].agent === 'finance'` |
| 18 | `fan-all-fail.test.mjs` | fanout | sve grane bacaju | izlaz = "Svi paralelni agenti su pali…", **bez** sinteze |
| 19 | `fan-concurrency.test.mjs` | fanout | 6 grana, `concurrency: 2` | nikad više od 2 aktivna poziva (mjeri mock `calls.length` po vremenu) |
| 20 | `fan-vote.test.mjs` | fanout | `merge: 'vote'`, 2× "da" 1× "ne" | izlaz "da" + `_(glasova: 2/3)_` |
| 21 | `fan-synthesis-fail.test.mjs` | fanout | sinteza baca | degradira na `concat`, run **ne** pada |
| 22 | `ho-basic.test.mjs` | handoff | support → billing, billing završi | `handoffs: 1`, `resolvedBy: 'billing'`, `visited` tačan |
| 23 | `ho-loop.test.mjs` | handoff | billing → support (u `visited`) | `status: 'handoff_loop'`, izlaz sadrži "spriječena petlja" |
| 24 | `ho-max.test.mjs` | handoff | `maxHandoffs: 3`, lanac se ne zaustavlja | `status: 'max_handoffs'`, tačno 4 agent poziva (i=0..3) |
| 25 | `ho-unknown.test.mjs` | handoff | `toAgent` ne postoji | `status: 'handoff_unknown'`, bez poziva |
| 26 | `ho-context.test.mjs` | handoff | `includeTranscript: false` | sljedeći agent **ne** dobija prethodni odgovor; `summary` dobija |
| 27 | `mag-accept.test.mjs` | magentic | critic `accept` u 2. iteraciji | petlja staje rano, `accepted: true`, 2 iteracije od 3 |
| 28 | `mag-max-iter.test.mjs` | magentic | critic stalno `revise` | tačno `maxIterations` (3) iteracije, `accepted: false` |
| 29 | `mag-stagnant.test.mjs` | magentic | score ne raste 2× | prekid prije `maxIterations`, log `magentic.stagnant_stop` |
| 30 | `mag-critic-issues.test.mjs` | magentic | 2. iteracija dobija listu problema | plan prompt sadrži `issues[].message` iz 1. iteracije |
| 31 | `critic-heuristics.test.mjs` | critic | odgovor sa "garantujem" + `api_key: ...` | `verdict: 'revise'`, `secret_leak` (high), `overclaim` |
| 32 | `critic-threshold.test.mjs` | critic | score tačno na pragu | `accept` ako je `score >= threshold` i nema high issue |
| 33 | `helpers-budget.test.mjs` | svi | `maxSteps: 1`, dva `callLlm` | drugi poziv baca `BUDGET_EXCEEDED`, `cost.record` nije zvan |
| 34 | `helpers-condense.test.mjs` | svi | rezultat 10 KB | vraćeno ≤ 2500 znakova + sufiks `[skraćeno N znakova]` |
| 35 | `tenant-isolation.test.mjs` | svi | run za `t1`, podaci za `t2` | nula dodira, `vector.query` nikad ne vrati tuđi dokument |
| 36 | `abort.test.mjs` | svi | abort u toku 2. koraka | `AbortError`, `results[]` sačuvan, trošak gotovih poziva naplaćen |

**Kako se hvata regresija:**

- **Snapshot `results[]` / `workers[]`**: fiksni clock/runId → `assert.deepStrictEqual` (redoslijed, `ok`,
  `code`, `output`) — promjena ponašanja patterna obara test bez ijedne mreže.
- **Broj LLM poziva je dio ugovora**: `assert.equal(llm.callCount, 4)` — sprječava tihi rast troška
  (najčešća regresija u multi-agent sistemima: dodatni poziv po grani).
- **Budžet u svakom testu**: `assert.ok(ctx.budget.state.steps <= maxSteps)` i `state.usd <= runUsd`.
- **Zlatni set rutiranja** u CI-u: tačnost < 0.88 = crveni build.
- **Trace golden**: `trace.spans` se snima u `tests/fixtures/trace/<pattern>.json` — nova granica ili novi
  poziv se odmah vidi u diff-u.
- **Politika kao test** (D15): zabranjen alat i `high` rizik bez odobrenja **moraju** pasti — DoD tačka 4.

---

## 11. Trošak po patternu

Procjena za tipičan NMQ zadatak (mješoviti modeli: jeftin za rutiranje/planiranje/sažimanje, srednji za
izvršavanje). Cijene po modelu se **ne** upisuju u dokument — žive u `PRICING` tabeli
`src/observability/cost.js` i mijenjaju se kod providera.

| Pattern | LLM poziva (tipično) | Latencija | Relativan trošak | Kada se isplati |
|---|---|---|---|---|
| `agent` | 1 (+1 po tool loop-u) | 1 poziv | 1× | Sve gdje jedan specijalista može sam; **default** i najjeftinije |
| `router` (keyword/embedding) | 0 | < 50 ms | ~0 | Uvijek prvi kod nepoznatog ulaza — najjeftiniji način da se ne potroši pogrešan agent |
| `router` (LLM fallback) | 1 (≤ 200 tokena izlaza) | 0,4–1,2 s | 1× mali | Samo kad skor < 0,45; cilj ≤ 35% saobraćaja |
| `sequential` (n koraka, m alata) | n − m | suma koraka (serijski) | (n − m)× | Linearni procesi; jeftinije od svih ostalih jer nema planiranja ni sinteze |
| `orchestrator-worker` (k workera) | 1 plan + k agent + 1 sinteza | serijski: Σ; `parallel: true`: ≈ max + sinteza | (k + 2)× | Kompleksan zadatak sa 3–5 nezavisnih djelova; ispod 3 djela → `sequential` je bolji |
| `fanout` (k grana) | k + (1 ako `synthesis`) | ≈ max(grana), ne suma | (k + 1)× **i plaćaš neiskorišteno** | Kad je latencija kritična ili trebaju nezavisni uglovi / verifikacija |
| `handoff` (h predaja) | h + 1 (po agentu ≥ 1) | serijski, h × trajanje agenta | (h + 1)× | Kad specijalizacija stvarno mijenja kvalitet; h > 3 se ne isplati (i zabranjeno je) |
| `magentic` (i iteracija) | i × (1 plan + 1 agent + 1 critic*) | najduža (i ciklusa) | ≈ 3i× — najskuplji | Istraživanje/dijagnostika bez poznatog plana; nikad za operativne zadatke |
| `critic` (unutar magentic) | 0 (heuristike) ili 1 (LLM) | heuristike: < 5 ms | 0 / 0,2× | Heuristike uvijek; LLM critic samo kad je tačnost važnija od cijene |

\* LLM critic se poziva samo ako je heuristika već `accept` i `criteria` je zadat — zato je tipično 1×, ne 3×.

**Tri pravila za smanjenje troška:**

1. **Keširaj sve što je deterministički ponovljivo.** `src/llm/index.js` već ima keš sa ključem
   `sha256(stableStringify({ model, messages, tools, extra }))` i `CACHE_MAX = 200`.
   Keširaj: rutiranje (najveći hit rate — isti FAQ dolazi 100×), planiranje identičnih zadataka,
   sažimanje istog dokumenta, `registry.lookup`. **Ograničenje:** keš je in-memory i **ne uključuje `tenantId`** —
   zato `cacheKeyExtra` mora nositi `tenantId`, inače jedan tenant može dobiti keširan odgovor drugog
   (kršenje D11). Metrika: `llm_cache_hits_total`.
2. **Jeftiniji model za svaki meta-korak.** Rutiranje, planiranje i sažimanje idu na
   `env.llm.fastModel` (`NMQ_LLM_FAST_MODEL`); samo izvršni koraci i finalna sinteza na `env.llm.model`.
   Uz to `maxTokens` po tipu koraka: router 200, planer pl/700, magentic plan 400, critic 250, sinteza 900 —
   sprječava "romane" i drži procjenu troška tačnom.
3. **Paralelizuj samo nezavisno, i to ograničeno.** `fanout`/`orchestrator-worker` skraćuju latenciju, ali
   **ne** smanjuju trošak. Zato: (a) dijeljeni `parse` korak **jednom**, pa grane dobijaju isti tekst;
   (b) `concurrency` ≤ 4 po API ključu (tvrda granica je 8) da se ne plati 429/retry;
   (c) prije fan-out-a provjeri da li se grane uopšte razlikuju — ako u testovima daju isti odgovor, spojiti ih;
   (d) `orchestrator-worker` sa `parallel: false` je jeftiniji po riziku (nema kaskadnog 429), a
   `parallel: true` samo kad je latencija bitna.

---

## 12. Zamke nađene u kodu (v1.0) — mora se popraviti

Ovo nije teorija; to su konkretni nalazi iz `src/orchestration/*` na dan 2026-09-29.

| # | Nalaz | Posljedica | Popravka |
|---|---|---|---|
| 1 | `src/orchestration/orchestrator-worker.js` radi `import { condenseList } from './parallel.js'`, a **`parallel.js` ne postoji** (`condenseList` je izvezen iz `fanout.js`) | `index.js` uvozi `orchestrator-worker.js` → **cijeli orchestration modul pada na importu** (`ERR_MODULE_NOT_FOUND`). Ovo je blocker za sve 6 patterna | `import { condenseList } from './fanout.js';` (ili izdvojiti `parallel.js` sa `runWithConcurrency` + `condenseList` i ažurirati oba importa) |
| 2 | `critic.review()` poziva `llm.chat()` **direktno**, ne kroz `helpers.callLlm()` | LLM critic poziv nije u `cost.record` ni u `budget.spend` → **nenaplaćen trošak i budžet koji se ne poštuje** (D16/D15) | critic treba da dobije `helpers`/`cost` ili da vrati `usage`, pa da poziv ide kroz `callLlm` |
| 3 | Keš LLM-a ne uključuje `tenantId` u ključ | teoretski cross-tenant hit (D11) | `cacheKeyExtra: ctx.tenantId` na svakom pozivu ili `tenantId` u ključ |
| 4 | `ctx` ne nosi `memory`/`vector`/`blobs` iako ih §8 i D9/D11 zahtijevaju | patterni/agenti ne mogu da čitaju memoriju kroz `ctx` (rade kroz `services`) | dodati u `ctx` ili dokumentovati kao `services`-only (odluka u „Otvorena pitanja") |
| 5 | Ne postoji provjera dubine ugniježđavanja (`depth > 2`) ni `allowedNested` | dubina 3+ može eksponencijalno potrošiti budžet | provjera u `run()` + `NESTED_DEPTH_EXCEEDED` |
| 6 | `orchestrator-worker` sa `parallel: true` koristi `Promise.all` bez semafora | 5 istovremenih poziva → 429 na dijelu workera | koristiti `runWithConcurrency()` iz `fanout.js` |

**Zamka #1 je blocker:** dok se ne popravi, `node scripts/demo.mjs` i `npm test` za orchestration ne mogu
ni da se učitaju. Popravka je jedan red.

---

## Otvorena pitanja

1. **`defaultPattern` po agentu** — gdje je granica za `support`: `handoff` (jer zadaci prelaze domene) ili
   `sequential` + handoff samo kad agent vrati `needsSpecialist`? Mijenja trošak i broj ping-pong slučajeva;
   predlog: `handoff` kao pattern za `support`, `sequential` za `ops`/`finance`.
2. **Pragovi rutiranja** — `minConfidence = 0.45` je sada jedini prag; da li se uvodi i `clarify` (pitanje
   korisniku) između 0.30 i 0.45, i ko mijenja prag: tenant admin ili samo NMQ? Prag direktno određuje
   udio LLM poziva, a time i trošak rutiranja.
3. **Memorija u `ctx`** — da li `memory`/`vector`/`blobs` ulaze u `ctx` (kako §8 i D9/D11 traže) ili ostaju
   `services` i do njih se dolazi kroz `createXPattern(services)`? Prvo je jednostavnije za agente,
   drugo čuva `ctx` kao isključivo per-run podatak.
4. **`critic` kao drugi model** — da li LLM critic mora biti **drugi** model od izvršnog (skuplje, ali hvata
   korelirane greške) ili je drugi prompt na istom modelu dovoljan? I mora li `critic` ići kroz `callLlm`
   (naplata) čak i ako to znači da njegov poziv ulazi u `maxSteps`?
5. **`dependsOn` u orchestrator-worker** — v1.0 nema talase; planer može vratiti samo ravan spisak podzadataka.
   Da li uvesti `dependsOn` (2 talasa) i time dobiti "cijene poslije istraživanja", ili ostati na ravnom
   spisku i kompleksnije zadatke rješavati `handoff`-om?
6. **Nastavak prekinutog run-a** — da li `/v1/runs/:runId/resume` postoji u MVP-u? Zahtijeva serijalizaciju
   `blackboard`-a i `visited[]` (handoff) ili `iterations[]` (magentic). Ako ne, abort mora biti konačan
   i to jasno pisati u SSE događaju.
7. **Budžet: tvrdi ili meki prekid** — da li `BudgetExceededError` treba da vrati djelimičan rezultat
   (bolje UX, ali korisnik može pomisliti da je gotovo) ili uvijek jasnu grešku bez izlaza?
   Predlog: djelimičan izlaz **samo** ako je zadnji `critic.review()` dao `verdict: 'accept'`.
