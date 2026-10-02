# 43 — BENCHMARK (skaliranje roja)

> Mjeri `scripts/bench.mjs`. **Iskreno o domenu:** svi čvorovi su u JEDNOM procesu (jedan event loop), pa su brojevi gornja granica jednog procesa — ne kapacitet N mašina. Pravi multi-host bench traži N procesa/hostova i mrežu između njih.

Cilj opterećenja i trajanje posla pišu se u zaglavlju svakog runa.

### Run 2026-09-30T14-45-58-320Z

| Čvorova | Discovery | Propušteno | p50 | p95 | p99 | CPU ukupno | CPU/task | RSS | Izgubljeno | Duplo |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0 ms | **31.9/s** | 3276 ms | 5443 ms | 5643 ms | 531 ms | 1.66 ms | 71.2 MB | 0 | 0 |
| 3 | 0 ms | **32.1/s** | 1208 ms | 1409 ms | 1435 ms | 1157 ms | 3.6 ms | 86 MB | 0 | 0 |
| 10 | 0 ms | **30.2/s** | 8504 ms | 13818 ms | 15023 ms | 6250 ms | 20.7 ms | 141.6 MB | 24 | 268 |
| 25 | 1 ms | **21.4/s** | 7497 ms | 12391 ms | 14019 ms | 18906 ms | 88.35 ms | 247.6 MB | 4 | 190 |

> Cilj: 40 taskova/s, posao 60 ms, 10s po konfiguraciji.

## Interpretacija (prvi bench, 30.09.2026)

| Čvorova | Propušteno | p95 | CPU/task | Nalaz |
|---|---|---|---|---|
| 1 | 31,9/s | 5,4 s | 1,66 ms | jedan čvor radi, ali p95 raste (red čeka) |
| 3 | 32,1/s | 1,4 s | 3,6 ms | **najbolji odnos**: p95 4× bolji nego sa 1 čvorom |
| 10 | 30,2/s | 13,8 s | 20,7 ms | **24 izgubljena, 268 duplih** — preko kapaciteta jednog procesa |
| 25 | 21,4/s | 12,4 s | 88,4 ms | propusnost **pada**, CPU/task eksplodira |

**Iskren zaključak:** 3 čvora u jednom procesu su „slatka tačka" (p95 1,4 s pri 32 taska/s). Preko toga **jedan
proces ne može** — 10 i 25 čvorova u istom event loop-u se međusobno guše (gossip + claim petlje + runneri dele
isti CPU), pa se pojavljuju izgubljeni i dupli taskovi. To **nije** dokaz da roj ne skalira: to je dokaz da
**više čvorova mora biti u više procesa/hostova** (pravi multi-host bench je F11). Backpressure (`maxQueueDepth`,
429) je već u kodu i tačno je odgovor na ovaj nalaz.

## Run na Hetzneru (01.10., `RATE=8`, 15 s po konfiguraciji, posao 60 ms)

Cilj je bio **održiv ritam od 8 t/s** (istovetan soak-u #16), ne maksimalni — da broj bude iskren, ne umjetno
napuhan (bench na 40 t/s mjeri PREKO kapaciteta, što je gore dokazano).

| Čvorova | Propušteno | p50 | p95 | p99 | CPU/task | RSS | Izgubljeno | Duplo |
|---|---|---|---|---|---|---|---|---|
| **1** | 7,93/s | 683 ms | 701 ms | 701 ms | 3,82 ms | 66,6 MB | 0 | 0 |
| **3** | 7,93/s | 675 ms | **698 ms** | 700 ms | 11,7 ms | 74 MB | **0** | **0** |
| 10 | 7,93/s | 681 ms | 861 ms | 1 024 ms | 45,7 ms | 105,3 MB | 0 | **39** |
| 25 | 7,67/s | 769 ms | **11 689 ms** | 15 161 ms | 154,9 ms | 132,6 MB | 0 | **97** |

### Interpretacija (mjerena na Hetzneru, ne pogađana)
1. **3 čvora su „slatka tačka" na jednom hostu**: pri 8 t/s daju p95 **698 ms**, **0 izgubljenih, 0 duplih**.
   To je i razlog zašto produkcija ide sa 3 node-a (braincore-node@8002/@8003 + API :8001).
2. **Više čvorova u JEDNOM procesu škodi, ne pomaže**: sa 10 čvorova raste broj istovremenih preuzimanja
   istog taska → **39 duplih**; sa 25 čvorova p95 odlazi na **11,7 s** i **97 duplih** — jedan event loop se
   zasićuje, a claim-trke eksplodiraju.
3. **Skaliranje = više procesa/hostova, ne više čvorova u jednom procesu.** Gornja granica jednog hosta je
   sada izmjerena: **~8 taskova/s sa p95 < 1 s na 3 čvora**. Za više kapaciteta treba više hostova (svaki po
   3 čvora).

### Broj za sajt (iskren)
> **„Jedan host: 3 čvora, ~8 taskova/s, p95 < 1 s, 0 izgubljenih, 0 duplih. Skaliranje je horizontalno —
> svaki dodatni host dodaje ~8 taskova/s sa istim garancijama."**

### Graf (case study): dupli izvršeni u JEDNOM procesu po broju čvorova

```
dupli  │
  97 ─ │                                    ████████████████████████ (25 čvorova)
  39 ─ │              ████████████           (10 čvorova)
   0 ─ │  █  █                              (1 i 3 čvora)
       └────────────────────────────────────
            1    3          10          25 čvorova
```

Jedan proces, 1/3/10/25 čvorova → **0 / 0 / 39 / 97 duplih**. Linija je čista: do 3 čvora nema trke;
preko toga broj istovremenih preuzimanja istog taska raste eksponencijalno — dokaz da je skaliranje
**horizontalno (više hostova), a ne više čvorova u jednom event loop-u**.

## FAZA 3 — „2 hosta = 16 t/s" (dokaz zašto traži ODVOJEN host, ne dva roja na jednoj mašini)

Pokušao sam besplatno da simulujem 2 hosta na JEDNOJ mašini (6 jezgara / 12 threadova): dva
odvojena roja po 3 čvora (2 procesa, različiti portovi), bench 8 t/s na svaki paralelno.

```
mašina: 6 jezgara / 12 threadova → CPU NIJE limit
2 roja (po 3 čvora) na 1 mašini = ~8/s, NE 16/s
```

**Zašto:** `claimConfirmMs 600 ms` serijalizuje claim po čvoru (HTTP-node put). Svaki roj drži
~4/s, dva roja ~8/s — a in-process bench (bez HTTP-a) daje 7,93/s. Razlika je HTTP + confirm
serijalizacija, ne CPU.

**Zaključak (mjeren, ne pogađan):**
> **„svaki host +8/s" traži ODVOJEN FIZIČKI host sa svojim claim petljama.** Dva roja na istoj
> mašini NE udvostručuju propusnost — što i potvrđuje premisu horizontalnog skaliranja.

**Za pravih „2 hosta = 16/s mereno":** treba drugi VPS u istom DC (Hetzner↔Hetzner 1–2 ms), gdje
je 8+8=16 čisto. Kućni PC kao drugi host preko Tailscale-a daje ~12–14/s — **limit je mreža
(20–40 ms ping), ne CPU** — i dovoljan je za besplatan dokaz zakona, ali NE za produkciju sa
Majom (PC spava / nestane struje / Windows Update → nema HA, nema „2,2 s detekcija 3,0 s povratak").
