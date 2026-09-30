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

## 8. Stripe (billing → API key)

1. Create the $999/mo price (and, if you bill metered usage, the $0.12/agent-hour meter).
2. Webhook endpoint: `https://api.braincore.pro/v1/stripe/webhook`, events `checkout.session.completed` and
   `customer.subscription.created`.
3. Copy the signing secret into `/etc/braincore/braincore.env` as `STRIPE_WEBHOOK_SECRET`; restart
   `braincore-api`.
4. Flow: verify `Stripe-Signature` (`t=<ts>,v1=<hmac>` over `t.payload`, 300 s tolerance) → ignore duplicate
   event ids → issue key → store only its SHA-256 hash in `data/_control/api-keys.json` → return the plaintext key
   exactly once.
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
