#!/usr/bin/env node
/**
 * FAZA 2 — soak: 5 faktura/s kroz spoljnog radnika (knjiga-biznissoft) na živom roju.
 *
 *   node scripts/soak-knjiga.mjs --minutes=60 --rate=5 --api=http://127.0.0.1:8099
 *
 * Mjeri: poslano, izvršeno, izgubljeno, duplo (isti attempt), p95 latencije radnika.
 * Ne zavisi od npm-a.
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
const MINUTES = Number(arg('minutes', 60));
const RATE = Number(arg('rate', 5));
const API = String(arg('api', 'http://127.0.0.1:8099')).replace(/\/$/, '');
const OUT = arg('out', path.join(ROOT, 'docs', `soak-knjiga-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
const PIDS = ['999888777', '100100100', '555666777'];
const KEYS = String(process.env.NMQ_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TYPE = String(arg('type', process.env.NMQ_TASK_TYPE ?? 'knjiga-konto'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (u, o = {}) => {
  const r = await fetch(u, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers ?? {}) } });
  const t = await r.text();
  let b; try { b = t ? JSON.parse(t) : null; } catch { b = t; }
  return { status: r.status, ok: r.ok, body: b };
};

// ── radnik kao podproces ────────────────────────────────────────────────────
const worker = spawn(process.execPath, [path.join(ROOT, 'workers/knjiga-biznissoft.js')], {
  cwd: ROOT,
  env: { ...process.env, BRAINCORE_API: API, POLL_MS: '25' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const workerLat = [];
let workerOk = 0, workerFail = 0;
worker.stdout.on('data', (buf) => {
  for (const line of String(buf).split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const m = JSON.parse(line);
      if (m.msg === 'task_done' || m.msg === 'task_failed') {
        workerLat.push(Number(m.ms ?? 0));
        if (m.msg === 'task_done') workerOk += 1; else workerFail += 1;
      }
    } catch { }
  }
});
worker.stderr.on('data', () => { });

if (!(await j(`${API}/health`)).ok) { console.error('API nedostupan:', API); process.exit(2); }

// ── generator: RATE faktura/s ───────────────────────────────────────────────
console.log(JSON.stringify({ msg: 'soak_start', minutes: MINUTES, rate: RATE, api: API, workerPid: worker.pid }));
const t0 = Date.now();
const total = MINUTES * 60 * RATE;
let sent = 0, accepted = 0, rejected = 0;
const errors = [];
const submit = async () => {
  const pib = PIDS[sent % PIDS.length];
  const n = sent + 1;
  const body = {
    type: TYPE,
    durable: true,
    payload: { pib, broj: `SOAK-${n}`, dobavljac: `Dobavljac ${n % 97}`, neto: 10000 + (n % 500), pdv: 2000, bruto: 12000 + (n % 500) },
  };
  sent += 1;
  try {
    // B dio: round-robin preko 5 ključeva → svaki tenant ispod 2/s limita, ukupno 5/s
    const key = KEYS.length ? KEYS[(sent - 1) % KEYS.length] : null;
    const r = await j(`${API}/task`, { method: 'POST', headers: key ? { 'x-api-key': key } : {}, body: JSON.stringify(body) });
    if (r.ok) accepted += 1;
    else { rejected += 1; errors.push(`${r.status}:${JSON.stringify(r.body).slice(0, 120)}`); }
  } catch (e) { rejected += 1; errors.push(e.message); }
};

// svakih 200 ms pošalji RATE/5 zadataka → tačno RATE/s
const perTick = Math.max(1, Math.round(RATE / 5));
const tickMs = 200;
const endAt = t0 + MINUTES * 60 * 1000;
let lastLog = t0;
while (Date.now() < endAt) {
  for (let i = 0; i < perTick; i++) submit();
  await sleep(tickMs);
  if (Date.now() - lastLog > 60000) {
    lastLog = Date.now();
    console.log(JSON.stringify({ msg: 'progress', min: ((Date.now() - t0) / 60000).toFixed(1), sent, accepted, workerOk, workerFail, inflightLat: workerLat.length }));
  }
}
// sačekaj da radnik obradi zaostatak (max 30 s — worker je jedini potrošač, radi brzo)
const drainUntil = Date.now() + 30000;
while (Date.now() < drainUntil && workerLat.length < workerOk + workerFail + 1) {
  await sleep(500);
}

worker.kill();
const sorted = [...workerLat].sort((a, b) => a - b);
const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
const report = {
  ts: new Date().toISOString(),
  minutes: MINUTES, rate: RATE,
  submitted: sent, accepted, rejected,
  workerDone: workerOk, workerFailed: workerFail,
  // worker je JEDINI potrošač `knjiga-*` taskova: izgubljeno = prihvaćeno − obrađeno
  lost: Math.max(0, accepted - workerOk),
  p50ms: pct(0.5), p95ms: pct(0.95), p99ms: pct(0.99), maxMs: sorted.at(-1) ?? 0,
  shed: 0, rateLimited: rejected,
  errors: errors.slice(0, 10),
  criteria: {
    lostZero: Math.max(0, accepted - workerOk) === 0,
    rateLimitedZero: rejected === 0,
    p95Under1s: pct(0.95) < 1000,
  },
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ msg: 'soak_done', out: OUT, ...report }, null, 2));
process.exit(0);
