/**
 * v0.3 „autonomni nivo": ciljevi, proaktivnost, self-improvement, self-play, RSI,
 * AI organizacija i A2A (pregovaranje + poravnanje).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildTestRobot, cleanup, smartScript, tempDataDir } from './helpers.mjs';
import { createAutonomy, AUTONOMY_LEVELS, HUMAN_ONLY } from '../src/core/autonomy.js';
import { createRewardModel } from '../src/learning/rewards.js';
import { ValidationError, PolicyError, NotFoundError } from '../src/core/errors.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── autonomija ───────────────────────────

test('autonomija: nivoi i odluke (propose/plan/act) po riziku', () => {
  const autonomy = createAutonomy({ config: { default: 'L1' }, logger: null });
  assert.deepEqual(Object.keys(AUTONOMY_LEVELS), ['L0', 'L1', 'L2', 'L3', 'L4']);
  assert.ok(HUMAN_ONLY.includes('financial'));

  autonomy.setLevel('t1', null, 'L1');
  assert.equal(autonomy.evaluate({ tenantId: 't1', kind: 'propose' }).action, 'allow');
  assert.equal(autonomy.evaluate({ tenantId: 't1', kind: 'plan' }).action, 'deny');
  assert.equal(autonomy.evaluate({ tenantId: 't1', riskLevel: 'low', kind: 'act' }).action, 'require_approval');
  assert.equal(autonomy.evaluate({ tenantId: 't1', riskLevel: 'high', kind: 'act' }).action, 'require_approval');

  autonomy.setLevel('t1', 'sales', 'L3');
  assert.equal(autonomy.evaluate({ tenantId: 't1', agentId: 'sales', kind: 'plan' }).action, 'allow');
  assert.equal(autonomy.evaluate({ tenantId: 't1', agentId: 'sales', riskLevel: 'low', kind: 'act' }).action, 'allow');
  assert.equal(autonomy.evaluate({ tenantId: 't1', agentId: 'sales', riskLevel: 'medium', kind: 'act' }).action, 'require_approval');

  autonomy.setLevel('t1', 'sales', 'L4');
  assert.equal(autonomy.evaluate({ tenantId: 't1', agentId: 'sales', riskLevel: 'medium', kind: 'act' }).action, 'allow');
  // visok rizik i „ljudske" kategorije traže čovjeka i na L4
  assert.equal(autonomy.evaluate({ tenantId: 't1', agentId: 'sales', riskLevel: 'high', kind: 'act' }).action, 'require_approval');
  assert.equal(autonomy.evaluate({ tenantId: 't1', agentId: 'sales', riskLevel: 'low', kind: 'act', detail: { tags: ['legal'] } }).action, 'require_approval');

  assert.throws(() => autonomy.setLevel('t1', null, 'L9'), ValidationError);
});

test('autonomija: assert baca PolicyError i upisuje audit', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const level = robot.autonomy.levelOf('demo-shop', 'creative');
    assert.equal(level, 'L1');
    await assert.rejects(
      () => robot.autonomy.assert({ tenantId: 'demo-shop', agentId: 'creative', kind: 'plan' }),
      PolicyError,
    );
    const audit = await robot.audit.read('demo-shop');
    assert.ok(audit.some((e) => e.action === 'autonomy_denied'));
    assert.match((await import('../src/index.js')).AUTONOMY_LEVELS.L2.name, /supervised/);
  } finally {
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── ciljevi ───────────────────────────

test('ciljevi: kreiranje, dekompozicija, napredak i zdravlje', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    const goal = await robot.goals.create('nmq', {
      title: 'Povećaj mjesečni prihod 15%',
      metric: 'monthly_revenue_eur',
      baseline: 10000,
      target: 11500,
      unit: 'EUR',
      deadline: new Date(Date.now() + 45 * 86_400_000).toISOString(),
      startAt: new Date(Date.now() - 45 * 86_400_000).toISOString(),
      owner: 'cro',
    });
    assert.ok(['draft', 'active', 'on_track', 'at_risk', 'off_track', 'achieved', 'missed'].includes(goal.status), 'status je ' + goal.status);

    const dec = await robot.goals.decompose('nmq', goal.id);
    assert.equal(dec.goal.subgoals.length, 2);
    assert.equal(dec.goal.plan.length, 3);
    assert.ok(dec.costUsd > 0);

    // napredak: 50% puta → on_track
    let updated = await robot.goals.recordProgress('nmq', goal.id, { value: 10750, source: 'test' });
    assert.equal(updated.progressPct, 50);

    // skok na 1% → off_track (jer je vrijeme odmaklo: očekivano ~50%)
    updated = await robot.goals.recordProgress('nmq', goal.id, { value: 10100, source: 'test' });
    assert.ok(['at_risk', 'off_track'].includes(updated.status), 'status je ' + updated.status);

    const replan = await robot.goals.replan('nmq', goal.id);
    assert.ok(replan.proposal.actions.length >= 1);
    assert.equal(replan.goal.replans.length, 1);

    const portfolio = await robot.goals.portfolio('nmq');
    assert.equal(portfolio.total, 1);
    assert.equal(portfolio.atRisk.length, 1);

    const history = await robot.goals.history('nmq');
    assert.equal(history.length, 2);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('ciljevi: postignut cilj i validacije', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    await assert.rejects(() => robot.goals.create('nmq', { title: 'bez metrike' }), ValidationError);
    const g = await robot.goals.create('nmq', { title: 'Test', metric: 'm', baseline: 0, target: 100, deadline: new Date(Date.now() + 86_400_000).toISOString() });
    const done = await robot.goals.recordProgress('nmq', g.id, { value: 120 });
    assert.equal(done.status, 'achieved');
    assert.equal(done.progressPct, 120);
    await assert.rejects(() => robot.goals.get('nmq', 'nema'), NotFoundError);
    await assert.rejects(() => robot.goals.setStatus('nmq', g.id, 'nepoznato'), ValidationError);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('ciljevi: zakazivanje poslova iz plana (persistentni agenti jure cilj)', async () => {
  const robot = await buildTestRobot({ script: smartScript(), scheduler: true });
  try {
    const g = await robot.goals.create('nmq', { title: 'Rast', metric: 'rev', baseline: 0, target: 100, deadline: new Date(Date.now() + 30 * 86_400_000).toISOString(), owner: 'cro' });
    await robot.goals.decompose('nmq', g.id);
    const scheduled = await robot.goals.schedule('nmq', g.id, { startInMs: 1000, stepDelayMs: 1000 });
    assert.equal(scheduled.jobs.length, 3);
    const jobs = await robot.scheduler.list('nmq');
    assert.equal(jobs.length, 3);
    assert.ok(jobs.every((j) => j.goalId === g.id));
    assert.ok(jobs.every((j) => j.nextRunAt > Date.now()));
  } finally {
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── proaktivni watcheri ───────────────────────────

test('watcheri: metrika preko praga → prijedlog; L3 agent niskog rizika → izvršava sam', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    // demo-shop je L1/L2 → predlaže (ide u inbox)
    robot.watchers.recordMetric('demo-shop', 'support_tickets_open', 55);
    const fired = (await robot.watchers.tick(['demo-shop'])).filter((f) => f.ruleId === 'tickets_rastu');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].action, 'propose');
    assert.ok(fired[0].proposalId);
    const proposals = await robot.improvements.list('demo-shop', { status: 'proposed' });
    assert.ok(proposals.length >= 1);
    assert.equal(proposals[0].kind, 'action');
    assert.ok(proposals.some((p) => p.source === 'watcher'));

    // cooldown: odmah drugi tick ne okida
    const again = await robot.watchers.tick(['demo-shop']);
    assert.equal(again.length, 0);

    // nmq: nizak rizik + L2/L3 → agent smije sam izvršiti (event rule "shopify_narudzbina")
    const firedNmq = await robot.watchers.onEvent('hook.shopify', { tenantId: 'nmq', orderId: '1042' });
    assert.ok(firedNmq.length >= 1);
    const run = firedNmq.find((f) => f.action === 'run');
    assert.ok(run, 'na L2+ nizak rizik se izvršava bez čovjeka');
    assert.ok(run.runId);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('watcheri: događaj sa bus-a i cilj koji skreće', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    // event rule: hook.shopify
    const fired = await robot.watchers.onEvent('hook.shopify', { tenantId: 'nmq', orderId: '1042' });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].ruleId, 'shopify_narudzbina');

    // goal_status rule
    const g = await robot.goals.create('nmq', { title: 'Kasni cilj', metric: 'm', baseline: 0, target: 1000, startAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), deadline: new Date(Date.now() + 5 * 86_400_000).toISOString(), owner: 'cro' });
    await robot.goals.recordProgress('nmq', g.id, { value: 10 });
    const ticked = await robot.watchers.tick(['nmq']);
    const goalRule = ticked.find((f) => f.ruleId === 'cilj_skrenuo');
    assert.ok(goalRule, 'watcher mora reagovati na cilj koji skreće');
    assert.match(goalRule.condition.reason, /ciljeva/);
  } finally {
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── reward model ───────────────────────────

test('reward: formula, agregacija i rangiranje', async () => {
  const dir = await tempDataDir('reward');
  const model = createRewardModel({ dataDir: dir });
  const good = model.score({ feedback: 'up', approval: 'approved', outcome: 'ok', costUsd: 0.01 });
  const bad = model.score({ feedback: 'down', outcome: 'error', toolErrors: 2, costUsd: 0.05 });
  assert.ok(good.reward > 0.8, `dobra nagrada je ${good.reward}`);
  assert.ok(bad.reward < 0.2, `loša nagrada je ${bad.reward}`);
  const rating = model.score({ feedback: 5, outcome: 'ok' });
  assert.ok(rating.reward > model.score({ feedback: 2, outcome: 'ok' }).reward);
  assert.ok(Array.isArray(good.reasons));

  await model.record('nmq', { runId: 'r1', agentId: 'support', pattern: 'agent', variant: 'A', signals: { feedback: 'up', outcome: 'ok' } });
  await model.record('nmq', { runId: 'r2', agentId: 'support', pattern: 'agent', variant: 'B', signals: { feedback: 'down', outcome: 'error' } });
  await model.record('nmq', { runId: 'r3', agentId: 'sales', pattern: 'team', variant: 'A', signals: { outcome: 'ok' } });

  const byAgent = await model.aggregate('nmq', { groupBy: 'agent' });
  assert.equal(byAgent.support.n, 2);
  assert.equal(byAgent.sales.n, 1);
  assert.ok(byAgent.support.avgReward < byAgent.sales.avgReward);

  const ranking = await model.ranking('nmq', { groupBy: 'agent' });
  assert.equal(ranking.top[0].key, 'sales');

  const variants = await model.variantComparison('nmq');
  assert.equal(variants[0].variant, 'A', 'varijanta A mora biti bolja');
  await cleanup(dir);
});

test('reward: run kroz HTTP upisuje nagradu (recordRunOutcome)', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'odgovor agenta' }) });
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const run = await (await fetch(`${base}/v1/agents/creative/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'napiši oglas', tenantId: 'nmq' }) })).json();
    const rewards = await robot.rewards.recent('nmq');
    assert.ok(rewards.some((r) => r.runId === run.runId), 'nagrada mora biti zapisana za run');

    await fetch(`${base}/v1/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating: 'down', runId: run.runId, comment: 'nije dobro', tenantId: 'nmq' }) });
    const after = await robot.rewards.recent('nmq');
    const fb = after.find((r) => r.signals?.feedback === 'down');
    assert.ok(fb, 'feedback mora ući u reward model');
    assert.ok(fb.signals.feedback === 'down');
  } finally {
    await robot.close();
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── self-improvement ───────────────────────────

test('self-improvement: prijedlog → odobrenje → primjena prompta → rollback', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const proposal = await robot.improvements.createProposal('nmq', {
      kind: 'prompt',
      target: 'support',
      current: robot.catalog.get('support', 'nmq').systemPrompt.slice(0, 100),
      proposed: 'Ti si support agent. Uvijek prvo provjeri politiku i navedi rok.',
      rationale: 'Agent ne navodi rok u odgovorima',
      evidence: [{ runId: 'r1', issue: 'bez roka' }],
      riskLevel: 'medium',
      source: 'test',
    });
    assert.equal(proposal.status, 'proposed');

    // ne može se primijeniti bez odobrenja
    await assert.rejects(() => robot.improvements.apply('nmq', proposal.id), ValidationError);

    await robot.improvements.decide('nmq', proposal.id, { approve: true, by: 'dejan' });
    const applied = await robot.improvements.apply('nmq', proposal.id, { by: 'dejan' });
    assert.equal(applied.proposal.status, 'applied');
    assert.match(robot.catalog.get('support', 'nmq').systemPrompt, /navedi rok/);

    const rolled = await robot.improvements.rollback('nmq', proposal.id);
    assert.equal(rolled.status, 'rolled_back');
    assert.ok(!/navedi rok/.test(robot.catalog.get('support', 'nmq').systemPrompt));

    const audit = await robot.audit.read('nmq');
    assert.ok(audit.some((e) => e.action === 'improvement_proposed'));
    assert.ok(audit.some((e) => e.action === 'improvement_applied'));
    assert.ok(audit.some((e) => e.action === 'improvement_rollback'));
  } finally {
    await cleanup(robot.__dir);
  }
});

test('self-improvement: izmjena politike kroz runtime override (i povrat)', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const before = robot.policyResolver('nmq', { agentId: 'support' }).tools?.requireApproval ?? [];
    const proposal = await robot.improvements.createProposal('nmq', {
      kind: 'policy',
      target: null,
      proposed: { tools: { requireApproval: [...before, 'notify'] } },
      rationale: 'Notify je postao rizičan za ovog klijenta',
      riskLevel: 'medium',
      source: 'test',
    });
    await robot.improvements.decide('nmq', proposal.id, { approve: true });
    await robot.improvements.apply('nmq', proposal.id);
    const after = robot.policyResolver('nmq', { agentId: 'support' }).tools.requireApproval;
    assert.ok(after.includes('notify'), 'runtime politika mora važiti odmah');

    await robot.improvements.rollback('nmq', proposal.id);
    const reverted = robot.policyResolver('nmq', { agentId: 'support' }).tools.requireApproval;
    assert.ok(!reverted.includes('notify'), 'rollback vraća politiku');
  } finally {
    await cleanup(robot.__dir);
  }
});

test('self-improvement: KB prijedlog i akcijski prijedlog (uz autonomiju)', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'izvršeno iz prijedloga' }) });
  try {
    const kb = await robot.improvements.createProposal('nmq', { kind: 'kb', proposed: { text: 'Politika povraćaja: 14 dana od dostave.', source: 'self-improvement' }, rationale: 'Česta pitanja bez odgovora' });
    await robot.improvements.decide('nmq', kb.id, { approve: true });
    const applied = await robot.improvements.apply('nmq', kb.id);
    assert.ok(applied.result.chunks >= 1);
    const hits = await robot.memory.vectors.query('nmq', { text: 'koliko dana za povraćaj', k: 3 });
    assert.ok(hits.length >= 1);

    const action = await robot.improvements.createProposal('nmq', { kind: 'action', target: 'sales', proposed: { input: 'Pošalji podsjetnik klijentima' }, rationale: 'Pipeline stagnira', riskLevel: 'low' });
    await robot.improvements.decide('nmq', action.id, { approve: true });
    const ran = await robot.improvements.apply('nmq', action.id);
    assert.equal(ran.proposal.status, 'applied');
    assert.ok(ran.result.runId);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('A/B: varijante se dijele deterministički, mjere i pobjednik se promoviše', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const exp = await robot.improvements.createExperiment('nmq', {
      agentId: 'creative',
      variants: [
        { name: 'kratko', specPatch: { temperature: 0.1, maxTokens: 300 } },
        { name: 'kreativno', specPatch: { temperature: 0.9, maxTokens: 900 } },
      ],
      splitPct: 100,
      minSamples: 2,
    });
    assert.equal(exp.status, 'running');

    const a1 = await robot.improvements.assignVariant('nmq', { agentId: 'creative', sessionId: 'ses-1' });
    const a2 = await robot.improvements.assignVariant('nmq', { agentId: 'creative', sessionId: 'ses-1' });
    assert.equal(a1.variant, a2.variant, 'ista sesija ostaje u istoj varijanti');
    assert.ok(['kratko', 'kreativno'].includes(a1.variant));

    // simuliraj mjerenja: "kreativno" je bolja
    for (let i = 0; i < 4; i += 1) {
      await robot.improvements.recordExperimentResult('nmq', { experimentId: exp.id, variant: 'kratko', reward: 0.4 });
      await robot.improvements.recordExperimentResult('nmq', { experimentId: exp.id, variant: 'kreativno', reward: 0.85 });
    }
    const concluded = await robot.improvements.concludeExperiment('nmq', exp.id, { promote: true });
    assert.equal(concluded.winner, 'kreativno');
    assert.equal(concluded.decision, 'promoted');
    assert.equal(concluded.deployed, true);
    assert.equal(robot.catalog.get('creative', 'nmq').temperature, 0.9, 'pobjednikova zakrpa ide u control plane');

    // varijanta iz zakrpe se primjenjuje po run-u (specPatch)
    const variant = await robot.improvements.assignVariant('nmq', { agentId: 'support', sessionId: 'x' });
    assert.equal(variant, null, 'nema eksperimenta za support');
  } finally {
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── self-play ───────────────────────────

test('self-play: scenariji, dataset i kurikulum', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    const cycle = await robot.selfplay.run('nmq', { rounds: 2, solverAgent: 'support', domain: 'support', difficulty: 2 });
    assert.equal(cycle.rounds, 2);
    assert.ok(cycle.passRate >= 0);
    assert.ok(cycle.costUsd > 0);

    const ds = await robot.selfplay.dataset('nmq');
    assert.equal(ds.total, 2);
    assert.ok(ds.examples.length >= 1);
    assert.match(ds.note, /fine-tune/);

    const cur = await robot.selfplay.curriculum('nmq');
    assert.equal(cur.samples, 2);
    assert.ok(cur.byDifficulty);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('self-play: slaba prolaznost stvara prijedlog sa predloženim promptom', async () => {
  const robot = await buildTestRobot({
    script: ({ messages }) => {
      const system = String(messages[0]?.content ?? '');
      if (system.includes('proposer u self-play')) return { text: JSON.stringify({ task: 'Težak zadatak', context: '', expected: '', difficulty: 4, checks: ['mora imati brojke'] }) };
      if (system.includes('poboljšavaš system prompt')) return { text: 'NOVI PROMPT: uvijek navedi brojke i rok.' };
      return { text: 'Ne znam.' }; // solver pada → slab rezultat
    },
  });
  try {
    const cycle = await robot.selfplay.run('nmq', { rounds: 3, solverAgent: 'support', threshold: 0.95, proposeBelow: 0.8 });
    assert.ok(cycle.passRate < 0.8);
    assert.ok(cycle.proposalId, 'slab rezultat mora dati prijedlog');
    const proposal = await robot.improvements.get('nmq', cycle.proposalId);
    assert.equal(proposal.kind, 'prompt');
    assert.equal(proposal.source, 'self-play');
    assert.match(String(proposal.proposed), /NOVI PROMPT/);
  } finally {
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── RSI ───────────────────────────

test('RSI: analiza nalaza i ciklus prijedloga, pa mjerenje efekta', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    // napravi loše runove za jedan agent
    for (let i = 0; i < 4; i += 1) {
      await robot.rewards.record('nmq', { runId: `r${i}`, agentId: 'creative', pattern: 'agent', signals: { feedback: 'down', outcome: 'error', toolErrors: 3 } });
    }
    await robot.rewards.record('nmq', { runId: 'g1', agentId: 'sales', pattern: 'team', signals: { feedback: 'up', outcome: 'ok' } });

    const analysis = await robot.rsi.analyze('nmq', { sinceDays: 1 });
    assert.ok(analysis.findings.length >= 1);
    assert.ok(analysis.findings.some((f) => f.subject === 'creative'));

    const cycle = await robot.rsi.cycle('nmq', { sinceDays: 1 });
    assert.ok(cycle.proposals.length >= 1);
    const proposalId = cycle.proposals[0].proposalId;
    const p = await robot.improvements.get('nmq', proposalId);
    assert.equal(p.source, 'rsi');

    // efekat prije primjene
    const impactBefore = await robot.rsi.impact('nmq', proposalId);
    assert.equal(impactBefore.status, 'nije primijenjen');

    // odobri i primijeni (akcija ili prompt)
    await robot.improvements.decide('nmq', proposalId, { approve: true });
    await robot.improvements.apply('nmq', proposalId);
    const impact = await robot.rsi.impact('nmq', proposalId);
    assert.ok(impact.verdict);
    assert.ok(['poboljšanje', 'pogoršanje (razmisli o rollback-u)', 'bez promjene', 'nedovoljno podataka'].includes(impact.verdict));
  } finally {
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── organizacija ───────────────────────────

test('organizacija: org chart sa KPI-jevima i budžetima', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    const chart = await robot.company.chart('nmq');
    assert.equal(chart.roles.length, 7);
    const ceo = chart.roles.find((r) => r.id === 'ceo');
    assert.equal(ceo.reportsTo, null);
    const cro = chart.roles.find((r) => r.id === 'cro');
    assert.equal(cro.reportsTo, 'ceo');
    assert.ok(cro.kpis.includes('konverzija ponuda > 20%'));
    assert.ok(typeof cro.budgetUsedPct === 'number' || cro.budgetUsedPct === null);
    assert.ok(cro.autonomy);

    const kpis = await robot.company.kpis('nmq');
    assert.equal(kpis.roles.length, 7);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('organizacija: pregovor o budžetu (dogovor) i ciklus planiranja', async () => {
  const robot = await buildTestRobot({ script: smartScript({ negotiation: 'agree' }) });
  try {
    const neg = await robot.company.negotiate('nmq', { topic: 'budžet za Q1', between: ['cfo', 'cro'], maxRounds: 3, context: { margin: 0.7 } });
    assert.ok(['agreed', 'escalated'].includes(neg.status));
    assert.ok(neg.transcript.length >= 1);
    assert.ok(neg.transcript[0].offer);

    const history = await robot.company.history('nmq');
    assert.ok(history.some((h) => h.type === 'negotiation'));

    const cycle = await robot.company.cycle('nmq', { period: 'month' });
    assert.ok(cycle.plan.priorities.length >= 1);
    assert.ok(cycle.plan.allocation.length >= 1);
    assert.ok(cycle.id);
    assert.ok(cycle.costUsd >= 0);

    const audit = await robot.audit.read('nmq');
    assert.ok(audit.some((e) => e.action === 'org_cycle'));
  } finally {
    await cleanup(robot.__dir);
  }
});

test('organizacija: neuspješan pregovor eskalira kroz inbox', async () => {
  const robot = await buildTestRobot({ script: smartScript({ negotiation: 'never' }) });
  try {
    const neg = await robot.company.negotiate('nmq', { topic: 'budžet', between: ['cfo', 'cro'], maxRounds: 2 });
    assert.equal(neg.status, 'escalated');
    assert.ok(neg.proposalId, 'eskalacija mora otvoriti prijedlog za čovjeka');
    const p = await robot.improvements.get('nmq', neg.proposalId);
    assert.equal(p.source, 'org-negotiation');
  } finally {
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── A2A ───────────────────────────

test('A2A: agent card opisuje skillove, limite i autentikaciju', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const card = (await import('../src/a2a/card.js')).buildAgentCard({ robot, tenantId: 'nmq', baseUrl: 'https://robot.test' });
    assert.equal(card.protocolVersion, '1.0');
    assert.equal(card.tenantId, 'nmq');
    assert.equal(card.capabilities.streaming, true);
    assert.equal(card.capabilities.negotiation, true);
    assert.equal(card.authentication.schemes[0], 'bearer');
    assert.ok(card.skills.length >= 10);
    assert.ok(card.limits.autonomyDefault);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('A2A: zadatak od drugog agenta se izvršava i ima stanje + istoriju', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'A2A odgovor' }) });
  try {
    const task = await robot.a2a.send({ tenantId: 'nmq', message: 'Pitanje od partnera', skillId: 'support', fromAgent: 'partner-bot', wait: true });
    assert.equal(task.state, 'completed');
    assert.match(task.output, /A2A odgovor/);
    assert.equal(task.history.length, 2);
    assert.ok(task.runId);

    const fetched = await robot.a2a.get('nmq', task.id);
    assert.equal(fetched.id, task.id);
    const list = await robot.a2a.list('nmq', { state: 'completed' });
    assert.equal(list.length, 1);

    await assert.rejects(() => robot.a2a.get('demo-shop', task.id), NotFoundError);
    await assert.rejects(() => robot.a2a.send({ tenantId: 'nmq' }), ValidationError);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('A2A: pregovor — granice, dogovor i poravnanje (interni ledger)', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    // ponuda preko maksimuma se odbija
    await assert.rejects(
      () => robot.negotiator.open({ tenantId: 'nmq', counterparty: 'dobavljac-x', topic: 'kupovina', ourOffer: { amountUsd: 999999 } }),
      PolicyError,
    );

    // normalan tok: otvaranje → kontraponuda → prihvatanje
    const neg = await robot.negotiator.open({ tenantId: 'nmq', counterparty: 'dobavljac-x', topic: 'kupovina licenci', ourOffer: { amountUsd: 200, items: 10 } });
    assert.equal(neg.state, 'open');
    assert.equal(neg.requiresHuman, false);

    let state = await robot.negotiator.respond('nmq', neg.id, { offer: { amountUsd: 240, items: 12 }, by: 'dobavljac-x' });
    assert.equal(state.round, 1);
    state = await robot.negotiator.respond('nmq', neg.id, { offer: { amountUsd: 200, items: 12 }, accept: true, by: 'us' });
    assert.equal(state.state, 'agreed');

    const closed = await robot.negotiator.close('nmq', neg.id);
    assert.equal(closed.negotiation.state, 'closed');
    assert.equal(closed.settlement.status, 'settled');
    assert.equal(closed.settlement.amountUsd, 200);
    assert.match(closed.settlement.note, /simulacija/);
    assert.ok(closed.negotiation.contract);
    assert.equal(closed.negotiation.contract.signature, null);

    const totals = await robot.settlement.totals('nmq');
    assert.equal(totals.count, 1);
    assert.equal(totals.settled, 200);
    assert.ok(totals.byMethod.internal >= 200);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('A2A: pregovor iznad praga traži čovjeka (proposal), ispod minimuma se odbija', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const big = await robot.negotiator.open({ tenantId: 'nmq', counterparty: 'partner', topic: 'veliki posao', ourOffer: { amountUsd: 3000 }, constraints: { maxAmountUsd: 5000, requireHumanAboveUsd: 1000 } });
    assert.equal(big.requiresHuman, true);
    const agreed = await robot.negotiator.respond('nmq', big.id, { offer: { amountUsd: 3000 }, accept: true, by: 'partner' });
    assert.equal(agreed.state, 'awaiting_human');
    assert.ok(agreed.proposalId);
    const proposal = await robot.improvements.get('nmq', agreed.proposalId);
    assert.equal(proposal.riskLevel, 'high');
    await assert.rejects(() => robot.negotiator.close('nmq', big.id), ValidationError);

    // ispod minimalne jedinične cijene → odbijeno
    const low = await robot.negotiator.open({ tenantId: 'nmq', counterparty: 'partner', topic: 'maloprodaja', ourOffer: { amountUsd: 100, unitPriceUsd: 5 }, constraints: { minUnitPriceUsd: 10 } });
    const rejected = await robot.negotiator.respond('nmq', low.id, { offer: { amountUsd: 100, unitPriceUsd: 4 }, by: 'partner' });
    assert.equal(rejected.state, 'rejected');
    assert.match(rejected.reason, /ispod minimuma/);

    // nedozvoljen partner
    await assert.rejects(() => robot.negotiator.open({ tenantId: 'nmq', counterparty: 'zli', topic: 'x', ourOffer: { amountUsd: 10 }, constraints: { allowedCounterparties: ['dobavljac-x'] } }), PolicyError);
  } finally {
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── HTTP rute (v0.3) ───────────────────────────

test('HTTP: ciljevi, prijedlozi, watcheri, autonomija, org i A2A rute', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (url, init = {}) => {
    const res = await fetch(`${base}${url}`, { ...init, headers: { 'content-type': 'application/json', 'x-tenant': 'nmq', ...(init.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const created = await call('/v1/admin/goals', { method: 'POST', body: JSON.stringify({ title: 'Rast prihoda', metric: 'rev', baseline: 100, target: 200, deadline: new Date(Date.now() + 30 * 86_400_000).toISOString(), owner: 'cro' }) });
    assert.equal(created.status, 200);
    const goalId = created.body.id;

    const dec = await call(`/v1/admin/goals/${goalId}/decompose`, { method: 'POST' });
    assert.equal(dec.body.goal.subgoals.length, 2);

    const prog = await call(`/v1/admin/goals/${goalId}/progress`, { method: 'POST', body: JSON.stringify({ value: 150 }) });
    assert.equal(prog.body.progressPct, 50);

    const portfolio = await call('/v1/admin/goals?portfolio=1');
    assert.equal(portfolio.body.total, 1);

    const card = await call('/.well-known/agent.json');
    assert.equal(card.body.protocolVersion, '1.0');

    const task = await call('/a2a/tasks', { method: 'POST', body: JSON.stringify({ message: 'pitanje partnera', skillId: 'support', wait: true }) });
    assert.equal(task.status, 200);
    assert.equal(task.body.state, 'completed');
    const taskId = task.body.id;
    const fetched = await call(`/a2a/tasks/${taskId}`);
    assert.equal(fetched.body.id, taskId);

    const neg = await call('/a2a/negotiations', { method: 'POST', body: JSON.stringify({ counterparty: 'partner', topic: 'licence', offer: { amountUsd: 150 } }) });
    assert.equal(neg.status, 200);
    const responded = await call(`/a2a/negotiations/${neg.body.id}/respond`, { method: 'POST', body: JSON.stringify({ offer: { amountUsd: 150 }, accept: true }) });
    assert.equal(responded.body.state, 'agreed');
    const closed = await call(`/a2a/negotiations/${neg.body.id}/close`, { method: 'POST' });
    assert.equal(closed.body.settlement.status, 'settled');

    const settlements = await call('/a2a/settlements');
    assert.equal(settlements.body.totals.count, 1);

    const aut = await call('/v1/admin/autonomy');
    assert.equal(aut.body.default, 'L1');
    const check = await call('/v1/admin/autonomy/check', { method: 'POST', body: JSON.stringify({ agentId: 'sales', riskLevel: 'low', kind: 'act' }) });
    assert.equal(check.body.action, 'allow');

    const org = await call('/v1/admin/org');
    assert.equal(org.body.roles.length, 7);

    const selfplay = await call('/v1/admin/selfplay', { method: 'POST', body: JSON.stringify({ rounds: 1, solverAgent: 'support' }) });
    assert.equal(selfplay.status, 200);
    assert.equal(selfplay.body.rounds, 1);

    const rsi = await call('/v1/admin/rsi/cycle', { method: 'POST', body: JSON.stringify({ sinceDays: 1 }) });
    assert.equal(rsi.status, 200);
    assert.ok(Array.isArray(rsi.body.findings));

    const createdProposal = await call('/v1/admin/proposals', { method: 'POST', body: JSON.stringify({ kind: 'action', target: 'support', proposed: { input: 'Provjeri otvorene tickete' }, rationale: 'HTTP test', riskLevel: 'low' }) });
    assert.equal(createdProposal.status, 200);
    const proposals = await call('/v1/admin/proposals');
    assert.ok(proposals.body.proposals.length >= 1);
    const pid = proposals.body.proposals[0].id;
    const decided = await call(`/v1/admin/proposals/${pid}/decide`, { method: 'POST', body: JSON.stringify({ approve: true, by: 'dejan' }) });
    assert.equal(decided.body.status, 'approved');
    const applied = await call(`/v1/admin/proposals/${pid}/apply`, { method: 'POST' });
    assert.ok(['applied', 'needs_code'].includes(applied.body.proposal.status));

    const runForReward = await call('/v1/run', { method: 'POST', body: JSON.stringify({ agentId: 'creative', input: 'napiši oglas', tenantId: 'nmq' }) });
    assert.equal(runForReward.status, 200);
    const rewards = await call('/v1/admin/rewards');
    assert.ok(rewards.body.ranking.all.length >= 1);

    const watchers = await call('/v1/admin/watchers/metrics', { method: 'POST', body: JSON.stringify({ metric: 'support_tickets_open', value: 99 }) });
    assert.equal(watchers.body.value, 99);
    const tick = await call('/v1/admin/watchers/tick', { method: 'POST' });
    assert.ok(tick.body.fired.length >= 1);
  } finally {
    await robot.close();
    await cleanup(robot.__dir);
  }
});
