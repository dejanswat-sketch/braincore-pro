# 19 — MAX plan (16 nedjelja): od v0.2 do enterprise spremnosti

> **Svrha:** prevesti v0.2 (radi, dokazano testovima) u stanje u kojem **jedan plaćeni pilot radi na pravoj
> vertikali**, **integracije su prave a ne primjer**, **operacije se vide na dashboardu**, **podaci su u
> Postgresu**, **deploy je u klasteru sa telemetrijom**, i **postoji sigurnosni paket** za prvi enterprise
> razgovor. Ovaj plan se **nastavlja** na `docs/07-MVP-PLAN.md` (12 nedjelja, faze 1–6) — ne poništava ga.
>
> **Realnost prije plana:** ovo je plan za **jednu do dvije osobe**. Sve što traži treću osobu, advokata,
> pen-testera ili sertifikacijsko tijelo je u §3 **označeno** i **nije** na kritičnom putu 16 nedjelja.
> Svaka faza ima **mjerljiv dokaz** — faza bez dokaza nije završena, bez obzira na utrošeno vrijeme.
>
> **Ugovor:** `docs/DECISIONS.md` (§1 LOCKED odluke, §4 Definition of Done, §5 zamke, §6 putanje, §7 stanje).
> Vrijednosti (cijene, verzije, rokovi) su **procjena** — svaka ima napisan **način provjere**.
> U dokument ne idu **vrijednosti** ključeva, samo **imena** env varijabli.

---

## 0. Stanje poslije v0.2

**Provjereno na kodu** (`node --test` = **106/106 prolazi**, `node src/cli.js agents` = **19**, `tools` = **20**,
`PATTERNS` u `src/orchestration/index.js` = **11**, `package.json dependencies: {}`).

| Sposobnost | Stanje | Gdje je dokaz |
|---|---|---|
| **106 testova** (`node --test`, bez zavisnosti, bez interneta) | ✅ | `tests/*.test.mjs` (8 fajlova, `max.test.mjs` najveći) |
| **19 agenata definisanih podacima** (`config/agents/*.json`) | ✅ | `node src/cli.js agents`; novi agent = novi JSON, bez koda |
| **11 patterna/ulaza** (`agent`, `react`, `router`, `sequential`, `orchestrator-worker`, `fanout`, `handoff`, `magentic`, `reflection`, `debate`, `team`) | ✅ | `PATTERNS` u `src/orchestration/index.js`, `GET /v1/patterns`, `tests/patterns.test.mjs` |
| **20 ugrađenih alata** (`low`/`medium`/`high` rizik) | ✅ | `node src/cli.js tools`; `src/tools/builtin.js` |
| **Scheduler** (interval/cron/event/dugoročni `process`, leasing, retry, checkpoint) | ✅ | `src/scheduler/index.js`, `tests/max.test.mjs` (7 testova) |
| **Control plane** (verzije agenta, deploy/rollback, pause/retire, per-agent ključ, per-agent budžet) | ✅ | `src/controlplane/registry.js`, `GET /v1/admin/*` |
| **Sandbox** (nivoi, mrežna allowlista, putanje, env allowlista, MCP podproces bez tajni hosta) | ✅ | `src/core/sandbox.js`, `tests/max.test.mjs` (4 testa) |
| **OTel izvoz** (OTLP/JSON `resourceSpans`, fajl ILI HTTP, greška ne ruši run) | ✅ | `src/observability/otel.js`, `tests/max.test.mjs` (3 testa) |
| **Epizodična memorija** (problem → koraci → rješenje → pouka, few-shot, `episode_record`) | ✅ | `src/memory/episodic.js`, `tests/max.test.mjs` (3 testa) |
| **Observability jezgro** (trace, 39 metrika, cost, hash-chained audit, tajne AES-256-GCM) | ✅ | `src/observability/*`, `GET /metrics`, `GET /v1/audit`, `tests/observability.test.mjs` |
| **Gateway** (REST + SSE + webhook + widget, 13/13 smoke) | ✅ | `scripts/smoke.mjs`, `public/widget/nmq-robot.js` |
| **MCP klijent** (stdio + Streamable HTTP) i interni šablon server | ✅ | `src/tools/mcp-*.js`, `mcp/example-server.mjs` |

**Šta NIJE gotovo (i to je sadržaj ovih 16 nedjelja):**

| Rupa | Zašto je blokada |
|---|---|
| **Pravi LLM u produkciji nije izmjeren** — radi adapter, ali nema podataka sa pravog modela na pravoj KB | Bez toga ne znamo kvalitet, latenciju ni trošak; sve ostalo je optimizacija naslijepo |
| **Nema eval harness-a** (zlatni set + automatska ocjena) | Svaka izmjena prompta je nagađanje; regresija kvaliteta se ne vidi |
| **Nema pravih MCP integracija** (Gmail, Shopify, Slack, CRM) | Robot radi samo na internim fajlovima; klijent ne vidi akciju u **svom** sistemu |
| **Nema OAuth po tenantu** (refresh, revokacija, kvote) | Integracija bez OAuth-a je demo, ne proizvod |
| **Nema dashboarda, alerta ni inbox-a za odobrenja** | `docs/DECISIONS.md` §7: „Dashboard ❌ planirano (faza 3)"; odobrenje se danas daje `curl`-om |
| **Nema Postgres/pgvector/Redis** (JSONL + brute-force cosine) | Nema RLS izolacije na nivou reda, nema queue, nema distributed lock-a → **ne smije se skalirati na više replika** |
| **Nema K8s tenanta po klijentu, NetworkPolicy, HPA, secrets toka** | `infra/k8s/base/` postoji (namespace, deployment, configmap, service), ali **nema** `tenant-template/`, `NetworkPolicy`, `HPA`, `secret.example.yaml` (iako manifesti na njih upućuju) |
| **Nema OTel Collector-a, Tempo-a, Grafane, Prometheus scrape config-a** | Telemetrija se piše u fajl i niko je ne gleda |
| **Nema OIDC/SSO, MFA, enterprise sigurnosnog paketa** (DPA, ROPA, incident plan, pen-test) | Enterprise razgovor se ne može ni započeti |

**Poznata nedosljednost u repou (popraviti u fazi 5):** `infra/k8s/base/configmap.yaml` i `deployment.yaml`
referenciraju fajlove koji **ne postoje**: `infra/k8s/base/secret.example.yaml`, `infra/k8s/tenant-template/`
i `infra/k8s/base/deployment-scheduler.yaml`. To nije greška u funkcionalnosti, ali **jeste** dokaz da
manifesti nisu bili primijenjeni na klaster (niko nije dobio `kubectl apply` grešku) — pa se u fazi 5 prvo
usklađuje repozitorij, pa tek onda deploy. Referenca na `docs/14` u tom istom manifestu je **validna**:
`docs/14-PERSISTENTNI-AGENTI.md` postoji (dokumenti `00`–`19` + `DECISIONS.md` su kompletni).

---

## 1. Faze (nedjelja po nedjelja)

### Faza 1 (nedjelja 1–3) — Prvi plaćeni pilot na pravoj vertikali + eval harness

| | |
|---|---|
| **Gradimo** | (a) Pravi model u produkciji (`NMQ_LLM_PROVIDER=openai-compatible`, `NMQ_LLM_MODEL`, `NMQ_LLM_API_KEY` iz DSH store-a) i `NMQ_LLM_FALLBACKS` sa **jednim** testiranim alternativnim providerom; (b) KB prvog klijenta kroz `POST /v1/kb` (politika povraćaja, dostava, FAQ — 20–40 dokumenata); (c) tuning prompta `support`/`ecommerce` agenta za **jednu** vertikalu (obavezan citat + „nemam u dokumentaciji"); (d) **eval harness**: `eval/golden.jsonl` (30–50 pitanja sa očekivanim ishodom) + `scripts/eval.mjs` koji mjeri tačnost, citiranost, p95 latenciju i trošak po upitu; (e) `tests/eval-regression.test.mjs` koji puca ako tačnost padne > 5% |
| **Deliverables** | `robot.<domena>` dostupan klijentu; izvještaj `eval/report-<datum>.md` (tačnost, citat %, p95, USD/upit); **zapis u `docs/18` §10** (dnevni/nedjeljni ritam) sa prvim stvarnim brojevima; baseline izmjeren **prije** tuninga |
| **Rizici i mitigacija** | *Halucinacija u support odgovoru* → obavezan citat + pravilo „ako nema u KB, reci nemam"; `critic` za `legal`/`finance` domene. *Latencija > 8 s* → keš (`nmq_llm_cache_hits_total`), manji model za rutiranje, kraći kontekst (top-k 3–5 umjesto 8). *Cijena po upitu iznad plana* → `NMQ_BUDGET_RUN_USD`, mjerenje `usd/upit` u evalom izvještaju. *Zlatni set pristrasan* → 30% pitanja iz **stvarnih** upita klijenta, 20% uzorak ručno ocjenjen |
| **Dokaz da je gotovo (mjerljivo)** | 20 stvarnih upita klijenta kroz živi sistem: **≥ 80% tačnih sa citatom**, **p95 < 8 s**, **< 0,02 USD/upit** (procjena granice — potvrditi sa stvarnim cijenama providera), **0** prijavljenih „izmislio je" slučajeva u nedjelji; `npm run eval` daje izvještaj i **regresija > 5% obara test** |

### Faza 2 (nedjelja 4–6) — 3–4 prave MCP integracije + OAuth po tenantu

| | |
|---|---|
| **Gradimo** | Talas 1 integracija, **samo ono što klijent koristi**: **Gmail** (čitanje + odgovor u istom thread-u), **Shopify** ili **WooCommerce** (status narudžbine, refund), **Slack** (notifikacija + Approve/Reject dugmad), **CRM** (HubSpot/Pipedrive — kontakt, deal, note). Za svaku: MCP server kroz `src/tools/mcp-client.js` (`stdio` **ili** Streamable HTTP), **OAuth po tenantu** sa refresh-om (skew 2 min), revokacijom i kill switch-om; tajne u `data/tenants/<id>/secrets/secrets.enc.json` (AES-256-GCM); allowlist po tenantu (`config/tools.json`), `riskLevel` po alatu (`email_send`, `invoice_create` → `high` → odobrenje) |
| **Deliverables** | 4 MCP servera vidljiva u `GET /v1/mcp` sa brojem alata; dokumentovan OAuth tok po tenantu (koji scope, gdje se čuva refresh token, kako se revokuje); `docs/03-MCP-INTEGRACIJE.md` ažuriran stvarnim stanjem; integracioni test protiv **sandbox** naloga klijenta (bez PII u testnim podacima) |
| **Rizici i mitigacija** | *OAuth kvote i promjene API-ja* → pinovana verzija servera, hash tool sheme, alert na promjenu sheme, fallback na interni alat (`outbox`). *Token istekne u toku runa* → refresh sa skew-om, retry jednom, jasna poruka korisniku (ne tiha greška). *Integracija radi na testnom nalogu a ne na klijentovom* → dokaz je akcija u **klijentovom** sistemu (mejl poslan, nota u CRM, status narudžbine promijenjen). *Prompt injection kroz mejl* → pravilo „podatak ≠ instrukcija", allowlist alata po izvoru, obavezan audit svakog poziva. *Scope creep na 10 integracija* → tvrdo pravilo: **max 4 do kraja faze**, peta samo ako je plati klijent |
| **Dokaz da je gotovo (mjerljivo)** | Za svaku od 4 integracije: **jedan stvarni događaj** iz klijentovog sistema prođe kroz robota i vrati se **akcijom** (odgovor na mejl, nota u CRM, promjena statusa narudžbine) — uz **audit zapis** (`action: tool_call`) i **jedan test** koji to ponavlja u CI-ju protiv sandbox naloga; revokacija OAuth pristupa se dokaže (nakon revokacije alat vraća jasnu grešku, ne pada cijeli run) |

### Faza 3 (nedjelja 7–9) — Dashboard + alerti + inbox za odobrenja

| | |
|---|---|
| **Gradimo** | (a) **Dashboard** (`/admin`, server-rendered HTML + `fetch` na `/metrics`, bez frameworka i bez build koraka): 4 stranice iz `docs/18` §6 (operativni, trošak/naplata, agenti, sigurnost); (b) **`infra/alerts.yml`** — minimum 10 alerta iz `docs/18` §5, koji prolaze `promtool check rules` u CI-ju; (c) **metrike koje fale** (`docs/18` §4.4): `nmq_cost_usd_total`, `nmq_pricing_missing_total`, `nmq_approvals_pending`, `nmq_approval_wait_seconds`, `nmq_budget_used_ratio`, `nmq_jobs_overdue`, `nmq_otel_export_total`, `nmq_errors_total`, `nmq_build_info`; (d) **Prometheus scrape + Alertmanager** (Slack `#nmq-alerts`, mejl approverima); (e) **inbox za odobrenja** — stranica sa listom `GET /v1/approvals`, detaljem (agent, alat, redigovani argumenti, iznos, rok) i dugmićima Approve/Reject koji pozivaju `POST /v1/approvals/:runId` (scope `approve`); (f) **tracing odobrenja u trace zapis** (`approvals[]`, `waitMs`) — popraviti rupu #1 iz `docs/18` §2.3; (g) `data/_global/pricing.json` + `pricingVersion`/`checkedAt`/`sourceUrl` |
| **Deliverables** | Dashboard u produkciji (dostupan samo admin/operator rolama); 10+ aktivnih alerta sa **testiranim** putem do Slacka (vještački izazvan alert u testnom okruženju); tok odobrenja koji **ne zahtijeva `curl`**; tabela cijena van koda, sa datumom provjere |
| **Rizici i mitigacija** | *Dashboard postane trošak održavanja* → server-rendered HTML, jedan fajl po stranici, bez npm paketa (D2). *Alerti šume* → pragovi i `for:` iz `docs/18` §5, dedup 1× u 15 min, mjesečna provjera false-positive (cilj < 20%). *Alerti nad metrikama koje ne postoje* → prvo metrike, pa alerti (redoslijed je obavezan). *Odobrenje odobreno dvaput* → idempotencija po `approvalId`/`runId`. *Tajne u dashboardu* → dashboard nikad ne prikazuje vrijednost ključa, samo ime providera (`GET /v1/tenants/:id/secrets`) |
| **Dokaz da je gotovo (mjerljivo)** | Klijentov operater **bez `curl`-a i bez naše pomoći** odobri `high` akciju iz pretraživača; alert za potrošnju ≥ 80% budžeta se **pojavi u Slacku** u testu; `promtool check rules infra/alerts.yml` prolazi; `GET /metrics` sadrži **sve** metrike iz `docs/18` §4.4 (test koji provjerava imena) |

### Faza 4 (nedjelja 10–12) — Postgres + pgvector + Redis + distributed lock + queue

| | |
|---|---|
| **Gradimo** | (a) **Postgres 16 + pgvector** kroz postojeće interfejse (`VectorStore`, memory, session, longterm, audit, cost) — **bez izmjene agenata** (D9); tabele po kanonskoj šemi iz `docs/02` §4.2 (`spans`, `traces`, `events`, `cost_ledger`, `audit_log` + `approvals`, `facts`, `policy_denials`), **RLS `FORCE`** po `tenant_id` za svaku tabelu; `audit_log` bez `UPDATE`/`DELETE` + trigger; (b) **Redis** za: sesije (hot cache), rate limit (atomični `INCR`+`EXPIRE` umjesto in-memory mape), **queue** za duge zadatke i **distributed lock**; (c) **distributed lock** zamjenjuje današnji `lease` u fajlu (`src/scheduler/store.js`) — scheduler smije raditi u **N replika**; (d) **migracije** (`infra/sql/001_init.sql`, `002_rls.sql`, …) sa `schema_migrations` tabelom i **idempotentnim** primjenjivanjem; (e) **backup/restore test** (`pg_dump` + restore u praznu bazu) sa zapisom u `docs/compliance/RESTORE-TESTS.md` |
| **Deliverables** | **Isti test set prolazi na Postgresu** (dokaz da interfejs nije pukao); `docker compose --profile data up -d` diže cijeli stack; test izolacije: pokušaj čitanja tuđeg tenanta kroz SQL **pada** (RLS); test distributed lock-a: dvije instance, isti posao se izvršava **jednom**; restore iz backup-a vraća sistem sa istim brojem zapisa; mjerenje: `vector.query` latencija prije/poslije pgvector indeksa |
| **Rizici i mitigacija** | *Migracija razbije izolaciju* → RLS `FORCE` + isti testovi izolacije kao na fajlovima + test koji **namjerno** probija tenant. *Distributed lock bugovi* (deadlock, dupli posao, „zaključan zauvek") → lock **uvijek** sa TTL-om i `owner` tokenom, refresh samo od vlasnika, `SET NX PX` + Lua release (release samo ako je token isti), chaos test: ubij instancu usred posla i provjeri da se posao preuzme poslije TTL-a. *Redis pad* → degradirani režim (rate limit u memoriji po instanci, queue pauzira, **nema gubitka** poslova jer stanje ostaje u `jobs.json`/Postgresu). *Dvostruko pisanje (JSONL + Postgres)* → prelazni period **zabranjen**: bira se jedan izvor po tipu podatka, sa `read` prekidačem po tenantu. *Cijena i operativni teret* → jedan VPS sa Postgresom je dovoljan za prve klijente (procjena: pokriva ga jedan Starter, `docs/09` §4) |
| **Dokaz da je gotovo (mjerljivo)** | `node --test` **isti broj testova prolazi** u dva režima (fajl i Postgres) — parametrizovano env varijablom; **restore iz backup-a u < 30 min** (mjereno, zapisano); dvije instance schedulera ne izvrše isti posao dvaput u **1000** uzastopnih tickova; `EXPLAIN` pokazuje da `vector.query` koristi pgvector indeks (ne sekvencijalni scan) na 10.000 vektora |

### Faza 5 (nedjelja 13–14) — K8s (namespace po tenantu, NetworkPolicy, HPA, secrets) + OTel Collector/Tempo/Grafana

| | |
|---|---|
| **Gradimo** | (a) Usklađivanje `infra/k8s/`: `tenant-template/` (namespace po klijentu, `ResourceQuota`, `LimitRange`, `NetworkPolicy` default-deny + dozvola samo na `nmq-system` i DNS), `secret.example.yaml` (struktura, **bez vrijednosti**), `deployment-scheduler.yaml` (1 replika, odvojeno od API-ja), `HPA` (CPU + custom metrika iz `nmq_jobs_active`); (b) **secrets tok**: `ExternalSecret` (već u `configmap.yaml`) ili `SealedSecret` — nikad tajna u git-u i nikad u `ConfigMap`; (c) **OTel Collector + Tempo + Grafana + Prometheus** po `docs/18` §3.3 (Collector varijanta A: prima OTLP na `4318`); (d) `ServiceMonitor`/scrape config za `GET /metrics`; (e) NetworkPolicy koja **dozvoljava** Collector-u ingress na `8787`, a svima ostalima ne; (f) `kubectl` runbook: kako se dodaje tenant, kako se rotira tajna, kako se rollback-uje deployment |
| **Deliverables** | Klaster sa **2 tenanta** (jedan stvarni, jedan testni) u odvojenim namespace-ima; trace iz jednog stvarnog runa **vidljiv u Grafani kroz Tempo**; Grafana dashboardi iz `docs/18` §6 rade protiv stvarnih metrika; NetworkPolicy dokazana (test: `curl` iz tuđeg namespace-a na `nmq-robot` **ne prolazi**); HPA skalira na 2 replike pod opterećenjem i vraća na 1; `kubectl describe` pokazuje `readOnlyRootFilesystem: true`, `runAsNonRoot: true`, `drop ALL` |
| **Rizici i mitigacija** | *K8s trošak i operativni teret* (solo tim održava klaster) → **jedan** mali klaster, `Helm`/`kustomize` nije obavezan, sve u git-u kao manifesti; ako klaster pojede više od X sati mjesečno na održavanje → vratiti se na Docker Compose (odluka se mjeri, ne osjeća). *Multi-replika + scheduler* → scheduler je **odvojen** Deployment sa 1 replikom + distributed lock (faza 4) kao drugi sloj. *Tajne u git-u* → pre-commit provjera (`grep` za obrasce iz `src/core/logger.js`) + `secret.example.yaml` sa **praznim** vrijednostima. *Collector/Tempo pojedu resurse* → resource limits + sampling (npr. 100% greške, 10–20% uspješnih) — **procjena**, mjeri se. *Isti problem kao Hostinger keš* → statika (`/widget.js`) i dalje `no-cache` + `?v=` (D5 u `DECISIONS.md` §5) |
| **Dokaz da je gotovo (mjerljivo)** | Jedan stvarni run se u Grafani vidi kao **waterfall kroz Tempo** (spanovi sa `nmq.*` atributima); **0** tajni u `git log` (provjereno skriptom); tenant A **ne može** doći do tenant B (dokazano mrežnim testom **i** API testom); HPA test zapisan (broj replika prije/poslije); trošak klastera zapisan kao **procjena** sa stvarnim brojem iz providera nakon prvog mjeseca |

### Faza 6 (nedjelja 15–16) — OIDC/SSO + MFA + sigurnosni paket dokumenata + prvi enterprise razgovor

| | |
|---|---|
| **Gradimo** | (a) **OIDC/SSO** (jedan provider: Google Workspace ili Microsoft Entra ID) — `authorization_code` + PKCE, mapiranje `email → tenantId + rola` iz `config/tenants.json`, sesija u potpisanom kolačiću (`HttpOnly`, `Secure`, `SameSite=Lax`); (b) **MFA** za `owner`/`admin` role (TOTP; `otpauth://` bez zavisnosti — HMAC-SHA1 je u `node:crypto`); (c) **sigurnosni paket dokumenata**: DPA (šablon, 3–5 str.), ROPA (tabela iz `docs/18` §9.1), politika pristupa, incident response plan (P0/P1 tokovi iz `docs/18` §5), backup/restore dokaz iz faze 4, „break-glass" uputstvo **van** servera; (d) **prvi enterprise razgovor** sa upitnikom (npr. CAIQ/SIG-lite) i **pisanim** odgovorom „šta imamo / šta nemamo" |
| **Deliverables** | Login kroz SSO radi za oba tenanta; MFA obavezan za admina; `/v1/audit` pokazuje `action: login` sa SSO identitetom; paket dokumenata u `docs/compliance/` (bez izmišljenih sertifikata!); zapis enterprise razgovora sa listom zahtjeva koje **ne** možemo ispuniti danas |
| **Rizici i mitigacija** | *OIDC integracija pojede nedjelje* → **jedan** provider, bez „podržavamo sve"; `redirect_uri` fiksan, state + PKCE obavezni; ako zapne > 5 dana → fallback na postojeće API ključeve i SSO se odgađa (ne blokira isporuku). *Sesija i CSRF* → `SameSite=Lax` + `state`; nikad `SameSite=None` bez potrebe. *Tvrdnje u sigurnosnim dokumentima* → svaka tvrdnja mora imati dokaz (test, log, konfiguracija); **nikad** ne pisati „SOC 2 compliant" ili „pen-tested" bez sertifikata/izvještaja. *Enterprise traži on-prem/SOC 2* → to je **odvojen, plaćen projekat** (`docs/09` §5, `docs/10` §2) — u 16 nedjelja **ne ulazimo** u sertifikaciju, samo u dokumentaciju koju možemo dokazati |
| **Dokaz da je gotovo (mjerljivo)** | **0** tajni i **0** vrijednosti ključeva u `git log` i u izvještajima; SSO login radi za 2 tenanta + MFA izazov za admina (test); paket dokumenata postoji sa **svakom** tvrdnjom vezanom na dokaz (tabela „tvrdnja → dokaz → gdje"); enterprise upitnik popunjen i **nijedan** odgovor nije pretjeran |

---

## 2. Zavisnosti između faza

```
                    ┌──────────────────────────────────────────────┐
   FAZA 1           │ Pravi model + KB klijenta + EVAL HARNESS      │
   (1–3)            └───────────────┬──────────────────────────────┘
                                    │  eval mora postojati PRIJE tuninga prompta
                                    │  (inače ne znamo da li je izmjena poboljšanje)
                                    ▼
                    ┌──────────────────────────────────────────────┐
   FAZA 2           │ 4 prave MCP integracije + OAuth po tenantu   │
   (4–6)            └───────────────┬──────────────────────────────┘
                                    │  integration testovi daju prave greške
                                    │  → pragovi za alerte (faza 3)
                                    ▼
                    ┌──────────────────────────────────────────────┐
   FAZA 3           │ Dashboard + ALERTI + inbox za odobrenja       │
   (7–9)            │ + metrike koje fale + pricing.json            │
                    └───────────────┬──────────────────────────────┘
                                    │  alerti i SLO se mjere nad Postgresom,
                                    │  ali NE ZAVISE od njega → mogu i prije
                                    ▼
                    ┌──────────────────────────────────────────────┐
   FAZA 4           │ Postgres + pgvector + Redis                   │
   (10–12)          │   ├── queue        (traži Redis)              │
                    │   └── DISTRIBUTED LOCK  ← traži Postgres/Redis │
                    └───────────────┬──────────────────────────────┘
                                    │  lock + lease moraju biti riješeni
                                    │  PRIJE više replika (inače dupli poslovi)
                                    ▼
                    ┌──────────────────────────────────────────────┐
   FAZA 5           │ K8s + HPA (više replika) + Collector/Tempo    │
   (13–14)          │ + Grafana                                     │
                    └───────────────┬──────────────────────────────┘
                                    │  enterprise razgovor traži dokaze
                                    │  (backup/restore, izolacija, trace)
                                    ▼
                    ┌──────────────────────────────────────────────┐
   FAZA 6           │ OIDC/SSO + MFA + sigurnosni paket             │
   (15–16)          │ + PRVI ENTERPRISE RAZGOVOR                    │
                    └──────────────────────────────────────────────┘
```

**Tvrde zavisnosti (ne može jedno prije drugog):**

| Ne može prije | Zato što |
|---|---|
| **Postgres prije distributed lock-a** | Lock bez transakcije/atomične operacije je „zaključavanje u fajlu" — ne radi u klasteru. Prvo baza (ili Redis), pa `SET NX PX`/`SELECT … FOR UPDATE`, pa više replika |
| **Distributed lock prije HPA / više replika** | Danas je leasing u `data/tenants/<id>/jobs/jobs.json` — dvije replike bi **duplo izvršile** posao. HPA bez lock-a je mašina za duple refunde i duple mejlove |
| **Eval prije prompt tuninga** | Bez zlatnog seta ne postoji način da se izmjena prompta ocijeni; „osjećam da je bolje" nije dokaz i ne prolazi gate |
| **Prave integracije prije alerta za alate** | Prag za „alat pada 3× zaredom" i za MCP server down nema smisla na mock alatima |
| **Metrike koje fale prije alerta koji ih koriste** | Alert nad nepostojećom metrikom se **nikad** ne pokrene (ili se pokrene kao `absent`) — tiha lažna sigurnost |
| **Backup/restore test prije enterprise razgovora** | Prvo pitanje na enterprise upitniku je RTO/RPO; bez mjerenog restore-a odgovor je nagađanje |
| **OIDC prije enterprise** | Enterprise ne prihvata „dijeljeni API ključ" kao identitet korisnika |
| **Test izolacije na Postgresu prije prelaska tenanta na Postgres** | Cross-tenant curenje je rizik #1 za posao; RLS se dokazuje testom, ne nadom |
| **Sve ostalo prije prvog plaćenog pilota** | Ako faza 1 ne pokaže vrijednost, faze 2–6 su trošak bez prihoda (kill criteria u `docs/10` §5) |

---

## 3. Resursi i realnost

### 3.1 Iskreno: šta jedna osoba može u 16 nedjelja

**Može** (uz pretpostavku ~30–35 h/nedjeljno i **bez** prodajnog tereta preko 20% vremena):

- Faza 1 u cjelini (model, KB, eval, 20 upita) — **jeste** realno u 3 nedjelje ako klijent daje KB i pristup.
- Faza 2 sa **4** integracije — **jeste**, ali samo ako su 3 od 4 „lake" (Gmail, Slack, Shopify).
  **CRM** (HubSpot/Pipedrive) sa pravim OAuth-om i mapiranjem polja je realno **1 dodatna nedjelja**.
- Faza 3 u cjelini — **jeste** uz uslov da se dashboard radi kao server-rendered HTML (bez frameworka),
  a ne „moderna SPA".
- Faza 4 — **jeste**, ali je **najveći tehnički rizik plana**: Postgres + RLS + Redis + lock + migracije
  + backup je 3 nedjelje **samo ako** se radi bez paralelnih feature-a.
- Faza 5 — **djelimično**: manifesti, namespace po tenantu, NetworkPolicy i Collector/Tempo su realni;
  **produkcijski** klaster sa HA, monitoringom klastera i disaster recovery-em **nije** posao za solo
  u 2 nedjelje (to je posao od mjesec i više, ili plaćeni DevOps).
- Faza 6 — **jeste** za OIDC (jedan provider), MFA (TOTP) i **paket dokumenata koji ne tvrdi ništa
  što nemamo**; **nije** za SOC 2, ISO 27001, pen-test ili pravno mišljenje.

**Ne može jedna osoba (i to treba reći naglas):**

| Šta | Zašto | Kada |
|---|---|---|
| **Penetration test** | Traži nezavisnog izvođača; rezultat se ne može sam izdati | Prije prvog enterprise sa bezbednosnim zahtjevima |
| **DPA / ugovor / pravno mišljenje** | Advokat (GDPR, prekogranični prenos, odgovornost za AI izlaz) | **Prije** prvog plaćenog klijenta — nije „poslije" |
| **SOC 2 / ISO 27001** | Sertifikacijsko tijelo, period posmatranja (mjeseci), novac | Ne u ovih 16 nedjelja; ponuditi kao **odvojen plaćen projekat** |
| **24/7 support i on-call** | Jedna osoba ne može biti 24/7; ugovorom **ne** obećavati | Do 3+ klijenta ili do prve plaćene podrške |
| **Prodaja i razvoj istovremeno** | Kontekst se mijenja; oboje trpe | Fiksni prodajni blok u nedjelji (prodaja se ne pomjera) |
| **Druga vertikala** | Fokus; pravilo „max 2 vertikale" | Tek kad prva ima 2+ plaćena klijenta |

### 3.2 Tabela zadataka — ko, koliko, koliko (procjena)

| Zadatak | Ko | Trajanje | Trošak (procjena, sa oznakom) | Kako se provjerava |
|---|---|---|---|---|
| Uključivanje pravog modela + KB + eval harness | 1 dev | 3 nedjelje | **0 EUR** direktno (vlastiti rad) + trošak modela po upitu (**procjena** < 0,02 USD/upit — mjeri eval izvještaj) | `npm run eval` izvještaj sa 20+ upita |
| 4 MCP integracije + OAuth po tenantu | 1 dev | 3 nedjelje | **0 EUR** direktno; klijentovi nalozi (Gmail/Shopify/CRM) — njegov trošak, ne naš | 4 akcije u klijentovom sistemu + CI test protiv sandbox naloga |
| Dashboard (4 stranice, server-rendered) | 1 dev | 1,5 nedjelje | **0 EUR** (bez frameworka, bez licenci) | Dashboard dostupan i korišćen bez `curl`-a |
| Alerti + metrike koje fale + `pricing.json` | 1 dev | 1 nedjelja | **0 EUR** | `promtool check rules` prolazi; test imena metrika |
| Inbox za odobrenja | 1 dev | 0,5 nedjelje | **0 EUR** | Klijentov operater odobri akciju iz pretraživača |
| Postgres + pgvector + Redis + migracije + RLS | 1 dev | 2 nedjelje | VPS resursi (vidi ispod) | Isti test set prolazi na Postgresu; test izolacije |
| Distributed lock + queue | 1 dev | 1 nedjelja | **0 EUR** | Test: 2 instance, 1000 tickova, 1 izvršenje |
| Kubernetes osnove (namespace po tenantu, NetworkPolicy, secrets, HPA) | 1 dev | 2 nedjelje | Klaster (vidi ispod) | NetworkPolicy test + HPA test |
| OTel Collector + Tempo + Grafana + Collector config | 1 dev | 0,5–1 nedjelja | Resursi na istom VPS-u (**procjena** 1–2 GB RAM — mjeri se `docker stats`) | Trace jednog runa vidljiv u Grafani |
| OIDC/SSO (1 provider) + TOTP MFA | 1 dev | 1 nedjelja | **0 EUR** (bez zavisnosti; TOTP u `node:crypto`) | SSO login + MFA izazov u testu |
| Sigurnosni paket (DPA šablon, ROPA, incident plan, pristup) | 1 dev (draft) | 1 nedjelja | **0 EUR** za draft; **advokat za pregled** — vidi ispod | Svaka tvrdnja u dokumentu ima dokaz |
| Break-glass runbook + test restore | 1 dev | 2 dana | **0 EUR** | Restore mjeren i zapisan (< 30 min) |
| **Advokat: DPA + ugovor + GDPR osnova** | advokat | 1–2 nedjelje (paralelno) | **procjena 500–2.000 EUR** (zavisi od obima i tržišta) — **provjeriti sa 2 ponude**, ne vjerovati procjeni | Potpisan/pregledan DPA **prije** prvog plaćenog klijenta |
| **Penetration test (web + API)** | vanjski izvođač | 1–2 nedjelje (paralelno) | **procjena 1.500–6.000 EUR** — **provjeriti ponude** (obim: 1 API, 1 widget, 1 klaster) | Izvještaj sa nalazima; kritični nalazi popravljeni prije enterprise potpisa |
| **SOC 2 Type I / ISO 27001 priprema** | vanjski konsultant + mi | **mjeseci** | **procjena 10.000+ EUR** — **provjeriti**; **NIJE** u 16 nedjelja | Sertifikat/izvještaj postoji ili se ne tvrdi |
| **Infrastruktura: mali VPS (Hetzner, EU)** | mi | trajno | **procjena 5–50 EUR/mj.** zavisno od veličine (postojeći `nmq-server` pokriva početak) — **provjeriti aktuelni cjenovnik Hetznera** | `docker stats` + faktura providera nakon prvog mjeseca |
| **Kubernetes klaster (managed ili 3× VPS)** | mi | trajno | **procjena 30–150 EUR/mj.** za mali klaster (control plane + 2–3 radnika) — **provjeriti cjenovnik**; alternativa: `k3s` na 1–2 VPS-a (jeftinije, više našeg rada) | Faktura providera + sati održavanja mjesečno |
| **Monitoring stack (Prometheus/Tempo/Grafana)** | mi | trajno | **0 EUR** za softver (sve open source), **resursi** dijele VPS (procjena 1–2 GB RAM) | `docker stats`; ako pređe limit → izdvojiti na drugi host |
| **Domene i TLS** | mi | trajno | **procjena 10–20 EUR/god.** po domeni + TLS besplatno (Let's Encrypt) — **provjeriti** kod registrara | Faktura registrara |
| **E-pošta/Slack za alerting** | mi | trajno | **0 EUR** (Slack free tier / postojeći mejl) — provjeriti limite | Alert test |

> **Pravilo o troškovima:** nijedan broj iz ove tabele **nije** ponuda i **nije** cjenovnik. Svaki se
> provjerava **prije** obaveze: cijene modela kod providera (`docs/06` §4.1), cijene hostinga iz aktuelnog
> cjenovnika, cijene pravnih/bezbjednosnih usluga iz **najmanje dvije ponude**. U dokumentima i ponudama
> klijentu uvijek stoji oznaka **„procjena"** + datum provjere.

---

## 4. Kontrolne tačke (gate)

Na kraju **svake** faze pitanje je isto: **„idemo dalje ili popravljamo?"** Odluka se donosi po **tri uslova**.
Ako **dva od tri** nisu ispunjena → **ne idemo dalje**; prva nedjelja sljedeće faze se troši na popravku.

| Faza | Uslov 1 — Dokaz radi | Uslov 2 — Klijent/vrijednost | Uslov 3 — Ekonomija i rizik |
|---|---|---|---|
| **1** | 20 stvarnih upita: ≥ 80% tačnih sa citatom, p95 < 8 s, 0 „izmislio je" | Klijent **koristi** robota (≥ 70% očekivanog volumena) i kontakt osoba odgovara u 3 dana | USD/upit unutar plana (< procjena 0,02); `docs/10` kill criteria nisu probijeni |
| **2** | 4 integracije rade u **klijentovom** sistemu, sa audit zapisom i CI testom | Klijent potvrđuje da akcija **rješava** posao koji je prije radio čovjek | OAuth kvote nisu probijene 2 nedjelje; nijedna integracija nije „na granici" (nema dnevnih ručnih intervencija) |
| **3** | Dashboard + 10 alerta + inbox rade bez `curl`-a | Operater klijenta **sam** odobri `high` akciju; nijedno odobrenje ne čeka > 24 h | False-positive alerta < 20%; trošak modela < 15% prihoda |
| **4** | Isti test set prolazi na Postgresu; restore < 30 min; lock test (2 instance, 1 izvršenje) | Nema novih grešaka vidljivih klijentu u 2 nedjelje poslije migracije | Mjesečni trošak infra unutar plana; nema „dvojnog pisanja" duže od prelaznog perioda |
| **5** | Trace u Grafani; NetworkPolicy dokazana; HPA radi; 0 tajni u gitu | Ista dostupnost i latencija kao prije K8s-a (bez regresije u SLO) | **Sati održavanja klastera mjereni**: ako > dogovoreni limit/nedjeljno → vraćanje na Compose je legitimna odluka |
| **6** | SSO + MFA rade; paket dokumenata sa vezom „tvrdnja → dokaz" | Enterprise sagovornik **nije** odbio zbog nedostatka dokumentacije | Nijedna tvrdnja bez dokaza; nijedan sertifikat se ne pominje kao postojeći |

**Pravilo za gate:** odluka se **zapisuje** (datum, tri uslova, odluka „idemo/popravljamo", ko je odlučio).
Bez zapisa, gate je formalnost — a formalnost se preskoči čim se pojavi pritisak.

---

## 5. Rizici MAX nivoa

| Rizik | Signal ranog upozorenja | Mitigacija |
|---|---|---|
| **Prekompleksnost** (16 nedjelja, 6 faza, sve odjednom) | Faza traje duže od plana 2 nedjelje; `TODO`/`FIXME` raste; nijedan dokaz nije zapisan; „još samo da refaktorišem" | **Jedan cilj po nedjelji**; gate na kraju svake faze; ako faza kasni > 1 nedjelju → **sječe se obim**, ne produžava rok; lista „NAMJERNO ne radimo" (§6) je štit |
| **K8s trošak i operativni teret** | Nedjeljno održavanje klastera > 2 h; `kubectl` problemi koji ne donose vrijednost klijentu; faktura klastera raste bez novog klijenta | Faza 5 ide **poslije** Postgresa i lock-a; mali klaster (ili `k3s`); sve kao manifesti u gitu (nema ručnih izmjena); ako održavanje pređe limit — **vraćanje na Docker Compose** je dozvoljeno i nije neuspjeh |
| **Distributed lock bugovi** (dupli poslovi, mrtvi lockovi) | Isti posao se izvršava dvaput; posao „nikad ne kreće" posle restarta; lock TTL istekao u toku dugog posla | Lock **uvijek** sa TTL + `owner` tokenom; release samo ako je token isti (Lua/`WATCH`); heartbeat/refresh samo od vlasnika; **idempotencija posla** (isti `runId` se ne izvršava dvaput); chaos test (ubij instancu usred posla); alert `NmqJobsOverdue` |
| **OIDC integracija** (potroši nedjelje, drift u mapiranju rola) | Login „radi kod mene" a ne u produkciji; `redirect_uri` problemi; korisnik vidi tuđe podatke zbog pogrešnog mapiranja | Jedan provider, fiksni `redirect_uri`, `state` + PKCE; mapiranje `email → tenantId + rola` u `config/tenants.json` **sa testom** (korisnik iz tenanta A ne vidi B); ako zapne > 5 dana → SSO se odgađa, API ključevi ostaju (ne blokira isporuku) |
| **Tim od jedne osobe** (key-man rizik, burnout, bolest, odmor) | Prodaja stane kad se razvija; „nedjelja bez koda" se ne dogodi 3 nedjelje; klijent zove lično | Fiksno radno vrijeme + 1 dan bez koda; **runbook** za sve kritično (`docs/08` §9–10) + break-glass **van** servera; backup lozinka u DSH store-u; ugovorom **ne** obećavati 24/7; kod ključnih odluka — pisani zapis (da druga osoba može preuzeti) |
| **`agent_budget` koji blokira klijenta u radu** | Klijent javi „robot ne radi"; `nmq_controlplane_blocked_total{reason="budget"}` raste; posao `blocked` u `GET /v1/admin/jobs/:jobId/runs` | Nikad tiha blokada: alert vlasniku na 80% (`NmqTenantBudgetSoft`), jasna poruka korisniku (`402` + period), **grace** za `high` akciju koja je već u toku (završi započeto), „unaprijed odobreno do iznosa X" kao opcija u politici, jedan klik za privremeno podizanje limita |
| **Postgres migracija razbije izolaciju** | Test izolacije padne; odgovor sadrži podatak iz drugog tenanta; upit bez `tenant_id` u `WHERE` | RLS `FORCE` na **svakoj** tabeli; `tenant_id` obavezan parametar (D11); test koji **namjerno** probija tenant; prelazak **po tenantu** (ne „svi odjednom"); JSONL ostaje čitljiv kao fallback u prelaznom periodu |
| **Alerti koji šume → niko ih ne gleda** | Više od 5 alerta dnevno; isti alert se ponavlja; P2 alerti se „markiraju pročitanim" bez akcije | Dedup 1× u 15 min; mjesečna ocjena false-positive (cilj < 20%); alert bez „prve akcije" se briše; P0 se nikad ne gasi bez zapisa |
| **Trošak modela pojede maržu** | Trošak modela / prihod > 15% dva mjeseca; USD/upit raste; heavy user bez limita | `NMQ_BUDGET_RUN_USD` + mjesečni budžet + keš + kraći kontekst + manji model za rutiranje; cijena = 3–4× trošak (`docs/09` §4); alerti #5–#9 iz `docs/18` §5 |
| **Enterprise zahtjev koji ne možemo ispuniti** (SOC 2, on-prem pod našim uslovima, 24/7 SLA) | Upitnik traži sertifikat; traži se pen-test izvještaj; traži se 24/7 | Pripremljen **jasan** odgovor „imamo / nemamo"; ponuditi odvojen plaćen projekat (`docs/09` §5); **ne** potpisivati što ne možemo isporučiti; self-hosted kao namjeran kanal |
| **Integracije koje klijent koristi samo jednu** | 4 integracije, jedna nosi 95% poziva | Mjeri se upotreba po alatu (`nmq_tool_calls_total`); nekorišćene integracije se **gase** (manje koda = manje bugova); pravilo „max 4" |
| **Zakasnjela odobrenja blokiraju klijenta** | `nmq_approvals_pending` raste; `nmq_approval_wait_seconds` p95 > 4 h | Eskalacija poslije 4/12/24 h (`docs/06` §6.3); inbox + Slack dugmad; „odobri unaprijed do iznosa X"; mjesečni izvještaj „koliko je čekalo" |

---

## 6. Šta NAMJERNO ne radimo u ovih 16 nedjelja

| Ne radimo | Zašto |
|---|---|
| **Service mesh** (Istio/Linkerd) | Rješava problem koji nemamo: mTLS i routing između **naših** servisa. Imamo 1–2 servisa; NetworkPolicy + TLS na ingressu je dovoljno. Uvođenje mesha je nedjelje rada i nova klasa incidenata |
| **Multi-region** | Nema klijenta koji traži; udvostručuje trošak i operativni teret. Prvo **jedan** region (EU), pa replika baze, pa tek onda drugi region |
| **Vlastiti model / fine-tuning** | Nemamo 10.000 označenih primjera, a cijena modela po upitu je manja od cijene našeg vremena. Prvo RAG + prompt + eval; fine-tuning tek ako eval pokaže da je problem **u modelu**, a ne u KB-u |
| **Kubernetes operator** (vlastiti CRD) | Rješavamo problem „kako da tenant bude namespace" — to `kubectl apply` + template rješava bez operatora. Operator je proizvod u proizvodu |
| **gVisor / Kata Containers** (sandbox na nivou kernela) | Naš sandbox je aplikativni (`src/core/sandbox.js`) + `readOnlyRootFilesystem` + `drop ALL` + seccomp `RuntimeDefault`. Kernel-level sandbox je za **nepouzdan** kod; mi izvršavamo **naše** alate i **pinovane** MCP servere |
| **Marketplace alata / plugin store** | Marketplace bez korisnika je prazna vitrina. Prvo 4 integracije koje klijent **koristi**, pa razgovor o marketplace-u |
| **Voice / telefonski kanal** | Drugi kanal, druga latencija, druga cijena. Nema klijenta koji to traži u prvih 16 nedjelja; ako traži — to je plaćen projekat |
| **Vlastiti dashboard framework / SPA** | „Moderni" frontend je 3× vremena bez vrijednosti za operatera. Server-rendered HTML + `fetch` na `/metrics` je dovoljno (i nema build koraka — D2) |
| **Višeregionalna analitika / ClickHouse** | Postgres + Prometheus + Tempo pokrivaju prve klijente. ClickHouse je druga baza za održavanje i drugi backup |
| **SOC 2 / ISO 27001 sertifikacija** | Mjeseci i desetine hiljada EUR. U 16 nedjelja radimo **dokumentaciju koju možemo dokazati**; sertifikacija je odvojen, plaćen projekat |
| **Rebranding / marketing sajt** | Ne mijenja ni jedan broj u evalom izvještaju |
| **Treća vertikala** | Pravilo iz `docs/10` §3: max 2 vertikale do dokaza |
| **Zamjena JSONL-a „u hodu" (dvojno pisanje na sve strane)** | Dvostruko pisanje je izvor dvije istine. Prelazak je **po tipu podatka**, sa jednim izvorom istine u svakom trenutku |
| **Proaktivno brisanje/arhiviranje bez retention config-a** | „Ručno `rm`" na podacima klijenta je nedozvoljeno; retention ide kroz `config/retention.json` + job + audit zapis |

---

## 7. Prvi zadatak

**Konkretno i odmah (nedjelja 1, dan 1–2): uključiti pravi model, ubaciti KB prvog klijenta, izmjeriti
20 upita, zapisati rezultat u ovaj dokument.**

```bash
# 0) Ključ se NE piše u chat ni u dokument (čita se iz DSH store-a i koristi u env-u)
node C:\Users\Administrator\.dsh\NMQ\get-key.mjs DEEPSEEK_API_KEY     # vrijednost se ne ispisuje u izvještaj

# 1) env (samo IMENA varijabli; vrijednosti ostaju van repoa)
#    NMQ_LLM_PROVIDER=openai-compatible
#    NMQ_LLM_BASE_URL=https://api.deepseek.com/v1
#    NMQ_LLM_MODEL=deepseek-chat
#    NMQ_LLM_API_KEY=<iz DSH store-a>
#    NMQ_DATA_DIR=./data      NMQ_LOG_LEVEL=info

# 2) provjera da LLM NIJE mock (obavezno prije mjerenja)
node scripts/serve.mjs &
curl -s localhost:8787/readyz | grep llmIsMock        # mora biti false

# 3) KB prvog klijenta (politika povraćaja, dostava, FAQ) — 20–40 dokumenata
curl -s -X POST localhost:8787/v1/kb -H 'content-type: application/json' \
  -d '{"text":"<tekst politike povraćaja>","source":"Politika povraćaja"}'
curl -s -X POST localhost:8787/v1/kb/search -H 'content-type: application/json' \
  -d '{"query":"mogu li vratiti robu posle 14 dana","k":5}'   # provjera da RAG vraća smislene chunkove

# 4) 20 stvarnih upita klijenta — jedan po jedan, sa zapisom odgovora, citata, latencije i troška
node scripts/eval.mjs --set eval/golden.jsonl --out eval/report-$(date +%F).md

# 5) trošak i latencija iz podataka (ne iz osjećaja)
curl -s 'localhost:8787/v1/usage'                     # summary.usd, byAgent, byModel
curl -s 'localhost:8787/v1/runs?limit=20'             # runId-evi + trajanja
curl -s 'localhost:8787/v1/runs/<runId>'              # spanovi (gdje je otišlo vrijeme)
curl -s 'localhost:8787/metrics' | grep -E 'nmq_(runs_finished_total|run_duration_seconds_count|llm_calls_total)'
```

**Šta se zapisuje u ovaj dokument (dodaje se kao nova podsekcija `## 7.1 Rezultat prvog mjerenja`):**

| Kolona | Primjer oblika | Napomena |
|---|---|---|
| Datum i model | `2026-10-05 · deepseek-chat` | Model iz `NMQ_LLM_MODEL`; **nikad** ne pisati ključ |
| Broj upita | `20` | Svih 20 iz stvarnog klijentovog korpusa |
| Tačnih sa citatom | `17/20 (85%)` | Ocjena po unaprijed pisanom kriterijumu |
| „Ne znam / nema u KB" | `2/20` | Ovo je **ispravan** ishod, ne greška |
| Pogrešnih | `1/20` | Sa kratkim opisom (bez PII) |
| p50 / p95 latencija | `2,4 s / 6,8 s` | Iz `nmq_run_duration_seconds` |
| Trošak | `0,011 USD/upit` (prosjek) | Iz `GET /v1/usage` |
| Trošak ukupno | `0,22 USD za 20 upita` | Isto |
| Najveći problem | `1 odgovor bez citata iako je KB imao odgovor` | Konkretno, mjerljivo |
| Odluka | `nastavljamo u fazu 2` ili `popravljamo prompt/KB` | Gate iz §4 (uslov 1) |

**Pravilo:** ako 20 upita **ne** prođe granicu (≥ 80% tačnih sa citatom, p95 < 8 s), **ne ide se u fazu 2**.
Prva nedjelja faze 2 se troši na prompt/KB — jer integracije na robotu koji daje pogrešne odgovore samo
brže šalju pogrešne odgovore.

---

## Otvorena pitanja

1. **Koji je prvi plaćeni pilot** (ime klijenta, vertikala, kontakt osoba) i da li je njegova KB spremna
   za ingest **u nedjelji 1**? Bez toga faza 1 počinje sa `mock` modelom ili sa izmišljenim podacima —
   a to je izgubljena nedjelja.
2. **Idemo li u fazi 4 na Postgres prije ili poslije fazе 3** (alerti/dashboard)? Plan ide 4 poslije 3
   jer alerti daju vidljivost; ali ako klijent prvi potpiše sa zahtjevom za RLS/izolacijom, redoslijed se
   **mijenja** — šta je tada žrtva (dashboard kasni nedjelju)?
3. **K8s u fazi 5 ili Docker Compose do 3+ klijenta?** Compose je jeftiniji i jednostavniji za solo tim;
   K8s daje namespace po tenantu i HPA. Odluka mijenja **koliko sati nedjeljno** ide na održavanje
   infrastrukture umjesto na klijenta — koji je prag (npr. „K8s tek kad imamo 3 klijenta")?
4. **Ko plaća advokata, pen-test i (eventualno) SOC 2** — mi iz marže, klijent kao deo setup-a, ili se
   enterprise razgovor odgađa dok ne postoji klijent koji to **plati**? Bez te odluke §3.2 je lista želja.
5. **Koliko traje pilot i po kojoj cijeni** (procjena 500–1.500 EUR za 30 dana iz `docs/09` §6) — i da li
   u pilot ulazi **jedna** integracija ili sve četiri? To direktno mijenja obim faze 2 (3 nedjelje vs. 5).
6. **Šta je „enterprise spremno" za našeg prvog enterprise sagovornika** — OIDC + dokumentacija + izolacija
   (naš plan) ili sertifikat (koji ne možemo u 16 nedjelja)? Ako je sertifikat uslov, faza 6 se mijenja iz
   „SSO + dokumenti" u „priprema za audit", a to je drugi plan i drugi budžet.
7. **Ko je vlasnik gate odluke** (mi sami, ili klijent kroz nedjeljni demo)? Ako odlučujemo sami, rizik je
   da se „idemo dalje" kaže i kad uslovi nisu ispunjeni — treba li u gate ubaciti **klijentov** potpis?
