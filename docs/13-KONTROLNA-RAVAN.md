# 13 — Kontrolna ravan (OCE stil, bez zavisnosti)

> Kontrolna ravan je **jedan modul** (`src/controlplane/registry.js`) i **jedan skup ruta**
> (`src/server/routes-admin.js`), bez ijedne npm zavisnosti i bez odvojenog servisa.
> Dokazi: `tests/max.test.mjs` (lifecycle, ključevi, budžet restart, admin API preko HTTP-a).
> Namjerno ograničenje: override u katalogu je **globalan po agentu**, ne po tenantu — vidi §3 i §8.

---

## 1. Šta kontrolna ravan radi

Pet sposobnosti, svaka sa jasnim vlasnikom u kodu:

| # | Sposobnost | Šta konkretno | Gdje je u kodu |
|---|---|---|---|
| 1 | **Lifecycle** | deploy nove verzije agenta (patch → aktivno odmah), `rollback` (uključujući `version: 0` = config baseline), `setStatus` (`active` / `paused` / `retired`), `setBudget`, `list`, `get`, `snapshot` | `src/controlplane/registry.js` (`deploy`, `rollback`, `setStatus`, `setBudget`, `list`, `get`, `snapshot`); rute `src/server/routes-admin.js` (`/v1/admin/agents*`) |
| 2 | **Identitet** | izdavanje per-agent ključa `nmqa_…`, čuvanje samo `sha256(pepper + ključ)`, `revokedAt`, `lastUsedAt`, provjera ključa (`authenticateAgentKey`) | `src/controlplane/registry.js` (`issueAgentKey`, `revokeAgentKey`, `authenticateAgentKey`, `hashKey`); rute `/v1/admin/agents/:agentId/keys` |
| 3 | **Budžet** | per-agent mjesečni limit `budgetUsdMonth` + tvrdi prekid prije run-a; seed iz `config/tenants.json` → `agentBudgets` | `src/controlplane/registry.js` (`setBudget`, `assertAgentBudget`, `agentSpend`); poziv iz `src/orchestration/index.js`; seed u `src/index.js` |
| 4 | **Politika** | pauziran/penzionisan agent se odbija; politika alata po tenantu/agentu (`allow`/`deny`/`require_approval`) ostaje u `src/core/policy.js` i primjenjuje se u `src/tools/registry.js` | `src/core/policy.js` (`resolvePolicy`, `evaluate`, `assertAllowed`), `src/tools/registry.js`, tenancy `allowedAgents` u `src/orchestration/index.js` |
| 5 | **Audit** | svaka lifecycle akcija, svaki blok budžeta, svaki tool poziv i svaka odluka odobrenja idu u hash-lanac po tenantu | `src/controlplane/registry.js` (`auditLifecycle`), `src/observability/audit.js`, `src/tools/registry.js`, `src/scheduler/index.js`, `src/server/routes.js` |

Kontrolna ravan **ne** izvršava agente i **ne** zove LLM. Ona je stanje + provjere + trag:
`assertAgentBudget` se poziva u `orchestrator.run` prije bilo kakvog rada, a `catalog.setOverride`
mijenja ono što `runAgent` vidi. Nadzor nad stanjem: `GET /v1/admin/health` (snapshot kontrolne ravni,
scheduler stats, sandbox `describe()`, MCP serveri, broj poslova, OTel brojač).

---

## 2. Model podataka

Stanje je **jedan JSON fajl**: `data/_control/agents.json`. Piše ga `persist()` (uz `updatedAt`),
čita `load()` pri `createRobot`. Struktura:

```
{
  "version": 1,
  "updatedAt": "<ISO>",
  "tenants": {
    "<tenantId>": {
      "agents": {
        "<agentId>": {
          "id": "<agentId>",
          "status": "active" | "paused" | "retired",
          "statusReason": null | "<string>",
          "activeVersion": 0,
          "versions": [ { "version": 1, "patch": {...}, "actor": "<keyId|'control-plane'|'rollback'>",
                          "note": null | "<string>", "createdAt": "<ISO>", "specHash": "<sha256>" } ],
          "overrides": { "<polje>": "<vrijednost>" },
          "keys": [ { "id": "akey_…", "hash": "<sha256(pepper:ključ)>", "role": "agent",
                      "scopes": ["crm:write"], "label": "server-1", "createdAt": "<ISO>",
                      "createdBy": "<keyId>", "lastUsedAt": null, "revokedAt": null } ],
          "budgetUsdMonth": null | <number>,
          "createdAt": "<ISO>"
        }
      }
    }
  }
}
```

Bitno: **vrijednost ključa se nikad ne upisuje** — samo `hash`. Test to provjerava čitanjem fajla
(`tests/max.test.mjs`: `assert.ok(!raw.includes(issued.key))`).

Primjer (skraćeno, izmišljeni tenant i ključevi — nijedna stvarna vrijednost):

```json
{
  "version": 1,
  "updatedAt": "2026-03-04T08:00:00.000Z",
  "tenants": {
    "nmq": {
      "agents": {
        "support": {
          "id": "support",
          "status": "active",
          "activeVersion": 2,
          "versions": [
            { "version": 1, "patch": { "temperature": 0.9 }, "actor": "key_1", "note": "topliji ton",
              "createdAt": "2026-03-04T07:59:00.000Z", "specHash": "<sha256>" },
            { "version": 2, "patch": { "maxSteps": 5 }, "actor": "control-plane", "note": null,
              "createdAt": "2026-03-04T08:00:00.000Z", "specHash": "<sha256>" }
          ],
          "overrides": { "temperature": 0.9, "maxSteps": 5 },
          "keys": [
            { "id": "akey_1", "hash": "<sha256>", "role": "agent", "scopes": ["crm:write"],
              "label": "server-1", "createdAt": "2026-03-04T08:01:00.000Z",
              "createdBy": "key_1", "lastUsedAt": null, "revokedAt": null }
          ],
          "budgetUsdMonth": 40,
          "createdAt": "2026-03-03T10:00:00.000Z"
        }
      }
    }
  }
}
```

Napomene o modelu (tačno kako kod radi):

1. `ensureAgent` vraća **virtualni** zapis (`emptyAgent`) ako agent još nije u fajlu i **ne upisuje ga**;
   fajl dobija zapis tek pri prvoj akciji koja zove `persist()` (`deploy`, `setStatus`, `setBudget`,
   `issueAgentKey`, `revokeAgentKey`).
2. `get()` vraća `{ ...zapis, effective: catalog.get(agentId) }` — dakle i efektivni spec (poslije zakrpa).
3. `specHash` je `sha256({ agentId, patch })` (`src/core/ids.js`), korisno za dokaz „šta je bilo deploy-ovano".
   Napomena: `sha256` za objekat koristi `JSON.stringify`, **ne** `stableStringify` (za razliku od audit
   lanca), pa isti `patch` sa drugačijim redoslijedom ključeva daje drugačiji `specHash` — uporedi ga
   normalizovanjem ako se koristi kao dokaz.
4. `statusReason` se upisuje samo kroz `setStatus`; `rollback` i `deploy` **ne** mijenjaju `statusReason`.
5. Fajl je jedan po **instalaciji** (ne po tenantu) — svi tenanti su u istom dokumentu pod `tenants`.

---

## 3. Agent lifecycle

### Deploy — zakrpa postaje aktivna odmah

```
POST /v1/admin/agents/:agentId/deploy    body: { patch: {...}, note?: "..." }
  ├─ validacija rute: body.patch mora biti objekat → ValidationError (400)
  └─ registry.deploy():
       ├─ tenant mora postojati (inače NotFoundError → 404)
       ├─ ako agent ne postoji u katalogu, dozvoljen je samo patch.systemPrompt (inače 404)
       ├─ patch mora imati ≥1 polje (inače ValidationError)
       ├─ version = activeVersion + 1
       ├─ overrides = { ...staro, ...patch }        ← SABIRANJE zakrpa
       ├─ status = 'active'                          ← deploy „odmrzava" pauziranog agenta
       ├─ versions.push({ version, patch, actor, note, createdAt, specHash })
       ├─ persist() → data/_control/agents.json
       ├─ catalog.setOverride(agentId, overrides)     ← ODMAH vidljivo u runAgent
       ├─ metrics.inc('controlplane_deploys_total')
       └─ audit action 'agent_deploy'
```

Dozvoljena polja zakrpe su polja specifikacije agenta iz `src/agents/catalog.js`: `systemPrompt`,
`tools`, `toolScopes`, `maxRisk`, `maxSteps`, `model`, `temperature`, `maxTokens`, `defaultPattern`,
`patternConfig`, `useKnowledge`, `episodic`, `ragK`, `routingHints`, `description`, `escalation`, `kpi`.
Zakrpa se **ne validira po poljima** — nepoznato polje se samo doda u spec (i nema efekta).

### Sabiranje zakrpa

Zakrpe se spajaju plitkim `Object.assign`: `v1 {temperature:0.9}` + `v2 {maxSteps:5}` → efektivno
`{temperature:0.9, maxSteps:5}` (dokaz u `tests/max.test.mjs`). Vrijednost se **zamjenjuje** — nema
`deepMerge`, pa zakrpa `patternConfig` zamjenjuje cijeli objekat, ne spaja polja.

### Rollback

```
POST /v1/admin/agents/:agentId/rollback   body: { version?: <number> }
  ├─ version === 0            → target = { version: 0, patch: {} }  = CONFIG BASELINE
  ├─ version === <n>          → target = versions.find(v => v.version === n)
  ├─ version nedostaje (null) → target = versions.at(-2)  (prethodna verzija)
  ├─ accumulated = Object.assign({}, ...versions.filter(v => v.version <= target.version).map(v => v.patch))
  ├─ overrides = accumulated;  activeVersion = target.version
  ├─ versions.push({ version: target.version, patch: accumulated, actor: 'rollback',
  │                  note: `rollback sa v${rolledBackFrom}`, createdAt, specHash })
  ├─ persist()
  ├─ accumulated ima polja ? catalog.setOverride : catalog.clearOverride
  └─ audit action 'agent_rollback' { from, to }
```

Posljedice koje treba znati prije upotrebe:

- **Rollback je istorija, ne brisanje.** Zapis ostaje u `versions[]` (novi red sa `actor:'rollback'`),
  pa je i rollback auditabilan.
- `version: 0` briše override (`catalog.clearOverride`) → agent se vraća **tačno** na `config/agents/*.json`.
  Dokaz: `tests/max.test.mjs` (`baseline.overrides` je `{}`, temperatura se vraća na početnu).
- Rollback **ne** vraća `status` — ako je agent pauziran, ostaje pauziran i `catalog` je bez override-a.
- Rollback na buduću/nepostojeću verziju → `ValidationError` („Nema verzije N za agenta X").

### Pause / resume / retire

```
POST /v1/admin/agents/:agentId/status   body: { status: 'active'|'paused'|'retired', reason?: "..." }
  ├─ nepoznat status → ValidationError (400)
  ├─ status 'active' + ima overrides → catalog.setOverride (zakrpe se vraćaju)
  ├─ status != 'active'              → catalog.clearOverride (agent radi po config-u)
  ├─ persist() + metrics 'controlplane_status_changes_total'
  └─ audit action `agent_${status}` (`agent_active` | `agent_paused` | `agent_retired`) + { reason }

efekat u radu:
  src/orchestration/index.js → controlPlane.assertAgentBudget() PRIJE patterna
    ├─ 'paused'  → PolicyError „Agent "X" je pauziran"
    └─ 'retired' → PolicyError „Agent "X" je penzionisan"
```

`retired` u praksi znači „ne diraj više": ne briše se iz `agents.json`, ne briše se iz `catalog`-a
(agent se i dalje vidi u `GET /v1/admin/agents`), ali se ne može pokrenuti. Uklanjanje iz config-a
nije lifecycle akcija — `list()` tada prikazuje red sa `missingInConfig: true`.

### Kako `catalog.setOverride` mijenja ponašanje bez restarta

`src/agents/catalog.js` drži `overrides: Map<canonicalId, patch>`; `get(id)`, `all()`, `byDomain()`,
`routingTable()` svi prolaze kroz `effective(base) = { ...base, ...patch }`. Pošto `runAgent` i ruter
čitaju spec preko `catalog.get()` **na svakom run-u**, zakrpa važi od sljedećeg zahtjeva — bez restarta,
bez reload-a i bez mreže. `logger.info('catalog.override_applied', ...)` je trag u logu.

Pri restartu `controlPlane.load()` **sam** poziva `catalog.setOverride` za svaki tenant/agenta gdje je
`status === 'active'` i `overrides` nije prazan (`logger.info('controlplane.override_restored')`).
Za `paused`/`retired` agente override se **ne** primjenjuje.

### Tabela: akcija → efekat → audit zapis

| Akcija (API) | Efekat u kodu | Efekat na agenta u radu | Audit zapis (`action`, `decision`, `outcome`) |
|---|---|---|---|
| `POST /v1/admin/agents/:id/deploy` | `deploy()`: nove verzije, `overrides` sabrane, `status='active'` | odmah, sljedeći run koristi novu spec | `agent_deploy` / `allow` / `ok` |
| `POST /v1/admin/agents/:id/rollback` (n) | `rollback()`: `overrides` = sabrane zakrpe ≤ n | odmah | `agent_rollback` / `allow` / `ok` (**bez** `actor` → `'control-plane'`) |
| `POST /v1/admin/agents/:id/rollback` (0) | `clearOverride` → config baseline | odmah | `agent_rollback` / `allow` / `ok` |
| `POST /v1/admin/agents/:id/status` (`paused`) | `status='paused'`, `clearOverride` | svaki run → `PolicyError` 403/`POLICY_DENIED` | `agent_paused` / `allow` / `ok` |
| `POST /v1/admin/agents/:id/status` (`active`) | `status='active'`, vraća `overrides` | ponovo radi | `agent_active` / `allow` / `ok` |
| `POST /v1/admin/agents/:id/status` (`retired`) | `status='retired'`, `clearOverride` | trajno blokiran | `agent_retired` / `allow` / `ok` |
| `POST /v1/admin/agents/:id/budget` | `budgetUsdMonth = number \| null` | blokada kad potrošnja ≥ limit | `agent_budget_set` / `allow` / `ok` |
| (automatski) potrošnja ≥ limit | `assertAgentBudget` throw prije run-a | run se ne pokreće | `agent_budget_block` / **`deny`** / **`blocked`** |
| `POST /v1/admin/agents/:id/keys` | novi `keys[]` zapis (hash) | ništa u run-u (ključ još nije vezan na gateway) | `agent_key_issued` / `allow` / `ok` |
| `DELETE /v1/admin/agents/:id/keys/:keyId` | `revokedAt = iso()` | `authenticateAgentKey` odmah vraća `null` | `agent_key_revoked` / `allow` / `ok` |

---

## 4. Per-agent identitet

### Izdavanje

```
POST /v1/admin/agents/:agentId/keys   body: { role?: 'agent', scopes?: [...], label?: "..." }
  └─ issueAgentKey():
       ├─ key = `nmqa_${token(24)}`                      (src/core/ids.js)
       ├─ record = { id: uid('akey'), hash: hashKey(key), role, scopes, label,
       │             createdAt, createdBy: actor, lastUsedAt: null, revokedAt: null }
       ├─ keys.push(record); persist()
       ├─ audit 'agent_key_issued' { keyId, role, scopes }
       └─ return { key, keyId, agentId, tenantId, role, scopes,
                   warning: 'Ključ se prikazuje samo sada — sačuvaj ga.' }
```

**Hash:** `hashKey(key) = sha256(`${pepper}:${key}`)`, gdje je `pepper = env.apiKeyPepper ??
process.env.NMQ_API_KEY_PEPPER ?? 'nmq-robot'`. Isti obrazac kao tenant API ključ u `src/tenancy/store.js`.
Ako `NMQ_API_KEY_PEPPER` nije postavljen u produkciji, pepper je fiksni string iz koda — to je
konfiguracijska obaveza, ne tajna u kodu.

**Scopes:** čuvaju se i vraćaju, ali ih **niko ne provjerava** u toku izvršavanja. `scopes` na alatima
(`tool.scopes`) se koriste samo pri filtriranju specifikacija za LLM (`specsFor`, `toolScopes` agenta).
Veza „agent ključ sa `scopes:['crm:write']` smije samo te alate" **nije implementirana** — planirano.

### Opoziv i provjera

```
DELETE /v1/admin/agents/:agentId/keys/:keyId
  └─ revokeAgentKey(): rec.revokedAt = iso(); persist(); audit 'agent_key_revoked'
     (nepoznat keyId → NotFoundError → 404)

authenticateAgentKey(key):
  ├─ hashKey(key) → candidateHash
  ├─ prolaz kroz SVE tenante → SVE agente → SVE ključeve
  ├─ preskače rec.revokedAt
  ├─ safeEqual(rec.hash, candidateHash)  (timing-safe)
  ├─ rec.lastUsedAt = iso()              (u memoriji! ne perzistira se odmah)
  └─ return { tenantId, agentId, role, scopes, keyId, auth: 'agent-key' }
```

⚠️ **Gdje se koristi danas:** samo programski i u testovima. `src/server/http.js` zove isključivo
`tenants.authenticate(...)` (`Bearer`/`x-api-key` + tenant hash), pa se `nmqa_…` ključ **ne može**
poslati na API. `tests/max.test.mjs` dokazuje `issue → authenticate → revoke → null` i to da se u fajlu
čuva samo hash. Dorada (planirano): u `src/server/http.js` prije `tenants.authenticate` probati
`robot.controlPlane.authenticateAgentKey(key)` i u `auth` ubaciti `agentId`; tada politika po agentu
(`resolvePolicy(policies, tenantId, { agentId })`) i `allowedAgents` rade i za mašinski identitet.

### Vezanje na MCP servere i service account-e

- **MCP server** se pokreće kao podproces (`stdio`) ili kao HTTP klijent; **ne dobija** agent ključ.
  Dobija očišćen env preko `sandbox.scrubEnv`, a u `config/tools.json` je `envAllowlist` na nivou
  **cijelog sandbox-a** (ne po serveru) — vidi ograničenja u `12` §5.
- **HTTP MCP** klijent šalje zaglavlja iz `config/tools.json` (`headers`), ali se `${ENV_VAR}` **ne**
  interpolira (`src/tools/mcp-http.js` predaje objekat dalje kako jeste).
- **Service account** u smislu infrastrukture: agent ključ je zamišljen kao „identitet agenta prema
  MCP serverima i internim servisima" (mapiranje na K8s `ServiceAccount` u §8), ali tu vezu treba
  dovršiti — trenutno je identitet samo zapis u kontrolnoj ravni.

### Šta još fali

| Fali | Posljedica | Gdje je predviđeno |
|---|---|---|
| Prihvatanje `nmqa_…` na HTTP gateway-u | agent ključ je za sada „mrtav" za API | `src/server/http.js` |
| Provjera `scopes` pri izvršenju alata | ključ sa `crm:write` nije ograničen u praksi | `src/tools/registry.js` / `src/agents/agent.js` |
| OIDC / SSO (ljudski identitet) | nema korisnika, nema grupa, nema MFA | planirano (nema koda) |
| mTLS između servisa | nema kriptografske provjere pozivaoca | planirano (nema koda) |
| Rotacija ključeva po rasporedu | nema `expiresAt`, nema automatskog opoziva | `src/controlplane/registry.js` (model dopuniti) |
| Per-agent rate limit | limit je samo po tenantu | `src/tenancy/store.js` (`rateLimit`) |
| Perzistencija `lastUsedAt` | `authenticateAgentKey` mijenja `rec.lastUsedAt` u memoriji, ali **ne** zove `persist()`; poslije restarta je ponovo `null` (defekt, ne samo nedostatak) | `src/controlplane/registry.js` |

---

## 5. Budžeti i kvote

Tri nezavisna nivoa; svaki može da prekine run, i nijedan ne „pozajmljuje" od drugog.

| Nivo | Limit | Gdje se provjerava | Pri prekoračenju |
|---|---|---|---|
| **Run** | `runUsd`, `maxSteps`, `maxWallMs`, `maxTokens` | `src/core/budget.js` (`assertCanContinue`) — prije svakog LLM poziva i svakog alata | `BudgetExceededError` (`limit: 'runUsd' | 'maxSteps' | 'maxWallMs' | 'maxTokens'`) |
| **Tenant (mjesečno)** | `tenant.budget.monthlyUsd` (config/tenants.json) → `createBudget({ monthlyUsd, spentThisMonthUsd })` | `src/core/budget.js` + `cost.monthlySpent(tenantId)` u `src/orchestration/index.js` | `BudgetExceededError` „Mjesečni budžet tenantа prekoračen" |
| **Per-agent (mjesečno)** | `budgetUsdMonth` u `data/_control/agents.json` | `src/controlplane/registry.js` (`assertAgentBudget`) — **prije** patterna, u `orchestrator.run` | `PolicyError` + audit `agent_budget_block` (`decision:'deny'`, `outcome:'blocked'`) |

### Kako se sabira potrošnja

`src/observability/cost.js`:

- `record({ tenantId, agentId, runId, model, usage })` dopisuje jednu liniju u
  `data/tenants/<id>/usage/YYYY-MM.jsonl` sa `tokensIn`, `tokensOut`, `usd` (cijena iz `PRICING`).
- `summary(tenantId, { month })` čita **taj mjesec**, sabira `usd`, `tokensIn/Out`, `calls`, i pravi
  `byAgent` i `byModel` mape.
- `monthlySpent(tenantId)` = `summary().usd` (mjesec iz `new Date().toISOString().slice(0,7)`).
- `agentSpend(tenantId, agentId, summary)` u kontrolnoj ravni = `summary.byAgent[agentId] ?? 0`.

Dakle **isti izvor** hrani tenant i per-agent limit; nema dvostrukog računanja i nema zaokruživanja na
dva mjesta (osim `toFixed(6)` u `summary`, dok `agent_budget_block` prijavljuje `spend` sa 4 decimale).

### Šta se dešava pri prekoračenju

1. Prva provjera je **per-agent** (`assertAgentBudget`) — prije nego se otvori trace i prije planera.
   Blokada ne troši ni jedan token i ne pravi novi run.
2. Druga je **tenant mjesečna**, unutar `budget.assertCanContinue` (fail-closed: ako se ne može
   dokazati da je dozvoljeno — prekid).
3. Treća je **run** (`runUsd`, `maxSteps`, 180 s default wall time).
4. Kod pauziranog/penzionisanog agenta blokada je **status**, ne budžet — ali ide kroz istu funkciju.

Test dokazuje redoslijed: `setBudget('nmq','creative', 0.0000001)` → prvi run prođe i potroši,
drugi run puca sa `PolicyError` i u auditu postoji `agent_budget_block`.

### Seed iz `config/tenants.json`

Pri `createRobot` (`src/index.js`), **poslije** `controlPlane.load()`:

```
for tenant of config.tenants:
  for [agentId, budget] of Object.entries(tenant.agentBudgets ?? {}):
     current = controlPlane.get(tenant.id, agentId)
     if (current.budgetUsdMonth === null || undefined) controlPlane.setBudget(tenant.id, agentId, budget)
```

- Seed je **idempotentan**: postojeći budžet se ne prepisuje, pa `PATCH`-ovan limit preživljava restart.
- `setBudget` piše audit `agent_budget_set` — pri prvom startu to znači nekoliko audit zapisa.
- Trenutno u `config/tenants.json`: `nmq` → `executor: 20`, `sales: 30`, `support: 40`;
  `demo-shop` → `support: 5`, `ecommerce: 5`.
- Limit je **mjesečni** i vezan na kalendarski mjesec UTC; nema dnevnih/satnih kvota i nema
  „grace" perioda. Vrijednost `null` znači „bez per-agent limita" (tenant limit i dalje važi).

---

## 6. RBAC i ABAC

### Implementirano (RBAC)

Role su fiksne u `src/tenancy/store.js` (`ROLES`):

| Rola | Dozvoljene akcije (`can(role, action)`) | Praktično znači |
|---|---|---|
| `owner` | `['*']` | sve, uključujući budžet i tajne |
| `admin` | `run`, `read`, `write`, `approve`, `manage-kb` | kontrolna ravan (osim `requiredRole: 'owner'`) |
| `operator` | `run`, `read`, `approve` | pokretanje i odobravanje, bez KB i bez admin ruta |
| `viewer` | `read` | samo čitanje; `GET /v1/admin/agents` → **403** (dokaz u `tests/max.test.mjs`) |

`requiredRole` na ruti provjerava `tenants.assertCan(auth.role, route.requiredRole)` u
`src/server/http.js` (prije handlera). Za `/v1/admin/*` (osim budžeta) to je `admin`; budžet je `owner`.

Tenant-ski ABAC koji **postoji**: `tenant.allowedAgents` (lista ili `'*'`) u
`src/orchestration/index.js` (`assertAgentAllowed`) — i za eksplicitni `agentId` i za agenta kojeg
izabere ruter. Agent van liste → `PolicyError`.

### Predlog (ABAC) — **nije implementirano**

Atributi koji već postoje u kodu i mogu se koristiti bez novih izvora podataka:

| Atribut | Izvor u kodu | Primjer pravila |
|---|---|---|
| Rizik alata (`riskLevel`) | `src/tools/registry.js` (`RISK_ORDER`, `specsFor`), `src/core/policy.js` (`risk`) | `high` + iznos > 1000 → `require_approval` (dva odobrenja) |
| Iznos (`args.amountUsd`) | `src/core/policy.js` (`tools.conditions.*.maxAmountUsd`) | `> maxAmountUsd` → `require_approval` |
| Vrijeme | `src/core/policy.js` (`businessHoursOnly`) | van 08–20 → `deny` (postoji za sve alate odjednom) |
| Izvor ulaza | `src/server/routes.js` (`hooks`, `HOOK_AGENTS`), `ctx.userId`/`sessionId` | webhook → samo `support`/`ecommerce`; admin UI → pun pristup |
| Tenant/plan | `config/tenants.json` (`plan`) | `starter` → zabranjeni `finance`/`legal` alati |
| Status agenta | `src/controlplane/registry.js` | `paused` → `deny` (implementirano) |
| Potrošnja | `src/observability/cost.js` | > 80% mjesečnog limita → samo `low` rizik |

Pseudo-kod predloga (proširenje `evaluate` u `src/core/policy.js`, **ne** novi modul):

```js
// PREDLOG — nije u kodu. Pravilo može samo da POOŠTRI odluku, nikad da je olabavi.
function evaluateAbac(baseVerdict, policy, action, attrs) {
  if (baseVerdict.decision === 'deny') return baseVerdict;      // deny je apsorbujući
  const rules = [...(policy.abac ?? []), ...(policy.tenants?.[action.tenantId]?.abac ?? [])];
  for (const r of rules) {
    if (!matchConditions(r.when, attrs)) continue;              // when: {riskLevel, minAmountUsd, source, hourFrom, plan}
    if (r.then === 'deny') return { decision: 'deny', reason: r.reason, rule: `abac.${r.id}` };
    if (r.then === 'require_approval' && baseVerdict.decision !== 'require_approval') {
      return { decision: 'require_approval', reason: r.reason, rule: `abac.${r.id}` };
    }
  }
  return baseVerdict;
}
```

Otvoreno u predlogu: ko je `attrs.source` (`'api' | 'hook' | 'job' | 'agent-key'`) i kako se
`args.amountUsd` pouzdano izvlači iz proizvoljnih alata (danas je konvencija, ne ugovor).

---

## 7. Audit

Kontrolna ravan piše **sve** lifecycle i sigurnosne akcije u hash-lanac po tenantu:

| `action` | Kad nastaje | `decision` / `outcome` | `meta` |
|---|---|---|---|
| `agent_deploy` | `deploy()` | `allow` / `ok` | `version`, `fields[]`, `note` |
| `agent_rollback` | `rollback()` | `allow` / `ok` | `from`, `to` |
| `agent_active` / `agent_paused` / `agent_retired` | `setStatus()` | `allow` / `ok` | `reason` |
| `agent_budget_set` | `setBudget()` (i seed pri startu) | `allow` / `ok` | `budgetUsdMonth` |
| `agent_budget_block` | `assertAgentBudget()` | **`deny`** / **`blocked`** | `spend`, `budget` |
| `agent_key_issued` | `issueAgentKey()` | `allow` / `ok` | `keyId`, `role`, `scopes` (**bez vrijednosti ključa**) |
| `agent_key_revoked` | `revokeAgentKey()` | `allow` / `ok` | `keyId` |
| `job_create` / `job_remove` | `scheduler.createJob` / `remove` | `allow` / `ok` | `jobId`, `agentId`, `schedule` |
| `job_run` / `job_run_manual` | `scheduler.runJob()` | `allow` / `deny` / `ok` / `error` | `costUsd`, `status`, `durationMs`, `reason`, `event` |
| `tool_call` | `tools.execute()` (svaki poziv, i odbijen i odobren i pao) | `allow` / `deny` / `require_approval` / `ok` / `blocked` / `pending` / `error` | `rule`, `reason`, `durationMs`, `resultPreview` |
| `approval_decision` | `POST /v1/approvals/:runId` | `approved` / `rejected` | `approvals[]` |

### Hash-lanac

`src/observability/audit.js`:

```
body  = { ts, seq, tenantId, actor, userId, runId, action, tool, args, decision, outcome, prevHash, meta }
hash  = sha256(stableStringify(body))
entry = { ...body, hash }
prevHash prvog zapisa = GENESIS = '0'.repeat(64)
fajl  = data/tenants/<tenantId>/audit/audit.jsonl   (append-only)
args  → stripSecrets + redact (tajne i PII se ne upisuju)
meta  → stripSecrets
```

`seq` je monotono rastući i drži se u memoriji (`heads: Map<tenantId, {seq, hash}>`), inicijalizovan
iz zadnjeg zapisa fajla pri prvom `append` poslije restarta.

### Kako se dokazuje nepromjenljivost

`audit.verify(tenantId)` (CLI: `node src/cli.js audit-verify`) prolazi cio fajl i za svaki zapis:

1. provjerava `body.prevHash === prethodniHash` → inače `{ ok:false, firstBadSeq, reason:'prevHash se ne poklapa' }`;
2. ponovo računa `sha256(stableStringify(body))` i poredi sa `hash` → inače `reason:'hash se ne poklapa (zapis je mijenjan)'`.

Vraća `{ ok:true, checked, head }`. Svaka izmjena, brisanje ili ubacivanje zapisa u sredini obara lanac.
**Iskreno:** lanac dokazuje **integritet**, ne **neporicanje** — onaj ko ima pristup fajl-sistemu može
da obriše cijeli fajl ili da prepiše sve zapise od početka (lanac će tada biti „ispravan"). Zato je
predviđeno eksterno sidrenje (dnevni `head` hash u odvojenom store-u / WORM) — trenutno **ne postoji**.

---

## 8. Mapiranje na Kubernetes

| Koncept kontrolne ravni | K8s resurs | Kako se mapira | Status u repou |
|---|---|---|---|
| Instalacija (svi tenanti) | `Namespace` `nmq-system` | jedan sistemski namespace, `pod-security…/enforce: restricted` | ✅ `infra/k8s/base/namespace.yaml` |
| Tenant | `Namespace` po klijentu (`nmq-tenant-<id>`) | odvojen prostor, svoje kvote i mrežna politika | ❌ šablon `infra/k8s/tenant-template/` **ne postoji** (pomenut u komentaru) |
| Agent (per-agent identitet) | `ServiceAccount` po agentu | `nmqa_…` ključ ↔ token/mount; agent dobija identitet u klasteru | ❌ planirano |
| Rola agenta / `scopes` | `Role` + `RoleBinding` | `scopes:['crm:write']` → dozvola nad konkretnim API-jem/servisom | ❌ planirano |
| Mrežna izolacija | `NetworkPolicy` | zabrana istoka–zapad saobraćaja osim allowliste | ❌ **ne postoji** (danas je izolacija samo u kodu: `sandbox.assertNetwork`) |
| Per-agent / per-tenant budžet | `ResourceQuota` | `budgetUsdMonth` ↔ CPU/mem kvota namespace-a (dva različita budžeta: novac vs resursi) | ✅ sistemski nivo u `namespace.yaml`; per-tenant ❌ |
| Default limiti po kontejneru | `LimitRange` | sprečava pod bez `resources` | ✅ `infra/k8s/base/namespace.yaml` |
| Tajne (`NMQ_MASTER_KEY`, `NMQ_API_KEY_PEPPER`, LLM ključ) | `Secret` (ovdje `ExternalSecret`) | imena ključeva u `deployment.yaml`, vrijednosti iz store-a | ✅ `infra/k8s/base/configmap.yaml` (ExternalSecret) |
| Scheduler poslovi (cron) | `CronJob` | spoljni cron za `audit-verify`, backup, rotaciju ključeva | ❌ planirano (interni scheduler je u procesu) |
| Skaliranje API-ja | `HPA` | po CPU/RPS; **zahtijeva odvojen scheduler sa 1 replikom** | ❌ planirano (deployment je `replicas: 1`) |
| Zdravlje | `livenessProbe` / `readinessProbe` / `startupProbe` | `/healthz`, `/readyz` | ✅ `infra/k8s/base/deployment.yaml` |
| Podaci | `PersistentVolumeClaim` `nmq-robot-data` (10Gi, RWO) | `NMQ_DATA_DIR=/data`, init kontejner pravi `tenants`, `_control`, `_global` | ✅ `infra/k8s/base/deployment.yaml` |

Primjer per-tenant namespace-a (**predlog** — fajl još ne postoji u repou):

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: nmq-tenant-nmq
  labels:
    app.kubernetes.io/part-of: nmq-platform
    nmq.io/tenant: nmq
    pod-security.kubernetes.io/enforce: restricted
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: nmq-tenant-quota
  namespace: nmq-tenant-nmq
spec:
  hard:
    requests.cpu: '2'
    requests.memory: 4Gi
    limits.cpu: '4'
    limits.memory: 8Gi
    pods: '6'
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: agent-support            # jedan po agentu; veže se na nmqa_… identitet
  namespace: nmq-tenant-nmq
automountServiceAccountToken: false
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: agent-support-role
  namespace: nmq-tenant-nmq
rules:
  - apiGroups: ['']
    resources: ['configmaps']
    verbs: ['get']               # scopes:['crm:write'] bi dodao pristup CRM servisu, ne K8s resursima
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: agent-support-binding
  namespace: nmq-tenant-nmq
subjects:
  - kind: ServiceAccount
    name: agent-support
    namespace: nmq-tenant-nmq
roleRef:
  kind: Role
  name: agent-support-role
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
  namespace: nmq-tenant-nmq
spec:
  podSelector: {}
  policyTypes: ['Egress', 'Ingress']
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: nmq-system
      ports:
        - { protocol: TCP, port: 8787 }
  ingress: []                    # niko spolja ne ulazi u tenant namespace
---
apiVersion: v1
kind: Secret
metadata:
  name: nmq-tenant-secrets      # vrijednosti se NE upisuju u git; ovdje samo imena ključeva
  namespace: nmq-tenant-nmq
type: Opaque
stringData:
  NMQ_API_KEY_PEPPER: '<iz store-a>'
  NMQ_MASTER_KEY: '<iz store-a>'
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nmq-audit-verify
  namespace: nmq-tenant-nmq
spec:
  schedule: '0 4 * * *'
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: verify
              image: nmq-robot:0.2.0
              command: ['node', 'src/cli.js', 'audit-verify']
```

---

## 9. API referenca

Sve rute iz `src/server/routes-admin.js` (+ `GET /v1/whoami`). Sve traže autentifikaciju
(`route.auth !== false`); `requiredRole` se provjerava u `src/server/http.js` **prije** handlera.
Tenant se određuje iz ključa, ili iz `x-tenant` / `body.tenantId` / `?tenant=` kad je anonimni režim
uključen (`NMQ_ALLOW_ANONYMOUS`, default u kodu je `true` — u produkciji postaviti `0`).

| Metod | Putanja | Rola | Tijelo / parametri | Odgovor (200) |
|---|---|---|---|---|
| GET | `/v1/whoami` | bilo koja autentifikovana | — | `{ tenantId, role, keyId, auth }` |
| GET | `/v1/admin/health` | `admin` | — | `{ controlPlane: {updatedAt, tenants, agents}, scheduler: {running, active, runningJobs}, agents, tools, sandbox, mcp[], jobs, otel }` |
| GET | `/v1/admin/agents` | `admin` | — | `{ agents: [{ id, status, activeVersion, versions, overrides[], keys, budgetUsdMonth, spendUsd, budgetUsedPct, lastDeployAt }] }` (+ `missingInConfig` za agente koji nisu u config-u) |
| GET | `/v1/admin/agents/:agentId` | `admin` | — | zapis agenta (`status`, `activeVersion`, `versions[]`, `overrides`, `keys[]`, `budgetUsdMonth`, `createdAt`) + `effective` (spec iz kataloga) |
| POST | `/v1/admin/agents/:agentId/deploy` | `admin` | `{ patch: {...}, note?, actor? }` — `patch` obavezan objekat | `{ agentId, version, active, patch }`; `400` ako nema `patch`, `404` nepoznat tenant/agent |
| POST | `/v1/admin/agents/:agentId/rollback` | `admin` | `{ version? }` (`0` = baseline; bez polja = prethodna) | `{ agentId, activeVersion, overrides }`; `400` ako verzija ne postoji, `404` ako agent nije u CP |
| POST | `/v1/admin/agents/:agentId/status` | `admin` | `{ status: 'active'\|'paused'\|'retired', reason? }` | `{ agentId, status }`; `400` za nepoznat status |
| POST | `/v1/admin/agents/:agentId/budget` | **`owner`** | `{ budgetUsdMonth: number \| null }` | `{ agentId, budgetUsdMonth }` |
| POST | `/v1/admin/agents/:agentId/keys` | `admin` | `{ role?, scopes?, label? }` | `{ key, keyId, agentId, tenantId, role, scopes, warning }` — **`key` se vidi samo ovdje** |
| DELETE | `/v1/admin/agents/:agentId/keys/:keyId` | `admin` | — | `{ keyId, revokedAt }`; `404` nepoznat ključ |
| GET | `/v1/admin/jobs` | `admin` | — | `{ jobs: [...], scheduler: {running, active, runningJobs} }` |
| POST | `/v1/admin/jobs` | `admin` | `{ agentId? \| pattern?, input?, name?, schedule?, triggers?, retry?, budgetPerRunUsd?, runNow? }` — traži `agentId` **ili** `pattern` | `job` (cijeli zapis: `id`, `schedule`, `nextRunAt`, `enabled`, `status`, `runs`, `process?`) |
| GET | `/v1/admin/jobs/:jobId` | `admin` | — | `job`; `404` ako ne postoji |
| GET | `/v1/admin/jobs/:jobId/runs` | `admin` | `?limit=` (default 20) | `{ runs: [...] }` filtrirano po `jobId` |
| POST | `/v1/admin/jobs/:jobId/run` | `admin` | — | `{ status, runId, output, costUsd, approvals }` ili `{ status: 'busy' }` ako lease drži neko drugi |
| POST | `/v1/admin/jobs/:jobId/pause` | `admin` | — | `job` (`enabled: false`, `status: 'paused'`); `404` ako ne postoji |
| POST | `/v1/admin/jobs/:jobId/resume` | `admin` | `{ everyMs? }` | `job` (`enabled: true`, `status: 'pending'`, novi `nextRunAt`) |
| DELETE | `/v1/admin/jobs/:jobId` | `admin` | — | `{ removed: true\|false }` |
| GET | `/v1/admin/episodes` | `admin` | `?limit=` (default 20) | `{ stats, episodes }` |
| POST | `/v1/admin/episodes` | `admin` | `{ problem, solution, ... }` — `problem` i `solution` obavezni | zapis epizode (`id`, `problem`, `solution`, `lessons[]`, …) |
| POST | `/v1/admin/processes` | `admin` | `{ steps: [...], name?, agentId?, stepDelayMs?, schedule?, runNow? }` — `steps` neprazan niz | `{ jobId, steps, nextRunAt, description }` |

Napomene: `sched()` i `cp()` bacaju `NotFoundError` ako scheduler/control plane nije inicijalizovan
(npr. `NMQ_SCHEDULER=0`) — tada `/v1/admin/jobs*` vraća **404**, ne 500. Mapiranje grešaka je u
`src/core/errors.js`: `ValidationError` → **400**, `NotFoundError` → **404**, `AuthError` → **401**,
`PolicyError` → **403** (`POLICY_DENIED`), `BudgetExceededError` → **402**, `ApprovalRequiredError` → **409**.

---

## 10. Operativni runbook

Pretpostavke: `BASE` je adresa gateway-a, `KEY` tenant API ključ (nikad se ne ispisuje u log),
`TENANT=nmq`. Auto je `x-api-key: $KEY` + `x-tenant: $TENANT`.

```bash
BASE=http://127.0.0.1:8787
H=(-H "content-type: application/json" -H "x-api-key: $KEY" -H "x-tenant: $TENANT")
```

### 1) Deploy toplijeg tona (support)

```bash
curl -sS "${H[@]}" -X POST "$BASE/v1/admin/agents/support/deploy" \
  -d '{"patch":{"temperature":0.9,"systemPrompt":"Ti si topao, ali kratak support agent."},"note":"topliji ton"}'
# → { "agentId":"support", "version":1, "active":{...}, "patch":{...} }
# provjeri da je odmah aktivno:
curl -sS "${H[@]}" "$BASE/v1/admin/agents/support" | grep -o '"temperature":[0-9.]*'
```

### 2) Rollback poslije incidenta

```bash
# (a) vrati prethodnu verziju (bez "version")
curl -sS "${H[@]}" -X POST "$BASE/v1/admin/agents/support/rollback" -d '{}'
# (b) vrati tačno na config baseline
curl -sS "${H[@]}" -X POST "$BASE/v1/admin/agents/support/rollback" -d '{"version":0}'
# dokaz u auditu (verify + zadnjih 20 zapisa):
curl -sS "${H[@]}" "$BASE/v1/audit?limit=20" | grep -o 'agent_rollback'
node src/cli.js audit-verify        # lanac mora biti ok za svaki tenant
```

### 3) Pauza agenta koji troši

```bash
# 1. koliko je potrošio (po agentu, ovaj mjesec) — summary.byAgent
curl -sS "${H[@]}" "$BASE/v1/usage" | grep -o '"creative":[0-9.]*'
# 2. pauza + razlog
curl -sS "${H[@]}" -X POST "$BASE/v1/admin/agents/creative/status" \
  -d '{"status":"paused","reason":"potrošnja iznad plana — čeka odobrenje"}'
# 3. tvrdi limit za slučaj da se vrati u rad (samo owner)
curl -sS "${H[@]}" -X POST "$BASE/v1/admin/agents/creative/budget" -d '{"budgetUsdMonth":5}'
# 4. vrati u rad kad se odobri
curl -sS "${H[@]}" -X POST "$BASE/v1/admin/agents/creative/status" -d '{"status":"active"}'
```

### 4) Izdavanje ključa za server (per-agent identitet)

```bash
curl -sS "${H[@]}" -X POST "$BASE/v1/admin/agents/executor/keys" \
  -d '{"role":"agent","scopes":["crm:write","internal:read"],"label":"server-1"}'
# → { "key":"nmqa_…", "keyId":"akey_…", "warning":"Ključ se prikazuje samo sada — sačuvaj ga." }
# ⚠️ ključ se NE može koristiti kao Authorization na API-ju (vidi §4); koristi ga programski:
#    robot.controlPlane.authenticateAgentKey(key)
# opoziv:
curl -sS "${H[@]}" -X DELETE "$BASE/v1/admin/agents/executor/keys/<keyId>"
```

### 5) Zakazivanje posla

```bash
# radnim danima u 08:00, agent ops
curl -sS "${H[@]}" -X POST "$BASE/v1/admin/jobs" -d '{
  "name":"jutarnji izvještaj","agentId":"ops","pattern":"agent",
  "input":"Napravi dnevni izvještaj o potrošnji i incidentima",
  "schedule":{"type":"cron","cron":"0 8 * * 1-5"},
  "budgetPerRunUsd":0.5,"retry":{"max":2,"backoffMs":5000}
}'
# odmah provjeri:
curl -sS "${H[@]}" "$BASE/v1/admin/jobs"
curl -sS "${H[@]}" -X POST "$BASE/v1/admin/jobs/<jobId>/run"
curl -sS "${H[@]}" "$BASE/v1/admin/jobs/<jobId>/runs?limit=5"
# pauza / nastavak / brisanje
curl -sS "${H[@]}" -X POST "$BASE/v1/admin/jobs/<jobId>/pause"
curl -sS "${H[@]}" -X POST "$BASE/v1/admin/jobs/<jobId>/resume" -d '{"everyMs":3600000}'
curl -sS "${H[@]}" -X DELETE "$BASE/v1/admin/jobs/<jobId>"
```

### 6) Pokretanje procesa onboardinga

```bash
curl -sS "${H[@]}" -X POST "$BASE/v1/admin/processes" -d '{
  "name":"onboarding Prima d.o.o.","agentId":"ops",
  "steps":[
    {"id":"dan1","name":"Kickoff","input":"Pošalji dobrodošlicu i zakaži kickoff"},
    {"id":"dan3","name":"Pristupi","input":"Dodijeli pristupe i provjeri CRM zapis"},
    {"id":"dan7","name":"Obuka","input":"Zakaži obuku i pošalji materijale"}
  ],
  "stepDelayMs":60000, "runNow":true
}'
# → { "jobId":"job_…", "steps":3, "nextRunAt":…, "description":"Koraci se izvršavaju jedan po jedan; proces pamti stanje i preživljava restart." }
# stanje procesa (done[], state, log[]):
curl -sS "${H[@]}" "$BASE/v1/admin/jobs/<jobId>"
# agent može da pomjeri proces (npr. čeka klijenta) alatom process_update:
#   { "jobId":"job_…", "state":"waiting_client", "note":"cekam potvrdu termina", "nextRunInMs":86400000 }
```

### Rutina poslije svake intervencije

1. `node src/cli.js audit-verify` — lanac ispravan za svaki tenant.
2. `curl -sS "$BASE/healthz"` i `"$BASE/readyz"` (u produkciji `llmIsMock: false`).
3. `GET /v1/admin/health` — `scheduler.running: true`, `sandbox.level`, `controlPlane.agents`.
4. Poslije restarta procesa: **prvi** `GET /v1/admin/jobs` (probudi scheduler — vidi `12` §4),
   pa provjeri `nextRunAt` na kritičnim poslovima.
5. Backup `data/` (uključuje `_control/agents.json` i `tenants/*/jobs/jobs.json`).

---

## Otvorena pitanja

1. Da li `overrides` u katalogu prelaze na ključ `tenantId:agentId` odmah (per-tenant deploy), ili
   kontrolna ravan do v1 ostaje vezana na „jedan proces = jedan tenant"? Ovo odlučuje da li je
   `POST /v1/admin/agents/:id/deploy` bezbjedan u multi-tenant režimu.
2. Da li `nmqa_…` ključ treba da bude prihvaćen na HTTP gateway-u (i sa kojom rolom/`scopes`), ili
   ostaje identitet samo za MCP servere i service account-e? Ako ulazi u gateway — kako se mapira na
   `ROLES` (`agent` nije u `ROLES`).
3. Kako da `scopes` postanu stvarna granica: provjera u `src/tools/registry.js` prije `execute`
   (po `ctx.agentKey.scopes`) ili filtriranje u `specsFor` (agent ni ne vidi alat)? Prvo je sigurnije,
   drugo je jeftinije.
4. Budžet: da li `budgetUsdMonth` ostaje vezan na kalendarski mjesec UTC, i da li nam treba i dnevna
   kvota (npr. `budgetUsdDay`) za agente koji troše u naletima?
5. Da li `paused` agent treba da zadrži zakrpe u katalogu (danas ih `setStatus` briše) — npr. ako je
   pauza operativna, a ne sigurnosna mjera?
6. Da li kontrolna ravan dobija svoj audit fajl (`data/_control/audit.jsonl`) ili sve ostaje u
   tenantovom auditu, kao danas? Danas `agent_deploy` za `nmq` ide u `data/tenants/nmq/audit/audit.jsonl`.
