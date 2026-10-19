# USTEDA TOKENA — znanje za robota

## sazmi.mjs — sazimanje prije slanja
- sazmi.mjs sažima fajlove LOKALNO (Ollama) prije nego ih agent procita.
- Izmereno: server.js 37.578 tokena -> 148 tokena (99,6% manje).
- Izmereno: DNEVNIK-RADA.md 6.720 -> 533 tokena (92,1% manje).
- Flagovi: --struktura, --nadji "X", --greske, --uporedi F2, --tekst, --max, --model.
- Veliki fajlovi se automatski dijele na dijelove pa sažimaju.
- Usteda u novcu: agent na cloudu bi platio ~$0.01-0.05 po velikom fajlu; lokalno $0.

## ruter-mapa.mjs — izbor modela po tipu zadatka
- ruter-mapa.mjs je jedini izvor istine za rutiranje (11 regex pravila, 26 tipova zadataka).
- Redosled pravila je bitan: vision -> embeddings -> SQL/kod -> veliki kod -> mali kod
- -> rezonovanje/PDV -> agentic -> objasnjenje -> SEO -> kreativno -> brzo.
- Modeli: gemma3:4b (0,3-2s, klasifikacija), gemma3:12b (SEO), devstral:24b (agentic),
- qwen2.5-coder:14b (kod), qwen3-coder:30b (tezak kod), deepseek-r1:14b (rezonovanje),
- qwen2.5vl:7b (slike), bge-m3 (embeddings), gpt-oss:20b (objasnjenja).
- Rutiranje je testirano 8/8 + 18/18 (100% tacnost).
- isti zadatak na localu = $0; na DeepSeek-u = $0.0002-0.05.

## PEAK sati — DeepSeek naplacuje duplo
- DeepSeek PEAK: 01-04h i 06-10h UTC = 03-06h i 08-12h srpski (Europe/Belgrade).
- U PEAK-u je cijena DUPLA — isti posao kosta 2x.
- Vikendom je uvijek off-peak (jeftinije).
- Off-peak: 16:30-00:30 UTC = 18:30-02:30 srpski.
- dsh-upozorenja.mjs javlja 15 min prije PEAK-a i na promjenu stanja.
- Radnja: odlozi cloud pozive za off-peak ili ih uradi lokalno.

## Hibrid — lokalno prvo
- lib/llmFetch.js: lokalni Ollama prvo, DeepSeek SAMO ako lokalni padne.
- NMQ_LLM_HIBRID=1 (default) dozvoljava fallback; NMQ_FALLBACK_MAX_PER_DAY=100 ogranicava.
- Svaki fallback se loguje u data/llm-fallback.log + llm-fallback-count.json.
- USE_OLLAMA=true ukljucuje lokalni; OLLAMA_MODEL=devstral:24b je glavni.
- U robotu: chat({fast:true}) koristi gemma3:4b za klasifikaciju/rutiranje/sumiranje.
- Svaki LLM poziv se loguje u llm-usage.jsonl (provider, model, ms, tokeni).

## Kes — isti prompt, nula tokena
- llm/index.js ima kes do 200 odgovora (kljuc = tenant + model + messages + alati).
- Ponovljeni identican poziv vraca kesiran odgovor — 0 tokena, 0 ms.
- tenantId je u kljucu da odgovor jednog klijenta ne pobjegne drugom.
- Metrika llm_cache_hits_total pokazuje koliko je poziva izbjegnuto.

## Merenje — bez njega nema ustede
- dsh-tabla.mjs meri SVE u tokenima: lokalno (tekst + vision + slike) vs cloud.
- Slike: 1 slika = 66.667 tokena ekvivalenta (DALL-E $0.04 / $0.60 po 1M).
- Reset brojaca: data/pracenje-od.txt + data/cloud-reset.json.
- Realan rezultat: 92% troska dolazi od zahtjeva sa >128k konteksta.
- Projekcija: sazmi.mjs -36%, ruter.mjs -4% = ukupno -40% troska.
- Preostalih 60% je planiranje/kod/odluke koje samo agent moze — tu se ne stedi, tu se RADI.

## Kontekst — najveci trosak
- 92% troska dolazi od poziva sa kontekstom vecim od 128k tokena.
- Zato: NIKAD ne slati cijeli fajl — posalji sazetak (sazmi.mjs) ili samo dio (--nadji).
- Za pretragu po kodu koristi grep/semantic_search (bge-m3 lokalno) umjesto citanja svega.
- Raspored: procitaj strukturu -> nadji relevantno -> sazmi -> tek onda salji modelu.

## Kada IPAK mora cloud
- Cloud je opravdan za: arhitekturu, teske odluke, debugging koji lokalni ne moze,
- pisanje novog koda gdje lokalni model grijesi, i finalnu verifikaciju.
- Sve ostalo (klasifikacija, rutiranje, sazimanje, SEO tekst, prevod, formatiranje) ide lokalno.
- Pravilo: ako je zadatak deterministican ili kratak — lokalno. Ako trazi rezonovanje preko
- vise koraka sa velikim kontekstom — prvo sazmi, pa odluci da li cloud.

## STVARNI PODACI — 5 dana rada (29.09 - 04.10.2026)
- Ukupno 12.581 zahtjeva u 5 dana.
- Ulazni tokeni: 21.9M · Izlazni: 11.4M.
- CACHE READ: 4.5 MILIJARDE tokena — cache hit kosta $0.003/M,
- a cache miss $0.15/M. To je 50x jeftinije. Zato: isti kontekst vise puta = ogromna usteda.
- Najveci dan: 03.10 sa 6.985 zahtjeva ($13,68 off-peak / $27,37 peak).
- Drugi dan: 04.10 sa 3.406 zahtjeva ($6,75 / $13,50). Ti dani su 87% ukupnog troska.
- UKUPNO: $23,62 off-peak | $47,24 peak | realno ~$35.43.
- ZAKLJUCAK: peak sati bi DUPLO povecali trosak. Rad van peak-a (ili lokalno) je najveca poluga.
- ZAKLJUCAK: 4,5 milijardi cache-read tokena znaci da se isti kontekst salje stalno —
- zato sazimanje i kesiranje daju najvecu ustedu.
- Cijene (deepseek-flash): off-peak cache hit $0.003/M, miss $0.15/M, izlaz $0.60/M;
- peak: hit $0.006/M, miss $0.30/M, izlaz $1.20/M.

## Scenariji (pitanje -> optimalna radnja)

**Treba mi da procitam server.js od 37 hiljada tokena i nadjem gdje se placa DeepSeek.**

Pokreni sazmi.mjs --nadji "deepseek" server.js. To lokalno sazme fajl na ~150 tokena (99,6% manje) prije nego ga posaljes modelu. Nikad ne salji cijeli fajl od 37k tokena.

**Imam 50 fajlova da analiziram, sve na DeepSeek-u.**

Ne. Prvo sazmi.mjs na svih 50 lokalno (Ollama, $0). Zatim posalji sazetke (par stotina tokena) modelu. Usteda ~95-99%. Ako je i dalje veliko, koristi semantic_search (bge-m3 lokalno) da nadjes samo relevantne dijelove.

**Kako da znam da li je sada skupo zvati DeepSeek?**

Provjeri PEAK: 03-06h i 08-12h srpski = DUPLA cijena. Vikendom je uvijek off-peak. dsh-upozorenja.mjs javlja 15 min prije. Ako je PEAK, odlozi cloud poziv ili uradi lokalno.

**Trebam klasifikovati 200 emailova u kategorije.**

Ovo je deterministicno i kratko -> chat({fast:true}) sa gemma3:4b lokalno. 0 tokena na DeepSeek-u. 200 emailova = par minuta na kartici.

**Trebam napisati kompleksnu SQL migraciju sa transakcijama.**

Ovo trazi rezonovanje -> lokalno prvo sa qwen2.5-coder:14b (ruter-mapa: SQL/kod pravilo). Ako lokalni ne uspije (provjeri odgovor), tek onda cloud — i to u off-peak.

**Isti prompt saljem 10 puta dnevno.**

Kes u llm/index.js (200 odgovora, kljuc = tenant+model+messages+alati) vraca isti odgovor bez tokena. Provjeri llm_cache_hits_total da vidis koliko je izbjegnuto.

**Kako da smanjim trosak za 40%?**

Tri stvari: (1) sazmi.mjs prije svakog citanja velikih fajlova (-36%), (2) ruter.mjs da svaki zadatak ide na najmanji model koji ga moze odraditi (-4%), (3) izbjegavaj PEAK sate. Preostalih ~60% je planiranje/kod gdje se ne stedi — tu se radi.

**Da li da ugasim Ollama da ustedim struju?**

Ne. Ollama na kartici je $0 po pozivu. Struja za par sati rada je manja od jednog cloud poziva sa velikim kontekstom. Ollama je izvor ustede, ne trosak.

**Model mi daje predugacke odgovore i trosi izlazne tokene.**

Ograniči maxTokens (ruter koristi 200 za rutiranje, 400 za sazimanje). Dodaj u system prompt: "Odgovori u najvise N recenica." Izlazni tokeni su 4x skuplji od ulaznih ($0.60 vs $0.15 po 1M).

**Koliko sam potrosio za 5 dana i gdje je otislo najvise?**

Za 5 dana (29.09-04.10.2026): 12.581 zahtjev, 21,9M ulaznih i 11,4M izlaznih tokena. Off-peak $23,62, peak $47,24, realno ~$35,43. Najvise je otislo na 03.10 (6.985 zahtjeva, $13,68) i 04.10 (3.406 zahtjeva, $6,75) — ta dva dana su 87% troska. Cache read je 4,5 milijardi tokena sto je 50x jeftinije od cache miss ($0,003 vs $0,15/M).

**Zasto mi je racun duplo veci od ocekivanog?**

Provjeri PEAK sate: 03-06h i 08-12h srpski = DUPLA cijena. Za 5 dana: off-peak bi bilo $23,62, peak $47,24 — razlika $23,62. Rjesenje: cloud pozive radi van peak-a (18:30-02:30 srpski) ili lokalno na kartici ($0).

**Sta mi najvise trosi tokene?**

Cache miss i veliki kontekst. 92% troska dolazi od zahtjeva sa kontekstom >128k tokena. Rjesenje: sazmi.mjs prije slanja (server.js 37.578 -> 148 tokena = 99,6% manje). Drugo: cache hit je 50x jeftiniji, pa isti kontekst ne treba slati ponovo — kesiraj.

**Kako da iskoristim to sto imam 4,5 milijardi cache read tokena?**

To znaci da stalno saljes ISTI kontekst. Iskoristi to: (1) drzi stabilan prefiks poruka (system prompt + pravila) da cache pogadja; (2) ne mijenjaj pocetak razgovora; (3) sazmi velike fajlove prije nego udju u kontekst. Cache hit $0,003/M vs miss $0,15/M = 50x usteda.

**Imam 12.581 zahtjev u 5 dana. Kako da to smanjim?**

Tri poluge: (1) 87% troska je u 2 dana (03.10 i 04.10) — tada je radio veliki posao; podijeli ga na manje sesije sa sazimanjem; (2) prebaci klasifikaciju/rutiranje/sumiranje na fast model lokalno (gemma3:4b, 6x brze, $0); (3) izbjegavaj peak sate (duplo skuplje). Projekcija: -40% troska.

**Daj mi konkretan plan za sledecu nedelju da potrosim manje.**

Plan: (1) SVEE velike fajlove prvo sazmi lokalno (sazmi.mjs) — usteda do 99%; (2) klasifikacija/rutiranje/sumiranje -> fast model (gemma3:4b) lokalno; (3) kod -> qwen2.5-coder:14b lokalno; (4) cloud samo za arhitekturu i teske odluke; (5) cloud pozive SAMO van peak-a (18:30-02:30); (6) drzi stabilan prefiks za cache hit. Cilj: sa ~$7/dan na <$2/dan.

**Koliko bih ustedeo da sam sve radio lokalno?**

Od 12.581 zahtjeva, velika vecina su klasifikacija, rutiranje, sazimanje i SEO tekst — sve to fast model (gemma3:4b) i glavni (devstral:24b) rade lokalno za $0. Ostaje cloud samo za kompleksno planiranje i debugging. Realna procjena: 60-80% troska bi bilo izbjegnuto, tj. sa $35,43 na $7-14 za isti period.

