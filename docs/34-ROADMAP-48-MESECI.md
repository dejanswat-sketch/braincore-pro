# 34 — Roadmap 48 mjeseci: od roja do AI vrste (i gdje se zaustavljamo)

> **Svrha:** strateški dokument za **investitore i safety board**. Odgovara na tri pitanja: **šta je stvarno
> napravljeno** (dokaz, ne tvrdnja), **šta gradimo u 48 mjeseci** (faze, dokazi, trošak, KPI) i **šta namjerno
> NE radimo** — uključujući **gdje se zaustavljamo i zašto**.
>
> **Nastavlja se na `docs/27-ROADMAP-24-MESECA.md`** (v0.3 plan) i **ne ponavlja ga**. Faze 0–24 mjeseca su
> skraćene na ono što je novo ili izmijenjeno; detalji (deliverables, rizici, trošak po fazi) ostaju u `docs/27`
> i u njemu se ne prepisuju. Ovaj dokument pokriva **šta se mijenja dolaskom v0.4** (swarm, evolucija, RSI
> meta-nivoi) i **šta se dešava poslije 24. mjeseca**.
>
> **Ugovor:** ovaj dokument ne smije biti u koliziji sa `docs/DECISIONS.md`. Ako se tvrdnja ovdje razlikuje od
> koda, **kod je tačan** i ovaj dokument se ispravlja. Odluke D1–D49 važe. **Stanje prateće dokumentacije
> (provjereno 30.09.2026):** `docs/29-SWARM-ARHITEKTURA.md` (680 linija), `docs/30-EMERGENTNA-ORGANIZACIJA-DAO.md`
> (554), `docs/31-RSI-META-ARHITEKTURA.md` (710) i `docs/32-AI-VRSTA-EVOLUCIJA.md` (733) **postoje**, ali su
> **nekomitovani** (`git status` → `??`). **`docs/33` NE POSTOJI**, a na njega upućuju `config/swarm.json`
> (`docs/29, docs/33`), `src/rsi/meta.js` (linija 242) i tri od četiri prateća dokumenta — to je **otvoreni dug**
> koji faza 0–12 mora zatvoriti (vidi §0.4 i §1.1 tačka 7).
>
> **Ovaj dokument se nastavlja na `docs/27` i na `docs/29`–`docs/32`:** oni opisuju **arhitekturu** v0.4 sloja,
> a `docs/34` opisuje **poslovnu putanju, granice i ekonomiju** tog sloja kroz 48 mjeseci.
>
> **Pravila pisanja (važe za svaki broj i svaku tvrdnju):**
> 1. **Svaka finansijska brojka je „procjena"** i ima napisano **izvođenje** (pretpostavke → račun).
> 2. **Nijedna cijena modela nije činjenica** — u kodu je tabela `PRICING` (`src/observability/cost.js`) sa
>    napomenom „provjeriti!", a nepoznat model se broji u `nmq_pricing_fallback_total` (D36).
> 3. **Ne postoje klijenti, prihodi ni partnerstva.** Sve buduće je **plan** ili **procjena**.
> 4. **Nikad se ne upisuju vrijednosti ključeva** — samo **imena** env varijabli.
> 5. Dokazi se navode **imenom komande/fajla**, ne opisom („radi" nije dokaz).

**Stanje verzije (provjereno na kodu, 30.09.2026):**
`package.json` → `"version": "0.3.1"`. Kod **v0.4 nije označen** — sposobnosti v0.4 (swarm, evolucija, RSI
meta-nivoi) **postoje u radnom stablu, ali nisu u git istoriji**: `git log` posljednji commit je
`c96a2dc NMQ Robot v0.3.1 — eval kapija + ispravke iz revizije (162/162)`, a `git status` pokazuje
`src/swarm/`, `src/evolution/`, `src/rsi/`, `src/server/routes-swarm.js`, `config/{swarm,rsi,evolution}.json`,
`tests/swarm.test.mjs` i modifikacije `src/index.js`, `src/core/config.js`, `src/eval/harness.js` kao
**nekomitovane**. Odgovor investitoru na „koju verziju gledam": **kod 0.3.1 + v0.4 sloj u radnom stablu**;
prvi zadatak faze 0 je tag `v0.4.0` tek poslije nezavisne revizije (§12, odluka 6).

---

## 0. Sažetak (1 strana za investitora i safety board)

### 0.1 Šta firma radi

**NMQ (Dejan Milošević PR)** gradi **NMQ Robot**: multi-tenant AI agent koji se ugrađuje u sajt (JS widget) i u
interne procese (REST/webhook) i koji **izvršava stvarne akcije** (mejl, faktura, CRM, ticket, izvještaj) pod
politikom, budžetom i dokazivim audit tragom. Od v0.4 isti sistem ima i **kolektivni sloj**: roj workera koji
sami uzimaju posao sa table (bez centralnog orkestratora), **evoluciju agenata** koja se ocjenjuje mjerenjem i
**RSI meta-nivoe** koji predlažu kako da se proces poboljšavanja sam poboljša — **ali nijedna izmjena ne ulazi
bez čovjeka**. Sve to sa **nula obaveznih npm zavisnosti** (D2) i fizičkom izolacijom podataka po klijentu
(D11, D12).

### 0.2 Šta je dokazano brojevima (pokrenuto, ne prepisano)

| Dokaz | Broj / ishod | Kako je provjereno (30.09.2026) |
|---|---|---|
| Testovi | **182 prolazi, 0 pada** (12 fajla, bez mreže, bez `npm install`) | `node --test` → `tests 182 / pass 182 / fail 0`, `duration_ms ≈ 11237` |
| Demo | **21 sekcija bez greške** (uključivo swarm, evolucija, RSI, org, A2A) | `node scripts/demo.mjs` |
| Smoke nad živim gateway-em | **31/31** | `node scripts/smoke.mjs` |
| Eval (zlatni set, tenant `nmq`) | **6/6 = 100%**, prag 80%, **IZNAD PRAGA**; 0,002886 USD ukupno; ~27 ms/provjera | `node scripts/eval.mjs` |
| Rute gateway-a | **141** ruta (od toga **34** u `routes-swarm.js`: swarm/governance/safety/evolucija/RSI) | brojanje `path:` u `src/server/routes*.js` |
| Metrike | **98 jedinstvenih imena**, **119 mjesta u kodu**; **33** swarm/RSI/evolution/org/A2A metrike | `src/observability/metrics.js` + call-sites |
| Swarm moduli | **4 modula, 991 linija** (`swarm.js` 235, `safety.js` 363, `governance.js` 206, `blackboard.js` 187) | `src/swarm/` |
| Evolucija + RSI | `genome.js` **326** linija, `meta.js` **353** linije | `src/evolution/`, `src/rsi/` |
| Testovi v0.4 sloja | **20 testova** u `tests/swarm.test.mjs` (556 linija): 14 swarm/blackboard/governance/safety + 6 evolucija/RSI/rute | `node --test tests/swarm.test.mjs` |
| Agenti / patterni / alati | **19 agenata** (podaci), **11 ulaza/patterna**, **20 ugrađenih + 1 MCP šablon** | `config/agents/*.json`, `node src/cli.js agents tools` |
| AI organizacija | **7 uloga** (ceo/cro/coo/cfo/cto/chro/cso) sa mandatima, KPI i budžetima | `config/company.json`, `src/org/company.js` |
| A2A | card sa **15 skillova**, streaming, pregovaranje; taskovi sa stanjima + SSE | `GET /.well-known/agent.json`, `/a2a/*` |

### 0.3 Ciljevi za 48 mjeseci (5 mjerljivih)

1. **Prihod:** **ARR ≈ 2,0–2,6 mio EUR (procjena)** u baznom scenariju na kraju 48. mjeseca, sa **≥ 40%
   prihoda iz kanala** (agencije/white-label/A2A), izvedeno u §7 — ne iz želje.
2. **Klijenti:** **≈ 300–400 plaćenih klijenata** (bazno), od toga **≥ 25 enterprise**, uz **churn < 2%/mj.**
   na Pro segmentu; izvedeno iz kapaciteta podrške i template-a (§6), ne iz tržišnog udjela.
3. **Autonomija pod nadzorom:** **> 75% zahtjeva riješeno bez čovjeka**, **eval ≥ 90%** na zlatnom setu po
   tenantu, **0 teških sigurnosnih incidenata** u svakoj godini, i **nikad** viša autonomija od **L4** (§5).
4. **Ekonomija agenata:** **≥ 10 A2A partnera** i **≥ 50.000 A2A transakcija/mj.** sa **pravim poravnanjem**
   (Stripe/SEPA; x402 samo za mikroplaćanja), uz **reputacioni skor** koji mijenja granice pregovora.
5. **RSI kroz kapiju:** **≥ 30% RSI/evolucijskih prijedloga primijenjeno** poslije ljudskog review-a, sa
   **0 automatskih izmjena koda** i **0 automatskih meta-izmjena** — broj koji se mjeri, ne izjavljuje.

### 0.4 Iskreno — šta NIJE dokazano

| Nije dokazano | Stvarno stanje u kodu/repozitoriju |
|---|---|
| **Nijedan plaćeni klijent, nijedan prihod, nijedno partnerstvo** | Ne postoji; sve od §1 dalje je **plan** ili **procjena** |
| **Eval je mjeren na MOCK modelu** | `node scripts/eval.mjs` piše „(mock LLM)"; provjere su determinističke (podstring/citat/alat). **Nijedan pravi model nije izmjeren u produkciji**; `src/llm/openai-compatible.js` postoji, mjerenja nema |
| **Nema fine-tuninga** | Nema SFT/LoRA, nema reward modela naučenog iz ljudskih ocjena. Postoji dataset (`learning/training-YYYY-MM.jsonl`) i **heuristički** reward (`src/learning/rewards.js`) |
| **A2A poravnanje je simulacija** | `src/a2a/negotiation.js` to sam kaže: `method: 'internal'` → `settled`, uz `note: 'Interni ledger (simulacija) — nema stvarnog prenosa novca.'`; `stripe`/`x402` → `pending` (adapter ne postoji) |
| **Swarm je single-node** | Tabla i feromoni su `Map` u memoriji procesa; na disk ide samo append-only log (`board-YYYY-MM-DD.jsonl`) za rekonstrukciju. **Nema cross-node claim-a, nema distributed lock-a** (D22: fajl-lease nije lock) |
| **Swarm izvršava samo nizak rizik** | `governance.assertCanRun` baca `PolicyError` za `medium` i `high` — to je namjerna granica, ali znači da roj **nije** dokazan na rizičnim zadacima |
| **Nema SOC 2 / ISO 27001 / pen-testa** | Nijedan nezavisni nalaz; `docs/19` §3.1: „ne može jedna osoba" |
| **Nema Postgres/pgvector/Redis, nema K8s klastera** | Sve na fajl-sistemu (JSONL/JSON); K8s manifesti **nisu** `kubectl apply` (D7, D8, `replicas: 1`) |
| **Integracije: 1 MCP šablon** | Nema Gmail/Shopify/Slack/CRM u produkciji; `config/tools.json`: `nmq-crm` (šablon) + `nmq-internal-http` (`enabled: false`) |
| **Nema dashboarda ni inbox-a za odobrenja** | Danas `POST /v1/approvals/:runId` (curl) |
| **v0.4 sloj nije ni commitovan, ni nezavisno revidiran** | `git status` → `src/swarm/`, `src/evolution/`, `src/rsi/`, `src/server/routes-swarm.js`, `config/{swarm,rsi,evolution}.json`, `tests/swarm.test.mjs` i `docs/29`–`docs/32` su **untracked**; `package.json` i `src/index.js` i dalje kažu **0.3.1** |
| **`docs/33` ne postoji** | Na njega upućuju `config/swarm.json`, `src/rsi/meta.js:242` i `docs/29`, `docs/30`, `docs/31` (`docs/29` to i sam priznaje, linija 14) |
| **Prateći dokumenti nisu revidirani i nisu u git-u** | `docs/29`–`docs/32` su napisani i uglavnom se poklapaju sa kodom, ali nijedan nije prošao **nezavisnu** provjeru (a `docs/34` je taj koji od njih zavisi) |
| **Tim je 1–2 osobe** | `docs/19` §3.1; key-man rizik je u §10 |

### 0.5 Šta tražimo

Tražimo **[IZNOS]** ukupno, u **tri tranše vezane na dokaze** (ne na protok vremena):

| Tranša | Kada se isplaćuje | Vezana na dokaz |
|---|---|---|
| **T1 — [IZNOS]** | odmah (faza 0–12 mj.) | 3 **plaćena** klijenta, eval ≥ 80% **na pravom modelu**, > 60% bez čovjeka, 0 incidenata izolacije |
| **T2 — [IZNOS]** | poslije 12–24 mj. | ≥ 30 klijenata, marža > 70%, cross-node swarm u pilotu, prvi SFT/LoRA sa mjerenim liftom |
| **T3 — [IZNOS]** | poslije 24–36 mj. | ≥ 10.000 A2A transakcija/mj. **sa pravim novcem**, 2 cross-node incidenta riješena bez štete, marketplace sa ≥ 5 template-a |

**[IZNOS] se ne popunjava „osjećajem":** izvodi se iz §7 (trošak prve 12 mjeseci + rezerva 3 mjeseca), a
izvođenje mora pisati uz svaku tranšu. **Do tada ostaje [IZNOS] i to je namjerno** — bolje prazna zagrada nego
izmišljen broj.

**Na šta se troši (procjena, izvedeno iz §7 i §8):**

| Namjena | Udio (procjena) | Zašto baš to |
|---|---|---|
| **Ljudi** (inženjeri, podrška, pa prodaja) | **60–70%** | Trošak modela je na ovom obimu mali; usko grlo su **integracije, trust i support** |
| **Prodaja i akvizicija** | **10–15%** | Bez plaćenog pilota nema nijedne druge brojke u dokumentu |
| **Pravno i sigurnost** (DPA, ugovor, pen-test, safety savjetnik) | **10–15%** | Raste sa fazama: od 3% u godini 1 do 15% u godini 4 (swarm + cross-node nadzor) |
| **Infrastruktura** (VPS → Postgres/Redis → klaster) | **5–10%** | Jedan VPS pokriva prve klijente; cross-node swarm je taj koji **tek tada** opravdava klaster |
| **Modeli / API** | **5–8%** | Cilj trošak modela / prihod **< 15%**; pravilo cijene **3–4×** (§7) |
| **Rezerva** | **10%** | Rizik „1–2 osobe": bolest, odmor, izgubljen mjesec |

**Rezime u tri poruke (za safety board i investitora):**

1. **Putanja je ista, tempo je drugačiji.** v0.4 ne mijenja putanju iz `docs/27` — mijenja **ono što je
   tehnički moguće** (roj, evolucija, RSI meta). Zato prve 12 mjeseci **ne dodaju nijednu novu sposobnost**:
   dokazuju postojeću na **plaćenom** klijentu. Sve što je v0.4 danas je **eksperimentalno po zrelosti**.
2. **Linije prihoda se grade po redu, ne paralelno.** (1) licenca po odjelu/funkciji → (2) % od mjerljive
   uštede sa baseline-om i cap-om → (3) template/franšiza (vidi `docs/28`) → (4) A2A provizija **kad ima
   stvarnog prometa**. Nijedna linija ne kreće prije nego prethodna radi bez nas.
3. **Granica je L4 i to je arhitektonska odluka, ne nedostatak hrabrosti.** Sistem na L4 smije sam planirati,
   ali **ne smije mijenjati sopstvene granice** — nivo autonomije, budžete, politike, alate i safety polja su
   izvan dometa mašine (D38, `FORBIDDEN_FIELDS` u `genome.js`, `RSI_LEVELS.*.human`). Da bismo dali više,
   morali bismo dokazati da mašina može sigurno mijenjati upravo onaj sloj koji garantuje da je sigurna — a taj
   dokaz ne postoji. Zato se zaustavljamo **na L4, sa rojem, evolucijom i RSI-jem kao prijedlozima**.

---

## 1. Faza 0–12 mj: dokazati vrijednost (ne dodavati sposobnosti)

> **Pravilo faze (i jedina stvar koja se ne mijenja iz `docs/27` §2):** u prvih 12 mjeseci **nijedna nova
> sposobnost** ne ulazi u proizvod. v0.4 sloj (roj, evolucija, RSI) **zamrzava se za prodaju** i koristi samo
> unutra (interni kvalitet), dok ne postoji klijent koji ga **plaća**.

### 1.1 Šta se gradi

| # | Šta gradimo | Zašto baš to, baš sada (veza na v0.4) |
|---|---|---|
| 1 | **Prvi PLAĆENI klijent** na jednoj vertikali (preporuka: e-commerce ops, `docs/28` §2.1) | Bez plaćenog pilota nijedan broj u ovom dokumentu nije provjerljiv |
| 2 | **Eval na PRAVOM modelu** (ne mock): `NMQ_LLM_PROVIDER`, `NMQ_LLM_BASE_URL`, `NMQ_LLM_MODEL`, `NMQ_LLM_API_KEY` iz DSH store-a + **jedan testiran** fallback; `llmIsMock: false` na `/readyz` | Danas je eval 6/6 na mock-u; **evolucija i RSI mjere genom istim harness-om** (`evolution.evaluate` → `evalHarness.run`), pa mock fitness vodi pogrešnoj evoluciji |
| 3 | **Zlatni set sa 30–50 pitanja** (danas 6 u `eval/nmq.json`), 20–30% iz **stvarnih** upita klijenta | Kapija iz D47 je definisana, ali je set premali da bi bio kapija |
| 4 | **3–4 prave integracije** (tvrdo: max 4; peta samo ako je plati klijent) kroz `src/tools/mcp-client.js` | Roj bez pravih alata radi nad testnim podacima — a to nije dokaz |
| 5 | **Dashboard + inbox za odobrenja** (server-rendered HTML, bez frameworka, D2) | Swarm i evolucija **stvaraju** prijedloge i odobrenja; bez inbox-a čovjek ne može držati korak |
| 6 | **Swarm u pilotu na 2 vertikale** — samo **nizak rizik**, jedan node, sa freeze dugmetom u dashboardu | Dokaz da roj radi na stvarnom saobraćaju; mjeri se **trošak po riješenom zadatku**, ne „emergencija" |
| 7 | **Usklađivanje verzije i dokumentacije** — tag `v0.4.0`, **`docs/33` napisan**, `docs/29`–`docs/32` revidirani i **komitovani**, `docs/27` §1 ažuriran | Kod upućuje na `docs/33` koji ne postoji, a v0.4 sloj (kod + 4 dokumenta) **nije u git-u** — to je dug prema revizoru i prema klijentu koji pita „pokaži mi politiku" |
| 8 | **Safety osnova:** DPA + ugovor + SOW (**prije** prvog plaćenog klijenta), hash-chained audit export za klijenta | `docs/26` §8.3; bez toga nema ni prvog plaćenog klijenta, ni safety board-a koji ima šta da čita |

### 1.2 Deliverables

- **`eval/report-<datum>.md`** — tačnost, % sa citatom, p50/p95, USD/upit, **baseline na pravom modelu prije
  tuninga**; isti brojevi kao kolone u §11.
- **4 MCP servera vidljiva u `GET /v1/mcp`** sa brojem alata + dokumentovan OAuth tok po tenantu (`docs/03`).
- **Dashboard u produkciji** + **jedno odobrenje iz pretraživača** (dokaz da `curl` nije potreban), plus
  **freeze/unfreeze** dugme za roj (`POST /v1/admin/swarm/freeze`) koje radi iz UI-a, ne iz terminala.
- **Swarm izvještaj iz pilota**: `GET /v1/admin/swarm` (workers, claims, completed, failed, costUsd,
  specjalizacija) + `GET /v1/admin/swarm/safety` (nalazi) — **dvije nedjelje rada** na dvije vertikale.
- **`docs/33`** napisan, **`docs/29`–`docs/32` revidirani i komitovani** zajedno sa v0.4 kodom (uključivo tabelu
  „tvrdnja → dokaz → gdje"), i **tag `v0.4.0`** postavljen tek poslije nezavisne revizije (§12 odluka 6).
- **DPA + ugovor + SOW** (advokat) i **zapis prvog mjerenja** u `docs/19` §7.1.

### 1.3 Dokaz da je faza gotova (mjerljivo — ništa „otprilike")

| Dokaz | Prag | Izvor u sistemu |
|---|---|---|
| Plaćeni klijenti | **3 potpisana plaćena pilota** (500–1.500 EUR / 30 dana, **procjena**) | fakture |
| Kvalitet na **pravom** modelu | **≥ 80% tačnih sa citatom**, p95 **< 8 s**, **0** prijava „izmislio je" | `scripts/eval.mjs`, `GET /v1/usage` |
| Regresija | test pada ako tačnost padne **> 5%** (kapija iz D47); **180 od 182 testa** moraju ostati zeleni (2 su vezana za mock) | `node --test` (danas **182/182**), `tests/eval-v3.test.mjs`, `tests/swarm.test.mjs` |
| Bez čovjeka | **> 60%** runova bez `approval` i bez `handoff` na čovjeka | trace + audit |
| Swarm u pilotu | **≥ 500 zadataka** kroz roj na **2 vertikale**, **0** incidenata težine `high` neriješenih, **≤ 1** lažna uzbuna na 100 zadataka | `/v1/admin/swarm`, `/v1/admin/swarm/incidents` |
| Odobrenja | nijedno ne čeka **> 24 h** | `nmq_approvals_pending` |
| Trošak | **< 0,02 USD/upit** (**procjena** — **provjeriti kod provajdera**) | `GET /v1/usage` |
| Izolacija | **0** incidenata izolacije tenanta | testovi + `nmq_tenant_mismatch_total` |

**KPI faze:** **3 plaćena klijenta**, **> 60% bez čovjeka**, **eval ≥ 80% na pravom modelu**,
**0 incidenata izolacije**, **0 automatskih promjena granica** (autonomija, budžet, alati, RSI nivo).

### 1.4 Rizici faze

| Rizik | Vjerovatnoća | Uticaj | Mitigacija |
|---|---|---|---|
| **Nema plaćenog klijenta** (najveći rizik cijelog plana) | visoka | kritičan | 30 ciljanih razgovora; **plaćen** pilot (besplatan daje lažan signal); odluka o nastavku na kraju 4. mjeseca po brojevima (`docs/10` §7) |
| **Mock eval sakrije pravi problem** | visoka | visok | pravilo: **nijedna tvrdnja o kvalitetu ne važi dok nije izmjerena na pravom modelu**; mock ostaje samo za testove u CI-ju |
| **Swarm „emergencija" se proda prerano** | srednja | visok | §5 pravilo: roj se **ne prodaje** kao funkcija do faze 24–36; u fazi 0–12 je interni mehanizam sa freeze dugmetom |
| **Evolucija promoviše genom koji je bolji samo na mock-u** | srednja | srednji | `autoPromote: false` (default u `config/evolution.json`); promocija ide kroz `improvements` prijedlog i čovjeka (D42) |
| **Scope creep na 10 integracija** | visoka | srednja | tvrdo **max 4**; peta samo ako je **plati** klijent |
| **Swarm lažne uzbune troše povjerenje** | srednja | srednji | pragovi su u `config/swarm.json` i mijenjaju se **samo** kroz board rutu (auditovano); mjeri se lažni pozitiv po 100 zadataka |
| **Pravni rizik (DPA, odgovornost za AI izlaz)** | srednja | visok | advokat **prije** prvog plaćenog klijenta; ugovorom: izlaz je **nacrt**, ne pravni savjet |

### 1.5 Trošak faze (procjena)

| Stavka | Trošak (procjena) | Izvođenje / provjera |
|---|---|---|
| Rad 1–2 osobe | **vlastiti rad** (oportunitetni trošak, ne cash) | sati u evidenciji |
| Model po upitu (mjerenje + 3 pilota + eval na pravom modelu) | **< 500 EUR** ukupno | `GET /v1/usage`; **provjeriti cijene kod provajdera** |
| Advokat: DPA + ugovor + SOW | **500–2.000 EUR** | 2 ponude, faktura |
| Pen-test (web + API + widget) | **1.500–6.000 EUR** | 2 ponude, izvještaj; radi se **prije** prvog enterprise razgovora |
| Infra (VPS EU, domena, TLS, backup) | **15–60 EUR/mj.** (postojeći `nmq-server` pokriva početak) | faktura providera |
| Swarm pilot (dodatni trošak modela u pilotu) | **< 300 EUR** (dva tenanta, ≤ 2 USD/sat kvota po tenantu u `config/swarm.json`) | `/v1/admin/swarm` `costUsd` |
| **Ukupno cash faze** | **≈ 2.500–9.000 EUR** (bez pen-testa), **≈ 4.000–15.000 EUR** sa pen-testom | — |

> **Napomena o kvoti:** `config/swarm.json` danas dozvoljava **2 USD/sat** i **8 runova/tick** za tenant `nmq`.
> To je **interna** postavka za demo; u pilotu se spušta na iznos koji odgovara ugovoru (i to je izmjena kroz
> board rutu, auditovana).

---

## 2. Faza 12–24 mj: skaliranje i kvalitet

> **Cilj faze:** sistem smije primiti **30–60 klijenata** bez duplih poslova, sekvencijalnog skena nad
> vektorima i **sa dokazanom izolacijom na nivou baze** — a **roj prelazi na više nodova** tek poslije
> Postgresa i distributed claim-a.

### 2.1 Šta se gradi

| # | Šta | Zašto sada (veza na v0.4) |
|---|---|---|
| 1 | **PostgreSQL 16 + pgvector** kroz **postojeće interfejse** (`VectorStore`, memory, longterm, audit, cost), **bez izmjene agenata** (D9); RLS `FORCE` po `tenant_id` | Prelaz sa fajl-sistema je preduslov za svaki naredni korak — uključujući shared store za feromone |
| 2 | **Redis**: sesije, rate limit (atomični `INCR`+`EXPIRE` umjesto in-memory mape), **queue** za duge zadatke | Danas su `rateWindows` u `src/swarm/governance.js` **u memoriji procesa** → restart briše kvote; u cross-node roju to je **sigurnosni** problem, ne performansni |
| 3 | **Cross-node swarm** — distributed claim + **feromoni u shared store** | Danas: tabla i feromoni su `Map` u memoriji (`src/swarm/blackboard.js`), na disk ide samo log. Bez ovoga „roj" je jedan proces |
| 4 | **Topologija roja (susedi)** — mediator prima listu susjeda umjesto broadcast-a | Danas je svaka peer poruka medijatorska **globalno**; sa 100+ workera to postaje i trošak i slijepa tačka nadzora |
| 5 | **Prvi SFT/LoRA na JEDNOM agentu**, van kritičnog puta, sa **eval kapijom** | Dataset nastaje iz self-play-a; odluka „da/ne" mora biti na dokazu (`docs/27` §12 odluka 4) |
| 6 | **Reward model na ljudskim ocjenama** (≥ 300 ocjena), korelacija > 0,6 | **Evolucija i RSI koriste isti fitness** (`genome.fitness`); ako je reward heuristički, evolucija optimizuje našu pretpostavku, ne kvalitet |
| 7 | **Distributed lock** koji zamjenjuje fajl-lease (D22) | Dvije replike + fajl-lease = **dupli mejl, dupli refund**; chaos test je obavezan |
| 8 | **30–60 klijenata na 2 vertikale** | Pravilo: treća vertikala tek kad prve dvije imaju 2+ plaćena klijenta **svaka** (`docs/10` §3) |

### 2.2 Deliverables

- Postgres/pgvector/Redis stack + migracije + **test koji namjerno probija tenant kroz SQL i pada**.
- **Dvije instance roja** sa dokazom: 1000 uzastopnih claim-ova → **svaki zadatak izvršen tačno jednom**.
- Eval izvještaj **baseline vs SFT** (tačnost, citiranost, USD/upit, latencija) — i **odluka** (uvesti/ne).
- Kalibrisan reward model + prvi A/B pobjednik promovisan kroz kontrolnu ravan **uz audit**.
- **`GET /v1/admin/evolution` i `/v1/admin/rsi` u dashboardu** — board vidi trend fitness-a i lift-a bez SSH-a.
- 30–60 plaćenih klijenata, od kojih **≥ 3 enterprise**.

### 2.3 KPI faze

| KPI | Cilj (procjena) | Izvor |
|---|---|---|
| Klijenti | **30–60** | CRM |
| Bruto marža po klijentu | **> 70%** | prihod − (model + infra + support minute) |
| Trošak po zahtjevu | **< 0,02 USD** (**provjeriti**) | `GET /v1/usage` |
| Churn | **< 3%/mj.** (Pro), **< 5%/mj.** (Starter) | otkazi / aktivni |
| Cross-node roj | **0 duplih izvršenja** u 1000 claim-ova; **0** incidenata izolacije | CI test + audit |
| SFT | odluka **na brojevima**, ne na vjeri; ako lift nije mjerljiv → **ne** ulazi u produkciju | `eval/report-*.md` |

### 2.4 Rizici faze

| Rizik | Vjerovatnoća | Uticaj | Mitigacija |
|---|---|---|---|
| **Postgres migracija razbije izolaciju** | niska | **kritičan** | RLS `FORCE` + test probijanja tenanta; prelazak **po tenantu**, ne „svi odjednom" |
| **Cross-node swarm: dupli claim** | srednja | visok | distributed lock sa TTL + owner token; **idempotencija po `taskId`**; chaos test |
| **Shared store feromona postane „skriveni kanal"** | srednja | visok | feromoni ostaju **podaci sa TTL-om** (ne poruke), medijacija ostaje **jedini** kanal; svaki upis u shared store ide kroz `safety.mediateMessage` |
| **Topologija susjeda smanji detekciju koluzije** | srednja | srednji | susjedi se **računaju iz stvarnih interakcija**, a ne zadaju ručno; `safety.detect` i dalje gleda **globalnu** ko-occurrence |
| **Fine-tune ne donosi ništa** | srednja | niski | trening je **van** kritičnog puta; ako lift nije mjerljiv — ostajemo na RAG + prompt + eval, i to je **u redu** |
| **Trošak klastera za solo tim** | visoka | srednji | cross-node ide **poslije** Postgresa; ako nedjeljno održavanje pređe 2 h → **povratak na Compose je legitimna odluka** |

### 2.5 Trošak faze (procjena)

| Stavka | Trošak (procjena) | Izvođenje |
|---|---|---|
| VPS sa Postgresom + Redis | **50–150 EUR/mj.** | **provjeriti cjenovnik** |
| Cross-node (2–3 node-a) | **60–300 EUR/mj.** | 2–3 VPS ili mali `k3s`; **provjeriti** |
| Monitoring (Prometheus/Tempo/Grafana) | **0 EUR** softver; **1–2 GB RAM** | `docker stats` |
| SFT/LoRA (jedan agent) | **50–500 EUR** po treningu (**tražiti ponudu**) | faktura provajdera |
| Ljudi | **2–3 FTE** → **6.000–14.000 EUR/mj.** bruto (**procjena**) | §8 |
| **Ukupno cash faze** | **≈ 120.000–220.000 EUR** za 12 mjeseci (sa ljudima) | — |

---

## 3. Faza 24–36 mj: emergencija pod nadzorom

> **Cilj faze:** roj se **pušta u produkciju** — ali sa **topologijom**, **nadzorom na nivou roja** i
> **granicama koje se ne mogu pregovarati iznutra**. Istovremeno A2A prelazi iz protokola u **stvarni novac**.

### 3.1 Šta se gradi

| # | Šta | Dokaz da je urađeno kako treba |
|---|---|---|
| 1 | **Emergentna specijalizacija u produkciji** (danas `swarm.specialization()` mjeri iz završetaka) | Specijalizacija se **predlaže** kao izmjena konfiguracije (pattern/tools po workeru) kroz `improvements`, čovjek odobrava; mjeri se **rast prolaznosti** prije/poslije na zlatnom setu |
| 2 | **Topologija roja (susedi)** — mediator zna ko smije kome i koliko često | Svaka peer poruka ima `from → to`, topologija je u configu (podatak), a ne u kodu; `GET /v1/admin/swarm/safety` pokazuje **graf interakcija** |
| 3 | **A2A sa pravim partnerima i pravim plaćanjem** (Stripe/SEPA) | **≥ 1 stvarna faktura** kroz A2A tok; `settle()` zatvara stavku **samo** kad adapter vrati `externalRef`; reconciliation sa bankom do centa |
| 4 | **x402 samo za mikroplaćanja** (odluka u §12) | Mikroplaćanja (< 5 EUR, npr. jedan dokument ili jedan poziv alata) — **odvojen** tok od Stripe/SEPA, sa dnevnim cap-om i allowlistom primalaca |
| 5 | **Reputacija partnera** — skor iz **stvarnih** ishoda (% završenih, prosječno vrijeme, sporovi) | Skor **utiče** na granice pregovora (`requireHumanAboveUsd` niži za slabijeg partnera); **jedan spor** dokumentovan i riješen eskalacijom na čovjeka |
| 6 | **Marketplace template-a** (`docs/28`) — ≥ 5 template-a, klijent/agencija sami aktiviraju | Uvođenje novog klijenta na template-u **< 1 dan našeg rada** (mjereno), ukupno < 3 dana |
| 7 | **Cross-node safety nadzor** — detekcija **između** nodova | Test: dva noda, namjerno koordinisano glasanje → incident se otvori **jednom**, ne dvaput i ne nijednom; lažni pozitiv < 5% |
| 8 | **Kill switch na nivou roja kao ugovorena funkcija** | Freeze radi iz dashboarda, traje kroz restart (`data/_control/swarm.json`), i **piše u audit** — klijent to vidi kao feature, ne kao našu olovku |

### 3.2 Deliverables

- **Swarm produkcijski izvještaj** po tenantu: workers, claims, completed/failed, `costUsd`, specijalizacija,
  incidenti, freeze istorija.
- Dokumentovan **A2A ugovor** (ko plaća, ko odgovara, šta je „isporučeno") + **reconciliation izvještaj**.
- Reputacioni skor + pravila koja iz njega slijede (zapisana, verzionisana).
- **≥ 5 template-a** + uputstvo „novi klijent za 1 dan našeg rada".
- **Cross-node incident runbook** sa najmanje jednim **vježbanim** scenarijem (ne samo napisanim).

### 3.3 KPI faze

| KPI | Cilj (procjena) | Izvor |
|---|---|---|
| % prihoda iz kanala | **≥ 25%** | CRM/atribucija |
| Broj A2A transakcija | **≥ 10.000/mj.** | `settlements_total`, `negotiations_total` |
| A2A partneri | **≥ 5** | ugovori |
| Teški incidenti | **0** (cilj); svaki se objavljuje u mjesečnom izvještaju board-a | `swarm_incidents_total`, `swarm_freeze_total` |
| Marketplace | **≥ 5 template-a**, ≥ 20 klijenata na template-u | `templates/` + CRM |
| Uvođenje klijenta | **< 1 dan našeg rada** (prosjek zadnjih 10) | evidencija sati |

### 3.4 Rizici faze

| Rizik | Vjerovatnoća | Uticaj | Mitigacija |
|---|---|---|---|
| **Emergentna specijalizacija se pretvori u „tihi kartel"** | srednja | **kritičan** | specijalizacija je **podatak koji čovjek primjenjuje**, ne automatska promjena; `vote` je **savjetodavan** (`consensus()` to i piše); freeze + quarantine rade automatski (`autoContain: true`) |
| **Roj izvršava nešto što nije nizak rizik** | niska | **kritičan** | `assertCanRun` baca `PolicyError` za `medium`/`high` — u fazi 3 se to **ne mijenja**; svaka promjena tog pravila je odluka board-a (D38) |
| **A2A sa pravim novcem povlači KYC/AML/PDV** | srednja | visok | novac ide kroz **postojećeg** procesora; **mi ne držimo sredstva**; pravnik pregleda tok **prije** prve transakcije |
| **x402 pukne ili partner ga ne podržava** | srednja | nizak | x402 je **opcija za mikroplaćanja**, ne kičma; Stripe/SEPA je primarni tok |
| **Marketplace bez korisnika** | srednja | srednji | marketplace kreće **tek** kad ima ≥ 20 klijenata; do tada su template-i interni alat |
| **Cross-node nadzor ima slijepu tačku** | srednja | visok | detekcija na **oba** nivoa (lokalno + agregirano); test sa namjernom koluzijom između nodova je **kapija** za produkciju |

### 3.5 Trošak faze (procjena)

| Stavka | Trošak (procjena) | Izvođenje |
|---|---|---|
| Ljudi (4–7 FTE) | **12.000–26.000 EUR/mj.** bruto (**procjena**) | §8 |
| Infra (klaster + monitoring + storage) | **400–1.200 EUR/mj.** | §7 |
| Pravnik (A2A ugovor, DPA lanac za agencije, x402 uslovi) | **2.000–6.000 EUR** jednokratno | 2 ponude |
| Procesor plaćanja | **procjena 2,9% + 0,30 EUR** po transakciji + **1–2%** konverzija — **provjeriti aktuelne uslove** | izvod procesora |
| Safety savjetnik (eksterni, dio vremena) | **500–1.500 EUR/mj.** | ugovor o angažovanju |
| Pen-test (drugi, poslije promjena) | **3.000–10.000 EUR** | izvještaj |
| **Ukupno cash faze** | **≈ 250.000–450.000 EUR** za 12 mjeseci | — |

---

## 4. Faza 36–48 mj: RSI i (opciono) DAO pilot

> **Cilj faze:** robot **predlaže izmjene sebe** (uz obavezan review i **eval kapiju**), a **AI organizacija je
> proizvod** („kupiš odjel"). R4/R5 ulaze u proizvodnju — **kao predlozi**, nikad kao automatska primjena.

### 4.1 Šta se gradi

| # | Šta | Dokaz da je urađeno kako treba |
|---|---|---|
| 1 | **R4 (environment-adaptation) u proizvodnji** — prilagođavanje novom domenu/jeziku/KB | `adaptEnvironment` proizvodi prijedlog; promjena se mjeri na zlatnom setu **prije** i **poslije**; `riskLevel: high` za `tools` (kako je u kodu) |
| 2 | **R5 (meta) u proizvodnji** — sistem predlaže **kako da poboljša proces poboljšavanja** | `metaImprove` daje prijedloge tipa `process_change` i `eval_extension`; **svaki** ide u inbox kao `kind: 'code'`; **0** automatskih meta-izmjena (`autoMetaPromote: false`) |
| 3 | **Eval kao kapija za svaku izmjenu** (nadogradnja D47) | Promjena koja **obara** zlatni set se **automatski odbija** i to je vidljivo u auditu; mjeri se **% prihvaćenih** i **% odbijenih** prijedloga |
| 4 | **Meta-izmjene kao predlozi sa obaveznim review-om** | Tok: nalaz → **patch predlog + test** → čovjek → PR → CI → deploy kroz kontrolnu ravan; mjeri se **vrijeme od nalaza do popravke** |
| 5 | **AI organizacija kao proizvod („kupiš odjel")** | **≥ 3 klijenta** koriste org ciklus kao **ugovorenu** funkciju; mjesečni izvještaj „odjela" (ciljevi, KPI, trošak, odluke) ide klijentu automatski |
| 6 | **Cross-tenant učenje samo kao šablon, nikad kao podatak** | Template (ne podaci klijenta) se unapređuje iz zajedničkih obrazaca; **evidencija** da nijedan podatak klijenta nije ušao u tuđi prompt/KB (test + audit) |
| 7 | **DAO pilot — SAMO ako postoji stvarna potreba trećih strana** | Uslov je u §5 i §12: **≥ 3 eksterne strane** koje same traže zajedničko upravljanje i **plaćaju** ga; bez toga **ne radimo ga** i to je uspjeh odluke |
| 8 | **Enterprise paket koji ne tvrdi ništa što nemamo** | SSO (jedan provider, `authorization_code` + PKCE) + MFA za `owner`/`admin`; tabela „tvrdnja → dokaz → gdje"; **nikad** „SOC 2 compliant" bez sertifikata |

### 4.2 Deliverables

- **RSI status tabla** za board (danas `GET /v1/admin/rsi` → `status()`): nivo, broj eksperimenata, **prosječan
  lift**, broj promocija, broj meta-ciklusa, kapije — u dashboardu, sa trendom po kvartalu.
- **Tok „nalaz → patch → test → review → deploy"** sa mjerenjem vremena; **zapis** za svaki meta-prijedlog.
- **Org kao proizvod:** cenovnik po „odjelu", ne po agentu (`docs/09` §8); primjer mjesečnog izvještaja.
- **Godišnji ugovori** za Pro/Enterprise (bolji cash-flow, niži churn).
- **Odluka o DAO pilotu** zapisana sa brojevima (da/ne i zašto), u `DECISIONS.md`.

### 4.3 KPI faze

| KPI | Cilj (procjena) | Izvor |
|---|---|---|
| ARR (bazno) | **≈ 2,0–2,6 mio EUR** (**procjena**, §7) | fakture + `GET /v1/usage` |
| Enterprise klijenti | **≥ 25** | ugovori |
| % automatizovanih poboljšanja koja prođu eval | **≥ 60%** prijavljenih; **≥ 30%** primijenjenih poslije review-a | audit (`improvement_*`, `rsi_promotions_total`) |
| Vrijeme od nalaza do popravke | **< 5 dana** | ticket → deploy |
| Org kao proizvod | **≥ 3 klijenta** sa ugovorenim org ciklusom | ugovori |
| Automatske izmjene granica | **0** (nepromjenjivo) | audit + testovi |

### 4.4 Rizici faze

| Rizik | Vjerovatnoća | Uticaj | Mitigacija |
|---|---|---|---|
| **RSI promijeni nešto pogrešno** | srednja | visok | **eval kapija** + review + test + rollback; automatski se mijenjaju **samo** prompt/pattern/policy/KB, i to poslije odobrenja; **kod nikad** bez čovjeka (D46) |
| **RSI proizvodi šum** (50 prijedloga koje niko ne gleda) | visoka | srednji | prijedlog bez **dokaza** i **očekivanog efekta** se odbacuje; nedjeljni limit; mjeri se „koliko je primijenjeno" (cilj > 30%, inače se ciklus prigušuje) |
| **Meta-izmjena oslabi kapiju** (najopasniji scenario) | niska | **kritičan** | kapija je **izvan** RSI dometa: R5 predlaže, ali `autoMetaPromote: false`; svaka izmjena kapije traži **board** i **dvije** osobe (safety savjetnik + vlasnik) |
| **DAO pilot uvede odgovornost bez potrebe** | srednja | visok | uslov „3 eksterne strane koje traže i plaćaju"; pravnik **prije** ičega; ako nema uslova — **ne radimo** |
| **Kompleksnost raste brže od tima** | visoka | srednji | sve kroz **postojeće** interfejse; nova sposobnost = nova JSON datoteka, ne novi servis; ako održavanje pređe limit — **sječe se obim, ne produžava rok** |
| **„Previše frontier, premalo prihoda"** | visoka | **kritičan** | §5 i §12: **nijedan** RSI/evolucijski/sarm rad ne smije biti uslov za prihod; KPI faze 0–12 je **prihod**, ne emergencija |

### 4.5 Trošak faze (procjena)

| Stavka | Trošak (procjena) | Izvođenje |
|---|---|---|
| Ljudi (7–12 FTE) | **24.000–48.000 EUR/mj.** bruto (**procjena**) | §8 |
| Infra (klaster, storage, monitoring, backup) | **800–2.000 EUR/mj.** | §7 |
| Pravno/sigurnost (SSO ugovori, DAO pravno mišljenje ako ide, pen-test) | **10.000–30.000 EUR** | 2–3 ponude |
| Safety savjetnik (eksterni, redovan) | **800–2.000 EUR/mj.** | ugovor |
| SOC 2 Type II (ako ga klijent **plati**) | **15.000–60.000 EUR** (**procjena**, **tražiti ponude**) — **nije** obaveza ovog plana | `docs/26` §8.3 |
| **Ukupno cash faze** | **≈ 400.000–700.000 EUR** za 12 mjeseci | — |

---

## 5. Šta NAMJERNO ne radimo (48 mj)

Ovo nije lista „nemamo vremena" — ovo je **strateški i sigurnosni štit**. Svaka stavka ima obrazloženje i
**uslov pod kojim bi se odluka promijenila**.

| Ne radimo | Zašto | Uslov koji bi odluku promijenio |
|---|---|---|
| **Vlastiti foundation model** | Cijena modela po upitu je **manja od našeg vremena**; nemamo 10.000+ označenih primjera; kvalitet se prvo rješava **RAG-om, promptom i eval-om**; model je zamjenjiv u jednom polju (D6) | Eval dokaže da je problem **u modelu**, a ne u KB-u — i to u formi **LoRA na jednom agentu** (§2), nikad foundation model |
| **Potpuno autonomno deployovanje sopstvenih izmjena** | Sistem koji može sam sebe deployovati **nema kapiju**; eval kapija je jedina mjera koja razdvaja „poboljšanje" od „regresije koja se ne vidi do klijenta". Naša cijela prodajna teza je **dokazivost**, a ona pada prvog dana autonomnog deploy-a | **Nikad** kao default. Maksimalno: automatsko **predlaganje + test** i primjena uz odobrenje **dvije** osobe (vlasnik + safety savjetnik), i to samo za `prompt`/`kb` na **jednom** tenantu |
| **Nekontrolisani novac bez čovjeka** | `high` rizik i kategorije `financial/legal/destructive/external_communication` traže čovjeka **na svim nivoima** (D38, `HUMAN_ONLY` u `src/core/autonomy.js`); greška u novcu je nepovratna, a povjerenje je jedina valuta koju imamo | **Nikad** kao default. Maksimalno: „unaprijed odobreno do iznosa X" **uz** allowlist primalaca, dnevni/mjesečni limit, idempotency ključ i alert — i to **po klijentu, uz njegov potpis** (`docs/26` §7 tačka 1 traži sve četiri stavke) |
| **Otvoreni peer kanali van medijacije** | `src/swarm/blackboard.js` to izričito zabranjuje („Namjerno NEMA direktne poruke agent→agent"); svaka poruka ide kroz `safety.mediateMessage`, gdje se provjerava, loguje i gdje se **covert kanal blokira**. Otvoren kanal = nemogućnost dokazivanja šta je roj dogovorio | Klijent **plati** izolovani roj na sopstvenoj infrastrukturi i prihvati odgovornost ugovorom — i tada medijacija **ostaje**, samo se mijenja ko je vlasnik loga |
| **Multi-region** | Nema klijenta koji to traži; udvostručuje trošak i operativni teret; prvo **jedan region (EU)**, pa replika baze, pa tek onda drugi region | Enterprise ugovor koji **plaća** multi-region i traži pisanu obavezu RTO/RPO |
| **Sopstveni blockchain** | Poravnanje između dvije firme je **računovodstveni i pravni** problem, ne kriptografski; Stripe/SEPA rješava 95% slučajeva brže, jeftinije i sa manje odgovornosti (KYC/AML); interni ledger **već postoji** za internu raspodjelu | Partner **traži** on-chain poravnanje, **plaća** ga, i pravnik potvrdi da ne uvodimo dodatne obaveze |
| **HR odluke** (zapošljavanje, otkaz, unapređenje, ocjena rada) | Zakon, etika i (od 2.12.2027) klasifikacija **visokorizičnog** sistema po EU AI Act, Annex III tačka 4 (`docs/26` §8.1). Robot može strukturisati prijave i pripremiti pitanja; **ne** rangira, ne odbija, ne ocjenjuje ljude | **Nikad** u ovom planu. Ako klijent to traži → to je **drugi posao**, sa pravnim mišljenjem, Annex IV dokumentacijom, QMS-om i ocjenom usaglašenosti — i sa cijenom koja to pokriva |
| **Autonomija iznad L4** | Vidi obrazloženje ispod — **L4 je plafon** | Nema uslova u ovom planu (vidi ispod) |
| **Voice / telefonski kanal** | Drugi kanal, druga latencija, druga cijena; nema klijenta koji to traži u prvih 36 mjeseci | Klijent koji to **plati** kao poseban projekat |
| **Vlastiti dashboard framework / SPA** | „Moderni" frontend je 3× vremena bez vrijednosti za operatera; server-rendered HTML + `fetch` je dovoljno i nema build korak (D2) | Operater **ne može** raditi posao u HTML-u (mjereno brojem klikova i support minuta) |
| **SOC 2 / ISO 27001 kao uslov opstanka** | Mjeseci i desetine hiljada EUR; radimo dokumentaciju **koju možemo dokazati** i jasno kažemo šta nemamo | Klijent potpiše ugovor koji **plaća** pripremu → tada je to **odvojen projekat** |
| **Treća vertikala prije nego prve dvije imaju 2+ plaćena klijenta** | Polovičan fokus je najsigurniji način da se izgubi postojeći napredak (`docs/10` §3) | Prve dvije vertikale imaju 2+ plaćena klijenta **svaka** |
| **Naplaćivanje po tokenu kao javni cjenovnik** | Klijent vidi nepredvidiv račun i odustaje; tokeni su **interna** mjera | Enterprise ugovor sa fiksnim minimumom i mjesečnim obračunom |

### 5.1 Zašto je L4 plafon (i šta bi značilo ići iznad)

**Šta L4 danas znači u kodu:** `src/core/autonomy.js` + `config/autonomy.json` — L0 assistant → L1 propose →
L2 supervised → L3 goal → L4 autonomous. Čak i na L4: `high` rizik i kategorije `financial`, `legal`,
`destructive`, `external_communication` traže čovjeka (D38). Nivo se mijenja **samo** kroz admin/owner rutu,
per tenant i per agent, i **svaka promjena je auditovana**.

**Šta bi značilo „L5":** da mašina sama mijenja **sopstvene granice** — nivo autonomije, budžete, politike
odobrenja, skup alata, safety pragove, RSI nivo. U kodu su **sva ta polja već označena kao zabranjena za
mutaciju**: `FORBIDDEN_FIELDS` u `src/evolution/genome.js` sadrži `autonomy`, `budget`, `tools`, `maxRisk`,
`policy`, `requireApproval`, `allowedTools`, `sandbox`, `maxToolCalls`; R4 i R5 u `RSI_LEVELS` imaju
`human: true`; `autoMetaPromote: false` u `config/rsi.json`; `autoPromote: false` u `config/evolution.json`.

**Zašto to ne prelazimo — tri razloga, po težini:**

1. **Nema evaluacije koja je jeftinija od rizika pogrešne meta-izmjene.** Greška na meta-nivou **kvari sve
   niže nivoe odjednom**: ako se oslabi kapija, svi prethodni dokazi (eval, audit, izolacija) prestaju nešto
   značiti — jer su bili proizvod kapije. To i piše u kodu (`src/rsi/meta.js`, uvodni komentar).
2. **Prodajna teza bi pala.** Klijent kupuje **dokazivost**: „pokaži mi šta je robot uradio i zašto".
   Autonomna izmjena sopstvenih granica znači da ono što je juče važilo ne mora da važi danas — a to je
   definicija sistema koji se ne može ugovoriti. **Ugovor sa klijentom je mjesto gdje se autonomija zaključava.**
3. **Regulatorno.** `Article 14` (human oversight) i `Article 12`/`19` (logovi) su „naš posao" i ako nismo
   visokorizični (`docs/26` §8.1). Sistem koji sam podešava granice nadzora je teško objasniti revizoru — i
   bespotrebno nas gura ka režimu u koji **ne želimo** da uđemo.

**Iskreno, i ovo je najvažnija rečenica ovog dokumenta:** L4 sa rojem, evolucijom i RSI-jem **kao
predlozima** je dovoljno „frontier" da bude teško kopirati, a dovoljno **ograničeno** da se može ugovoriti,
auditovati i objasniti. Sve iznad toga je naučni eksperiment sa tuđim novcem i tuđim podacima — i tamo ne
idemo bez **posebnog** programa, posebnog budžeta i ljudi koje danas nemamo.

---

## 6. Biznis model za „AI vrstu"

**„AI vrsta"** ovdje znači: sistem koji ima **više agenata, roj, evoluciju i organizaciju** — i koji se
prodaje kao **sposobnost organizacije**, ne kao licenca za chat. Četiri linije prihoda, **po redu uvođenja**:

| # | Model | Kome | Kako se mjeri | Zašto je odbranjiv |
|---|---|---|---|---|
| 1 | **Licenca po odjelu/funkciji** (ne po agentu, ne po tokenu) | Sve (Starter → Enterprise) | Mjesečna pretplata + fair-use; `GET /v1/usage` je **interna** mjera, ne faktura | Cijena je vezana za **funkciju** (support, finansije, prodaja), a sidro je **plata čovjeka** (`docs/09` §8). Kopirati prompt je lako; kopirati **odjel sa politikama, budžetom, izolacijom i auditom** nije |
| 2 | **% od mjerljive uštede** (uz baseline i cap) | Pro/Enterprise sa ponavljajućim procesom | `ušteđeni sati = (broj runova × prosječno minuta po zadatku kod čovjeka) / 60`, gdje „prosječno minuta" dolazi iz **baseline-a mjerenog prije uključenja**; cap = **ne više od 100% mjesečne licence** | Rizik je na nama (naplaćujemo **poslije** izmjerene uštede, klijent ima 15 dana da ospori broj), a **baseline i izvještaj generiše robot** — što je istovremeno i dokaz i proizvod. Bez baseline-a: **nije mjereno**, i tada se ne naplaćuje |
| 3 | **Template / franšiza** (vidi `docs/28`) | Agencije i firme iz iste vertikale | Vrijeme uvođenja novog klijenta (**cilj < 1 dan našeg rada**), broj klijenata po template-u, % prihoda iz kanala | Vrijednost nije JSON nego **eval zlatni set iz stvarnih promašaja** + playbook + KB checklist; to nastaje iz mjeseci rada i **nije prenosivo kopiranjem** (`docs/28` §8) |
| 4 | **A2A provizija** (kad bude stvarnog prometa) | Partneri i njihovi klijenti | Broj A2A transakcija/mj. (`settlements_total`, `negotiations_total`), prosječna vrijednost, marža po transakciji | Naplaćujemo **posredovanje u izvršenju** (zadatak + dokaz + poravnanje), ne pristup mreži. Provizija ide kroz **postojećeg** procesora; **mi ne držimo sredstva** |

**Redoslijed je obavezan:** linija 1 mora raditi bez nas prije nego linija 2 ima smisla (jer bez baseline-a
nema %), linija 3 prije linije 4 (jer bez template-a nema ponovljivog partnera). **Nijedna linija ne kreće
paralelno** — to je pravilo iz `docs/28` §7: „kanal se ne otvara dok prethodni **ne radi bez nas**".

### 6.1 Kako skalirati na hiljade klijenata sa minimalnim marginalnim troškom

| Poluga | Šta konkretno radimo | Efekat na marginalni trošak |
|---|---|---|
| **Self-service onboarding** | Klijent sam unosi tenant, dokumente, radno vrijeme i odobravatelja kroz dashboard; mi ulazimo **samo** na „poveži integraciju" | Uvođenje pada sa 8–16 h na **1–2 h** (mjereno; cilj iz `docs/28` §4) |
| **Template + verzionisanje** | Nova vertikala = novi folder **podataka** (D14), ne kod; `templateVersion` + audit pri primjeni (D33: override po tenantu) | Nova vertikala je **dani**, ne mjeseci; izmjena template-a **ne** mijenja tiho postojećeg klijenta |
| **Eval automatizacija** | Regresija pada **test**, ne čovjek: promjena prompta/politike ide kroz isti zlatni set (D47), po tenantu | Kvalitet prestaje da bude ručni posao; trošak provjere je **jedan eval run**, ne sastanak |
| **KB šabloni + checklist** | „Ponavljajuće pitanje = nova stavka u template-u (KB/politika/watcher), **ne** novi ticket" (`docs/10` §2) | Support minute po klijentu **padaju** umjesto da rastu — i to je jedini način da 300 klijenata bude izvodljivo sa < 10 ljudi |
| **Roj kao „kapacitet", ne kao funkcija** | Worker se dodaje kao podatak; kvote (`config/swarm.json`) drže trošak po tenantu | Skaliranje kapaciteta ne traži novi servis ni novu arhitekturu |
| **Kill switch i izolacija kao ugovorena funkcija** | Freeze/unfreeze + izolacioni nivoi (`open/contained/locked/frozen`) su **vidljivi** klijentu | Jedan problematičan tenant se gasi **u sekundi** — bez toga je svaki incident globalni incident |

**Iskreno o marginalnom trošku (tri stvari koje stvarno bole):**

1. **Integracije** — svaka nova integracija je **razvoj** (OAuth, mapiranje polja, kvote). Pravilo: **max 4 po
   template-u**; peta samo ako je **plati** klijent.
2. **Onboarding van template-a** — klijent van naše 4 vertikale pojede 5–20 h. Pravilo: van template-a se
   prodaje **samo kao Enterprise projekat**.
3. **Cross-node roj** — svaki novi node je operativni trošak (nadzor, lock, monitoring). Pravilo: node se
   dodaje **samo** kad metrika kaže da je jedan node uska grla (mjereno: p95 claim latencija, broj idle tickova).

---

## 7. Ekonomija

> **Sve brojke su „procjena" i svaka ima izvođenje.** Pretpostavke su ispod tabele; **mijenja ih zamjena bilo
> koje pretpostavke**, ne osjećaj.

### 7.1 Pretpostavke (eksplicitno)

- **ARPU po segmentu (procjena, iz `docs/09` §3–4 i `docs/28` §5.1):** Starter **130 EUR/mj.**,
  Pro **400 EUR/mj.**, Enterprise **1.800 EUR/mj.** (miks pretplate + fair-use + setup se prikazuje odvojeno).
- **Trošak modela:** cilj **< 15% prihoda**; u modelu računamo **12%** prihoda. **Stvarne cijene provjeriti kod
  provajdera** — `PRICING` u `src/observability/cost.js` je konfiguracija, ne činjenica (D36).
- **Infra (procjena):** G1 **50–150 EUR/mj.**, G2 **150–600 EUR/mj.**, G3 **500–1.400 EUR/mj.**,
  G4 **1.000–2.500 EUR/mj.** (Postgres/Redis → cross-node → klaster/monitoring/storage). **Provjeriti cjenovnike.**
- **Ljudi (procjena, bruto trošak firme, region Srbija/BiH/CG/Hrvatska):** inženjer **3.000–6.000 EUR/mj.**,
  podrška **1.200–2.000 EUR/mj.**, prodaja **1.500–3.500 EUR/mj.**, DevOps **3.500–6.000 EUR/mj.**,
  data/ML **3.000–6.000 EUR/mj.**, safety savjetnik (eksterni, dio vremena) **500–2.000 EUR/mj.**
- **Pravno/sigurnost/ostalo:** G1 **3.000–15.000 EUR** (DPA/ugovor + pen-test), G2 **5.000–20.000 EUR**,
  G3 **10.000–35.000 EUR** (A2A ugovori, DPA lanac za agencije, drugi pen-test), G4 **15.000–60.000 EUR**
  (SSO ugovori, DAO pravno mišljenje ako ide, SOC 2 **samo ako je plaćen**).
- **Setup prihod** je prikazan odvojeno (jednokratno), jer nije ponavljajući.
- **Valuta:** trošak modela je u **USD**, prihod u **EUR** → fakturisati u EUR gdje je moguće; kursni rizik se
  **ne** prenosi na klijenta tiho (`docs/09` §9).

### 7.2 Prihod, trošak, marža, runway — po godini (procjena)

**Izvođenje prihoda (bazno), korak po korak:**

- **G1 (mj. 1–12):** 3 klijenta do mj. 6, 12 do mj. 12; miks 10 Starter + 2 Pro; prosječno trajanje u godini
  ≈ 5 mjeseci naplaćeno → `(10×130 + 2×400) × 5 = 8.100 EUR` + setup `12 × 300 = 3.600` → **≈ 12.000 EUR**.
- **G2 (mj. 13–24):** 12 → 55 klijenata; miks 40 Starter + 13 Pro + 2 Enterprise; prosjek 6 mjeseci naplate
  → `(40×130 + 13×400 + 2×1.800) × 6 = (5.200 + 5.200 + 3.600) × 6 = 84.000 EUR` + setup ≈ 13.000 → **≈ 97.000 EUR**.
- **G3 (mj. 25–36):** 55 → 160 klijenata; miks 110 Starter + 42 Pro + 8 Enterprise; prosjek 6 mjeseci
  → `(14.300 + 16.800 + 14.400) × 6 = 273.000 EUR` + setup ≈ 40.000 → **≈ 313.000 EUR**.
- **G4 (mj. 37–48):** 160 → 350 klijenata; miks 230 Starter + 95 Pro + 25 Enterprise; prosjek 6 mjeseci
  → `(29.900 + 38.000 + 45.000) × 6 = 677.400 EUR` + setup ≈ 60.000 → **≈ 737.000 EUR**.

| | **Godina 1** (mj. 1–12) | **Godina 2** (mj. 13–24) | **Godina 3** (mj. 25–36) | **Godina 4** (mj. 37–48) |
|---|---|---|---|---|
| **Prihod — konzervativno (procjena)** | **5.000 EUR** (2 klijenta krajem G1) | **40.000 EUR** (18 klijenata) | **130.000 EUR** (60 klijenata) | **330.000 EUR** (150 klijenata) |
| **Prihod — bazno (procjena)** | **12.000 EUR** (12 klijenata, miks 10/2) | **97.000 EUR** (55 klijenata, 2 enterprise) | **313.000 EUR** (160, 8 enterprise) | **737.000 EUR** (350, 25 enterprise) |
| **Prihod — optimistično (procjena)** | **30.000 EUR** (1 agencija kao kanal + 25 klijenata) | **250.000 EUR** (120 klijenata, 8 enterprise) | **750.000 EUR** (320, 20 enterprise) | **1.900.000 EUR** (800, 60 enterprise, 30% iz A2A) |
| **Trošak modela (12% prihoda, procjena)** | 600–3.600 | 4.800–30.000 | 15.600–90.000 | 39.600–228.000 |
| **Infra (procjena)** | 600–1.800 | 1.800–7.200 | 6.000–16.800 | 12.000–30.000 |
| **Ljudi (procjena)** | 25.000–60.000 (1–2 osobe) | 72.000–168.000 (2–3) | 144.000–312.000 (4–7) | 288.000–576.000 (7–12) |
| **Pravno/sigurnost/ostalo (procjena)** | 3.000–15.000 | 5.000–20.000 | 10.000–35.000 | 15.000–60.000 |
| **Ukupan trošak (procjena)** | **29.000–80.000** | **84.000–225.000** | **176.000–374.000** | **355.000–894.000** |
| **Bruto marža po klijentu (cilj)** | **> 65%** | **> 70%** | **> 75%** | **> 78%** |
| **Marža na nivou firme (bazno)** | **negativna** (investiranje) | **negativna do nule** | **oko nule** | **+10 do +25%** |
| **ARR na kraju godine (bazno, procjena)** | **≈ 60.000 EUR** | **≈ 265.000 EUR** | **≈ 770.000 EUR** | **≈ 2.000.000–2.600.000 EUR** |

> **Kako se iz G4 prihoda dobija ARR:** 350 klijenata × mjesečni miks ARPU
> `(230×130 + 95×400 + 25×1.800) / 350 = (29.900 + 38.000 + 45.000) / 350 = 112.900 / 350 ≈ 322 EUR`
> → **112.900 EUR/mj. × 12 ≈ 1.355.000 EUR**. Uz **A2A proviziju** (procjena: 50.000 transakcija/mj. ×
> prosječno 3 EUR × 5% = **7.500 EUR/mj. = 90.000 EUR/god.**) i **setup/enterprise projekte**
> (procjena 60.000 EUR) bazni ARR izlazi **≈ 1,5–1,6 mio EUR**. Gornja granica **2,0–2,6 mio** pretpostavlja
> **povoljniji miks** (više Pro/Enterprise) i **40% prihoda iz kanala**; sve je **procjena**.

**Runway — formula, ne osjećaj:**

```
runway (mj.) = (cash + [IZNOS]) / (mjesečni trošak ljudi + infra + pravno + model)
```

- **Danas (1–2 osobe, minimalna infra):** mjesečni burn **(procjena) 1.500–3.500 EUR** → runway **6–12 mj.**
  bez prihoda. Ovo je **ključni broj za [IZNOS]**: tranša T1 mora pokriti **12 mjeseci ovog burn-a + rezervu
  3 mjeseca**, a to je **(procjena) 25.000–60.000 EUR** (uključuje honorarnog inženjera, advokata i model).
- **Poslije prve tranše (2–3 osobe):** burn **(procjena) 8.000–14.000 EUR/mj.** → **2–4 mj.** bez prihoda.
  Zato je **tranša 2 vezana na 3 plaćena klijenta**, a ne na protok vremena: jedini način da burn ne pojede
  kapital prije dokaza.
- **Godina 3–4:** burn raste sa ljudima (do **48.000–80.000 EUR/mj.** u G4), ali ga prihod pokriva; ako ne
  pokriva dva kvartala zaredom → **sječe se obim** (manje vertikala, manje enterprise custom posla), ne
  produžava runway.

### 7.3 Pravilo cijene: 3–4× trošak modela

> **Cijena usage-a = 3–4× očekivani trošak modela.**

Zašto ne 1,2×: uz trošak modela idu **retry-i i greške (+15%)**, **embedding i vektorska pretraga (+10%)**,
**support** (najveći skriveni trošak), **infrastruktura**, **naplata i devizni troškovi**, **rezerva za rast
cijena** i **neplaćanje** (`docs/09` §4). Ako je cijena 2× trošak modela — firma radi za dobrovoljce.
**Provjera u praksi:** trošak modela / prihod **< 15%** (cilj) — ako je **> 30% dva mjeseca zaredom**, to je
**kill-prag** (`docs/10` §5), a ne „optimizovaćemo kasnije".

> **Napomena specifična za v0.4:** evolucija i RSI **troše model** na eksperimente (svaki kandidat = eval run;
> `populationSize 6 × generations 3` = **18 eval runova po `evolve()` pozivu** u defaultu). Zato:
> (a) evolucija/RSI idu **van** kritičnog puta i po rasporedu (nedjeljno), ne u request putu;
> (b) trošak evolucije se **mjeri odvojeno** (`evolution_fitness`, `rsi_experiment_lift`, `GET /v1/usage`) i
> **ne** ulazi u cijenu klijentovog zahtjeva; (c) budžet roja (**2 USD/sat** u `config/swarm.json`) je
> **interna** granica, ne klijentova.

### 7.4 Dva scenarija koja moramo imati napisana unaprijed

**A) Cijene modela padnu 50% (dobre vijesti — i zamka).**

| Efekat | Naša reakcija |
|---|---|
| Trošak modela / prihod pada sa 12% na ~6% → marža raste | **Ne** spuštati cijenu svima. Pad cijene modela je **naša marža** ili **novi segment** (self-serve tier 29–49 EUR/mj. sa malim obimom) |
| Konkurencija spušta cijene jer im je trošak pao | Ne takmičiti se na cijeni nego na **izvršenim akcijama + izolaciji + izvještaju** (`docs/10` §2); sidro je **plata zaposlenog**, ne pretplata na chat |
| Fine-tune postaje jeftiniji | Ubrzavamo §2: **LoRA na jednom agentu** je isplativ eksperiment — ali i dalje kroz **eval kapiju** |
| Evolucija/RSI postaju jeftiniji po eksperimentu | **Više eksperimenata, ista kapija**: `minLift` (3%) i `minFitnessGain` (5%) se **ne** spuštaju zato što je run jeftin |
| Cijena po upitu postaje „ništa" | Vrijednost se **mora** mjeriti u ušteđenim satima i riješenim ticketima, ne u tokenima — inače nam cijena ide na nulu |

**B) Cijene modela porastu 3× (loše vijesti).**

| Efekat | Naša reakcija |
|---|---|
| Trošak modela / prihod skače sa 12% na **~36%** → marža pada ispod 70% | **Tvrde brave rade prvo:** `maxCostUsdRun`, dnevni/mjesečni budžet tenanta, per-agent budžet (D15), **satna kvota roja** (`maxCostPerHourUsd`) — run se **prekida**, ne pravi se gubitak |
| Heavy useri prave gubitak | Fair-use klauzula + overage (poruka 0,02–0,05 EUR, run 0,15–0,50 EUR — **procjena**) + detekcija anomalije (trošak > 3× prosjek 7 dana → privremeni limit) |
| **Evolucija/RSI troše 18× po ciklusu** i to sada boli 3× više | Prvo se **isključuje automatski raspored** (RSI/evolucija samo ručno), pa se smanjuje `populationSize`/`generations`, pa `maxCases` po evaluaciji — **kapija ostaje** |
| Ugovori sa fiksnom cijenom | U ugovoru **od starta**: pravo na korekciju cijene uz **30 dana** najave (`docs/10` §2) |
| Nužna optimizacija | Keš odgovora, kraći kontekst (top-k 3–5 umjesto 8), **manji model za rutiranje** (ruter ionako radi bez LLM-a kad može), fallback na jeftiniji provajder; **EU-only lokalni model** kao opcija |
| Ako ni to ne pomogne | **Kill-prag:** trošak modela > 40% prihoda dva mjeseca → **stop dok se cijena ili obim ne isprave** |

---

## 8. Tim i resursi

**Realnost danas:** **1–2 osobe** (vlasnik + po potrebi izvođač). Kapacitet **~30–35 h/nedjeljno** rada na
proizvodu, **bez** prodajnog tereta preko 20% vremena (`docs/19` §3.1). To znači da je **prodaja fiksni blok u
nedjelji** koji se ne pomjera — inače nema ni jednog plaćenog klijenta u ovom dokumentu.

**Dva trenutka koja se ne smiju promašiti (odgovor na „kad prvi put treba drugi inženjer i safety reviewer"):**

- **Drugi inženjer: pri potpisu 2. plaćenog klijenta (procjena: mj. 9–12).** Ne zato što je posao težak, nego
  zato što **jedna osoba ne može istovremeno držati klijenta i graditi**. Prvi znak da je vrijeme: **dvije
  nedjelje zaredom bez dana bez koda** ili **onboarding prvog klijenta > 3 dana našeg rada**.
- **Safety reviewer (eksterni, dio vremena): pri ulasku roja u produkciju (procjena: mj. 24–30), a najkasnije
  pri prvom A2A plaćanju.** Prvi znak: **prva lažna uzbuna koju nismo umjeli objasniti** ili **prvi incident
  koji je otvorio `safety.detect` a da ga nismo razumjeli**. Do tada: vlasnik + tehnički + pisani incident
  zapisi (i to je priznanje da smo u tom periodu **slabiji**, ne tvrdnja da nismo).

| Faza | Ko je potreban (rola) | Koliko ljudi | Mjesečni trošak (procjena) | Šta se može odložiti |
|---|---|---|---|---|
| **0–12 mj.** | Osnivač: **full-stack inženjer + prodaja** (ista osoba); honorarni izvođač po potrebi | **1–2** | **0–2.500 EUR** (honorar + alati/infra + model) | Dashboard „lijepa" verzija → 4 stranice; evolucija/RSI **van produkcije**; swarm samo u pilotu; marketplace; white-label |
| **12–24 mj.** | + **1 inženjer** (integracije, MCP, OAuth) + **0,5–1 FTE podrška/operacije** | **2–3** | **6.000–14.000 EUR** | K8s klaster ako Compose nosi 30 klijenata; SOC 2; DAO; voice; multi-region |
| **24–36 mj.** | + **1 inženjer (A2A/integracije)** + **0,5–1 FTE prodaja/marketing** + **eksterni safety savjetnik (dio vremena)** | **4–7** | **12.000–26.000 EUR** | Drugi pen-test; EU-only GPU obrada; org kao proizvod; cross-node iznad 3 noda |
| **36–48 mj.** | + **0,5–1 FTE DevOps/SRE** + **0,5–1 FTE data/ML** (eval, dataset, fine-tune) + **safety savjetnik redovno** | **7–12** | **24.000–48.000 EUR** | Prvi veliki klijent se **ne** juri aktivno; SOC 2 samo ako je plaćen; DAO samo ako ima uslov iz §5 |
| **Kontinuirano** | **Vanjski**: advokat (ugovor/DPA/agencije), pen-tester, knjigovođa, safety savjetnik | po potrebi | **500–3.000 EUR** po angažovanju (**procjena**, 2 ponude) | SOC 2 konsultant (skup) — **ne** prije plaćenog zahtjeva |

**Ono što 1–2 osobe NE MOGU (i to treba reći naglas, jer određuje tempo):**

| Ne može | Zašto | Kada |
|---|---|---|
| **Penetration test** | Traži nezavisnog izvođača; rezultat se ne može sam izdati | Prije prvog enterprise razgovora sa sigurnosnim zahtjevima |
| **DPA / ugovor / pravno mišljenje** | Advokat (GDPR, prekogranični prenos, odgovornost za AI izlaz) | **Prije** prvog plaćenog klijenta — nije „poslije" |
| **Safety review roja i RSI meta-nivoa** | Nezavisna provjera vlastitog nadzornog sloja — sam sebi ne možeš biti revizor, a to je upravo sloj koji sve ostalo drži | Prije nego roj/A2A uđu u produkciju (§8, gore) |
| **SOC 2 / ISO 27001** | Sertifikacijsko tijelo + period posmatranja + novac | Odvojen plaćen projekat kad postoji kupac |
| **24/7 support i on-call** | Jedna osoba ne može biti 24/7 | Ugovorom **ne** obećavati do 3+ klijenta ili do plaćene podrške |
| **Prodaja i razvoj istovremeno bez plana** | Kontekst se mijenja, oboje trpe | Fiksni prodajni blok u nedjelji |
| **Druga vertikala odjednom** | Fokus | Tek kad prva ima 2+ plaćena klijenta |

---

## 9. Safety board i governance firme

**Zašto board postoji (a ne „vlasnik odlučuje"):** v0.4 uvodi sistem koji **sam sebi predlaže izmjene** i
**roj koji se sam organizuje**. To su dvije klase rizika koje **ne može** provjeravati ista osoba koja ih je
napisala i koja ih prodaje. Board nije ukras — on je **jedina kapija** koja nije u kodu.

### 9.1 Ko sjedi

| Član | Ko | Zašto on | Prava |
|---|---|---|---|
| **Osnivač (vlasnik)** | Dejan Milošević | Odgovornost prema kupcu i zakonu; vlasnik rizika | Predlaže, odlučuje o komercijalnom; **nema** pravo ukinuti sigurnosnu granicu bez drugog člana |
| **Tehnički član** | Vodeći inženjer (danas osnivač; kasnije druga osoba) | Poznaje kod i operativu; piše incident zapise | Predlaže izuzeće, izvodi mjere; **ne** odlučuje sam o izuzeću |
| **Eksterni safety savjetnik** | Nezavisan (ugovor o angažovanju, **ne** zaposlen) | Nezavisna provjera nadzornog sloja; nema komercijalni interes | **Pravo veta na sigurnosna pitanja** (vidi 9.4), pravo uvida u audit i incidente |

**Kvorum:** board može zasjedati samo ako su prisutna **najmanje 2 od 3**, a **svaka** odluka o promjeni
granica (autonomija, RSI nivo, izolacija, kvote, novi A2A partner sa novcem) traži **najmanje 2 glasa** —
nikad jedan. Dok je savjetnik honoraran i nema ga na svakom sastanku, pravilo je: **odluka koja dira granice
čeka sljedeći sastanak sa savjetnikom** (bez izuzetka za „hitno").

### 9.2 Šta board OBAVEZNO pregleda (svaki mjesec)

| # | Tema | Izvor (u sistemu) | Šta board traži |
|---|---|---|---|
| 1 | **Incidenti** (swarm, sigurnost, izolacija) | `GET /v1/admin/swarm/incidents`, `nmq_tenant_mismatch_total` | za svaki: uzrok, da li je auto-akcija bila proporcionalna, da li je lažna uzbuna, šta se mijenja |
| 2 | **Izuzeci** (svaka akcija mimo politike) | `GET /v1/audit` (`decision: require_approval`, `deny`) | ko je odobrio, zašto, koliko je trajalo; izuzeci koji se ponavljaju → postaju pravilo ili se ukidaju |
| 3 | **Promjene granica** (autonomija, izolacija, kvote, budžeti) | `POST /v1/admin/autonomy`, `/v1/admin/swarm/governance/*`, audit | da li je promjena **uža** ili **šira**; šira traži obrazloženje + rok važenja |
| 4 | **RSI nivoi i meta-prijedlozi** | `GET /v1/admin/rsi`, `/v1/admin/proposals` (`source: rsi-meta`) | nivo (R1–R5), broj eksperimenata, **prosječan lift**, koji su prijedlozi primijenjeni i **šta je odbijeno** |
| 5 | **Novi partneri u A2A** (i svaki novi primalac novca) | `/a2a/negotiations`, `settlements_total` | reputacija, granice (`maxAmountUsd`, `requireHumanAboveUsd`), ko je pravno lice, ko plaća |
| 6 | **Eval trend po tenantu** | `GET /v1/admin/eval/history`, `nmq_eval_pass_rate` | ako tenant padne ispod praga → ne idu nove funkcije dok se ne popravi |
| 7 | **Trošak i marža** | `GET /v1/usage`, `nmq_cost_usd_total` | trošak modela / prihod; scenario „cijena 3×" je li i dalje izdržljiv |

### 9.3 Ritam

| Ritam | Šta se radi | Trajanje (procjena) |
|---|---|---|
| **Mjesečno** | Board sastanak sa **7 tačaka** iz 9.2 + **zapisnik** (odluke, glasovi, rok važenja izuzeća) | 60–90 min |
| **Kvartalno** | Javni **sigurnosni izvještaj** (§9.5) + pregled KPI tabele iz §11 sa **istim** brojevima kao investitoru | 2–3 h |
| **Odmah (vanredno)** | Svaki incident težine `high`, svaki freeze, svaka neobjašnjena lažna uzbuna, svaki spor sa A2A partnerom | u roku **72 h** se saziva sastanak ili se odluka **obustavlja** do sastanka |
| **Godišnje** | Obnova ugovora sa safety savjetnikom; ponovni pen-test (ako je plaćen); pregled „šta namjerno ne radimo" (§5) | 1 dan |

### 9.4 Kako se rješava sukob interesa (i zašto je veto na jednoj strani)

**Sukob je stvaran i ne treba ga glumiti:** osnivač ima interes da **isporuči i naplati**, savjetnik ima
interes da **ne propusti rizik**. Ako obojica imaju veto, board je blokiran; ako niko nema, board je ukras.

| Mehanizam | Kako radi |
|---|---|
| **Veto je samo na sigurnost** | Savjetnik može **zaustaviti** odluku koja **širi** granice (veća autonomija, viši RSI, blaža izolacija, viši limit novca, novi partner). **Ne može** blokirati komercijalnu odluku koja granice **sužava** — sužavanje je uvijek dozvoljeno |
| **Pisano obrazloženje u oba smjera** | Svaki veto i svako ukidanje veta ide u zapisnik **sa razlogom** i u audit; „osjećaj" nije razlog |
| **Rok važenja izuzeća** | Svako izuzeće (npr. „ovaj partner smije do 5.000 EUR bez čovjeka") ima **datum isteka** (max 90 dana) i automatski se vraća na default ako se ne obnovi |
| **Nezavisnost savjetnika** | Honorar **nije** vezan za broj odobrenih izuzeća; zabranjeno je da savjetnik istovremeno bude dobavljač ili da ima udio u firmi (ako dobije udio → imenuje se **drugi** savjetnik) |
| **Odvojeni interesi u zapisniku** | Pri svakoj odluci se u zapisnik upisuje **čiji interes** je pogođen (klijent / firma / treća strana) — to sprečava da se „naš rast" podvede pod „interes klijenta" |
| **Klijent ima svoj kill switch** | Klijent uvijek može izolovati svoj tenant (`locked`/`frozen`) i to ne traži naš pristanak — najjača zaštita od našeg sukoba interesa |

### 9.5 Šta se objavljuje javno (transparentnost bez odavanja klijenata)

**Objavljujemo:**

- **Klasu incidenata i ishod** (npr. „2 lažne uzbune detekcije koluzije, 0 stvarnih; pragovi podešeni") —
  **bez** imena klijenta, bez podataka, bez internih pragova koji bi se mogli zloupotrijebiti.
- **Promjene politike i granica** koje utiču na korisnike (npr. „od datuma X, A2A plaćanja iznad Y traže
  čovjeka") — kratko i unaprijed.
- **Šta NAMJERNO ne radimo** (§5) i **zašto je L4 plafon** (§5.1) — ovo je dio identiteta, ne tajna.
- **Godišnji sigurnosni pregled** u formi „tvrdnja → dokaz → gdje": šta imamo (hash-chained audit, izolacija,
  politike, freeze), a šta **nemamo** (SOC 2, pen-test, treća revizija) — bez uljepšavanja.

**Ne objavljujemo:**

- Imena klijenata, broj klijenata po vertikali, ugovorene cijene i ARPU po klijentu.
- Podatke klijenata, KB sadržaj, trace/audit zapise (osim **svog** tenanta i uz pisanu saglasnost).
- **Tačne** sigurnosne pragove i konfiguraciju (npr. `lockstepThreshold`, `concentrationThreshold`) — javno se
  objavljuje **proces** i **klasa** događaja, ne parametri koji bi omogućili izbjegavanje detekcije.
- Nijedan ključ, nijedan token, nijedan interni URL — nikad (`DECISIONS.md` §5).

---

## 10. Rizici (investitorski i safety pogled)

Vjerovatnoća i uticaj su **procjena**. „Rani signal" je **mjerljiv** — to je ono što se vidi **prije** nego
što problem postane sudbina.

| Rizik | Vjerovatnoća | Uticaj | Mitigacija | Rani signal |
|---|---|---|---|---|
| **Nema plaćenog klijenta** (sve ostalo je teorija) | **visoka** | **kritičan** | 30 ciljanih razgovora; **plaćen** pilot (500–1.500 EUR, procjena); odluka o nastavku na kraju **4. mjeseca** po brojevima; plan B napisan unaprijed | 0 potpisa poslije 8 razgovora; „rado bi, ali…" 2×; onboarding > 3 nedjelje |
| **Zavisnost od LLM provajdera** (cijena, uslovi, kvalitet preko noći) | **visoka** | **visok** | Multi-provider adapter (D6) + **jedan testiran** fallback; u ugovoru **ne** obećavati konkretan model; trošak po modelu se prati; `nmq_pricing_fallback_total` (D36) | `nmq_llm_calls_total` po modelu se ne mijenja; 429/5xx rastu; kvalitet pada poslije njihovog update-a |
| **Koluzija / incident u roju** (najnoviji rizik, specifičan za v0.4) | **srednja** | **kritičan** | Medijacija kao **jedini** kanal (peer poruke van `safety` ne postoje); detekcija lockstep-a, koordinisanog glasanja, koncentracije i covert kanala; **auto-contain** + quarantine + freeze; glasanje **savjetodavno** | `swarm_findings_total` raste bez objašnjenja; isti worker drži > 60% claim-ova; dva workera glasaju identično N rundi; poruke sa visokom entropijom |
| **Regulatorni (EU AI Act — rokovi)** | **srednja** | **visok** | **2.12.2026** transparentnost (Article 50) je **naš najbliži rok** i već ga dijelom imamo (widget pokazuje šta robot radi); Annex III visokorizične obaveze od **2.12.2027** — koristimo vrijeme da **HR proces ne uđe** u taj režim; uloge provider/deployer se razrješavaju sa advokatom prije prve HR-adjacent prodaje | Klijent/partner traži „AI compliance" dokument; promjena klasifikacije našeg use-case-a; klijent iz EU pita „gdje se obrađuju podaci" |
| **Reputacioni** (jedan loš klijent ili jedan incident sa imenom firme) | **srednja** | **visok** | Fair-use klauzula; pravo trenutne suspenzije tenanta; jasna lista „šta nikad" (`docs/26` §7); javno objavljivanje **klase** incidenta bez imena klijenta (§9.5) | Javna pritužba; klijent traži da se robot potpiše umjesto njega; bulk generisanje sadržaja |
| **Timski (key-man, 1–2 osobe)** | **visoka** | **visok** | Runbook za sve kritično; **break-glass** van servera; pristupi u DSH store-u; **ugovorom ne obećavati 24/7**; drugi inženjer pri 2. plaćenom klijentu (§8) | 3 nedjelje bez dana bez koda; klijent zove lično; „sve je u glavi" |
| **Komoditizacija** (ono što radimo kopira se za vikend) | **visoka** | **srednji** | Vrijednost **nije** prompt: to su **integracije, izolacija, politike, audit, eval, izvještaj i organizacija**; eval zlatni set nastaje iz **stvarnih** promašaja i ne kopira se | Neko objavi identičan „recept"; klijent pita „zašto ne bismo sami" |
| **Cijena tokena** (rast 3× ili kraj jeftinog režima) | **srednja** | **visok** | Tvrdi budžeti (D15) + satna kvota roja; keš; kraći kontekst; manji model za rutiranje; overage + fair-use; pravo na korekciju cijene uz 30 dana najave; **RSI/evolucija se prvo isključuju** (§7.4 B) | USD/upit raste 2 mjeseca; trošak modela / prihod > 15% → > 30% |
| **Prodajni ciklus je dug** (B2B 3–9 mj.) | **visoka** | **srednji** | Ciljati **odlučioca** odmah; mali **plaćen** pilot; više malih klijenata umjesto jednog velikog; agencije kao skraćeni put | Prosjek dana od razgovora do potpisa; broj „javljamo se sljedeće nedjelje" |
| **„Previše frontier, premalo prihoda"** (rizik koji sami sebi pravimo) | **visoka** | **kritičan** | **Pravilo faze 0–12:** nijedna nova sposobnost; v0.4 sloj **zamrznut za prodaju**; svaki RSI/evolucija/sarm sat mora imati vezu na KPI iz §11 ili se ne radi | Nedjelje bez razgovora sa klijentom; broj swarm/RSI commit-ova raste, plaćenih korisnika nema |
| **Cross-node roj: dupli claim / dupli novac** | **srednja** | **visok** | Distributed lock (TTL + owner token) + idempotencija po `taskId`; chaos test; **cross-node ide poslije Postgresa**, ne prije | Jedan zadatak izvršen dvaput; `settlements_total` veći od broja faktura |
| **Marketplace/kanal bez korisnika** | **srednja** | **srednji** | Marketplace kreće tek sa ≥ 20 klijenata; kanal se ne otvara dok prethodni **ne radi bez nas** | Prazna vitrina; agencija traži da mi radimo njen posao |
| **Investitor očekuje brže** (nesklad očekivanja) | **srednja** | **srednji** | Ovaj dokument: tranše vezane na **dokaze**, ne na vrijeme; kvartalni izvještaj sa **istim** KPI tabelama iz §11; eksplicitna lista neuspjeha u §0.4 | Pitanja koja nisu u §11; zahtjev za funkcijama van §1–§4 |

---

## 11. Kako mjerimo uspjeh

Sve vrijednosti su **ciljevi (procjena)**. „Izvješteno" znači: broj je iz sistema (`GET /v1/usage`,
`GET /metrics`, `GET /v1/admin/*`), a **ne** iz osjećaja. **Isti brojevi idu investitoru i safety board-u
svaki kvartal** — jedan izvor, dvije publike.

| KPI | Faza 0–12 mj. | Faza 12–24 mj. | Faza 24–36 mj. | Faza 36–48 mj. | Izvor u sistemu |
|---|---|---|---|---|---|
| **Prihod (ARR, procjena)** | 20.000–60.000 EUR | 150.000–300.000 EUR | 500.000–900.000 EUR | **2,0–2,6 mio EUR** | fakture + `GET /v1/usage` |
| **Plaćeni klijenti** | **3** | **30–60** | **120–200** | **300–400** | CRM |
| **Enterprise klijenti** | 0 | **≥ 3** | **≥ 10** | **≥ 25** | ugovori |
| **Bruto marža po klijentu** | **> 65%** | **> 70%** | **> 75%** | **> 78%** | prihod − (model + infra + support) |
| **% riješeno bez čovjeka** | **> 60%** | > 65% | > 70% | **> 75%** | runovi bez `approval` i bez `handoff` |
| **Eval prolaznost (zlatni set po tenantu)** | **≥ 80% (na pravom modelu)** | ≥ 85% | ≥ 88% | **≥ 90%** | `scripts/eval.mjs`, `nmq_eval_pass_rate` |
| **Incidenti (teški)** | **0** | **0** | **0** (svaki se objavljuje) | **0** | `swarm_incidents_total`, audit |
| **Churn (mjesečno)** | n/a (pilot) | < 5% (Starter) / < 3% (Pro) | < 4% / < 3% | **< 3% / < 2%** | otkazi / aktivni |
| **NPS** | n/a (3 klijenta) | **≥ 40** | ≥ 45 | **≥ 50** | anketa + feedback u widgetu |
| **% prihoda iz kanala** | 0 | 10–15% | **≥ 25%** | **≥ 40%** | CRM/atribucija |
| **A2A transakcije / mj.** | 0 | 0 (priprema) | **≥ 10.000** | ≥ 50.000 | `settlements_total`, `negotiations_total` |
| **Trošak modela / prihod** | < 15% | < 15% | < 15% | **< 12%** | `nmq_cost_usd_total` / prihod |
| **RSI/evolucija: % prijedloga primijenjenih** | n/a (ručno) | > 15% | > 20% | **> 30%** | `rsi_promotions_total`, `improvement_*` |
| **% prihvaćenih prijedloga koji prođu eval** | — | ≥ 50% | ≥ 55% | **≥ 60%** | `eval_runs_total` + audit |
| **Vrijeme od nalaza do popravke** | — | < 14 dana | < 10 dana | **< 5 dana** | ticket → deploy |
| **Automatske izmjene granica** | **0** | **0** | **0** | **0** | audit + testovi (nepromjenjivo) |

**Pravilo mjerenja (da KPI ne postane marketing):** svaki broj u ovoj tabeli mora imati **izvor u sistemu** i
**datum**. Ako broj nije mjerljiv — piše **„nije mjereno"**. Izmišljena ušteda se obije o glavu na drugom
sastanku (`docs/09` §7). **Posebno pravilo za v0.4:** brojevi iz mock LLM-a **ne idu** u ovu tabelu — mock je
za testove, ne za izvještaj.

---

## 12. Odluke koje tražimo

Šest odluka. Svaka ima **zašto sada** i **posljedicu ako se ne donese**.

| # | Odluka | Zašto sada | Posljedica ako se ne donese |
|---|---|---|---|
| **1** | **Fokus na JEDNU vertikalu u prvih 12 mjeseci** (preporuka: **e-commerce ops**, `docs/28` §2.1) i tvrdo odbijanje druge prije 2+ plaćena klijenta — **iako v0.4 sada tehnički podržava roj na više vertikala** | Bez fokusa robot je „univerzalan" i nigdje dovoljno dobar; roj na dvije vertikale istovremeno **udvostručuje** broj rubnih slučajeva za nadzor | Rasipanje; nijedna referenca; odgađanje prvog prihoda; incidenti koje ne stignemo analizirati |
| **2** | **Budžet za pen-test + pravni paket (DPA/ugovor) PRIJE prve enterprise prodaje** — **procjena 2.000–8.000 EUR** (2 ponude za svaku stavku); **i prije prvog A2A plaćanja** dodati pravni pregled toka novca | Enterprise ne prihvata bez DPA; pen-test je ulaznica u razgovor; A2A sa pravim novcem povlači KYC/AML/PDV i to se rješava **prije** prve transakcije | Enterprise razgovor propada u prvoj rundi; ili (gore) potpisujemo tvrdnje koje ne možemo dokazati |
| **3** | **x402 (mikroplaćanja): DA, ali tek u fazi 24–36 mj. i SAMO za iznose < 5 EUR**, sa dnevnim cap-om i allowlistom primalaca; **primarni tok je Stripe/SEPA** | Mikroplaćanja su jedini slučaj gdje je on-chain/agentični tok jeftiniji od kartice; za sve veće iznose je pravno i računovodstveno skuplji | Gubimo mikrotransakcioni kanal (npr. plaćanje po dokumentu) — **ili**, ako se pusti prerano, uvodimo odgovornost bez obima |
| **4** | **DAO pilot: NE** u ovih 48 mjeseci, **osim** ako se ispuni uslov: **≥ 3 eksterne strane** koje same traže zajedničko upravljanje, **plaćaju** ga i pravnik potvrdi da ne uvodimo dodatne obaveze; odluka se zapisuje sa brojevima | DAO rješava problem **zajedničkog vlasništva i glasanja**, a mi danas nemamo ni jednog eksternog vlasnika procesa; uvoditi ga „jer je moderno" je isti mamac kao blockchain u `docs/27` §6 | Trošimo nedjelje i pravnu sigurnost na strukturu koja ne rješava ni jedan klijentov problem — ili, obrnuto, propuštamo stvarnu potrebu ako se pojavi (zato uslov, ne „nikad") |
| **5** | **Prvi SFT/LoRA: DA, tek u fazi 12–24 mj., na JEDNOM agentu, van kritičnog puta, sa eval kapijom** — **procjena 50–500 EUR** po treningu (**tražiti ponudu**); **uslov:** reward model je prvo kalibrisan na ≥ 300 **ljudskih** ocjena (korelacija > 0,6) | Redoslijed je obavezan: **heuristički** reward danas vodi i evoluciju i RSI (`genome.fitness`); trenirati prije kalibracije znači učiti model na našoj pretpostavci | Ili gubimo kvalitet koji je moguć, ili (gore) trošimo nedjelje na trening koji optimizuje pogrešnu metu |
| **6** | **Tranše vezane na dokaze + tag `v0.4.0` tek poslije nezavisne revizije:** T1 = (3 plaćena klijenta, eval ≥ 80% **na pravom modelu**, > 60% bez čovjeka, 0 incidenata izolacije); T2 = (≥ 30 klijenata, marža > 70%, cross-node roj u pilotu, prvi SFT sa mjerenim liftom); T3 = (≥ 10.000 A2A transakcija/mj. sa **pravim** novcem, marketplace ≥ 5 template-a, 2 cross-node incidenta riješena bez štete) | Jedini način da i mi i investitor isto mjerimo uspjeh; sprječava „još jedan mjesec" bez dokaza; **v0.4 sloj je danas nekomitovan** i ne smije se prodavati kao gotov | Kapital se troši na aktivnost, ne na rezultat; gate postaje formalnost; klijent dobija funkciju koja nije revidirana |

**Dodatno, tražimo potvrdu dvije pretpostavke (ne odluku, nego saglasnost):**

(a) **prodajni ciklus od 3 mjeseca je realan** za naš segment (ako nije — mijenjamo segment, ne plan);
(b) **1–2 osobe su prihvatljiv rizik** uz ugovornu ogradu da **ne** obećavamo 24/7 i uz obavezu da **safety
savjetnik** ulazi najkasnije pri prvom A2A plaćanju (§8).

---

## Otvorena pitanja

1. **Koja je prva vertikala konačno** — e-commerce ops (naša preporuka), agencije (white-label, B2B2B) ili
   knjigovodstvo (protivciklično, viša cijena po satu)? Odluka mijenja **koje 3–4 integracije** gradimo prve
   i **koje zadatke roj uopšte dobija** u pilotu (§1).
2. **Do kog broja klijenata ostajemo na fajl-sistemu (JSONL)**, a od kojeg su Postgres + pgvector + Redis
   **obavezni** — i to ne zbog performansa, nego zbog **sigurnosti** (kvote roja i feromoni su danas u
   memoriji procesa, pa restart briše rate-limit)? Prag iz koda je > 20 tenanta ili > 100 MB po fajlu
   (`docs/10` §1), ali **incident u roju mijenja redoslijed** — šta je tada žrtva?
3. **Postoji li tvrdi plafon za „% prijedloga koje sistem smije sam primijeniti"** — i da li je to 0 (kako je
   danas: `autoPromote: false`, `autoMetaPromote: false`) ili neki mali broj za `kb`/`prompt` na jednom
   tenantu? Ovo direktno mijenja šta R5 uopšte smije predložiti (§4, §5.1).
4. **Ko je prvi A2A partner sa PRAVIM novcem** — postojeći klijent sa svojim agentom (jeftinije, sigurnije)
   ili agent-platforma sa tržišta (brže, nedokazano)? Ako u 6 mjeseci ne nađemo **2** partnera, **zamrzavamo
   A2A** i energija ide u marketplace i white-label (§3).
5. **Ima li safety savjetnik veto i na komercijalne odluke koje posredno šire granice** (npr. „primamo
   enterprise klijenta koji traži L4 za sve agente")? Bez tog odgovora §9.4 je nedorečen, a upravo taj slučaj
   je najvjerovatniji način da granice popuste pod pritiskom prihoda.
6. **Kako mjerimo da roj stvarno donosi vrijednost**, a ne samo aktivnost — kroz **% riješenih bez čovjeka**
   i **trošak po riješenom zadatku** (naša preporuka), ili kroz **propusnost (throughput)** i **vrijeme do
   odgovora**? Ako mjerimo pogrešnu stvar, roj će izgledati korisno dok marža pada — a to je greška koju
   otkrijemo tek na kraju kvartala.
