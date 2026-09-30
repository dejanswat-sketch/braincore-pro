# Zašto 1h soak a ne 3-minute test — kako smo našli 11.200 duplih izvršenja

*Braincore Pro · inženjerska bilješka · 30.09.2026.*

Kratki testovi su nam davali lijepe brojeve: **0 izgubljenih, 0 duplih, p95 ispod sekunde**. Radili smo
ih po 1–3 minuta i vjerovali im. Onda smo pustili isti test **sat vremena** i dobili ovo:

```
trajanje:      60 min
poslano:       25 707
izvršeno:      25 697
duplo:         11 200      ← 44 % posla izvršeno dvaput
izgubljeno:    10
latencija:     p50 883 ms · p95 938 518 ms (15 minuta!) · max 18 min
heap:          16 MB → 215 MB (vrh 240 MB)
CRDT tabla:    37 751 zapis po čvoru
```

Brojke su iz našeg repoa, ne iz prezentacije. Ovako smo došli do njih — i šta je bilo pogrešno.

## Uzrok #1: lease koji ističe dok vlasnik još radi

Zadatak preuzima **jedan** čvor (claim u CRDT tabli) i dobija lease od **10 sekundi**. Ako čvor umre,
lease istekne i drugi čvor preuzme posao — tako nema izgubljenih zadataka.

Problem: pod zasićenjem izvršenje je trajalo **duže od 10 sekundi** (p95 je otišao na 15 minuta), ali
vlasnik **nije obnavljao lease**. Drugi čvorovi su zaključili „vlasnik je mrtav" i preuzeli isti zadatak.
Pa opet. I opet. Zato **11 200 duplih izvršenja** — ne zato što je logika preuzimanja pogrešna, nego zato
što nije imala povratnu informaciju „još radim".

**Popravka:** vlasnik osvježava `claim.at` svakih **`lease / 3` (3,3 s)** i oglašava svježi zapis roju.
Ako u međuvremenu izgubi vlasništvo, obnavljanje se samo zaustavlja — ne obnavljamo tuđi zapis.
Rezultat poslije popravke: **0 duplih** u istom satu.

## Uzrok #2: tabla koja raste zauvijek

Naši `task:`, `result:` i `claim:` zapisi su „živi" — kompakcija je brisala samo **tombstone-e**
(obrisane ključeve), pa je poslije 25 000 zadataka tabla imala **37 751 zapis** i heap **240 MB**.

**Popravka:** `gc({ olderThanMs: 15 min })` briše završene zapise, a čuva:
- ono što je ovaj čvor **trenutno preuzeo**,
- **nezavršene** zadatke,
- **žive** claim-ove.

Brojači (koliko je završeno) žive **izvan tabele**, pa GC ne kvari tačnost. Rezultat: **1 500 zapisa**,
heap **76 MB**.

## Uzrok #3: lažni backpressure (i zašto su nam brojevi lagali)

Drugi soak je prijavio **23 179 izgubljenih** zadataka. Zvučalo je katastrofalno. Nije bilo izgubljeno —
bilo je **odbijeno**, i to iz pogrešnog razloga: na putu kroz čvor zadatak se **ne uzima** preko
`queue.pop()` (preuzimanje ide kroz CRDT), pa se red **nikad nije praznio**. `queued` je rastao dok nije
udario u prag 500 → sistem je počeo da odbija posao **bez stvarnog opterećenja**.

**Popravka:** backpressure se računa po **stvarnom backlogu** (nezavršeni zadaci u tabli), a `discard()`
uklanja zadatak iz reda kad završi. Uz to, naš **mjerni alat** sada razlikuje „sistem je odbio višak"
(kapacitet) od „sistem je izgubio posao" (greška). Do tada smo mjerili sopstvenu grešku u mjerenju.

## Uzrok #4: jedan tenant može da zagusi mašinu

Pri 8 zadataka/s u **jednom procesu** event loop se zasićuje. To nije bug roja — to je granica jednog
procesa. Ali znači da je jedan klijent mogao da podigne latenciju svima.

**Popravka:** rate limit **po ključu/tenantu** (120/min), plus **metering** (taskovi, agent-sati,
odbijeni) po tenantu — tačno za naplatu, i vidljivo u Prometheus-u
(`nmq_tenant_tasks_total{tenant="..."}`).

## Šta smo naučili (i zašto ovo objavljujemo)

1. **Kratki test daje lažnu sigurnost.** Sat vremena je otkrio klasu grešaka koju tri minuta ne mogu.
2. **Brojka „izgubljeno" je besmislena ako alat ne razlikuje odbijanje od gubitka.** Prvo popravi mjerenje.
3. **Lease bez obnavljanja je vremenska bomba.** Radi savršeno dok je sve brzo, i raspada se tačno onda
   kada ti treba.
4. **Sve što raste zauvijek će se srušiti.** Tabla, red, memorija — sve treba granicu.

Većina bi ovaj run sakrila. Mi smo ga objavili, popravili i **ponovili isti test** — jer jedini broj koji
nešto znači je onaj koji izdrži sat vremena.

> **Measured, not promised.**

*Metodologija: 3 čvora u jednom procesu (loopback), 5–8 zadataka/s, restart čvora svakih 10 minuta,
`node scripts/soak.mjs`. Mrežna particija između fizičkih hostova nije simulirana — to je sljedeći korak.*
