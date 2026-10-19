#!/usr/bin/env node
/**
 * ruter-worker.js — SPECIJALIZOVANI ROBOTIC: uzima `ai-*` zadatke iz BRAINCORE roja
 * i salje ih PRAVOM lokalnom modelu (specijalnost), pa vraca rezultat u roj.
 *
 * Ideja (korisnik): svaki model radi ono sto najbolje radi; DSH agent je saobracajac.
 * Ovaj worker je "ruka" saobracajca — izvrsava zadatke na lokalnoj kartici ($0).
 *
 * Tipovi zadataka i model:
 *   ai-klasifikuj  -> gemma3:4b            (brzo, 0.3-2s)
 *   ai-prevedi     -> gemma3:4b
 *   ai-izvuci      -> devstral:24b         (ekstrakcija polja iz teksta)
 *   ai-analiziraj  -> devstral:24b         (analiza loga/teksta)
 *   ai-kod         -> qwen2.5-coder:14b    (kod, SQL, regex)
 *   ai-logika      -> deepseek-r1:14b      (dokaz, matematika, tezak izbor)
 *   ai-objasni     -> gpt-oss:20b          (objasnjenje, dokumentacija)
 *   ai-tekst       -> qwen3:14b            (SEO/GEO tekst, kreativno)
 *   ai-embedding   -> bge-m3               (vektori)
 *
 * Env:
 *   BRAINCORE_API   (default http://127.0.0.1:8081)
 *   WORKER_ID       (default ruter-worker-1)
 *   WORKER_TYPES    (default svi ai-* gore)
 *   POLL_MS         (default 300)
 *   OLLAMA_BASE     (default http://127.0.0.1:11434)
 *   ONCE=1          (obradi dostupno pa izadji — za test)
 *
 * Test bez roja:  node workers/ruter-worker.js --probaj "klasifikuj: pogresan iznos"
 */
import { randomUUID } from 'node:crypto';

const API = (process.env.BRAINCORE_API ?? 'http://127.0.0.1:8081').replace(/\/$/, '');
const OLLAMA = (process.env.OLLAMA_BASE ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
const API_KEY = process.env.NMQ_API_KEY ?? process.env.BRAINCORE_API_KEY ?? '';
const WORKER_ID = process.env.WORKER_ID ?? 'ruter-worker-1';
const POLL_MS = Number(process.env.POLL_MS ?? 300);
const ONCE = process.env.ONCE === '1';
const INSTANCE = randomUUID();
const TIMEOUT = Number(process.env.RUTER_TIMEOUT_MS || 600000);

// ── SPECIJALNOST: iz zajednicke mape (ruter-mapa.mjs) ──
import { TIPOVI as MODEL_PO_TIPU } from 'file:///C:/Users/Administrator/.dsh/NMQ/ruter-mapa.mjs';

const TYPES = String(process.env.WORKER_TYPES ?? Object.keys(MODEL_PO_TIPU).join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const log = (msg, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), worker: WORKER_ID, msg, ...extra }));

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(API_KEY ? { 'x-api-key': API_KEY } : {}), ...(opts.headers || {}) },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
}

// ── poziv lokalnog modela ──
async function pozoviModel(model, prompt, { sys, json, max } = {}) {
  const t0 = Date.now();
  if (model === 'bge-m3') {
    const r = await fetch(`${OLLAMA}/api/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: prompt }), signal: AbortSignal.timeout(TIMEOUT),
    });
    const d = await r.json();
    return { text: JSON.stringify({ embedding_dim: (d.embeddings?.[0] || []).length }), ms: Date.now() - t0, tok: 0 };
  }
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sys || ('Ti si precizan poslovni asistent. Odgovaras kratko i tacno.'
          + (json ? ' Vrati ISKLJUCIVO validan JSON.' : '')) },
        { role: 'user', content: prompt },
      ],
      stream: false,
      options: { temperature: 0.2, num_predict: max ?? 800 },
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const d = await r.json();
  return { text: String(d?.message?.content || '').trim(), ms: Date.now() - t0, tok: d?.eval_count || 0 };
}

// ── obrada jednog zadatka ──
async function obradi(task) {
  const model = MODEL_PO_TIPU[task.type];
  if (!model) return { ok: false, error: `nema modela za tip "${task.type}"` };
  const p = task.payload || task.data || {};
  const prompt = String(p.prompt ?? p.tekst ?? p.text ?? p.zadatak ?? '');
  if (!prompt) return { ok: false, error: 'zadatak nema prompt/tekst' };
  try {
    const r = await pozoviModel(model, prompt, { sys: p.sys, json: p.json === true, max: p.max });
    log('zadatak_ok', { type: task.type, model, ms: r.ms, tok: r.tok });
    return { ok: true, result: { model, text: r.text, ms: r.ms, tok: r.tok } };
  } catch (e) {
    log('zadatak_greska', { type: task.type, model, error: e.message });
    return { ok: false, error: e.message };
  }
}

// ── roj: claim / done ──
async function claim() {
  const r = await jsonFetch(`${API}/v1/worker/claim`, {
    method: 'POST',
    body: JSON.stringify({ types: TYPES, workerId: WORKER_ID, instanceId: INSTANCE, leaseMs: 60000 }),
  });
  if (r.status === 204 || !r.body?.task) return null;
  if (!r.ok) throw new Error(`claim ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
  return r.body.task;
}

async function done(task, outcome, ms) {
  await jsonFetch(`${API}/v1/worker/done`, {
    method: 'POST',
    body: JSON.stringify({
      taskId: task.id, attempt: task.attempt, workerId: WORKER_ID, instanceId: INSTANCE,
      ok: outcome.ok, result: outcome.result ?? null, error: outcome.error ?? null, ms,
    }),
  });
}

// ── test bez roja ──
async function probaj(zadatak) {
  // sam odaberi tip po kljucnoj rijeci (isto kao ruter.mjs)
  let tip = 'ai-tekst';
  const t = zadatak.toLowerCase();
  if (/klasifikuj|kategorij/.test(t)) tip = 'ai-klasifikuj';
  else if (/prevedi/.test(t)) tip = 'ai-prevedi';
  else if (/sql|regex|funkcij|kod|upit/.test(t)) tip = 'ai-kod';
  else if (/dokaz|matematik|logik|prost broj/.test(t)) tip = 'ai-logika';
  else if (/objasni|dokumentuj/.test(t)) tip = 'ai-objasni';
  else if (/analiziraj|izvuci|nadji/.test(t)) tip = 'ai-analiziraj';
  const model = MODEL_PO_TIPU[tip];
  console.log(`  tip=${tip}  model=${model}`);
  const r = await pozoviModel(model, zadatak);
  console.log(`  (${(r.ms / 1000).toFixed(1)}s · ${r.tok} tok)`);
  console.log('  -> ' + r.text.slice(0, 400));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--probaj') return probaj(argv.slice(1).join(' '));
  if (argv[0] === '--modeli') {
    for (const [t, m] of Object.entries(MODEL_PO_TIPU)) console.log('  ' + t.padEnd(16) + ' -> ' + m);
    return;
  }

  log('worker_start', { api: API, ollama: OLLAMA, types: TYPES, instance: INSTANCE });
  let zadnjiPrazan = 0;
  for (;;) {
    let task;
    try { task = await claim(); } catch (e) { log('claim_error', { error: e.message }); await new Promise((r) => setTimeout(r, 2000)); continue; }
    if (!task) {
      zadnjiPrazan++;
      if (zadnjiPrazan % 100 === 0) log('worker_loop', { pollMs: POLL_MS, praznih: zadnjiPrazan });
      if (ONCE) { log('once_gotovo'); return; }
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    zadnjiPrazan = 0;
    const t0 = Date.now();
    const outcome = await obradi(task);
    await done(task, outcome, Date.now() - t0);
    if (ONCE) { log('once_gotovo'); return; }
  }
}

main().catch((e) => { console.error('ruter-worker: ' + e.message); process.exit(1); });
