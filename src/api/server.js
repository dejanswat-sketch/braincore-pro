/**
 * Public API facade za BRAINCORE PRO (api.braincore.pro) + live feed (live.braincore.pro).
 *
 * Jedan HTTP server (bez npm zavisnosti) radi sve:
 *   GET  /health                     — liveness
 *   GET  /status                     — stanje ovog node-a + membership
 *   POST /task                       — prijem taska od sajta/klijenta (CORS)
 *   GET  /tasks                      — taskovi, rezultati, CRDT
 *   GET  /metrics                    — brojači (JSON)
 *   POST /v1/fitness                 — edge šalje SAMO fitness (Genome Registry)
 *   GET  /v1/genome/best             — najbolji genom (top 10%)
 *   POST /v1/stripe/webhook          — Stripe → izdavanje API ključa
 *   GET  /v1/keys                    — lista ključeva (maskirano; traži admin ključ)
 *   POST /v1/keys/:id/revoke         — opoziv ključa
 *   GET  /live                       — live vizuelizacija (HTML)
 *   GET  /live.js                    — klijentski skript za live
 *   WS   /events                     — WebSocket feed (snapshot + eventi)
 *
 * CORS je ograničen na `corsOrigins` (default: braincore.pro i localhost) — po smernicama.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from '../live/ws.js';
import { createLiveFeed } from '../live/feed.js';
import { createKeyIssuer, handleStripeWebhook } from './stripe.js';
import { createGenomeRegistry } from '../research/genome-registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const API_DEFAULTS = {
  host: '127.0.0.1',
  port: 8081,
  corsOrigins: ['https://braincore.pro', 'https://www.braincore.pro', 'http://localhost:8080', 'http://127.0.0.1:8080'],
  maxBodyBytes: 512 * 1024,
  rateLimitPerMin: 240,
  stripeToleranceSec: 300,
};

export async function createApiServer({ node, registry = null, keyIssuer = null, config = {}, logger, metrics, audit, env = process.env } = {}) {
  if (!node) throw new Error('createApiServer traži swarm node');
  const cfg = { ...API_DEFAULTS, ...(config ?? {}) };
  const genomeRegistry = registry ?? createGenomeRegistry({ secret: env.NMQ_CLUSTER_SECRET ?? node.gossip?.settings?.secret ?? 'braincore-registry-secret', logger, metrics, audit });
  const issuer = keyIssuer ?? createKeyIssuer({ dataDir: cfg.dataDir ?? null, logger, metrics, audit });
  const feed = createLiveFeed({ node, config: cfg.feed ?? {}, logger, metrics });
  const rateWindow = [];
  const startedAt = Date.now();

  // Live feed: kad se nešto desi u roju, pošalji event svim WS klijentima
  node.on('done', (r) => feed.push('task_done', r));
  node.on('failed', (r) => feed.push('task_failed', r));
  node.on('task', (t) => feed.push('task_seen', { taskId: t.id, type: t.type, origin: t.origin }));
  node.gossip.on('membership', (m) => feed.push('membership', { nodeId: m.nodeId, status: m.status, load: m.load }));

  function corsHeaders(origin) {
    const allowed = cfg.corsOrigins.includes(origin) || cfg.corsOrigins.includes('*');
    return {
      'access-control-allow-origin': allowed ? origin : cfg.corsOrigins[0],
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization,x-api-key',
      'access-control-max-age': '600',
      vary: 'origin',
      ...(allowed ? {} : { 'x-cors-blocked': '1' }),
    };
  }

  function allowRate() {
    const now = Date.now();
    while (rateWindow.length && now - rateWindow[0] > 60_000) rateWindow.shift();
    if (rateWindow.length >= cfg.rateLimitPerMin) return false;
    rateWindow.push(now);
    return true;
  }

  async function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > cfg.maxBodyBytes) {
          reject(Object.assign(new Error('Tijelo zahtjeva je preveliko'), { code: 'PAYLOAD_TOO_LARGE' }));
          req.destroy();
        }
      });
      req.on('end', () => resolve(raw));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin ?? '';
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const send = (code, body, extra = {}) => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
      res.writeHead(code, {
        'content-type': typeof body === 'string' && body.startsWith('<!doctype') ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        'x-powered-by': 'braincore-pro/swarm (zero-npm)',
        ...corsHeaders(origin),
        ...extra,
      });
      res.end(payload);
    };

    if (req.method === 'OPTIONS') return send(204, '');
    if (!allowRate()) return send(429, { error: { code: 'RATE_LIMITED', message: 'Previše zahtjeva; pokušaj ponovo za minut.' } });

    try {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        return send(200, { ok: true, service: 'braincore-pro-api', nodeId: node.nodeId, uptimeMs: Date.now() - startedAt, npmDependencies: 0 });
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        return send(200, { ...node.stats(), membership: node.gossip.membershipList(), liveClients: ws.clientCount() });
      }
      if (req.method === 'GET' && url.pathname === '/tasks') {
        return send(200, { tasks: [...node.tasks.values()], done: node.done.slice(-100), crdt: node.crdt.toObject() });
      }
      if (req.method === 'GET' && url.pathname === '/metrics' && (url.searchParams.get('format') === 'prom' || String(req.headers.accept ?? '').includes('text/plain'))) {
        // Prometheus text format (v0.0.4) — bez npm klijenta, samo tekst
        const stats = node.stats();
        const m = [];
        const put = (name, help, type, value, labels = '') => m.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name}${labels} ${value}`);
        put('braincore_peers_alive', 'Broj živih peer-ova u roju', 'gauge', stats.peersAlive);
        put('braincore_nodes', 'Ukupan broj čvorova u roju', 'gauge', stats.swarmNodes);
        put('braincore_tasks_known', 'Poznati taskovi', 'gauge', stats.tasksKnown);
        put('braincore_tasks_done_total', 'Završeni taskovi (cijeli roj)', 'counter', stats.swarmTasksDone);
        put('braincore_tasks_done_local', 'Završeni taskovi na ovom čvoru', 'counter', stats.tasksDone);
        put('braincore_load', 'Zadaci u izvršenju na ovom čvoru', 'gauge', stats.load);
        put('braincore_crdt_entries', 'Zapisa u CRDT tabli', 'gauge', node.crdt.size);
        put('braincore_crdt_tombstones', 'Tombstone zapisa u CRDT tabli', 'gauge', node.crdt.stats().deleted);
        put('braincore_pheromones_active', 'Aktivnih feromona', 'gauge', node.pheromone.stats().active);
        put('braincore_queue_depth', 'Taskova koji čekaju u redu', 'gauge', stats.queue?.queued ?? 0);
        put('braincore_live_clients', 'Povezanih live (WS) klijenata', 'gauge', ws.clientCount());
        put('braincore_gossip_sent_total', 'Poslanih gossip poruka', 'counter', node.gossip.stats.sent);
        put('braincore_gossip_received_total', 'Primljenih gossip poruka', 'counter', node.gossip.stats.received);
        put('braincore_gossip_rejected_total', 'Odbijenih gossip poruka (potpis/tip)', 'counter', node.gossip.stats.rejected);
        put('braincore_gossip_rate_limited_total', 'Odbijenih zbog rate limita', 'counter', node.gossip.stats.rateLimited ?? 0);
        put('braincore_gossip_prev_key_total', 'Prihvaćenih potpisa STARIM ključem (rotacija)', 'counter', node.gossip.stats.acceptedWithPrevKey ?? 0);
        put('braincore_uptime_seconds', 'Vrijeme rada čvora', 'gauge', Math.round(stats.uptimeMs / 1000));
        return send(200, `${m.join('\n')}\n`, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      }      if (req.method === 'GET' && url.pathname === '/metrics') {
        const stats = node.stats();
        return send(200, {
          peersAlive: stats.peersAlive,
          swarmNodes: stats.swarmNodes,
          tasksKnown: stats.tasksKnown,
          tasksDone: stats.swarmTasksDone, // roj-široko (svi čvorovi), isto kao na sajtu
          tasksDoneLocal: stats.tasksDone,
          crdtSize: node.crdt.size,
          pheromones: node.pheromone.stats(),
          gossip: node.gossip.stats,
          liveClients: ws.clientCount(),
          rateWindow: rateWindow.length,
        });
      }
      if (req.method === 'POST' && url.pathname === '/task') {
        const raw = await readBody(req);
        let body;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return send(400, { error: { code: 'BAD_JSON', message: 'Tijelo nije JSON' } });
        }
        // Opciona autentikacija ključem (ključ se izdaje posle Stripe plaćanja)
        const apiKey = req.headers['x-api-key'] ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') ?? null;
        if (apiKey) {
          const record = await issuer.verify(apiKey);
          if (!record) return send(401, { error: { code: 'INVALID_KEY', message: 'API ključ nije važeći ili je opozvan' } });
          body.tenantId = body.tenantId ?? record.tenantId;
        }
        if (!body.type && !body.title) return send(400, { error: { code: 'VALIDATION_ERROR', message: 'Task traži "type" (ili "title")' } });
        const task = await node.submitTask(body);
        metrics?.inc('api_tasks_accepted_total', {});
        return send(200, { accepted: true, task: { ...task, payload: undefined }, node: node.nodeId });
      }
      if (req.method === 'POST' && url.pathname === '/v1/fitness') {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(400, { error: { code: 'BAD_JSON', message: 'Tijelo nije JSON' } });
        }
        const result = genomeRegistry.report(body);
        return send(200, result);
      }
      if (req.method === 'GET' && url.pathname === '/v1/genome/best') {
        const k = Number(url.searchParams.get('k') ?? 1);
        const update = genomeRegistry.bestUpdate({ k });
        return send(update.update ? 200 : 404, update);
      }
      if (req.method === 'GET' && url.pathname === '/v1/registry/stats') {
        return send(200, { stats: genomeRegistry.stats(), reports: genomeRegistry.history({ limit: 50 }) });
      }
      if (req.method === 'POST' && url.pathname === '/v1/stripe/webhook') {
        const raw = await readBody(req);
        const result = await handleStripeWebhook({
          rawBody: raw,
          signature: req.headers['stripe-signature'],
          secret: env.STRIPE_WEBHOOK_SECRET,
          issuer,
          logger,
          metrics,
          toleranceSec: cfg.stripeToleranceSec,
        });
        return send(result.status, result.body);
      }
      if (req.method === 'GET' && url.pathname === '/v1/keys') {
        const admin = env.BRAINCORE_ADMIN_KEY ?? null;
        const provided = req.headers['x-api-key'] ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!admin || provided !== admin) return send(401, { error: { code: 'ADMIN_REQUIRED', message: 'Traži se BRAINCORE_ADMIN_KEY' } });
        return send(200, { keys: await issuer.list() });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/v1/keys/') && url.pathname.endsWith('/revoke')) {
        const admin = env.BRAINCORE_ADMIN_KEY ?? null;
        const provided = req.headers['x-api-key'] ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!admin || provided !== admin) return send(401, { error: { code: 'ADMIN_REQUIRED', message: 'Traži se BRAINCORE_ADMIN_KEY' } });
        const id = url.pathname.split('/')[3];
        return send(200, { revoked: await issuer.revoke(id, { by: 'admin' }) });
      }
      if (req.method === 'GET' && (url.pathname === '/live' || url.pathname === '/live/')) {
        const html = await readFile(path.join(HERE, 'live.html'), 'utf8');
        return send(200, html, { 'content-type': 'text/html; charset=utf-8' });
      }
      if (req.method === 'GET' && url.pathname === '/live.js') {
        const js = await readFile(path.join(HERE, 'live.js'), 'utf8');
        return send(200, js, { 'content-type': 'application/javascript; charset=utf-8' });
      }
      return send(404, { error: { code: 'NOT_FOUND', message: `Nema rute ${url.pathname}` } });
    } catch (err) {
      const status = err.status ?? (err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 500);
      if (status === 429) res.setHeader('retry-after', '1');
      logger?.warn?.('api.request_failed', { path: url.pathname, error: err.message, code: err.code ?? null });
      // `toJSON()` nosi i `retryable` i `details` (npr. QUEUE_FULL nosi prag reda i trenutnu dubinu)
      return send(status, typeof err.toJSON === 'function' ? err.toJSON() : { error: { code: err.code ?? 'INTERNAL', message: err.message } });
    }
  });

  const ws = attachWebSocket(server, { path: '/events', logger, metrics, onClient: (client) => client.send(feed.snapshot()) });
  feed.start((payload) => ws.broadcast(payload));

  return {
    server,
    ws,
    feed,
    registry: genomeRegistry,
    keys: issuer,
    settings: cfg,

    async listen({ port = cfg.port, host = cfg.host } = {}) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(true));
      });
      const addr = server.address();
      logger?.info?.('api.listening', { host: addr.address, port: addr.port, nodeId: node.nodeId, livePath: '/live', wsPath: '/events' });
      return { host: addr.address, port: addr.port };
    },

    async close() {
      feed.stop();
      ws.close();
      await new Promise((resolve) => server.close(resolve));
      return true;
    },

    /** Test hook: HTTP handler bez mreže. */
    fetch: (url, init) => {
      // Mali in-process klijent (koristi se u testovima kad je server već na portu 0)
      return fetch(`http://127.0.0.1:${server.address()?.port}${url}`, init);
    },
  };
}
