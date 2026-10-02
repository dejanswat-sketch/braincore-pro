#!/usr/bin/env node
/**
 * FAZA 4 — 60-min self-tune run.
 *
 * Roj je već podignut (HTTP API). Ovaj runner:
 *   1. spawn-uje self-tune robota (workers/self-tune.mjs, petlja 30 s)
 *   2. generiše RATE t/s load-a (bench.tick → pun claim/execute/GC ciklus)
 *   3. svakih SAMPLE_MS uzorkuje /v1/tuning (heap, gcAgeMs, crdt, reclaimStorm)
 *   4. na kraju izvještava: heap min/vrh (mora <100 MB), gcAgeMs trajektoriju,
 *      crdt ravno poslije GC, p95 latencije, i koliko puta je robot SAM pomjerio knobe.
 *
 *   node scripts/soak-self-tune.mjs --minutes=60 --rate=5 --api=http://127.0.0.1:8099
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const eq = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const API = String(arg('api', 'http://127.0.0.1:8099')).replace(/\/$/, '');
const RATE = Number(arg('rate', 5));
const MINUTES = Number(arg('minutes', 60));
const SAMPLE_MS = Number(arg('sample', 60_000));
const OUT = arg('out', path.join(ROOT, 'docs', `soak-self-tune-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (u, o = {}) => {
  const r = await fetch(u, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers ?? {}) } });
  const t = await r.text();
  let b; try { b = t ? JSON.parse(t) : null; } catch { b = t; }
  return { status: r.status, ok: r.ok, body: b };
};

// 1) robot
const robot = spawn(process.execPath, [path.join(ROOT, 'workers/self-tune.mjs')], {
  cwd: ROOT, env: { ...process.env, BRAINCORE_API: API, TUNE_INTERVAL_MS: '30000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let adjustments = 0, stableCount = 0;
robot.stdout.on('data', (buf) => {
  for (const line of String(buf).split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try { const m = JSON.parse(line); if (m.msg === 'adjust') adjustments += 1; else if (m.msg === 'stable') stableCount += 1; } catch { }
  }
});
robot.stderr.on('data', () => { });

// 2) proveri tuning endpoint
const first = await j(`${API}/v1/tuning`);
if (!first.ok) { console.error('Nema /v1/tuning na', API); process.exit(2); }

// 3) load + uzorkovanje
const samples = [];
let sent = 0;
const t0 = Date.now();
const end = t0 + MINUTES * 60 * 1000;
const submit = async () => {
  sent += 1;
  try { await j(`${API}/task`, { method: 'POST', body: JSON.stringify({ type: 'bench.tick', payload: { n: sent } }) }); } catch { }
};
const sample = async (min) => {
  const t = await j(`${API}/v1/tuning`);
  if (t.ok) samples.push({ min, ...t.body.tuning });
};
console.log(JSON.stringify({ msg: 'soak_self_tune_start', minutes: MINUTES, rate: RATE, api: API, robotPid: robot.pid }));
await sample(0);
let lastSample = t0;
while (Date.now() < end) {
  const el = (Date.now() - t0) / 1000;
  for (let i = 0; i < RATE; i++) submit(); // RATE taskova/s
  await sleep(1000);
  if (Date.now() - lastSample >= SAMPLE_MS) {
    lastSample = Date.now();
    const min = +(el / 60).toFixed(1);
    await sample(min);
    const last = samples.at(-1);
    console.log(JSON.stringify({ msg: 'progress', min, heapUsedMb: last?.heapUsedMb, gcAgeMs: last?.gcAgeMs, crdt: last?.crdtEntries, tasks: last?.tasks, reclaimStorm: last?.reclaimStormCount }));
  }
}
await sleep(3000);
await sample(+((Date.now() - t0) / 60000).toFixed(1));
robot.kill();

const heaps = samples.map((s) => s.heapUsedMb);
const report = {
  ts: new Date().toISOString(),
  minutes: MINUTES, rate: RATE,
  submitted: sent,
  samples: samples.length,
  heapMinMb: Math.min(...heaps), heapPeakMb: Math.max(...heaps),
  heapUnder100: Math.max(...heaps) < 100,
  gcAgeMsStart: samples[0]?.gcAgeMs, gcAgeMsEnd: samples.at(-1)?.gcAgeMs,
  gcAgeMsHistory: samples.map((s) => ({ min: s.min, gcAgeMs: s.gcAgeMs, heap: s.heapUsedMb, crdt: s.crdtEntries, reclaimStorm: s.reclaimStormCount })),
  crdtStart: samples[0]?.crdtEntries, crdtEnd: samples.at(-1)?.crdtEntries,
  robotAdjustments: adjustments, robotStable: stableCount,
  criteria: {
    heapUnder100: Math.max(...heaps) < 100,
    robotRan: adjustments + stableCount > 0,
    crdtBounded: (samples.at(-1)?.crdtEntries ?? 0) < 20000,
  },
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ msg: 'soak_self_tune_done', out: OUT, ...report }, null, 2));
process.exit(0);
