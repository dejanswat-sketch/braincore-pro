/**
 * SPRINT 3 + SPRINT 5 — rotacija ključa bez prekida i kompakcija CRDT table.
 *
 * Oba testa odgovaraju stavkama iz `docs/40-PLAN-RAZVOJA.md`:
 *   • Sprint 3: `NMQ_CLUSTER_SECRET_PREV` — čvorovi se restartuju jedan po jedan bez ispadanja iz roja
 *   • Sprint 5: GC tombstone-a — tabla ne raste u nedogled, a konvergencija ostaje tačna
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGossip } from '../src/gossip.js';
import { createCrdtBlackboard } from '../src/shared/blackboard.js';
import { createSwarmNode } from '../src/node.js';

const OLD_SECRET = 'stari-kljuc-1234567890abcdef';
const NEW_SECRET = 'novi-kljuc-abcdef1234567890';

test('rotacija ključa: čvor prihvata STARI potpis dok traje rotacija, a potpisuje NOVIM', async () => {
  // Čvor B je već prešao na novi ključ, ali još prihvata stari (rolling restart)
  const b = await createGossip({ nodeId: 'rot-b', port: 0, host: '127.0.0.1', secret: NEW_SECRET, secretPrev: OLD_SECRET, config: { intervalMs: 60_000 } });
  const oldNode = await createGossip({ nodeId: 'rot-old', port: 0, host: '127.0.0.1', secret: OLD_SECRET, config: { intervalMs: 60_000 } });
  const stranger = await createGossip({ nodeId: 'rot-stranger', port: 0, host: '127.0.0.1', secret: 'treci-kljuc-00000000000000', config: { intervalMs: 60_000 } });
  try {
    await b.start();
    // 1) stari potpis prolazi i to se broji
    b.handleRaw(oldNode.frame('PING', { host: '127.0.0.1', port: 1 }), { address: '127.0.0.1', port: 1 });
    assert.equal(b.membershipList().some((m) => m.nodeId === 'rot-old'), true, 'čvor sa STARIM ključem mora biti prihvaćen tokom rotacije');
    assert.equal(b.stats.acceptedWithPrevKey, 1, 'broji se prijem starim ključem');

    // 2) tuđi ključ se odbija i tokom rotacije
    const before = b.stats.rejected;
    b.handleRaw(stranger.frame('PING', { host: '127.0.0.1', port: 2 }), { address: '127.0.0.1', port: 2 });
    assert.ok(b.stats.rejected > before, 'treći ključ nema pristup');

    // 3) potpis koji B šalje je NOVIM ključem: stari čvor (bez secretPrev) ga odbija
    const fresh = await createGossip({ nodeId: 'rot-fresh', port: 0, host: '127.0.0.1', secret: NEW_SECRET, config: { intervalMs: 60_000 } });
    await fresh.start();
    const bFrame = b.frame('PING', { host: '127.0.0.1', port: fresh.port });
    const oldOnly = await createGossip({ nodeId: 'rot-oldonly', port: 0, host: '127.0.0.1', secret: OLD_SECRET, config: { intervalMs: 60_000 } });
    await oldOnly.start();
    const rejectedBefore = oldOnly.stats.rejected;
    oldOnly.handleRaw(bFrame, { address: '127.0.0.1', port: 3 });
    assert.ok(oldOnly.stats.rejected > rejectedBefore, 'novi potpis se odbija na čvoru koji nije dobio novi ključ');

    // 4) bez `secretPrev` stari potpis se odbija (dokaz da je rotacija opt-in)
    const strict = await createGossip({ nodeId: 'rot-strict', port: 0, host: '127.0.0.1', secret: NEW_SECRET, config: { intervalMs: 60_000 } });
    await strict.start();
    const strictBefore = strict.stats.rejected;
    strict.handleRaw(oldNode.frame('PING', { host: '127.0.0.1', port: 4 }), { address: '127.0.0.1', port: 4 });
    assert.ok(strict.stats.rejected > strictBefore);
    await strict.stop();
    await fresh.stop();
    await oldOnly.stop();
  } finally {
    await b.stop();
    await oldNode.stop();
    await stranger.stop();
  }
});

test('kompakcija CRDT-a: briše samo stare tombstone-e, živi zapisi i konvergencija ostaju tačni', () => {
  const A = createCrdtBlackboard({ nodeId: 'A' });
  const B = createCrdtBlackboard({ nodeId: 'B' });

  A.set('ziv-1', { v: 1 });
  A.set('ziv-2', { v: 2 });
  A.set('obrisan', { v: 3 });
  A.delete('obrisan'); // tombstone
  A.set('svjez-tombstone', { v: 4 });
  A.delete('svjez-tombstone');

  assert.equal(A.stats().deleted, 2, 'dvije brisane stavke (tombstone)');
  assert.equal(A.stats().live, 2);

  // „sada" je 20 minuta poslije → oba tombstone-a su starija od 10 min
  const now = Date.now() + 20 * 60_000;
  const res = A.compact({ olderThanMs: 600_000, now });
  assert.equal(res.removed, 2, 'oba tombstone-a su uklonjena');
  assert.deepEqual(res.keys.sort(), ['obrisan', 'svjez-tombstone']);
  assert.equal(A.size, 2, 'ostaju samo živi zapisi');
  assert.equal(A.get('ziv-1').v, 1);
  assert.equal(A.get('obrisan'), undefined);

  // Kompakcija je idempotentna
  assert.equal(A.compact({ olderThanMs: 600_000, now }).removed, 0);

  // Konvergencija živih zapisa je i dalje tačna na oba čvora
  B.merge(A.snapshot());
  assert.equal(B.get('ziv-2').v, 2);
  assert.equal(A.fingerprint(), B.fingerprint(), 'poslije kompakcije stanja su identična');

  // Ako je tombstone SVJEŽ, ne dira se (čvor koji je bio offline može ga još vidjeti)
  const C = createCrdtBlackboard({ nodeId: 'C' });
  C.set('k', 1);
  C.delete('k');
  const fresh = C.compact({ olderThanMs: 600_000 }); // bez pomjeranja vremena
  assert.equal(fresh.removed, 0, 'svjež tombstone se ne uklanja');
});

test('node: kompakcija je uključena u petlje i gasi se sa close()', async () => {
  const node = await createSwarmNode({
    nodeId: 'compact-node',
    port: 0,
    host: '127.0.0.1',
    secret: NEW_SECRET,
    config: { httpAdmin: false, autoLoop: true, claimIntervalMs: 20, syncIntervalMs: 20, compactionIntervalMs: 30, compactionAgeMs: 0, durableSubmit: false },
  });
  await node.start();
  node.crdt.set('tmp', { v: 1 });
  node.crdt.delete('tmp');
  await new Promise((r) => setTimeout(r, 120)); // pusti kompakciju (age 0 → sve staro)
  assert.equal(node.crdt.get('tmp'), undefined);
  assert.equal(node.crdt.size, 0, 'tombstone je uklonjen automatskom kompakcijom');
  await node.close();
  assert.equal(node.closed, true);
});
