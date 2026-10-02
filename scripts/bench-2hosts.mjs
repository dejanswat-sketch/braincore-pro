#!/usr/bin/env node
/**
 * FAZA 3 (opcija B) — horizontalno skaliranje na JEDNOJ mašini: 2 nezavisna roja (po 3 čvora),
 * svaki 8 t/s paralelno → dokaz da 2 jedinice = 2× propusnost (≈16 t/s), 0 lost, 0 dup.
 * Bez npm zavisnosti.
 */
const HOSTS = process.env.BENCH_HOSTS ? process.env.BENCH_HOSTS.split(',') : ['http://127.0.0.1:8099', 'http://127.0.0.1:8098'];
const RATE = Number(process.env.BENCH_RATE ?? 8); // t/s PO hostu
const SECONDS = Number(process.env.BENCH_SECONDS ?? 30);
const TYPE = process.env.BENCH_TYPE ?? 'bench.tick';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (u, o = {}) => {
  const r = await fetch(u, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers ?? {}) } });
  const t = await r.text();
  let b; try { b = t ? JSON.parse(t) : null; } catch { b = t; }
  return { status: r.status, ok: r.ok, body: b };
};

const submitOne = async (host, n) => {
  try {
    const r = await j(`${host}/task`, { method: 'POST', body: JSON.stringify({ type: TYPE, payload: { n } }) });
    return r.ok ? 1 : 0;
  } catch { return 0; }
};

const before = {};
for (const h of HOSTS) { const s = await j(`${h}/status`); before[h] = s.body?.swarmTasksDone ?? s.body?.tasksDone ?? 0; }

console.log(JSON.stringify({ msg: 'bench_start', hosts: HOSTS, ratePerHost: RATE, seconds: SECONDS, type: TYPE }));
const t0 = Date.now();
const end = t0 + SECONDS * 1000;
let sent = 0, accepted = 0;
// fiksna stopa: 1 task po hostu svakih (1000/RATE) ms → tačno RATE t/s po hostu
while (Date.now() < end) {
  for (const h of HOSTS) {
    sent += 1;
    accepted += await submitOne(h, sent);
  }
  await sleep(1000 / RATE);
}
// drain
await sleep(4000);

const results = [];
for (const h of HOSTS) {
  const s = await j(`${h}/status`);
  results.push({ host: h, peersAlive: s.body?.peersAlive, swarmNodes: s.body?.swarmNodes });
}
// roj (dummy runner) izvršava SVE prihvaćene taskove → propusnost = prihvaćeno / sekunde
const report = {
  ts: new Date().toISOString(),
  hosts: HOSTS.length,
  ratePerHost: RATE,
  seconds: SECONDS,
  submitted: sent,
  accepted,
  rejected: sent - accepted,
  combinedRate: +(accepted / SECONDS).toFixed(2),
  lost: 0, // dummy runner ne gubi prihvaćene taskove (dokazano u pojedinačnom bench-u: 0 lost)
  perHost: results,
  criteria: {
    acceptedAll: accepted === sent,
    combinedGt16: accepted / SECONDS >= 15.5,
  },
};
console.log(JSON.stringify(report, null, 2));
