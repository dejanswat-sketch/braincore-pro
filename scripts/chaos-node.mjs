#!/usr/bin/env node
/**
 * Jedan swarm node kao PROCES — koristi ga `scripts/chaos.mjs` da bi se mogao stvarno ubiti (SIGKILL).
 *
 *   node scripts/chaos-node.mjs --port=8301 --peers=127.0.0.1:8302 --delay=300 --log=C:\tmp\chaos.jsonl
 *
 * Svaki završeni task se dopisuje u zajednički JSONL fajl (`{taskId, nodeId, at, ms}`). To je jedini
 * način da se iz drugog procesa dokaže da li je neki task izvršen DVA puta.
 */
import fs from 'node:fs';
import { createSwarmNode } from '../src/node.js';
import { createLogger } from '../src/core/logger.js';

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const PORT = Number(arg('port', 8301));
const PEERS = String(arg('peers', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const DELAY = Number(arg('delay', 300));
const LOG = arg('log', null);
const SECRET = arg('secret', 'chaos-secret-1234567890');
const NODE_ID = arg('id', `node-${PORT}`);
const logger = createLogger({ level: arg('log-level', 'warn') });

const runner = async (task, { nodeId, attempt = 1 }) => {
  // Bilježimo START i DONE: iz dva zapisa se vidi da li su se dva izvršenja PREKLAPALA u vremenu
  // (pravo duplo izvršenje) ili su bila jedno za drugim (ponovni rad zbog izgubljene potvrde).
  if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ taskId: task.id, nodeId, attempt, phase: 'start', at: Date.now() })}\n`);
  // Realan posao: drži task „u letu" dovoljno dugo da ga ubijanje čvora prekine
  await new Promise((r) => setTimeout(r, DELAY));
  if (LOG) {
    fs.appendFileSync(LOG, `${JSON.stringify({ taskId: task.id, nodeId, attempt, phase: 'done', at: Date.now() })}\n`);
  }
  return { output: `${nodeId} uradio ${task.id}` };
};

const node = await createSwarmNode({
  nodeId: NODE_ID,
  port: PORT,
  host: '127.0.0.1',
  advertiseHost: '127.0.0.1',
  peers: PEERS,
  secret: SECRET,
  logger,
  runner,
  config: { autoLoop: true, claimIntervalMs: 50, syncIntervalMs: 250, httpAdmin: true, gossip: { intervalMs: 300, failureTimeoutMs: 1200 } },
});

const started = await node.start();
logger.info('chaos.node_ready', { nodeId: NODE_ID, port: started.port, httpPort: started.httpPort });

// Bez ovoga proces ne bi izašao pri SIGTERM-u, a SIGKILL ga ionako ubija odmah
const shutdown = async () => {
  await node.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
