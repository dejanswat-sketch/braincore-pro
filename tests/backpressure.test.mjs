/**
 * BACKPRESSURE — test koji je iznudio soak test (docs/44 §3): kad je red pun, odbijamo odmah (429)
 * umjesto da pustimo da latencija eksplodira.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwarmNode } from '../src/node.js';
import { createApiServer } from '../src/api/server.js';
import { QueueFullError } from '../src/core/errors.js';

const SECRET = 'backpressure-secret-1234567890';

test('backpressure: node odbija novi task kad je red pun (QueueFullError)', async () => {
  const node = await createSwarmNode({
    nodeId: 'bp-node',
    port: 0,
    host: '127.0.0.1',
    secret: SECRET,
    config: { httpAdmin: false, autoLoop: false, maxQueueDepth: 2, durableSubmit: false, taskTtlMs: 60_000 },
    runner: async () => ({ output: 'ok' }),
  });
  try {
    await node.start();
    await node.submitTask({ type: 'a', payload: {} });
    await node.submitTask({ type: 'b', payload: {} });
    assert.equal(node.stats().queue.queued, 2);
    await assert.rejects(() => node.submitTask({ type: 'c', payload: {} }), (err) => {
      assert.ok(err instanceof QueueFullError, `očekivan QueueFullError, dobio ${err.name}`);
      assert.equal(err.status, 429);
      assert.equal(err.retryable, true);
      assert.equal(err.details.maxQueueDepth, 2);
      return true;
    });
    // isključeno → ista situacija prolazi (da se zna da je ponašanje konfigurabilno)
    const loose = await createSwarmNode({ nodeId: 'bp-loose', port: 0, host: '127.0.0.1', secret: SECRET, config: { httpAdmin: false, autoLoop: false, maxQueueDepth: 2, shedWhenBusy: false, durableSubmit: false } });
    await loose.start();
    for (let i = 0; i < 4; i += 1) await loose.submitTask({ type: 'x', payload: {} });
    assert.equal(loose.stats().queue.queued, 4);
    await loose.close();
  } finally {
    await node.close();
  }
});

test('backpressure: API vraća 429 + Retry-After kad je red pun', async () => {
  const node = await createSwarmNode({
    nodeId: 'bp-api',
    port: 0,
    host: '127.0.0.1',
    secret: SECRET,
    config: { httpAdmin: false, autoLoop: false, maxQueueDepth: 1, durableSubmit: false },
  });
  const api = await createApiServer({ node, config: { port: 0, host: '127.0.0.1' } });
  const addr = await api.listen();
  try {
    const first = await fetch(`http://127.0.0.1:${addr.port}/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'a', payload: {} }) });
    assert.equal(first.status, 200);
    const second = await fetch(`http://127.0.0.1:${addr.port}/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'b', payload: {} }) });
    assert.equal(second.status, 429, 'drugi task mora biti odbijen (red je pun)');
    assert.equal(second.headers.get('retry-after'), '1');
    const body = await second.json();
    assert.equal(body.error.code, 'QUEUE_FULL');
    assert.equal(body.error.retryable, true);
  } finally {
    await api.close();
    await node.close();
  }
});