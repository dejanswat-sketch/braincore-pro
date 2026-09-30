/**
 * 3 NODE-A — checklist iz „Punih smernica" (test/3-nodes.test.js → ovdje `tests/3-nodes.test.mjs`).
 *
 * Checklist koji ovaj fajl dokazuje:
 *   ☑ node src/index.js --port=... radi bez errora (CLI test)
 *   ☑ 3 node-a se vide za <2s (gossip log / membership)
 *   ☑ Task ubačen u 8001 završi u 8002 (kad je 8002 slobodniji)
 *   ☑ Pheromone ispari nakon 30s (TTL + decay)
 *   ☑ Nema node_modules i nema zabranjenih modula u kodu
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createSwarmNode } from '../src/node.js';
import { createGossip } from '../src/gossip.js';
import { createCrdtBlackboard } from '../src/shared/blackboard.js';
import { createPheromoneStore } from '../src/shared/pheromone.js';
import { createTaskQueue } from '../src/shared/queue.js';
import { createRespClient, encodeCommand, parseReply } from '../src/resp-client.js';
import { createTicketRouter } from '../src/support/ticket-router.js';
import { createToolRunner } from '../src/execution/tool-runner.js';
import { createExtractor } from '../src/research/extractor.js';
import { createGenomeRegistry, ALLOWED_REPORT_FIELDS } from '../src/research/genome-registry.js';
import { createFederationClient } from '../src/research/federation.js';
import { PolicyError, ValidationError, AuthError } from '../src/core/errors.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SECRET = 'test-secret-3-nodes-1234567890';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tri node-a u istom procesu (efemerni portovi). */
async function threeNodes({ runnerFor = () => null, config = {} } = {}) {
  const mk = (id, port, peers) =>
    createSwarmNode({
      nodeId: id,
      port,
      host: '127.0.0.1',
      advertiseHost: '127.0.0.1',
      peers,
      secret: SECRET,
      config: { httpAdmin: false, autoLoop: false, claimIntervalMs: 30, claimConfirmMs: 80, gossip: { intervalMs: 100, failureTimeoutMs: 1200 }, ...config },
      runner: runnerFor(id),
    });
  const a = await mk('node-A', 0, []);
  const b = await mk('node-B', 0, []);
  const c = await mk('node-C', 0, []);
  const sa = await a.start();
  const sb = await b.start();
  const sc = await c.start();
  await b.gossip.join([`127.0.0.1:${a.port}`]);
  await c.gossip.join([`127.0.0.1:${a.port}`, `127.0.0.1:${b.port}`]);
  const syncs = {
    A: await a.waitForPeers({ expected: 2, timeoutMs: 2000 }),
    B: await b.waitForPeers({ expected: 2, timeoutMs: 2000 }),
    C: await c.waitForPeers({ expected: 2, timeoutMs: 2000 }),
  };
  return { a, b, c, starts: { sa, sb, sc }, syncs };
}

// ─────────────────────────── discovery ───────────────────────────

test('3 node-a se nalaze za <2s (bez mastera, UDP gossip)', async () => {
  const { a, b, c, syncs } = await threeNodes();
  try {
    for (const [id, s] of Object.entries(syncs)) {
      assert.equal(s.alivePeers, 2, `${id} vidi ${s.alivePeers} peer-ova`);
      assert.ok(s.syncMs < 2000, `${id} sync ${s.syncMs}ms mora biti <2000ms`);
    }
    // membership je obostran i bez „mastera"
    for (const n of [a, b, c]) {
      const ids = n.gossip.membershipList().map((m) => m.nodeId).sort();
      assert.deepEqual(ids, ['node-A', 'node-B', 'node-C']);
      assert.equal(n.gossip.members.get(n.nodeId).self, true);
    }
    assert.ok(a.gossip.stats.sent > 0 && b.gossip.stats.received > 0);
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
});

test('gossip: failure detection (suspect/dead) i zabrana lažnog potpisa', async () => {
  const a = await createGossip({ nodeId: 'alpha', port: 0, host: '127.0.0.1', secret: SECRET, config: { intervalMs: 50, failureTimeoutMs: 150, deadAfterMisses: 2 } });
  const ghost = await createGossip({ nodeId: 'ghost', port: 0, host: '127.0.0.1', secret: SECRET, config: { intervalMs: 60_000 } });
  const attacker = await createGossip({ nodeId: 'attacker', port: 0, host: '127.0.0.1', secret: 'drugi-secret-000000000000' });
  try {
    await a.start();
    // „ghost" se javi JEDNOM (potpisan PING), a poslije toga ne postoji — a ga mora proglasiti mrtvim
    a.handleRaw(ghost.frame('PING', { host: '127.0.0.1', port: 39999 }), { address: '127.0.0.1', port: 39999 });
    assert.equal(a.membershipList().find((m) => m.nodeId === 'ghost')?.status, 'alive');

    // tuđ potpis se odbija
    const before = a.stats.rejected;
    a.handleRaw(attacker.frame('PING', { host: '127.0.0.1', port: 39998 }), { address: '127.0.0.1', port: 39998 });
    assert.ok(a.stats.rejected > before, 'tuđ potpis mora biti odbijen');
    assert.equal(a.membershipList().some((m) => m.nodeId === 'attacker'), false, 'nepotpisan član ne smije u membership');

    // poslije 2 promašaja (150ms svaki) ghost je suspect/dead
    await wait(700);
    const status = a.membershipList().find((m) => m.nodeId === 'ghost')?.status;
    assert.ok(['suspect', 'dead'].includes(status), `status je ${status}`);

    // karantin je „sticky": PING ne vraća člana u život
    a.quarantineMember('ghost', 'test');
    a.handleRaw(ghost.frame('PING', { host: '127.0.0.1', port: 39999 }), { address: '127.0.0.1', port: 39999 });
    assert.equal(a.membershipList().find((m) => m.nodeId === 'ghost')?.status, 'dead');
    assert.equal(a.releaseMember('ghost', { by: 'board' }).status, 'alive');
  } finally {
    await a.stop();
    await ghost.stop();
    await attacker.stop();
  }
});

// ─────────────────────────── task rutiranje ───────────────────────────

test('task ubačen u node A završava u node B ako je B slobodniji', async () => {
  // A ima spor runner (1.5s) → dok je zauzet, novi task mora preuzeti B
  const { a, b, c } = await threeNodes({
    runnerFor: (id) => async (task) => {
      if (id === 'node-A') await wait(1500);
      return { output: `${id} obradio ${task.id}` };
    },
  });
  try {
    // 1) Zauzmi A sporim taskom — tick se NE await-uje jer runner traje 1.5s (A je tada „zauzet")
    await a.submitTask({ type: 'slow', payload: { text: 'dugi posao' }, ttl: 30_000, value: 5 });
    const slowTick = a.tick();
    // Čekanje se IZVODI iz stvarnog prozora čvora, ali vezano za CONFIRM prozor (ne grace + confirm):
    // A mora biti JOŠ ZAUZET (runner traje 1,5 s), a claim verifikacija mora biti završena. Sa totalMs
    // (2,1 s) A bi već završio posao i `load` bi bio 0 — to je bila moja greška u prvom pokušaju.
    const w = a.claimWindows();
    await wait(w.confirmMs + 200);
    assert.ok(a.load() >= 1, `A load je ${a.load()}`);

    // 2) Sačekaj da A VIDI da je B slobodan (load 0 dolazi uz PING/ACK)
    for (let i = 0; i < 60; i += 1) {
      const peer = a.gossip.members.get('node-B');
      if (peer && peer.status === 'alive' && peer.load !== null) break;
      await wait(50);
    }
    assert.equal(a.minPeerLoad(), 0, 'A mora vidjeti da je B slobodan');

    // 3) Novi task ide u A, ali ga mora preuzeti B (slobodniji)
    const task = await a.submitTask({ type: 'support.ticket', payload: { text: 'Kako da resetujem lozinku?' }, ttl: 30_000, value: 10 });
    const aTick = await a.tick();
    assert.equal(aTick.idle, true);
    assert.equal(aTick.reason, 'peer_freer', `A razlog: ${aTick.reason}`);

    // B preuzima i izvršava
    let doneOnB = null;
    for (let i = 0; i < 40 && !doneOnB; i += 1) {
      await b.tick();
      doneOnB = b.done.find((d) => d.taskId === task.id) ?? null;
      if (!doneOnB) await wait(50);
    }
    assert.ok(doneOnB, 'B mora završiti task');
    assert.equal(doneOnB.nodeId, 'node-B');
    assert.equal(a.done.some((d) => d.taskId === task.id), false, 'A nije smio izvršiti taj task');

    // CRDT zna ko je završio (i to vide svi)
    await wait(200);
    assert.equal(b.crdt.get(`task:${task.id}`).doneBy, 'node-B');
    assert.equal(c.crdt.get(`claim:${task.id}`).nodeId, 'node-B');
    await slowTick; // pusti spori task da se završi prije zatvaranja
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
});

test('atomski claim preko CRDT-a: dva node-a ne mogu uzeti isti task', async () => {
  const { a, b, c } = await threeNodes();
  try {
    const task = await a.submitTask({ type: 'support.ticket', payload: { text: 'x' }, value: 3 });
    // Oba node-a pokušavaju u ISTOM trenutku
    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
    const ran = [ra, rb].filter((r) => r.ran);
    assert.equal(ran.length, 1, `tačno jedan smije izvršiti (bilo ${ran.length})`);
    const losers = [ra, rb].filter((r) => !r.ran);
    assert.ok(losers.every((l) => ['već preuzet', 'izgubio trku (LWW)'].includes(l.reason) || l.idle), JSON.stringify(losers));
    assert.equal([a, b, c].filter((n) => n.done.some((d) => d.taskId === task.id)).length, 1);
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
});

// ─────────────────────────── CRDT blackboard ───────────────────────────

test('CRDT: LWW + vektorski sat konvergira bez obzira na redoslijed i duple pakete', () => {
  const A = createCrdtBlackboard({ nodeId: 'A' });
  const B = createCrdtBlackboard({ nodeId: 'B' });
  const C = createCrdtBlackboard({ nodeId: 'C' });

  // Istovremeni upisi istog ključa na svim čvorovima
  A.set('task:1', { id: 1, value: 'A verzija' });
  B.set('task:1', { id: 1, value: 'B verzija' });
  C.set('task:1', { id: 1, value: 'C verzija' });
  A.set('task:2', { id: 2, value: 'samo A' });
  // B prvo VIDI task:2 (merge), pa ga obriše — tako nastaje tombstone sa većim brojačem
  B.merge(A.delta({}));
  B.delete('task:2');

  const snapA = A.snapshot();
  const snapB = B.snapshot();
  const snapC = C.snapshot();

  // Različit redoslijed dolaska + dupli paketi
  C.merge(snapA);
  C.merge(snapA); // duplikat
  C.merge(snapB);
  B.merge(snapC);
  B.merge(snapA);
  A.merge(snapC);
  A.merge(snapB);
  A.merge(snapB); // duplikat

  assert.equal(A.fingerprint(), B.fingerprint(), 'A i B moraju imati identično stanje');
  assert.equal(B.fingerprint(), C.fingerprint(), 'B i C moraju imati identično stanje');

  // Determinizam: pobjednik je isti na svim čvorovima
  const winner = A.get('task:1');
  assert.equal(B.get('task:1').value, winner.value);
  assert.equal(C.get('task:1').value, winner.value);

  // Idempotentnost: spajanje istog paketa ne mijenja stanje
  const before = A.fingerprint();
  const res = A.merge(snapB);
  assert.equal(res.applied, 0, 'nema novih primjena za već viđeno stanje');
  assert.equal(A.fingerprint(), before);

  // Tombstone: brisanje je operacija i širi se
  assert.equal(A.get('task:2'), undefined);
  assert.equal(C.get('task:2'), undefined);
});

test('CRDT: delta i vektorski sat (sync bez slanja cijelog stanja)', () => {
  const A = createCrdtBlackboard({ nodeId: 'A' });
  const B = createCrdtBlackboard({ nodeId: 'B' });
  A.set('k1', 1);
  A.set('k2', 2);
  const delta = A.delta(B.vectorClock());
  assert.equal(delta.length, 2);
  B.merge(delta);
  assert.deepEqual(B.vectorClock(), { A: 2 }, 'B zna šta je vidio od A');
  assert.equal(B.delta(A.vectorClock()).length, 0, 'poslije sync-a nema nove delte');
  assert.equal(B.toObject().k2, 2);
  // novi lokalni zapis na B je jedina nova delta ZA A (B je taj koji je napisao k3)
  B.set('k3', 3);
  assert.deepEqual(B.delta(A.vectorClock()).map((e) => e.key), ['k3']);
  assert.deepEqual(A.delta(B.vectorClock()).map((e) => e.key), [], 'A nema ništa novo za B');
});

// ─────────────────────────── pheromone (TTL + decay) ───────────────────────────

test('pheromone: TTL 30s, decay (pola za 10s) i „heat" po zadatku', async () => {
  let now = 1_000_000;
  const ph = createPheromoneStore({ config: { ttlMs: 30_000, halfLifeMs: 10_000, minStrength: 0.02, decayIntervalMs: 50 }, now: () => now });
  const p = await ph.deposit({ tenantId: 'nmq', type: 'hot', taskId: 't1', strength: 1, by: 'node-A' });
  assert.equal(ph.active({ tenantId: 'nmq' })[0].currentStrength, 1);

  // poslije jednog poluživota jačina je ~0.5
  now += 10_000;
  assert.equal(ph.active({ tenantId: 'nmq' })[0].currentStrength, 0.5);
  assert.equal(ph.decayed(p, now), 0.5);

  // poslije 20s → 0.25
  now += 10_000;
  assert.equal(ph.active({ tenantId: 'nmq' })[0].currentStrength, 0.25);

  // spec: poslije 30s trag je ispario (TTL)
  now += 10_000;
  assert.equal(ph.active({ tenantId: 'nmq' }).length, 0, 'poslije 30s nema aktivnih tragova');
  assert.equal(ph.stats().total, 0, 'decay/expiry je obrisao zapis');

  // „heat": done/hot podiže, problem spušta
  now += 1000;
  await ph.deposit({ tenantId: 'nmq', type: 'hot', taskId: 't2', strength: 2 });
  await ph.deposit({ tenantId: 'nmq', type: 'problem', taskId: 't2', strength: 1 });
  const heat = ph.heat({ tenantId: 'nmq' });
  assert.equal(heat[0].taskId, 't2');
  assert.ok(heat[0].heat > 0);
  ph.stopDecay();
});

// ─────────────────────────── queue (RESP LPUSH/BRPOP) ───────────────────────────

function fakeRedisServer() {
  const lists = new Map();
  const kv = new Map();
  const server = net.createServer((socket) => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      for (;;) {
        if (!buf.startsWith('*')) break;
        const lines = buf.split('\r\n');
        if (lines.length < 2) break;
        const argc = Number(lines[0].slice(1));
        const args = [];
        let idx = 1;
        let ok = true;
        for (let i = 0; i < argc; i += 1) {
          if (lines[idx + 1] === undefined) {
            ok = false;
            break;
          }
          args.push(lines[idx + 1]);
          idx += 2;
        }
        if (!ok) break;
        buf = buf.slice(lines.slice(0, idx).join('\r\n').length + 2);
        const cmd = (args[0] ?? '').toUpperCase();
        const reply = (s) => socket.write(s);
        if (cmd === 'PING') reply('+PONG\r\n');
        else if (cmd === 'LPUSH' || cmd === 'RPUSH') {
          const list = lists.get(args[1]) ?? [];
          const vals = args.slice(2);
          if (cmd === 'LPUSH') list.unshift(...vals.reverse());
          else list.push(...vals);
          lists.set(args[1], list);
          reply(`:${list.length}\r\n`);
        } else if (cmd === 'LLEN') reply(`:${(lists.get(args[1]) ?? []).length}\r\n`);
        else if (cmd === 'BRPOP') {
          const list = lists.get(args[1]) ?? [];
          if (!list.length) reply('*-1\r\n');
          else {
            const val = list.pop();
            lists.set(args[1], list);
            reply(`*2\r\n$${Buffer.byteLength(args[1])}\r\n${args[1]}\r\n$${Buffer.byteLength(val)}\r\n${val}\r\n`);
          }
        } else if (cmd === 'SET') {
          kv.set(args[1], args[2]);
          reply('+OK\r\n');
        } else if (cmd === 'SETEX') {
          kv.set(args[1], args[3]);
          reply('+OK\r\n');
        } else if (cmd === 'GET') {
          const v = kv.get(args[1]);
          reply(v === undefined ? '$-1\r\n' : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
        } else if (cmd === 'LLEN') reply(`:${(lists.get(args[1]) ?? []).length}\r\n`);
        else reply('-ERR nepoznata komanda\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return { server, lists, kv };
}

test('queue: LPUSH/BRPOP preko ručnog RESP klijenta + visibility timeout', async () => {
  const { server } = fakeRedisServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const redis = createRespClient({ host: '127.0.0.1', port });
  const queue = createTaskQueue({ backend: 'resp', redis, tenantId: 'nmq', config: { visibilityTimeoutMs: 50 } });
  try {
    await queue.init();
    const t1 = await queue.push({ type: 'support.ticket', payload: { text: 'a' }, ttl: 5000 });
    await queue.push({ type: 'sales.lead', payload: { text: 'b' } });
    assert.equal(await queue.size(), 2);

    const popped = await queue.pop({ timeoutSec: 1 });
    assert.equal(popped.id, t1.id);
    assert.equal(queue.inFlight.size, 1);

    await queue.ack(popped.id, { success: true });
    assert.equal(queue.inFlight.size, 0);

    // neuspjeh vraća task u queue
    const p2 = await queue.pop({ timeoutSec: 1 });
    await queue.ack(p2.id, { success: false });
    assert.equal(await queue.size(), 1);
    const requeued = await queue.pop({ timeoutSec: 1 });
    assert.equal(requeued.attempts, 1, 'pokušaj se broji');

    // visibility timeout: task u letu se vraća
    await queue.requeueStale({ at: Date.now() + 1000 });
    assert.equal(await queue.size(), 1);
  } finally {
    await queue.close();
    await new Promise((r) => server.close(r));
  }
});

test('RESP parser: kodiranje i parsiranje (uključujući NULL i grešku)', () => {
  assert.equal(encodeCommand(['PING']), '*1\r\n$4\r\nPING\r\n');
  assert.equal(parseReply(Buffer.from('+OK\r\n')).value, 'OK');
  assert.equal(parseReply(Buffer.from('$-1\r\n')).value, null);
  assert.equal(parseReply(Buffer.from('$3\r\nab')), null);
  assert.deepEqual(parseReply(Buffer.from('*2\r\n$1\r\na\r\n$1\r\nb\r\n')).value, ['a', 'b']);
  assert.equal(parseReply(Buffer.from('-ERR puklo\r\n')).isError, true);
});

// ─────────────────────────── klaster fasadе (support/execution/research) ───────────────────────────

test('support cluster: ticket-router klasifikuje, stavlja u queue i ostavlja feromon', async () => {
  const queue = createTaskQueue({ backend: 'memory', tenantId: 'nmq' });
  await queue.init();
  const pheromone = createPheromoneStore({ config: { ttlMs: 30_000 } });
  const router = createTicketRouter({
    catalog: { get: (id) => (id === 'support' || id === 'finance' ? { id } : null) },
    queue,
    pheromone,
    tenantId: 'nmq',
  });
  const cases = [
    ['Tražim povraćaj novca za narudžbinu', 'refund', 'support'],
    ['Molim fakturu za oktobar', 'billing', 'finance'],
    ['Aplikacija ne radi, greška 500', 'technical', 'support'], // dev ne postoji u katalogu → fallback support
    ['Kada stiže narudžbina 1042?', 'ecommerce', 'support'],
    ['Pošaljite ponudu sa cijenama', 'sales', 'support'],
  ];
  for (const [text, type, agentId] of cases) {
    const res = await router.submit({ subject: text, text });
    assert.equal(res.type, type, `"${text}" → ${res.type}`);
    assert.equal(res.agentId, agentId);
    assert.ok(res.queued.id);
    assert.ok(res.pheromone.id);
    assert.equal(res.pheromone.ttlMs, 30_000);
  }
  assert.equal(queue.stats().queued, cases.length);
  assert.ok(pheromone.active({ tenantId: 'nmq' }).length >= cases.length);
});

test('execution cluster: tool-runner poštuje politiku i sandbox (fail-closed)', async () => {
  const executed = [];
  const runner = createToolRunner({
    tools: { execute: async (name) => { executed.push(name); return { ok: true, name }; } },
    policyResolver: () => ({ tools: { email_send: 'require_approval', shell_exec: 'deny' }, defaultTool: 'allow' }),
    sandbox: { evaluate: ({ toolName }) => (toolName === 'http_fetch' ? { allowed: false, reason: 'mreža nije dozvoljena' } : { allowed: true }) },
    tenantId: 'nmq',
  });
  // dozvoljeno
  assert.equal((await runner.run('calculator', { expression: '1+1' })).ok, true);
  // zabranjeno politikom
  await assert.rejects(() => runner.run('shell_exec', {}), (e) => e instanceof PolicyError && /zabranjen politikom/.test(e.message));
  // traži odobrenje
  await assert.rejects(() => runner.run('email_send', {}), (e) => e instanceof PolicyError && /traženje odobrenja|traži odobrenje/.test(e.message));
  assert.equal((await runner.run('email_send', {}, { approved: true })).ok, true);
  // sandbox blokira
  await assert.rejects(() => runner.run('http_fetch', {}), PolicyError);
  assert.deepEqual(executed, ['calculator', 'email_send']);
  assert.ok(runner.stats().total >= 2);
  assert.equal(runner.check('shell_exec').allowed, false);
});

test('research cluster: extractor izvlači činjenice i ne izmišlja', async () => {
  const ingested = [];
  const extractor = createExtractor({
    memory: { vectors: { ingest: async (t, { text }) => { ingested.push(text); return { chunks: 1 }; } } },
    tenantId: 'nmq',
  });
  const res = await extractor.extract('Kontakt je ana@prima.rs, telefon +381 60 123 4567, faktura br. F-2026-0042, iznos 1.500,00 EUR, rok 15.03.2026.');
  const kinds = res.facts.map((f) => f.kind);
  assert.ok(kinds.includes('email'));
  assert.ok(kinds.includes('amount'));
  assert.ok(kinds.includes('date'));
  assert.equal(res.ingested, 1);
  assert.ok(ingested[0].includes('ana@prima.rs'));

  // Nema izmišljanja: prazan tekst → nema činjenica, a „missing" prijavljuje šta nije nađeno
  const empty = await extractor.extract('Ništa korisno ovdje.');
  assert.equal(empty.facts.length, 0);
  assert.deepEqual(empty.missing.sort(), ['amount', 'date', 'email']);
});

// ─────────────────────────── federacija: samo fitness ───────────────────────────

test('federation: šalje SAMO metrike (nikad sadržaj), HMAC obavezan, top 10% se distribuira', () => {
  const registry = createGenomeRegistry({ secret: SECRET, config: { minSamples: 3, topPercent: 10 } });
  const edge = createFederationClient({ nodeId: 'edge-us-1', secret: SECRET, registry });

  // 1) dozvoljena polja
  const report = edge.buildReport({ fitness: 0.87, tasksDone: 142, pheromoneEfficiency: 0.92, tenantId: 'nmq' });
  assert.deepEqual(Object.keys(report).sort(), ['fitness', 'genome_id', 'node_id', 'pheromone_efficiency', 'sig', 'tasks_done', 'tenant_hash', 'ts'].sort());
  assert.ok(!('text' in report) && !('payload' in report), 'nijedno polje sa sadržajem');
  assert.equal(ALLOWED_REPORT_FIELDS.includes('text'), false);

  // 2) registry odbija bilo kakav sadržaj (čak i ako se podmetne)
  assert.throws(() => registry.report({ ...report, email_text: 'kupac@firma.com' }), (e) => e instanceof ValidationError && /nedozvoljena polja/.test(e.message));
  assert.throws(() => registry.report({ ...report, extra: 'x'.repeat(200) }), ValidationError);
  // 3) HMAC: tuđ potpis se odbija
  assert.throws(() => registry.report({ ...report, sig: 'a'.repeat(64) }), AuthError);
  // 4) ispravan izvještaj prolazi
  assert.equal(registry.report(report).accepted, true);

  // 5) tournament selection: genom sa dovoljno mjerenja i boljom fitness pobjeđuje
  const good = edge.buildReport({ fitness: 0.95, tasksDone: 200, pheromoneEfficiency: 0.9, genomeId: 'genom-B' });
  const bad = edge.buildReport({ fitness: 0.4, tasksDone: 20, pheromoneEfficiency: 0.3, genomeId: 'genom-C' });
  for (let i = 0; i < 4; i += 1) {
    registry.report(good);
    registry.report(bad);
  }
  // genom sa samo 1-2 mjerenja se NE razmatra (minSamples)
  registry.report(edge.buildReport({ fitness: 1, tasksDone: 5, genomeId: 'genom-D' }));
  const winners = registry.selectWinners();
  assert.equal(winners[0].genomeId, 'genom-B');
  assert.ok(!winners.some((w) => w.genomeId === 'genom-D'), 'nedovoljno uzoraka se ignoriše');
  assert.equal(winners[0].samples, 4);

  // 6) distribucija: bez objavljenog bloba nema update-a, sa blobom ima
  assert.equal(registry.bestUpdate().update, null);
  registry.publish({ genomeId: 'genom-B', blob: { systemPrompt: 'Bolji prompt', temperature: 0.2 }, fitness: 0.95, source: 'registry' });
  const update = registry.bestUpdate().update;
  assert.equal(update.genomeId, 'genom-B');
  assert.equal(update.blob.systemPrompt, 'Bolji prompt');
  assert.ok(update.samples >= 3);
});

test('federation: hot-swap je isključen po defaultu (predlog), a sa uključenim radi kroz control plane', async () => {
  const registry = createGenomeRegistry({ secret: SECRET, config: { minSamples: 1 } });
  const edge = createFederationClient({ nodeId: 'edge-1', secret: SECRET, registry });
  registry.report(edge.buildReport({ fitness: 0.9, tasksDone: 10, genomeId: 'g2' }));
  registry.publish({ genomeId: 'g2', blob: { systemPrompt: 'Novi prompt' } });
  const update = registry.bestUpdate().update;

  const deployed = [];
  const edgeOff = createFederationClient({ nodeId: 'edge-1', secret: SECRET, registry, controlPlane: { deploy: async (...a) => deployed.push(a) } });
  const off = await edgeOff.applyUpdate(update, { agentId: 'support' });
  assert.equal(off.applied, false);
  assert.match(off.reason, /autoHotSwap je isključen/);
  assert.equal(deployed.length, 0);

  const edgeOn = createFederationClient({ nodeId: 'edge-2', secret: SECRET, registry, controlPlane: { deploy: async () => ({ version: 3 }) }, config: { autoHotSwap: true, minFitnessGain: 0.01 } });
  const on = await edgeOn.applyUpdate(update, { agentId: 'support' });
  assert.equal(on.applied, true);
  assert.equal(on.genomeId, 'g2');
});

// ─────────────────────────── CRDT konvergencija preko mreže ───────────────────────────

test('CRDT preko mreže: sva tri node-a konvergiraju na identično stanje', async () => {
  const { a, b, c } = await threeNodes();
  try {
    const task = await a.submitTask({ type: 'support.ticket', payload: { text: 'x' }, value: 2 });
    await a.tick(); // A claim-uje i izvršava
    let same = false;
    for (let i = 0; i < 40 && !same; i += 1) {
      await wait(100);
      const fps = [a, b, c].map((n) => n.crdt.fingerprint());
      same = fps[0] === fps[1] && fps[1] === fps[2] && fps[0].length > 0;
    }
    assert.ok(same, `stanja nisu ista:\nA=${a.crdt.fingerprint()}\nB=${b.crdt.fingerprint()}\nC=${c.crdt.fingerprint()}`);
    assert.equal(b.crdt.get(`task:${task.id}`).doneBy, 'node-A');
    assert.equal(c.crdt.get(`result:${task.id}`).ok, true);

    // idempotentnost: dupli paket sa mreže ne mijenja stanje
    const before = a.crdt.fingerprint();
    const dup = a.crdt.merge(b.crdt.snapshot());
    assert.equal(dup.applied, 0);
    assert.equal(a.crdt.fingerprint(), before);
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
});

// ─────────────────────────── privatnost na žici + rate limit ───────────────────────────

test('privatnost: payload taska preko UDP-a je šifrovan (bez tajne se ne čita)', async () => {
  const SECRET_A = 'cluster-secret-A-1234567890';
  const frames = [];
  const a = await createSwarmNode({ nodeId: 'sec-A', port: 0, host: '127.0.0.1', secret: SECRET_A, config: { httpAdmin: false, autoLoop: false } });
  const watcher = await createGossip({ nodeId: 'sec-watch', port: 0, host: '127.0.0.1', secret: SECRET_A, config: { intervalMs: 60_000 } });
  // Čvorovi se stvaraju u vanjskom scope-u da bi ih `finally` SIGURNO zatvorio i kad neka tvrdnja padne
  let wrong = null;
  let right = null;
  try {
    await a.start();
    await watcher.start();
    await a.gossip.join([`127.0.0.1:${watcher.port}`]);
    // Snimi SVE što prođe mrežom (kao da neko prisluškuje)
    watcher.on('message', (msg) => frames.push(msg));

    const SECRET_TEXT = 'Kupac Ana, IBAN RS35123456789012345678, traži povraćaj';
    await a.submitTask({ type: 'support.ticket', payload: { text: SECRET_TEXT }, ttl: 30_000 });
    await wait(400);

    const raw = JSON.stringify(frames);
    assert.ok(frames.length > 0, 'mora biti uhvaćen barem jedan okvir');
    assert.equal(raw.includes(SECRET_TEXT), false, 'čist tekst NE smije ići preko mreže');
    assert.equal(raw.includes('IBAN RS35'), false, 'ni dijelovi sadržaja');
    const taskFrame = frames.find((f) => f.payload?.kind === 'task');
    assert.ok(taskFrame, 'task frame mora postojati');
    assert.ok(taskFrame.payload.payloadEnc, 'payload mora biti šifrovan');
    assert.equal(typeof taskFrame.payload.task.payload, 'undefined', 'task meta ne nosi payload');
    assert.equal(taskFrame.payload.task.payloadEncrypted, true);

    // Node sa POGREŠNOM tajnom ne može dešifrovati i NE izvršava task (fail-closed)
    wrong = await createSwarmNode({ nodeId: 'sec-wrong', port: 0, host: '127.0.0.1', secret: 'pogresna-tajna-0000000000', config: { httpAdmin: false, autoLoop: false } });
    await wrong.start();
    wrong.gossip.handleRaw(watcher.frame('DISSEMINATE', taskFrame.payload), { address: '127.0.0.1', port: 1 });
    await wait(150);
    assert.equal(wrong.crdt.get(`task:${taskFrame.payload.task.id}`), undefined, 'bez ključa task se ne prima u CRDT');
    assert.equal(wrong.tasks.has(taskFrame.payload.task.id), false, 'bez ključa se ne prima ni lokalno (fail-closed)');

    // Isti task kod čvora SA ispravnom tajnom se dešifruje i vidi — payload živi LOKALNO, ne u CRDT-u
    right = await createSwarmNode({ nodeId: 'sec-right', port: 0, host: '127.0.0.1', secret: SECRET_A, config: { httpAdmin: false, autoLoop: false } });
    await right.start();
    right.gossip.handleRaw(watcher.frame('DISSEMINATE', taskFrame.payload), { address: '127.0.0.1', port: 1 });
    await wait(150);
    const local = right.tasks.get(taskFrame.payload.task.id);
    assert.ok(local, 'sa ispravnom tajnom task se prima lokalno');
    assert.equal(local.payload.text, SECRET_TEXT, 'sadržaj je ispravno dešifrovan (lokalno)');

    // …a u CRDT-u (koji se širi rojem) NEMA čistog sadržaja — samo metapodaci
    const meta = right.crdt.get(`task:${taskFrame.payload.task.id}`);
    assert.ok(meta, 'metapodaci taska jesu u CRDT-u');
    assert.equal(meta.payload, undefined, 'CRDT ne smije nositi payload');
    assert.equal(JSON.stringify(meta).includes(SECRET_TEXT), false, 'ni dijelovi sadržaja u CRDT-u');
  } finally {
    if (wrong) await wrong.close().catch(() => {});
    if (right) await right.close().catch(() => {});
    await a.close();
    await watcher.stop();
  }
});

test('gossip: rate limit na UDP ulazu (flooding se odbija)', async () => {
  const node = await createGossip({ nodeId: 'rl-node', port: 0, host: '127.0.0.1', secret: SECRET, config: { intervalMs: 60_000, maxInboundPerMin: 5 } });
  const peer = await createGossip({ nodeId: 'rl-peer', port: 0, host: '127.0.0.1', secret: SECRET, config: { intervalMs: 60_000 } });
  try {
    await node.start();
    await peer.start();
    const frame = peer.frame('PING', { host: '127.0.0.1', port: peer.port });
    for (let i = 0; i < 5; i += 1) node.handleRaw(frame, { address: '127.0.0.1', port: peer.port });
    const before = node.stats.rateLimited ?? 0;
    for (let i = 0; i < 10; i += 1) node.handleRaw(frame, { address: '127.0.0.1', port: peer.port });
    assert.ok((node.stats.rateLimited ?? 0) > before, 'prekoračenje mora biti odbijeno');
    assert.ok(node.stats.duplicates > 0, 'dupli paketi se prepoznaju');
  } finally {
    await node.stop();
    await peer.stop();
  }
});

test('CRDT: sync(remoteClock) je alias za delta (ime iz smernica)', () => {
  const A = createCrdtBlackboard({ nodeId: 'A' });
  const B = createCrdtBlackboard({ nodeId: 'B' });
  A.set('k', 1);
  const viaSync = A.sync(B.vectorClock());
  const viaDelta = A.delta(B.vectorClock());
  assert.deepEqual(viaSync.map((e) => e.key), viaDelta.map((e) => e.key));
  assert.deepEqual(viaSync.map((e) => e.key), ['k']);
});

// ─────────────────────────── zabrana npm-a ───────────────────────────

test('nema npm zavisnosti: samo Node built-in moduli u kodu', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'dependencies mora biti prazan objekat');
  await assert.rejects(() => fs.access(path.join(ROOT, 'node_modules')), 'node_modules ne smije postojati');

  const files = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  await walk(path.join(ROOT, 'src'));
  assert.ok(files.length > 30, `skenirano ${files.length} fajlova`);

  const forbidden = ['ioredis', 'libp2p', 'bullmq', 'express', 'axios', 'lodash', 'ws', 'redis', 'kafkajs', 'amqplib'];
  const violations = [];
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    // skini komentare da tekst u komentarima ne pravi lažne pozitive
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    // specifier mora izgledati kao ime modula/putanja (bez razmaka), npr. 'fs', 'ioredis', './x.js'
    for (const m of code.matchAll(/(?:from|require\()\s*['"]([A-Za-z0-9@._/-]+)['"]/g)) {
      const spec = m[1];
      const bare = !spec.startsWith('.') && !spec.startsWith('node:');
      if (bare || forbidden.some((f) => spec === f || spec.startsWith(`${f}/`))) {
        violations.push(`${path.relative(ROOT, file)} → ${spec}`);
      }
    }
  }
  assert.deepEqual(violations, [], `zabranjeni moduli: ${violations.join(', ')}`);
});

// ─────────────────────────── CLI checklist ───────────────────────────

test('CLI: node src/index.js --port=... se diže i odgovara na /status (checklist)', async () => {
  const port = 18900 + Math.floor(Math.random() * 80);
  const child = spawn(process.execPath, ['src/index.js', `--port=${port}`, '--log=warn'], {
    cwd: ROOT,
    env: { ...process.env, NMQ_CLUSTER_SECRET: 'cli-checklist-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d.toString();
  });
  child.stderr.on('data', (d) => {
    out += d.toString();
  });
  try {
    let status = null;
    for (let i = 0; i < 60 && !status; i += 1) {
      await wait(100);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/status`);
        if (res.ok) status = await res.json();
      } catch {
        /* još se diže */
      }
    }
    assert.ok(status, `node nije odgovorio; izlaz: ${out.slice(0, 400)}`);
    assert.equal(status.nodeId, `node-${port}`);
    assert.ok(status.port >= 1);
    // task preko HTTP-a
    const res = await fetch(`http://127.0.0.1:${port}/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'support.ticket', payload: { text: 'reset lozinke' } }) });
    const body = await res.json();
    assert.equal(body.accepted, true);
    // i bude izvršen (node je sam, pa nema ko drugi)
    let done = 0;
    for (let i = 0; i < 40 && !done; i += 1) {
      await wait(100);
      const t = await (await fetch(`http://127.0.0.1:${port}/tasks`)).json();
      done = (t.done ?? []).length;
    }
    assert.ok(done >= 1, 'task mora biti izvršen');
    assert.match(out, /SYNCED|PARTIAL/, 'CLI mora ispisati SYNCED/PARTIAL liniju');
  } finally {
    child.kill('SIGKILL');
  }
});
