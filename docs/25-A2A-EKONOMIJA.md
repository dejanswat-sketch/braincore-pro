# 25 — A2A ekonomija: pregovaranje, ugovori i poravnanje

> Nivo v0.3. Ovaj dokument opisuje **stvarno stanje koda**: `src/a2a/card.js`, `src/a2a/tasks.js`,
> `src/a2a/negotiation.js`, rute u `src/server/routes-autonomy.js` i testove u `tests/autonomy.test.mjs`.
> Sve što nije implementirano označeno je kao **planirano**.
>
> **Tri rečenice koje moraju stajati na početku:** A2A pregovaranje je implementirano kao mašina stanja
> sa tvrdim granicama. Poravnanje je **interni ledger — simulacija, nema stvarnog novca, nema blockchain-a**.
> Ugovor je zapis sa uslovima, `signature: null`; digitalni potpis, escrow i smart contract **nisu** u kodu.
> Sve pravno u ovom dokumentu je **prijedlog za razgovor sa advokatom**, ne pravni savjet.

---

## 1. Agent card

Agent card je „vizit karta" našeg agenta: `GET /.well-known/agent.json` (i `GET /a2a/card`), grade je
`buildAgentCard({ robot, tenantId, baseUrl })`. Ruta je javna po putanji, ali prolazi kroz **istu
autentikaciju kao i sve ostalo** (API ključ tenanta ili per-agent ključ, `Authorization: Bearer`);
`baseUrl` dolazi iz `config.env.publicUrl`.

Šta card izlaže (polje po polje, kako je u kodu):

| Polje | Vrijednost u kodu | Napomena |
|---|---|---|
| `protocolVersion` | `'1.0'` | naša oznaka verzije kartice |
| `name` | `NMQ Robot — <tenant.name ?? tenantId>` | ime iz `config/tenants.json` |
| `description` | fiksni tekst: domeni (support, prodaja, operacije, finansije, HR, dev, podaci, e-trgovina, pravno, kreativa) + „izvodi akcije kroz alate (MCP), uz politike, budžete i dokazivi audit trag" | marketinški, ali tačan |
| `url` | `<baseUrl>/a2a` | prefiks A2A ruta |
| `version` | `robot.version` | konstanta `VERSION` u `src/index.js` (trenutno `'0.2.0'`; `package.json` i dalje piše `0.1.0` — nedosljednost koju treba raščistiti) |
| `provider` | `{ organization: 'NMQ — Dejan Milošević PR', url: baseUrl }` | |
| `tenantId` | iz zahtjeva | više tenantа = više kartica, ista ruta |
| `capabilities.streaming` | `true` | SSE na `GET /a2a/tasks/:id/events` |
| `capabilities.pushNotifications` | `false` | **planirano** (nema webhook push-a nazad ka partneru) |
| `capabilities.stateTransitionHistory` | `true` | `history[]` na zadatku |
| `capabilities.negotiation` | `true` | `/a2a/negotiations` |
| `capabilities.settlement` | `true` | **interni ledger (simulacija)**; Stripe/SEPA/x402 planirano |
| `defaultInputModes` / `defaultOutputModes` | `['text/plain','application/json']` | zadatak prima `message` kao tekst |
| `authentication.schemes` | `['bearer']` | + `note` o API ključu tenanta i per-agent ključu `nmqa_…` |
| `limits.rateLimitPerMin` | `tenant.rateLimitPerMin ?? env.rateLimitPerMin ?? 60` | za `nmq` 120, za `demo-shop` 30 |
| `limits.monthlyBudgetUsd` | `tenant.budget.monthlyUsd ?? null` | za `nmq` 200 |
| `limits.autonomyDefault` | `autonomy.levelOf(tenantId, '*')` → fallback `'L1'` | tenant-nivo, ne agent-nivo |
| `skills[]` | agenti iz kataloga (vidi dalje) | `includeSkills` (default `true`) |

### `skills[]` — katalog kao ponuda

`skills` se ne pišu ručno: `catalog.view(tenantId)` daje agente **onako kako ih vidi taj tenant**
(uključujući per-tenant override iz kontrolne ravni), pa se filtrira:

```js
(cat?.all() ?? []).filter((a) => a.domain !== 'core' || ['researcher', 'critic', 'planner'].includes(a.id))
```

Drugim riječima: izlažu se **svi agenti čiji `domain` nije `core`**, plus tri „core" agenta koja imaju
smisla prema van (`researcher`, `critic`, `planner`). Ko je u kojoj grupi zavisi od `config/agents/*.json`
(npr. `router` i `critic` su `domain: 'core'`, a `executor` je `domain: 'ops'`), pa se **spisak skillova
čita iz kataloga, ne pretpostavlja** — u testu je jedina tvrdnja `card.skills.length >= 10`. Ako neki
agent ne treba da bude vidljiv partnerima, to se danas rješava njegovim `domain`-om ili override-om u
kontrolnoj ravni, a **ne** postoji poseban „A2A allowlist" za skillove (vidi §7). Mapiranje polja:
`id`, `name`, `description`, `domain`, `tags` (prvih 8 `routingHints`), `defaultPattern`,
`examples` (iz `kpi` agenta).

Primjer izlaza (ilustrativno, skraćeno — vrijednosti `skills` zavise od kataloga i override-a tenanta):

```json
{
  "protocolVersion": "1.0",
  "name": "NMQ Robot — NMQ — Dejan Milošević PR",
  "description": "Univerzalni AI agent: support, prodaja, operacije, finansije, HR, dev, podaci, e-trgovina, pravno i kreativa. Izvodi akcije kroz alate (MCP), uz politike, budžete i dokazivi audit trag.",
  "url": "https://robot.example/a2a",
  "version": "0.2.0",
  "provider": { "organization": "NMQ — Dejan Milošević PR", "url": "https://robot.example" },
  "tenantId": "nmq",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "stateTransitionHistory": true,
    "negotiation": true,
    "settlement": true
  },
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "authentication": {
    "schemes": ["bearer"],
    "note": "API ključ tenanta (Authorization: Bearer) ili per-agent ključ (nmqa_…)"
  },
  "limits": { "rateLimitPerMin": 120, "monthlyBudgetUsd": 200, "autonomyDefault": "L2" },
  "skills": [
    {
      "id": "support",
      "name": "Support agent",
      "description": "…",
      "domain": "support",
      "tags": ["…"],
      "defaultPattern": "agent",
      "examples": ["…"]
    }
  ]
}
```

> Card **ne izlaže** cijene, ključeve, tajne, interne putanje ni budžet po agentu. Izlaže limite na
> nivou tenanta — što je i namjera: partner treba da zna **koliko smije da traži**, ne koliko mi trošimo.

---

## 2. Zadaci između agenata (tasks)

`POST /a2a/tasks` (rola `run`) prima zadatak od drugog agenta ili A2A klijenta:

```json
{ "message": "…", "skillId": "support", "sessionId": "…", "fromAgent": "partner-bot",
  "params": { "pattern": "agent", "riskLevel": "low", "options": {} }, "wait": false }
```

- `message` (ili `input`) je obavezan; skraćuje se na **8000 znakova** (`input.slice(0, 8000)`).
- `skillId` može doći i kao `body.agentId` ili `body.params.agentId`.
- `sessionId` se generiše ako nije poslan (`a2asess_…`) — pa razgovor sa istim partnerom može da
  nastavi kontekst ako partner sam čuva i šalje `sessionId`.
- `wait: true` → ruta čeka ishod i vraća gotov zadatak; `wait: false` → vraća `submitted` odmah
  (bez `promise` polja u odgovoru — on se ne serijalizuje).

### Stanja

`const STATES = ['submitted','working','input_required','completed','failed','cancelled']`

| Stanje | Kako nastaje | Značenje za partnera |
|---|---|---|
| `submitted` | `send()` je upisao zadatak | primljeno, još se ne radi |
| `working` | `execute()` je počeo | u toku; `runId` se pojavljuje po završetku |
| `input_required` | `orchestrator.run()` vrati `status: 'awaiting_approval'` | **traži čovjeka na našoj strani** (odobrenje) |
| `completed` | run završio bez čekanja odobrenja | `output` je popunjen |
| `failed` | izuzetak u toku izvršavanja | `error: { message, code }` |
| `cancelled` | `POST /a2a/tasks/:taskId/cancel` | AbortController prekida run; ako je već terminalno, vraća se kao jeste |

Svaka promjena stanja ide u `history[]` (`{ts, state, by}`) i u JSONL zapis, i emituje se na bus kao
`a2a.task.<taskId>` **i** `a2a.task` (globalni kanal za posmatranje).

### Tok događaja (SSE)

`GET /a2a/tasks/:taskId/events` (rola `read`):

1. Odmah se šalje jedan `state` događaj sa trenutnim stanjem (`taskId`, `state`, `output`, `error`).
2. Ako je stanje već terminalno (`completed`/`failed`/`cancelled`) — stream se **odmah zatvara**;
   partner ne visi na otvorenoj vezi.
3. Inače se pretplaćuje na bus (`robot.bus.on('a2a.task.<id>')`) i šalje svaki događaj; `keep-alive`
   je `: ping` komentar **svakih 15 s** (`src/server/stream.js`), pa proxy koji reže tihe veze ne
   prekida stream.
4. Na `req.on('close')` skida se pretplata i zatvara stream.

### Otkazivanje

`POST /a2a/tasks/:taskId/cancel` (rola `run`). Traži zadatak **u aktivnoj mapi** (in-memory); ako je
proces restartovan, zadatak se nađe samo na disku i otkazivanje vraća `NotFoundError` — to je poznata
granica (vidi §7). Otkazivanje postavlja stanje `cancelled`, aborts signal i upisuje `history` unos
`by: 'client'`.

### Kako zadatak prolazi kroz iste politike, budžete i audit

Ovo je najvažnija rečenica ovog poglavlja: A2A zadatak **nema svoj zaobilazni put**. Izvršava se kroz
isti `orchestrator.run()` kao i korisnički zahtjev, sa:

| Sloj | Kako se primjenjuje na A2A zadatak |
|---|---|
| Autonomija | `autonomy.evaluate({ tenantId, agentId: skillId, riskLevel: params.riskLevel ?? 'low', kind: 'act' })` — rezultat ide u `task.autonomy` i u audit `decision` |
| Agent allowlist tenanta | `assertAgentAllowed` u `orchestrator.run` (isti put kao `/v1/run`) |
| Per-agent budžet | `assertAgentBudget` **prije** patterna — ako je prekoračen, zadatak pada sa `PolicyError` (i to se vidi kao `failed`) |
| Mjesečni budžet tenanta | `budget.assertCanContinue` unutar run-a |
| Run budžet (`runUsd`, `maxSteps`, `maxWallMs`) | isto, po pozivu |
| Politike alata (allow/deny/require_approval) | isti `policyResolver` i isti tool registry |
| Rate limit i auth | isti gateway (`src/server/http.js`) — `Authorization: Bearer` + `requiredRole` |
| Odobrenje | ako politika traži odobrenje → run vraća `awaiting_approval` → zadatak je `input_required`; odluka se donosi kroz `POST /v1/approvals/:runId` (rola `approve`) |
| Trošak | `cost.record` po LLM pozivu; ukupan `costUsd` se upisuje na zadatak |
| Audit | `action: 'a2a_task'`, `actor: 'a2a:<fromAgent>'`, `decision` iz autonomije, `outcome: ok/pending/error`, `runId`, `costUsd`, `pattern` |
| Metrike | `a2a_tasks_total{state}`, `a2a_task_duration_seconds` (samo za `completed`) |
| Log | `a2a.task_finished` sa `state` i `costUsd` |

Stanje na disku: append-only `data/tenants/<id>/a2a/tasks-YYYY-MM.jsonl` (svaka promjena = novi red sa
`_op: created|updated`) + snapshot aktivnih u `data/tenants/<id>/a2a/tasks.active.json` (zadnjih 200,
za brz pregled poslije restarta). `GET /a2a/tasks` i `GET /a2a/tasks/:taskId` (rola `read`) čitaju i
aktivne i one sa diska, uz provjeru `tenantId` (tuđi zadatak = `NotFoundError`).

### Primjer toka: partner agent → naš support

1. Partner pokupi `/.well-known/agent.json`, vidi `skills: [support, sales, …]` i `limits`.
2. `POST /a2a/tasks` sa `{ message: "Kupac tvrdi da narudžbina nije stigla, šta je politika povraćaja?", skillId: "support", fromAgent: "partner-bot", wait: true }`.
3. Naš gateway: auth → rate limit → rola `run` → `a2a.send()` → zapis `submitted` → `working`.
4. `autonomy.evaluate(skillId: 'support', riskLevel: 'low')` — za `demo-shop` je `support` na `L2`,
   `allow`; za `nmq` default `L2`, `allow`.
5. `orchestrator.run()` — `support` agent čita KB, možda zove `memory_search`; sve kroz politike i budžet.
6. Ako je odgovor o povraćaju označen kao `external_communication`/`financial` → traži odobrenje →
   zadatak je `input_required`, partner dobija to stanje preko SSE, a naš operator odobrava kroz
   `POST /v1/approvals/:runId`.
7. Inače: `completed`, `output` je odgovor, `runId` i `costUsd` su upisani, audit ima zapis,
   metrike su inkrementirane. Partner dobija finalni događaj na SSE toku.

**Šta ovdje fali (planirano):** `resumeAfterApproval(tenantId, taskId)` postoji u kodu ali **nije
povezan ni na jednu rutu** — zadatak u `input_required` se ne „nastavlja" automatski poslije odobrenja
u A2A zapisu (odobrenje nastavlja **run** kroz `/v1/approvals/:runId`, a `task.state` se ne mijenja
posebnim pozivom). To je prva stvar koju treba spojiti prije ozbiljnog partnerskog saobraćaja.

---

## 3. Pregovaranje (cena, uslovi, rok)

`src/a2a/negotiation.js` → `createNegotiator({ …, defaultConstraints })`. Rute:
`POST /a2a/negotiations` (rola `run`), `GET /a2a/negotiations`, `GET /a2a/negotiations/:id`,
`POST /a2a/negotiations/:id/respond` (rola `run`), `POST /a2a/negotiations/:id/close` (**rola `approve`**).

### Constraints (granice) — default iz `src/index.js`

```js
defaultConstraints: { maxAmountUsd: 5000, requireHumanAboveUsd: 250, maxRounds: 5 }
```

`constraintsFor(tenantId, overrides)` spaja default iz konstruktora sa onim što pošalje poziv (ili
partner). Moguće ih je zadati **po pregovoru**, što je i namjena: svaki posao nosi svoje granice.

| Constraint | Default | Šta radi |
|---|---|---|
| `maxAmountUsd` | 5000 | **tvrda** gornja granica ponude; preko nje `PolicyError` pri otvaranju, a pri odgovoru status `escalated` |
| `minUnitPriceUsd` | 0 | pod ovom jediničnom cijenom pregovor je `rejected` (štiti maržu) |
| `allowedCounterparties` | `['*']` | lista dozvoljenih partnera; `'*'` = svi; nepoznat partner → `PolicyError` |
| `requireHumanAboveUsd` | 250 | iznad ovog iznosa dogovor **ne** ide u `agreed`, nego u `awaiting_human` + prijedlog čovjeku |
| `maxRounds` | 5 | broj rundi; dostignut limit bez dogovora → `expired` |

### Stanja

`open` → `respond` → (`agreed` | `rejected` | `escalated` | `awaiting_human` | `expired`) → `close` = `closed`

| Stanje | Kako nastaje | Šta dalje |
|---|---|---|
| `open` | `open()` | čeka `respond()` |
| `agreed` | `accept: true` **i** iznos ≤ `requireHumanAboveUsd` | `close()` (rola `approve`) → poravnanje + ugovor-zapis |
| `awaiting_human` | `accept: true` **i** iznos > `requireHumanAboveUsd` | prijedlog u inbox (`target: 'finance'`, `riskLevel: 'high'`); `close()` baca `ValidationError` dok stanje nije `agreed` |
| `rejected` | ponuda pod `minUnitPriceUsd` | pregovor je završen; novi pregovor ili ručna odluka |
| `escalated` | ponuda **preko** `maxAmountUsd` | prijedlog u inbox (`target: 'sales'`, `riskLevel: 'high'`) |
| `expired` | dostignut `maxRounds` bez prihvatanja | nema automatskog nastavka |
| `closed` | `close()` uspješno | postoji `settlementId` i `contract` |

### Tok ponuda

`open({ tenantId, counterparty, topic, ourOffer, constraints, direction })`:

- validira partnera (`assertCounterparty`) i, ako je poslana naša ponuda, da ne prelazi `maxAmountUsd`;
- upisuje `offers: [{ ts, by: 'us', ...ourOffer }]`, `current`, `round: 0`;
- postavlja `requiresHuman = Number(ourOffer?.amountUsd ?? 0) > requireHumanAboveUsd`;
- audit: `negotiation_open` sa `decision: allow` ili **`require_approval`** ako `requiresHuman`.

`respond(tenantId, id, { offer, accept, by, note })`:

- odbija ako stanje nije `open` (`ValidationError`) ili ako je `round >= maxRounds`;
- **redoslijed provjera je bitan:** (1) preko `maxAmountUsd` → `escalated` + prijedlog;
  (2) ispod `minUnitPriceUsd` → `rejected` + `reason`; (3) inače `current = offer`;
- zatim: `accept && state === 'open'` → iznad praga `awaiting_human` (+ prijedlog), inače `agreed`;
- ako nije prihvaćeno i `round >= maxRounds` → `expired`;
- svaka runda se dopisuje u `offers` i u JSONL, uz audit `negotiation_response`
  (`decision: allow` samo za `agreed`, inače `require_approval`) i metriku `negotiations_total{state}`.

`close(tenantId, id, { by, currency })` — **rola `approve`**: dozvoljen samo iz `agreed`; pravi
poravnanje preko `settlement.create({ from: 'nmq-robot', to: counterparty, method: 'internal', … })`,
postavlja `state: 'closed'`, `settlementId`, `closedAt` i `contract` zapis (vidi §5).

### Tabela scenarija (ono što test dokazuje)

| Scenario | Ulaz | Ishod u kodu | Dokaz |
|---|---|---|---|
| Ponuda **preko maksimuma**, pri otvaranju | `ourOffer.amountUsd = 999999`, default `maxAmountUsd` 5000 | **`PolicyError`** — pregovor se ne otvara | `A2A: pregovor — granice, dogovor i poravnanje` |
| Ponuda **preko maksimuma**, u odgovoru | partner ponudi iznos > `maxAmountUsd` | stanje **`escalated`** + `proposalId` (`source: 'a2a-negotiation'`, `riskLevel: 'high'`) | kod; direktnog testa za ovaj put **nema** (dokazan je `awaiting_human` put, koji koristi isti `createProposal` mehanizam) |
| **Ispod minimalne jedinične cijene** | `offer.unitPriceUsd = 4`, `minUnitPriceUsd = 10` | stanje **`rejected`**, `reason` sadrži „ispod minimuma" | `…traži čovjeka (proposal), ispod minimuma se odbija` |
| **Iznad praga za čovjeka**, prihvatanje | `amountUsd = 3000`, `requireHumanAboveUsd = 1000` | stanje **`awaiting_human`** + prijedlog `riskLevel: 'high'`; `close()` baca `ValidationError` | isti test |
| **Nedozvoljen partner** | `allowedCounterparties: ['dobavljac-x']`, partner `zli` | **`PolicyError`** — ne otvara se | isti test |
| Normalan tok u granicama | 200 → 240 → 200 `accept` | `open` → `round 1` → **`agreed`** → `close` → `settled` | `A2A: pregovor — granice, dogovor i poravnanje` |
| Prekid bez dogovora do `maxRounds` | 5 rundi bez `accept` | **`expired`** | kod (nema posebnog testa za `expired`) |

Iznosi i pragovi u testovima su **testne vrijednosti** — produkcione granice se zadaju po pregovoru i
moraju doći iz poslovne odluke (vidi „Otvorena pitanja").

---

## 4. Poravnanje (settlement)

`createSettlement({ dataDir, logger, metrics, audit, defaultCurrency = 'EUR' })`.

> ⚠️ **Ovo nije plaćanje.** Interni ledger je **simulacija**: nema stvarnog prenosa novca, nema banke,
> nema blockchain-a, nema waleta. Zapis ima `note` koji to i kaže u samom podatku
> („Interni ledger (simulacija) — nema stvarnog prenosa novca."). Test to provjerava (`/simulacija/`).

Polja zapisa (`settlement.create`):

| Polje | Tip | Napomena |
|---|---|---|
| `id` | string | `set_…` |
| `ts` | ISO string | vrijeme kreiranja |
| `tenantId` | string | izolacija |
| `from` / `to` | string | kod `close()` je `from: 'nmq-robot'`, `to: <counterparty>` |
| `amountUsd` | number | zaokruženo na 6 decimala; mora biti > 0 (`ValidationError`) |
| `currency` | string | default `'EUR'` (dok je iznos u polju `amountUsd`; to je nedosljednost koju treba raščistiti — vidi „Otvorena pitanja") |
| `reference` | string \| null | kod pregovora `neg:<id>` |
| `method` | string | `'internal'` (default) ili bilo šta drugo (`'stripe'`, `'sepa'`, `'x402'` — **planirano**) |
| `terms` | object | uslovi iz dogovora |
| `metadata` | object | npr. `{ topic, rounds }` |
| `status` | `'settled'` \| `'pending'` | `internal` → odmah `settled`; drugi metod → `pending` |
| `settledAt` | ISO \| null | popunjeno za `internal` |
| `note` | string | objašnjenje: simulacija ili „metod traži adapter (planirano)" |
| `externalRef` | string \| null | dolazi iz `settle()` kada adapter javi da je plaćanje prošlo |

Statusi i prelazi:

```
create(method:'internal')  → settled   (settledAt = ts)
create(method:'stripe'|'sepa'|'x402'|…) → pending   (note: traži adapter)
settle(tenantId, id, { externalRef })   → settle  samo iz pending; ako je već settled, vraća postojeći
```

`settle()` je **ručni hook** — „kad adapter javi da je plaćanje prošlo". To je namjerno: kod ne
pretpostavlja da je vanjski svijet uspio. Uz to: metrike `settlements_total{method,status}` i
`settlements_settled_total`, audit `settlement_create` i `settlement_settled`.
`totals(tenantId)` daje `{ count, settled, pending, byMethod }`; `list()` deduplikuje po `id` (uzima
zadnju verziju zapisa, jer je JSONL append-only sa `_op: 'update'`). `GET /a2a/settlements` vraća oboje
plus eksplicitnu `note` da je ledger simulacija.

### Kako bi se zakačio pravi novac (planirano)

| Metod | Šta treba prije nego radi | Rizik | Status |
|---|---|---|---|
| **Interni ledger** | ništa (postoji) | nema novca → nema rizika; **ne smije se prikazati kao naplata** | ✅ implementirano (simulacija) |
| **Stripe** (kartice, invoices, payment intents) | račun, KYC firme, webhook endpoint sa potpisom, idempotency key, refund tok, usklađivanje sa fakturama | chargeback, dupli webhook, povrat i storno, PCI opseg (ako se podaci kartice diraju — kod Stripe Checkout se ne diraju) | ⏳ planirano |
| **SEPA / bankarski nalog** | IBAN, nalog za prenos, izvod (CAMT/MT940) za usklađivanje, referenca plaćanja | nema trenutne potvrde, ručno uparivanje, greške u referenci, sporije | ⏳ planirano |
| **x402 / stablecoin mikro-plaćanje** | wallet sa malim saldom, provider/protokol, KYC/AML gdje se primjenjuje, računovodstveni tretman (valuta, kurs, PDV) | volatilnost ako nije stablecoin, regulatorna neizvjesnost, neopozivost, privremena i poreska evidencija | ⏳ planirano, **samo za mikro-iznose i probni period** (vidi §6) |

Zajednička pravila za svaki adapter (nijedno nije u kodu, sve je planirano): idempotency key na svaki
pokušaj, potpisani webhook sa provjerom, `externalRef` u zapisu poravnanja, i **nikad** `amountUsd` iz
LLM-a kao konačan iznos bez ljudske potvrde iznad praga.

---

## 5. Ugovori i potpisi

### Šta je implementirano

`close()` pravi `contract` zapis na pregovoru:

```js
contract: {
  topic,                                              // predmet
  parties: ['nmq-robot', counterparty],               // strane
  terms: neg.current,                                 // dogovoreni uslovi (amountUsd, terms, …)
  rounds: neg.round,
  signature: null,                                    // ⚠️ NEMA potpisa
  note: 'Radni zapis ugovora — potpis (digitalni/pravni) je sljedeći korak, van ovog modula.'
}
```

Dakle: **uslovi jesu strukturisani i dokazivi** (u JSONL-u i u auditu), a **potpis nije**. To je
„radni zapis", dovoljan da dvije strane imaju isti zapis o tome šta je dogovoreno — nije dokument koji
se može izvršiti.

### Šta nije implementirano

| Stvar | Status | Zašto je teško |
|---|---|---|
| Digitalni potpis (kvalifikovani/eIDAS, PAdES, XAdES) | ❌ planirano | traži certificiranog provajdera i pravni okvir; „potpis" koji sam pravimo ne vrijedi |
| Potpis ključem (HMAC/Ed25519) za tehničku dokazivost | ❌ planirano | jeftino tehnički, ali **nije** pravni potpis; korisno za integritet, ne za obavezu |
| Smart contract / on-chain ugovor | ❌ planirano | vidi §6 |
| Escrow (sredstva kod trećeg lica) | ❌ planirano | to je finansijska usluga; zahtijeva licencu ili partnera |
| Versionisanje i izmjene ugovora (amendments) | ❌ planirano | danas je ugovor nepromjenljiv zapis u trenutku `close()` |
| Veza ugovor ↔ faktura ↔ poravnanje | ⚠️ djelimično | postoji `reference: neg:<id>` na poravnanju; nema `contractId` na fakturi |

### Minimalni pravni okvir prije nego se ovo uključi

Ovo **nije** pravni savjet — sve stavke treba **provjeriti sa advokatom** (i, gdje se diraju lični
podaci, sa licem za zaštitu podataka):

1. **Ko je ugovorna strana.** Da li ugovara NMQ (Dejan Milošević PR) ili klijent (tenant)? Ako agent
   pregovara u ime klijenta, klijent mora dati **pisano ovlaštenje** i granice (mandat i `maxAmountUsd`
   su tehnička, ne pravna granica ovlaštenja).
2. **Uslovi korištenja + DPA.** Kada agent razmjenjuje podatke sa trećim agentom, to je obrada podataka
   po nalogu. Treba DPA sa klijentom i jasno reći šta **ne** izlazi (PII, cijene, baza znanja).
3. **Ograničenje odgovornosti** i isključenje posredne štete — naročito ako agent može da napravi
   obavezujuću ponudu. Realno: do potpisa, agent **predlaže**, čovjek **zaključuje**.
4. **Kada je ugovor zaključen.** Ako `agreed` u našem sistemu automatski znači obavezu, to mora biti
   eksplicitno u uslovima. Danas `agreed` ništa ne obavezuje — `close()` traži `approve` rolu.
5. **Porezi i računovodstvo** za svaki metod naplate (PDV, mjesto oporezivanja, kurs, evidencija).
6. **Revizijski trag kao dokaz.** Hash-chained audit i JSONL su dobri dokazi; advokat treba da potvrdi
   da su prihvatljivi i koliko se čuvaju (rok zastarjelosti).
7. **Incident i odgovornost** ako agent pogrešno odgovori partneru — ko plaća i kako se to ograničava.

Praktično pravilo do tada: **A2A ne smije zaključiti obavezujući posao bez čovjeka.** U kodu je to već
tako (`close` traži `approve`, iznad praga ide `awaiting_human`).

---

## 6. Blockchain: realno stanje u 2026

Ovo poglavlje je namjerno skeptično. Cilj nije „da li je blockchain dobra tehnologija", nego **gdje
rješava naš problem, a gdje ga pravi**.

### Gdje blockchain ima smisla

| Slučaj | Zašto tu tehnologija pomaže |
|---|---|
| **Trustless settlement između strana koje se ne poznaju** | Nema zajedničkog posrednika ni ugovora; ono što je zapisano je i izvršeno, bez „vjeruj mi da ću platiti" |
| **Mikro-plaćanja po pozivu** (plaćanje API-ja po tokenu/pozivu) | Klasična kartica je za to preskupa i prespora; model „plati i dobij podatak" u jednom potezu je prirodan |
| **Dokazivost i vremenska oznaka** | Nepromjenljiv zapis da je nešto postojalo u datom trenutku (hash ugovora/odluke), bez otkrivanja sadržaja |
| **Programabilni escrow bez posrednika** | Uslov „plati kad se isporuči" izvršava kod, ne čovjek — korisno kad treće lice nije dostupno ili je skupo |
| **Plaćanje „mašina-mašini" na otvorenom tržištu** | Kad agent kupuje od nepoznatog agenta, bez računa i fakture |

### Gdje blockchain **nema** smisla

| Slučaj | Zašto ne |
|---|---|
| **Interni procesi** (naše poravnanje između naših uloga/tenanta) | Nema nepovjerenja — baza i ledger su dovoljni; lanac samo dodaje latenciju i trošak |
| **B2B sa ugovorom i fakturom** | Postoji ugovor, postoji DPA, postoji faktura i zakonski rok plaćanja: lanac ne mijenja ni jednu obavezu |
| **Naplata pretplate klijentu** | Kartica/SEPA + faktura; dodavanje waleta i vaučera je korak nazad za korisnika |
| **Evidencija koja mora da se briše (GDPR)** | Nepromjenljivost je u direktnom sukobu sa pravom na brisanje — rješava se samo „hash van lanca, podatak u bazi" |
| **Sve gdje je potrebna ispravka greške** | Neopozivost znači da typo u adresi/iznosu nema povratka; klasičan payment ima chargeback i storno |

### Troškovi i rizici (sve treba provjeriti za konkretnu mrežu i jurisdikciju)

| Rizik | Šta konkretno znači |
|---|---|
| **Volatilnost** | Ako sredstvo nije stablecoin, iznos od danas nije iznos od sutra; za firmu je to kursni rizik u knjigama |
| **Regulativa** | Tretman kripto-imovine, pružanje usluga i prekogranična plaćanja se razlikuju po jurisdikciji i mijenjaju se — **provjeriti sa advokatom/poreznim savjetnikom** |
| **KYC/AML** | Primanje sredstava od nepoznatog lica povlači provjeru identiteta i porijekla sredstava; „agent plati agentu" ne ukida tu obavezu |
| **Neopozivost** | Greška je konačna; nema povrata bez saglasnosti druge strane |
| **Operativna sigurnost ključeva** | Izgubljen privatni ključ = izgubljena sredstva; krađa ključa = krađa sredstava; to je novi, tvrdi sigurnosni sloj koji moramo držati |
| **Računovodstvo** | Vrednovanje, PDV, priznavanje prihoda, evidencija po transakciji — sve to mora ući u knjige, a ne u dnevni izvještaj |
| **Zrelost ekosistema** | Standardi i provajderi se brzo mijenjaju; ono što danas radi može za godinu biti bez podrške |

### Preporuka za naš slučaj

1. **Interni ledger ostaje simulacija** dok ne postoji stvarna potreba — i to mora pisati u svakom
   odgovoru API-ja (i piše: `note`).
2. **Prvi pravi novac ide kroz klasičan kanal** (Stripe/SEPA + faktura), jer je to ono što klijent i
   knjigovodstvo već znaju, i zato što ima povrat, storno i jasan poreski tretman.
3. **Blockchain samo za uski slučaj:** mikro-plaćanje prema **nepoznatom** trećem agentu za
   mikro-uslugu (vidi §8c), sa **stablecoin-om**, malim dnevnim limitom, odvojenim wallet-om sa
   minimalnim saldom i **obaveznim** ljudskim odobrenjem pri prvom punjenju i pri svakoj promjeni limita.
4. **Nikakav „token" ni „naš chain"** — to ne rješava nijedan naš problem, a uvodi regulatorni i
   reputacioni rizik.
5. **Odluka se donosi na osnovu brojeva, ne entuzijazma:** ako mikro-plaćanja ne pređu mali mjesečni
   obim, klasičan kanal je jeftiniji i sigurniji.

Reference za dalje čitanje (spoljni izvori, **neprovjereni** u ovom projektu — tretirati kao tvrdnje
sa interneta, ne kao naše činjenice): [x402 standard i plaćanja stablecoin-om](https://www.theblock.co/news/business/2026-02-11-stripe-adds-x402-integration-usdc-agent-payments-389352),
[A2A v1.0 builder's guide](https://aaif.io/blog/a2a-v1-0-a-builder-s-guide-part-1-discovery-tasks-and-clients),
[stablo odluka u A2A protokolu (društveni primjer)](https://raw.githubusercontent.com/Hovborg/multi-agent/9bc8331bed8d90674bdf05b4e7684d9478486389/docs/protocols/a2a.md).

---

## 7. Sigurnost u A2A

### Šta je već zaštićeno

| Zaštita | Kako je u kodu |
|---|---|
| **Autentikacija** | `Authorization: Bearer` (API ključ tenanta ili per-agent `nmqa_…`) kroz isti gateway; opozvan/nepoznat ključ ne pada na anonimusa (D34) |
| **Autorizacija po roli** | `requiredRole`: `run` (kreiranje zadatka, odgovor u pregovoru, otkazivanje), `read` (čitanje), `approve` (`close` pregovora = novac!) |
| **Izolacija tenanta** | Svaki zadatak/pregovor/poravnanje ima `tenantId`; tuđi ID → 404, ne 403 sa podacima |
| **Tvrdi limiti pregovora** | `maxAmountUsd`, `minUnitPriceUsd`, `allowedCounterparties`, `maxRounds` — provjera **prije** upisa |
| **Odobrenje preko praga** | `requireHumanAboveUsd` → `awaiting_human` + prijedlog u inbox; `close` traži `approve` rolu |
| **Isti budžeti i politike** | A2A zadatak ide kroz `orchestrator.run`, pa kroz per-agent i tenant budžet i politike alata |
| **Audit svake ponude** | `negotiation_open`, `negotiation_response`, `negotiation_close`, `settlement_create`, `settlement_settled`, `a2a_task` — svaki sa `decision` i `outcome`, u hash-lancu |
| **Rate limit** | po tenantu (`rateLimitPerMin`), isti kao za ostale rute |
| **Bez izlaganja tajni** | Card ne sadrži ključeve, cijene ni interne putanje |
| **SSE higijena** | Terminalni zadatak odmah zatvara stream; `ping` svakih 15 s |

### Šta fali (planirano, po prioritetu)

| Nedostatak | Rizik | Predlog |
|---|---|---|
| **Potpisivanje zahtjeva** (npr. HMAC po tijelu + timestamp, ili Ed25519) | Replay i „ne poričem" — bez potpisa se ne može dokazati ko je šta poslao, a presretnut zahtjev se može ponoviti | Potpis na svaki `POST /a2a/*` + `X-NMQ-Timestamp` + `X-NMQ-Signature`; verifikacija prije handlera |
| **Anti-replay** | Ponovljen zahtjev (isti ID, isti sadržaj) može napraviti dupli posao ili dupli pregovor | `nonce`/`jti` po zahtjevu + kratki prozor (npr. 5 min) + keš obrađenih; za plaćanja obavezno **idempotency key** |
| **Reputacija partnera** | Nepoznat partner može trošiti naš budžet i praviti nam obaveze | Ocjena po partneru (uspješni zadaci, sporovi, kašnjenja), „novi partner" = tvrđi limiti dok se ne dokaže |
| **Kvote po partneru** | Jedan partner može pojesti tenant rate limit i budžet | Dnevni/mjesečni limit po `fromAgent`/partneru, odvojeno od limita tenanta |
| **Detekcija zloupotrebe** | Nagli skok broja pregovora, ponude tik ispod/iznad granice, ponavljanje istog zahtjeva | Alerti na obrasce: broj pregovora po partneru, % `escalated`, prosječan iznos, ponavljanje `offer` hash-a |
| **Verifikacija partnerovog card-a** | Prihvatamo da je partner onaj za koga se izdaje | Dohvatiti `/.well-known/agent.json` druge strane i provjeriti domen/TLS; za ozbiljne partnere razmjena ključeva van opsega |
| **Nastavak zadatka poslije odobrenja** | `input_required` zadatak se ne „otvara" sam; partner ne zna šta je odlučeno | Spojiti `a2a.resumeAfterApproval()` na tok odobrenja (ruta ili hook) |
| **Otkazivanje poslije restarta** | Zadatak sa diska se ne može otkazati (nema aktivne veze) | Otkazivanje i za „stale" zadatke + periodični reaper |
| **Potpis/verzija ugovora** | `signature: null` — nema tehničkog ni pravnog potpisa | Vidi §5 (uz advokata) |
| **PII u A2A porukama** | Partner može poslati lične podatke; mi ih čuvamo u `tasks-YYYY-MM.jsonl` i vraćamo u `output` | Redakcija ulaza/izlaza po istim pravilima kao za ostale kanale; politika čuvanja i brisanja po partneru |
| **Allowlist po partneru** | Danas se provjerava samo za **pregovore** (`allowedCounterparties`); zadaci nemaju listu | Uvesti `allowedAgentPeers` na nivou tenanta (isti duh kao `allowedAgents`) |

---

## 8. Poslovni scenariji

### (a) Nabavka — naš agent pita 3 dobavljača i bira

**Tok:** nabavka ima potrebu (npr. licence) → otvaramo **tri pregovora** (jedan po dobavljaču) sa istim
`topic` i uslovima → svaki dobavljač odgovara kroz `POST /a2a/negotiations/:id/respond` → uporedimo
`outcome` (iznos + uslovi + rok) → izaberemo jednog → `close()` (rola `approve`) → poravnanje
(interni ledger ili Stripe) → drugi pregovori se ostavljaju da `expire` ili se eksplicitno zatvore.

**Ko odobrava:** do `requireHumanAboveUsd` (default 250) pregovor ide u `agreed` i `close` traži
`approve` rolu; iznad praga → `awaiting_human` + prijedlog čovjeku (`target: 'finance'`,
`riskLevel: 'high'`).

**Gdje je novac:** u v0.3 **nigdje** — interni ledger je simulacija. U planu: Stripe/SEPA (ili x402 za
mikro-iznose), sa `externalRef` i `settle()` hook-om.

**Rizik:** pogrešna količina/rok u `terms` (strukturisano polje, ali popunjava ga LLM); nedozvoljen
dobavljač (štiti `allowedCounterparties`); tri istovremena pregovora mogu potrošiti budžet na
pregovaranje (svaka runda = LLM poziv, i to je vidljivo u `costUsd`); rizik „lažne uštede" ako se
upoređuju neuporedivi uslovi.

### (b) Prodaja — naš agent odgovara partnerovom upitu

**Tok:** partner pošalje `POST /a2a/tasks` sa `skillId: 'sales'` → naš `sales` agent (za `nmq` je `L3`)
pripremi odgovor/ponudu → ako je odgovor prema van (`external_communication`) ili sadrži cijenu
(`financial`), traži odobrenje → zadatak je `input_required`, čovjek odobrava kroz
`POST /v1/approvals/:runId` → partner dobija odgovor, a ako je ponuda prihvaćena, otvara se pregovor
kroz `/a2a/negotiations`.

**Ko odobrava:** svaki izlaz prema partneru koji nosi obavezu — čovjek; isto tako svaki popust
(`CSO vs CRO`, „marža je veto" u `docs/24` §7).

**Gdje je novac:** kod partnera → nama, kroz njegov kanal; u našem sistemu samo zapis poravnanja.

**Rizik:** obećanje cijene ili roka bez osnova; curenje internih cijena/marži u prompt ili odgovor;
preuzimanje obaveze bez ovlaštenja (zato `close` traži `approve`); reputacioni rizik ako partner
citira naš odgovor kao obavezujuću ponudu.

### (c) Mikro-usluga — naš agent plaća tuđi API po pozivu

**Tok:** naš agent treba tuđi podatak/prevod/embedding → pozove partnerov A2A endpoint sa zadatkom →
partner vrati uslove (cijena po pozivu) → pregovor sa vrlo malim `maxAmountUsd` i dnevnim limitom →
`agreed` (ispod praga) → poravnanje kroz **x402/stablecoin** (planirano) → `externalRef` u zapisu →
ako iznos poraste preko dnevnog limita, sledeći poziv se odbija TVRDO.

**Ko odobrava:** prvo punjenje wallet-a i **svaka promjena limita** — čovjek (owner); pojedinačni
mikro-poziv ispod dnevnog limita može agent.

**Gdje je novac:** u wallet-u trećeg lica/providera, ne u našem sistemu; kod nas je evidencija
(`settlements` sa `method: 'x402'`, `status: 'pending'` → `settled`).

**Rizik:** volatilnost (ako nije stablecoin), neopozivost, KYC/AML, računovodstveni tretman,
krađa ključa wallet-a, „agent potroši više nego što je predviđeno" (štiti dnevni limit + prag za
čovjeka), i pravni status mikro-plaćanja — **provjeriti sa advokatom** prije uključivanja.

---

## 9. Kako se to pokreće i testira

### Rute

| Metod | Ruta | Rola | Handler |
|---|---|---|---|
| GET | `/.well-known/agent.json` | (auth tenanta) | `buildAgentCard` |
| GET | `/a2a/card` | (auth tenanta) | `buildAgentCard` |
| POST | `/a2a/tasks` | `run` | `a2a.send` |
| GET | `/a2a/tasks` | `read` | `a2a.list` (`?state`, `?limit`) |
| GET | `/a2a/tasks/:taskId` | `read` | `a2a.get` |
| POST | `/a2a/tasks/:taskId/cancel` | `run` | `a2a.cancel` |
| GET | `/a2a/tasks/:taskId/events` | `read` | SSE tok (`state`, `working`, `completed`/`failed`/`cancelled` + `ping`) |
| POST | `/a2a/negotiations` | `run` | `negotiator.open` (`counterparty`, `topic`, `offer`, `constraints`) |
| GET | `/a2a/negotiations` | `read` | `negotiator.list` |
| GET | `/a2a/negotiations/:id` | `read` | `negotiator.get` |
| POST | `/a2a/negotiations/:id/respond` | `run` | `negotiator.respond` (`offer`, `accept`, `note`) |
| POST | `/a2a/negotiations/:id/close` | **`approve`** | `negotiator.close` → poravnanje + ugovor |
| GET | `/a2a/settlements` | `read` | `settlement.totals` + `list` + `note` (simulacija) |

Podaci na disku: `a2a/tasks-YYYY-MM.jsonl`, `a2a/tasks.active.json`, `a2a/negotiations.jsonl`,
`a2a/settlements-YYYY-MM.jsonl` (svaki u `data/tenants/<id>/`).

### Tabela testova (`tests/autonomy.test.mjs`, sekcija „A2A")

| Test | Šta dokazuje |
|---|---|
| `A2A: agent card opisuje skillove, limite i autentikaciju` | `protocolVersion === '1.0'`, `tenantId`, `capabilities.streaming === true`, `capabilities.negotiation === true`, `authentication.schemes[0] === 'bearer'`, `skills.length >= 10`, `limits.autonomyDefault` postoji |
| `A2A: zadatak od drugog agenta se izvršava i ima stanje + istoriju` | `wait: true` → `completed`, `output` sadrži odgovor, `history.length === 2`, `runId` postoji; `get()` i `list({state})` rade; **tuđi tenant → `NotFoundError`**; `send()` bez `message` → `ValidationError` |
| `A2A: pregovor — granice, dogovor i poravnanje (interni ledger)` | ponuda 999999 → `PolicyError`; normalan tok 200 → 240 → 200 `accept` → `agreed` → `close` → `settlement.status === 'settled'`, `amountUsd === 200`, `note` sadrži „simulacija", `contract.signature === null`; `totals.count === 1`, `totals.settled === 200`, `byMethod.internal >= 200` |
| `A2A: pregovor iznad praga traži čovjeka (proposal), ispod minimuma se odbija` | `requiresHuman === true`; `accept` iznad praga → `awaiting_human` + `proposalId` sa `riskLevel: 'high'`; `close()` baca `ValidationError`; `unitPriceUsd` pod minimumom → `rejected` + `reason`; nedozvoljen partner → `PolicyError` |
| `HTTP: ciljevi, prijedlozi, watcheri, autonomija, org i A2A rute` | kroz HTTP: `/.well-known/agent.json`, `POST /a2a/tasks` (`completed`), `GET /a2a/tasks/:id`, `POST /a2a/negotiations` → `respond accept` → `agreed` → `close` → `settled`, `GET /a2a/settlements` (`totals.count === 1`) |

Pokretanje:

```powershell
cd E:\NMQ-PROGRAMI\nmq-robot
node --test                          # cijeli suite
node --test tests/autonomy.test.mjs  # A2A + organizacija + autonomija
```

Stanje na dan provjere (2026-09-30): `node --test` → **150/150 prolazi** (`node v24.21.0`).

**Šta testovi ne pokrivaju (rupe):** SSE tok događaja (`/events`) se ne testira kroz HTTP; `expired`
stanje nema test; `escalated` na osnovu `maxAmountUsd` u `respond` nema direktan test (dokazan je
`awaiting_human` put); `settle()` za `pending` zapise nema test; `resumeAfterApproval()` nije pokriven
jer nije povezan na rutu.

---

## Otvorena pitanja

1. **Koje su produkcione granice?** `defaultConstraints` u `src/index.js` su `maxAmountUsd: 5000`,
   `requireHumanAboveUsd: 250`, `maxRounds: 5`. Da li to ide po tenantu (u `config/tenants.json`) i
   da li se smije mijenjati bez restarta (kontrolna ravan), ili ostaje u kodu?
2. **Valuta i iznos.** Polje se zove `amountUsd`, a default `currency` je `'EUR'`. Da li uvodimo
   jedinstveno polje `amount` + `currency` i kurs/datum kursa, ili ostajemo na USD + `currency` kao
   oznaci?
3. **Prvi pravi metod naplate** — Stripe, SEPA ili x402? Odluka određuje šta ide u `settle()`, šta u
   fakturu i koji je poreski tretman; sve tri stavke treba **provjeriti sa advokatom/knjigovođom**.
4. **Potpis ugovora.** Da li nam je dovoljan tehnički potpis (HMAC/Ed25519) za dokazivanje sadržaja i
   vremena, ili je potreban kvalifikovani elektronski potpis (i kod kog provajdera)?
5. **Ko smije biti partner?** Da li uvodimo `allowedAgentPeers` po tenantu (allowlist kao za agente) i
   obaveznu provjeru partnerovog agent card-a prije prvog zadatka?
6. **Politika čuvanja i PII u A2A.** Koliko dugo čuvamo `tasks/negotiations/settlements` zapise, i da li
   se PII iz partnerskih poruka redaktuje prije upisa ili samo pri izvozu? (GDPR brisanje po partneru
   nije implementirano.)
