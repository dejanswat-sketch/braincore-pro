# 10 — Rizici i mitigacije

> Vezano za `docs/DECISIONS.md` v1.0. Ovo je **radni registar rizika za odlučivanje**, ne prezentacija.
> Vjerovatnoća i uticaj su **procjena** (skala: niska / srednja / visoka). Dokument se ažurira
> pri svakom pilotu i na kraju svakog mjeseca — rizik koji nije ažuriran je rizik koji je zaboravljen.
> Pravilo: svaki rizik ima **vlasnika odluke** i **rani signal** koji se može vidjeti u podacima,
> a ne tek kad se desi.

---

## 1. Tehnički rizici

| Rizik | Vjer. | Uticaj | Rana detekcija (signal u podacima) | Mitigacija | Ko odlučuje |
|---|---|---|---|---|---|
| **Nekontrolisana petlja agenta i trošak** | **visoka** | **visok** | Broj `steps` po runu raste; `cost` po runu iznad budžeta; isti tool+args ponovljen > 2x; p95 latencija raste | Tvrde granice u kodu (`maxSteps` 12, `maxToolCalls` 25, `maxToolRepeats` 3, `maxWallClockMs`, `maxCostUsdRun`) — **ne u promptu**; prekid runa + alert; dnevni/mjesečni budžet po tenantu; cost tracker po `tenantId+agentId+model` (D16) | Vlasnik projekta (prag), inženjer (implementacija) |
| **Halucinacija u domenu sa posljedicama** (legal, medicinski, finansijski, poreski) | **visoka** | **visok** | Klijent prijavi netačan odgovor; `critic` agent nalazi neslaganje; run bez ijednog tool poziva u domenu gdje je izvor obavezan; odgovor bez citata izvora | **Obavezan izvor** (RAG/tool) za takve domene; `critic` pattern; eksplicitno „ne znam" kao dozvoljen ishod; obavezan disclaimer + upućivanje na čovjeka; `high` rizik → odobrenje; **ne prodavati** legal/medical u prvih 12 mjeseci bez čovjeka u petlji | Vlasnik (šta prodajemo), inženjer (politike) |
| **Latencija** (SSE, višekoračni run, kritični kanal) | **srednja** | **srednja** | p95 vrijeme do prvog tokena; p95 trajanje runa; broj „čekaj" odgovora; napuštanje widget sesije | Streaming (SSE) od prvog tokena; `router` pattern da ne ide težak agent na lak zadatak; paralelizacija nezavisnih tool poziva (`fanout`); keš embedding-a; manji model za klasifikaciju/rutiranje; timeout po alatu + fallback odgovor | Inženjer |
| **Rate limit / ispad LLM providera** | **srednja** | **visok** | 429/5xx u `provider.chat`; rast retry-ja; rast latencije; greške u runovima po modelu | Provider adapter sa **2–3 providere** (D6: OpenAI-kompatibilni) i fallback lancem; exponential backoff + jitter; queue po tenantu (Redis, D8); **graceful degradation** (manji model / „trenutno ne mogu"); nikad tiho padanje — `error` event ka widgetu | Inženjer |
| **MCP server se promijeni i pokvari** | **srednja** | **srednja/visok** | Hash popisa alata se promijenio; nove greške u tool pozivu; latencija skočila; MCP server traži nove dozvole | **Pinovanje verzije/commit-a**; hash tool sheme → automatski `disable` + alert ako se promijeni bez revizije; allowlist po tenantu; MCP sandbox (bez shell-a, read-only FS, egress pravila; vidi `08` §7); fallback na `builtin` alat | Inženjer |
| **Kompleksnost 6 patterna** (D13) — održavanje, testovi, nejasan izbor | **srednja** | **srednja** | Vrijeme dodavanja patterna raste; testovi za pattern nestabilni; agenti koriste 2 patterna u 90% slučajeva; bug fix u jednom patternu kvari drugi | Ne graditi 6 patterna paralelno: **`sequential` + `router` prvo**, ostala 4 tek kad ih klijent traži; svaki pattern ima test (D17); pattern se bira **config-om**, ne kodom; zajednički `ctx`, budget, trace i tool-sloj za sve patterne; mjeri koji se patterni stvarno koriste i **obriši nekorišćene** | Vlasnik + inženjer |
| **Skaliranje na 100+ tenanta** | **srednja** | **srednja** | Broj fajlova po folderu; vrijeme `vector.query` raste linearno; JSONL fajlovi > 100 MB; memorija procesa raste | JSONL je MVP (D7) i ima **jasan prag prelaska**: > 20 tenanta **ili** > 100 MB po fajlu → Postgres+pgvector (D8) i Redis; brute-force cosine zamijeniti `pgvector` indeksom; rotacija/kompakcija JSONL; jedan proces ne smije držati sve tenante u memoriji (lazy load po tenantu) | Inženjer (prag), vlasnik (trošak) |
| **Gubitak podataka** (fajl, deploy, disk, ransomware) | **niska/srednja** | **visok** | `restic snapshots` ne raste; `restic check` greška; test restore nije rađen > 3 mj.; disk > 80% | Dnevni šifrovani restic backup (04:00) + offline USB; **test restore kvartalno** sa zapisom; backup prije svakog deploy-a; LUKS; append-only JSONL (nema prepisivanja cijelog fajla) | Vlasnik |
| **Cross-tenant curenje kroz bug** (tehnički rizik, ne samo sigurnosni) | **niska** | **kritičan** | Test izolacije pada; odgovor sadrži podatak koji nije iz tog tenanta; zajednički keš ključ bez `tenantId` | `tenantId` obavezan parametar (fail-closed, D11); fizički folderi (D12) + RLS; testovi izolacije u CI; **nijedan novi upit ne prolazi bez `tenantId` u WHERE**; code review checklist | Inženjer |
| **Tajna procurela u log ili trace** | **srednja** | **visok** | Grep po logu nalazi `sk-`/`nmq_live_`; trace span sadrži token; izvještaj sadrži kredencijale | Logger redaguje polja i obrasce **na ulazu**; nikad tajna u prompt; `[REDACTED]` u izlazu; test `no-secrets-in-logs.test.mjs`; tajne samo iz DSH store-a (env) | Inženjer |
| **Zavisnost od jednog providera (tehnički dio)** | **srednja** | **srednja** | Svi runovi idu na jedan model; kvalitet pada poslije njihovog update-a; cijena skače | Adapter za više providera (D6) + `mock` za testove; runovi se loguju sa `model` pa je A/B i migracija mjerljiva; držati **jedan** alternativni provider konfigurisan i povremeno testiran (ne samo „podržano u kodu") | Inženjer |
| **Preoptimizacija prije prvog klijenta** (rizik koji sam sebi pravimo) | **visoka** | **srednja** | Nedjelje prolaze bez razgovora sa klijentom; broj integracija raste a nijedan plaćeni korisnik; „još samo da refaktorišem" | „Definition of Done" iz `DECISIONS.md` §4 je **granica MVP-a**; sve poslije toga čeka prvog plaćenog klijenta; nedjeljni ritam (§5) mjeri sate na prodaji vs kodu | Vlasnik |

---

## 2. Poslovni rizici

| Rizik | Signal (rani, mjerljiv) | Mitigacija |
|---|---|---|
| **Klijent ne vidi vrijednost** (robot radi, ali se ne koristi) | < 30% očekivanog volumena u 3. nedjelji; nema pitanja od klijenta; kontakt osoba ne odgovara; runovi samo iz testa | Baseline i „success criteria" **prije** starta pilota; prva vrijednost u **7 dana**; mjesečni izvještaj sa brojevima (`09` §7); ako nema korišćenja — **prekidamo** i ne produžavamo (bolje priznati nego naplaćivati mrtvo) |
| **Konkurencija je jeftinija** (ChatGPT tim paket, gotovi botovi 20–50 EUR/mj.) | Klijent kaže „ovo mogu i sam"; poredi sa pretplatom na ChatGPT; traži popust prije prvog razgovora | Ne takmičiti se na cijeni nego na **izvršenim akcijama + izolaciji + izvještaju**; sidro je plata zaposlenog, ne pretplata na chat; demo na **njihovim** podacima; ponuditi **manji obim** umjesto niže cijene |
| **Prodajni ciklus je dug** (B2B, 3–9 mj.) | Prosjek dana od prvog razgovora do potpisa; broj „sledeće nedjelje se javljamo"; odluka čeka „gazdu" | Ciljati **odlučioca** odmah (vlasnik u maloj firmi); krenuti sa malim plaćenim pilotom (odluka na nivou jednog procesa); više malih klijenata umjesto jednog velikog; pratiti **payback** i odustati od segmenata sa ciklusom > 3 mj. |
| **Support teret raste linearno** | Support minute po klijentu ne padaju poslije 2 mj.; broj „kako ovo radi" ticketa; isti problem kod 3 klijenta | Self-serve dokumentacija i video za 5 najčešćih pitanja; **odgovor na ponavljajuće pitanje = nova funkcionalnost ili dokument**, ne novi ticket; kvartalno mjerenje minuta po klijentu; cijena paketa se koriguje ako minute rastu; onboarding naplaćen |
| **Zavisnost od jednog LLM providera** (poslovni dio: cijena, uslovi, pristup) | Provider mijenja cijene/uslove; prekid pristupa; kvalitet se mijenja preko noći; region blokada | Multi-provider adapter (D6); **EU/self-hosted model** kao opcija za osjetljive klijente (Ollama/vLLM na Hetzneru); u ugovoru sa klijentom **ne** obećavati konkretan model; pratiti trošak po modelu i biti spreman prebaciti |
| **Cijene modela padaju** (dobar rizik, ali mijenja cjenovnik) | Nove generacije modela 3–10x jeftinije; konkurencija spušta cijene | **Ne graditi cijenu na „jeftinom modelu"** nego na vrijednosti (ušteđeni sati); zadržati maržu i spuštati cijenu samo ako to otvara novi segment (self-serve tier); pad cijene modela je prilika za **veću maržu**, ne za popust svima |
| **Cijene modela rastu / rate limit se smanjuje** | Trošak po runu skače; 429 češći | Overage cijena i fair-use u ugovoru; `maxCostUsdRun` i dnevni budžet; keširanje i kraći kontekst; manji model za rutiranje; pravo na korekciju cijene uz **30 dana** najave (u ugovoru) |
| **Klijent traži on-prem / self-hosted** | „Naš IT ne dozvoljava cloud"; zahtjev za SOC 2/ISO; zahtjev za penetration test | Self-hosted enterprise licenca (`09` §5) kao **namjeran** odgovor, ne izuzetak; jasno reći šta self-hosted **ne** rješava (naša odgovornost za njihov server prestaje); ako traže SOC 2 — to je poseban, plaćen projekat (`08` §8) |
| **Pravni rizik kod legal domene** | Klijent iz advokatske firme traži automatske pravne savjete; odgovor bez upozorenja; greška u dokumentu | **Ne** prodavati autonomno pravno odlučivanje; robot priprema **nacrt** i **citira izvor**, advokat odobrava; obavezan disclaimer i `high` rizik → `approval`; ugovorom jasno: „izlaz je nacrt, ne pravni savjet"; E&O osiguranje razmotriti prije ulaska u ovu vertikalu |
| **Naplata u regionu i devizni priliv** | Kasne uplate; visoke bankarske provizije; nemogućnost kartičnog plaćanja | Fakturisanje u **EUR**; Paddle/Stripe preko EU entiteta za kartice; virmanska uplata za Pro/Enterprise uz automatsku suspenziju poslije 15 dana; provjeriti PDV/reverse charge sa knjigovođom (`09` §9) |
| **Zavisnost od jedne osobe (key-man rizik)** | Osoba nedostupna; niko ne zna gdje su ključevi; nema„break-glass" uputstva | Dokumentovani runbook (`08` §9–10); backup lozinka i pristupi u DSH store-u; „break-glass" uputstvo **van** servera; pristupi klijenata u zajedničkom, dokumentovanom spremištu; ugovor sa klijentom ne obećava 24/7 ako nas ima 1–2 |
| **Sezonski/ekonomski pad potražnje** | Manje upita klijentima → manje runova → klijent pita „zašto plaćam" | Pretplata mora nositi vrijednost i kad je volumen mali (izvještaji, automatizacije, monitoring); uvesti godišnje ugovore; ne zavisiti od jedne vertikale (e-commerce je sezonski) |

---

## 3. Rizici izgradnje (solo / tim od 1–2)

| Rizik | Mitigacija |
|---|---|
| **Previše scope-a** (10 agenata, 6 patterna, widget, webhook, MCP, Postgres, Redis, self-hosted) | **MVP granica je `DECISIONS.md` §4** i ništa preko; 10 agenata postoje kao **JSON config** (D14) — to ne znači da su svi „gotovi" i testirani sa klijentom; 6 patterna: **`sequential` + `router` prvo**; MCP i Postgres **poslije** prvog plaćenog klijenta |
| **Nedostatak fokusa / „sve odjednom"** | Jedna vertikala i jedan proces po pilotu; nedjeljni ritam (§5) — u svakoj nedjelji **jedan** cilj; svaka nova ideja ide u „parking lot" i čeka kraj nedjelje; **ne** raditi na dva nepovezana problema isti dan |
| **Burnout** | Realan rizik #1 kod solo rada; raditi **fiksno radno vrijeme** i 1 dan bez koda; mjeriti sate prodaje vs koda; prihvatiti da je MVP 8–12 nedjelja, ne 4; **spoljni** ritam (nedjeljni demo) drži tempo bez samopritiska; odmor planirati kao task |
| **Nedostatak (ili gomilanje) povratne informacije** | Feedback **u samom robotu**: 👍/👎 + komentar uz svaki run (jedno polje, u `data/.../feedback.jsonl`); nedjeljni pregled svih 👎; razgovor sa klijentom **svake 2 nedjelje** uživo |
| **Sve je „prioritet"** | Samo **jedna** stvar je prioritet u nedjelji („one thing"); sve ostalo je lista koja čeka; ako stigne novi zahtjev, ide na kraj liste ili zamjenjuje trenutni prioritet — **nikad** oboje |
| **Tehnički dug koji koči prodaju** | Tehnički dug je dozvoljen **ako** je iza interfejsa (`VectorStore`, `Provider`, `ToolRegistry` — D6, D9); refaktorisanje bez klijenta je zabava, ne posao; dug se otplaćuje kad koči konkretnog klijenta |
| **Licence, ugovori, DPA, PDV — „poslije ćemo"** | Ovo **nije** poslije: DPA i ugovor moraju postojati prije prvog plaćenog klijenta; šablon ugovora 2–4 str.; knjigovođa uključen prije prve fakture van zemlje |
| **Pravilo fokusa (tvrdi limit)** | ### **Ne graditi više od 2 vertikale u MVP-u.** Treća vertikala ulazi samo ako prve dvije imaju 2+ plaćena klijenta svaka ili ako je prva „kill" po §5. |

---

## 4. Odluke koje mogu da ubiju projekat

| # | Odluka (mamac) | Zašto izgleda dobro | Šta se realno desi | **Alternativa (odluka koju treba donijeti)** |
|---|---|---|---|---|
| 1 | **Graditi svoj agent framework umjesto koristiti postojeći** | „Imamo kontrolu, bez zavisnosti (D2), bez tuđih bugova" | 3–6 mjeseci na infrastrukturu (retry, streaming, tool calling, state), a nula razlike za klijenta; sve što smo napravili postoji i bolje održavano | Koristiti **postojeći** runtime/framework **ili** vlastiti, ali **minimalni** sloj samo za ono što klijent vidi (politike, budžet, audit, multi-tenant) — to je naših 20% koji se razlikuju. Odluka se donosi **prije** prve linije orkestracije i ne mijenja se u toku MVP-a |
| 2 | **Graditi 20 integracija prije prvog klijenta** | „Spremni smo za svakoga" | 20 nedovršenih integracija, nijedna nije testirana na pravim podacima, nijedan plaćeni klijent; svaka integracija ima svoj auth, rate limit i bug | **2–3 integracije za 2 vertikale** (`09` §6: e-commerce kanal, email, CRM/knjigovodstvo), svaka **testirana na podacima klijenta**; treća integracija se dodaje **na zahtjev** plaćenog klijenta i naplaćuje |
| 3 | **Naplaćivati po tokenu** | „Fer je, plaćaš koliko trošiš" | Klijent vidi nepredvidiv račun i odustaje; prodaja postaje razgovor o tokenima umjesto o vrijednosti; heavy useri bježe, a oni koji malo troše stalno se cjenkaju | Pretplata (predvidivost) + **fair-use** + overage (`09` §3, §9); tokeni su **interna** mjera, ne javni cjenovnik. Ako klijent traži „po utrošku" — to je Enterprise ugovor sa mjesečnim obračunom i **fiksiranim minimumom** |
| 4 | **Self-hosted za sve** (jer je „lakše prodati") | „Nemaju brigu o podacima, mi nemamo trošak infra" | Gubimo kontrolu nad verzijama i kvalitetom; support eksplodira (njihova infrastruktura, njihove verzije Node-a, njihov proxy); nema cost tracking-a pa nema upsell-a; nema multi-tenant ekonomije | **SaaS je default** (jedna codebase, jedan deploy, mjerenje); self-hosted je **premium Enterprise** kanal sa višom cijenom i jasnim granicama odgovornosti (`09` §5). Ako klijent ne može platiti premium — nije naš klijent **danas** |
| 5 | **Ignorisati observability** („dodaćemo logove kasnije") | Uštedi vrijeme u MVP-u; „radi, vidi se na ekranu" | Ne znamo zašto je odgovor loš, ne možemo dokazati trošak, ne možemo naplatiti usage, ne možemo naći cross-tenant bug, ne možemo proći ni osnovni audit; svaki incident se rješava nagađanjem | Trace + metrike + cost tracker + **hash-chained audit** (D16) **od prvog dana** — to je 3 fajla (`trace.js`, `metrics.js`, `cost.js`, `audit.js`), ne projekat. Bez toga nema ni naplate ni compliance-a |
| 6 | *(dodatno)* **Praviti „univerzalnog" agenta bez ijedne vertikale** | „Multi-tenant, 10 agenata, sve domene" | Demo izgleda impresivno, ali nigdje nije dovoljno dobar; prodaja nema priču („za koga tačno?"); testiranje je nemoguće | Izabrati **2 vertikale** (§3) i u njima biti **najbolji**; univerzalnost je arhitektura (D11–D15), a prodaja je vertikala |

---

## 5. Kako iterativno testirati

**Prvih 5 pilota — svaki ima jasnu svrhu (ne „još jedan klijent"):**

| # | Pilot | Šta se tačno mjeri | Odluka koju nosi |
|---|---|---|---|
| 1 | **Poznati klijent / vlastita firma** (najniži rizik, može se prekinuti) | Da li robot završi run bez rušenja; kvalitet odgovora; broj potrebnih ispravki politika | Da li je MVP tehnički spreman za stranca |
| 2 | **E-commerce support** (visok volumen, jasan proces) | % ticketa riješenih bez čovjeka; p95 vrijeme odgovora; trošak po riješenom ticketu | Da li vertikala 1 nosi vrijednost |
| 3 | **Agencija (white-label)** | Koliko krajnjih klijenata agencija može opslužiti; support minute; da li agencija može sama konfigurisati | Da li je kanal B2B2B skalabilan i koliko podrške traži |
| 4 | **Knjigovodstvo / CRM interna automatizacija** | Ušteđeni sati po zadatku; tačnost ekstrakcije podataka; broj `high` odobrenja | Da li vertikala 2 ima dovoljnu cijenu po satu |
| 5 | **Klijent koji je tražio „nešto drugo"** (kontrolni pilot, npr. nekretnine ili servis) | Koliko je mapiranje procesa trajalo; koliko novih integracija je trebalo; da li se ponavlja obrazac | Da li se naš model prenosi na novu vertikalu ili smo „one-trick" |

**Kill criteria (kada odustati od vertikale — unaprijed napisano, da ne odlučujemo u afektu):**
- **Nema plaćanja poslije 2 pilota** u toj vertikali (oba „rado bi, ali…") → **stop**, ne „još jedan pilot".
- **< 20% riješenih bez čovjeka** poslije 30 dana → proces nije zreo za automatizaciju.
- **Support minute po klijentu ne padaju** poslije 2 mjeseca → trošak raste, marža pada → stop ili promjena obima.
- **Onboarding > 3 nedjelje** za jedan proces → previše custom posla za solo tim.
- **Pravni/compliance zid** (klijent traži SOC 2/ISO ili on-prem pod uslovima koje ne možemo ispuniti) → vertikala čeka fazu 3.
- **Kontakt osoba prestane odgovarati 3 nedjelje** → pilot je mrtav; zatvoriti i ne trošiti sate.
- **Trošak modela > 40% prihoda** dva mjeseca zaredom → cijena ili obim su pogrešni → stop dok se ne ispravi.

**Nedjeljni ritam (obavezno, i kad nema klijenata):**
- **Ponedjeljak (≤ 60 min):** plan nedjelje — **jedan** cilj, 3 zadatka; šta se **ne** radi ove nedjelje.
- **Srijeda:** kratka provjera — je li cilj još validan (ako ne, mijenja se sada, ne u petak).
- **Petak (≤ 30 min):** demo (sebi ili klijentu) — mora se **vidjeti** rad, ne opisivati; zapis:
  šta je urađeno, šta nije, koji rizik je nov, šta ide za sljedeću nedjelju.
- **Kraj mjeseca:** ažuriranje `10-RIZICI.md` (ovaj fajl) + registar pretpostavki (§6) + mjesečni izvještaj klijentima.

**Kako se skuplja feedback — u samom robotu:**
- Uz svaki run u UI: **👍 / 👎** (obavezno) + opcionalan komentar (jedno tekstualno polje, max 500 znakova).
- Zapis: `feedback.jsonl` — `{ runId, tenantId, agentId, rating, comment, createdAt, model, costUsd }`
  (bez PII u komentaru — prolazi kroz isti redaktor kao i logovi).
- Widget: „Je li ovaj odgovor bio koristan?" (jedan klik, bez registracije).
- **Pravilo:** svaki 👎 se pročita **istu nedjelju**; 👎 bez komentara se ne rješava nagađanjem — pitamo klijenta.
- Izvoz: 👎 lista ulazi u `tests/` kao **regresioni korpus** (napravi test od stvarnog promašaja).

---

## 6. Registar pretpostavki

| # | Pretpostavka | Kako se provjerava | Rok | Šta ako padne |
|---|---|---|---|---|
| A1 | Firme u regionu **plaćaju** za automatizaciju 100–600 EUR/mj. | 10 razgovora + 3 plaćena pilota (`09` §6) | 90 dana | Spustiti na self-serve tier (29–49 EUR/mj.) ili ići na agencije/white-label kanal |
| A2 | Postoji **dovoljno ponavljajućeg** posla koji se može automatizovati u 2 vertikale | Mjerenje volumena i % riješenih bez čovjeka u pilotima 2 i 4 | 120 dana | Pivot na jednu vertikalu sa najvećim volumenom (§7) |
| A3 | Kvalitet modela je **dovoljan** za te procese uz RAG + politike | 👎 stopa < 15% i tačnost na kontrolnom setu u pilotima | 90 dana | Dodati `critic` + obavezan izvor; uvesti čovjeka u petlju za sve odgovore (mijenja ekonomiju!) |
| A4 | Trošak modela ostaje **< 15% prihoda** | Cost tracker po tenantu, mjesečno | 90 dana | Manji model za rutiranje, kraći kontekst, keš, veće cijene/obim, fair-use |
| A5 | **Jedna osoba** može održavati 10–15 klijenata uz < 1 h/klijentu/nedjeljno | Support minute po klijentu (ticket sistem) | 180 dana | Dokumentacija + self-serve + template odgovori; ili platiti prvu liniju podrške; ili ograničiti broj klijenata |
| A6 | Klijenti **prihvataju** da podaci budu kod nas (Hetzner, EU) | Pitanja o lokaciji podataka u prvih 10 razgovora; broj zahtjeva za self-hosted | 120 dana | EU-only tier ili self-hosted kao default za Enterprise |
| A7 | Agencije **mogu i žele** prodavati pod svojim brendom | Pilot 3: koliko ih konfiguriše samo, koliko ih traži našu pomoć | 120 dana | White-label samo kao Enterprise dodatak ili odustati od tog kanala |
| A8 | MCP ekosistem je **dovoljno zreo** za produkciju | Revizija i test 2–3 MCP servera u pilotu (`08` §7) | 150 dana | Ostati na `builtin` alatima + vlastitim integracijama; MCP kao „opciono" |
| A9 | **6 patterna** je prava apstrakcija (D13) | Mjeri se koji se patterni stvarno koriste u 5 pilota | 150 dana | Ostaviti 2–3 koja nose 95% posla; ostale ukloniti (manje koda = manje bugova) |
| A10 | JSONL fajl-sistem (D7) izdrži do **20 tenanta** | Mjerenje latencije `vector.query` i veličine fajlova | 150 dana | Prijelaz na Postgres+pgvector i Redis ranije — **prije** nego što postane problem |
| A11 | Možemo **naplatiti setup** (150–1.500 EUR) | Prihvatanje u prvih 5 ponuda | 90 dana | Ugraditi setup u prva 3 mjeseca pretplate (bez snižavanja ukupne cijene) |
| A12 | Konkurencija nas **neće pregaziti** cijenom prije nego stignemo | Praćenje ponuda u regionu, 1x mjesečno | kontinuirano | Fokus na dubinu vertikale (integracije + izvještaji + izolacija), ne na cijenu |

---

## 7. Plan B

Ako se poslije **3–4 mjeseca** pokaže da „univerzalni robot za sve" ne prolazi (A1/A2 padnu),
ne gasiti projekat — suziti ga. Tri realne pivot opcije, po prioritetu:

**Pivot 1 — Samo support agent za e-commerce (najkonkretniji, najkraći put do prihoda).**
- **Šta ostaje:** widget + email kanal, `support` i `ecommerce` agent, RAG nad katalogom/politikama,
  eskalacija na čovjeka, mjesečni izvještaj.
- **Šta se briše/odgađa:** 8 od 10 agenata, 4 od 6 patterna, MCP, self-hosted, Enterprise compliance.
- **Cijena:** 99–299 EUR/mj. **Ciljna grupa:** mali shopovi i Shopify/WooCommerce agencije.
- **Dokaz uspjeha:** 10 plaćenih klijenata, churn < 5%/mj., support < 30 min/klijent/mj.
- **Zašto radi:** volumen je visok, vrijednost se vidi u 7 dana, prodaja ide kroz agencije.

**Pivot 2 — Interna automatizacija za agencije (white-label, B2B2B).**
- **Šta ostaje:** multi-tenant izolacija + config po klijentu (naša najjača strana), izvještaji,
  generisanje sadržaja i izvještaja, unos podataka, taskovi.
- **Šta se briše/odgađa:** widget kao primarni kanal, javni SaaS, potrošački use-case.
- **Cijena:** 299–999 EUR/mj. po agenciji (+ po krajnjem klijentu), setup naplaćen.
- **Dokaz uspjeha:** 3 agencije × 5+ krajnjih klijenata; agencija sama konfiguriše bez nas.
- **Zašto radi:** jedna prodaja = više klijenata; agencija radi našu prvu liniju podrške.

**Pivot 3 — On-prem / self-hosted „AI gateway" za firme koje ne smiju u cloud.**
- **Šta ostaje:** Docker paket, multi-tenant izolacija, politike, budžet, audit, vlastiti model (Ollama/vLLM).
- **Šta se briše/odgađa:** javni SaaS, self-serve onboarding, cjenovnik po porukama.
- **Cijena:** licenca 4.000–12.000 EUR/god. + setup 2.000–6.000 EUR (`09` §5).
- **Dokaz uspjeha:** 2–3 ugovora godišnje, marža > 85%, support ugovoren (ne „neograničen").
- **Zašto radi:** nema konkurencije u regionu za „AI koji radi na našem serveru, sa našim pravilima";
  ali prodajni ciklus je dug i traži referencu — zato **nije** prva opcija.

**Odluka o pivotu (pravilo):** pivot se odlučuje na **kraju 4. mjeseca**, na osnovu brojeva iz §5 i §6 —
ne na osnovu osjećaja. Do tada: **nijedan pivot se ne radi „u hodu"**, jer polovičan pivot je
najsigurniji način da se izgubi i postojeći napredak.

---

## 8. Rizici specifični za region i kontekst (NMQ)

| Rizik | Signal | Mitigacija |
|---|---|---|
| **Infrastruktura i deploy zamke** (naučeno na NMQ projektima) | Hostinger LVE obara build; keš servira stare module; `.env` u git-u; deploy bez backup-a | Nema build koraka — `dependencies: {}` (D2); statika `no-cache` + `?v=` version bust; `.gitignore` prvi fajl; backup prije deploy-a (`DECISIONS.md` §5) — ovo su **već poznate** zamke, ne nova procjena |
| **Jedan runtime, bez Python mikroservisa** | Pojavi se „samo još jedan Python skript za obradu" | D1: samo Node ≥ 20; sve što treba radi se u Node-u ili kroz tool/MCP; Python na serveru = dva sistema za održavanje |
| **Tajne u chatu/izvještaju** | Ključ se pojavi u logu, screenshotu ili odgovoru agenta | Tajne samo iz DSH store-a (`get-key.mjs`); u izvještajima samo **ime** ključa; redakcija na ulazu u log i izlazu iz agenta (`08` §5) |
| **„Vlasnik je i prodaja i razvoj i support"** | Prodaja stane kad se razvija; razvoj stane kad se prodaje | Fiksni nedjeljni ritam (§5) sa **prodajnim** blokom koji se ne pomjera; prodaja je 1 ponuda + 5 razgovora nedjeljno, ne „kad stignem" |
| **Klijent traži funkciju koju niko drugi ne traži** | Jedan klijent = 40% razvojnih sati | Pravilo 80/20: radimo je **samo** ako je plati (setup ili Enterprise) ili ako je traže 3+ klijenta; inače ide u „parking lot" |
| **Cijena rada u regionu je niska** → pritisak na cijenu | Klijent poredi sa „studentom koji to radi za 300 EUR" | Ne prodavati sate, prodavati **rezultat** (`09` §1); mjesečni izvještaj sa brojevima je dokaz; sidro = plata zaposlenog, ne sat freelancera |
| **Sezonalnost e-commerce-a** (novembar–januar skok, ljeto pad) | Prihod i volumen osciluju ±40% | Najmanje 2 vertikale u portfoliju (jedna protivciklična: knjigovodstvo/admin — najjača u januaru–aprilu); pretplata nosi fiksni dio |
| **Pravni oblik i ugovori** (privatni preduzetnik / DOO, DPA, IP prava) | Prvi klijent traži ugovor i DPA, a šablona nema | Šabloni (ugovor, DPA, NDA, SOW za pilot) spremni **prije** prvog plaćenog klijenta; knjigovođa uključen prije prve fakture van zemlje; IP prava: naš kod ostaje naš, izlazi i podaci su klijentovi |
| **Prezavisnost od jedne osobe u supportu** | Klijent zove lično; nema ticketa; sve je u glavi | Ticket sistem (i najprostiji) od prvog klijenta; dokumentovani runbook; „break-glass" uputstvo van servera (`08` §10) |

**Mapiranje glavnih rizika na već postojeće mehanizme (dokaz da mitigacija nije samo riječ):**

| Rizik | Mehanizam u kodu / config-u | Dokaz (test ili metrika) |
|---|---|---|
| Nekontrolisan trošak | `src/core/budget.js` + `config/policies.json` | `budget.test.mjs`: run se prekida na `maxCostUsdRun` |
| Cross-tenant curenje | `src/tenancy/store.js`, RLS | `tenant-isolation.test.mjs`, `path-traversal.test.mjs` |
| `high` rizik bez odobrenja | `src/core/policy.js` | `policy.test.mjs`: alat se ne izvršava bez `approval` |
| Nemjerljiv trošak | `src/observability/cost.js` | `/metrics` + `cost.test.mjs` po `tenantId+agentId+model` |
| Nema dokaza šta je urađeno | `src/observability/audit.js` | `verify-audit.mjs` — hash-chain se ne može mijenjati tiho |
| MCP server se promijeni | hash tool sheme + `disable` | test: promjena sheme → alat onemogućen |
| Gubitak podataka | restic + test restore | zapis u `docs/compliance/RESTORE-TESTS.md` |

---

## Otvorena pitanja

1. **Koliko je stvarno „tvrdo" MVP ograničenje** iz `DECISIONS.md` §4 — da li smijemo pustiti MCP i
   Postgres prije prvog plaćenog klijenta ako to traži pilot, ili to čeka i rizikujemo da pilot propadne?
2. **Koje dvije vertikale su konačne** za MVP (`§3` pravilo „max 2") — e-commerce support + agencije,
   ili e-commerce + knjigovodstvo? Odluka mijenja koje integracije gradimo prve.
3. **Da li uvodimo `critic` agenta i obavezan izvor za sve odgovore odmah**, iako to povećava
   trošak i latenciju po runu (utiče direktno na A3 i A4)?
4. **Kada je tačka prelaska sa JSONL-a na Postgres** — čekamo 20 tenanta (D7/D8) ili prelazimo
   pri **prvom** klijentu koji traži garancije o performansama/izolaciji?
5. **Koja je realna cijena supporta po klijentu** i mjerimo li je od prvog dana (ticket sistem ili
   ručna evidencija) — bez tog broja `09` §4 marže su nagađanje?
6. **Ko donosi odluku o pivotu i na osnovu kojih pragova** — da li su brojevi iz §5 (kill criteria)
   dovoljni, ili treba dodati finansijski prag (npr. „manje od X EUR prihoda u 4. mjesecu = pivot")?
