#!/usr/bin/env node
/**
 * FAZA 4 — self-tune robot.
 *
 * Čita `/v1/tuning` sa API-ja svakih 30 s i SAM podešava `gcAgeMs` / `compactionIntervalMs` /
 * `claimLeaseMs` — ono što smo ručno namještali u soak-u #7→#16 (110,5 → 99,6 MB heap).
 *
 * Pravila (sva iz mjerenja, ne iz pogađanja):
 *   • heap > 90 MB  → GC kasni  → smanji gcAgeMs + compactionIntervalMs (agresivnije prune)
 *   • reclaim_storm raste → gcAgeMs pretijesan → povećaj gcAgeMs (7 min je već pogoršalo storm 82→246)
 *   • heap < 50 MB + storm miran → relaksiraj ka 10 min (zadani optimum)
 *   • queueDepth > 1000 → duži lease (manje reclaim-a)
 *
 * Sigurnosne granice su U NODE-U (`setTuning` klampuje): gcAgeMs [5 min, 30 min],
 * compactionIntervalMs [5 s, 5 min], claimLeaseMs [3 s, 60 s]. Robot ne može otići predaleko.
 *
 * Env: BRAINCORE_API (default https://api.braincore.pro), TUNE_INTERVAL_MS (default 30000), ONCE=1 (jedan krug).
 */
const API = (process.env.BRAINCORE_API ?? 'https://api.braincore.pro').replace(/\/$/, '');
const INTERVAL = Number(process.env.TUNE_INTERVAL_MS ?? 30_000);
const ONCE = process.env.ONCE === '1';
// Pragovi su podesivi env-om (za test + ops); defaulti su iz mjerenja.
const HEAP_HIGH = Number(process.env.TUNE_HEAP_HIGH ?? 90);
const HEAP_LOW = Number(process.env.TUNE_HEAP_LOW ?? 50);
const GC_TARGET = Number(process.env.TUNE_GC_TARGET_MS ?? 600_000);

const log = (msg, extra) => console.log(JSON.stringify({ ts: new Date().toISOString(), robot: 'self-tune', msg, ...extra }));
const j = async (u, o = {}) => {
  const r = await fetch(u, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers ?? {}) } });
  const t = await r.text();
  let b; try { b = t ? JSON.parse(t) : null; } catch { b = t; }
  return { status: r.status, ok: r.ok, body: b };
};

let prev = null;

async function tick() {
  let u;
  try {
    const g = await j(`${API}/v1/tuning`);
    if (!g.ok) return log('tuning_unavailable', { status: g.status, error: JSON.stringify(g.body).slice(0, 120) });
    u = g.body.tuning;
  } catch (e) { return log('tuning_error', { error: e.message }); }

  const stormDelta = prev ? Math.max(0, u.reclaimStormCount - prev.reclaimStormCount) : 0;
  const adj = {};
  const reason = [];

  if (u.heapUsedMb > HEAP_HIGH) {
    adj.gcAgeMs = Math.round(u.gcAgeMs * 0.7);
    adj.compactionIntervalMs = Math.max(5_000, Math.round(u.compactionIntervalMs * 0.5));
    reason.push(`heap ${u.heapUsedMb} > ${HEAP_HIGH}`);
  } else if (stormDelta > 0) {
    adj.gcAgeMs = Math.round(u.gcAgeMs * 1.25);
    reason.push(`reclaim_storm +${stormDelta}`);
  } else if (u.heapUsedMb < HEAP_LOW && u.gcAgeMs < GC_TARGET) {
    adj.gcAgeMs = Math.min(GC_TARGET, Math.round(u.gcAgeMs * 1.15));
    reason.push(`relaksacija (heap ${u.heapUsedMb})`);
  }

  if ((u.queueDepth ?? 0) > 1000) {
    adj.claimLeaseMs = Math.min(60_000, Math.round(u.claimLeaseMs * 2));
    reason.push(`queue ${u.queueDepth}`);
  }

  const snap = { heapUsedMb: u.heapUsedMb, gcAgeMs: u.gcAgeMs, compactionIntervalMs: u.compactionIntervalMs, claimLeaseMs: u.claimLeaseMs, reclaimStorm: u.reclaimStormCount, crdt: u.crdtEntries, tasks: u.tasks, queue: u.queueDepth };

  if (Object.keys(adj).length) {
    try {
      const r = await j(`${API}/v1/tuning`, { method: 'POST', body: JSON.stringify(adj) });
      log('adjust', { reason, wanted: adj, applied: r.body?.after ?? null, snap });
    } catch (e) { log('adjust_error', { error: e.message }); }
  } else {
    log('stable', { snap, stormDelta });
  }

  prev = { heapUsedMb: u.heapUsedMb, reclaimStormCount: u.reclaimStormCount, gcAgeMs: u.gcAgeMs };
}

if (ONCE) { await tick(); process.exit(0); }
log('robot_start', { api: API, intervalMs: INTERVAL, heapHigh: HEAP_HIGH, heapLow: HEAP_LOW, gcTarget: GC_TARGET });
await tick();
setInterval(tick, INTERVAL);
