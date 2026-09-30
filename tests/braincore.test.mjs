/**
 * BRAINCORE PRO — API sloj, live WebSocket, Stripe webhook i klaster fasade.
 *
 * Checklist koji ovaj fajl dokazuje (sve bez ijedne npm zavisnosti):
 *   ☑ RFC 6455 handshake i frame-ovi (accept key po spec vektoru, encode/parse round-trip)
 *   ☑ WebSocket feed: klijent odmah dobije snapshot, `broadcast` stiže svima
 *   ☑ API: /health, /status, /metrics, POST /task (sa i bez ključa), CORS, rate limit
 *   ☑ Genome Registry: prima SAMO metrike (HMAC), odbija sadržaj, vraća top-10% genom
 *   ☑ Stripe webhook: potpis (ispravan/pogrešan/istekao), idempotencija, izdavanje ključa (hash u fajlu)
 *   ☑ Klaster fasade: support intake, execution run (politika), research reportFromRewards
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSwarmNode } from '../src/node.js';
import { createApiServer } from '../src/api/server.js';
import { attachWebSocket, acceptKey, encodeFrame, parseFrame } from '../src/live/ws.js';
import { createLiveFeed } from '../src/live/feed.js';
import { createGenomeRegistry } from '../src/research/genome-registry.js';
import { createFederationClient } from '../src/research/federation.js';
import { createKeyIssuer, verifyStripeSignature, signPayload, handleStripeWebhook } from '../src/api/stripe.js';
import { createSupportCluster } from '../src/clusters/support.js';
import { createExecutionCluster } from '../src/clusters/execution.js';
import { createResearchCluster } from '../src/clusters/research.js';
import { createTaskQueue } from '../src/shared/queue.js';
import { createPheromoneStore } from '../src/shared/pheromone.js';
import { createToolRunner } from '../src/execution/tool-runner.js';
import { PolicyError, ValidationError, AuthError } from '../src/core/errors.js';

const SECRET = 'braincore-test-secret-1234567890';
const STRIPE_SECRET = 'whsec_test_1234567890abcdef';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── RFC 6455 ───────────────────────────

test('WebSocket: accept key po spec vektoru + frame encode/parse round-trip', () => {
  // RFC 6455 §1.3 — poznati primjer
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');

  const encoded = encodeFrame(JSON.stringify({ hello: 'svet' }));
  assert.equal(encoded[0], 0x81, 'FIN + TEXT opcode');
  const parsed = parseFrame(encoded);
  assert.ok(parsed);
  assert.equal(parsed.frame.opcode, 0x1);
  assert.deepEqual(JSON.parse(parsed.frame.payload.toString('utf8')), { hello: 'svet' });

  // duže od 125 bajtova → 16-bitna dužina
  const long = encodeFrame('x'.repeat(500));
  assert.equal(long[1] & 0x7f, 126);
  assert.equal(parseFrame(long).frame.payload.length, 500);
  // nepotpun bafer → null (čeka još bajtova)
  assert.equal(parseFrame(encoded.subarray(0, 3)), null);
  // klijentski frame je maskiran i mora se ispravno odmaskirati
  const masked = maskClientFrame('ping-od-klijenta');
  const back = parseFrame(masked);
  assert.equal(back.frame.payload.toString('utf8'), 'ping-od-klijenta');
});

/** Klijentski frame (obavezno maskiran) — koristi se u testu kao minimalni WS klijent. */
function maskClientFrame(text) {
  const data = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const header = Buffer.alloc(2);
  header[0] = 0x81;
  header[1] = 0x80 | data.length;
  const payload = Buffer.from(data);
  for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, payload]);
}

/** Minimalni WS klijent: handshake + čitanje frame-ova. */
function wsConnect(port, wsPath = '/events') {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        [
          `GET ${wsPath} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n',
        ].join('\r\n'),
      );
    });
    let handshakeDone = false;
    const messages = [];
    const listeners = [];
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const headers = buf.subarray(0, end).toString('utf8');
        if (!headers.includes('101')) return reject(new Error(`Handshake nije 101: ${headers.split('\r\n')[0]}`));
        if (!headers.toLowerCase().includes(`sec-websocket-accept: ${acceptKey(key)}`.toLowerCase())) return reject(new Error('Pogrešan Sec-WebSocket-Accept'));
        handshakeDone = true;
        buf = buf.subarray(end + 4);
        resolve({
          headers,
          messages,
          send: (text) => socket.write(maskClientFrame(text)),
          close: () => socket.destroy(),
          onMessage: (fn) => listeners.push(fn),
          waitFor: async (predicate, timeoutMs = 3000) => {
            const t0 = Date.now();
            for (;;) {
              const found = messages.find(predicate);
              if (found) return found;
              if (Date.now() - t0 > timeoutMs) throw new Error(`Nije stigla poruka (imam ${messages.length})`);
              await wait(25);
            }
          },
        });
      }
      for (;;) {
        const parsed = parseFrame(buf);
        if (!parsed) break;
        buf = buf.subarray(parsed.offset);
        if (parsed.frame.opcode === 0x1) {
          const msg = JSON.parse(parsed.frame.payload.toString('utf8'));
          messages.push(msg);
          for (const fn of listeners) fn(msg);
        }
      }
    });
    socket.on('error', reject);
  });
}

test('WebSocket feed: snapshot odmah, broadcast svima, nepoznata putanja se odbija', async () => {
  const node = await createSwarmNode({ nodeId: 'ws-node', port: 0, host: '127.0.0.1', secret: SECRET, config: { httpAdmin: false, autoLoop: false } });
  await node.start();
  const api = await createApiServer({ node, config: { port: 0, host: '127.0.0.1' } });
  const addr = await api.listen();
  try {
    const client = await wsConnect(addr.port);
    // odmah dolazi snapshot (onClient šalje feed.snapshot())
    const snap = await client.waitFor((m) => m.type === 'snapshot');
    assert.equal(snap.node.id, 'ws-node');
    assert.ok(Array.isArray(snap.nodes) && Array.isArray(snap.pheromones));
    assert.equal(api.ws.clientCount(), 1);

    // broadcast stiže klijentu
    api.ws.broadcast({ type: 'event', kind: 'test', hello: 'braincore' });
    const evt = await client.waitFor((m) => m.kind === 'test');
    assert.equal(evt.hello, 'braincore');

    // live feed šalje event kad task završi
    const task = await node.submitTask({ type: 'x', payload: {}, ttl: 5000 });
    await node.tick();
    const done = await client.waitFor((m) => m.type === 'event' && m.kind === 'task_done' && m.taskId === task.id);
    assert.equal(done.nodeId, 'ws-node');

    // klijentska poruka (klijent→server) ne ruši server
    client.send(JSON.stringify({ type: 'hello' }));
    await wait(50);
    assert.equal(api.ws.clientCount(), 1);

    // nepoznata WS putanja → 404 i socket se zatvara
    await assert.rejects(() => wsConnect(addr.port, '/nema'), /404/);
    client.close();
    await wait(50);
  } finally {
    await api.close();
    await node.close();
  }
});

// ─────────────────────────── API sloj ───────────────────────────

async function bootApi({ config = {}, registry = null, env = {} } = {}) {
  const node = await createSwarmNode({ nodeId: `api-${Math.floor(Math.random() * 1000)}`, port: 0, host: '127.0.0.1', secret: SECRET, config: { httpAdmin: false, autoLoop: false } });
  await node.start();
  const api = await createApiServer({ node, registry, config: { port: 0, host: '127.0.0.1', ...config }, env: { NMQ_CLUSTER_SECRET: SECRET, ...env } });
  const addr = await api.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  return { node, api, base };
}

test('API: health/status/metrics/live stranica + task bez ključa (demo tenant)', async () => {
  const { node, api, base } = await bootApi();
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.service, 'braincore-pro-api');
    assert.equal(health.npmDependencies, 0);

    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.nodeId, node.nodeId);
    assert.equal(status.peersAlive, 0);
    assert.ok(Array.isArray(status.alive));

    const metrics = await (await fetch(`${base}/metrics`)).json();
    assert.equal(metrics.tasksDone, 0);
    assert.equal(metrics.liveClients, 0);
    assert.ok(metrics.gossip && metrics.pheromones);

    const live = await fetch(`${base}/live`);
    assert.equal(live.status, 200);
    assert.match(live.headers.get('content-type'), /text\/html/);
    assert.match(await live.text(), /BRAINCORE PRO/);

    const jsRes = await fetch(`${base}/live.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type'), /javascript/);

    // task bez ključa → prihvaćen
    const res = await fetch(`${base}/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'support.ticket', payload: { text: 'reset' }, value: 5 }) });
    const body = await res.json();
    assert.equal(body.accepted, true);
    assert.equal(body.node, node.nodeId);
    assert.equal(body.task.payload, undefined, 'API ne vraća payload nazad');

    // izvršavanje: node radi sam, pa ga claim-uje
    await node.tick();
    assert.equal(node.done.length, 1);

    // validacija: task bez type
    const bad = await fetch(`${base}/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"payload":{}}' });
    assert.equal(bad.status, 400);
    // neispravan JSON
    const badJson = await fetch(`${base}/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nije json' });
    assert.equal(badJson.status, 400);
    // nepoznata ruta
    assert.equal((await fetch(`${base}/nema-ovoga`)).status, 404);
  } finally {
    await api.close();
    await node.close();
  }
});

test('API: CORS je ograničen na dozvoljene domene, rate limit radi', async () => {
  const { node, api, base } = await bootApi({ config: { rateLimitPerMin: 4, corsOrigins: ['https://braincore.pro'] } });
  try {
    const ok = await fetch(`${base}/health`, { headers: { origin: 'https://braincore.pro' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://braincore.pro');
    assert.equal(ok.headers.get('x-cors-blocked'), null);

    const blocked = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(blocked.headers.get('access-control-allow-origin'), 'https://braincore.pro');
    assert.equal(blocked.headers.get('x-cors-blocked'), '1', 'tuđ origin je označen kao blokiran');

    const preflight = await fetch(`${base}/task`, { method: 'OPTIONS', headers: { origin: 'https://braincore.pro' } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);

    // rate limit: limit je 4 uključujući prethodna 3 zahtjeva
    let limited = 0;
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch(`${base}/health`);
      if (res.status === 429) limited += 1;
    }
    assert.ok(limited > 0, `očekivan 429 bar jednom (dobio ${limited})`);
  } finally {
    await api.close();
    await node.close();
  }
});

test('API: API ključ (izdat posle plaćanja) se verifikuje; nevažeći se odbija', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'braincore-keys-'));
  const issuer = await createKeyIssuer({ dataDir });
  const { node, api, base } = await bootApi({ config: { dataDir }, env: { BRAINCORE_ADMIN_KEY: 'admin-test-key' } });
  try {
    const { key, record } = await issuer.issue({ tenantId: 'klijent-1', email: 'buyer@example.com', plan: 'pro-999' });
    assert.ok(key.startsWith('bnc_'));
    assert.equal(record.preview.includes('…'), true);

    // fajl čuva SAMO hash, nikad pun ključ
    const raw = await fs.readFile(path.join(dataDir, '_control', 'api-keys.json'), 'utf8');
    assert.equal(raw.includes(key), false, 'pun ključ ne smije biti u fajlu');
    assert.ok(raw.includes(record.hash));

    // važeći ključ prolazi i vezuje tenant
    const ok = await fetch(`${base}/task`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ type: 'support.ticket', payload: { text: 'x' } }) });
    assert.equal(ok.status, 200);

    const badKey = await fetch(`${base}/task`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'bnc_invalid-key-000000' }, body: JSON.stringify({ type: 'support.ticket' }) });
    assert.equal(badKey.status, 401);

    // admin ruta traži admin ključ
    assert.equal((await fetch(`${base}/v1/keys`)).status, 401);
    const list = await (await fetch(`${base}/v1/keys`, { headers: { 'x-api-key': 'admin-test-key' } })).json();
    assert.equal(list.keys.length, 1);
    assert.equal(list.keys[0].hash, undefined, 'hash se ne vraća kroz API');

    const revoked = await (await fetch(`${base}/v1/keys/${record.id}/revoke`, { method: 'POST', headers: { 'x-api-key': 'admin-test-key' } })).json();
    assert.ok(revoked.revoked.revokedAt);
    assert.equal(await issuer.verify(key), null, 'opozvan ključ više ne prolazi');
  } finally {
    await api.close();
    await node.close();
  }
});

test('Live feed: snapshot sadrži čvorove, feromone koji opadaju i rezultate', async () => {
  const node = await createSwarmNode({ nodeId: 'feed-node', port: 0, host: '127.0.0.1', secret: SECRET, config: { httpAdmin: false, autoLoop: false } });
  await node.start();
  const feed = createLiveFeed({ node, config: { intervalMs: 10_000 } });
  try {
    await node.pheromone.deposit({ tenantId: 'nmq', type: 'hot', taskId: 't1', by: 'feed-node', strength: 1 });
    const task = await node.submitTask({ type: 'support.ticket', payload: { text: 'x' } });
    await node.tick();
    const snap = feed.snapshot();
    assert.equal(snap.node.id, 'feed-node');
    assert.equal(snap.nodes[0].nodeId, 'feed-node');
    // tragovi: naš `hot` + ono što node sam ostavi pri claim-u i završetku (`claimed`, `done`)
    assert.ok(snap.pheromones.length >= 1);
    const hot = snap.pheromones.find((p) => p.type === 'hot');
    assert.ok(hot, 'hot trag mora biti u snapshotu');
    assert.ok(hot.strength > 0.9);
    assert.ok(snap.pheromones.some((p) => p.type === 'done'), 'node ostavlja i "done" trag');
    assert.equal(snap.tasks.length, 1);
    assert.equal(snap.results[0].taskId, task.id);
    assert.equal(snap.stats.tasksDone, 1);
    // eventi se pamte i vraćaju
    feed.push('custom', { a: 1 });
    assert.equal(feed.recent().at(-1).kind, 'custom');
  } finally {
    feed.stop();
    await node.close();
  }
});

// ─────────────────────────── Genome Registry ───────────────────────────

test('Genome Registry preko API-ja: prima samo metrike, vraća top-10% genom', async () => {
  const registry = createGenomeRegistry({ secret: SECRET, config: { minSamples: 2, topPercent: 10 } });
  const { node, api, base } = await bootApi({ registry });
  const edge = createFederationClient({ nodeId: 'edge-1', secret: SECRET, registry });
  try {
    const report = edge.buildReport({ fitness: 0.9, tasksDone: 10, pheromoneEfficiency: 0.8, genomeId: 'g-1' });
    const ok = await fetch(`${base}/v1/fitness`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).accepted, true);

    // sadržaj se odbija (dodatno polje)
    const withContent = await fetch(`${base}/v1/fitness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...report, ticket_text: 'kupac@firma.com' }),
    });
    assert.equal(withContent.status, 400);
    assert.match((await withContent.json()).error.message, /nedozvoljena polja/);

    // pogrešan potpis
    const badSig = await fetch(`${base}/v1/fitness`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...report, sig: 'a'.repeat(64) }) });
    assert.equal(badSig.status, 401);

    // prije objavljivanja genoma nema update-a
    const none = await fetch(`${base}/v1/genome/best`);
    assert.equal(none.status, 404);

    registry.report(report);
    registry.report(report);
    registry.publish({ genomeId: 'g-1', blob: { systemPrompt: 'Bolji prompt' } });
    const best = await (await fetch(`${base}/v1/genome/best?k=1`)).json();
    assert.equal(best.update.genomeId, 'g-1');
    assert.equal(best.update.blob.systemPrompt, 'Bolji prompt');
    assert.ok(best.update.samples >= 2);

    const stats = await (await fetch(`${base}/v1/registry/stats`)).json();
    assert.equal(stats.stats[0].genomeId, 'g-1');
  } finally {
    await api.close();
    await node.close();
  }
});

// ─────────────────────────── Stripe ───────────────────────────

test('Stripe webhook: potpis, idempotencija i izdavanje ključa', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'braincore-stripe-'));
  const issuer = await createKeyIssuer({ dataDir });
  const event = {
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_1', amount_total: 99_900, customer_details: { email: 'buyer@firma.com' }, metadata: { plan: 'pro-999', tenant: 'klijent-7' } } },
  };
  const rawBody = JSON.stringify(event);

  // 1) ispravan potpis → ključ izdat
  const good = await handleStripeWebhook({ rawBody, signature: signPayload({ rawBody, secret: STRIPE_SECRET }), secret: STRIPE_SECRET, issuer });
  assert.equal(good.status, 200);
  assert.equal(good.body.issued, true);
  assert.ok(good.body.key.startsWith('bnc_'));
  assert.equal(good.body.plan, 'pro-999');

  // 2) isti event ponovo → idempotentno (bez novog ključa)
  const dup = await handleStripeWebhook({ rawBody, signature: signPayload({ rawBody, secret: STRIPE_SECRET }), secret: STRIPE_SECRET, issuer });
  assert.equal(dup.body.duplicate, true);
  assert.equal((await issuer.list()).length, 1);

  // 3) pogrešan potpis → AuthError
  const otherSecret = 'whsec_drugi_0000000000000000';
  await assert.rejects(() => handleStripeWebhook({ rawBody, signature: signPayload({ rawBody, secret: otherSecret }), secret: STRIPE_SECRET, issuer }), AuthError);

  // 4) istekao timestamp → odbijeno
  const old = signPayload({ rawBody, secret: STRIPE_SECRET, timestamp: Math.floor(Date.now() / 1000) - 10_000 });
  await assert.rejects(() => handleStripeWebhook({ rawBody, signature: old, secret: STRIPE_SECRET, issuer }), AuthError);

  // 5) verifikator direktno
  assert.equal(verifyStripeSignature({ rawBody, header: signPayload({ rawBody, secret: STRIPE_SECRET }), secret: STRIPE_SECRET }).ok, true);
  assert.equal(verifyStripeSignature({ rawBody, header: 'nema', secret: STRIPE_SECRET }).ok, false);
  assert.equal(verifyStripeSignature({ rawBody, header: 't=abc,v1=def', secret: STRIPE_SECRET }).reason, 'losi_timestamp');
  assert.throws(() => verifyStripeSignature({ rawBody, header: 'x', secret: '' }), ValidationError);

  // 6) nepoznat tip događaja se ignoriše (ali potpis mora biti ispravan)
  const other = JSON.stringify({ id: 'evt_2', type: 'invoice.paid', data: { object: {} } });
  const ignored = await handleStripeWebhook({ rawBody: other, signature: signPayload({ rawBody: other, secret: STRIPE_SECRET }), secret: STRIPE_SECRET, issuer });
  assert.equal(ignored.body.ignored, 'invoice.paid');
});

test('Stripe webhook preko API rute (end-to-end, bez Stripe naloga)', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'braincore-wh-'));
  const { node, api, base } = await bootApi({ config: { dataDir }, env: { STRIPE_WEBHOOK_SECRET: STRIPE_SECRET } });
  try {
    const event = JSON.stringify({ id: 'evt_e2e', type: 'checkout.session.completed', data: { object: { id: 'cs_e2e', amount_total: 99_900, customer_details: { email: 'kupac@firma.com' } } } });
    const res = await fetch(`${base}/v1/stripe/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signPayload({ rawBody: event, secret: STRIPE_SECRET }) },
      body: event,
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.issued, true);

    const forged = await fetch(`${base}/v1/stripe/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signPayload({ rawBody: event, secret: 'whsec_pogresan' }) },
      body: event,
    });
    assert.equal(forged.status, 401);
  } finally {
    await api.close();
    await node.close();
  }
});

// ─────────────────────────── klaster fasade ───────────────────────────

test('Support cluster: intake klasifikuje, stavlja u queue i ostavlja feromon', async () => {
  const node = await createSwarmNode({ nodeId: 'cluster-node', port: 0, host: '127.0.0.1', secret: SECRET, config: { httpAdmin: false, autoLoop: false } });
  await node.start();
  try {
    const support = createSupportCluster({
      node,
      robot: { catalog: { get: (id) => (['support', 'finance'].includes(id) ? { id } : null) } },
      tenantId: 'nmq',
    });
    assert.equal(support.name, 'support');
    const routed = await support.intake({ subject: 'I want a refund for order 42', text: 'I want a refund for order 42' });
    assert.equal(routed.type, 'refund');
    assert.equal(routed.agentId, 'support');
    assert.ok(routed.queued.id);
    assert.ok(routed.pheromone.id);
    const health = support.health();
    assert.equal(health.load, 0);
    assert.ok(support.queueStats().queue.queued >= 1);
  } finally {
    await node.close();
  }
});

test('Execution cluster: run ide kroz alat ili echo, politika ostaje fail-closed', async () => {
  const calls = [];
  const tools = { execute: async (name, args) => { calls.push({ name, args }); return { ok: true, echoed: args }; } };
  const robot = {
    tools,
    policyResolver: () => ({ tools: { shell_exec: 'deny' }, defaultTool: 'allow' }),
    sandbox: { evaluate: () => ({ allowed: true }) },
  };
  const execution = createExecutionCluster({ robot, node: { nodeId: 'exec-node' } });
  // alat preko taska
  const viaTool = await execution.run({ id: 't1', type: 'x', tenantId: 'nmq', payload: { tool: 'calculator', args: { expression: '2+2' } } });
  assert.equal(viaTool.via, 'tool');
  assert.equal(viaTool.tool, 'calculator');
  assert.deepEqual(calls[0].args, { expression: '2+2' });
  // zabranjen alat
  await assert.rejects(() => execution.run({ id: 't2', type: 'x', payload: { tool: 'shell_exec', args: {} } }), PolicyError);
  // echo kad nema alata/robota
  const echo = await createExecutionCluster({ node: { nodeId: 'echo-node' } }).run({ id: 't3', type: 'generic', payload: {} });
  assert.equal(echo.via, 'echo');
  assert.match(echo.output, /echo-node/);
  assert.ok(execution.stats().total >= 1);
});

test('Research cluster: reportFromRewards šalje samo metrike, best() vraća genoma', async () => {
  const registry = createGenomeRegistry({ secret: SECRET, config: { minSamples: 1, topPercent: 100 } });
  const research = createResearchCluster({ node: { nodeId: 'edge-rs' }, secret: SECRET, registry, tenantId: 'nmq' });
  assert.equal(research.name, 'research');
  const res = await research.reportFromRewards({ rewards: [{ reward: 1, signals: { toolErrors: 0 } }, { reward: 0.5, signals: { toolErrors: 1 } }], tasksDone: 2 });
  assert.equal(res.sent, true);
  assert.equal(res.report.fitness, 0.75);
  assert.equal(res.report.pheromone_efficiency, 0.5);
  assert.deepEqual(Object.keys(res.report).sort(), ['fitness', 'genome_id', 'node_id', 'pheromone_efficiency', 'sig', 'tasks_done', 'ts'].sort());
  registry.publish({ genomeId: res.report.genome_id, blob: { systemPrompt: 'genom' } });
  assert.equal(research.best().update.genomeId, res.report.genome_id);
  assert.ok(research.stats().reports >= 1);
});

test('Klaster fasade rade i bez robota (degradacija, ne pad)', async () => {
  const node = await createSwarmNode({ nodeId: 'bare-node', port: 0, host: '127.0.0.1', secret: SECRET, config: { httpAdmin: false, autoLoop: false } });
  await node.start();
  try {
    const support = createSupportCluster({ node, robot: null });
    const routed = await support.intake({ text: 'Something else entirely' });
    assert.equal(routed.type, 'other');
    assert.equal(routed.agentId, 'support');

    const execution = createExecutionCluster({ robot: null, node });
    assert.equal(execution.toolRunner, null);
    assert.match((await execution.run({ id: 'x', type: 'y', payload: {} })).output, /bare-node/);

    const research = createResearchCluster({ node, robot: null, secret: SECRET });
    assert.ok(research.extractor);
    const facts = await research.extractor.extract('Contact ana@firma.rs on 15.03.2026 about 1.500,00 EUR.');
    assert.ok(facts.facts.length >= 3);
  } finally {
    await node.close();
  }
});

test('Queue i pheromone preko node-a: task ulazi u queue, feromon ispari po TTL-u', async () => {
  const queue = createTaskQueue({ backend: 'memory', tenantId: 'nmq' });
  await queue.init();
  let now = 5_000_000;
  const pheromone = createPheromoneStore({ config: { ttlMs: 30_000, halfLifeMs: 10_000 }, now: () => now });
  try {
    const pushed = await queue.push({ type: 'support.ticket', payload: { text: 'x' }, ttl: 30_000 });
    assert.equal(await queue.size(), 1);
    const popped = await queue.pop({ timeoutSec: 1 });
    assert.equal(popped.id, pushed.id);
    await queue.ack(popped.id, { success: true });

    await pheromone.deposit({ tenantId: 'nmq', type: 'hot', taskId: pushed.id, by: 'node', strength: 1 });
    assert.equal(pheromone.active({ tenantId: 'nmq' })[0].currentStrength, 1);
    now += 15_000;
    assert.ok(pheromone.active({ tenantId: 'nmq' })[0].currentStrength < 0.4);
    now += 15_000;
    assert.equal(pheromone.active({ tenantId: 'nmq' }).length, 0, 'poslije TTL-a trag je nestao');
  } finally {
    await queue.close();
    pheromone.stopDecay();
  }
});

test('tool-runner: politika deny/require_approval je fail-closed', async () => {
  const runner = createToolRunner({
    tools: { execute: async () => ({ ok: true }) },
    policyResolver: () => ({ tools: { shell_exec: 'deny', email_send: 'require_approval' }, defaultTool: 'allow' }),
  });
  await assert.rejects(() => runner.run('shell_exec', {}), PolicyError);
  await assert.rejects(() => runner.run('email_send', {}), PolicyError);
  assert.equal((await runner.run('email_send', {}, { approved: true })).ok, true);
  assert.equal(runner.check('shell_exec').allowed, false);
});
