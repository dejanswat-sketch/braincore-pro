# ZNANJE IZ RADA — NMQ (5 dana)

> Ovo je znanje izvuceno iz naseg stvarnog rada (dnevnik, 321 zapis).
> Koristi ga kao cinjenice: arhitektura, procedure, lekcije, odluke.

Generisano: 2026-10-04 21:40

## KLJUCNE CINJENICE (portovi, sati, cijene)
- LOKALNI SERVISI: Masina 01 GEO = port 3020; Masina 02 Analitika = port 3010; Masina 03 Braincore (robot) = port 8081, swarm 8001/8002/8003, bridge 5055.
- OSTALO: mobil upload 3001, accountflow statika 3002, Agent Studio 3101, Ollama 11434, Grafana 3030 (ugasena).
- PEAK SATI (DeepSeek naplacuje DUPLO): 01-04h i 06-10h UTC = 03-06h i 08-12h srpski.
- OFF-PEAK: 16:30-00:30 UTC = 18:30-02:30 srpski. VIKENDOM je UVIJEK off-peak.
- CIJENE deepseek-flash off-peak: cache hit 0,003 USD/M, cache miss 0,15 USD/M, izlaz 0,60 USD/M. Peak (duplo): 0,006 / 0,30 / 1,20.
- NAPLATA: Creem. $19 citation prod_3AhLpEZvSL4cEJllzRKHyz, $149 STARTER prod_30VCb97YdCjv27osjlOJeJ, $249 GROWTH prod_6D2IKZrzSCBukDhJLxf2Lp, $499 OVERLORD prod_3Mk7tHz3MUHpD0ny3RNM47, $999 AGENCY prod_6EQOd9A2l55NduIB1TzV3m.
- WEBHOOK: https://api.aicommandcenter.pro/api/webhooks/creem (trazi potpis, raw body).
- TUNEL: cloudflared, tunel ID c1298084-3a43-4d53-bd57-37a22dcad597 (ime nmq-machine-api).
- MASINA: RTX 5060 Ti 16 GB, Ryzen, 32 GB RAM, Windows. Ollama modeli na H disku.
- MODELI: devstral:24b (glavni), gemma3:4b (fast), qwen2.5-coder:14b (kod), gemma3:12b (SEO), qwen2.5vl:7b (slike), bge-m3 (embeddings), deepseek-r1:14b (rezonovanje).
- USTEDA (izmereno): sazmi.mjs smanjuje 37.578 tokena na 148 (99,6%); cache hit je 50 puta jeftiniji od miss; 92% troska dolazi od konteksta veceg od 128k tokena.

## Glavni sajt i tri masine
Prodajna stranica, tri motora (01 GEO, 02 Analitika, 03 Braincore), Creem naplata

- zapisa: 59 (od 2026-10-04 do 2026-10-04)
- **zadnje stanje:** SAJT SE VRATIO
  - zasto: automatska provjera
  - rezultat: HTTP 200
- **lekcije:**
  - robot treba da se prodaje kao program na aicommandcenter.pro; korisnik je izabrao zamjenu te strane
  - vraceno revert commitom 898831d (push) i Hostinger rebuild-om; /architect-showroom ponovo prikazuje NMQ.Architect/Agent Studio; provjereno 200
  - korisnik: sajt treba da ima 3 masine; koncept nadjen u llms-full.txt i katalogu (Machine 01 SEO+GEO, 02 Analytics, 03 Architect+AI Commander)
  - uporedjeno sa restic backupom 03.10: lokalni kod = backup (nov), server = stariji; rute /seo-geo, /board, /commander vracaju 404 (nikad nisu napravljene)
  - korisnik: sajt treba da ima 3 masine (Machine 01 SEO+GEO, 02 Analytics Board, 03 Architect -> zamijenjen robotom)
  - commit 6e11db2 + push; Hostinger deploy 1m 24s (verzija 01a10628); https://aicommandcenter.pro/machines vraca 200 i prikazuje 3 masine + Creem AGENCY link; provjereno 10 strana - sve 200; build testiran lokalno prije push-a

## API i tunel
Cloudflare tunel, rute, prebacivanje sa VPS-a na nasu masinu

- zapisa: 16 (od 2026-10-04 do 2026-10-04)
- **zadnje stanje:** SAJT SE VRATIO
  - zasto: automatska provjera
  - rezultat: HTTP 200
- **lekcije:**
  - korisnik je trazio da se osposobi tok kupovine; email sa kljucem je bio u MOCK modu jer RESEND_API_KEY nije bio aktivan na VPS-u
  - masina je stala 23.09 i pravila se da ne radi pun kapacitet - uzrok je bio dnevni limit od 5 centi u env-u koji nadjacava config

## NMQ Robot (Masina 03)
Braincore, agenti, orchestratori, RAG, memorija

- zapisa: 19 (od 2026-10-04 do 2026-10-04)
- **zadnje stanje:** RAG sloj ugradjen u robota: znanje ide u svaki system prompt, robot daje tacne brojke
  - zasto: korisnik: ubaci da probamo
  - rezultat: UGRADJENO (3 fajla): (1) NOVI src/llm/znanje.js - modul koji ucitava nase znanje iz docs/*.md i data/knjigovodja-trening, sa PRIORITETOM na USTEDA-TOKENA.md/usteda-znanje.md/DNEVNIK-RADA/facts (ostalo su dokumenti robota, 105 fajlova posle dedup-a), pravi kratak rezime za system prompt; izvlaci NASLOVE + KLJUCNE BROJKE (regex za $, %, 12.581, 4,5 …
- **lekcije:**
  - braincore.test.mjs 15/15 + server.test.mjs 15/15; dodate provjere da zasticene rute vracaju 401
  - izmjene su testirane (30/30 testova + e2e lanac) i treba ih sacuvati
  - korisnik: mislim da jako slabo koristis hibrid nasi robotici bi to trebali da uce najvise
  - PROBLEM NADJEN (korisnik bio u pravu): u core/config.js fastModel se citao iz NMQ_LLM_FAST_MODEL ali ga LLM sloj (src/llm/index.js) NIKAD nije koristio - svi pozivi su isli kroz glavni model (devstral:24b) pa su i trivijalni zadaci trosili veliki model i VRAM.

## SEO masina (Masina 01)
GEO, cron poslovi, baza, hibrid

- zapisa: 24 (od 2026-10-04 do 2026-10-04)
- **zadnje stanje:** PROGRAM ZAUSTAVLJEN
  - zasto: automatska provjera
  - rezultat: vise ne radi
- **lekcije:**
  - korisnik pita da li su Windows postavke dobre za 24/7 i da li treba jos nesto podesiti

## Knjigovodja Pro
Baza, fakture, klijenti, BizniSoft, kontni okvir

- zapisa: 16 (od 2026-10-04 do 2026-10-04)
- **zadnje stanje:** Postavljen automatski trigger za obuku robota + Python 3.12 + Unsloth
  - zasto: korisnik: mozes li to postaviti ali da krene kada budu podatci ubaceni u knjigovodju
  - rezultat: ANALIZA ROBOTA: nmq-robot v1.9.2 ima 4 prava mehanizma za napredovanje (svi u kodu): (1) learning/rewards.js - reward model od sirovih signala (feedback, odobrenja, ishodi, greske, eskalacije, trosak, trajanje) do ocjene 0-1 po run/agent/pattern/varijanta u rewards.jsonl; (2) learning/selfplay.js - Proposer generise scenario, Solver rjesava, Judge…
- **lekcije:**
  - provjera prije rada pokazala da je Faza B (Maja) vec razvijena
  - pokreni-roj.bat (roj za Maju) + workers/knjiga-biznissoft.js + bridge na 127.0.0.1:5055; ulaz E:\knjige\ulaz, provjera E:\knjige\za-proveru
  - treba napraviti bridge (Flask) da robot moze automatski da knjizi; do tada robot ne radi umjesto Maje
  - worker sada salje status pripremljeno (ne spremno_za_biznisoft); bridge dodaje fakturu u kontrolni_centar kao ceka_odobrenje; izvoz u outbox dozvoljen samo uz odobreno=true; provjereno: 1 task -> 1 faktura -> 1 stavka Ceka odobrenje (duplikat uklonjen)
  - dodato u .gitignore (.secrets.key, *.key, *.pem, *.db, *.sqlite); provjereno da nije vise kandidat; backup .gitignore.bak-20261004
  - Maja treba da zna tok: robot priprema, ona odobrava u Kontrolnoj sobi; i kako se pokrece

## Analitika (Masina 02)
Python motor, churn, revenue assurance, BYOK

- zapisa: 8 (od 2026-10-04 do 2026-10-04)
- **zadnje stanje:** SERVIS PAO
  - zasto: automatska provjera
  - rezultat: stanje: inactive
- **lekcije:**
  - korisnik: zar ona ne radi preko hertza analitiku kad uzmes kljuc

## Merenje i usteda
Tokeni, lokalno vs cloud, usteda, ruter

- zapisa: 11 (od 2026-10-04 do 2026-10-04)
- **zadnje stanje:** SVE SE MJERI U TOKENIMA - zajednicka jedinica lokalno vs cloud
  - zasto: korisnik: da merimo sve po tokenima sta mislis
  - rezultat: ODGOVOR: da - tokeni su jedina zajednicka jedinica (sekunde i slike se ne mogu porediti sa mojim tokenima); IMPLEMENTIRANO u dsh-tabla.mjs: (1) LOKALNO tekst - iz ruter-log.jsonl (tacni tokeni) + ostatak Ollama poziva x 1100 tok (prosjek 800 ulaz + 300 izlaz); (2) LOKALNO vision - iz lokalni-rad.jsonl (tok_in + tok_out iz Ollama usage); (3) LOKALN…

## VPS (rezerva, ugaseno)
Prenosimo sve lokalno, VPS je hladna rezerva

- zapisa: 4 (od 2026-10-04 do 2026-10-04)
- **zadnje stanje:** Ugaseno SVE nase sto je trošilo: cron, timeri, PM2, backup, 13 GB diska
  - zasto: korisnik: jesi sve sto trose eliminisao
  - rezultat: UGASENO SVE NASE: (1) CRON - svih 6 poslova komentarisano (check-bank-guard 04:45, chown svaka 2h, daily-check 06:15, oaa.mirror_agent_citation x3 u 06:30/06:45/18:00), backup /root/crontab.backup-20261004-203939; (2) TIMERI - ugaseno i disable-ovano 7: braincore-scrape (radio SVAKE MINUTE), braincore-alert (SVAKE MINUTE), prometheus-node-exporter…

## Tunel (cloudflared)
Javni pristup sa nase masine

- zapisa: 5 (od 2026-10-04 do 2026-10-04)
- **zadnje stanje:** SERVIS PAO
  - zasto: automatska provjera
  - rezultat: stanje: inactive

## Braincore domen
Cloudflare zona, NS, poddomene

- zapisa: 18 (od 2026-10-04 do 2026-10-04)
- **zadnje stanje:** NS propagirali - poddomene presle na nasu masinu
  - zasto: automatski nadzor NMQ-Braincore-NS-Check
  - rezultat: Cloudflare zona: active; na nasoj masini: 3/3; {api.braincore.pro:{status:200,gdje:NAS ROBOT ✓},live.braincore.pro:{status:200,gdje:NAS ROBOT ✓},accountflow.braincore.pro:{status:200,gdje:NAS ACCOUNTFLOW ✓},braincore.pro (sajt):{status:200,gdje:HOSTINGER (sajt)}}
- **lekcije:**
  - Zato je Majin program uvijek dobijao praznu listu (33 B).
  - Rjesenje: zaustavljeni nasi procesi i mobil.enabled=false u oba naseg config.yaml (accountflow + APPDATA, backup .bak-20261004), paket ponovo poslat.
  - Sifra 'maja' postavljena na MAJA79 u obje nase baze, provjereno verify_password; dodat POSTAVI-SIFRU.bat/.py (radi lokalno, bez interneta, trazi bazu u svim profilima).
  - Maja ne moze da se prijavi (pogresna sifra) i primjedba da su stavke lijevog menija presitne; korisnik trazi da se sve staro obrise i da dobije novi ZIP sa novom prijavom
  - CISTA-BAZA: knjigovodja.db samo sa korisnikom maja (sifra MAJA79, provjereno verify_password) bez klijenata/faktura.
  - Korisnik trazi: (1) da program radi preko njegovog DeepSeek kljuca, (2) dugme refresh/update, (3) dugme Nazad jer se gubi u programu, (4) da Maja jednim klikom pusti udaljenu pomoc

## KLJUCNE CINJENICE (portovi, sati, cijene)
- LOKALNI SERVISI: Masina 01 GEO = port 3020 (seo-operator-os); Masina 02 Analitika = port 3010 (oaa-trial, Python motor); Masina 03 Braincore = port 8081 (nmq-robot), swarm 8001/8002/8003, bridge 5055.
- OSTALO: mobil upload 3001, accountflow statika 3002, Agent Studio 3101, Ollama 11434, Grafana 3030 (ugasena).
- PEAK SATI (DeepSeek naplacuje DUPLO): 01-04h i 06-10h UTC = 03-06h i 08-12h srpski (Europe/Belgrade).
- OFF-PEAK: 16:30-00:30 UTC = 18:30-02:30 srpski. VIKENDOM je UVIJEK off-peak.
- CIJENE deepseek-flash (off-peak): cache hit 0,003 USD/M, cache miss 0,15 USD/M, izlaz 0,60 USD/M. Peak (duplo): 0,006 / 0,30 / 1,20 USD po milionu.
- NAPLATA: Creem (Merchant of Record). Proizvodi: $19 citation (prod_3AhLpEZvSL4cEJllzRKHyz), $149 STARTER (prod_30VCb97YdCjv27osjlOJeJ), $249 GROWTH (prod_6D2IKZrzSCBukDhJLxf2Lp), $499 OVERLORD (prod_3Mk7tHz3MUHpD0ny3RNM47), $999 AGENCY (prod_6EQOd9A2l55NduIB1TzV3m).
- WEBHOOK: https://api.aicommandcenter.pro/api/webhooks/creem (trazi potpis, raw body).
- TUNEL: cloudflared, tunel ID c1298084-3a43-4d53-bd57-37a22dcad597 (ime nmq-machine-api).
- MASINA: RTX 5060 Ti 16 GB, Ryzen, 32 GB RAM, Windows. Ollama modeli na H:\AI-MODELI\ollama.
- MODELI: devstral:24b (glavni/agentic), gemma3:4b (fast/klasifikacija), qwen2.5-coder:14b (kod), gemma3:12b (SEO), qwen2.5vl:7b (slike), bge-m3 (embeddings), deepseek-r1:14b (rezonovanje).

## Arhitektura (odluka 04.10.2026)
Sve tri masine rade LOKALNO na nasoj masini, VPS je hladna rezerva:
- Masina 01 GEO: seo-operator-os, port 3020, cron (Own-sites 18:00, GEO light 09:00, KeyGuardian 06:10)
- Masina 02 Analitika: oaa-trial, port 3010, Python motor oaa.machine_bridge (30 konektora, 27 akcija)
- Masina 03 Braincore: nmq-robot, port 8081, swarm 8001/8002/8003, bridge 5055
- Javni pristup: Cloudflare tunel (c1298084-...), api.aicommandcenter.pro i api/live/accountflow.braincore.pro
- Naplata: Creem (5 proizvoda: $19 citation, $149/$249/$499/$999), webhook /api/webhooks/creem
- Ostatak: mobil upload 3001, accountflow statika 3002, Agent Studio 3101, Ollama 11434

## Procedure (kako se radi)
- Restart robota: powershell -File E:\NMQ-PROGRAMI\nmq-robot\pokreni-robota.ps1 (idempotentna, 1 s)
- Braincore lokalno: pokreni-braincore.ps1 (mobil + accountflow + robot)
- OAA analitika: pokreni-oaa.ps1 (start/stop)
- Provera NS: node provjeri-braincore-ns.mjs (task svakih 15 min)
- PEAK provjera: node peak-gate.mjs (off-peak = smije cloud)
- Sazimanje prije slanja: node sazmi.mjs <fajl> (do 99,6% manje tokena)
- Dnevnik: brain-log.ps1 -Target -Action -Why -Result -Tag agent
- Audit: brain-audit.ps1 (mora biti POKRIVENO)

## Lekcije koje su nas skupo kostale
- Windows: task sa akcijom koja pokazuje na nepostojecu putanju PADA tiho — provjeri putanju.
- PowerShell 5.1: Sort-Object na [ordered]@{} ne radi; koristi -Property { $_["kljuc"] }.
- Start-Process sa -RedirectStandardOutput ostavlja handle otvoren — dodaj exit 0 na kraj skripte.
- .mjs ne moze require() — koristi import ili .cjs.
- Windows tar ne raspakiva cist .gz — koristi Node zlib.gunzipSync.
- Cloudflare API token bez zone.create ne moze dodati zonu (403) — treba Global API Key (cfk_ format).
- Hostinger API ne mijenja nameservere preko PATCH/POST — samo PUT sa ns1/ns2.
- Ollama app.exe ignorise OLLAMA_MODELS env — koristi ollama.exe serve sa env.
- Node patch skripte: $ u template stringu se interpolira — pazi kad pises patcheve.
