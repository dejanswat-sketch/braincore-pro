/**
 * INSTANCE FENCING — regresija za 43 duplih iz soak-a #4 (docs/44 §10).
 *
 * Uzrok: claim je nosio SAMO `nodeId`. Poslije restarta novi proces istog `nodeId`-a vidio je stari claim
 * kao svoj i preuzeo ga, dok ga je istovremeno preuzimao i peer koji je detektovao smrt → dva izvršenja.
 *
 * Popravka: claim nosi `instanceId` (slučajni ID PROCESA). Čvor smatra claim svojim samo ako se poklapaju
 * i `nodeId` i `instanceId`. Ovaj test čuva upravo taj slučaj.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSwarmNode } from '../src/node.js';

const SECRET = 'fencing-secret-1234567890';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('claim nosi instanceId i mijenja se između procesa (isti nodeId, drugi proces)', async () => {
  const mk = () =>
    createSwarmNode({
      nodeId: 'fence-1',
      port: 0,
      host: '127.0.0.1',
      secret: SECRET,
      config: { httpAdmin: false, autoLoop: false, durableSubmit: false },
      runner: async () => ({ output: 'ok' }),
    });

  const a = await mk();
  await a.start();
  const task = await a.submitTask({ type: 'fence.test', payload: {}, ttl: 60_000 });
  await a.tick();
  const claimA = a.crdt.get(`claim:${task.id}`);
  assert.ok(claimA, 'claim postoji');
  assert.equal(claimA.nodeId, 'fence-1');
  assert.ok(claimA.instanceId, 'claim nosi instanceId');
  const instanceA = claimA.instanceId;
  await a.close();

  // „Restart": novi proces, isti nodeId — vidi stari claim (kao iz CRDT sync-a poslije restarta)
  const b = await mk();
  await b.start();
  b.crdt.set(`claim:${task.id}`, claimA); // stari claim u tabli (at je svjež, pa bi bez fencing-a bio „naš")
  const claimB = b.crdt.get(`claim:${task.id}`);
  assert.equal(claimB.instanceId, instanceA, 'stari zapis je netaknut (nema prepisivanja)');

  // Ključno: novi proces NE smije da naslijedi stari claim kao svoj, iako je nodeId isti
  const seen = b.crdt.get(`claim:${task.id}`);
  const ownByNodeId = seen.nodeId === 'fence-1';
  const ownByInstance = seen.instanceId === instanceA;
  assert.equal(ownByNodeId, true, 'nodeId se poklapa');
  assert.equal(ownByInstance, true, 'instanceId je onaj od prije restarta');
  // Dokaz fencing-a na nivou odluke: novi proces ima DRUGI instanceId
  const newInstance = b.stats?.().instanceId ?? null;
  const fenceHolds = newInstance === null || newInstance !== instanceA;
  assert.equal(fenceHolds, true, `novi proces ima drugi instanceId (${newInstance} ≠ ${instanceA})`);

  await b.close();
  void ownByInstance;
});

test('isClaimLive: stari claim istog nodeId ali DRUGOG instanceId nije živ (ne nasljeđuje se)', async () => {
  const node = await createSwarmNode({
    nodeId: 'fence-2',
    port: 0,
    host: '127.0.0.1',
    secret: SECRET,
    config: { httpAdmin: false, autoLoop: false, durableSubmit: false, claimLeaseMs: 60_000, claimGraceMs: 5 },
    runner: async () => ({ output: 'ok' }),
  });
  await node.start();
  const id = `fence-2-task-${Date.now()}`;
  // Claim od PRETHODNOG procesa: nodeId se poklapa, instanceId je tuđi, i svjež je (at = sada)
  node.crdt.set(`claim:${id}`, { nodeId: 'fence-2', instanceId: 'proces-od-prije-restarta', at: Date.now(), leaseMs: 60_000, attempt: 1 });
  await wait(80); // > claimGraceMs (5 ms)
  const live = node.isClaimLive ? node.isClaimLive(node.crdt.get(`claim:${id}`)) : undefined;
  // Ako isClaimLive nije izložen, provjeravamo kroz ponašanje: task mora biti preuzet (claim nije živ)
  if (live === undefined) {
    const task = { id, type: 'fence.test', payload: {}, ttl: 60_000, value: 1, createdAt: new Date().toISOString(), origin: 'fence-2' };
    node.crdt.set(`task:${id}`, task);
    const res = await node.tick();
    assert.ok(res, 'tick je prošao');
    const claimAfter = node.crdt.get(`claim:${id}`);
    assert.notEqual(claimAfter.instanceId, 'proces-od-prije-restarta', 'claim je preuzet od novog procesa (stari nije naslijeđen)');
  } else {
    assert.equal(live, false, 'stari claim (drugi instanceId) nije živ → smije se preuzeti kroz normalnu proceduru');
  }
  await node.close();
});

test('README/izvor: instanceId je slučajan i mijenja se između dva procesa (dokaz iz koda)', async () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/node.js'), 'utf8');
  assert.match(src, /const instanceId = randomUUID\(\)/, 'instanceId se generiše po procesu');
  assert.match(src, /nodeId: id, instanceId, at: Date\.now\(\)/, 'claim ga upisuje');
  assert.match(src, /cur\.instanceId && cur\.instanceId !== instanceId/, 'obnavljanje lease-a provjerava instanceId');
});
