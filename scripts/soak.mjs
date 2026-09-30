#!/usr/bin/env node
/**
 * SOAK TEST — dugotrajno opterećenje: da li roj ostaje stabilan satima (Sprint 2, `docs/40`).
 *
 *   node scripts/soak.mjs --minutes=2                    # kratka provjera (CI)
 *   node scripts/soak.mjs --minutes=60 --rate=20         # prijemni test (1 h, 20 taskova/s)
 *   node scripts/soak.mjs --minutes=60 --restart-every=300   # + restart čvora svakih 5 min
 *
 * Šta mjeri (i zašto):
 *   • propusnost (taskova/s)                — da li sistem drži korak pod trajnim opterećenjem
 *   • latencija p50/p95/p99                 — rep je važniji od prosjeka (korisnik osjeti p99)
 *   • izgubljeno / duplo izvršeno           — 0 i 0 su kriteriji (isti kao chaos)
 *   • memorija (heapUsed start/kraj/vrh)    — da li postoji curenje (sat vremena je dovoljno da se vidi)
 *   • rast CRDT-a i broj feromona           — da li se tabla i tragovi čiste (decay radi)
 *   • oporavak poslije restarta čvora       — koliko taskova je izgubljeno/duplirano pri restartu
 *
 * Iskreno o domenu: sve je na JEDNOJ mašini (loopback, procesi u istom procesu). Mrežna particija i
 * pravi multi-host se mjere posebno (chaos F6/F11). Rezultat se upisuje u `docs/soak-<ts>.json`
 * i u `data/_control/soak-history.json` da se vidi trend kroz vrijeme.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSwarmNode } from '../src/node.js';
import { createLogger } from '../src/core/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const MINUTES = Number(arg('minutes', 2));
const RATE = Number(arg('rate', 20)); // taskova u sekundi (cilj)
const DELAY = Number(arg('delay', 120)); // koliko task „radi" (ms)
const NODES = Number(arg('nodes', 3));
const RESTART_EVERY = Number(arg('restart-every', 0)); // sekunde; 0 = ne restartuj
const BASE_PORT = Number(arg('base-port', 8701));
const MEM_EVERY = Number(arg('memory-every', 15)); // sekunde
const P95_BUDGET = Number(arg('p95-budget', 1500)); // ms; iznad = prekoračenje budžeta
const SECRET = arg('secret', 'soak-secret-1234567890');
const logger = createLogger({ level: arg('log', 'warn') });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}`;
const ports = Array.from({ length: NODES }, (_, i) => BASE_PORT + i);

const header = (t) => console.log(`\n${t}`);
const line = (t) => console.log(`  ${t}`);

// ── stanje mjerenja ─────────────────────────────────────────────────────────
const submitted = new Map(); // taskId -> submitTs
const latencies = [];
const executions = new Map(); // taskId -> broj izvršenja
const memory = [];
let restarts = 0;
const restartStats = [];

const runner = async (task) => {
  await wait(DELAY);
  executions.set(task.id, (executions.get(task.id) ?? 0) + 1);
  return { output: `soak ${task.id}` };
};

const mkNode = (id, port, peers) =>
  createSwarmNode({
    nodeId: id,
    port,
    host: '127.0.0.1',
    advertiseHost: '127.0.0.1',
    peers,
    secret: SECRET,
    logger,
    runner,
    config: { httpAdmin: false, autoLoop: true, claimIntervalMs: 40, syncIntervalMs: 250, gossip: { intervalMs: 300, failureTimeoutMs: 1200 } },
  });

header(`SOAK TEST ${runId}`);
line(`${NODES} node-a na ${ports.join(', ')} · ${MINUTES} min · cilj ${RATE} taskova/s · runner ${DELAY} ms`);
line(RESTART_EVERY ? `restart čvora svakih ${RESTART_EVERY} s` : 'bez restarta čvora (samo kontinuirano opterećenje)');

const nodes = [];
for (let i = 0; i < NODES; i += 1) {
  nodes.push(await mkNode(`soak-${ports[i]}`, ports[i], i === 0 ? [] : ports.slice(0, i).map((p) => `127.0.0.1:${p}`)));
}
const t0 = Date.now();
await nodes[0].start();
for (let i = 1; i < NODES; i += 1) await nodes[i].start();
for (let i = 1; i < NODES; i += 1) await nodes[i].gossip.join([`127.0.0.1:${ports[0]}`]);
await Promise.all(nodes.map((n) => n.waitForPeers({ expected: NODES - 1, timeoutMs: 3000 })));
line(`roj sinhronizovan za ${Date.now() - t0} ms (svaki vidi ${NODES - 1} peera)`);

for (const n of nodes) {
  n.on('done', (r) => {
    const ts = submitted.get(r.taskId);
    if (ts) latencies.push(Date.now() - ts);
  });
}

// ── generator opterećenja ───────────────────────────────────────────────────
let seq = 0;
let stop = false;
let lastRestart = Date.now();
const intervalMs = Math.max(1, Math.round(1000 / RATE));
const loadTimer = setInterval(async () => {
  if (stop) return;
  const node = nodes[seq % nodes.length];
  const id = `soak-task-${++seq}`;
  submitted.set(id, Date.now());
  try {
    await node.submitTask({ id, type: 'soak.load', payload: { text: `soak ${seq}` }, ttl: 120_000, value: 1 + (seq % 4), durable: false });
  } catch {
    /* task se broji kao izgubljen ako se nikad ne izvrši */
  }
}, intervalMs);

// ── uzorkovanje memorije ────────────────────────────────────────────────────
const memTimer = setInterval(() => {
  const m = process.memoryUsage();
  memory.push({ at: Date.now(), heapUsedMb: Number((m.heapUsed / 1024 / 1024).toFixed(1)), rssMb: Number((m.rss / 1024 / 1024).toFixed(1)) });
}, MEM_EVERY * 1000);

// ── opcioni restart čvora pod opterećenjem ──────────────────────────────────
const restartTimer = RESTART_EVERY
  ? setInterval(async () => {
      const idx = NODES - 1; // uvijek zadnji node
      const before = executions.size;
      const port = ports[idx];
      const killed = nodes[idx];
      const peers = ports.slice(0, idx).map((p) => `127.0.0.1:${p}`);
      try {
        await killed.close(); // „čvor je pao" (bez graceful LEAVE)
        await wait(500);
        const fresh = await mkNode(`soak-${port}`, port, peers);
        await fresh.start();
        await fresh.gossip.join([`127.0.0.1:${ports[0]}`]);
        await fresh.waitForPeers({ expected: NODES - 1, timeoutMs: 3000 });
        fresh.on('done', (r) => {
          const ts = submitted.get(r.taskId);
          if (ts) latencies.push(Date.now() - ts);
        });
        nodes[idx] = fresh;
        restarts += 1;
        restartStats.push({ at: Date.now(), port, recoveredMs: 500, executionsBefore: before });
        line(`↻ node ${port} restartovan i vratio se u roj (#${restarts})`);
      } catch (err) {
        line(`✖ restart node ${port} nije uspio: ${err.message}`);
      }
    }, RESTART_EVERY * 1000)
  : null;

// ── čekaj kraj ──────────────────────────────────────────────────────────────
const endAt = Date.now() + MINUTES * 60_000;
while (Date.now() < endAt) {
  await wait(1000);
  const done = executions.size;
  if ((Date.now() - t0) % 30_000 < 1000) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    line(`t+${elapsed}s · poslano ${submitted.size} · izvršeno ${done} · taskova/s ${(done / ((Date.now() - t0) / 1000)).toFixed(1)}`);
  }
}

stop = true;
clearInterval(loadTimer);
clearInterval(memTimer);
if (restartTimer) clearInterval(restartTimer);

// pusti da se posao u toku završi (isti „settle" princip kao u chaos testu)
const settleMs = Number(arg('settle', 10_000));
const settleUntil = Date.now() + settleMs;
while (Date.now() < settleUntil && executions.size < submitted.size) await wait(500);

// ── statistika ──────────────────────────────────────────────────────────────
const completed = executions.size;
const lost = submitted.size - completed;
const duplicated = [...executions.values()].filter((n) => n > 1).length;
const durationSec = (Date.now() - t0) / 1000;
const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
const heapStart = memory[0]?.heapUsedMb ?? null;
const heapEnd = memory.at(-1)?.heapUsedMb ?? null;
const heapPeak = memory.length ? Math.max(...memory.map((m) => m.heapUsedMb)) : null;
const crdtSizes = nodes.map((n) => n.crdt.size);

const result = {
  scope: 'single machine (loopback), in-process nodes — mrežna particija nije simulirana',
  runId,
  startedAt: new Date(t0).toISOString(),
  minutes: MINUTES,
  nodes: NODES,
  targetRate: RATE,
  runnerDelayMs: DELAY,
  durationSec: Number(durationSec.toFixed(1)),
  submitted: submitted.size,
  completed,
  lost,
  duplicated,
  throughputPerSec: Number((completed / durationSec).toFixed(2)),
  latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99), max: sorted.at(-1) ?? null, samples: sorted.length },
  memoryMb: { start: heapStart, end: heapEnd, peak: heapPeak, samples: memory.length },
  crdtSizePerNode: crdtSizes,
  pheromonesActive: nodes.reduce((s, n) => s + n.pheromone.active({}).length, 0),
  restarts,
  gossip: nodes.reduce(
    (acc, n) => ({ sent: acc.sent + n.gossip.stats.sent, received: acc.received + n.gossip.stats.received, rejected: acc.rejected + n.gossip.stats.rejected, duplicates: acc.duplicates + n.gossip.stats.duplicates, rateLimited: acc.rateLimited + (n.gossip.stats.rateLimited ?? 0) }),
    { sent: 0, received: 0, rejected: 0, duplicates: 0, rateLimited: 0 },
  ),
  p95BudgetMs: P95_BUDGET,
  verdict: { lostOk: lost === 0, duplicatedOk: duplicated === 0, p95Ok: (pct(95) ?? 0) <= P95_BUDGET, memoryStable: heapEnd !== null && heapStart !== null ? heapEnd - heapStart < 150 : null },
};

header('REZULTAT SOAK TESTA');
line(`trajanje:            ${result.durationSec} s (${MINUTES} min)`);
line(`poslano / izvršeno:  ${result.submitted} / ${result.completed}`);
line(`propusnost:          ${result.throughputPerSec} taskova/s (cilj ${RATE})`);
line(`latencija:           p50 ${result.latencyMs.p50} · p95 ${result.latencyMs.p95} · p99 ${result.latencyMs.p99} · max ${result.latencyMs.max} ms`);
line(`izgubljeno:          ${lost}   ${lost === 0 ? '✔' : '✖'}`);
line(`duplo izvršeno:      ${duplicated}   ${duplicated === 0 ? '✔' : '✖'}`);
line(`memorija (heap):     start ${heapStart} MB · kraj ${heapEnd} MB · vrh ${heapPeak} MB   ${result.verdict.memoryStable ? '✔ stabilno' : '⚠ pogledaj trend'}`);
line(`CRDT po čvoru:       ${crdtSizes.join(', ')} · aktivnih feromona ${result.pheromonesActive}`);
line(`gossip:              poslano ${result.gossip.sent} · primljeno ${result.gossip.received} · odbijeno ${result.gossip.rejected} · duplikata ${result.gossip.duplicates} · rate-limited ${result.gossip.rateLimited}`);
line(`restarti čvora:      ${restarts}`);
line(`p95 budžet:          ${P95_BUDGET} ms → ${result.verdict.p95Ok ? '✔ u budžetu' : '✖ prekoračen'}`);
line(`domen:               ${result.scope}`);

fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
const outFile = path.join(ROOT, 'docs', `soak-${runId}.json`);
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
line(`zapisano:            ${path.relative(ROOT, outFile)}`);

const histFile = path.join(ROOT, 'data', '_control', 'soak-history.json');
fs.mkdirSync(path.dirname(histFile), { recursive: true });
const history = fs.existsSync(histFile) ? JSON.parse(fs.readFileSync(histFile, 'utf8')) : [];
history.push({ ts: result.startedAt, minutes: MINUTES, throughputPerSec: result.throughputPerSec, latencyMs: result.latencyMs, lost, duplicated, memoryMb: result.memoryMb, restarts });
fs.writeFileSync(histFile, JSON.stringify(history.slice(-50), null, 2));
line(`istorija:            data/_control/soak-history.json (unosa: ${history.length})`);

for (const n of nodes) await n.close().catch(() => {});
const ok = result.verdict.lostOk && result.verdict.duplicatedOk && result.verdict.p95Ok;
process.exit(ok ? 0 : 1);
