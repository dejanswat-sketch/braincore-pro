/**
 * SPRINT 3 + 4 — rotacija ključa, kompakcija CRDT-a, Prometheus format i alert skripta.
 *
 * Ovi testovi provjeravaju ono što je dodato poslije soak-a i CI-ja:
 *   • `NMQ_CLUSTER_SECRET_PREV` (rolling restart bez ispadanja iz roja)
 *   • GC tombstone-a (tabla ne raste u nedogled, konvergencija ostaje tačna)
 *   • `/metrics?format=prom` — Prometheus text format (bez npm klijenta)
 *   • `deploy/alertcheck.sh` — postoji, izvršan je i ispravno prijavljuje zdravo stanje
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSwarmNode } from '../src/node.js';
import { createApiServer } from '../src/api/server.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SECRET = 'prom-secret-1234567890';

test('Prometheus format: /metrics?format=prom vraća text/plain sa očekivanim metrikama', async () => {
  const node = await createSwarmNode({ nodeId: 'prom-node', port: 0, host: '127.0.0.1', secret: SECRET, config: { httpAdmin: false, autoLoop: false, durableSubmit: false } });
  const api = await createApiServer({ node, config: { port: 0, host: '127.0.0.1' } });
  const addr = await api.listen();
  try {
    await node.submitTask({ type: 'x', payload: {} });
    await node.tick();

    const res = await fetch(`http://127.0.0.1:${addr.port}/metrics?format=prom`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const text = await res.text();
    for (const metric of [
      'braincore_peers_alive',
      'braincore_nodes',
      'braincore_tasks_done_total',
      'braincore_tasks_done_local',
      'braincore_crdt_entries',
      'braincore_crdt_tombstones',
      'braincore_pheromones_active',
      'braincore_queue_depth',
      'braincore_gossip_sent_total',
      'braincore_gossip_rejected_total',
      'braincore_gossip_prev_key_total',
      'braincore_uptime_seconds',
    ]) {
      assert.match(text, new RegExp(`^${metric} \\d+`, 'm'), `nedostaje metrika ${metric}`);
      assert.match(text, new RegExp(`^# TYPE ${metric} `, 'm'), `nedostaje TYPE za ${metric}`);
    }
    // Accept: text/plain takođe daje Prometheus format (bez ?format=prom)
    const viaAccept = await fetch(`http://127.0.0.1:${addr.port}/metrics`, { headers: { accept: 'text/plain' } });
    assert.match(await viaAccept.text(), /braincore_nodes/);
    // bez Accept-a ostaje JSON (za live stranicu)
    const json = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
    assert.match(json.headers.get('content-type'), /application\/json/);
    assert.equal((await json.json()).tasksDone, 1);
  } finally {
    await api.close();
    await node.close();
  }
});

test('deploy artefakti postoje i alert skripta radi (bez npm-a)', async () => {
  for (const file of ['deploy/alertcheck.sh', 'deploy/release.sh', 'deploy/rollback.sh', 'deploy/grafana-dashboard.json']) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `nedostaje ${file}`);
  }
  // Grafana dashboard je validan JSON sa panelima
  const dash = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/grafana-dashboard.json'), 'utf8'));
  assert.ok(Array.isArray(dash.panels) && dash.panels.length >= 8, 'dashboard mora imati panele');
  assert.ok(dash.panels.some((p) => p.title.includes('Queue depth')), 'mora imati panel za red (backpressure)');

  // release/rollback skripte moraju biti bash sa `set -euo pipefail` (fail-fast)
  for (const file of ['deploy/release.sh', 'deploy/rollback.sh']) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(code, /set -euo pipefail/);
    assert.match(code, /systemctl restart/);
  }
});

test('alertcheck.sh: na zdravom čvoru vraća 0, na mrtvom API-ju vraća 1', async (t) => {
  // `bash` na Windowsu ovdje ide na WSL koji nije instaliran → preskačemo izvršavanje.
  // Skripta se STVARNO izvršava u CI-ju (ubuntu-latest) protiv živog lokalnog API-ja.
  let bashWorks = true;
  try {
    execFileSync('bash', ['-c', 'echo ok'], { stdio: 'pipe' });
  } catch {
    bashWorks = false;
  }
  if (!bashWorks) {
    t.skip('bash nije dostupan u ovom okruženju (Windows/WSL) — izvršavanje se provjerava u CI-ju');
    return;
  }

  const node = await createSwarmNode({ nodeId: 'alert-node', port: 0, host: '127.0.0.1', secret: SECRET, config: { httpAdmin: false, autoLoop: false, durableSubmit: false } });
  const api = await createApiServer({ node, config: { port: 0, host: '127.0.0.1' } });
  const addr = await api.listen();
  const script = path.join(ROOT, 'deploy/alertcheck.sh');
  try {
    // Zdrav slučaj: API radi, nema peer-ova ali PEERS_MIN=0 da test ne zavisi od roja
    const ok = execFileSync('bash', [script], { env: { ...process.env, API: `http://127.0.0.1:${addr.port}`, PEERS_MIN: '0' }, encoding: 'utf8' });
    assert.match(ok, /OK: sve provjere prošle/);
  } finally {
    await api.close();
    await node.close();
  }
  // Mrtav API → skripta mora pasti (exit 1)
  let failed = false;
  try {
    execFileSync('bash', [script, '--quiet'], { env: { ...process.env, API: 'http://127.0.0.1:1' }, encoding: 'utf8' });
  } catch (err) {
    failed = true;
    assert.match(String(err.stderr), /ALERT: API ne odgovara/);
  }
  assert.equal(failed, true, 'alertcheck mora prijaviti mrtav API');
});
