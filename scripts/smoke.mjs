#!/usr/bin/env node
/**
 * Smoke test protiv ŽIVOG servera (ili sam digne server ako nema URL-a).
 *
 *   node scripts/smoke.mjs                                  # digne svoj server (mock LLM) i provjeri
 *   NMQ_SMOKE_URL=https://robot.domena.com node scripts/smoke.mjs   # provjeri živi server
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRobot } from '../src/index.js';
import { createMockProvider } from '../src/llm/mock.js';
import { loadEnvFile } from './env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile({ root: ROOT });

const live = process.env.NMQ_SMOKE_URL;
const results = [];
let robot = null;
let base = live;

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, error: err.message });
    console.log(`  ✖ ${name} — ${err.message}`);
  }
}

const api = (url, init = {}) =>
  fetch(`${base}${url}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(process.env.NMQ_SMOKE_KEY ? { authorization: `Bearer ${process.env.NMQ_SMOKE_KEY}` } : {}), ...(init.headers ?? {}) },
  });

async function ensureServer() {
  if (live) {
    console.log(`\n  Provjeravam živi server: ${live}\n`);
    return;
  }
  const dataDir = path.join(ROOT, 'data', '_smoke');
  await fs.rm(dataDir, { recursive: true, force: true });
  robot = await createRobot({
    root: ROOT,
    dataDir,
    connectMcp: true,
    env: { ...process.env, NMQ_LLM_PROVIDER: process.env.NMQ_LLM_API_KEY ? process.env.NMQ_LLM_PROVIDER ?? 'openai-compatible' : 'mock', NMQ_LOG_LEVEL: 'warn' },
    overrides: process.env.NMQ_LLM_API_KEY ? {} : { llm: createMockProvider({ model: 'deepseek-chat' }), logLevel: 'warn' },
  });
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${addr.port}`;
  console.log(`\n  Server dignut lokalno: ${base}\n`);
}

async function main() {
  await ensureServer();

  await check('GET /healthz', async () => {
    const r = await api('/healthz');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j.ok) throw new Error('healthz.ok nije true');
    return `v${j.version}`;
  });

  await check('GET /readyz', async () => {
    const j = await (await api('/readyz')).json();
    return `agenata: ${j.agents}, alata: ${j.tools}, LLM: ${j.llm?.join('/')}`;
  });

  await check('GET /v1/agents', async () => {
    const j = await (await api('/v1/agents')).json();
    if (!j.count) throw new Error('nema agenata');
    return `${j.count} agenata`;
  });

  await check('GET /v1/tools', async () => {
    const j = await (await api('/v1/tools')).json();
    const high = j.tools.filter((t) => t.riskLevel === 'high').length;
    return `${j.count} alata (${high} visokog rizika)`;
  });

  await check('GET /metrics', async () => {
    const text = await (await api('/metrics')).text();
    if (!text.includes('nmq_')) throw new Error('nema nmq metrika');
    return `${text.split('\n').length} linija`;
  });

  await check('POST /v1/agents/support/run', async () => {
    const r = await api('/v1/agents/support/run', { method: 'POST', body: JSON.stringify({ input: 'Kako da resetujem lozinku?', tenantId: 'nmq' }) });
    const j = await r.json();
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${j?.error?.message}`);
    if (!j.runId) throw new Error('nema runId');
    return `agent=${j.agentId} pattern=${j.pattern} cost=${j.costUsd}`;
  });

  await check('POST /v1/router/run', async () => {
    const r = await api('/v1/router/run', { method: 'POST', body: JSON.stringify({ input: 'Ne radi mi prijava na nalog', tenantId: 'nmq' }) });
    const j = await r.json();
    if (!j.routing?.agentId) throw new Error('nema routing.agentId');
    return `${j.routing.agentId} (${j.routing.method})`;
  });

  await check('POST /v1/run/stream (SSE)', async () => {
    const r = await api('/v1/run/stream', { method: 'POST', body: JSON.stringify({ input: 'Status narudžbine 1042', agentId: 'ecommerce', tenantId: 'nmq' }) });
    if (!r.headers.get('content-type')?.includes('event-stream')) throw new Error('nije SSE');
    const text = await r.text();
    if (!text.includes('event: done')) throw new Error('nema "done" događaja');
    return `${[...text.matchAll(/^event: (\w+)/gm)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).join(',')}`;
  });

  await check('POST /v1/kb + /v1/kb/search', async () => {
    await api('/v1/kb', { method: 'POST', body: JSON.stringify({ text: 'Radno vrijeme podrške je 09-17 radnim danima.', source: 'SMOKE' }) });
    const j = await (await api('/v1/kb/search', { method: 'POST', body: JSON.stringify({ query: 'radno vrijeme', k: 3 }) })).json();
    if (!j.hits?.length) throw new Error('nema pogodaka u bazi znanja');
    return `${j.hits.length} pogodaka`;
  });

  await check('GET /v1/usage', async () => {
    const j = await (await api('/v1/usage')).json();
    if (typeof j.summary?.usd !== 'number') throw new Error('nema summary.usd');
    return `${j.summary.usd} USD, ${j.summary.calls} poziva`;
  });

  await check('GET /v1/audit (hash lanac)', async () => {
    const j = await (await api('/v1/audit')).json();
    if (!j.verify?.ok) throw new Error(`lanac polomljen: ${j.verify?.reason ?? 'nepoznato'}`);
    return `${j.verify.checked} zapisa, lanac ispravan`;
  });

  await check('GET /widget.js', async () => {
    const r = await api('/widget.js');
    const text = await r.text();
    if (!text.includes('NMQRobot')) throw new Error('widget nije ispravan');
    return `${(text.length / 1024).toFixed(0)} KB`;
  });

  await check('404 za nepoznatu rutu', async () => {
    const r = await api('/nema-ovoga');
    if (r.status !== 404) throw new Error(`očekivano 404, dobijeno ${r.status}`);
    return '404';
  });

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`  ── SMOKE REZULTAT: ${results.length - failed.length}/${results.length} prošlo ──`);
  if (failed.length) {
    console.log(`  Pali: ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}`);
  }
  console.log('');

  if (robot) await robot.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('SMOKE GREŠKA:', err?.message);
  if (robot) await robot.close().catch(() => {});
  process.exit(1);
});
