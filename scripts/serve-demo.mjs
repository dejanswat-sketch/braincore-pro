#!/usr/bin/env node
/**
 * Lokalna demo mašina: 3 swarm node-a + API + live feed u JEDNOM procesu.
 *
 *   node scripts/serve-demo.mjs                # API :8081, node-ovi 8001/8002/8003 (in-process)
 *   node scripts/serve-demo.mjs --api-port=8081 --ticket-every=15000
 *
 * Zašto jedan proces: za gledanje i demo je dovoljno, a ponašanje je isto (koordinacija ide preko
 * CRDT table i gossip-a, ne preko hosta). Za pravi deploy vidi deploy/install.sh (3 procesa/systemd).
 */
import { createSwarmNode } from '../src/node.js';
import { createApiServer } from '../src/api/server.js';
import { createLogger } from '../src/core/logger.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const API_PORT = Number(arg('api-port', 8081));
const SECRET = process.env.NMQ_CLUSTER_SECRET ?? 'braincore-local-demo-secret';
const TICKET_EVERY = Number(arg('ticket-every', 15_000));
const logger = createLogger({ level: arg('log', 'warn') });

const config = { httpAdmin: false, autoLoop: true, claimIntervalMs: 40, syncIntervalMs: 250, gossip: { intervalMs: 300, failureTimeoutMs: 1200 } };
const runner = async (task, { nodeId }) => {
  // Različita brzina po node-u → vidi se kako „najslobodniji" preuzima posao
  const ms = nodeId.endsWith('1') ? 900 : nodeId.endsWith('2') ? 300 : 120;
  await new Promise((r) => setTimeout(r, ms));
  return { output: `${nodeId} obradio ${task.type} za ${ms}ms` };
};

const nodes = [];
// Origin (8001) traži posao brže i sam je sporiji: prvi task uzme on, a dok je zauzet (900 ms),
// ostala dva iz burst-a preuzimaju 8002/8003 — tačno ponašanje iz prijemnog testa.
const mk = (id, port, peers, claimIntervalMs) =>
  createSwarmNode({ nodeId: id, port, host: '127.0.0.1', advertiseHost: '127.0.0.1', peers, secret: SECRET, config: { ...config, claimIntervalMs }, logger, runner });

const n1 = await mk('node-8001', 8001, [], 30);
const n2 = await mk('node-8002', 8002, [], 160);
const n3 = await mk('node-8003', 8003, [], 220);
for (const n of [n1, n2, n3]) nodes.push(n);

const s1 = await n1.start();
await n2.start();
await n3.start();
await n2.gossip.join(['127.0.0.1:8001']);
await n3.gossip.join(['127.0.0.1:8001', '127.0.0.1:8002']);
await Promise.all(nodes.map((n) => n.waitForPeers({ expected: 2, timeoutMs: 2500 })));

const api = await createApiServer({ node: n1, config: { port: API_PORT, host: '127.0.0.1' }, logger, env: process.env });
const addr = await api.listen();

console.log(`LIVE  →  http://127.0.0.1:${addr.port}/live        (3 node-a, feromoni, taskovi)`);
console.log(`API   →  http://127.0.0.1:${addr.port}/status      (stanje roja)`);
console.log(`        http://127.0.0.1:${addr.port}/metrics     (brojači)`);
console.log(`SYNC  →  ${nodes.map((n) => `${n.nodeId}:${n.port}`).join(' · ')}  (discovery ${s1.syncMs} ms)`);

// Demo saobraćaj: burst od 3 ticketa na SPORI node (8001, runner 900 ms).
// Prvi task uzme 8001, a dok je zauzet, ostala dva preuzmu 8002/8003 — vidi se cross-node hand-off.
const tickets = [
  { text: 'I need a refund for order 1042', type: 'support.ticket' },
  { text: 'Invoice for October is missing', type: 'support.ticket' },
  { text: 'The API returns 500 on /v2/orders', type: 'support.ticket' },
  { text: 'When will my package arrive?', type: 'support.ticket' },
  { text: 'Please send a quote with pricing', type: 'support.ticket' },
];
let i = 0;
const timer = TICKET_EVERY > 0
  ? setInterval(() => {
      for (let b = 0; b < 3; b += 1) {
        const t = tickets[i++ % tickets.length];
        n1.submitTask({ type: t.type, payload: t, value: 1 + (i % 3), ttl: 60_000 }).catch(() => {});
      }
    }, TICKET_EVERY)
  : null;

const shutdown = async () => {
  if (timer) clearInterval(timer);
  await api.close().catch(() => {});
  await Promise.all(nodes.map((n) => n.close().catch(() => {})));
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
