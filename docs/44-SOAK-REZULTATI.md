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
