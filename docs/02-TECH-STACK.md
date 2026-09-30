# 02 — Tech stack

> Ovaj dokument je izveden iz `docs/DECISIONS.md` (verzija 1.0, obavezujući ugovor).
> Oznake `D1`–`D20` u tekstu su reference na odluke iz tog fajla. Ako dokument i
> `DECISIONS.md` nisu saglasni — **važi `DECISIONS.md`**, i ovaj fajl se ispravlja.
>
> Pravilo o verzijama i cijenama: nijedna tačna verzija biblioteke ni cijena modela u ovom
> dokumentu **nije garantovana**. Gdje piše „provjeriti" — postoji navedena komanda ili URL
> kojim se vrijednost utvrđuje prije upotrebe. Cijene i verzije se mijenjaju brže od dokumentacije.

---

## 1. Odluka u jednoj tabeli

| Sloj | Tehnologija | Verzija | Zašto baš to | Šta je alternativa |
|---|---|---|---|---|
| Runtime | Node.js, ESM (`"type": "module"`) | ≥ 20 LTS; referentno 22 (D1). Tačan broj provjeriti: `node -v` na ciljnom serveru | Isti runtime kao DSH, Hostinger Passenger i Hetzner VPS — jedan jezik, jedan `node_modules`, jedan način deploy-a | Bun / Deno (brži start, ali drugačiji deploy i slabija pokrivenost na shared hostingu); Python (vidi §9) |
| Jezik | JavaScript (bez TypeScript build koraka) | ES2023+ | Nema transpile koraka → nema build-a → Hostinger LVE limit (D2, §5 DECISIONS) ne može da obori deploy | TypeScript (bolji tipovi, ali `tsc` korak i `node_modules`); JSDoc tipovi kao srednja opcija |
| Paket menadžer | npm (samo `package.json` + skripte) | npm iz Node distribucije | Ne instaliramo ništa; npm je samo runner skripti (`npm test`, `npm start`) | pnpm / yarn — nemaju šta da ubrzaju kad je `dependencies: {}` |
| HTTP server | `node:http` + vlastiti micro-router | ugrađeno u Node (D3) | REST + SSE + webhook + statika = ~300 linija; nula supply-chain rizika | Express / Fastify / Hono (ekosistem middleware-a, ali zavisnost i verzija koja se mora pratiti) |
| Streaming | SSE `text/event-stream` (D4) | protokol, ne biblioteka | Radi kroz svaki proxy, Cloudflare i shared hosting; browser `EventSource` je ugrađen | WebSocket (`ws` zavisi od zavisnosti; držati samo u `optionalDependencies`) |
| MCP klijent | Vlastiti JSON-RPC 2.0 klijent (D5) | protokol MCP, spec se čita sa `modelcontextprotocol.io` — **provjeriti reviziju** prije implementacije | MCP je otvoren JSON-RPC protokol; ne zavisimo od toga da li se SDK API mijenja između verzija | `@modelcontextprotocol/sdk` (brži start, ali zavisnost + breaking changes) |
| LLM | OpenAI-kompatibilan adapter preko `fetch` (D6) | zavisi od provajdera | DeepSeek primarni (ključ već postoji u DSH store-u), ostali su samo drugi `baseUrl` + `model` | Vercel AI SDK / LiteLLM (proxy) — vidi §9; oba uvode zavisnost ili drugi servis |
| Skladištenje MVP | Fajl-sistem: JSONL + JSON (D7) | – | MVP se diže jednom komandom, bez servera, backup je `cp -r data/` | SQLite (jedan fajl, ali native modul → build problem na Hostingeru) |
| Skladištenje produkcija | PostgreSQL | 16.x (D8) — tačnu minor verziju provjeriti: `psql -c 'select version();'` | RLS daje izolaciju tenanta na nivou reda, a ne na nivou aplikativne greške | MySQL/MariaDB (nema RLS); Supabase (hosted PG, ali dodatni vendor) |
| Vektorska memorija | Brute-force cosine u JS-u → kasnije pgvector | pgvector ekstenzija — tačnu verziju provjeriti u `pg_available_extensions` | Do ~10⁴–10⁵ vektora po tenantu brute-force je dovoljan i nema infrastrukture | Qdrant / Weaviate / Milvus / Chroma (odvojen servis; uvodi se tek kad pgvector ne drži) |
| Embeddings | Ugrađeni hash-embedder + `openai-compatible` embedder (D10) | – | Demo, testovi i offline rad bez interneta i bez troška; produkcija koristi isti interfejs | Lokalni model (Ollama) / sentence-transformers — Python, van MVP-a |
| Sesije / rate limit / queue | In-memory Map → Redis | Redis — tačnu verziju provjeriti: `redis-server --version` | Redis je jedini dio stack-a koji se uvodi kasnije i samo ako zatreba (§10) | In-memory (gubi se na restartu); Postgres kao queue (radi, ali sporije) |
| Testovi | `node --test` (D17) | ugrađeno u Node 20+ | Testovi bez zavisnosti i bez interneta — tačka 1 iz „Definition of Done" | Vitest / Jest (bolji DX, ali `node_modules` i build) |
| Frontend (embed) | Jedan JS fajl + Shadow DOM | vanilla JS, ES2020 target | Widget se ubacuje jednim `<script>` tagom, stilovi ne cure u sajt ni iz sajta | React/Preact widget (bundle + build korak); iframe (izolacija, ali lošiji UX i SEO) |
| Dashboard (kasnije) | Next.js | verziju provjeriti prije uvođenja | Isti jezik, kasnije i nezavisno od jezgra | Admin u `node:http` (nema build, ali ručni UI rad) |
| Kontenerizacija | Docker + `docker-compose` (D18) | – | Isto kao postojeća NMQ infrastruktura (Hetzner `nmq-server`) | goli `systemd` bez Dockera (manje slojeva, ali nema reproducibilnog okruženja) |
| Reverse proxy / tunel | Cloudflare tunnel + `cloudflared` | – | Nema otvorenih portova, TLS i WAF besplatno, isto kao sada | nginx + Let's Encrypt (više kontrole, više posla) |
| Observability | Vlastiti trace + `/metrics` (Prometheus tekst) + cost tracker (D16) | – | Naplata po usage-u i audit zahtijevaju podatke koje ionako moramo sami da skupljamo po tenantu | OpenTelemetry SDK (standard, ali zavisnost i kolektor); Grafana stack kao potrošač našeg `/metrics` |
| Tajne | DSH store + `get-key.mjs`, `.env` van git-a | – | Ključevi su već centralizovani (513 ključeva u `.credentials.yaml`) | Vault / SOPS / Doppler (ispravno za tim, preteško za jednog operatera) |

---

## 2. Jezgro bez zavisnosti (zero-dep core)

### 2.1 Šta tačno znači `dependencies: {}`

```json
{
  "name": "nmq-robot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "dependencies": {},
  "optionalDependencies": {},
  "scripts": {
    "start": "node scripts/serve.mjs",
    "demo": "node scripts/demo.mjs",
    "test": "node --test tests/",
    "smoke": "node scripts/smoke.mjs"
  }
}
```

Posljedice koje se odmah vide:

1. **Nema `npm install`** → nema faze u kojoj deploy može da padne (Hostinger LVE limit procesa,
   §5 u `DECISIONS.md`). `git clone` + `npm start` je cijeli setup.
2. **Nema `node_modules`** → nema supply-chain rizika, nema `npm audit`, nema lock fajla koji
   treba održavati, nema „radi kod mene" problema.
3. **Nema build koraka** → nema `dist/`, nema source map zbrke, nema razlike između razvojnog i
   produkcionog izlaza.
4. **Radi offline** → hash-embedder (D10) + `mock` LLM provider (D6) znače da `npm test` i
   `node scripts/demo.mjs` prolaze bez interneta i bez ijednog ključa.

### 2.2 Šta dobijamo iz samog Node-a

| Potreba | Ugrađeni modul | Napomena |
|---|---|---|
| HTTP server, routing | `node:http` | Vlastiti router: `method + path pattern → handler`, ~60 linija |
| SSE stream | `node:http` (`res.write`) | `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no` |
| HTTP klijent (LLM, REST alati) | `node:https` / globalni `fetch` | `fetch` je stabilan od Node 21; na 20 provjeriti da nije eksperimentalan |
| MCP stdio transport | `node:child_process` (`spawn`) | JSON-RPC 2.0 preko `stdin`/`stdout`, poruke odvojene `\n` |
| MCP HTTP transport | `node:http`/`https` + `fetch` | Streamable HTTP: `POST` JSON-RPC + opcioni SSE odgovor |
| Fajl skladište (JSONL/JSON) | `node:fs/promises` | Append-only JSONL, atomski write kroz `rename` |
| Kripto (AES-256-GCM, hash) | `node:crypto` | `createCipheriv('aes-256-gcm')`, `scrypt`, `timingSafeEqual` |
| Testovi | `node:test` + `node:assert/strict` | Ugrađen runner i mock (`t.mock`) |
| CLI argumenti | `node:util` (`parseArgs`) | Bez `yargs`/`commander` |
| Konfiguracija | `node:fs` + JSON | `.env` čita vlastiti parser od ~20 linija |
| Vrijeme / ID | `node:crypto` (`randomUUID`) | Prefiksirani ID-jevi: `run_`, `tr_`, `tnt_` |

### 2.3 Granice ovog pristupa (gdje zero-dep počinje da boli)

| Granica | Simptom | Kako se rješava bez lomljenja pravila |
|---|---|---|
| Nema `npm` ekosistema | Svaka nova integracija (OAuth, Stripe, AWS) se piše ručno preko `fetch` | MCP (D5) — integracija se konzumira kao protokol, ne kao paket |
| Vlastiti router | Nema gotovih middleware-a (CORS, body limit, multipart) | Pišu se jednom, u `src/server/http.js`, i pokrivaju testovima |
| Vlastiti MCP klijent | Svaka promjena MCP specifikacije je naš posao | Klijent je izolovan u `src/tools/mcp-client.js`; JSON-RPC 2.0 je stabilan sloj ispod |
| Nema ORM-a | SQL se piše ručno, migracije su `.sql` fajlovi | Za 10-15 tabela je prednost: nema magije, RLS se vidi u kodu |
| Brute-force vektori | Linearno usporavanje sa brojem vektora | Prag: vidi §5.4; tada pgvector kroz isti `VectorStore` interfejs |
| Bez TypeScript-a | Greške u obliku objekata se hvataju testovima, ne kompajlerom | JSDoc `@typedef` + `// @ts-check` u kritičnim fajlovima (opciono, bez build-a) |
| Bez bundlera za widget | Nema tree-shakinga, sav kod ide u jedan fajl | Widget je ionako namjerno jedan fajl (D4, §6) |

### 2.4 Kada se uvodi prva zavisnost

Prva zavisnost se **ne uvodi** dok ne važi bar jedan od sljedećih uslova (odluka se upisuje u
`DECISIONS.md` prije koda):

1. **Zadatak je nemoguć bez nje**, a ne „lakši je sa njom". Primjer: potreban je pravi PDF
   renderer sa fontovima — alternativa je poziv eksternog servisa.
2. **Postojeći kod je dokazano uzak grlo** — mjereno, ne osjećano: npr. brute-force cosine preko
   500k vektora pravi > 300 ms po upitu na produkciji.
3. **Zavisnost je jedan fajl bez tranzitivnih zavisnosti** i može se vendovati u `vendor/`
   (kao three.js u projektu OBJECT A-90 — lokalno, bez CDN-a).
4. **Sigurnosno je kritična i mi je ne treba pisati** (npr. puna implementacija OAuth 2.1 PKCE
   protiv 5 provajdera).

Procedura uvođenja:

```
1. Upisati odluku u docs/DECISIONS.md (nova stavka D21+), sa razlogom i alternativom.
2. `dependencies` (obavezno) ili `optionalDependencies` (mora da degradira bez nje).
3. Provjeriti: `npm ls --all` (broj tranzitivnih), `npm audit`, licenca, veličina.
4. Dokazati da `npm test` i `node scripts/demo.mjs` i dalje rade bez te zavisnosti
   (test mora da je preskoči ako nije instalirana).
5. Verzija se pinuje tačno (bez `^`), lock fajl ulazi u git.
```

Prvi realni kandidati, po prioritetu: (a) `ws` za WebSocket samo ako neki tenant to izričito traži,
(b) `pg` **samo u produkciji** za Postgres (u MVP-u je skladište fajl-sistem), (c) `redis` klijent
uz Redis u fazi 3 migracije. Do tada: `dependencies: {}`.

---

## 3. LLM sloj

### 3.1 Adapter preko `fetch` (D6)

Svi provajderi koji podržavaju OpenAI-kompatibilan `/chat/completions` koriste **isti** adapter;
razlika je samo u `baseUrl`, `apiKey` i `model`. Ugovor iz `DECISIONS.md` §2:

```js
provider.chat({ messages, tools, temperature, maxTokens, stream, signal })
  -> { text, toolCalls[], usage, model, finishReason }
```

Konfiguracija (imena polja, bez vrijednosti ključeva):

```json
{
  "llm": {
    "default": "deepseek",
    "providers": {
      "deepseek": {
        "kind": "openai-compatible",
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKeyRef": "DEEPSEEK_API_KEY",
        "model": "deepseek-chat",
        "timeoutMs": 60000,
        "supportsTools": true,
        "supportsStream": true
      },
      "openai": {
        "kind": "openai-compatible",
        "baseUrl": "https://api.openai.com/v1",
        "apiKeyRef": "OPENAI_API_KEY",
        "model": "gpt-4o-mini",
        "apiKeyHeader": "Authorization"
      },
      "groq": {
        "kind": "openai-compatible",
        "baseUrl": "https://api.groq.com/openai/v1",
        "apiKeyRef": "GROQ_API_KEY",
        "model": "llama-3.3-70b-versatile"
      },
      "openrouter": {
        "kind": "openai-compatible",
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKeyRef": "OPENROUTER_API_KEY",
        "model": "deepseek/deepseek-chat",
        "extraHeaders": { "HTTP-Referer": "https://nmq.local", "X-Title": "NMQ Robot" }
      },
      "ollama": {
        "kind": "openai-compatible",
        "baseUrl": "http://127.0.0.1:11434/v1",
        "apiKeyRef": null,
        "model": "llama3.1:8b",
        "note": "lokano; provjeriti OLLAMA_HOST/OLLAMA_URL u DSH store-u"
      },
      "vllm": {
        "kind": "openai-compatible",
        "baseUrl": "http://127.0.0.1:8000/v1",
        "apiKeyRef": null,
        "model": "provjeriti-na-serveru"
      },
      "mock": {
        "kind": "mock",
        "note": "deterministički odgovori za testove; bez mreže"
      }
    }
  }
}
```

Pravila adaptera:

- **Ključ se nikad ne čita iz koda** nego po imenu (`apiKeyRef`) iz DSH store-a ili env-a (§8).
- **Nikad se ne loguje** tijelo zahtjeva sa ključem; u trace ide `provider`, `model`, `usage`,
  trajanje — ne header-i.
- **`signal`** (AbortSignal) je obavezan parametar podrške: svaki poziv ima timeout i može se
  prekinuti (korisnik zatvori widget, budžet se potroši).
- **Retry**: samo na 429/5xx/mrežnu grešku, eksponencijalni backoff sa jitter-om, max 3 pokušaja;
  nikad retry na 400/401/403 (to je naša greška u zahtjevu ili ključu).
- **Idempotentnost**: ako je zahtjev već potrošio tokene a pao u mreži, ne ponavljamo slijepo —
  cost tracker (D16) bilježi šta je stiglo.

### 3.2 Tabela modela i cijena (približno — obavezno provjeriti)

> Sljedeće vrijednosti su **orijentir**, upisane u trenutku pisanja dokumenta. Cijene se mijenjaju
> bez najave. Prije nego se osloniš na broj: provjeri zvaničnu stranicu cijena provajdera i
> upiši stvarnu vrijednost u `config/pricing.json` sa datumom provjere.

| Provajder | Model (primjer) | Kontekst (orijentaciono) | Cijena input / output (orijentaciono) | Kako provjeriti |
|---|---|---|---|---|
| DeepSeek | `deepseek-chat` | provjeriti | najniža od navedenih; tačan broj **provjeriti** | `GET /models` na `api.deepseek.com` + stranica cijena provajdera |
| DeepSeek | `deepseek-reasoner` | provjeriti | skuplji output (reasoning tokeni); **provjeriti** | isto |
| OpenAI | `gpt-4o-mini` | provjeriti | srednja; **provjeriti** | `platform.openai.com/docs/pricing` |
| OpenAI | `gpt-4o` / `gpt-4.1` | provjeriti | viša; **provjeriti** | isto |
| Groq | `llama-3.3-70b-versatile` | provjeriti | niska + vrlo brz inference; **provjeriti** | `console.groq.com/docs/pricing` |
| OpenRouter | proizvoljan model iz kataloga | provjeriti | provajder-dependent, naplata po tokenu + marža; **provjeriti** | `openrouter.ai/models` (piše cijena po modelu) |
| Ollama (lokalno) | `llama3.1:8b` i sl. | provjeriti | **0 $ po tokenu**, plaća se RAM/CPU servera | `ollama list`, `ollama ps` na serveru |
| vLLM (lokalno) | bilo koji HF model | provjeriti | **0 $ po tokenu**, plaća se GPU | `curl http://127.0.0.1:8000/v1/models` |
| mock | – | – | 0 $, bez mreže | – |

Model cijena u kodu (`config/pricing.json`) — jedini izvor istine za $ izračun:

```json
{
  "_note": "USD po 1M tokena. Provjeriti na stranici provajdera i upisati datum.",
  "deepseek:deepseek-chat":      { "in": 0.0, "out": 0.0, "checkedAt": "PROVJERITI" },
  "openai:gpt-4o-mini":          { "in": 0.0, "out": 0.0, "checkedAt": "PROVJERITI" },
  "groq:llama-3.3-70b-versatile":{ "in": 0.0, "out": 0.0, "checkedAt": "PROVJERITI" },
  "_fallbackPolicy": "ako model nije u tabeli, cost se bilježi u tokenima, $ = null (nikad izmišljena cijena)"
}
```

**Pravilo:** ako model nije u tabeli cijena, `cost tracker` upisuje `usd: null` i broj tokena.
Nikad se ne prikazuje izmišljena cifra korisniku ili na fakturi.

### 3.3 Fallback lanac modela

Fallback je **lista kandidata po ulozi**, ne jedan model. Uloge: `default`, `cheap`, `reasoning`,
`vision`, `embedding`.

```json
{
  "llm": {
    "chains": {
      "default": [
        { "provider": "deepseek", "model": "deepseek-chat" },
        { "provider": "groq",     "model": "llama-3.3-70b-versatile" },
        { "provider": "openai",   "model": "gpt-4o-mini" },
        { "provider": "ollama",   "model": "llama3.1:8b" }
      ],
      "reasoning": [
        { "provider": "deepseek", "model": "deepseek-reasoner" },
        { "provider": "openai",   "model": "gpt-4o" }
      ]
    },
    "fallbackRules": {
      "onStatus": [408, 409, 429, 500, 502, 503, 504],
      "onError": ["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "ABORT_ERR"],
      "maxAttemptsPerProvider": 2,
      "backoffMs": [250, 1000],
      "neverFallbackOn": [400, 401, 403, 422],
      "budgetCheck": "prije svakog kandidata; ako je budžet tenanta potrošen -> stop, ne fallback"
    }
  }
}
```

Algoritam (redoslijed je bitan):

```
1. Uzmi lanac za ulogu (npr. default) i filtriraj provajdere bez ključa -> ako je lista prazna, greška.
2. Provjeri budžet tenanta (tokeni $) i rate limit -> ako je prekoračen, vrati 429/402 bez poziva.
3. Za svakog kandidata: pozovi provider.chat sa timeout-om i signal-om.
4. Uspjeh -> zabilježi (tenantId, agentId, provider, model, usage, usd, fallbackIndex) i vrati.
5. Greška koja je u onStatus/onError -> sljedeći kandidat, uz backoff.
6. Greška koja je u neverFallbackOn -> prekid (naš bug ili neispravan ključ; fallback bi je sakrio).
7. Svi kandidati pali -> vrati strukturiranu grešku sa listom pokušaja (provider, model, status).
```

Ključno: **`fallbackIndex` ide u trace i u cost**. Time se vidi koliko često primarni provajder
pada — to je signal da se nešto mijenja (rate limit, istekao ključ, promjena API-ja).

### 3.4 Strujanje (SSE)

Lanac na serverskoj strani:

```
klijent (widget / curl)                NMQ Robot                         LLM provajder
  |  POST /v1/agents/:id/stream  ->     |                                    |
  |                                     |  POST /chat/completions stream:true|
  |                                     | ---------------------------------> |
  |                                     |  <-- SSE: data: {delta...}         |
  |  <-- SSE: token / step / tool       |  (parse, normalizuj, prosli)       |
  |                                     |  <-- data: [DONE]                  |
  |  <-- SSE: done {usage, cost}        |  zabilježi cost + trace span       |
```

Format prema klijentu (ugovor iz `DECISIONS.md` §2 — događaji `token | step | tool | done | error`):

```
event: step
data: {"step":1,"agentId":"support","pattern":"sequential"}

event: tool
data: {"name":"hubspot.search_contact","status":"running","riskLevel":"low"}

event: token
data: {"text":"Vaš nalog "}

event: tool
data: {"name":"hubspot.search_contact","status":"ok","ms":412}

event: done
data: {"runId":"run_...","usage":{"in":812,"out":233},"cost":{"usd":null,"tokens":1045},"finishReason":"stop"}
```

Pravila implementacije (iz iskustva, ne teorije):

- Header-i: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`,
  `Connection: keep-alive`, `X-Accel-Buffering: no` (Cloudflare/nginx inače baferuju cijeli odgovor).
- Heartbeat komentar (`: ping`) na ~15 s da proxy ne prekine tihu vezu.
- `res.flushHeaders()` odmah nakon prvog event-a, da klijent ne čeka prvi token.
- **Prekid na klijentu** (`EventSource.close()`) mora da abort-uje LLM poziv (`AbortController`) —
  inače plaćamo tokene za odgovor koji niko ne čita.
- Ako provajder ne podržava stream, radimo „pseudo-stream": puni odgovor pa emisija po riječima
  uz malu pauzu. To je UX trik, i u trace-u se označava `streamMode: "synthetic"` — nikad se ne
  predstavlja kao pravi streaming.
- U SSE se **nikad** ne šalju tajne ni sirovi error stack; greška ide kao `event: error` sa kodom.

### 3.5 Tool-calling

Dva formata, jedan interni model:

| Provajder | Format | Način zadavanja |
|---|---|---|
| OpenAI-kompatibilni (DeepSeek, Groq, OpenRouter, vLLM) | `tools: [{ type: "function", function: { name, description, parameters } }]` + `tool_choice` | JSON Schema iz `tool.params` |
| Anthropic-style | `tools: [{ name, description, input_schema }]` + `tool_use` blokovi | mapiranje iz istog internog `Tool` |
| Modeli bez tool-calling-a (mali lokalni) | nema API podrške | „ReAct fallback": tražimo JSON oblik `{"tool":"name","args":{...}}` u tekstu, uz validator |

Interni `Tool` (ugovor iz `DECISIONS.md` §2):

```js
{
  name: 'hubspot.search_contact',
  description: 'Traži kontakt u HubSpot CRM-u po emailu ili imenu.',
  params: {                       // JSON Schema, bez $ref — provajderi ga ne vole
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email' },
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 }
    },
    additionalProperties: false
  },
  riskLevel: 'low',               // low | medium | high  (D15)
  scopes: ['crm:read'],           // šta alat smije nad podacima
  handler: async (args, ctx) => { /* ctx: { tenantId, agentId, runId, logger, signal } */ }
}
```

Petlja izvršavanja (jedan krug):

```
1. Pošalji messages + tools (samo oni koje politika dozvoljava za tenanta i agenta, D15).
2. Ako odgovor ima toolCalls:
   a. Za svaki poziv: validiraj args protiv JSON Schema (bez validacije -> alat ne ide dalje).
   b. Politika: allow/deny po imenu, allow/deny po scopes, riskLevel=high -> approval (D15).
   c. Ako je potrebno odobrenje -> zapis u approvals[], run pauzira, čeka POST /v1/approvals/:runId.
   d. Izvrši handler sa timeout-om; ulaz/izlaz/trajanje/greška idu u audit (D16).
   e. Rezultat vrati kao `role: "tool"` poruku (skraćeno na N bajtova, sa referencom na pun zapis).
3. Ponovi od 1 dok nema toolCalls ili dok se ne potroši maxSteps (default 8).
4. Pri svakom krugu provjeri budžet; pri svakom alatu provjeri rate limit.
```

Zamke koje se rješavaju odmah, ne poslije:

- **Argument koji nije JSON** → parse u try/catch, greška se vraća modelu kao `tool` rezultat
  (`{"error":"..."}`) da može da se ispravi, uz max 2 takva pokušaja.
- **Alat koji ne postoji** (model halucinira ime) → `{"error":"unknown_tool","available":[...]}`.
- **Beskonačna petlja alata** → `maxSteps` po patternu, tvrd prekid i `finishReason: "max_steps"`.
- **Veliki rezultat alata** → truncate + hash + pun zapis na disk; model dobija skraćenu verziju.
- **Paralelni tool-calls iz jednog odgovora** → izvršavaju se paralelno (`Promise.all`) samo ako
  su svi `riskLevel: low` i nemaju međuzavisnost; inače sekvencijalno.

---

## 4. Skladištenje

### 4.1 MVP — fajl-sistem (D7, D12)

```
data/
  tenants/
    <tenantId>/
      config.json                 # ime, jezik, plan, budžet, dozvoljeni alati (bez tajni!)
      agents.json                 # override agenata za ovaj tenant
      sessions/
        <sessionId>.jsonl         # append-only: user/assistant/tool poruke
      longterm/
        events.jsonl              # append-only: činjenice, odluke, ishodi
      vectors/
        vectors.jsonl             # {id, text, metadata, embedding[]}
      audit/
        2026-09.jsonl             # hash-chained audit (D16)
      traces/
        <runId>.jsonl             # spanovi: llm, tool, pattern, approval
      costs/
        2026-09.json                # agregat po danu/agentu/modelu
      cache/
        <sha256>.json             # keš LLM odgovora i HTTP GET-ova
  _global/
    tenants.json                  # registar tenanta (id, plan, status)
    pricing.json                  # tabela cijena modela
```

Pravila:

- **JSONL je append-only.** Nikad se ne prepisuje istorija; ispravka je novi red (`type: "correction"`).
- **Atomski write** za JSON fajlove: piši u `.tmp` pa `fs.rename` (rename je atomski na istom FS-u).
- **`data/` je u `.gitignore`** (D12 + zamka iz §5 `DECISIONS.md`).
- Svaki put kad se čita tuđi tenant — nemoguće je konstruisati putanju bez `tenantId`, jer sve
  funkcije primaju `tenantId` kao prvi argument (D11). Dodatno: validacija `tenantId` regexom
  `^[a-z0-9][a-z0-9_-]{1,31}$` (sprječava `../`).
- Rotacija: mjesečni fajlovi za audit/traces/costs; stari se arhiviraju (`data/_archive/YYYY-MM/`).
- Backup: postojeći restic (dnevno 04:00, AES-256) već pokriva `E:\NMQ-PROGRAMI`; za server se
  dodaje `data/` u restic set. Prije svakog deploy-a ručni `cp -r data/ data.bak-$(date +%F)`.

### 4.2 Produkcija — PostgreSQL 16 + pgvector + Redis (D8)

Tabela: šta ide gdje i zašto.

| Podatak | MVP (fajl) | Produkcija | Zašto tu |
|---|---|---|---|
| Tenant config | `tenants/<id>/config.json` | `tenants` (PG) | Mijenja se retko, ali se čita na svakom zahtjevu → keš u Redis-u |
| Sesije (kratkoročno) | `sessions/<id>.jsonl` | **Redis** (TTL) + `messages` (PG) | Redis za brzo čitanje zadnjih N poruka; PG za istoriju i analitiku |
| Duga memorija (činjenice) | `longterm/events.jsonl` | `events` (PG, JSONB) | Pretraga po metapodacima, join sa tenantom, RLS |
| Vektori | `vectors/vectors.jsonl` | `embeddings` (PG + pgvector) | Isti upit filtrira tenant i radi ANN |
| Audit log | `audit/YYYY-MM.jsonl` | `audit_log` (PG, append-only, hash chain) | Ne smije se mijenjati; RLS + `REVOKE UPDATE/DELETE` |
| Trace / spanovi | `traces/<runId>.jsonl` | `spans` (PG) + `traces` | Analitika po run-u, debug u produkciji |
| Cost | `costs/YYYY-MM.json` | `cost_ledger` (PG, particionisano po mjesecu) | Fakturisanje; agregati su upiti, ne prepisivanje |
| Rate limit / brojači | in-memory Map | **Redis** (`INCR` + `EXPIRE`) | Atomarno i dijeljeno između procesa |
| Queue (webhook, dugi taskovi) | in-memory | **Redis** (Streams/List) | Preživi restart; jedan worker pattern |
| Tajne tenanta (OAuth tokeni) | **nikad u `data/`** | `tenant_secrets` (PG, AES-256-GCM) | Enkripcija u aplikaciji, ključ van baze (§8) |
| Keš LLM/HTTP | `cache/<sha>.json` | Redis (+ opciono PG za trajni keš) | Jeftinije i brže od diska |

Minimalna šema (skraćeno, bez indeksa koji nisu nosivi):

```sql
-- Tenants
CREATE TABLE tenants (
  tenant_id   text PRIMARY KEY,
  name        text NOT NULL,
  plan        text NOT NULL DEFAULT 'trial',
  status      text NOT NULL DEFAULT 'active',   -- active | suspended | deleted
  budget_usd  numeric(12,4),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Sesije i poruke
CREATE TABLE sessions (
  tenant_id  text NOT NULL REFERENCES tenants(tenant_id),
  session_id text NOT NULL,
  agent_id   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, session_id)
);

CREATE TABLE messages (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  session_id  text NOT NULL,
  role        text NOT NULL,        -- user | assistant | tool | system
  content     jsonb NOT NULL,
  tokens_in   integer,
  tokens_out  integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_tenant_session_created_idx
  ON messages (tenant_id, session_id, created_at DESC);

-- Duga memorija
CREATE TABLE events (
  id         bigserial PRIMARY KEY,
  tenant_id  text NOT NULL,
  kind       text NOT NULL,         -- fact | decision | outcome | note
  text       text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_tenant_created_idx ON events (tenant_id, created_at DESC);
CREATE INDEX events_metadata_gin_idx  ON events USING gin (metadata jsonb_path_ops);

-- Vektori (pgvector)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE embeddings (
  id         bigserial PRIMARY KEY,
  tenant_id  text NOT NULL,
  source_id  text,                  -- veza na events.id / doc id
  chunk_no   integer NOT NULL DEFAULT 0,
  text       text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding  vector(1536),          -- dimenzija = dimenzija embedder-a (vidi §5.1)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX embeddings_tenant_idx ON embeddings (tenant_id);

-- Cost ledger (particionisanje po mjesecu)
CREATE TABLE cost_ledger (
  id          bigserial,
  tenant_id   text NOT NULL,
  agent_id    text,
  provider    text NOT NULL,
  model       text NOT NULL,
  tokens_in   integer NOT NULL DEFAULT 0,
  tokens_out  integer NOT NULL DEFAULT 0,
  usd         numeric(12,6),        -- NULL ako cijena nije poznata (nikad izmišljena)
  run_id      text,
  created_at  timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);
```

### 4.3 RLS politika (izolacija tenanta na nivou reda)

Princip: aplikacija se prema bazi predstavlja kao **jedan** korisnik, ali prije svakog upita
postavlja `app.tenant_id`; RLS odbija sve što nije tog tenanta. Time greška u `WHERE` klauzuli
ne znači curenje podataka.

```sql
-- 1) Rola aplikacije NIJE vlasnik tabela i NEMA BYPASSRLS
CREATE ROLE nmq_app LOGIN PASSWORD 'PROVJERITI-U-STORE' NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO nmq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nmq_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nmq_app;

-- 2) Uključi RLS na svakoj tenant tabeli
ALTER TABLE messages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages    FORCE  ROW LEVEL SECURITY;   -- važi i za vlasnika tabele
ALTER TABLE events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE events      FORCE  ROW LEVEL SECURITY;
ALTER TABLE embeddings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE embeddings  FORCE  ROW LEVEL SECURITY;
ALTER TABLE cost_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_ledger FORCE  ROW LEVEL SECURITY;

-- 3) Jedna politika po tabeli (primer za events; isto za ostale)
CREATE POLICY events_tenant_isolation ON events
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- 4) Aplikacija prije svakog upita (u istoj transakciji!)
BEGIN;
SELECT set_config('app.tenant_id', $1, true);   -- true = lokalno za transakciju
SELECT id, text, created_at FROM events ORDER BY created_at DESC LIMIT 20;
COMMIT;
```

Pravila koja se moraju držati (inače RLS ne štiti):

1. `set_config(..., true)` je **lokalno za transakciju** — pooling (PgBouncer) onda ne može da
   „pomiješa" tenant-e između zahtjeva. Bez `true` postoji realan rizik curenja.
2. Rola aplikacije **ne smije** biti vlasnik tabela (vlasnik zaobilazi RLS osim uz `FORCE`).
3. `current_setting('app.tenant_id', true)` — drugi argument `true` sprječava grešku kad vrijednost
   nije postavljena; tada `tenant_id = NULL` → nijedan red nije vidljiv (fail-closed).
4. Test izolacije je **obavezan** (D17): dva tenanta, isti upit, provjera da B ne vidi ništa od A.
5. Tajne tenanta idu u odvojenu tabelu `tenant_secrets` sa **istom** RLS politikom i dodatnom
   enkripcijom na nivou aplikacije (§8) — RLS nije zamjena za enkripciju.

---

## 5. Vektorska memorija i embeddings

### 5.1 Interfejs (D9) i dimenzije

```js
// isti interfejs za brute-force, pgvector i Qdrant
vector.upsert(tenantId, { id, text, metadata, embedding? })
vector.query(tenantId, { text | embedding, k, filter })
```

| Embedder | Dimenzija | Kada se koristi | Napomena |
|---|---|---|---|
| `hash-embedder` (ugrađen) | 256 (podrazumijevano, podesivo) | Testovi, offline demo, smoke na Hostingeru | Deterministčki bag-of-words hash; nema semantike — samo za funkcionalne testove, ne za kvalitet pretrage |
| `openai-compatible` (`text-embedding-3-small` i sl.) | provjeriti (tipično 1536) | Produkcija | Dimenzija se **zaključava u konfiguraciji**; promjena dimenzije = nova kolekcija + reindeksiranje |
| Ollama embedder (`OLLAMA_EMBED_MODEL`) | provjeriti | Lokalno, bez troška | Provjeriti dostupnost modela na serveru |
| Gemini / OpenAI alternativni | provjeriti | Ako primarni padne | Isti interfejs, druga `dim` |

Pravila:

- **Dimenzija je fiksirana i provjerava se pri upisu**: ako `embedding.length !== config.dim` →
  greška, ne tihi truncate.
- **Normalizacija na L2** pri upisu i upitu — tada je cosine == dot product, računanje je brže.
- Ako je embedding već izračunat, ne računa se ponovo (`embedding?` u `upsert`).
- Vektori se **nikad ne šalju** u LLM kontekst; LLM dobija samo tekst i metapodatke.

### 5.2 Implementacije

**Faza 1 — brute-force cosine (radi odmah):**

```js
// src/memory/vector.js (suština)
function cosine(a, b) {            // a i b su L2-normalizovani
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
// pretraga: filtriraj po tenantId + metadata filter, pa linearno ocijeni, pa top-k
```

**Faza 2 — pgvector (isti interfejs):**

```sql
SET LOCAL hnsw.ef_search = 100;
SELECT id, text, metadata,
       1 - (embedding <=> $1::vector) AS score
FROM embeddings
WHERE tenant_id = current_setting('app.tenant_id', true)
  AND ($2::jsonb IS NULL OR metadata @> $2::jsonb)
ORDER BY embedding <=> $1::vector
LIMIT $3;
```

- Indeks: HNSW (`vector_cosine_ops`) za brzinu uz dobar recall; IVFFlat ako je gradivo predugo ili
  memorija uska. Parametre (`m`, `ef_construction`) tuningovati na stvarnim podacima, ne napamet.
- Uvijek `WHERE tenant_id = ...` — ANN indeks ne poznaje RLS, RLS filtrira **poslije** i može da
  vrati manje od `k`. Zato se u praksi traži `k * 3` pa filtrira, ili se radi **particija po tenantu**
  za velike tenant-e.

**Faza 3 — Qdrant** samo ako: > ~10⁷ vektora ukupno, potrebna je kolekcija po tenantu sa
nezavisnim skaliranjem, ili pgvector na Hetzneru počne da guši PG (CPU/RAM). Migracija je
`export → upsert → verifikacija broja i spot-check top-k → prebacivanje `VECTOR_BACKEND``.

### 5.3 Chunking

| Parametar | Podrazumijevano | Raspon | Zašto |
|---|---|---|---|
| Ciljna veličina chunka | 800 znakova | 400–1200 | Kompromis: dovoljno konteksta, a da top-3 stane u prompt |
| Preklapanje (overlap) | 120 znakova (15%) | 10–20% | Sprječava da odgovor bude tačno na granici i time izgubljen |
| Jedinica rezanja | granica pasusa → rečenice | – | Nikad ne sijeci nasred rečenice; prvo `\n\n`, pa `. `, pa tvrdi rez |
| Metapodaci po chunku | `source_id, chunk_no, chunks_total, path/title, lang, created_at, tenant_id` | – | `chunk_no` omogućava „daj i susjedne chunkove" (proširenje konteksta) |
| Minimum | 50 znakova | – | Kratki ostaci se spajaju sa prethodnim chunkom |
| Kod / tabele | po logičkoj cjelini | – | Kod se ne dijeli po znakovima nego po funkciji/bloku |

Dedup prije upisa: `sha256(normalizovan tekst)` — isti chunk se ne upisuje dvaput u istu kolekciju.
Reindeksiranje: promjena chunking parametara ili embedder-a → nova verzija kolekcije
(`vectors_v2`), nikad „u mjestu", da stara pretraga nastavi da radi dok se ne završi.

### 5.4 Metadata filter

Filter je **JSONB containment** (`@>`) ili eksplicitni `WHERE` — isti semantički jezik na svim
backend-ima:

```js
await vector.query(tenantId, {
  text: 'kolika je bila ponuda za klijenta X',
  k: 5,
  filter: {
    kind: 'quote',                    // tip dokumenta/činjenice
    lang: 'sr',
    source_id: { in: ['doc_17', 'doc_22'] },   // opciono: ograniči na dokumente
    created_at: { gte: '2026-01-01' }
  }
});
```

Mapiranje filtera:

| Operator | Brute-force | pgvector | Qdrant |
|---|---|---|---|
| `eq` | `===` | `metadata @> '{"k":v}'` | `must: match` |
| `in` | `includes` | `metadata -> 'k' ?| array[...]` | `must: match any` |
| `gte/lte` | poređenje | `(metadata->>'k')::timestamptz >= ...` | `range` |
| `and/or` | logičke operacije | `AND`/`OR` sa zagradama | `must`/`should` |

**Kad se prelazi sa brute-force na pgvector** — pragovi (izmjeri prije odluke):

```
- broj vektora po tenantu > 20.000, ILI
- ukupno > 100.000, ILI
- p95 latencija query-ja > 150 ms na produkcijskom hardveru, ILI
- memorija procesa > 512 MB samo zbog vektora.
Mjeriti: skripta koja ubaci N vektora i izmjeri p50/p95 za k=5 (bez mreže, samo računanje).
```

---

## 6. Frontend

### 6.1 Embed widget — jedan fajl (D4)

```
public/widget/nmq-robot.js        # sve: stilovi, logika, transport; bez zavisnosti, bez build-a
```

Ugradnja na bilo koji sajt:

```html
<script>
  window.NMQ_ROBOT_CONFIG = {
    endpoint: 'https://robot.nomorequiet.com',
    tenantId: 'nomorequiet',
    agentId: 'support',
    locale: 'sr',
    theme: { accent: '#e11d48', position: 'bottom-right' },
    greeting: 'Zdravo! Kako mogu da pomognem?'
  };
</script>
<script src="https://robot.nomorequiet.com/widget/nmq-robot.js?v=0.1.0" defer></script>
```

Zahtjevi na widget:

| Zahtjev | Rješenje | Zašto |
|---|---|---|
| Ne smije da pokvari sajt | **Shadow DOM** (`attachShadow({ mode: 'open' })`) | CSS sajta ne ulazi unutra, naš CSS ne izlazi napolje |
| Ne smije da blokira render | `<script defer>` + lazy init na prvi klik | Nema uticaja na Core Web Vitals |
| Bez build koraka | Jedan IIFE/ESM fajl, `?v=` version bust | Zamka sa kešom (Hostinger/CDN) iz `DECISIONS.md` §5 |
| Streaming | `fetch` + `ReadableStream` (POST) ili `EventSource` (GET) | POST je bolji za dugačke poruke; `EventSource` ne podržava POST → koristi se fetch-stream sa SSE parserom |
| Bez ključa u browseru | Widget šalje samo `tenantId` + `agentId` (+ opcioni kratkotrajni `visitorToken`) | API ključ tenanta nikad ne ide u HTML |
| Sigurnost | `Content-Security-Policy` kompatibilno, bez `eval`, bez inline stila van Shadow DOM-a | Radi na sajtovima sa strogim CSP-om |
| Pristupačnost | `role="dialog"`, focus trap, Esc zatvara, `aria-live` za tokene | Osnovni nivo je obavezan, ne „nice to have" |
| Otpornost | Ako endpoint padne → poruka i link na email; nikad prazan prozor | Tihi neuspjeh je najgora varijanta |

### 6.2 SDK

`public/sdk/nmq-robot-sdk.js` (takođe jedan fajl) — za serverske i interne integracije:

```js
const nmq = createNmq({ endpoint, tenantId, apiKey /* serverski, iz store-a */ });
await nmq.run('support', { input: '...' });          // -> { output, steps, usage, cost }
for await (const ev of nmq.stream('support', { input: '...' })) { /* token|step|tool|done */ }
await nmq.approve(runId, { decision: 'approve', note: '...' });
```

Ugovor SDK-a = ugovor REST API-ja iz `DECISIONS.md` §2. SDK ne uvodi svoj protokol; to je tanak
omotač oko `fetch`-a sa retry-jem i tipiziranim greškama.

### 6.3 Dashboard

Next.js dashboard je **opciono i kasnije** (§10, faza 6):

- Prikaz: run-ovi i trace, cost po tenantu/agentu/modelu, usage graf, lista odobrenja (`high` rizik),
  editor politika, lista MCP servera i status konekcija, audit log pretraga.
- Do tada: `GET /metrics` (Prometheus tekst) + `GET /v1/runs/:runId` + mali HTML iz `node:http`.
- Razlog odlaganja: dashboard je UI nad podacima koji već postoje; njegovo prijevremeno pisanje
  odlaže jedinu stvar koja donosi prihod — da robot radi posao.

---

## 7. Infrastruktura

### 7.1 Gdje šta živi

| Okruženje | Hardver | Šta hostuje | Zašto tu |
|---|---|---|---|
| **Primarno** | Hetzner VPS, Finska (`nmq-server`, `root@62.238.35.78`) | NMQ Robot API, Docker compose (api + postgres/pgvector + redis), Cloudflare tunnel | Pun Docker, stalni procesi, queue, baze; jeftin i blizu EU korisnika |
| **Lagani tenant** | Hostinger shared (`u972051764@82.25.83.80`) | Widget statika + lagani API za pojedinačne sajtove (Passenger, `touch tmp/restart.txt`) | Već postoji za 9 domena; nema Docker-a → samo fajl-skladište i mali obim |
| **Lokalno (dev)** | Windows radna stanica | `node scripts/serve.mjs` + `node --test` | Bez mreže i bez ključa (mock provider + hash-embedder) |
| **Tunel** | `cloudflared` | Ulaz sa interneta bez otvorenog porta | Isto kao postojeći `cloudflared` na VPS-u |
| **Backup** | Hetzner `/opt/backup/restic` + USB `F:\DSH-BACKUP` | restic, dnevno 04:00, AES-256 | Postojeći backup; `data/` se dodaje u set |

### 7.2 Docker + compose

```yaml
# infra/docker-compose.yml (skica)
services:
  api:
    build: { context: .., dockerfile: infra/Dockerfile }
    environment:
      - NMQ_ENV=production
      - NMQ_DATA_DIR=/data
      - PG_HOST=postgres
      - REDIS_URL=redis://redis:6379/0
    env_file: [ ../.env ]          # .env NIJE u git-u
    volumes: [ nmq-data:/data ]
    ports: [ "127.0.0.1:8787:8787" ]   # samo lokalno; spolja ide Cloudflare tunnel
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "scripts/healthcheck.mjs"]
      interval: 30s

  postgres:
    image: pgvector/pgvector:pg16     # tag provjeriti prije upotrebe
    environment:
      - POSTGRES_DB=nmq_robot
      - POSTGRES_USER=nmq_app
      - POSTGRES_PASSWORD_FILE=/run/secrets/pg_password
    volumes: [ pg-data:/var/lib/postgresql/data ]
    restart: unless-stopped

  redis:
    image: redis:7-alpine             # tag provjeriti prije upotrebe
    command: ["redis-server", "--appendonly", "yes", "--maxmemory-policy", "noeviction"]
    volumes: [ redis-data:/data ]
    restart: unless-stopped

volumes: { nmq-data: {}, pg-data: {}, redis-data: {} }
```

Napomene: `--maxmemory-policy noeviction` jer Redis drži rate-limit brojače i queue — nikad ih se
ne smije tiho izgubiti. Lozinke kroz Docker secrets, ne kroz `environment` (env se vidi u
`docker inspect`).

### 7.3 systemd

```ini
# infra/nmq-robot.service
[Unit]
Description=NMQ Robot API
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/nmq-robot
ExecStart=/usr/bin/docker compose -f infra/docker-compose.yml up
ExecStop=/usr/bin/docker compose -f infra/docker-compose.yml down
Restart=always
RestartSec=5
EnvironmentFile=/opt/nmq-robot/.env

[Install]
WantedBy=multi-user.target
```

Operacije:

```bash
systemctl daemon-reload && systemctl enable --now nmq-robot
systemctl status nmq-robot
journalctl -u nmq-robot -f --since "10 min ago"
docker compose -f infra/docker-compose.yml ps
```

### 7.4 Cloudflare tunnel

```bash
cloudflared tunnel list
cloudflared tunnel route dns nmq-robot robot.nomorequiet.com
# config.yml (skica)
# tunnel: <TUNNEL_ID>            # ID čitati iz cloudflared, ne prepisivati ručno
# credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
# ingress:
#   - hostname: robot.nomorequiet.com
#     service: http://127.0.0.1:8787
#   - service: http_status:404
```

Pravila: Cloudflare uključen **samo** kao tunel + TLS + rate limit; SSE mora da radi → provjeriti
da nije uključena opcija koja baferuje ili „optimizuje" odgovore; `Cache-Control: no-store` na
API rutama; nikad ne keširati odgovore agenta na ivici.

### 7.5 Deploy procedura (skraćeno, po zamkama iz `DECISIONS.md` §5)

```
1. Backup: restic snapshot + `cp -r /opt/nmq-robot/data /opt/nmq-robot/data.bak-$(date +%F)`.
2. Provjera: `git status` (nema .env), `node --test` prolazi lokalno.
3. Kod: git pull na VPS (ili rsync), pa `docker compose build api`.
4. Migracije (ako ih ima): `psql -f infra/migrations/NNN_*.sql` — prije `up`.
5. `docker compose up -d`, pa `curl -fsS localhost:8787/healthz` i `/readyz`.
6. Smoke protiv živog: `node scripts/smoke.mjs` (healthz, agents, jedan run, jedan tool).
7. Statika: `?v=` bump za widget; `Cache-Control: no-cache` (zamka sa kešom).
8. Ako nešto ne radi: `docker compose logs --tail=200 api` → rollback na prethodni image tag.
```

### 7.6 Backup i restore

| Šta | Kako | Gdje | Dokaz da radi |
|---|---|---|---|
| `data/` (fajl-skladište) | restic snapshot (postojeći, 04:00) | Hetzner `/opt/backup/restic` + `F:\DSH-BACKUP` | `restic snapshots`, pa test restore u temp folder |
| Postgres | `pg_dump -Fc` prije deploy-a + dnevno | isto | `pg_restore --list dump` prolazi |
| Redis | AOF (`appendonly yes`) + `BGREWRITEAOF` | Docker volume | restart Redis-a i provjera da brojači nisu izgubljeni |
| Ključevi (store) | van `data/`, van gita | DSH store / `.credentials.yaml` (već u backup setu) | `get-key.mjs --has <IME>` |
| Restore vježba | 1× kvartalno, u temp okruženje | – | Zapis u `docs/` sa datumom i ishodom |

`RESTIC_PASSWORD` je u DSH store-u — **nikad** se ne upisuje u repo, skriptu ni u `docker-compose`.

---

## 8. Okruženja i tajne

### 8.1 Pravila (bez izuzetka)

1. **`.env` NIJE u git-u.** Prvi fajl u repozitoriju je `.gitignore` sa `.env`, `data/`,
   `node_modules/`, `*.bak*`, `*.log`. Provjera prije svakog commit-a: `git status --short`.
2. **Vrijednost ključa se nikad ne ispisuje** — ni u chat, ni u log, ni u trace, ni u error poruku.
   U izvještaju se piše samo ime ključa i „postavljen".
3. **Ključ se čita iz DSH store-a po imenu:**

```bash
node C:\Users\Administrator\.dsh\NMQ\get-key.mjs DEEPSEEK_API_KEY     # ispisuje vrijednost
node C:\Users\Administrator\.dsh\NMQ\get-key.mjs --has DEEPSEEK_API_KEY   # da/ne (bez vrijednosti)
node C:\Users\Administrator\.dsh\NMQ\get-key.mjs --search hostinger       # pretraga po imenu
node C:\Users\Administrator\.dsh\NMQ\get-key.mjs --list                   # imena svih ključeva
```

4. U kodu se ključ dobija **samo** kroz loader koji prima ime (`apiKeyRef`), nikad direktno iz
   `process.env` na mjestu upotrebe — jedan ulaz, jedan audit, jedna tačka za rotaciju.
5. **Maskiranje u logu**: ako se vrijednost ipak nađe u stringu (npr. URL sa tokenom), logger je
   mora zamijeniti `***` prije ispisa (`redactSecrets()` u `src/core/logger.js`).
6. Na serveru (`Hetzner`) ključevi se drže u `/opt/nmq-robot/.env` sa `chmod 600`, vlasnik root,
   i **nikad** ne ulaze u Docker image (samo `env_file`, nikad `COPY .env`).

### 8.2 Tabela potrebnih ključeva (samo imena)

| Ime ključa | Za šta | Gdje se koristi | Status u DSH store-u |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | Primarni LLM | LLM adapter, `apiKeyRef` | postoji |
| `DEEPSEEK_MODEL` | Podrazumijevani model | config | postoji |
| `OPENAI_API_KEY` | Fallback LLM + embeddings | LLM + vector | postoji |
| `OPENAI_MODEL` | Model za fallback | config | postoji |
| `GROQ_API_KEY` | Brzi fallback LLM | LLM | provjeriti (`--has`) |
| `OPENROUTER_API_KEY` | Katalog modela | LLM | provjeriti (`--has`) |
| `ANTHROPIC_API_KEY` | Alternativni provajder | LLM | postoji |
| `GEMINI_API_KEY` | Alternativni provajder / embeddings | LLM | postoji |
| `OLLAMA_HOST` / `OLLAMA_URL` | Lokalni LLM bez troška | LLM | postoji |
| `OLLAMA_EMBED_MODEL` | Lokalni embeddings | vector | postoji |
| `NMQ_TENANT_KEK` | **Ključ za AES-256-GCM** enkripciju tajni tenanta (§5 u `03`) | `src/tenancy/crypto.js` | provjeriti / kreirati |
| `NMQ_ADMIN_TOKEN` | Zaštita `/v1/tenants/*` i approval ruta | server | provjeriti / kreirati |
| `PG_HOST` `PG_PORT` `PG_USER` `PG_PASSWORD` `PG_DATABASE` | Postgres (faza 2) | `src/tenancy/pg.js` | postoji (provjeriti da su za NMQ Robot bazu, ne za neku drugu) |
| `REDIS_URL` / `REDIS_ENABLED` | Redis (faza 3) | rate limit, queue, sesije | postoji |
| `CLOUDFLARE_API_TOKEN` `CLOUDFLARE_ACCOUNT_ID` | Tunel, DNS | infra | postoji |
| `RESTIC_PASSWORD` `RESTIC_REPOSITORY` | Backup | infra | postoji |
| `SLACK_BOT_TOKEN` | Slack MCP (talas 1) | MCP server | postoji |
| `GITHUB_TOKEN` / `GITHUB_PERSONAL_ACCESS_TOKEN` | GitHub MCP (talas 1) | MCP server | postoji |
| `NOTION_API_KEY` | Notion MCP | MCP server | provjeriti (`--has`) |
| `JIRA_*` / `ATLASSIAN_*` | Jira MCP | MCP server | provjeriti |
| `HUBSPOT_*` (ili `PIPEDRIVE_*`) | CRM MCP | MCP server | provjeriti |
| `STRIPE_API_KEY` `STRIPE_WEBHOOK_SECRET` | Stripe MCP + webhook | MCP server | postoji |
| `SHOPIFY_API_KEY` | Shopify MCP | MCP server | postoji |
| `GOOGLE_CLIENT_ID` / `GOOGLE_PRIVATE_KEY` / `GOOGLE_SERVICE_ACCOUNT_JSON` | Gmail/Calendar/Drive (service account ili OAuth) | MCP server | postoji |
| `HOSTINGER_API_TOKEN` `HOSTINGER_SSH_*` | Deploy laganog tenanta | infra | postoji |
| `VPS_IP` `VPS_USER` `VPS_SSH_KEY` `VPS_APP_PATH` `VPS_SERVICE` | Deploy na Hetzner | infra | postoji |
| `SENDGRID_API_KEY` | Slanje emaila (obavještenja/approvals) | alat | postoji |
| `TELEGRAM_BOT_TOKEN` `TELEGRAM_CHAT_ID` | Notifikacije o odobrenjima | alat | postoji |
| `AIRTABLE_API_KEY` `AIRTABLE_BASE_ID` | Interni NMQ CRM/Ticketing (alternativa) | interni MCP | postoji |

Kako se status provjerava (bez ispisivanja vrijednosti):

```bash
for k in DEEPSEEK_API_KEY OPENAI_API_KEY GROQ_API_KEY OPENROUTER_API_KEY \
         NOTION_API_KEY HUBSPOT_API_KEY NMQ_TENANT_KEK; do
  printf '%-28s ' "$k"
  node "C:\\Users\\Administrator\\.dsh\\NMQ\\get-key.mjs" --has "$k" 2>/dev/null || echo 'n/a'
done
```

---

## 9. Šta NE koristimo i zašto

| Ne koristimo | Zašto ne (u MVP-u) | Kada bi imalo smisla |
|---|---|---|
| **LangChain / LlamaIndex** | Ogroman broj tranzitivnih zavisnosti, brze breaking promjene, apstrakcije kriju tačan sadržaj prompta i troškove. Naš jezik je 6 patterna i jedan tool protokol — to je manje koda nego konfiguracija LangChain-a | Ako se pojavi potreba za desetinama retriever-a i vector store-ova istovremeno — i tada je vjerovatnije da ćemo napisati adapter |
| **CrewAI / AutoGen** | Role-play framework sa sopstvenim modelom agenta; mi imamo svoj (`config/agents/*.json`, D14) i svoj governance sloj (D15). Dvostruka kontrola znači dvostruka pravila i nemoguć audit | Ako se pokaže da nam treba gotov „multi-agent conversation" pattern koji ne umijemo bolje |
| **Python mikroservisi** | Zamka iz `DECISIONS.md` §5 — jedan runtime (Node). Python bi dodao drugi deploy, drugi `venv`, drugi healthcheck i dvije verzije iste logike | Za ML trening/embedding model koji se servira preko HTTP-a (vLLM/TEI) — tada kao **spoljni servis**, ne kao dio naše codebase |
| **NoSQL (MongoDB i sl.) bez potrebe** | Naši upiti su relacionog oblika (tenant → sesija → poruke; tenant → cost → model). JSONB u Postgresu pokriva fleksibilnost, a RLS daje izolaciju koju NoSQL ne daje besplatno | Ako se pojavi masovni append sa nepoznatom šemom (npr. sirovi webhook event log) — i tada vjerovatno Redis Streams ili JSONL |
| **Kubernetes u MVP-u** | Jedan VPS i jedan tenant sa 3 kontejnera se rješava `docker compose` + `systemd`. K8s dodaje control plane, YAML-e, resurse i način da se pokvari nešto što bi inače radilo | Kad ima ≥ 3-5 nodova, potreban autoscaling po tenantu, ili multi-region (§10 faza 6) |
| **Vector DB kao servis odmah** (Qdrant/Pinecone) | Do 10⁴–10⁵ vektora brute-force i pgvector su dovoljni; dodatni servis je dodatni trošak i tačka pada | Kad pgvector ne drži latenciju ili obim (§5.2, faza 3) |
| **GraphQL** | API ima 10-ak ruta i jedan klijent (naš widget/SDK); GraphQL bi dodao šemu, resolver-e i build | Ako se pojavi više nezavisnih klijenata sa različitim potrebama za podacima |
| **Kafka / RabbitMQ** | Za desetine hiljada poruka dnevno Redis Streams je više nego dovoljno | Ako dnevni obim pređe stotine hiljada poruka ili treba replay/retencija na nedjelje |
| **Vlastiti auth sistem za korisnike** | Nemamo korisnike, imamo tenant-e i API ključeve; OAuth je vezan za **integracije**, ne za naše korisnike | Ako dashboard postane višekorisnički (faza 6) — tada OIDC provider, ne ručno |

---

## 10. Migracioni put

Faze su **sekvencijalne i opcione**: svaka sljedeća se uvodi tek kad prethodna ima dokazano
opterećenje, ne zato što je „vrijeme". Svaka faza ima **okidač** (mjerljiv uslov) i **dokaz**.

| Faza | Šta se uvodi | Okidač (mjerljivo) | Kako se izvodi bez zastoja | Dokaz da je uspjelo |
|---|---|---|---|---|
| **0. Fajlovi** | JSONL/JSON + in-memory | – (MVP) | – | `npm test` prolazi offline; demo pokaže 6 patterna + 2 tenanta |
| **1. Fajlovi + struktura za migraciju** | Interfejsi (`SessionStore`, `LongtermStore`, `VectorStore`, `CostStore`) sa fajl implementacijom | Prvi plaćajući tenant | Sve store operacije idu kroz interfejs; nijedan agent ne zna gdje se čuva | Test koji pušta isti scenario kroz interfejs, bez znanja o backendu |
| **2. PostgreSQL 16** | `pg` klijent + `tenants/messages/events/audit_log/cost_ledger/spans` + RLS | > 3 aktivna tenanta, ILI > 1 GB `data/`, ILI potreba za izvještajem preko više tenanta, ILI dva procesa koja dijele podatke | Dvostruki upis (fajl + PG) kroz flag `STORAGE=dual`, pa jednokratni backfill skript (`scripts/migrate-files-to-pg.mjs`), pa prebacivanje | Test izolacije RLS (tenant B ne vidi A); `COUNT(*)` u PG == broj JSONL redova; cost agregat identičan |
| **3. Redis** | Rate limit, queue, sesije keš, `INCR` brojači | > 1 API instanca, ILI potreban rate limit između procesa, ILI restart gubi sesije koje korisnici primjećuju | Prvo samo rate limit i cache (ne izvor istine), pa queue, pa sesije | Uz dva procesa, limit se poštuje globalno; restart ne gubi naplaćene run-ove |
| **4. pgvector** | `embeddings` + HNSW/IVFFlat indeks, `VECTOR_BACKEND=pgvector` | Pragovi iz §5.4 (20k/100k vektora, p95 > 150 ms, RAM > 512 MB) | Reindeksiranje u novu tabelu (`embeddings_v2`) sa istim `source_id`; stara pretraga radi do prebacivanja | Spot-check: top-5 iz pgvector == top-5 brute-force za 20 uzoraka upita (uz dopušteno odstupanje na granici) |
| **5. Queue (Redis Streams → worker)** | Odvojen worker proces za webhook-ove, reindeksiranje, batch izvještaje | Webhook obrada traje > 5 s ili ih ima > 100/dan, ILI reindeksiranje blokira API | Consumer grupe, `XACK`, DLQ stream za neuspjele | Nijedan webhook nije izgubljen pri restartu API-ja; DLQ je prazan ili objašnjen |
| **6. Kubernetes (samo ako)** | K8s + HPA + secrets + ingress | ≥ 3-5 nodova, autoscaling po tenantu, multi-region, ili zahtjev enterprise kupca za izolovanim namespace-om | Prethodno: image je već isti (Docker), healthcheck postoji, config kroz env/secrets | Isti smoke prolazi u K8s; trošak infra ≤ prethodni + 30% uz jasnu korist |
| **7. (paralelno, opciono) Next.js dashboard** | UI nad postojećim podacima | > 3 tenanta koja traže sami da vide cost i odobrenja | Read-only rute ka istim store-ovima | Tenant sam nađe svoj cost bez našeg angažovanja |

Pravila migracije:

- **Nikad „flag day".** Svaka faza ima period dvostrukog rada (dual write ili dual read).
- **`tenantId` je svuda prvi argument** — to je ono što migraciju čini mehaničkom, a ne rizičnom.
- Migracije baze su numerisani `.sql` fajlovi u `infra/migrations/`, primijenjeni prije `up` (v. §7.5).
- **Rollback plan je dio migracije**: stari backend ostaje funkcionalan do potvrde (min. 7 dana).
- Svaka faza mijenja `DECISIONS.md` ako mijenja odluku (npr. `STORAGE` podrazumijevana vrijednost).

---

## Otvorena pitanja

1. **Primarni hosting za API**: da li NMQ Robot API ide na postojeći Hetzner `nmq-server`
   (dijeli VPS sa `nmq-server`, `oaa-trial`, `cloudflared`) ili na **novi** VPS? Dijeljenje je
   jeftinije, ali Postgres + Redis + LLM saobraćaj mogu da ugroze postojeće servise (RAM/CPU).
2. **Dimenzija i provajder embeddings-a**: ostajemo li na OpenAI `text-embedding-3-small`
   (dimenziju potvrditi i zaključati) ili idemo na lokalni Ollama embedder zbog troška i privatnosti
   podataka tenanta? Od toga zavisi šema (`vector(N)`) i da li je potreban GPU.
3. **Tabela cijena**: ko je odgovoran da jednom mjesečno provjeri cijene i upiše ih u
   `config/pricing.json` sa datumom? Bez toga cost izvještaj nije upotrebljiv za fakturisanje.
4. **Prvi plaćajući tenant i njegov obim**: koliko poruka/dan i koliko korisnika se očekuje u prvom
   mjesecu? To određuje da li faza 2 i 3 migracije idu odmah ili je fajl-skladište dovoljno dugo.
5. **Domen i brending**: da li API živi na `robot.nomorequiet.com`, `api.aicommandcenter.pro` ili
   novom domenu? Od toga zavisi Cloudflare tunel, CORS i CSP za widget.
6. **`NMQ_TENANT_KEK`**: kreiramo li novi ključ za enkripciju tajni tenanta i gdje se čuva njegova
   sigurnosna kopija (ako se izgubi — svi OAuth tokeni tenanta su nepovratno izgubljeni)?
