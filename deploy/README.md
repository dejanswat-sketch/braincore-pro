# Braincore Pro — deployment (Hetzner + Hostinger)

Everything here is zero-dependency: Node built-ins only. The machine never runs `npm install`.

```
deploy/
├── install.sh                  # one-shot installer for Ubuntu 22.04/24.04 (Node 20, nginx, Redis, systemd)
├── braincore.env.example       # environment template (copy to /etc/braincore/braincore.env)
├── braincore-node@.service     # systemd template: one swarm node per port (8001/8002/8003)
├── braincore-api.service       # systemd unit: node :8001 + public API/live facade on :8081
├── nginx-braincore.conf        # api.braincore.pro (REST) + live.braincore.pro (WebSocket upgrade)
└── README.md                   # this file
```

## 0. Topology

| Host | Role | What runs |
|---|---|---|
| Hostinger (shared) | Static site | `site/` — `braincore.pro`, `www` |
| Hetzner CX11/CPX11 ×3 | Swarm machine | 3 swarm nodes (:8001/:8002/:8003, UDP gossip + HTTP admin) |
| Hetzner (same box) | Public surface | API + live feed on :8081, exposed by nginx as `api.` and `live.` |

The static site calls `https://api.braincore.pro`; the browser opens `https://live.braincore.pro` for the
WebSocket feed. Neither touches the swarm nodes directly.

## 1. DNS (Hostinger hPanel)

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `@` | Hostinger IP | 300 |
| A | `www` | Hostinger IP | 300 |
| A | `api` | Hetzner IP | 300 |
| A | `live` | Hetzner IP | 300 |

Then enable SSL for `braincore.pro` + `www` in hPanel (free Let's Encrypt), and on the Hetzner box run:

```bash
certbot --nginx -d api.braincore.pro -d live.braincore.pro
```

Verify propagation before running certbot:

```bash
dig +short api.braincore.pro live.braincore.pro
```

## 2. Site (Hostinger)

1. Upload the contents of `site/` into `public_html/` (File Manager → Upload, or unzip an archive).
2. Replace `REPLACE_WITH_YOUR_PAYMENT_LINK` in `index.html` with your Stripe Payment Link.
3. Point that Payment Link's success URL at `https://braincore.pro/thanks.html`.
4. Keep `robots.txt`, `sitemap.xml` and `favicon.svg` at the web root.

Files served: `index.html`, `docs.html`, `privacy.html`, `terms.html`, `thanks.html`, `script.js`,
`favicon.svg`, `robots.txt`, `sitemap.xml`, `assets/brain-hero.png` (+ `-2x`), `assets/live-preview.png`.

## 3. Machine (Hetzner)

```bash
scp -r . root@<HETZNER_IP>:/root/braincore-src
ssh root@<HETZNER_IP> 'bash /root/braincore-src/deploy/install.sh'
```

The installer:

1. installs Node 20, nginx, Redis, certbot (runtime only — no npm packages),
2. creates the `braincore` system user and `/opt/braincore`,
3. copies the code, generates `NMQ_CLUSTER_SECRET` and `BRAINCORE_ADMIN_KEY` into `/etc/braincore/braincore.env`,
4. writes per-node env files (`node-8001.env`, `node-8002.env`, `node-8003.env`),
5. enables `braincore-api.service` + `braincore-node@8002`, `@8003`,
6. runs the acceptance check.

Manual equivalent:

```bash
sudo -u braincore NMQ_CLUSTER_SECRET=<secret> node src/index.js --port=8001 --api-port=8081
sudo -u braincore NMQ_CLUSTER_SECRET=<secret> node src/index.js --port=8002 --peers=127.0.0.1:8001
sudo -u braincore NMQ_CLUSTER_SECRET=<secret> node src/index.js --port=8003 --peers=127.0.0.1:8001,127.0.0.1:8002
```

> Every node needs the **same** `NMQ_CLUSTER_SECRET`. Rotate it only during a maintenance window and restart all
> nodes together, because it signs gossip frames and derives the payload encryption key.

## 4. Acceptance test

```bash
# 3 nodes discover each other (<2s) and the task moves to a freer peer
curl -s http://127.0.0.1:8081/status | jq '{nodeId, peersAlive, alive}'
curl -s -X POST http://127.0.0.1:8081/task -H 'content-type: application/json' \
     -d '{"type":"support.ticket","payload":{"text":"acceptance"},"value":10}' | jq '{accepted, node}'
sleep 2
curl -s http://127.0.0.1:8081/tasks | jq '.done'

# pheromones decay (they drop out of /metrics after the 30s TTL)
curl -s http://127.0.0.1:8081/metrics | jq '.pheromones'

# public surface
curl -s https://api.braincore.pro/health | jq .
curl -sI https://live.braincore.pro/live | head -1
```

Expected: `peersAlive: 2`, at least one entry in `.done` executed by a node other than the one that received the
task, and `pheromones.active` returning to `0` about 30 s after the last deposit.

## 5. Stripe (billing → API key)

1. Create a **Payment Link** (or Price) for $999/mo; metered agent-hours are billed at $0.12/agent-hour.
2. In Stripe → Developers → Webhooks add `https://api.braincore.pro/v1/stripe/webhook`, event
   `checkout.session.completed` and `customer.subscription.created`.
3. Put the signing secret into `/etc/braincore/braincore.env` as `STRIPE_WEBHOOK_SECRET` and restart
   `braincore-api`.
4. On payment the endpoint verifies the `Stripe-Signature` (HMAC-SHA256 over `t.payload`, 300 s tolerance),
   ignores duplicate event ids, and returns the issued API key **once**. Only a SHA-256 hash is stored in
   `data/_control/api-keys.json`.
5. Admin endpoints (`GET /v1/keys`, `POST /v1/keys/:id/revoke`) require `BRAINCORE_ADMIN_KEY`.

## 6. Operations

```bash
journalctl -u braincore-api -f            # API + live feed
journalctl -u braincore-node@8002 -f      # a single node
systemctl restart braincore-api
systemctl status 'braincore-node@*'

# backups (data/ holds tenants, audit chain, issued keys)
tar czf /opt/backup/braincore-$(date +%F).tgz -C /opt/braincore data
redis-cli --version && redis-cli info server | head -3
```

Watch: `peersAlive` (should equal node count − 1), `gossip.rejected` (spikes mean a secret mismatch),
`gossip.rateLimited` (flooding or a loop), `pheromones.active` and `crdtSize` (board growth).

## 7. What is intentionally not here

- No npm packages, no bundler, no Docker requirement (containers are fine, but systemd is the reference).
- No TLS between nodes yet: run the swarm on a private network or inside WireGuard; payloads are encrypted and
  frames are signed, but the transport itself is not.
- No CI pipeline in this folder; the test suite runs with `node --test`.
