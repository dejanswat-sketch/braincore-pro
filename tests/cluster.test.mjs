/**
 * v0.5 — cross-node swarm: RESP klijent, deljena tabla (atomski claim), gossip membership i HMAC,
 * cross-node zadaci i safety na ulazu sa drugog čvora.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import { buildTestRobot, cleanup, tempDataDir } from './helpers.mjs';
import { PolicyError, ValidationError } from '../src/core/errors.js';
import { createRedisClient, encodeCommand, parseReply } from '../src/cluster/redis.js';
import { createFileStore } from '../src/cluster/store.js';
import { createGossipNode, ALLOWED_MESSAGE_TYPES } from '../src/cluster/gossip.js';
import { createSwarmSafety } from '../src/swarm/safety.js';
import { createSwarmGovernance } from '../src/swarm/governance.js';
import { createSwarm } from '../src/swarm/swarm.js';
import { createBlackboard } from '../src/swarm/blackboard.js';
const SECRET = 'test-cluster-secret-1234567890';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Mini RESP server za test klijenta (bez Redis-a na mašini). */
function fakeRedis() {
  const data = new Map();
  const hashes = new Map();
  const server = net.createServer((socket) => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      // parsiraj komande iz bafera (svaka počinje sa *N)
      for (;;) {
        if (!buf.startsWith('*')) break;
        const lines = buf.split('\r\n');
        if (lines.length < 2) break;
        const argc = Number(lines[0].slice(1));
        const args = [];
        let idx = 1;
        let ok = true;
        for (let i = 0; i < argc; i += 1) {
          if (lines[idx] === undefined) {
            ok = false;
            break;
          }
          args.push(lines[idx + 1]);
          idx += 2;
        }
        if (!ok) break;
        const consumed = lines.slice(0, idx).join('\r\n').length + 2;
        buf = buf.slice(consumed);
        const cmd = (args[0] ?? '').toUpperCase();
        if (cmd === 'PING') socket.write('+PONG\r\n');
        else if (cmd === 'SET') {
          const key = args[1];
          const nx = args.includes('NX');
          if (nx && data.has(key)) socket.write('$-1\r\n');
          else {
            data.set(key, args[2]);
            socket.write('+OK\r\n');
          }
        } else if (cmd === 'GET') {
          const v = data.get(args[1]);
          socket.write(v === undefined ? '$-1\r\n' : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
        } else if (cmd === 'HSET') {
          const key = args[1];
          const h = hashes.get(key) ?? new Map();
          for (let i = 2; i < args.length; i += 2) h.set(args[i], args[i + 1]);
          hashes.set(key, h);
          socket.write(':1\r\n');
        } else if (cmd === 'HGETALL') {
          const h = hashes.get(args[1]) ?? new Map();
          if (!h.size) socket.write('*0\r\n');
          else {
            const parts = [`*${h.size * 2}\r\n`];
            for (const [k, v] of h) parts.push(`$${Buffer.byteLength(k)}\r\n${k}\r\n$${Buffer.byteLength(v)}\r\n${v}\r\n`);
            socket.write(parts.join(''));
          }
        } else if (cmd === 'EVAL') {
          // Naš Lua claim: ako ključ ne postoji → claimed, inače busy
          const key = args[3];
          if (data.has(key)) socket.write('*1\r\n$4\r\nbusy\r\n');
          else {
            const worker = args[4];
            data.set(key, args[5]);
            socket.write(`*2\r\n$7\r\nclaimed\r\n$${Buffer.byteLength(worker)}\r\n${worker}\r\n`);
          }
        } else if (cmd === 'DEL') {
          const had = data.delete(args[1]) ? 1 : 0;
          socket.write(`:${had}\r\n`);
        } else if (cmd === 'ZADD' || cmd === 'ZREM' || cmd === 'EXPIRE' || cmd === 'LPUSH') socket.write(':1\r\n');
        else if (cmd === 'ZCARD') socket.write(':0\r\n');
        else if (cmd === 'ZRANGEBYSCORE' || cmd === 'LRANGE') socket.write('*0\r\n');
        else socket.write('-ERR nepoznata komanda\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return server;
}
// ─────────────────────────── RESP klijent ───────────────────────────
test('RESP: kodiranje i parsiranje (jednostavan, bulk, niz, greška, broj)', () => {
  assert.equal(encodeCommand(['PING']), '*1\r\n$4\r\nPING\r\n');
  assert.equal(encodeCommand(['SET', 'k', 'v']), '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n');
  const simple = parseReply(Buffer.from('+OK\r\n'));
  assert.equal(simple.value, 'OK');
  const bulk = parseReply(Buffer.from('$3\r\nabc\r\n'));
  assert.equal(bulk.value, 'abc');
  assert.equal(parseReply(Buffer.from('$3\r\nab')), null, 'nepotpun bulk mora vratiti null');
  const nullBulk = parseReply(Buffer.from('$-1\r\n'));
  assert.equal(nullBulk.value, null);
  const num = parseReply(Buffer.from(':42\r\n'));
  assert.equal(num.value, 42);
  const arr = parseReply(Buffer.from('*2\r\n$1\r\na\r\n$1\r\nb\r\n'));
  assert.deepEqual(arr.value, ['a', 'b']);
  const err = parseReply(Buffer.from('-ERR puklo\r\n'));
  assert.equal(err.isError, true);
  assert.match(err.value.message, /puklo/);
});
test('RESP: klijent radi protiv servera (PING/SET NX/GET/HSET/EVAL)', async () => {
  const server = fakeRedis();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const client = createRedisClient({ url: `redis://127.0.0.1:${port}` });
  try {
    assert.equal(await client.ping(), 'PONG');
    assert.equal(await client.set('a', '1'), 'OK');
    assert.equal(await client.get('a'), '1');
    assert.equal(await client.set('a', '2', { nx: true }), null, 'NX na postojeći ključ vraća null');
    await client.hset('h', { x: '1', y: '2' });
    assert.deepEqual(await client.hgetall('h'), { x: '1', y: '2' });
    const claim = await client.eval('return 1', ['lock'], ['w1', 'payload', '1000', '0']);
    assert.deepEqual(claim, ['claimed', 'w1']);
    assert.deepEqual(await client.eval('return 1', ['lock'], ['w2', 'p', '1000', '0']), ['busy']);
    assert.equal(await client.get('nema'), null);
  } finally {
    await client.close();
    await new Promise((res) => server.close(res));
  }
});
// ─────────────────────────── deljena tabla (file store) ───────────────────────────
test('deljena tabla: atomski claim — dva workera, samo jedan dobija zadatak', async () => {
  const dir = await tempDataDir('cluster-store');
  const a = createFileStore({ dir });
  const b = createFileStore({ dir });
  await a.init();
  await b.init();
  try {
    await a.putTask({ id: 't1', tenantId: 'nmq', title: 'zadatak', value: 5, requiredSkills: [] });
    const [r1, r2] = await Promise.all([a.claimTask('t1', 'w1', { leaseMs: 5000 }), b.claimTask('t1', 'w2', { leaseMs: 5000 })]);
    const winners = [r1, r2].filter((r) => r.claimed);
    assert.equal(winners.length, 1, 'tačno jedan claim smije proći');
    const loser = [r1, r2].find((r) => !r.claimed);
    assert.ok(['zauzet', 'lock_se_drzi'].includes(loser.reason), 'razlog gubitnika: ' + loser.reason);
    assert.ok(['zauzet', 'lock_se_drzi'].includes(loser.reason), 'razlog gubitnika: ' + loser.reason);
    // drugi čvor vidi stanje iz store-a
    const seen = await b.getTask('t1');
    assert.equal(seen.state, 'claimed');
    assert.ok(['w1', 'w2'].includes(seen.claimedBy));
  } finally {
    await cleanup(dir);
  }
});
test('deljena tabla: istekao lease vraća zadatak, complete je vidljiv drugom čvoru', async () => {
  const dir = await tempDataDir('cluster-store2');
  const a = createFileStore({ dir });
  const b = createFileStore({ dir });
  await a.init();
  await b.init();
  try {
    await a.putTask({ id: 't2', tenantId: 'nmq', title: 'zadatak', value: 1, requiredSkills: [] });
    const first = await a.claimTask('t2', 'w1', { leaseMs: 1000 });
    assert.equal(first.claimed, true);
    const busy = await b.claimTask('t2', 'w2', { leaseMs: 1000 });
    assert.equal(busy.claimed, false, 'dok lease traje, drugi ne smije uzeti');
    // simuliraj istek lease-a prepisivanjem zapisa
    const task = await a.getTask('t2');
    await a.putTask({ ...task, leaseUntil: new Date(Date.now() - 1000).toISOString() });
    const second = await b.claimTask('t2', 'w2', { leaseMs: 5000 });
    assert.equal(second.claimed, true, 'poslije isteka lease-a zadatak se vraća na tablu');
    assert.equal(second.task.attempts, 2);
    await b.completeTask('t2', { workerId: 'w2', success: true, result: { output: 'gotovo' } });
    const after = await a.getTask('t2');
    assert.equal(after.state, 'done');
    assert.equal(after.result.output, 'gotovo');
    assert.equal((await a.openTasks('nmq')).length, 0);
    // neuspjeh vraća zadatak u open
    await a.putTask({ id: 't3', tenantId: 'nmq', title: 'drugi', value: 1, requiredSkills: [] });
    await a.claimTask('t3', 'w1', { leaseMs: 5000 });
    await a.completeTask('t3', { workerId: 'w1', success: false, result: { error: 'puklo' } });
    assert.equal((await a.getTask('t3')).state, 'open');
  } finally {
    await cleanup(dir);
  }
});
// ─────────────────────────── gossip ───────────────────────────
async function twoNodes(extraA = {}, extraB = {}) {
  const make = (nodeId, extra) => ({
    nodeId,
    host: '127.0.0.1',
    port: 0,
    secret: SECRET,
    ...extra,
    config: { intervalMs: 200, suspectMs: 2000, deadMs: 5000, ...(extra.config ?? {}) },
  });
  const a = await createGossipNode(make('node-a', extraA));
  const b = await createGossipNode(make('node-b', extraB));
  await a.start();
  await b.start();
  return { a, b };
}
test('gossip: dva čvora se pronalaze i vide jedan drugog kao žive', async () => {
  const { a, b } = await twoNodes();
  try {
    const join = await a.join([`127.0.0.1:${b.port}`]);
    assert.equal(join[0].ok, true, JSON.stringify(join));
    await wait(250);
    const membersA = a.membershipList().map((m) => m.nodeId).sort();
    const membersB = b.membershipList().map((m) => m.nodeId).sort();
    assert.deepEqual(membersA, ['node-a', 'node-b']);
    assert.deepEqual(membersB, ['node-a', 'node-b']);
    assert.equal(a.memberCount(), 2);
    assert.equal(b.memberCount(), 2);
    // heartbeat održava članove živim
    await wait(500);
    assert.equal(b.membershipList().find((m) => m.nodeId === 'node-a').status, 'alive');
  } finally {
    await a.stop();
    await b.stop();
  }
});
test('gossip: broadcast se isporučuje drugom čvoru, sa TTL-om (nema beskonačnog kruženja)', async () => {
  const received = [];
  const { a, b } = await twoNodes({}, { onMessage: (m) => received.push(m) });
  try {
    await a.join([`127.0.0.1:${b.port}`]);
    await wait(200);
    const sent = await a.broadcast('disseminate', { hello: 'svijet' }, { ttl: 2 });
    assert.ok(sent.targets >= 1);
    await wait(300);
    const hit = received.find((m) => m.type === 'disseminate');
    assert.ok(hit, 'poruka mora stići do drugog čvora');
    assert.equal(hit.payload.hello, 'svijet');
    assert.ok(hit.hops >= 0 && hit.ttl <= 2);
  } finally {
    await a.stop();
    await b.stop();
  }
});
test('gossip: HMAC — tuđ potpis, nepotpisan okvir i nepoznat tip se odbijaju', async () => {
  const node = await createGossipNode({ nodeId: 'node-sec', host: '127.0.0.1', port: 0, secret: SECRET });
  await node.start();
  const attacker = await createGossipNode({ nodeId: 'node-x', host: '127.0.0.1', port: 0, secret: 'drugi-secret-000000000' });
  try {
    const good = node.envelope('heartbeat', { host: '127.0.0.1', port: 1 });
    assert.equal(node.verify(JSON.parse(good)).ok, true);
    const forged = attacker.envelope('heartbeat', { host: '1.2.3.4', port: 9 });
    const verdict = node.verify(JSON.parse(forged));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'losi_potpis');
    assert.equal(node.handleRaw(forged).ok, false);
    const unsigned = JSON.stringify({ body: { v: 1, id: 'x', type: 'heartbeat', from: 'node-y', incarnation: 1, ttl: 1, hops: 0, ts: Date.now(), payload: {} } });
    assert.equal(node.handleRaw(unsigned).reason, 'nema_potpisa');
    assert.equal(node.handleRaw('nije json').reason, 'nije_json');
    assert.throws(() => node.envelope('proizvoljan_tip', {}), ValidationError);
    assert.ok(ALLOWED_MESSAGE_TYPES.includes('swarm_message'));
  } finally {
    await node.stop();
    await attacker.stop();
  }
});
test('gossip: rate limit na ulazne poruke + prevelika poruka se odbija', async () => {
  const rejected = [];
  const node = await createGossipNode({ nodeId: 'node-rl', host: '127.0.0.1', port: 0, secret: SECRET, config: { maxInboundPerMin: 3, maxMessageBytes: 512 }, onMessage: null });
  node.on('rejected', (r) => rejected.push(r));
  await node.start();
  try {
    const frame = node.envelope('heartbeat', { host: '127.0.0.1', port: 1 }, { ttl: 0 });
    assert.equal(node.handleRaw(frame).ok, true);
    assert.equal(node.handleRaw(frame).ok, true);
    assert.equal(node.handleRaw(frame).ok, true);
    const limited = node.handleRaw(frame);
    assert.equal(limited.ok, false);
    assert.equal(limited.reason, 'rate_limit');
    assert.throws(() => node.envelope('disseminate', { blob: 'x'.repeat(2000) }), (err) => /prevelika/.test(err.message));
  } finally {
    await node.stop();
  }
});
test('gossip: član koji ućuti postaje suspect pa dead; ručni karantin ga izbacuje', async () => {
  const changes = [];
  const { a, b } = await twoNodes({ config: { intervalMs: 100, suspectMs: 150, deadMs: 300 } }, { config: { intervalMs: 60_000 } });
  try {
    await a.join([`127.0.0.1:${b.port}`]);
    await wait(200);
    assert.ok(a.membershipList().some((m) => m.nodeId === 'node-b'));
    a.on('membership', (m) => changes.push(`${m.nodeId}:${m.status}`));
    // b prestaje da šalje heartbeat (interval 60s) → a ga proglašava suspect/dead
    await wait(700);
    const status = a.membershipList().find((m) => m.nodeId === 'node-b')?.status;
    assert.ok(['suspect', 'dead'].includes(status), `status je ${status}`);
    assert.ok(changes.length >= 1);
    const q = a.quarantineMember('node-b', 'test');
    assert.equal(q.ok, true);
    assert.equal(a.membershipList().find((m) => m.nodeId === 'node-b').status, 'dead');
    assert.equal(a.isKnownNode?.('node-b'), undefined); // gossip nema isKnownNode (to je cluster node)
  } finally {
    await a.stop();
    await b.stop();
  }
});
// ─────────────────────────── cluster node (cross-node zadaci + safety) ───────────────────────────
async function clusterFixture(extra = {}) {
  const dir = extra.dataDir ?? (await tempDataDir('cluster-node'));
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const metrics = { inc() {}, observe() {}, gauge() {} };
  const governance = createSwarmGovernance({ config: {}, dataDir: dir, logger, metrics, audit: null, autonomy: null });
  const board = createBlackboard({ dataDir: dir, logger, metrics });
  const safety = createSwarmSafety({ config: {}, dataDir: dir, logger, metrics, audit: null, bus: null, governance, blackboard: board, isKnownWorker: () => true });
  const swarm = createSwarm({ config: {}, blackboard: board, governance, safety, orchestrator: { run: async () => ({ status: 'ok', output: 'odgovor', costUsd: 0.002, agentId: 'support', runId: 'run_x', pattern: 'agent' }) }, catalog: { has: () => true, get: () => ({ domain: 'support', tools: [] }) }, autonomy: null, rewards: null, audit: null, metrics, logger });
  const { createClusterNode } = await import('../src/cluster/node.js');
  const cluster = await createClusterNode({ config: { secret: SECRET, gossip: { intervalMs: 150, suspectMs: 2000, deadMs: 5000 } }, dataDir: dir, logger, metrics, audit: null, bus: null, host: '127.0.0.1', port: 0 });
  cluster.attach({ swarm, safety, governance, blackboard: board, orchestrator: { run: async () => ({ status: 'ok', output: 'odgovor', costUsd: 0.002, agentId: 'support', runId: 'run_x', pattern: 'agent' }) }, catalog: null, rewards: null, audit: null });
  await cluster.start();
  return { dir, cluster, swarm, safety, governance, board };
}
test('cluster: zadatak na zajedničkoj tabli se claim-uje i izvršava (cross-node work stealing)', async () => {
  const fx = await clusterFixture();
  try {
    fx.swarm.registerWorker({ tenantId: 'nmq', agentId: 'support', skills: ['support', 'general'] });
    await fx.cluster.postTask({ tenantId: 'nmq', title: 'Cross-node ticket', payload: { input: 'test', tag: 'support' }, requiredSkills: ['support'], value: 4 });
    const open = await fx.cluster.store.openTasks('nmq');
    assert.equal(open.length, 1);
    const run = await fx.cluster.runOnce({ tenantId: 'nmq', maxRuns: 2 });
    assert.equal(run.ran, 1);
    assert.equal(run.results[0].status, 'ok');
    assert.equal((await fx.cluster.store.openTasks('nmq')).length, 0, 'zadatak je završen i skinut sa table');
    assert.equal(fx.swarm.stats('nmq').completed, 1);
    const pheromones = await fx.cluster.store.activePheromones({ tenantId: 'nmq' });
    assert.ok(pheromones.some((p) => p.type === 'done'), 'završetak ostavlja trag i u deljenom store-u');
  } finally {
    await fx.cluster.stop();
    await cleanup(fx.dir);
  }
});
test('cluster: dva čvora dele tablu — jedan objavi, drugi uzme i završi', async () => {
  const dir = await tempDataDir('cluster-shared');
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const metrics = { inc() {}, observe() {}, gauge() {} };
  const { createClusterNode } = await import('../src/cluster/node.js');
  const mk = (nodeId) =>
    createClusterNode({ nodeId, config: { secret: SECRET, gossip: { intervalMs: 200 } }, dataDir: dir, logger, metrics, audit: null, bus: null, host: '127.0.0.1', port: 0 });
  const a = await mk('node-1');
  const b = await mk('node-2');
  try {
    await a.start();
    await b.start();
    await a.join([`127.0.0.1:${b.port}`]);
    await wait(250);
    const task = await a.postTask({ tenantId: 'nmq', title: 'Posao sa čvora A', payload: { input: 'x' }, value: 2 });
    const seenByB = await b.store.openTasks('nmq');
    assert.equal(seenByB.length, 1, 'čvor B vidi zadatak koji je objavio čvor A');
    const claim = await b.claimTask({ tenantId: 'nmq', workerId: 'w-b', skills: [] });
    assert.equal(claim.id, task.id);
    const steal = await a.claimTask({ tenantId: 'nmq', workerId: 'w-a', skills: [] });
    assert.equal(steal, null, 'čvor A ne smije uzeti zadatak koji je već claim-ovan');
    await b.completeTask(task.id, { workerId: 'w-b', success: true, result: { output: 'gotovo' }, tenantId: 'nmq' });
    assert.equal((await a.store.getTask(task.id)).state, 'done');
    assert.equal(a.memberCount?.() ?? a.gossip.memberCount(), 2);
  } finally {
    await a.stop();
    await b.stop();
    await cleanup(dir);
  }
});
test('cluster: poruka sa drugog čvora prolazi medijaciju, a skriveni kanal se odbija i karantinira čvor', async () => {
  const dir = await tempDataDir('cluster-msg');
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const metrics = { inc() {}, observe() {}, gauge() {} };
  const governance = createSwarmGovernance({ config: {}, dataDir: dir, logger, metrics, audit: null, autonomy: null });
  const board = createBlackboard({ dataDir: dir, logger, metrics });
  const known = new Set(['node-1', 'node-2']);
  const safety = createSwarmSafety({
    config: {},
    dataDir: dir,
    logger,
    metrics,
    audit: null,
    bus: null,
    governance,
    blackboard: board,
    isKnownWorker: (id) => (id.startsWith('node:') ? known.has(id.slice(5)) : true),
  });
  const swarm = createSwarm({ config: {}, blackboard: board, governance, safety, orchestrator: { run: async () => ({ status: 'ok', output: 'x', costUsd: 0 }) }, catalog: { has: () => true, get: () => ({}) }, autonomy: null, rewards: null, audit: null, metrics, logger });
  const { createClusterNode } = await import('../src/cluster/node.js');
  const a = await createClusterNode({ nodeId: 'node-1', config: { secret: SECRET, gossip: { intervalMs: 150 } }, dataDir: dir, logger, metrics, audit: null, bus: null, host: '127.0.0.1', port: 0 });
  const b = await createClusterNode({ nodeId: 'node-2', config: { secret: SECRET, gossip: { intervalMs: 150, maxInboundPerMin: 5000 } }, dataDir: dir, logger, metrics, audit: null, bus: null, host: '127.0.0.1', port: 0 });
  const deps = { swarm, safety, governance, blackboard: board, orchestrator: null, catalog: null, rewards: null, audit: null };
  a.attach(deps);
  b.attach(deps);
  try {
    await a.start();
    await b.start();
    await a.join([`127.0.0.1:${b.port}`]);
    await wait(250);
    // normalna poruka sa A stiže do B (kroz medijaciju na obje strane)
    const sent = await a.publishSwarmMessage({ tenantId: 'nmq', from: 'node-1', to: 'swarm', type: 'status', payload: { text: 'Završio sam ticket 42.' } });
    assert.equal(sent.checked, true);
    await wait(300);
    assert.equal(safety.report({ tenantId: 'nmq' }).findings, 0, 'normalna poruka ne smije dati nalaz');
    // napadački čvor šalje skriveni kanal (zaobilazi lokalnu provjeru jer ima tajnu)
    const forged = a.gossip.envelope('swarm_message', { tenantId: 'nmq', from: 'node-2', to: 'swarm', msgType: 'status', payload: { blob: 'aB3xK9mQ2zP7wL4nR8tY6uI1oJ5hG0fD2sA9qW3eZ7xC4vB6nM8kL1pO5iU2yT4rE6wQ9' } });
    b.gossip.handleRaw(forged);
    await wait(200);
    const report = safety.report({ tenantId: 'nmq' });
    assert.ok(report.findings >= 1, 'sumnjiv sadržaj sa mreže mora dati nalaz');
    assert.ok(report.incidents >= 1);
    // Karantin ide na STVARNOG pošiljaoca sa žice (node-1), ne na lažni identitet iz payload-a (node-2)
    assert.ok(report.quarantined.some((q) => q.workerId === 'node:node-1'), `karantin: ${JSON.stringify(report.quarantined)}`);
    assert.ok(report.quarantined.every((q) => q.reason.startsWith('cluster:')), 'razlog mora biti klasterski');
    assert.equal(b.gossip.members.get('node-1')?.status, 'dead', 'čvor koji je poslao skriveni kanal je izbačen iz membership-a');
    // Karantin je "sticky": heartbeat poslije incidenta ne smije vratiti čvor u život
    await wait(400);
    assert.equal(b.gossip.members.get('node-1')?.status, 'dead', 'heartbeat ne smije oživjeti karantinovan čvor');
    const released = b.gossip.releaseMember('node-1', { by: 'board' });
    assert.equal(released.status, 'alive');
  } finally {
    await a.stop();
    await b.stop();
    await cleanup(dir);
  }
});
// ─────────────────────────── HTTP rute ───────────────────────────
test('HTTP: cluster rute (status, members, join, tasks, run, quarantine po rolama)', async () => {
  process.env.NMQ_CLUSTER_SECRET = SECRET;
  const robot = await buildTestRobot({ script: () => ({ text: 'cluster odgovor' }), env: { NMQ_CLUSTER: '1', NMQ_CLUSTER_PORT: '0', NMQ_CLUSTER_SECRET: SECRET } });
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (url, init = {}) => {
    const res = await fetch(`${base}${url}`, { ...init, headers: { 'content-type': 'application/json', 'x-tenant': 'nmq', ...(init.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    assert.ok(robot.cluster, 'klaster mora biti uključen');
    const status = await call('/v1/admin/cluster');
    assert.equal(status.status, 200);
    assert.equal(status.body.store.kind, 'file');
    assert.ok(status.body.members >= 1);
    const members = await call('/v1/admin/cluster/members');
    assert.equal(members.body.members[0].nodeId, robot.cluster.nodeId);
    const workers = await call('/v1/admin/swarm/workers', { method: 'POST', body: JSON.stringify({ agents: [{ agentId: 'support', skills: ['support', 'general'] }] }) });
    assert.equal(workers.status, 200);
    const tasks = await call('/v1/admin/cluster/tasks', { method: 'POST', body: JSON.stringify({ tasks: [{ title: 'HTTP cross-node', payload: { input: 'Kako da resetujem lozinku?', tag: 'support' }, requiredSkills: ['support'], value: 3 }] }) });
    assert.equal(tasks.body.created.length, 1);
    const board = await call('/v1/admin/cluster/board');
    assert.equal(board.body.open.length, 1);
    const run = await call('/v1/admin/cluster/run', { method: 'POST', body: JSON.stringify({ maxRuns: 2 }) });
    assert.equal(run.body.ran, 1);
    assert.equal(run.body.results[0].status, 'ok');
    const joinNoPeers = await call('/v1/admin/cluster/join', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(joinNoPeers.status, 400);
    const quarantine = await call('/v1/admin/cluster/quarantine/node-lažni', { method: 'POST', body: JSON.stringify({ reason: 'test' }) });
    assert.equal(quarantine.body.ok, false, 'nepoznat član se ne može karantinovati');
    // agent ključ ne smije članiti/izbacivati članove (role owner)
    const issued = await call('/v1/admin/agents/executor/keys', { method: 'POST', body: JSON.stringify({ name: 'cluster-test' }) });
    const denied = await fetch(`${base}/v1/admin/cluster/join`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant': 'nmq', authorization: `Bearer ${issued.body.key}` }, body: JSON.stringify({ peers: ['127.0.0.1:1'] }) });
    assert.equal(denied.status, 403);
  } finally {
    await robot.close();
    await cleanup(robot.__dir);
    delete process.env.NMQ_CLUSTER_SECRET;
  }
});
test('cluster: bez NMQ_CLUSTER_SECRET klaster je fail-closed (ne startuje)', async () => {
  delete process.env.NMQ_CLUSTER_SECRET;
  await assert.rejects(
    () => buildTestRobot({ script: () => ({ text: 'x' }), env: { NMQ_CLUSTER: '1', NMQ_CLUSTER_PORT: '0' } }),
    (err) => /NMQ_CLUSTER_SECRET/.test(err.message),
  );
});
