# 45 — VIDEO DEMO: „I killed a production node and nothing happened"

> Snima se **samo ako soak #3 prođe** kriterije (`shedByBackpressure = 0`, `izgubljeno = 0`,
> `duplo = 0`, `p95 ≤ 1,5 s`, heap < 100 MB). Do tada je hero na sajtu o evaly (24/24 = 100 %) i
> arhitekturi — to je već tačno i ne mijenja se.

## Priprema (5 min prije snimanja)
1. Na Hetzneru: `systemctl is-active braincore-api braincore-node@8002 braincore-node@8003` → sva tri `active`.
2. `node scripts/chaosctl.mjs status` → `chaos: ARMED`, `peersAlive: 3`.
3. Otvori dva taba: `https://live.braincore.pro/live` i `https://braincore.pro` (drugi samo za uvodni kadar).
4. Pusti nekoliko taskova da dashboard ima šta da prikaže:
   `curl -s https://api.braincore.pro/task -H 'content-type: application/json' -d '{"type":"support.ticket","payload":{"text":"Where is my order?"}}'`
5. Snimi ekran u 1080p/60, bez zvuka (dodaće se muzika).

## Scenario (60–75 s)
| # | Radnja | Šta se vidi / šta reći |
|---|---|---|
| 1 | Kadar na dashboard (t+0) | „Three nodes, live. 7.5 tasks per second, p95 under a second, zero lost, zero overlaps." |
| 2 | Uključi **CHAOS MODE** (arm) | „Fail-safes first: it can never kill the API node, one kill per minute, everything is audited." |
| 3 | Klik **KILL NODE** → potvrdi | Dugme se zaključava, u logu: `! NODE-02 termination initiated…` |
| 4 | Čekaj ~2 s | Mapa: hex postaje **crven**, `DETECTION — node-02 is 'suspect'` |
| 5 | Čekaj još ~1 s | `REJOIN — node-02 is back` + `integrity: 0 lost · N tasks · 0 overlaps — verified` |
| 6 | Završni kadar | „Production node killed. Zero tasks lost. Zero duplicates. That is measured, not promised." |

## Brojevi koje smiješ izgovoriti (samo ako su iz soak-a #3)
* 3-node swarm, **p95 ≤ 1,5 s** pod trajnim opterećenjem od **5 taskova/s** kroz **60 minuta**
* **0 izgubljenih**, **0 duplih izvršenja**, **0 odbijenih zbog backpressure-a** pri tom opterećenju
* heap stabilan (< 100 MB), CRDT tabla ograničena (GC)
* smrt čvora detektovana ~1,3–2,2 s, povratak ~3 s (mjereno klikom i CLI-jem)

## Šta se NE smije izgovoriti
* Da 8 t/s radi u jednom procesu — **ne radi**; pri 8 t/s sistem odbija ~85 % (to je ispravno, ali nije kapacitet).
* Da je skaliranje na 25 čvorova dokazano — bench pokazuje da se **jedan proces** guši; skaliranje traži više procesa/hostova.
* Bilo koji broj iz soak-a #1/#2 kao da je završni (11 200 duplih je bio stvarni pad — i o njemu se smije govoriti kao o tome kako se mjeri i popravlja).

## Alternativa bez klika (isti dokaz, za automatizaciju)
```bash
node scripts/chaosctl.mjs kill --random --confirm    # ispiše DETECTION i REJOIN sa vremenima
```