#!/usr/bin/env node
/**
 * BENCHMARK — kako se roj skalira sa brojem čvorova (Sprint 5, `docs/40`).
 *
 *   node scripts/bench.mjs                                  # 1, 3, 10, 25 čvorova × 15 s
 *   node scripts/bench.mjs --nodes=1,3 --seconds=10 --rate=40
 *
 * Za svaku konfiguraciju mjeri:
 *   • postignutu propusnost (taskova/s) pri fiksnom opterećenju i fiksnom trajanju posla
 *   • latenciju p50/p95/p99 (od predaje do završetka)
 *   • CPU (process.cpuUsage) i memoriju (rss/heap) — koliko košta držati N čvorova
 *   • discovery (koliko ms treba da se svi vide)
 *
 * ISKRENO O DOMENU: svi čvorovi su **u jednom procesu** (jedan event loop), pa su brojevi
 * **gornja granica jednog procesa**, a ne kapacitet N mašina. Pravi multi-host bench zahtijeva
 * N procesa/hostova i mrežu između njih (F11 iz transparentnog izvještaja).
 * Rezultat: `docs/bench-<ts>.json` + tabela u `docs/43-BENCHMARK.md`.
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
const NODE_COUNTS = String(arg('nodes', '1,3,10,25')).split(',').map((s) => Number(s.trim())).filter(Boolean);
const SECONDS = Number(arg('seconds', 15));
const TARGET_RATE = Number(arg('rate', 40)); // taskova/s (ukupno, ne po čvoru)
const DELAY = Number(arg('delay', 60)); // trajanje posla (ms)
const BASE_PORT = Number(arg('base-port', 8801));
const SECRET = arg('secret', 'bench-secret-1234567890');
const logger = createLogger({ level: 'error' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (t) => console.log(`  ${t}`);

console.log(`\nBENCHMARK — ${NODE_COUNTS.join('/')} čvorova · ${SECONDS}s po konfiguraciji · cilj ${TARGET_RATE} taskova/s · posao ${DELAY} ms`);
console.log('  (svi čvorovi u JEDNOM procesu → gornja granica jednog procesa, ne N mašina)');

const results = [];

for (const count of NODE_COUNTS) {
  const ports = Array.from({ length: count }, (_, i) => BASE_PORT + i);
  const latencies = [];
  const submitted = new Map();
  const executions = new Map();
  const runner = async (task) => {
    await wait(DELAY);
    executions.set(task.id, (executions.get(task.id) ?? 0) + 1);
    return { output: 'bench' };
  };
  const mk = (port, peers) => createSwarmNode({ nodeId: `bench-${port}`, port, host: '127.0.0.1', advertiseHost: '127.0.0.1', peers, secret: SECRET, logger, runner, config: { httpAdmin: false, autoLoop: true, claimIntervalMs: 40, syncIntervalMs: 250, durableSubmit: false, gossip: { intervalMs: 300, failureTimeoutMs: 1200 } } });
  const nodes = [];
  for (let i = 0; i < count; i += 1) nodes.push(await mk(ports[i], i === 0 ? [] : ports.slice(0, i).map((p) => `127.0.0.1:${p}`)));

  const tStart = Date.now();
  await nodes[0].start();
  for (let i = 1; i < count; i += 1) await nodes[i].start();
  for (let i = 1; i < count; i += 1) await nodes[i].gossip.join([`127.0.0.1:${ports[0]}`]);
  const discoveryMs = count === 1 ? 0 : (await Promise.all(nodes.slice(1).map((n) => n.waitForPeers({ expected: count - 1, timeoutMs: 5000 })))).reduce((m, r) => Math.max(m, r.syncMs), 0);
  const setupMs = Date.now() - tStart;

  for (const n of nodes) {
    n.on('done', (r) => {
      const ts = submitted.get(r.taskId);
      if (ts) latencies.push(Date.now() - ts);
    });
  }

  const cpu0 = process.cpuUsage();
  const mem0 = process.memoryUsage();
  let seq = 0;
  const intervalMs = Math.max(1, Math.round(1000 / TARGET_RATE));
  const timer = setInterval(() => {
    const id = `bench-${count}-${++seq}`;
    submitted.set(id, Date.now());
    nodes[seq % nodes.length].submitTask({ id, type: 'bench.load', payload: {}, ttl: 60_000, value: 1 }).catch(() => {});
  }, intervalMs);

  await wait(SECONDS * 1000);
  clearInterval(timer);
  // settle: pusti posao u toku (isto kao soak), da mjerenje ne kazni sistem bez razloga
  const settleUntil = Date.now() + 10_000;
  while (Date.now() < settleUntil && executions.size < submitted.size) await wait(200);
  const durationSec = SECONDS;
  const cpu = process.cpuUsage(cpu0);
  const mem = process.memoryUsage();
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);

  const result = {
    nodes: count,
    discoveryMs,
    setupMs,
    seconds: durationSec,
    targetRate: TARGET_RATE,
    submitted: submitted.size,
    completed: executions.size,
    lost: submitted.size - executions.size,
    duplicated: [...executions.values()].filter((n) => n > 1).length,
    throughputPerSec: Number((executions.size / durationSec).toFixed(2)),
    latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99), max: sorted.at(-1) ?? null },
    cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(0)),
    cpuPerTaskMs: executions.size ? Number((((cpu.user + cpu.system) / 1000) / executions.size).toFixed(2)) : null,
    rssMb: Number((mem.rss / 1024 / 1024).toFixed(1)),
    heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
    heapDeltaMb: Number(((mem.heapUsed - mem0.heapUsed) / 1024 / 1024).toFixed(1)),
    crdtEntries: nodes.reduce((s, n) => s + n.crdt.size, 0),
    gossipSent: nodes.reduce((s, n) => s + n.gossip.stats.sent, 0),
  };
  results.push(result);
  line(`${String(count).padStart(2)} node(ova): discovery ${discoveryMs} ms · ${result.throughputPerSec} taskova/s · p50 ${result.latencyMs.p50} · p95 ${result.latencyMs.p95} · p99 ${result.latencyMs.p99} ms · CPU ${result.cpuMs} ms (${result.cpuPerTaskMs} ms/task) · RSS ${result.rssMb} MB · izgubljeno ${result.lost} · duplo ${result.duplicated}`);

  for (const n of nodes) await n.close().catch(() => {});
  await wait(500);
}

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(ROOT, 'docs', `bench-${runId}.json`);
fs.writeFileSync(outFile, JSON.stringify({ scope: 'single process, in-process nodes (loopback)', runId, targetRate: TARGET_RATE, runnerDelayMs: DELAY, results }, null, 2));
console.log(`\n  zapisano: ${path.relative(ROOT, outFile)}`);

// Tabela u dokumentu (markdown), da brojevi ostanu u repou, a ne samo u logu
const doc = path.join(ROOT, 'docs', '43-BENCHMARK.md');
const header = `\n### Run ${runId}\n\n| Čvorova | Discovery | Propušteno | p50 | p95 | p99 | CPU ukupno | CPU/task | RSS | Izgubljeno | Duplo |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
const rows = results
  .map((r) => `| ${r.nodes} | ${r.discoveryMs} ms | **${r.throughputPerSec}/s** | ${r.latencyMs.p50} ms | ${r.latencyMs.p95} ms | ${r.latencyMs.p99} ms | ${r.cpuMs} ms | ${r.cpuPerTaskMs} ms | ${r.rssMb} MB | ${r.lost} | ${r.duplicated} |`)
  .join('\n');
const existing = fs.existsSync(doc) ? fs.readFileSync(doc, 'utf8') : '# 43 — BENCHMARK (skaliranje roja)\n\n> Mjeri `scripts/bench.mjs`. **Iskreno o domenu:** svi čvorovi su u JEDNOM procesu (jedan event loop), pa su brojevi gornja granica jednog procesa — ne kapacitet N mašina. Pravi multi-host bench traži N procesa/hostova i mrežu između njih.\n\nCilj opterećenja i trajanje posla pišu se u zaglavlju svakog runa.\n';
fs.writeFileSync(doc, `${existing}${header}${rows}\n\n> Cilj: ${TARGET_RATE} taskova/s, posao ${DELAY} ms, ${SECONDS}s po konfiguraciji.\n`);
console.log(`  tabela:   docs/43-BENCHMARK.md`);

const bad = results.filter((r) => r.lost > 0 || r.duplicated > 0);
process.exit(bad.length ? 1 : 0);
