#!/usr/bin/env node
/**
 * Smoke test protiv ŽIVOG servera (ili sam digne server ako nema URL-a).
 *
 *   node scripts/smoke.mjs                                  # digne svoj server (mock LLM) i provjeri
 *   NMQ_SMOKE_URL=https://robot.domena.com node scripts/smoke.mjs   # provjeri živi server
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRobot } from '../src/index.js';
import { createMockProvider } from '../src/llm/mock.js';
import { createScriptedLlm } from './mock-script.mjs';
import { loadEnvFile } from './env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile({ root: ROOT });

const live = process.env.NMQ_SMOKE_URL;
const results = [];
let robot = null;
let base = live;

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, error: err.message });
    console.log(`  ✖ ${name} — ${err.message}`);
  }
}

const api = (url, init = {}) =>
  fetch(`${base}${url}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(process.env.NMQ_SMOKE_KEY ? { authorization: `Bearer ${process.env.NMQ_SMOKE_KEY}` } : {}), ...(init.headers ?? {}) },
  });

async function ensureServer() {
  if (live) {
    console.log(`\n  Provjeravam živi server: ${live}\n`);
    return;
  }
  const dataDir = path.join(ROOT, 'data', '_smoke');
  await fs.rm(dataDir, { recursive: true, force: true });
  robot = await createRobot({
    root: ROOT,
    dataDir,
    connectMcp: true,
    env: { ...process.env, NMQ_LLM_PROVIDER: process.env.NMQ_LLM_API_KEY ? process.env.NMQ_LLM_PROVIDER ?? 'openai-compatible' : 'mock', NMQ_LOG_LEVEL: 'warn' },
    overrides: process.env.NMQ_LLM_API_KEY ? {} : { llm: createMockProvider({ script: createScriptedLlm(), model: 'deepseek-chat' }), logLevel: 'warn' },
  });
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${addr.port}`;
  console.log(`\n  Server dignut lokalno: ${base}\n`);
}

async function main() {
  await ensureServer();

  await check('GET /healthz', async () => {
    const r = await api('/healthz');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j.ok) throw new Error('healthz.ok nije true');
    return `v${j.version}`;
  });

  await check('GET /readyz', async () => {
    const j = await (await api('/readyz')).json();
    return `agenata: ${j.agents}, alata: ${j.tools}, LLM: ${j.llm?.join('/')}`;
  });

  await check('GET /v1/agents', async () => {
    const j = await (await api('/v1/agents')).json();
    if (!j.count) throw new Error('nema agenata');
    return `${j.count} agenata`;
  });

  await check('GET /v1/tools', async () => {
    const j = await (await api('/v1/tools')).json();
    const high = j.tools.filter((t) => t.riskLevel === 'high').length;
    return `${j.count} alata (${high} visokog rizika)`;
  });

  await check('GET /metrics', async () => {
    const text = await (await api('/metrics')).text();
    if (!text.includes('nmq_')) throw new Error('nema nmq metrika');
    return `${text.split('\n').length} linija`;
  });

  await check('POST /v1/agents/support/run', async () => {
    const r = await api('/v1/agents/support/run', { method: 'POST', body: JSON.stringify({ input: 'Kako da resetujem lozinku?', tenantId: 'nmq' }) });
    const j = await r.json();
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${j?.error?.message}`);
    if (!j.runId) throw new Error('nema runId');
    return `agent=${j.agentId} pattern=${j.pattern} cost=${j.costUsd}`;
  });

  await check('POST /v1/router/run', async () => {
    const r = await api('/v1/router/run', { method: 'POST', body: JSON.stringify({ input: 'Ne radi mi prijava na nalog', tenantId: 'nmq' }) });
    const j = await r.json();
    if (!j.routing?.agentId) throw new Error('nema routing.agentId');
    return `${j.routing.agentId} (${j.routing.method})`;
  });

  await check('POST /v1/run/stream (SSE)', async () => {
    const r = await api('/v1/run/stream', { method: 'POST', body: JSON.stringify({ input: 'Status narudžbine 1042', agentId: 'ecommerce', tenantId: 'nmq' }) });
    if (!r.headers.get('content-type')?.includes('event-stream')) throw new Error('nije SSE');
    const text = await r.text();
    if (!text.includes('event: done')) throw new Error('nema "done" događaja');
    return `${[...text.matchAll(/^event: (\w+)/gm)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).join(',')}`;
  });

  await check('POST /v1/kb + /v1/kb/search', async () => {
    await api('/v1/kb', { method: 'POST', body: JSON.stringify({ text: 'Radno vrijeme podrške je 09-17 radnim danima.', source: 'SMOKE' }) });
    const j = await (await api('/v1/kb/search', { method: 'POST', body: JSON.stringify({ query: 'radno vrijeme', k: 3 }) })).json();
    if (!j.hits?.length) throw new Error('nema pogodaka u bazi znanja');
    return `${j.hits.length} pogodaka`;
  });

  await check('GET /v1/usage', async () => {
    const j = await (await api('/v1/usage')).json();
    if (typeof j.summary?.usd !== 'number') throw new Error('nema summary.usd');
    return `${j.summary.usd} USD, ${j.summary.calls} poziva`;
  });

  await check('GET /v1/audit (hash lanac)', async () => {
    const j = await (await api('/v1/audit')).json();
    if (!j.verify?.ok) throw new Error(`lanac polomljen: ${j.verify?.reason ?? 'nepoznato'}`);
    return `${j.verify.checked} zapisa, lanac ispravan`;
  });

  await check('GET /widget.js', async () => {
    const r = await api('/widget.js');
    const text = await r.text();
    if (!text.includes('NMQRobot')) throw new Error('widget nije ispravan');
    return `${(text.length / 1024).toFixed(0)} KB`;
  });

  await check('404 za nepoznatu rutu', async () => {
    const r = await api('/nema-ovoga');
    if (r.status !== 404) throw new Error(`očekivano 404, dobijeno ${r.status}`);
    return '404';
  });

  // ── MAX nivo: kontrolna ravan, persistentni poslovi, epizode ──
  await check('GET /v1/whoami', async () => {
    const j = await (await api('/v1/whoami')).json();
    if (!j.tenantId) throw new Error('nema tenantId');
    return `${j.tenantId} / ${j.role}`;
  });

  await check('GET /v1/admin/health', async () => {
    const j = await (await api('/v1/admin/health')).json();
    if (!j.controlPlane || !j.sandbox) throw new Error('kontrolna ravan ili sandbox nisu dostupni');
    return `agenata: ${j.agents}, poslova: ${j.jobs}, sandbox: ${j.sandbox.level}, OTel: ${j.otel?.enabled}`;
  });

  await check('POST /v1/admin/agents/support/deploy + rollback', async () => {
    const dep = await (await api('/v1/admin/agents/support/deploy', { method: 'POST', body: JSON.stringify({ patch: { temperature: 0.42 }, note: 'smoke' }) })).json();
    if (dep.version !== 1) throw new Error(`deploy nije vratio verziju 1: ${JSON.stringify(dep)}`);
    const rb = await (await api('/v1/admin/agents/support/rollback', { method: 'POST', body: JSON.stringify({ version: 0 }) })).json();
    if (rb.activeVersion !== 0) throw new Error('rollback nije vratio na baseline');
    return `deploy v1 → rollback v0`;
  });

  await check('POST /v1/admin/agents/executor/keys', async () => {
    const j = await (await api('/v1/admin/agents/executor/keys', { method: 'POST', body: JSON.stringify({ scopes: ['crm:write'] }) })).json();
    if (!/^nmqa_/.test(j.key ?? '')) throw new Error('ključ nije u formatu nmqa_…');
    await api(`/v1/admin/agents/executor/keys/${j.keyId}`, { method: 'DELETE' });
    return `izdat i opozvan (${j.keyId})`;
  });

  await check('POST /v1/admin/jobs + run', async () => {
    const created = await (await api('/v1/admin/jobs', { method: 'POST', body: JSON.stringify({ name: 'smoke posao', agentId: 'ops', input: 'radi', schedule: { type: 'interval', everyMs: 3600000 }, runNow: true }) })).json();
    if (!created.id) throw new Error('posao nije kreiran');
    const run = await (await api(`/v1/admin/jobs/${created.id}/run`, { method: 'POST' })).json();
    if (!['ok', 'awaiting_approval'].includes(run.status)) throw new Error(`posao nije izvršen: ${JSON.stringify(run).slice(0, 200)}`);
    const runs = await (await api(`/v1/admin/jobs/${created.id}/runs`)).json();
    await api(`/v1/admin/jobs/${created.id}`, { method: 'DELETE' });
    return `status=${run.status}, zapisa=${runs.runs.length}`;
  });

  await check('POST /v1/admin/processes (dugoročni proces)', async () => {
    const j = await (await api('/v1/admin/processes', { method: 'POST', body: JSON.stringify({ name: 'smoke onboarding', agentId: 'ops', stepDelayMs: 1000, steps: [{ id: 'd1', input: 'a' }, { id: 'd2', input: 'b' }] }) })).json();
    if (j.steps !== 2) throw new Error('proces nije kreiran sa 2 koraka');
    const run1 = await (await api(`/v1/admin/jobs/${j.jobId}/run`, { method: 'POST' })).json();
    const job = await (await api(`/v1/admin/jobs/${j.jobId}`)).json();
    await api(`/v1/admin/jobs/${j.jobId}`, { method: 'DELETE' });
    return `koraka=${j.steps}, poslije 1. pokretanja završeno=${job.process?.done?.length ?? 0} (${run1.status})`;
  });

  await check('GET/POST /v1/admin/episodes', async () => {
    await api('/v1/admin/episodes', { method: 'POST', body: JSON.stringify({ problem: 'smoke problem', solution: 'smoke rješenje', success: true, lessons: ['provjeri prvo'] }) });
    const j = await (await api('/v1/admin/episodes')).json();
    if (!j.stats?.total) throw new Error('epizoda nije zapamćena');
    return `epizoda: ${j.stats.total} (${j.stats.success} uspješnih)`;
  });

  await check('GET /metrics (MAX metrike)', async () => {
    const text = await (await api('/metrics')).text();
    const wanted = ['nmq_runs_started_total', 'nmq_cost_usd_total', 'nmq_jobs_runs_total', 'nmq_controlplane_deploys_total', 'nmq_approvals_pending'];
    const missing = wanted.filter((m) => !text.includes(m));
    if (missing.length) throw new Error(`nedostaju metrike: ${missing.join(', ')}`);
    return `${wanted.length} ključnih metrika prisutno`;
  });

  // ── v0.3: autonomni nivo ──
  await check('GET /v1/admin/autonomy', async () => {
    const j = await (await api('/v1/admin/autonomy')).json();
    if (!j.forTenant?.level) throw new Error('nema nivoa autonomije');
    return `tenant=${j.forTenant.level} (${j.forTenant.name}), default=${j.default}`;
  });

  await check('POST /v1/admin/goals + decompose + progress', async () => {
    const created = await (await api('/v1/admin/goals', { method: 'POST', body: JSON.stringify({ title: 'SMOKE cilj', metric: 'rev', baseline: 100, target: 200, deadline: new Date(Date.now() + 30 * 86400000).toISOString(), owner: 'cro' }) })).json();
    if (!created.id) throw new Error('cilj nije kreiran');
    const dec = await (await api(`/v1/admin/goals/${created.id}/decompose`, { method: 'POST' })).json();
    const prog = await (await api(`/v1/admin/goals/${created.id}/progress`, { method: 'POST', body: JSON.stringify({ value: 150 }) })).json();
    return `podciljeva=${dec.goal?.subgoals?.length ?? 0}, napredak=${prog.progressPct}% (${prog.status})`;
  });

  await check('POST /v1/admin/watchers/metrics + tick', async () => {
    await api('/v1/admin/watchers/metrics', { method: 'POST', body: JSON.stringify({ metric: 'support_tickets_open', value: 99 }) });
    const tick = await (await api('/v1/admin/watchers/tick', { method: 'POST' })).json();
    return `pokrenuto watchera: ${tick.fired?.length ?? 0}`;
  });

  await check('GET /v1/admin/proposals (inbox) + decide', async () => {
    const created = await (await api('/v1/admin/proposals', { method: 'POST', body: JSON.stringify({ kind: 'action', target: 'support', proposed: { input: 'SMOKE akcija' }, rationale: 'smoke test', riskLevel: 'low' }) })).json();
    const decided = await (await api(`/v1/admin/proposals/${created.id}/decide`, { method: 'POST', body: JSON.stringify({ approve: true, by: 'smoke' }) })).json();
    if (decided.status !== 'approved') throw new Error(`odluka nije primijenjena: ${decided.status}`);
    const applied = await (await api(`/v1/admin/proposals/${created.id}/apply`, { method: 'POST' })).json();
    return `prijedlog ${created.kind} → ${applied.proposal.status}`;
  });

  await check('POST /v1/admin/selfplay (1 runda)', async () => {
    const j = await (await api('/v1/admin/selfplay', { method: 'POST', body: JSON.stringify({ rounds: 1, solverAgent: 'support' }) })).json();
    if (j.error) throw new Error(j.error.message);
    return `prolaznost=${j.passRate}, težina=${j.finalDifficulty}`;
  });

  await check('POST /v1/admin/rsi/cycle', async () => {
    const j = await (await api('/v1/admin/rsi/cycle', { method: 'POST', body: JSON.stringify({ sinceDays: 1 }) })).json();
    return `nalaza=${j.findings?.length ?? 0}, prijedloga=${j.proposals?.length ?? 0}`;
  });

  await check('GET /v1/admin/org + cycle', async () => {
    const chart = await (await api('/v1/admin/org')).json();
    if (!chart.roles?.length) throw new Error('org chart je prazan');
    const cycle = await (await api('/v1/admin/org/cycle', { method: 'POST', body: JSON.stringify({ period: 'month' }) })).json();
    if (cycle.error) throw new Error(cycle.error.message);
    return `uloga=${chart.roles.length}, prioriteta=${cycle.plan?.priorities?.length ?? 0}, pregovor=${cycle.negotiation?.status ?? '-'}`;
  });

  await check('GET /.well-known/agent.json (A2A card)', async () => {
    const j = await (await api('/.well-known/agent.json')).json();
    if (!j.skills?.length) throw new Error('karta nema skillova');
    return `skillova=${j.skills.length}, streaming=${j.capabilities.streaming}`;
  });

  await check('POST /a2a/tasks + GET status', async () => {
    const task = await (await api('/a2a/tasks', { method: 'POST', body: JSON.stringify({ message: 'SMOKE A2A zadatak', skillId: 'support', wait: true }) })).json();
    const fetched = await (await api(`/a2a/tasks/${task.id}`)).json();
    if (!['completed', 'input_required', 'failed'].includes(fetched.state)) throw new Error(`neočekivano stanje: ${fetched.state}`);
    return `stanje=${fetched.state}, agent=${fetched.agentId}`;
  });

  await check('A2A pregovor + poravnanje', async () => {
    const neg = await (await api('/a2a/negotiations', { method: 'POST', body: JSON.stringify({ counterparty: 'smoke-partner', topic: 'smoke nabavka', offer: { amountUsd: 120 } }) })).json();
    const resp = await (await api(`/a2a/negotiations/${neg.id}/respond`, { method: 'POST', body: JSON.stringify({ offer: { amountUsd: 120 }, accept: true }) })).json();
    if (resp.state !== 'agreed') return `stanje=${resp.state} (bez poravnanja)`;
    const closed = await (await api(`/a2a/negotiations/${neg.id}/close`, { method: 'POST' })).json();
    return `dogovoreno=${closed.settlement.amountUsd} USD, status=${closed.settlement.status} (interni ledger)`;
  });


  // ── v0.4: swarm, governance, safety, evolucija, RSI ──
  await check('GET /v1/admin/swarm (roj + safety)', async () => {
    const j = await (await api('/v1/admin/swarm')).json();
    return `workera=${j.workers}, izolacija=${j.isolation}, otvorenih=${j.board.open}`;
  });

  await check('POST /v1/admin/swarm/workers + tasks + run', async () => {
    const workers = await (await api('/v1/admin/swarm/workers', { method: 'POST', body: JSON.stringify({ agents: [{ agentId: 'support', skills: ['support', 'general'] }, { agentId: 'sales', skills: ['sales', 'general'] }] }) })).json();
    if (workers.error) throw new Error(workers.error.message);
    const tasks = await (await api('/v1/admin/swarm/tasks', { method: 'POST', body: JSON.stringify({ tasks: [{ title: 'SMOKE ticket', payload: { input: 'Kako da resetujem lozinku?', tag: 'support' }, requiredSkills: ['support'], value: 3 }, { title: 'SMOKE lead', payload: { input: 'Kvalifikuj lead', tag: 'sales' }, requiredSkills: ['sales'], value: 2 }] }) })).json();
    if (tasks.error) throw new Error(tasks.error.message);
    const run = await (await api('/v1/admin/swarm/run', { method: 'POST', body: JSON.stringify({ rounds: 1 }) })).json();
    if (run.error) throw new Error(run.error.message);
    return `workera=${workers.total}, zadataka=${tasks.created.length}, runova=${run.ran}, gotovo=${run.stats.completed}`;
  });

  await check('GET /v1/admin/swarm/specialization + pheromones', async () => {
    const spec = await (await api('/v1/admin/swarm/specialization')).json();
    const ph = await (await api('/v1/admin/swarm/pheromones')).json();
    return `specijalizacija=${Object.keys(spec.specialization).join(',') || '-'}, feromona=${ph.pheromones.length}`;
  });

  await check('Swarm governance: locked blokira, freeze pa unfreeze', async () => {
    await api('/v1/admin/swarm/governance/isolation', { method: 'POST', body: JSON.stringify({ level: 'locked', reason: 'smoke' }) });
    const tick = await (await api('/v1/admin/swarm/tick', { method: 'POST' })).json();
    if (tick.ran !== 0) throw new Error('roj je izvršavao u "locked" izolaciji!');
    const frozen = await (await api('/v1/admin/swarm/freeze', { method: 'POST', body: JSON.stringify({ reason: 'smoke kill switch' }) })).json();
    const unfrozen = await (await api('/v1/admin/swarm/unfreeze', { method: 'POST', body: JSON.stringify({ level: 'contained' }) })).json();
    return `locked→tick(${tick.skipped})→${frozen.level}→${unfrozen.level}`;
  });

  await check('Swarm safety: skriveni kanal se odbija + incident', async () => {
    const res = await api('/v1/admin/swarm/message', { method: 'POST', body: JSON.stringify({ from: 'smoke-w1', to: 'smoke-w2', type: 'status', payload: { blob: 'aB3xK9mQ2zP7wL4nR8tY6uI1oJ5hG0fD2sA9qW3eZ7xC4vB6nM8kL1pO5iU2yT4rE6wQ9' } }) });
    const body = await res.json();
    if (res.status !== 403) throw new Error(`sumnjiva poruka je prošla (status ${res.status})`);
    const incidents = await (await api('/v1/admin/swarm/incidents')).json();
    const report = await (await api('/v1/admin/swarm/safety')).json();
    return `status=${res.status} (${body.error?.code}), incidenata=${incidents.incidents.length}, nalaza=${report.findings}`;
  });

  await check('POST /v1/admin/evolution/evolve + promote', async () => {
    const evo = await (await api('/v1/admin/evolution/evolve', { method: 'POST', body: JSON.stringify({ agentId: 'support', populationSize: 4, generations: 1, maxCases: 2 }) })).json();
    if (evo.error) throw new Error(evo.error.message);
    const promote = await (await api('/v1/admin/evolution/promote', { method: 'POST', body: JSON.stringify({ agentId: 'support' }) })).json();
    if (promote.error) throw new Error(promote.error.message);
    return `best=${evo.best.genome.hash} fitness=${evo.best.fitness}, prijedlog=${promote.proposal.id} (auto=${promote.autoPromote})`;
  });

  await check('GET /v1/admin/rsi + eksperiment kroz kapiju', async () => {
    const status = await (await api('/v1/admin/rsi')).json();
    await api('/v1/admin/autonomy', { method: 'POST', body: JSON.stringify({ agentId: null, level: 'L3' }) });
    const lvl = await (await api('/v1/admin/rsi/level', { method: 'POST', body: JSON.stringify({ level: 'R2', reason: 'smoke' }) })).json();
    const exp = await (await api('/v1/admin/rsi/experiment', { method: 'POST', body: JSON.stringify({ agentId: 'support', strategy: 'temperature', maxCases: 2, run: true }) })).json();
    if (exp.error) throw new Error(exp.error.message);
    const research = await (await api('/v1/admin/rsi/research')).json();
    return `nivo=${status.level}→${lvl.level}, lift=${exp.experiment.lift} (${exp.experiment.verdict}), zapisa=${research.log.length}`;
  });
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`  ── SMOKE REZULTAT: ${results.length - failed.length}/${results.length} prošlo ──`);
  if (failed.length) {
    console.log(`  Pali: ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}`);
  }
  console.log('');

  if (robot) await robot.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('SMOKE GREŠKA:', err?.message);
  if (robot) await robot.close().catch(() => {});
  process.exit(1);
});
