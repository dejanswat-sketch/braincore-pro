#!/usr/bin/env node
/**
 * METRICS SCRAPE — uzima /metrics?format=prom i upisuje kompaktan uzorak u istoriju (JSONL).
 *
 *   node scripts/metrics-scrape.mjs                     # lokalno: http://127.0.0.1:8081
 *   node scripts/metrics-scrape.mjs --api=https://api.braincore.pro
 *
 * Zašto: `deploy/alertcheck.sh` provjerava pragove, ali **istorija** je ono što pokazuje trend
 * (curenje memorije, rast reda, pogrešan ključ). Uzorci idu u `data/_control/metrics-history.jsonl`
 * (rotacija na 5000 linija ≈ 20 h pri 15 s). Kad se doda Prometheus/Grafana, ovaj fajl je izvor.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const API = (arg('api', process.env.BRAINCORE_API ?? 'http://127.0.0.1:8081')).replace(/\/$/, '');
const DATA_DIR = arg('data', process.env.NMQ_DATA_DIR ?? path.join(ROOT, 'data'));
const FILE = path.join(DATA_DIR, '_control', 'metrics-history.jsonl');
const MAX_LINES = Number(arg('max-lines', 5000));

const wanted = [
  'braincore_peers_alive', 'braincore_nodes', 'braincore_tasks_done_total', 'braincore_load',
  'braincore_crdt_entries', 'braincore_crdt_tombstones', 'braincore_pheromones_active',
  'braincore_queue_depth', 'braincore_live_clients', 'braincore_gossip_rejected_total',
  'braincore_gossip_rate_limited_total', 'braincore_gossip_prev_key_total', 'braincore_uptime_seconds',
];

const res = await fetch(`${API}/metrics?format=prom`, { signal: AbortSignal.timeout(10_000) });
if (!res.ok) {
  console.error(`scrape neuspjesan: HTTP ${res.status}`);
  process.exit(1);
}
const text = await res.text();
const sample = { ts: new Date().toISOString(), api: API };
for (const line of text.split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const [metric, value] = line.trim().split(' ');
  const base = metric.replace(/\{.*\}$/, '');
  if (!wanted.includes(base)) continue;
  const label = metric.includes('tenant="') ? metric.match(/tenant="([^"]+)"/)?.[1] : null;
  const key = label ? `${base}{${label}}` : base;
  const num = Number(value);
  if (Number.isFinite(num)) sample[key] = num;
}

fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.appendFileSync(FILE, `${JSON.stringify(sample)}\n`);
const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
if (lines.length > MAX_LINES) fs.writeFileSync(FILE, `${lines.slice(-MAX_LINES).join('\n')}\n`);
console.log(`scrape OK: ${Object.keys(sample).length - 2} metrika → ${FILE} (${Math.min(lines.length, MAX_LINES)} uzoraka)`);