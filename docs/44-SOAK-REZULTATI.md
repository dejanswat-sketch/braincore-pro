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
