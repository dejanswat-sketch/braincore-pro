#!/usr/bin/env node
/**
 * chaosctl — komandna linija za chaos dugme (isto što i KILL NODE na live.braincore.pro).
 *
 *   node scripts/chaosctl.mjs status
 *   node scripts/chaosctl.mjs kill --random --confirm
 *   node scripts/chaosctl.mjs kill --node=node-8002 --confirm --api=https://api.braincore.pro
 *
 * Zašto i CLI: za snimanje demoa i za automatizaciju (CI/cron) — bez otvaranja browsera.
 * Sve ide kroz isti API endpoint, pa važe iste zaštite (naoružavanje, 1/60 s, nikad API čvor, audit).
 */
const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);
const API = (arg('api', process.env.BRAINCORE_API ?? 'https://api.braincore.pro')).replace(/\/$/, '');
const cmd = process.argv[2] ?? 'status';

const line = (s) => console.log(s);

async function call(path, init) {
  const res = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error?.message ?? `HTTP ${res.status}`);
    err.code = body?.error?.code ?? `HTTP_${res.status}`;
    err.status = res.status;
    throw err;
  }
  return body;
}

if (cmd === 'status') {
  const s = await call('/v1/chaos/status');
  line(`chaos:      ${s.armed ? 'ARMED' : 'DISABLED'}`);
  line(`cooldown:   ${s.cooldownMs} ms`);
  line(`kills:      ${s.killsTotal}`);
  line(`peersAlive: ${s.peersAlive}`);
  if (s.history?.length) {
    line('history:');
    for (const h of s.history.slice(-5)) line(`  ${h.at}  ${h.nodeId} (port ${h.port})`);
  }
  process.exit(s.armed ? 0 : 1);
}

if (cmd === 'kill') {
  if (!has('confirm')) {
    line('Odbijeno: dodaj --confirm (fail-safe, isto kao potvrda u browseru).');
    process.exit(2);
  }
  const t0 = Date.now();
  const status = await call('/status');
  const alive = (status.alive ?? []).map((a) => a.split('@')[0]);
  const want = arg('node', null);
  if (want && !alive.includes(want)) {
    line(`Odbijeno: ${want} nije živ (živi: ${alive.join(', ')})`);
    process.exit(3);
  }
  const k = await call('/v1/chaos/kill', { method: 'POST', headers: { 'content-type': 'application/json' } });
  line(`! ${k.nodeId} termination initiated…  (accepted in ${k.acceptedInMs} ms, kill #${k.killsTotal})`);
  line(`  expected: detection ~${k.expectedDetectionMs} ms, rejoin ~${k.expectedRecoverySec} s`);

  // prati oporavak (isto mjerenje kao na dashboardu)
  let detected = null;
  let rejoined = null;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 800));
    let s;
    try {
      s = await call('/status');
    } catch {
      line(`  t+${Date.now() - t0} ms: API kratko ne odgovara`);
      continue;
    }
    const m = (s.membership ?? []).find((x) => x.nodeId === k.nodeId);
    if (!m) continue;
    const el = Date.now() - t0;
    if (m.status !== 'alive' && !detected) {
      detected = el;
      line(`  t+${el} ms: DETECTION — ${k.nodeId} is '${m.status}'`);
    }
    if (detected && m.status === 'alive' && !rejoined) {
      rejoined = el;
      line(`  t+${el} ms: REJOIN — ${k.nodeId} is back (alive peers: ${s.peersAlive})`);
      break;
    }
  }
  line('');
  line(`SUD: detection ${detected ?? 'n/a'} ms · rejoin ${rejoined ?? 'n/a'} ms`);
  process.exit(rejoined ? 0 : 1);
}

line(`Nepoznata komanda: ${cmd}. Koristi: status | kill --random --confirm`);
process.exit(2);
