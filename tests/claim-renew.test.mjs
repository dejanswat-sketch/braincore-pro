/**
 * CLAIM RENEWAL + GC — regresija za 1h soak (docs/44 §7):
 *   • lease je isticao DOK vlasnik radi → 11 200 duplih izvršenja u 25 707 taskova
 *   • task:/result:/claim: zapisi se nikad nisu brisali → 37 751 zapis i heap 240 MB
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwarmNode } from '../src/node.js';
import { createCrdtBlackboard } from '../src/shared/blackboard.js';

const SECRET = 'renew-secret-1234567890';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('claim renewal: vlasnik osvježava lease dok radi (peer NE preuzima task)', async () => {
  const node = await createSwarmNode({
    nodeId: 'renew-node',
    port: 0,
    host: '127.0.0.1',
    secret: SECRET,
    config: { httpAdmin: false, autoLoop: false, durableSubmit: false, claimLeaseMs: 900, claimConfirmMs: 600, claimGraceMs: 100 },
    runner: async () => {
      await wait(2600); // namjerno DUŽE od lease-a (900 ms)
      return { output: 'ok' };
    },
  });
  try {
    await node.start();
    const task = await node.submitTask({ type: 'dug', payload: {}, ttl: 60_000 });
    const running = node.tick(); // claim + runner (2,6 s)
    await wait(1200);
    const first = node.crdt.get(`claim:${task.id}`);
    assert.equal(first.nodeId, 'renew-node', 'vlasnik drži claim');
    await wait(1200);
    const second = node.crdt.get(`claim:${task.id}`);
    assert.ok(second.at > first.at, `claim.at je osvježen (${first.at} → ${second.at})`);
    assert.equal(second.renewed, true, 'zapis nosi oznaku da je obnovljen');
    // drugi čvor koji vidi samo zapis NE smije ga preuzeti (claim je živ)
    const peer = createCrdtBlackboard({ nodeId: 'peer' });
    peer.merge(node.crdt.snapshot());
    const age = Date.now() - peer.get(`claim:${task.id}`).at;
    assert.ok(age < 900, `claim je svjež (${age} ms < lease 900 ms) — peer ne krade`);
    const rec = await running;
    assert.equal(rec.ok, true);
    assert.equal(node.done.length, 1);
  } finally {
    await node.close();
  }
});

test('GC: briše stare task:/result:/claim: zapise, čuva nezavršene i žive claim-ove', async () => {
  const crdt = createCrdtBlackboard({ nodeId: 'gc-node' });
  crdt.set('task:stari-done', { id: 'stari-done', state: 'done' });
  crdt.set('result:stari-done', { nodeId: 'gc-node', ok: true });
  crdt.set('task:stari-otvoren', { id: 'stari-otvoren' });
  crdt.set('claim:ziv', { nodeId: 'gc-node', at: Date.now() });
  crdt.set('drugi-kljuc', { v: 1 });

  const now = Date.now() + 20 * 60_000; // 20 min kasnije
  const res = crdt.gc({
    olderThanMs: 15 * 60_000,
    now,
    protect: (key, entry) => {
      if (key.startsWith('task:') && entry?.value?.state !== 'done') return true; // nezavršen se čuva
      if (key.startsWith('claim:')) {
        const c = entry?.value ?? null;
        return Boolean(c && now - c.at < 10_000); // živ claim se čuva
      }
      return false;
    },
  });
  assert.ok(res.removed >= 2, `uklonjeno najmanje 2 (bilo ${res.removed})`);
  assert.equal(crdt.get('task:stari-done'), undefined, 'završen task je uklonjen');
  assert.equal(crdt.get('result:stari-done'), undefined, 'rezultat je uklonjen');
  assert.ok(crdt.get('task:stari-otvoren'), 'nezavršen task ostaje');
  assert.equal(crdt.get('drugi-kljuc').v, 1, 'nepovezani ključevi se ne diraju');

  // GC ne dira brojače (oni žive van tabele)
  const node = await createSwarmNode({ nodeId: 'gc-count', port: 0, host: '127.0.0.1', secret: SECRET, config: { httpAdmin: false, autoLoop: false, durableSubmit: false }, runner: async () => ({ output: 'x' }) });
  await node.start();
  const t = await node.submitTask({ type: 'x', payload: {} });
  await node.tick();
  assert.equal(node.done.length, 1, 'brojač završenih preživljava');
  node.crdt.gc({ olderThanMs: 0, now: Date.now() + 60_000 });
  assert.equal(node.done.length, 1, 'poslije GC-a brojač je i dalje tačan');
  await node.close();
});