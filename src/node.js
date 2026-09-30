/**
 * Swarm NODE — jedan proces u roju. Nema mastera: svaki node je ravnopravan.
 *
 * `node src/index.js --port=8001 --peers=127.0.0.1:8002,127.0.0.1:8003`
 *
 * Sastav (po smernicama):
 *   • UDP gossip (dgram)      — ko je živ, koliko je opterećen  → `src/gossip.js`
 *   • CRDT blackboard         — dijeljeno stanje taskova i claim-ova (LWW + vektorski sat)
 *   • Task queue (LPUSH/BRPOP)— lokalni red; može i preko RESP-a (`src/shared/queue.js`)
 *   • Pheromone (TTL + decay) — tragovi koji koordiniraju bez komande
 *
 * Ključno ponašanje: **task ubačen u node A završava u node B ako je B slobodniji.**
 *   – A objavi task u CRDT (`task:<id>`) i pošalje ga gossip-om (piggyback uz PING)
 *   – svaki node vidi task; CLAIM ide kroz CRDT (deterministički LWW pobjednik)
 *   – node se prijavljuje za claim samo ako je **najslobodniji** (load ≤ najmanji load među živima)
 *   – poslije claim-a slijedi kratka verifikacija (ako je neko drugi pobijedio, node odustaje)
 *
 * Sve bez ijedne npm zavisnosti: `dgram`, `net`, `http`, `crypto`, `events`.
 */
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createGossip } from './gossip.js';
import { createCrdtBlackboard } from './shared/blackboard.js';
import { createPheromoneStore } from './shared/pheromone.js';
import { createTaskQueue } from './shared/queue.js';
import { createTicketRouter } from './support/ticket-router.js';
import { createToolRunner } from './execution/tool-runner.js';
import { createExtractor } from './research/extractor.js';
import { createGenomeRegistry } from './research/genome-registry.js';
import { createFederationClient } from './research/federation.js';
import { encryptPayload, decryptPayload } from './shared/crypto.js';
import { iso } from './core/clock.js';
import { uid } from './core/ids.js';
import { ValidationError } from './core/errors.js';

export const NODE_DEFAULTS = {
  claimIntervalMs: 50,
  syncIntervalMs: 300, // CRDT sync (delta lokalnih zapisa) — nezavisan od claim petlje
  claimConfirmMs: 120, // koliko čekamo da vidimo da li je neko drugi preuzeo isti task
  taskTtlMs: 30_000,
  maxInFlight: 3,
  autoLoop: true, // claim petlja se vrti sama; u testovima se isključuje (deterministički tick)
  encryptTaskPayload: true, // payload taska ide šifrovan preko UDP-a (AES-256-GCM iz tajne klastera)
  httpAdmin: true,
  gossip: {},
};

export async function createSwarmNode({
  nodeId = null,
  port = 8001,
  host = '0.0.0.0',
  advertiseHost = '127.0.0.1',
  peers = [],
  secret,
  tenantId = 'nmq',
  dataDir = null,
  runner = null,
  robot = null,
  config = {},
  logger,
  metrics,
  audit,
  registry = null,
} = {}) {
  const cfg = { ...NODE_DEFAULTS, ...(config ?? {}) };
  const id = nodeId ?? `node-${port}`;
  const emitter = new EventEmitter();
  const tasks = new Map(); // taskId -> task (lokalno poznati)
  const inFlight = new Map();
  const done = [];
  const startedAt = Date.now();

  const crdt = createCrdtBlackboard({ nodeId: id, logger, metrics });
  const pheromone = createPheromoneStore({ logger, metrics, config: { ttlMs: cfg.taskTtlMs, halfLifeMs: Math.max(1000, Math.floor(cfg.taskTtlMs / 3)) } });
  const queue = createTaskQueue({ backend: 'memory', tenantId, logger, metrics, config: { ttlMs: cfg.taskTtlMs, visibilityTimeoutMs: cfg.taskTtlMs * 2 } });

  const load = () => inFlight.size;
  const minPeerLoad = () => {
    const peersAlive = gossip.membershipList().filter((m) => m.nodeId !== id && m.status === 'alive' && m.load !== null);
    if (!peersAlive.length) return null;
    return Math.min(...peersAlive.map((m) => Number(m.load)));
  };

  const gossip = createGossip({
    nodeId: id,
    port,
    host,
    advertiseHost,
    secret,
    peers,
    config: cfg.gossip,
    logger,
    metrics,
    status: () => ({ load: load(), tasksDone: done.length, uptimeMs: Date.now() - startedAt }),
    onMessage: (msg) => {
      if (msg.type === 'DISSEMINATE_ITEM') onDisseminate(msg.payload);
    },
  });

  /** Task bez payload-a — to je ono što smije u CRDT (dijeli se preko mreže). */
  function metaOf(task) {
    const { payload, ...meta } = task;
    return { ...meta, payloadEncrypted: true };
  }

  function onDisseminate(item) {
    if (!item) return;
    if (item.kind === 'crdt') {
      const res = crdt.merge(item.entries);
      if (res.applied) emitter.emit('crdt', res);
      return;
    }
    if (item.kind === 'task' && item.task) {
      // Task sa drugog čvora: payload je ŠIFROVAN (UDP je čist tekst), pa ga dešifrujemo ovdje
      let task = item.task;
      if (item.payloadEnc) {
        try {
          task = { ...item.task, payload: decryptPayload(secret, item.payloadEnc, { aad: item.task.id }) };
        } catch (err) {
          metrics?.inc('node_payload_decrypt_failed_total', {});
          logger?.warn?.('node.payload_decrypt_failed', { taskId: item.task.id, error: err.message });
          return; // bez ključa se task NE izvršava (fail-closed)
        }
      }
      if (!task.payload) task = { ...task, payload: {} };
      if (!crdt.get(`task:${task.id}`)) crdt.set(`task:${task.id}`, task);
      if (!tasks.has(task.id)) tasks.set(task.id, task);
      emitter.emit('task', task);
    }
  }

  /** Objavi task SVIMA: lokalno + CRDT + gossip. */
  async function submitTask(task) {
    const normalized = {
      id: task.id ?? uid('task'),
      type: task.type ?? 'generic',
      payload: task.payload ?? {},
      ttl: Number(task.ttl ?? cfg.taskTtlMs),
      tenantId: task.tenantId ?? tenantId,
      value: Number(task.value ?? 1),
      skills: task.skills ?? [],
      createdAt: iso(),
      origin: id,
    };
    tasks.set(normalized.id, normalized);
    crdt.set(`task:${normalized.id}`, metaOf(normalized)); // u CRDT idu SAMO metapodaci (payload ostaje lokalno)
    await queue.push(normalized);
    // Preko žice ide METAPODACI + ŠIFROVAN payload (UDP je čist tekst; HMAC daje integritet, ne tajnost)
    if (cfg.encryptTaskPayload) {
      const { payload, ...meta } = normalized;
      gossip.broadcast({ kind: 'task', task: { ...meta, payloadEncrypted: true }, payloadEnc: encryptPayload(secret, payload, { aad: normalized.id }) });
    } else {
      gossip.broadcast({ kind: 'task', task: normalized });
    }
    metrics?.inc('node_tasks_submitted_total', { node: id });
    logger?.info?.('node.task_submitted', { nodeId: id, taskId: normalized.id, type: normalized.type });
    return normalized;
  }

  /** Claim u CRDT-u + kratka verifikacija (deterministički LWW pobjednik). */
  async function tryClaim(task) {
    const claimKey = `claim:${task.id}`;
    const existing = crdt.get(claimKey);
    if (existing) return { claimed: false, reason: 'već preuzet', by: existing.nodeId };
    crdt.set(claimKey, { nodeId: id, at: Date.now(), load: load() });
    // Šaljemo SAMO novi claim zapis (ne cijeli snapshot) — ostatak širi periodični CRDT sync
    const fresh = crdt.delta({ [id]: lastBroadcast }).filter((e) => e.nodeId === id);
    if (fresh.length) {
      lastBroadcast = Math.max(...fresh.map((e) => e.counter));
      gossip.broadcast({ kind: 'crdt', entries: fresh });
    }
    await new Promise((r) => setTimeout(r, cfg.claimConfirmMs));
    const winner = crdt.get(claimKey);
    if (!winner || winner.nodeId !== id) {
      metrics?.inc('node_claims_lost_total', { node: id });
      return { claimed: false, reason: 'izgubio trku (LWW)', by: winner?.nodeId ?? null };
    }
    if (inFlight.size >= cfg.maxInFlight) {
      crdt.delete(claimKey);
      return { claimed: false, reason: 'preopterećen' };
    }
    inFlight.set(task.id, { task, at: Date.now() });
    await pheromone.deposit({ tenantId: task.tenantId, type: 'claimed', taskId: task.id, by: id, strength: 0.8 });
    queue.inFlight.set(task.id, { task, at: Date.now() });
    metrics?.inc('node_tasks_claimed_total', { node: id, type: task.type });
    return { claimed: true, task };
  }

  async function runTask(task) {
    const started = Date.now();
    try {
      const output = runner ? await runner(task, { nodeId: id, robot }) : { output: `obrađeno na ${id}` };
      const record = { taskId: task.id, nodeId: id, ok: true, ms: Date.now() - started, output: output?.output ?? null, at: iso() };
      done.push(record);
      crdt.set(`result:${task.id}`, { nodeId: id, ok: true, ms: record.ms, at: record.at });
      crdt.set(`task:${task.id}`, { ...task, state: 'done', doneBy: id });
      await pheromone.deposit({ tenantId: task.tenantId, type: 'done', taskId: task.id, by: id, strength: 1 });
      await queue.ack(task.id, { success: true });
      metrics?.inc('node_tasks_done_total', { node: id, type: task.type });
      emitter.emit('done', record);
      logger?.info?.('node.task_done', { nodeId: id, taskId: task.id, ms: record.ms });
      return record;
    } catch (err) {
      const record = { taskId: task.id, nodeId: id, ok: false, error: err.message, ms: Date.now() - started, at: iso() };
      done.push(record);
      crdt.set(`result:${task.id}`, { nodeId: id, ok: false, error: err.message, at: record.at });
      crdt.delete(`claim:${task.id}`); // vrati task u igru
      await pheromone.deposit({ tenantId: task.tenantId, type: 'problem', taskId: task.id, by: id, strength: 1.5 });
      await queue.ack(task.id, { success: false });
      emitter.emit('failed', record);
      logger?.warn?.('node.task_failed', { nodeId: id, taskId: task.id, error: err.message });
      return record;
    } finally {
      inFlight.delete(task.id);
    }
  }

  /** Jedan ciklus: pogledaj CRDT, claim-uj ako si najslobodniji, izvrši. */
  async function tick() {
    if (inFlight.size >= cfg.maxInFlight) return { idle: true, reason: 'maxInFlight' };
    const myLoad = load();
    const peerMin = minPeerLoad();
    // Ako je neki drugi node slobodniji — NE uzimamo task (task u A završava u B)
    if (peerMin !== null && peerMin < myLoad) return { idle: true, reason: 'peer_freer', myLoad, peerMin };

    // Kandidati: taskovi iz CRDT-a koji nisu preuzeti i nisu završeni
    const candidates = crdt
      .entries()
      .filter((e) => e.key.startsWith('task:'))
      .map((e) => e.value)
      .filter((t) => t && t.state !== 'done' && !inFlight.has(t.id))
      .filter((t) => !crdt.get(`claim:${t.id}`))
      .sort((a, b) => (b.value ?? 1) - (a.value ?? 1) || String(a.createdAt).localeCompare(String(b.createdAt)));

    const task = candidates[0];
    if (!task) return { idle: true, reason: 'nema_posla' };
    const full = tasks.get(task.id) ?? task; // payload je lokalno
    const claim = await tryClaim(full);
    if (!claim.claimed) return { idle: true, reason: claim.reason, by: claim.by ?? null, taskId: task.id };
    const record = await runTask(task);
    return { ran: true, ...record };
  }

  function startLoops() {
    const claimTimer = setInterval(() => {
      tick().catch((err) => logger?.warn?.('node.tick_failed', { error: err.message }));
    }, cfg.claimIntervalMs);
    if (claimTimer.unref) claimTimer.unref();
    const queueTimer = setInterval(() => queue.requeueStale().catch(() => {}), Math.max(1000, cfg.taskTtlMs));
    if (queueTimer.unref) queueTimer.unref();
    pheromone.startDecay();
    return { claimTimer, queueTimer };
  }

  /**
   * CRDT sync: periodično oglašava SAMO nove LOKALNE zapise (delta po vektorskom satu).
   * Bez ovoga bi se stanje spojilo tek kad neko claim-uje (tada se šalje snapshot) — a rezultati
   * i završeni taskovi moraju se vidjeti svuda.
   */
  let lastBroadcast = 0;
  function startSync() {
    const timer = setInterval(() => {
      const fresh = crdt
        .delta({ [id]: lastBroadcast })
        .filter((e) => e.nodeId === id)
        .map((e) => ({ key: e.key, value: e.value, meta: e.meta, deleted: e.deleted, counter: e.counter, nodeId: e.nodeId, clock: e.clock, ts: e.ts }));
      if (!fresh.length) return;
      lastBroadcast = Math.max(...fresh.map((e) => e.counter));
      gossip.broadcast({ kind: 'crdt', entries: fresh });
      metrics?.inc('node_crdt_sync_total', { node: id, entries: String(fresh.length) });
    }, cfg.syncIntervalMs);
    if (timer.unref) timer.unref();
    return timer;
  }

  // ── HTTP admin (isti broj porta, TCP; UDP gossip je odvojen namespace) ──────
  let server = null;
  let syncRef = null;
  function startHttp() {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
        const send = (code, body) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.method === 'GET' && url.pathname === '/status') {
          return send(200, { ...api.stats(), membership: gossip.membershipList() });
        }
        if (req.method === 'GET' && url.pathname === '/tasks') {
          return send(200, { tasks: [...tasks.values()], done: done.slice(-50), crdt: crdt.toObject() });
        }
        if (req.method === 'POST' && url.pathname === '/task') {
          let raw = '';
          req.on('data', (d) => {
            raw += d;
            if (raw.length > 1_000_000) req.destroy();
          });
          req.on('end', async () => {
            try {
              const body = raw ? JSON.parse(raw) : {};
              const task = await submitTask(body);
              send(200, { accepted: true, task });
            } catch (err) {
              send(400, { error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
            }
          });
          return undefined;
        }
        if (req.method === 'POST' && url.pathname === '/tick') {
          tick()
            .then((r) => send(200, r))
            .catch((err) => send(500, { error: { message: err.message } }));
          return undefined;
        }
        return send(404, { error: { code: 'NOT_FOUND', message: `nema rute ${url.pathname}` } });
      });
      server.listen(port, host === '0.0.0.0' ? undefined : host, () => resolve(server.address().port));
    });
  }

  const api = {
    nodeId: id,
    tenantId,
    crdt,
    pheromone,
    queue,
    gossip,
    tasks,
    done,
    get port() {
      return gossip.port;
    },
    get httpPort() {
      return server?.address()?.port ?? null;
    },
    load,
    minPeerLoad,
    on: (...a) => emitter.on(...a),
    submitTask,
    tick,
    runTask,
    startLoops,

    async start() {
      await queue.init();
      if (cfg.httpAdmin) await startHttp();
      const t0 = Date.now();
      await gossip.start();
      // Claim petlja se vrti sama; u testovima se isključuje da bi tick bio deterministički
      if (cfg.autoLoop) startLoops();
      // CRDT sync se vrti UVIJEK (i u testovima) — inače se stanje ne bi širilo
      syncRef = startSync();
      // Ako imamo peer-ove, javi se odmah (bez čekanja prvog intervala)
      if (peers?.length) await gossip.join(peers);
      const discovery = await api.waitForPeers({ expected: (peers?.length ?? 0), timeoutMs: 2000 });
      const syncMs = Date.now() - t0;
      logger?.info?.('node.started', { nodeId: id, port: api.port, httpPort: api.httpPort, peers: gossip.aliveCount() - 1, syncMs });
      return { nodeId: id, port: api.port, httpPort: api.httpPort, syncMs, ...discovery };
    },

    /**
     * Čeka da se pojavi `expected` živih peer-ova.
     * Spec: 3 node-a se moraju naći za <2s.
     */
    async waitForPeers({ expected = 2, timeoutMs = 2000, pollMs = 25 } = {}) {
      const t0 = Date.now();
      for (;;) {
        const alive = gossip.aliveCount() - 1;
        if (alive >= expected) return { synced: true, alivePeers: alive, syncMs: Date.now() - t0 };
        if (Date.now() - t0 >= timeoutMs) return { synced: alive > 0, alivePeers: alive, syncMs: Date.now() - t0, timedOut: true };
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },

    stats() {
      return {
        nodeId: id,
        port: api.port,
        httpPort: api.httpPort,
        tenantId,
        uptimeMs: Date.now() - startedAt,
        load: load(),
        inFlight: inFlight.size,
        tasksKnown: tasks.size,
        tasksDone: done.length,
        peersAlive: gossip.aliveCount() - 1,
        alive: gossip.membershipList().filter((m) => m.status === 'alive').map((m) => `${m.nodeId}@${m.host}:${m.port}`),
        crdtSize: crdt.size,
        pheromone: pheromone.stats(),
        queue: queue.stats(),
        gossipStats: gossip.stats,
      };
    },

    async close() {
      pheromone.stopDecay();
      if (syncRef) clearInterval(syncRef);
      await gossip.stop().catch(() => {});
      if (server) await new Promise((resolve) => server.close(resolve));
      await queue.close().catch(() => {});
      return true;
    },
  };

  return api;
}

/**
 * Pomoćne tvornice za klastere iz postera (isti node, ali sa fasadama po domenima).
 */
export function createSupportCluster(args) {
  const router = createTicketRouter({ catalog: args.robot?.catalog, queue: args.queue, pheromone: args.pheromone, autonomy: args.robot?.autonomy, governance: args.robot?.swarmGovernance, logger: args.logger, metrics: args.metrics, audit: args.robot?.audit, tenantId: args.tenantId });
  return { ticketRouter: router, submit: (ticket, opts) => router.submit(ticket, opts) };
}

export function createExecutionCluster(args) {
  return createToolRunner({ tools: args.robot?.tools, policyResolver: args.robot?.policyResolver, sandbox: args.robot?.sandbox, audit: args.robot?.audit, metrics: args.metrics, logger: args.logger, tenantId: args.tenantId });
}

export function createResearchCluster(args) {
  const extractor = createExtractor({ memory: args.robot?.memory, llm: args.robot?.llm, logger: args.logger, metrics: args.metrics, audit: args.robot?.audit, tenantId: args.tenantId });
  const registry = args.registry ?? createGenomeRegistry({ secret: args.secret, logger: args.logger, metrics: args.metrics, audit: args.robot?.audit });
  const federation = createFederationClient({ nodeId: args.nodeId, secret: args.secret, registry, controlPlane: args.robot?.controlPlane, logger: args.logger, metrics: args.metrics, audit: args.robot?.audit });
  return { extractor, registry, federation };
}
