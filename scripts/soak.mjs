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
const shed = []; // odbijeno backpressure-om (429) — namjerno odbacivanje viška, NIJE gubitak
const failedSubmit = []; // druge greške pri predaji
const memory = [];
let restarts = 0;
const restartStats = [];

const executorByTask = new Map(); // taskId -> [{ nodeId, attempt }] — KO je izvrsio (cross-node vs same-node)
const runner = async (task, ctx = {}) => {
  await wait(DELAY);
  executions.set(task.id, (executions.get(task.id) ?? 0) + 1);
  const arr = executorByTask.get(task.id) ?? [];
  arr.push({ nodeId: ctx.nodeId ?? 'nepoznat', attempt: ctx.attempt ?? null });
  executorByTask.set(task.id, arr);
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
  /**
   * VAŽNO (nalaz iz 1h soak-a 30.09.): task se broji kao POSLAN tek kad ga je roj PRIHVATIO.
   * Backpressure (429 QUEUE_FULL) znači da je sistem iskreno odbio višak — to NIJE izgubljen task,
   * to je „shed". Ranije se takav task brojao u `submitted` pa je 23 179 odbijenih izgledalo kao gubitak.
   */
  try {
    await node.submitTask({ id, type: 'soak.load', payload: { text: `soak ${seq}` }, ttl: 120_000, value: 1 + (seq % 4), durable: false });
    submitted.set(id, Date.now());
  } catch (err) {
    if (err?.code === 'QUEUE_FULL') shed.push({ id, at: Date.now(), queueDepth: err.details?.queueDepth ?? null });
    else failedSubmit.push({ id, at: Date.now(), code: err?.code ?? 'ERROR', message: err?.message ?? String(err) });
  }
}, intervalMs);

// ── uzorkovanje memorije ────────────────────────────────────────────────────
const memTimer = setInterval(() => {
  const m = process.memoryUsage();
  memory.push({ at: Date.now(), heapUsedMb: Number((m.heapUsed / 1024 / 1024).toFixed(1)), rssMb: Number((m.rss / 1024 / 1024).toFixed(1)) });
  // NOSIOC MEMORIJE (docs/44 §29): CRDT je oboren kao hipoteza (tabela -29 %, heap isti), pa na svakom
  // intervalu logujemo velicine SVIH struktura — da se vidi koja prati broj zadataka.
  try {
    const snap = nodes.map((n) => ({ node: n.nodeId, ...(typeof n.memoryByStructure === 'function' ? n.memoryByStructure() : {}) }));
    console.error(`[mem-by-structure] ${JSON.stringify(snap)}`);
  } catch (err) {
    console.error(`[mem-by-structure] greska: ${err.message}`);
  }
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
const completed = executions.size; // jedinstveni taskovi koji su izvršeni
// RAČUNANJE (popravljeno poslije soak-a #6): `lost` se smije računati samo nad taskovima koje je klijent
// VIDIO kao poslane — inače negativan „gubitak" (soak #6: -1), jer je jedan task koji je PAO PRI PREDAJI
// (6 grešaka) ipak izvršen: klijent je vidio grešku, a posao je odrađen. To je nalaz, ne artefakt.
const completedSubmitted = [...executions.keys()].filter((id) => submitted.has(id)).length;
const executedNotSubmitted = [...executions.keys()].filter((id) => !submitted.has(id));
const lost = Math.max(0, submitted.size - completedSubmitted);
const duplicated = [...executions.values()].filter((n) => n > 1).length; // taskovi izvršeni više od jednom
// Za svaki DUPLIRANI task ispisi trag claim-ova sa svih cvorova: vidi se KO je potvrdio i KADA
// (i sta je zatekao pri preuzimanju). Ovo je jedini nacin da se odluka o `confirm` prozoru donese
// mjerenjem, a ne poganjanjem.
const dupIds = [...executions.entries()].filter(([, c]) => c > 1).map(([id]) => id).slice(0, 6);
for (const id of dupIds) {
  const traces = nodes.map((n) => ({ node: n.nodeId, events: n.claimTrace(id) })).filter((t) => t.events.length);
  console.error(`[dup-trace] ${id} ${JSON.stringify(traces)}`);
}
const extraExecutions = [...executions.values()].reduce((s, n) => s + Math.max(0, n - 1), 0);
// KLASIFIKACIJA DUPLIH: cross-node (dva razlicita cvora) vs same-node (isti cvor dvaput).
// Ovo razdvaja dve razlicite popravke: cross-node => `confirm`/LWW; same-node => self-reclaim/retry
// (gde `confirm` prozor nije ni u igri). Bez ovoga je svaka odluka poganjanje.
const dupDetail = [...executorByTask.entries()]
  .filter(([, arr]) => arr.length > 1)
  .map(([taskId, arr]) => ({
    taskId,
    nodes: arr.map((a) => a.nodeId),
    attempts: arr.map((a) => a.attempt),
    uniqueNodes: new Set(arr.map((a) => a.nodeId)).size,
    sameNode: new Set(arr.map((a) => a.nodeId)).size === 1,
  }));
const dupCrossNode = dupDetail.filter((d) => !d.sameNode).length;
// PRAVI kriterij: ponovljeno izvrsavanje ISTOG `attempt`-a (isti ili drugi cvor) = stvarni duplikat.
// Novi `attempt` na drugom cvoru = `retryAfterKill` (ocekivano `at-least-once`: posao je ostao bez vlasnika).
const dupSameAttemptDetail = dupDetail.filter((d) => {
  const seen = new Set();
  for (const a of d.attempts) {
    if (a !== null && a !== undefined && seen.has(a)) return true;
    seen.add(a);
  }
  return false;
});
const duplicateSameAttempt = dupSameAttemptDetail.length;
const retryAfterKill = dupDetail.length - duplicateSameAttempt;
const dupSameNode = dupDetail.filter((d) => d.sameNode).length;
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
  shedByBackpressure: shed.length,
  failedSubmit: failedSubmit.length,
  completed,
  lost,
  duplicated,
  extraExecutions,
  dupCrossNode,
  duplicateSameAttempt,
  retryAfterKill,
  duplicateSameAttemptDetail: dupSameAttemptDetail.slice(0, 12),
  dupSameNode,
  dupDetail: dupDetail.slice(0, 12),
  completedSubmitted,
  executedNotSubmitted: executedNotSubmitted.length,
  executedNotSubmittedIds: executedNotSubmitted.slice(0, 10),
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
line(`poslano / izvršeno:  ${result.submitted} / ${result.completed}  (odbijeno backpressure-om: ${result.shedByBackpressure}, druge greške: ${result.failedSubmit})`);
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
