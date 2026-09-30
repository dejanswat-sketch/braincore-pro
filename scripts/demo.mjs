#!/usr/bin/env node
/**
 * Demo: pokazuje sve što NMQ Robot radi — bez interneta i bez troška (mock LLM).
 *
 *   node scripts/demo.mjs
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRobot } from '../src/index.js';
import { createMockProvider } from '../src/llm/mock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', '_demo');

const line = (t = '') => console.log(t);
const head = (n, t) => {
  line('');
  line('─'.repeat(78));
  line(`${n}. ${t}`);
  line('─'.repeat(78));
};

/** Skriptovani LLM koji se ponaša razumno na svim patternima. */
function scriptedLlm() {
  return ({ messages }) => {
    const system = String(messages.find((m) => m.role === 'system')?.content ?? '');
    const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
    const user = String([...messages].reverse().find((m) => m.role === 'user')?.content ?? '');

    if (system.includes('planer')) {
      return {
        text: JSON.stringify({
          goal: 'Pripremiti ponudu za Prima d.o.o.',
          subtasks: [
            { agent: 'sales', goal: 'Kvalifikuj lead i predloži paket' },
            { agent: 'finance', goal: 'Provjeri cijenu i uslove plaćanja' },
          ],
        }),
      };
    }
    if (system.includes('analitičar')) return { text: 'SINTEZA: pravni rizik je nizak, komercijalni uslovi prihvatljivi, rokovi izvodljivi. Preporuka: potpisati uz izmjenu člana 7 (penali).' };
    if (system.includes('Ti si orchestrator')) return { text: 'PONUDA (sinteza): Prima d.o.o. — Pro paket, 149 EUR/mjesečno, uvođenje 2 nedjelje.' };
    if (system.includes('iterativno')) return { text: 'PLAN: 1) pregledaj log deploy-a 2) uporedi sa poslednjim dobrim buildom 3) predloži popravku' };
    if (lastTool) return { text: `Na osnovu alata: ${String(lastTool.content).slice(0, 180)}` };

    if (/lozink|prijava|reset/i.test(user)) {
      return { toolCalls: [{ name: 'memory_search', arguments: { query: 'reset lozinke', k: 3 } }] };
    }
    if (/ponudu|ponuda/i.test(user)) {
      return { toolCalls: [{ name: 'lead_score', arguments: { budget: 9, urgency: 8, companySize: 8, authority: 9, needClarity: 7 } }] };
    }
    return { text: `Odgovor agenta: ${user.slice(0, 140)}` };
  };
}

async function main() {
  await fs.rm(DATA, { recursive: true, force: true });

  const llm = createMockProvider({ script: scriptedLlm(), model: 'deepseek-chat' });
  const robot = await createRobot({
    root: ROOT,
    dataDir: DATA,
    connectMcp: true,
    env: { ...process.env, NMQ_LOG_LEVEL: 'warn' },
    overrides: { llm, logLevel: 'warn' },
  });

  line('');
  line('╔════════════════════════════════════════════════════════════════════════════╗');
  line('║  NMQ ROBOT — DEMO (mock LLM: bez mreže, bez troška)                        ║');
  line('╚════════════════════════════════════════════════════════════════════════════╝');
  line(`  Verzija: ${robot.version} · Node ${process.version}`);
  line(`  Agenti: ${robot.catalog.size()} · Alati: ${robot.tools.size()} · MCP serveri: ${robot.mcp.list().length}`);
  line(`  MCP alati: ${robot.mcp.list().flatMap((s) => s.tools).join(', ')}`);
  line(`  Tenanti: ${robot.config.tenants.map((t) => t.id).join(', ')}`);

  // ── 1. Router ───────────────────────────────────────────────────────────────
  head(1, 'ROUTER — prepoznaje namjeru i bira agenta (bez LLM-a kad može)');
  const routed = await robot.orchestrator.run({
    tenantId: 'nmq',
    pattern: 'router',
    input: 'Ne radi mi prijava na nalog, ne mogu da se ulogujem',
  });
  line(`  → agent: ${routed.agentId} · pattern: ${routed.pattern} · metoda: ${routed.routing.method} · pouzdanost: ${routed.routing.confidence}`);
  line(`  kandidati: ${routed.routing.candidates.map((c) => `${c.agentId}(${c.score})`).join(', ')}`);

  // ── 2. Agent + alati ────────────────────────────────────────────────────────
  head(2, 'AGENT — koristi alat, pa odgovara (support agent)');
  const support = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'support', pattern: 'agent', input: 'Kako da resetujem lozinku?' });
  line(`  odgovor: ${support.output.slice(0, 200)}`);
  line(`  koraci: ${support.result.results[0].steps.map((s) => (s.type === 'tool' ? `alat:${s.name}` : `llm:${s.tokensIn}in/${s.tokensOut}out`)).join(' → ')}`);

  // ── 3. Sequential ───────────────────────────────────────────────────────────
  head(3, 'SEQUENTIAL — analiza → plan → checklista → izvještaj (ops agent)');
  const seq = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'ops', pattern: 'sequential', input: 'Novi projekat: uvođenje CRM-a za klijenta Prima d.o.o., rok 6 nedjelja' });
  line(`  koraka: ${seq.result.results.length} · tipovi: ${seq.result.results.map((r) => r.kind).join(', ')}`);
  line(`  izlaz (prvih 200): ${String(seq.output).replace(/\n/g, ' ').slice(0, 200)}`);

  // ── 4. Orchestrator-worker ──────────────────────────────────────────────────
  head(4, 'ORCHESTRATOR-WORKER — planer razbija zadatak, workeri izvršavaju, sinteza spaja');
  const orch = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'sales', pattern: 'orchestrator-worker', input: 'Pripremi ponudu za Prima d.o.o.' });
  line(`  plan (${orch.result.plan.source}): ${orch.result.plan.subtasks.map((s) => `${s.agent}: ${s.goal}`).join(' | ')}`);
  line(`  workera uspješno: ${orch.result.workersOk}/${orch.result.plan.subtasks.length}`);
  line(`  sinteza: ${orch.output.slice(0, 200)}`);

  // ── 5. Fanout ───────────────────────────────────────────────────────────────
  head(5, 'FAN-OUT / FAN-IN — isti ugovor pod tri ugla, pa spoj');
  const fan = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'legal', pattern: 'fanout', input: 'Pregledaj ugovor o održavanju sa Prima d.o.o.' });
  line(`  uglovi: ${fan.result.workers.map((w) => `${w.agent}${w.angle ? ` (${w.angle})` : ''}`).join(', ')}`);
  line(`  merge: ${fan.result.merge} · sinteza: ${fan.output.slice(0, 180)}`);

  // ── 6. Handoff ──────────────────────────────────────────────────────────────
  head(6, 'PEER-TO-PEER HANDOFF — support predaje finansijama');
  const handoffRobot = robot;
  handoffRobot.llm.providers[0].reset();
  // kratka skripta samo za ovaj prikaz
  const handoffLlm = createMockProvider({
    model: 'deepseek-chat',
    script: ({ messages, callIndex }) => {
      if (messages.some((m) => m.role === 'tool')) return { text: 'Preuzeo sam zahtjev i pokrećem refundaciju.' };
      if (callIndex === 0) return { toolCalls: [{ name: 'handoff', arguments: { toAgent: 'finance', reason: 'Povraćaj novca je finansijska odluka', summary: 'Klijent traži refundaciju za prošli mjesec.' } }] };
      return { text: 'Refundacija je moguća uz odobrenje.' };
    },
  });
  const tmpRobot = await createRobot({ root: ROOT, dataDir: path.join(DATA, '_handoff'), connectMcp: false, env: { ...process.env, NMQ_LOG_LEVEL: 'warn' }, overrides: { llm: handoffLlm, logLevel: 'warn' } });
  const hnd = await tmpRobot.orchestrator.run({ tenantId: 'nmq', agentId: 'support', pattern: 'handoff', input: 'Tražim povraćaj novca za prošli mjesec' });
  line(`  lanac: ${hnd.result.visited.join(' → ')}`);
  line(`  razlog predaje: ${hnd.result.handoffChain[0]?.reason ?? '-'}`);
  line(`  riješio: ${hnd.result.resolvedBy} · odgovor: ${hnd.output.slice(0, 160)}`);
  await tmpRobot.close();

  // ── 7. Magentic ─────────────────────────────────────────────────────────────
  head(7, 'MAGENTIC — plan → akcija → refleksija → korekcija (dev agent)');
  const mag = await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'dev', pattern: 'magentic', input: 'Zašto pada deploy na produkciji?' });
  line(`  iteracije: ${mag.result.iterations.map((i) => `#${i.iteration} score=${i.score} ${i.verdict}`).join(' · ')}`);
  line(`  prihvaćeno: ${mag.result.accepted} · izlaz: ${mag.output.slice(0, 160)}`);

  // ── 8. Governance ───────────────────────────────────────────────────────────
  head(8, 'GOVERNANCE — politika, budžet, human-in-the-loop');
  const denied = await robot.orchestrator.run({ tenantId: 'demo-shop', agentId: 'support', pattern: 'agent', input: 'Napravi fakturu' });
  line(`  demo-shop + zabranjen alat → status: ${denied.status} (agent objasni umjesto pada)`);

  const approvalLlm = createMockProvider({
    model: 'deepseek-chat',
    script: ({ messages }) =>
      messages.some((m) => m.role === 'tool')
        ? { text: 'Mejl je poslat.' }
        : { toolCalls: [{ name: 'email_send', arguments: { to: 'klijent@example.com', subject: 'Ponuda', body: 'U prilogu je ponuda.' } }] },
  });
  const apprRobot = await createRobot({ root: ROOT, dataDir: path.join(DATA, '_approval'), connectMcp: false, env: { ...process.env, NMQ_LOG_LEVEL: 'warn' }, overrides: { llm: approvalLlm, logLevel: 'warn' } });
  const pending = await apprRobot.orchestrator.run({ tenantId: 'nmq', agentId: 'sales', pattern: 'agent', input: 'Pošalji ponudu klijentu' });
  line(`  email_send (high rizik) → status: ${pending.status} · čeka odobrenje za: ${pending.approvals.map((a) => a.tool).join(', ')}`);
  const outboxBefore = await fs.readFile(path.join(DATA, '_approval', 'tenants', 'nmq', 'outbox', 'emails.jsonl'), 'utf8').catch(() => '');
  line(`  mejl poslan bez odobrenja? ${outboxBefore.trim() ? 'DA (greška!)' : 'NE — ispravno'}`);
  const approved = await apprRobot.orchestrator.run({ tenantId: 'nmq', agentId: 'sales', pattern: 'agent', input: 'Pošalji ponudu klijentu', approvedTools: ['email_send'] });
  const outboxAfter = await fs.readFile(path.join(DATA, '_approval', 'tenants', 'nmq', 'outbox', 'emails.jsonl'), 'utf8').catch(() => '');
  line(`  nakon odobrenja → status: ${approved.status} · mejl u outboxu: ${outboxAfter.trim() ? 'DA' : 'NE'}`);
  await apprRobot.close();

  // ── 9. Memorija + RAG izolacija ─────────────────────────────────────────────
  head(9, 'MEMORIJA — tri sloja + izolacija tenanta (RAG)');
  await robot.memory.vectors.ingest('nmq', {
    text: 'Politika povraćaja NMQ: kupac ima 14 dana od dostave uz račun. Refundacija ide na isti način plaćanja u roku 5 radnih dana.',
    source: 'Politika povraćaja 2026',
    docId: 'kb-refund',
    metadata: { tags: ['politika', 'refund'] },
  });
  await robot.memory.longterm.upsertFact('nmq', 'glavni_klijent', 'Prima d.o.o. (Pro paket)');
  const ctx = await robot.memory.recall('nmq', 'koliko dana imam za povraćaj');
  line(`  RAG pogodaka: ${ctx.citations.length} · izvor: ${ctx.citations[0]?.source ?? '-'} · score: ${ctx.citations[0]?.score ?? '-'}`);
  line(`  činjenice: ${ctx.factsText.replace(/\n/g, ' ')}`);
  const leak = await robot.memory.vectors.query('demo-shop', { text: 'politika povraćaja NMQ', k: 5 });
  line(`  demo-shop vidi NMQ dokument? ${leak.length ? 'DA (greška!)' : 'NE — izolacija radi'}`);
  line(`  sesije: ${robot.memory.sessions.count()} · embedder: ${robot.memory.embedder.name} (semantički: ${robot.memory.isSemantic})`);

  // ── 10. Trošak, trace, audit ────────────────────────────────────────────────
  head(10, 'OBSERVABILITY — trošak po tenantu, trace, hash-chained audit');
  for (const t of robot.config.tenants) {
    const sum = await robot.cost.summary(t.id);
    line(`  ${t.id.padEnd(10)} potrošnja: ${sum.usd.toFixed(6)} USD · poziva: ${sum.calls} · tokena: ${sum.tokensIn + sum.tokensOut} · po agentu: ${JSON.stringify(sum.byAgent)}`);
  }
  const trace = robot.tracer.get(mag.runId);
  line(`  trace ${mag.runId}: ${trace.spans.length} spanova · trajanje ${mag.durationMs}ms · status ${trace.status}`);
  for (const t of robot.config.tenants) {
    const v = await robot.audit.verify(t.id);
    line(`  audit ${t.id.padEnd(10)} lanac: ${v.ok ? 'ispravan' : 'POLOMLJEN'} · zapisa: ${v.checked}`);
  }
  line(`  metrike (prvih 5 linija):`);
  line(
    robot.metrics
      .render()
      .split('\n')
      .slice(0, 5)
      .map((l) => `    ${l}`)
      .join('\n'),
  );

  // ── 11. Gateway ─────────────────────────────────────────────────────────────
  head(11, 'GATEWAY — isti robot preko HTTP-a i SSE-a');
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  const health = await (await fetch(`${base}/healthz`)).json();
  const ready = await (await fetch(`${base}/readyz`)).json();
  line(`  server: ${base} · healthz.ok=${health.ok} · agenata=${ready.agents} · alata=${ready.tools}`);
  const sse = await fetch(`${base}/v1/run/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'Kako da resetujem lozinku?', agentId: 'support', tenantId: 'nmq' }),
  });
  const sseText = await sse.text();
  const events = [...sseText.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
  line(`  SSE događaji: ${[...new Set(events)].join(', ')}`);
  line(`  widget: ${base}/widget.js · demo stranica: ${base}/`);
  line(`  primjer ugradnje: <script src="${base}/widget.js" data-tenant="nmq" data-agent="support" data-auto="1" defer></script>`);

  // ── 12. Persistentni agenti ─────────────────────────────────────────────────
  head(12, 'PERSISTENTNI AGENTI — posao koji radi sam, bez korisnika');
  const reportJob = await robot.scheduler.createJob('nmq', {
    name: 'dnevni izvještaj',
    agentId: 'data',
    pattern: 'agent',
    input: 'Napravi dnevni izvještaj o prodaji',
    schedule: { type: 'cron', cron: '0 8 * * 1-5' },
    runNow: true,
  });
  line(`  posao: ${reportJob.id} · raspored: ${robot.scheduler.describeSchedule(reportJob.schedule)} · prvi termin: ${new Date(reportJob.nextRunAt).toISOString()}`);
  const jobRun = await robot.scheduler.runNow('nmq', reportJob.id);
  const jobAfter = await robot.scheduler.get('nmq', reportJob.id);
  line(`  izvršeno: status=${jobRun.status} · ukupno pokretanja=${jobAfter.runs} · trošak=${jobAfter.totalCostUsd} USD · sljedeći=${new Date(jobAfter.nextRunAt).toISOString()}`);

  const hookJob = await robot.scheduler.createJob('nmq', {
    name: 'reakcija na Shopify',
    agentId: 'ecommerce',
    input: 'Obradi novu narudžbinu',
    schedule: { type: 'once' },
    triggers: [{ type: 'event', event: 'hook.shopify' }],
  });
  const fired = await robot.scheduler.triggerEvent('hook.shopify', { orderId: '1042' });
  line(`  event trigger (hook.shopify): pokrenuto poslova=${fired}`);
  await new Promise((r) => setTimeout(r, 120));
  const hookRuns = (await robot.scheduler.runs('nmq')).filter((r) => r.jobId === hookJob.id);
  line(`  posao "${hookJob.name}" → izvršavanja: ${hookRuns.length} (reason=${hookRuns[0]?.reason})`);

  // ── 13. Dugoročni proces ────────────────────────────────────────────────────
  head(13, 'DUGOROČNI PROCES — onboarding kroz dane (pamti stanje, preživljava restart)');
  const procJob = await robot.scheduler.createJob('nmq', {
    name: 'onboarding Prima d.o.o.',
    type: 'process',
    agentId: 'ops',
    schedule: { type: 'interval', everyMs: 86_400_000 },
    process: {
      steps: [
        { id: 'd1', name: 'Kickoff', agentId: 'ops', input: 'Uradi kickoff sastanak' },
        { id: 'd3', name: 'Pristupi', agentId: 'ops', input: 'Dodijeli pristupe' },
        { id: 'd7', name: 'Obuka', agentId: 'ops', input: 'Zakazi obuku' },
      ],
      done: [],
      state: 'pending',
    },
  });
  await robot.scheduler.runNow('nmq', procJob.id);
  let proc = await robot.scheduler.get('nmq', procJob.id);
  line(`  poslije 1. pokretanja: završeni koraci=[${proc.process.done.join(',')}] · stanje=${proc.process.state}`);
  await robot.scheduler.runNow('nmq', procJob.id);
  await robot.scheduler.runNow('nmq', procJob.id);
  proc = await robot.scheduler.get('nmq', procJob.id);
  line(`  poslije 3. pokretanja: završeni koraci=[${proc.process.done.join(',')}] · status=${proc.status}`);
  line(`  stanje je u fajlu: data/_demo/tenants/nmq/jobs/jobs.json (preživljava restart)`);

  // ── 14. Kontrolna ravan ─────────────────────────────────────────────────────
  head(14, 'KONTROLNA RAVAN — deploy/rollback, per-agent identitet i budžet');
  const before = robot.catalog.get('support').temperature;
  const dep = await robot.controlPlane.deploy('nmq', 'support', { patch: { temperature: 0.45, maxSteps: 6 }, note: 'demo: topliji ton' });
  line(`  deploy v${dep.version}: temperature ${before} → ${robot.catalog.get('support').temperature}, maxSteps → ${robot.catalog.get('support').maxSteps}`);
  await robot.controlPlane.rollback('nmq', 'support', 0);
  line(`  rollback na baseline: temperature = ${robot.catalog.get('support').temperature} (bez restarta)`);
  const agentKey = await robot.controlPlane.issueAgentKey('nmq', 'executor', { scopes: ['crm:write'] });
  const who = robot.controlPlane.authenticateAgentKey(agentKey.key);
  line(`  per-agent ključ: ${agentKey.key.slice(0, 14)}… → tenant=${who.tenantId}, agent=${who.agentId}, scopes=${JSON.stringify(who.scopes)}`);
  const cpList = await robot.controlPlane.list('nmq');
  const execRow = cpList.find((a) => a.id === 'executor');
  line(`  budžet po agentu: executor = ${execRow.budgetUsdMonth} USD/mjesec · potrošeno ${execRow.spendUsd.toFixed(4)} USD`);
  await robot.controlPlane.setStatus('nmq', 'creative', 'paused', { reason: 'demo' });
  try {
    await robot.orchestrator.run({ tenantId: 'nmq', agentId: 'creative', pattern: 'agent', input: 'x' });
    line('  pauziran agent je prošao — GREŠKA!');
  } catch (err) {
    line(`  pauziran agent → blokiran: ${err.code} (${err.message})`);
  }
  await robot.controlPlane.setStatus('nmq', 'creative', 'active');

  // ── 15. Specijalistički tim i debata ────────────────────────────────────────
  head(15, 'SPECIJALISTIČKI TIM + DEBATA — planing → research → validation → decision → execution');
  const teamRes = await robot.orchestrator.run({ tenantId: 'nmq', pattern: 'team', input: 'Pripremi ponudu za Prima d.o.o.' });
  line(`  tim: ${teamRes.result.stages.map((s) => `${s.role}(${s.agent})`).join(' → ')}`);
  line(`  svi koraci uspjeli: ${teamRes.result.stages.every((s) => s.ok)} · trošak: ${teamRes.costUsd} USD`);
  line(`  zaključak tima: ${String(teamRes.output).replace(/\n/g, ' ').slice(0, 180)}`);

  const debateRes = await robot.orchestrator.run({
    tenantId: 'nmq',
    pattern: 'debate',
    input: 'Da li uvesti novu funkciju odmah ili čekati?',
    options: { patternConfig: { rounds: 1, debaters: [{ agent: 'finance', stance: 'za' }, { agent: 'legal', stance: 'protiv' }] } },
  });
  line(`  debata: ${debateRes.result.debaters.map((d) => `${d.agent}(${d.stance})`).join(' vs ')} · rundi: ${debateRes.result.rounds} · sudija: ${debateRes.result.judge}`);
  line(`  presuda: ${String(debateRes.output).replace(/\n/g, ' ').slice(0, 180)}`);

  // ── 16. Epizodična memorija, sandbox, OTel ──────────────────────────────────
  head(16, 'EPIZODIČNA MEMORIJA · SANDBOX · OTEL — učenje, granice, telemetrija');
  await robot.memory.episodic.record('nmq', {
    agentId: 'support',
    problem: 'Kupac traži povraćaj jer narudžbina kasni 10 dana',
    solution: 'Provjerio politiku (14 dana), odobrio povraćaj, poslao potvrdu na mejl',
    success: true,
    lessons: ['Uvijek provjeri rok od 14 dana prije odobrenja'],
    tools: ['memory_search', 'email_send'],
  });
  const epStats = await robot.memory.episodic.stats('nmq');
  const epSimilar = await robot.memory.episodic.similar('nmq', 'kupac hoće povraćaj novca jer je kasnilo', { k: 2 });
  line(`  epizode: ukupno=${epStats.total} uspješnih=${epStats.success} · pronađeno sličnih=${epSimilar.length} (score ${epSimilar[0]?.score})`);
  line(`  epizode idu u prompt kao "kako smo slične slučajeve rješavali ranije" (few-shot)`);

  line(`  sandbox nivo: ${robot.sandbox.level} · mreža: ${robot.sandbox.describe().network} · max timeout: ${robot.sandbox.describe().maxTimeoutMs}ms`);
  try {
    robot.sandbox.assertNetwork('https://zli.example.com/steal');
    line('  sandbox propustio zabranjeni domen — GREŠKA!');
  } catch (err) {
    line(`  sandbox blokirao zabranjeni domen: ${err.code}`);
  }

  const otelRun = await robot.tracer.readFromDisk({ tenantId: 'nmq', limit: 1 });
  line(`  OTel: izvezeno runova=${robot.otel.exported} · fajl=${robot.otel.traceFile ? 'data/_demo/_global/otel-traces.jsonl' : '-'}`);
  const otelFile = await fs.readFile(robot.otel.traceFile, 'utf8').catch(() => '');
  const firstLine = otelFile.split('\n').filter(Boolean)[0];
  if (firstLine) {
    const parsed = JSON.parse(firstLine);
    line(`  OTLP span: resurs=${parsed.resourceSpans?.[0]?.resource?.attributes?.[0]?.value?.stringValue} · spanova u runu=${parsed.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.length} · poslednji trace=${otelRun[0]?.runId ?? '-'}`);
  }

  line('');
  line('╔════════════════════════════════════════════════════════════════════════════╗');
  line('║  DEMO ZAVRŠEN — sve radi bez interneta i bez troška (mock LLM)              ║');
  line('║  Za pravi rad: postavi NMQ_LLM_API_KEY (DeepSeek) i pokreni serve.mjs       ║');
  line('╚════════════════════════════════════════════════════════════════════════════╝');
  line('');

  await robot.close();
}

main().catch((err) => {
  console.error('DEMO GREŠKA:', err?.message);
  if (process.env.NMQ_DEBUG === '1') console.error(err.stack);
  process.exit(1);
});
