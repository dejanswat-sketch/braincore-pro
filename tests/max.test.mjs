/**
 * MAX nivo: persistentni agenti (scheduler), control plane (lifecycle + identitet + budžet),
 * specijalistički tim, refleksija, debata, epizodična memorija, sandbox i OTel izvoz.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildTestRobot, cleanup, smartScript, tempDataDir } from './helpers.mjs';
import { cronMatches, nextCronAt } from '../src/scheduler/cron.js';
import { createSandbox, SANDBOX_LEVELS } from '../src/core/sandbox.js';
import { createOtelExporter } from '../src/observability/otel.js';
import { createControlPlane } from '../src/controlplane/registry.js';
import { PolicyError, ValidationError, NotFoundError } from '../src/core/errors.js';
import { loadConfig } from '../src/core/config.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── cron ───────────────────────────

test('cron: prepoznaje tačan trenutak i liste/raspone/korake', () => {
  const d = new Date('2026-03-04T08:30:00');
  assert.equal(cronMatches('30 8 * * *', d), true);
  assert.equal(cronMatches('0 8 * * *', d), false);
  assert.equal(cronMatches('30 8 * * 1-5', d), true); // srijeda
  assert.equal(cronMatches('*/15 * * * *', d), true);
  assert.equal(cronMatches('0,30 8,9 * * *', d), true);
  assert.throws(() => cronMatches('nije cron', d));
});

test('cron: nextCronAt vraća sljedeći termin', () => {
  const from = new Date('2026-03-04T08:30:00').getTime();
  const next = nextCronAt('0 9 * * *', from);
  assert.equal(new Date(next).getHours(), 9);
  assert.ok(next > from);
});

// ─────────────────────────── scheduler ───────────────────────────

test('scheduler: posao po intervalu se izvršava i bilježi trošak', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'Periodicni posao je odradjen.' }), scheduler: true, env: { NMQ_SCHEDULER_TICK_MS: '20' } });
  try {
    const job = await robot.scheduler.createJob('nmq', {
      name: 'dnevni izvještaj',
      agentId: 'ops',
      pattern: 'agent',
      input: 'Napravi dnevni izvještaj',
      schedule: { type: 'interval', everyMs: 30_000 },
      runNow: true,
    });
    assert.ok(job.id);
    assert.equal(job.enabled, true);
    const res = await robot.scheduler.runNow('nmq', job.id);
    assert.equal(res.status, 'ok');

    const updated = await robot.scheduler.get('nmq', job.id);
    assert.equal(updated.runs, 1);
    assert.ok(updated.totalCostUsd > 0);
    assert.ok(updated.nextRunAt > Date.now(), 'sljedeće pokretanje mora biti u budućnosti');

    const runs = await robot.scheduler.runs('nmq');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].jobId, job.id);
    assert.equal(runs[0].manual, true);

    const audit = await robot.audit.read('nmq');
    assert.ok(audit.some((e) => e.action === 'job_run_manual'));
  } finally {
    await cleanup(robot.__dir);
  }
});

test('scheduler: tick sam pokreće due poslove', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'tick ok' }), scheduler: true, env: { NMQ_SCHEDULER_TICK_MS: '20' } });
  try {
    const job = await robot.scheduler.createJob('nmq', {
      name: 'brzi posao',
      agentId: 'creative',
      pattern: 'agent',
      input: 'kratko',
      schedule: { type: 'interval', everyMs: 3_600_000 },
      runNow: true,
    });
    robot.scheduler.start();
    await wait(300);
    const updated = await robot.scheduler.get('nmq', job.id);
    assert.ok(updated.runs >= 1, `tick je trebao pokrenuti posao (runs=${updated.runs})`);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('scheduler: pauza/resume i brisanje posla', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }), scheduler: true });
  try {
    const job = await robot.scheduler.createJob('nmq', { name: 'x', agentId: 'ops', input: 'x', schedule: { type: 'interval', everyMs: 60_000 } });
    const paused = await robot.scheduler.pause('nmq', job.id);
    assert.equal(paused.enabled, false);
    assert.equal(paused.status, 'paused');
    const resumed = await robot.scheduler.resume('nmq', job.id, { everyMs: 120_000 });
    assert.equal(resumed.enabled, true);
    assert.equal(resumed.schedule.everyMs, 120_000);
    assert.equal(await robot.scheduler.remove('nmq', job.id), true);
    assert.equal(await robot.scheduler.get('nmq', job.id), null);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('scheduler: event trigger pokreće posao koji sluša webhook', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'Reagovao na dogadjaj.' }), scheduler: true });
  try {
    const job = await robot.scheduler.createJob('nmq', {
      name: 'shopify reakcija',
      agentId: 'ecommerce',
      input: 'obradi dogadjaj',
      schedule: { type: 'once' },
      triggers: [{ type: 'event', event: 'hook.shopify' }],
    });
    const fired = await robot.scheduler.triggerEvent('hook.shopify', { orderId: '1042' });
    assert.equal(fired, 1);
    await wait(150);
    const runs = await robot.scheduler.runs('nmq');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].reason, 'event');
    assert.equal(runs[0].event, 'hook.shopify');
    assert.ok(runs[0].runId);
    assert.equal(await robot.scheduler.get('nmq', job.id).then((j) => j.runs), 1);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('scheduler: dugoročni proces izvršava korake i pamti stanje (checkpoint)', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'korak odradjen' }), scheduler: true });
  try {
    const job = await robot.scheduler.createJob('nmq', {
      name: 'onboarding klijenta',
      type: 'process',
      agentId: 'ops',
      schedule: { type: 'interval', everyMs: 60_000 },
      process: {
        steps: [
          { id: 'dan1', name: 'Kickoff', agentId: 'ops', input: 'Uradi kickoff' },
          { id: 'dan3', name: 'Pristupi', agentId: 'ops', input: 'Dodijeli pristupe' },
          { id: 'dan7', name: 'Obuka', agentId: 'ops', input: 'Zakazi obuku' },
        ],
        done: [],
        state: 'pending',
      },
    });

    await robot.scheduler.runNow('nmq', job.id);
    let after1 = await robot.scheduler.get('nmq', job.id);
    assert.deepEqual(after1.process.done, ['dan1'], 'prvi korak mora biti označen kao završen');
    assert.equal(after1.process.state, 'in_progress');

    await robot.scheduler.runNow('nmq', job.id);
    await robot.scheduler.runNow('nmq', job.id);
    const after3 = await robot.scheduler.get('nmq', job.id);
    assert.equal(after3.process.done.length, 3);
    assert.equal(after3.status, 'completed');
    assert.equal(after3.nextRunAt, null);

    // četvrti poziv ne radi ništa novo
    const again = await robot.scheduler.runNow('nmq', job.id);
    assert.equal(again.status, 'completed');
    assert.equal((await robot.scheduler.get('nmq', job.id)).process.done.length, 3);

    // stanje preživljava "restart" (novi job store čita isti fajl)
    const raw = await fs.readFile(path.join(robot.__dir, 'tenants', 'nmq', 'jobs', 'jobs.json'), 'utf8');
    assert.match(raw, /dan7/);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('scheduler: greška alata vodi u retry, pa u failed poslije maxAttempts', async () => {
  const robot = await buildTestRobot({
    scheduler: true,
    script: () => {
      throw Object.assign(new Error('model nedostupan'), { retryable: true });
    },
  });
  try {
    const job = await robot.scheduler.createJob('nmq', {
      name: 'nestabilan posao',
      agentId: 'ops',
      input: 'x',
      schedule: { type: 'interval', everyMs: 60_000 },
      retry: { max: 1, backoffMs: 2000 },
    });
    await robot.scheduler.runNow('nmq', job.id);
    const after1 = await robot.scheduler.get('nmq', job.id);
    assert.equal(after1.status, 'retrying');
    assert.equal(after1.enabled, true);
    assert.ok(after1.nextRunAt > Date.now());

    await robot.scheduler.runNow('nmq', job.id);
    const after2 = await robot.scheduler.get('nmq', job.id);
    assert.equal(after2.status, 'failed');
    assert.equal(after2.enabled, false);

    const runs = await robot.scheduler.runs('nmq');
    assert.equal(runs.filter((r) => r.status === 'error').length, 2);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('scheduler: alat process_update mijenja stanje procesa iz agenta', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }), scheduler: true });
  try {
    const job = await robot.scheduler.createJob('nmq', {
      name: 'proces',
      type: 'process',
      agentId: 'ops',
      schedule: { type: 'interval', everyMs: 60_000 },
      process: { steps: [{ id: 's1', input: 'x' }, { id: 's2', input: 'y' }], done: [], state: 'pending' },
    });
    const res = await robot.tools.execute(
      'process_update',
      { jobId: job.id, state: 'waiting_client', note: 'cekam odgovor klijenta', nextRunInMs: 3_600_000 },
      { tenantId: 'nmq', agentId: 'ops', jobId: job.id },
    );
    assert.equal(res.result.state, 'waiting_client');
    const updated = await robot.scheduler.get('nmq', job.id);
    assert.equal(updated.process.state, 'waiting_client');
    assert.match(updated.process.log.at(-1).note, /cekam odgovor/);
    assert.ok(updated.nextRunAt > Date.now());
  } finally {
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── control plane ───────────────────────────

test('control plane: deploy nove verzije mijenja agenta odmah, rollback ga vraća', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const before = robot.catalog.get('support', 'nmq').temperature;
    const deployed = await robot.controlPlane.deploy('nmq', 'support', { patch: { temperature: 0.9, maxSteps: 3 }, note: 'topliji ton' });
    assert.equal(deployed.version, 1);
    assert.equal(robot.catalog.get('support', 'nmq').temperature, 0.9);
    assert.equal(robot.catalog.get('support', 'nmq').maxSteps, 3);

    const v2 = await robot.controlPlane.deploy('nmq', 'support', { patch: { maxSteps: 5 } });
    assert.equal(v2.version, 2);
    assert.equal(robot.catalog.get('support', 'nmq').maxSteps, 5);
    assert.equal(robot.catalog.get('support', 'nmq').temperature, 0.9, 'zakrpe se sabiraju');

    const rolled = await robot.controlPlane.rollback('nmq', 'support', 1);
    assert.equal(rolled.activeVersion, 1);
    assert.equal(robot.catalog.get('support', 'nmq').maxSteps, 3);

    const baseline = await robot.controlPlane.rollback('nmq', 'support', 0);
    assert.deepEqual(baseline.overrides, {});
    assert.equal(robot.catalog.get('support', 'nmq').temperature, before);

    const audit = await robot.audit.read('nmq');
    assert.ok(audit.some((e) => e.action === 'agent_deploy'));
    assert.ok(audit.some((e) => e.action === 'agent_rollback'));
  } finally {
    await cleanup(robot.__dir);
  }
});

test('control plane: pauziran agent ne može da se pokrene', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    await robot.controlPlane.setStatus('nmq', 'sales', 'paused', { reason: 'test' });
    await assert.rejects(
      () => robot.orchestrator.run({ tenantId: 'nmq', agentId: 'sales', pattern: 'agent', input: 'x' }),
      (err) => err instanceof PolicyError || err.code === 'POLICY_DENIED',
    );
    await robot.controlPlane.setStatus('nmq', 'sales', 'active');
    const ok = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'sales', pattern: 'agent', input: 'x' });
    assert.equal(ok.status, 'ok');
  } finally {
    await cleanup(robot.__dir);
  }
});

test('control plane: mjesečni budžet po agentu blokira dalje runove', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    await robot.controlPlane.setBudget('nmq', 'creative', 0.0000001);
    await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'creative', pattern: 'agent', input: 'prvi' });
    await assert.rejects(
      () => robot.orchestrator.run({ tenantId: 'nmq', agentId: 'creative', pattern: 'agent', input: 'drugi' }),
      (err) => err instanceof PolicyError && /budžet/.test(err.message),
    );
    const audit = await robot.audit.read('nmq');
    assert.ok(audit.some((e) => e.action === 'agent_budget_block'));
  } finally {
    await cleanup(robot.__dir);
  }
});

test('control plane: per-agent ključ se izdaje, provjerava i opoziva', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const issued = await robot.controlPlane.issueAgentKey('nmq', 'executor', { scopes: ['crm:write'], label: 'server-1' });
    assert.match(issued.key, /^nmqa_/);
    const auth = robot.controlPlane.authenticateAgentKey(issued.key);
    assert.equal(auth.tenantId, 'nmq');
    assert.equal(auth.agentId, 'executor');
    assert.deepEqual(auth.scopes, ['crm:write']);
    assert.equal(robot.controlPlane.authenticateAgentKey('nmqa_pogresan'), null);

    const raw = await fs.readFile(path.join(robot.__dir, '_control', 'agents.json'), 'utf8');
    assert.ok(!raw.includes(issued.key), 'ključ se čuva samo kao hash');

    await robot.controlPlane.revokeAgentKey('nmq', 'executor', issued.keyId);
    assert.equal(robot.controlPlane.authenticateAgentKey(issued.key), null);
    const audit = await robot.audit.read('nmq');
    assert.ok(audit.some((e) => e.action === 'agent_key_issued'));
    assert.ok(audit.some((e) => e.action === 'agent_key_revoked'));
  } finally {
    await cleanup(robot.__dir);
  }
});

test('control plane: stanje preživljava restart (override se vraća iz fajla)', async () => {
  const dir = await tempDataDir('cp-restart');
  const robot1 = await buildTestRobot({ script: () => ({ text: 'ok' }), dataDir: dir });
  await robot1.controlPlane.deploy('nmq', 'support', { patch: { temperature: 0.77 } });
  await robot1.close();

  const robot2 = await buildTestRobot({ script: () => ({ text: 'ok' }), dataDir: dir });
  try {
    assert.equal(robot2.catalog.get('support', 'nmq').temperature, 0.77, 'deploy mora preživjeti restart');
  } finally {
    await robot2.close();
    await cleanup(dir);
  }
});

// ─────────────────────────── specijalistički patterni ───────────────────────────

test('pattern: team prolazi kroz sve specijalističke uloge', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', pattern: 'team', input: 'Pripremi ponudu za Prima d.o.o.' });
    assert.equal(res.pattern, 'team');
    const roles = res.result.stages.map((s) => s.role);
    assert.deepEqual(roles.slice(0, 6), ['plan', 'research', 'extract', 'validate', 'decide', 'execute']);
    assert.ok(res.result.stages.every((s) => s.ok), 'svaki korak tima mora uspjeti');
    assert.ok(res.output.length > 0);
    assert.ok(res.costUsd > 0);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('pattern: team poštuje skip listu i ne pada ako agent ne postoji', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    const res = await robot.orchestrator.run({
      tenantId: 'nmq',
      pattern: 'team',
      input: 'Kratak zadatak',
      options: { patternConfig: { skip: ['research', 'extract', 'validate'] } },
    });
    const roles = res.result.stages.map((s) => s.role);
    assert.ok(!roles.includes('research'));
    assert.ok(roles.includes('plan'));

    const res2 = await robot.orchestrator.run({
      tenantId: 'nmq',
      pattern: 'team',
      input: 'x',
      options: { patternConfig: { stages: [{ role: 'plan', agent: 'planner' }, { role: 'x', agent: 'nema-me' }], synthesize: false } },
    });
    assert.deepEqual(res2.result.missingAgents, ['nema-me']);
    assert.equal(res2.result.stages.length, 1);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('pattern: reflection popravi odgovor kroz kritičara', async () => {
  let call = 0;
  const robot = await buildTestRobot({
    script: () => {
      call += 1;
      // prvi odgovor je namjerno loš (kratak) → kritičar traži popravku
      return call === 1 ? { text: 'Ne znam.' } : { text: 'Evo detaljnog odgovora sa koracima i rokovima za klijenta Prima d.o.o.' };
    },
  });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', pattern: 'reflection', agentId: 'sales', input: 'Napisi ponudu', options: { patternConfig: { maxRounds: 2, threshold: 0.95 } } });
    assert.equal(res.result.rounds.length, 2, 'mora uraditi drugu rundu jer prva nije prošla');
    assert.ok(res.result.rounds[1].score > res.result.rounds[0].score, 'druga verzija mora biti bolja');
    assert.match(res.output, /detaljnog odgovora/);
    assert.ok(res.result.improvement > 0);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('pattern: debate vodi raspravu i sudija donosi odluku', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    const res = await robot.orchestrator.run({
      tenantId: 'nmq',
      pattern: 'debate',
      input: 'Da li uvesti novu funkciju?',
      options: { patternConfig: { rounds: 2, debaters: [{ agent: 'finance', stance: 'za' }, { agent: 'legal', stance: 'protiv' }, { agent: 'ops', stance: 'operativno' }] } },
    });
    assert.equal(res.result.rounds, 2);
    assert.equal(res.result.debaters.length, 3);
    assert.equal(res.result.transcript.length, 6, '3 debatera × 2 runde');
    assert.ok(res.result.positions.finance.length > 0);
    assert.ok(res.output.length > 0);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('pattern: debate sa nedovoljno debatera ne pada, nego se ponaša kao agent', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'Odgovor bez debate.' }) });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', pattern: 'debate', agentId: 'ops', input: 'x', options: { patternConfig: { debaters: [{ agent: 'finance' }] } } });
    assert.match(res.result.skipped, /nedovoljno/);
    assert.match(res.output, /Odgovor bez debate/);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('pattern: react je alias za agent petlju (ReAct)', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', pattern: 'react', agentId: 'support', input: 'Kako da resetujem lozinku?' });
    assert.equal(res.status, 'ok');
    assert.ok(res.output.length > 0);
  } finally {
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── epizodična memorija ───────────────────────────

test('epizodična memorija: pamti ishod, pronalazi slične i daje few-shot tekst', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    await robot.memory.episodic.record('nmq', {
      agentId: 'support',
      problem: 'Kupac traži povraćaj novca za narudžbinu koja je kasnila 10 dana',
      solution: 'Provjerio politiku (14 dana), odobrio povraćaj, poslao potvrdu',
      success: true,
      lessons: ['Uvijek provjeri rok od 14 dana prije odobrenja'],
      tools: ['memory_search', 'email_send'],
    });
    await robot.memory.episodic.record('nmq', {
      agentId: 'support',
      problem: 'Kupac pita gdje je paket',
      solution: 'Provjerio status narudžbine i poslao tracking',
      success: true,
    });

    const similar = await robot.memory.episodic.similar('nmq', 'kupac hoće povraćaj novca jer je kasnilo', { k: 2 });
    assert.ok(similar.length >= 1);
    assert.match(similar[0].problem, /povraćaj/);

    const text = await robot.memory.episodic.fewShotText('nmq', 'kupac traži povraćaj novca jer je kasnilo', { k: 2 });
    assert.match(text, /Sličan prošli slučaj/);
    assert.match(text, /Pouke:/);

    const stats = await robot.memory.episodic.stats('nmq');
    assert.equal(stats.total, 2);
    assert.equal(stats.success, 2);

    // izolacija: drugi tenant ne vidi epizode
    const other = await robot.memory.episodic.similar('demo-shop', 'povraćaj novca');
    assert.equal(other.length, 0);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('epizodična memorija: agent automatski pamti epizodu kad koristi alat', async () => {
  const robot = await buildTestRobot({ script: smartScript() });
  try {
    await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'support', pattern: 'agent', input: 'Kako da resetujem lozinku?' });
    const stats = await robot.memory.episodic.stats('nmq');
    assert.ok(stats.total >= 1, 'epizoda mora biti zapamćena kad je agent koristio alat');
    assert.ok(stats.byAgent.support >= 1);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('epizodična memorija: alat episode_record i pouke', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const res = await robot.tools.execute(
      'episode_record',
      { problem: 'Faktura sa pogrešnim PDV-om', solution: 'Ispravio stopu na 20% i poslao novu', success: false, lessons: ['Provjeri PDV prije slanja'] },
      { tenantId: 'nmq', agentId: 'finance' },
    );
    assert.ok(res.result.id);
    const updated = await robot.memory.episodic.addLesson('nmq', res.result.id, { lesson: 'Dodaj provjeru u SOP', success: true });
    assert.equal(updated.success, true);
    assert.equal(updated.lessons.length, 2);
  } finally {
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── sandbox ───────────────────────────

test('sandbox: nivoi, mreža, putanje i env', () => {
  assert.deepEqual(SANDBOX_LEVELS, ['none', 'restricted', 'strict']);

  const sb = createSandbox({ level: 'restricted', networkAllowlist: ['api.deepseek.com'], fsWriteRoots: ['/data'], fsReadRoots: ['/app'], envAllowlist: ['SLACK_BOT_TOKEN'] });
  assert.equal(sb.assertNetwork('https://api.deepseek.com/v1/x'), true);
  assert.throws(() => sb.assertNetwork('https://zli.example.com'), PolicyError);
  assert.throws(() => sb.assertNetwork('nije-url'), PolicyError);

  assert.equal(sb.assertPath('/data/tenants/nmq/a.json', { mode: 'write' }), path.resolve('/data/tenants/nmq/a.json'));
  assert.throws(() => sb.assertPath('/etc/passwd', { mode: 'write' }), PolicyError);
  assert.throws(() => sb.assertPath('/data/../etc/passwd', { mode: 'read' }), PolicyError);

  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.NMQ_MASTER_KEY = 'tajna-koja-ne-smije-u-podproces';
  const env = sb.scrubEnv({ CUSTOM: '1' });
  assert.equal(env.SLACK_BOT_TOKEN, 'xoxb-test');
  assert.equal(env.CUSTOM, '1');
  assert.equal(env.NMQ_MASTER_KEY, undefined, 'tajne hosta ne idu u podproces');
  assert.ok(env.PATH);
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.NMQ_MASTER_KEY;

  const strict = createSandbox({ level: 'strict', networkAllowlist: ['x.com'], fsWriteRoots: ['/data'] });
  assert.throws(() => strict.assertNetwork('https://x.com'), PolicyError);
  assert.throws(() => strict.assertPath('/data/a', { mode: 'write' }), PolicyError);

  assert.throws(() => createSandbox({ level: 'nepoznat' }), PolicyError);
});

test('sandbox: http_fetch poštuje sandbox granice prije allowliste', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    await assert.rejects(
      () => robot.tools.execute('http_fetch', { url: 'https://zli.example.com/steal' }, { tenantId: 'nmq', agentId: 'dev', sandbox: robot.sandbox, approvedTools: new Set(['http_fetch']) }),
      (err) => err.code === 'POLICY_DENIED',
    );
  } finally {
    await cleanup(robot.__dir);
  }
});

test('sandbox: MCP podproces dobija očišćen env (bez tajni hosta)', async () => {
  const { createMcpManager } = await import('../src/tools/mcp-client.js');
  const { createToolRegistry } = await import('../src/tools/registry.js');
  const probeFile = path.join(ROOT, 'mcp', '_sb-probe.mjs');
  await fs.writeFile(
    probeFile,
    [
      "import readline from 'node:readline';",
      'const rl = readline.createInterface({ input: process.stdin });',
      "rl.on('line', (line) => {",
      '  let msg; try { msg = JSON.parse(line); } catch { return; }',
      '  if (msg.id === undefined || msg.id === null) return;',
      "  if (msg.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'probe', version: '1', leaked: Object.keys(process.env).filter((k) => /MASTER_KEY|SECRET_HOST/.test(k)) } } }) + '\\n');",
      '    return;',
      '  }',
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\\n');",
      '});',
      'setTimeout(() => process.exit(0), 5000);',
    ].join('\n'),
    'utf8',
  );

  process.env.NMQ_MASTER_KEY = 'tajna-hosta';
  process.env.SECRET_HOST_TOKEN = 'tajna-hosta-2';
  const registry = createToolRegistry({ logger: null });
  const sandbox = createSandbox({ level: 'restricted', networkAllowlist: ['x'], envAllowlist: ['PATH'] });
  const mcp = createMcpManager({ registry, logger: null, root: ROOT, sandbox });
  try {
    const report = await mcp.connectAll([{ id: 'probe', transport: 'stdio', command: process.execPath, args: ['mcp/_sb-probe.mjs'], enabled: true }]);
    assert.equal(report[0].serverInfo?.name, 'probe');
    assert.deepEqual(report[0].serverInfo.leaked, [], 'tajne hosta ne smiju doći do MCP podprocesa');
  } finally {
    await mcp.closeAll();
    delete process.env.NMQ_MASTER_KEY;
    delete process.env.SECRET_HOST_TOKEN;
    await fs.rm(probeFile, { force: true });
  }
});

// ─────────────────────────── OTel ───────────────────────────

test('otel: run se izvozi kao OTLP/JSON sa atributima i statusom', async () => {
  const dir = await tempDataDir('otel');
  const otel = createOtelExporter({ dataDir: dir, file: true, logger: null, endpoint: '', serviceVersion: '0.2.0' });
  const run = {
    runId: 'run_1',
    traceId: 'trace_abc123',
    tenantId: 'nmq',
    agentId: 'support',
    pattern: 'agent',
    startedAt: '2026-03-04T08:00:00.000Z',
    endedAt: '2026-03-04T08:00:02.000Z',
    status: 'ok',
    costUsd: 0.0012,
    usage: { tokensIn: 100, tokensOut: 50 },
    spans: [{ spanId: 'span_1', name: 'llm:support', startedAt: '2026-03-04T08:00:00.500Z', durationMs: 800, status: 'ok', attrs: { step: 1 } }],
  };
  const payload = await otel.exportRun(run);
  assert.ok(payload.resourceSpans);
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2, 'jedan span + korijenski span run-a');
  const root = spans.find((s) => s.name.startsWith('agent.run'));
  assert.ok(root.attributes.some((a) => a.key === 'nmq.cost_usd' && a.value.doubleValue === 0.0012));
  assert.ok(root.attributes.some((a) => a.key === 'nmq.tenant' && a.value.stringValue === 'nmq'));

  const written = await fs.readFile(otel.traceFile, 'utf8');
  assert.match(written, /resourceSpans/);
  assert.equal(otel.exported, 1);
  await cleanup(dir);
});

test('otel: greška u izvozu ne ruši run', async () => {
  const otel = createOtelExporter({ dataDir: null, file: false, endpoint: 'http://127.0.0.1:1/v1/traces', logger: null, fetchImpl: async () => ({ ok: false, status: 500 }) });
  const res = await otel.exportRun({ runId: 'x', tenantId: 'nmq', spans: [] });
  assert.ok(res, 'izvoz vraća payload i kad endpoint padne');
});

test('tracer: OTel izvoz se poziva na kraju run-a', async () => {
  const dir = await tempDataDir('otel2');
  const exported = [];
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }), dataDir: dir, overrides: { otel: { enabled: true, exported: 0, exportRun: async (run) => exported.push(run.runId) } } });
  try {
    const res = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'ops', pattern: 'agent', input: 'x' });
    assert.ok(exported.includes(res.runId));
  } finally {
    await robot.close();
    await cleanup(dir);
  }
});

// ─────────────────────────── admin API ───────────────────────────

test('admin API: lifecycle, ključevi, poslovi i epizode kroz HTTP', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'admin ok' }), scheduler: true, env: { NMQ_SCHEDULER_TICK_MS: '50' } });
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (url, init = {}) => {
    const res = await fetch(`${base}${url}`, { ...init, headers: { 'content-type': 'application/json', 'x-tenant': 'nmq', ...(init.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const health = await call('/v1/admin/health');
    assert.equal(health.status, 200);
    assert.ok(health.body.controlPlane);
    assert.ok(health.body.sandbox);
    assert.equal(health.body.scheduler.running, true);

    const agents = await call('/v1/admin/agents');
    assert.equal(agents.body.agents.length, 19);

    const deploy = await call('/v1/admin/agents/support/deploy', { method: 'POST', body: JSON.stringify({ patch: { temperature: 0.33 }, note: 'http deploy' }) });
    assert.equal(deploy.status, 200);
    assert.equal(robot.catalog.get('support', 'nmq').temperature, 0.33);

    const rollback = await call('/v1/admin/agents/support/rollback', { method: 'POST', body: JSON.stringify({ version: 0 }) });
    assert.equal(rollback.body.activeVersion, 0);
    assert.equal(robot.catalog.get('support', 'nmq').temperature, 0.2);

    const paused = await call('/v1/admin/agents/creative/status', { method: 'POST', body: JSON.stringify({ status: 'paused' }) });
    assert.equal(paused.body.status, 'paused');
    await call('/v1/admin/agents/creative/status', { method: 'POST', body: JSON.stringify({ status: 'active' }) });

    const key = await call('/v1/admin/agents/executor/keys', { method: 'POST', body: JSON.stringify({ scopes: ['crm:write'] }) });
    assert.match(key.body.key, /^nmqa_/);

    const job = await call('/v1/admin/jobs', { method: 'POST', body: JSON.stringify({ name: 'http posao', agentId: 'ops', input: 'radi', schedule: { type: 'once' }, runNow: true }) });
    assert.equal(job.status, 200);
    const runNow = await call(`/v1/admin/jobs/${job.body.id}/run`, { method: 'POST' });
    assert.equal(runNow.body.status, 'ok');
    const runs = await call(`/v1/admin/jobs/${job.body.id}/runs`);
    assert.ok(runs.body.runs.length >= 1);

    const process = await call('/v1/admin/processes', { method: 'POST', body: JSON.stringify({ name: 'onboarding', agentId: 'ops', steps: [{ id: 'd1', input: 'a' }, { id: 'd2', input: 'b' }] }) });
    assert.equal(process.body.steps, 2);

    const episode = await call('/v1/admin/episodes', { method: 'POST', body: JSON.stringify({ problem: 'test problem', solution: 'test rjesenje', success: true }) });
    assert.ok(episode.body.id);
    const episodes = await call('/v1/admin/episodes');
    assert.equal(episodes.body.stats.total, 1);

    const who = await call('/v1/whoami');
    assert.equal(who.body.tenantId, 'nmq');

    const nf = await call('/v1/admin/jobs/nepostoji');
    assert.equal(nf.status, 404);

    const bad = await call('/v1/admin/agents/support/deploy', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(bad.status, 400);
  } finally {
    await robot.close();
    await cleanup(robot.__dir);
  }
});

test('admin API: viewer rola ne smije u kontrolnu ravan', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    robot.tenants.authenticate = () => ({ tenantId: 'nmq', role: 'viewer', keyId: 'test', auth: 'test' });
    const res = await fetch(`${base}/v1/admin/agents`, { headers: { 'x-tenant': 'nmq' } });
    assert.equal(res.status, 403);
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await robot.close();
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── webhook → event bus ───────────────────────────

test('webhook emituje događaj na bus i pokreće posao koji ga sluša', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'reagovao' }), scheduler: true, env: { NMQ_SCHEDULER_TICK_MS: '50' } });
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  const seen = [];
  robot.bus.on('hook.shopify', (e) => seen.push(e));
  try {
    await robot.scheduler.createJob('nmq', {
      name: 'slusa shopify',
      agentId: 'ecommerce',
      input: 'obradi',
      schedule: { type: 'once' },
      triggers: [{ type: 'event', event: 'hook.shopify' }],
    });
    const res = await fetch(`${base}/v1/hooks/shopify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant': 'nmq' },
      body: JSON.stringify({ subject: 'Narudžbina 1042', body: 'kasni' }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].source, 'shopify');
    // čekaj dok scheduler ne pokupi event-triggered posao (pod opterećenjem 250ms nije dovoljno)
    const deadline = Date.now() + 8000;
    let runs = [];
    while (Date.now() < deadline) {
      runs = await robot.scheduler.runs('nmq');
      if (runs.some((r) => r.reason === 'event')) break;
      await wait(100);
    }
    assert.ok(runs.some((r) => r.reason === 'event'), 'posao koji sluša događaj mora se pokrenuti');
  } finally {
    await robot.close();
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── validacije ───────────────────────────

test('control plane: validacije bacaju jasne greške', async () => {
  const dir = await tempDataDir('cp-val');
  const config = await loadConfig({ root: ROOT, dataDir: dir });
  const { createAgentCatalog } = await import('../src/agents/catalog.js');
  const catalog = createAgentCatalog(config, null);
  const cp = createControlPlane({ config, catalog, dataDir: dir, logger: null, metrics: null, audit: null, cost: null, tenants: { has: () => true }, env: {} });
  await cp.load();
  await assert.rejects(() => cp.deploy('nmq', 'support', {}), ValidationError);
  await assert.rejects(() => cp.setStatus('nmq', 'support', 'nepoznato'), ValidationError);
  await assert.rejects(() => cp.deploy('nmq', 'nema-agenta', {}), NotFoundError);
  await cleanup(dir);
});

test('scheduler: cron posao dobija sljedeći termin pri kreiranju', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }), scheduler: true });
  try {
    const job = await robot.scheduler.createJob('nmq', { name: 'jutarnji', agentId: 'ops', input: 'izvjestaj', schedule: { type: 'cron', cron: '0 8 * * 1-5' } });
    assert.ok(job.nextRunAt > Date.now());
    const when = new Date(job.nextRunAt);
    assert.equal(when.getHours(), 8);
    assert.equal(when.getMinutes(), 0);
    assert.ok(when.getDay() >= 1 && when.getDay() <= 5);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('sandbox: agent ne smije pozvati alat koji je van njegovog sandboxa', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const strictRobot = await buildTestRobot({ script: () => ({ text: 'ok' }), overrides: { sandbox: createSandbox({ level: 'strict', networkAllowlist: ['api.deepseek.com'], fsReadRoots: ['.'], fsWriteRoots: ['.'] }) } });
    try {
      await assert.rejects(
        () => strictRobot.tools.execute('http_fetch', { url: 'https://api.deepseek.com' }, { tenantId: 'nmq', agentId: 'dev', sandbox: strictRobot.sandbox, approvedTools: new Set(['http_fetch']) }),
        (err) => err.code === 'POLICY_DENIED' && /strict/i.test(err.message),
      );
    } finally {
      await strictRobot.close();
      await cleanup(strictRobot.__dir);
    }
  } finally {
    await cleanup(robot.__dir);
  }
});

// ─────────────────────────── popravke iz revizije v0.2 ───────────────────────────

test('scheduler: agent iz procesa dobija jobId (process_update radi bez eksplicitnog id-a)', async () => {
  const robot = await buildTestRobot({
    scheduler: true,
    script: ({ messages }) => {
      if (messages.some((m) => m.role === 'tool')) return { text: 'Pomjereno na kasnije.' };
      return { toolCalls: [{ name: 'process_update', arguments: { state: 'waiting_client', note: 'cekam odgovor', nextRunInMs: 3_600_000 } }] };
    },
  });
  try {
    const job = await robot.scheduler.createJob('nmq', {
      name: 'proces koji sam sebe odgađa',
      type: 'process',
      agentId: 'ops',
      schedule: { type: 'interval', everyMs: 60_000 },
      process: { steps: [{ id: 's1', name: 'Korak', input: 'uradi i odgodi' }], done: [], state: 'pending' },
    });
    const res = await robot.scheduler.runNow('nmq', job.id);
    assert.equal(res.status, 'ok');
    const updated = await robot.scheduler.get('nmq', job.id);
    assert.equal(updated.process.state, 'waiting_client', 'agent je morao promijeniti stanje bez eksplicitnog jobId');
    assert.ok(
      updated.process.log.some((l) => /cekam odgovor/.test(l.note ?? '')),
      'bilješka agenta mora ostati u procesu',
    );
  } finally {
    await cleanup(robot.__dir);
  }
});

test('scheduler: waiting_approval ZAUSTAVLJA raspored (nema dvostrukog izvršavanja)', async () => {
  const robot = await buildTestRobot({
    scheduler: true,
    env: { NMQ_SCHEDULER_TICK_MS: '20' },
    script: ({ messages }) =>
      messages.some((m) => m.role === 'tool')
        ? { text: 'Mejl je poslat.' }
        : { toolCalls: [{ name: 'email_send', arguments: { to: 'k@example.com', subject: 'Ponuda', body: 'x' } }] },
  });
  try {
    const job = await robot.scheduler.createJob('nmq', {
      name: 'posao koji traži odobrenje',
      agentId: 'sales',
      input: 'Pošalji ponudu',
      schedule: { type: 'interval', everyMs: 10_000 },
      runNow: true,
    });
    const res = await robot.scheduler.runNow('nmq', job.id);
    assert.equal(res.status, 'awaiting_approval');
    const after = await robot.scheduler.get('nmq', job.id);
    assert.equal(after.status, 'waiting_approval');
    assert.equal(after.nextRunAt, null, 'raspored mora stati dok se ne odobri');
    assert.match(after.pausedReason, /email_send/);

    robot.scheduler.start();
    await wait(200); // tick ne smije ponovo pokrenuti posao
    const later = await robot.scheduler.get('nmq', job.id);
    assert.equal(later.runs, 1, `posao se izvršio ${later.runs}x — očekivano 1 (bez duplog izvršavanja)`);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('scheduler: uspjeh resetuje attempts, retry koristi eksponencijalni backoff', async () => {
  let fail = true;
  const robot = await buildTestRobot({
    scheduler: true,
    script: () => {
      if (fail) throw Object.assign(new Error('privremeno'), { retryable: true });
      return { text: 'ok' };
    },
  });
  try {
    const job = await robot.scheduler.createJob('nmq', { name: 'flaky', agentId: 'ops', input: 'x', schedule: { type: 'interval', everyMs: 60_000 }, retry: { max: 3, backoffMs: 100 } });
    await robot.scheduler.runNow('nmq', job.id);
    const after1 = await robot.scheduler.get('nmq', job.id);
    assert.equal(after1.attempts, 1);
    const firstDelay = after1.nextRunAt - Date.now();

    await robot.scheduler.runNow('nmq', job.id);
    const after2 = await robot.scheduler.get('nmq', job.id);
    assert.equal(after2.attempts, 2);
    const secondDelay = after2.nextRunAt - Date.now();
    assert.ok(secondDelay > firstDelay * 1.5, `backoff mora rasti (${firstDelay} → ${secondDelay})`);

    fail = false;
    await robot.scheduler.runNow('nmq', job.id);
    const after3 = await robot.scheduler.get('nmq', job.id);
    assert.equal(after3.status, 'ok');
    assert.equal(after3.attempts, 0, 'uspjeh mora resetovati brojač pokušaja');
  } finally {
    await cleanup(robot.__dir);
  }
});

test('scheduler: cron se validira pri kreiranju (nema tiho mrtvih poslova)', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }), scheduler: true });
  try {
    await assert.rejects(
      () => robot.scheduler.createJob('nmq', { name: 'loš cron', agentId: 'ops', input: 'x', schedule: { type: 'cron', cron: '0 8 * * JAN' } }),
      (err) => err instanceof ValidationError && /cron/i.test(err.message),
    );
    await assert.rejects(
      () => robot.scheduler.createJob('nmq', { name: 'prekratak cron', agentId: 'ops', input: 'x', schedule: { type: 'cron', cron: '0 8 *' } }),
      ValidationError,
    );
    await assert.rejects(
      () => robot.scheduler.createJob('nmq', { name: 'loš interval', agentId: 'ops', input: 'x', schedule: { type: 'interval', everyMs: 0 } }),
      ValidationError,
    );
    await assert.rejects(
      () => robot.scheduler.createJob('nmq', { name: 'nepoznat tip', agentId: 'ops', input: 'x', schedule: { type: 'svakidanas' } }),
      ValidationError,
    );
    const ok = await robot.scheduler.createJob('nmq', { name: 'dobar cron', agentId: 'ops', input: 'x', schedule: { type: 'cron', cron: '*/15 8-17 * * 1-5' } });
    assert.ok(ok.nextRunAt > Date.now());
  } finally {
    await cleanup(robot.__dir);
  }
});

test('scheduler: wildcard trigger "hook.*" pokriva sve hookove', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }), scheduler: true });
  try {
    await robot.scheduler.createJob('nmq', {
      name: 'svi hookovi',
      agentId: 'ops',
      input: 'reaguj',
      schedule: { type: 'once' },
      triggers: [{ type: 'event', event: 'hook.*' }],
    });
    const fired = await robot.scheduler.triggerEvent('hook.shopify', { orderId: '1' });
    assert.equal(fired, 1, 'wildcard hook.* mora uhvatiti hook.shopify');
    await wait(150); // izvršavanje posla je asinhrono
    const runs = await robot.scheduler.runs('nmq');
    assert.equal(runs.length, 1);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('GDPR: forgetUser briše epizode, vektore i samo tuđe činjenice korisnika', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const ep = await robot.memory.episodic.record('nmq', {
      userId: 'u1',
      agentId: 'support',
      problem: 'Korisnik u1 traži povraćaj, mejl petar@example.com',
      solution: 'Odobreno, kartica 4111111111111111 evidentirana',
      success: true,
      lessons: ['Provjeri rok 14 dana'],
    });
    await robot.memory.episodic.record('nmq', { userId: 'u2', agentId: 'support', problem: 'Drugi korisnik u2 pita za dostavu', solution: 'Odgovoreno', success: true });
    await robot.memory.longterm.upsertFact('nmq', 'klijent_u1', { name: 'Petar', email: 'petar@example.com' });
    await robot.memory.longterm.upsertFact('nmq', 'klijent_u2', { name: 'Ana' });
    await robot.memory.vectors.upsert('nmq', { id: 'doc_u1_1', text: 'dokument korisnika u1', metadata: { userId: 'u1', source: 'upload' } });

    // PII redakcija pri upisu u epizodu
    const raw = await fs.readFile(robot.memory.episodic.file('nmq'), 'utf8');
    assert.ok(!raw.includes('petar@example.com'), 'PII ne smije biti u epizodama');
    assert.ok(!raw.includes('4111111111111111'), 'broj kartice ne smije biti u epizodama');
    assert.match(raw, /EMAIL_REDACTED/);

    const result = await robot.memory.forgetUser('nmq', 'u1');
    assert.ok(result.removedEpisodes >= 1, 'epizoda korisnika mora biti obrisana');
    assert.deepEqual(result.removedFacts, ['klijent_u1']);
    assert.ok(result.removedVectors >= 1, 'vektorski zapis korisnika mora biti obrisan');

    const facts = await robot.memory.longterm.readFacts('nmq');
    assert.equal(facts.klijent_u1, undefined);
    assert.ok(facts.klijent_u2, 'činjenice drugog korisnika moraju ostati');

    const stats = await robot.memory.episodic.stats('nmq');
    assert.equal(stats.total, 1, 'ostaje samo epizoda drugog korisnika');

    const hits = await robot.memory.vectors.query('nmq', { text: 'dokument korisnika', k: 5, minScore: 0 });
    assert.ok(!hits.some((h) => h.id === 'doc_u1_1'), 'vektorski zapis korisnika je obrisan');
  } finally {
    await cleanup(robot.__dir);
  }
});

test('epizode: dodavanje pouke reindeksira zapis (pouka utiče na sličnost)', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    const ep = await robot.memory.episodic.record('nmq', { agentId: 'finance', problem: 'Faktura sa pogrešnim PDV-om', solution: 'Ispravljeno', success: false });
    const before = await robot.memory.episodic.similar('nmq', 'provjeri pdv prije slanja', { k: 3, minScore: 0.01 });
    await robot.memory.episodic.addLesson('nmq', ep.id, { lesson: 'Uvijek provjeri PDV stopu prije slanja fakture', success: true });
    const after = await robot.memory.episodic.similar('nmq', 'provjeri pdv prije slanja', { k: 3, minScore: 0.01 });
    assert.ok(after.length >= 1);
    assert.ok(
      after[0].score >= (before[0]?.score ?? 0),
      `sličnost mora porasti ili ostati ista poslije reindeksiranja (${before[0]?.score} → ${after[0].score})`,
    );
    assert.match(after[0].lessons.join(' '), /PDV stopu/);
  } finally {
    await cleanup(robot.__dir);
  }
});

test('webhook: skipDirectRun pokreće samo poslove (bez duplog izvršavanja)', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'posao reagovao' }), scheduler: true });
  // tenant hook mapping sa skipDirectRun
  robot.config.tenants.find((t) => t.id === 'nmq').hooks.shopify = { agentId: 'ecommerce', skipDirectRun: true };
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await robot.scheduler.createJob('nmq', { name: 'shopify jobs only', agentId: 'ecommerce', input: 'obradi', schedule: { type: 'once' }, triggers: [{ type: 'event', event: 'hook.shopify' }] });
    const res = await fetch(`${base}/v1/hooks/shopify`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant': 'nmq' }, body: JSON.stringify({ subject: 'Narudžbina 1042' }) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.triggeredOnly, true);
    assert.equal(body.runId, undefined, 'nema sinhronog run-a');
    await wait(200);
    const runs = await robot.scheduler.runs('nmq');
    assert.equal(runs.length, 1, 'posao se pokrenuo tačno jednom');
  } finally {
    await robot.close();
    await cleanup(robot.__dir);
  }
});

test('control plane: nepoznat agent i tenant daju 404', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    await assert.rejects(() => robot.controlPlane.list('nepostoji'), NotFoundError);
    await assert.rejects(() => robot.controlPlane.rollback('nmq', 'nema-agenta', 1), NotFoundError);
    await assert.rejects(() => robot.controlPlane.revokeAgentKey('nmq', 'support', 'nema'), NotFoundError);
  } finally {
    await cleanup(robot.__dir);
  }
});
