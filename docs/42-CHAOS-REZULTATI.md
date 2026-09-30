# 42 — CHAOS REZULTATI (izdržljivost roja pod kvarom)

> Dokaz, ne obećanje. Harness: [`scripts/chaos.mjs`](../scripts/chaos.mjs) (3 node-a kao **procesi**,
> `SIGKILL` nad najzauzetijim, zajednički JSONL zapis svakog izvršenja).
> Pokretanje: `node scripts/chaos.mjs --tasks=24 --delay=300 --json=docs/chaos-runX.json --keep-log`

**Domen mjerenja (iskreno):** loopback, ubijanje **procesa**. Mrežna particija (odvojena mreža, `iptables`,
namespaces) **nije** simulirana — za to trebaju dva hosta (F6/F11 iz transparentnog izvještaja).

## 1. Rezultati kroz iteracije

| Run | Zadatak | claim verify | Fix koji je ušao | Završeno | Izgubljeno | Preklopljeno (BUG) | Ponovni rad | Detekcija smrti |
|---|---|---|---|---|---|---|---|---|
| 1 | 18 / 400 ms | 120 ms | — (baseline) | 13/18 | **5** ✖ | 0 | 0 | **nije detektovano (>6 s)** ✖ |
| 2 | 18 / 400 ms | 120 ms | tračevi ne produžavaju život | 13/18 | **5** ✖ | 0 | 0 | 1329 ms ✔ |
| 3 | 18 / 400 ms | 120 ms | **claim lease** (10 s) + grace 1.5 s | **18/18** | **0** ✔ | 0 | 0 | 1330 ms ✔ |
| 4 | 24 / 300 ms | 120 ms | — | 24/24 | 0 ✔ | **1** ✖ | 1 | 1137 ms |
| 5 | 24 / 300 ms | 120 ms | fencing `attempt` + dedupe po `result:` | 24/24 | 0 ✔ | **2** ✖ | 2 | 1144 ms |
| 6 | 24 / 300 ms | **600 ms** | settle = 2× gossip interval | 24/24 | 0 ✔ | **2** ✖ | 2 | 1247 ms |
| 7 | 30 / 250 ms | 600 ms | — | 30/30 | 0 ✔ | **4** ✖ | 4 | 1365 ms |
| 8 | 24 / 300 ms | 600 ms | **`result-query`** (pitaj roj prije ponovnog rada) | 21/24 | **3** ✖ | **0** ✔ | 10 | 1260 ms |
| 9 | 24 / 300 ms | 600 ms | — (ponavljanje) | 21/24 | 3 ✖ | **1** | 1 | 1267 ms |

„Preklopljeno" = dva izvršenja **istog taska** koja se **preklapaju u vremenu** (dva čvora rade isti posao
istovremeno) — to je prava greška. „Ponovni rad" = drugo izvršenje **poslije** prvog (posao završen, potvrda
izgubljena) — to je cijena „at-least-once" isporuke, ne greška u tabeli.

## 2. Šta je popravljeno (i zašto je bilo ozbiljno)

| # | Nalaz | Uzrok | Popravka | Dokaz |
|---|---|---|---|---|
| 1 | Mrtav čvor nije bio proglašen mrtvim **>6 s** | Tuđi **digest** (tračevi) je osvježavao `lastSeen` mrtvom čvoru → failure detection nikad ne opali | `upsertMember(info, { direct: false })` — tračevi samo **upisuju** nepoznatog člana, nikad ne produžavaju život | run 2: 1329 ms; regresioni test u `tests/chaos.test.mjs` |
| 2 | **5 od 18 taskova izgubljeno** poslije `SIGKILL` | Claim je bio vječan: task koji je držao mrtvi čvor ostajao je „preuzet" zauvijek | **claim lease** (`claimLeaseMs` 10 s) + `claimGraceMs` 1.5 s + `isClaimLive()` (vlasnik mora biti živ) | run 3: 18/18, 0 izgubljenih |
| 3 | **Preklopljeno duplo izvršenje** (2–4 u 24–30 taskova) | Claim verifikacija 120 ms < gossip interval 300 ms → tuđi claim stigne **poslije** naše verifikacije i oba čvora rade | `claimConfirmMs = max(600, 2× gossip interval)` (ne može se podesiti niže) | run 8: 0 preklopljenih |
| 4 | Ponovni rad zbog izgubljene potvrde | Čvor završi posao, pa umre prije nego što rezultat stigne do ostalih | **`result-query`**: prije ponovnog izvršavanja pitaj roj da li neko ima rezultat (600 ms prozor), pa odustani ako ima | run 8: ponovni rad pao na 1–2 (s 10 na 1 u run 9) |

## 3. Šta je ostalo otvoreno (i to je sada glavni posao)

1. **Nedurabilno primanje taska (najvažnije).** Ako čvor primi task i umre **prije** nego što ga raširi
   (gossip je best-effort, interval 300 ms), task nestaje s njim — u runu 8/9 to su ona 3 „izgubljena" bez
   ijednog zapisa u logu. Popravka: **durable submit** — `POST /task` se vraća tek kad bar jedan peer potvrdi
   da ima task (quorum 1), uz retry i `Idempotency-Key`.
2. **Particija i dalje nije izmjerena.** Sav „split-brain" rizik je time nedokazan u realnim uslovima;
   treba test sa dva hosta i blokiranim UDP-om (F6/F11).
3. **Ponovni rad je i dalje moguć** (1–2 u 24). To je legitimno za „at-least-once", ali efekti moraju biti
   idempotentni — zato task nosi `idempotencyKey`, a `runTask` bilježi `superseded` kad izgubi vlasništvo.
4. **Propusnost pod opterećenjem** nije mjerena (Sprint 5): ovdje je 5–13 taskova/s na 3 procesa sa
   runner-om od 250–400 ms, na jednoj mašini.

## 4. Kako se ovo pušta (i šta se gleda)

```bash
node scripts/chaos.mjs --tasks=24 --delay=300 --keep-log
node scripts/chaos.mjs --tasks=48 --delay=200 --kill=busiest --verbose
```

Kriteriji prihvatanja (acceptance):
* `preklopljeno (BUG) = 0` — **mora**; ako nije 0, to je greška koja se odmah popravlja.
* `izgubljeno = 0` — mora poslije **durable submit** popravke (do tada se prijavljuje kao otvoreno).
* `detekcija smrti < 2× failureTimeout` (1200 ms → do 2400 ms) — trenutno ~1.1–1.4 s ✔.
* `ponovni rad` se **ne** skriva: broji se i prijavljuje (at-least-once), a efekti su idempotentni po
  `idempotencyKey`.

## 5. Veza sa planom (`docs/40`)

Sprint 2 je time djelimično isporučen: harness postoji, dvije teške greške su nađene i popravljene, treća
(durable submit) je definirana kao sljedeći zadatak. Sve dalje (fencing na nivou kvorema, particija, soak
test) ostaje kako je u planu — sa ovim brojevima kao polaznom tačkom.
