/**
 * MONOTONI FENCING TOKEN — regresija za nalaz iz soak-a (docs/44 §18).
 *
 * Dokaz iz mjerenja: `attempts = 1,2,2,2` — isti čvor je izvršio isti zadatak sa ISTIM `attempt`-om više
 * puta. Uzrok: LWW merge može vratiti STARIJI `claim:` zapis (`attempt: 1` poslije `attempt: 2`), pa čvor
 * ponovo izračuna `1 + 1 = 2`. Popravka: `attemptFloor` po taskId — token NIKAD ne opada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwarmNode } from '../src/node.js';

const SECRET = 'fencing-mono-secret-1234567890';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('attemptFloor: claim poslije STAROG zapisa ne ponavlja isti attempt', async () => {
  const node = await createSwarmNode({
    nodeId: 'mono-1',
    port: 0,
    host: '127.0.0.1',
    secret: SECRET,
    config: { httpAdmin: false, autoLoop: false, durableSubmit: false, claimGraceMs: 5, claimLeaseMs: 60_000 },
    runner: async () => ({ output: 'ok' }),
  });
  try {
    await node.start();
    const t1 = await node.submitTask({ type: 'mono.test', payload: {}, ttl: 60_000 });
    const c1 = await node.tryClaim(t1);
    assert.equal(c1.claimed, true, 'prvi claim je prosao');
    assert.equal(c1.attempt, 1, 'prvi attempt je 1');

    // LWW je vratio STARIJI zapis: claim ponovo nosi attempt 1
    node.crdt.set(`claim:${t1.id}`, { nodeId: 'drugi-cvor', instanceId: 'staro', at: Date.now() - 60_000, attempt: 1, leaseMs: 5 });
    await wait(20); // > claimGraceMs(5) -> claim je slobodan
    const c2 = await node.tryClaim(t1);
    assert.equal(c2.claimed, true, 'drugi claim je prosao');
    assert.ok(c2.attempt > 1, `attempt MORA rasti (dobijeno ${c2.attempt})`);

    node.crdt.set(`claim:${t1.id}`, { nodeId: 'drugi-cvor', instanceId: 'staro', at: Date.now() - 60_000, attempt: 1, leaseMs: 5 });
    await wait(20);
    const c3 = await node.tryClaim(t1);
    assert.ok(c3.attempt > c2.attempt, `attempt mora rasti i treci put (${c2.attempt} -> ${c3.attempt})`);
  } finally {
    await node.close();
  }
});
test('executing guard: drugi ulazak u isti task se preskace (runner pozvan TACNO jednom)', async () => {
  let runs = 0;
  const node = await createSwarmNode({
    nodeId: 'mono-2',
    port: 0,
    host: '127.0.0.1',
    secret: SECRET,
    config: { httpAdmin: false, autoLoop: false, durableSubmit: false },
    runner: async () => {
      runs += 1;
      await wait(120);
      return { output: 'ok' };
    },
  });
  try {
    await node.start();
    const t = await node.submitTask({ type: 'mono.test', payload: {}, ttl: 60_000 });
    const first = node.runTask({ ...t }, { attempt: 1 });
    await wait(20);
    const second = await node.runTask({ ...t }, { attempt: 1 });
    assert.equal(second.skipped, true, 'drugi ulazak je preskocen');
    await first;
    assert.equal(runs, 1, `runner je pozvan TACNO jednom (bilo ${runs})`);
  } finally {
    await node.close();
  }
});

test('odustajanje povlaci claim: cvor koji preskoci izvrsavanje ne ostavlja ziv claim', async () => {
  const node = await createSwarmNode({
    nodeId: 'withdraw-1',
    port: 0,
    host: '127.0.0.1',
    secret: SECRET,
    config: { httpAdmin: false, autoLoop: false, durableSubmit: false },
    runner: async () => {
      await wait(150);
      return { output: 'ok' };
    },
  });
  try {
    await node.start();
    const t = await node.submitTask({ type: 'withdraw.test', payload: {}, ttl: 60_000 });
    const claim = await node.tryClaim(t);
    assert.equal(claim.claimed, true, 'claim je uzet');
    assert.ok(node.crdt.get(`claim:${t.id}`), 'claim postoji poslije tryClaim');

    const first = node.runTask({ ...t }, { attempt: claim.attempt });   // drzi executing
    await wait(20);
    const second = await node.runTask({ ...t }, { attempt: claim.attempt }); // guard -> odustaje
    assert.equal(second.skipped, true, 'drugi ulazak je preskocen');
    await first;
    // poslije ZAVRSETKA posla claim se povlaci (finally/withdraw) — ne smije ostati "ziv" zapis
    const after = node.crdt.get(`claim:${t.id}`);
    assert.ok(!after || after.nodeId === undefined, `claim je povucen (ostalo: ${JSON.stringify(after)})`);
  } finally {
    await node.close();
  }
});
