import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestRobot, cleanup, smartScript } from './helpers.mjs';
import { PATTERNS } from '../src/orchestration/index.js';
import { PolicyError, BudgetExceededError, ApprovalRequiredError } from '../src/core/errors.js';
import { createMockProvider } from '../src/llm/mock.js';

test('postoji 11 ulaza (agent/react + ruter + 8 patterna)', () => {
  assert.deepEqual(PATTERNS, ['agent', 'react', 'router', 'sequential', 'orchestrator-worker', 'fanout', 'handoff', 'magentic', 'reflection', 'debate', 'team']);
});

test('pattern: agent (direktan poziv) + trošak i trace', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'Kratak odgovor agenta.' }) });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'creative', pattern: 'agent', input: 'Napiši naslov za oglas' });
    assert.equal(res.pattern, 'agent');
    assert.equal(res.status, 'ok');
    assert.match(res.output, /Kratak odgovor/);
    assert.ok(res.costUsd > 0, 'trošak mora biti veći od nule');
    assert.ok(res.usage.tokensIn > 0);
    assert.ok(robot.tracer.get(res.runId), 'trace mora postojati');

    const usage = await robot.cost.summary('nmq');
    assert.equal(usage.calls > 0, true);
    assert.ok(usage.byAgent.creative > 0);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('pattern: sequential izvršava korake u redu i završava alatom', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'Sadržaj koraka.' }) });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'ops', pattern: 'sequential', input: 'Novi projekat: uvođenje CRM-a za klijenta Prima' });
    assert.equal(res.pattern, 'sequential');
    assert.equal(res.result.results.length, 3, 'dva agentska koraka + jedan alat');
    assert.equal(res.result.results[2].kind, 'tool');
    assert.equal(res.result.results[2].name, 'report_generate');
    assert.match(res.output, /Plan projekta i onboarding/);
    assert.ok(res.result.results[0].output.includes('Sadržaj koraka'));
  } finally {
    await cleanup(robot.__dir);
  }
});

test('pattern: orchestrator-worker planira, delegira i sintetiše', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'sales', pattern: 'orchestrator-worker', input: 'Pripremi ponudu za Prima d.o.o.' });
    assert.equal(res.pattern, 'orchestrator-worker');
    assert.equal(res.result.plan.subtasks.length, 2);
    assert.equal(res.result.workersOk, 2);
    assert.match(res.output, /FINALNO/);
    assert.ok(res.result.workers.every((w) => w.ok));
  } finally {
    await cleanup(robot.__dir);
  }
});

test('pattern: fanout radi paralelno i spaja rezultate', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'legal', pattern: 'fanout', input: 'Pregledaj ugovor o održavanju' });
    assert.equal(res.pattern, 'fanout');
    assert.equal(res.result.workers.length, 3);
    assert.deepEqual(
      res.result.workers.map((w) => w.agent).sort(),
      ['finance', 'legal', 'ops'],
    );
    assert.match(res.output, /SINTEZA/);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('pattern: fanout trpi pad jednog workera', async () => {
  const robot = await buildTestRobot({
    script: ({ messages }) => {
      const sys = String(messages[0]?.content ?? '');
      if (sys.includes('analitičar')) return { text: 'SINTEZA sa preostalima.' };
      if (sys.includes('finansijski')) throw Object.assign(new Error('model nedostupan'), { retryable: false });
      return { text: 'ok' };
    },
  });
  try {
    const res = await robot.orchestrator.run({
      tenantId: 'nmq',
      pattern: 'fanout',
      agentId: 'legal',
      input: 'analiza',
      options: { patternConfig: { workers: [{ agent: 'legal' }, { agent: 'finance' }], merge: 'concat' } },
    });
    assert.equal(res.result.workers.length, 2);
    assert.equal(res.result.workers.filter((w) => w.ok).length, 1);
    assert.equal(res.result.failed.length, 1);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('pattern: handoff predaje kontrolu i bilježi lanac', async () => {
  const robot = await buildTestRobot({ script: smartScript({ handoffTo: 'finance' }) });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'support', pattern: 'handoff', input: 'Tražim povraćaj novca za prošli mjesec' });
    assert.equal(res.pattern, 'handoff');
    assert.equal(res.result.handoffChain.length, 1);
    assert.equal(res.result.handoffChain[0].to, 'finance');
    assert.deepEqual(res.result.visited, ['support', 'finance']);
    assert.equal(res.result.resolvedBy, 'finance');
  } finally {
    await cleanup(robot.__dir);
  }
});

test('pattern: handoff sprječava ping-pong petlju', async () => {
  const script = () => ({
    toolCalls: [{ name: 'handoff', arguments: { toAgent: 'support', reason: 'nazad', summary: '' } }],
  });
  const robot = await buildTestRobot({ script });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'support', pattern: 'handoff', input: 'x' });
    assert.ok(res.result.handoffChain.length <= 1, 'ne smije se vraćati na istog agenta');
    assert.ok(['handoff_loop', 'max_handoffs', 'ok'].includes(res.result.status ?? 'ok'));
  } finally {
    await cleanup(robot.__dir);
  }
});

test('pattern: magentic radi iteracije i refleksiju', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'dev', pattern: 'magentic', input: 'Zašto pada deploy?' });
    assert.equal(res.pattern, 'magentic');
    assert.ok(res.result.iterations.length >= 1);
    assert.ok(typeof res.result.finalReview.score === 'number');
    assert.ok(res.output.length > 0);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('pattern: router bira agenta bez LLM-a i koristi njegov default pattern', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', pattern: 'router', input: 'Ne radi mi prijava na nalog, ne mogu da se ulogujem' });
    assert.equal(res.routing.agentId, 'support');
    assert.equal(res.routing.method, 'heuristic');
    assert.equal(res.pattern, 'handoff');
    assert.equal(res.agentId, 'support');
  } finally {
    await cleanup(robot.__dir);
  }
});

test('orchestracija: tenant isolation preko allowedAgents', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    await assert.rejects(
      () => robot.orchestrator.run({ tenantId: 'demo-shop', agentId: 'finance', input: 'napravi fakturu' }),
      (err) => err instanceof PolicyError || err.code === 'POLICY_DENIED',
    );
    const ok = await robot.orchestrator.run({ tenantId: 'demo-shop', agentId: 'support', pattern: 'agent', input: 'pitanje' });
    assert.equal(ok.status, 'ok');
    await assert.rejects(() => robot.orchestrator.run({ tenantId: 'nepostoji', input: 'x' }), (err) => err.code === 'NOT_FOUND');
  } finally {
    await cleanup(robot.__dir);
  }
});

test('orchestracija: budžet prekida run i vraća BUDGET_EXCEEDED', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'x'.repeat(200) }) });
  try {
    await assert.rejects(
      () => robot.orchestrator.run({ tenantId: 'nmq', agentId: 'creative', pattern: 'agent', input: 'generiši mnogo teksta', options: { maxStepUsd: 0, maxRunUsd: 0.0000001 } }),
      (err) => err instanceof BudgetExceededError || err.code === 'BUDGET_EXCEEDED',
    );
  } finally {
    await cleanup(robot.__dir);
  }
});

test('orchestracija: high rizik daje status awaiting_approval i ne izvršava akciju', async () => {
  const robot = await buildTestRobot({
    script: ({ messages }) => {
      if (messages.some((m) => m.role === 'tool')) return { text: 'Mejl je poslat.' };
      return { toolCalls: [{ name: 'email_send', arguments: { to: 'k@example.com', subject: 'Ponuda', body: 'Tekst ponude' } }] };
    },
  });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'sales', pattern: 'agent', input: 'Pošalji ponudu klijentu' });
    assert.equal(res.status, 'awaiting_approval');
    assert.equal(res.approvals.length, 1);
    assert.equal(res.approvals[0].tool, 'email_send');

    const { readJsonl } = await import('../src/core/fsx.js');
    const outbox = await readJsonl(`${robot.__dir}/tenants/nmq/outbox/emails.jsonl`);
    assert.equal(outbox.length, 0, 'mejl se NE smije poslati bez odobrenja');

    // nakon odobrenja akcija prolazi
    const approved = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'sales', pattern: 'agent', input: 'Pošalji ponudu klijentu', approvedTools: ['email_send'] });
    assert.equal(approved.status, 'ok');
    const after = await readJsonl(`${robot.__dir}/tenants/nmq/outbox/emails.jsonl`);
    assert.equal(after.length, 1);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('orchestracija: agent koji poziva zabranjen alat dobija odbijanje, a ne pad', async () => {
  const robot = await buildTestRobot({
    script: ({ messages }) => {
      if (messages.some((m) => m.role === 'tool')) return { text: 'Alat je odbijen, evo alternative.' };
      return { toolCalls: [{ name: 'invoice_create', arguments: { customer: { name: 'X' }, items: [{ description: 'a', qty: 1, unitPrice: 1 }] } }] };
    },
  });
  try {
    // demo-shop: finance agent nije dozvoljen, ali support smije raditi; invoice_create je zabranjen za demo-shop
    const res = await robot.orchestrator.run({ tenantId: 'demo-shop', agentId: 'support', pattern: 'agent', input: 'Napravi fakturu' });
    const toolStep = res.result.results[0].steps.find((s) => s.type === 'tool');
    assert.equal(toolStep.ok, false);
    assert.equal(toolStep.code, 'POLICY_DENIED');
    assert.equal(res.status, 'ok', 'run se nastavlja sa objašnjenjem');
  } finally {
    await cleanup(robot.__dir);
  }
});

test('orchestracija: sesija se nastavlja između runova', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'Nastavljam razgovor.' }) });
  try {
    const llm = robot.llm.providers[0];
    await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'support', pattern: 'agent', input: 'Zovem se Petar', sessionId: 'ses-1' });
    const before = llm.calls.length;
    await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'support', pattern: 'agent', input: 'Kako se zovem?', sessionId: 'ses-1' });
    const secondCall = llm.calls[before];
    const contents = secondCall.messages.map((m) => m.content).join(' ');
    assert.match(contents, /Zovem se Petar/, 'prethodna poruka mora biti u kontekstu');
  } finally {
    await cleanup(robot.__dir);
  }
});
