/**
 * ZATVARANJE ČVORA — regresija koju je našao soak test (restart čvora pod opterećenjem):
 * poslije `close()` su claim/sync/queue tajmeri nastavljali da rade, pa je log punio
 * „node.tick_failed: Not running" (čvor je mrtav, a još kuca).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwarmNode } from '../src/node.js';

const SECRET = 'close-secret-1234567890';

test('close(): zaustavlja sve petlje i blokira dalji rad (nema „Not running")', async () => {
  const warnings = [];
  const logger = { warn: (msg, fields) => warnings.push({ msg, ...(fields ?? {}) }), info: () => {}, debug: () => {}, error: () => {} };
  const node = await createSwarmNode({
    nodeId: 'close-node',
    port: 0,
    host: '127.0.0.1',
    secret: SECRET,
    logger,
    config: { httpAdmin: false, autoLoop: true, claimIntervalMs: 20, syncIntervalMs: 20, durableSubmit: false, taskTtlMs: 500 },
    runner: async () => ({ output: 'ok' }),
  });
  await node.start();
  await node.submitTask({ type: 'x', payload: {} });
  await new Promise((r) => setTimeout(r, 120)); // pusti da petlje rade
  await node.close();
  assert.equal(node.closed, true, 'čvor je označen kao zatvoren');

  const before = warnings.length;
  await new Promise((r) => setTimeout(r, 200)); // ovdje su ranije izlazili „Not running" warnovi
  const after = warnings.filter((w) => w.msg === 'node.tick_failed');
  assert.equal(after.length, 0, `poslije close() ne smije biti tick_failed (bilo ${after.length})`);
  assert.equal(warnings.length, before, 'nijedan novi warn poslije zatvaranja');

  const ticked = await node.tick();
  assert.equal(ticked.idle, true);
  assert.equal(ticked.reason, 'closed', 'tick na zatvorenom čvoru vraća "closed", ne baca grešku');

  // dvostruko zatvaranje je bezopasno
  await node.close();
});