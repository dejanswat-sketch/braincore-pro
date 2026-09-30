import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, assertAllowed, redactPii, resolvePolicy, DECISIONS } from '../src/core/policy.js';
import { createBudget } from '../src/core/budget.js';
import { createToolRegistry } from '../src/tools/registry.js';
import { PolicyError, ApprovalRequiredError, BudgetExceededError } from '../src/core/errors.js';
import { createMockProvider } from '../src/llm/mock.js';
import { buildTestRobot, cleanup } from './helpers.mjs';

const policies = {
  defaults: {
    tools: { allow: ['*'], deny: ['shell_exec'], requireApproval: ['email_send'], conditions: { payment: { maxAmountUsd: 1000 } } },
    risk: { low: 'allow', medium: 'allow', high: 'require_approval' },
  },
  tenants: {
    strict: {
      tools: { allow: ['calculator', 'current_time'], requireApproval: [] },
      agents: { support: { deny: ['current_time'] } },
    },
  },
};

test('politika: deny pobjeđuje allow', () => {
  const verdict = evaluate(policies.defaults, { tool: 'shell_exec', agentId: 'dev', riskLevel: 'high' });
  assert.equal(verdict.decision, DECISIONS.DENY);
  assert.match(verdict.reason, /globalno zabranjen/);
});

test('politika: tenant može samo da pooštri (allow lista)', () => {
  const policy = resolvePolicy(policies, 'strict', { agentId: 'support' });
  assert.equal(evaluate(policy, { tool: 'calculator', agentId: 'support', riskLevel: 'low' }).decision, DECISIONS.ALLOW);
  assert.equal(evaluate(policy, { tool: 'http_fetch', agentId: 'support', riskLevel: 'medium' }).decision, DECISIONS.DENY);
});

test('politika: zabrana po agentu nadjačava globalni allow', () => {
  const policy = resolvePolicy(policies, 'strict', { agentId: 'support' });
  const v = evaluate(policy, { tool: 'current_time', agentId: 'support', riskLevel: 'low' });
  assert.equal(v.decision, DECISIONS.DENY);
  assert.match(v.rule, /agents\.support\.deny/);
});

test('politika: high rizik traži odobrenje, uslov po iznosu takođe', () => {
  assert.equal(evaluate(policies.defaults, { tool: 'email_send', riskLevel: 'high' }).decision, DECISIONS.APPROVAL);
  assert.equal(evaluate(policies.defaults, { tool: 'payment', riskLevel: 'low', args: { amountUsd: 5000 } }).decision, DECISIONS.APPROVAL);
  assert.equal(evaluate(policies.defaults, { tool: 'payment', riskLevel: 'low', args: { amountUsd: 50 } }).decision, DECISIONS.ALLOW);
});

test('politika: assertAllowed baca odgovarajuću grešku', () => {
  assert.throws(() => assertAllowed(policies.defaults, { tool: 'shell_exec' }), PolicyError);
  assert.throws(() => assertAllowed(policies.defaults, { tool: 'email_send', riskLevel: 'high' }), ApprovalRequiredError);
});

test('PII redakcija: mejl, kartica, IBAN, JMBG', () => {
  const text = 'Kontakt: petar@example.com, kartica 4111 1111 1111 1111, IBAN RS35123456789012345678, JMBG 0101990710025';
  const out = redactPii(text);
  assert.ok(!out.includes('petar@example.com'));
  assert.ok(!out.includes('4111 1111 1111 1111'));
  assert.match(out, /EMAIL_REDACTED/);
  assert.match(out, /IBAN_REDACTED/);
});

test('budžet: prekid nakon maxSteps i nakon potrošnje', () => {
  const b = createBudget({ maxSteps: 2, runUsd: 0.1, monthlyUsd: 1 });
  b.addStep();
  b.addStep();
  assert.throws(() => b.assertCanContinue(), BudgetExceededError);

  const b2 = createBudget({ maxSteps: 10, runUsd: 0.05, monthlyUsd: 1 });
  b2.spend({ usd: 0.04 });
  assert.throws(() => b2.assertCanContinue({ estimatedUsd: 0.02 }), BudgetExceededError);

  const b3 = createBudget({ maxSteps: 10, runUsd: 1, monthlyUsd: 0.5, spentThisMonthUsd: 0.49 });
  assert.throws(() => b3.assertCanContinue({ estimatedUsd: 0.05 }), BudgetExceededError);
});

test('registry: politika se provjerava prije izvršenja alata', async () => {
  const executed = [];
  const registry = createToolRegistry({ policyResolver: () => policies.defaults, logger: null });
  registry.register({ name: 'echo', riskLevel: 'low', handler: async (args) => (executed.push(args), { ok: true }) });
  registry.register({ name: 'email_send', riskLevel: 'high', handler: async () => ({ sent: true }) });

  const ok = await registry.execute('echo', { a: 1 }, { tenantId: 'nmq', agentId: 'support' });
  assert.equal(ok.result.ok, true);

  await assert.rejects(() => registry.execute('email_send', {}, { tenantId: 'nmq', agentId: 'support' }), ApprovalRequiredError);
  assert.equal(executed.length, 1, 'zabranjen alat se ne smije izvršiti');

  const approved = await registry.execute('email_send', {}, { tenantId: 'nmq', agentId: 'support', approvedTools: new Set(['email_send']) });
  assert.equal(approved.result.sent, true);
});

test('registry: specsFor filtrira alate koje agent ne smije', () => {
  const registry = createToolRegistry({ policyResolver: () => policies.defaults });
  registry.register({ name: 'calculator', riskLevel: 'low', handler: async () => ({}) });
  registry.register({ name: 'shell_exec', riskLevel: 'high', handler: async () => ({}) });
  const names = registry.specsFor({ policy: policies.defaults, agentId: 'dev' }).map((t) => t.name);
  assert.ok(names.includes('calculator'));
  assert.ok(!names.includes('shell_exec'));
});

test('audit: svaki poziv alata ostavlja zapis (uključujući odbijanje)', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const audit = [];
    robot.audit.append = async (entry) => (audit.push(entry), entry);
    await assert.rejects(() => robot.tools.execute('invoice_create', { customer: { name: 'X' }, items: [] }, { tenantId: 'nmq', agentId: 'sales' }));
    // invoice_create je high rizik → traži odobrenje, zapis mora postojati
    assert.equal(audit.length >= 1, true);
    assert.ok(['require_approval', 'deny'].includes(audit[0].decision));
  } finally {
    await cleanup(robot.__dir);
  }
});

test('llm: mock provider bilježi pozive i vraća skriptovane odgovore', async () => {
  const llm = createMockProvider({ script: [{ text: 'prvi' }, { toolCalls: [{ name: 'x', arguments: { y: 1 } }] }] });
  const r1 = await llm.chat({ messages: [{ role: 'user', content: 'a' }] });
  const r2 = await llm.chat({ messages: [{ role: 'user', content: 'b' }] });
  assert.equal(r1.text, 'prvi');
  assert.equal(r2.toolCalls[0].name, 'x');
  assert.equal(llm.callCount, 2);
});
