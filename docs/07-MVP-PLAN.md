# 07 — MVP plan (12 nedjelja)

> Realno stanje: **Nedjelja 0 je završena** — skeleton, ugovor, dokumentacija (00–11), 70 testova, demo i smoke prolaze.
> Plan ispod je ono što ostaje do prvog plaćenog klijenta. Faze imaju **dokaz da su gotove**, ne samo listu zadataka.

---

## 0. Stanje poslije nedjelje 0 (v0.1.0)

| Gotovo | Dokaz |
|---|---|
| Gateway (REST + SSE + webhook), widget, demo stranica | `node scripts/smoke.mjs` → 13/13 |
| 6 orchestration patterna + ruter bez LLM-a | `node --test` → 70/70, `node scripts/demo.mjs` |
| 13 agenata (podaci), 21 ugrađen alat, MCP stdio klijent + šablon servera | `node src/cli.js agents`, `tools`, `GET /v1/mcp` |
| Memorija: sesija, istorija/facts, RAG sa citatima, izolacija tenanta | `tests/memory.test.mjs` |
| Governance: politike, budžet, odobrenja, PII redakcija | `tests/policy.test.mjs`, `tests/patterns.test.mjs` |
| Observability: trace, metrike, trošak, hash-chained audit | `tests/observability.test.mjs`, `node src/cli.js audit-verify` |
| Dokumentacija 00–11 + DECISIONS | `docs/` |

**Nije gotovo:** pravi LLM u produkciji (samo adapter i mock), dashboard, alerti, e2e test widgeta u browseru, prave integracije (Gmail/Slack/Shopify), Postgres/Redis, MFA/SSO.

---

## 1. Faze

### Faza 1 (nedjelja 1–2) — „Radi na pravom modelu i pravom klijentu"

| | |
|---|---|
| **Gradimo** | Uključivanje DeepSeek modela u produkciji; tuning promptova za 1 vertikalu (e-commerce support); `kb_ingest` stvarnih dokumenata klijenta; Playwright e2e za widget (bez keša, sa `?v=`) |
| **Deliverables** | `robot.<domena>` sa pravim modelom, KB klijenta (politika povraćaja, dostava, FAQ), e2e izvještaj (screenshot + 0 JS grešaka) |
| **Rizici** | Halucinacije u support odgovorima → mitigacija: obavezno citiranje + „nemam u dokumentaciji" pravilo; latencija > 8s → keš odgovora i manji model za rutiranje |
| **Dokaz da je gotovo** | 20 stvarnih upita klijenta: ≥ 80% tačnih uz citat, p95 < 8s, trošak < 0,02 USD/upit |

### Faza 2 (nedjelja 3–4) — „Integracije koje klijent stvarno koristi"

| | |
|---|---|
| **Gradimo** | Talas 1 MCP servera u mjeri u kojoj klijent koristi: Gmail (čitanje/odgovor), Shopify ili WooCommerce (status narudžbine), Slack ili mejl notifikacije, HubSpot/Pipedrive ako postoji CRM |
| **Deliverables** | 3–4 žive integracije po tenantu, MCP liste u `GET /v1/mcp`, dokumentovan OAuth tok po tenantu, tajne u AES-256-GCM + refresh sa lock-om |
| **Rizici** | OAuth kvote i promjene API-ja; token istekne u toku run-a → mitigacija: refresh sa skew-om 2 min, kill switch, fallback na interni alat (npr. outbox) |
| **Dokaz da je gotovo** | Pravi mejl/narudžbina iz klijentovog sistema prođe kroz robota i vrati se akcijom (odgovor, note u CRM, promjena statusa) — uz audit zapis |

### Faza 3 (nedjelja 5–6) — „Operacije: dashboard, alerti, odobrenja"

| | |
|---|---|
| **Gradimo** | Mali dashboard (`/admin`): runovi, greške, p95, trošak po tenantu, top alati, **odobrenja koja čekaju**; `infra/alerts.yml` (Prometheus) + notifikacija na Slack/mejl; stranica za odobravanje sa jednim klikom |
| **Deliverables** | Dashboard u produkciji, 5 alerta aktivnih, tok odobrenja koji ne zahtijeva curl |
| **Rizici** | Dashboard postane trošak održavanja → mitigacija: server-rendered HTML, bez frameworka; alerti koji šumе → mitigacija: pragovi iz `06` §8 |
| **Dokaz da je gotovo** | Bez curl-a: klijentov operater odobri akciju iz pretraživača; alert za potrošnju > 80% se pojavi u Slacku |

### Faza 4 (nedjelja 7–8) — „Kvalitet: eval, feedback, učenje"

| | |
|---|---|
| **Gradimo** | `eval/` zlatni set (30–50 pitanja po klijentu + očekivani ishod), automatska ocjena pri svakoj izmjeni prompta; iskorišćenje `feedback` (👍/👎) i `policy_denials` za prijedloge izmjena; auto-prijedlog dopune KB iz riješenih ticketa (uz odobrenje) |
| **Deliverables** | `npm run eval` izvještaj (tačnost, citiranost, trošak), CI koji pada ako tačnost opadne > 5% |
| **Rizici** | Zlatni set zastari → mitigacija: dopuna iz stvarnih upita mjesečno; ocjena bez ljudske provjere → mitigacija: 20% uzorak ručno |
| **Dokaz da je gotovo** | Izmjena prompta koja pokvari kvalitet **ne prođe** CI; izvještaj pokazuje trend kroz 4 nedjelje |

### Faza 5 (nedjelja 9–10) — „Druga vertikala i white-label osnova"

| | |
|---|---|
| **Gradimo** | Druga vertikala (agencije/servisne firme: ponude, onboarding, izvještaji) kroz `patternConfig` + nove agente; više tenanta po klijentu (pod-tenanti za agencije), brend widgeta (boja, naslov, domen) |
| **Deliverables** | 2 vertikale u produkciji, 1 agencijski tenant koji servisira svoje klijente |
| **Rizici** | Rasipanje fokusa → mitigacija: pravilo „max 2 vertikale"; pod-tenanti komplikuju izolaciju → mitigacija: eksplicitni testovi izolacije prije puštanja |
| **Dokaz da je gotovo** | Novi klijent se uvede **bez izmjene koda** (samo JSON + KB + ključ) u < 1 dan |

### Faza 6 (nedjelja 11–12) — „Skaliranje i prvi enterprise razgovor"

| | |
|---|---|
| **Gradimo** | PostgreSQL + pgvector + Redis kroz postojeće interfejse (bez izmjene agenata), queue za duge zadatke, backup/restore test, SLO izvještaj (p95, greške, dostupnost), sigurnosni paket dokumenata (DPA, ROPA, politika pristupa, incident plan) |
| **Deliverables** | Migracija odrađena i dokazana (isti testovi prolaze na Postgresu), test restore iz backup-a, SLO izvještaj za mjesec |
| **Rizici** | Migracija razbije izolaciju → mitigacija: isti testovi izolacije + RLS `FORCE`; cijena infra skoči → mitigacija: VPS od ~50 EUR pokriva 1 Starter klijenta (vidi `09` §4) |
| **Dokaz da je gotovo** | Restore iz backup-a vraća sistem u < 30 min; svi testovi prolaze na Postgresu; enterprise upitnik popunjen dokumentima koje već imamo |

---

## 2. Nedjeljni ritam

| Dan | Šta se radi |
|---|---|
| Ponedjeljak | izbor 1–2 zadatka iz faze + definisan **dokaz** da su gotovi |
| Srijeda | provjera sa klijentom (5 min): da li ide u pravom smjeru |
| Četvrtak | integracije i „prljavi" rad (OAuth, deploy, podaci klijenta) |
| Petak | demo + `node --test` + `scripts/smoke.mjs` + `audit-verify`; zapis u `CHANGELOG` |
| Svaki dan | 15 min: pogledati `GET /v1/usage` i `nmq_approvals_pending` |

---

## 3. Rizici plana i mitigacije

| Rizik | Vjerovatnoća | Uticaj | Mitigacija |
|---|---|---|---|
| Scope se širi (20 integracija) | visoka | visok | tvrdo pravilo: **max 2 vertikale i max 4 integracije do prvog plaćenog klijenta** |
| Prvi klijent ne vidi vrijednost | srednja | visok | mjesečni izvještaj koji robot sam generiše (ušteđeni sati, % riješenih bez čovjeka) |
| Trošak modela pojede maržu | srednja | visok | `budget` u kodu + `maxToolRepeats` + keš; cijena = 3–4x trošak modela |
| Prompt injection kroz mejl/dokument | srednja | visok | pravilo „podatak ≠ instrukcija", allowlist alata po izvoru, odobrenje za `high` |
| Solo izgori | srednja | visok | faze sa dokazima, petak demo, nedjelja bez produkcijskih izmjena |
| Zakasnjela odobrenja blokiraju klijenta | srednja | srednji | eskalacija poslije 24h + mogućnost „odobri unaprijed do iznosa X" |
| Postgres migracija kasni | niska | srednji | MVP radi na fajlovima; interfejsi su isti, migracija ne dira agente |

---

## 4. „Kill criteria" — kada stati i pivotirati

1. Poslije 10 pilot razgovora nijedan klijent ne pristaje na plaćeni pilot → problem je vrijednost, ne tehnika; pivot na vertikalu gdje je bol (vidi `10` §7).
2. Tačnost na zlatnom setu < 70% i ne raste 3 nedjelje → problem je KB ili prompt; prekidamo dodavanje funkcija dok se ne popravi.
3. Trošak modela po riješenom zahtjevu > 0,05 USD uz cijenu koju klijent prihvata → mijenjamo model (manji) ili sužavamo obim.
4. Više od 30% odgovora završi na ljudskoj eskalaciji → robot nije spreman za tu vertikalu.

---

## 5. Prvi zadatak poslije ovog dokumenta

**Faza 1, zadatak 1:** uključiti pravi model i izmjeriti 20 upita na KB jednog klijenta.

```bash
cp .env.example .env      # NMQ_LLM_API_KEY (iz DSH store-a), NMQ_LLM_MODEL=deepseek-chat
node scripts/serve.mjs
# ubaci KB klijenta
curl -X POST localhost:8787/v1/kb -H "content-type: application/json" \
  -d '{"text":"<tekst politike>","source":"Politika povraćaja"}'
# izmjeri
curl localhost:8787/v1/usage
```

---

## Otvorena pitanja

1. Koji klijent je prvi pilot (ime) i koja je njegova KB spremna za ingest?
2. Idemo li na dashboard u fazi 3 ili ga zamjenjujemo curl + Slack notifikacijama?
3. Koliko pitanja ulazi u zlatni set po klijentu (predlog: 30)?
4. Da li CI ide na GitHub Actions ili na lokalni `node --test` + restic provjera?
5. Prelazak na Postgres u fazi 6 ili odmah nakon prvog plaćenog klijenta?
6. Ko piše sigurnosna dokumenta (DPA, ROPA) — mi ili advokat, i u kojoj fazi?
