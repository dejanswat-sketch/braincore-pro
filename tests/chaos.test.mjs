/**
 * CHAOS / IZDRŽLJIVOST — regresioni testovi za dvije greške koje je našao `scripts/chaos.mjs`.
 *
 * 1. Tračevi (digest) su produžavali život mrtvom čvoru → failure detection nije radio.
 *    Dokaz iz chaos run 1: node ubijen SIGKILL-om nije bio proglašen mrtvim >6 s.
 * 2. Task koji je držao ubijeni čvor ostajao je zauvijek „preuzet" → izgubljen posao.
 *    Dokaz iz chaos run 1: 5 od 18 taskova nikad nije završeno.
 *
 * Oba testa padaju bez popravki (provjereno prije commita).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGossip } from '../src/gossip.js';
import { createSwarmNode } from '../src/node.js';
import { createCrdtBlackboard } from '../src/shared/blackboard.js';

const SECRET = 'chaos-regression-secret-123456';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('gossip: tuđi tračevi NE produžavaju život mrtvom čvoru (failure detection radi)', async () => {
  const a = await createGossip({ nodeId: 'alpha', port: 0, host: '127.0.0.1', secret: SECRET, config: { intervalMs: 40, failureTimeoutMs: 150, deadAfterMisses: 2 } });
  const ghost = await createGossip({ nodeId: 'ghost', port: 0, host: '127.0.0.1', secret: SECRET, config: { intervalMs: 60_000 } });
  const talker = await createGossip({ nodeId: 'talker', port: 0, host: '127.0.0.1', secret: SECRET, config: { intervalMs: 60_000 } });
  try {
    await a.start();
    await talker.start();
    // ghost se javi jednom (a ga upozna), pa nestane
    a.handleRaw(ghost.frame('PING', { host: '127.0.0.1', port: 39901 }), { address: '127.0.0.1', port: 39901 });
    assert.equal(a.membershipList().find((m) => m.nodeId === 'ghost')?.status, 'alive');

    // Drugi čvor „priča" o ghost-u u svom digest-u (tračevi) — to NE smije biti dokaz života
    for (let i = 0; i < 12; i += 1) {
      a.handleRaw(
        talker.frame('PING', {
          host: '127.0.0.1',
          port: 39902,
          members: [{ nodeId: 'ghost', host: '127.0.0.1', port: 39901, status: 'alive', incarnation: 1, load: 0, lastSeen: new Date().toISOString() }],
        }),
        { address: '127.0.0.1', port: 39902 },
      );
      await wait(60);
    }
    const status = a.membershipList().find((m) => m.nodeId === 'ghost')?.status;
    assert.ok(['suspect', 'dead'].includes(status), `ghost mora biti suspect/dead, a jeste ${status} (tračevi ne smiju produžiti život)`);
  } finally {
    await a.stop();
    await ghost.stop();
    await talker.stop();
  }
});

test('claim lease: task koji je držao mrtav/odustali čvor vraća se u igru (nema izgubljenog posla)', async () => {
  const node = await createSwarmNode({
    nodeId: 'lease-node',
    port: 0,
    host: '127.0.0.1',
    secret: SECRET,
    config: { httpAdmin: false, autoLoop: false, claimLeaseMs: 300, claimGraceMs: 50 },
    runner: async () => ({ output: 'ok' }),
  });
  try {
    await node.start();
    const task = await node.submitTask({ type: 'load', payload: { text: 'x' }, ttl: 60_000 });

    // 1) Svjež claim od NEPOZNATOG (mrtvog) čvora → ne otimamo odmah (grace)
    node.crdt.set(`claim:${task.id}`, { nodeId: 'node-mrtvi', at: Date.now(), load: 0 });
    const early = await node.tick();
    assert.equal(early.idle, true, 'u grace periodu se claim poštuje');

    // 2) Poslije grace-a → task se vraća u igru i ovaj čvor ga preuzima i izvršava
    await wait(120);
    const later = await node.tick();
    assert.equal(later.ran, true, `task mora biti preuzet poslije grace-a (bilo: ${JSON.stringify(later)})`);
    assert.equal(later.taskId, task.id);
    assert.equal(node.done.length, 1);
    assert.equal(node.crdt.get(`claim:${task.id}`).nodeId, 'lease-node', 'novi claim je naš');

    // 3) Živ claim drugog čvora se i dalje poštuje
    const t2 = await node.submitTask({ type: 'load', payload: { text: 'y' }, ttl: 60_000 });
    node.gossip.members.set('node-zivi', { nodeId: 'node-zivi', host: '127.0.0.1', port: 1, status: 'alive', lastSeen: Date.now(), incarnation: 1, self: false });
    node.crdt.set(`claim:${t2.id}`, { nodeId: 'node-zivi', at: Date.now(), load: 0 });
    const respected = await node.tick();
    assert.equal(respected.idle, true);
    assert.ok(['sva_preuzeta', 'nema_posla', 'već preuzet'].includes(respected.reason), `razlog: ${respected.reason}`);
    assert.equal(node.done.length, 1, 'tuđi živ claim se ne otima');
  } finally {
    await node.close();
  }
});

test('CRDT: claim lease ne kvari konvergenciju (stanje ostaje isto na svim čvorovima)', () => {
  const A = createCrdtBlackboard({ nodeId: 'A' });
  const B = createCrdtBlackboard({ nodeId: 'B' });
  A.set('claim:t1', { nodeId: 'A', at: 1000, load: 0 });
  B.set('claim:t1', { nodeId: 'B', at: 2000, load: 1 });
  A.merge(B.snapshot());
  B.merge(A.snapshot());
  assert.equal(A.fingerprint(), B.fingerprint());
  assert.equal(A.get('claim:t1').nodeId, 'B', 'noviji claim (veći brojač / nodeId) pobjeđuje deterministički');
});
