# MAJA UPUTSTVO — Braincore Pro ↔ BizniSoft veza

> **Maja ne uči novi program.** Ona i dalje radi u BizniSoftu, kao i do sada. Braincore roj radi
> PRIPREMU umjesto nje: predloži konto, provjeri PDV, spremi ulaznu kalkulaciju u „U obradi" — a Maja
> samo **F11 potvrdi** ono što je robot pripremio. Ništa više.

---

## Kako Maji radi (2 koraka)

### 1. Dvoklik na `pokreni-roj.bat`

Bat diže lokalni roj (3 čvora) i knjiga-radnika. Ne zatvaraj taj prozor dok radiš.

### 2. U BizniSoftu

```
Upravljanje eFakturama
  → Kreiranje ulaznih kalkulacija na osnovu primljenih eFaktura
    → vidi "U obradi"
      → F11 (Potvrdi)
```

Sve što robot pripremi sa **visokom pouzdanošću** dolazi tamo kao „U obradi" — Maja F11.

---

## Šta robot radi automatski (i šta NE smije sam)

| Slučaj | Šta se dešava |
|---|---|
| Konto predlog **pouzdan ≥ 0.92** (naučeno ≥ 3 puta iz Majinih knjiženja) | ulazna kalkulacija **„U obradi"** → Maja F11 |
| Konto predlog **< 0.92** | **ne knjiži sam** → fajl u `E:\knjige\za-proveru\` → Maja ručno |
| PDV stopa **nije 20/10/0** | **ne knjiži sam** → `E:\knjige\za-proveru\` → Maja ručno |

**Zašto tako:** robot uči **od Maje** (`konto_learning` — kad Maja 3× proknjiži isti dobavljač +
opis, robot to zapamti i dalje radi sam sa 95% pouzdanosti). Dok nema pravila, sve ide na provjeru —
sigurno, ne brzo. To je namjerno.

---

## Folderi

```
E:\knjige\ulaz\         — spremni dokumenti (robot čita odavde)
E:\knjige\za-proveru\   — NEŠTO SUMNJIVO: Maja otvori i odluči ručno
```

---

## Tačna linija roja (poznata zamka)

```bat
set NMQ_EXTERNAL_TYPES=knjiga-
node src\index.js --port 8001 --api-port 8081 --nodes 3
```

`NMQ_EXTERNAL_TYPES=knjiga-` **MORA** biti postavljen — inače roj sam izvrši `knjiga-*` taskove
umjesto da ih ostavi radniku. (Dokazano: roj preskače, radnik uzima, `done` u 17–33 ms.)

---

## Rate limit (za test/soak, ne za Maju)

- **2 taska/s po ključu** = 120/min (tenant limit).
- Za soak na 5/s koristi **5 ključeva round-robin** (svaki 1/s) → ukupno 5/s bez ijednog 429.
- To je dokaz za Fazu 3/proizvod: `jedan ključ 2/s · pet ključeva 10/s · 0 izgubljenih`.

---

## Stvarno stanje (bez Tailscale-a)

- Lokalni PC je na Tailscale (`100.99.123.41`, adapter **Up**) — ali **Hetzner nema Tailscale** i
  **ne treba nam sad**. Tailscale bi dao „kućni PC = 12–14/s" broj, ali to je nice-to-have.
- Zakon iz `docs/43-BENCHMARK.md` (`30c9dcd`) ostaje: **2 roja na 1 mašini = ~8/s, ne 16/s**, jer
  `claimConfirmMs 600 ms` serijalizuje claim po čvoru. „Svaki host +8/s" traži **odvojen fizički host**.
- Za BizniSoft je **jedan Hetzner host dosta** (~28 000 faktura/h); kućni PC ne mora stalno da radi.

---

## Dokaz da put radi (izmjeren)

```
sveža faktura (bez result:) →
  1) roj PRESKOČI (externalTypes, state='' poslije 6 s)
  2) worker uzme (33 ms)
  3) predict_konto → konto 4330, confidence 0.95 (naučeno pravilo)
  4) ulazna kalkulacija: faktura #41, konto 4330, status "spremno_za_biznisoft" (= U obradi)
  5) Maja F11 → Proknjiženo
```

Niski confidence (0.6, bez pravila) → `E:\knjige\za-proveru\FAKT-2026-001.json` (Maja ručno).
