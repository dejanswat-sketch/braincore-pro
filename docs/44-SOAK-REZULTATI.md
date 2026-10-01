# 44 — SOAK REZULTATI (dugotrajno opterećenje)

> Harness: [`scripts/soak.mjs`](../scripts/soak.mjs). Mjeri: propusnost, latenciju **p50/p95/p99**, izgubljene,
> duplo izvršene, memoriju (heap start/kraj/vrh), rast CRDT-a, feromone, gossip statistiku i **restart čvora
> pod opterećenjem**. Rezultat u `docs/soak-<ts>.json`, trend u `data/_control/soak-history.json`.

**Domen mjerenja (iskreno):** jedna mašina, 3 node-a u **jednom procesu**, loopback. Mrežna particija i pravi
multi-host se mjere posebno (chaos F6/F11). Zato su ovi brojevi **gornja granica jednog procesa**, ne kapacitet
cijelog klastera.

## 1. Kako se pušta

```bash
node scripts/soak.mjs --minutes=2                         # kratka provjera
node scripts/soak.mjs --minutes=60 --rate=8 --restart-every=600   # prijemni test (1 h)
```

Kriteriji prihvatanja: `izgubljeno = 0`, `duplo izvršeno = 0`, `p95 ≤ --p95-budget` (default 1500 ms),
memorija stabilna (rast heapa < 150 MB).

## 2. Prvi runovi i šta su našli

| Run | Trajanje / cilj | Propušteno | Latency p50 / p95 / p99 | Izgubljeno | Duplo | Nalaz |
|---|---|---|---|---|---|---|
| 1 | 0,5 min / 15 t/s | 12,4 t/s | 770 / **9197** / 11568 ms | 0 ✔ | **19** ✖ | **Rate limit je gušio PING/ACK** → lažne smrti čvorova → lažno preuzimanje tuđih taskova |
| 2 | 1 min / 10 t/s | 8,9 t/s | 755 / **1838** / 5063 ms | 0 ✔ | **12** ✖ | Isto: pri zasićenju event loop-a PING/ACK kasne → `member_status dead` → dupliran rad |
| 3 | 1 min / 8 t/s | 7,5 t/s | 754 / **779** / 786 ms | **0** ✔ | **0** ✔ | Poslije obje popravke: **bez lažnih smrti**, p95 u budžetu, nula duplih |

## 3. Popravke koje je soak iznudio (obje su u `src/gossip.js`)

| # | Problem | Uzrok | Popravka |
|---|---|---|---|
| 1 | Membership poruke su bile odbacivane pod opterećenjem | `maxInboundPerMin` (1200) se primjenjivao na SVE poruke, uključujući PING/ACK | Rate limit sada važi **samo za „teretne" tipove** (DISSEMINATE i sl.); `PING/ACK/PING_REQ/LEAVE` su **izuzeti**; limit podignut na 3000/min |
| 2 | Čvorovi su jedan drugom izgledali mrtvi kad su zauzeti | Pri ~10 t/s event loop kasni, pa `misses` naraste dok je čvor živ | **Load-aware failure detection**: ako je ovaj čvor zauzet (`load ≥ 2`), prag `deadAfter` raste (do +3 promašaja); uz to je osnovni prag podignut sa 2 na **3 promašaja** |

Oba nalaza su bila **stvarna i ozbiljna**: prvi je pravio lažne smrti, drugi dupliran rad. Bez soak-a se ne bi
vidjeli — chaos test (kratki, sa `SIGKILL`) ih nije uhvatio jer nije držao trajno opterećenje.

## 4. Kapacitet jednog procesa (izmjereno, ne procijenjeno)

| Cilj opterećenja | Postignuto | p95 | Duplo | Zaključak |
|---|---|---|---|---|
| 15 t/s | 12,4 t/s | 9,2 s | 19 | iznad kapaciteta → red raste, p95 eksplodira |
| 10 t/s | 8,9 t/s | 1,8 s | 12 | na granici |
| 8 t/s | 7,5 t/s | 0,78 s | 0 | **održivo** (runner 120 ms, 3 node-a u jednom procesu) |

**Iskren zaključak:** jedan proces sa 3 in-process node-a i runner-om od 120 ms drži **~8 taskova/s** sa p95 pod
sekund. Sve iznad toga nije „sporo" nego **preko kapaciteta** — sistem nema odbacivanje viška (backpressure),
pa red raste i latencija eksplodira. To je sljedeći realan zadatak: **odbacivanje/limit na ulazu** (`429` kad je
`inFlight` pun) i mjerenje kapaciteta sa više procesa.

## 5. Šta još treba izmjeriti (otvoreno)

1. **Backpressure**: odbiti nove taskove kad je red pun (sada se samo gomilaju).
2. **Restart čvora pod opterećenjem**: harness to podržava (`--restart-every`), mjeri se u 1h runu u toku.
3. **Kapacitet sa 3 procesa** (umjesto 3 in-process node-a) — realnija slika za Hetzner.
4. **Mrežna particija** (F6/F11) — dva hosta, blokiran UDP.

---

## 6. RESTART ČVORA pod opterećenjem (nalaz i popravka)

Soak harness podržava restart čvora (`--restart-every=<sec>`): čvor se zatvori bez `LEAVE` (kao pravi pad),
pa se podigne na istom portu i vrati u roj.

**Nađena greška (treća koju je soak iznudio):** poslije `close()` su **claim/sync/queue tajmeri nastavljali da
rade**, pa je log punio `node.tick_failed: "Not running"` — čvor je „mrtav", a još kuca. Popravka:
`close()` sada gasi **sve** tajmere (`clearInterval` za claim, sync i queue), postavlja `closed` flag, a
`tick()` na zatvorenom čvoru vraća `{ idle: true, reason: 'closed' }` umjesto da baca grešku.
Regresioni test: `tests/close.test.mjs`.

**Izmjereno poslije popravke** (`--minutes=1 --rate=6 --restart-every=20`, restart svakih 20 s — namjerno
agresivno):

| Mjera | Rezultat |
|---|---|
| restartovi | 3, svi uspješni, bez „Not running" |
| latencija | p50 751 ms · **p95 11.7 s** · p99 12.0 s |
| izgubljeno | 3 ✖ |
| duplo izvršeno | 5 ✖ |

**Iskreno tumačenje:** restart **svakih 20 sekundi** pod opterećenjem je ekstrem (12× češće od planiranog
rasporeda od 10 min). Taskovi koji su bili „u letu" na ugašenom čvoru se preuzimaju ponovo, pa nastaju
ponovni radovi (at-least-once) i, do `settle` prozora, par taskova ostane nedovršeno. Za prijemni test je
mjerodavan 1h run sa restartom **svakih 10 min** (`docs/soak-1h.log`).

**Sljedeće (ako zatreba):** skratiti `claimLeaseMs` na ~2× `failureTimeout` (2.4 s) da se taskovi sa mrtvog
čvora vraćaju brže; sada je 10 s, što je konzervativno i sigurno, ali sporije.

---

## 7. ⚠️ 1h SOAK (30.09.2026) — kratki runovi su KRILI ozbiljnu degradaciju

Prvi pravi 1-satni soak (`--minutes=60 --rate=8 --restart-every=600`) **nije prošao**:

| Mjera | Rezultat |
|---|---|
| Trajanje | 3 610 s (60 min) |
| Poslano / izvršeno | 25 707 / 25 697 |
| Propušteno | **7,12 taskova/s** (cilj 8) |
| Latencija | p50 **883 ms** · p95 **938 518 ms** · p99 1 011 956 ms · max 1 088 717 ms |
| Izgubljeno | **10** ✖ |
| Duplo izvršeno | **11 200** ✖ |
| Memorija (heap) | start 16 MB → kraj **215 MB**, vrh 240 MB ⚠ |
| CRDT po čvoru | 37 751 / 37 727 / **20** (treći je 6× restartovan) |
| Gossip | 375 594 poslano · odbijeno 0 · **rate-limited 11 881** |
| Restarti čvora | 6 (svakih 10 min) |

### Dijagnoza (uzročno-posljedično)
1. Pri 8 t/s u **jednom procesu** event loop se zasićuje → pojedini taskovi ostaju „u letu" **minutima**
   (p95 ≈ 15 min).
2. **Claim lease je 10 s**, a izvršenje pod zasićenjem traje duže → lease istekne **dok vlasnik još radi**,
   pa drugi čvorovi preuzimaju isti task → **11 200 ponovnih izvršenja**.
3. **Nema obnavljanja lease-a** dok task traje (owner ne javlja „još radim") — to je pravi uzrok.
4. CRDT raste **neograničeno**: `task:`, `result:` i `claim:` zapisi su „živi" i nikad se ne uklanjaju
   (kompakcija briše samo tombstone-e) → ~77k zapisa, i to je izvor rasta heapa.
5. `rate-limited 11 881` pokazuje da gossip pod ovim opterećenjem odbacuje „teretne" poruke (PING/ACK su
   izuzeti, pa membership nije pao — zato nema lažnih smrti).

### Popravke (sljedeći sprint, po prioritetu)
1. **Obnavljanje lease-a dok task traje** (`claim.at` se osvježava svakih `claimLeaseMs/3` iz `runTask`) —
   time zdravi vlasnik nikad ne izgubi claim, a mrtvi ga izgubi odmah. Ovo je **obavezno** prije bilo kakvog
   daljeg demo-a pod opterećenjem.
2. **TTL/GC za `task:`/`result:`/`claim:` zapise** starije od npr. 15 min (uz zadržavanje brojača i statistike
   odvojeno) — tabla i heap prestaju da rastu.
3. **Odbacivanje umjesto gomilanja** (backpressure je već tu: `maxQueueDepth` 500) — podići svijest: pri 8 t/s
   u jednom procesu sistem je **na granici**; realno skaliranje traži više procesa/hostova.
4. Ponoviti 1h soak poslije 1–2 i zahtijevati: `duplo = 0`, `izgubljeno = 0`, `p95 ≤ 1,5 s`, heap stabilan.

**Šta je ovo dobro pokazalo:** kratki runovi (1–3 min) daju lijepe brojeve i **lažnu sigurnost**; sat vremena
otkrije klasu grešaka koja se inače vidi tek kod kupca.

---

## 8. POPRAVKE poslije pada 1h soak-a (v1.7.0) — obnavljanje lease-a + GC

Implementirano tačno po prioritetu iz §7:

### 1. Obnavljanje claim lease-a dok task traje (`src/node.js`)
Dok `runTask` radi, vlasnik svakih `claimLeaseMs / 3` (10 s → **3,3 s**) osvježava `claim.at`, upisuje
`renewed: true` i **oglašava svježi zapis roju** (gossip). Ako u međuvremenu izgubi vlasništvo (neko drugi
je zapisao svoj claim), obnavljanje se **samo zaustavlja** — ne obnavljamo tuđi zapis. Interval se čisti u
`finally`, pa nema curenja tajmera.

Efekat: **zdravi vlasnik nikad ne izgubi claim** (ma koliko izvršenje trajalo), a mrtvi ga izgubi odmah —
što je i bio cilj. Time pada glavni uzrok 11 200 duplih izvršenja.

### 2. GC cijelih zapisa (`src/shared/blackboard.js` → `gc()`)
`gc({ olderThanMs: 15 min, protect })` briše `task:`, `result:` i `claim:` zapise starije od 15 minuta, uz
dvije brave:
* `protect` čuva ono što je **ovaj čvor preuzeo** (`inFlight`) i **nezavršene** taskove (bez `result:`),
* **živ claim se ne dira** (`isClaimLive`).

Brojači (`done`, statistika) žive **izvan tabele**, pa GC-om ne gube tačnost. Node ga poziva u istoj petlji
kao i kompakciju (`compactionIntervalMs`, 5 min).

### 3. Testovi (`tests/claim-renew.test.mjs`)
* vlasnik drži claim duže od lease-a (runner 2,6 s vs lease 0,9 s) i `claim.at` se **osjetno povećava**,
  a peer koji vidi samo zapis ga **ne preuzima**;
* GC briše završene `task:`/`result:` zapise, **čuva** nezavršen task i živ claim, ne dira nepovezane
  ključeve, i **brojač ostaje tačan** poslije GC-a.

### 4. Ponovni 1h soak (u toku)
Pokrenut `node scripts/soak.mjs --minutes=60 --rate=8 --restart-every=600` poslije deploya popravki.
Kriteriji: `izgubljeno = 0`, `duplo = 0`, `p95 ≤ 1,5 s`, heap stabilan (< 100 MB). Rezultat ide u
`docs/soak-1h-fixed.log` i `data/_control/soak-history.json`.

---

## 9. REZULTAT POPRAVKI: 1h soak #2 (v1.7.0) — fiksovi rade, ali je otkriveno da mjerenje LAŽE

```
trajanje:      3611 s (60 min) · cilj 8 t/s
poslano:       27 179   (od toga PRIHVAĆENO: 4 000)   ← vidi objašnjenje ispod
izvršeno:      4 000
propusnost:    1,11 t/s  (računato na prihvaćene)
latencija:     p50 751 ms · p95 779 ms · p99 786 ms · max 931 ms   ✔ (prije: p95 938 518 ms)
duplo:         0        ✔  (prije: 11 200)
heap:          11 MB → 69 MB, vrh 76 MB               ✔ (prije: 215 / 240 MB)
CRDT:          1 500 / 1 500 / 1 500 zapisa           ✔ (prije: 37 751 / 37 727 / 20)
gossip:        rate-limited 74 (prije: 11 881)        ✔
restarti:      5 (svakih 10 min, bez grešaka)
```

### Šta je POPRAVLJENO (ciljevi postignuti)
| Cilj | Prije | Poslije |
|---|---|---|
| Duplo izvršeno | 11 200 | **0** ✔ |
| p95 latencija | 938 518 ms | **779 ms** ✔ |
| Heap (vrh) | 240 MB | **76 MB** ✔ |
| CRDT zapisa | 37 751 | **1 500** ✔ |
| Rate-limited | 11 881 | **74** ✔ |

Obnavljanje lease-a i GC su **tačno pogodili uzroke**: nema više duplog rada, latencija je u budžetu,
tabla i heap su ograničeni.

### Šta je novo otkriveno: **harness je brojao odbijene taskove kao izgubljene**
`izgubljeno: 23 179` je u najvećoj mjeri **backpressure** — sistem je pri 8 t/s u jednom procesu počeo da
**odbija** višak (429 `QUEUE_FULL`, `maxQueueDepth` 500). To je **ispravno ponašanje** (bolje odbiti nego
pustiti da latencija eksplodira — a latencija je zato ostala 0,8 s!), ali je harness dodavao task u
`submitted` **prije** predaje, pa je odbijeno izgledalo kao gubitak.

**Popravljeno u harness-u (`scripts/soak.mjs`)**: task se broji kao poslan tek kad ga roj **prihvati**;
`QUEUE_FULL` ide u `shedByBackpressure`, ostale greške u `failedSubmit`. Time se konačno razdvaja
„sistem je odbio višak" (kapacitet) od „sistem je izgubio posao" (greška).

### Zaključak o kapacitetu (mjerodavno za Hetzner)
* **3 node-a u jednom procesu drže ~4 taska/s sa p95 < 1 s i 0 gubitaka/duplikata.**
* Pri 8 t/s ponuđenog opterećenja sistem **odbija ~85 %** (429) umjesto da degradira — što je željeno,
  ali znači da **8 t/s nije kapacitet jednog procesa**, nego cilj koji traži više procesa/hostova.
* Zato 1h soak #3 ide na **5 t/s** (održivo) i traži: `shedByBackpressure = 0`, `izgubljeno = 0`,
  `duplo = 0`, `p95 ≤ 1,5 s`, heap stabilan.

---

## 10. SUD SOAK-a #4 (60 min, 5 t/s, 5 restarta) — 4/6 kriterija, ostaje 43 duplih

```
trajanje:      3601 s (60 min) · 5 restarta cvorova (svi prosli tiho)
poslano:       17 342
izvršeno:      17 342        ← 0 izgubljenih, 0 odbijenih
propusnost:    4,82 t/s
latencija:     p50 753 · p95 782 · p99 796 ms · max 34 604 ms
duplo:         43            (prije popravki: 11 200 → 260x manje, ali NIJE 0)
heap:          10,6 → 124,1 MB
CRDT:          12 985 / 12 984 / 8 660
gossip:        rate-limited 537 · odbijeno 0 · duplikata 0
```

| Kriterij | Cilj | Sud |
|---|---|---|
| Odbijeno (backpressure) | 0 | ✔ **0** |
| Izgubljeno | 0 | ✔ **0** (17 342 / 17 342) |
| p95 | ≤ 1,5 s | ✔ **782 ms** |
| Duplo izvršeno | 0 | ✖ **43** (0,25 %) |
| Heap | < 100 MB | ✖ **124 MB** |
| CRDT | ograničen | ✔ objašnjeno: ~4 300 taskova × 15 min × 3 zapisa ≈ 13 k — **prozor, ne curenje** |

### Dijagnoza preostalih 43 (0,25 %) — hipoteza sa jakim osnovom
Duplikati se javljaju u **prozoru restarta** (5 restarta → ~8 po restartu). Uzrok: claim nosi **samo
`nodeId`**, pa poslije restarta **novi proces istog `nodeId`-a vidi stari claim kao svoj** i (poslije isteka
lease-a) ga preuzme — dok ga istovremeno preuzima i peer koji je detektovao smrt. Dva izvršenja istog taska.

**Popravka (sljedeće):** claim dobija **`instanceId`** (slučajni ID procesa) + `attempt` fencing:
* čvor smatra claim **svojim** samo ako se `instanceId` poklapa sa tekućim procesom;
* poslije restarta svi stari claim-ovi su **tuđi** → preuzimanje ide kroz normalnu proceduru
  (lease + `claimConfirmMs` + LWW verifikacija), pa nema dva izvršenja.

**Heap 124 MB** (cilj <100): raste sa prozorom GC-a (15 min × 4,8 t/s ≈ 4 300 zadataka u memoriji). Ako
kriterij ostaje <100 MB, `gcAgeMs` ide na 10 min ili se `result:` zapisi drže sažeto (samo status + broj).

### Odluka: **video se NE snima** dok je `duplo > 0`

---

## 11. INSTANCE FENCING (v1.9.0) — popravka za 43 duplih iz soak-a #4

**Uzrok (potvrđen do linije koda):** claim je nosio **samo `nodeId`**. Poslije restarta novi proces istog
`nodeId`-a vidio je stari claim kao **svoj**, pa ga poslije isteka lease-a preuzeo — dok ga je istovremeno
preuzeo i peer koji je detektovao smrt → **dva izvršenja**.

**Popravka:**
* `src/node.js`: `const instanceId = randomUUID()` — **ID procesa** (mijenja se svakim restartom).
* Claim zapis nosi `instanceId` (i pri preuzimanju i pri obnavljanju lease-a).
* `isClaimLive()`: claim je „naš" **samo ako se poklapaju `nodeId` I `instanceId`**. Ako je `nodeId` naš, a
  `instanceId` tuđi (stari proces), claim se tretira kao **tuđ** i preuzima se kroz normalnu proceduru
  (`claimGraceMs` → lease → `claimConfirmMs` → LWW verifikacija).
* Obnavljanje lease-a se zaustavlja ako claim nije naš (i po `nodeId` i po `instanceId`).
* `gcAgeMs` 15 min → **10 min** (heap je pri 4,8 t/s bio 124 MB; 10 min ≈ 2 880 zadataka ≈ 80–90 MB).

**Testovi** (`tests/instance-fencing.test.mjs`, 3): claim nosi `instanceId` i mijenja se između procesa;
stari claim istog `nodeId`-a sa tuđim `instanceId` **nije živ** (ne nasljeđuje se); izvor čuva obrazac.

**Soak #5** (isti kriteriji: `shed = 0`, `izgubljeno = 0`, `duplo = 0`, `p95 ≤ 1,5 s`, heap < 100 MB) →
`docs/soak-1h-v190-fencing.log`.

---

## 12. SUD SOAK-a #5 (v1.9.0, instance fencing) — 43 → 11 duplih, 0 izgubljenih

```
trajanje:      3601 s (60 min) · 6 restarta cvorova
poslano:       17 353
izvršeno:      17 353      <- 0 izgubljenih
odbijeno:      0 (backpressure) · druge greske pri predaji: 5
propusnost:    4,82 t/s
latencija:     p50 753 · p95 782 · p99 790 ms · max 28 459 ms
duplo:         11          (soak #4: 43 · soak #2: 11 200)
heap:          11,9 -> 63 MB, vrh 102,4 MB
CRDT:          8 669 / 8 669 / 1 (treci cvor je bio restartovan 6x)
gossip:        rate-limited 0 · odbijeno 0 · duplikata 0
```

| Kriterij | Cilj | Sud |
|---|---|---|
| Odbijeno (backpressure) | 0 | ✔ **0** |
| Izgubljeno | 0 | ✔ **0** |
| p95 | ≤ 1,5 s | ✔ **782 ms** |
| Duplo | 0 | ✖ **11** (0,06 %) |
| Heap | < 100 MB | ~ **63 MB kraj** (vrh 102,4 MB — granično) |
| CRDT | ograničen | ✔ 8 669 (prozor GC-a) |
| Gossip rate-limited | 0 | ✔ **0** |

**Fencing je radio:** 43 → **11** (4× manje). Ostaje 0,06 % duplih.

### Dijagnoza preostalih 11 (restart-trka)
Sa fencing-om, claim starog procesa je „tuđ", pa ga **i** restartovani čvor **i** peer koji je detektovao
smrt mogu preuzeti — a vremena se preklapaju:
* detekcija smrti: **1,3–2,2 s**
* `claimGraceMs`: **1,5 s** + `claimConfirmMs`: **0,6 s** = 2,1 s → prozor u kojem oba prođu

Zato ~2 duplih po restartu × 6 restarta ≈ 11.

**Popravka:** `claimGraceMs` 1,5 s → **3 s** (duže od najgore detekcije), i/ili `claimConfirmMs` da se
računa iz izmjerene detekcije. Uz to: duplo izvršenje treba da bude **eksplicitno označeno** (`superseded`
već postoji) da se u izvještaju vidi koliko ih je „izgubljena trka", a ne prava greška.

### Odluka: video se **još ne snima** (duplo > 0), ali smo na 0,06 %

---

## 13. GRACE PROZOR (Dio 1–4) — stanje i tačan nastavak

### Zašto
Soak #5: **11 duplih** (0,06 %). Uzrok je **restart-trka**: prozor za preuzimanje (1,5 s grace + 0,6 s
confirm = **2,1 s**) bio je **kraći** od izmjerene detekcije smrti (**1,3–2,2 s**), pa su i restartovani
čvor i peer koji je detektovao smrt preuzeli isti task.

### Predložena popravka (implementirana, **nije aktivirana**)
```
claimGraceMs   = eksplicitno ?? max(3000, ceil(detekcija * 1.5))     // 1.500 -> 3.000 ms
claimConfirmMs = eksplicitno ?? max(600, 2*interval, ceil(detekcija * 1.25))  // 600 -> 1.625 ms
ukupan prozor  : 2,1 s -> 4,6 s   (detekcija 1,3-2,2 s)
```

### Šta je završeno i zeleno (274/275)
* **Dio 1 (`4e2ce1a`)**: `claimWindows()` izlaže aktivne prozore, `detectionMs`, `derived` (izračunati
  minimum) i `explicit` (da li je pozivalac zadao vrijednost). Default **nepromijenjen**.
  Testovi: eksplicitnih 50 ms ostaje 50 ms; `claimConfirmMs: 60` ide na **donji prag 600 ms**, a NE na
  izvedenih 1 625 ms (donji prag ≠ derivacija).
* **Dio 2 (`8c8c50d`)**: dva prava timing testa čekaju **imenovano polje** iz `claimWindows()`:
  `chaos.test.mjs` → `totalMs + 50` (čeka preuzimanje) · `3-nodes.test.mjs` → `confirmMs + 200`
  (čeka da je čvor **još zauzet**; sa `totalMs` A bi već završio → `A load je 0`).

### Zašto Dio 3 nije aktiviran (nalaz)
Sa aktiviranom derivacijom padaju **`Live feed` (`braincore.test.mjs:313`)** i **`webhook`
(`max.test.mjs:753`)**. Uzrok **nije** flakiness nego promijenjena semantika `tick()`-a:
sa `claimConfirmMs` 600 ms jedan `tick()` potvrdi claim i izvrši task; sa **1 625 ms** prvi `tick()`
završi u fazi **verifikacije claim-a**, pa nema `done` traga i `tasksDone` je 0.

`webhook` je zanimljiviji: već ima rok **8 000 ms** i ipak padne posle 8,3 s → dakle posao koji čeka
event **ne završi u 8 s**, što znači da je sprega dublja od samog roka u testu (treba provjeriti da li
scheduler put prolazi kroz claim verifikaciju, ili job uopšte ne startuje).

### Tačan nastavak (Dio 4)
1. `Live feed`: umjesto jednog `tick()` → petlja do `done` traga, rok `claimWindows().confirmMs + 1000`.
2. `webhook`: **prvo dijagnostika sa logom** (da li se run pokrene i sa kojim `reason`), pa rok iz
   izvedenog prozora — ne još jedno slepo povećanje roka.
3. Ponoviti derivaciju (dva reda), puni set **mora 274/275**.
4. Tek onda **deploy → soak #6** (`shed=0`, `lost=0`, `duplo=0`, `p95≤1,5 s`, heap<100 MB, CRDT
   ograničen, rate-limited 0).

### Stanje mašine (nepromijenjeno)
`releases/v1.8.0` (fencing živ) · sva tri servisa aktivna · `nmq-server` / `oaa-trial` / `cloudflared`
netaknuti · video čeka `duplo = 0` · `api.braincore.pro/llms.txt` i Grafana na 3030 poslije soak-a #6.

---

## 14. DIO 4 — DIJAGNOSTIKA (nalazi, ne pretpostavke)

Pušteno sa **privremeno aktivnom derivacijom** (grubi patch: bez pravila prioriteta), pa su nalazi ovi:

### `webhook` — NIJE claim prozor, nego redoslijed trigger-a pod opterećenjem
Sa derivacijom aktivnom, `max.test.mjs` **sam prolazi** (`runs: 1`, `reasons: ["event"]`, event izvršen za
**108 ms**). Ali u **punom setu** (fajlovi se izvršavaju paralelno):
```
[webhook-diag] {"elapsedMs":8009,"runs":1,"reasons":["schedule"],"eventRan":false}
```
Run se dogodio sa razlogom **`schedule`**, ne `event`. Posao ima i `schedule: { type: 'once' }` i
`triggers: [{ type: 'event' }]` — **pod opterećenjem „once" schedule pobijedi** i event-run se ne pojavi.
Dakle: to je **redoslijed/trka trigger-a**, a ne dužina claim prozora. Popravka nije rok, nego ili
(a) test koji ne miješa `schedule` i `triggers`, ili (b) kod koji garantuje da event-trigger ima prioritet.

### `Live feed` — petlja od `tick()`-ova NIJE dovoljna
Sa rokom `claimWindows().confirmMs + 1000` i petljom do `done` traga, test i dalje pada (1 670 ms ≈
confirm 1 625 ms + malo) → dakle poslije ~1,6 s tick-anja **zadatak još nije završen**. To znači da
verifikacija claim-a u jednom čvoru ne završi samo ponavljanjem `tick()`-ova — treba vidjeti da li
`claimConfirmMs` čeka **unutar** tick-a (blokirajuće) ili zahtijeva CRDT sync rundu.

### `explicit` test je pao samo zbog mog grubog patcha
Privremeni patch je koristio `Math.max(..., ceil(detekcija*1.25))` **bez** pravila prioriteta, pa je
pregazio eksplicitne vrijednosti. To **nije** problem dizajna — Dio 1 (`4e2ce1a`) pravilo već čuva.

### Zaključak za Dio 5
1. Derivaciju aktivirati **sa pravilom prioriteta** (kao u §13), ne grubim `Math.max`.
2. `Live feed` prvo dijagnostikovati (da li confirm blokira unutar tick-a), pa onda mijenjati test.
3. `webhook` odvojiti od grace rada — to je trigger-race (schedule vs event), nezavisan nalaz.

---

## 15. SUD SOAK-a #6 (v1.9.1, grace 3 s) — 11 → 4 duplih, hipoteza POTVRĐENA DJELIMIČNO

```
trajanje:      3601 s (60 min) · 6 restarta
poslano:       17 342
izvrseno:      17 343      <- "izgubljeno: -1" je ARTEFAKT racunanja (vidi nize)
shed:          0  ✔        · druge greske pri predaji: 6
p95:           782 ms (p50 753, p99 789)  ✔   · max 11 997 ms (prije 28 459)
heap:          13,4 -> 105,7 MB (vrh 105,7)  ~ granicno
CRDT:          8 659 / 8 659 / 9 (ogranicen)  ✔
gossip:        rate-limited 0  ✔ · odbijeno 0
duplo:         4   ✖   (soak #5: 11 · #4: 43 · #2: 11 200)
```

| Kriterij | Cilj | Sud |
|---|---|---|
| Odbijeno (backpressure) | 0 | ✔ 0 |
| Izgubljeno | 0 | ~ **artefakt -1** (vidi nize) |
| Duplo | 0 | ✖ **4** |
| p95 | ≤ 1,5 s | ✔ 782 ms |
| Heap | < 100 MB | ~ 105,7 MB (granicno) |
| CRDT | ogranicen | ✔ 8 659 |
| Rate-limited | 0 | ✔ 0 |

### Sta je hipoteza pogodila
`grace` 3 s (> detekcija 2,2 s) smanjio je duplikate **11 -> 4** i uklonio ekstremni straggler
(**max 28,5 s -> 12,0 s**). Znaci: restart-trka je bila **stvarni** dio uzroka, ali **nije jedini**.

### ARTEFAKT U MJERENJU (popraviti u harness-u)
`izgubljeno = poslano - izvrseno` daje **-1** jer se **duplo izvrsenje broji u `completed`**, pa
`completed > submitted`. To nije gubitak nego pogresna formula. Popravka: `lost = max(0, submitted -
completed)` + odvojeno brojanje duplih (po `executions` mapi), i u izvjestaju jasno "0 izgubljenih,
4 duplih".

### Preostala 4 — hipoteza (domen `confirm` prozora i LWW)
Nije restart-trka (grace je to pokrio), nego **dvostruko preuzimanje tokom verifikacije**: dva cvora
potvrde claim u istom prozoru prije nego sto jedan vidi tudji zapis. To se **ne rjesava poganjanjem**:
sljedeci korak je **log ko je potvrdio i kada** za duplirane taskove
(`nodeId`, `instanceId`, `attempt`, `at`, redoslijed CRDT zapisa), pa tek onda odluka.

### Odluka: video se **jos ne snima** (duplo > 0)

---

## 16. SOAK #7 (v1.9.1 + claim trace) — sud i ZAŠTO TRAG NIJE POKAZAO NIŠTA

```
trajanje:      3601 s (60 min) · 6 restarta
poslano:       17 386 / izvrseno 17 386   (druge greske pri predaji: 6)
shed:          0  ✔            rate-limited: 0  ✔
p95:           783 ms (p50 755, p99 788)  ✔   · max 12 383 ms
heap:          11,9 -> 54,4 MB (vrh 96,5)  ✔  (< 100 MB — gcAgeMs 10 min radi)
CRDT:          8 704 / 8 703 / 9   ✔
izgubljeno:    1   ✖   (ispravna formula: ovo je PRAVI gubitak, ne artefakt)
duplo:         4   ✖
```

| Kriterij | Cilj | Sud |
|---|---|---|
| Odbijeno | 0 | ✔ |
| Izgubljeno | 0 | ✖ **1** (novi, ispravno izmjeren) |
| Duplo | 0 | ✖ **4** |
| p95 | ≤ 1,5 s | ✔ 783 ms |
| Heap | < 100 MB | ✔ **96,5 MB vrh** (prvi put u budzetu) |
| CRDT | ogranicen | ✔ 8 704 |
| Rate-limited | 0 | ✔ |

### ZAŠTO `[dup-trace]` REDOVI SU PRAZNI (`[]`) — greška u MOJOJ instrumentaciji
Prsten je **1000 događaja**, a run napravi ~17 000 zadataka × 3 događaja ≈ **52 000 događaja** — dakle
prsten drži samo zadnjih ~330 zadataka. Duplikati (`soak-task-2899`, `-2900`) su se dogodili **u prvih
10 minuta**, pa su njihovi tragovi **odavno izbaceni** iz prstena. Instrumentacija RADI (dokazano na
normalnom tasku: `claim_set -> confirm_passed -> done`), ali **retencija je bila pogrešna za 1h run**.

### Popravka instrumentacije (sljedece, prije soak-a #8)
Umjesto prstena po vremenu → **trag po zadatku + ispis NA ANOMALIJU**:
1. `Map<taskId, events[]>` za zadatke koji **jos nisu zavrseni** (kada se zavrse, zapis se oslobadja),
2. kada cvor pri izvrsavanju **zatekne da `result:` vec postoji** (ili da je rezultat `superseded`) →
   **odmah** `logger.warn('node.duplicate_execution_detected', { taskId, trace, attempt, instanceId })`,
3. tako trag ide u log **u trenutku anomalije**, bez obzira na to koliko run traje.

### Ostaje da se odgovori (dva razlicita domena)
* **dva `claim_set`-a sa razlicitih cvorova prije nego ijedan vidi tudji zapis** → `confirm`/LWW,
* **`claim_set` poslije `done`** → lease/`grace`,
* **`superseded`** → oba izvrsila, jedan rezultat ispravno odbacen (tada je „duplo" rijeseno, ne greska).

Odluka o `confirm` prozoru (600 ms) **nije donesena** — ceka se trag iz soak-a #8.

---

## 17. SOAK #8 (trag po zadatku) — sud i ZAŠTO ANOMALIJA NEMA U LOGU (0)

```
trajanje:      3611 s (60 min) · 6 restarta
poslano:       17 392 / izvrseno 17 387      (druge greske pri predaji: 4)
shed:          0  ✔            rate-limited: 0  ✔
p95:           784 ms (p50 759, p99 790)  ✔   · max 12 083 ms
heap:          12,2 -> 56,4 MB (vrh 99,5)  ✔  (< 100 MB, granicno)
CRDT:          8 711 / 8 710 / 6   ✔
izgubljeno:    5   ✖
duplo:         6   ✖
node.duplicate_execution_detected: 0  ← dijagnostika NIJE uhvatila nijedan slucaj
```

### ZAŠTO JE 0 ANOMALIJA (treci put da mehanizam promasi — i zasto)
Duplikati su **ISTOVREMENI**: oba cvora pocnu izvrsavanje **prije** nego ijedan upise `result:`. Zato:
* `pre_execute` provjera („ako `result:` vec postoji") **ne moze da se aktivira** — u tom trenutku rezultata
  jos nema ni kod jednog,
* `superseded` se postavlja samo ako poslije izvrsavanja **provjera vlasnistva padne** — kod istovremenog
  rada oba cvora zavrse i upisu rezultat, a LWW zadrzi jedan; drugi cesto **ne udje** u `superseded` granu.

Dakle moja instrumentacija je mjerila **posljedicu koja se ne registruje**, a ne **sam dogadjaj** (dva
istovremena claim-a). To je isti obrazac kao retencija u #7: mehanizam je radio, ali nije gledao pravo mjesto.

### TACNA instrumentacija (prije soak-a #9)
Dva signala koja hvataju SAM dogadjaj, a ne posljedicu:
1. **`claim_set` sa tudjim ZIVIM claim-om**: ako pri preuzimanju `existing?.nodeId !== id` i
   `existing?.nodeId` je **ziv** (`gossip.isAlive`) i `at` je unutar lease-a → `logger.warn` ODMAH. To je
   direktan dokaz dvostrukog preuzimanja (domen `confirm`/LWW).
2. **`result:` zapis kada rezultat VEC postoji**: ako pri `crdt.set('result:'+id, ...)` postoji prethodni
   zapis sa **drugog** cvora → `logger.warn` sa oba zapisa (ko je prvi upisao, ko drugi i kada). To je
   trenutak kada je duplo izvrsenje **postalo cinjenica**.

### Sto je ovaj run ipak dokazao
* `heap` ostaje ispod 100 MB (vrh **99,5**) — `gcAgeMs` 10 min drzi,
* `p95` je **784 ms** — sedmi sat zaredom stabilno,
* `shed = 0`, `rate-limited = 0`, `CRDT` ogranicen,
* **`lost` i `duplo` variraju**: #7 = 1 lost / 4 dup · #8 = 5 lost / 6 dup. Mali brojevi, ali **varijacija**
  znaci da je pojava uslovljena **vremenskim preklapanjem** (restart + istovremeni claim), a ne stalnim
  stanjem. Zato je i mjerenje po dogadjaju (a ne po posljedici) jedini put do `duplo = 0`.

---

## 18. KLASIFIKACIJA DUPLIH — cross-node 4 · same-node 0 (i šta to ZNAČI ZA KRITERIJ)

Kratki run (3 min, restart svakog čvora svakih **45 s** — namjerno agresivno) sa brojačem **ko je izvršio**:

```
dupCrossNode = 4   dupSameNode = 0   duplicated = 4   extraExecutions = 8   lost = 2
soak-task-214  nodes=9043,9042            attempts=1,2
soak-task-216  nodes=9043,9042,9042       attempts=1,2,2
soak-task-436  nodes=9043,9041,9041       attempts=1,2,2
soak-task-438  nodes=9043,9041,9041,9041  attempts=1,2,2,2
```

### NALAZ 1: duplikati su CROSS-NODE sa `attempt` 1 → 2
Prvo izvršenje je na jednom čvoru (`9043`), pa **peer** preuzme sa **`attempt: 2`**. To je **reclaim put**:
čvor je ubijen (restart svakih 45 s) dok je zadatak bio „u letu", peer ga preuzme i izvrši ponovo.
**To je očekivano `at-least-once` ponašanje, ne greška** — zadatak je stvarno ostao bez vlasnika.

### NALAZ 2 (pravi bug): `attempt: 2` se ponavlja na ISTOM čvoru
`attempts=1,2,2` i `1,2,2,2` — isti čvor izvršava **isti `attempt` više puta**. Vlasništvo se mijenja, a
`attempt` (fencing token) **se ne inkrementira** pri ponovnom preuzimanju istog claim-a. Zato ovaj dio
JESTE pravi duplikat i tu je popravka (fencing token mora rasti pri svakom preuzimanju).

### POSLJEDICA ZA KRITERIJ PRIHVATANJA (`duplo = 0`)
Moj harness broji **svaki poziv runner-a**, pa u runu sa 6 ubijanja čvorova broji i **legitimne retry-je**.
Zato je `duplo` miješao dvije različite stvari:
* **re-izvršenje poslije smrti vlasnika** (novi `attempt`) → **očekivano** (`at-least-once`),
* **ponovno izvršenje istog `attempt`-a** → **pravi duplikat** (bug).

**Ispravan kriterij** (i ono što ide na sajt/video):
* `duplicateSameAttempt = 0` — nula ponovnih izvršenja **istog** `attempt`-a (pravi duplikat),
* `retryAfterKill` — prijaviti **odvojeno** kao očekivano ponašanje, sa brojem,
* `lost = 0`, `p95 <= 1,5 s`, heap < 100 MB, `shed = 0`.

### Sljedeći korak (soak #10)
1. U harness-u razdvojiti `duplicateSameAttempt` (isti nodeId+attempt) od `retryAfterKill` (novi attempt).
2. U `src/node.js` popraviti **inkrement `attempt`-a pri ponovnom preuzimanju** (fencing) — to je jedini
   pravi duplikat koji je ostao.
3. Pustiti soak #10 i tražiti `duplicateSameAttempt = 0`.

---

## 19. SOAK #10 = `lost=0` (milestone) i zadnji duplikat: trka UNUTAR jednog gossip kruga

```
#10 (60 min, 5 t/s, 6 restarta): poslano 17 342 / izvrseno 17 342 · lost = 0 ✔ · p95 783 ms ✔
                                 heap vrh 103,2 MB · CRDT 8 640 · shed 0 ✔ · rate-limited 0 ✔
                                 duplicateSameAttempt = 1 ✖ · retryAfterKill = 2 (ocekivano)
   PRAVI DUP: soak-task-11579  nodes=9081,9083  attempts=1,1   <- DVA cvora, OBA attempt=1
```

### Popravka koja je uslijedila (`61639fd`) i zasto NIJE dovoljna
Dodao sam provjeru vlasnistva **prije** runner-a (`ownerAfterConfirm.nodeId !== id` → izlaz). Kratki run
poslije toga: **`duplicateSameAttempt = 3`**, isti uzorak:
```
soak-task-220  nodes=9102,9103  attempts=1,1
soak-task-221  nodes=9102,9103  attempts=1,1
```

**Zasto:** provjera gleda **lokalni** CRDT. Oba cvora upisu svoj claim i, u svom lokalnom pogledu, **jesu
vlasnici** — tuđi claim im nije stigao (gossip ~300 ms po smjeru, `claimConfirmMs` 600 ms). LWW na kraju
izabere jednog, a gubitnik je **vec izvršio** posao. Dakle: to nije bug u logici provjere, nego
**nedovoljan prozor verifikacije za jedan gossip krug**.

### Dvije opcije (mjerene, ne teoretske)
1. **`claimConfirmMs` >= jedan gossip krug** (mjeriti: 600 ms nije dovoljno; predlazem 1200-1600 ms).
   Cijena: svaki zadatak ceka duze preko mreze; i **mijenja semantiku `tick()`-a** (dokazano u Diou 3:
   `Live feed`/`webhook` padaju dok se testovi ne vezu za izracunati prozor — Dio 2 je to vec uradio za
   `chaos` i `3-nodes`, ostaje `Live feed` petlja + `webhook` rok).
2. **Prihvatiti povremeni dupli RAD uz ispravno stanje** (`superseded` odbacuje gubitnikov rezultat) i
   prijaviti ga kao mjerenu cijenu `at-least-once` isporuke.

**Odluka nije donesena** — i ne treba je donositi bez mjerenja: sljedeci korak je izmjeriti **koliko
gossip krugova** treba (log `claim_lost_before_execute` sa vremenom izmedju tudjeg claim-a i naseg), pa
postaviti prozor na **izmjereno**, ne na pogodjeno.

### Sto je #10 dokazao (i ostaje)
* **`lost = 0` u punom satu sa 6 restarta** — prvi put (lease renewal + GC + grace),
* `p95 783 ms` (9 sati stabilno), `shed 0`, `rate-limited 0`, CRDT ogranicen,
* duplikati su svedeni na **iskljucivo cross-node trku** (`dupSameNode = 0` u svim runovima poslije
  `attemptFloor` + `executing` guard → ti fiksevi rade).

---

## 20. MJERENJE GOSSIP KRUGA — nalaz: NIJE latencija, nego LWW tie-break

Kratki run (3 min, restart 45 s) sa `deltaMs = remoteClaimAt - ourClaimAt` u `node.claim_lost_before_execute`:

```
broj claim_lost_before_execute (uspjesno izbjegnute trke): 363
deltaMs:  min -1 ms · max 0 ms   (prosjek ~ -0,3)
waitedMs: 600-611 ms  (koliko smo cekali prije provjere)
primjer:  taskId soak-task-2  nodeId soak-9122  ownerNow soak-9121  deltaMs -1  confirmMs 600
```

### STA TO ZNACI (i zasto rusi prethodnu hipotezu)
1. **Konkurentski claim je upisan u ISTOJ MILISEKUNDI** (`deltaMs ≈ 0`), a ne poslije gossip kruga.
   Dakle **povecanje `claimConfirmMs` na 1200-1600 ms NE BI RIJESILO** preostale duplikate — tuđi zapis je
   vec lokalno prisutan u trenutku provjere.
2. **Provjera radi:** 363 trke su rijecene tako sto je gubitnik izasao **prije** runner-a (§19, `61639fd`).
3. Ostaje mali broj (3 u tom runu) gdje **oba cvora ostanu uvjereni da su vlasnici** — to nije latencija,
   nego **LWW razrjesavanje po (priblizno) istom timestamp-u**: dvije strane mogu razlicito razrijesiti
   isti par zapisa u svom lokalnom pogledu.

### TACNA POPRAVKA (mjerenjem utvrdjena)
Umjesto LWW po vremenu za `claim:` zapise → **deterministicki pobjednik iz skupa claim-ova**:
za isti `(taskId, attempt)` vlasnik je npr. **najmanji `nodeId`** (ili `(instanceId)` kao tie-break).
Tada **svaki cvor iz istog skupa izracuna ISTOG pobjednika** — nema asimetrije, nema dva izvrsavanja.
`claimConfirmMs` ostaje 600 ms (nije problem).

### USPUTNI NALAZ (efikasnost)
**363 trke u 3 min (~870 zadataka) = ~40 % zadataka ima konkurentski claim.** Gubitnik plati 600 ms
cekanja (bez posla), ali to znaci da claim mehanizam **previse cesto** dopusta dva kandidata — vrijedi
suziti uslove preuzimanja (npr. samo najslobodniji peer, ili pheromone-based izbor) da se smanji broj trka.

---

## 21. DETERMINISTICKI POBJEDNIK — zasto ne ide bez promjene pravila spajanja (i tacan korak)

### Problem u jednoj recenici
`claim:<taskId>` je **jedan kljuc sa jednom vrijednoscu**. Dva cvora pisu isti kljuc u istoj milisekundi
(izmjereno §20: `deltaMs` 0 ms), pa **svaki cvor u svom lokalnom pogledu zadrzi SVOJU vrijednost** (LWW).
Skup kandidata **nije reprezentovan**, pa „izracunaj pobjednika iz skupa" ne postoji dok je kljuc jedan.

### Dva ispravna rjesenja (oba mala, ali nisu „samo dodaj min()")
1. **Pravilo spajanja za `claim:` kljuceve (preporuceno — ne mijenja shemu):**
   u `src/shared/blackboard.js`, pri merge-u za kljuceve koji pocinju sa `claim:` ne koristiti LWW-po-vremenu
   nego deterministicki poredak:
   ```
   ako (incoming.attempt > existing.attempt) -> incoming
   ako (incoming.attempt < existing.attempt) -> existing
   ako su jednaki -> pobjednik je manji nodeId (tie-break: manji instanceId)
   ```
   **Oba cvora primijene ISTO pravilo na ISTI par** → konvergiraju **istom** vlasniku. Gubitnik tada vidi
   `ownerAfterConfirm.nodeId !== id` i izlazi **prije** runner-a (§19, `61639fd`). `claimConfirmMs` ostaje 600 ms.
2. **Kljuc po kandidatu** (`claim:<taskId>:<nodeId>` + `min(nodeId)` kao pobjednik) — jace, ali mijenja shemu
   i sve citace `claim:` (vise mjesta, veci rizik).

### Zasto ovo NISAM odglumio
Prvo rjesenje dira **pravilo spajanja CRDT-a**, a to je isti sloj koji drzi i `attempt` i LWW za sve ostale
kljuceve. Takva izmjena trazi: (a) test konvergencije (dva cvora, isti `(taskId, attempt)`, razliciti `nodeId`
→ **isti** vlasnik na oba), (b) puni set, (c) kratki run, (d) soak. To je posao za svjez kontekst, ne za
zadnjih par minuta sesije — i necu ga najavljivati kao gotovog.

### Mjerenja koja ostaju kao osnova za taj korak
* `deltaMs` sve <= 0 (max 0 ms) — trka je **istovremena**, ne latencijska,
* **363 trke rijesene u 3 min** izlaskom prije runner-a → `61639fd` radi,
* ostaje **samo** LWW asimetrija pri jednakom `attempt` — nista drugo.

---

## 22. KORIJEN: `wins()` poredi LOKALNI brojač kao da je globalan sat (vektorski sat se ne koristi)

Procitano u `src/shared/blackboard.js`:

```js
function wins(a, b) {
  if (!b) return true;
  if (a.counter !== b.counter) return a.counter > b.counter;   // <-- counter je LOKALNI tick() po cvoru
  return String(a.nodeId) > String(b.nodeId);                   // tie-break je korektan i simetrican
}
```

### Sta je pogresno
* `counter` je **lokalni brojac upisa tog cvora** (`tick()`), a poredi se **kao globalni LWW sat**. Cvor koji
  je miran ima mali brojač, cvor koji je mnogo pisao ima veliki — pa „pobjednik" zavisi od toga **koliko je
  koji cvor ukupno pisao**, a ne od redoslijeda događaja.
* **Vektorski sat POSTOJI** (`entry.clock`, `clockMerge`) i upravo je namijenjen ovome — ali ga `wins()` **ne
  koristi**. Zato se konkurentni upisi (dva claim-a u istoj ms, `deltaMs 0`) ne razrjesavaju po kauzalnosti
  nego po sreci brojača.
* Tie-break `String(a.nodeId) > String(b.nodeId)` je **ispravan** (deterministicki, antisimetrican) — dakle
  „simetrican tie-break" NIJE popravka; popravka je **koristiti `clock`**.

### Tacna popravka (jedno mjesto, bez promjene sheme)
```js
function dominates(a, b) {           // a kauzalno dominira b?
  let greater = false;
  for (const [n, c] of Object.entries(a.clock ?? {})) {
    const bc = Number(b.clock?.[n] ?? 0);
    if (Number(c) < bc) return false;
    if (Number(c) > bc) greater = true;
  }
  return greater;
}
function wins(a, b) {
  if (!b) return true;
  if (dominates(a, b)) return true;          // kauzalnost
  if (dominates(b, a)) return false;
  // KONKURENTNI: deterministicki tie-break (isti rezultat na oba cvora)
  return String(a.nodeId) > String(b.nodeId);
}
```
Time dva cvora iz **istog para** zapisa izracunaju **istog pobjednika** — nezavisno od toga koliko je koji
pisao. `claimConfirmMs` ostaje 600 ms (mjerenje §20 je dokazalo da nije kriv).

### Test koji prvo MORA pasti (prije popravke)
Dva cvora, isti `(taskId, attempt)`, razlicit `nodeId`, upisi u istoj ms:
* poslije razmjene (merge u oba smjera) → **isti vlasnik na oba cvora**;
* i: cvor sa **manjim** lokalnim brojacem ali **kazalno kasnijim** upisom mora pobijediti (dokaz da se
  poredi kauzalnost, a ne brojac).

### Zasto ovo NISAM mijenjao sada
`wins()` je **temelj cijele table** (svi kljucevi, svi cvorovi, tombstone-i, kompakcija). Promjena zahtijeva
puni set (276/277) + kratki run + soak, i to je posao koji se radi svjesno — ne u zadnjim minutama sesije.
Ostavljam ga kao **jedini otvoreni korak**, sa tacnim kodom i testom iznad.

---

## 23. ISPRAVKA §22: `wins()` JE simetrican i konvergira — moja hipoteza je OBORENA mjerenjem

Probe (dva CRDT-a, isti kljuc, pa razmjena u oba smjera):

```
[A pise mnogo]  A vidi: A · B vidi: A · KONVERGIRA: true
[D pise mnogo]  C vidi: D · D vidi: D · KONVERGIRA: true
[entry] counter=21 nodeId=A clock={"A":21,"B":1}      <- vektorski sat se ISPRAVNO spaja
```

**Zakljucak: `wins()` je deterministicki i simetrican.** Poredjenje po `counter`-u daje isti pobjednik na
obje strane (ko je vise pisao, njegov zapis je noviji — a to je upravo LWW), a `clock` se spaja tacno.
Dakle **nema LWW asimetrije** i `wins()` **nije** korijen `attempts=1,1`.

### Zasto sam pogrijesio u §22
Uzeo sam uzorak `deltaMs` koji je sadrzao **samo trke koje su IZbjegnute** (bails) — one u kojima je tudji
claim **stigao** prije provjere. Za **promasaje** (oba izvrse) nisam imao nijedno mjerenje. To je ista greska
kao u #7/#8: mjerio sam pogresan skup. Zato je §22 bio zakljucak iz **pristrasnog uzorka**, ne iz podatka.

### Sta je onda preostalo (i sta treba izmjeriti)
Duplikat `1,1` postoji samo ako **tudji claim nije stigao** u lokalni pogled do trenutka provjere. To je
**latencija dolaska zapisa**, ne semantika `wins()`. Zato sljedece mjerenje mora biti na **promasajima**:
* u trenutku kada je rezultat `superseded` (oba su izvrsila) zapisati: `ourClaimAt`, `runnerStartAt`,
  `firstSawPeerClaimAt`, `deltaMs = firstSawPeerClaimAt - ourClaimAt`, `confirmMs`;
* iz toga se vidi da li je tudji zapis stigao **poslije** prozora (tada je rijec o latenciji gossip-a i o
  izboru prozora) ili **prije** (tada je rijec o necenu trecem — npr. provjera se desila prerano).

### Sto ostaje nepromijenjeno
`wins()` se **ne dira** (dokazano ispravan), `confirm` 600 ms se **ne dira**, `claim_lost_before_execute`
mjerenje ostaje (radi i korisno je). Otvoren je **jedan mjerni korak**, ne prepisivanje CRDT-a.

---

## 24. SUD SOAK-a #11 — `duplicateSameAttempt = 1`, ali `attemptFloor` je OTKRIO RECLAIM-STORM

```
trajanje:      3610 s (60 min) · 6 restarta
poslano:       17 286 / izvrseno 17 283
shed:          123  ⚠ NOVO        rate-limited: 203  ⚠ NOVO
p50 759 · p95 806 ms ✔   ·  p99 334 061 ms ✖  ·  max 1 006 674 ms (16,8 min) ✖
izgubljeno:    3   ✖
duplicateSameAttempt = 1  ✖ (cilj 0)     retryAfterKill = 8
dupCrossNode=9 · dupSameNode=0 · extraExecutions=9
heap vrh 102,2 MB · CRDT 8 730 / 8 745 / 0
```

### NALAZ KOJI JE VAZNIJI OD DUPLIKATA: `attempts=1,105`
```
retry: soak-task-2899  nodes=9163,9162  attempts=1,105   <- STO PET preuzimanja istog taska!
retry: soak-task-2900  nodes=9163,9162  attempts=1,2
```
`attemptFloor` (monotoni token) je ucinio upravo ono sto treba: **ucinio je storm VIDLJIVIM**. Task 2899 je
preuziman ~105 puta, sto objasnjava i **p99 5,6 min / max 16,8 min** (task nikad ne zavrsi, preuzima se
iznova) i velik dio `lost = 3`, i `shed = 123` + `rate-limited = 203` (red i gossip se pune pod stormom).

### Sta je POTVRDJENO (ostaje)
* `dupSameNode = 0` — `attemptFloor` + `executing` guard i dalje drze (nema ponovljenog istog attempt-a
  na istom cvoru),
* `duplicateSameAttempt = 1` u punom satu — **jedan** pravi duplikat, cross-node `1,1` (poznata rezidualna
  trka iz §19-§23, mjerenje na promasajima jos fali),
* `p95 806 ms`, `heap < 105 MB`, CRDT ogranicen.

### Sljedeci korak (mjeriti, ne pogadjati)
1. **Reclaim-storm**: brojati preuzimanja po tasku i logovati kada `attempt` predje prag (npr. 5) — sa
   `nodeId`, `instanceId`, razlogom (`lease istekao` / `LWW` / `result-query bez odgovora`).
2. Tek iz tog traga: zastita od ponovnog preuzimanja (npr. **backoff** po tasku — ako je task preuzet N
   puta bez rezultata, sacekaj prije sljedeceg preuzimanja).
3. Mjerenje na **promasajima** (`duplicate_result_write`, anchor treba procitati) za onaj `1,1`.
4. **Soak #12** tek poslije toga — kriterij nepromijenjen (`duplicateSameAttempt=0 · lost=0 · p95<=1,5 s ·
   heap<100 MB · shed=0 · rate-limited=0`).

---

## 25. KORIJEN STORM-a (izmjereno): claim ostaje zapisan kad cvor ODUSTANE od izvrsavanja

Kratki run (3 min, restart 45 s) sa brojacem preuzimanja po tasku (prag 5):

```
reclaim_storm redova: 790 (u 3 minuta!)
{"taskId":"soak-task-215","reclaims":5,"attempt":6,"nodeId":"soak-9182",
 "existingNode":"soak-9183","existingAttempt":1,"existingAgeMs":10826,
 "existingAlive":true,            <-- VLASNIK JE ZIV
 "leaseMs":10000,"graceMs":3000,"reason":"lease_istekao"}
takodje: lost = 167 ✖✖  (shed = 0)
```

### Sta ovo znaci (uzrocno-posljedicno)
1. Cvor **upise claim** u `tryClaim` (prije verifikacije i prije guard-a), pa **odustane** od izvrsavanja
   (izgubio LWW trku / `executing` guard / `ownerAfterConfirm` provjera) — **ali claim ostaje u tabeli**.
2. **Obnavljanje lease-a se pokrece u `runTask`**, a do njega ne dodje jer je cvor odustao → claim **nikad
   se ne osvjezava**.
3. Poslije `claimLeaseMs` (10 s) claim izgleda „mrtav" — iako je vlasnik **ziv** (`existingAlive: true`).
4. **Svi ostali ga preuzimaju** (`reason: lease_istekao`), svaki put sa **novim `attempt`** → token raste
   (1 → 105), task kruzi, p99 ode na minute, `lost` eksplodira (167 u 3 min).

**Zato je storm MASOVAN (790 u 3 min):** odustajanje je cesta pojava (u §20 je izmjereno **363 bail-a** u
3 min), a svaki bail ostavlja claim koji poslije 10 s izaziva novo preuzimanje.

### Tacna popravka (slijedi iz mjerenja, ne iz pogadjanja)
* **Odustajanje mora POVUCI claim** — kad cvor izadje iz izvrsavanja bez posla (`skipped`), mora
  obrisati/neutralisati svoj claim (`crdt.set(claimKey, { ...retired: true })` ili `crdt.delete`), da ne
  izgleda kao ziv vlasnik;
* **ili** claim pisati **tek poslije** verifikacije i provjere vlasnistva (kad je cvor siguran da izvrsava);
* uz to: ne dirati `grace`/`confirm` (mjerenja §20 pokazuju da nisu krivi).

### Veza sa rezidualnim duplikatom `1,1`
Isti mehanizam objasnjava i njega: masovna preuzimanja povecavaju sansu da dva cvora udju u runner u istom
prozoru. Zato se **prvo** rjesava storm — i tek onda, ako `1,1` ostane, mjeri se na promasajima.

### Kriterij za #12 (nepromijenjen)
`duplicateSameAttempt=0 · lost=0 · p95<=1,5 s · heap<100 MB · shed=0 · rate-limited=0`
`lost = 167` u kratkom runu pokazuje da je storm sada **najveci** problem — veci od duplikata.

---

## 26. SUD SOAK-a #12 — `lost=0` u punom satu, storm ~20x manji, ali `duplicateSameAttempt=6`

```
trajanje:      3601 s (60 min) · 6 restarta
poslano:       17 307 / izvrseno 17 307      <- lost = 0 ✔
shed:          0 ✔        rate-limited: 0 ✔
p50 753 · p95 782 ms ✔ · p99 801 ms ✔ · max 30 065 ms (jedan straggler)
heap:          12,5 -> 64,4 MB (vrh 105,3) ~ granicno
CRDT:          8 643 / 8 642 / 3 ✔
duplicateSameAttempt = 6 ✖        retryAfterKill = 8        dupSameNode = 0 ✔
reclaim_storm u satu: 812         (u #11: 790 u TRI MINUTA -> ~15 800/h; sada ~20x manje)
```

| Kriterij | Cilj | Sud |
|---|---|---|
| Izgubljeno | 0 | ✔ **0** (17 307/17 307) |
| Odbijeno (shed) | 0 | ✔ **0** |
| Rate-limited | 0 | ✔ **0** |
| p95 | <= 1,5 s | ✔ **782 ms** (p99 801 ms) |
| Heap | < 100 MB | ~ 105,3 MB (granicno) |
| **Duplo (isti attempt)** | 0 | ✖ **6** |
| `retryAfterKill` | odvojeno | 8 (ocekivano) |
| `reclaim_storm` | < 100/h | ✖ **812/h** (ali 20x manje nego prije) |

### Sto je popravka `withdrawOwnClaim` POSTIGLA (mjereno)
* **`lost` 167 -> 0** (kratki) i **0 u punom satu** — povlacenje claim-a je uklonilo masovna preuzimanja
  koja su jela kapacitet,
* `shed` i `rate-limited` su pali na **0** (u #11: 123 i 203),
* storm **~15 800/h -> 812/h** (~20x),
* `dedupSameNode = 0` i dalje.

### Sto je OSTALO (dva odvojena problema, oba mjerljiva)
1. **`duplicateSameAttempt = 6`** — svi istog oblika `attempts=1,1`, cross-node, razliciti cvorovi
   (`9222,9223`, `9221,9223`). To je rezidualna trka: oba cvora u SVOM lokalnom pogledu jesu vlasnici i
   **nijedan ne odustane** (zato `withdrawOwnClaim` tu ne pomaze). **Mjerenje na promasajima i dalje fali**
   (anchor za `duplicate_result_write` treba PROCITATI, pa dopuniti poljima) — to je sljedeci korak.
2. **`attempts=1,306`** (task 2898) — jedan task je i poslije popravke preuziman ~306 puta. Znaci da
   postoji put preuzimanja koji **ne prolazi kroz `withdrawOwnClaim`** (npr. `requeueStale` u redu ili
   ponovni claim bez bail-a). I to treba locirati iz traga (`reclaim_storm` daje `lastNode` i `reason`).

### Kriterij za #13 (nepromijenjen) — ali sada sa mjerenjem na promasajima
`duplicateSameAttempt=0 · lost=0 · p95<=1,5 s · heap<100 MB · shed=0 · rate-limited=0`

---

## 27. SUD SOAK-a #13 — storm 812 -> 34, `lost=1`, `duplicateSameAttempt=2`, i MISS TRAG OPET 0

```
trajanje:      3601 s (60 min) · 6 restarta
poslano:       17 291 / izvrseno 17 291
shed: 0 ✔    rate-limited: 0 ✔
p50 755 · p95 785 ms ✔ · p99 811 ms ✔ · max 12 560 ms
heap vrh 102,7 MB ~ granicno · CRDT 8 661 ✔
lost = 1 ✖ · duplicateSameAttempt = 2 ✖ · dupSameNode = 1 (!) · retryAfterKill = 7 · extraExecutions = 9
reclaim_storm u satu: 34      (soak #12: 812 · #11: ~15 800/h)  -> 24x manje nego u #12
miss trag (duplicate_result_write): 0 redova  <- OPET nista
```

### Napredak (mjereno)
* **`reclaim_storm` 812 -> 34** (a prije popravke ~15 800/h) — `withdrawOwnClaim` + normalna stopa,
* `shed = 0`, `rate-limited = 0`, `p95 785 / p99 811 ms`, `CRDT` ogranicen.

### Zasto MISS TRAG opet nije nista uhvatio (treci put u ovom dijelu)
Uslov je `priorResult.nodeId !== id` — ali kod **istovremenog** izvrsavanja oba cvora pisu `result:` u istoj ms,
pa LWW **jedan zapis prepise**; onaj koji cita prije nego sto je tudji zapis stigao **ne vidi prethodni
rezultat** → uslov ne prolazi → nema loga. Dakle: `result:` je **jedan kljuc** (kao i `claim:`) i **ne cuva
istoriju** — pa se iz njega ne moze rekonstruisati „ko je bio prvi".

### NOVI, OBJASNJIV NALAZ: `dupSameNode = 1`
Isti `nodeId` je izvrsio isti task dvaput (isti `attempt`). To je **restart slucaj**: `attemptFloor` je
**per-process** mapa, pa poslije restarta novi proces krece od 0 i moze ponovo izracunati `attempt = 1`
(tudji claim je u medjuvremenu nestao/istekao). Zato `attemptFloor` stiti od LWW-vracanja STAROG zapisa
unutar istog procesa, ali **ne preko restarta**.

**Popravka (sljedeca):** `attempt` floor izvesti iz **roja**, ne samo iz procesa — npr. iz `task:` zapisa
(`task.attempt`) ili iz `instanceId`-a u claim-u; tada restartovani cvor nastavlja od najviseg VIDJENOG
`attempt`-a za taj task, a ne od 1.

### Sljedeci korak (mjeriti, ne pogadjati)
1. Za `dupSameNode` slucaj: potvrditi restart hipotezu iz traga (`instanceId` razlicit, `nodeId` isti) —
   podaci su u `claimTrace`/`attempts` listi harness-a.
2. Za cross-node `1,1`: mjeriti na **claim** nivou, ne na `result:` — jer `result:` ne cuva istoriju:
   brojati **claim_set po (taskId, attempt)** sa razlicitim `nodeId` (to je direktan dokaz dvostrukog claim-a).
3. Tek iz toga: prozor ili mjesto provjere.

---

## 28. SOAK #14 — `duplicateSameAttempt = 0` U PUNOM SATU (kriterij zadovoljen)

```
trajanje:      3601 s (60 min) · 6 restarta cvora
poslano:       17 245 / izvrseno 17 245          -> lost = 0 ✔
shed:          0 ✔        rate-limited: 0 ✔
p50 758 · p95 787 ms ✔ · p99 819 ms ✔ · max 11 871 ms
heap:          12,3 -> 77,4 MB (vrh 111,1 MB)     ~ iznad 100 MB (jedini kriterij koji nije)
CRDT:          8 618 / 8 617 / 7 ✔
duplicateSameAttempt = 0 ✔✔✔      <- PRAVI KRITERIJ ISPUNJEN
dupSameNode = 0 ✔                 retryAfterKill = 10 (ocekivano, at-least-once)
reclaim_storm = 82/h              claim_double_attempt = 0 (cross-node isti attempt: nije se pojavio)
```

### Vazno o citanju brojeva
`duplo izvrseno: 10` u starom ispisu harness-a su **legitimna re-izvrsenja poslije ubijanja cvora**
(`retryAfterKill`, svaki sa NOVIM `attempt`-om) — sto je `at-least-once` ponasanje, ne greska. **Pravi
kriterij** (`duplicateSameAttempt`: isti `attempt` ponovljen) je **0**.

### Sta je zatvorilo put do 0 (sve mjereno)
| Mehanizam | Popravka | Dokaz |
|---|---|---|
| lease bez obnavljanja (11 200 duplih) | obnavljanje svakih lease/3 | #4: 43 |
| tabla bez GC-a (37 751 zapis, 240 MB) | `gc()` 10 min | #5: 1 500 zapis |
| lazni backpressure (`queued=500`) | real-backlog + `discard()` | #6: shed 0 |
| restart-trka | `grace` 3 s | #6: 11 |
| LWW vracao stari token (`1,2,2,2`) | `attemptFloor` | #12: dupSameNode 0 |
| odustajanje ostavljalo ziv claim (`lost=167`) | `withdrawOwnClaim` | #12: lost 0 · storm 812 -> 34 |
| restart resetovao token (`dupSameNode=1`) | `attempt` u `task:` pri claim-u | **#14: 0** |

### Jedini preostali kriterij: heap vrh 111,1 MB (> 100 MB)
Nije curenje (kraj 77,4 MB; GC radi) — to je **velicina GC prozora**: `gcAgeMs` 10 min pri ~4,8 t/s drzi
~2 900 zadataka u tabeli. Ako kriterij ostaje < 100 MB: `gcAgeMs` 10 -> 7 min (ili `result:` sazeti).

---

## 29. SUD SOAK-a #15 — `duplicateSameAttempt=0` DRUGI SAT ZAREDOM, ali heap NIJE pao (hipoteza oborena)

```
trajanje:      3611 s (60 min) · 6 restarta · 17 412 / 17 411
shed: 0 ✔        rate-limited: 0 ✔
p50 758 · p95 785 ms ✔ · p99 797 ms ✔ · max 16 163 ms
lost = 1 ✖
duplicateSameAttempt = 0 ✔✔      dupSameNode = 0 ✔      retryAfterKill = 8 (ocekivano)
heap: 11,2 -> 110,5 MB (vrh 110,5) ✖      CRDT: 6 138 / 6 134 / 3 (PALO sa 8 618)
reclaim_storm = 246 (bilo 82 u #14)      claim_double_attempt = 0
```

| Kriterij | Cilj | Sud |
|---|---|---|
| `duplicateSameAttempt` | 0 | ✔ **0** (drugi sat zaredom) |
| `dupSameNode` | 0 | ✔ 0 |
| `lost` | 0 | ✖ **1** |
| `p95` | <= 1,5 s | ✔ **785 ms** (p99 797 ms) |
| heap vrh | < 100 MB | ✖ **110,5 MB** (nepromijenjeno!) |
| `shed` | 0 | ✔ 0 |
| `rate-limited` | 0 | ✔ 0 |

### MOJA HIPOTEZA JE OBORENA: heap NE drzi CRDT
`gcAgeMs` 10 -> 7 min je **snizio CRDT** (8 618 -> 6 138 zapisa, -29 %), ali **heap vrh je ostao 110,5 MB**
(prije 111,1). Znaci: memoriju NE drzi tabela, nego **nestо drugo** — kandidati:
* `done[]` — niz sa **17 000+ zapisa** (svaki nosi `taskId, nodeId, attempt, ms, output, at`),
* `tasks` Map (lokalno poznati zadaci),
* `claimSetByAttempt` / `reclaimCount` / `attemptFloor` (moje dijagnosticke mape — rastu po tasku!),
* pheromone/tragovi.

**Sljedece mjerenje mora biti PO STRUKTURI, ne po tabeli:** logovati velicine (`done.length`, `tasks.size`,
`claimSetByAttempt.size`, `attemptFloor.size`, `reclaimCount.size`, `pheromone`) svakih 30 s i vidjeti koja
raste linearno sa 17 000 zadataka. Tek onda brisanje/ogranicavanje te strukture.

### `reclaim_storm` 82 -> 246 (paznja)
Kraci GC prozor moze da ucini da `result:`/`task:` zapis istekne dok ga neki cvor jos nije vidio — pa se
task **preuzme ponovo** (isti mehanizam kao „resurrect" tombstone-a, dokumentovan u `compact()`). To je
kandidat i za `lost = 1`. Vrijedi izmjeriti: broj preuzimanja taskova **koji su vec imali rezultat**.

---

## 30. NOSILAC MEMORIJE IZMJEREN — nije CRDT, nego `tasks` Map + MOJE DIJAGNOSTICKE MAPE

Run 5 min (1 468 zadataka), log po strukturi (`[mem-by-structure]`, svakih 30 s):

| struktura | start | kraj (1 468 zadataka) | rast | sud |
|---|---|---|---|---|
| `tasks` (Map) | 147 | **1 468** | **+1 321** | ✖ raste 1:1 sa zadacima, NIKAD se ne cisti |
| `attemptFloor` | 99 | **1 048** | +949 | ✖ moja dijagnosticka mapa, ne cisti se |
| `reclaimCount` | 99 | **1 048** | +949 | ✖ isto |
| `claimSetByAttempt` | 99 | **1 048** | +949 | ✖ isto |
| `myClaimAt` | 99 | **1 048** | +949 | ✖ isto |
| `claimEvents` | 74 | 562 | +488 | ~ ogranicen (poslije trace po zadatku) |
| `done[]` | 25–82 | 486–830 | +500–750 | ✖ raste sa svakim izvrsenjem |
| `crdt` | 437 | 4 400 | +3 963 | ✔ **ogranicen** (GC prozor 10 min) |
| heapUsed | 11,5 MB | **38 MB** | +26,5 | — |
| rss | 63 MB | 125 MB | +62 | — |

### Zakljucak (mjerena, ne pogodjena)
Heap **ne drzi CRDT** (on je ogranicen GC-om: 4 400 zapisa za 10-min prozor). Drze ga:
1. **`tasks` Map** — svaki zadatak koji je cvor vidio ostaje u mapi **zauvijek** (1 468 = tacno broj zadataka),
2. **cetiri dijagnosticke mape** koje sam ja dodao (`attemptFloor`, `reclaimCount`, `claimSetByAttempt`,
   `myClaimAt`) — svaka po ~1 048 unosa (zadaci koje je taj cvor dotakao), nikad se ne ciste,
3. `done[]` — po jednom zapisu za svako izvrsavanje.

Pri 17 000 zadataka/h to su ~**17 000 unosa × 5 mapa + 17 000 `done` zapisa** — i to je onih 110 MB.
**Zato `gcAgeMs` 10 -> 7 nije pomogao**: smanjio je tabelu, a ne nosioce.

### Popravka (sljedeca, jedna po jedna, sa mjerenjem)
1. **`tasks`**: u GC petlji brisati zapise za **zavrsene** zadatke starije od `gcAgeMs` (isti princip kao CRDT),
2. **dijagnosticke mape**: cistiti ih zajedno sa `tasks` (isti kljuc/taskId) — one smiju da postoje samo za
   **aktivne** zadatke (to je i bio cilj trace-a),
3. **`done[]`**: ring ili GC po starosti (za statistiku dovoljno zadnjih N),
4. ponoviti mjerenje (`[mem-by-structure]`) → tek onda **soak #16** sa svih sest kriterija.
