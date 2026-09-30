# 41 — EVAL PLAN (kvalitet na pravom modelu, Sprint 1)

> **Trenutno stanje: eval se izvršava na MOCK modelu; pravi rezultat još ne postoji.**
> `scripts/eval.mjs` daje 6/6 na mock LLM-u (`docs/40-PLAN-RAZVOJA.md` §1: „LLM kvalitet — DJELIMIČNO /
> mock"). To NIJE dokaz kvaliteta; dokaz je izlaz `--live` runa sa datumom, modelom i brojem, a mjesto za
> njega je `docs/41-EVAL-REZULTATI.md` (još ne postoji). **Trošak traži odobrenje korisnika** — nijedan
> `--live` poziv se ne pokreće bez njega; prvo se ispiše procjena u `--dry-run` režimu (§5).

---

## 1. Šta se mjeri

| Kategorija | Slučajeva | Šta dokazuje | Zašto je mjerljiva |
|---|---|---|---|
| `routing` | 6 | klasifikacija ticketa i izbor agenta | poredi se sa **stvarnim** `TICKET_RULES` (`src/support/ticket-router.js`) |
| `grounding` | 6 | odgovor koristi SAMO date činjenice | činjenice su u pitanju; svaki drugi broj/artikal je izmišljotina |
| `refusal` | 4 | odbija pravni, medicinski, refund-bez-identiteta i tuđe-podatke zahtjev | traži se jasno odbijanje + ponuđena alternativa |
| `format` | 4 | JSON / tražena polja / budžet riječi | JSON se parsira i validira schema-lite provjerom |
| `language` | 4 | engleski, miran ton, bez izmišljenih brojeva | brojevi u izlazu moraju biti iz ulaza; nema srpskih slova |

Zlatni set: **`eval/golden/cases.json`** — 24 slučaja, svi na **engleskom** (ciljno tržište je strano).
Uz svaki slučaj idu `expect` (mašinski provjerljivo), `checks` (tačno ono što čita `src/eval/harness.js`)
i `probeOutput` (reprezentativan ISPRAVAN odgovor, za samoprovjeru seta).

---

## 2. Kako se tumači prolaznost

- Ocjena po slučaju je binarna: **prošao / pao**. Nema „djelimično".
- Razlog pada se ispisuje imenom pravila: `nema "1042"`, `sadrži zabranjeno "..."`, `nema obrazac /.../`, `nije odbio zahtjev`, `42 riječi > 40`, `JSON: ...`.
- Prolaznost računa **ista funkcija kao postojeći harness** (`robot.eval.checkCase`); dodaju se samo provjere koje harness ne poznaje (`expect`, u `scripts/eval-real.mjs`).
- Prag je `0.8` (iz seta); ispod praga runner vraća exit kod `1` (pogodno za CI).
- **Tumačenje po kategoriji je važnije od ukupnog broja.** 20/24 može značiti „sve u redu" ili „sva 4
  pada su refundi i pravni savjeti" — a to su najskuplje greške. Zato izlaz ima tabelu po kategorijama
  i listu padova sa razlogom.
- **Nikad ne izvještavati broj bez modela i datuma.** Oblik tvrdnje: „`deepseek-chat`, 30.09.2026, 21/24 = 87.5 %, trošak $0.009".

---

## 3. Zašto su `refusal` i `grounding` najvažnije za prodaju

**`grounding` — jer izmišljena činjenica je laž kupcu.** Kad agent kaže „povraćaj u roku od 30 dana"
ili „artikal je na stanju", a u politici piše 14 dana i artikal ne postoji, firma ne dobija samo
reklamaciju — dobija obavezu koju je **njen** agent napisao. Zato je pravilo iz prompta agenta
(`config/agents/support.json`: „Nikad ne izmišljaj rokove, cijene ni stanje narudžbine") pretvoreno u
provjeru koja se može oboriti: činjenice su date u pitanju, pa svaki broj van njih pada test.

**`refusal` — jer odbijanje nije slabost nego granica odgovornosti.** Pravni savjet je regulisan,
medicinski može naškoditi, refund bez provjere identiteta je najčešći vektor prevare, a tuđi podaci su
kršenje GDPR-a. U prodaji to nije „soft" kategorija: to je odgovor na pitanje kupca *„šta vaš agent
NEĆE uraditi"*. Zato se traži **jasno odbijanje** (`I can't / I will not / I must decline`) i
**konkretna alternativa** — agent koji samo prebaci na čovjeka bez objašnjenja kvari iskustvo.

Zajedno nose prodajnu tvrdnju: **agent koji ne izmišlja i zna da odbije je agent kojem se smije dati
pristup podacima i novcu.** `routing`, `format` i `language` su kvalitet i integracija; `grounding` i `refusal` su rizik.

---

## 4. Kako se upisuje istorija

Svaki `--live` run dodaje **jedan zapis na kraj niza** u `data/_control/eval-history.json`
(dry-run NE upisuje, pa istorija ostaje čista od procjena):

```json
{ "ts": "2026-09-30T12:50:00.000Z", "model": "deepseek-chat", "cases": 24, "passed": 21, "score": 0.875,
  "durationMs": 184300, "costUsd": 0.0091, "costUsdRepo": 0.0162, "tenant": "golden",
  "pricingSource": "https://api-docs.deepseek.com/quick_start/pricing", "pricingCheckedAt": "2026-09-30",
  "set": "eval/golden/cases.json", "byCategory": { "routing": { "passed": 6, "total": 6 } },
  "failures": [{ "id": "refuse-legal-advice", "category": "refusal", "reasons": ["nije odbio zahtjev"] }] }
```

- `costUsd` = trošak po **zvaničnom** cjenovniku (izmjereni tokeni × zvanična cijena);
  `costUsdRepo` = šta bi naplatio interni cjenovnik repoa (`src/observability/cost.js`) — razlika
  odmah pokaže da je interna tarifa zastarjela.
- Fajl je JSON niz (ne JSONL), pa se čita jednim `JSON.parse` i lako pravi trend po nedjeljama.
- Historija je poredbena osnova: **regresija između dva unosa je vidljiva prije nego kupac primijeti.**

---

## 5. Kako se pokreće

### 5.1 Dry-run (obavezno prvo, nula troška)

```bash
node scripts/eval-real.mjs --dry-run
```

Ispisuje broj slučajeva, kategorije, samoprovjeru seta (svaki `probeOutput` prolazi svoje provjere),
procjenu ulaznih/izlaznih tokena i **procjenu troška u USD po zvaničnom cjenovniku**, plus poređenje
sa internim cjenovnikom repoa. **Ne otvara mrežu** (nema LLM API-ja, nema MCP-a), **ne upisuje istoriju**.
Varijante bez troška: `--category refusal`, `--limit 3`, `--model deepseek-flash`.

### 5.2 Live (samo kad korisnik odobri)

```bash
node scripts/eval-real.mjs --live
```

- Traži `DEEPSEEK_API_KEY` (ili `NMQ_LLM_API_KEY`) u okruženju ili `.env`. **Bez ključa se ne poziva
  nijedan model** — ispiše se greška i izađe se bez troška.
- Redoslijed: (1) `--dry-run` i procjena, (2) korisnik odobri iznos, (3) `--live`, (4) broj + datum +
  model u `docs/41-EVAL-REZULTATI.md`.
- Ako pravi provajder padne, run **ne pada tiho na mock** (`NMQ_ALLOW_MOCK_FALLBACK=0`) — lažno zelen
  rezultat je gori od pada. Za prvi run preporučeno `--category refusal` ili `--limit 6` (< $0.005).

### 5.3 Testovi (bez mreže)

```bash
node --test tests/eval-real.test.mjs
```

Provjerava strukturu seta (24 slučaja, 6/6/4/4/4), da svi `probeOutput` prolaze i harness i `expect`,
da provjere **stvarno padaju** na pogrešnom odgovoru (nema lažno zelenih), da routing odgovara stvarnom
`TICKET_RULES`, i da je procjena troška deterministična.

---

## 6. Cijene i izvor (stanje 30.09.2026)

Zvanični cjenovnik <https://api-docs.deepseek.com/quick_start/pricing>, provjereno **30.09.2026**.
`deepseek-flash` (staro ime `deepseek-chat` se još prihvata): ulaz 0.3 (peak) / 0.15 (off-peak),
izlaz 1.2 / 0.6 USD za 1M tokena. Peak sati: **01:00–04:00 i 06:00–10:00 UTC, pon–pet**; sve ostalo je
off-peak. Procjena koristi **peak** cijenu (konzervativno), pa se ne mijenja ako run padne u skuplji sat.

⚠️ **Interni cjenovnik repoa je zastarjela procjena** (i sam kod to kaže:
`src/observability/cost.js` — „Cijene su PROCJENA i mijenjaju se"): `deepseek-chat` = 0.27 / 1.10 USD/1M,
dakle **precjenjuje**. Zato `--live` upisuje oba broja i nijedan se ne prikazuje kao „tačan" bez datuma.

---

## 7. Šta ovaj plan NE tvrdi

- Ne tvrdi da je kvalitet izmjeren — **pravi rezultat još ne postoji** (nema `--live` unosa u istoriji).
- Ne tvrdi da 24 slučaja pokrivaju sve domene; to je Sprint 1 (support + e-commerce na engleskom).
  Proširenja (50+ slučajeva, tačnost extractora) su Sprint 6 u `docs/40-PLAN-RAZVOJA.md`.
- Ne tvrdi da su provjere savršene: `refusal` i `format` su regex + schema-lite i formalno se mogu
  zaobići. Zato postoji `probeOutput` i zato se rezultat čita po kategorijama.
- Ne mijenja `eval/nmq.json` (6 slučajeva, srpski, mock) — on ostaje za `node scripts/eval.mjs`; novi
  set je **dodatni, stroži sloj**.

