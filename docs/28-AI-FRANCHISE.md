# 28 — AI franšiza: od jednog robota do mreže vertikalnih agenata

> **Svrha:** ovaj dokument opisuje **poslovni model rasta** NMQ Robota: ne „prodati još jednog agenta",
> nego **jednom napraviti vertikalni template** (ciljevi, KPI, playbooks, agenti, politike, KB šablon, eval)
> i onda ga **uvođenjem samo konfigurisati** kod svakog novog klijenta. Franšiza ovdje **nije** pravni ugovor
> o franšizi — to je **interni naziv za gotov, ponovljiv paket po vertikali**.
>
> **Vezano za:** `docs/09-MONETIZACIJA.md` (paketi, pravilo cijene 3–4×, mjerenje uštede),
> `docs/27-ROADMAP-24-MESECA.md` (§4.1 tačka 5 — marketplace template-a, cilj „novi klijent < 3 dana"),
> `docs/10-RIZICI.md` (§3 pravilo „max 2 vertikale u MVP-u", §5 kill criteria),
> `docs/26-RIZICI-I-ETIKA.md` (šta se **nikad** ne automatizuje, etika u prodaji),
> `DECISIONS.md` (D14 — agenti su podaci, D20 — SaaS + self-hosted, D33 — override po tenantu).
>
> **Iskreno prije nego što se počne:** u repozitorijumu **danas ne postoji** ni `templates/`, ni `eval/`,
> ni `scripts/eval.mjs`, ni `scripts/report.mjs` (provjereno). Sve što u ovom dokumentu piše kao
> „template `<vertikala>/`" je **predlog strukture** koji tek treba napraviti. Model je ispravan i izvodljiv —
> ali **nijedan template još nije napravljen**, i to je prva stavka plana (§10).
>
> **Sve cijene su procjena** i imaju napisan **način provjere**. **Nikad** se ne upisuju vrijednosti ključeva.
> Verzija: 1.0 · Vlasnik: NMQ (Dejan Milošević PR).

---

## 0. Zašto franšiza, a ne „još jedan klijent"

| Problem kod custom uvođenja | Kako template to rješava |
|---|---|
| Svaki novi klijent = **mapiranje procesa od nule** (5–20 h našeg rada) | Proces je već snimljen u `playbook.md`; mijenja se **samo ono što je različito** (nazivi, rokovi, kanali) |
| Kvalitet zavisi od toga koliko smo tog dana pažljivi | Isti prompt, iste politike, isti eval zlatni set → **isti minimum kvaliteta** kod svakog klijenta |
| Ne znamo da li smo pogoršali nešto kod klijenta A dok popravljamo klijenta B | Izmjena ide u **template**, pa se **testira** zlatnim setom prije nego dođe do klijenata |
| Support raste linearno sa brojem klijenata | Ponavljajuće pitanje postaje **stavka u template-u** (KB članak, politika, watcher), ne novi ticket |
| Cijena nam pada jer klijent traži „samo malo drugačije" | Obim se prodaje kroz paket, a razlika se **konfiguriše** — ne razvija |

**Definicija uspjeha ovog modela:** „novi klijent na postojećem template-u za **< 1 dan** našeg rada"
(custom dio), dok je cilj iz `docs/27` §4.1 „< 3 dana" **ukupno** (uključujući klijentove sastanke i pristupe).
Ako je naš rad > 1 dan — template je loš, a ne klijent.

---

## 1. Model

**Template =** folder sa **podacima, ne kodom** (D14: novi agent je novi JSON). Uvođenje klijenta je
**konfiguracija + ingest**, a ne razvoj. Template se sastoji od:

| Element | Šta je u template-u | Šta ostaje zajedničko (jezgro, ne diramo po klijentu) | Šta je po klijentu |
|---|---|---|---|
| **Ciljevi** | Šablonski ciljevi sa mjerljivom metrikom (npr. „riješeno bez čovjeka > 65%", „vrijeme odgovora < 2 min") | `src/goals/manager.js` (dekompozicija, `progressPct`, `health`, replan, zakazivanje poslova) | Vrijednosti baseline/target/deadline i vlasnik cilja |
| **KPI** | Lista KPI-jeva po agentu (polje `kpi` u `config/agents/*.json`) + KPI po ulozi u org šemi (`config/company.json`) | Reward model (`src/learning/rewards.js`), metrike, trošak po runu | Pragovi (npr. „> 65%" vs „> 75%"), koji KPI je ugovoren |
| **Playbooks** | `playbook.md` — korak-po-korak proces koji čovjek danas radi (ulaz, odluka, izlaz, izuzeci) | Orchestration patterni, `patternConfig`, budžet po patternu | Izuzeci („kod nas se refund radi drugačije"), eskalaciona lista |
| **Agenti** | `agents/*.json` — koji agenti, `systemPrompt`, `tools`, `toolScopes`, `maxRisk`, `maxSteps`, `temperature`, `routingHints` | Katalog, ruter, kontrolna ravan (verzije/rollback) | Samo razlike u promptu (naziv firme, ton, rokovi) — **nikad nova logika** |
| **Politike** | `policies.json` — `allow`/`deny`/`requireApproval`, `risk`, `budget`, `rateLimitPerMin`, `businessHoursOnly`, `conditions` | `src/core/policy.js` (deny pobjeđuje, fail-closed) | Stroža pravila, iznosi limita, radno vrijeme, lista odobravatelja |
| **Watchers** | `watchers.json` — 3–5 proaktivnih pravila po vertikali (`metric`, `event`, `schedule`) | `src/goals/watchers.js` (cooldown, `maxPerDay`, `kind: propose|run`) | Metrike iz **njihovog** sistema, ko prima obavještenje |
| **Integracije** | `integrations.md` — koje 3–4 integracije vertikala stvarno koristi + mapiranje na MCP servere | `src/tools/mcp-*.js`, sandbox (allowlist, očišćen env), OAuth po tenantu | Njihovi nalozi, tokeni (u `secrets.enc.json`), mapiranje polja |
| **KB šablon** | `kb/` — struktura i **lista pitanja** na koja KB mora imati odgovor (politika povraćaja, dostava, garancija, reklamacije…) + 10–20 primjera dokumenata | RAG (brute-force cosine), chunking, `redactPii`, ingest ruta | Njihovi **stvarni** dokumenti (mi ih ne izmišljamo) |
| **Eval zlatni set** | `eval/golden.jsonl` — 30–50 pitanja sa očekivanim ishodom iz **te** vertikale | `scripts/eval.mjs` (kad postoji), regresioni test (> 5% pad = pad testa) | 20–30% pitanja iz **stvarnih** upita klijenta |
| **Politika autonomije** | `autonomy.json` — početni nivo (uvijek **L1**) i kriterijum za podizanje | `src/core/autonomy.js` (L0–L4, `HUMAN_ONLY`, `high` → čovjek uvijek) | Dozvoljeni nivo poslije pilota (L2 za dokazane agente) |
| **Acceptance test** | `onboarding/checklist.md` — 10–15 koraka koji se **odčekiraju** (ne „procijeni se") | Tenant store, ključevi, suspenzija, backup | Potpis klijenta na checklisti |

**Predložena struktura foldera (ne postoji — prva stvar u §10):**

```
templates/
  ecommerce-ops/
    template.json          ← manifest: verzija, vertikala, minimalna verzija robota, lista artefakata
    playbook.md            ← procesi (ko radi šta, koji su izuzeci)
    goals.json             ← šablonski ciljevi + KPI pragovi
    agents/                ← 3–6 agent JSON-a (kopije/izvedenice iz config/agents/)
    policies.json          ← allow/deny/requireApproval/budget za vertikalu
    watchers.json          ← 3–5 pravila
    autonomy.json          ← L1 start + kriterijum podizanja
    integrations.md        ← 3–4 integracije + mapiranje polja
    kb/                    ← skeleton + lista obaveznih pitanja + primjeri
    eval/golden.jsonl      ← 30–50 pitanja
    onboarding/checklist.md← koraci uvođenja sa trajanjem i vlasnikom
```

---

## 2. Četiri template-a (prvi talas)

> Redoslijed nije slučajan: prvo **e-commerce ops** (najveći volumen, najmanji pravni rizik, najbrža
> vidljivost — isto kao `docs/27` §12 odluka 1), pa **agency sales** (kanal B2B2B), pa **SaaS support**
> (najbolji odnos automatizacije i cijene), pa **manufacturing procurement** (najveća ušteda po transakciji,
> ali najduži prodajni ciklus — zato **posljednji**, i to tek uz postojećeg klijenta iz te branše).

### 2.1 E-commerce ops (prvi template, prvi prihod)

| | |
|---|---|
| **Procesi** | „Gdje je moja pošiljka", reklamacija, povraćaj, zamjena, pitanje o proizvodu/zalihi, potvrda narudžbine |
| **Ciljevi** | `riješeno bez čovjeka > 65%` · `vrijeme odgovora < 2 min` · `povraćaj bez greške > 95%` |
| **KPI** | % runova bez `approval` i bez `handoff`; p95 vrijeme odgovora; 👎 stopa < 15%; trošak/riješen zahtjev |
| **Agenti** | `ecommerce` (default pattern `agent`, `maxRisk: medium`, `maxSteps: 10`, `temperature: 0.2`), `support` (eskalacija), `router`, `critic` (za sporne reklamacije) |
| **Integracije** | Shopify **ili** WooCommerce (status narudžbine, refund), e-mail (odgovor u istom thread-u), Slack/notifikacija, opciono CRM |
| **Watchers** | „nova narudžbina" (`hook.shopify`, `kind: run`, `riskLevel: low`), „nagomilani ticketi" (`metric > 40`, `kind: propose`), „nagrada pala" (`reward < 0.45`, `minSamples: 5`) |
| **Tipični procesi (playbook)** | 1) prepoznaj tip upita → 2) provjeri status (`order_lookup`) → 3) ako je povraćaj: citiraj politiku (`memory_search`) → 4) odgovor sa rokom → 5) ako nema podatka: traži broj narudžbine (ne pogađaj) → 6) `email_send` **ide na odobrenje** |
| **Cijena (procjena)** | **Starter 99–149 EUR/mj.** (1 kanal, 1–2 agenta) · **Pro 349–599 EUR/mj.** (widget + email + CRM) · **setup 150–1.500 EUR** zavisno od paketa — **provjera:** naplaćeni pilot i 3 fakture; cijena = 3–4× stvarni trošak modela iz `GET /v1/usage` |
| **Zašto prvi** | Volumen je visok → vrijednost vidljiva u **7 dana**; nema pravnog rizika; integracije su poznate (Shopify/Woo/e-mail) |

### 2.2 Agency sales (kanal B2B2B — jedan klijent, više krajnjih klijenata)

| | |
|---|---|
| **Procesi** | Kvalifikacija upita, priprema ponude, follow-up sekvenca, izvještaj klijentu, onboarding projekta |
| **Ciljevi** | `kvalifikovanih leadova +X%` · `konverzija ponuda > 20%` · `sati ušteđeni po projektu > Y` |
| **KPI** | Broj pripremljenih ponuda/mj.; vrijeme od brief-a do nacrta ponude; % ponuda koje je agencija poslala **bez** dorade |
| **Agenti** | `sales` (L3 u `nmq`, ali kod agencije start **L1**), `researcher` (podaci o leadu), `creative` (nacrt sadržaja), `data` (mjesečni izvještaj), `router` |
| **Integracije** | CRM (HubSpot/Pipedrive: kontakt, deal, note), e-mail, kalendar (opciono), Notion/Docs za ponude |
| **Watchers** | „pipeline stagnira" (`metric: deals_stalled > N`), „nedjeljni pregled portfolija" (`schedule`, `everyMs: 604800000`), „cilj skrenuo" (`goal_status: off_track`) |
| **Tipični procesi** | 1) upit sa forme → 2) kvalifikacija (budžet, rok, obim) → 3) nacrt ponude iz šablona → 4) **čovjek pregleda i šalje** (`email_send` je `requireApproval`) → 5) zapis u CRM → 6) follow-up posao (scheduler) → 7) mjesečni izvještaj klijentu agencije |
| **Cijena (procjena)** | **Pro 349–599 EUR/mj.** po agenciji **+ 30% white-label** (`docs/09` §2) + po krajnjem klijentu dogovor; **setup 500–1.500 EUR** — **provjera:** 2 agencije × broj krajnjih klijenata; naplaćeno u prva 3 mjeseca |
| **Posebnost** | Agencija je **naš kanal**, ne konkurent: ona radi prvu liniju podrške i konfiguraciju, mi dajemo template + update. **Ugovor mora razriješiti ko je obrađivač prema krajnjem klijentu** (`docs/27` §4.3) |

### 2.3 SaaS support (najbolji odnos automatizacije i cijene)

| | |
|---|---|
| **Procesi** | Onboarding korisnika, „kako se radi X", bug report → ticket, naplata/pretplata pitanja, eskalacija na inženjera |
| **Ciljevi** | `prvi odgovor < 5 min` · `riješeno bez čovjeka > 60%` · `eskalacija samo kad treba < 25%` |
| **KPI** | % riješenih bez eskalacije; `nmq_run_duration_seconds` p95 < 8 s; trošak/riješen ticket < 0,02 USD (**procjena** — **provjeriti** kod provajdera) |
| **Agenti** | `support`, `dev` (bug triage → ticket sa koracima reprodukcije), `router`, `critic` |
| **Integracije** | Ticket sistem (Jira/Linear/GitHub Issues), Slack (notifikacija + Approve/Reject dugmad), KB/dokumentacija, e-mail |
| **Watchers** | „nagomilani ticketi" (`metric: support_tickets_open > 40`), „greške u alatima" (metrika iz `nmq_tool_errors_total`), „odobrenje čeka" (podsjetnik) |
| **Tipični procesi** | 1) upit → 2) `memory_search` po KB (obavezan citat) → 3) ako nema u KB: **reci „nemam u dokumentaciji"** i ponudi eskalaciju → 4) ako je bug: `ticket_create` sa koracima → 5) Slack notifikacija |
| **Cijena (procjena)** | **Pro 349–599 EUR/mj.** · **Enterprise 1.200–3.500+ EUR/mj.** (više timova, SSO, self-hosted) — **provjera:** `GET /v1/usage` × broj riješenih ticketa; poređenje sa platom jednog support čovjeka (`docs/09` §8) |
| **Zašto ovaj treći** | Tehnički klijent **sam zna mjeriti** — eval, latenciju i tačnost; najlakše dokazati vrijednost, ali je i najzahtjevniji po kvalitetu (greška je vidljiva) |

### 2.4 Manufacturing procurement (najveća ušteda, najduži ciklus)

| | |
|---|---|
| **Procesi** | Prikupljanje ponuda dobavljača, poređenje uslova, praćenje rokova isporuke, reklamacije prema dobavljaču, priprema narudžbenice |
| **Ciljevi** | `vrijeme do 3 ponude < 2 dana` · `ušteda po narudžbi > X%` · `kašnjenje isporuke detektovano prije roka > 90%` |
| **KPI** | Broj obrađenih RFQ/mj.; prosječna ušteda po narudžbi; % narudžbi bez ručne intervencije u pripremi |
| **Agenti** | `ops`, `finance` (uslovi plaćanja, marža), `researcher` (podaci o dobavljaču), `extractor` (čitanje ponuda iz PDF-a/e-maila), `router` |
| **Integracije** | ERP (SAP/odoo/ Pantheon — kroz MCP server), e-mail (ponude dobavljača), Excel/CSV razmjena, opciono A2A sa dobavljačkim agentom |
| **Watchers** | „rok isporuke se približava" (`schedule` + `metric`), „ponuda iznad limita" (eskalacija), „dobavljač ne odgovara 3 dana" |
| **Tipični procesi** | 1) zahtjev za nabavku → 2) RFQ poslan dobavljačima (`email_send` → **odobrenje**) → 3) `extractor` pročita ponude → 4) tabela poređenja (uslovi, rok, cijena) → 5) **čovjek bira** → 6) priprema narudžbenice (nacrt) |
| **Cijena (procjena)** | **Enterprise 1.200–3.500+ EUR/mj.**, setup **2.000–8.000 EUR**, self-hosted licenca **4.000–12.000 EUR/god.** ako ne smiju u cloud (`docs/09` §5) — **provjera:** jedna stvarna ušteda na narudžbi (uporedi cijenu prije/poslije) + faktura |
| **Iskreno o riziku** | ERP integracije su **teške i spore**, prodajni ciklus 3–9 mj., A2A sa dobavljačima je **nedokazan** (`docs/27` §4.3). Zato ovaj template **ne** ide u prvi talas razvoja — ide tek kad postoji klijent iz te branše koji **plaća** pilot |

---

## 3. Kako se template pravi (jednom, pa se prodaje)

> Pravilo: **template se ne pravi „za tržište", nego iz 3+ stvarna klijenta.** Ako nemamo 3 klijenta u
> vertikali, nemamo template nego pretpostavku — a pretpostavka se prodaje skupo.

| # | Korak | Šta konkretno radimo | Izlaz (artefakt) | Trajanje (procjena) |
|---|---|---|---|---|
| **1** | **Izaberi vertikalu sa 3+ klijenta** | Ne „e-commerce" nego **isti proces kod 3 firme** (npr. „povraćaj + status narudžbine u Shopify-ju") | Jedna rečenica: „template rješava X za Y" | 0 (odluka) |
| **2** | **Snimi procese u playbook** | Snimamo **kako čovjek danas radi** (ekran + razgovor), ne kako bismo mi voljeli; svaki izuzetak se zapisuje | `playbook.md` (5–15 strana) | 2–3 dana |
| **3** | **Definiši KPI i izvore mjerenja** | Za svaki KPI: **odakle** se mjeri (metrika/tabela/ručno) i **baseline** prije robota (`docs/09` §7: bez baseline-a nema tvrdnje) | `goals.json` + tabela „KPI → izvor → baseline" | 1 dan |
| **4** | **Napiši agente i watchere kao JSON** | Kopija postojećih `config/agents/*.json` + izmjena `systemPrompt`, `tools`, `routingHints`, `maxRisk`; watchers iz playbook izuzetaka | `agents/*.json`, `watchers.json`, `autonomy.json` | 2–4 dana |
| **5** | **Zgradi KB šablon** | Struktura foldera + **lista pitanja** na koja KB mora imati odgovor + 10–20 **anonimizovanih** primjera; ingest kroz `POST /v1/kb` | `kb/` + `onboarding/kb-checklist.md` | 2 dana |
| **6** | **Napravi eval zlatni set** | 30–50 pitanja sa očekivanim ishodom; 30% iz **stvarnih** upita, 20% ručno ocjenjeno (`docs/19` faza 1) | `eval/golden.jsonl` + izvještaj baseline | 2–3 dana |
| **7** | **Pakuj kao `templates/<vertikala>/`** | Manifest sa verzijom i **minimalnom verzijom robota**; sve iznad u jedan folder; `onboarding/checklist.md` | `templates/<vertikala>/` + `template.json` | 1 dan |
| **8** | **(novo, ne u planu 27) Verzionisanje template-a** | `templateVersion` u manifestu + audit zapis pri primjeni na tenant; izmjena template-a **ne smije** tiho promijeniti klijenta (D33: override po tenantu) | `template.json.version` + `template_applied` u auditu | 0,5 dana |

**Ukupno (procjena): 12–17 dana rada** za prvi template. **Provjera:** mjeri se stvarno; ako prvi template
traje > 20 dana, drugi se **ne počinje** dok se ne svede na < 10 (inače model nije ponovljiv).

### 3.1 Tabela artefakata po template-u (šta mora postojati da template „važi")

| Artefakt | e-commerce ops | agency sales | SaaS support | manufacturing procurement |
|---|---|---|---|---|
| `template.json` (manifest, verzija) | ✅ obavezno | ✅ | ✅ | ✅ |
| `playbook.md` | ✅ povraćaj/reklamacija | ✅ ponuda/follow-up | ✅ ticket/bug triage | ✅ RFQ → ponuda → narudžbenica |
| `goals.json` (3–5 ciljeva + KPI) | ✅ | ✅ | ✅ | ✅ |
| `agents/*.json` (3–6) | `ecommerce`, `support`, `router`, `critic` | `sales`, `researcher`, `creative`, `data`, `router` | `support`, `dev`, `router`, `critic` | `ops`, `finance`, `researcher`, `extractor`, `router` |
| `policies.json` (allow/deny/approval/budget) | ✅ `email_send` → approval | ✅ `email_send`, `crm_upsert` | ✅ Slack/Jira write | ✅ `invoice_create` uz `maxAmountUsd` |
| `watchers.json` (3–5 pravila) | ✅ | ✅ | ✅ | ✅ |
| `autonomy.json` (start L1) | ✅ | ✅ | ✅ | ✅ |
| `integrations.md` (3–4) | Shopify/Woo, e-mail, Slack, CRM | CRM, e-mail, Docs | Jira/Linear, Slack, KB, e-mail | ERP, e-mail, CSV, (A2A) |
| `kb/` + lista obaveznih pitanja | ✅ | ✅ | ✅ | ✅ |
| `eval/golden.jsonl` (30–50) | ✅ | ✅ | ✅ | ✅ |
| `onboarding/checklist.md` | ✅ | ✅ | ✅ | ✅ |
| **Ukupno (procjena)** | **9–13 dana** | **10–14 dana** | **10–15 dana** | **15–25 dana** (ERP) |

---

## 4. Uvođenje klijenta iz template-a (cilj: < 1 dan)

> **Cilj je < 1 dan NAŠEG rada** (custom dio). Ukupno trajanje (uključujući klijentove sastanke i pristupe)
> je realno **3–7 dana** — i to je poruka koju treba dati klijentu. Ako prodamo „gotovo za jedan dan",
> a treba sedmica za pristupe, izgubili smo povjerenje prvog dana.

| # | Korak | Šta se tačno radi | Trajanje (procjena) | Ko to radi |
|---|---|---|---|---|
| **0** | **Prije početka: uslovi** | Potpisan SOW + DPA; imenovan **odobravatelj** (`high` akcije) i **kontakt** za KB; dogovoreno radno vrijeme agenta (`businessHoursOnly`) | 1–3 dana (klijent) | Vlasnik + klijent |
| **1** | **Tenant** | Tenant u `config/tenants.json` (id, plan, `timezone`, `allowedAgents`, `hooks`) + `agentBudgets`; ključ: `node src/cli.js keys <tenantId> <role>` (**prikazuje se jednom**) | 15 min | Mi |
| **2** | **Ključevi i pristupi** | Integracije: OAuth/tokeni → `secrets.enc.json` (`AES-256-GCM`); `NMQ_HTTP_ALLOWLIST` za `http_fetch`; MCP serveri u `config/tools.json` (samo ono što klijent koristi) | 1–3 h | Mi + klijentov IT |
| **3** | **KB ingest** | Njihovi dokumenti kroz `POST /v1/kb`; provjera kroz `POST /v1/kb/search` da RAG vraća smislene chunkove; **prazna mjesta** se popunjavaju njihovim tekstom (ne našim izmišljotinama) | 2–4 h | Mi (klijent daje tekst) |
| **4** | **Politike i budžeti** | `policies.json` override za tenant: `allow`/`deny`/`requireApproval`, `risk`, `budget.runUsd/monthlyUsd`, `rateLimitPerMin`, `conditions` (npr. `invoice_create.maxAmountUsd`) | 30–60 min | Mi |
| **5** | **Autonomija L1** | `autonomy.json` → tenant na **L1** (`propose`); svaka akcija ide u inbox. **Ne** diramo na L2 dok ne prođe pilot | 15 min | Mi |
| **6** | **Eval na njihovim podacima** | `eval/golden.jsonl` dopunjen sa 20–30% **stvarnih** upita; mjeri se tačnost, citiranost, p95, USD/upit; **baseline prije uključenja** | 2–4 h | Mi |
| **7** | **Pilot nedjelja (L1 → mjerenje)** | 7 dana sa odobravanjem svake akcije; svaki 👎 se čita **istu nedjelju** (`docs/10` §5); dnevno 15 min pregleda | 7 dana (kalendarski), **~2 h našeg rada** | Mi + klijent |
| **8** | **Odluka o L2** | Kriterijum (**predlog**): ≥ 100 runova, 👎 < 15%, 0 incidenata, klijent koristi ≥ 70% očekivanog volumena → `POST /v1/admin/autonomy` na L2 za **taj** agent | 30 min | Mi (vlasnik odlučuje) |
| **9** | **Mjerenje i izvještaj** | Prvi mjesečni izvještaj (3 broja + trend + top 5 tema + odobrenja + trošak) — **robot ga generiše**, mi ga čitamo prije slanja | 1–2 h (prvi put) | Mi |

**Ukupno našeg rada (procjena): 8–16 h = 1–2 dana.** Cilj „< 1 dan" je dostižan kad su **koraci 3 i 6**
automatizovani (KB checklist + `scripts/eval.mjs`), a **ne** kad se radi ručno. **Provjera:** mjeriti sate
po klijentu (evidencija) prvih 5 uvođenja; ako je prosjek > 2 dana → template se popravlja, ne klijent.

**Šta se NIKAD ne radi u uvođenju:** ne izmišljamo klijentove politike; ne dajemo L2 „jer se klijentu žuri";
ne uključujemo više od 4 integracije (`docs/27` §2.1 tvrdo pravilo); ne obećavamo 24/7 (`docs/10` §3).

---

## 5. Naplata

**Tri linije prihoda** (isti model kao `docs/09` §3, ali vezan za template):

1. **Licenca / pretplata (mjesečno)** — pokriva platformu, template, update-e i podršku. **Fiksna i predvidiva.**
2. **Održavanje + self-improvement update-i** — nove verzije template-a, novi agenti/politike, eval set,
   sigurnosne zakrpe, kvartalni pregled kvaliteta. **Ovo je razlog da klijent ostane** (`docs/09` §5: prioritet
   je da klijent **želi** ostati zbog update-a, ne obmana).
3. **% od uštede / revenue-a** — varijabilni dio, vezan na **mjerljiv** rezultat, isključivo uz baseline
   i uz izvještaj koji robot **sam** generiše.

### 5.1 Tabela po paketu

| | **Starter** | **Pro** | **Pro + white-label (agencija)** | **Enterprise / self-hosted** |
|---|---|---|---|---|
| **Licenca / mj. (procjena)** | **99–149 EUR** | **349–599 EUR** | **+30% na Pro** (`docs/09` §2) | **1.200–3.500+ EUR** |
| **Šta ulazi** | 1 proces, 1 kanal, 1–2 agenta, mjesečni izvještaj | 5 agenata, 5 integracija, pune politike, human-in-the-loop | isto + pod-tenanti i brend agencije | neograničeno po config-u, SSO (planirano), opcija self-hosted |
| **Održavanje / update (procjena)** | uključeno (isti template, mjesečno) | uključeno + prioritetni fix | uključeno + 1 zajednički pregled/kvartal | **18–22% godišnje** od licencne cijene poslije prve godine (`docs/09` §5) |
| **% od uštede (procjena)** | **ne** (nema baseline-a → nema osnova za %) | **10–20%** prve godine, uz mjereni baseline | **10–15%** po krajnjem klijentu (agencija fakturiše dalje) | **5–15%** ili fiksni bonus po projektu (dogovor) |
| **Setup (jednokratno, procjena)** | 150–400 EUR | 500–1.500 EUR | 1.500–4.000 EUR (multi-tenant postavka) | 2.000–8.000 EUR (instalacija na njihovoj infra) |
| **Pilot (30 dana, procjena)** | 500–1.500 EUR (plaćen — `docs/09` §6) | isto | isto, po krajnjem klijentu | dio setup-a |
| **Vrijedi od** | 1. plaćenog klijenta | 2.–3. klijent | prva agencija | **ne** prije 6 mjeseci |

**Pravilo cijene (obavezujuće, iz `docs/09` §4 i `docs/27` §8.2):**

> **Cijena = 3–4× očekivani trošak modela.** Trošak modela / prihod **< 15%** (cilj);
> **> 30% dva mjeseca zaredom = kill-prag** — stop dok se cijena ili obim ne isprave.
> **Provjera:** `GET /v1/usage` (trošak po tenantu/agentu/modelu) ÷ prihod iz fakture, mjesečno.
> Ako je odnos iznad 15% — prvo se **sječe obim** (manje procesa, kraći kontekst, manji model za rutiranje),
> pa tek onda razgovor o cijeni (koji traži **30 dana najave**, `docs/10` §2).

### 5.2 Kako izmjeriti „% od uštede" (da ne postane izmišljotina)

1. **Baseline prije uključenja** (nedjelja 0): koliko upita/narudžbi/RFQ dnevno, prosječno vrijeme obrade,
   koliko sati troši osoba, koliko grešaka. **Bez baseline-a nema %** — u izvještaju piše „nije mjereno"
   (`docs/09` §7).
2. **Mjesečni izvještaj generiše robot** (planirano `scripts/report.mjs` — **ne postoji**, vidi §10):
   3 broja (riješeno bez čovjeka · ušteđeni sati · prosječno vrijeme odgovora), trend, top 5 tema,
   odobrenja (koliko `high` akcija je čovjek odobrio/odbio), stvarni trošak modela, **preporuka** za sljedeći korak.
3. **Formula uštede:** `ušteđeni sati = (broj runova × prosječno minuta po zadatku kod čovjeka) / 60`,
   gdje „prosječno minuta" dolazi iz **baseline-a**, ne iz naše procjene.
4. **Fakturisanje %:** fakturiše se **poslije** mjeseca u kojem je ušteda izmjerena, uz izvještaj kao prilog.
   Klijent ima pravo osporiti broj u roku 15 dana i mijenja se **ista** formula, ne „dogovor".
5. **Gornja granica:** % od uštede ima **cap** (procjena: ne više od 100% mjesečne licence) — da klijent
   nikad ne strahuje da će ga model „oderati" kad robot radi dobro.

---

## 6. Ekonomija na skali

**Pretpostavke za tabelu (sve procjena, sve se provjeravaju):**
ARPU **130 EUR** (Starter), **400 EUR** (Pro), **1.800 EUR** (Enterprise) — miks kao u `docs/27` §8.
Trošak modela **12% prihoda** (cilj < 15%, `docs/00` §6) — **provjera:** `GET /v1/usage`.
Trošak supporta **50 EUR/h** interne cijene (`docs/09` §4); onboarding se **naplaćuje** i time ne ulazi u maržu.

| | **10 klijenata** | **50 klijenata** | **200 klijenata** |
|---|---|---|---|
| **Miks (procjena)** | 6 Starter, 3 Pro, 1 Enterprise | 25 Starter, 20 Pro, 5 Enterprise | 80 Starter, 95 Pro, 25 Enterprise |
| **Prihod / mj. (procjena)** | 6×130 + 3×400 + 1×1.800 = **3.780 EUR** | 25×130 + 20×400 + 5×1.800 = **20.250 EUR** | 80×130 + 95×400 + 25×1.800 = **93.400 EUR** |
| **ARR (procjena)** | ≈ **45.000 EUR** | ≈ **243.000 EUR** | ≈ **1.120.000 EUR** |
| **Trošak modela (12%, procjena)** | ≈ 455 EUR | ≈ 2.430 EUR | ≈ 11.200 EUR |
| **Trošak infra (procjena)** | **50–150 EUR** (1 VPS + Postgres/Redis) | **300–800 EUR** (2–3 VPS ili mali K8s + monitoring) | **1.500–4.000 EUR** (klaster, replike, storage, backup) |
| **Trošak podrške (procjena)** | 10 × 0,5 h = 5 h → **250 EUR** | 50 × 0,35 h = 17,5 h → **875 EUR** | 200 × 0,25 h = 50 h → **2.500 EUR** + **1 FTE prve linije 1.500 EUR** |
| **Ljudi (procjena)** | 1–2 osobe (vlasnik + honorarac) | 2–3 osobe | 5–7 osoba (inž., podrška, prodaja, DevOps) |
| **Marža po klijentu (procjena, prije ljudi)** | **> 80%** (Starter realno 70–75%) | **> 75%** | **> 78%** (i tada je usko grlo **čovjek**, ne model) |
| **Šta postaje problem** | Plaćanje i pravni okvir (DPA), ne tehnologija | **Support minute** i **onboarding bez template-a** | **Integracije** (svaka nova je custom), **devizni/PDV** tok, **key-man** rizik |
| **Kako držati marginalni trošak niskim** | Template + KB checklist + self-service onboarding | + eval automatizacija (regresija pada test, ne čovjek) + „ponavljajuće pitanje = stavka u template-u" | + white-label (agencija radi prvu liniju) + self-hosted za enterprise (njihova infra) |

**Gdje marginalni trošak stvarno boli (iskreno):**

1. **Integracije** — svaka nova integracija je **razvoj** (OAuth, mapiranje polja, kvote), ne konfiguracija.
   Pravilo: **max 4 po template-u**; peta samo ako je **plati** klijent (`docs/27` §2.1).
2. **Onboarding bez template-a** — klijent van naše 4 vertikale pojede 5–20 h. Pravilo: van template-a se
   prodaje **samo kao Enterprise projekat** (`docs/10` §8: jedan klijent = 40% razvojnih sati).
3. **Support minute** — mjeriti po klijentu od prvog dana; ako ne padaju poslije 2 mjeseca, template je loš
   (`docs/10` §5 kill criteria).
4. **Naplata u regionu** — kartice (Paddle/Stripe preko EU entiteta), virman za Pro/Enterprise, PDV/reverse
   charge, devizni priliv (`docs/09` §9). **Provjeriti sa knjigovođom** prije prve fakture van zemlje.

---

## 7. Kanali

| Kanal | Prednost | Trošak akvizicije (procjena) | Ko prodaje | Kada uvodimo |
|---|---|---|---|---|
| **Direktno (mi)** | Kontrola nad kvalitetom i cijenom; najbolja povratna informacija za template | **visok**: 5–15 h prodaje po klijentu × 40–60 EUR/h = **200–900 EUR** po klijentu (**procjena**, mjeri se satima) | Vlasnik (fiksni prodajni blok u nedjelji, `docs/10` §5) | **odmah** |
| **Kroz agencije (white-label)** | Jedna prodaja = 5–30 krajnjih klijenata; agencija radi prvu liniju podrške | **nizak/srednji**: 10–20 h po agenciji jednokratno → **400–1.200 EUR**, dalje ~0 | Agencija (mi obučavamo) | poslije **1 referentnog klijenta** u vertikali; cilj: 2 agencije u fazi 12–18 mj. (`docs/27` §4) |
| **Vertikalni partneri** (npr. Shopify/Woo agencije, knjigovodstvene firme) | Dolaze sa **gotovom** bazom klijenata i razumiju proces | **srednji**: 20–40 h po partneru + revizija ugovora → **800–2.500 EUR** | Partner | poslije **3 plaćena klijenta** i napisanog `partner-playbook` |
| **Marketplace template-a** | Skalira bez nas; klijent/agencija sami aktivira | **nizak po transakciji**, ali **visok ulaz**: ≥ 5 template-a + self-service + podrška za self-service → **procjena 4–6 nedjelja razvoja** | Sam klijent | **tek kad ima ≥ 20 klijenata** (`docs/27` §4.3: „marketplace bez korisnika je prazna vitrina") |
| **Preporuka (postojeći klijent)** | Najjeftiniji i najkvalitetniji lead | ≈ **0** direktno; dajemo 1 mjesec popusta za uspješnu preporuku (**procjena**) | Klijent | od prvog zadovoljnog klijenta |

**Pravilo kanala:** kanal se ne otvara dok prethodni **ne radi bez nas**. Agency kanal prije nego što smo
sposobni napisati `partner-playbook` znači da ćemo raditi njihov posao umjesto svog.

---

## 8. Zaštita od kopiranja

**Šta je lako kopirati (i ne treba trošiti energiju na zaštitu):**

| Lako kopirati | Zašto |
|---|---|
| **Prompt** (`systemPrompt` u `config/agents/*.json`) | Jedan fajl; može se pročitati i prepisati. **Prompt nije proizvod** (`docs/27` §9 rizik „komoditizacija promptova") |
| **Lista alata i politika** | Struktura je logična i vidljiva iz dokumentacije |
| **Opšti „recept"** (ciljevi, watchers) | Copy-paste iz naših dokumenata — i to je **u redu**, jer nije ono što nosi vrijednost |
| **Ime i opis paketa** | Trivijalno |

**Šta je teško kopirati (i gdje je stvarna vrijednost):**

| Teško kopirati | Zašto |
|---|---|
| **Podaci klijenata + KB** | Nastaju kroz mjesece; tuđi KB nije prenosiv i nije „naš" da ga damo |
| **Eval zlatni set i izvještaji** | Nastaju iz **stvarnih** promašaja; kopija bez podataka je prazna; **eval je ono što se ne kopira** (`docs/27` §9) |
| **Self-improvement loop** | Prijedlog → odobrenje → primjena → **mjerenje efekta** → rollback, sa auditom; kopirati kod je moguće, kopirati **naviku mjerenja** nije |
| **Integracije** | OAuth po tenantu, mapiranje polja, kvote, greške — svaka je dani rada i **specifična za klijenta** |
| **Izolacija i dokazi** | Fizička izolacija po tenantu, hash-chained audit, politike, budžeti — godinama građen temelj (`docs/17`) |
| **Kontinuirani update-i** | Ono zbog čega klijent **ostaje** (`docs/09` §5) |

**Šta to znači za cijenu i ugovor:**

1. **Ne naplaćujemo prompt** — naplaćujemo **proces + izolaciju + dokaz + izvještaj + update**
   (`docs/09` §1, §8). Ako klijent kaže „ovo je samo prompt", odgovor je: „izvolite prompt —
   trebaju vam još politike, budžeti, audit, izolacija, integracije i mjerenje".
2. **Ugovor:** zabranjena redistribucija template-a i koda, podlicenciranje, korišćenje jedne licence na
   više instanci, objavljivanje bezbjednosnih nalaza bez roka (`docs/09` §5 lista), i **obaveza da se
   podaci i KB klijenta ne koriste za obuku** naših modela bez pisane saglasnosti.
3. **Self-hosted:** kod koji klijent ima na serveru **može** modifikovati — licenca je pravna i praktična
   prepreka, **ne** kriptografska (`docs/09` §5). Zato prioritet nije obfuskacija, nego da klijent **želi**
   ostati zbog update-a, eval-a i supporta.
4. **White-label:** agencija **ne smije** prodati template kao svoj proizvod; prodaje **uslugu** na njemu.
   To mora biti u ugovoru, jer je inače naš kanal naš konkurent.

---

## 9. Rizici franšize

| Rizik | Rani signal (mjerljiv) | Mitigacija |
|---|---|---|
| **Kvalitet varira po klijentu** (isti template, različit ishod) | Isti agent ima 👎 stopu 8% kod jednog, 40% kod drugog; eval rezultat po tenantu se razlikuje > 15% | Eval **po tenantu** (ne samo globalno); obavezan baseline i njegovo ponavljanje mjesečno; razlika > 15% pokreće reviziju KB-a (najčešći uzrok: loš KB, ne loš prompt) |
| **Kanibalizacija** (novi klijent u vertikali gdje već imamo 5 istih firmi) | Dva klijenta iz istog grada/nische traže **isključivost**; postojeći klijent sazna da imamo njegovog konkurenta | Ugovorom: **nema** ekskluzivnosti **osim** ako je plaćena (dodatak na licencu, **procjena +30–50%**); pošteno reći unaprijed, ne poslije |
| **Podrška eksplodira** | Support minute/klijent **ne padaju** poslije 2 mjeseca; isti problem kod 3 klijenta; > 5 ticketa/dan | „Ponavljajuće pitanje = nova stavka u template-u (KB/politika/watcher), ne novi ticket" (`docs/10` §2); mjesečna ocjena minuta; ako ne padaju → **obim se sječe** ili cijena raste |
| **Jedan loš klijent kvari reputaciju** | Klijent koristi robota za spam/bulk generisanje; javna pritužba; klijent traži „da se potpiše umjesto njega" | Fair-use klauzula (`docs/09` §9); jasna lista „šta nikad" (`docs/26` §7); pravo **trenutne suspenzije** tenanta (podaci ostaju); ugovorom zabranjeno korišćenje za obmanu potrošača |
| **Zavisnost od jedne vertikale** | > 80% prihoda iz e-commerce; sezona (novembar–januar) pravi ±40% oscilaciju | Najmanje **2 vertikale** u portfoliju, jedna protivciklična (knjigovodstvo/back-office je najjače januar–april, `docs/10` §8); pretplata nosi fiksni dio |
| **Zavisnost od jedne platforme** (npr. Shopify API promjena) | Integracija pukne nakon njihovog update-a; kvote se smanje | Pinovana verzija MCP servera + hash tool šeme (`docs/17` §6); **drugi** kanal u istom template-u (e-mail kao fallback); mjeri se `nmq_tool_errors_total` po alatu |
| **Template zastari** (vertikala se promijeni, mi ne) | Klijent sam traži izmjenu koja nije u template-u; eval set se ne mijenja 6 mjeseci | Kvartalni pregled template-a: 3 nova stvarna upita + 3 propusta u eval set; `template.json.version` se **mora** promijeniti ako se prompt/politika mijenja |
| **Preprodaja bez naše kontrole** (agencija prodaje pod svojim imenom i šuti o ograničenjima) | Krajnji klijent ne zna da razgovara sa AI; agencija obećava ono što robot ne smije | `partner-playbook` je **obavezan** dio ugovora: šta se smije reći, koje su ograde, šta ide u ugovor sa krajnjim klijentom (`docs/26` §9); pravo da prekinemo white-label ako se ograde ne poštuju |

---

## 10. Prvih 90 dana

**Cilj 90 dana (jedna rečenica): 1 template, 3 klijenta, mjerenje — pa drugi template.**
**Ne:** 4 template-a, 20 klijenata, marketplace. To je najsigurniji način da nijedan template ne bude dobar.

| Nedjelja | Šta radimo | Izlaz (dokaz) |
|---|---|---|
| **1–2** | **Izbor vertikale i snimanje procesa**: 3 razgovora sa firmama iz iste branše (e-commerce ops kao preporuka); snimamo **kako čovjek danas radi** | 1 izabrana vertikala + `playbook.md` (prva verzija) |
| **3** | **KPI + baseline + `goals.json`**: za svaki KPI izvor mjerenja; baseline **prije** uključenja kod prvog klijenta | Tabela „KPI → izvor → baseline" + `goals.json` |
| **4–5** | **Agenti, politike, watchers, autonomy kao JSON** (iz `config/agents/`); sve na **L1**; prvi tenant (`config/tenants.json` + `node src/cli.js keys`) | `templates/ecommerce-ops/{agents,policies.json,watchers.json,autonomy.json}` + tenant |
| **5–6** | **KB šablon + `checklist`** (lista pitanja na koja KB mora imati odgovor) + ingest prvog klijenta; provjera `POST /v1/kb/search` | `kb/` + `onboarding/kb-checklist.md` + 20–40 dokumenata prvog klijenta |
| **6–7** | **Eval zlatni set** (30–50 pitanja, 30% stvarnih) + **ručni** mjerni izvještaj (dok `scripts/eval.mjs` ne postoji) | `eval/golden.jsonl` + `eval/report-<datum>.md` (tačnost, citiranost, p95, USD/upit) |
| **7** | **Pilot 1 počinje (L1)**: 30 dana, plaćen, sa potpisanim „success criteria" i baseline-om | Potpisan SOW + DPA + prvi dan rada u auditu |
| **8–9** | **Pilot 2 i 3** (ista vertikala, isti template, **samo konfiguracija**) — ovo je **pravi test modela**: koliko sati po klijentu | Evidencija sati po uvođenju (cilj < 1 dan našeg rada) + 2 nova tenanta |
| **10** | **Prvi mjesečni izvještaj** za sva 3 klijenta (3 broja + trend + top 5 tema + odobrenja + trošak); 👎 lista → regresioni set | 3 izvještaja poslana; 👎 upisi u `eval/golden.jsonl` |
| **11** | **Odluka o L2** za agente koji su prošli kriterijum (§4 korak 8) + prvi `report` koji robot generiše (ručno ako skripta ne postoji) | `POST /v1/admin/autonomy` na L2 + zapis odluke |
| **12** | **Retrospektiva template-a**: šta je bilo custom kod svakog klijenta → ide u template; šta je ostalo custom → ide u cijenu. **Odluka:** drugi template (agencije) ili još 3 klijenta u prvoj vertikali | `templates/<v>/CHANGELOG.md` + odluka zapisana (datum, brojevi, ko je odlučio) |

**Kill/gate kriteriji za 90 dana (unaprijed napisani, da se ne odlučuje u afektu):**

| Signal | Odluka |
|---|---|
| 0 plaćenih klijenata poslije 8 razgovora | Mijenja se **vertikala**, ne template (ili se provjerava da li je problem u cijeni/obimu, `docs/10` §6 A1) |
| Onboarding > 3 dana našeg rada po klijentu | **Template se popravlja prije** nego se prodaje četvrti klijent |
| Support minute ne padaju poslije 2 mjeseca | Obim se sječe ili cijena raste (kill-prag `docs/10` §5) |
| Trošak modela > 40% prihoda dva mjeseca | **Stop** dok se cijena ili obim ne isprave (`docs/10` §5) |
| Eval tačnost < 80% sa citatom na zlatnom setu | Ne ide se u drugi template; prompt/KB se popravljaju (kapija iz `docs/27` §2.3) |

**Konkretno, prvi zadatak (dan 1):** napraviti `templates/` i `eval/` **strukturu** (prazne fajlove sa
manifestom i checklistom) — jer sve ostalo u ovom dokumentu zavisi od toga da ta dva foldera **postoje**.
To je posao od **2 sata** i odmah otkriva šta još ne postoji (`scripts/eval.mjs`, `scripts/report.mjs`).

---

## Otvorena pitanja

1. **Da li prvi template gradimo „iz glave" ili iz 3 stvarna klijenta?** Ovaj dokument tvrdi da bez 3 klijenta
   template nije template — ali to znači 2–4 mjeseca samo prikupljanja, prije nego što imamo šta da prodamo
   ponovljivo. Da li je prihvatljivo napraviti „v0.5 template" iz **jednog** klijenta i popravljati ga u hodu?
2. **Gdje živi template** — u istom repozitorijumu (`templates/`) ili u odvojenom repou? Ako je u istom,
   self-hosted klijent dobija **sve** naše template-e (to je lako kopirati, §8); ako je odvojeno, imamo dva
   mjesta istine i teže testiranje. Koja je odluka i zašto?
3. **Da li naplaćujemo „% od uštede" uopšte**, i ako da — kako klijent vjeruje broju koji **naš** robot
   generiše (§5.2)? Da li uvesti nezavisnu provjeru (klijentov knjigovođa potpisuje baseline i mjerenje)
   kao uslov za taj model naplate — ili ostati samo na pretplati i ne ulaziti u mjerenje tuđe uštede?
4. **Koliko vertikala smije biti aktivno istovremeno?** `docs/10` §3 kaže „max 2 u MVP-u", `docs/27` §3 kaže
   „2 vertikale, 10–20 klijenata", a `docs/27` §4 cilja **5+ template-a** do 18. mjeseca. Koji je tvrdi broj
   u jednom trenutku — i šta se gasi ako se pređe?
5. **Da li white-label agencija smije sama mijenjati prompt i politike** (i time „naš" template učiniti
   drugačijim), ili dobija **samo konfiguraciju** (nazivi, rokovi, KB)? Prvo skida support sa nas ali razbija
   garantovan kvalitet; drugo čuva kvalitet ali agencija nije „svoja".
6. **Kada (i da li) uvodimo pravo na ekskluzivnost po vertikali/teritoriji** za agenciju ili klijenta —
   i po kojoj cijeni? Bez te odluke prvi veliki klijent može tražiti ekskluzivnost koju smo već dali drugome,
   a to je ugovorni incident, ne pregovor.
