# 45 — VIDEO DEMO: „I killed a production node and nothing happened"

> Snima se **samo ako je soak prošao sve kriterije**. Finalni snimak je **soak #16** — jedini run u kome je
> svih šest zeleno u punom satu. Do tada je hero na sajtu o evaly (24/24 = 100 %) i arhitekturi.

## Finalni brojevi (soak #16 — ovo je jedino što se smije izgovoriti)

| Šta | Broj |
|---|---|
| Roj | **3 čvora**, jedan host |
| Trajanje / opterećenje | **60 minuta**, **5 taskova/s** |
| Restarti tokom runa | **6** (čvor vraćen svakih 10 min) |
| Izgubljeno | **0** (17 378 / 17 378) |
| Duplih **istog attempt**-a | **0** (`duplicateSameAttempt = 0`) — dva sata zaredom (#14 i #16) |
| Latencija | p50 756 · **p95 783 ms** · p99 788 · max 11,7 s |
| Heap | start 15,8 → kraj 80,1 MB · **vrh 99,6 MB** (< 100) |
| CRDT | 8 704 / 8 702 / 15 (GC drži ravno) |
| Backpressure / rate-limit | **0 / 0** |
| KILL NODE | prihvaćeno **9–33 ms** · detekcija **2,2 s** · povratak **3,0 s** · **0 izgubljenih** |

`retryAfterKill = 4` se **smije** pomenuti kao legitimno at-least-once ponavljanje (novi `attempt`), ali se
**ne smije** miješati sa `duplicateSameAttempt` (koji je 0). To su dvije različite stvari i to je poenta.

## Scenario (90 s) — automatski, bez klika

Snima se skriptom (bez npm-a):

```bash
SCENES="0:https://braincore.pro,18:https://live.braincore.pro/live" \
TRAFFIC=10 KILL_AT=44 \
CAPTIONS="2:Braincore Pro — a decentralized AI swarm|18:Three nodes, live on Hetzner|24:60 minutes · 5 tasks/s · 6 restarts|30:0 lost · 0 duplicates of the same attempt · p95 783 ms|36:Heap peak 99.6 MB · shed 0 · rate-limited 0|44:Now — killing a production node|52:Death detected in 2.2 s|60:Rejoined in 3.0 s — zero tasks lost|70:Measured, not promised. braincore.pro" \
node scripts/record-video.mjs https://braincore.pro docs/kill-node.webm 88 44
```

| # | Kadar | Šta se vidi / titl |
|---|---|---|
| 1 | 0–18 s | `braincore.pro` — aurora, šareni swarm, stakleni mozak sa živom jezgrom, robotski egzoskelet |
| 2 | 18–44 s | `live.braincore.pro/live` — 3 čvora, feromoni koji blede (TTL), task čestice pod 10 t/s |
| 3 | **44 s** | **KILL NODE** → `{"killed":true,"nodeId":"node-8002","acceptedInMs":9}` |
| 4 | 44–62 s | čvor postaje crven, `DETECTION — 'suspect'` u ~2,2 s |
| 5 | 62–88 s | `REJOIN — back` u ~3,0 s, `integrity: 0 lost · 0 overlaps` |

## Šta se NE smije izgovoriti
* Da 8 t/s radi u jednom procesu — **ne radi**; bench pokazuje 3 čvora kao slatku tačku (7,93/s, p95 698 ms, 0/0).
* Da je skaliranje na 25 čvorova dokazano — **jedan proces** se guši (39 i 97 duplih na 10 i 25 čvorova);
  skaliranje traži više **hostova**.
* Bilo koji broj iz soak-a #1/#2 kao završni (11 200 duplih je bio stvarni pad — o njemu se smije govoriti
  samo kao o tome **kako se mjeri i popravlja**).

## Alternativa bez klika (isti dokaz, za provjeru)
```bash
node scripts/chaosctl.mjs kill --random --confirm    # ispiše DETECTION i REJOIN sa vremenima
```
