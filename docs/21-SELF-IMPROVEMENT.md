# 21 — Self-improvement: mjerenje, prijedlozi, odobrenje, A/B

> **Svrha:** objasniti kako robot **mjeri sopstveni kvalitet**, iz toga **izvodi prijedloge**, kako ti prijedlozi
> prolaze kroz **čovjeka**, kako se primjenjuju **bez dodirivanja config fajlova**, kako se **mjeri efekat**
> i kako se sve to **vraća** ako ne radi.
>
> **Ugovor:** `docs/DECISIONS.md` (§7 stanje, §8 D21–D36), `docs/00-VIZIJA.md` (§5 — v0.5 „robot uči iz svog rada").
> **Kod je kanonski.** Sve što nije implementirano označeno je kao **planirano**.
> Vrijednosti ključeva se **nikad** ne upisuju — samo **imena** env varijabli (`NMQ_LLM_API_KEY`, `NMQ_MASTER_KEY`, …).
> Sve što je procjena (vrijeme, cijena, verzija) nosi riječ *procjena*.

---

## 1. Šta je stvarno implementirano (a šta nije)

Prije svega ostalog — granica. Self-improvement u NMQ Robotu **nije** treniranje modela. To je
**mjerni i odlučivački sloj oko modela**, i to je namjerno.

### Implementirano (postoji u kodu i ima test)

| Sposobnost | Gdje je | Dokaz |
|---|---|---|
| **Reward model** — jedna ocjena 0–1 po run-u iz stvarnih signala | `src/learning/rewards.js` (`DEFAULT_WEIGHTS`, `score`, `record`) | `tests/autonomy.test.mjs` → `reward: formula, agregacija i rangiranje` |
| **Agregacije** — po agentu, patternu, varijanti, cilju | `rewards.aggregate` / `ranking` / `variantComparison` | isto + `GET /v1/admin/rewards` |
| **Prijedlozi poboljšanja** — 7 tipova sa `rationale`, `evidence`, `riskLevel` | `src/learning/improvements.js` (`KINDS`) | `self-improvement: prijedlog → odobrenje → primjena prompta → rollback` |
| **Human-in-the-loop odobrenje** — `proposed → approved/rejected` | `improvements.decide` + `POST /v1/admin/proposals/:id/decide` (rola `approve`) | isti test (`apply` bez odobrenja baca `ValidationError`) |
| **Primjena kroz control plane i runtime politike** (bez izmjene config fajlova) | `improvements.apply` → `controlPlane.deploy` / `policyOverrides.apply` / `memory.vectors.ingest` | `self-improvement: izmjena politike kroz runtime override (i povrat)`, `… KB prijedlog …` |
| **A/B po run-u** — varijanta važi samo za taj run | `improvements.assignVariant` → `options.specPatch` → `ctx.specPatch` → `runAgent` | `A/B: varijante se dijele deterministički, mjere i pobjednik se promoviše` |
| **Rollback** — primijenjeno se vraća | `improvements.rollback`, `policyOverrides.revert`, `controlPlane.rollback` | prvi i drugi test iz tabele |
| **Mjerenje efekta** — prosječna nagrada prije/poslije primjene | `src/learning/rsi.js` → `impact`, `GET /v1/admin/proposals/:id/impact` | `RSI: analiza nalaza i ciklus prijedloga, pa mjerenje efekta` |
| **Self-play dataset za budući trening** | `src/learning/selfplay.js` → `learning/training-YYYY-MM.jsonl`, `dataset()` | `self-play: scenariji, dataset i kurikulum` |

### NIJE implementirano (i zašto je to ispravno)

| Nije implementirano | Status | Zašto ne sada |
|---|---|---|
| **Fine-tuning modela (LoRA/adapteri) iz sopstvenih podataka** | **planirano** — `selfplay.dataset()` samo *priprema* format („spreman za SFT/DPO; sam trening se pokreće van ovog procesa") | Trening traži GPU ili API fine-tune, dakle **prvu pravu zavisnost** (D2: `dependencies: {}`), novi proces i eval koji je jeftiniji od rizika. Nema ga bez dataseta — a dataset se tek sada skuplja |
| **RLHF reward-model trening** (model koji uči ocjenjivati umjesto nas) | **planirano** (`docs/22` nije napisan; vidi §9) | Prvo treba **skup ljudskih ocjena** (feedback + odobrenja) sa dovoljno uzoraka i dokazanom stabilnošću reward funkcije. Treniranje ocjenjivača na 200 primjera daje pristrasnu ocjenu koja izgleda autoritativno |
| **Online RL na ishodima** (agent uči iz nagrade u toku rada) | **planirano** | Online RL bez sandboxa u odvojenom procesu i bez `maxSteps`/budžet brave je **način da se potroši novac i pokvari produkcija**. Uz to: cilj nije „model bolje piše", nego „posao je obavljen" — a to se prvo mora naučiti mjeriti |
| **Automatska izmjena koda / MCP servera** | **planirano, namjerno** — prijedlozi tipa `tool` i `code` ostaju status `needs_code` | Robot ne mijenja sopstveni kod. To je granica koju ne treba pomicati dok ne postoje eval, sandbox u odvojenom procesu i obavezan ljudski pregled svake izmjene |

**Zašto je ovo ispravan redoslijed.** Postoji tačno jedan redoslijed koji ne laže:

1. **Mjeri** (reward model) — bez mjere nema ni „bolje" ni „gore", samo mišljenje.
2. **Predloži** (prijedlozi + RSI) — promjena je **predlog**, ne činjenica; čovjek odlučuje.
3. **Primijeni reverzibilno** (control plane + runtime override) — svaka promjena ima `rollbackInfo` i put nazad.
4. **Izmjeri efekat** (`rsi.impact`) — tek sada se zna da li je promjena bila dobra.
5. **Tek onda** treniraj (SFT/LoRA) i **još kasnije** treniraj ocjenjivača (RLHF reward model).

Preskakanje koraka 1–4 i prelazak na korak 5 daje model koji je „fine-tuned" na **neprovjerenim** podacima,
sa nepoznatim efektom i bez rollback-a. To nije ubrzanje — to je gubitak mogućnosti da se bilo šta dokaže.

---

## 2. Reward model

Reward model je **deterministička funkcija** od skupa signala koje sistem već ima. Nema treniranih težina koje
se mijenjaju u toku rada — težine su **konstanta** (`DEFAULT_WEIGHTS`) i mogu se pregaziti konfiguracijom
(`config.autonomy.rewardWeights` → `createRewardModel({ weights })`).

### Signali i težine (`src/learning/rewards.js`)

| Signal (ključ) | Težina | Kako se primjenjuje u `score` |
|---|---|---|
| `base` | **0.5** | Početna vrijednost svakog run-a |
| `feedbackUp` | **+0.30** | `feedback: 'up'` ili `true` |
| `feedbackDown` | **−0.35** | `feedback: 'down'` ili `false` |
| `ratingScale` | **0.25** | Ocjena 1–5: `((f - 3) / 2) * 0.25` → 5 daje +0.25, 1 daje −0.25, 3 ne mijenja ništa |
| `approved` | **+0.05** | `approval: 'approved'` |
| `rejected` | **−0.25** | `approval: 'rejected'` |
| `pendingApproval` | **0.0** | Težina postoji (0) — čekanje na odobrenje **ne kažnjava** run |
| `outcomeOk` | **+0.15** | `outcome: 'ok'` |
| `outcomeError` | **−0.35** | `outcome: 'error'` |
| `policyDenied` | **−0.10** × `min(3, n)` | Broj odbijenih politika; **plafon 3** (poslije trećeg nema razlike) |
| `toolError` | **−0.08** × `min(5, n)` | Broj grešaka alata; **plafon 5** |
| `escalation` | **−0.12** × `min(3, n)` | Broj eskalacija (handoff bez rješenja); **plafon 3** |
| `uncited` | **−0.08** | Odgovor bez citata (kad je bio KB izvor) |
| `costPenaltyPerUsd` | **−2.0** × USD | Skup run bez rezultata se kažnjava linearno (nema plafona) |
| `slowPenaltyPer10s` | **−0.02** × `floor(ms / 10000)` | Kašnjenje **samo ako `durationMs > 10_000`** |

Rezultat se **klampuje** u `[0, 1]` na 4 decimale: `Number(Math.max(0, Math.min(1, n)).toFixed(4))`.
Uz ocjenu se vraća i `reasons[]` — **ljudski čitljiv spisak** onoga što je podiglo/spustilo ocjenu
(„feedback+ (0.3)", „greške alata 2", „trošak 0.0500 USD").

> Dva detalja iz koda koja vrijedi znati: (1) `policyDenied`, `toolErrors`, `escalations` se sabiraju sa
> **plafonom** — deset grešaka alata ne pravi razliku prema pet, jer bi jedan pokvaren run inače uvijek pao na 0
> i prestao da nosi informaciju; (2) `durationMs` ulazi **samo ako je > 10 s**, pa brzi runovi nemaju nikakav
> vremenski bonus (nema nagrade za brzinu, samo kazna za sporost).

### Primjer: dobar run

Signali: `feedback: 'up'`, `approval: 'approved'`, `outcome: 'ok'`, `costUsd: 0.01`, trajanje 8 s.

```
reward = 0.50                       (base)
       + 0.30                       (feedbackUp)
       + 0.05                       (approved)
       + 0.15                       (outcomeOk)
       + (-2.0 * 0.01) = -0.02      (trošak)
       = 0.98    →  clamp → 0.98
```

(Trajanje 8 s < 10 s, pa nema `slowPenalty`.) Test tvrdi `good.reward > 0.8` — i tačno je 0.98.

### Primjer: loš run

Signali: `feedback: 'down'`, `outcome: 'error'`, `toolErrors: 2`, `costUsd: 0.05`, trajanje 35 s.

```
reward = 0.50                       (base)
       + (-0.35)                    (feedbackDown)
       + (-0.35)                    (outcomeError)
       + (-0.08 * 2) = -0.16        (greške alata)
       + (-2.0 * 0.05) = -0.10      (trošak)
       + (-0.02 * floor(35000/10000)) = -0.02 * 3 = -0.06   (sporost)
       = -0.52   →  clamp na 0  →  0
```

Test tvrdi `bad.reward < 0.2` — u ovom slučaju je **0**. Ocjena 0 je legitimna: run je imao grešku, negativan
feedback, greške alata i bio skup. Uz to `record` loguje `reward.low` upozorenje kad je ocjena < 0.3.

### Gdje se ocjena čuva i šta se iz nje izvodi

**Zapis:** `data/tenants/<id>/learning/rewards-YYYY-MM.jsonl` (mjesečna rotacija), jedan red = jedan run:

```jsonc
{
  "id": "rw_...", "ts": "...", "tenantId": "nmq",
  "runId": "run_...", "agentId": "support", "pattern": "agent",
  "variant": "kreativno",        // A/B varijanta (ako je run bio u eksperimentu)
  "goalId": null, "jobId": "job_...",
  "reward": 0.98,
  "reasons": ["feedback+ (0.3)", "odobreno", "trošak 0.0100 USD"],
  "signals": { "feedback": "up", "approval": "approved", "outcome": "ok", "costUsd": 0.01 },
  "costUsd": 0.01
}
```

Uz fajl postoji i **in-memory keš zadnjih 2000 zapisa** (`cache`), a `recent`/`aggregate` spajaju fajl i keš
i deduplikuju po `id` — tako da ocjena upisana prije nekoliko sekundi ne čeka flush. Svaki `record` mjeri i
`reward_value` (histogram po tenantu i agentu).

**Agregacije:**

| Funkcija | Grupisanje (`groupBy`) | Vraća |
|---|---|---|
| `aggregate(tenantId, { groupBy, sinceMs })` | `agent`, `agentId`, `pattern`, `variant`, `goalId`, `jobId` (ili bilo koje polje) | po grupi: `n`, `sum`, `avgReward` (4 decimale), `costUsd`, `lowRewards` (koliko je ispod 0.35) |
| `ranking(tenantId, { groupBy, sinceMs })` | isto | `{ top: 3, bottom: 3, all }` sortirano po `avgReward` |
| `variantComparison(tenantId, { sinceMs })` | `variant` (bez `unknown`) | lista `{ variant, n, avgReward, costUsd }` sortirana opadajuće |

`ranking` je ono što RSI analiza koristi kao ulaz (`rewards.ranking(..., groupBy: 'agent')` → `row.n >= 3 &&
row.avgReward < 0.5` → nalaz), a `variantComparison` je ono što `GET /v1/admin/experiments` vraća uz listu
eksperimenata.

### Šta reward model **ne vidi** (danas)

`robot.recordRunOutcome` popunjava: `feedback`, `approval`, `outcome`, `costUsd`, `durationMs`, `toolErrors`,
`policyDenied`, `escalations`. On **ne** popunjava `uncited` — dakle težina `uncited` (−0.08) postoji u formuli
i radi kad se signal pošalje direktno (`rewards.score({ uncited: true })`), ali je kroz HTTP put **nikad** ne
dobija. Isto važi za `slowPenaltyPer10s`: `durationMs` se **ne prosljeđuje** u `recordRunOutcome` iz
`src/server/routes.js` (poziv ne sadrži to polje), pa se kazna za sporost realno ne aktivira kroz rute.
Oba su **planirana** da se povežu na trace.

---

## 3. Odakle dolaze signali

Nijedan signal se ne izmišlja. Svaki dolazi iz toka koji već postoji:

| Signal | Ulaz u sistem | Šta se dalje dešava |
|---|---|---|
| **`feedback`** | `POST /v1/feedback` (`src/server/routes.js`) | Upisuje `note` događaj u dugoročnu memoriju, inkrementuje `feedback_total`, pa poziva `robot.recordRunOutcome({ result: {...}, feedback })`. Ocjena: broj → `ratingScale`, `'down'` → `feedbackDown`, sve ostalo → `feedbackUp` |
| **`approval`** | `POST /v1/approvals/:runId` | `body.approve === false` → audit `approval_decision` (`rejected`), događaj u memoriji, `recordRunOutcome({ approval: 'rejected' })`. Odobrenje → ponovni `orchestrator.run` sa `approvedTools` i `recordRunOutcome({ approval: 'approved' })` |
| **`outcome`, `costUsd`, `toolErrors`, `policyDenied`, `escalations`** | `robot.recordRunOutcome` u `src/index.js`, pozvano iz `src/server/routes.js` poslije **svakog** `executeRun` | Iz `result`: `steps` se filtriraju (`type:'tool' && ok === false` → `toolErrors`; `code === 'POLICY_DENIED'` → `policyDenied`), `result.handoffs.length` → `escalations`, `result.status` → `ok`/`pending`/`error` |
| **`durationMs`** | isto mjesto (ali **nije** proslijeđen iz rute — vidi §2) | Ako dođe, aktivira `slowPenaltyPer10s` |
| **`goalId` / `jobId`** | `recordRunOutcome({ jobId, goalId })` | Omogućava `aggregate({ groupBy: 'goalId' \| 'jobId' })` — nagrada po cilju i po poslu |
| **A/B `variant`** | `assignVariant` u ruti prije run-a | Ulazi u reward zapis; `recordExperimentResult` puni brojače eksperimenta |
| **Trace (greške alata)** | `src/observability/trace.js` + `tracer.readFromDisk` | RSI analiza čita trace **sa diska** i traži spanove `tool <ime>` sa `status: 'error'` |
| **Ciljevi** | `goals.portfolio` | RSI pravi nalaz `goal_<id>` za svaki cilj u `at_risk`/`off_track`/`missed` |

Ključna posljedica dizajna: **reward se upisuje i kad run padne** (`outcome: 'error'`) i **kad run čeka
odobrenje** (`outcome: 'pending'`, ocjena bez kazne). Zato je `nmq` tenant sa puno odobrenja i dalje mjerljiv,
a ne „prazan" — što je bitno jer je odobrenje najčešći ishod prvih nedjelja rada.

---

## 4. Prijedlozi poboljšanja

Prijedlog (`proposal`) je zapis koji **nikad ne mijenja ništa sam**. Ima `rationale` (zašto), `evidence`
(dokaz), `riskLevel`, `source` (`rsi` | `self-play` | `watcher` | `org-negotiation` | `manual`) i
`requiresHuman: true` koji je **tvrdo upisan u kod** pri kreiranju.

Sedam tipova (`KINDS` u `src/learning/improvements.js`):

| Tip | Šta se mijenja | Kako se primjenjuje (`apply`) | Kako se vraća (`rollback`) |
|---|---|---|---|
| `prompt` | `systemPrompt` agenta | `controlPlane.deploy(tenantId, target, { patch: { systemPrompt } })` — nova **verzija** agenta, bez restarta | `controlPlane.rollback(tenantId, agentId, version - 1)` |
| `pattern` | `defaultPattern` agenta | `controlPlane.deploy(..., { patch: { defaultPattern } })` | isto (rollback na prethodnu verziju) |
| `policy` | politika (allow/deny/requireApproval/budžet/rate limit) | `policyOverrides.apply(tenantId, { id: 'po_<id>', patch })` — **runtime override**, stupa na snagu odmah | `policyOverrides.revert(tenantId, 'po_<id>')` → `active = false` |
| `kb` | baza znanja (dokument/chunk) | `memory.vectors.ingest(tenantId, { text, source, metadata: { proposalId, tags: ['self-improvement'] } })` | **nema automatskog rollback-a** (vektorski zapis se ne briše kroz ovaj tok) — vidi §10 |
| `action` | konkretna akcija (najčešće iz watchera) | `autonomy.evaluate({ riskLevel, kind: 'act' })` → ako nije `deny`, `orchestrator.run(...)` | **nema** — akcija je izvršena; „povrat" je nova akcija |
| `tool` | kod/MCP server alata | **ne primjenjuje se** → `status = 'needs_code'` | — |
| `code` | kod sistema | **ne primjenjuje se** → `status = 'needs_code'` | — |

### Zašto `tool` i `code` ostaju `needs_code`

U `apply` **nema** grane za `tool` i `code` — `default` grana radi ovo:

```js
default:
  p.status = 'needs_code';
  p.history = [...p.history, { ts: iso(), event: 'needs_code', by }];
  await writeJson(pFile(tenantId), state);
  return { proposal: p, result: null,
           message: 'Ovaj tip prijedloga traži izmjenu koda/MCP servera — ostaje kao zadatak.' };
```

Tri razloga, svi praktični:

1. **Nema rollback-a koda.** `prompt` i `policy` imaju verziju/override koji se vraća jednim pozivom.
   Kod nema — „vrati fajl na prethodno" nije operacija koju ovaj sistem zna da izvede bezbedno.
2. **Nema evaluacije koja je jeftinija od rizika.** Da bi izmjena koda bila automatska, treba zlatni set
   (eval harness — **planiran**, `docs/00` §5 faza v0.3) i sandbox u **odvojenom procesu** (danas je sandbox
   aplikativni sloj u istom procesu, D27).
3. **Bez `needs_code` prijedlog bi „uspio" a ne bi uradio ništa.** Status je pošten: *ovo je zadatak za
   čovjeka*, i vidi se u `GET /v1/admin/proposals?status=needs_code`.

Isti princip važi za RSI: nalaz tipa `tool` se **pretvara u prijedlog** (`suggestedKind: 'tool'`), ali se
nikad ne primjenjuje sam — čovjek dobija tačan dokaz („alat X je pao 7× u zadnjih 200 runova") i odlučuje.

---

## 5. Životni ciklus prijedloga

```
                        ┌──────────────────────────────────────────┐
                        │  IZVORI                                  │
                        │  RSI analiza · self-play · watcher ·     │
                        │  pregovor org · čovjek (manual)          │
                        └──────────────────┬───────────────────────┘
                                           ▼
                        ┌──────────────────────────────────────────┐
                        │  createProposal()                        │
                        │  status: "proposed", requiresHuman: true │
                        │  hash = sha256(kind+target+proposed)[0:16]│
                        └──────────────────┬───────────────────────┘
                                           │  AUDIT: improvement_proposed (pending)
                          ┌────────────────┴────────────────┐
                          ▼                                 ▼
        ┌───────────────────────────┐        ┌───────────────────────────┐
        │ decide(approve: true)      │        │ decide(approve: false)    │
        │ status: "approved"         │        │ status: "rejected"        │
        └────────────┬──────────────┘        └───────────────────────────┘
                     │  AUDIT: improvement_decision (approved)
                     ▼
        ┌───────────────────────────────────────────────────────┐
        │ apply()   (samo za "approved" — inače ValidationError)│
        │  prompt/pattern → control plane deploy (verzija)      │
        │  policy         → runtime override (policy-overrides) │
        │  kb             → vectors.ingest                      │
        │  action         → autonomy.evaluate + orchestrator.run│
        │  tool/code      → status: "needs_code" (kraj)         │
        └──────────┬──────────────────────────────┬─────────────┘
                   │ status: "applied"            │ status: "needs_code"
                   │ AUDIT: improvement_applied   │
                   ▼                              ▼
        ┌───────────────────────────┐   ┌───────────────────────────┐
        │ rollback()                │   │  ZADATAK ZA ČOVJEKA       │
        │ status: "rolled_back"     │   │  (izmjena koda/MCP)       │
        │ AUDIT: improvement_rollback│  └───────────────────────────┘
        └───────────────────────────┘
```

Statusi kroz koje prijedlog prolazi: `proposed` → `approved` \| `rejected` → `applied` →
(`rolled_back` \| `needs_code`). Dodatno: `updateProposal` je dozvoljen **samo** u statusu `proposed`
(dokaz: `self-play` prvo napravi prijedlog, pa mu naknadno dopiše predloženi prompt — i to je jedini način da
`proposed` bude `null` u trenutku kreiranja i `string` u trenutku odluke).

### Šta tačno rade tri funkcije

**`decide(tenantId, id, { approve, by, note })`**
- dozvoljeno samo iz statusa `proposed` (inače `ValidationError: Prijedlog je već odlučen`)
- upisuje `status`, `decidedAt`, `decidedBy`, `decisionNote` i novi unos u `history`
- metrika `improvement_decisions_total` + audit **`improvement_decision`** sa `decision: approved|rejected`
- **ne** primjenjuje ništa — odluka i primjena su odvojeni koraci (namjerno: odobrenje može čekati)

**`apply(tenantId, id, { by })`**
- dozvoljeno samo iz statusa `approved`
- radi **jednu** od pet stvari iz tabele u §4, i to kroz postojeće podsisteme (control plane, policy overrides,
  vektorska baza, orchestrator) — **ne dira `config/*.json`**
- zapisuje `rollbackInfo` (`{ type: 'control-plane', agentId, version }` ili `{ type: 'policy-override', overrideId }`)
  — bez toga `rollback` ne bi znao šta da vrati
- upisuje `appliedAt`, `appliedBy`, `applyResult` (skraćeno: `runId` ili `version` ili `chunks`)
- metrika `improvement_applied_total` + audit **`improvement_applied`** (sa `meta.rollbackInfo`)

**`rollback(tenantId, id, { by })`**
- dozvoljeno samo iz statusa `applied` (inače `ValidationError`)
- `control-plane` → `controlPlane.rollback(tenantId, agentId, max(0, version - 1))`
- `policy-override` → `policyOverrides.revert(tenantId, overrideId)`
- `kb` i `action` **nemaju** rollback (u kodu nema grane) → status se ipak postavlja na `rolled_back`,
  pa je to iskrena rupa (vidi §10)
- metrika `improvement_rollbacks_total` + audit **`improvement_rollback`**

Sva četiri audit zapisa (`improvement_proposed`, `improvement_decision`, `improvement_applied`,
`improvement_rollback`) idu u `data/tenants/<id>/audit/audit.jsonl` — hash-chained, pa je lanac odluka
dokaziv. Test `self-improvement: prijedlog → odobrenje → primjena prompta → rollback` provjerava tri od
četiri zapisa (`proposed`, `applied`, `rollback`).

---

## 6. Runtime politike (`policy-overrides.js`)

**Zašto se `config/policies.json` ne mijenja iz koda.** Tri razloga, i svi su operativni:

1. **Config je „tvorničko stanje".** Ako robot prepiše `config/policies.json`, poslije više nema načina da se
   odgovori na pitanje *„da li je ovo politika koju smo isporučili, ili ju je agent sam izmijenio?"* —
   a to je prvo pitanje svake revizije.
2. **Config je pod git-om, izmjena iz koda pravi nevidljivi diff.** Svaki `apply` bi mijenjao fajl koji je
   dio isporuke i „prljaju" radno stablo; runtime izmjena u `data/` je očekivana i backupirana.
3. **Rollback mora biti jedna operacija.** Vraćanje izmijenjenog JSON fajla na „prethodno" zahtijeva kopiju
   stanja; `policy-overrides.json` sa `active: true/false` je sam svoj rollback.

### Kako override ulazi u `policyResolver`

```js
// src/learning/policy-overrides.js
async active(tenantId) {
  const state = await load(tenantId);
  return state.overrides.filter((o) => o.active).reduce((acc, o) => deepMerge(acc, o.patch), {});
},
activeSync(tenantId) {                       // sinhrono, iz keša — za vrijeme izvršavanja
  const state = cache.get(tenantId);
  if (!state) return {};
  return state.overrides.filter((o) => o.active).reduce((acc, o) => deepMerge(acc, o.patch), {});
},
```

```js
// src/index.js — spaja se NA KRAJU, preko config-a
const policyResolver = (tenantId, { agentId } = {}) => {
  const t = tenantId ?? config.env.defaultTenant;
  const base = resolvePolicy(config.policies, t, { agentId });
  const extra = policyOverrides.activeSync(t);
  return extra && Object.keys(extra).length ? deepMerge(base, extra) : base;
};
```

Bitno: override je **`deepMerge` preko** razriješene politike (defaults + tenant). Zato `policy` prijedlog
mijenja **samo ono što navede** — primjer iz testa dodaje `notify` u `tools.requireApproval`, a sve ostalo
(`deny`, `allow`, `risk`, `budget`) ostaje kako je bilo. `activeSync` postoji zato što se politika čita
**sinhrono** pri svakom run-u (u `runAgent`: `policyResolver(tenantId, { agentId })`), a `active()` je
asinhrona verzija za prikaz/admin.

Kad se policy prijedlog primijeni, u `data/tenants/<id>/learning/policy-overrides.json` stoji:

```jsonc
{
  "overrides": [
    { "id": "po_prop_...", "patch": { "tools": { "requireApproval": ["email_send", "notify"] } },
      "rationale": "Notify je postao rizičan za ovog klijenta",
      "source": "self-improvement", "proposalId": "prop_...",
      "active": true, "appliedAt": "..." }
  ]
}
```

**Kako se vidi razlika tvornička/naučena politika i kako se vraća:**

| Pitanje | Odgovor | Gdje |
|---|---|---|
| Šta je tvornički? | `config/policies.json` (`defaults` + `tenants`) | git |
| Šta je naučeno? | `learning/policy-overrides.json` — svi zapisi sa `active: true` | `data/tenants/<id>/` |
| Šta je efektivno? | `deepMerge(tvorničko, aktivni override-i)` | `policyResolver(tenantId, { agentId })` |
| Kako vratiti? | `rollback(proposalId)` → `revert(overrideId)` → `active = false`, `revertedAt` se upiše | `policyOverrides.revert` |
| Gdje se vidi u logu? | `policy_override.applied` / `policy_override.reverted` (logger **warn** nivo) | logovi + audit `improvement_applied` / `improvement_rollback` |

Rollback **ne briše** zapis — mijenja `active` na `false`. To je namjerno: ostaje dokaz da je politika
nekad bila drugačija i ko ju je odobrio (`proposalId` je u zapisu).

---

## 7. A/B testiranje

Cilj A/B-a ovdje nije „testirati stranicu", nego **testirati ponašanje agenta** (prompt, temperatura, pattern,
model) na **stvarnom saobraćaju**, bez zaustavljanja sistema i bez rizika da se svi klijenti prebace na
neprovjerenu varijantu.

### Korak 1 — raspodjela: `assignVariant`

```js
async assignVariant(tenantId, { agentId, sessionId, runId }) {
  const state = await loadExperiments(tenantId);
  const exp = Object.values(state.experiments).find((e) => e.status === 'running' && e.agentId === agentId);
  if (!exp) return null;
  const bucket = parseInt(sha256({ s: sessionId ?? runId ?? uid('x'), e: exp.id }).slice(0, 8), 16) % 100;
  if (bucket >= exp.splitPct) return { variant: 'control', specPatch: {}, experimentId: exp.id };
  const idx = bucket % exp.variants.length;
  const variant = exp.variants[idx];
  return { variant: variant.name, specPatch: variant.specPatch, experimentId: exp.id };
}
```

Četiri osobine:

1. **Deterministički po sesiji.** Isti `sessionId` + isti `experimentId` → **uvijek isti bucket** (hash je
   SHA-256, prvi 8 hex znakova → `% 100`). Korisnik koji je u razgovoru ne prebacuje se između varijanti usred
   razgovora — što je uslov da poređenje ima smisla. Test to dokazuje: dva poziva sa `ses-1` daju istu varijantu.
2. **`splitPct` kontroliše koliko saobraćaja ulazi u eksperiment.** Bucket `>= splitPct` → `control` sa
   **praznim `specPatch`-om**, tj. agent radi tačno kako je konfigurisan. Time je kontrola stvarna (config),
   a ne „treća varijanta".
3. **Jedan eksperiment po agentu.** `find(...)` uzima **prvi** `running` eksperiment za tog agenta; drugi
   istovremeni eksperiment na istom agentu se **neće** primijeniti (tiho ignorisanje — vidi §10).
4. **Odabir varijante unutar eksperimenta je `bucket % brojVarijanti`** — dakle **nije** ravnomjerna podjela
   između varijanti: brojevi 0–9 uz dvije varijante daju indekse 0,1,0,1,… (ravnomjerno), ali uz tri varijante
   i `splitPct: 10` uzorak je mali i raspodjela je osjetljiva. Ravnomjerna raspodjela (npr. `bucket * n / splitPct`)
   je **planirana**.

### Korak 2 — primjena SAMO na taj run

Ruta (`src/server/routes.js`) prvo pita za varijantu, pa je ubaci u opcije run-a:

```js
let assignment = null;
if (agentId && robot.improvements?.assignVariant) {
  assignment = await robot.improvements.assignVariant(tenantId, { agentId, sessionId, runId: `${tenantId}:${Date.now()}:…` });
}
const runOptions = { ...(options ?? {}),
  ...(assignment?.specPatch && Object.keys(assignment.specPatch).length ? { specPatch: assignment.specPatch } : {}) };
```

Lanac do agenta:

```
assignVariant → specPatch → orchestrator options.specPatch
             → ctx.specPatch (src/orchestration/index.js)
             → runAgent(spec, input, ctx)  (isti ctx ide kroz sve patterne)
             → if (ctx.specPatch) spec = { ...spec, ...ctx.specPatch }   (src/agents/agent.js)
```

Zakrpa je **plitki spread preko spec-a agenta**, pa pokriva sve što je u `config/agents/*.json`:
`temperature`, `maxTokens`, `systemPrompt`, `model`, `maxSteps`, `tools`, `defaultPattern`… i **ne mijenja
katalog** — dakle drugi run istog agenta u isto vrijeme radi po config-u. To je razlika prema `controlPlane.deploy`:
deploy mijenja **verziju agenta za sve**, A/B mijenja **jedan run**.

### Korak 3 — mjerenje

Dvije stvari se mjere paralelno:

1. **Globalno po varijanti** — `recordRunOutcome({ variant, experimentId })` upisuje `variant` u reward zapis,
   pa `variantComparison(tenantId)` daje `avgReward` po varijanti (preko **svih** agenata tog tenanta — vidi §10).
2. **Po eksperimentu** — `recordExperimentResult(tenantId, { experimentId, variant, reward })` puni brojače
   **unutar** eksperimenta: `v.n += 1`, `v.sumReward += reward`, `v.avgReward = sum / n` (4 decimale).
   Poziva se automatski iz `recordRunOutcome` kad postoji `experimentId`.

### Korak 4 — zaključak: `concludeExperiment`

```js
const ranked = [...exp.variants].filter((v) => v.n >= exp.minSamples).sort((a, b) => b.avgReward - a.avgReward);
if (!ranked.length) return { experiment: exp, decision: 'insufficient_data', ranked: exp.variants };
const winner = ranked[0], loser = ranked.at(-1);
const lift = Number((winner.avgReward - loser.avgReward).toFixed(4));
const significant = winner.n >= exp.minSamples && lift > 0.03;
if (significant && promote && controlPlane) {
  await controlPlane.deploy(tenantId, exp.agentId, { patch: winner.specPatch, actor: `experiment:${id}`,
                              note: `A/B pobjednik ${winner.name} (lift ${lift})` });
  exp.result.deployed = true;
}
```

Pravila odlučivanja su **eksplicitna i konzervativna**:

| Uslov | Ishodi |
|---|---|
| Nijedna varijanta nema `minSamples` (default 10) | `decision: 'insufficient_data'` — **ništa se ne mijenja** |
| `lift = winner.avgReward − loser.avgReward` **≤ 0.03** | `decision: 'no_change'` — razlika je u šumu |
| `lift > 0.03` i `promote: true` | `decision: 'promoted'` → `controlPlane.deploy` pobjednikove zakrpe (**trajno**), plus audit `experiment_conclude` |
| `lift > 0.03` i `promote: false` | Zaključeno bez primjene (`deployed` nije postavljen) — čovjek odlučuje ručno |

Prag 0.03 je isti broj kao prag u `rsi.impact` — namjerno: „poboljšanje" znači isto u A/B odluci i u mjerenju
efekta primijenjenog prijedloga.

### Primjer: dvije varijante temperature

```jsonc
// POST /v1/admin/experiments
{
  "agentId": "creative",
  "variants": [
    { "name": "kratko",     "specPatch": { "temperature": 0.1, "maxTokens": 300 } },
    { "name": "kreativno",  "specPatch": { "temperature": 0.9, "maxTokens": 900 } }
  ],
  "splitPct": 100,      // sav saobraćaj ide u eksperiment (nema kontrole iz config-a)
  "minSamples": 10
}
```

Tok:

1. `POST /v1/agents/creative/run` sa `sessionId: "ses-1"` → `assignVariant` → npr. `kreativno` sa
   `specPatch { temperature: 0.9, maxTokens: 900 }`.
2. `runAgent` vidi `ctx.specPatch` i radi sa `temperature 0.9` **samo za taj run** (katalog nije diran).
3. `recordRunOutcome` upiše nagradu sa `variant: 'kreativno'` i pozove `recordExperimentResult`.
4. Poslije 10+ uzoraka po varijanti: `POST /v1/admin/experiments/:id/conclude`.
5. Ako je `kreativno` bolja za > 0.03 → `controlPlane.deploy` postavlja `temperature: 0.9` kao **novu verziju**
   agenta `creative` (test to provjerava: `robot.catalog.get('creative','nmq').temperature === 0.9`).
6. `GET /v1/admin/experiments` vraća listu eksperimenata **i** `variantComparison` (živa prosječna nagrada po
   varijanti iz reward zapisa).

---

## 8. Mjerenje efekta (impact)

A/B poredi **varijante**. `rsi.impact` poredi **vrijeme** — prije i poslije primjene prijedloga. To je odgovor
na pitanje koje svaki menadžer postavi: *„pa je li bolje otkad smo to uradili?"*

Skraćeno (puni kod: `src/learning/rsi.js` → `impact`):

```js
async function impact(tenantId, proposalId) {
  const proposal = await improvements.get(tenantId, proposalId);
  if (!proposal.appliedAt && !proposal.rolledBackAt) return { proposalId, status: 'nije primijenjen', impact: null };
  const at = new Date(proposal.appliedAt ?? proposal.rolledBackAt).getTime();
  const rows = await rewards.recent(tenantId, { limit: 1000 });
  const before = rows.filter((r) => new Date(r.ts).getTime() <  at && (!proposal.target || r.agentId === proposal.target));
  const after  = rows.filter((r) => new Date(r.ts).getTime() >= at && (!proposal.target || r.agentId === proposal.target));
  const delta = before.length && after.length ? Number((avg(after) - avg(before)).toFixed(4)) : null;
  return { ..., before: { n, avgReward }, after: { n, avgReward }, delta,
           verdict: delta === null ? 'nedovoljno podataka'
                  : delta >  0.03 ? 'poboljšanje'
                  : delta < -0.03 ? 'pogoršanje (razmisli o rollback-u)'
                  : 'bez promjene' };
}
```

| Prag | Zaključak |
|---|---|
| `delta > +0.03` | **poboljšanje** |
| `−0.03 ≤ delta ≤ +0.03` | **bez promjene** (razlika je u šumu) |
| `delta < −0.03` | **pogoršanje (razmisli o rollback-u)** — poruka je namjerno uputa, ne automatska akcija |
| `before.length === 0` ili `after.length === 0` | `delta: null` → **nedovoljno podataka** |
| Prijedlog nije primijenjen | `status: 'nije primijenjen'` |

Filtriranje po `proposal.target` znači: za `prompt` prijedlog agenta `support` poredi se **nagrada agenta
`support`** prije i poslije, ne cijelog tenanta. Za `policy` prijedlog (`target: null`) poredi se **cijeli
tenant** — što je i logično, jer politika važi globalno.

**Zašto je ovo bolje od „osjećaja da je bolje":**

1. **Isti signal, isti prag.** „Bolje" nije mišljenje nego `delta` iz istog reward modela, sa pragom koji je
   zapisan u kodu (0.03) i koji se ne mijenja od prijedloga do prijedloga.
2. **Vidi se i pogoršanje.** Sistem koji mjeri samo uspjehe laže; ovdje negativan `delta` eksplicitno kaže
   „razmisli o rollback-u" — i `rollback` je jedna ruta (`POST /v1/admin/proposals/:id/rollback`).
3. **Mjeri se **prije** i **poslije** na istom metru**, pa je poređenje moguće i kad se prompt promijeni.
4. **Nedostatak podataka je priznat.** `nedovoljno podataka` je legitiman ishod; bolje nego lažna tvrdnja
   na 3 uzorka. (Koliko uzoraka je „dovoljno" je **otvoreno pitanje** — vidi kraj.)

---

## 9. Put do pravog RLHF-a (kada i kako)

Ovo je plan, ne stanje. Faze su namjerno razdvojene **preduslovom** — faza se ne počinje dok preduslov prethodne
nije ispunjen, jer svaka sljedeća faza je skuplja i teže se vraća.

| Faza | Šta se radi | Preduslov (mjerljiv) | Trošak (*procjena*) | Rizik |
|---|---|---|---|---|
| **(a) Sada: mjerenje + prijedlozi + A/B** | Reward model na stvarnom saobraćaju, prijedlozi kroz inbox, reverzibilna primjena, A/B po run-u, `impact` | ✅ Ispunjeno — postoji u kodu i testovima | Nula dodatnog troška (koristi postojeće runove) | **Mali**: sve je reverzibilno; glavni rizik je da se rezultati pogrešno protumače na malom uzorku |
| **(b) Sljedeće: dataset iz self-play → SFT/LoRA trening van procesa** | `selfplay.dataset()` (`learning/training-YYYY-MM.jsonl`, samo `passed: true`) → izvoz u SFT/DPO format → trening na GPU-u ili API fine-tune → model se vraća kao **novi provajder/model u config-u** | **≥ nekoliko stotina do hiljada provjerenih primjera** (`score`/`verdict` iz kritičara) i **eval zlatni set** (v0.3, `docs/00` §5) — bez evala se ne zna da li je fine-tune bolji | *procjena*: GPU sati ili API fine-tune po treningu + inženjering za izvoz i verzionisanje modela. **Konkretne cijene i verzije se ne tvrde ovdje — provjeriti kod provajdera u trenutku odluke** | **Srednji**: model se može „pokvariti" na uskom domenu; riješenje je A/B protiv baznog modela i rollback na prethodni model (isti mehanizam kao `prompt` deploy) |
| **(c) Zatim: reward-model trening na ljudskim ocjenama** | Iz `feedback` + `approval` zapisa napraviti parove (izlaz → ocjena) i trenirati **ocjenjivač**; koristi se kao `critic` sa naučenim ocjenama umjesto ručnih kriterija | **Dovoljno ljudskih ocjena** po domenu (red veličine: hiljade, *procjena*) + dokaz da je trenutni reward model stabilan (nema „igranja", §10) | *procjena*: trening + stalno održavanje; ljudsko vrijeme za kvalitet ocjena | **Visok**: pristrasnost ocjenjivača se **nauči** i onda izgleda kao istina; potreban je nezavisan eval set i ljudi koji ga čuvaju |
| **(d) Zatim: online RL na ishodima** | Agent uči iz ishoda poslova/ciljeva u toku rada (nagrada = ostvaren cilj, ne zadovoljstvo korisnika) | **Sandbox u odvojenom procesu** (D27 je aplikativni sloj), tvrdi budžet po eksperimentu, eval koji je jeftiniji od rizika, i dokaz da su brave (§9 u `docs/20`) neprobojne | *procjena*: najveći — trajni compute, tim koji to održava, i novi sloj observability za politiku odlučivanja | **Najviši**: agent koji optimizuje nagradu može naći put oko politike; bez odvojenog sandboxa i limita to je rizik za produkciju, ne za laboratoriju |

**Redoslijed nije proizvoljan:** (b) traži dataset, dataset traži (a). (c) traži ljudske ocjene, koje (a)
tek počinje da skuplja. (d) traži da su (b) i (c) dokazano bolji od bazne linije — inače online RL optimizuje
nešto što ni sami ne znamo da mjerimo.

---

## 10. Ograničenja i zamke

Ovo poglavlje je namjerno neprijatno; svaka tvrdnja je provjerena u kodu.

1. **Reward može biti „igran" — agent može optimizovati ocjenu, a ne ishod.** Reward se sastoji od `feedback`
   (ljudska ocjena), `approval`, `outcome: 'ok'` i **kazne za trošak**. Agent koji nauči da bude kratak,
   pristojan i da ne poziva alate (≈ nula grešaka alata, nula troška) može imati visoku nagradu **a da ne
   uradi posao**. `outcomeOk` se dodjeljuje kad run završi bez greške — ne kad je **zadatak riješen**.
   Pravi lijek je vezivanje nagrade na **ishod** (cilj ostvaren, ticket zatvoren, narudžba potvrđena) —
   to je faza (d) i zahtijeva konektore (vidi `docs/20` §11, prvo ograničenje).
2. **Mali uzorci.** `aggregate` vraća `n` po grupi, ali **nijedan prag u A/B odluci ne provjerava ništa osim
   `n >= minSamples`** (default 10). `rsi.impact` nema prag uzorka uopšte — ako postoje bar jedan zapis prije i
   bar jedan poslije, `delta` se računa i **verdict se izdaje**. Na 10 primjera `+0.04` može biti šum.
   Preporuka u praksi: gledati `before.n`/`after.n` prije nego se povjeruje `verdict`-u.
3. **Pristrasnost ocjenjivača.** `feedback` daje **korisnik** (i to najčešće samo nezadovoljan korisnik —
   zadovoljni ne ocjenjuju). `approval` daje **operater**, koji odobrava ono što mu je poznato. Oba signala
   mjere **zadovoljstvo ljudi**, ne kvalitet ishoda. System to ne koriguje (nema težine po „ko je ocjenjivao",
   nema normalizacije po korisniku).
4. **A/B bez dovoljno saobraćaja.** `splitPct` dijeli **mali** saobraćaj tenanta; `minSamples: 10` po varijanti
   na tenantu sa 20 runova dnevno znači da eksperiment traje danima, a ako je `splitPct: 30`, znatno duže.
   Ako u međuvremenu neko promijeni config agenta, poređenje je nevažeće (sistem to **ne detektuje** i ne
   prekida eksperiment automatski).
5. **Jedan eksperiment po agentu.** `assignVariant` uzima prvi `running` eksperiment (`find`), pa drugi
   istovremeni eksperiment na istom agentu **tiho ne radi ništa** — nema greške, nema upozorenja u API
   odgovoru. Kreiranje drugog eksperimenta bi trebalo da se odbije (**planirano**).
6. **`variantComparison` miješa agente.** Grupisanje je po `variant` **bez** `agentId`, pa ako dva agenta imaju
   eksperimente sa istim imenom varijante (npr. `kontrola`), njihove nagrade se sabiraju u jednu prosječnu
   vrijednost. Grupisanje po `{agentId, variant}` je **planirano**.
7. **Rollback za `kb` i `action` ne postoji.** `rollback` postavlja status `rolled_back`, ali za `kb` ne
   uklanja ingestovane chunkove, a za `action` ne može da „poništi" izvršenu akciju. Status je dakle
   administrativni, ne stvarni povrat — što je iskrena rupa u odnosu na `prompt`/`pattern`/`policy`.
8. **Nedovršeni signali.** `uncited` se nikad ne popunjava kroz HTTP (`recordRunOutcome` ne šalje), a
   `durationMs` se iz rute **ne prosljeđuje** — pa se `slowPenaltyPer10s` realno ne aktivira. Dvije težine u
   formuli su trenutno „mrtve" kroz glavni put.
9. **Reward težine nisu naučene.** `DEFAULT_WEIGHTS` je **ljudska procjena** (0.5 base, 0.3 za 👍, −0.35 za 👎…).
   Nema podataka koji ih potvrđuju na stvarnom saobraćaju; ako se mijenjaju, **istorijske ocjene nisu uporedive**
   (isti run bi danas dobio drugu ocjenu). Verzionisanje težina uz zapis je **planirano**.
10. **RIZIK od preoptimizacije na jedan KPI.** Ako je `ranking` po `pattern` osnova za prijedlog tipa `pattern`,
    agent može završiti na patternu koji daje najbolju **nagradu**, a najgori **trošak po riješenom zadatku**.
    Zato je `costUsd` u agregacijama — ali **ništa automatski ne balansira** nagradu i trošak osim ručnog
    čitanja `ranking`-a.

---

## Otvorena pitanja

1. **Koliko uzoraka je „dovoljno" za `impact`?** Danas je dovoljan **jedan** zapis prije i **jedan** poslije.
   Da li uvesti tvrdi minimum (npr. `n ≥ 20` po strani) i vratiti `nedovoljno podataka` ispod njega — i koji
   broj je odbranjiv za tenanta sa desetinama runova dnevno?
2. **Kako vezati nagradu na ISHOD, a ne na zadovoljstvo?** Koji je prvi konektor koji daje objektivan ishod
   (narudžba potvrđena, ticket zatvoren, cilj ostvaren) i kako izbjeći da se „outcome: ok" i dalje dodjeljuje
   svakom runu koji nije pukao?
3. **Šta raditi sa dva istovremena eksperimenta na istom agentu** — odbiti drugi sa jasnom greškom, ili
   podržati slojevite varijante (npr. prompt × temperatura)? Trenutno drugi **tiho** ne radi, što je najgora
   od tri opcije.
4. **Da li `rolled_back` za `kb` i `action` treba da bude pravi povrat** (brisanje ingestovanih chunkova,
   kompenzaciona akcija) ili treba da se zove drugačije (npr. `retracted`) da ne obećava ono što ne radi?
5. **Kada uvesti verzionisanje reward težina i eval zlatni set** kao preduslov za fazu (b)? Bez toga se
   dataset za fine-tune filtrira ocjenama koje se mogu promijeniti bez traga — a to znači da isti dataset
   nije reproduktivan.
6. **Ko odobrava promjenu reward težina?** One su danas `DEFAULT_WEIGHTS` u kodu (+ opcioni `rewardWeights`
   iz config-a). Ako težine mijenja agent (ili RSI prijedlog tipa `code`), dobijamo situaciju da agent
   podešava metar po kojem se mjeri — da li to ostaje trajno izvan domašaja self-improvementa?
