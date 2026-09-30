/**
 * v0.3.1 — eval harness + regresije na nalaze nezavisne revizije:
 *   - eval zlatni set (provjere: sadržaj, citat, alati, status, trošak)
 *   - tvrdi limiti iz politike (`maxToolCalls`, `maxTokens`)
 *   - `apply` ne smije primijeniti prijedlog bez sadržaja (ranije: String(null) = "null")
 *   - rollback KB prijedloga briše unesene zapise
 *   - autonomija preživljava restart
 *   - A2A zadatak se nastavlja poslije odobrenja
 *   - company.cycle traži autonomiju za planiranje
 *   - trace sadrži spanove alata (ranije ih nije bilo)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildTestRobot, cleanup, smartScript, tempDataDir } from './helpers.mjs';
import { ValidationError, PolicyError, NotFoundError } from '../src/core/errors.js';

const ROOT = path.resolve(import.meta.dirname, '..');

// ─────────────────────────── eval harness ───────────────────────────

test('eval: zlatni set se pokreće, provjere rade i rezultat je iznad praga', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    const set = await robot.eval.loadSet('nmq');
    assert.equal(set.cases.length, 6);
    const report = await robot.eval.run('nmq');
    assert.equal(report.total, 6);
    assert.ok(report.passRate >= 0.8, `prolaznost je ${report.passRate}`);
    assert.equal(report.meetsThreshold, true);
    assert.ok(report.costUsd > 0);
    assert.ok(report.avgDurationMs >= 0);
    const history = await robot.eval.history('nmq');
    assert.ok(history.length >= 1);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('eval: detektuje pad (provjera alata i sadržaja) i ne laže o uspjehu', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'Ne znam.' }) });
  try {
    const report = await robot.eval.run('nmq', { caseIds: ['support-reset-lozinke', 'finance-faktura-racunica'] });
    assert.equal(report.total, 2);
    assert.equal(report.passed, 0);
    assert.ok(report.failures.length === 2);
    const first = report.failures.find((f) => f.caseId === 'support-reset-lozinke');
    assert.ok(first.failures.some((m) => /memory_search|ne znam/i.test(m)), JSON.stringify(first.failures));
    assert.equal(report.meetsThreshold, false);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('eval: provjere pojedinačno (mustInclude/mustCite/maxCostUsd/expectStatus)', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const pass = robot.eval.checkCase({ checks: { mustInclude: ['ok'], mustCite: false } }, { output: 'Odgovor: ok', status: 'ok' });
    assert.equal(pass.passed, true);

    const fail = robot.eval.checkCase({ checks: { mustInclude: ['obavezno'], mustCite: true, maxCostUsd: 0.001, expectStatus: 'ok' } }, { output: 'nema toga', status: 'error', costUsd: 0.5 });
    assert.equal(fail.passed, false);
    assert.equal(fail.failures.length, 4);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('eval: HTTP ruta pokreće set i vraća izvještaj', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const res = await fetch(`${base}/v1/admin/eval`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant': 'nmq' }, body: JSON.stringify({ maxCases: 3 }) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.total, 3);
    assert.ok(body.passRate >= 0);

    const sets = await (await fetch(`${base}/v1/admin/eval/sets`, { headers: { 'x-tenant': 'nmq' } })).json();
    assert.equal(sets.goldenSet.cases, 6);
    const hist = await (await fetch(`${base}/v1/admin/eval/history`, { headers: { 'x-tenant': 'nmq' } })).json();
    assert.ok(hist.history.length >= 1);
  } finally {
    await robot.close();
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── tvrdi limiti iz politike ───────────────────────────

test('politika: maxToolCalls prekida petlju alata', async () => {
  const robot = await buildTestRobot({
    // mock uvijek traži alat — da bi limit stvarno bio testiran (a ne da petlja stane sama)
    script: () => ({ toolCalls: [{ name: 'calculator', arguments: { expression: '1+1' } }] }),
  });
  try {
    // limit se zadaje po run-u (options) ili politikom (config/policies.json → maxToolCalls)
    const res = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'dev', pattern: 'agent', input: 'izračunaj nešto', options: { maxToolCalls: 2 } });
    const steps = res.result.results[0].steps;
    const blocked = steps.filter((s) => s.code === 'MAX_TOOL_CALLS');
    assert.ok(blocked.length >= 1, 'mora postojati korak blokiran limitom');
  } finally {
    await cleanup(robot.__dir);
  }
});

test('trace sadrži spanove alata (regresija: ranije ih nije bilo)', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'support', pattern: 'agent', input: 'Kako da resetujem lozinku?' });
    const run = robot.tracer.get(res.runId);
    const toolSpans = run.spans.filter((s) => s.name.startsWith('tool '));
    assert.ok(toolSpans.length >= 1, 'trace mora imati span alata');
    assert.match(toolSpans[0].name, /tool memory_search|tool /);
    assert.equal(robot.eval.toolsUsed(res).includes('memory_search'), true);
  } finally {
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── prijedlozi bez sadržaja ───────────────────────────

test('self-improvement: prijedlog bez sadržaja se NE primjenjuje (nema tihog "null" prompta)', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const before = robot.catalog.get('support', 'nmq').systemPrompt;
    const p = await robot.improvements.createProposal('nmq', { kind: 'prompt', target: 'support', proposed: null, rationale: 'RSI nalaz bez predloženog teksta', source: 'rsi' });
    await robot.improvements.decide('nmq', p.id, { approve: true });
    await assert.rejects(() => robot.improvements.apply('nmq', p.id), (err) => err instanceof ValidationError && /dopuni/i.test(err.message));
    assert.equal(robot.catalog.get('support', 'nmq').systemPrompt, before, 'prompt ne smije biti promijenjen');

    // čovjek dopuni → sada prolazi
    await robot.improvements.updateProposal('nmq', p.id, { proposed: 'Novi, bolji prompt agenta.' });
    const applied = await robot.improvements.apply('nmq', p.id);
    assert.equal(applied.proposal.status, 'applied');
    assert.match(robot.catalog.get('support', 'nmq').systemPrompt, /Novi, bolji prompt/);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('self-improvement: prijedlog za nepostojećeg agenta se odbija', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const p = await robot.improvements.createProposal('nmq', { kind: 'prompt', target: 'nema-agenta', proposed: 'tekst', rationale: 'test' });
    await robot.improvements.decide('nmq', p.id, { approve: true });
    await assert.rejects(() => robot.improvements.apply('nmq', p.id), NotFoundError);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('self-improvement: KB prijedlog se može vratiti (briše unesene zapise)', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const p = await robot.improvements.createProposal('nmq', { kind: 'kb', proposed: { text: 'Privremena politika za test povraćaja.', source: 'test-kb' }, rationale: 'test' });
    await robot.improvements.decide('nmq', p.id, { approve: true });
    await robot.improvements.apply('nmq', p.id);
    assert.ok((await robot.memory.vectors.query('nmq', { text: 'privremena politika povraćaja', k: 3 })).length >= 1);

    const rolled = await robot.improvements.rollback('nmq', p.id);
    assert.equal(rolled.status, 'rolled_back');
    assert.equal(rolled.rollbackResult.removed >= 1, true, 'KB zapisi moraju biti obrisani');
    assert.equal((await robot.memory.vectors.query('nmq', { text: 'privremena politika povraćaja', k: 3 })).length, 0);
  } finally {
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── autonomija: perzistencija ───────────────────────────

test('autonomija: promjena nivoa preživljava restart', async () => {
  const dir = await tempDataDir('autonomy');
  const r1 = await buildTestRobot({ script: () => ({ text: 'ok' }), dataDir: dir });
  try {
    assert.equal(r1.autonomy.levelOf('demo-shop', 'creative'), 'L1');
    r1.autonomy.setLevel('demo-shop', 'creative', 'L4');
    assert.equal(r1.autonomy.levelOf('demo-shop', 'creative'), 'L4');
  } finally {
    await r1.close();
  }

  const r2 = await buildTestRobot({ script: () => ({ text: 'ok' }), dataDir: dir });
  try {
    assert.equal(r2.autonomy.levelOf('demo-shop', 'creative'), 'L4', 'nivo mora preživjeti restart');
    // config vrijednosti se ne gaze preko perzistiranih
    assert.equal(r2.autonomy.levelOf('demo-shop', 'support'), 'L2');
  } finally {
    await r2.close();
    await cleanup(dir);
  }
});

// ─────────────────────────── A2A: nastavak poslije odobrenja ───────────────────────────

test('A2A: zadatak koji čeka odobrenje se nastavlja kroz /resume', async () => {
  const robot = await buildTestRobot({
    script: ({ messages }) =>
      messages.some((m) => m.role === 'tool')
        ? { text: 'Mejl je poslat.' }
        : { toolCalls: [{ name: 'email_send', arguments: { to: 'k@example.com', subject: 'Ponuda', body: 'x' } }] },
  });
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (url, init = {}) => {
    const res = await fetch(`${base}${url}`, { ...init, headers: { 'content-type': 'application/json', 'x-tenant': 'nmq', ...(init.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const task = await call('/a2a/tasks', { method: 'POST', body: JSON.stringify({ message: 'Pošalji ponudu partneru', skillId: 'sales', wait: true }) });
    assert.equal(task.status, 200);
    assert.equal(task.body.state, 'input_required', `stanje je ${task.body.state}`);
    assert.ok(task.body.approvals.length >= 1);

    const resumed = await call(`/a2a/tasks/${task.body.id}/resume`, { method: 'POST', body: JSON.stringify({ approve: true, by: 'dejan' }) });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.state, 'completed');
    assert.match(String(resumed.body.output), /Mejl je poslat/);
    assert.ok(resumed.body.history.some((h) => h.state === 'approved'));
  } finally {
    await robot.close();
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── organizacija: autonomija ───────────────────────────

test('organizacija: ciklus planiranja traži autonomiju (L1 ne smije planirati)', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    // demo-shop je L1 → planiranje je zabranjeno
    await assert.rejects(() => robot.company.cycle('demo-shop', { period: 'month' }), (err) => err instanceof PolicyError && /planiranje/i.test(err.message));
    const ok = await robot.company.cycle('nmq', { period: 'month' });
    assert.ok(ok.id);
    const audit = await robot.audit.read('nmq');
    assert.ok(audit.some((e) => e.action === 'autonomy_decision' && e.args?.kind === 'plan'));
  } finally {
    await cleanup(robot.__dir);
  }
});
