#!/usr/bin/env node
/**
 * CHAOS TEST — dokaz da kvar čvora ne gubi i ne duplira posao (Sprint 2, zadatak 1).
 *
 *   node scripts/chaos.mjs                      # 3 node-a, 24 taska, ubija najzauzetiji
 *   node scripts/chaos.mjs --tasks=48 --delay=400 --kill=busiest
 *   node scripts/chaos.mjs --json=chaos-result.json
 *
 * Šta mjeri (i zašto baš to):
 *   • detectedMs    — koliko treba da živi čvorovi proglase mrtvog (suspect/dead)
 *   • reclaimedMs   — koliko treba da task koji je mrtvi čvor držao završi NEKO DRUGI
 *   • lost          — taskovi koji nikad nisu završeni (cilj: 0)
 *   • duplicated    — taskovi izvršeni DVA puta (cilj: 0) — dokaz iz zajedničkog JSONL loga
 *   • throughput    — taskova/s prije i poslije ubijanja
 *
 * Iskreno o domenu mjerenja: ovo je **loopback**. Ubijanje procesa (SIGKILL) je stvarno, ali mrežna
 * particija (odvojena mreža) se ovako NE simulira — za to treba firewall/network namespace na dva
 * hosta (F6/F11 iz transparentnog izvještaja). Zato rezultat piše `scope: "loopback, process kill"`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const TASKS = Number(arg('tasks', 24));
const DELAY = Number(arg('delay', 400));
const BASE_PORT = Number(arg('base-port', 8301));
const KILL_MODE = arg('kill', 'busiest');
const SECRET = arg('secret', 'chaos-secret-1234567890');
const JSON_OUT = arg('json', null);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const runId = `chaos-${Date.now()}`;
const logFile = path.join(os.tmpdir(), `${runId}.jsonl`);
fs.writeFileSync(logFile, '');
const ports = [BASE_PORT, BASE_PORT + 1, BASE_PORT + 2];

const header = (t) => console.log(`\n${t}`);
const line = (t) => console.log(`  ${t}`);

// ── start 3 node-a kao procese ───────────────────────────────────────────────
header(`CHAOS TEST (${runId})`);
line(`3 node-a na ${ports.join(', ')} · ${TASKS} taskova · runner ${DELAY} ms · kill=${KILL_MODE}`);
const children = [];
for (let i = 0; i < 3; i += 1) {
  const port = ports[i];
  const peers = i === 0 ? [] : ports.slice(0, i).map((p) => `127.0.0.1:${p}`).join(',');
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/chaos-node.mjs'), `--port=${port}`, `--peers=${peers}`, `--delay=${DELAY}`, `--log=${logFile}`, `--secret=${SECRET}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    const text = d.toString().trim();
    if (text && flag('verbose')) console.log(`  [node-${port}] ${text}`);
  });
  children.push({ port, child, pid: child.pid, killedAt: null });
}

const api = (port, p, init) =>
  fetch(`http://127.0.0.1:${port}${p}`, { ...init, signal: AbortSignal.timeout(4000) }).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status} na ${p}`))));

const cleanup = () => {
  for (const c of children) {
    try {
      if (c.child.exitCode === null) c.child.kill('SIGKILL');
    } catch {
      /* već mrtav */
    }
  }
};
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

// ── čekaj sync (svi vide 2 peera) ───────────────────────────────────────────
let synced = false;
for (let i = 0; i < 80 && !synced; i += 1) {
  await wait(125);
  try {
    const stats = await Promise.all(ports.map((p) => api(p, '/status')));
    synced = stats.every((s) => s.peersAlive >= 2);
  } catch {
    /* još se dižu */
  }
}
if (!synced) {
  console.error('  ✖ node-ovi se nisu sinhronizovali — prekidam');
  cleanup();
  process.exit(2);
}
line('✔ roj sinhronizovan (svaki vidi 2 peera)');

// ── optereti sistem ─────────────────────────────────────────────────────────
const submitAt = Date.now();
const submitted = [];
for (let i = 0; i < TASKS; i += 1) {
  const res = await api(ports[i % 3], '/task', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'chaos.load', payload: { text: `chaos task ${i}` }, value: 1 + (i % 5), ttl: 120_000 }),
  });
  submitted.push(res.task.id);
}
line(`→ poslano ${submitted.length} taskova na sva tri node-a`);

const readLog = () => {
  try {
    return fs
      .readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

// ── sačekaj da posao krene, pa ubij čvor ────────────────────────────────────
let victim = null;
for (let i = 0; i < 60 && !victim; i += 1) {
  await wait(100);
  const done = readLog().length;
  if (done >= Math.max(2, Math.floor(TASKS * 0.15))) {
    const stats = await Promise.all(children.map((c) => api(c.port, '/status').catch(() => null)));
    const withLoad = children.filter((c, idx) => stats[idx] && stats[idx].load > 0);
    victim = KILL_MODE === 'busiest' && withLoad.length ? withLoad.sort((a, b) => 0)[0] : children[children.length - 1];
  }
}
if (!victim) victim = children[children.length - 1];

const doneBeforeKill = readLog().length;
const killAt = Date.now();
victim.child.kill('SIGKILL');
victim.killedAt = killAt;
line(`✖ SIGKILL node-${victim.port} (PID ${victim.pid}) — do tada završeno ${doneBeforeKill}/${TASKS}`);

// ── koliko brzo roj primijeti smrt ─────────────────────────────────────────
const survivors = children.filter((c) => c !== victim);
let detectedMs = null;
for (let i = 0; i < 120 && detectedMs === null; i += 1) {
  await wait(50);
  for (const s of survivors) {
    try {
      const status = await api(s.port, '/status');
      const dead = (status.membership ?? []).find((m) => m.port === victim.port);
      if (dead && dead.status !== 'alive') {
        detectedMs = Date.now() - killAt;
        break;
      }
    } catch {
      /* nedostupno na trenutak */
    }
  }
}
line(`  detekcija smrti: ${detectedMs === null ? 'NIJE DETEKTOVANO (>6s)' : `${detectedMs} ms`}`);

// ── da li su svi taskovi završeni i da li je neko izvršen dvaput ────────────
const deadline = Date.now() + Math.max(30_000, TASKS * DELAY * 2);
let log = readLog();
while (Date.now() < deadline && new Set(log.map((e) => e.taskId)).size < TASKS) {
  await wait(250);
  log = readLog();
}
const cleanedAt = Date.now();
const perTask = new Map();
for (const e of log.filter((x) => x.phase !== 'start')) perTask.set(e.taskId, [...(perTask.get(e.taskId) ?? []), e]);
const lost = submitted.filter((id) => !perTask.has(id));
const duplicated = submitted.filter((id) => (perTask.get(id) ?? []).length > 1);

/**
 * Prava mjera „duplog izvršenja": da li su se dva izvršenja ISTOG taska PREKLAPALA u vremenu.
 * Sekvencijalno (drugi počinje poslije prvog) = ponovni rad zbog izgubljene potvrde — očekivano kod
 * „at-least-once" isporuke. Preklapanje = dva čvora su radila isti posao u isto vrijeme → greška.
 */
const intervals = new Map();
for (const e of log) {
  const key = `${e.taskId}|${e.nodeId}|${e.attempt ?? 1}`;
  const prev = intervals.get(key) ?? {};
  intervals.set(key, e.phase === 'start' ? { ...prev, start: e.at, taskId: e.taskId } : { ...prev, end: e.at, taskId: e.taskId, nodeId: e.nodeId, attempt: e.attempt ?? 1 });
}
const sameAttemptDupes = [];
const retried = [];
const overlapping = [];
for (const [id, entries] of perTask) {
  const attempts = entries.map((e) => e.attempt ?? 1);
  const seen = new Set();
  let dupe = false;
  for (const a of attempts) {
    if (seen.has(a)) dupe = true;
    seen.add(a);
  }
  if (dupe) sameAttemptDupes.push(id);
  if (attempts.length > 1) retried.push(id);
  const spans = [...intervals.values()].filter((s) => s.taskId === id && s.start && s.end);
  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length; j += 1) {
      if (spans[i].start < spans[j].end && spans[j].start < spans[i].end) overlapping.push(id);
    }
  }
}
const overlappingIds = [...new Set(overlapping)];
const completed = submitted.filter((id) => perTask.has(id));
const victimWork = log.filter((e) => e.nodeId === `node-${victim.port}`).length;

// reclaimedMs: vrijeme od ubijanja do PRVOG taska koji je završio neki drugi node
const firstOther = log.filter((e) => e.nodeId !== `node-${victim.port}` && e.at > killAt).sort((a, b) => a.at - b.at)[0];
const reclaimedMs = firstOther ? firstOther.at - killAt : null;

const result = {
  scope: 'loopback, process kill (SIGKILL) — mrežna particija NIJE simulirana',
  runId,
  nodes: ports.map((p) => `node-${p}`),
  tasks: TASKS,
  runnerDelayMs: DELAY,
  victim: `node-${victim.port}`,
  completedBeforeKill: doneBeforeKill,
  victimCompletedBeforeKill: victimWork,
  detectedMs,
  reclaimedMs,
  completed: completed.length,
  lost: lost.length,
  duplicated: duplicated.length,
  duplicatedSameAttempt: sameAttemptDupes.length,
  overlapping: overlappingIds.length,
  retried: retried.length,
  totalExecutions: log.length,
  madeSpanMs: cleanedAt - submitAt,
  throughputPerSec: Number((log.length / ((cleanedAt - submitAt) / 1000)).toFixed(2)),
  logFile,
};

// ── ispis ───────────────────────────────────────────────────────────────────
header('REZULTAT');
line(`završeno:            ${result.completed}/${TASKS}`);
line(`izgubljeno:          ${result.lost}   ${result.lost === 0 ? '✔' : '✖'}`);
line(`duplo izvršeno:      ${result.overlapping} preklopljenih ${result.overlapping === 0 ? '✔' : '✖'}  (retry: ${result.retried}, isti pokušaj 2x: ${result.duplicatedSameAttempt})`);
line(`detekcija smrti:     ${detectedMs === null ? 'n/a' : `${detectedMs} ms`}`);
line(`re-claim (drugi):    ${reclaimedMs === null ? 'n/a' : `${reclaimedMs} ms`}`);
line(`ukupno izvršenja:    ${result.totalExecutions} (taskova ${TASKS})`);
line(`propusnost:          ${result.throughputPerSec} taskova/s`);
line(`žrtva je uradila:    ${victimWork} prije nego što je ubijena`);
if (lost.length) line(`izgubljeni ID-jevi:  ${lost.slice(0, 5).join(', ')}${lost.length > 5 ? ' …' : ''}`);
if (duplicated.length) line(`duplirani ID-jevi:   ${duplicated.slice(0, 5).join(', ')}${duplicated.length > 5 ? ' …' : ''}`);
line(`dokaz (JSONL):       ${logFile}`);
line(`domen mjerenja:      ${result.scope}`);

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
  line(`zapisano:            ${JSON_OUT}`);
}

cleanup();
await wait(200);
if (flag('keep-log')) console.log(`  (JSONL zadržan za analizu: ${logFile})`);
else fs.rmSync(logFile, { force: true });
process.exit(result.lost === 0 && result.overlapping === 0 ? 0 : 1);
