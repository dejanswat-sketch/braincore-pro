# 03 — MCP i integracije

> Izvedeno iz `docs/DECISIONS.md` (verzija 1.0). Ključne odluke u pozadini ovog dokumenta:
> **D5** (vlastiti JSON-RPC 2.0 MCP klijent: `stdio` + Streamable HTTP), **D11** (`tenant_id`
> obavezan u svakoj operaciji), **D15** (`riskLevel` + `scopes` + human-in-the-loop za `high`),
> **D16** (svaki tool poziv ide u audit log).
>
> Pravilo o tačnosti: imena polja MCP protokola i OAuth scope-ova se **provjeravaju** prije
> implementacije na zvaničnoj specifikaciji (`modelcontextprotocol.io`) odnosno dokumentaciji
> provajdera. Gdje u dokumentu piše „provjeriti" — to znači: ne oslanjaj se na ovaj tekst,
> otvori izvor i potvrdi. Nijedan scope u ovom dokumentu nije garantovan.

---

## 1. Kako MCP radi u NMQ Robotu

### 1.1 Protokol: JSON-RPC 2.0

MCP je **JSON-RPC 2.0** protokol (D5). Ne koristimo SDK — pišemo klijent, jer je protokol mali i
stabilan, a SDK verzije se mijenjaju brže od naše codebase.

Osnovni oblici poruka:

```json
// Zahtjev
{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": { "protocolVersion": "PROVJERITI", "capabilities": {}, "clientInfo": { "name": "nmq-robot", "version": "0.1.0" } } }

// Uspješan odgovor
{ "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "PROVJERITI",
  "capabilities": { "tools": { "listChanged": true } }, "serverInfo": { "name": "github-mcp", "version": "PROVJERITI" } } }

// Greška
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "Method not found", "data": {} } }

// Notifikacija (bez id, bez odgovora)
{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

Životni ciklus jedne MCP sesije, tačno ovim redom:

```
1. initialize                -> server vrati protocolVersion, capabilities, serverInfo
2. notifications/initialized -> notifikacija; od ovog trenutka server može da šalje notifikacije
3. tools/list                -> lista alata { name, description, inputSchema }
4. tools/call                -> { name, arguments } -> { content: [...], isError?: bool }
5. (zatvaranje)              -> stdio: kill procesa; HTTP: DELETE sesije ili istek sesije
```

Napomene koje se ne smiju preskočiti:

- **`protocolVersion` se ne pogađa.** Klijent pošalje svoju verziju, server odgovori **svojom**;
  ako se razlikuju, koristi se verzija servera i zabilježi upozorenje u trace. Ako server odbije
  verziju — konekcija je neispravna i alat se ne registruje.
- **`id` je uvijek broj koji raste** u okviru jedne konekcije; koristi se za uparivanje odgovora
  i za otkazivanje (`notifications/cancelled`) ako poziv prekorači timeout.
- **`isError: true` u `result`** nije JSON-RPC greška. To je alat koji je pravilno odgovorio
  „nisam uspio" — takav rezultat ide modelu kao sadržaj, a ne kao prekid.
- Sadržaj `tools/call` rezultata je **lista blokova** (`type: "text" | "image" | "resource"`);
  mi u LLM kontekst šaljemo tekst, a binarne stvari (screenshot, PDF) idu na disk + referenca.
  Kako tačno izgledaju tipovi blokova — **provjeriti u specifikaciji**.

### 1.2 Transporti

| Transport | Kako radi | Kada se koristi | Gdje živi kod |
|---|---|---|---|
| **stdio** | `child_process.spawn` servera; JSON-RPC poruke kao linije na `stdin`/`stdout`; `stderr` je log | Lokalni procesi, interni NMQ serveri, CLI alati (`npx` serveri) | `src/tools/mcp-stdio.js` |
| **Streamable HTTP** | `POST /mcp` sa JSON-RPC tijelom; odgovor je JSON ili SSE stream; sesija kroz `Mcp-Session-Id` header | Udaljeni/cloud MCP serveri (Slack, Notion, GitHub, HubSpot...) | `src/tools/mcp-http.js` |
| **SSE (legacy)** | Odvojen `GET /sse` za stream + `POST` za poruke | Samo ako server ne podržava Streamable HTTP; označiti kao „legacy" u config-u | `src/tools/mcp-http.js` (`mode: "sse"`) |

Zahtjevi na oba transporta (isti interfejs prema ostatku sistema):

```js
// src/tools/mcp-client.js — interfejs koji registry i agenti koriste
client.connect()                        // initialize + initialized
client.listTools()                      // -> [{ name, description, inputSchema }]
client.callTool(name, args, { signal }) // -> { content, isError, raw }
client.close()
client.on('notification', handler)      // tools/list_changed, progress, log
```

Detalji implementacije `stdio` koji se lako pogreše:

```
- spawn(node|cmd, args, { stdio: ['pipe','pipe','pipe'], env: sanitizovanoEnv })
- env: NE prosleđivati cijeli process.env; samo ono što alat traži + tenantId
  (inače MCP server vidi sve naše ključeve)
- poruke se odvajaju po newline; buffer ispravno hendluje poruku koja je stigla u dijelovima
- stderr se hvata u zaseban buffer i ide u naš log (inače se izgubi i debagovanje je nemoguće)
- restart politika: max 3 restarta u 60 s, pa alat ide u status "unhealthy" i politika ga blokira
- na `close()` šaljemo SIGTERM, pa SIGKILL posle 3 s (zombi procesi pojedu RAM VPS-a)
```

Za Streamable HTTP:

```
- jedan klijent po (tenantId, serverName) paru; sesija se NE dijeli između tenanta
- Authorization header nosi tenantov token (nikad naš); vidi §5
- odgovor koji je SSE stream se čita kao tok i mapira na iste event-e kao token stream
- mrežni timeout 30 s po pozivu, 3 retry-a na 5xx/429, bez retry-a na 4xx
- ako server vrati `Mcp-Session-Id` različit od prethodnog, stara sesija se odbacuje
```

### 1.3 Registracija MCP servera u `config/tools.json`

Konkretan primjer (miješa oba transporta + interni server + jedan onemogućen):

```json
{
  "$comment": "Registar MCP servera. Tajne se NIKAD ne upisuju ovdje — samo imena ključeva.",
  "servers": {
    "nmq-crm": {
      "transport": "stdio",
      "command": "node",
      "args": ["mcp/nmq-crm-server.mjs"],
      "env": { "NMQ_CRM_BASE": "http://127.0.0.1:8788", "NMQ_CRM_TOKEN_REF": "NMQ_ADMIN_TOKEN" },
      "enabled": true,
      "tenants": ["*"],
      "startupTimeoutMs": 8000,
      "toolPrefix": "nmq_crm"
    },
    "nmq-ticketing": {
      "transport": "stdio",
      "command": "node",
      "args": ["mcp/nmq-ticketing-server.mjs"],
      "enabled": true,
      "tenants": ["*"],
      "toolPrefix": "nmq_ticket"
    },
    "filesystem": {
      "transport": "stdio",
      "command": "node",
      "args": ["mcp/filesystem-server.mjs", "--root", "data/tenants"],
      "enabled": true,
      "tenants": ["*"],
      "toolPrefix": "fs",
      "$note": "root je data/tenants; server sam dodaje tenantId u putanju — alat ne može izaći iz svog foldera"
    },
    "github": {
      "transport": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "auth": { "kind": "bearer", "tokenRef": "GITHUB_PERSONAL_ACCESS_TOKEN" },
      "mode": "streamable-http",
      "enabled": true,
      "tenants": ["*"],
      "toolPrefix": "github",
      "riskOverrides": { "github.create_pull_request": "medium", "github.merge_pull_request": "high" }
    },
    "notion": {
      "transport": "http",
      "url": "PROVJERITI",
      "auth": { "kind": "oauth2", "provider": "notion", "perTenant": true },
      "mode": "streamable-http",
      "enabled": false,
      "tenants": ["nomorequiet", "aicommandcenter"],
      "toolPrefix": "notion",
      "$note": "url i auth se potvrđuju iz dokumentacije servera prije uključivanja"
    },
    "postgres-readonly": {
      "transport": "stdio",
      "command": "node",
      "args": ["mcp/postgres-server.mjs"],
      "env": { "PG_URL_REF": "NMQ_ROBOT_PG_READONLY_URL" },
      "enabled": true,
      "tenants": ["*"],
      "toolPrefix": "pg",
      "riskOverrides": { "pg.run_query": "high" },
      "guardrails": { "readOnly": true, "maxRows": 200, "statementTimeoutMs": 5000, "denyPatterns": ["\\b(insert|update|delete|drop|alter|truncate|grant)\\b"] }
    }
  },
  "policyDefaults": {
    "unknownServer": "disabled",
    "toolCallTimeoutMs": 30000,
    "maxResultBytes": 65536,
    "audit": true
  }
}
```

Pravila za ovaj fajl:

1. **Nikad tajna u `config/tools.json`** — samo `tokenRef` / `*_REF` imena, koja se razrješavaju
   kroz loader (§5), po tenantu.
2. `tenants: ["*"]` znači „svi aktivni tenanti"; eksplicitna lista je pravilo, ne preporuka.
3. `toolPrefix` sprječava koliziju imena (`github.create_issue` vs `jira.create_issue`).
4. `enabled: false` je legitiman način da se server drži u konfiguraciji a ne registruje.
5. `riskOverrides` postoje jer isti MCP server izlaže i čitanje i pisanje — rizik se ne smije
   zadavati na nivou servera.

### 1.4 Kako se MCP alat prevodi u interni `Tool`

Ugovor iz `DECISIONS.md` §2 je jedini ciljni oblik:

```js
tool = { name, description, params /* JSON Schema */, riskLevel: 'low'|'medium'|'high', scopes: [], handler(args, ctx) }
```

Mapiranje MCP → interni `Tool`:

| Interni `Tool` | Odakle dolazi | Ako ne postoji, default |
|---|---|---|
| `name` | `${toolPrefix}.${mcpTool.name}` | bez prefiksa se ne registruje (kolizija) |
| `description` | `mcpTool.description` | `"(bez opisa)"` + upozorenje u logu |
| `params` | `mcpTool.inputSchema` | ako nema šeme → alat se registruje kao **`high`** (model bez šeme halucinira argumente) |
| `riskLevel` | `config.riskOverrides[name]` → inače klasifikator (§1.5) | `medium` ako klasifikator ne odluči |
| `scopes` | `config.scopes[name]` → inače izvedeno iz imena (`get_*`/`list_*`/`search_*` → `:read`) | `[]` znači „nema dozvoljenih scope-ova" → alat je nedostupan dok se ne dodijeli |
| `handler` | adapter koji poziva `client.callTool(name, args, { signal })` | – |

Adapter (`mcp-client.js` → `registry.js`) mora da radi sljedeće, i to je cijela poenta sloja:

```js
function toInternalTool(server, mcpTool, cfg, ctx) {
  return {
    name: `${cfg.toolPrefix}.${mcpTool.name}`,
    description: mcpTool.description ?? '(bez opisa)',
    params: mcpTool.inputSchema ?? { type: 'object', additionalProperties: true },
    riskLevel: cfg.riskOverrides?.[`${cfg.toolPrefix}.${mcpTool.name}`] ?? classifyRisk(mcpTool.name),
    scopes: cfg.scopes?.[`${cfg.toolPrefix}.${mcpTool.name}`] ?? deriveScopes(mcpTool.name),
    source: { kind: 'mcp', server: server.name, transport: server.transport },
    handler: async (args, ctx) => {
      const started = Date.now();
      try {
        validate(args, mcpTool.inputSchema);                        // bez validacije -> ne ide dalje
        const res = await server.client.callTool(mcpTool.name, args, { signal: ctx.signal });
        ctx.audit.tool(ctx, { ok: true, ms: Date.now() - started, bytes: estimateBytes(res) });
        return normalizeContent(res);                               // content blokovi -> { text, attachments[] }
      } catch (err) {
        ctx.audit.tool(ctx, { ok: false, ms: Date.now() - started, error: err.code ?? err.name });
        throw new ToolError(err, { tool: mcpTool.name, server: server.name });
      }
    }
  };
}
```

Pet stvari zbog kojih ovaj sloj postoji (a ne da agent priča direktno sa MCP serverom):

1. **Jedinstvena validacija argumenata** — JSON Schema prije mreže, ne poslije.
2. **Jedinstvena politika** — allow/deny po alatu, `scopes`, `riskLevel` (D15).
3. **Jedinstveni audit** — svaki poziv, ulaz, izlaz, trajanje, greška (D16 + zamka iz `DECISIONS.md` §5).
4. **Jedinstveni timeout i prekid** — `AbortSignal` se propagira do transporta.
5. **Zamjena izvora** — ako MCP server padne, isti `Tool` može imati `builtin` implementaciju, a
   agenti i config se ne mijenjaju.

### 1.5 Klasifikacija rizika (kako se `riskLevel` ne pogađa)

```
low     → čitanje bez posljedica:  get_*, list_*, search_*, read_*, query (read-only), fetch (GET dozvoljen domen)
medium  → pisanje koje je lako poništiti ili je interno:  create_draft, update_field, add_label, post_message, create_task
high    → nepovratno, spolja vidljivo ili novac:  send_*, delete_*, merge_*, publish_*, refund, charge, transfer,
          deploy, cancel_subscription, bulk_* (preko N zapisa)
```

Nepoznato ime alata → **`medium`** (nikad `low`, jer bi tiho propustilo rizičnu operaciju).
`high` **uvijek** ide kroz odobrenje (D15): run se pauzira i čeka `POST /v1/approvals/:runId`
(odobrenje stiže preko dashboarda, Telegram notifikacije ili email-a).

---

## 2. Prioriteti integracija (talas 1/2/3)

- **Talas 1** = odmah: dokazuju da robot „radi", pokrivaju ≥ 80% internih NMQ procesa.
- **Talas 2** = za 1-2 mjeseca: širenje po vertikalama (enterprise, ecommerce, komunikacije).
- **Talas 3** = kasnije: infrastruktura, BI, vertikalni sistemi, HR/finansije.

Kolona „autentikacija" opisuje **tip**; tačna imena scope-ova i URL-ovi su u §3 (za talas 1) i
**provjeravaju se** prije implementacije.

| Alat | Kategorija | Transport | Autentikacija | riskLevel (najviši koji izlaže) | Use-case u robotu | Talas |
|---|---|---|---|---|---|---|
| **Gmail** | email | HTTP | OAuth 2.1 (per-tenant), scope-ovi provjeriti | high (`send`) | Podrška: pročitaj thread → odgovori → označi; sales: prati odgovore na ponude | 1 |
| **Google Calendar** | kalendar | HTTP | OAuth 2.1 (per-tenant) | medium (`create_event`) | Zakazivanje sastanaka iz razgovora; provjera slobodnih termina | 1 |
| **Slack** | komunikacija | HTTP | Bot token (per-tenant ili naš workspace) | medium (`post_message`) | Notifikacije o odobrenjima, interpolacija robota u tim, `/nmq` komande | 1 |
| **Notion** | dokumentacija | HTTP | OAuth 2.1 / internal integration token | medium (`update_page`) | Baza znanja za support agenta; pisanje sažetaka sastanaka | 1 |
| **GitHub** | dev | HTTP | Personal access token / GitHub App | high (`merge_pr`) | Dev agent: issue → branch → PR; pregled PR-ova; release notes | 1 |
| **Jira** | dev/ticketing | HTTP | OAuth 2.1 (3LO) / API token | medium (`transition_issue`) | Ops/dev: kreiranje i ažuriranje taskova iz razgovora i iz emaila | 1 |
| **HubSpot** (ili Pipedrive) | CRM | HTTP | OAuth 2.1 / private app token | medium (`create_note`) | Sales agent: nađi kontakt → kvalifikuj → upiši note → otvori deal | 1 |
| **PostgreSQL** | baza | stdio (naš server, read-only) | connection string / service (per-tenant) | high (`run_query`) | Data agent: „koliko narudžbi prošle nedjelje" → SQL → tabela | 1 |
| **Stripe** | plaćanja | HTTP | Restricted API key (per-tenant, read-first) | high (`refund`) | Finance/ops: status pretplate, dunning odgovori, izvještaj naplate | 1 |
| **Shopify** | ecommerce | HTTP | Admin API access token (per-tenant) | high (`update_order`) | Ecommerce agent: status narudžbe, tracking, povrat, opis proizvoda | 1 |
| **Google Drive / Docs** | dokumenti | HTTP | OAuth 2.1 / service account | medium (`create_doc`) | Uvoz dokumenata u vektorsku memoriju; generisanje ponuda i ugovora | 1 |
| **Filesystem (interni)** | fajlovi | stdio | bez auth (root po tenantu) | high (`delete`) | Rad sa fajlovima tenanta unutar `data/tenants/<id>/`; uvoz/izvoz | 1 |
| **HTTP fetch** | web | stdio (interni) | bez auth + allowlist domena | medium (`POST`) | Čitanje javnih stranica, provjera linkova, scraping sa dozvolom | 1 |
| **NMQ CRM (interni MCP)** | interni | stdio | interni token (`NMQ_ADMIN_TOKEN`) | medium | Nalozi, kontakt istorija, ponude — naš izvor istine za NMQ | 1 |
| **NMQ Ticketing (interni MCP)** | interni | stdio | interni token | medium | Tiketi, SLA, eskalacija — support agent radi u našem sistemu | 1 |
| Outlook / Teams | email/komunikacija | HTTP | OAuth 2.1 (Microsoft Graph) | high (`send`) | Enterprise tenanti koji nisu na Google-u | 2 |
| Salesforce | CRM | HTTP | OAuth 2.1 + Connected App | medium | Enterprise sales; zamjena HubSpot-a za velike klijente | 2 |
| Confluence | dokumentacija | HTTP | OAuth 2.1 / API token | medium | Baza znanja u enterprise okruženju | 2 |
| Linear | dev | HTTP | API key / OAuth | medium | Alternativa Jiri za moderne timove | 2 |
| ClickUp / Asana / Trello / Monday | task menadžment | HTTP | OAuth 2.1 / API token | medium | Taskovi kod klijenata koji ne koriste Jiru | 2 |
| BigQuery | data | HTTP | Service account (JSON) | medium (SQL) | Analitika nad velikim datasetima; read-only | 2 |
| Snowflake | data | HTTP | Key-pair / OAuth | medium (SQL) | Enterprise DWH; read-only uloga | 2 |
| Elasticsearch | data | HTTP | API key | medium | Pretraga logova i interne dokumentacije | 2 |
| Zendesk / Intercom / HelpScout | podrška | HTTP | OAuth 2.1 / API token | medium | Support agent u tuđem helpdesk-u (mi smo asistent, ne zamjena) | 2 |
| QuickBooks / Xero | finansije | HTTP | OAuth 2.1 | high (knjiženje) | Knjigovodstveni pregled, priprema faktura (uz odobrenje) | 2 |
| WooCommerce | ecommerce | HTTP | Consumer key/secret (per-tenant) | high | WordPress prodavnice | 2 |
| Figma | dizajn | HTTP | OAuth 2.1 / PAT | low (čitanje) | Dizajn agent: čitanje frame-ova, komentari | 2 |
| Canva | dizajn | HTTP | OAuth 2.1 | medium | Generisanje vizuala za marketing | 2 |
| WordPress / Webflow | web/CMS | HTTP | Application password / API token | high (publish) | Objava sadržaja; sadržaj agent | 2 |
| Cloudflare (Workers/D1/KV/R2) | infra | HTTP | API token (scoped) | high (deploy) | Deploy pomoćnih servisa, DNS, keš; infra agent | 2 |
| WhatsApp Cloud API | komunikacija | HTTP | Meta app token + phone number ID | high (send) | Korisnička podrška na WhatsApp-u (najkorišćeniji kanal u regionu) | 2 |
| Instagram DM | komunikacija | HTTP | Meta Graph API / page token | medium | Odgovori na DM, kvalifikacija lead-ova | 2 |
| Telegram | komunikacija | HTTP | Bot token | medium | Notifikacije (već imamo token) + bot interfejs za operatere | 2 |
| Twilio (voice) | komunikacija | HTTP | Account SID + auth token | high (call/SMS) | Telefonski agent, verifikacija, podsjetnici | 2 |
| Zoom / Google Meet transkript | sastanci | HTTP | OAuth 2.1 | low (čitanje) | Transkript sastanka → sažetak → akcije u taskove | 2 |
| AWS / GCP / Azure | infra | HTTP | IAM role / service account (scoped) | high | Infra agent: cost pregled, restart servisa (uz odobrenje) | 3 |
| Magento | ecommerce | HTTP | Integration token | high | Enterprise ecommerce | 3 |
| Looker / Tableau / Power BI | BI | HTTP | API token / service principal | low (čitanje) | Čitanje izvještaja u razgovoru | 3 |
| DINO-X (vision) | AI/vision | HTTP | API key | low | Detekcija i opis objekata na slikama; QA vizuelnih sadržaja | 3 |
| QA Sphere | testovi | HTTP | API key | medium | Test menadžment; dev agent čita i ažurira test slučajeve | 3 |
| DataWorks | data | HTTP | Access key (Alibaba) | medium | Ako se pojavi klijent na Alibaba stack-u | 3 |
| LinkedIn sourcing | HR/sales | HTTP | OAuth (ograničeno) | medium | Sourcing kandidata/lead-ova; **pravni rizik** — provjeriti ToS | 3 |
| HRIS (BambooHR i sl.) | HR | HTTP | API key | medium | HR agent: odsustva, onboarding checkliste | 3 |
| DocuSign | pravno | HTTP | OAuth 2.1 / JWT grant | high (potpisivanje) | Slanje na potpis; legal agent priprema i prati | 3 |

Redoslijed unutar talasa 1 (zašto baš tako): **interni MCP serveri + Filesystem + HTTP fetch** idu
prvi jer ne traže ni tuđi OAuth ni tuđu dokumentaciju i dokazuju cijeli lanac (politika → alat →
audit → memorija). Zatim **Gmail + Calendar + HubSpot/Pipedrive** (najveći broj internih procesa
odjednom). Zatim **Slack + Notion + GitHub + Jira** (timski rad). Na kraju **Stripe + Shopify +
PostgreSQL + Google Drive** (novac i podaci, traže `high` odobrenja i pažljivije politike).

---

## 3. Detalji talasa 1

Za svaku integraciju: alati, autentikacija, `scopes` + `riskLevel`, i **konkretan tok**.
Svi scope-ovi su **za provjeru** u dokumentaciji provajdera prije implementacije; ovdje je naveden
minimum koji posao traži, ne maksimum koji API nudi (princip najmanjih dozvola).

### 3.1 Gmail

| Alati (MCP imena) | Rizik | Opis |
|---|---|---|
| `gmail.search_messages` | low | Pretraga po `from:`, `subject:`, `newer_than:`, labelama |
| `gmail.get_message` | low | Puni sadržaj jedne poruke + thread |
| `gmail.list_threads` | low | Lista thread-ova po labeli/pošiljaocu |
| `gmail.create_draft` | medium | Pripremi odgovor kao draft (bez slanja) |
| `gmail.send_message` | high | Stvarno slanje (uvijek kroz odobrenje) |
| `gmail.modify_labels` | medium | Arhiviraj, označi kao pročitano, dodijeli labelu |
| `gmail.list_labels` | low | Orijentacija u strukturi mailbox-a |

- **Autentikacija:** OAuth 2.1 (per-tenant), offline pristup radi refresh tokena. Tip: „web server"
  flow sa `state` + PKCE; redirect ide na našu rutu `GET /v1/oauth/google/callback`.
- **Scopes (provjeriti tačna imena):** minimalno `.../auth/gmail.readonly` za čitanje,
  `.../auth/gmail.compose` za draftove, `.../auth/gmail.send` **samo** za tenante koji su izričito
  uključili slanje. `gmail.modify` umjesto `mail.google.com` (nikad puni pristup).
- **`scopes` u našem sistemu:** `email:read`, `email:draft`, `email:send` → politika po tenantu
  bira podskup.
- **Tok (support → sales):**
  ```
  1. Webhook /v1/hooks/email dobije novu poruku (ili agent radi cron pretragu "is:unread label:support").
  2. gmail.get_message -> tekst + pošiljalac.
  3. hubspot.search_contact(email) -> ako postoji nalog, uzmi istoriju; ako ne, hubspot.create_contact.
  4. Agent sastavi odgovor; gmail.create_draft (medium, bez odobrenja) -> čovjek pregleda u Gmailu.
  5. Ako je tenant uključio auto-send i rizik dozvoljen -> gmail.send_message (high) -> run pauzira,
     stiže notifikacija (Slack/Telegram), operater odobrava -> poruka odlazi.
  6. gmail.modify_labels: ukloni "support", dodaj "answered".
  7. hubspot.create_note: "Odgovoreno 2026-09-29, tema: reklamacija #4412".
  ```

### 3.2 Google Calendar

| Alati | Rizik | Opis |
|---|---|---|
| `gcal.list_calendars` | low | Koji kalendari postoje |
| `gcal.find_free_slots` | low | Slobodni termini u zadatom opsegu (radi preko freebusy) |
| `gcal.list_events` | low | Događaji u opsegu |
| `gcal.create_event` | medium | Novi događaj (opciono sa Google Meet linkom) |
| `gcal.update_event` | medium | Pomjeri/izmijeni |
| `gcal.delete_event` | high | Brisanje |
| `gcal.add_attendees` | medium | Dodaj učesnike i pošalji pozivnice |

- **Autentikacija:** isti Google OAuth klijent kao Gmail (`GOOGLE_CLIENT_ID`), per-tenant token.
- **Scopes (provjeriti):** `.../auth/calendar.events` (čitanje+pisanje događaja) — ne
  `calendar` (puni pristup uključujući dijeljenje i brisanje kalendara).
- **`scopes` kod nas:** `calendar:read`, `calendar:write`.
- **Tok:** `sales agent primi "možemo u četvrtak?"` → `gcal.find_free_slots(čet, 30min)` →
  predloži 2 termina u odgovoru → korisnik potvrdi → `gcal.create_event(attendees)` →
  `gmail.send_message` sa potvrdom (high → odobrenje). Sve u jednom `traceId`.

### 3.3 Slack

| Alati | Rizik | Opis |
|---|---|---|
| `slack.list_channels` | low | Kanali u workspace-u |
| `slack.read_history` | low | Zadnjih N poruka (samo kanali kojima je bot član) |
| `slack.search_messages` | low | Pretraga (ako je dozvoljeno na planu) |
| `slack.post_message` | medium | Objava u kanal/thread |
| `slack.reply_thread` | medium | Odgovor u thread-u |
| `slack.upload_file` | medium | Prilog (izvještaj, CSV) |
| `slack.open_modal` | low | Interaktivni obrazac za unos parametara |

- **Autentikacija:** bot token per workspace; jedan Slack app sa našim manifestom
  (bot scopes definisani aplikacijom, ne tenantom) + per-tenant instalacija. Za notifikacije
  NMQ koristi vlastiti `SLACK_BOT_TOKEN`.
- **Scopes (provjeriti):** `chat:write`, `channels:read`, `groups:read`, `commands`, `files:write`,
  `search:read` (search traži korisnički token — provjeriti).
- **`scopes` kod nas:** `slack:read`, `slack:write`.
- **Tok (odobrenja):** `high` alat u run-u → `slack.post_message` u kanal `#nmq-approvals` sa
  blokovima (dugmad **Odobri**/**Odbij**) → interakcija poziva `POST /v1/approvals/:runId` →
  run nastavlja. Alternativa za tenante bez Slack-a: Telegram ili email.

### 3.4 Notion

| Alati | Rizik | Opis |
|---|---|---|
| `notion.search` | low | Pretraga stranica i baza po naslovu/sadržaju |
| `notion.get_page` | low | Sadržaj stranice kao blokovi |
| `notion.query_database` | low | Upit nad bazom sa filterima |
| `notion.create_page` | medium | Nova stranica (npr. zapisnik) |
| `notion.append_blocks` | medium | Dopuna postojeće stranice |
| `notion.update_page_properties` | medium | Status, tags, owner |
| `notion.create_database_item` | medium | Novi red u bazi (lead, ticket) |

- **Autentikacija:** internal integration token (najprostije, jedan po tenantu) ili OAuth 2.1 ako
  želimo samostalnu instalaciju iz našeg dashboarda. Stranice/baze moraju biti **eksplicitno
  podijeljene** sa integracijom — inače 404 (najčešća greška).
- **`scopes` kod nas:** `docs:read`, `docs:write`.
- **Tok (baza znanja):** `notion.search("politika povrata")` → 3 stranice → chunk + `vector.upsert`
  u tenant namespace → sljedeći put support agent odgovara iz memorije bez poziva Notion API-ja
  (jeftinije i brže; osvježavanje 1×/dan ili na webhook `page.updated` ako postoji).

### 3.5 GitHub

| Alati | Rizik | Opis |
|---|---|---|
| `github.search_repos` / `github.get_repo` | low | Orijentacija u kod |
| `github.search_code` | low | Pretraga koda (radi samo na indeksiranim repo-ima) |
| `github.list_issues` / `github.get_issue` | low | Issue list i detalj |
| `github.create_issue` | medium | Novi issue iz razgovora/tiketa |
| `github.create_branch` | medium | Grana za fix |
| `github.create_or_update_file` | **high** | Commit — mijenja kod |
| `github.create_pull_request` | medium | PR (bez merge-a) |
| `github.merge_pull_request` | **high** | Merge (uvijek odobrenje) |

- **Autentikacija:** fine-grained Personal Access Token po repozitoriju (per-tenant) ili GitHub App
  (bolje dugoročno: instalacija po organizaciji, kraći tokeni). U DSH store-u postoji
  `GITHUB_PERSONAL_ACCESS_TOKEN` (naš); tenantski tokeni idu u `tenant_secrets`.
- **`scopes` kod nas:** `repo:read`, `repo:write`, `repo:merge` (posljednji samo uz odobrenje).
- **Tok (dev agent):** `jira.get_issue(NMQ-441)` → `github.get_repo` → `github.create_branch` →
  `github.create_or_update_file` (high → odobrenje) → `github.create_pull_request` →
  `slack.post_message` u `#dev` sa linkom → Jira prelazak u „In Review".
  **Merge nikad automatski**, čak i uz odobrenje CI-ja.

### 3.6 Jira

| Alati | Rizik | Opis |
|---|---|---|
| `jira.search_issues` | low | JQL upit (npr. `project = NMQ AND status = Open`) |
| `jira.get_issue` | low | Detalj + komentari |
| `jira.create_issue` | medium | Novi task/bug |
| `jira.update_issue` | medium | Polja, prioritet, assignee |
| `jira.transition_issue` | medium | Promjena statusa |
| `jira.add_comment` | medium | Komentar (npr. sažetak iz Slack thread-a) |
| `jira.log_work` | medium | Evidencija vremena |

- **Autentikacija:** OAuth 2.1 (3LO) za cloud, ili API token + email za self-hosted/Data Center.
  Provjeriti koji je slučaj za NMQ Atlassian nalog (u store-u vidjeti `JIRA_*` / `ATLASSIAN_*`).
- **`scopes` kod nas:** `tickets:read`, `tickets:write`.
- **Tok (ops agent):** Slack poruka „pao je deploy" → `slack.read_history` → `jira.create_issue`
  (sa logom u prilogu) → `jira.transition_issue` u „In Progress" ako se prepozna poznati problem →
  `slack.reply_thread` sa brojem tiketa → memorija bilježi „incident X = ticket NMQ-NNN".

### 3.7 HubSpot (ili Pipedrive)

| Alati | Rizik | Opis |
|---|---|---|
| `hubspot.search_contact` | low | Po emailu, telefonu ili imenu |
| `hubspot.search_company` | low | Firma + povezani kontakti i deal-ovi |
| `hubspot.list_deals` | low | Pipeline i faze |
| `hubspot.create_contact` | medium | Novi kontakt |
| `hubspot.create_note` | medium | Bilješka na kontakt/deal (sa `hs_timestamp`) |
| `hubspot.update_deal` | medium | Pomjeri fazu, iznos, close date |
| `hubspot.create_task` | medium | Zadatak za prodaju |
| `hubspot.log_email` | medium | Evidencija email komunikacije |

- **Autentikacija:** OAuth 2.1 (per-tenant) ili private app token (brže za jednog klijenta,
  ali token je širi — koristiti scoped private app). Pipedrive: API token + `api_token` query param.
- **`scopes` kod nas:** `crm:read`, `crm:write`.
- **Tok (glavni NMQ scenarij, „support → CRM"):**
  ```
  1. Ticket #4412 u NMQ Ticketing: "ne mogu da se ulogujem".
  2. nmq_ticket.get_ticket(4412) -> email kupca + opis.
  3. hubspot.search_contact(email) -> nađen nalog, plan = Pro, aktivan.
  4. pg.run_query(...) -> prošla 3 logina u 24h (read-only, maxRows 200).
  5. Agent formuliše odgovor -> gmail.create_draft (medium).
  6. hubspot.create_note(deal_id, "Support #4412: ...") (medium).
  7. nmq_ticket.add_reply(4412, odgovor) + nmq_ticket.set_status(4412, "waiting_customer").
  8. Ako je poznat bug: github.create_issue (medium) sa referencom na ticket.
  9. Cijeli tok: jedan traceId, cost po agentu, audit za svaki poziv.
  ```

### 3.8 PostgreSQL

| Alati | Rizik | Opis |
|---|---|---|
| `pg.list_schemas` | low | Šeme i tabele |
| `pg.describe_table` | low | Kolone, tipovi, indeksi |
| `pg.run_query` | **high** | SELECT (i samo SELECT) nad dozvoljenim tabelama |
| `pg.explain_query` | low | Plan izvršavanja prije nego se pusti upit |

- **Autentikacija:** odvojena **read-only** rola po tenantu (`nmq_ro_<tenant>`), connection string
  u `tenant_secrets`. Nikad `postgres` superuser.
- **Zaštita (obavezno, u kodu servera, ne u promptu):**
  ```
  - dozvoljen je samo jedan statement koji počinje sa SELECT/WITH
  - zabranjeni tokeni: insert|update|delete|drop|alter|truncate|grant|create|copy|\\copy|vacuum
  - statement_timeout = 5s, maxRows = 200, maxBytes = 256KB
  - zabranjen pristup šemama pg_catalog/information_schema osim preko list/describe alata
  - connection pool per tenant, max 2 konekcije (da agent ne pojede bazu)
  - `SET ROLE nmq_ro` + `default_transaction_read_only = on` na nivou role (druga linija odbrane)
  ```
- **`scopes` kod nas:** `db:read` (i to je sve; `high` rizik je zbog same prirode SQL-a i PII).
- **Tok (data agent):** „Koliko narudžbi je prošle nedjelje i koliki je prosječan iznos?" →
  `pg.describe_table(orders)` → `pg.explain_query` → `pg.run_query` (uz odobrenje) → tabela u
  odgovoru → rezultat (bez PII) ide u `longterm.append` kao fact sa `created_at`.

### 3.9 Stripe

| Alati | Rizik | Opis |
|---|---|---|
| `stripe.list_customers` | low | Pretraga kupaca |
| `stripe.get_subscription` | low | Status pretplate, period, plan |
| `stripe.list_invoices` | low | Fakture i status plaćanja |
| `stripe.list_payment_intents` | low | Status naplate |
| `stripe.create_payment_link` | medium | Link za plaćanje |
| `stripe.create_refund` | **high** | Povraćaj (uvijek odobrenje, uvijek u audit sa iznosom) |
| `stripe.update_subscription` | **high** | Promjena plana/količine |

- **Autentikacija:** **restricted API key** per tenant sa minimalnim setom dozvola; `sk_live` se
  nikad ne koristi direktno. Webhook: `STRIPE_WEBHOOK_SECRET` + provjera potpisa (obavezno,
  inače je ruta otvorena).
- **`scopes` kod nas:** `billing:read`, `billing:write`, `billing:refund` (odvojen scope jer
  povraćaj novca nikad ne dijeli dozvolu sa običnim pisanjem).
- **Tok (finance agent):** Stripe webhook `invoice.payment_failed` → `stripe.get_subscription` →
  `gmail.create_draft` sa dunning porukom (u jeziku klijenta) → ako nema odgovora 5 dana →
  `hubspot.create_task` za prodaju → ako klijent traži povraćaj → `stripe.create_refund` (high) →
  čovjek odobrava u dashboardu → iznos i razlog u `audit_log`.

### 3.10 Shopify

| Alati | Rizik | Opis |
|---|---|---|
| `shopify.get_order` | low | Status, stavke, plaćanje, tracking |
| `shopify.list_orders` | low | Filtrirano po statusu/datumu |
| `shopify.search_products` | low | Katalog |
| `shopify.get_customer` | low | Kupac + istorija |
| `shopify.create_draft_order` | medium | Priprema narudžbe (npr. B2B ponuda) |
| `shopify.update_order` | **high** | Izmjena narudžbe (adresa, stavke) |
| `shopify.create_fulfillment` | **high** | Slanje/otprema |
| `shopify.issue_refund` | **high** | Povraćaj |

- **Autentikacija:** Admin API access token custom app-a (per-tenant); poželjno samo čitanje +
  `write_orders` bez `write_products`. Webhook za `orders/create`, `orders/fulfilled`.
- **`scopes` kod nas:** `shop:read`, `shop:write`, `shop:refund`.
- **Tok (podrška „gdje je moja narudžba"):** `shopify.list_orders(email, last 2)` →
  `shopify.get_order` → ako je fulfilled, uzmi tracking → odgovor kroz Gmail ili WhatsApp →
  ako nije, `nmq_ticket.create_ticket` sa SLA tagom → `slack.post_message` u `#ops` ako kasni > 3 dana.

### 3.11 Google Drive / Docs

| Alati | Rizik | Opis |
|---|---|---|
| `gdrive.search_files` | low | Pretraga po imenu/sadržaju |
| `gdrive.get_file` | low | Preuzmi/metapodaci (PDF, Docs, Sheets) |
| `gdrive.export_doc` | low | Docs/Sheets → tekst/CSV za indeksiranje |
| `gdrive.create_doc` | medium | Novi dokument (ponuda, zapisnik) |
| `gdrive.update_doc` | medium | Dopuna dokumenta |
| `gdrive.share_file` | **high** | Dijeljenje van organizacije (uvijek odobrenje) |
| `gdrive.create_folder` | medium | Struktura po klijentu |

- **Autentikacija:** OAuth 2.1 per-tenant ili service account sa `domain-wide delegation` za
  Workspace (tada agent radi **kao** korisnik — moćnije, ali i osjetljivije; u DSH store-u postoje
  `GOOGLE_SERVICE_ACCOUNT_JSON` / `GOOGLE_PRIVATE_KEY` / `GOOGLE_CLIENT_ID`).
- **Scopes (provjeriti):** `.../auth/drive.file` (samo fajlovi koje je app kreirao ili otvorio) je
  najsigurniji; `drive.readonly` ako treba pretraga po cijelom Drive-u; `drive` **samo** ako je
  nužno i uz jasnu saglasnost tenanta.
- **`scopes` kod nas:** `docs:read`, `docs:write`, `docs:share`.
- **Tok (znanje):** `gdrive.search_files("cjenovnik 2026")` → `gdrive.export_doc` → chunk
  (800/120, §5 `02-TECH-STACK.md`) → `vector.upsert` u namespace tenanta → sljedeći upit „koliko
  košta Pro plan?" odgovara iz memorije, bez ponovnog čitanja Drive-a.

### 3.12 Filesystem (interni MCP server)

| Alati | Rizik | Opis |
|---|---|---|
| `fs.list_dir` | low | Lista unutar `data/tenants/<tenantId>/` |
| `fs.read_file` | low | Čitanje teksta (ograničena veličina i ekstenzije) |
| `fs.write_file` | medium | Upis (u dozvoljeni podfolder, npr. `exports/`) |
| `fs.move_file` | medium | Premještanje u okviru tenanta |
| `fs.delete_file` | **high** | Brisanje (odobrenje + ide u „trash" folder, ne `unlink`) |
| `fs.stat_file` | low | Metapodaci |

- **Autentikacija:** nema — izolacija je **putanja**. `tenantId` dolazi iz `ctx`, ne iz argumenata
  alata. Server **odbija** svaku putanju koja nakon `path.resolve` ne počinje sa
  `data/tenants/<tenantId>/` (sprječava `../`, symlink escape, apsolutne putanje).
- **`scopes` kod nas:** `fs:read`, `fs:write`, `fs:delete`.
- **Tok:** agent izveze CSV iz `pg.run_query` → `fs.write_file('exports/orders-2026-09.csv')` →
  `slack.upload_file` → korisnik dobije fajl; memorija pamti gdje je fajl.

### 3.13 HTTP fetch (interni MCP server)

| Alati | Rizik | Opis |
|---|---|---|
| `http.get` | low | GET sa allowlistom domena, bez auth headera osim ako je konfigurisano |
| `http.head` | low | Provjera dostupnosti/linkova |
| `http.post` | medium | POST sa JSON tijelom (samo za domene sa dozvolom) |
| `http.extract_text` | low | HTML → čist tekst (uklanjanje skripti i navigacije) |
| `http.sitemap` | low | Lista URL-ova sa sitemap.xml |

- **Zaštita (SSRF je realan rizik):**
  ```
  - allowlist domena po tenantu; default prazna lista -> alat ne radi
  - blokirane privatne adrese: 127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7
  - blokirani portovi osim 80/443
  - max 2 MB odgovora, timeout 15 s, max 3 redirecta (i svaki redirect se validira ponovo)
  - `User-Agent: NMQ-Robot/0.1 (+kontakt)` — jasan identitet, bez lažnog predstavljanja
  - robots.txt se poštuje za scraping (provjera prije serije zahtjeva)
  ```
- **`scopes` kod nas:** `web:read`, `web:post`.
- **Tok:** „Provjeri da li nam cjenovnik na sajtu odgovara onom u bazi" → `http.get` stranice →
  `http.extract_text` → poređenje sa `pg.run_query` → razlike u tabeli + `nmq_ticket.create_ticket`.

### 3.14 Interni MCP server: NMQ CRM

| Alati | Rizik | Opis |
|---|---|---|
| `nmq_crm.search_account` | low | Pretraga naloga (naziv, PIB, email) |
| `nmq_crm.get_account` | low | Nalog + kontakt osobe + istorija |
| `nmq_crm.create_account` | medium | Novi nalog |
| `nmq_crm.add_note` | medium | Bilješka/interakcija |
| `nmq_crm.list_quotes` | low | Ponude naloga |
| `nmq_crm.create_quote` | medium | Priprema ponude (nacrt) |
| `nmq_crm.update_quote_status` | medium | Poslata/prihvaćena/odbijena |

- **Autentikacija:** interni token (`NMQ_ADMIN_TOKEN`) + `tenantId`; mreža je lokalna (127.0.0.1).
- **`scopes` kod nas:** `nmq_crm:read`, `nmq_crm:write`.
- **Tok:** `nmq_crm.search_account("Pekara Sunce")` → `nmq_crm.get_account` →
  `nmq_crm.create_quote` (nacrt) → `gmail.create_draft` sa ponudom → `nmq_crm.add_note`.

### 3.15 Interni MCP server: NMQ Ticketing

| Alati | Rizik | Opis |
|---|---|---|
| `nmq_ticket.search_tickets` | low | Pretraga po statusu, tagu, emailu |
| `nmq_ticket.get_ticket` | low | Detalj + thread |
| `nmq_ticket.create_ticket` | medium | Novi tiket (npr. iz emaila ili Slack-a) |
| `nmq_ticket.add_reply` | medium | Odgovor u tiketu |
| `nmq_ticket.set_status` | medium | status/prioritet/tag |
| `nmq_ticket.assign` | medium | Dodjela operateru |
| `nmq_ticket.sla_report` | low | Prekršeni i predstojeći SLA |

- **Autentikacija:** interni token; vidi §4 skeleton (isti obrazac kao ovaj server).
- **`scopes` kod nas:** `nmq_ticket:read`, `nmq_ticket:write`.
- **Tok (routing + eskalacija):** email stigne → `nmq_ticket.create_ticket` (medium, auto) →
  router agent bira `support` → `nmq_ticket.get_ticket` → pokušaj rješenja iz memorije →
  ako nema rješenja: `nmq_ticket.assign(operater)` + `slack.post_message` sa SLA rokom →
  `nmq_ticket.sla_report` jednom dnevno daje izvještaj u `#support`.

### 3.16 Zajednička pravila za sve talas-1 integracije

| Pravilo | Zašto |
|---|---|
| Svaki MCP server dobija **sopstveni** token po tenantu, nikad dijeljeni | Curenje jednog tenanta ne otvara ostale; opoziv je po tenantu |
| Svaki alat ima `params` JSON Schema, bez `$ref` | Provajderi modela ne razrješavaju `$ref` pouzdano |
| Svaki poziv ima timeout (default 30 s) i `AbortSignal` | Inače jedan MCP server blokira cijeli run |
| Rezultat alata se skraćuje na 64 KB u kontekst, pun zapis na disk | Cijena tokena i stabilnost prompta |
| Svaki `high` alat: odobrenje + zapis **ko je** odobrio i **kada** | D15 + D16; bez toga enterprise prodaja ne prolazi |
| Integracija je „zdrava" samo ako je posljednji poziv uspio ili je prošlo < 5 min od greške | `/healthz` mora da prijavi mrtav MCP server, a ne da izgleda zeleno |

---

## 4. Interni MCP serveri

### 4.1 Zašto su interni MCP serveri najbrži put do „univerzalnosti"

1. **Naši sistemi nemaju MCP server.** Ako robot ne može da čita naš CRM i naše tikete, on je
   demo, ne proizvod. Interni server je jedini način da robot radi **naše** procese, a ne tuđe.
2. **Nema tuđeg OAuth-a, nema tuđe dokumentacije, nema tuđeg rate limita.** Jedan fajl, `stdio`,
   gotovo za sat vremena — a odmah dokazuje cijeli lanac (politika → alat → audit → cost → memorija).
3. **Jedan obrazac se ponavlja.** Napisati `nmq-crm-server.mjs` znači imati šablon za svaki budući
   interni API (fakture, KPO, SEO operator, OAA, rentai...). Svaki novi interni sistem = kopija
   šablona + 3-8 alata, bez izmjene jezgra.
4. **Univerzalnost dolazi od protokola, ne od broja integracija.** Isti `Tool` interfejs znači da
   agent ne zna (i ne treba da zna) da li je alat MCP server u drugom procesu ili funkcija u našem
   kodu. To je ono što omogućava da se svaki postojeći NMQ program pretvori u „sposobnost" robota.
5. **Kontrola ostaje kod nas.** `riskLevel`, `scopes` i audit su na našoj strani, pa interni alat
   može biti moćan (npr. `nmq_crm.create_quote`) bez davanja moći modelu.

### 4.2 Skelet vlastitog MCP servera (JS, bez zavisnosti, `stdio`, 3 alata)

```js
#!/usr/bin/env node
// mcp/nmq-ticketing-server.mjs
// Minimalni MCP server nad NMQ Ticketing API-jem: stdio + JSON-RPC 2.0, bez ijedne zavisnosti.
import { createInterface } from 'node:readline';

const BASE  = process.env.NMQ_TICKETING_BASE ?? 'http://127.0.0.1:8789';
const TOKEN = process.env.NMQ_TICKETING_TOKEN ?? '';       // dolazi iz env-a koji je prosledio klijent
const PROTOCOL = process.env.MCP_PROTOCOL_VERSION ?? 'PROVJERITI';   // pravu vrijednost uzeti iz specifikacije

// --- 1. Definicija alata: ime, opis, JSON Schema, rizik (rizik se ipak prepisuje na strani klijenta)

const TOOLS = [
  {
    name: 'search_tickets',
    description: 'Pretraga tiketa po statusu, tagu ili emailu korisnika.',
    inputSchema: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: 'Tekst, email ili ID' },
        status: { type: 'string', enum: ['open', 'waiting_customer', 'closed'] },
        limit:  { type: 'integer', minimum: 1, maximum: 50, default: 10 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_ticket',
    description: 'Vraća tiket sa cijelim thread-om poruka.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'integer'] } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'add_reply',
    description: 'Dodaje odgovor operatera/agenta u tiket.',
    inputSchema: {
      type: 'object',
      properties: {
        id:   { type: ['string', 'integer'] },
        body: { type: 'string', minLength: 1 },
        internal: { type: 'boolean', default: false, description: 'Interna bilješka, nevidljiva klijentu' }
      },
      required: ['id', 'body'],
      additionalProperties: false
    }
  }
];

// --- 2. Izvršavanje alata (jedina tačka gdje se dira mreža)

async function callApi(path, { method = 'GET', body } = {}) {
  const res = await fetch(new URL(path, BASE), {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`nmq-ticketing ${res.status}: ${await res.text().catch(() => '')}`);
  return res.status === 204 ? null : res.json();
}

async function runTool(name, args) {
  const tenant = process.env.NMQ_TENANT_ID ?? '';        // tenant dolazi iz env-a, ne iz argumenata modela
  if (!tenant) throw new Error('NMQ_TENANT_ID nije postavljen');
  switch (name) {
    case 'search_tickets': {
      const qs = new URLSearchParams({ tenant, limit: String(args.limit ?? 10) });
      if (args.query)  qs.set('q', args.query);
      if (args.status) qs.set('status', args.status);
      const rows = await callApi(`/api/tickets?${qs}`);
      return text(JSON.stringify(rows, null, 2));
    }
    case 'get_ticket': {
      const t = await callApi(`/api/tickets/${encodeURIComponent(args.id)}?tenant=${encodeURIComponent(tenant)}`);
      return text(JSON.stringify(t, null, 2));
    }
    case 'add_reply': {
      const r = await callApi(`/api/tickets/${encodeURIComponent(args.id)}/replies`, {
        method: 'POST',
        body: { tenant, body: args.body, internal: !!args.internal }
      });
      return text(`Odgovor dodat u tiket ${args.id} (id: ${r?.id ?? 'n/a'})`);
    }
    default:
      throw Object.assign(new Error(`Nepoznat alat: ${name}`), { code: -32601 });
  }
}

const text = (s) => ({ content: [{ type: 'text', text: String(s) }] });

// --- 3. JSON-RPC 2.0 petlja preko stdio (linija = jedna poruka)

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize':
        return send({ jsonrpc: '2.0', id, result: {
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'nmq-ticketing', version: '0.1.0' }
        }});
      case 'notifications/initialized':
        return;                                                  // notifikacija: bez odgovora
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const { name, arguments: args = {} } = params ?? {};
        try {
          const result = await runTool(name, args);
          return send({ jsonrpc: '2.0', id, result });
        } catch (err) {
          // Greška ALATA nije JSON-RPC greška: model treba da vidi šta je pošlo naopako.
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Greška: ${err.message}` }], isError: true } });
        }
      }
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      default:
        if (isNotification) return;                              // nepoznata notifikacija se ignoriše
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); }
  catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  handle(msg);
});
rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
```

Šta je u ovom skeletu namjerno, a ne slučajno:

| Detalj | Razlog |
|---|---|
| `NMQ_TENANT_ID` iz **env-a**, ne iz argumenata alata | Model ne može da bira tenant; izolacija je van njegovog domašaja (D11) |
| Greška alata → `result.isError`, greška protokola → `error` | Model treba da vidi „nije uspjelo" i da proba drugačije; protokolna greška prekida |
| Nema logovanja na `stdout` | `stdout` je **protokol**; svaki `console.log` kvari JSON-RPC tok. Log ide na `stderr` |
| Nema zavisnosti | Server se pokreće gdje hoćeš, bez `npm install` (D2) |
| `AbortSignal.timeout` na svakom pozivu | Mrtav interni API ne blokira run |
| Tri alata, ne trideset | Manje alata = bolji izbor modela; širenje ide po potrebi, ne „za svaki slučaj" |

### 4.3 Izrada novog internog MCP servera (procedura)

```
1. Kopirati šablon: mcp/<sistem>-server.mjs (ticketing šablon je referentni).
2. Definisati 3-8 alata po pravilu: čitanje je low, pisanje je medium, brisanje/slanje/novac je high.
   Više od 8 alata po serveru => podijeliti po domenu (npr. nmq-crm-quotes, nmq-crm-accounts).
3. Svaki alat: ime u snake_case, opis u jednoj rečenici (model po njemu bira), JSON Schema bez $ref.
4. Dodati server u config/tools.json (transport stdio, toolPrefix, tenants, riskOverrides).
5. Test bez mreže: `node tests/mcp-server.test.mjs` šalje initialize -> tools/list -> tools/call
   kroz spawn i provjerava odgovore (D17).
6. Provjeriti da server ne piše na stdout osim JSON-RPC, i da se uredno gasi na SIGTERM.
7. Uključiti u demo (scripts/demo.mjs) kao dokaz da interni alat radi kraj LLM-a.
```

Test obrazac (bez zavisnosti, koristi `node:test`):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('nmq-ticketing MCP: initialize + tools/list', async () => {
  const p = spawn(process.execPath, ['mcp/nmq-ticketing-server.mjs'], {
    env: { ...process.env, NMQ_TENANT_ID: 'test', NMQ_TICKETING_BASE: 'http://127.0.0.1:9' }
  });
  const lines = [];
  p.stdout.setEncoding('utf8');
  const readOne = () => new Promise((res) => p.stdout.once('data', (d) => res(JSON.parse(d.trim().split('\n')[0]))));
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  const init = await readOne();
  assert.equal(init.result.serverInfo.name, 'nmq-ticketing');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  const list = await readOne();
  assert.ok(list.result.tools.some((t) => t.name === 'get_ticket'));
  p.kill('SIGTERM');
});
```

---

## 5. Upravljanje tajnama i auth po tenantu

### 5.1 Model prikupljanja tokena

```
Operater (NMQ)                    NMQ Robot API                        Provajder (Google/Slack/...)
   |  klik "Poveži Gmail"  ->  GET /v1/tenants/:id/oauth/google/start
   |                             |  generiši state + PKCE verifier
   |  <-- redirect 302 ----------|  (state u Redis/JSONL, TTL 10 min)
   |-------------------------------------------------------------------------->  consent ekran
   |  <-- redirect /v1/oauth/google/callback?code=...&state=...
   |                             |  provjeri state (jednokratni!), zamijeni code za tokene
   |                             |  ENKRIPTOVATI tokene -> tenant_secrets
   |  <-- 200 "Povezano: gmail (readonly, compose)"   [nikad ne prikazuj token]
```

Pravila:

1. **`state` je jednokratan i vezan za tenanta** — bez toga je CSRF na OAuth tok.
2. **PKCE** (`code_challenge`/`code_verifier`) za sve provajdere koji ga podržavaju.
3. **Consent ekran uvijek pokazuje koje smo scope-ove tražili** — tenant mora da zna šta daje.
4. Nakon razmjene, token **nikad** ne prolazi kroz naše logove, trace, error poruke ni SSE tokove.
5. Tenant može da otkaže pristup u našem UI-ju **i** kod provajdera; oba puta moraju da dovedu do
   istog stanja (integacija označena kao `revoked`).

### 5.2 Gdje se čuvaju

```
MVP (fajl):     data/tenants/<tenantId>/secrets/<provider>.enc.json   (AES-256-GCM, vidi dole)
Produkcija:     PG tabela tenant_secrets (RLS po tenant_id) — isti enkriptovani blob
Redis:          NIKAD trajni tokeni. U Redis idu samo kratkotrajni state/verifier (TTL 10 min)
Kod / git:      NIKAD. Nijedan token, čak ni testni, ne ulazi u repo
```

Šifrat (jedan JSON po provajderu, sve što treba za refresh):

```json
{
  "v": 1,
  "provider": "google",
  "tenantId": "nomorequiet",
  "alg": "aes-256-gcm",
  "keyRef": "NMQ_TENANT_KEK",
  "iv": "base64...",
  "tag": "base64...",
  "ct": "base64...",            // šifrat: { access_token, refresh_token, expires_at, scope, token_type }
  "scopes": ["email:read", "email:draft"],
  "createdAt": "2026-09-29T10:00:00Z",
  "updatedAt": "2026-09-29T10:00:00Z",
  "status": "active"
}
```

Enkripcija (AES-256-GCM, D-nivo zahtjev za enkripciju tajni tenanta):

```js
// src/tenancy/crypto.js — skica
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

// Ključ se čita IZ DSH STORE-A po imenu (nikad iz koda):
//   node C:\Users\Administrator\.dsh\NMQ\get-key.mjs NMQ_TENANT_KEK
// 32 bajta: KEK je base64 ili hex; ako je passphrase -> scrypt sa tenantId kao salt.
function deriveKey(kekMaterial, tenantId) {
  return createHash('sha256').update(`${kekMaterial}:${tenantId}`).digest();   // 32B
}

export function seal(plaintextObj, { kekMaterial, tenantId }) {
  const key = deriveKey(kekMaterial, tenantId);
  const iv = randomBytes(12);                                  // 96-bit IV za GCM
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`${tenantId}:v1`));                     // AAD veže šifrat za tenanta
  const ct = Buffer.concat([c.update(JSON.stringify(plaintextObj), 'utf8'), c.final()]);
  return { v: 1, alg: 'aes-256-gcm', iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct) };
}

export function open(sealed, { kekMaterial, tenantId }) {
  const key = deriveKey(kekMaterial, tenantId);
  const d = createDecipheriv('aes-256-gcm', key, unb64(sealed.iv));
  d.setAAD(Buffer.from(`${tenantId}:v1`));
  d.setAuthTag(unb64(sealed.tag));                             // ako AAD/tenant ne odgovara -> throw
  return JSON.parse(Buffer.concat([d.update(unb64(sealed.ct)), d.final()]).toString('utf8'));
}
const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');
```

Zašto baš ovako:

| Odluka | Razlog |
|---|---|
| AES-256-**GCM** (ne CBC) | GCM daje autentikaciju šifrata; CBC bi zahtijevao odvojen HMAC i lako se pogreši |
| Ključ izveden sa `tenantId` u materijalu | Šifrat jednog tenanta se ne može otvoriti ključem drugog, čak i ako se fajl preseli |
| `setAAD(tenantId:v1)` | Onemogućava „prelijepi tuđi šifrat u svoj folder" napad |
| Novi `iv` na svaki `seal` | Ponovljena IV sa istim ključem u GCM-u razbija povjerljivost — nikad se ne reciklira |
| `keyRef`, ne ključ u fajlu | Rotacija ključa ne dira fajlove; mijenja se jedan podatak u store-u |
| `v: 1` u šifratu | Migracija algoritma bez nagađanja šta je unutra |

### 5.3 Refresh tokena

```js
// src/tenancy/oauth.js — pravilo: refresh se radi NA JEDNOM MJESTU, uz zaključavanje
async function getAccessToken(tenantId, provider) {
  const sealed = await secrets.read(tenantId, provider);          // -> { ... } ili null
  if (!sealed) throw new AuthError('integration_not_connected', { tenantId, provider });
  if (sealed.status !== 'active') throw new AuthError('integration_revoked', { tenantId, provider });

  const tok = open(sealed, { kekMaterial: await kek(), tenantId });
  const skewMs = 120_000;                                         // 2 min ranije, ne na sekund
  if (tok.expires_at - Date.now() > skewMs) return tok.access_token;

  // zaključavanje po (tenantId, provider): u MVP-u in-process Map<Promise>, u produkciji Redis SETNX
  return withLock(`refresh:${tenantId}:${provider}`, async () => {
    const again = open(await secrets.read(tenantId, provider), { kekMaterial: await kek(), tenantId });
    if (again.expires_at - Date.now() > skewMs) return again.access_token;   // neko je već osvježio

    const res = await provider.refresh(again.refresh_token);       // POST /token, grant_type=refresh_token
    const next = {
      access_token: res.access_token,
      refresh_token: res.refresh_token ?? again.refresh_token,     // neki provajderi ne vraćaju novi
      expires_at: Date.now() + (res.expires_in ?? 3600) * 1000,
      scope: res.scope ?? again.scope,
      token_type: res.token_type ?? 'Bearer'
    };
    await secrets.write(tenantId, provider, seal(next, { kekMaterial: await kek(), tenantId })); // atomski write
    audit.write(tenantId, { type: 'oauth_refresh', provider, at: new Date().toISOString() });    // bez tokena!
    return next.access_token;
  });
}
```

Pravila refresh-a:

1. **Skew 2 minute** — token koji ističe „sada" je praktično istekao u trenutku poziva.
2. **Zaključavanje** — bez njega 10 paralelnih poziva napravi 10 refresh-a i provajder može da
   opozove token (rotirajući refresh tokeni se „potroše").
3. **Refresh token se ne mijenja ako provajder ne vrati novi** — čuvanje `undefined` bi trajno
   oborilo integraciju.
4. **Neuspjeh refresh-a ≠ pad robota**: integracija ide u status `needs_reauth`, alat se isključuje
   iz registra za taj tenant, agentu se kaže „Gmail nije povezan", a tenant dobija notifikaciju.
5. **Svaki refresh je u audit logu** (bez vrijednosti) — inače se ne može objasniti „zašto je
   integracija pukla u 3 ujutru".

### 5.4 Onemogućavanje tenanta (kill switch)

| Nivo | Akcija | Efekat | Vrijeme |
|---|---|---|---|
| Integracija | `status: "revoked"` + brisanje šifrovanog fajla | Alati tog provajdera se ne registruju za tenant | trenutno |
| Alat | `config/tools.json` → `riskOverrides`/`deny` za tenant | Konkretan alat odbijen u politici | trenutno (hot reload config-a) |
| Tenant (pauza) | `tenants.status = "suspended"` | `/run` i `/stream` vraćaju 402/403; memorija se ne briše; webhook-ovi se odbijaju | trenutno |
| Tenant (brisanje) | `status = "deleted"` + brisanje `data/tenants/<id>/` i redova u PG | Podaci nestaju; ostaje samo zapis u audit logu da je tenant obrisan i kada | trajno |
| Globalno | `NMQ_KILL_SWITCH=1` u env-u | Svi `high` alati automatski odbijeni, ostaje samo čitanje | restart ili hot flag |

Pravila: **brisanje tenanta je nepovratno** → prije brisanja obavezan `pg_dump`/`tar` tog tenanta
i potvrda od operatera; svaka akcija iz tabele iznad ide u audit log sa **ko**, **kada**, **šta**.
Opoziv OAuth pristupa kod provajdera se **predlaže** korisniku (link), ali se ne izvršava automatski
— za to tražimo eksplicitnu potvrdu.

---

## 6. Katalog gotovih MCP servera i agregatora

> Svi linkovi se **provjeravaju prije upotrebe**. Sadržaj i imena se mijenjaju; nijedan URL ovdje
> nije garancija da server postoji, radi, ili da je siguran. Prije dodavanja bilo kog tuđeg MCP
> servera: pročitati kod ili barem `tools/list` output, i dodijeliti `riskLevel` sami.

| Izvor | Šta je | Kako se koristi | Napomena |
|---|---|---|---|
| `github.com/modelcontextprotocol/servers` | Zvanična referentna lista servera (filesystem, fetch, git, memory, sqlite...) | Kao referentna implementacija i šablon; pojedini serveri se mogu pokrenuti preko `npx` | Provjeriti koji su „reference" a koji „community"; licenca po serveru |
| `modelcontextprotocol.io` | Specifikacija protokola | Jedini izvor istine za `initialize`, `tools/list`, `tools/call`, transport i verziju protokola | Obavezno pročitati prije pisanja klijenta |
| `smithery.ai` | Katalog/registry MCP servera sa instalacijom | Kao izvor kandidata; serveri se testiraju u izolaciji prije produkcije | Kvalitet varira; nikad ne davati produkcijske tokene neprovjerenom serveru |
| `glama.ai/mcp/servers` | Katalog + pretraga MCP servera | Isto kao Smithery; korisno za poređenje alternativa | Provjeriti datum zadnjeg commita |
| `pulsemcp.com` | Katalog i „directories" | Isto | Isto |
| Zvanični provajderi (Slack, Notion, GitHub, Stripe, Atlassian, HubSpot...) | Sopstveni MCP serveri ili zvanične integracije | Preferirano: zvanični server pre bilo kog agregatora | Provjeriti da li je server „GA", „beta" ili eksperimentalan |
| `npx`-pokretljivi serveri | Server bez instalacije | `transport: "stdio", command: "npx", args: ["-y", "<paket>"]` | **Ne** na Hostingeru (LVE + nema `npm install`); na VPS-u uz `--ignore-scripts` i fiksiranu verziju |

Pravila za tuđe MCP servere:

1. **Pinovati verziju** (`paket@1.2.3`, nikad `latest`) — inače tuđi update menja ponašanje našeg alata.
2. **Sandbox**: proces sa minimalnim env-om, bez pristupa `data/` osim ako je nužno.
3. **Nema mrežnog pristupa** ako serveru ne treba (npr. filesystem i memory serveri).
4. **`tools/list` se snima u audit** pri svakom pokretanju — ako server doda novi alat, to se vidi.
5. **Provjera izvora**: broj zvjezdica na GitHub-u nije sigurnosna provjera; provjeriti autore i
   da li se paket objavljuje sa istog repozitorija.
6. Ako server traži naš `DEEPSEEK_API_KEY` ili bilo koji naš ključ, a ne tenantov — **ne dodajemo ga**.

---

## 7. Kada pisati vlastiti alat umjesto MCP-a

Kriteriji (dovoljno je **jedno** „da" u lijevoj koloni da se ide na vlastiti alat):

| Situacija | Vlastiti `builtin` alat | MCP server |
|---|---|---|
| Alat je čista funkcija bez mreže (kalkulacija, formatiranje, validacija) | **da** | ne |
| Alat treba da radi u istom procesu (pristup memoriji, konfiguraciji, politici) | **da** | ne |
| Pouzdanost/performanse su kritične (poziva se u svakom run-u) | **da** | ne |
| Postoji zreo MCP server za sistem koji tenant već koristi | ne | **da** |
| Integracija se mijenja bez našeg deploy-a (tuđi API) | ne | **da** (izolacija od našeg ciklusa) |
| Potrebna je izolacija (rizik, pad, memorija) van našeg procesa | ne | **da** |
| Više tenanta koristi isti sistem sa svojim tokenima | ne | **da** (jedan server, N tenanta) |
| Alat je interni NMQ API | **da**, ali kao **interni MCP server** (§4) — ne kao `builtin` | – |
| Treba nam „univerzalnost" za buduće klijente | ne | **da** |
| Brzina izrade je prioritet (jedan klijent, jedan slučaj) | **da** (10 linija) | ne |
| Alat mora da radi i kad MCP server padne (fallback) | **da** | **da** (dvije implementacije istog `Tool` imena) |

Tabela odluke — konkretni primjeri za NMQ:

| Slučaj | Odluka | Obrazloženje |
|---|---|---|
| `calc.margin(price, cost)` | vlastiti `builtin` | Čista funkcija, nema mreže, poziva se često |
| `memory.recall(query)` | vlastiti `builtin` | Direktan pristup `VectorStore`-u i `tenantId`-ju iz `ctx` |
| `policy.check(tool, action)` | vlastiti `builtin` | Mora biti prije svakog poziva, u istom procesu |
| Slack | MCP server | Tuđi API, tuđi OAuth, mijenja se bez nas |
| NMQ CRM | **interni MCP server** | Naš API, ali izolovan i ponovo upotrebljiv za svaki budući NMQ program |
| Interni „quick win" (`nmq_echo`, `nmq_health`) | vlastiti `builtin` | Nema smisla dizati proces za jednu funkciju |
| PDF generisanje iz šablona | vlastiti `builtin` (ili `vendor/` biblioteka) | Nema tuđeg API-ja; traži determinističan izlaz |
| Fakturisanje preko tuđeg servisa | MCP server | Tuđi API + tuđi OAuth + tuđa pravila |
| Čitanje lokalnih fajlova tenanta | MCP server (filesystem, §3.12) | Izolacija putanje i mogućnost pada bez obaranja API-ja |

Pravilo presude: **ako nešto može pasti ili se promijeniti bez našeg deploy-a → MCP. Ako je naša
logika i mora biti u istom procesu → `builtin`.** Interni NMQ API-ji su poseban slučaj: pišu se kao
interni MCP serveri zato što se time isti kod koristi i za buduće programe, a ne samo za robota.

---

## Otvorena pitanja

1. **Koji su tačni URL-ovi i verzija protokola MCP servera koje želimo (Slack, Notion, GitHub,
   HubSpot)?** Neki provajderi nude zvaničan hostovan MCP endpoint, neki traže da server pokrenemo
   sami (`stdio`/lokalni HTTP). Od toga zavisi da li nam treba `npx` na VPS-u i koje IP adrese
   moraju biti dozvoljene.
2. **Da li NMQ ima pristup Google Workspace admin konsoli** (service account sa domain-wide
   delegation) ili radimo isključivo per-tenant OAuth? Prvo je moćnije i brže za internu upotrebu,
   drugo je jedino ispravno za tuđe tenante.
3. **Koji je NMQ CRM i Ticketing izvor istine** za interne MCP servere — postojeća NMQ baza
   (`PG_*` ključevi), Airtable (`AIRTABLE_API_KEY`), ili nešto treće? Bez toga §4 skeleton nema
   na šta da se poveže.
4. **Gdje ide `high` odobrenje** dok dashboard ne postoji: Telegram bot (`TELEGRAM_BOT_TOKEN`
   postoji), Slack kanal, ili email preko SendGrid-a? Jedan kanal mora biti izabran prije nego
   prvi `high` alat uopšte bude registrovan.
5. **`NMQ_TENANT_KEK`**: kreiramo li ga sada i gdje je sigurnosna kopija? Ako se izgubi, svi OAuth
   tokeni svih tenanta su nepovratno neupotrebljivi i svaki tenant mora ponovo da poveže svoje
   integracije.
6. **Politika za MCP servere trećih strana**: da li dozvoljavamo `npx` servere iz javnih registara
   (Smithery/Glama) u produkciji, ili samo zvanične provajderske servere i naše interne? To je
   sigurnosna odluka, ne tehnička, i mora biti zapisana u `DECISIONS.md`.
