# 11 — Pokretanje, testiranje, održavanje

> Sve komande se pokreću iz korijena projekta: `E:\NMQ-PROGRAMI\nmq-robot`
> Deploy (Hetzner, Hostinger, Docker, Cloudflare) je u [`infra/DEPLOY.md`](../infra/DEPLOY.md).

---

## 1. Prvih pet minuta

```bash
node --test                # 70 testova, bez mreže i bez npm install
node scripts/demo.mjs      # demo svih 6 patterna + izolacija tenanta + naplata
node scripts/serve.mjs     # gateway na http://127.0.0.1:8787 (widget + demo stranica)
node scripts/smoke.mjs     # 13 provjera protiv živog servera
node src/cli.js help       # sve CLI komande
```

Ako nema `NMQ_LLM_API_KEY`, robot radi sa **mock LLM-om** — sve osim kvaliteta odgovora je identično
(alati, memorija, politike, trošak se računa po cijeni pravog modela).

---

## 2. Konfiguracija

| Fajl | Šta mijenjaš | Restart? |
|---|---|---|
| `.env` | port, LLM, budžeti, allowlist, master ključ | **da** |
| `config/agents/*.json` | agenti: prompt, alati, pattern, model, limiti | da (čita se pri startu) |
| `config/policies.json` | politike: allow/deny/approval, budžet, radno vrijeme | da |
| `config/tenants.json` | tenanti, planovi, API ključevi, webhook mapiranja | da |
| `config/tools.json` | MCP serveri, podešavanja ugrađenih alata | da |
| `public/widget/nmq-robot.js` | widget | ne (servira se po zahtjevu, bez keša) |

**Tajne NIKAD ne idu u ove fajlove.** Vrijednosti idu u `.env` (nije u git-u) ili u DSH store:

```powershell
node C:\Users\Administrator\.dsh\NMQ\get-key.mjs DEEPSEEK_API_KEY   # ispisuje vrijednost
node C:\Users\Administrator\.dsh\NMQ\get-key.mjs --has DEEPSEEK_API_KEY
```

Tajne **klijenata** (OAuth tokeni) idu u `data/tenants/<id>/secrets/secrets.enc.json` preko API-ja:

```bash
curl -X POST localhost:8787/v1/tenants/nmq/secrets \
  -H "content-type: application/json" \
  -d '{"provider":"slack","value":"xoxb-..."}'
```

Šifrovanje: AES-256-GCM, ključ `scrypt(NMQ_MASTER_KEY, "nmq-tenant:<tenantId>")`, AAD `<tenantId>:v1`.

---

## 3. Česte operacije

| Želim da… | Komanda |
|---|---|
| vidim agente / alate / patterne | `node src/cli.js agents` · `tools` · `patterns` |
| pokrenem jedan zadatak iz terminala | `node src/cli.js run support "Kako da resetujem lozinku?"` |
| simuliram webhook | `node src/cli.js hook shopify "Narudžbina 1042 kasni"` |
| vidim potrošnju po tenantu | `node src/cli.js cost` |
| provjerim audit lanac | `node src/cli.js audit-verify` |
| generišem API ključ | `node src/cli.js keys nmq owner` |
| dodam znanje klijentu (RAG) | `POST /v1/kb {text, source, tags}` |
| vidim šta je robot radio | `GET /v1/runs` · `GET /v1/runs/:runId` |
| odobrim akciju visokog rizika | `GET /v1/approvals` → `POST /v1/approvals/:runId {"approve":true}` |
| uradim backup podataka | `data/tenants/**` (pokriveno restic backup-om u 04:00) |

---

## 4. Kako se dodaje nova stvar

### Novi agent (bez koda)

```json
// config/agents/racunovodja.json
{
  "id": "racunovodja",
  "name": "Knjigovodstveni agent",
  "domain": "finance",
  "description": "Knjiži dokumente, pravi izvještaje, provjerava PDV.",
  "systemPrompt": "Ti si knjigovodstveni agent. ...",
  "defaultPattern": "sequential",
  "patternConfig": { "steps": [{ "agent": "racunovodja", "input": "{{input}}" }] },
  "tools": ["calculator", "report_generate", "memory_search", "kb_ingest", "current_time"],
  "maxRisk": "medium",
  "routingHints": ["knjiženje", "pdv", "kontni plan", "bilans", "izvod"],
  "maxSteps": 10
}
```

→ `GET /v1/agents` odmah pokazuje agenta, ruter ga može izabrati, politika se primjenjuje automatski.

### Nova integracija (MCP)

1. Nađi ili napiši MCP server (šablon: `mcp/example-server.mjs`).
2. Dodaj ga u `config/tools.json`:

```json
{ "id": "gmail", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-gmail"],
  "enabled": true, "riskLevel": "high", "scopes": ["mail:read", "mail:send"],
  "tools": { "send_email": { "riskLevel": "high" } } }
```

3. Provjeri: `GET /v1/mcp` → alat se pojavljuje kao `gmail.send_email`.
4. Dodaj ga u `tools` liste onih agenata kojima treba; u politici odluči da li traži odobrenje.

### Nova sposobnost (kod)

Dodaj alat u `src/tools/builtin.js` (obavezno: `name`, `description`, `params` JSON Schema, `riskLevel`, `handler`)
i test u `tests/tools.test.mjs`. Nema registracije — `registerBuiltinTools` ga pokupi.

---

## 5. Testiranje i provjere prije svake izmjene

```bash
node --test                         # 70 unit/integration testova
node scripts/demo.mjs               # end-to-end kroz sve patterne (mora proći bez greške)
node scripts/smoke.mjs              # 13 HTTP provjera
node src/cli.js audit-verify        # hash lanac mora biti ispravan
```

| Test fajl | Šta dokazuje |
|---|---|
| `tests/policy.test.mjs` | politika (deny/approval/budžet/PII) i da se zabranjen alat ne izvršava |
| `tests/memory.test.mjs` | izolacija tenanta (sesija, istorija, vektori), chunking, embeddings |
| `tests/tools.test.mjs` | registry (timeout, retry, dry-run), ugrađeni alati, MCP stdio, allowlist |
| `tests/patterns.test.mjs` | svi patterni, handoff petlja, budžet, odobrenja, sesija |
| `tests/server.test.mjs` | gateway: rute, SSE, webhook, KB izolacija, rate limit, auth |
| `tests/observability.test.mjs` | trošak, metrike, hash-chained audit (+ detekcija izmjene), tenancy, tajne |

---

## 6. Rješavanje problema

| Simptom | Uzrok | Rješenje |
|---|---|---|
| `/readyz` kaže `llmIsMock` | nema `NMQ_LLM_API_KEY` | postavi ključ u `.env` i restartuj |
| Odgovori su „[mock] …" | mock provider | isto kao gore |
| `POLICY_DENIED` u odgovoru agenta | alat nije na allow listi ili je zabranjen | `config/policies.json` → `tenants.<id>.tools` |
| `APPROVAL_REQUIRED` / `awaiting_approval` | `high` rizik ili `requireApproval` | odobri kroz `POST /v1/approvals/:runId` ili promijeni politiku |
| `BUDGET_EXCEEDED` | run/mjesečni budžet ili `maxSteps` | `config/policies.json` → `budget`, `maxSteps` |
| MCP alat ne postoji | server nije pokrenut ili `enabled: false` | `GET /v1/mcp`, log `mcp.connect_failed` |
| `http_fetch` odbija domen | allowlist | `NMQ_HTTP_ALLOWLIST=api.deepseek.com,...` |
| Widget se ne osvježava na sajtu | keš (Hostinger/CDN) | statika je `no-cache`; koristi `?v=` i provjeri `x-robot-version` |
| Na Hostingeru „node: command not found" | Node nije na PATH-u | `/opt/alt/alt-nodejs22/root/bin/node` |
| Passenger ne odgovara | `app.js` mora export-ovati server | vidi `infra/DEPLOY.md` §B |
| Testovi padaju poslije izmjene prompta | mock skripta se poziva po sistemskom promptu | ažuriraj `tests/helpers.mjs` (`smartScript`) |

---

## 7. Sigurnosna pravila pri radu (obavezno)

1. **Nikad** ne ispisuj vrijednosti ključeva u chat, log ili commit — samo imena.
2. `.env` i `data/` su u `.gitignore`; provjeri `git status` prije svakog commita.
3. Prije deploy-a: backup `data/` (restic pokriva `E:\NMQ-PROGRAMI`).
4. Poslije izmjene politike ili agenata: `node src/cli.js audit-verify` i `GET /v1/usage`.
5. U produkciji `requireAuth: true` + generisan API ključ po klijentu.
6. Novi MCP server se dodaje samo ako je kod pregledan (ili je zvanični) — MCP server je izvršni kod.

---

## Otvorena pitanja

1. Da li `scripts/smoke.mjs` ide u CI (GitHub Actions) ili se pokreće ručno prije deploy-a?
2. Da li dashboard (faza 3) mijenja CLI komande ili ih samo dopunjuje?
3. Kako čuvamo `NMQ_MASTER_KEY` na VPS-u — systemd `EnvironmentFile` sa `chmod 600` ili Docker secret?
4. Da li klijentske tajne idu u Postgres (produkcija) ili ostaju šifrovani fajlovi?
5. Koliko često rotiramo API ključeve klijenata (predlog: 6 mjeseci + pri sumnji)?
6. Da li dozvoljavamo klijentu pristup `GET /v1/audit` (transparentnost) ili samo nama?
