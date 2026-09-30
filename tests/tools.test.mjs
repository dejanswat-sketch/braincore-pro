import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMath, assertUrlAllowed, registerBuiltinTools } from '../src/tools/builtin.js';
import { createToolRegistry } from '../src/tools/registry.js';
import { createMcpManager } from '../src/tools/mcp-client.js';
import { PolicyError, ValidationError, ToolError } from '../src/core/errors.js';
import { buildTestRobot, cleanup, ROOT } from './helpers.mjs';

test('calculator: računa ispravno i odbija opasne izraze', () => {
  assert.equal(evaluateMath('2+3*4'), 14);
  assert.equal(evaluateMath('(1200*1.2)+150'), 1590);
  assert.equal(evaluateMath('2^10'), 1024);
  assert.equal(evaluateMath('max(3,7)+sqrt(16)'), 11);
  assert.equal(Number(evaluateMath('round(10/3)')), 3);
  assert.throws(() => evaluateMath('process.exit(1)'), ValidationError);
  assert.throws(() => evaluateMath('1/0'), ValidationError);
  assert.throws(() => evaluateMath('1+'), ValidationError);
});

test('http_fetch: allowlist blokira tuđe domene', () => {
  assert.equal(assertUrlAllowed('https://api.deepseek.com/v1/models', ['api.deepseek.com']), true);
  assert.equal(assertUrlAllowed('https://sub.api.deepseek.com/x', ['api.deepseek.com']), true);
  assert.throws(() => assertUrlAllowed('https://zli.example.com/steal', ['api.deepseek.com']), PolicyError);
  assert.throws(() => assertUrlAllowed('file:///etc/passwd', ['api.deepseek.com']), PolicyError);
  assert.throws(() => assertUrlAllowed('http://x.com', []), PolicyError);
});

test('registry: timeout i retry', async () => {
  const registry = createToolRegistry({ logger: null });
  let attempts = 0;
  registry.register({
    name: 'flaky',
    riskLevel: 'low',
    retries: 2,
    timeoutMs: 200,
    handler: async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('privremeno');
        err.retryable = true;
        throw err;
      }
      return { ok: true, attempts };
    },
  });
  const res = await registry.execute('flaky', {}, { tenantId: 'nmq' });
  assert.equal(res.result.attempts, 3);

  registry.register({ name: 'spor', riskLevel: 'low', timeoutMs: 60, retries: 0, handler: () => new Promise((r) => setTimeout(r, 300)) });
  await assert.rejects(() => registry.execute('spor', {}, { tenantId: 'nmq' }), (err) => err.code === 'TIMEOUT');
});

test('registry: nepoznat alat i dry-run', async () => {
  const registry = createToolRegistry({ logger: null });
  registry.register({ name: 'x', riskLevel: 'high', handler: async () => ({ done: true }) });
  await assert.rejects(() => registry.execute('nema_me', {}, { tenantId: 'nmq' }), (err) => err.code === 'NOT_FOUND');
  const dry = await registry.execute('x', { a: 1 }, { tenantId: 'nmq', dryRun: true });
  assert.equal(dry.wouldRun, true);
  assert.equal(dry.dryRun, true);
});

test('ugrađeni alati: crm upsert + get, faktura, report, lead_score', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const ctx = { tenantId: 'nmq', agentId: 'sales' };

    const contact = await robot.tools.execute('crm_upsert', { entityType: 'contact', fields: { name: 'Prima d.o.o.', mrr: 149 } }, ctx);
    assert.ok(contact.result.id);
    const found = await robot.tools.execute('crm_get', { entityType: 'contact', id: contact.result.id }, ctx);
    assert.equal(found.result.name, 'Prima d.o.o.');

    // update iste firme ne pravi duplikat
    await robot.tools.execute('crm_upsert', { entityType: 'contact', id: contact.result.id, fields: { plan: 'Pro' } }, ctx);
    const updated = await robot.tools.execute('crm_get', { entityType: 'contact', id: contact.result.id }, ctx);
    assert.equal(updated.result.plan, 'Pro');

    const lead = await robot.tools.execute('lead_score', { budget: 9, urgency: 9, companySize: 8, authority: 9, needClarity: 8 }, ctx);
    assert.equal(lead.result.grade, 'A');

    const inv = await robot.tools.execute('invoice_create', { customer: { name: 'Prima d.o.o.' }, items: [{ description: 'Razvoj', qty: 2, unitPrice: 500 }], vatRate: 0.2 }, { ...ctx, approvedTools: new Set(['invoice_create']) });
    assert.equal(inv.result.subtotal, 1000);
    assert.equal(inv.result.vat, 200);
    assert.equal(inv.result.total, 1200);
    assert.match(inv.result.number, /^INV-\d{4}-\d{4}$/);
    assert.match(inv.result.markdown, /UKUPNO: 1200 EUR/);

    const rep = await robot.tools.execute('report_generate', { title: 'Test', sections: [{ heading: 'A', body: 'tekst', table: { columns: ['x', 'y'], rows: [[1, 2]] } }] }, ctx);
    assert.match(rep.result.markdown, /\| x \| y \|/);

    const t = await robot.tools.execute('ticket_create', { subject: 'Ne radi prijava', priority: 'high' }, ctx);
    assert.equal(t.result.status, 'open');
  } finally {
    await cleanup(robot.__dir);
  }
});

test('ugrađeni alati: mejl ide u outbox (bez mreže)', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const res = await robot.tools.execute(
      'email_send',
      { to: 'klijent@example.com', subject: 'Ponuda', body: 'U prilogu je ponuda.' },
      { tenantId: 'nmq', agentId: 'sales', approvedTools: new Set(['email_send']) },
    );
    assert.equal(res.result.status, 'queued');
    const { readJsonl } = await import('../src/core/fsx.js');
    const rows = await readJsonl(`${robot.__dir}/tenants/nmq/outbox/emails.jsonl`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].to, 'klijent@example.com');
  } finally {
    await cleanup(robot.__dir);
  }
});

test('MCP: stdio server se spaja i njegovi alati su dostupni kroz registry', async () => {
  const registry = createToolRegistry({ logger: null });
  const mcp = createMcpManager({ registry, logger: null, root: ROOT });
  const report = await mcp.connectAll([
    { id: 'test-crm', transport: 'stdio', command: process.execPath, args: ['mcp/example-server.mjs'], enabled: true, riskLevel: 'low', tools: { crm_note_add: { riskLevel: 'medium' } } },
  ]);
  try {
    assert.equal(report[0].tools.length, 3);
    assert.ok(registry.names().includes('test-crm.crm_contact_lookup'));

    const lookup = await registry.execute('test-crm.crm_contact_lookup', { query: 'petar' }, { tenantId: 'nmq', agentId: 'sales', policy: { tools: { allow: ['*'] } } });
    assert.match(lookup.result.text, /Petar Petrović/);
    assert.equal(registry.get('test-crm.crm_note_add').riskLevel, 'medium');

    const note = await registry.execute('test-crm.crm_note_add', { contactId: 'c1', note: 'Zvao danas' }, { tenantId: 'nmq', agentId: 'sales', policy: { tools: { allow: ['*'] } } });
    assert.match(note.result.text, /saved/);

    const bad = await registry.execute('test-crm.tickets_search', { query: 'nema-ovoga' }, { tenantId: 'nmq', agentId: 'support', policy: { tools: { allow: ['*'] } } });
    assert.match(bad.result.text, /Nema rezultata/);
  } finally {
    await mcp.closeAll();
  }
});

test('MCP: alat koji vrati isError se ne pretvara u uspjeh', async () => {
  const registry = createToolRegistry({ logger: null });
  const mcp = createMcpManager({ registry, logger: null, root: ROOT });
  await mcp.connectAll([{ id: 'test-crm2', transport: 'stdio', command: process.execPath, args: ['mcp/example-server.mjs'], enabled: true }]);
  try {
    const res = await registry.execute('test-crm2.crm_note_add', { contactId: 'nema', note: 'x' }, { tenantId: 'nmq', agentId: 'sales', policy: { tools: { allow: ['*'] } } });
    assert.equal(res.result.isError, true);
  } finally {
    await mcp.closeAll();
  }
});

test('MCP: mrtav server daje jasnu grešku, ne visi', async () => {
  const registry = createToolRegistry({ logger: null });
  const mcp = createMcpManager({ registry, logger: null, root: ROOT });
  await mcp.connectAll([
    { id: 'mrtav', transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(1)'], enabled: true, timeoutMs: 1500 },
  ]).catch(() => {});
  const tools = registry.names().filter((n) => n.startsWith('mrtav.'));
  assert.equal(tools.length, 0);
  await mcp.closeAll();
});

test('registerBuiltinTools: registruje očekivani broj alata i svaki ima riskLevel', () => {
  const registry = createToolRegistry({ logger: null });
  registerBuiltinTools(registry, { dataDir: '/tmp', memory: { longterm: { search: async () => [] }, vectors: { query: async () => [], ingest: async () => ({ chunks: 0 }) } }, env: {}, logger: null });
  assert.ok(registry.size() >= 18, `očekivano ≥18 alata, dobijeno ${registry.size()}`);
  for (const tool of registry.list()) {
    assert.ok(['low', 'medium', 'high'].includes(tool.riskLevel), `${tool.name} nema ispravan riskLevel`);
    assert.equal(typeof tool.handler, 'function');
    assert.ok(tool.params && tool.params.type === 'object', `${tool.name} nema JSON Schema parametara`);
  }
});
