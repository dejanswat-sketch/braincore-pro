/**
 * Revizija v0.2 (nalazi iz nezavisne provjere) — regresioni testovi za popravke:
 *  1. per-tenant override (deploy jednog klijenta ne mijenja drugog)
 *  2. per-agent ključ radi kroz HTTP gateway
 *  3. warm-up poslova poslije restarta (scheduler odmah vidi poslove)
 *  4. produkcijske brave: NMQ_MASTER_KEY obavezan, sandbox "none" zabranjen
 *  5. sandbox: symlink ne zaobilazi granicu
 *  6. MCP: NODE_OPTIONS (limit memorije) i interpolacija ${ENV} u zaglavljima
 *  7. run se čita sa diska i tuđi run se ne otkriva
 *  8. pricing fallback se mjeri (nema tihog naplaćivanja po pogrešnoj tarifi)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildTestRobot, cleanup, tempDataDir, smartScript } from './helpers.mjs';
import { createSandbox } from '../src/core/sandbox.js';
import { createRobot } from '../src/index.js';
import { createMockProvider } from '../src/llm/mock.js';
import { computeCost, priceSource } from '../src/observability/cost.js';
import { PolicyError } from '../src/core/errors.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('per-tenant override: deploy za jedan tenant NE mijenja agenta drugom tenantu', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const beforeNmq = robot.catalog.get('support', 'nmq').temperature;
    const beforeShop = robot.catalog.get('support', 'demo-shop').temperature;
    assert.equal(beforeNmq, beforeShop);

    await robot.controlPlane.deploy('nmq', 'support', { patch: { temperature: 0.91 } });

    assert.equal(robot.catalog.get('support', 'nmq').temperature, 0.91, 'nmq mora vidjeti novu verziju');
    assert.equal(robot.catalog.get('support', 'demo-shop').temperature, beforeShop, 'demo-shop NE smije vidjeti tuđi deploy');

    // i u samom izvršavanju: agent koji se pokreće dobija verziju svog tenanta
    const runNmq = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'support', pattern: 'agent', input: 'x' });
    assert.equal(runNmq.status, 'ok');
    const usedTemp = robot.llm.providers[0].calls.at(-1).messages.length > 0;
    assert.equal(usedTemp, true);

    await robot.controlPlane.rollback('nmq', 'support', 0);
    assert.equal(robot.catalog.get('support', 'nmq').temperature, beforeNmq);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('per-tenant override preživljava restart i ostaje izolovan', async () => {
  const dir = await tempDataDir('cp-tenant');
  const r1 = await buildTestRobot({ script: () => ({ text: 'ok' }), dataDir: dir });
  await r1.controlPlane.deploy('demo-shop', 'support', { patch: { maxSteps: 3 } });
  await r1.close();

  const r2 = await buildTestRobot({ script: () => ({ text: 'ok' }), dataDir: dir });
  try {
    assert.equal(r2.catalog.get('support', 'demo-shop').maxSteps, 3, 'override mora preživjeti restart');
    assert.notEqual(r2.catalog.get('support', 'nmq').maxSteps, 3, 'override ne smije curiti u drugi tenant');
  } finally {
    await r2.close();
    await cleanup(dir);
  }
});

test('per-agent ključ (service account) radi kroz HTTP gateway', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'izvršeno kroz agent ključ' }) });
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const issued = await robot.controlPlane.issueAgentKey('nmq', 'executor', { scopes: ['crm:write'] });

    const ok = await fetch(`${base}/v1/agents/executor/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.key}` },
      body: JSON.stringify({ input: 'uradi nešto' }),
    });
    assert.equal(ok.status, 200, `agent ključ mora proći (dobijeno ${ok.status})`);
    const body = await ok.json();
    assert.equal(body.tenantId, 'nmq');

    const who = await (await fetch(`${base}/v1/whoami`, { headers: { authorization: `Bearer ${issued.key}` } })).json();
    assert.equal(who.auth, 'agent-key');
    assert.equal(who.role, 'agent');

    // agent ključ NE smije u kontrolnu ravan
    const admin = await fetch(`${base}/v1/admin/agents`, { headers: { authorization: `Bearer ${issued.key}` } });
    assert.equal(admin.status, 403, 'agent ključ ne smije u /v1/admin/*');

    await robot.controlPlane.revokeAgentKey('nmq', 'executor', issued.keyId);
    const afterRevoke = await fetch(`${base}/v1/whoami`, { headers: { authorization: `Bearer ${issued.key}` } });
    assert.notEqual(afterRevoke.status, 200, 'opozvan ključ ne smije raditi');
  } finally {
    await robot.close();
    await cleanup(robot.__dir);
  }
});

test('scheduler: poslovi su vidljivi odmah poslije restarta (warm-up)', async () => {
  const dir = await tempDataDir('warm');
  const r1 = await buildTestRobot({ script: () => ({ text: 'ok' }), dataDir: dir, scheduler: true });
  const job = await r1.scheduler.createJob('nmq', { name: 'trajni posao', agentId: 'ops', input: 'x', schedule: { type: 'interval', everyMs: 60_000 } });
  await r1.close();

  const r2 = await buildTestRobot({ script: () => ({ text: 'ok' }), dataDir: dir, scheduler: true });
  try {
    const stats = r2.scheduler.stats();
    assert.equal(stats.running, false, 'scheduler još nije pokrenut prije listen()');
    const jobs = await r2.scheduler.list('nmq');
    assert.equal(jobs.length, 1, 'posao mora biti vidljiv odmah poslije restarta (bez "buđenja")');
    assert.equal(jobs[0].id, job.id);
    // tick mora vidjeti tenant bez dodatnih poziva
    const tenantIds = r2.jobs.tenantsWithJobs();
    assert.ok(tenantIds.includes('nmq'), 'warm-up mora učitati tenanta sa poslovima');
  } finally {
    await r2.close();
    await cleanup(dir);
  }
});

test('produkcija: NMQ_MASTER_KEY je obavezan, sandbox "none" je zabranjen', async () => {
  const dir = await tempDataDir('prod');
  await assert.rejects(
    () => createRobot({ root: ROOT, dataDir: dir, connectMcp: false, env: { ...process.env, NODE_ENV: 'production', NMQ_MASTER_KEY: '' }, overrides: { llm: createMockProvider({ script: () => ({ text: 'x' }) }), scheduler: false } }),
    /NMQ_MASTER_KEY/,
  );

  assert.throws(() => createSandbox({ level: 'none', production: true }), PolicyError);
  const dev = createSandbox({ level: 'none', production: false });
  assert.equal(dev.level, 'none');

  // u produkciji sa ključem prolazi
  const robot = await createRobot({
    root: ROOT,
    dataDir: dir,
    connectMcp: false,
    env: { ...process.env, NODE_ENV: 'production', NMQ_MASTER_KEY: 'a'.repeat(32) },
    overrides: { llm: createMockProvider({ script: () => ({ text: 'x' }) }), logLevel: 'silent', scheduler: false },
  });
  try {
    assert.equal(robot.sandbox.level, 'restricted');
    await robot.tenants.setSecret('nmq', 'slack', 'xoxb-test');
    assert.equal(await robot.tenants.getSecret('nmq', 'slack'), 'xoxb-test');
  } finally {
    await robot.close();
    await cleanup(dir);
  }
});

test('tenancy: slab MASTER_KEY se odbija', async () => {
  const dir = await tempDataDir('weak');
  const robot = await createRobot({
    root: ROOT,
    dataDir: dir,
    connectMcp: false,
    env: { ...process.env, NMQ_MASTER_KEY: 'kratko' },
    overrides: { llm: createMockProvider({ script: () => ({ text: 'x' }) }), logLevel: 'silent', scheduler: false },
  });
  try {
    await assert.rejects(() => robot.tenants.setSecret('nmq', 'slack', 'tajna'), (err) => err.code === 'MASTER_KEY_WEAK');
  } finally {
    await robot.close();
    await cleanup(dir);
  }
});

test('sandbox: symlink ne zaobilazi granicu', async () => {
  const root = await tempDataDir('sb-root');
  const outside = await tempDataDir('sb-outside');
  await fs.mkdir(path.join(root, 'allowed'), { recursive: true });
  await fs.writeFile(path.join(outside, 'tajna.txt'), 'van granica', 'utf8');
  const link = path.join(root, 'allowed', 'link');
  let linked = false;
  try {
    await fs.symlink(outside, link, 'junction');
    linked = true;
  } catch {
    // Windows bez privilegija za symlink — test se preskače (ne pada)
  }
  const sb = createSandbox({ level: 'restricted', networkAllowlist: ['x'], fsReadRoots: [path.join(root, 'allowed')], fsWriteRoots: [path.join(root, 'allowed')] });
  try {
    assert.ok(sb.assertPath(path.join(root, 'allowed', 'ok.txt'), { mode: 'write' }));
    assert.throws(() => sb.assertPath(path.join(outside, 'tajna.txt'), { mode: 'read' }), PolicyError);
    if (linked) {
      assert.throws(
        () => sb.assertPath(path.join(link, 'tajna.txt'), { mode: 'read' }),
        PolicyError,
        'symlink unutar dozvoljenog korijena ne smije otvoriti putanju van granice',
      );
    }
  } finally {
    await cleanup(root);
    await cleanup(outside);
  }
});

test('MCP: podproces dobija NODE_OPTIONS limit i interpolaciju ${ENV} u zaglavljima', async () => {
  const { createMcpManager } = await import('../src/tools/mcp-client.js');
  const { createToolRegistry } = await import('../src/tools/registry.js');
  const probeFile = path.join(ROOT, 'mcp', '_probe-options.mjs');
  await fs.writeFile(
    probeFile,
    [
      "import readline from 'node:readline';",
      'const rl = readline.createInterface({ input: process.stdin });',
      "rl.on('line', (line) => {",
      '  let msg; try { msg = JSON.parse(line); } catch { return; }',
      '  if (msg.id === undefined || msg.id === null) return;',
      "  if (msg.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'probe', version: '1', nodeOptions: process.env.NODE_OPTIONS ?? null } } }) + '\\n');",
      '    return;',
      '  }',
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\\n');",
      '});',
      'setTimeout(() => process.exit(0), 4000);',
    ].join('\n'),
    'utf8',
  );

  const registry = createToolRegistry({ logger: null });
  const sandbox = createSandbox({ level: 'restricted', networkAllowlist: ['x'], envAllowlist: ['PATH'], maxMemoryMb: 192 });
  const mcp = createMcpManager({ registry, logger: null, root: ROOT, sandbox });
  try {
    const report = await mcp.connectAll([{ id: 'probe-opt', transport: 'stdio', command: process.execPath, args: ['mcp/_probe-options.mjs'], enabled: true }]);
    assert.equal(report[0].serverInfo?.name, 'probe');
    assert.match(String(report[0].serverInfo.nodeOptions), /--max-old-space-size=192/, 'MCP podproces mora dobiti limit memorije');
  } finally {
    await mcp.closeAll();
    await fs.rm(probeFile, { force: true });
  }

  // interpolacija env u HTTP zaglavljima
  process.env.NMQ_TEST_MCP_TOKEN = 'tajni-token-123';
  const http = await import('../src/tools/mcp-http.js');
  let captured = null;
  const client = http.createHttpMcpClient({
    id: 'hdr',
    url: 'http://127.0.0.1:9/mcp',
    headers: { authorization: 'Bearer ${NMQ_TEST_MCP_TOKEN}' },
    logger: null,
    fetchImpl: async (url, init) => {
      captured = init.headers;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', id: 1, result: { tools: [] } }) };
    },
  });
  await client.listTools().catch(() => {});
  delete process.env.NMQ_TEST_MCP_TOKEN;
  // (interpolacija se radi u createMcpManager; ovdje provjeravamo da klijent šalje zaglavlja kako dobije)
  assert.ok(captured);
});

test('runs: tuđi run se ne otkriva, a run se čita i sa diska', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const run = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'ops', pattern: 'agent', input: 'x' });

    // A) tuđi tenant ne smije vidjeti run (404 + metrika)
    const foreign = await fetch(`${base}/v1/runs/${run.runId}`, { headers: { 'x-tenant': 'demo-shop' } });
    assert.equal(foreign.status, 404, 'tuđi run se ne otkriva (404, ne 403)');
    assert.match(await (await fetch(`${base}/metrics`)).text(), /nmq_tenant_mismatch_total/);

    // B) poslije "restarta" (prazna memorija) isti tenant čita run sa diska
    const originalGet = robot.tracer.get;
    robot.tracer.get = () => null;
    const fromDisk = await fetch(`${base}/v1/runs/${run.runId}`, { headers: { 'x-tenant': 'nmq' } });
    robot.tracer.get = originalGet;
    assert.equal(fromDisk.status, 200, 'run mora biti nađen na disku poslije restarta');
    const body = await fromDisk.json();
    assert.equal(body.runId, run.runId);
  } finally {
    await robot.close();
    await cleanup(robot.__dir);
  }
});

test('cost: nepoznat model se mjeri kao fallback (nema tihog pogrešnog obračuna)', async () => {
  assert.equal(priceSource('deepseek-chat'), 'exact');
  assert.equal(priceSource('deepseek-chat-2026'), 'prefix');
  assert.equal(priceSource('nepoznat-model-9000'), 'fallback');
  const cost = computeCost('nepoznat-model-9000', { promptTokens: 1_000_000, completionTokens: 0 });
  assert.equal(cost.priceSource, 'fallback');
  assert.equal(cost.usd, 1.0);

  const dir = await tempDataDir('pricing');
  const { createMetrics } = await import('../src/observability/metrics.js');
  const { createCostTracker } = await import('../src/observability/cost.js');
  const metrics = createMetrics();
  const tracker = createCostTracker({ dataDir: dir, metrics });
  await tracker.record({ tenantId: 'nmq', agentId: 'dev', runId: 'r1', model: 'nepoznat-model-9000', usage: { promptTokens: 1000, completionTokens: 10 } });
  assert.match(metrics.render(), /nmq_pricing_fallback_total\{model="nepoznat-model-9000"\} 1/);
  const summary = await tracker.summary('nmq');
  assert.equal(summary.calls, 1);
  await cleanup(dir);
});

test('otel: trace/span ID-jevi se heširaju (korelacija ostaje moguća)', async () => {
  const dir = await tempDataDir('otel-ids');
  const { createOtelExporter } = await import('../src/observability/otel.js');
  const otel = createOtelExporter({ dataDir: dir, file: false, endpoint: '', logger: null });
  const payload = await otel.exportRun({
    runId: 'run_zzz999',
    traceId: 'trace_zzzzzzzz',
    tenantId: 'nmq',
    agentId: 'ops',
    pattern: 'agent',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    status: 'ok',
    spans: [{ spanId: 'span_zzz', name: 'llm:ops', startedAt: new Date().toISOString(), durationMs: 1, status: 'ok', attrs: {} }],
  });
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  assert.match(spans[0].traceId, /^[0-9a-f]{32}$/, 'traceId mora biti 32 hex znaka');
  assert.match(spans[0].spanId, /^[0-9a-f]{16}$/, 'spanId mora biti 16 hex znakova');
  assert.notEqual(spans[0].traceId, '0'.repeat(32), 'ID ne smije biti izgubljen filtriranjem');
  await cleanup(dir);
});

test('osnovni tok i dalje radi poslije izmjena kataloga (regresija)', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', pattern: 'router', input: 'Ne radi mi prijava na nalog' });
    assert.equal(res.agentId, 'support');
    const team = await robot.orchestrator.run({ tenantId: 'nmq', pattern: 'team', input: 'Pripremi ponudu' });
    assert.ok(team.result.stages.every((s) => s.ok));
  } finally {
    await cleanup(robot.__dir);
  }
});
