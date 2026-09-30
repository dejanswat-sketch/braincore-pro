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
