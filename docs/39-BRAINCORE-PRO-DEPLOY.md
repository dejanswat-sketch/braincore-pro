# 39 — BRAINCORE PRO deployment runbook (braincore.pro)

> Domain: **braincore.pro** (owned). Site → Hostinger. Machine → Hetzner. Product name: **Braincore Pro**.
> Control surface: **Genesis Brain v2.0**. Everything below is implemented in this repository; nothing here is a
> mock-up. Prices appear where the plan defines them and are labelled as plan values, not revenue.

---

## 1. Target topology

| Host | Role | What runs | Ports |
|---|---|---|---|
| Hostinger (shared hosting) | Public site | `site/` — static HTML + Tailwind | 80/443 (hPanel SSL) |
| Hetzner #1 (CX11/CPX11, Ubuntu 22.04+) | Swarm node 1 + public API | `node :8001`, API + live facade `:8081` | 8001/udp, 8001/tcp, 8081/tcp |
| Hetzner #2 | Swarm node 2 | `node :8002` | 8002/udp+tcp |
| Hetzner #3 | Swarm node 3 | `node :8003` | 8003/udp+tcp |

Three nodes may also run as three processes on one machine (that is what the automated tests do); behaviour is
identical because coordination happens through the CRDT board and gossip, not through the host.

```
browser ──► https://braincore.pro            (Hostinger: static site)
   │
   ├── fetch ──► https://api.braincore.pro    (nginx → 127.0.0.1:8081 → API facade)
   │                 └── POST /task ──► swarm node :8001 ──► UDP gossip ──► :8002/:8003
   │                                                                        (CRDT claim; freest node executes)
   └── wss ───► https://live.braincore.pro    (nginx → 127.0.0.1:8081 → /events WebSocket)
                      └── snapshots + events: nodes, load, pheromones, task results

edge node (customer) ──HMAC──► POST /v1/fitness   (metrics only; content never leaves the edge)
                    ◄───────── GET /v1/genome/best (top 10% genome, hot-swap through the control plane)
```

---

## 2. DNS (Hostinger hPanel)

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `@` | Hostinger IP | 300 |
| A | `www` | Hostinger IP | 300 |
| A | `api` | Hetzner IP (node 1) | 300 |
| A | `live` | Hetzner IP (node 1) | 300 |

1. hPanel → Domains → DNS Zone Editor → add the four records above.
2. hPanel → SSL: enable free SSL for `braincore.pro` and `www`.
3. On the Hetzner box, after DNS resolves: `certbot --nginx -d api.braincore.pro -d live.braincore.pro`.
4. Verify: `dig +short api.braincore.pro live.braincore.pro` and
   `curl -sI https://api.braincore.pro/health | head -1`.

Reference details for the hosting account live in the workspace notes; secret values are never printed here.

---

## 3. Site (Hostinger, English only)

Upload the contents of `site/` into `public_html/`:

| File | Purpose |
|---|---|
| `index.html` | Landing page: hero (Genesis Brain hero render), proof strip, four layers, four clusters, live preview, security, deploy commands, comparison, pricing **$999/mo**, FAQ, CTA |
| `docs.html` | API reference (endpoints, examples, environment variables) |
| `privacy.html`, `terms.html` | Legal pages referenced by the footer and by Stripe |
| `thanks.html` | Stripe success page (`noindex`) |
| `script.js` | Cursor-driven 360° parallax, scroll reveal, copy buttons, live API metrics, Stripe-link guard |
| `assets/brain-hero.png` (+ `-2x`) | Hero image (transparent background; blends via `mix-blend-mode: screen`) |
| `assets/live-preview.png` | Screenshot of the live surface (rendered from `?demo=1`) |
| `favicon.svg`, `robots.txt`, `sitemap.xml` | Housekeeping |

Before uploading: replace `REPLACE_WITH_YOUR_PAYMENT_LINK` in `index.html` with your Stripe Payment Link and point
its success URL at `https://braincore.pro/thanks.html`.

Lighthouse notes: Tailwind is loaded from CDN, the hero is preloaded with explicit `width`/`height`, the second
image uses `loading="lazy"`, animations respect `prefers-reduced-motion`, and `script.js` is `defer`red.

---

## 4. Machine (Hetzner, Ubuntu 22.04)

```bash
scp -r . root@<HETZNER_IP>:/root/braincore-src
ssh root@<HETZNER_IP> 'bash /root/braincore-src/deploy/install.sh'
```

`deploy/install.sh` installs Node 20, nginx, Redis and certbot (runtime only — it never runs `npm install`),
creates the `braincore` system user, copies the code to `/opt/braincore`, generates `NMQ_CLUSTER_SECRET` and
`BRAINCORE_ADMIN_KEY` into `/etc/braincore/braincore.env`, writes per-node env files, installs the systemd units
and the nginx site, starts the swarm, and runs the acceptance check.

Bundled units:

* `deploy/braincore-node@.service` — template, one node per port (`braincore-node@8002`, `@8003`).
* `deploy/braincore-api.service` — node `:8001` **plus** the API/live facade on `:8081`.
* `deploy/nginx-braincore.conf` — `api.` (REST, rate-limited) and `live.` (WebSocket upgrade, no buffering).

Every node needs the same `NMQ_CLUSTER_SECRET`: it signs gossip frames and derives the AES-256-GCM key for task
payloads. Rotate during a maintenance window and restart all nodes together.

---

## 5. API and live surface

| Endpoint | Purpose |
|---|---|
| `GET /health`, `GET /status`, `GET /metrics` | Liveness, membership, counters (used by the landing page) |
| `POST /task` | Submit work; optional `x-api-key`; CORS restricted to `braincore.pro` |
| `GET /tasks` | Known tasks, results, CRDT snapshot |
| `POST /v1/fitness` | Edge reports fitness (HMAC-signed, metrics only) |
| `GET /v1/genome/best?k=1` | Winning genome from the top 10 % (respects `minSamples`) |
| `POST /v1/stripe/webhook` | Stripe → API key issuance |
| `GET /v1/keys`, `POST /v1/keys/:id/revoke` | Admin key required (`BRAINCORE_ADMIN_KEY`) |
| `GET /live`, `GET /live.js`, `WS /events` | Live swarm visualisation and feed |

---

## 6. WebSocket live feed (zero npm)

`src/live/ws.js` implements RFC 6455 directly: `Sec-WebSocket-Accept` handshake, frame parsing (7/16/64-bit
lengths, client unmasking), text/ping/pong/close frames and broadcast. `src/live/feed.js` builds one snapshot per
second (nodes with status and load, pheromones with their *current* decayed strength, tasks, results, counters)
and pushes an event immediately when a task completes, fails or a membership change occurs. `src/api/live.js`
draws it on a canvas: nodes as glowing points, links between live peers, pheromone trails fading with strength,
task particles travelling to the pool. `?demo=1` renders a synthetic swarm for screenshots and offline demos.

---

## 7. Genome Registry (edge → central)

An edge node measures locally and sends exactly:

```json
{ "node_id": "edge-us-1", "genome_id": "genom-B", "fitness": 0.87,
  "tasks_done": 142, "pheromone_efficiency": 0.92, "tenant_hash": "…", "ts": 1770000000000, "sig": "<hmac>" }
```

The registry rejects any additional field and any string longer than 128 characters (a plausible side channel),
verifies the HMAC, ranks genomes, applies `minSamples` so noise cannot win, keeps the top 10 % and serves the
winning blob back. `tenant_hash` is `sha256(salt:tenantId)` truncated to 16 hex chars — pseudonymisation, **not**
legal anonymisation. Hot-swap of a genome is a proposal unless `autoHotSwap` is explicitly enabled; applied
changes go through the control plane and keep a rollback version.

---

## 8. Stripe (billing → API key) — **currently disabled on the site by decision**

**Status:** the site shows "Talk to us — request access" (mailto) instead of a card checkout, and no Stripe link is
configured. The payment code path exists, is wired and is covered by tests, so it can be switched on the moment the
live Stripe account exists: replace the `#checkout` href in `site/index.html` with the Payment Link and point its
success URL at `https://braincore.pro/thanks.html`.

When you enable it:

1. Create the $999/mo price (and, if you bill metered usage, the $0.12/agent-hour meter).
2. Webhook endpoint: `https://api.braincore.pro/v1/stripe/webhook`, events `checkout.session.completed` and
   `customer.subscription.created`.
3. Copy the signing secret into `/etc/braincore/braincore.env` as `STRIPE_WEBHOOK_SECRET`; restart `braincore-api`.
4. Flow: verify `Stripe-Signature` (`t=<ts>,v1=<hmac>` over `t.payload`, 300 s tolerance) → ignore duplicate event
   ids → issue key → store only its SHA-256 hash in `data/_control/api-keys.json` → return the plaintext key exactly
   once.
5. Admin endpoints require `BRAINCORE_ADMIN_KEY`; revoking a key takes effect immediately, including in other
   processes (the file is re-read when its mtime changes).

$999/mo and $0.12/agent-hour are the **planned** prices from the brief; the code contains no revenue figures.

---

## 9. Acceptance test

```bash
# 1. three nodes find each other in under 2 seconds
journalctl -u braincore-api -n 20 | grep -i 'node.started\|SYNCED'
curl -s http://127.0.0.1:8081/status | jq '{nodeId, peersAlive, alive}'
#    expect: peersAlive 2, three node ids

# 2. a task submitted to one node is executed by a freer node
curl -s -X POST http://127.0.0.1:8081/task -H 'content-type: application/json' \
     -d '{"type":"support.ticket","payload":{"text":"acceptance"},"value":10}' | jq '{accepted, node}'
sleep 2 && curl -s http://127.0.0.1:8081/tasks | jq '.done'
#    expect: a result whose nodeId differs from the submitting node when it is busier

# 3. pheromones decay and expire (TTL 30 s)
curl -s http://127.0.0.1:8081/metrics | jq '.pheromones'
sleep 31 && curl -s http://127.0.0.1:8081/metrics | jq '.pheromones.active'
#    expect: active: 0

# 4. public surface
curl -s https://api.braincore.pro/health | jq .
curl -sI https://live.braincore.pro/live | head -1

# 5. Stripe webhook (locally, without touching Stripe)
node -e "import('./src/api/stripe.js').then(async (m)=>{
  const body=JSON.stringify({id:'evt_local',type:'checkout.session.completed',data:{object:{id:'cs_1',amount_total:99900}}});
  console.log(m.signPayload({rawBody:body,secret:process.env.STRIPE_WEBHOOK_SECRET}));
})"
```

The same acceptance is enforced automatically by `tests/3-nodes.test.mjs` (discovery, cross-node hand-off,
atomic claim, CRDT convergence, TTL/decay) and `tests/braincore.test.mjs` (WebSocket handshake and broadcast, API
routes, CORS, rate limit, key issuance/revocation, Stripe signatures, Genome Registry, cluster facades).

---

## 10. Operations

```bash
journalctl -u braincore-api -f          # API + live feed
journalctl -u braincore-node@8002 -f    # one swarm node
systemctl restart braincore-api         # after env changes
systemctl status 'braincore-node@*'

tar czf /opt/backup/braincore-$(date +%F).tgz -C /opt/braincore data   # tenants, audit chain, issued keys
```

Watch these numbers: `peersAlive` (should be node count − 1), `gossip.rejected` (spikes ⇒ secret mismatch),
`gossip.rateLimited` (flooding or a loop), `pheromones.active`, `crdtSize` (board growth), `liveClients`.

Backup rule from the workspace notes still applies: back up data before any deploy, and never commit `.env`.

---

## 11. What is NOT covered (honest)

| Item | Why | Plan |
|---|---|---|
| DNS + SSL | hPanel and certbot require your account access | Do it manually with §2/Hostinger; the agent can verify with `dig`/`curl` afterwards |
| Stripe account, price ID, webhook secret | Yours to create; the agent must not hold card or payout data | §8, then paste the secret into `/etc/braincore/braincore.env` |
| TLS between nodes | Payloads are AES-256-GCM encrypted and frames HMAC-signed, but transport is plain UDP | Run the swarm on a private network or WireGuard; mTLS is future work |
| Redis in the default install | Optional by design: memory + file store work on one machine | `NMQ_REDIS_URL` + `redis-server` for the shared queue |
| Docker images | systemd is the reference path | Container files are easy to add later; nothing depends on them |
| CI pipeline | Tests run locally with `node --test` | Add a GitHub Actions job running `node --test` |
| Multi-tenant billing enforcement | Keys are bound to a tenant, quotas are enforced at the policy layer | Add per-key rate limits and usage metering per key |
| The `image_20260930_112600.webp` hero | That file lives in another environment; we shipped our own Genesis Brain render | Drop your file at `site/assets/brain-hero.png` (or `.webp`) and update the `<img src>` |

---

## Open questions

1. Do you want the swarm on **three separate CX11 machines** (survives a host failure) or three processes on one
   CPX21 (cheaper, same demo behaviour)?
2. Should `live.braincore.pro` be public to everyone, or behind a token/allowlist while you demo to buyers?
3. Which Stripe object do you prefer: a simple **Payment Link** (fastest) or a Checkout Session minted per tenant
   (needed for metered billing and tenant-specific keys)?
4. Is `sales@braincore.pro` a real mailbox yet, or should the site temporarily use your personal address?
5. Do you want the pre-payment HTTP API open (demo tenant) or key-only from day one?
6. Who gets `BRAINCORE_ADMIN_KEY` — only you, or also a future ops person (then we add roles instead of one key)?
7. Do we publish the honest limitations section (§11 and the site's "Honest limits" line) to buyers as-is? It
   tests well with technical buyers and costs nothing to defend.

---

## 12. STATUS: sajt je ŽIV na braincore.pro (30.09.2026)

Postavljeno preko `scripts/deploy-site.mjs`:

| Provjera | Rezultat |
|---|---|
| `https://braincore.pro/` | **HTTP 200**, 37.707 B, sadrži „Genesis Brain", „Decentralized AI", „Talk to us", „$999" |
| `/docs.html` | HTTP 200 (10.376 B) |
| `/privacy.html` · `/terms.html` | HTTP 200 |
| `/script.js` · `/favicon.svg` | HTTP 200 |
| `/assets/brain-hero.png` | HTTP 200 (781 KB) |

**DNS stanje (izmjereno):**
* `braincore.pro` → **93.127.179.103** i **77.37.53.223** (dva A zapisa)
* `www.braincore.pro` → **77.37.83.126** i **91.108.98.155** (dva A zapisa)
* `api.braincore.pro`, `live.braincore.pro` → **još nemaju zapise** (Hetzner dio nije u DNS-u)

Preporuka: ostaviti **jedan** A zapis po imenu (dva rade, ali unose neodređenost) i dodati `api`/`live` → Hetzner IP.

**Iskreno o jednoj grešci pri deployu:** moja predprovjera je pogrešno zaključila da je postojeći sadržaj „naš"
(gledala je da li fajl `index.html` postoji, a ne marker u njemu), pa je tvoja **„Braincore — Coming Soon"**
stranica prepisana **bez bekapa**. `.htaccess` i `swarm.png` su ostali netaknuti. Greška je popravljena:
preflight sada provjerava **marker**, a `--backup` režim sklanja tuđi sadržaj u `~/domains/<domen>/_osnova-<datum>/`
prije uploada. Ako želiš Coming Soon stranicu nazad (npr. kao `soon.html`), mogu je rekonstruisati za 5 minuta.

---

## 13. STATUS: MAŠINA JE ŽIVA na Hetzneru (30.09.2026) — sajt + API + live

Postavljeno od strane agenta, bez ručnih koraka (osim mailboxa). Hostinger API token je korišten za DNS.

### DNS (Hostinger API, zona braincore.pro)
| Ime | Tip | Vrijednost |
|---|---|---|
| `@` | ALIAS | `braincore.pro.cdn.hstgr.net.` (Hostinger CDN) |
| `www` | CNAME | `www.braincore.pro.cdn.hstgr.net.` |
| **`api`** | **A** | **62.238.35.78** (Hetzner) — dodato preko API-ja |
| **`live`** | **A** | **62.238.35.78** (Hetzner) — dodato preko API-ja |

### Mašina (Hetzner, 62.238.35.78)
* Node **v22.23.2** (već bio — NodeSource nije trebao), bez npm zavisnosti u projektu
* Instalirano: nginx, redis-server, certbot (+ python3-certbot-nginx), rsync
* **ufw je bio aktivan i propuštao samo SSH** → otvoreni `80/tcp` i `443/tcp`.
  **Portovi 8081 i 8001–8003 su i dalje zatvoreni spolja** (API i roj su iza nginxa, odnosno na loopback-u).
* Servisi: `braincore-api` (node :8001 + API/live :8081), `braincore-node@8002`, `braincore-node@8003` — svi **active**
* Postojeći servisi **netaknuti**: `nmq-server`, `oaa-trial`, `cloudflared` (svi i dalje active)
* Kod: `/root/braincore-src` → `/opt/braincore` (data izvan releases)
* SSL: Let's Encrypt za `api.braincore.pro` i `live.braincore.pro`, auto-renew uključen

### Prijemni test (izmjereno spolja, preko interneta)
| Provjera | Rezultat |
|---|---|
| `https://api.braincore.pro/health` | **HTTP 200** (`npmDependencies: 0`) |
| `https://live.braincore.pro/live` | **HTTP 200** |
| `wss://live.braincore.pro/events` | **HTTP/1.1 101 Switching Protocols** (+ `sec-websocket-accept`) |
| Roj | **3 čvora** (`peersAlive=2`, `alive: node-8001 · node-8002 · node-8003`) |
| Task preko interneta | prihvaćen, **`durable: true`**, potvrdio `node-8003`, izvršio **node-8003** (cross-node) |
| Prometheus | `braincore_nodes 3`, `braincore_tasks_done_total`, `braincore_queue_depth` |
| Sajt | `https://braincore.pro/` HTTP 200 |

### Šta je ostalo ručno (jedina dvije stavke)
1. **Mailboxi** `sales@` i `privacy@braincore.pro` — hPanel → Email → Create account (API token ne pokriva email hosting).
2. **Stripe** (opciono, kada bude nalog): `STRIPE_WEBHOOK_SECRET` u `/etc/braincore/braincore.env` → `systemctl restart braincore-api`.

### Ops komande na mašini
```bash
journalctl -u braincore-api -f
bash /opt/braincore/current/deploy/alertcheck.sh      # API, peers, red, odbijeni potpisi, systemd
bash /opt/braincore/current/deploy/release.sh         # nova verzija + backup podataka
bash /opt/braincore/current/deploy/rollback.sh        # povratak (<60 s)
```

---

## 14. CHAOS DUGME (KILL NODE) — živo na live.braincore.pro (30.09.2026)

### Kako radi
1. Posjetilac na `https://live.braincore.pro/live` uključi **CHAOS MODE** (potvrda) i pritisne **KILL NODE**.
2. `POST /v1/chaos/kill` izabere **živi peer** (nikad čvor koji drži API), pošalje mu `POST /shutdown`
   (ruta je isključena osim ako je `NMQ_ALLOW_SHUTDOWN=1`).
3. Čvor se ugasi, a **systemd (`Restart=always`) ga vrati** u roku od ~2 s.
4. Dashboard uživo prikazuje: hex postane crven, posao preuzme slobodniji peer, pa čvor ponovo uđe u roj.

### Zaštite (fail-safe)
| Mjera | Vrijednost |
|---|---|
| Naoružavanje | `ALLOW_CHAOS_KILL=1` u `/etc/braincore/braincore.env` (bez toga ruta vraća 403) |
| Rate limit | **1 ubijanje u 60 s** (429 sa `retryInMs`) |
| Nikad API čvor | bira se samo peer iz membership-a |
| Audit | svako ubijanje ide u hash-chained audit log |
| UI | „arm" + `confirm()` prije izvršenja; dugme se zaključava 3 s poslije klika |

### Izmjereno (stvarni klik, preko interneta)
| Faza | Vrijeme |
|---|---|
| Prihvatanje zahtjeva | **39 ms** |
| Detekcija smrti (peer → `suspect`) | **2 207 ms** |
| Povratak u roj (`alive`) | **3 209 ms** |
| Ukupno (kill → rejoin) | **3,2 s** |

### Dvije prave greške koje je ovaj deploy otkrio (i koje su popravljene)
1. **systemd jedinice nisu koristile `current/`** — radile su iz statičnog `/opt/braincore`, pa `release.sh`
   nije imao efekta (nova verzija na disku, stara u procesu). Popravljeno: `WorkingDirectory`/`ExecStart`
   pokazuju na `/opt/braincore/current`, a `install.sh` odmah pravi `current` symlink.
2. **`import.meta.url` vs symlink** — kad se kod pokreće preko symlinka, Node razriješi put, pa poređenje sa
   `process.argv[1]` padne i CLI blok se **nikad ne izvrši** (proces izađe sa statusom 0). Popravljeno:
   `fs.realpathSync(process.argv[1])` prije poređenja.

### Poznato ograničenje (iskreno)
Brojači (`swarmTasksDone`, `tasksDone`) su **per-process** i resetuju se kad se čvor restartuje — zato poslije
ubijanja dashboard kratko pokazuje manje „done". Trajni brojači (u `data/` ili Redis-u) su sljedeći zadatak.

---

## 15. Dopuna dashboarda poslije referentnog mockupa (30.09.2026)

Iz referentnog vizuala dodato:
* **`scripts/chaosctl.mjs`** — CLI za isto dugme: `chaosctl status`, `chaosctl kill --random --confirm`
  (koristi isti API, iste zaštite). Izmjereno kroz CLI: detekcija **2162 ms**, povratak **3022 ms**.
* **Eksplicitna sekvenca u logu**: `! NODE-0X termination initiated…` → `DETECTION` → `REJOIN` →
  `integrity: 0 lost · N tasks completed · 0 overlaps — verified`.
* **CPU% i RSS po čvoru** — instrumentacija je u kodu (`selfUsage()` u `src/node.js`, polja `cpuPct`/`rssMb`
  putuju kroz gossip u `src/gossip.js`, prikaz na mapi u `live.js`).

### ⚠️ Otvoreno (iskreno)
Vrijednosti `cpuPct`/`rssMb` **još se ne vide na živom dashboardu** (`/status` ih vraća prazne) iako je kod
deployovan (provjereno `grep`-om na serveru i procesi rade iz `current/`). Sljedeći korak je da se nađe gdje se
polje gubi u lancu `status() → statusPayload() → PING payload → handle() → membership → feed`, pa da se doda
test koji to čuva. Do tada dashboard prikazuje `CPU —` i `RAM —` za peer-ove, a `load`/`tasks` su tačni.

---

## 16. GRAFANA + metrics.braincore.pro (01.10.)

* `deploy/grafana-setup.sh` — instalirao Grafana na **127.0.0.1:3030** (default 3000 je nmq-server, NE dira se).
* DNS `metrics` A → `62.238.35.78` (Hostinger API).
* nginx reverse proxy `/etc/nginx/sites-available/braincore-metrics` → `127.0.0.1:3030`, `noindex`, WebSocket
  (Grafana Live), `/api/health` otvoren. **Bez nginx basic-auth** — vrata je Grafana login (admin/admin → promijeniti).
* `certbot --nginx -d metrics.braincore.pro` (auto-renew).

### Provjereno spolja
* `https://metrics.braincore.pro/api/health` → 200 (Grafana 13.2.3)
* `https://metrics.braincore.pro/` → 200

### Što ostaje za korisnika
1. **Promijeniti Grafana lozinku**: login `admin/admin` → `/admin/users` ili CLI
   `grafana-cli admin reset-admin-password <nova>`.
2. **Import dashboard-a**: `deploy/grafana-dashboard.json` → Dashboards → Import → Upload JSON.
3. **Izvor podataka**: Prometheus scrape `http://127.0.0.1:8081/metrics?format=prom` (svakih 15 s) **ili**
   `data/_control/metrics-history.jsonl` (13 metrika, ~20 h, skuplja `braincore-scrape.timer`).
