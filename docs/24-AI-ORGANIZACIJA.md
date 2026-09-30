# 24 — AI organizacija: firma kao tim agenata

> Nivo v0.3. Ovaj dokument opisuje **stvarno stanje koda**: `config/company.json`, `src/org/company.js`,
> rute `GET/POST /v1/admin/org*` i testove u `tests/autonomy.test.mjs`.
> Gdje nešto nije implementirano, piše **planirano** — ne pretpostavka.
> Ugovor o putanjama i odlukama je u `docs/DECISIONS.md` (§6, §7, §8) i tamo je kod kanonski.

Ideja u jednoj rečenici: **firma se ne simulira razgovorom, nego podatkom.** Org chart je JSON,
ciklus planiranja je zapis u `.jsonl`, a pregovor između uloga je mašina stanja sa granicama —
i sve troje ostavlja trag u auditu i u trošku.

---

## 1. Org chart kao podatak

Org chart **nije** kod. Živi u `config/company.json`, a `src/org/company.js` ga samo čita
(`config.roles`) i obogaćuje trenutnim stanjem. To znači da se organizacija mijenja bez deploya koda:
dovoljno je izmijeniti JSON i restartovati proces (config se čita pri `createRobot`, nema hot reload-a).

Polja jednog unosa u `roles`:

| Polje | Tip | Šta znači | Ko ga koristi |
|---|---|---|---|
| `id` | string | kratki ključ uloge (`ceo`, `cro`, `cfo`…) — koristi se u rutama i u `goals.owner` | `roleById`, `POST /v1/admin/org/negotiate` (`between`) |
| `title` | string | naziv za ljude (`CRO (revenue)`) — ide u prompt pregovora | `company.negotiate` (system prompt) |
| `agentId` | string | **koji stvarni agent iz `config/agents/` izvršava posao uloge** | `goals` filtriranje, `cost.summary().byAgent`, `autonomy.levelOf`, `rewards.aggregate` |
| `reportsTo` | string \| null | hijerarhija; `null` = vrh | `chart()` (`null` ako nije zadato) |
| `mandate` | string | granica ovlaštenja uloge, u jednoj rečenici | prompt pregovora („Mandat: …") |
| `kpis` | string[] | šta se mjeri — **tekst**, mjerenje je u §5 | `chart().kpis`, `company.kpis()`, prompt |
| `budgetUsd` | number | **deklarisani** mjesečni budžet uloge; služi za `budgetUsedPct` | `chart()`; **nije** tvrdi runtime limit (vidi §5) |

Trenutni chart (7 uloga, `config/company.json`):

| Uloga | `agentId` | `reportsTo` | Mandat | KPI-jevi (kako pišu u configu) | `budgetUsd` |
|---|---|---|---|---|---|
| `ceo` | `decider` | — (vrh) | Strategija, prioriteti, alokacija ciljeva i budžeta, presuda u pregovorima | rast prihoda · marža · broj ciljeva na putu | 60 |
| `cro` | `sales` | `ceo` | Prodaja, cijene, upsell, pipeline | kvalifikovanih leadova · konverzija ponuda > 20% · prosječna vrijednost posla | 50 |
| `coo` | `ops` | `ceo` | Isporuka, rokovi, kvalitet procesa | poštovanje rokova > 90% · vrijeme od brief-a do plana < 15 min | 30 |
| `cfo` | `finance` | `ceo` | Marža, cash flow, naplata, kontrola troška | marža > 70% · dani naplate < 30 · trošak modela po zahtjevu < 0.02 USD | 25 |
| `cto` | `dev` | `ceo` | Pouzdanost, integracije, brzina isporuke promjena | greške runova < 1% · p95 latencija < 8s · vrijeme do popravke < 30 min | 25 |
| `chro` | `hr` | `ceo` | Znanje tima, onboarding, baza znanja | pokrivenost KB > 80% · vrijeme do short liste < 1 dan | 15 |
| `cso` | `support` | `ceo` | Zadovoljstvo klijenata, rješavanje bez čovjeka | riješeno bez čovjeka > 60% · vrijeme odgovora < 2 min | 40 |

`period: "month"` u istom fajlu je samo default oznaka perioda za ciklus; `cycle()` ga prima i kroz
`PERIOD:` u promptu, a zapis ide u fajl po **kalendarskom mjesecu** (vidi §3).

### Zašto su uloge vezane na postojeće agente iz `config/agents/`

`agentId` nije ukras — on je spojnica između „organizacione slike" i **stvarnih mehanizama** koji već
postoje u v0.1/v0.2:

| Mehanizam | Kako se spaja preko `agentId` |
|---|---|
| Ciljevi | `chart()` broji ciljeve gdje je `goal.owner === role.id` **ili** `goal.owner === role.agentId` — pa radi i ako je cilj pisan ulogom (`cro`) i ako je pisan agentom (`sales`) |
| Nagrade | `rewards.aggregate(tenantId, { groupBy: 'agent' })` → `avgReward` i broj uzoraka za tu ulogu |
| Trošak | `cost.summary(tenantId).byAgent[agentId]` → `spendUsd` i `budgetUsedPct` |
| Autonomija | `autonomy.levelOf(tenantId, agentId)` → nivo se ne izmišlja za ulogu, nasljeđuje ga od agenta (`config/autonomy.json`) |
| Politike i budžet | Agent ima svoje politike, per-agent budžet (`budgetUsdMonth`) i ključeve — uloga time ne mijenja ništa i ne zaobilazi ništa |
| Katalog | `catalog.get(agentId, tenantId)` daje prompt, model i pattern koje agent stvarno koristi |

Zaključak: **uloga je pogled (view) nad agentom, ne novi agent.** Uloga ne dobija sopstveni prompt,
sopstveni budžet u kontrolnoj ravni, ni sopstveni ključ. Zato uvođenje uloge ne povećava površinu
napada i ne pravi drugu istinu o tome koliko je potrošeno.

---

## 2. Šta uloga dobija

`company.chart(tenantId)` je jedan `async` poziv koji paralelno čita tri izvora i spaja ih po ulozi:

```
Promise.all([
  goals.list(tenantId),                          // svi ciljevi tenanta
  rewards.aggregate(tenantId, { groupBy:'agent' }),
  cost.summary(tenantId)                         // tekući mjesec (usage/YYYY-MM.jsonl)
])
```

Po ulozi vraća:

| Polje u izlazu | Izvor | Napomena |
|---|---|---|
| `goals[]` (`id`, `title`, `status`, `pct`) | `goals.list` filtrirano po `owner` | `pct` je `progressPct` iz `goals/manager.js` |
| `goalsAtRisk` | broj ciljeva sa statusom `at_risk`, `off_track` ili `missed` | status se računa iz napretka vs. proteklog vremena |
| `avgReward`, `samples` | `rewards.aggregate` | `null` dok nema uzoraka — **ne** pretvarati `null` u 0 |
| `spendUsd` | `cost.summary().byAgent[agentId]` | zaokruženo na 6 decimala |
| `budgetUsd` | `config/company.json` | deklarisani, ne nametnuti limit |
| `budgetUsedPct` | `spendUsd / budgetUsd * 100` | `null` ako uloga nema `budgetUsd` |
| `autonomy` | `autonomy.levelOf(tenantId, agentId)` | npr. `L1`–`L4` |

**Šta `chart()` NE vraća:** nivo autonomije tenanta kao cjelinu (onaj `*`). On se vidi u
`GET /v1/admin/autonomy` (`default` + `forTenant`). Ako treba u org pregledu — to je dopuna, ne
postojeće ponašanje.

Primjer izlaza (ilustrativni brojevi za tenant `nmq`; `avgReward` je `null` dok nema nagrada):

```json
{
  "tenantId": "nmq",
  "roles": [
    {
      "id": "ceo",
      "title": "CEO",
      "agentId": "decider",
      "reportsTo": null,
      "mandate": "Strategija, prioriteti, alokacija ciljeva i budžeta, presuda u pregovorima",
      "kpis": ["rast prihoda", "marža", "broj ciljeva na putu"],
      "budgetUsd": 60,
      "goals": [],
      "goalsAtRisk": 0,
      "avgReward": null,
      "samples": 0,
      "spendUsd": 0.0,
      "budgetUsedPct": 0.0,
      "autonomy": "L2"
    },
    {
      "id": "cro",
      "title": "CRO (revenue)",
      "agentId": "sales",
      "reportsTo": "ceo",
      "goals": [
        { "id": "goal_7f3a1c", "title": "Povećaj mjesečni prihod 15%", "status": "at_risk", "pct": 22 }
      ],
      "goalsAtRisk": 1,
      "avgReward": 0.71,
      "samples": 14,
      "spendUsd": 0.0842,
      "budgetUsd": 50,
      "budgetUsedPct": 0.2,
      "autonomy": "L3"
    }
  ]
}
```

Dvije stvari koje se iz ovoga vide odmah, a vrijedi ih gledati u nedjeljnom pregledu (§6):
uloga sa `goalsAtRisk > 0` i `spendUsd` koji raste bez napretka cilja.

> **Pažnja pri čitanju brojeva:** `budgetUsedPct` od 0.2 ne znači „uloga smije još 49.9 USD".
> Tvrdi limit je per-agent budžet iz kontrolne ravni (`data/_control/agents.json`) i mjesečni budžet
> tenanta (`config/tenants.json`, za `nmq` je `budget.monthlyUsd: 200`). Uloge su **namjera**, ne brana.

---

## 3. Ciklus planiranja

`company.cycle(tenantId, { period, topic, context })`. Ciklus **ne izvršava** ništa sam: proizvodi
plan, pokreće jedan pregovor i sve to zapisuje. Nijedan cilj se ne mijenja, nijedan posao se ne
zakazuje — to ostaje na ljudskom odobrenju ili na `goals.schedule()`.

Tok:

**(a) CEO alocira ciljeve i prioritete (LLM, JSON šema).** Jedan `helpers.callLlm` poziv, `role: 'org-ceo'`,
`temperature: 0.2`, `maxTokens: 900`, `responseFormat: json_object`. U prompt ide `PERIOD`, lista ciljeva
(`title`, `progressPct`, `status`, `deadline`, `owner`) i stanje uloga (nagrada, `budgetUsedPct`, ciljevi
u riziku). Tražena šema:

```json
{
  "priorities": ["..."],
  "allocation": [{ "role": "cro", "goals": ["..."], "budgetUsd": 0 }],
  "risks": ["..."],
  "decisions_needed": ["..."]
}
```

Ako LLM ne vrati parsabilan JSON, `helpers.parseJson(res.text, null)` daje `null`, a kod nastavlja sa
praznim planom (`{ priorities: [], allocation: [], risks: [], decisions_needed: [] }`) — ciklus i dalje
prođe i ostane zapisan. **To je namjerno:** tih fallback je bolji od pada ciklusa, ali znači da „prazan
ciklus" u istoriji treba čitati kao signal problema sa modelom, ne kao odluku.

**(b) CFO vs CRO pregovor o budžetu.** Ako postoje uloge `cfo` i `cro`, poziva se `negotiate()` sa
`topic` (default `"budžet za sljedeći period"`), `maxRounds` iz `context.maxRounds` (default 3) i
kontekstom `{ period, plan: plan.allocation, margin: context.margin ?? 0.7 }`. Rezultat se u ciklus
upisuje **sažeto**: `{ id, status, outcome, rounds }` — ne cijeli transkript.

**(c) Zapis i audit.** Ciklus ide kao **jedan JSONL red** u
`data/tenants/<id>/org/cycles-YYYY-MM.jsonl` (`type: 'org_cycle'`), a pregovori (i oni samostalni i onaj
iz ciklusa) u **isti fajl** sa `type: 'negotiation'`. Fajl se rotira po kalendarskom mjesecu
(`new Date().toISOString().slice(0,7)` — UTC). Uz to: metrika `org_cycles_total{tenant,period}`,
audit zapis `org_cycle` (`actor: 'ceo'`, `decision: 'allow'`) i `logger.info('org.cycle')`.

Zapis ciklusa nosi i `chartAtCycle` (presjek stanja uloga u trenutku planiranja) i `costUsd`
(CEO poziv + svi pozivi iz pregovora). To je ono što omogućava da se **kasnije** poredi šta je plan
rekao i šta se stvarno desilo.

| Korak | Ko | Ulaz | Izlaz | Ako padne |
|---|---|---|---|---|
| (a) Alokacija | `roleById('ceo').agentId` (`decider`) kroz LLM | `PERIOD`, portfolio ciljeva, stanje uloga iz `chart()` | `plan {priorities, allocation, risks, decisions_needed}` | LLM greška/budžet → **cijeli `cycle()` pada** (nema zapisa); neparsabilan JSON → prazan plan + zapis prolazi |
| (b) Pregovor o budžetu | `cfo` ↔ `cro` (LLM, naizmjenično) | `topic`, `maxRounds`, `context{period, plan, margin}` | `{id, status: agreed\|escalated, outcome, rounds}` | LLM greška → izuzetak iz `negotiate()` → **ciklus pada**; nema dogovora u N rundi → `escalated` + prijedlog za čovjeka, **ciklus se nastavlja** |
| (c) Zapis | `company.cycle()` | plan + sažetak pregovora + `chartAtCycle` | red u `org/cycles-YYYY-MM.jsonl` + audit `org_cycle` + `org_cycles_total` | Greška upisa → izuzetak; LLM je već potrošio tokene i oni **ostaju** u `usage/` (trošak se ne vraća) |

Šta ciklus **ne** radi (planirano): ne mijenja `budgetUsd` uloga, ne postavlja per-agent budžet u
kontrolnoj ravni, ne kreira ciljeve iz `allocation`, ne provjerava `autonomy.evaluate(kind:'plan')` prije
poziva. Sve četiri stvari su svjesno ostavljene čovjeku u v0.3 — vidi §6 i „Otvorena pitanja".

---

## 4. Pregovaranje između agenata

`company.negotiate(tenantId, { topic, between, maxRounds, context })`.

### Strukturisani tok

1. Validacija: `between` mora dati **dvije poznate uloge** (`ValidationError` u suprotnom);
   `POST /v1/admin/org/negotiate` dodatno traži `topic` i `between.length === 2`.
2. Runde `1..maxRounds`: govornik se mijenja (`round % 2 === 1 ? a : b`).
3. Sistem prompt nosi **mandat, KPI-jeve, budžet i ime druge strane** — i jedno tvrdo pravilo:
   `Ne prelazi svoj budžet.` Traženi odgovor:

```json
{ "offer": { "amountUsd": 0, "terms": "..." }, "reasoning": "2-3 rečenice", "accept": false }
```

4. Svaka runda ide kroz `helpers.callLlm` → **trošak se mjeri** (`costUsd` po rundi, sabran u ciklusu),
   a `agentId` je agent govornika (pa potrošnja ulazi u njegov `byAgent`, a ne u „org" stavku).
5. `accept: true` → status `agreed`, zapis `type:'negotiation'`, metrika `org_negotiations_total{status:'agreed'}`,
   audit `org_negotiation` sa `decision: 'allow'`.
6. Nakon `maxRounds` bez `accept` → **eskalacija** (vidi dalje), status `escalated`, audit
   `decision: 'require_approval'`.

Ključna razlika od „ćaskanja": **ponuda je strukturirani objekat** (`{amountUsd, terms}`), pa se može
zapisati, porediti po rundama, sabrati u trošak i nacrtati na grafiku. Proza se ne može.

### Kad nema dogovora — eskalacija u inbox

`negotiate()` tada zove `improvements.createProposal(tenantId, …)` sa:

| Polje | Vrijednost |
|---|---|
| `kind` | `action` |
| `target` | `roleById('ceo').agentId` (ili agent strane `a` ako CEO uloga ne postoji) |
| `proposed.input` | `Presudi u pregovoru "<topic>" između <a> i <b>. Zadnja ponuda: <JSON>` |
| `rationale` | `Pregovor "<topic>" nije završen u <N> rundi` |
| `evidence` | po rundi: `{round, role, amountUsd}` |
| `riskLevel` | `medium` |
| `source` | `org-negotiation` |

Prijedlog ide u standardni self-improvement inbox (`data/tenants/<id>/learning/proposals.json`,
`requiresHuman: true`), vidljiv kroz `GET /v1/admin/proposals` i odlučuje se kroz
`POST /v1/admin/proposals/:id/decide` (`requiredRole: 'approve'`). Isti kanal koristi i A2A pregovor
(`source: 'a2a-negotiation'`) — jedan inbox za sve „treba čovjek" situacije. Za `nmq` je nivo autonomije
`L2`, a `POST /v1/admin/proposals/:id/apply` za `kind: 'action'` ide kroz `autonomy.evaluate(kind:'act')`,
pa se akcija i dalje ne izvršava sama ako nivo ne dozvoljava.

### Zašto je to bolje od „slobodnog ćaskanja" agenata

| Slobodno ćaskanje | Strukturisani pregovor (kod) |
|---|---|
| Nema granice — agent može „obećati" 50.000 USD | Mandat i budžet su u promptu, a iznos u strukturisanom polju koje se validira i zapisuje |
| Ne zna se kad je kraj | Tačno `maxRounds`, pa `agreed` ili `escalated` |
| Trošak nevidljiv | Svaka runda ima `costUsd`; ciklus sabira |
| Nema dokaza ko je šta rekao | `transcript[]` u JSONL + hash-chained audit |
| Ne zna se koga pitati | Eskalacija ima `target`, `rationale`, `evidence` i ulazi u inbox |
| Nedeterministički testovi | Testira se **struktura** (statusi, broj rundi, prisustvo `offer`), ne tekst |

Granica iskrenosti: `negotiate()` **ne** provjerava `autonomy.evaluate()` prije poziva i **ne** zaustavlja
pregovor ako ponuda pređe budžet uloge — on samo traži od modela da ga ne pređe. Tvrdi limiti žive u
A2A sloju (`src/a2a/negotiation.js`, vidi `docs/25`) i u per-agent budžetu. Org pregovor je **proces
odlučivanja**, ne izvršni kanal za novac.

---

## 5. KPI i odgovornost

`company.kpis(tenantId)` ne mjeri KPI-jeve — on ih **prikazuje pored onoga što se stvarno zna**:

```json
{
  "tenantId": "nmq",
  "roles": [
    {
      "role": "cro",
      "agentId": "sales",
      "kpis": ["kvalifikovanih leadova", "konverzija ponuda > 20%", "prosječna vrijednost posla"],
      "measured": { "goalsOwned": 1, "goalsAtRisk": 1, "avgReward": 0.71, "budgetUsedPct": 0.2 }
    }
  ]
}
```

Dakle dvije kolone: **namjera** (`kpis[]`, tekst iz configa) i **dokaz** (`measured`, iz stvarnih
podataka: ciljevi → `goals.list`, nagrade → `rewards.aggregate`, trošak → `cost.summary`).

| KPI iz configa (primjer) | Čime se **danas** može približno izmjeriti | Šta fali |
|---|---|---|
| „konverzija ponuda > 20%" | cilj sa `metric: conversion_pct` i `goals.recordProgress` | nema automatskog izvora iz CRM-a — neko mora zvati `/v1/admin/goals/:id/progress` |
| „trošak modela po zahtjevu < 0.02 USD" | `cost.summary().usd / calls` **nije** izloženo kao KPI; sirovi brojevi jesu u `GET /v1/usage` | nema izračunatog „po zahtjevu" u `company.kpis()` |
| „greške runova < 1%" | metrike (`/metrics`) i audit (`outcome: 'error'`) | `company.kpis()` ih ne čita |
| „riješeno bez čovjeka > 60%" | feedback + ticketi + `approvals` | nema veze između ticketa i odluke „riješeno bez čovjeka" |
| „p95 latencija < 8s" | trace/spanovi, `run_duration_seconds` | nema p95 izračuna u org sloju |
| „dani naplate < 30" | `invoice_*` alati i `data/tenants/<id>/invoices/` | nema veze faktura → uplata |

**Iskreno: nema automatskog mjerenja iz ERP-a, CRM-a, banke ni Google Analytics-a.** Sve van ciljeva i
nagrada je ili u metrikama (kojih org sloj ne čita) ili ne postoji. KPI tabela je mjesto gdje se
**priznaje razlika**, ne gdje se ona sakriva.

### Predlog kako dodati konektore (planirano, nije u kodu)

Redoslijed je po odnosu vrijednost/rizik:

1. **Prvo metrike koje već postoje.** Sklopiti u `company.kpis()` čitanje `/metrics` snapshot-a
   (`runovi`, greške, latencija, `policy_denials`) — nula novih integracija, odmah tačni CTO/CFO KPI-jevi.
2. **Drugo ciljevi kao ugovor.** Svaki KPI koji se može izraziti brojem pretvoriti u `goal` sa
   `metric`, `baseline`, `target`, `deadline`, `owner = <role.id>`. Tada `goalsAtRisk` **postaje** KPI
   mjera, a `progress` može da piše i watcher i čovjek.
3. **Treće sistem koji klijent stvarno ima.** Za `nmq` realan prvi konektor je **Stripe/webhook**
   (hook `stripe` → agent `finance` već postoji u `config/tenants.json`): uplata → `recordProgress` na
   cilju „naplata". Drugo je **Gmail/Slack** za support KPI-jeve, treće **Shopify** za e-com.
4. **Četvrto ERP/knjigovodstvo** (npr. izvoz faktura/naloga) — najveći posao i najveći pravni rizik
   (pristup finansijskim podacima klijenta), pa ide tek sa DPA-om i advokatom (vidi `docs/25` §5).
5. **Uvijek isto pravilo:** konektor samo **piše mjerenje** (`recordProgress` ili `watchers.recordMetric`),
   nikad ne mijenja KPI definiciju i nikad ne odlučuje. KPI ostaje u `config/company.json`, mjerenje u
   podacima — kao i sve ostalo u ovom projektu.

---

## 6. Hibridna organizacija (AI + ljudi)

Granica nije „koliko je agent pametan", nego **ko snosi posljedicu**. U kodu je ta granica već
projektovana: `src/core/autonomy.js` ima `HUMAN_ONLY = ['financial','legal','destructive','external_communication']`
i pravilo koje važi na **svim** nivoima: `riskLevel: 'high'` i `HUMAN_ONLY` kategorije → `require_approval`.

| Odluka | Ko odlučuje | Mehanizam u kodu |
|---|---|---|
| Klasifikacija i rutiranje zahtjeva | **agent** | `src/agents/router-agent.js` |
| Odgovor na FAQ i status narudžbine (informisanje) | **agent** | patterni + KB/`memory_search`; odgovor ide kroz SSE/odgovor API-ja |
| Slanje prema van (mejl klijentu, javna poruka) | **agent pripremi, čovjek/politika pusti** | `HUMAN_ONLY: external_communication`; `config/policies.json` stavlja `email_send` i `invoice_create` (i `http_fetch` za tenant `nmq`) u `requireApproval`; izlaz ide u outbox (`data/tenants/<id>/outbox/`) |
| Raspored unutar dana, redoslijed zadataka, retry | **agent** | scheduler, `maxToolRepeats`, budžet run-a |
| Kratak sadržaj/izvještaj iz postojećih podataka | **agent** | `report`/`kb` alati |
| **Novac** (plaćanje, poravnanje, cijena iznad praga, budžet) | **čovjek** | `HUMAN_ONLY: financial`, `requireHumanAboveUsd` (A2A), budžet `owner` rola |
| **Pravno** (ugovor, DPA, potpis, uslovi) | **čovjek** | `HUMAN_ONLY: legal`; `contract.signature: null` |
| **Ljudi** (zaposlenje, otkaz, ocjena radnika) | **čovjek** | nema agenta koji to smije; CHRO uloga pokriva znanje/KB, ne odluke o ljudima |
| **Brisanje podataka** | **čovjek** | `HUMAN_ONLY: destructive` |
| **Strategija i prioriteti** | **čovjek uz AI prijedlog** | `company.cycle()` daje `plan` + `decisions_needed[]`; primjena je ručna |
| Promjena ponašanja agenta (prompt, politika, KB) | **čovjek** | `improvements` → `decide` → `apply` (+ `rollback`) |
| Nivo autonomije | **čovjek** | `POST /v1/admin/autonomy`, `requiredRole: 'owner'` |

Kod `nmq` to konkretno znači: default je `L1`, tenant `*` je `L2`, `sales` i `ops` su `L3`
(`config/autonomy.json`). `L3` smije sam da planira i zakazuje poslove iz cilja — **ali** visok rizik i
dalje ide čovjeku. Nigdje nije uključen `L4`.

### Nedjeljni pregled (ritual, 15 minuta)

Cilj rituala je da se **ne čita 40 strana logova**, nego 6 brojeva i 3 liste. Predlog agende:

| Min | Šta se gleda | Odakle | Pitanje koje se postavlja |
|---|---|---|---|
| 0–3 | Trošak tenanta vs. budžet; top 3 agenta po potrošnji | `GET /v1/usage`, `GET /v1/admin/health` | Da li je potrošnja u skladu sa vrijednošću? |
| 3–6 | Ciljevi u riziku (ko, koliko kasni) | `GET /v1/admin/goals?portfolio=1`, `GET /v1/admin/org` | Koji cilj mijenjamo ili gasimo? |
| 6–9 | Inbox: prijedlozi i eskalacije (pregovori bez dogovora, A2A iznad praga) | `GET /v1/admin/proposals?status=proposed` | Odobriti / odbiti / dopisati kontekst |
| 9–12 | Kvalitet: nagrade, greške, odbijene politike, odobrenja koja čekaju > 24h | `GET /v1/admin/rewards`, `/metrics` | Gdje agent griješi sistematski? |
| 12–15 | Odluke: ko mijenja šta do sljedeće nedjelje (1–3 stavke, ne 10) | zapisnik (za sada ručno) | Ko je vlasnik svake stavke? |

Ritual je **ručni** u v0.3 — nema rute koja ga generiše i nema zakazanog posla za njega. To je
kandidat za prvi „meta" posao u scheduleru (planirano).

---

## 7. Konflikti i kako se rješavaju

Konflikt nije kvar — to je normalno stanje organizacije. Ono što se u kodu može riješiti jeste da
konflikt ima **mehanizam**, a ne da zavisi od toga koji je model te večeri bolje raspoložen.

Četiri tipa koja se stvarno pojavljuju:

| # | Konflikt | Interes A | Interes B | Mehanizam |
|---|---|---|---|---|
| 1 | **CFO vs CRO — budžet** | marža, cash flow, trošak | rast, pipeline, kampanje | `company.negotiate(['cfo','cro'])`; bez dogovora u `maxRounds` → eskalacija na CEO/čovjeka (`source: org-negotiation`) |
| 2 | **COO vs CRO — prioriteti** | rokovi i kvalitet isporuke | novi posao, veći obim | mandat COO pokriva rokove → ako novi obim obara rok, CRO mora dati termin ili odbiti; eskalacija kroz `improvements` (`source` iz watchera/ciklusa) |
| 3 | **CTO vs COO — rokovi** | pouzdanost, ne uvoditi rizik | isporučiti na vrijeme | mandat CTO pokriva pouzdanost; „brzina isporuke promjena" i „p95 < 8s" su **oba** njegova KPI-ja → odluka se mjeri, ne prepire |
| 4 | **CSO vs CRO — popust** | zadovoljstvo klijenta, rješeno bez čovjeka | cijena i marža | popust je cijena → **marža je veto** (vidi dalje); sve iznad praga ide čovjeku |

Mehanizam, u redoslijedu koji se primjenjuje:

1. **Mandat** — ako konflikt nije u tvom mandatu, nije tvoja odluka. `mandate` je u configu i u promptu.
2. **Granice** — broj (budžet uloge, `budgetUsd`, per-agent budžet, `requireHumanAboveUsd`, `maxRounds`).
   Granica rješava većinu konflikata prije nego razgovor počne.
3. **Pregovor** — strukturisano, sa `offer` objektom i `transcript`-om; najviše `maxRounds`.
4. **Eskalacija** — nema dogovora → prijedlog u inbox sa `target` (CEO/čovjek), `rationale` i `evidence`.
   **Nikad tiho odustajanje:** ishod je uvijek `agreed` ili `escalated`, i oba se zapisuju.
5. **Pravilo „marža je veto"** — ako odluka obara maržu ispod granice iz KPI-ja (`marža > 70%` za CFO),
   CRO/CSO ne mogu je izglasati sami: ide čovjeku. U kodu je to danas **konvencija i prompt**, ne
   tvrda provjera — tvrdi dio je `HUMAN_ONLY: financial` + `requireHumanAboveUsd` u A2A pregovoru.

Ono što fali (planirano): automatska provjera „da li ova odluka obara KPI druge uloge" prije nego se
pregovor zatvori. Danas to vidi samo model iz prompta i čovjek iz inboxa — što je za v0.3 prihvatljivo,
ali nije za `L4` autonomiju.

---

## 8. Zašto NE 20 agenata

Iskreno: **zato što svaka uloga košta.** Nije filozofija, to su tri mjerljive stvari.

**1) Trošak tokena.** Svaka uloga koja „misli" radi barem jedan LLM poziv. Ciklus sa 7 uloga je
1 (CEO) + do `maxRounds` (pregovor) poziva; ciklus sa 20 uloga koji uključi svaku u raspravu je
20+ poziva **za isti plan**. Trošak po pozivu živi u `PRICING` tabeli
(`src/observability/cost.js`) i namjerno se **ne prepisuje u dokument**; ono što se zna je da se svaki
poziv mjeri (`cost.record`) i da u `nmq` tenant ima `budget.monthlyUsd: 200` — budžet se može potrošiti
na raspravu, a ne na posao. Relativni odnos je isti kao u `docs/04` §11: `orchestrator-worker` sa k
workera je (k+2)×, a `magentic` ≈ 3i× i najskuplji je. Organizacija sa 20 uloga je `magentic` na nivou
cijele firme.

**2) Latencija.** Pregovor je serijski: runda čeka rundu. 7 uloga sa po 3 runde je 21 sekvencijalni
LLM poziv prije nego bilo šta počne da se radi. Za operativne zadatke to je neupotrebljivo; `docs/04`
zato i kaže „nikad `magentic` za operativne zadatke".

**3) Koordinacioni šum.** Što više uloga, to više parova koji mogu biti u konfliktu (2 uloge = 1 par,
7 uloga = 21 par, 20 uloga = 190 parova). Svaki par je prilika za eskalaciju u inbox — a inbox čita
**čovjek** i njegovo vrijeme je najskuplji resurs u sistemu. Organizacija koja proizvodi 30 prijedloga
nedjeljno neće biti pročitana; ona je gora od organizacije sa 7 uloga i 4 prijedloga.

### Pravilo

> **Uloga postoji samo ako ima KPI i budžet.**

Bez KPI-ja se ne može reći da li je uloga korisna; bez budžeta se ne može zaustaviti. U `company.json`
to znači: svaki unos ima `kpis` (neprazna lista odvojivih mjera) i `budgetUsd` (broj). Uloga koja ne
može da ispuni oba uslova je **podsjetnik**, ne uloga — i treba da bude stavka u `kpis` postojeće uloge.

### Kako ugasiti ulogu

1. **Prvo je isključi iz ciklusa**, ne briši: postavi `budgetUsd: 0` i ostavi unos — `chart()` i
   `kpis()` i dalje prikazuju njene ciljeve i nagrade, pa se vidi da li je neko primijetio.
2. **Prebaci ciljeve:** `goals.owner` sa `role.id` (ili `agentId`) na ulogu koja preuzima, kroz
   `POST /v1/admin/goals/:goalId/status` / `recordProgress` tok. Ako cilj nema kome da pripadne — to je
   znak da uloga nije trebala postojati.
3. **Skini ulogu iz `between`** u svim pozivima `negotiate()`; ako je bila u `cycle()` toku (`cfo`/`cro`),
   ciklus automatski preskače pregovor (kod provjerava `roleById('cfo') && roleById('cro')`).
4. **Posmatraj nedjelju-dvije:** da li neko pita „zašto nema X"? Ako ne — obriši unos iz
   `config/company.json` i restartuj.
5. **Ne briši istoriju.** `org/cycles-YYYY-MM.jsonl` ostaje; stari zapisi imaju `between` i `allocation`
   i poslije gašenja uloge, i to je tačno ono što treba za reviziju odluka.

Kod ima **7 uloga** i to je namjerno: `tests/autonomy.test.mjs` tvrdi `chart.roles.length === 7`, pa
svako dodavanje uloge zahtijeva i svjesnu izmjenu testa — mala frikcija koja tjera na pitanje „zašto".

---

## 9. Kako se to pokreće i testira

### Rute (sve `requiredRole: 'admin'`, tenant iz zaglavlja/ključa)

| Metod | Ruta | Šta radi | Tijelo / parametri |
|---|---|---|---|
| GET | `/v1/admin/org` | `company.chart(tenantId)` — uloge, ciljevi, nagrade, potrošnja, budžet, autonomija | — |
| GET | `/v1/admin/org/kpis` | `company.kpis(tenantId)` — KPI-jevi pored mjerenja | — |
| POST | `/v1/admin/org/cycle` | `company.cycle(tenantId, body)` — CEO plan + CFO/CRO pregovor + zapis | `{ period?, topic?, context? }` |
| POST | `/v1/admin/org/negotiate` | `company.negotiate(tenantId, body)` — strukturisani pregovor dvije uloge | `{ topic, between: [a, b], maxRounds?, context? }` (validacija: `topic` + tačno 2 uloge) |
| GET | `/v1/admin/org/history` | `company.history(tenantId, { limit })` — zadnjih N zapisa (ciklusi **i** pregovori), najnoviji prvi | `?limit=20` |

Prateće rute bez kojih se ovo ne kontroliše: `GET /v1/admin/proposals` (inbox, uključujući eskalacije),
`POST /v1/admin/proposals/:id/decide` (`approve`), `GET /v1/admin/autonomy` (`default` + `forTenant`),
`GET /v1/usage` (trošak), `GET /v1/audit` (hash-lanac).

Podaci na disku: `data/tenants/<id>/org/cycles-YYYY-MM.jsonl`, `data/tenants/<id>/learning/proposals.json`,
`data/tenants/<id>/usage/YYYY-MM.jsonl`.

### Tabela testova (`tests/autonomy.test.mjs`, sekcija „organizacija")

| Test | Šta dokazuje |
|---|---|
| `organizacija: org chart sa KPI-jevima i budžetima` | `chart.roles.length === 7`; `ceo.reportsTo === null`; `cro.reportsTo === 'ceo'`; `cro.kpis` sadrži `konverzija ponuda > 20%`; `budgetUsedPct` je broj ili `null`; `cro.autonomy` postoji; `kpis().roles.length === 7` |
| `organizacija: pregovor o budžetu (dogovor) i ciklus planiranja` | `negotiate(['cfo','cro'])` daje `agreed` ili `escalated`, `transcript.length >= 1` i prvi unos ima `offer`; `history()` sadrži zapis `type: 'negotiation'`; `cycle()` vraća `plan.priorities.length >= 1`, `allocation.length >= 1`, `id`, `costUsd >= 0`; u auditu postoji `org_cycle` |
| `organizacija: neuspješan pregovor eskalira kroz inbox` | sa mock-om koji nikad ne prihvata (`negotiation: 'never'`) i `maxRounds: 2` → `status === 'escalated'`, `proposalId` postoji, a prijedlog ima `source: 'org-negotiation'` |
| `HTTP: ciljevi, prijedlozi, watcheri, autonomija, org i A2A rute` | `GET /v1/admin/org` kroz HTTP vraća `roles.length === 7` (ruta je registrovana i autorizovana) |

Pokretanje (bez ijedne npm zavisnosti):

```powershell
cd E:\NMQ-PROGRAMI\nmq-robot
node --test                      # cijeli suite
node --test tests/autonomy.test.mjs
```

Stanje na dan provjere (2026-09-30): `node --test` → **150/150 prolazi** (`node v24.21.0`), a
`tests/autonomy.test.mjs` pokriva autonomiju, ciljeve, watchere, nagrade, self-improvement, self-play,
RSI, organizaciju, A2A i HTTP rute iz ovog dokumenta.

---

## Otvorena pitanja

1. **Ko mijenja `budgetUsd` uloge?** Danas ga mijenja samo čovjek u `config/company.json` (+ restart).
   Da li `cycle()` smije da predloži izmjenu kroz `improvements` (`kind: 'policy'`), ili budžet uloge
   ostaje isključivo ljudska odluka?
2. **Da li ciklus smije da kreira ciljeve?** `plan.allocation` sad ima `goals[]` kao **tekst**. Da li
   ga mapirati na `goals.create` (uz odobrenje) ili tražiti da `allocation` nosi `metric/baseline/target`
   da bi bilo mašinski primjenjivo?
3. **Tvrda „marža je veto" u kodu.** Treba li `company.negotiate()` da odbije dogovor koji obara KPI
   druge uloge (npr. `marža > 70%`), i kako to izmjeriti prije nego što se pojavi stvarni podatak?
4. **KPI iz metrika.** Da li `company.kpis()` čita `/metrics` snapshot direktno (nula integracija, ali
   metrike su procesne, ne poslovne) ili se prvo prave `goal` zapisi za svaki brojivi KPI?
5. **Koji je prvi pravi konektor za mjerenje** — Stripe (uplata → naplata), Gmail/Slack (support), ili
   Shopify (e-com)? Odluka određuje koji se KPI prvi može tvrditi kao tačan.
6. **Kada `L4` za ijednu ulogu?** Ako nikad, treba li `L4` uopšte ostati u `AUTONOMY_LEVELS` kao
   opcija koju nijedan tenant ne uključuje, ili ga vezati na formalan uslov (npr. 30 dana bez
   `agent_budget_block` i bez `outcome: 'error'`)?
