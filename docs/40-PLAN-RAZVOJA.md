# 40 — PLAN RAZVOJA BRAINCORE PRO mašine (živi dokument)

> Ovaj fajl je **radni plan** za mašinu (swarm + API + live + sajt). Kad se nastavlja rad — počinje se odavde.
> Pravilo: svaka stavka je „završena" tek kad ima **dokaz** (test, izmjeren broj, screenshot ili dokument).
> Statusi su iskreni: **STVARNO** / **DJELIMIČNO** / **NE RADIMO** — nikad uljepšavanje.

Stanje na dan pisanja (v0.7.1): `node --test` **240/240**, eval 6/6 (mock LLM), smoke 42/42, demo 27 sekcija,
discovery 3 node-a **34–42 ms**, pheromone TTL 30 s, `dependencies: {}`, git tagovi v0.1.0 → v0.7.1.

---

## 1. Gdje smo sada (iskreno)

| Sloj | Status | Dokaz | Rupa koju znamo |
|---|---|---|---|
| Communication (UDP gossip) | STVARNO | `tests/3-nodes.test.mjs`, 42 ms discovery | nema WireGuard/mTLS; fanout je fiksan na 2 |
| Coordination (CRDT + queue + pheromone) | STVARNO | konvergencija + TTL testovi | tombstone-i rastu; nema kompakcije; nema fencing tokena |
| Cross-node izvršavanje | STVARNO | task iz A izvršava B | pod mrežnom particijom claim se može podijeliti (split-brain) |
| Federacija genoma | STVARNO (metrike), DJELIMIČNO (učenje) | `src/research/*`, testovi | nema statističke značajnosti; nema realnog A/B sa ljudima |
| Klasteri support/research/execution | STVARNO | `src/clusters/*` + testovi | kvalitet rutiranja nije izmjeren na realnim ticketima |
| API + live | STVARNO | `tests/braincore.test.mjs`, WS handshake po spec vektoru | nema autentikacije za live; nema per-key limita |
| LLM kvalitet | **DJELIMIČNO / mock** | eval 6/6 na mock modelu | **nema mjerenja na pravom modelu** — ovo je najveća rupa |
| Ops (CI, monitoring, rollback) | **NE RADIMO** | — | nema CI, nema Prometheus formata, nema staging-a |
| Sajt + pozicioniranje | STVARNO | `site/`, screenshotovi | nema self-serve onboarding-a, nema video materijala |

**Zaključak:** mašina *radi* i to je dokazano. Ono što sada određuje vrijednost nije još jedan sloj arhitekture,
nego: (a) **dokaz kvaliteta na pravom modelu**, (b) **izdržljivost pod kvarom**, (c) **operativna zrelost**.
Zato su prva tri prioriteta iz tih oblasti, a ne „emergentni jezik".

---

## 2. Četiri kolosijeka (svaki tjedan po jedan korak iz svakog)

| # | Kolosijek | Cilj | Zašto sada |
|---|---|---|---|
| **A** | Pouzdanost | sistem preživi kvar, particiju i ponovni task bez duplog izvršenja | kupac prvo pita „šta ako node padne" |
| **B** | Sigurnost i ops | TLS/WireGuard, rotacija ključeva, CI, monitoring, rollback | bez ovoga nema ozbiljnog kupca u EU/US |
| **C** | Kvalitet (proizvod) | mjerljivo bolje odgovore na realnim modelu i realnim ticketima | ovdje je novac: „vaš support je 30 % brži" |
| **D** | Skaliranje i moat | 10–50 node-ova, kompakcija table, benchmark brojevi, RSI sa kapijama | priprema za veće klijente i za fazu $1M |

---

## 3. Plan za 90 dana (po sprintovima od 1 tjedna)

### Sprint 1 — „Istina o kvalitetu" (kolosijek C, najveći povrat)
1. `NMQ_LLM_API_KEY` (DeepSeek) + `scripts/eval.mjs` protiv **pravog** modela; 20–30 zlatnih slučajeva
   (support ticketi: refund, billing, tehnički, e-commerce; + 5 „ne smije odgovoriti" slučajeva).
2. Zapis rezultata u `data/_control/eval-history.json` + tabela po verzijama (regresija se vidi odmah).
3. **Dokaz:** `eval X/Y = Z %` na pravom modelu, upisano u `docs/41-EVAL-REZULTATI.md` sa datumom i modelom.
4. Rupa koju zatvaramo: „eval je 6/6" više ne smije biti rečenica bez modela i datuma.

### Sprint 2 — „Kvar nije iznenađenje" (kolosijek A)
0. **Poznati flake (viđen 30.09.)**: `tests/server.test.mjs` → „per-agent ključ (service account) radi kroz HTTP
   gateway" je pao jednom dok su paralelno radila 3 demo node-a + API; dva naredna puna prolaza su 240/240.
   Zadatak: naći uzrok (vjerovatno zauzet port ili vremenska zavisnost), popraviti i dodati u CI kao „mora 3×
   zaredom zeleno" da flake ne prolazi ispod radara.
1. `scripts/chaos.mjs`: 3 node-a + load; ubij jedan (`SIGKILL`), mjeri: vrijeme detekcije, vrijeme re-claim-a,
   broj izgubljenih taskova (cilj **0**), broj duplo izvršenih (cilj **0**).
2. **Idempotency key** na tasku + `fencing token` na claim-u (monotoni brojač po tasku) → duplo izvršenje
   nemoguće i pod particijom; test sa simuliranim cijepanjem mreže (blokiraj UDP između dva node-a).
3. **Soak test** 1 h (10 taskova/s): memorija, `crdtSize`, `peersAlive`, latencije p50/p95/p99 u zapisnik.
4. **Dokaz:** `docs/42-CHAOS-REZULTATI.md` sa brojevima prije/poslije.

### Sprint 3 — „Zid oko mašine" (kolosijek B)
1. **WireGuard** između node-ova (upute + skripta); gossip i queue slušaju samo na `wg0`.
2. **Rotacija ključa** bez prekida: `NMQ_CLUSTER_SECRET` + `NMQ_CLUSTER_SECRET_PREV` (prijem potpisa oba ključa
   tokom prozora rotacije) + test.
3. **Per-key rate limit i metering**: brojač agent-sati po ključu (tačan, provjerljiv), limit po ključu.
4. **Dokaz:** testovi rotacije i limita + mjerenje potrošnje za jedan simulirani dan.

### Sprint 4 — „Ops koji se ne vidi" (kolosijek B)
1. **CI (GitHub Actions)**: `node --test`, `eval --threshold`, `smoke`, `audit-verify` na svaki push; badge u README.
2. **Prometheus format** na `/metrics` (`text/plain; version=0.0.4`) + `deploy/grafana-dashboard.json`.
3. **Alerti** (peersAlive < N-1, `gossip.rejected` skok, `rateLimited`, `tasksDone` stagnira 10 min) — kao systemd
   timer skripta koja šalje mail/webhook (bez npm).
4. **Deploy sa rollback-om**: `deploy/release.sh` (verzija u `/opt/braincore/releases/<tag>`, symlink `current`,
   `systemctl restart`, i `rollback.sh`); + **staging** na istom boxu (drugi portovi + drugi tenant).
5. **Dokaz:** zeleni CI link + screenshot Grafane + probni rollback (vrijeme povratka u sekundama).

### Sprint 5 — „Skaliranje sa brojevima" (kolosijek D)
1. `scripts/bench.mjs`: 1 / 3 / 10 / 25 node-ova (u procesu), mjeri: taskova/s, gossip poruka/s, CPU, RAM,
   p95 latenciju; tabela u `docs/43-BENCHMARK.md`.
2. **Kompakcija table**: GC tombstone-a starijih od `compactionAgeMs`, sa dokazom da konvergencija ostaje tačna.
3. **Adaptivni fanout**: fanout = f(broj živih čvorova), sa testom da discovery ostaje < 2 s na 25 node-ova.
4. **Dokaz:** brojevi + testovi kompakcije.

### Sprint 6 — „Kvalitet kao proizvod" (kolosijek C)
1. Izmjeriti kvalitet po klasteru: tačnost rutiranja ticketa (zlatni set ≥ 50), tačnost extractora (precizija/odziv).
2. **Genome A/B sa statistikom**: odluka o pobjedniku samo ako je razlika značajna (npr. Wilson interval), inače
   „nema odluke" — nikad promocija na osnovu šuma.
3. **Tenant dashboard** (jednostavna HTML stranica iz `data/`): taskovi, kvalitet, trošak, incidenti.
4. **Dokaz:** tabela kvaliteta po klasteru + primjer A/B odluke sa intervalom pouzdanosti.

### Sprint 7 — „Prodaja bez laži" (kolosijek C/D)
1. Self-serve onboarding: ključ po tenant-u, kvota, „prvih 14 dana" tok (kad bude Stripe nalog — Payment Link).
2. **Case study** sa izmjerenim brojevima (vrijeme odgovora prije/poslije na našem demo tenant-u).
3. Video (2 min): tri node-a se nađu, task prelazi, feromon ispari, live prikaz.
4. **Dokaz:** stranica `braincore.pro/case-study` + video + onboarding test (novi tenant prođe bez naše ruke).

### Sprint 8+ — dublji moat (odloženo, ali zapisano)
- Emergence sloj „kako treba": specijalizacija mjerena, formiranje kohorti, dokaz na bench-u.
- RSI R1–R3: predlog → dokaz na zlatnom setu → **ljudsko odobrenje** → mjerenje poslije promjene.
- Detektori (koluzija, skriveni kanal) sa testovima; „crveni tim" vježba.
- Postgres/pgvector za memoriju na skali; NATS u produkciji umjesto Redis liste (uz test).
- Višejezičnost (EN primarni), SOC 2 priprema (politike, dokazi), pen-test.

---

## 4. Kako radimo (ritam i disciplina)

1. **Jedan tjedan = jedan sprint** iz tabele iznad; na kraju sprinta: tag (`v0.x.y`), unos u `docs/DECISIONS.md`,
   i kratak izvještaj sa brojevima (prije/poslije).
2. **Definition of Done** za svaku stavku: (a) kod, (b) test koji pada bez promjene, (c) dokument sa dokazom,
   (d) nula novih npm zavisnosti — ako nešto traži paket, prvo se pita „može li built-in".
3. **Nikad ne tvrdimo broj bez mjerenja.** Ako nema mjerenja, piše „nije izmjereno".
4. **Sigurnosna pravila ostaju:** backup prije deploy-a, `.env` nikad u git, tajne samo imenom u izvještaju.
5. **Redoslijed prioriteta pri sukobu:** sigurnost > tačnost podataka > pouzdanost > brzina > ljepota.

### Komande koje se koriste svaki dan

```bash
node --test                       # 240/240 (mora ostati zeleno)
node scripts/eval.mjs             # kvalitet (sada mock → Sprint 1: pravi model)
node scripts/smoke.mjs            # 42 provjere kroz sve slojeve
node scripts/demo.mjs             # 27 sekcija, uključujući 3-node swarm
node src/cli.js audit-verify      # lanac audita
node src/index.js --port=8001 --api-port=8081   # mašina lokalno
```

---

## 5. Metrike uspjeha (ono što gledamo svaki tjedan)

| Metrika | Sada | Cilj za 90 dana |
|---|---|---|
| Eval na pravom modelu | nije izmjereno | ≥ 85 % na ≥ 20 slučajeva, sa istorijom |
| Duplo izvršeni taskovi pod kvarom | nepoznato | **0** (dokazano chaos testom) |
| Izgubljeni taskovi pri `SIGKILL` node-a | nepoznato | **0** |
| Discovery (3 node-a, p95) | 34–42 ms | < 200 ms na 25 node-ova |
| Taskova/s po node-u | nije izmjereno | ≥ 50 (izmjereno) |
| Vrijeme rollback-a deploy-a | ne postoji | < 60 s |
| Prekršeni budžet (tenant) | 0 (politika) | 0 i dokazano meteringom |
| Vrijeme odgovora na incident | nema procesa | runbook + < 30 min do prvog odgovora |

---

## 6. Rizici (i šta radimo s njima)

| Rizik | Vjerovatnoća | Udar | Odgovor |
|---|---|---|---|
| Split-brain claim pod particijom → duplo izvršenje | srednja | visok (novac/dupli mailovi) | fencing token + idempotency key (Sprint 2) |
| Eval na mock modelu stvori lažnu sigurnost | **visoka** | visok (prodaja na pogrešnim brojevima) | Sprint 1: pravi model, istorija rezultata |
| Nema TLS-a između node-ova | srednja | visok (prisluškivanje u datacentru) | WireGuard (Sprint 3), pa mTLS |
| Rast CRDT table (tombstone-i) | srednja | srednji (RAM) | kompakcija + soak test (Sprint 2 i 5) |
| „Emergentna inteligencija" ostane marketinška fraza | srednja | srednji (kredibilitet) | mjerena specijalizacija ili je ne prodajemo |
| Zavisnost od jednog čovjeka (bus factor) | **visoka** | visok | ovaj plan + runbook + CI + „sve kroz testove" |
| Cijena LLM poziva pojede maržu | srednja | srednji | mjerenje troška po tasku + budžeti po tenant-u |

---

## 7. Šta tražim od tebe (odluke/pristup)

1. **DeepSeek ključ za eval** — Sprint 1 ne može bez njega (imam pristup store-u, samo potvrdi da smijem
   trošiti na eval, npr. ~1–2 $ za 30 slučajeva).
2. **Deploy na Hetzner** (da/ne) — kad kažeš „kreni", instaliram i pustim prijemni test.
3. **WireGuard na Hetzneru** (Sprint 3) — treba mi potvrda da smijem dirati mrežnu konfiguraciju boxa.
4. **Domen/mailboxi** — `sales@` i `privacy@braincore.pro` moraju postojati prije javnog sajta.
5. **Prioritet** — ako želiš drugačiji redoslijed (npr. prvo sajt i prodaja, pa pouzdanost), reci i prepisujem plan.

---

## 8. Prva tri konkretna zadatka (mogu odmah, bez tvog pristupa)

1. **`scripts/chaos.mjs`** — 3 node-a, ubijanje čvora pod load-om, mjerenje izgubljenih/duplih taskova.
   (Sprint 2, ali ga mogu napisati prije ešalona jer ne traži ništa od tebe.)
2. **Fencing token + idempotency key** na claim-u, sa testom koji simulira particiju (blokiran UDP između dva
   node-a) — zatvara najozbiljniju tehničku rupu.
3. **Kompakcija CRDT table** (GC tombstone-a) + test da konvergencija ostaje tačna i fingerprint stabilan.

Ako kažeš „kreni po planu", radim tim redom i svaki zadatak završavam sa testom + brojevima u ovom fajlu.
