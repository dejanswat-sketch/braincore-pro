import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeCost, priceFor, createCostTracker } from '../src/observability/cost.js';
import { createMetrics } from '../src/observability/metrics.js';
import { createAuditLog } from '../src/observability/audit.js';
import { createTracer } from '../src/observability/trace.js';
import { createTenantStore, TENANT_ID_RE } from '../src/tenancy/store.js';
import { buildTestRobot, cleanup, tempDataDir } from './helpers.mjs';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { redact } from '../src/core/logger.js';

test('cost: cijena se računa po modelu, nepoznat model ima fallback', () => {
  const known = computeCost('deepseek-chat', { promptTokens: 1_000_000, completionTokens: 1_000_000 });
  assert.equal(known.usd, Number((0.27 + 1.1).toFixed(8)));
  const unknown = computeCost('nepoznat-model-9000', { promptTokens: 1_000_000, completionTokens: 0 });
  assert.equal(unknown.usd, 1.0, 'fallback cijena je 1 USD / 1M ulaznih tokena');
  assert.equal(computeCost('mock', { promptTokens: 999999, completionTokens: 999999 }).usd, 0);
  assert.ok(priceFor('deepseek-reasoner').out > priceFor('deepseek-chat').out);
});

test('cost: tracker akumulira po tenantu, agentu i modelu', async () => {
  const dir = await tempDataDir('cost');
  const tracker = createCostTracker({ dataDir: dir });
  await tracker.record({ tenantId: 'a', agentId: 'sales', runId: 'r1', model: 'deepseek-chat', usage: { promptTokens: 1000, completionTokens: 500 } });
  await tracker.record({ tenantId: 'a', agentId: 'support', runId: 'r2', model: 'deepseek-chat', usage: { promptTokens: 2000, completionTokens: 500 } });
  await tracker.record({ tenantId: 'b', agentId: 'sales', runId: 'r3', model: 'gpt-4o-mini', usage: { promptTokens: 1000, completionTokens: 1000 } });

  const a = await tracker.summary('a');
  assert.equal(a.calls, 2);
  assert.ok(a.byAgent.sales > 0 && a.byAgent.support > 0);
  const b = await tracker.summary('b');
  assert.equal(b.calls, 1);
  assert.ok(b.usd > 0);
  assert.ok(a.usd !== b.usd);
  await cleanup(dir);
});

test('metrics: Prometheus format sa labelama i histogramom', () => {
  const m = createMetrics();
  m.inc('runs_total', { tenant: 'nmq', agent: 'support' });
  m.inc('runs_total', { tenant: 'nmq', agent: 'support' });
  m.inc('runs_total', { tenant: 'demo-shop', agent: 'sales' }, 3);
  m.set('approvals_pending', { tenant: 'nmq' }, 2);
  m.observe('run_duration_seconds', { tenant: 'nmq' }, 1.5);
  const text = m.render();
  assert.match(text, /nmq_runs_total\{agent="support",tenant="nmq"\} 2/);
  assert.match(text, /nmq_runs_total\{agent="sales",tenant="demo-shop"\} 3/);
  assert.match(text, /nmq_approvals_pending\{tenant="nmq"\} 2/);
  assert.match(text, /nmq_run_duration_seconds_bucket\{le="\+Inf",tenant="nmq"\} 1/);
  assert.match(text, /nmq_run_duration_seconds_count\{tenant="nmq"\} 1/);
  assert.match(text, /# TYPE nmq_runs_total counter/);
});

test('audit: hash lanac se verifikuje i prepoznaje izmjenu', async () => {
  const dir = await tempDataDir('audit');
  const audit = createAuditLog({ dataDir: dir });
  await audit.append({ tenantId: 'nmq', actor: 'agent', action: 'tool_call', tool: 'calculator', args: { expression: '2+2' }, decision: 'allow', outcome: 'ok' });
  await audit.append({ tenantId: 'nmq', actor: 'agent', action: 'tool_call', tool: 'email_send', args: {}, decision: 'require_approval', outcome: 'pending' });
  await audit.append({ tenantId: 'nmq', actor: 'human', action: 'approval_decision', tool: 'email_send', args: { approve: true }, decision: 'approved', outcome: 'ok' });

  const ok = await audit.verify('nmq');
  assert.equal(ok.ok, true);
  assert.equal(ok.checked, 3);

  const file = audit.path('nmq');
  const rows = (await fs.readFile(file, 'utf8')).trim().split('\n');
  // mijenjamo drugi zapis (npr. neko pokuša da sakrije akciju)
  const tampered = JSON.parse(rows[1]);
  tampered.tool = 'calculator';
  rows[1] = JSON.stringify(tampered);
  await fs.writeFile(file, `${rows.join('\n')}\n`, 'utf8');

  const bad = await audit.verify('nmq');
  assert.equal(bad.ok, false);
  assert.equal(bad.firstBadSeq, 2);
  await cleanup(dir);
});

test('audit: tajne i PII se ne upisuju u zapis', async () => {
  const dir = await tempDataDir('audit2');
  const audit = createAuditLog({ dataDir: dir });
  await audit.append({
    tenantId: 'nmq',
    action: 'tool_call',
    tool: 'http_fetch',
    args: { url: 'https://x.com', apiKey: 'sk-abcdefghijklmnopqrstuvwxyz123456', note: 'klijent petar@example.com' },
  });
  const rows = await audit.read('nmq');
  const raw = JSON.stringify(rows[0]);
  assert.ok(!raw.includes('sk-abcdefghijklmnopqrstuvwxyz123456'), 'API ključ ne smije biti u auditu');
  await cleanup(dir);
});

test('logger: redaktuje tajne u porukama', () => {
  assert.ok(!redact('ključ je sk-abcdefghijklmnopqrstuvwxyz123456').includes('sk-abcdefghijklmnopqrst'));
  assert.match(redact('token=ghp_abcdefghijklmnopqrstuvwxyz0123456789'), /REDACTED|\*\*\*/);
});

test('trace: run i spanovi se čuvaju i upisuju na disk', async () => {
  const dir = await tempDataDir('trace');
  const metrics = createMetrics();
  const tracer = createTracer({ dataDir: dir, metrics });
  const run = tracer.startRun({ tenantId: 'nmq', agentId: 'support', pattern: 'agent', input: 'test' });
  const s = tracer.span(run, 'llm:support', { step: 1 });
  s.end({ tokensIn: 10 });
  const s2 = tracer.span(run, 'tool:calculator', {});
  s2.fail(new Error('puklo'));
  await tracer.endRun(run, { output: 'rezultat', usage: { tokensIn: 10, tokensOut: 5 }, costUsd: 0.001 });

  assert.equal(tracer.get(run.runId).status, 'ok');
  assert.equal(run.spans.length, 2);
  assert.equal(run.spans[1].status, 'error');

  const fromDisk = await tracer.readFromDisk({ tenantId: 'nmq' });
  assert.equal(fromDisk.length, 1);
  assert.equal(fromDisk[0].runId, run.runId);
  assert.match(metrics.render(), /nmq_runs_finished_total/);
  await cleanup(dir);
});

test('tenancy: tenantId validacija, API ključ i rate limit', async () => {
  const dir = await tempDataDir('tenant');
  const config = await loadConfig({ root: path.resolve(import.meta.dirname, '..'), dataDir: dir });
  const tenants = createTenantStore({ config, dataDir: dir, logger: null, env: { apiKeyPepper: 'pepper', masterKey: 'master' } });

  assert.ok(TENANT_ID_RE.test('demo-shop'));
  assert.equal(TENANT_ID_RE.test('../etc'), false);
  assert.throws(() => tenants.validateId('../etc'));

  const key = 'nmq_test_key_123';
  const hash = tenants.hashKey(key);
  config.tenants[0].apiKeys = [{ id: 'k1', hash, role: 'admin' }];
  const auth = tenants.authenticate({ apiKey: key });
  assert.equal(auth.tenantId, config.tenants[0].id);
  assert.equal(auth.role, 'admin');
  assert.throws(() => tenants.authenticate({ apiKey: 'pogresan', required: true }));

  assert.equal(tenants.can('admin', 'run'), true);
  assert.equal(tenants.can('viewer', 'run'), false);
  assert.throws(() => tenants.assertCan('viewer', 'run'));

  let allowed = 0;
  for (let i = 0; i < 5; i += 1) if (tenants.rateLimit('nmq', 3).ok) allowed += 1;
  assert.equal(allowed, 3);

  await tenants.setSuspended('nmq', true, 'test');
  assert.equal(tenants.isSuspended('nmq'), true);
  assert.throws(() => tenants.authenticate({ apiKey: key }));
  await cleanup(dir);
});

test('tenancy: tajne se šifruju AES-256-GCM i mogu se pročitati samo sa istim ključem', async () => {
  const dir = await tempDataDir('secrets');
  const config = await loadConfig({ root: path.resolve(import.meta.dirname, '..'), dataDir: dir });
  const env = { apiKeyPepper: 'pepper', masterKey: 'master-key-123456', ...process.env };
  const t1 = createTenantStore({ config, dataDir: dir, logger: null, env });
  await t1.setSecret('nmq', 'slack', 'xoxb-super-tajni-token');

  const raw = await fs.readFile(t1.paths.secretsFile('nmq'), 'utf8');
  assert.ok(!raw.includes('xoxb-super-tajni-token'), 'tajna ne smije biti u čitljivom obliku');
  assert.equal(await t1.getSecret('nmq', 'slack'), 'xoxb-super-tajni-token');
  assert.equal(await t1.getSecret('nmq', 'nema'), null);

  // drugi ključ (pogrešan master) ne može dekriptovati
  const t2 = createTenantStore({ config, dataDir: dir, logger: null, env: { ...env, masterKey: 'drugi-kljuc' } });
  await assert.rejects(() => t2.getSecret('nmq', 'slack'));
  await cleanup(dir);
});

test('config: javna konfiguracija ne sadrži tajne', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }), env: { NMQ_LLM_API_KEY: 'sk-tajna-abcdefghijklmnop' } });
  try {
    const pub = robot.config.publicConfig();
    const json = JSON.stringify(pub);
    assert.ok(!json.includes('sk-tajna'));
    assert.equal(pub.agents.length, 19);
    assert.equal(pub.mcpServers.length >= 1, true);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('logger: level filter i child bindings', async () => {
  const lines = [];
  const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) }).child({ tenant: 'nmq' });
  log.debug('ne treba');
  log.info('ne treba');
  log.warn('treba', { a: 1 });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.msg, 'treba');
  assert.equal(parsed.tenant, 'nmq');
  assert.equal(parsed.level, 'warn');
});
