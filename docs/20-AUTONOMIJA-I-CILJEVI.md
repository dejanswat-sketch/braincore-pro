# 20 — Autonomija i ciljevi: od izvršioca do agenta koji juri rezultat

> **Svrha:** objasniti kako robot prestaje da bude „nešto što odgovara kad ga pitaš" i postaje **agent koji
> ima cilj, mjeri ga, sam primijeti problem i predlaže (ili izvršava) akciju** — a da pritom ništa ne izmakne
> kontroli. Ovo je dokument za v0.3 nivo („autonomni agent").
>
> **Ugovor:** `docs/DECISIONS.md` (§6 putanje, §7 stanje, §8 D21–D36) i `docs/00-VIZIJA.md`.
> **Kod je kanonski.** Svaka tvrdnja ovdje je provjerena u kodu i navedena je putanja fajla.
> Ono što nije implementirano označeno je kao **planirano**.
>
> **Pravilo o brojevima:** vrijednosti ključeva se **nikad** ne upisuju u dokument — samo **imena** env varijabli
> (`NMQ_MASTER_KEY`, `NMQ_LLM_API_KEY`, …). Sve što je procjena označeno je riječju *procjena*.

---

## 1. Nivoi autonomije (L0–L4)

Nivo autonomije je **jedan broj po tenantu i po agentu** koji odgovara na pitanje: *koliko agent smije sam,
bez čovjeka?* Definicija je u kodu — `src/core/autonomy.js`, konstanta `AUTONOMY_LEVELS`:

| Nivo | Ime (`name`) | Smije predložiti (`canPropose`) | Smije planirati (`canPlan`) | Nizak rizik (`canActLow`) | Srednji rizik (`canActMedium`) | Visok rizik |
|---|---|---|---|---|---|---|
| **L0** | `assistant` | ❌ | ❌ | ❌ (traži odobrenje) | ❌ | **odobrenje** |
| **L1** | `propose` | ✅ | ❌ | ❌ (traži odobrenje) | ❌ | **odobrenje** |
| **L2** | `supervised` | ✅ | ✅ | ✅ | ❌ (traži odobrenje) | **odobrenje** |
| **L3** | `goal` | ✅ | ✅ | ✅ | ❌ (traži odobrenje) | **odobrenje** |
| **L4** | `autonomous` | ✅ | ✅ | ✅ | ✅ | **odobrenje** |

Tri stvari koje se lako pročitaju pogrešno, a kod ih rješava ovako:

1. **L2 i L3 imaju identična prava u `evaluate`.** Razlika L2 vs L3 nije u tabeli dozvola nego u **namjeri**:
   L2 je „nadgledano izvršavanje zadataka", L3 je „agent juri cilj" (`goals.schedule` + nedjeljni ljudski
   pregled). Kod ih zato tretira isto (`canActMedium: false` za oba), a razlika se vidi u `config/autonomy.json`
   (kome se daje koji nivo) i u toku rada (`docs/20` §6).
2. **L1 smije predložiti, ali ne smije izvršiti ni nizak rizik.** `evaluate({ riskLevel: 'low', kind: 'act' })`
   na L1 vraća `require_approval` — dakle agent smije reći „predlažem da pošaljemo podsjetnik", a čovjek to
   pokreće. To je razlika između „pametan asistent" i „agent koji radi".
3. **L0 ne smije ni predložiti.** `evaluate({ kind: 'propose' })` na L0 vraća `deny`. L0 je čist chat:
   odgovara na ono što ga pitaš, ništa ne inicira.

### `HUMAN_ONLY` kategorije — „zubata" lista koja važi na svim nivoima

```js
export const HUMAN_ONLY = ['financial', 'legal', 'destructive', 'external_communication'];
```

Provjera u `evaluate` (treći korak, izvršenje) je:

```js
const humanOnly = (detail.tags ?? []).some((t) => HUMAN_ONLY.includes(t))
                || detail.category && HUMAN_ONLY.includes(detail.category);
if (riskLevel === 'high' || humanOnly) {
  return { level, action: 'require_approval',
           reason: 'visok rizik / kategorija rezervisana za čovjeka (važi na svim nivoima)' };
}
```

Značenje četiri kategorije u praksi NMQ Robota:

| Kategorija | Primjeri iz sistema | Zašto čovjek |
|---|---|---|
| `financial` | `invoice_create`, plaćanje, pregovor koji zatvara ugovor (`a2a/negotiation.js`) | Novac se ne može „vratiti" ako agent pogriješi; greška je stvarna šteta |
| `legal` | pravne tvrdnje, uslovi, ugovorni tekst, odgovor koji obavezuje firmu | Obavezivanje firme je pravni akt, ne tekst |
| `destructive` | brisanje podataka, `db_drop`, `db_truncate`, `filesystem.delete_any` | Nema undo-a; politika ih i inače drži u `deny` (`config/policies.json`) |
| `external_communication` | mejl ka klijentu, javna objava, poruka trećoj strani | Izlazna komunikacija je neopoziva i predstavlja firmu |

**Ključna tvrdnja (dokazana testom):** `high` rizik i `HUMAN_ONLY` kategorija traže čovjeka **i na L4**.
`tests/autonomy.test.mjs` to provjerava dvaput:

```js
autonomy.setLevel('t1', 'sales', 'L4');
assert.equal(autonomy.evaluate({ tenantId: 't1', agentId: 'sales', riskLevel: 'medium', kind: 'act' }).action, 'allow');
assert.equal(autonomy.evaluate({ tenantId: 't1', agentId: 'sales', riskLevel: 'high',   kind: 'act' }).action, 'require_approval');
assert.equal(autonomy.evaluate({ tenantId: 't1', agentId: 'sales', riskLevel: 'low', kind: 'act',
                                 detail: { tags: ['legal'] } }).action, 'require_approval');
```

Napomena o **redu provjere**: `high`/`HUMAN_ONLY` se provjerava **prije** `medium`, pa nema načina da
kategorija `financial` „propadne" kroz neku drugu granu. Ovo je namjerno — redoslijed je sigurnosna odluka,
ne stil.

### Kako se nivo postavlja

**a) Globalni default i po-tenantski/per-agent nivo — `config/autonomy.json`:**

```json
{
  "default": "L1",
  "tenants": {
    "nmq":        { "*": "L2", "executor": "L2", "creative": "L1", "sales": "L3", "ops": "L3" },
    "demo-shop":  { "*": "L1", "support": "L2", "ecommerce": "L2" }
  }
}
```

Prioritet razrješavanja je u `levelOf` (`src/core/autonomy.js`) i ide od **najspecifičnijeg ka najopštijem**:

```
tenant+agent  →  tenant+'*'  →  '*'+'*'  →  config.default  →  'L1'
```

`src/index.js` učitava fajl pri startu i mapira `"*"` u „nivo za cijeli tenant":

```js
const autonomy = createAutonomy({ config: config.autonomy ?? {}, logger, metrics, audit });
for (const [tenantId, levels] of Object.entries(config.autonomy?.tenants ?? {})) {
  for (const [agentId, level] of Object.entries(levels)) autonomy.setLevel(tenantId, agentId === '*' ? null : agentId, level);
}
```

**b) Runtime promjena — `POST /v1/admin/autonomy`** (`src/server/routes-autonomy.js`, rola `owner`):

```jsonc
// POST /v1/admin/autonomy   { "agentId": "sales", "level": "L3" }
// agentId izostavljen ili null  →  nivo za CIJELI tenant
```

`setLevel` validira nivo (`ValidationError` za nepoznat), loguje `autonomy.level_changed` i inkrementuje
metriku `autonomy_level_changes_total`. Stanje nivoa je **u memoriji procesa** — poslije restarta se ponovo
čita iz `config/autonomy.json`. To znači: runtime promjena je za „sada", a trajna promjena se radi u config-u
(ili, u v1, kroz control plane — **planirano**).

**c) Čitanje stanja — `GET /v1/admin/autonomy`** vraća `snapshot()` (default + sve postavljene parove) i
`describe(tenantId)` (efektivni nivo za tenant bez `agentId`). **d) Suha proba — `POST /v1/admin/autonomy/check`**
poziva `evaluate` sa zadatim `agentId`/`riskLevel`/`kind`/`detail` i **ništa ne izvršava**; koristi se za
„da vidim šta bi se desilo" prije nego se nivo podigne.

### Gdje se provjerava

Postoje tačno **dvije ulazne tačke** i jedna je „mekana", jedna „tvrda":

| Funkcija | Vraća / radi | Gdje se koristi |
|---|---|---|
| `autonomy.evaluate({tenantId, agentId, riskLevel, kind, detail})` | `{ level, action: 'allow' \| 'require_approval' \| 'deny', reason }` — **ne baca** | Watcheri (`src/goals/watchers.js` → `fire`), `improvements.apply` za `kind: 'action'`, `a2a` i pregovori, `POST /v1/admin/autonomy/check` |
| `autonomy.assert({...})` | poziva `evaluate`, upisuje **audit** i **baca `PolicyError`** kad je `deny` | rute i watcheri koji moraju da prekinu tok |

Audit zapisi koje `assert` ostavlja (oba u `data/tenants/<id>/audit/audit.jsonl`):

- `autonomy_denied` — `decision: 'deny'`, `outcome: 'blocked'`, `meta: verdict` (npr. „L1 propose: planiranje nije dozvoljeno")
- `autonomy_decision` — `decision: 'allow' | 'require_approval'`, `outcome: 'ok' | 'pending'`

Uz to `assert` inkrementuje metriku `autonomy_decisions_total` sa labelama `tenant`, `level`, `action`, `kind` —
pa se na `/metrics` vidi **koliko puta je koji nivo rekao „ne"**. Test `autonomija: assert baca PolicyError i
upisuje audit` dokazuje da odbijeno planiranje ostavlja `autonomy_denied` u audit logu.

> **Važno ograničenje (iskreno):** `autonomy` je brava za **proaktivne/autonomne** akcije (watcher, prijedlog,
  zakazani posao, pregovor). Ona **ne zamjenjuje** `policyResolver` — alat koji je na `deny` listi ostaje
  zabranjen bez obzira na nivo, a `high` rizik alat traži odobrenje i kroz politiku (`src/core/policy.js`,
> `assertAllowed`). Dvije brave rade zajedno: **politika kaže šta se smije**, **autonomija kaže ko smije da
> odluči**.

---

## 2. Cilj nije prompt

Prompt je tekst koji agent dobije **sada**. Cilj je **zapis sa rokom, metrikom i istorijom** koji živi
nedjeljama i koji agent juri kroz poslove. Razlika je operativna, ne filozofska: prompt se ne može mjeriti,
cilj mora.

Model cilja je u `create` (`src/goals/manager.js`):

```jsonc
{
  "id": "goal_...",            // uid('goal')
  "tenantId": "nmq",
  "title": "Povećaj mjesečni prihod 15%",
  "description": "",
  "metric": "monthly_revenue_eur",   // OBAVEZNO — šta se mjeri
  "unit": "EUR",
  "baseline": 10000,                 // odakle krećemo
  "target": 11500,                   // gdje ciljamo (obavezan)
  "current": 10000,                  // zadnje izmjereno (početno = baseline)
  "deadline": "2026-11-13T...",      // OBAVEZNO — do kada
  "startAt": "2026-09-29T...",
  "owner": "ceo",                    // ko odgovara (agent ili uloga)
  "subgoals": [],                    // iz decompose
  "kpis": [],                        // iz decompose
  "plan": [],                        // koraci: { step, agent, when }
  "status": "active",
  "cadence": "weekly",               // koliko često se mjeri/pregleda
  "budgetUsd": null,                 // budžet cilja (nije tvrda brava — vidi §6)
  "createdAt": "...", "updatedAt": "...",
  "progress": [],                    // zadnjih 200 mjerenja: { ts, value, note, source }
  "replans": [],                     // zadnjih 10 replanova: { ts, status, pct, diagnosis, actions, dropped }
  "source": "api"
}
```

**Gdje živi:**

| Šta | Putanja (stvarna, u kodu) |
|---|---|
| Stanje ciljeva (jedan fajl po tenantu) | `data/tenants/<id>/goals/goals.json` |
| Mjerenja napretka (append-only) | `data/tenants/<id>/goals/progress-YYYY-MM.jsonl` |
| Audit cilja | `data/tenants/<id>/audit/audit.jsonl` (`goal_create`, `goal_decompose`, `goal_replan`, `goal_status`) |

`progress-YYYY-MM.jsonl` je **mjesečna rotacija** (ključ je `d.toISOString().slice(0, 7)`), pa se stara mjerenja
ne prepisuju; `goals.json` drži samo zadnjih 200 mjerenja u memoriji cilja (`slice(-200)`), a puna istorija je
u JSONL-u koji čita `history()` (`readJsonl(progressFile, { tail: true })`).

**Zašto je mjerljivost obavezna.** `create` ima četiri tvrde validacije koje bacaju `ValidationError`:

```js
if (!spec.title) throw new ValidationError('Cilj traži "title"');
if (!spec.metric) throw new ValidationError('Cilj traži "metric" (npr. "monthly_revenue_eur")');
if (spec.target === undefined) throw new ValidationError('Cilj traži "target"');
if (!spec.deadline) throw new ValidationError('Cilj traži "deadline" (ISO datum)');
```

Logika je jednostavna: **cilj bez metrike se ne može izmjeriti, cilj bez roka se ne može ocijeniti kao
„kasni"**, a cilj bez broja je želja. Test `ciljevi: postignut cilj i validacije` dokazuje da
`create({ title: 'bez metrike' })` pada sa `ValidationError`. Time je „nemjerljiv cilj" nemoguć **po
konstrukciji**, a ne po disciplini tima.

---

## 3. Kako cilj nastaje

Tok je: **čovjek zapiše cilj → LLM ga razbije na podciljeve i plan → plan se pretvori u poslove**.

```
POST /v1/admin/goals            (title, metric, baseline, target, unit, deadline, owner)
        │
        ├── goals.create()  →  goals.json + audit goal_create
        │
POST /v1/admin/goals/:goalId/decompose
        │
        ├── goals.decompose()  →  LLM (role: goal-decomposer, temperature 0.2, maxTokens 900, JSON)
        │        vraća: { subgoals[], plan[], kpis[] }
        │        →  goals.json (subgoals sa id+status, plan do 12 koraka) + audit goal_decompose
        │
POST /v1/admin/goals/:goalId/schedule   (opciono, ali ovo je "agent juri cilj")
        │
        └── goals.schedule()  →  scheduler.createJob() po koraku plana, svaki sa goalId
```

`decompose` je **LLM poziv kroz `helpers.callLlm`**, dakle ide kroz isti put kao svaki drugi LLM poziv:
budžet, cost tracker, trace span, metrike. Zato vraća i `costUsd` i `usage` — dekompozicija cilja **nije
besplatna** i vidi se u trošku tenanta.

Dvije stvari u promptu su namjerno tvrde:

- **„Podciljevi moraju biti mjerljivi."** (u system promptu) — da podciljevi ne postanu lista aktivnosti.
- **„Koristi SAMO agente sa spiska."** — spisak se gradi iz kataloga tenanta:
  `catalog.view(tenantId).routingTable()` → `- support (support): ...`. Time plan **ne može** uputiti na agenta
  koji tom tenantu nije dostupan. Vezivanje plana na stvarne agente je razlika između plana i teksta.

### Primjer: cilj

```json
{
  "title": "Povećaj mjesečni prihod 15%",
  "description": "Fokus na obnovi ugovora i upsell-u postojećim klijentima.",
  "metric": "monthly_revenue_eur",
  "unit": "EUR",
  "baseline": 10000,
  "target": 11500,
  "deadline": "2026-11-13T00:00:00.000Z",
  "owner": "ceo"
}
```

### Primjer: rezultat dekompozicije (oblik koji kod upisuje)

```json
{
  "subgoals": [
    { "id": "sg_...", "title": "Obnovi 20 ugovora koji ističu", "metric": "renewed_contracts", "target": 20, "owner": "sales", "status": "active" },
    { "id": "sg_...", "title": "Upsell na 10% baze",             "metric": "upsell_rate_pct",   "target": 10, "owner": "sales", "status": "active" }
  ],
  "plan": [
    { "step": "Segmentiraj klijente po datumu isteka ugovora", "agent": "data",  "when": "nedjelja 1" },
    { "step": "Napravi listu ponuda za obnovu + upsell",       "agent": "sales", "when": "nedjelja 2" },
    { "step": "Pošalji ponude i prati odgovore",               "agent": "sales", "when": "nedjelja 3" }
  ],
  "kpis": ["renewed_contracts", "upsell_rate_pct", "pipeline_value_eur"]
}
```

Obratite pažnju: `decompose` **ne mijenja** `metric`, `baseline`, `target`, `deadline` ni `owner`. On dodaje
`subgoals`, `plan` i `kpis`. Cilj („kuda") i put („kako") su odvojeni — to je ono što omogućava replan (§5)
bez prepisivanja istorije.

---

## 4. Kako se cilj mjeri

Mjerenje ulazi kroz **jednu funkciju**: `recordProgress(tenantId, goalId, { value, note, source, at })`.
Poziva se sa `POST /v1/admin/goals/:goalId/progress`. Validacija je tvrda:

```js
if (value === undefined || value === null || Number.isNaN(Number(value)))
  throw new ValidationError('Mjerenje traži numeričku "value"');
```

Tri polja imaju jasno značenje:

| Polje | Šta je | Primjeri `source` |
|---|---|---|
| `value` | novo stanje metrike (ne prirast!) | `10750` |
| `note` | kontekst mjerenja | `"mjereno iz Stripe-a za oktobar"` |
| `source` | **odakle** mjerenje dolazi | `manual`, `test`, agent koji je upisao poslije koraka |

`recordProgress` radi pet stvari: upiše `current`, doda zapis u `goal.progress` (zadnjih 200), izračuna
zdravlje (`health`), postavi `status` **na izračunatu vrijednost**, i appenduje liniju u
`progress-YYYY-MM.jsonl`. Uz to inkrementuje `goal_progress_updates_total`, a za loše statuse i
`goals_at_risk_total` + loguje `goal.at_risk`.

### Formula `progressPct`

```js
function progressPct(goal) {
  const { baseline = 0, target = 0 } = goal;
  const current = goal.current ?? baseline;
  const span = target - baseline;
  if (span === 0) return current >= target ? 100 : 0;
  return Number((((current - baseline) / span) * 100).toFixed(1));
}
```

Dakle: **koliko je puta od `baseline` do `target` pređeno**, u procentima. Specijalan slučaj `span === 0`
(cilj „ostati na istom") daje 100 ako je `current >= target`, inače 0 — bez dijeljenja nulom.

### Formula `expectedPct`

```js
function expectedPct(goal, at = Date.now()) {
  const start = new Date(goal.startAt ?? goal.createdAt).getTime();
  const end = new Date(goal.deadline).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Number(Math.min(100, Math.max(0, ((at - start) / (end - start)) * 100)).toFixed(1));
}
```

Ovo je **vremenski napredak**, ne poslovni: koliko je roka proteklo. Ako su datumi neispravni (`end <= start`)
vraća `null` i tada se cilj ne ocjenjuje kao „kasni" — kod tada daje samo `active`/`achieved`.

### Tabela statusa (iz `health`)

| Status | Uslov u kodu | Značenje |
|---|---|---|
| `achieved` | `pct >= 100` | Cilj dostignut (i preko 100% je dozvoljeno — vidi test sa `value: 120`) |
| `missed` | `deadline < now` i `pct < 100` | Rok je prošao, cilj nije dostignut |
| `on_track` | `gap = expected - pct` i `gap <= 10` | Zaostatak **do 10 procentnih poena** |
| `at_risk` | `gap <= 30` | Zaostatak **10–30 p.p.** |
| `off_track` | `gap > 30` | Zaostatak **preko 30 p.p.** |
| `paused` | postavljen rukom (`setStatus`) | `decorate` vraća `paused` i **ne prepisuje** ga izračunom |
| `active`, `draft`, `cancelled` | kad `expectedPct` vrati `null`, ili rukom | Nema vremenske osnove za ocjenu / cilj nije u toku |
| `ok`, `error` (kod poslova) | — | To su statusi **run-a/posla**, ne cilja; ne miješati |

`gap` se prijavljuje kao `Number(gap.toFixed(1))` pa je prag „≤10" stvarno „≤10.0 p.p." poslije zaokruživanja.
Zdravlje se računa i u `decorate`, pa `list`/`get`/`portfolio` uvijek vraćaju svjež status.

### Konkretan primjer brojeva (isti kao u testu)

Cilj: `baseline = 10000`, `target = 11500`, `startAt = now - 45 dana`, `deadline = now + 45 dana`.

1. Prvo mjerenje `value: 10750` → `progressPct = (10750 - 10000) / 1500 = 50.0%`.
   `expectedPct ≈ 50.0%` (pola roka je prošlo) → `gap = 0` → **`on_track`**.
2. Drugo mjerenje `value: 10100` → `progressPct = (10100 - 10000) / 1500 = 6.7%`.
   `expectedPct ≈ 50.0%` → `gap ≈ 43.3` → **`off_track`** (test prihvata `at_risk` ili `off_track`, jer
   zavisnost od milisekundi pomjera `expected` za djelić).
3. Da je `value: 11500`, `pct = 100` → **`achieved`**.
4. Da je rok prošao, a `value: 11000` (`pct ≈ 66.7`) → **`missed`**.

`portfolio(tenantId)` agregira isto na nivou tenanta: `total`, `byStatus` (brojač po statusu) i `atRisk[]`
(svi ciljevi u `at_risk`/`off_track`/`missed`, sa `pct`, `expected`, `deadline`, `owner`). To je ono što
`GET /v1/admin/goals?portfolio=1` vraća i što watcher `cilj_skrenuo` i RSI analiza koriste kao ulaz.

---

## 5. Replan

Replan je **promjena puta, ne cilja**. Postoje dva okidača:

1. **Watcher `cilj_skrenuo`** (`config/watchers.json`) — `when.type = goal_status`, `statuses: ["off_track", "missed"]`,
   `then.kind: "propose"`, `agentId: "ops"`, `riskLevel: "medium"`. Watcher dakle **predlaže** replan (ide u inbox),
   ne izvršava ga sam; `POST /v1/admin/goals/:goalId/replan` je ono što ga stvarno pokrene.
2. **Ručno** — operater pozove `POST /v1/admin/goals/:goalId/replan` (rola `admin`).

LLM prompt (`role: 'goal-replanner'`, `temperature 0.3`, `maxTokens 800`, JSON) traži ovaj oblik:

```json
{
  "diagnosis": "Ponude su poslate kasno i nisu praćene pozivom.",
  "actions": [
    { "step": "Podijeli listu na 3 segmenta i pošalji u 3 talasa", "agent": "sales", "when": "nedjelja 1" },
    { "step": "Uvedi podsjetnik poslije 72h bez odgovora",          "agent": "sales", "when": "nedjelja 1" }
  ],
  "drop": ["Masovni mejl cijeloj bazi"],
  "expectedEffect": "vraćanje na putanju u 2 nedjelje"
}
```

**Sistemska instrukcija je eksplicitna: „Ne mijenjaj sam cilj (target/rok) — mijenjaj put do cilja."**
I kod je u skladu: `replan` upisuje **samo** u `goal.replans`:

```js
goal.replans = [...(goal.replans ?? []).slice(-10), { ts, status: h.status, pct: h.pct,
                 diagnosis: parsed.diagnosis, actions: parsed.actions, dropped: parsed.drop ?? [] }];
```

`metric`, `baseline`, `target`, `deadline`, `owner` ostaju **netaknuti**. `replans` je ograničen na zadnjih 10 —
istorija odluka je dokaz, ne arhiva.

**Zašto se target i rok ne diraju automatski:**

1. **Pomjeranje roka je najlakši način da cilj „uspije".** Ako agent smije da pomjeri rok, svaki `off_track`
   se rješava sam od sebe i metrika statusa postaje besmislena. Replan koji mijenja rok nije replan — to je
   odustajanje, a odustajanje je ljudska odluka (`setStatus` u `paused`/`cancelled`).
2. **`target` je obaveza prema nekome** (vlasniku, klijentu, budžetu). Agent ne može da smanji obavezu.
3. **Mjerljivost ostaje čista.** Ako se mijenja samo put, `progressPct`/`expectedPct` su uporedivi prije i
   poslije replana — pa se **efekat replana može izmjeriti** (isti `metric`, isti `target`).

Uz svaki replan ide `audit: goal_replan` (sa `status` i brojem akcija) i metrika `goal_replans_total`.

---

## 6. Cilj kao posao

Do ovog koraka cilj je zapis koji **čovjek** mjeri. `schedule()` ga pretvara u **posao** — a posao radi
scheduler, bez čovjeka. To je trenutak u kojem je robot stvarno „agent koji juri rezultat".

```js
async schedule(tenantId, goalId, { startInMs = 0, stepDelayMs = 3_600_000 } = {}) {
  if (!scheduler) throw new ValidationError('Scheduler nije dostupan — cilj ne može da zakaže poslove');
  const goal = await this.get(tenantId, goalId);
  for (const [i, step] of (goal.plan ?? []).entries()) {
    jobs.push(await scheduler.createJob(tenantId, {
      name: `cilj:${goal.id} korak ${i + 1}: ${String(step.step).slice(0, 60)}`,
      agentId: step.agent ?? goal.owner,
      pattern: step.pattern,
      input: `CILJ: ... KORAK ${i + 1}/${goal.plan.length}: ${step.step} ...`,
      schedule: { type: 'once', at: Date.now() + startInMs + i * stepDelayMs },
      enabled: true,
      goalId: goal.id,
      retry: { max: 2, backoffMs: 10_000 },
    }));
  }
  goal.jobs = jobs.map((j) => j.id);
}
```

Bitne osobine:

| Osobina | Vrijednost u kodu | Zašto je bitno |
|---|---|---|
| Jedan korak plana = jedan posao | `schedule: { type: 'once', at: ... }` | Koraci ne blokiraju jedan drugog |
| Razmak između koraka | `stepDelayMs` (default 1h) | Agent ima vremena da prethodni korak ostavi trag u memoriji |
| Veza na cilj | `goalId: goal.id` na poslu | `GET /v1/admin/jobs` filtrira po cilju; test provjerava `jobs.every(j => j.goalId === g.id)` |
| Ponovni pokušaj | `retry: { max: 2, backoffMs: 10_000 }` (scheduler radi eksponencijalni backoff do 10 min) | Prolazna greška ne ubija korak |
| Posao preživljava restart | `data/tenants/<id>/jobs/jobs.json` (D21, atomiski upis) | Cilj se nastavlja i poslije restarta procesa |
| Kad alat traži odobrenje | Posao prelazi u `waiting_approval` i `nextRunAt = null` | **Ne izvršava se dvaput** — jednom kroz odobrenje, jednom po rasporedu |

Kako agent onda „sam radi korake": scheduler u `runJob` poziva `robot.orchestrator.run({ tenantId, agentId,
pattern, input, options: { maxRunUsd: job.budgetPerRunUsd, jobId: job.id, ... } })`. Orchestrator gradi budžet,
provjerava `policy` i agentski budžet (control plane), a agent u run-u ima instrukciju iz `input`-a:
*„Uradi ovaj korak i na kraju upiši novo mjerenje metrike ako ga možeš izmjeriti."* Mjerenje ulazi kroz
`recordProgress` (sa `source` koji nije `manual`) — i tako se zatvara petlja: **posao → akcija → mjerenje →
status → (ako skrene) watcher → replan**.

> ⚠️ **Upozorenje koje se mora pročitati prije `schedule`:** zakazani korak **troši budžet** — svaki run ima
> LLM pozive, a `pattern` može biti `team` (×6 koraka) ili `debate` (×5). Kontrolna tačka su:
> `budgetPerRunUsd` **na poslu** (`maxRunUsd` u orchestratoru), `runUsd`/`monthlyUsd` iz politike tenanta
> (`config/policies.json`), per-agent budžet iz control plane-a (`budgetUsdMonth`, `assertAgentBudget`)
> i tvrdi globalni limiti `NMQ_BUDGET_RUN_USD` / `NMQ_BUDGET_MONTHLY_USD`. **Cilj sa 8 koraka i bez
> `budgetPerRunUsd` je otvoren ček.** Prije `schedule` uvijek: (1) provjeri da li `goal.plan` ima korake koje
> je stvarno potrebno izvršiti, (2) postavi `budgetPerRunUsd` po koraku, (3) provjeri `budgetUsd` na cilju —
> ali znaj da `goal.budgetUsd` **nije** tvrda brava (kod ga ne provjerava u `schedule`; to je planirano),
> nego polje za praćenje.

---

## 7. Proaktivni watcheri

Watcher je **pravilo „ako → onda"** koje robot provjerava sam. Kod je u `src/goals/watchers.js`, pravila u
`config/watchers.json`. Pet tipova uslova (`when.type`) koje `evaluateCondition` stvarno podržava:

| `when.type` | Polja | Šta mjeri | Kako se pokreće |
|---|---|---|---|
| `metric` | `metric`, `op`, `value` | Zadnju vrijednost metrike koju je sistem upisao (`recordMetric`) | `tick()` — periodično, i `POST /v1/admin/watchers/tick` |
| `goal_status` | `statuses[]`, `owner?` | Broj ciljeva u datim statusima (`goals.portfolio`) | `tick()` |
| `reward` | `groupBy`, `below`, `minSamples`, `windowMs` | Grupe (agent/pattern) sa `avgReward` ispod praga i dovoljno uzoraka | `tick()` |
| `event` | `event` (npr. `hook.shopify`, `hook.*`) | Događaj sa bus-a | `onEvent()` — **ne** u tick-u (tick ih preskače) |
| `schedule` | `everyMs` | Protekle vrijeme od zadnjeg okidanja | `tick()` |

Operatori za `metric`: `>`, `>=`, `<`, `<=`, `==`, `!=` (`OPS` u kodu; default je `>`).

### Dvije brave protiv spam-a: `cooldownMs` i `maxPerDay`

```js
if (now() - s.lastRunAt < (rule.cooldownMs ?? 3_600_000)) return false;   // default 1h
if (rule.maxPerDay && s.runsToday >= rule.maxPerDay) return false;        // dnevni plafon
```

Stanje se drži **po tenantu i po pravilu** (`${tenantId}::${ruleId}`) i resetuje se na promjenu datuma
(`s.day !== today`). To znači da pravilo koje je „vruće" za jednog klijenta ne troši kvotu drugom. Test
`watcheri: metrika preko praga …` dokazuje da **drugi `tick()` odmah poslije prvog ne okida ništa**.

### `then.kind: propose` vs `then.kind: run`

Ovo je najvažnija razlika u watcherima, i rješava se **kroz autonomiju**:

```js
const decision = autonomy?.evaluate({
  tenantId, agentId: then.agentId,
  riskLevel: then.riskLevel ?? 'low',
  kind: then.kind === 'run' ? 'act' : 'propose',
}) ?? { action: 'require_approval', level: 'L0' };

const record = { ..., action: decision.action === 'allow' && then.kind === 'run' ? 'run' : 'propose' };
```

| `then.kind` | Kad se izvrši odmah | Kad ide u inbox |
|---|---|---|
| `propose` | **nikad** — uvijek ide u inbox (zahtijeva `kind: 'propose'` dozvolu, tj. L1+) | Uvijek: `createProposal({ kind: 'action', source: 'watcher', ... })` |
| `run` | samo ako `autonomy.evaluate(kind: 'act')` vrati `allow` — dakle **L2+ i nizak rizik** | Ako autonomija traži odobrenje/odbija → pretvara se u `propose` |

Ako autonomija nije dostupna, default je **`require_approval` / L0** — „fail-closed": bez brave se ne
izvršava. Bitan detalj iz koda: `riskLevel` za `run` pravilo **mora biti `low`**; srednji rizik na L4 bi prošao
kroz `evaluate`, ali `high` nikad (prva grana u `evaluate`).

Svako okidanje ostavlja: metricu `watchers_fired_total` (`tenant`, `rule`, `action`), eventualno
`watchers_failed_total`, log `watcher.fired` i **audit zapis `watcher_fire`** sa `decision` (allow/
require_approval), `outcome` (`ok`/`error`), `runId` i `meta.level` + `meta.proposalId`.

### Primjer toka 1 — „tickets_rastu"

Pravilo iz `config/watchers.json`:

```json
{
  "id": "tickets_rastu",
  "when": { "type": "metric", "metric": "support_tickets_open", "op": ">", "value": 40 },
  "then": { "kind": "propose", "agentId": "support", "riskLevel": "low",
            "input": "Otvoreno je {{value}} ticketa. Predloži 3 konkretne akcije …" },
  "cooldownMs": 3600000, "maxPerDay": 3
}
```

Tok:

1. Sistem (ili alat, ili webhook) upiše mjerenje: `POST /v1/admin/watchers/metrics { metric: "support_tickets_open", value: 55 }`.
   `recordMetric` pamti zadnjih 500 vrijednosti **u memoriji procesa** i postavi gauge `watcher_metric`.
2. `tick(['demo-shop'])` (ručno ili iz `robot.startWatchers()` intervala, default `NMQ_WATCHERS_TICK_MS`):
   uslov `55 > 40` → `met: true`, `reason: "support_tickets_open=55 > 40 → true"`.
3. `fire()` zamijeni `{{value}}` sa `55` u `input`-u.
4. `autonomy.evaluate({ kind: 'propose' })` — `demo-shop` je L1 (`config/autonomy.json`), `canPropose: true` → `allow`.
   Ali `then.kind` je `propose`, pa `action = 'propose'` (nikad `run`).
5. `createProposal` upiše `data/tenants/demo-shop/learning/proposals.json` sa `kind: 'action'`,
   `source: 'watcher'`, `rationale: 'Proaktivni watcher "Nagomilani ticketi": support_tickets_open=55 > 40'`.
   Audit: `improvement_proposed` (`decision: require_approval`).
6. `markRun` — sljedeće okidanje za isti tenant moguće tek poslije 1h **i** najviše 3× dnevno.
7. Čovjek: `POST /v1/admin/proposals/:id/decide { approve: true }` → `apply` → `orchestrator.run(...)` (kind `action`),
   uz **ponovnu** provjeru autonomije (`autonomy.evaluate({ kind: 'act' })`).

Test dokazuje korake 2–6, uključujući da je `proposals[0].kind === 'action'` i `source === 'watcher'`.

### Primjer toka 2 — „hook.shopify"

Pravilo: `when: { type: 'event', event: 'hook.shopify' }`, `then: { kind: 'run', agentId: 'ecommerce', riskLevel: 'low' }`,
`cooldownMs: 1000`, `maxPerDay: 200`.

1. Webhook: `POST /v1/hooks/shopify` → ruta izvrši run i **emituje** `hook.shopify` na bus.
2. `src/index.js`: `bus.on('hook.*', (env) => watchers.onEvent(env.event, env.payload))` — dakle **svaki**
   hook ide i u watchtore; pravilo filtrira po `when.event` (podržan i `hook.*` i prefiks `hook.shopify.*`).
3. `onEvent` preskače `tick`-logiku, ali **poštuje** `canRun` (cooldown/maxPerDay).
4. `then.kind = 'run'` + `riskLevel: 'low'`; tenant `nmq` ima `default`/`*` nivo **L2** → `canActLow: true`
   → `action: 'allow'`, pa `record.action = 'run'`.
5. `orchestrator.run({ agentId: 'ecommerce', userId: 'watcher:shopify_narudzbina', sessionId: 'watcher_shopify_narudzbina' })`
   — run ide kroz budžet, politiku i trace.
6. `record.runId` i `record.costUsd` se upišu; audit `watcher_fire` sa `outcome: 'ok'`.
7. Za istog tenanta i **L1** nivo, isti hook bi završio kao **prijedlog u inboxu** — jer `canActLow: false`.

Test `watcheri: metrika preko praga …` dokazuje upravo ovu razliku: na `demo-shop` (L1) → `propose` sa
`proposalId`; na `nmq` (L2) → `run` sa `runId`.

---

## 8. Tok od signala do akcije

```
   METRIKA              DOGAĐAJ                VRIJEME                CILJ
 (recordMetric)     (bus: hook.*, a2a.*)     (schedule tick)      (goal_status)
       │                    │                     │                    │
       └────────────┬───────┴─────────────────────┴────────────────────┘
                    ▼
        ┌───────────────────────────┐
        │  WATCHERS (in-process)    │   canRun: cooldownMs + maxPerDay  (po tenantu!)
        │  evaluateCondition()      │   metric | goal_status | reward | event | schedule
        └─────────────┬─────────────┘
                      │  condition.met === true
                      ▼
        ┌───────────────────────────┐
        │  AUTONOMIJA (brava)       │   kind = then.kind === 'run' ? 'act' : 'propose'
        │  autonomy.evaluate()      │   high rizik / HUMAN_ONLY  →  UVIJEK čovjek
        └───────┬───────────┬───────┘
                │           │
     action=propose│        │action=allow  (then.kind === 'run')
                ▼           ▼
   ┌────────────────┐   ┌────────────────────────────┐
   │  INBOX          │   │  ORCHESTRATOR.run()       │
   │  proposals.json │   │  pattern + agent + budget │
   │  status:proposed│   │  policy + audit + trace   │
   └───────┬────────┘   └────────────┬───────────────┘
           │  čovjek: decide(approve) │
           │  pa apply()              │
           └──────────┬───────────────┘
                      ▼
        ┌───────────────────────────┐
        │  REZULTAT + REWARD        │  robot.recordRunOutcome()
        │  rewards-YYYY-MM.jsonl    │  feedback | odobrenje | ishod | trošak | greške
        └─────────────┬─────────────┘
                      ▼
        ┌───────────────────────────┐
        │  AUDIT (hash-chained)     │  watcher_fire · autonomy_decision · autonomy_denied
        │  audit/audit.jsonl        │  improvement_proposed · goal_progress · job_run
        └───────────────────────────┘
```

Dvije stvari se vide iz dijagrama: (1) **autonomija je između „primijetio" i „uradio"** — nema puta oko nje;
(2) **svaka grana završava u auditu**, pa se i odbijena akcija može dokazati (`autonomy_denied`).

---

## 9. Sigurnosne brave

Autonomija je jedna brava; oko nje ih je još pet. Nijedna se ne smije zaobići „za ovaj jedan slučaj".

| Brava | Gdje je u kodu | Šta tačno drži |
|---|---|---|
| **Budžet run-a i tenanta** | `createBudget` (`src/core/budget.js`) + `runUsd`/`monthlyUsd` iz `config/policies.json` | `assertCanContinue` je **fail-closed**: broj koraka, `maxWallMs` (default 180 s), `runUsd`, mjesečni `monthlyUsd` (uz stvarnu potrošnju `cost.monthlySpent`), `maxTokens`. Svaki LLM poziv prvo traži dozvolu, pa troši |
| **Per-agent budžet** | `controlplane/registry.js` → `assertAgentBudget` + `setBudget` | `budgetUsdMonth` po agentu; ako je status `paused`/`retired` **ili** je budžet potrošen → `PolicyError` sa auditom `agent_budget_block` |
| **Rate limit** | `src/server/http.js` + `rateLimitPerMin` (prioritet: `route.rateLimit` → tenant → `NMQ_RATE_LIMIT_PER_MIN`) | Ograničenje **po tenantu** na ulazu (`tenants.rateLimit`), sa `x-ratelimit-remaining` / `retry-after` i metrikom `rate_limited_total`; rute `GET /metrics` i `/healthz` su izuzete (`rate: false`) |
| **Kill switch (tenant)** | `tenancy/store.js` → `suspend`/`isSuspended` + `data/tenants/<id>/status.json` | Suspendovan tenant ne prolazi ni autentikaciju; status preživljava restart (`loadStatuses` pri startu). Ruta za suspend je admin |
| **Kill switch (agent)** | `controlplane/registry.js` → status `active`/`paused`/`retired` | Pauziran/penzionisan agent se odbija u orchestratoru prije nego što se ijedan token potroši |
| **Politike** | `src/core/policy.js` (`resolvePolicy` + `evaluate`) i runtime override | `deny` pobjeđuje **uvijek** (prva grana); zatim allow lista → radno vrijeme → `requireApproval` → nivo rizika → uslovi (npr. `maxAmountUsd` za `invoice_create`) |
| **`maxToolRepeats`** | `src/agents/agent.js` | Isti alat sa **istim argumentima** max 3× (ili `spec.maxToolRepeats`); dalje se vraća `LOOP_PREVENTED`, `status = 'loop_prevented'` i petlja se prekida |
| **Odobrenje visokog rizika** | `tools/registry.js` → `ApprovalRequiredError`; ruta `POST /v1/approvals/:runId` | Akcija se **ne izvršava** dok čovjek ne odobri; posao koji čeka odobrenje se **zaustavlja** (`waiting_approval`, `nextRunAt = null`) da se ne izvrši dvaput |

### Šta se **NE MOŽE** desiti na L4

1. **Ne može izvršiti akciju visokog rizika** — `riskLevel === 'high'` vraća `require_approval` prije bilo koje
   druge provjere (`autonomy.evaluate`, prva grana izvršenja).
2. **Ne može izvršiti akciju iz `HUMAN_ONLY` kategorije** (`financial`, `legal`, `destructive`,
   `external_communication`) — traži čovjeka čak i kad je `riskLevel` nizak (`detail.tags`/`detail.category`).
3. **Ne može probiti budžet ni kill switch** — L4 ne dira `assertCanContinue`, `assertAgentBudget`,
   `isSuspended` ni status agenta; sve te provjere su **iznad** nivoa autonomije u toku izvršavanja.
4. **Ne može izvršiti alat koji politika zabranjuje** (`deny`) niti alat koji nije na allow listi tenanta —
   politika se provjerava u `tools.execute` prije handlera, nezavisno od autonomije.

(Uz to, na L4 se **ne može** ni „vrtjeti u krug": `maxToolRepeats`, `maxSteps` i `maxSteps × PATTERN_STEP_BUDGET`
vrijede bez izuzetka.)

---

## 10. Kako se to testira

Sve iz ovog dokumenta ima dokaz u `tests/autonomy.test.mjs` (pokreće se sa `node --test`, bez interneta, bez
zavisnosti, sa mock LLM-om):

| Šta test dokazuje | Test (ime u `tests/autonomy.test.mjs`) |
|---|---|
| Nivoi L0–L4 postoje u tom redu; L1 smije `propose` a ne smije `plan` ni nizak rizik; L3 planira i izvršava nizak rizik, a srednji traži odobrenje; **L4 izvršava srednji, ali `high` i `legal` traže čovjeka**; nepoznat nivo baca `ValidationError` | `autonomija: nivoi i odluke (propose/plan/act) po riziku` |
| `assert` baca `PolicyError` za nedozvoljeno planiranje i upisuje `autonomy_denied` u audit log tenanta | `autonomija: assert baca PolicyError i upisuje audit` |
| `create` validacije (metric/target/deadline), `decompose` daje podciljeve i plan i **trošak > 0**, `recordProgress` daje `progressPct`, loše mjerenje daje `at_risk`/`off_track`, `replan` upisuje `replans`, `portfolio` vidi cilj kao rizičan, `history` vraća 2 mjerenja iz JSONL-a | `ciljevi: kreiranje, dekompozicija, napredak i zdravlje` |
| Cilj bez metrike se **odbija**; `value: 120` na `target: 100` daje `achieved` i `progressPct: 120`; nepostojeći cilj → `NotFoundError`; nepoznat status → `ValidationError` | `ciljevi: postignut cilj i validacije` |
| `schedule` pravi **onoliko poslova koliko plan ima koraka**, svaki posao ima `goalId` i `nextRunAt` u budućnosti | `ciljevi: zakazivanje poslova iz plana (persistentni agenti jure cilj)` |
| Metrika preko praga → `propose` + `proposalId` + `kind: 'action'` + `source: 'watcher'`; **cooldown blokira drugi tick**; na L2+ **nizak rizik + `kind: 'run'` se izvršava sam** (`runId` postoji) | `watcheri: metrika preko praga → prijedlog; L3 agent niskog rizika → izvršava sam` (L3 u naslovu testa, a tenant `nmq` je u config-u L2 — provjera je ista: `canActLow`) |
| `event` pravilo se okida **samo** preko `onEvent('hook.shopify')`; `goal_status` pravilo reaguje na cilj koji kasni i vraća razlog sa brojem ciljeva | `watcheri: događaj sa bus-a i cilj koji skreće` |
| Reward formula: dobar run > 0.8, loš < 0.2, ocjena 5 > ocjena 2, `aggregate`/`ranking`/`variantComparison` rade | `reward: formula, agregacija i rangiranje` |
| HTTP run upisuje nagradu za taj `runId`; `POST /v1/feedback` dodaje `feedback: 'down'` u reward zapis | `reward: run kroz HTTP upisuje nagradu (recordRunOutcome)` |
| Pun ciklus kroz HTTP: `POST/GET /v1/admin/goals`, `decompose`, `progress`, `?portfolio=1`, `GET /v1/admin/autonomy`, `/autonomy/check`, watchers/metrika + tick | `HTTP: ciljevi, prijedlozi, watcheri, autonomija, org i A2A rute` |

> **Napomena o pokrivenosti:** nema testa koji dokazuje da `goal.budgetUsd` ograničava zakazane poslove —
> jer **kod to još ne radi** (vidi §11). Testirano je ono što postoji; ono što ne postoji je navedeno kao rupa.

---

## 11. Ograničenja

Ovo poglavlje je namjerno neprijatno. Svaka tvrdnja ispod je provjerena u kodu.

1. **Ciljevi se ne mjere sami — nema konektora ka ERP-u, Stripe-u, CRM-u ili Google Analytics-u.**
   `recordProgress` traži da **neko** pošalje `value`: čovjek kroz rutu, alat, ili agent na kraju zakazanog
   koraka („upiši novo mjerenje ako ga možeš izmjeriti"). Integracije su u `docs/03-MCP-INTEGRACIJE.md`
   navedene kao **planirano** (faza 2). Praktična posljedica: cilj mjeri onoliko dobro koliko dobro radi
   najslabiji konektor — do tada je `metric` tačan samo ako ga čovjek redovno upisuje.
2. **Nema više-vlasništva cilja.** `owner` je **jedno polje** (string). Nema „odgovorni + izvršilac + sponzor",
   nema notifikacije vlasniku, nema delegiranja. Sve što se zna je čiji je cilj i koji agenti su u planu.
3. **Nema zavisnosti između ciljeva.** Cilj A ne može reći „ne kreći dok B ne dostigne X", niti postoje
   roditelj/dijete ciljevi između tenanta. `subgoals` su **lista unutar jednog cilja**, bez izračuna
   napretka iz podciljeva (podciljevi imaju svoj `metric`/`target`, ali ne ulaze u `progressPct` roditelja).
   Portfolio je ravan spisak; nema kritičnog puta ni agregacije po strategiji.
4. **Watcheri su in-process — bez distributed lock-a.** Stanje (`state`, `metricsStore`) je u **memoriji
   procesa**, a `recordMetric` čuva zadnjih 500 vrijednosti. Dvije replike znače: dvostruko okidanje
   (svaka replika ima svoj cooldown i svoj `runsToday`) i različite „zadnje metrike". Isto važi za `leasing`
   kod schedulera (D22: fajl-lease, **nije** distributed lock). Za više replika treba Redis ili Postgres
   advisory lock (**planirano**, `docs/14` §7).
5. **Metrike watchera ne preživljavaju restart.** `metricsStore` i `state` nisu na disku, pa se poslije
   restarta cooldown resetuje (može doći do jednog dodatnog okidanja) i „zadnja vrijednost metrike" je
   nepoznata dok ne stigne novo mjerenje. Persistiranje je **planirano**.
6. **`goal.budgetUsd` nije tvrda brava.** Polje se upisuje i vraća, ali ga `schedule` ne provjerava; tvrdi
   limit je `budgetPerRunUsd` na poslu + budžeti iz politike i control plane-a. Cilj dakle može ukupno
   potrošiti više od `budgetUsd` (samo po koraku je ograničen). Veza `goal.budgetUsd` → `job.budgetPerRunUsd`
   je **planirana**.
7. **Promjena nivoa autonomije ne preživljava restart.** `setLevel` piše u memoriju; trajna promjena ide u
   `config/autonomy.json` (ili, u v1, kroz control plane). API zato nije „konfiguracija" nego „prekidač za sada".
8. **L2 i L3 su u `evaluate` identični.** Razlika je proceduralna (ko smije da zakaže poslove iz cilja), ne
   tehnička — kod ne brani L2 agentu da pozove `schedule` ako mu je ruta dostupna; brani mu samo ono što
   `plan`/`act` dozvole kažu. Stroga razlika L2/L3 je **planirana**.
9. **Replan ne zakazuje nove poslove.** `replan` upisuje `actions` u `goal.replans`, ali **ne** poziva
   `schedule` ponovo i ne gasi stare poslove. Operater mora ručno da odluči šta sa već zakazanim koracima.
   Automatsko „preuzmi replan u poslove" je **planirano**.

---

## Otvorena pitanja

1. **Koji je prvi konektor za automatsko mjerenje cilja** — Stripe (prihod), Shopify (narudžbe) ili interni
   CRM/ERP klijenta? Bez toga svi ciljevi zavise od ručnog upisa, a watcher `cilj_skrenuo` reaguje sa
   zakašnjenjem od jednog ciklusa mjerenja.
2. **Smije li L3 agent da sam pozove `schedule`** (pretvori plan u poslove i potroši budžet), ili `schedule`
   ostaje isključivo ljudska/admin odluka dok ne postoje tvrde veze `goal.budgetUsd` → `job.budgetPerRunUsd`?
3. **Kako tretirati `progressPct > 100`** — kao `achieved` odmah (sada tako radi), ili kao signal da je
   `target` bio prenizak i da treba novi (viši) cilj? Trenutno nema mehanizma za „cilj je premašen, podigni letvicu".
4. **Da li replan smije da poništi već zakazane poslove** (i kako to izgleda u auditu), ili je pravilo da
   zakazani korak uvijek ide do kraja pa se tek onda plan mijenja?
5. **Kada se prelazi na distribuiranog watchera** (Redis/Postgres lock + perzistentno stanje cooldown-a)?
   Trenutno je jedina replika uslov ispravnosti, a to nije nigdje u kodu zapisano kao tvrdi uslov —
   samo u dokumentaciji.
6. **Ko odgovara kad cilj „padne"** — `owner` je jedno polje, ali kod `missed` cilja nema ni notifikacije ni
   obaveznog pregleda. Da li u v1 uvesti obavezan nedjeljni ljudski pregled portfolija (što
   `config/watchers.json` sada nudi samo kao `propose` prijedlog)?
