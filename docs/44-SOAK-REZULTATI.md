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
