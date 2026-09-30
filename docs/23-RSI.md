# 23 — RSI: agent koji analizira sebe (u praksi, 2026)

> **Nivo:** v0.3.0 (autonomni nivo, `DECISIONS.md` §9) · **Kod:** `src/learning/rsi.js` (184 linije), `src/learning/rewards.js`,
> `src/learning/improvements.js`, `src/controlplane/registry.js`, `src/learning/policy-overrides.js`,
> `src/observability/trace.js`, `src/observability/audit.js`, `src/server/routes-autonomy.js` (sekcija *RSI*)
> · **Testovi:** `tests/autonomy.test.mjs` (24/24 prolazi, provjereno lokalno) · **Demo:** `scripts/demo.mjs` sekcija 19
> · **Vezani dokumenti:** `DECISIONS.md` §6–§9 — posebno **D46** („RSI: analiza + prijedlog, ne samo-deploy"),
> **D42** (self-improvement bez fine-tuninga) i **D43** (politike se ne mijenjaju u config-u) —
> `docs/19` (plan), `docs/20` (nivoi L0–L4), `docs/21` (prijedlozi poboljšanja i mjerenje efekta),
> `docs/22` (self-play).
>
> **Jedna rečenica:** RSI ovdje znači da agent **prikuplja dokaze o svom radu i predlaže izmjene**, čovjek
> odobrava, a sistem **mjeri efekat i može vratiti** — nije autonomno prepisivanje arhitekture, i namjerno.

---

## 1. Šta RSI znači ovdje

### 1.1 Praktična definicija

**Recursive self-improvement (RSI), praktični nivo:** petlja u kojoj sistem

1. **prikuplja dokaze** o svom radu (nagrade, greške alata, runovi sa greškom, ciljevi u zaostatku),
2. iz njih izvodi **nalaze** (`findings`) sa pragovima — ne „utiscima",
3. pretvara nalaze u **prijedloge** (`kind`, `target`, `rationale`, `evidence`, `expectedImpact`, `riskLevel`),
4. **čovjek odobrava ili odbija** (nikad automatski),
5. primjena ide kroz **verzionisane, reverzibilne** kanale (control plane, runtime policy override, KB),
6. sistem **mjeri efekat** (prije/poslije) i može **vratiti** (rollback).

Ovo je tačno formulacija iz koda (`src/learning/rsi.js`, komentar na vrhu):

> Nivoi koje NE pokriva (i zašto): automatsko pisanje i deploy nove arhitekture ili modela.
> Za to treba (a) eval koji je jeftiniji od rizika, (b) sandbox u drugom procesu, (c) čovjek u lancu.
> Ovaj modul daje tačno ono što tim treba prije toga: **dokaze i predloge**.

### 1.2 Šta RSI ovdje NIJE

| Nije | Zašto | Gdje je granica u kodu |
|---|---|---|
| Autonomno prepisivanje arhitekture | Arhitektura je dokument + kod pod revizijom; analiza gleda samo naše logove | `rsi.analyze` ne čita kod, ne piše kod |
| Automatsko deployovanje prompta | Prijedlog ima `requiresHuman: true`; `apply` traži status `approved` | `improvements.createProposal` / `apply` |
| Samomodifikacija modela (težine) | U procesu nema treninga (D2: `dependencies: {}`) | van sistema (`docs/22` §6.5) |
| „Agent koji se sam poboljšava preko noći" | Odluka je čovjekova; RSI samo **predlaže** | `docs/20` nivoi L0–L4 + `HUMAN_ONLY` kategorije |
| Mjerenje posljedica u svijetu | Reward model vidi samo sistemske signale | `src/learning/rewards.js` (feedback, ishod, trošak…) |

---

## 2. Nivoi RSI-a

Tabela je namjerno konzervativna: **sve što je automatizovano danas** je „analiza + predlog", a ne „izmjena".

| Nivo | Šta je automatizovano danas | Šta traži čovjeka | Rizik | Status u kodu |
|---|---|---|---|---|
| **1. Prompt** | Nalaz iz niske nagrade agenta → prijedlog `kind: 'prompt'` | Tekst novog prompta, odobrenje, primjena, mjerenje | **Srednji** — mijenja ponašanje agenta prema svim korisnicima | ✅ `analyze` → `suggestedKind: 'prompt'`; `apply` → `controlPlane.deploy` (verzija + rollback). ⚠️ `proposed`/`current` su `null` (nema generatora) |
| **2. Politika (policy)** | **Ništa** — `analyze` ne generiše politike | Sve: prijedlog dolazi iz watchera ili ručno | **Visok** — politika odlučuje šta agent smije | ⚠️ `improvements` podržava `kind: 'policy'` + `policyOverrides` (reverzibilno), ali RSI ga **ne predlaže** (`suggestedKind` nikad nije `'policy'`) |
| **3. Baza znanja (kb)** | **Ništa** — nema nalaza tipa „pitanje bez odgovora" | Odobrenje teksta dokumenta | Nizak/srednji — KB mijenja činjenice koje agent citira | ⚠️ `kind: 'kb'` postoji i `apply` radi `memory.vectors.ingest`, ali RSI nalaz ne postoji (planirano: iz `memory_search` promašaja) |
| **4. Izbor patterna** | Nalaz iz niske nagrade **patterna** → prijedlog `kind: 'pattern'` | Odobrenje + provjera da pattern postoji | Srednji — mijenja tok izvršavanja (broj LLM poziva, budžet) | ✅ `analyze` (`low_reward_pattern_*`) → `apply` deployuje `defaultPattern` |
| **5. Alati / kod** | Nalaz iz grešaka alata (`tool_errors_<tool>`) → prijedlog `kind: 'tool'` | **Sve** — kod/MCP server se mijenja ručno | Srednji/visok — alat dira vanjski sistem | ✅ nalaz postoji; `apply` ga **namjerno** ostavlja kao zadatak: status `needs_code` |
| **6. Arhitektura** | Ništa (i ne treba) | Čovjek piše dokument/odluku | Visok | ❌ planirano kao **dokument**, ne kao kod (`DECISIONS.md`, ovaj dokument) |
| **7. Model (težine)** | Ništa | Trening van procesa + eval | Visok | ❌ planirano (`docs/22` §6; `DECISIONS.md` §7: eval harness ❌ planirano) |

Pravilo koje iz tabele slijedi: **RSI smije da automatizuje samo ono što je (a) reverzibilno i (b) mjerljivo.**
Zato su nivoi 1 i 4 automatizovani do predloga, nivo 5 se zaustavlja u `needs_code`, a nivoi 6–7 nisu ni predviđeni.

To pravilo je i **ugovorna odluka**, ne samo opis: **D46** („RSI: analiza + prijedlog, ne samo-deploy")
kaže da nivoi prompt/politika/KB/pattern jesu u kodu, a alati/kod/arhitektura/model **traže čovjeka**, uz
obrazloženje: *„Recursive self-improvement bez evaluacije i nadzora je rizik, ne funkcija."*

---

## 3. Self-analiza (`rsi.analyze`)

### 3.1 Izvori nalaza

`analyze(tenantId, { sinceDays = 7 })` radi četiri provjere, u ovom redu:

| # | Izvor | Šta čita | Uslov → nalaz |
|---|---|---|---|
| 1 | **Nagrade po agentu** | `rewards.ranking(tenantId, { groupBy: 'agent', sinceMs })` → `bottom` (3 najgora) | `n >= 3` **i** `avgReward < 0.5` → `low_reward_agent_<key>`, `suggestedKind: 'prompt'` |
| 2 | **Nagrade po patternu** | `rewards.ranking(…, { groupBy: 'pattern' })` → `bottom` (3 najgora) | isto (`n >= 3`, `avgReward < 0.5`) → `low_reward_pattern_<key>`, `suggestedKind: 'pattern'` |
| 3a | **Greške alata iz trace-a** | `tracer.readFromDisk({ tenantId, limit: 200 })` → spanovi `name: "tool <x>"` sa `status: 'error'` | `n >= 3` grešaka za isti alat → `tool_errors_<tool>`, `suggestedKind: 'tool'` |
| 3b | **Runovi sa greškom** | isti trace skup → `run.status === 'error'` | `>= 5` runova → `run_errors`, `area: 'reliability'`, `suggestedKind: 'prompt'` |
| 4 | **Ciljevi u zaostatku** | `goals.portfolio(tenantId).atRisk` (statusi `at_risk`, `off_track`, `missed`) | svaki cilj iz `atRisk` → `goal_<id>`, `suggestedKind: 'action'` |

Na kraju: `metrics.set('rsi_findings', { tenant }, findings.length)` i vraća
`{ tenantId, sinceDays, findings, at: iso() }`.

### 3.2 Pragovi i severity

| Nalaz | Uslov | Severity | `suggestedKind` | Target prijedloga |
|---|---|---|---|---|
| `low_reward_agent_<agent>` | `n ≥ 3` i `avgReward < 0.5` | `high` ako `avgReward < 0.35`, inače `medium` | `prompt` | agentId |
| `low_reward_pattern_<pattern>` | `n ≥ 3` i `avgReward < 0.5` | uvijek `medium` | `pattern` | pattern (kao string) |
| `tool_errors_<tool>` | `≥ 3` greške u zadnjih 200 trace redova | `high` ako `≥ 10`, inače `medium` | `tool` | ime alata |
| `run_errors` | `≥ 5` runova sa `status: 'error'` | `high` | `prompt` | `'runs'` (nije agent — vidi §9.5) |
| `goal_<id>` | cilj u `atRisk` | `high` ako `off_track`/`missed`, inače `medium` | `action` | goalId |

**Napomena o `avgReward`:** to je izlaz reward modela (`src/learning/rewards.js`), jedna ocjena 0–1 po runu.
Bazna vrijednost je `0.5` (`DEFAULT_WEIGHTS.base`), pa „nagrada 0.5" znači „ništa se nije dogodilo ni dobro ni
loše" — zato je prag `< 0.5` strog, a `< 0.35` (visok rizik) odgovara runu sa najmanje jednom ozbiljnom kaznom
(`outcomeError −0.35`, `feedbackDown −0.35`, `rejected −0.25`…).

### 3.3 Primjer izlaza

```jsonc
{
  "tenantId": "nmq",
  "sinceDays": 7,
  "at": "2026-09-30T09:12:41.882Z",
  "findings": [
    {
      "id": "low_reward_agent_creative",
      "severity": "high",
      "area": "agent",
      "subject": "creative",
      "message": "Agent \"creative\" ima prosječnu nagradu 0.31 na 5 runova",
      "evidence": { "key": "creative", "n": 5, "sum": 1.55, "avgReward": 0.31, "costUsd": 0.0212, "lowRewards": 4 },
      "suggestedKind": "prompt"
    },
    {
      "id": "tool_errors_crm_upsert",
      "severity": "medium",
      "area": "tool",
      "subject": "crm_upsert",
      "message": "Alat \"crm_upsert\" je pao 4x u zadnjih 137 runova",
      "evidence": { "tool": "crm_upsert", "errors": 4 },
      "suggestedKind": "tool"
    },
    {
      "id": "goal_goal_0munv3k2",
      "severity": "high",
      "area": "goal",
      "subject": "goal_0munv3k2",
      "message": "Cilj \"Rast prihoda\" je off_track (48% vs očekivano 62%)",
      "evidence": { "id": "goal_0munv3k2", "title": "Rast prihoda", "status": "off_track", "pct": 48, "expected": 62, "deadline": "…", "owner": "cro" },
      "suggestedKind": "action"
    }
  ]
}
```

**Iskrene granice analize (dokazi iz koda):**

- Gleda se **samo 3 najgore** grupe po grupisanju (`ranking()` vraća `top: 3` i `bottom: 3`), pa 4. najgori
  agent nikad ne ulazi u nalaz.
- **Trace se čita samo za tekući dan** (`readFromDisk` default `date = new Date()`, `limit: 200`, `tail: true`),
  bez obzira na `sinceDays: 7`. Za `sinceDays = 7` analiza **ne čita** 7 dana trace-ova — čita današnji fajl.
  Nagrade se agregiraju po `sinceMs`, pa su one jedini izvor koji stvarno poštuje prozor.
- `const denials = {}` je deklarisan u kodu i **nikad se ne puni** (mrtav kod — planirano: brojati odbijene
  politike iz spanova/audita i predlagati `kind: 'policy'`).
- Parametri `catalog`, `cost`, `autonomy`, `memory` se prosleđuju u `createRsi`, a **ne koriste** se u tijelu
  modula (priprema za buduće provjere: trošak po riješenom zadatku, memorija bez odgovora, autonomija po agentu).
- Nema nalaza za **trošak**, **kašnjenje**, **PII/tajne u odgovorima** ni **ponavljanje istog alata**
  (`status: 'loop_prevented'`) — sve to postoji u podacima, ali analiza to još ne čita.

---

## 4. Od nalaza do prijedloga

### 4.1 `rsi.propose` — mapiranje nalaz → prijedlog

```js
const kind = f.suggestedKind ?? 'prompt';
const proposal = await improvements.createProposal(tenantId, {
  kind,
  target: kind === 'policy' ? null : f.subject,
  current: null,                       // nema „prije" — planirano
  proposed: null,                      // nema „poslije" — čovjek ili generator
  rationale: `RSI: ${f.message}`,
  evidence: [f.evidence],
  expectedImpact: kind === 'prompt' ? 'veća nagrada i manje padova'
                 : kind === 'pattern' ? 'bolji izbor patterna za dati domen'
                 : 'manje grešaka',
  riskLevel: f.severity === 'high' ? 'high' : 'medium',
  source: 'rsi',
});
```

| Polje prijedloga | Vrijednost iz RSI-ja | Zašto je tako |
|---|---|---|
| `kind` | `suggestedKind` nalaza (`prompt`/`pattern`/`tool`/`action`) | Određuje **koji** kanal primjene (`improvements.apply` switch) |
| `target` | `null` za `policy`, inače `subject` (agent, pattern, alat, goal id) | Za politiku nema „agenta" — mijenja se pravilo |
| `rationale` | `"RSI: " + message` | Čovjek u inbox-u prvo čita **zašto** |
| `evidence` | `[f.evidence]` — sirovi agregat/objekat | Bez dokaza prijedlog je mišljenje (§4.3) |
| `expectedImpact` | po `kind`-u (vidi kod) | Služi za kasniju provjeru da li je obećanje ispunjeno |
| `riskLevel` | `high` ako je nalaz `high`, inače `medium` | Određuje koliko pažnje traži odobrenje |
| `source` | `'rsi'` | Audit i filtriranje (`GET /v1/admin/proposals?status=proposed`) |

`improvements.createProposal` dodaje još: `id` (`prop_…`), `ts`, `status: 'proposed'`, **`requiresHuman: true`**,
`history: [{event: 'proposed'}]`, `hash = sha256({kind, target, proposed}).slice(0,16)`, i upisuje
**audit** sa `decision: 'require_approval'`, `outcome: 'pending'`.

### 4.2 `rsi.cycle` — pun ciklus

```js
const cycle = await robot.rsi.cycle('nmq', { sinceDays: 7, autoPropose: true });
// → { ...analyze(), proposals: [{ findingId, proposalId, kind }, …] }
```

- `autoPropose: false` daje **samo analizu** (za dashboard ili „dry run" prije uključivanja).
- Uvijek se upisuje audit: `action: 'rsi_cycle'`, `args: { findings, proposals, sinceDays }`.
- Metrika: `nmq_rsi_proposals_total` (counter, po tenantu).
- Ako `improvements` nije dostupan, `propose` se prekida (`if (!improvements) break;`) — analiza i dalje radi.

### 4.3 Zašto je `evidence` obavezan

Prijedlog bez dokaza je **mišljenje modela**; prijedlog sa dokazom je **tvrdnja koja se može provjeriti**.
`evidence` mora omogućiti čovjeku da **bez ponovnog pokretanja analize** odgovori na tri pitanja:

1. **Koliko uzorka?** (`n`, `errors`, `total`) — je li 3 runa dovoljno za promjenu prompta?
2. **Šta je tačno izmjereno?** (agregat nagrada, broj grešaka alata, status cilja)
3. **Kako ću poslije znati da je pomoglo?** (`expectedImpact` + mjerenje u §5)

Danas je `evidence` **snimak objekta**, ne referenca: za nalaz iz grešaka alata to je `{ tool, errors: 4 }` —
**nema `runId`-jeva ni `spanId`-jeva**, pa čovjek ne može otvoriti konkretan trace (`GET /v1/runs/:runId`).
Planirano: u `analyze` prikupiti prvih N `runId` vrijednosti po alatu i staviti ih u `evidence`.

---

## 5. Mjerenje efekta (`rsi.impact`)

### 5.1 Kako radi

```js
const impact = await robot.rsi.impact('nmq', proposalId);

// korak 1: prijedlog mora biti primijenjen ili vraćen
if (!proposal.appliedAt && !proposal.rolledBackAt) return { proposalId, status: 'nije primijenjen', impact: null };

// korak 2: granica = trenutak primjene (ili rollback-a)
const at = new Date(proposal.appliedAt ?? proposal.rolledBackAt).getTime();

// korak 3: nagrade, podijeljene na prije/poslije; po target agentu ako target postoji
const rows = await rewards.recent(tenantId, { limit: 1000 });
const before = rows.filter((r) => new Date(r.ts).getTime() <  at && (!proposal.target || r.agentId === proposal.target));
const after  = rows.filter((r) => new Date(r.ts).getTime() >= at && (!proposal.target || r.agentId === proposal.target));
const delta  = before.length && after.length ? avg(after) − avg(before) : null;
```

Pragovi verdikta (hardkodovani, `±0.03`):

| Verdikt | Uslov | Šta raditi |
|---|---|---|
| `nedovoljno podataka` | `delta === null` (nema redova prije **ili** poslije) | Sačekati više runova; **ne** zaključivati |
| `poboljšanje` | `delta > 0.03` | Ostaviti; upisati u izvještaj (i u KB tima ako je prompt) |
| `bez promjene` | `−0.03 ≤ delta ≤ 0.03` | Ostaviti ako je izmjena jeftina, ili vratiti ako dodaje složenost |
| `pogoršanje (razmisli o rollback-u)` | `delta < −0.03` | **Rollback** (ruta `…/rollback`) + zapis u audit |

Metrika: `nmq_rsi_impact_delta` (histogram, po `kind`).

### 5.2 Rollback — šta se stvarno vraća

`improvements.rollback` zna da vrati **samo ono što je primijenio**:

| `kind` | `rollbackInfo` | Šta rollback radi |
|---|---|---|
| `prompt`, `pattern` | `{ type: 'control-plane', agentId, version }` | `controlPlane.rollback(tenantId, agentId, version − 1)` — vraća **prethodnu deployovanu verziju** (verzije se akumuliraju) |
| `policy` | `{ type: 'policy-override', overrideId }` | `policyOverrides.revert` → stavlja `active: false` (tvornička politika iz `config/policies.json` ostaje netaknuta) |
| `kb` | nema | **Ne postoji automatski rollback** — ubačeni dokument ostaje; planirano: `memory.vectors.remove` po `docId`/`metadata.proposalId` |
| `action` | nema | Akcija je već izvršena u svijetu; rollback nije moguć (zato `action` ide kroz autonomiju i odobrenje) |

### 5.3 Koliko uzorka treba (procjena)

Da bi se razlika od `0.03` na skali 0–1 razlikovala od šuma (procjena, **nije** izmjereno u projektu):

| Situacija | Minimum po strani | Zašto |
|---|---|---|
| Prompt sa velikim efektom (ozbiljno krštenje politike) | **n ≥ 10** | vidljivo i na malom uzorku |
| Tipična izmjena prompta (`±0.05`) | **n ≥ 30** | ispod toga jedan loš dan prevagne |
| Izmjena patterna (mijenja broj koraka i trošak) | **n ≥ 30** i poređenje troška | efekat na nagradu i na novac nisu isti signal |
| „Pogoršanje" kao osnov za **rollback** | **n ≥ 15** po strani **i** pad u najmanje dva dana | izbjegava panični rollback zbog jednog incidenta |

U kodu ovih pragova **nema** — `impact` vraća brojeve i verdikt, a odluku nosi čovjek.

### 5.4 Iskrene slabosti mjerenja

1. **Prozor je ograničen podacima, ne vremenom.** `rewards.recent()` čita **tekući mjesec**
   (`learning/rewards-YYYY-MM.jsonl` za `new Date()`) + in-memory keš. Prijedlog primijenjen prošlog mjeseca
   ima prazan „prije" → verdikt `nedovoljno podataka`, iako su podaci postojali.
2. **Nema kontrolne grupe.** „Prije/poslije" miješa efekat izmjene sa sezonom, kampanjom, promjenom saobraćaja
   i svim drugim izmjenama u istom periodu. A/B eksperimenti (`improvements.createExperiment`) su jedini
   mehanizam koji ovo rješava — i zato ih treba koristiti za svaku izmjenu prompta koja je „blizu" pragu.
3. **Nema statističke značajnosti.** `±0.03` je heuristički prag, ne test. Sa n=3 na jednoj strani „+0.05"
   je slučajnost.
4. **Za `target: null` (politika) poredi se cijeli tenant** — efekat jedne politike se utapa u sve ostale runove.
5. **Nema automatskog podsjetnika.** Proces „7 dana" iz §6 je **konvencija**, ne kod: nema tajmera koji
   upozorava da prijedlog čeka mjerenje (planirano: watcher/cron koji traži `applied` prijedloge starije od 7 dana
   i otvara „review impact" zadatak).

---

## 6. Human-in-the-loop RSI

### 6.1 Tok

```
[noću, cron 02:00]
   rsi.cycle(tenantId, { sinceDays: 7 })
        │  analyze() → findings (dokazi)
        │  propose() → prijedlozi (status: proposed, requiresHuman: true)
        ▼
[inbox]  GET /v1/admin/proposals?status=proposed
        │
        ├─ čovjek ODBIJA  → POST /v1/admin/proposals/:id/decide {approve:false, note:"…"}
        │                    (status: rejected, audit: improvement_decision)
        │
        └─ čovjek ODOBRAVA → POST /v1/admin/proposals/:id/decide {approve:true}
                             │
                             ├─ ODOBRENO (status: approved)  ← ovdje može stati (čeka prozor za primjenu)
                             ▼
                        POST /v1/admin/proposals/:id/apply
                             │  prompt/pattern → controlPlane.deploy (nova verzija + audit)
                             │  policy         → policyOverrides.apply (aktivan override)
                             │  kb             → memory.vectors.ingest
                             │  tool/code      → status: needs_code (zadatak za čovjeka)
                             ▼
                        PRIMIJENJENO (status: applied, appliedAt, rollbackInfo)
                             │
                     [7 dana rada — konvencija]  GET /v1/admin/proposals/:id/impact
                             │
                        ├─ poboljšanje / bez promjene → KEEP
                        └─ pogoršanje → POST /v1/admin/proposals/:id/rollback
```

### 6.2 Šta čovjek MORA vidjeti prije odobrenja

| Šta | Gdje živi | Zašto je obavezno | Stanje |
|---|---|---|---|
| **Diff prompta** (prije → poslije) | `current` i `proposed` | Bez diffa se odobrava naslijepo; prompt je ponašanje agenta | ⚠️ RSI ostavlja oba `null` — diff postoji samo za self-play prijedloge (`docs/22` §7) |
| **Dokazi** | `evidence[]` | Provjerljivost podataka (§4.3) | ✅ (bez `runId` referenci — planirano) |
| **Očekivani efekat** | `expectedImpact` | Da se poslije može reći „jesmo li pogodili" | ✅ |
| **Rizik** | `riskLevel` (`low`/`medium`/`high`) | Visok rizik traži više od jednog pregleda | ✅ |
| **Obim primjene** | `kind` + `target` | Prompt jednog agenta ≠ politika cijelog tenanta | ✅ |
| **Plan vraćanja** | `rollbackInfo` | Čovjek mora znati da postoji izlaz | ⚠️ postoji **poslije** primjene, ne u prijedlogu (planirano: predeklarisati) |
| **Ko je predložio** | `source` (`rsi` \| `self-play` \| `watcher` \| `manual`) | Odgovornost i „koliko vjerujem izvoru" | ✅ |

Role: `decide` traži rolu **`approve`**, `apply` i `rollback` traže **`admin`**, a postavljanje per-agent
budžeta traži **`owner`** — dakle i sam lanac odobravanja je pod pravima, ne samo pod navikom.

### 6.3 Audit trag (dokaz da je čovjek odlučio)

| Događaj | `action` u auditu | `decision` | `outcome` |
|---|---|---|---|
| Prijedlog otvoren | `improvement_proposed` | `require_approval` | `pending` |
| Odluka | `improvement_decision` | `approved` \| `rejected` | `ok` |
| Primjena | `improvement_applied` | `allow` | `ok` (+ `meta.rollbackInfo`) |
| Vraćanje | `improvement_rollback` | `allow` | `ok` |
| Ciklus analize | `rsi_cycle` | `allow` | `ok` |

Audit je hash-chained (`src/observability/audit.js`), pa se naknadno „popravljanje" istorije obara
verifikacijom (`node src/cli.js audit-verify`) — to je ono što RSI čini **dokazivim**, a ne samo korisnim.

---

## 7. Zašto NE automatsko samo-deployovanje

Četiri konkretna razloga, svaki sa stanjem u kodu:

### 7.1 Ne postoji evaluacija koja je jeftinija od rizika

`DECISIONS.md` §7 eksplicitno vodi **„Eval harness (zlatni set) — ❌ planirano"**. Bez zlatnog seta nema
načina da se prije deploy-a provjeri **regresija** na slučajevima koji su ranije radili. Self-play dataset i
`critic` **nisu** eval harness: judge je isti model, nema holdout-a, nema fiksnog seta, nema poređenja
verzija. Deploy bez toga je eksperiment na živim korisnicima — a to je upravo ono što `docs/19` i `docs/22`
§10 odgađaju do izgradnje harness-a.

### 7.2 Agent ne vidi posljedice van sistema

Agent djeluje alatima (`email_send`, `invoice_create`, `crm_upsert`, `ticket_create`, MCP serveri). Reward
model vidi **sistemske** signale: feedback, ishod, odobrenje/odbijanje, greške alata, trošak, trajanje
(`src/learning/rewards.js`, `DEFAULT_WEIGHTS`). On **ne vidi** da li je kupac otišao, da li je faktura
proknjižena pogrešno, da li je mejl završio u spam-u. Automatski deploy optimizuje ono što je mjereno, a ne
ono što je važno — klasičan Goodhart.

### 7.3 Drift i petlja povratne sprege

`solver` i `judge` su u default konfiguraciji **isti model**; self-play dataset se gradi iz judge-ovih
verdikata; prompt se mijenja na osnovu tog dataset-a; nova petlja mjeri istim judge-om. Rezultat je
**korelisana greška** koja se vremenom pojačava: model „nauči" da zadovolji sudiju (dužina, citati, ton), a ne
da riješi zadatak. Automatski deploy uklanja jedini element koji ovu petlju lomi — **čovjeka** sa vanjskim
kriterijem. Uz to, reward model ima **fiksne težine** (`DEFAULT_WEIGHTS`), pa je i on meta optimizacije
(npr. kraći odgovori izbjegavaju `slowPenaltyPer10s`, citati izbjegavaju `uncited`).

### 7.4 Regulatorno i ugovorno pitanje

- **GDPR/DPA:** podaci tenanta se koriste za izmjenu ponašanja sistema; svaka takva obrada mora biti pokrivena
  ugovorom i dokumentovana (`docs/08`, `docs/17`). Dataset za trening je dodatni korak koji traži izričitu
  osnovu.
- **Odgovornost:** ako agent sam promijeni politiku i pošalje pogrešan mejl klijentu, **nema potpisa**. Kod
  human-in-the-loop to je odluka čovjeka sa imenom u auditu (`decidedBy`, `appliedBy`).
- **Enterprise zahtjev:** `DECISIONS.md` D15 (governance) i D34 (produkcijske brave) traže da `high` rizik
  **uvijek** traži čovjeka; `autonomy.js` ima `HUMAN_ONLY` kategorije koje se ne mogu zaobići ni na L4.
- **Revizija:** bez `requiresHuman` i hash-chained audita, sistem se ne može dokazati kao „pod kontrolom" —
  a to je blocker #1 za prodaju (`docs/00` §3).

### 7.5 Šta bi bio preduslov da se dozvoli (automatizacija za uski `kind`)

| Preduslov | Zašto | Kako bi izgledalo |
|---|---|---|
| **Eval harness sa zlatnim setom** | Bez njega nema regresione provjere | `src/eval/harness.js` + `data/tenants/<id>/eval/golden.jsonl` (§10) |
| **Sandbox u drugom procesu** | Test kandidata ne smije dirati produkcijske alate | `src/core/sandbox.js` nivo `strict` + izolovan proces/kontenjer |
| **Budžet koji je fail-closed** | Automatika bez limita je finansijski rizik | `createBudget` u ruti + per-agent `budgetUsdMonth` (danas se ne primjenjuje u self-play-u, `docs/22` §8.4) |
| **Automatski rollback sa okidačem** | Ako se metrika pogorša, sistem se sam vraća bez čekanja čovjeka | Watcher: `impact` delta < −0.03 uz `n ≥ 15` → `improvements.rollback` (planirano) |
| **Canary / A/B sa `minSamples`** | Dokaz prije nego izmjena dođe do svih | `improvements.createExperiment` već postoji (`splitPct`, `minSamples`, `lift > 0.03`) |
| **Kill switch** | Jedna komanda zaustavlja automatiku | Tenant kill switch (`status.json`) + `planned` gating po `kind`-u |
| **Nivo autonomije po vrsti izmjene** | „Automatizuj prompt, nikad politiku" | `autonomy.setLevel(tenantId, agentId, level)` + novo polje „koji `kind` se smije sam primijeniti" (planirano) |

Do tada, **jedina** automatska radnja ostaje: analiza i otvaranje prijedloga. To je namjerno mala površina.

---

## 8. Arhitektura koja ovo omogućava

RSI nije moguć bez slojeva koji su izgrađeni u v0.1–v0.2. Tabela pokazuje **šta RSI dobija** od svakog sloja
i **šta bi se izgubilo** bez njega.

| Sloj | Fajl / putanja | Šta RSI dobija | Bez toga |
|---|---|---|---|
| **Trace/span** | `src/observability/trace.js`, `data/tenants/<id>/traces/YYYY-MM-DD.jsonl` | Nalaze o greškama alata i runovima (`tool <x>` sa `status: 'error'`) | Nema dokaza o kvarovima — samo agregati nagrada |
| **Reward model** | `src/learning/rewards.js`, `learning/rewards-YYYY-MM.jsonl` | Jednu ocjenu 0–1 po runu, `ranking`/`aggregate`/`variantComparison` — osnovu za „agent/pattern radi loše" | Nema kriterija za „loše"; prijedlozi bi bili nagađanje |
| **Hash-chained audit** | `src/observability/audit.js`, `audit/audit.jsonl` | Nepromjenjiv trag: ko je predložio, odobrio, primijenio, vratio | Nema dokazivosti → nema enterprise prodaje |
| **Kontrolna ravan (verzije)** | `src/controlplane/registry.js`, `data/_control/agents.json` | `deploy` → nova verzija, `rollback(version − 1)`, `pause`/`retire`, per-agent `budgetUsdMonth`, per-agent ključevi | Izmjena prompta bi bila „prepiši config" — bez verzije i bez povratka |
| **Izolacija po tenantu** | `catalog.setOverride(tenantId, …)` (D33), `data/tenants/<id>/…` | Deploy za jednog klijenta ne mijenja ponašanje drugom u istom procesu | Jedan `deploy` bi pokvario sve klijente — automatska izmjena bila bi nesaglediva |
| **Runtime politike** | `src/learning/policy-overrides.js`, `learning/policy-overrides.json` | `apply`/`revert` izmjena politike **bez** diranja `config/policies.json` (vidi se razlika „tvorničko" vs „naučeno") | Politički prijedlog bi tražio restart/deploy config-a |
| **A/B eksperimenti** | `src/learning/improvements.js` (`createExperiment`, `assignVariant`, `recordExperimentResult`, `concludeExperiment`) | Kontrolnu grupu, determinističko grananje po `sessionId`, `minSamples`, provjeru `lift > 0.03` prije promocije | Prije/poslije bez kontrole (§5.4) |
| **Metrike** | `src/observability/metrics.js` → `GET /metrics` | `nmq_rsi_findings` (gauge), `nmq_rsi_proposals_total`, `nmq_rsi_impact_delta`, `nmq_improvement_*`, `nmq_controlplane_deploys_total` | Nema alerta ni dashboard-a; RSI bi bio „nevidljiv" u operacijama |
| **Ciljevi i watcheri** | `src/goals/manager.js` (`portfolio().atRisk`), `src/goals/watchers.js` | Nalaze tipa „cilj skreće" i ulaz za `kind: 'action'` | RSI bi gledao samo agente, ne poslovni ishod |
| **Autonomija (L0–L4)** | `src/core/autonomy.js`, `config/autonomy.json` | Granicu šta se smije izvršiti bez čovjeka (`HUMAN_ONLY` se ne zaobilazi) | Nema okvira za bilo kakvu automatizaciju (`apply` za `action` zove `autonomy.evaluate`) |
| **Kontrolne rute** | `src/server/routes-autonomy.js` | `GET /v1/admin/rsi/analyze`, `POST /v1/admin/rsi/cycle`, `GET /v1/admin/proposals/:id/impact`, `GET /v1/admin/rewards` | RSI bi bio biblioteka bez operativnog ulaza |

Zaključak: **RSI je funkcija infrastrukture, ne „pameti modela".** Zato je u v0.3 prvo izgrađen reward model,
verzije, audit i mjerenje — a analiza je „samo" čitanje tih podataka.

---

## 9. Ograničenja

1. **Analiza gleda samo naše podatke.** Sve što RSI zna je u `data/tenants/<id>/`: nagrade, trace, ciljevi.
   Nema vanjskog istinitog kriterija (da li je kupac zadovoljan, da li je faktura tačna, da li se ticket vratio).
2. **Mali uzorci i niski pragovi.** `n ≥ 3` za agenta/pattern je statistički ništa; default prozor je 7 dana;
   `bottom` pokriva samo 3 najgore grupe. Realno je da se prijedlog otvori zbog **jednog** lošeg dana.
3. **Ne mjeri dugoročni efekat.** `impact` poredi sve redove prije/poslije bez prozora, a podaci su ograničeni
   na tekući mjesec; nema kontrole za sezonu, kampanju ni druge istovremene izmjene; nema koštane analize
   (koliko je izmjena „vrijedila" kroz 30/90 dana).
4. **Ne predlaže arhitekturne promjene.** To je svjesna granica: arhitektura se mijenja **dokumentom i
   odlukom** (`DECISIONS.md`), pa je „RSI nivo 6" u tabeli §2 označen kao ❌ — planirano kao dokument, ne kod.
5. **Nalaz `run_errors` ima target `'runs'`** — taj string nije ni agent ni pattern, pa prijedlog `kind: 'prompt'`
   sa `target: 'runs'` i `proposed: null` **prolazi** kroz `controlPlane.deploy`: `patch.systemPrompt` postaje
   string `"null"`, što je „truthy", pa provjera `if (!base && !patch.systemPrompt)` **ne** baca `NotFoundError`,
   nego se tiho kreira override za nepostojećeg agenta `runs`. Planirano: validacija `proposed` (§9.8) i
   `target: null` ili mapiranje na agenta iz trace-a (`run.agentId`).
6. **`impact` mjeri efekat na nagradu, ne na cilj.** Ako cilj (`goal`) kasni, a nagrada agenta raste, RSI će
   reći „poboljšanje" — iako poslovni ishod nije popravljen.
7. **Nema deduplikacije prijedloga.** `rsi.cycle` pokrenut dva puta u istoj noći daje dva prijedloga za isti
   nalaz (`id` je novi `uid`, `hash` se računa iz `{kind, target, proposed}` i sa `proposed: null` je
   **identičan** — pa hash može poslužiti kao ključ deduplikacije; planirano).
8. **Prazan `proposed`/`current` je operativna rupa.** RSI otvara `kind: 'prompt'` bez teksta; `apply` ne
   provjerava `proposed` i za prompt radi `String(null)` → deployuje **`"null"`** kao system prompt.
   Nema ni `PATCH` rute da čovjek dopuni tekst. Ovo je najvažnija stvar za popravku prije nego se RSI koristi
   na produkciji (`docs/22` §7 ima istu napomenu).
9. **Trace prozor.** `analyze` sa `sinceDays: 7` čita trace **samo za tekući dan** (`readFromDisk` default),
   pa je analiza kvarova „danas", a analiza nagrada „7 dana" — dvije različite istine u istom izvještaju.
10. **Self-play rezultati nisu u nagradama.** Runovi self-play-a ne prolaze kroz `recordRunOutcome`, pa RSI
    ne vidi da se prolaznost na scenarijima popravlja ili kvari (`docs/22` §7).
11. **Neiskorišteni parametri** (`catalog`, `cost`, `autonomy`, `memory`) i mrtav `denials` objekat — signal da
    su predviđeni nalazi (trošak, memorija bez odgovora, odbijanja politika) ostali neimplementirani.

---

## 10. Sljedeći korak — eval harness (zlatni set)

**Preduslov za bilo kakvu automatizaciju iz §7.5.** Bez ovoga svaka diskusija o „samo-deploy-u" ostaje teorija.
Konkretno šta treba izgraditi:

### 10.1 Podaci

| Fajl | Sadržaj |
|---|---|
| `data/tenants/<id>/eval/golden-<domain>.jsonl` | Zlatni set: `{ id, domain, agentId, input, mustInclude[], mustNotInclude[], expectedTools[], maxCostUsd, source: 'ticket'\|'selfplay'\|'manual', addedAt, addedBy }` |
| `data/tenants/<id>/eval/runs-YYYY-MM.jsonl` | Rezultat svakog pokretanja: `{ runId, ts, version, agentId, caseId, passed, score, issues[], costUsd, durationMs }` |
| `config/eval/thresholds.json` | Pragovi: minimalni prolaz po domenu, dozvoljeni pad pri regresiji, obavezne provjere |

**Veličina (procjena):** 30–50 slučajeva po domenu za prvi zlatni set; od toga najmanje 20% iz **stvarnih**
ticketa/mejlova (sa redakcijom PII), ostatak iz self-play dataset-a (`passed: true`) i ručno.

### 10.2 Kod

| Komponenta | Šta radi | Napomena |
|---|---|---|
| `src/eval/harness.js` | Pokreće zlatni set kroz `orchestrator.run` sa fiksiranim modelom/temperaturom; ocjenjuje heuristikama (`critic.heuristics`) + provjerama iz `mustInclude`/`mustNotInclude`/`expectedTools`; upisuje rezultat | Bez LLM sudije u prvoj verziji (determinizam > „pamet") |
| `src/eval/regression.js` | Poredi dva pokretanja (baseline vs kandidat): prolaz po domenu, novi padovi, `Δcost`, `Δlatency` | Odluka: `pass` / `warn` / `block` |
| `POST /v1/admin/eval/run` | Pokreće evaluaciju (opciono sa `specPatch` kandidata — probni prompt **prije** deploy-a) | `specPatch` već postoji u `runAgent` (`ctx.specPatch`) |
| `GET /v1/admin/eval/report` | Posljednji rezultat + regresija prema baseline-u | Za dashboard i za inbox |
| `GET /v1/admin/eval/golden` | Pregled seta (dodavanje/uklanjanje uz audit) | Zlatni set je „ugovor o kvalitetu" |

### 10.3 Gating (gdje se eval spaja sa RSI-jem)

1. **Prije primjene:** `POST /v1/admin/proposals/:id/apply` odbija `kind: 'prompt'|'pattern'` ako kandidat
   **nije** prošao eval (`block`), ili zahtijeva dodatnu potvrdu ako je `warn`.
2. **Poslije primjene:** `rsi.impact` pored `ΔavgReward` prijavljuje i **Δeval** (isti zlatni set) — to je
   signal koji ne zavisi od saobraćaja i sezone.
3. **Automatski rollback kao budući korak:** ako `Δeval` padne ispod praga **i** `impact` delta < −0.03 uz
   `n ≥ 15`, watcher predlaže rollback (ili ga, na L4 za taj `kind`, izvršava — tek kada su svi preduslovi iz
   §7.5 ispunjeni).
4. **Zlatni set kao izvor istine za self-play:** scenariji koji su u zlatnom setu **ne** ulaze u trening
   (holdout), inače se model obučava na testu.

### 10.4 Redoslijed rada (predlog)

| Korak | Isporuka | Zašto tim redom |
|---|---|---|
| 1 | `golden.jsonl` po domenu + `harness.js` (bez LLM sudije) | Mjerenje prije automatizacije |
| 2 | `regression.js` + `GET /v1/admin/eval/report` | Da se vidi pad, a ne samo prolaz |
| 3 | Gating u `improvements.apply` | Automatika dobija kočnicu |
| 4 | Popravke iz §9: `proposed` validacija, `PATCH` ruta, `target: 'runs'`, trace prozor, dedup, budget u self-play-u | Uklanja poznate rupe prije nego ih automatika „proširi" |
| 5 | Tek onda: razmatranje auto-apply za uski `kind` (npr. `kb` dopuna) | Najmanji rizik, najlakši rollback |

---

## Otvorena pitanja

1. **Ko piše i održava zlatni set?** Da li ga puni čovjek iz stvarnih ticketa, self-play iz `passed: true`
   redova, ili oboje — i ko snosi odgovornost ako zlatni set „zamrzne" pogrešno ponašanje?
2. **Koji je minimalni `n` za prijedlog?** `n ≥ 3` je danas prag; da li ga podići na 10, ili uvesti „najmanje
   3 u dva različita dana" da se izbjegnu prijedlozi iz jednog incidenta?
3. **Da li RSI smije predlagati politike?** `improvements` to podržava (`kind: 'policy'`, reverzibilan
   override), ali analiza to ne generiše; koji izvor bi bio legitiman (odbijene politike iz audita, watcher)?
4. **Kako mjeriti dugoročni efekat** (30/90 dana) kad `rewards.recent` čita samo tekući mjesec — uvesti
   mjesečne snimke („baseline" fajl po agentu) ili čitati sve `rewards-*.jsonl` fajlove?
5. **Koji `kind` je kandidat za prvo auto-apply** (kad eval harness postoji): KB dopuna (najniži rizik),
   prompt (srednji), pattern (mijenja trošak), ili nijedan do v1.0?
6. **Kako RSI da vidi ishod van sistema** (da li je ticket ponovo otvoren, da li je kupac ostao) — uvesti
   „outcome hook" koji alat ili webhook vraća u reward model, ili ostati samo na internim signalima?
