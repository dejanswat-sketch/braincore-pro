# 05 — Memorija i RAG

> Svrha: definisati tri sloja memorije NMQ Robota, tačne formate zapisa, RAG pipeline i izolaciju po tenantu.
> Ovaj dokument je u skladu sa `docs/DECISIONS.md`: **D7** (JSONL/JSON u MVP-u), **D8** (PostgreSQL 16 + pgvector + Redis u produkciji),
> **D9** (interfejs `VectorStore`, brute-force cosine → pgvector/Qdrant), **D10** (hash-embedder offline + openai-compatible embedder),
> **D11** i **D12** (`tenant_id` obavezan, `data/tenants/<tenant_id>/`), **D16** (cost/trace/audit).
> Ako se bilo koja tvrdnja ovdje razlikuje od `DECISIONS.md` — `DECISIONS.md` je mjerodavan i ovaj fajl se ispravlja.

**Usklađenost sa susjednim dokumentima (provjereno):** putanje fajlova, imena Postgres tabela i chunking parametri preuzeti su iz
`02-TECH-STACK.md` (§4.1 layout, §4.2 DDL, §4.3 RLS, §5.3 chunking) — taj dokument je **kanonski** za šemu i putanje.
Ovaj dokument dodaje **sadržaj memorije** (taksonomija eventova, JSON šeme, retrieval pipeline, facts, retencija, izolacija u praksi).
Nazivi tabela koje ovaj dokument uvodi: **`facts`** (izvedene činjenice; nema je u §4.2 — predlaže se dodavanje u kanonsku šemu).
Naziv `chunks` se **ne** uvodi: chunk = red u `embeddings`. Naziv `usage/` se **ne** uvodi: trošak živi u `costs/`.
Imena akcija u auditu prate `04-ORCHESTRACIJA.md` (`handoff`, `router_decision`, `plan_trimmed`, `tenant_mismatch`) i
`08-SECURITY-COMPLIANCE.md` (`gdpr_delete`); scope za odluku o odobrenju je `approvals:decide`.

---

## 1. Tri sloja memorije

| Sloj | Šta čuva | Životni vijek | Gdje živi (MVP) | Gdje živi (produkcija) | Ko čita |
|---|---|---|---|---|---|
| **short-term (session)** | Trenutni razgovor: `messages[]`, aktivni task, privremeni `slots`, poslednji tool rezultat, sažetak starijeg dijela | TTL 24h od zadnje aktivnosti (config `session.ttlHours`); gasi se i ranije kad istekne `maxTokens` prozor | `data/tenants/<tenantId>/sessions/<sessionId>.jsonl` + `sessions/<sessionId>.snapshot.json`; u memoriji `Map` sa LRU (max 500 sesija) | Redis (`SETEX nmq:sess:<tenantId>:<sessionId>`), JSON u hash-u; Postgres `sessions` za durable kopiju | `src/memory/session.js` → orchestration pattern, agent loop, `/v1/agents/:id/stream` |
| **long-term (event log)** | Istorija razgovora i akcija: svaki `user_message`, `agent_message`, `tool_call`, `tool_result`, `decision`, `approval`, `outcome`; izvedene `facts` | 365 dana za `tool_call`/`approval`/`outcome`/`decision`; 180 dana za `*_message`; `facts` bez roka dok ih korisnik ne obriše | `data/tenants/<tenantId>/longterm/events.jsonl` (append-only, **kanonska putanja iz `02-TECH-STACK.md` §4.1**); izvedeni `facts/<userId>.jsonl` | Postgres `events` (JSONB: `kind`/`text`/`metadata`, tabele po `02-TECH-STACK.md` §4.2) + `facts`; RLS po `tenant_id` | `src/memory/longterm.js` → `search()`, memory extraction, `/v1/runs/:runId`, analitika |
| **vector (RAG)** | Dokumenta, KB, wiki, FAQ, prošli projekti/ponude, transkripti sastanaka — sve što se **pretražuje po značenju** | Dok traje dokument u izvoru; reingest pri svakoj izmjeni; chunk bez izvora se briše (`source_deleted`) | `data/tenants/<tenantId>/vectors/vectors.jsonl` (`{id, text, metadata, embedding[]}`, kanonska putanja); brute-force cosine u `src/memory/vector.js` | Postgres `embeddings` (pgvector `vector(1536)`, HNSW indeks) za tenant do ~5M chunkova; Qdrant kolekcija `t_<tenantId>` za veće | `src/memory/vector.js` → RAG retrieve korak, `researcher` agent, citations |

> **Napomena o imenima (važno, izbjegava koliziju):** u ovom dokumentu „chunk" je **jedan red u tabeli `embeddings`**
> (`source_id` = `docId`, `chunk_no` = redni broj). Naziv tabele `chunks` se **ne** uvodi — kanonska šema je `embeddings`
> iz `02-TECH-STACK.md` §4.2. Fizički JSONL je uvijek `vectors/vectors.jsonl`, a ne `vectors/index.jsonl`.

**Pravilo slojeva:** sesija je *brza i prolazna*, long-term je *istinit i trajan* (dokaz šta je urađeno),
vektor je *približan i ponovljiv iz izvora* (uvijek se može reingestovati). Nijedan sloj nije izvor istine za novac —
za to su `costs/` i audit (vidi `06-OBSERVABILITY-GOVERNANCE.md`).

**Šta se NIKAD ne stavlja u memoriju:** tajne (API ključevi, lozinke, tokeni), brojevi kartica, CVV,
kompletni matični brojevi. Ako alat vrati takav podatak, prolazi kroz redakciju prije upisa (sekcija 8).

---

## 2. Session memory

### 2.1 Struktura sesije (JSON)

```json
{
  "sessionId": "s_01J9F2K7QW3ZB4",
  "tenantId": "t_nmq",
  "agentId": "support",
  "userId": "u_8842",
  "channel": "widget",
  "createdAt": "2026-09-29T08:11:02.481Z",
  "updatedAt": "2026-09-29T08:19:44.115Z",
  "expiresAt": "2026-09-30T08:19:44.115Z",
  "branchOf": null,
  "state": {
    "status": "active",
    "turn": 7,
    "pattern": "router",
    "activeRunId": "r_01J9F2M8TT1Q0C",
    "pendingApproval": null
  },
  "tokens": { "window": 3120, "budget": 8000, "summarizeAt": 6400, "total": 41230 },
  "slots": {
    "intent": "refund_request",
    "orderId": "ORD-99120",
    "language": "sr",
    "sentiment": "neutral"
  },
  "summary": "Korisnik traži povraćaj za ORD-99120 (isporuka 12.09). Ponuda: zamjena ili refundacija. Ceka odgovor podrske o roku.",
  "messages": [
    { "role": "user", "content": "Stigla mi je pogrešna veličina", "at": "2026-09-29T08:11:02.481Z", "tokens": 14 },
    { "role": "assistant", "content": "Provjeriću porudžbinu ORD-99120.", "at": "2026-09-29T08:11:09.002Z", "tokens": 22, "citations": [] },
    { "role": "tool", "name": "orders.get", "args": { "orderId": "ORD-99120" }, "resultRef": "evt_01J9F2M...", "at": "2026-09-29T08:11:10.774Z", "tokens": 180 }
  ],
  "lastToolResult": { "name": "orders.get", "status": "ok", "at": "2026-09-29T08:11:10.774Z" }
}
```

Polja koja se **obavezno** postavljaju pri kreiranju: `sessionId`, `tenantId`, `agentId`, `createdAt`, `expiresAt`.
`schemaVersion` polje postoji u svakom zapisu (MVP: `1`) da migracija formata ne zahtijeva downtime.

### 2.2 Klizni prozor (sliding window) i sažimanje

- Prozor se mjeri u **tokenima**, ne u broju poruka: `tokens.window` (trenutno u promptu) vs `tokens.budget` (maksimalno).
- Tokeni se broje heuristikom `ceil(znakova / 4)` za en i `ceil(znakova / 3)` za sr/latinicu (`src/core/ids.js`, `estimateTokens()`),
  ili tačno ako provider vrati `usage.prompt_tokens` (uvijek vjeruj provideru kad je dostupan).
- Kada `tokens.window >= summarizeAt`: uzmi najstarijih 60% poruka (nikad `system` i nikad zadnjih 4 turn-a),
  sažmi ih u jedan `summary` blok i izbaci iz `messages[]`. Originalne poruke **ostaju** u long-term logu.
- Rezultat sažimanja je 120–250 riječi, obavezno sa: cilj korisnika, donesene odluke, ID-evi entiteta, otvorena pitanja, jezik.
- Sažetak se upisuje kao event `decision` (`kind: "session_summary"`) da je i on dio istorije i audita.
- Nikad ne sažimaj: brojeve porudžbina, iznose, datume, pravne formulacije, `pendingApproval` — ti dijelovi se prenose verbatim.
- Ako i posle sažimanja prozor prelazi budžet → `state.status = "active"`, uzmi zadnjih N poruka i obavijesti korisnika da je kontekst skraćen
  (u SSE: `event: step` sa `{"note":"context_truncated"}`).

```json
{ "type": "decision", "kind": "session_summary", "sessionId": "s_01J9F2K7QW3ZB4", "covers": { "from": 1, "to": 11 }, "summaryTokens": 190, "model": "summarizer" }
```

### 2.3 Identifikatori, TTL i nastavak sesije

| Pitanje | Odgovor |
|---|---|
| Ko je vlasnik `sessionId`? | Server generira (`s_` + ULID). Klijent ga **ne** izmišlja; može ga čuvati i poslati nazad |
| Kako klijent nastavlja? | `POST /v1/agents/:agentId/run` sa `{ "sessionId": "s_..." }`; ako sesija ne postoji/istekla → server vraća `{ "error": "session_expired", "newSessionId": "s_..." }` i novu sesiju |
| TTL | `session.ttlHours` (default 24h), produžava se pri svakom `append()`; tvrdi limit `session.maxTtlHours` (default 72h) |
| Prekid sesije | Eksplicitno: `DELETE /v1/sessions/:id` (ili `state.status="closed"`); implicitno: TTL istekao ili novi `pendingApproval` preusmjeren |
| Nastavak posle prekida | Rebuild iz `snapshot.json` (poslednji kompaktni state) + replay poslednjih 20 eventova iz long-term loga; `branchOf` se puni ako se nastavlja stara sesija kao nova grana |
| Izolacija | Svaki `get/append/set` prima `tenantId`; implementacija **baca** `TenantIsolationError` ako se `sessionId` nađe pod drugim tenantom (vidi sekciju 5) |
| Snapshot | Piše se posle svakih 50 eventova ili na `closed`; sadrži `slots`, `summary`, `tokens`, zadnjih 10 poruka |

---

## 3. Long-term memorija

### 3.1 Eventi i JSONL šema

Fajl: `data/tenants/<tenantId>/longterm/events.jsonl` — append-only, jedan JSON po liniji, `\n` terminacija, UTF-8 bez BOM
(rotacija: `longterm/archive/YYYY-MM.jsonl`, kanonska pravila u `02-TECH-STACK.md` §4.1).
Zajednička polja **svakog** eventa: `schemaVersion`, `eventId` (`evt_` + ULID), `tenantId`, `ts` (ISO 8601 UTC), `type`,
`sessionId`, `runId`, `agentId`, `userId` (ako postoji), `traceId`, `spanId`. `eventId` je unikatan i nikad se ne mijenja.

```jsonc
// type: user_message
{ "schemaVersion":1,"eventId":"evt_01J9F2K7","tenantId":"t_nmq","ts":"2026-09-29T08:11:02.481Z","type":"user_message",
  "sessionId":"s_01J9F2K7QW3ZB4","runId":null,"agentId":"support","userId":"u_8842","traceId":"tr_01J9F2K7","spanId":"sp_01",
  "content":"Stigla mi je pogrešna veličina","lang":"sr","channel":"widget","redacted":false,"tokens":14 }

// type: agent_message
{ "schemaVersion":1,"eventId":"evt_01J9F2K8","tenantId":"t_nmq","ts":"2026-09-29T08:11:09.002Z","type":"agent_message",
  "sessionId":"s_01J9F2K7QW3ZB4","runId":"r_01J9F2M8TT1Q0C","agentId":"support","traceId":"tr_01J9F2K7","spanId":"sp_02",
  "content":"Provjeriću porudžbinu ORD-99120.","model":"deepseek-chat","finishReason":"tool_calls","tokens":{"in":410,"out":22},
  "citations":[{"docId":"d_help_refund","chunkId":"c_017","score":0.83}],"redacted":false }

// type: tool_call
{ "schemaVersion":1,"eventId":"evt_01J9F2M9","tenantId":"t_nmq","ts":"2026-09-29T08:11:10.100Z","type":"tool_call",
  "sessionId":"s_01J9F2K7QW3ZB4","runId":"r_01J9F2M8TT1Q0C","agentId":"support","traceId":"tr_01J9F2K7","spanId":"sp_03",
  "tool":"orders.get","riskLevel":"low","argsRedacted":{"orderId":"ORD-99120"},"scopes":["orders:read"],
  "policyDecision":"allow","attempt":1,"source":"builtin" }

// type: tool_result
{ "schemaVersion":1,"eventId":"evt_01J9F2MA","tenantId":"t_nmq","ts":"2026-09-29T08:11:10.774Z","type":"tool_result",
  "sessionId":"s_01J9F2K7QW3ZB4","runId":"r_01J9F2M8TT1Q0C","traceId":"tr_01J9F2K7","spanId":"sp_03",
  "tool":"orders.get","status":"ok","durationMs":674,"bytes":1180,"redacted":false,
  "result":{"orderId":"ORD-99120","size":"M","shippedAt":"2026-09-12","status":"delivered"},
  "resultHash":"sha256:9f2c...","truncated":false }

// type: decision (odluka agenta ili sistema, npr. izbor agenta/patterna ili sažimanje)
{ "schemaVersion":1,"eventId":"evt_01J9F2MB","tenantId":"t_nmq","ts":"2026-09-29T08:11:10.900Z","type":"decision",
  "sessionId":"s_01J9F2K7QW3ZB4","runId":"r_01J9F2M8TT1Q0C","traceId":"tr_01J9F2K7","spanId":"sp_04",
  "kind":"tool_selection","chosen":"orders.get","alternatives":["orders.list","crm.findCustomer"],"reason":"orderId poznat","by":"agent" }

// type: approval (zahtjev, odluka i ko je odlučio)
{ "schemaVersion":1,"eventId":"evt_01J9F2MC","tenantId":"t_nmq","ts":"2026-09-29T08:12:00.000Z","type":"approval",
  "sessionId":"s_01J9F2K7QW3ZB4","runId":"r_01J9F2M8TT1Q0C","traceId":"tr_01J9F2K7","spanId":"sp_05",
  "tool":"refunds.create","riskLevel":"high","status":"pending","requestedBy":"support","approver":null,
  "expiresAt":"2026-09-30T08:12:00.000Z","amount":{"value":4990,"currency":"RSD"},"argsRedacted":{"orderId":"ORD-99120"} }
// status: pending | approved | rejected | expired ; posle odluke dodaju se: approver, decidedAt, reason, channel

// type: outcome (krajnji ishod posla — jedino što se broji u KPI)
{ "schemaVersion":1,"eventId":"evt_01J9F2MD","tenantId":"t_nmq","ts":"2026-09-29T08:14:31.220Z","type":"outcome",
  "sessionId":"s_01J9F2K7QW3ZB4","runId":"r_01J9F2M8TT1Q0C","traceId":"tr_01J9F2K7",
  "result":"resolved","metric":{"firstResponseMs":6600,"handledTurns":7,"escalated":false,"costUsd":0.0041},
  "tags":["refund","ecommerce"],"verifiedBy":"user_confirmation" }
```

### 3.2 Indeksi i performanse

| Indeks (MVP: u memoriji pri startu, iz JSONL-a) | Ključ | Za šta |
|---|---|---|
| `bySession` | `tenantId + sessionId + ts` | Rebuild sesije, replay, „šta se pričalo" |
| `byRun` | `tenantId + runId` | `GET /v1/runs/:runId`, waterfall trace |
| `byUser` | `tenantId + userId + ts` | Memory extraction, GDPR brisanje po korisniku |
| `byTool` | `tenantId + tool + ts` | Metrika `nmq_tool_calls_total`, analiza grešaka |
| `byApproval` | `tenantId + status` | Lista čekajućih odobrenja, eskalacija |
| `fullText` | invertovani indeks nad `content` (MVP: jednostavan token indeks; produkcija: Postgres `tsvector`) | `longterm.search()` keyword dio hibrida |

Produkcija: `events` po šemi iz `02-TECH-STACK.md` §4.2 (`tenant_id`, `kind`, `text`, `metadata jsonb`, `created_at`) — jedan red po eventu,
pri čemu se `type` iz JSONL-a mapira na `kind`, a cijeli JSON event u `metadata`. Indeksi: `(tenant_id, created_at DESC)`, `gin (metadata jsonb_path_ops)`;
dodatno `(tenant_id, (metadata->>'session_id'))` i `(tenant_id, (metadata->>'user_id'))` za replay i GDPR. Uz svaki upit obavezno `app.tenant_id` (RLS, sekcija 5.2).
Rotacija: fajlovi stariji od retencije idu u hladni storage (`longterm/archive/*.jsonl.gz`) ili se brišu po politici iz sekcije 8.
Ako se uvede tabela `event_log` sa punom taksonomijom (kolone `type`, `session_id`, `run_id`), ona **mijenja** `events` tek kroz migraciju i uz izmjenu `02-TECH-STACK.md` — do tada je `events` jedini izvor u PG-u.

### 3.3 Memory extraction — iz istorije u `facts`

**Cilj:** iz sirovih eventova izvući stabilne, provjerljive činjenice o korisniku/tenantu, sa dokazom (koji event ih podržava).
Ne izmišljati: `fact` bez `sourceEventIds` se **odbacuje**.

```jsonc
// data/tenants/<tenantId>/facts/<userId>.jsonl
{ "schemaVersion":1,"factId":"f_01J9F3A1","tenantId":"t_nmq","userId":"u_8842","ts":"2026-09-29T08:20:00.000Z",
  "subject":"user:u_8842","predicate":"preferred_language","object":"sr","confidence":0.92,
  "sourceEventIds":["evt_01J9F2K7","evt_01J9F2K8"],"extractor":"llm:summarizer","status":"active","expiresAt":null,
  "validFrom":"2026-09-29T08:20:00.000Z","supersedes":null }
```

| Pravilo | Vrijednost |
|---|---|
| Kada se pokreće | Asinhrono posle `outcome` eventa, ili na svakih 10 turn-a, ili na `closed` sesije; nikad u kritičnoj putanji odgovora |
| Ko izvlači | LLM sa malim modelom + striktna JSON šema (`extractor`); deterministički fallback za `orderId`, `email`, `language` |
| Dozvoljeni predikati (MVP) | `preferred_language`, `contact_email`, `company`, `plan`, `timezone`, `preferred_channel`, `product_owned`, `objection`, `do_not_contact` |
| Prag | `confidence >= 0.75` da uđe u `active`; `0.5–0.75` → `status:"candidate"` (ne ide u prompt bez potvrde) |
| Kontradikcija | Novi fact sa istim `subject+predicate` i većim `confidence` postavlja `supersedes` na stari i stari prelazi u `status:"superseded"` |
| `do_not_contact` | Nikad se ne supersede automatski; samo korisnik ili admin |
| Upotreba | U prompt idu max 5 `active` factova (najnoviji + najveći confidence), svaki sa `factId` za brisanje |
| Trošak | Extraction batch: max 20 eventova po pozivu, max 400 tokena izlaza |

---

## 4. Vektorska memorija i RAG

### 4.1 Pipeline

```
ingest → chunk → redact(PII) → embed → upsert → [retrieve → rerank] → prompt → odgovor sa citatima
```

| Korak | Ulaz | Izlaz | Pravilo |
|---|---|---|---|
| **ingest** | fajl/URL/tekst/DB zapis | `doc` + `docId` (`d_` + ULID), `contentHash` (sha256) | Idempotentno: isti `tenantId + source + contentHash` → preskoči (nema duplikata, nema novog troška) |
| **chunk** | `doc.text` | `chunk[]` | **ciljna veličina 800 znakova, raspon 800–1200** (kanonski: `02-TECH-STACK.md` §5.3), **preklop 120 znakova (15%)**, granice: prvo po `\n\n`/naslovima, pa po rečenici, pa tvrdi rez; minimum 50 znakova (kratki ostatak se spaja sa prethodnim chunkom); chunk nikad ne prelazi 1200 znakova |
| **redact** | `chunk.text` | očišćen tekst | PII redakcija **prije** embedovanja (email/telefon/JMBG/kartica → `[EMAIL]` itd.) |
| **embed** | `chunk.text` | `embedding: number[]` | MVP: hash-embedder (dim 256, offline); produkcija: `openai-compatible` (dim 1536, **dimenzija fiksirana u config-u i provjerava se pri upisu**); keš po `sha256(normalizovan tekst + embedderId)`; L2 normalizacija pri upisu i upitu |
| **upsert** | `{ id, text, metadata, embedding }` | zapis u `VectorStore` | `id = source_id + ':' + chunk_no` (kanonske kolone `embeddings` iz §4.2); upsert je idempotentan po tom paru |
| **retrieve** | `query` | `top-k = 8` kandidata | Hibridno: vektorski top 8 + keyword/BM25 top 8 → unija → dedup po `chunkId` |
| **rerank** | 8–16 kandidata | **3** chunka u prompt | Reranker: LLM cross-encoder (mali model) ili heuristika (skor = 0.7×cosine + 0.3×BM25, +0.1 ako je `lang` isti, −0.2 ako je `ageDays > 365`) |
| **prompt** | 3 chunka | blok `KONTEXT` sa citatima | Svaki chunk ulazi sa `[docId:chunkId]` oznakom; model mora citirati; bez pokrivenosti → „nemam u dokumentaciji" |

Parametri chunkinga su u config-u (`config/tenants.json` → `rag.chunk`), ne u kodu; mijenjanje zahtijeva **reingest** dokumenta.
Preklop od 120 znakova je namjerno manji od 150: kraći preklop = manje duplog teksta u promptu (i manji trošak), a i dalje pokriva granicu pasusa.

### 4.2 Metadata šema (obavezna po chunku)

Mapiranje na kanonsku tabelu `embeddings` (`02-TECH-STACK.md` §4.2): `source_id` = `docId`, `chunk_no` = `chunkIndex`,
`text` = tekst chunka, `embedding` = vektor, a sve ostalo (uključujući `tenant_id`) ide u `metadata jsonb`.

```jsonc
{ "chunkId":"d_help_refund:17","docId":"d_help_refund","tenantId":"t_nmq","source":"kb/refunds.md","sourceType":"markdown",
  "title":"Politika povraćaja","url":"https://.../refunds","lang":"sr","tags":["refund","policy","ecommerce"],
  "createdAt":"2026-08-01T00:00:00.000Z","updatedAt":"2026-09-20T10:00:00.000Z","contentHash":"sha256:1ab4...",
  "chunkIndex":17,"chunkTotal":42,"tokens":280,"acl":["public"],"pii":"redacted","trust":"untrusted",
  "embedder":"hash-256","version":1 }
```

| Polje | Zašto je obavezno |
|---|---|
| `tenantId` | Prvi filter u **svakom** upitu; bez njega upit se odbija (sekcija 5.4) |
| `docId`, `source` | Citiranje i brisanje cijelog dokumenta (`delete by docId`) |
| `lang` | Filter jezika + blagi bonus u reranku |
| `tags` | Filteri tipa `filter: { tags: { $in: ["policy"] } }` |
| `createdAt` | Svježina: stariji dokumenti dobijaju manji skor; retencija |
| `acl` | Lista grupa/rola koje smiju vidjeti chunk (`["public"]`, `["support"]`, `["legal","admin"]`, `["user:u_8842"]`) |
| `trust` | `trusted` (naš KB) ili `untrusted` (uvezeni dokument); `untrusted` se nikad ne ubacuje u `system` prompt (zaštita od prompt injection, `08-SECURITY-COMPLIANCE.md`) |
| `contentHash` | Idempotentan ingest i detekcija izmjene |
| `version` | Schema verzija chunka; reingest diže verziju |

### 4.3 Hibridna pretraga

```
query "koliko traje povraćaj novca"
  ├─ vektorski:  embed(query) → cosine nad tenantovim indeksom → top 8   (semantika, sinonimi)
  └─ keyword:    BM25/tsvector nad chunk.text → top 8                   (tačni ID-evi, šifre, imena)
  → unija (do 16) → dedup po chunkId → rerank → top 3 → prompt
```

| Situacija | Zašto oba |
|---|---|
| Korisnik pita „ORD-99120" | Vektor sam promaši tačan ID; BM25 ga nađe odmah |
| Korisnik pita „kad će mi pare nazad" | BM25 promaši (nema tih riječi u KB); vektor nađe „povraćaj … 5 radnih dana" |
| Pravni tekst | Tačna formulacija je obavezna → BM25 težina u reranku raste na 0.5 |

**Citiranje je obavezno** za `support` i `legal` agente: svaka tvrdnja iz KB-a mora imati `[docId:chunkId]`.
Ako retrieve vrati 0 chunkova iznad praga (`minScore`, default `0.25`): agent odgovara „nemam to u dokumentaciji",
nudi eskalaciju na čovjeka i **ne** izmišlja. Odgovor bez ijednog citata u tim domenima se loguje kao `quality_flag: "uncited"`.

---

## 5. Izolacija po tenantu u praksi

### 5.1 Nivo 1 — fizička izolacija (MVP)

Kanonski izgled je u `02-TECH-STACK.md` §4.1; ovdje je samo ono što memorija dodaje (označeno `+`):

```
data/tenants/<tenantId>/
  config.json                  # politike/budžet tenanta (bez tajni)   [kanonski]
  sessions/<sessionId>.jsonl                                          # [kanonski]
  sessions/<sessionId>.snapshot.json   + kompaktni state (slots/summary/tokens)
  longterm/events.jsonl                                               # [kanonski]
  longterm/archive/YYYY-MM.jsonl       + rotacija
  facts/<userId>.jsonl         + izvedene činjenice (memory extraction)
  vectors/vectors.jsonl                                               # [kanonski]
  documents/<docId>.<ext>      + originali (ACL-om zaštićeni, ne embeduju se direktno)
  cache/<sha256>.json                                                 # [kanonski] embedding/LLM keš
  audit/YYYY-MM.jsonl                                                 # [kanonski] hash-chained (vidi 06)
  traces/<runId>.jsonl                                                # [kanonski] spanovi (vidi 06)
  costs/YYYY-MM.json                                                  # [kanonski] agregat troška (vidi 06)
```

Pravila: `tenantId` prolazi kroz `sanitizeTenantId()` (`^[a-z0-9][a-z0-9_-]{1,31}$`) — sprječava `../` u putanji;
svaka putanja se gradi isključivo kroz `pathFor(tenantId, ...)` u `src/tenancy/store.js`, nikad string konkatenacijom u drugim modulima;
`data/` je u `.gitignore` (DECISIONS D7 i zamke). Redoslijed foldera **nije** slobodan: `longterm/`, `vectors/`, `audit/`, `traces/`, `costs/`
su kanonski; nova imena (`events/`, `usage/`, `vectors/index.jsonl`) se ne uvode.

### 5.2 Nivo 2 — logička izolacija (PostgreSQL RLS)

Isti obrazac kao `02-TECH-STACK.md` §4.3, primijenjen na tabele koje memorija koristi: `events`, `embeddings`, `facts`.
Imena politika su **po tabeli** (npr. `events_tenant_isolation`), da se ne sudaraju sa politikama iz §4.3.

```sql
-- 1) Rola aplikacije NIJE vlasnik tabela i NEMA BYPASSRLS (kanonski: §4.3)
CREATE ROLE nmq_app LOGIN PASSWORD '<iz DSH store-a: APP_DB_PASSWORD>' NOBYPASSRLS;
GRANT SELECT, INSERT, UPDATE, DELETE ON events, embeddings, facts TO nmq_app;

-- 2) RLS na svakoj tenant tabeli koje memorija dodaje
ALTER TABLE facts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts      FORCE  ROW LEVEL SECURITY;   -- važi i za vlasnika tabele
-- events i embeddings su već pod RLS-om po §4.2/§4.3; FORCE ponavljamo radi jasnoće
ALTER TABLE events     FORCE  ROW LEVEL SECURITY;
ALTER TABLE embeddings FORCE  ROW LEVEL SECURITY;

-- 3) Politika po tabeli (jedna po tabeli; USING za čitanje, WITH CHECK za upis)
CREATE POLICY events_tenant_isolation ON events
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY embeddings_tenant_isolation ON embeddings
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY facts_tenant_isolation ON facts
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
```

Svaka transakcija (obavezno, kroz `withTenant()` helper; `set_config(..., true)` jer je **lokalno za transakciju** — `SET LOCAL` je ekvivalent,
ali se koristi `set_config` radi parametrizacije):

```sql
BEGIN;
SELECT set_config('app.tenant_id', $1, true);          -- $1 = 't_nmq'; pooling ne može pomiješati tenant-e
SELECT id, text, metadata,
       1 - (embedding <=> $2::vector) AS score
  FROM embeddings
 WHERE tenant_id = current_setting('app.tenant_id', true)   -- eksplicitno + RLS kao drugi sloj
   AND metadata @> $3::jsonb                                -- acl/tags filter
 ORDER BY embedding <=> $2::vector
 LIMIT 8;
COMMIT;
```

Zahtjevi: konekcija se **nikad** ne drži preko granice zahtjeva sa postavljenim `app.tenant_id`;
drugi argument `true` je obavezan; ako vrijednost nije postavljena, `USING` je `NULL` → nula redova (fail-closed).
**ANN indeks ne poznaje RLS** — RLS filtrira poslije, pa se traži `k * 3` i filtrira na `k`, ili se radi particija po tenantu za velike tenante.
Test: `SELECT count(*) FROM events` (i `embeddings`, `facts`) bez postavljenog `app.tenant_id` mora vratiti `0`.

### 5.3 Nivo 3 — vektorska izolacija: namespace vs metadata filter

| Pristup | Kako | Prednosti | Mane | Kada |
|---|---|---|---|---|
| **A. Kolekcija/namespace po tenantu** | `t_<tenantId>` (Qdrant collection, pgvector tabela/particija, ili `data/tenants/<id>/vectors/`) | Fizički nemogu cross-tenant upit; brisanje tenanta = drop kolekcije; indeks po tenantu je manji i tačniji; lakši backup/restore po tenantu | Mnogo malih kolekcija (Qdrant/pgvector overhead po kolekciji); cross-tenant analitika („svi tenanti") traži fan-out; rebalans pri rastu | **Default za NMQ**: tenant < 5M chunkova; enterprise klijenti; regulisani domeni |
| **B. `tenant_id` u metadata filteru** | jedna kolekcija, `filter: { tenantId: "t_nmq" }` uz svaki upit | Jednostavno, jedan indeks, cross-tenant analitika trivijalna, manje kolekcija | Greška u filteru = curenje podataka; jedan veliki indeks (pogoršanje preciznosti pri velikom broju tenanta); teže dokazati izolaciju auditoru | > 500 malih tenanta, ili tenant koji nikad ne prelazi 50k chunkova |

**Odluka:** MVP i prvi enterprise klijenti → **A** (namespace po tenantu), jer je izolacija feature #1 (D11).
Prebacivanje na **B** je dozvoljeno samo kroz `VectorStore` adapter i samo uz **obavezan** `tenant_id` filter u query builder-u
(filter se dodaje u adapteru, nikad ga agent ne piše ručno). Hibrid: A za velike tenante, B za „long tail" malih — isti interfejs, različit `strategy` u config-u.

### 5.4 Zabrana cross-tenant upita

- Svaki javni metod memorije ima `tenantId` kao **prvi** parametar; bez njega → `TypeError` (ne default vrijednost!).
- `longterm.search()` i `vector.query()` grade filter kroz `tenantFilter(ctx)`, koji baca `TenantIsolationError` ako je `ctx.tenantId` prazan ili ne odgovara `session.tenantId`.
- Interne funkcije ne primaju „listu tenanta" — cross-tenant izvještaji idu isključivo kroz `src/tenancy/store.js#forEachTenant()`
  (admin putanja, zahtijeva `scope: "admin:read"`, loguje se u audit kao `type:"admin_cross_tenant_read"`).
- Rezultati pretrage nikad ne sadrže `content` iz drugog tenanta čak i ako embedding sličnost postoji; `chunkId` je globalno unikatan,
  ali se prije vraćanja provjerava pripadnost (`assertSameTenant(chunk, ctx)`).
- Keševi (embedding, odgovor, retrieval) su imenski prostori po tenantu: ključ **uvijek** sadrži `tenantId` (npr. `emb:t_nmq:sha256:...`).

### 5.5 Test izolacije (obavezan, `node --test`)

```
1. Seed: tenant A dobija dokument "A-tajna-<uuid>", tenant B dokument "B-tajna-<uuid>".
2. Upit pod tenantom A sa tekstom B-tajne → assert: 0 rezultata, 0 citata, nijedan chunkId ne pripada B.
3. Upit pod tenantom A bez tenantId → assert: TenantIsolationError (fail-closed).
4. Postgres: bez `app.tenant_id` → assert count(*) == 0 na events/embeddings/facts.
5. Postgres: `set_config('app.tenant_id','t_a',true)` → INSERT sa tenant_id='t_b' → assert: WITH CHECK ga odbija.
6. Fajl-sistem: pokušaj pathFor('t_a', '../../t_b/longterm/events.jsonl') → assert: sanitizacija baca grešku.
7. Faktovi: extraction iz sesije tenanta A nikad ne upisuje u facts tenanta B (assert po putanji fajla).
8. Keš: dva identična upita pod A i B → assert različit keš ključ (`cache/<sha256>` po tenantu) i različit rezultat.
9. RLS/ANN: `k*3` over-fetch pod A nikad ne vrati red pod B čak i kad je B najbliži susjed u vektorskom prostoru.
```

---

## 6. Kako agent koristi memoriju

### 6.1 Redoslijed u jednom turn-u

```
[1] POLICY      → evaluate(policy, action): allow / deny / require_approval   (prije svega ostalog)
[2] SESSION     → session.get(tenantId, sessionId) → messages, slots, summary, tokens
[3] RAG RETRIEVE→ vector.query(tenantId, { text: userMsg, k: 8, filter }) → rerank → top 3 + citati
[4] ISTORIJA    → longterm.search(tenantId, { query: userMsg, k: 5 }) + poslednjih N eventova iz sesije
[5] FACTS       → facts aktivan set (max 5) za userId
[6] PROMPT      → system(agent) + politika + KONTEXT(citati) + FAKTOVI + ISTORIJA + sesija(prozor)
[7] LLM         → provider.chat(...) ; ako traži tool → [1] ponovo za taj tool
[8] TOOL        → izvrši (ili pauziraj na odobrenje), upiši tool_call/tool_result
[9] ODGOVOR     → tekst + citati → SSE stream do klijenta
[10] UPIS       → session.append + longterm.append(agent_message, tool_*, decision)
                + vector.upsert (samo novi dokumenti/faktovi, ne svaki turn)
                + costs/cost + trace span zatvoren (+ audit ako je bila akcija)
```

Dijagram toka (tekstualno):

```
  korisnik ──► HTTP/SSE ulaz ──► POLICY ──deny──► 403 + policy_denied event
                                  │ allow/approval
                                  ▼
                              SESSION ──► RAG retrieve ──► longterm+facts
                                  │            │
                                  └──────┬─────┘
                                         ▼
                                    PROMPT BUILD ──► LLM ──tool_calls?──┐
                                         ▲                             │
                                         │                    TOOL (risk high → APPROVAL → pauza)
                                         └──────── tool_result ────────┘
                                         ▼
                                   ODGOVOR + citati ──► SSE ──► korisnik
                                         ▼
                        UPIS: session │ longterm │ (vector) │ usage │ trace │ audit
```

Napomena: korak **[3] RAG se preskače** kada je `rag.enabled=false` za agenta (npr. `ops` nad internim API-jem) ili kada
procijenjeni trošak retrieval-a prelazi budžet turn-a; u tom slučaju u trace ide `span: "rag.skipped"` sa razlogom.

### 6.2 Primjer prompta sa ubačenim kontekstom i citatima

```
SYSTEM
Ti si NMQ support agent za tenant "t_nmq". Jezik: sr (latinica). Odgovaraj kratko i konkretno.
PRAVILA:
- Tvrdnje o politici povraćaja smiješ dati SAMO iz KONTEXT bloka i moraš navesti citat u obliku [docId:chunkId].
- Ako KONTEXT ne pokriva pitanje, reci "nemam to u dokumentaciji" i ponudi eskalaciju. Ne izmišljaj rokove.
- Nikad ne traži i ne izgovaraj broj kartice, lozinku ili API ključ.
- Za akcije sa rizikom high (refund, brisanje, slanje mejla spolja) predloži akciju; izvršenje čeka odobrenje.

KONTEXT (izvor: KB, tenant t_nmq)
[1] [d_help_refund:c_017] "Povraćaj se obrađuje u roku od 5 radnih dana od prijema robe. Novac se vraća na isti način plaćanja."
[2] [d_help_refund:c_018] "Ako je porudžbina stigla u pogrešnoj veličini, kupac bira zamjenu ili povraćaj u roku od 14 dana."
[3] [d_ship_terms:c_004] "Rok isporuke je 2–4 radna dana za teritoriju Srbije."

FAKTOVI (o korisniku)
- preferred_language = sr (f_01J9F3A1, confidence 0.92)
- product_owned = "Model X" (f_01J9F3A2, confidence 0.80)

ISTORIJA (poslednjih 5 događaja, tenant t_nmq)
- 2026-09-29T08:11:02Z user_message: "Stigla mi je pogrešna veličina"
- 2026-09-29T08:11:10Z tool_result orders.get: {"orderId":"ORD-99120","size":"M","status":"delivered"}

SESIJA (sažetak starijeg dijela)
Korisnik traži povraćaj za ORD-99120; ponuđena zamjena ili refundacija; čeka rok.

USER
Stigla mi je pogrešna veličina, koliko traje povraćaj?
```

Očekivani odgovor (sa citatom, bez izmišljanja): „Povraćaj se obrađuje u roku od 5 radnih dana od prijema robe [d_help_refund:c_017].
Pošto je porudžbina ORD-99120 već isporučena, možete izabrati zamjenu ili povraćaj u roku od 14 dana [d_help_refund:c_018].
Želite li da pokrenem zahtjev za povraćaj (čeka odobrenje)?"

---

## 7. Troškovi i performanse

| Operacija | Latencija (cilj) | Trošak | Kako se drži u cilju |
|---|---|---|---|
| `session.get` + `append` (fajl) | < 5 ms p50, < 20 ms p95 | 0 (disk) | Snapshot svakih 50 eventova; ne čitaj cijeli JSONL nego snapshot + tail |
| `session.get` + `append` (Redis) | < 2 ms p50, < 10 ms p95 | ~0 (self-hosted) | `SETEX` + hash; jedan round-trip |
| Embed query (hash-embedder) | < 2 ms | 0 | Uvijek u procesu, bez mreže |
| Embed query (API) | < 120 ms p95 | po 1K tokena → **provjeriti kod providera** | Keš po `sha256(text+embedderId)`; batch; timeout 3s + fallback na hash-embedder |
| Embed ingest (batch 64 chunka) | < 1.5 s po batch-u | po 1K tokena → **provjeriti kod providera** | Batch 64–128; keš; reingest samo izmijenjenih `contentHash` |
| Vektorska pretraga (brute-force, 10k chunkova) | < 50 ms | 0 | Do ~50k chunkova drži u memoriji kao `Float32Array`; iznad toga pgvector HNSW |
| Vektorska pretraga (pgvector HNSW) | < 20 ms p95 | 0 (VPS) | `ef_search=64`; indeks `vector_cosine_ops` |
| Keyword/BM25 | < 10 ms (MVP), < 30 ms (Postgres) | 0 | `tsvector` GIN indeks |
| Rerank (heuristika) | < 5 ms | 0 | Default u MVP-u |
| Rerank (LLM cross-encoder) | < 400 ms | mali model → **provjeriti kod providera** | Samo kad je `rag.rerank="llm"` (legal/support sa velikim KB) |
| Sažimanje sesije | < 1.2 s | mali model → **provjeriti kod providera** | Samo kad `tokens.window >= summarizeAt` (6400), ne svaki turn |
| Memory extraction | < 2 s (async) | mali model → **provjeriti kod providera** | Batch 20 eventova; nikad u kritičnoj putanji |
| Cijeli RAG turn (bez LLM odgovora) | < 300 ms p95 | vidi gore | Paralelno: vektorski + keyword upit istovremeno (`Promise.all`) |

**Keširanje:**
- **Embedding keš:** ključ `emb:<tenantId>:<embedderId>:<sha256(normalizovan tekst)>` → `number[]`. Fajl: `data/tenants/<id>/cache/<sha256>.json` (kanonska putanja iz `02-TECH-STACK.md` §4.1); LRU u memoriji (max 20k unosa). Udara samo na ponovljeni tekst (isti FAQ, isti chunk, ista query).
- **Retrieval keš:** ključ `rag:<tenantId>:<sha256(queryNormalized + filterHash)>` → lista `chunkId` + skorovi; TTL 10 min ili do prvog `upsert` u tom tenantu (invalidacija po `docId`).
- **Response keš:** ključ `ans:<tenantId>:<agentId>:<sha256(prompt)>`; TTL 5 min; **zabranjen** za `high` rizik akcije, za personalizovane odgovore i za sve što sadrži korisničke podatke iz alata. Uvijek se preskače ako je `session.turn > 1`.
- **Config keš:** agenti/politike se čitaju jednom i drže u memoriji, sa `mtime` provjerom (hot reload bez restarta).
- **Batch embed:** pri ingestu grupiši 64–128 chunkova po pozivu; pri query-ju nikad batch (jedan query = jedan poziv), osim za `fanout` pattern gdje se sve pod-query-jev embeduju zajedno.

**Kada manji model za sažimanje:** uvijek za `session_summary`, `memory extraction` i klasifikaciju namjere (`intent`), jer
kvalitet glavnog odgovora ne zavisi od njih; veliki model samo za finalni odgovor, planiranje (`magentic`) i pravni tekst.
Konkretna imena modela i cijene se **ne hardkoduju** — dolaze iz `config/tenants.json` (`models.summarizer`, `models.embedder`)
i provjeravaju se kod providera (sekcija 8 i `06-OBSERVABILITY-GOVERNANCE.md` sekcija 4).

---

## 8. Zaboravljanje i privatnost

| Zahtjev | Kako se izvodi | Dokaz |
|---|---|---|
| **Brisanje po korisniku (GDPR čl. 17)** | `DELETE /v1/tenants/:id/users/:userId` → (1) `facts/<userId>.jsonl` se briše, (2) `longterm/events.jsonl` se filtrira po `userId` (prepiši fajl bez tih linija — append-only log dobija `tombstone`), (3) redovi u `embeddings` sa `acl` koji sadrže `user:<id>` se brišu, (4) sesije se brišu, (5) audit dobija zapis o brisanju | `deletion-report.json`: broj obrisanih eventova/embeddinga/faktova + `jobId`; u audit `kind:"gdpr_delete"` sa `userId` i `counts` |
| Tombstone umjesto tihe izmjene | U log se prvo upiše `{"type":"tombstone","userId":"...","reason":"gdpr","eventIds":[...]}` pa se fizički prepišu fajlovi; čitači odbacuju evente navedene u tombstone-u | Lanac audita ostaje validan (sekcija 7 u docu 06) |
| **Retencija** | `user_message`/`agent_message`: 180 dana · `tool_call`/`tool_result`: 365 · `decision`/`outcome`: 365 · `approval`: 365 (obavezno za reviziju) · `traces`: 30 dana · `costs`: 7 godina (finansije) · `audit`: 7 godina i **ne briše se** | Dnevni `retention` job (cron/systemd timer) loguje `type:"retention_run"` sa brojem obrisanih zapisa po tipu |
| **Redakcija PII prije embedovanja** | Regex + validatori: email, telefon (RS format), JMBG (13 cifara + checksum), broj kartice (Luhn), IBAN, `sk-`/`Bearer` obrasci, API ključevi → zamjena `[EMAIL]`, `[PHONE]`, `[JMBG]`, `[CARD]`, `[IBAN]`, `[SECRET]` (kanonski oblik zamjene i audit `redaction`: `08-SECURITY-COMPLIANCE.md`) | Original ostaje u `documents/` (pod ACL-om), samo **embedovani tekst** je redigovan; u metapodacima `pii:"redacted"`; test sa uzorkom PII mora dati 0 pogodaka u `vectors/vectors.jsonl` |
| **`acl` filter u pretrazi** | `vector.query()` uvijek merge-uje dva filtera: `tenantId` (obavezno) i `acl` (presjek sa `ctx.userScopes`); chunk bez `acl` se **odbacuje** (fail-closed) | Test: korisnik bez `legal` scope ne dobija nijedan chunk sa `acl:["legal"]` |
| Zabrana logovanja tajni | Tajne vrijednosti se rediguju u `tool_call.argsRedacted` i nikad ne ulaze u `content`; u config-u i logovima samo **imena** varijabli (npr. `SMTP_PASS`), vrijednosti iz DSH store-a (`get-key.mjs`) | Test: `grep -i 'sk-' data/` mora biti prazan |
| Pravo na prenosivost | `GET /v1/tenants/:id/users/:userId/export` → JSON sa `messages`, `facts`, `outcomes` (bez internih tragova i bez tuđih podataka) | Fajl `export.json` sa `schemaVersion` i potpisom |
| Minimizacija | Ne ingestuj lične dokumente bez `acl`; `facts` ograničeni na listu predikata iz 3.3 | Revizija liste predikata pri svakoj izmjeni šeme |
| Anonimizacija za analitiku | Metrike i `usage` nikad ne sadrže `content`, samo brojeve i ID-eve (hash korisnika ako treba) | Metrike su po dizajnu bez PII (doc 06 sekcija 3) |

---

## 9. Plan uvođenja

### MVP — nedjelja 1–3 (radi offline, bez servera)

- `src/memory/session.js`: `get/append/set`, JSONL + snapshot, TTL, klizni prozor, sažimanje heuristikom (bez LLM-a) ili malim modelom.
- `src/memory/longterm.js`: `append` u `longterm/events.jsonl`, `search` (keyword + in-memory indeksi iz 3.2), memory extraction sa 5 predikata.
- `src/memory/vector.js` + `embeddings.js`: hash-embedder (dim 256), brute-force cosine, chunking 800/120, hibridna pretraga sa heurističkim rerankom (top 8 → 3).
- Izolacija: `data/tenants/<tenantId>/`, `sanitizeTenantId`, `pathFor`, kao i 8 testova izolacije iz 5.5.
- Citati u odgovoru za `support` (format `[docId:chunkId]`), fallback „nemam u dokumentaciji".
- **Dokaz:** `node --test` prolazi bez mreže i bez zavisnosti; `scripts/demo.mjs` pokaže 2 tenanta i RAG odgovor sa citatima.

### v1 — nedjelja 4–8 (produkcijska memorija)

- PostgreSQL 16 + pgvector: `embeddings` (`vector(1536)` + HNSW), `facts`; `events` po kanonskoj šemi; migracije u `infra/`.
- RLS politike iz 5.2 + `withTenant()` helper + `set_config('app.tenant_id', ..., true)` u svakoj transakciji; test fail-closed.
- Redis za sesije (`SETEX`), rate limit i queue za asinhrone jobove (extraction, ingest, retention).
- `openai-compatible` embedder + batch ingest 64–128; embedding keš u `cache/`; `VectorStore` adapter sa `strategy: "namespace" | "filter"`.
- LLM rerank za legal/support; `acl` filter u svim pretragama; PII redakcija prije embedovanja.
- Retention job (180/365/30) + GDPR brisanje po korisniku + export.

### v2 — nedjelja 9–12 (skala i kvalitet)

- Qdrant adapter iza istog interfejsa za tenante > 5M chunkova; hibridna strategija A/B iz 5.3.
- Memory evaluation: skup od 50 pitanja po domenu, mjeri se `recall@3`, `citation_accuracy`, `answerable_rate`; regresija blokira deploy.
- Višekanalna memorija: isti `userId` kroz widget, email i Slack se spaja u jedan profil (uz `channel` atribuciju eventa).
- Facts sa TTL-om i „svježina" (npr. `plan` ističe za 90 dana), revizija kontradikcija, admin UI za pregled/potvrdu `candidate` faktova.
- Napredno zaboravljanje: po `docId`, po `tag`, po vremenskom periodu („zaboravi sve prije 2025"), sa izvještajem.
- Skalabilnost: streaming ingest velikih dokumenata (PDF/HTML), inkrementalni reindeks, dedup po `contentHash`, multi-tenant fairness u job queue-u.

---

## Otvorena pitanja

1. **Embedding model i dimenzija:** ostajemo li na 1536 (pgvector `vector(1536)`, kanonski iz `02-TECH-STACK.md` §4.2) ili idemo na model sa drugom dimenzijom?
   Odluka mijenja DDL, veličinu indeksa i cijenu; mjeri se `recall@3` na 50 pitanja prije zaključavanja.
2. **Reranker:** da li je LLM rerank obavezan za `legal` (kvalitet) ili dovoljan heuristički uz veći BM25 ponder (latencija + trošak)?
3. **Retencija `*_message`:** da li 180 dana zadovoljava poslovne potrebe (reklamacije, sporovi) ili ide na 365 kao za alate?
4. **Brisanje u append-only logu:** prihvatamo li prepisivanje fajlova (tombstone + rewrite) ili uvodimo kriptografsko brisanje
   (ključ po korisniku, brisanje ključa = podaci nečitljivi)? Drugo je skuplje ali dokazivo.
5. **Namespace vs metadata filter:** koji je prag za prelazak na strategiju B (broj tenanta vs broj chunkova) i ko ga mjeri?
6. **Sesije u Redis-u:** da li je TTL 24h dovoljan za widget podrške, ili klijenti traže „nastavi razgovor posle 7 dana" (durable sesija bez Redis TTL-a)?
