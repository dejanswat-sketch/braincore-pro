# 09 — Monetizacija i pakovanje

> Vezano za `docs/DECISIONS.md` v1.0 — model prodaje je **SaaS (multi-tenant) + self-hosted enterprise
> licenca** (D20), naplata se oslanja na `cost tracker` po tenantu (D16) i politike/budžete (D15).
> **Sve cijene u ovom dokumentu su procjena**, ne cjenovnik. Nijedna cijena modela nije navedena kao
> činjenica — **provjeriti kod providera** prije nego se uđe u obavezu prema klijentu.

---

## 1. Pozicioniranje

**U jednoj rečenici:** NMQ Robot je AI agent koji se ugrađuje u firmin sajt i interne procese,
**sam izvršava posao** (kreira task, odgovara kupcu, piše u CRM, pravi ponudu i izvještaj) — pod
politikama, budžetom i audit tragom, sa **potpunom izolacijom podataka po klijentu**.

**Za koga:**
- **Male i srednje firme u regionu** (5–100 zaposlenih): e-commerce, servisi, knjigovodstvo, agencije,
  pravne i konsultantske firme, klinike, nekretnine. Karakteristika: **nemaju IT tim**, imaju ponavljajući
  administrativni posao i nemaju vremena za „AI projekat".
- **Agencije** (marketing, web, SEO, knjigovodstvene): traže **white-label** alat koji mogu prodati
  svojim klijentima i na njemu imati maržu. Ovo je najbrži kanal — jedna agencija = 5–30 krajnjih klijenata.
- **Sekundarno:** firme sa 100+ zaposlenih koje traže **self-hosted** zbog internih politika.

**Zašto nije „još jedan ChatGPT wrapper" — tri konkretne razlike:**

| # | Razlika | Šta to znači u praksi (dokaz) | Gdje u kodu |
|---|---|---|---|
| 1 | **Radi akcije, ne samo odgovara** | Robot kreira task, šalje mejl, upisuje u CRM, pravi ponudu/invoice draft, generiše izvještaj. Svaka akcija je *tool call* sa `riskLevel`, a `high` rizik čeka ljudsko odobrenje | `src/tools/registry.js`, `src/core/policy.js`, `/v1/approvals/:runId` |
| 2 | **Izolovan po tenantu** | `tenant_id` je obavezan parametar svake operacije; fizički odvojeni folderi + RLS u Postgresu; testovi izolacije u CI. Klijent A **ne može** doći do podataka klijenta B ni kroz bug | `src/tenancy/store.js`, `tests/tenant-isolation.test.mjs` |
| 3 | **Mjerljiv trošak i mjerljiv rezultat** | Svaki run nosi `tenantId + agentId + model + tokens + cost`; izvještaj po klijentu je automatski, a ne „vjerujte nam". Trošak je vidljiv **prije** nego što faktura iznenadi | `src/observability/cost.js`, `/metrics`, mjesečni report |

Dodatna razlika koju treba prodavati, ali **ne** kao prvu: **mjesto gdje podaci žive** (Hetzner Finska = EU),
**bez build koraka i bez npm zavisnosti** (D2) → brz deploy i mali supply-chain rizik, i
**provider-agnostičnost** (DeepSeek/OpenAI/Groq/OpenRouter/Ollama/vLLM) → nema lock-in-a.

**Šta robot NIJE (iskreno, da se ne obeća pogrešno):** nije „AI koji vodi firmu", nije zamjena za ERP,
nije 100% tačan u pravnoj/medicinskoj domeni bez čovjeka, i nije enterprise spreman za SOC 2 danas (vidi `08`, §8).

---

## 2. Tri paketa

> Cijene su **mjesečne, u EUR, bez PDV-a**, raspon = procjena za tržište Srbija/BiH/CG/Hrvatska.
> Model naplate: **pretplata (platforma) + usage (tokeni/runovi) + jednokratni setup** — vidi §3.

| | **Starter** | **Pro** | **Enterprise** |
|---|---|---|---|
| **Cijena / mjesec (procjena)** | **99–149 EUR** | **349–599 EUR** | **1.200–3.500+ EUR** |
| Za koga | 1 proces, 1 kanal, test vrijednosti | firma koja robot koristi svakodnevno | više timova / self-hosted / compliance |
| **Agenti** | 1–2 | 5 | neograničeno (definisano config-om) |
| **Integracije** | 1 (npr. samo web widget **ili** samo email) | 5 | neograničeno + MCP serveri po dogovoru |
| **Poruke / runovi** | 1.000 poruka/mj. **ili** 300 runova | 10.000 poruka **ili** 3.000 runova | po dogovoru (pool + fair-use) |
| **Memorija** | sesija (30 dana) | sesija + long-term (12 mj.) + vektorska | sve + custom retencija |
| **Model** | jeftiniji model (npr. DeepSeek) | izbor modela po agentu | izbor + privatni/EU model |
| **Politike i odobrenja** | osnovne (allow/deny) | pune + human-in-the-loop za `high` | pune + custom politike po procesu |
| **Audit i izvještaji** | mjesečni PDF/CSV izvještaj | + cost po agentu/kanalu | + export audit chain-a, ROPA paket |
| **SLA** | best-effort (bez SLA) | 99,5% (procjena) | 99,9% (procjena), + RTO/RPO iz `08` §10 |
| **Support** | email, ≤ 48 h | email + prioritet, ≤ 8 h radnim danom | + telefon/kanal, ≤ 4 h, imenovani kontakt |
| **Onboarding** | self-serve + 1 sesija (1 h) | 3–5 dana, mapiranje 2 procesa | 2–6 nedjelja, 3–5 procesa, obuka tima |
| **Self-hosted (Docker)** | ❌ | ❌ | ✅ (posebna licenca, §5) |
| **Namjenski tenant izolovan** | deljeni VPS | deljeni VPS (izolovan namespace) | opcija: namjenski VPS/instance |
| **White-label (agencije)** | ❌ | ⚠️ opciono (+30% na cijenu) | ✅ uključeno |
| **Godišnja uplata** | −10% | −15% | −15 do −20% |

**Pravila pakovanja:**
- **Setup je obavezan i naplaćuje se posebno** (Starter 150–400 EUR, Pro 500–1.500 EUR,
  Enterprise 2.000–8.000 EUR — **procjena**). Setup nije „naplata za ništa": to je mapiranje procesa,
  integracije, test na njihovim podacima i obuka. On takođe **filtrira klijente koji neće platiti**.
- Ne prodavati Starter ispod 99 EUR/mj.: ispod toga support pojede maržu (vidi §4).
- **Ne prodavati „neograničeno"** — vidi §8 i §9.
- Enterprise cijena se **nikad** ne fiksira bez procjene mjesečnog troška modela (§4, pravilo 3–4x).

---

## 3. Model naplate

Tri komponente, svaka sa jasnim razlogom:

1. **Pretplata (platforma)** — pokriva infrastrukturu, razvoj, support, monitoring. Fiksna, predvidiva.
2. **Usage (tokeni/runovi)** — pokriva varijabilni trošak LLM-a. Mjeri se iz `cost tracker`-a (D16),
   **naplaćuje sa maržom 3–4x** nad stvarnim troškom modela (vidi §4).
3. **Setup (jednokratno)** — mapiranje procesa, integracije, onboarding. Nije pretplata, nije usage.

**Kako se mjeri usage (tehnički, već u ugovoru):** `usage = { inputTokens, outputTokens, cachedTokens? }`
po runu, sa `tenantId + agentId + model`; cijena po modelu je **tabela u config-u** koju ažuriramo ručno
(**provjeriti kod providera** — cijene se mijenjaju i ne smiju biti hardkodovane kao istina).

### Primjer tri fakture (mjesec dana, **procjena**)

| | **A) Mali shop** (Starter) | **B) Agencija** (Pro white-label) | **C) Firma sa 30 zaposlenih** (Pro/Enterprise) |
|---|---|---|---|
| Kanali | web widget + email | 4 klijenta, widget + email svakome | widget, email, CRM, interno (taskovi, izvještaji) |
| Poruka / runova | 1.800 poruka / 400 runova | 12.000 poruka / 3.500 runova | 6.000 poruka / 1.200 runova (duži, „teži" runovi) |
| Pretplata | 129 EUR | 499 EUR (+150 EUR white-label) | 899 EUR |
| Setup (amortizovan 1/12 od 900 EUR) | 75 EUR | 125 EUR (od 1.500 EUR) | 250 EUR (od 3.000 EUR) |
| Uključeni usage | 1.000 poruka / 300 runova | 10.000 / 3.000 | 5.000 / 1.000 |
| Prekoračenje | 500 poruka → 0,03 EUR/poruka = 15 EUR | 2.000 poruka → 0,02 EUR = 40 EUR | 1.000 poruka → 0,02 EUR = 20 EUR |
| **Faktura ukupno (procjena)** | **≈ 219 EUR** | **≈ 814 EUR** | **≈ 1.169 EUR** |
| Stvarni trošak modela (procjena) | ≈ 12 EUR | ≈ 55 EUR | ≈ 90 EUR |
| **Bruto marža (procjena)** | ≈ 87% | ≈ 78% | ≈ 78% |

**Napomena:** brojevi troška modela su **pretpostavka za model srednje klase**; za reasoning modele sa
dugim kontekstom trošak može biti 3–10x veći. Zato je **budžet po tenantu tvrd limit** (D15) —
kad se probije, run se prekida, ne pravi se gubitak.

**Overage cijene (procjena):** poruka 0,02–0,05 EUR · run 0,15–0,50 EUR · dodatni agent 20–50 EUR/mj.
Overage je **uvijek skuplji od uključenog** (to je signal da paket treba veći), ali nikad kazneni
(klijent ne smije strahovati da će ga „oderati" zbog jednog skoka).

---

## 4. Jedinična ekonomija (unit economics)

Ciljna marža: **> 70% bruto po klijentu**, a pravilo za cijenu usage-a:

> ### **Pravilo: cijena usage-a = 3–4x očekivani trošak modela.**

Zašto 3–4x, a ne 1,2x: trošak modela nije jedini varijabilni trošak. Uz njega idu **retry-i i greške**
(procjena +15%), **embedding i vektorska pretraga** (procjena +10%), **support** (najveći skriveni trošak),
**infrastruktura**, **naplata i devizni troškovi**, **rezerva za rast cijena** i **neplaćanje**.
Ako je cijena 2x trošak modela — firma radi za dobrovoljce.

| Klijent (tip) | Prihod/mj. (**procjena**) | Trošak LLM-a | Trošak infra (alokacija) | Trošak supporta | **Marža** |
|---|---|---|---|---|---|
| Starter, mali shop | 129 EUR | 12 EUR | 6 EUR | 15 EUR (0,3 h × 50) | **≈ 74%** |
| Pro, agencija (4 klijenta) | 649 EUR | 55 EUR | 15 EUR | 60 EUR (1,2 h × 50) | **≈ 80%** |
| Pro, firma 30 ljudi | 899 EUR | 90 EUR | 15 EUR | 45 EUR (0,9 h × 50) | **≈ 83%** |
| Enterprise, self-hosted | 1.800 EUR (pretplata+support) | 0 EUR (klijent plaća svoj model) | ≈ 0 EUR | 120 EUR | **≈ 93%** |
| Heavy user bez limita (rizik) | 129 EUR | 300 EUR | 10 EUR | 40 EUR | **≈ −170%** ← zato fair-use |
| Onboarding mjesec (Starter) | 129 + 400 setup | 25 EUR | 6 EUR | 250 EUR (5 h) | **≈ 50%** (prvi mjesec) |

**Referentne cijene rada:** interna cijena sata **procjena 40–60 EUR** (ukalkulisano u support).
Support se **mora** mjeriti po klijentu (minute u ticket sistemu) — inače marža u tabeli iznad je fikcija.

**Hetzner VPS od ~50 EUR — koliko klijenata pokriva (procjena):**

| Paket | Prihod/klijent | Bruto marža po klijentu | Klijenata za pokrivanje 50 EUR VPS-a |
|---|---|---|---|
| Starter | 129 EUR | ≈ 95 EUR | **1 klijent** (jedan Starter plaća VPS i ostaje viška) |
| Pro | 499 EUR | ≈ 350 EUR | **1 klijent** pokriva VPS ~7x |
| Enterprise | 1.200+ EUR | ≈ 1.100 EUR | **1 klijent** pokriva VPS i cijeli support mjeseca |

Dakle: **VPS nije problem** (jedan Starter ga pokriva). Problem su **support, razvoj i akvizicija**.
**Break-even za jednu osobu (procjena):** da bi „plata + troškovi" bili pokriveni (procjena
2.500–4.000 EUR/mj. bruto troška za firmu), potrebno je **oko 8–12 Starter** klijenata **ili
4–6 Pro** klijenata **ili 2–3 Enterprise** — uz uslov da support ne eksplodira.

**Ključna metrika koju treba pratiti od prvog dana:**
- **CAC** (trošak akvizicije) — koliko sati prodaje po klijentu × cijena sata.
- **Payback period** — koliko mjeseci da se CAC vrati (cilj **< 3 mj.**; ako je > 6, model je slab).
- **Churn** — mjesečni odliv (cilj **< 3%**; Starter će realno imati 5–8%).
- **NRR** — rast prihoda kod postojećih (cilj > 100% kroz prelazak na veći paket).
- **Support minute po klijentu** — ako rastu linearno sa brojem klijenata, biznis ne skalira.
- **Trošak modela / prihod** — cilj **< 15%**; ako je > 30%, paket je pogrešno dimenzionisan.

---

## 5. Self-hosted enterprise licenca

Za klijente koji **ne mogu** podatke staviti kod nas (banke, zdravstvo, državne firme, firme sa
ISO/SOC obavezama, ili jednostavno „naš IT to ne dozvoljava").

**Šta ulazi:**
- Izvorni kod (ili minifikovani/dist bundle — **odluka**, vidi otvorena pitanja) + `Dockerfile` + `docker-compose.yml`.
- `systemd` unit + uputstvo za deploy (`infra/deploy-*.md`) + Cloudflare tunel kao opcija.
- **1 godina update-a**: nove verzije, sigurnosne zakrpe, novi agenti i alati (config fajlovi).
- **1 godina email support-a** (≤ 8 h radnim danom) + uključenih **8 h konsaltinga** (instalacija, integracije).
- Dokumentacija (ova `docs/` + DECISIONS.md) i **jedan** onboarding sastanak sa timom.
- Dozvola: **jedna produkcijska instanca**, jedan pravni subjekt; dodatne instance po dogovoru.

**Cijena (procjena):**

| Varijanta | Cijena (procjena) |
|---|---|
| Licenca (1 god. update + support), 1 instanca | **4.000–12.000 EUR / godina** |
| Setup + instalacija na njihovoj infrastrukturi | **2.000–6.000 EUR** jednokratno |
| Dodatna instanca (npr. test + produkcija) | +25–40% |
| Produženje update/support poslije 1. godine | 18–22% od licencne cijene godišnje |
| Custom razvoj (nova integracija, MCP server) | 80–120 EUR/h (**procjena**) |
| Enterprise SaaS (bez self-host) | 1.200–3.500 EUR/mj. |

**Šta je zabranjeno (ugovor + tehnička mjera):**
- **Redistribucija** koda ili bundle-a kao svog proizvoda; prodaja dalje; podlicenciranje.
- Uklanjanje/zaobilaženje licencne provjere, telemetrije i copyright oznaka.
- Korišćenje **jedne** licence na **više** instanci/klijenata (agencija ne smije kupiti jednu i prodati 10x).
- Korišćenje za obuku sopstvenog modela na našem kodu.
- Objavljivanje bezbjednosnih nalaza bez dogovorenog roka (koordinisano otkrivanje — 90 dana).

**Kako se tehnički štiti (i koliko je to stvarno):**
- **Licencni ključ** u `config/license.json`: potpisan (Ed25519) sadržaj
  `{ tenantName, instanceId, issuedAt, expiresAt, features[], maxInstances }`; aplikacija
  verifikuje **javnim ključem** ugrađenim u kod → offline, bez „telefoniranja kući".
- **Instance binding:** `instanceId = hash(machine-id + hostname)`; ako se promijeni → grace period
  (30 dana) + upozorenje, pa ograničenje na `read-only` (nikad naglo gašenje — klijent ne smije ostati bez sistema).
- **Telefonska/online verifikacija opciono** za enterprise: jednom mjesečno `POST /license/verify`
  (samo `instanceId` + verzija + broj runova — **bez podataka klijenta**). Isključivo uz pisanu saglasnost.
- **Expiry:** poslije isteka licence — upozorenja 60/30/7 dana, pa prelazak u `read-only` mod
  (postojeći podaci ostaju dostupni — podaci su klijentovi, ne naši).
- **Iskreno o granicama:** kod koji klijent ima na svom serveru se **može** modifikovati.
  Licenca je pravna + praktična prepreka (niko ne želi tužbu i nema update-a), **ne** kriptografska.
  Zato: obfuskacija **nije** prioritet; prioritet je da klijent **želi** ostati zbog update-a i support-a.

---

## 6. Go-to-market u 90 dana

Cilj 90 dana: **3 plaćena pilota** i **1 case study sa brojevima**. Ne: 50 klijenata.

**Tri prve vertikale (izabrane po kriterijumu: mjerljiv volumen, jasan proces, dostupni odlučioci):**
1. **E-commerce support** (Shopify/WooCommerce/email): ponavljajuća pitanja „gdje je pošiljka", reklamacije,
   povrati. Volumen je visok → vrijednost je očigledna u prvih 7 dana.
2. **Agencije** (marketing/web/SEO): white-label, robot radi izvještaje, odgovara na upite, piše predloge.
   Kanal: **jedna agencija = više klijenata**, prodaja je B2B2B.
3. **Knjigovodstvo / CRM** (interna automatizacija): unos dokumenata, podsjetnici za fakture, priprema
   izvještaja, odgovori na ponavljajuća pitanja klijenata. Manji volumen, ali visoka cijena po satu rada.

**Vertikale koje NE idu u prvih 90 dana:** legal i medical (odgovornost i compliance), banke i osiguranja
(prodajni ciklus 9–18 mj.), državne firme (javne nabavke), i sve što traži SOC 2 (vidi `08` §8).

**Plan po nedjeljama:**

| Nedjelja | Fokus | Konkretne akcije | Izlaz |
|---|---|---|---|
| **1–2** | Dokazivo demo, ne slajdovi | 2 demo scenarija na **njihovim** podacima (bez pravih PII); snimak ekrana 3 min; 1-str. opis sa cijenom | Demo + cjenovnik |
| **3–4** | Lista 30 ciljeva | 10 e-commerce, 10 agencija, 10 knjigovodstva (poznanstva prvo); 1 cold email + 1 LinkedIn + 1 poziv dnevno | 30 kontaktiranih, 8 razgovora |
| **5–6** | Razgovori (ne prodaja) | Pitanja: koji posao se ponavlja, koliko sati, ko ga radi, šta boli; **ne** pričati o AI-u | 8 mapa procesa, 3 kandidata za pilot |
| **7–8** | Pilot ponuda | „30 dana, fiksna cijena, 1 proces, mjerimo 4 metrike"; cijena pilota **500–1.500 EUR** (procjena) ili besplatno uz **pisanu obavezu** mjerenja | 3 potpisana pilota |
| **9–11** | Implementacija pilota | Mapiranje, integracije, politike, test na stvarnim podacima; definisati „uspjeh" **prije** starta | 3 aktivna robota |
| **12** | Mjerenje i odluka | Prikupiti 4 metrike (vidi §7); sastanak sa brojevima; ponuda za plaćeni nastavak | 3 konverzije u plaćeno, 1 case study |

**Šta je „prvi plaćeni pilot" i kako izgleda (konkretno):**
- **Trajanje:** 30 dana. **Cijena:** 500–1.500 EUR (procjena) — plaćeno, jer besplatni piloti daju
  lažan signal i klijent se ne obavezuje.
- **Obim:** **1 proces**, **1 kanal**, jasno napisan „success criteria" koji potpisujemo **prije** starta.
- **Mjerenje (baseline nedjelja 0):** koliko ticketa/upita dnevno, prosječno vrijeme odgovora,
  koliko sati troši osoba, koliko ih robot riješi bez čovjeka.
- **Obaveze klijenta:** 1 kontakt osoba, pristup kanalu (email/Shopify), 2 h nedjeljno za feedback.
- **Izlaz:** izvještaj sa brojevima + odluka: (a) prelazak na Starter/Pro, (b) produženje pilota,
  (c) stop. Ako nema mjerljive uštede — **ne** prodajemo dalje, mijenjamo vertikalu (vidi `10` §5).

---

## 7. Dokazivanje vrijednosti

**Šta mjerimo kod klijenta (4 metrike, sve iz podataka koje robot već ima):**

| Metrika | Kako se mjeri | Izvor podatka |
|---|---|---|
| **Ušteđeni sati** | (broj runova × prosječno minuta po zadatku kod čovjeka) / 60 | `runs` + baseline iz pilot faze |
| **Riješeno bez čovjeka** | runovi završeni bez `approval` i bez `handoff` na čovjeka / ukupno | `runs`, `steps`, `approvals` |
| **Vrijeme odgovora** | p50/p95 latencija od ulaza do odgovora; uporedi sa baseline-om | `trace` (spanovi) |
| **Konverzija leadova** | broj upita → kvalifikovan lead/kupovina (ako klijent da pristup) | webhook izvor + CRM |

Sekundarno: **trošak po riješenom zadatku** (cost tracker / broj riješenih) — to je broj koji
opravdava cijenu i istovremeno naš interni kontrolni mehanizam.

**Mjesečni izvještaj koji robot sam generiše** (`scripts/report.mjs` → PDF/HTML + email):
1. **Sažetak u 3 broja:** riješeno bez čovjeka · ušteđeni sati · prosječno vrijeme odgovora.
2. **Trend** (ovaj mjesec vs prošli): volumen, riješeno bez čovjeka, trošak.
3. **Top 5 tema** upita (i 3 teme koje robot **nije** znao → to je prodajni argument za sljedeći korak).
4. **Odobrenja:** koliko `high` akcija je čovjek odobrio/odbio — dokaz da politike rade.
5. **Trošak:** stvarni trošak modela i usage vs uključeno u paket (transparentno; gradi povjerenje).
6. **Preporuka:** jedna konkretna sljedeća automatizacija (upsell, ali zasnovan na podacima).
7. **Izjava:** „brojevi su izračunati iz X runova; baseline preuzet iz pilot mjerenja od <datum>."

**Pravilo:** nijedna tvrdnja o uštedi **ne smije** biti bez baseline-a. Ako nemamo baseline,
pišemo „nije mjereno" — jer izmišljena ušteda se obije o glavu na drugom sastanku.

---

## 8. Cjenovna psihologija i zamke

1. **Ne naplaćuj po „agentu" — naplaćuj po kanalu/procesu i rezultatu.** „Agent" je naš interni pojam;
   klijent kupuje „email support" ili „priprema ponuda". Ako naplaćujemo po agentu, klijent optimizuje
   broj agenata umjesto vrijednosti i cjenkanje je neizbježno.
2. **Uvedi fair-use, ne „neograničeno".** „Neograničeno" privlači 5% klijenata koji prave 60% troška.
   Formulacija: „uključeno X, preko toga Y EUR po poruci — uz upozorenje pri 80% i **nikad** bezobrazno visok overage".
3. **Godišnji popust 10–20%, ali naplata mjesečno je default.** Godišnja uplata poboljšava cash-flow i
   smanjuje churn; mjesečna je niža barijera. Uvedi godišnju tek kad imaš 5+ zadovoljnih klijenata.
4. **Setup uvijek naplaćuj (ili ugradi u prva 3 mjeseca paketa).** Besplatan onboarding privlači
   klijente koji neće ostati i troši nam najvrijednije sate. Alternativa: „prva 3 mjeseca Pro cijena
   uključuje setup" — psihološki lakše od odvojene stavke.
5. **Cijenu veži za sidro koje klijent razumije.** „Jedan zaposleni košta 700 EUR/mj. (procjena);
   robot radi dio njegovog posla za 349 EUR/mj." Nikad ne poredi sa „ChatGPT pretplatom od 20 EUR" —
   to sidro ubija maržu i nikad se ne vrati.
6. *(dodatno)* **Ne snižavaj cijenu da dobiješ klijenta** — snizi **obim** (manje procesa, jedan kanal).
   Snižena cijena ostaje snižena; smanjen obim se kasnije lako proširi.

---

## 9. Rizici naplate

**Gubitak na heavy userima — kako se sprečava (tehnički, ne samo ugovorom):**

| Mehanizam | Detalj | Gdje |
|---|---|---|
| Tvrd budžet po runu | `maxCostUsdRun`, `maxSteps`, `maxToolCalls` → run se prekida | `src/core/budget.js` |
| Dnevni/mjesečni budžet tenanta | `maxCostUsdDay`, `maxCostUsdMonth` → blokada + alert | `src/core/budget.js`, `config/policies.json` |
| Upozorenja na 60/80/100% | email vlasniku + banner u UI, **prije** nego što nastane trošak | `src/observability/cost.js` |
| Overage cijena | Poruka 0,02–0,05 EUR, run 0,15–0,50 EUR (**procjena**) — jasno u ugovoru | Cjenovnik |
| Automatski upgrade predlog | Kad 3 mjeseca zaredom prekorači, predlog većeg paketa (jeftinije od overage-a) | Izvještaj |
| Detekcija anomalije | Trošak tenanta > 3x prosjek zadnjih 7 dana → alert + privremeni limit | Metrike |
| Fair-use klauzula | „Normalna upotreba; zloupotreba (npr. bulk generisanje sadržaja) nije pokrivena" | Ugovor |
| Suspenzija | Neplaćanje > 15 dana → `read-only` (podaci ostaju, robot ne radi) | Aplikacija |

**Naplata u regionu (Srbija/BiH/CG/Hrvatska) — realnost:**
- **Kartice (Stripe/Paddle):** najlakše za Starter i Pro; ali: Stripe nije dostupan za isplatu u svim
  zemljama regiona → koristiti **Paddle** ili **Stripe preko EU entiteta** (provjeriti aktuelne uslove i
  naknade; **procjena** 2,9% + 0,30 EUR po transakciji, +1–2% za konverziju valute).
- **Fakture i virmanska uplata (IPS/SEPA):** realnost za Pro i Enterprise (firme traže fakturu, rok 15–30 dana).
  Ovo zahtijeva ručno praćenje → uvesti jednostavnu evidenciju (rok, opomena, suspenzija).
- **Devizni priliv:** za uplate iz inostranstva — provjeriti provizije banke i potreban dokument
  (ugovor/faktura); **procjena** 0,5–1,5% + fiksna naknada po prilivu.
- **PDV / VAT:** B2B u EU — reverse charge uz validan VAT ID; B2C digitalne usluge — mjesto potrošnje
  (mini one-stop-shop). **Obavezno provjeriti sa knjigovođom** prije prve fakture van zemlje.
- **Neplaćanje:** Starter/Pro → automatska suspenzija poslije 15 dana; Enterprise → ugovorna kamata + eskalacija.
- **Valuta:** fakturisati u EUR; klijentima u Srbiji omogućiti plaćanje u RSD po srednjem kursu
  (kursni rizik nosi mi ako faktura glasi u RSD, a trošak modela je u USD) → **fakturisati u EUR** gdje god je moguće.

---

## Otvorena pitanja

1. **Da li se self-hosted isporučuje kao izvorni kod ili bundle?** Izvorni kod je lakši za podršku i
   prodaju, ali se lakše redistribuira. Odluka mijenja i cijenu i licencnu zaštitu (§5).
2. **Koja je stvarna cijena modela po 1.000 poruka** za naš primarni model i za fallback — i koliko
   varira između providere? Bez tog broja, §3 i §4 su pretpostavka (provjeriti kod providera).
3. **Da li agencija smije prodavati pod svojim brendom i po svojoj cijeni** (white-label), i ko
   odgovara za GDPR/DPA prema krajnjem klijentu — mi ili agencija? Ovo mora ući u ugovor.
4. **Koliko je realno naplatiti setup za Starter** (150–400 EUR) na tržištu regiona, gdje su klijenti
   navikli na „besplatno uvođenje" — i da li umjesto toga uvesti „probni mjesec sa ograničenim obimom"?
5. **Koja je ciljna cijena za „EU tier"** ako klijent traži EU-only obradu (vlastiti Ollama/vLLM na Hetzneru)?
   GPU na Hetzneru drastično mijenja trošak infra — **procjena** traži poseban cjenovni razred.
6. **Da li idemo na godišnju uplatu odmah** (poboljšava cash-flow) ili tek poslije 5 zadovoljnih klijenata
   (niža barijera ulaza)? Odluka utiče na to koliko mjeseci možemo izdržati bez prihoda.
