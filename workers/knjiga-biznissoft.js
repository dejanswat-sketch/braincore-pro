#!/usr/bin/env node
/**
 * FAZA 2 — knjiga-biznissoft worker.
 *
 * Spoljni radnik koji uzima `knjiga-*` taskove iz BRAINCORE roja (durable) i za svaki pravi
 * PRIPREMU ZA BIZNISOFT u programu Knjigovođa Pro (bridge na 127.0.0.1:5055):
 *   ulazna kalkulacija → status „spremno za BizniSoft" → izvoz u outbox → (opciono) SEF/eFakture.
 *
 * Ne dira zamrznuti `releases/v1.9.2`: 3 node-a ostaju, worker radi SPOLJA preko HTTP API-ja.
 *
 * Env:
 *   BRAINCORE_API   (default https://api.braincore.pro)
 *   BRIDGE_URL      (default http://127.0.0.1:5055)
 *   WORKER_ID       (default knjiga-worker-1)
 *   WORKER_TYPES    (default knjiga-ingest,knjiga-ocr,knjiga-konto,knjiga-pdv,knjiga-reconcile,knjiga-efaktura)
 *   POLL_MS         (default 200)
 *   ONCE            (ako je 1 — obradi dostupno pa izađi; za testove)
 */
import { randomUUID } from 'node:crypto';

const API = (process.env.BRAINCORE_API ?? 'https://api.braincore.pro').replace(/\/$/, '');
const BRIDGE = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:5055').replace(/\/$/, '');
const WORKER_ID = process.env.WORKER_ID ?? 'knjiga-worker-1';
const TYPES = String(
  process.env.WORKER_TYPES ??
    'knjiga-ingest,knjiga-ocr,knjiga-konto,knjiga-pdv,knjiga-reconcile,knjiga-efaktura',
).split(',').map((s) => s.trim()).filter(Boolean);
const POLL_MS = Number(process.env.POLL_MS ?? 200);
const ONCE = process.env.ONCE === '1';
const INSTANCE = randomUUID();

const log = (msg, extra) => console.log(JSON.stringify({ ts: new Date().toISOString(), worker: WORKER_ID, msg, ...extra }));

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
}

// ── bridge (Knjigovođa Pro) ─────────────────────────────────────────────────
const bridge = {
  status: () => jsonFetch(`${BRIDGE}/api/v1/status`),
  clients: () => jsonFetch(`${BRIDGE}/api/v1/clients`),
  createInvoice: (data) => jsonFetch(`${BRIDGE}/api/v1/invoices`, { method: 'POST', body: JSON.stringify(data) }),
  updateInvoice: (id, data) => jsonFetch(`${BRIDGE}/api/v1/invoices/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  outboxWrite: (data) => jsonFetch(`${BRIDGE}/api/v1/outbox/write`, { method: 'POST', body: JSON.stringify(data) }),
  sefSync: (data = {}) => jsonFetch(`${BRIDGE}/api/v1/sef/sync`, { method: 'POST', body: JSON.stringify(data) }),
};

// ── obrađivači po tipu taska ────────────────────────────────────────────────
/**
 * Svaki obrađivač dobija `payload` i vraća `{ ok, result }`.
 * Suština je „ulazna kalkulacija U obradi": dokument uđe, dobije konta/PDV, spremi se za BizniSoft.
 */
const HANDLERS = {
  // 1) Ulazna faktura ulazi u sistem (iz emaila, SEF-a, papira)
  'knjiga-ingest': async (p) => {
    const inv = await bridge.createInvoice({
      pib: p.pib,
      broj: p.broj ?? p.invoiceNumber,
      dobavljac: p.dobavljac ?? p.partner ?? p.supplier,
      neto: p.neto ?? p.amount,
      pdv: p.pdv ?? p.vat,
      bruto: p.bruto,
      datum: p.datum,
      tip: p.tip ?? 'ulazna',
      status: p.status ?? 'Nova',
      izvor: `braincore:${WORKER_ID}`,
    });
    if (!inv.ok) return { ok: false, error: `bridge invoices: ${inv.status} ${JSON.stringify(inv.body).slice(0, 160)}` };
    return { ok: true, result: { fakturaId: inv.body?.data?.id, status: inv.body?.data?.status, stage: 'ingest' } };
  },

  // 2) OCR / parsiranje priloženog dokumenta → stavke
  'knjiga-ocr': async (p) => {
    const tekst = String(p.tekst ?? p.text ?? '');
    const broj = (tekst.match(/(?:faktura|ra[cč]un|invoice)\s*(?:br\.?|broj|no\.?)?\s*([A-Za-z0-9\-\/]+)/i) ?? [])[1] ?? null;
    const pib = (tekst.match(/\bPIB[:\s]*(\d{9})\b/i) ?? [])[1] ?? p.pib ?? null;
    const iznos = (tekst.match(/([\d.]+,\d{2})/) ?? [])[1] ?? null;
    if (!broj && !pib && !iznos) return { ok: false, error: 'OCR nije našao ni broj ni PIB ni iznos' };
    return { ok: true, result: { broj, pib, iznos, stage: 'ocr', chars: tekst.length } };
  },

  // 3) Predlog konta (konto learning radi u programu)
  'knjiga-konto': async (p) => {
    if (!p.fakturaId) return { ok: false, error: 'fakturaId obavezan za konto' };
    const konto = p.konto ?? p.predlog ?? '4700'; // ulazne fakture — dobavljači (fallback)
    const r = await bridge.updateInvoice(p.fakturaId, { konto, status: 'pripremljeno' });
    if (!r.ok) return { ok: false, error: `bridge patch: ${r.status}` };
    return { ok: true, result: { fakturaId: p.fakturaId, konto, stage: 'konto' } };
  },

  // 4) PDV kontrola
  'knjiga-pdv': async (p) => {
    const neto = Number(p.neto ?? 0);
    const pdv = Number(p.pdv ?? 0);
    const stopa = neto > 0 ? Math.round((pdv / neto) * 100) : null;
    const ok = stopa === 20 || stopa === 10 || stopa === 0;
    return {
      ok: true,
      result: { neto, pdv, stopa, stopaValidna: ok, ocekivano: [20, 10, 0], stage: 'pdv' },
      warning: ok ? undefined : `PDV stopa ${stopa}% nije standardna (20/10/0)`,
    };
  },

  // 5) Uparivanje sa izvodom banke
  'knjiga-reconcile': async (p) => {
    const r = await jsonFetch(`${BRIDGE}/api/v1/bank/reconcile`, {
      method: 'POST',
      body: JSON.stringify({ klijent_id: p.klijentId, faktura_id: p.fakturaId }),
    });
    if (!r.ok) return { ok: false, error: `bridge reconcile: ${r.status}` };
    return { ok: true, result: { ...(r.body?.data ?? {}), stage: 'reconcile' } };
  },

  // 6) PRIPREMA ZA BIZNISOFT: „ulazna kalkulacija" + izvoz fajla u outbox
  'knjiga-biznissoft': async (p) => {
    const r = await jsonFetch(`${BRIDGE}/api/v1/outbox/write`, {
      method: 'POST',
      body: JSON.stringify({
        pib: p.pib,
        filename: p.filename ?? `BizniSoft_KUF_${new Date().toISOString().slice(0, 10)}.csv`,
        content: p.content ?? '',
      }),
    });
    if (!r.ok) return { ok: false, error: `bridge outbox: ${r.status}` };
    return { ok: true, result: { putanja: r.body?.data?.path, stage: 'biznisoft-kalkulacija' } };
  },

  // 7) eFakture preko SEF-a (automatizacija u programu)
  'knjiga-efaktura': async (p) => {
    const r = await bridge.sefSync({ pib: p.pib, klijent_id: p.klijentId, faktura_id: p.fakturaId, dry_run: p.dryRun ?? false });
    if (!r.ok) return { ok: false, error: `SEF sync: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}` };
    return { ok: true, result: { ...(r.body?.data ?? {}), stage: 'efaktura' } };
  },
};

// ── BRAINCORE: claim / done ─────────────────────────────────────────────────
async function claim() {
  const r = await jsonFetch(`${API}/v1/worker/claim`, {
    method: 'POST',
    body: JSON.stringify({ types: TYPES, workerId: WORKER_ID, instanceId: INSTANCE, leaseMs: 30000 }),
  });
  if (r.status === 204 || !r.body?.task) return null;
  if (!r.ok) throw new Error(`claim ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
  return r.body.task;
}

async function done(task, outcome, ms) {
  await jsonFetch(`${API}/v1/worker/done`, {
    method: 'POST',
    body: JSON.stringify({
      taskId: task.id,
      attempt: task.attempt,
      workerId: WORKER_ID,
      instanceId: INSTANCE,
      ok: outcome.ok,
      result: outcome.result ?? null,
      error: outcome.error ?? null,
      ms,
    }),
  });
}

// ── petlja ──────────────────────────────────────────────────────────────────
const stats = { claimed: 0, ok: 0, failed: 0, unknownType: 0, lat: [] };

async function tick() {
  let task;
  try { task = await claim(); } catch (e) { log('claim_error', { error: e.message }); return false; }
  if (!task) return false;

  stats.claimed += 1;
  const t0 = Date.now();
  const handler = HANDLERS[task.type];
  let outcome;
  if (!handler) {
    stats.unknownType += 1;
    outcome = { ok: false, error: `nema obrađivača za tip "${task.type}"` };
  } else {
    try { outcome = await handler(task.payload ?? {}); } catch (e) { outcome = { ok: false, error: e.message }; }
  }
  const ms = Date.now() - t0;
  stats.lat.push(ms);
  if (outcome.ok) stats.ok += 1; else stats.failed += 1;
  await done(task, outcome, ms);
  log(outcome.ok ? 'task_done' : 'task_failed', { taskId: task.id, type: task.type, ms, result: outcome.result ?? outcome.error });
  return true;
}

// ── start ───────────────────────────────────────────────────────────────────
const st = await bridge.status().catch((e) => ({ ok: false, error: e.message }));
if (!st.ok) {
  log('bridge_unavailable', { bridge: BRIDGE, error: st.error ?? st.status });
  process.exit(2);
}
log('worker_start', { api: API, bridge: BRIDGE, types: TYPES, bridgeClients: st.body?.data?.clients ?? null });

if (ONCE) {
  let n = 0;
  while (await tick()) { n += 1; if (n > 500) break; }
  const sorted = [...stats.lat].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
  log('worker_once_done', { ...stats, lat: undefined, p95Ms: p95 });
  process.exit(0);
}

let stop = false;
process.on('SIGINT', () => { stop = true; });
process.on('SIGTERM', () => { stop = true; });
log('worker_loop', { pollMs: POLL_MS });
while (!stop) {
  const did = await tick();
  if (!did) await new Promise((r) => setTimeout(r, POLL_MS));
  if (stats.claimed && stats.claimed % 100 === 0 && stats.lat.length >= 100) {
    const sorted = [...stats.lat].sort((a, b) => a - b);
    log('progress', {
      claimed: stats.claimed, ok: stats.ok, failed: stats.failed,
      p50Ms: sorted[Math.floor(sorted.length * 0.5)],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    });
    stats.lat = [];
  }
}
log('worker_stop', { ...stats, lat: undefined });
