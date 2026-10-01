#!/usr/bin/env node
/**
 * Snima VIDEO sa žive stranice preko CDP screencast-a + browser MediaRecorder (WebM).
 * BEZ npm zavisnosti: Node >= 22 (globalni WebSocket + fetch) + lokalni Chrome/Edge.
 *
 *   node scripts/record-video.mjs <url> <out.webm> [sekunde] [killNaSekundi]
 *
 * Primjer (KILL NODE demo):
 *   node scripts/record-video.mjs https://live.braincore.pro/live docs/kill-node.webm 24 4
 *
 * Tok:
 *   1. digne headless Chrome sa --remote-debugging-port
 *   2. Page.startScreencast → skuplja JPEG frejmove sa žive strane
 *   3. u zadatom trenutku pozove chaos kill API
 *   4. frejmove ubaci u <canvas> i snimi MediaRecorder-om (VP9/WebM) → fajl
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, outFile, secArg = '20', killArg = '0'] = process.argv.slice(2);
if (!url || !outFile) {
  console.error('Upotreba: node scripts/record-video.mjs <url> <out.webm> [sekunde] [killNaSekundi]');
  process.exit(2);
}
const SECONDS = Number(secArg);
const KILL_AT = Number(killArg);
const FPS = 20;

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browser = CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) { console.error('Nema Chrome/Edge.'); process.exit(2); }
console.log('browser:', browser);

const PORT = 9411 + (process.pid % 300);
const profile = path.join(os.tmpdir(), 'rec-' + Date.now());
const proc = spawn(browser, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--window-size=1280,720',
  '--hide-scrollbars', '--mute-audio',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrlForPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const pg = list.find((t) => t.type === 'page');
      if (pg?.webSocketDebuggerUrl) return pg.webSocketDebuggerUrl;
    } catch { }
    await sleep(300);
  }
  throw new Error('CDP endpoint nije odgovorio');
}

let id = 0;
const pending = new Map();
let ws;
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const listeners = [];
const on = (fn) => listeners.push(fn);

const wsUrl = await wsUrlForPage();
ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  } else if (m.method) {
    for (const fn of listeners) fn(m);
  }
};

await send('Page.enable');
await send('Runtime.enable');
console.log('navigating...', url);
await send('Page.navigate', { url });
await sleep(6000); // da se WS poveže i nacrta prvi frejm

const frames = [];
let ackSession = null;
on((m) => {
  if (m.method === 'Page.screencastFrame') {
    frames.push(m.params.data);
    ackSession = m.params.sessionId;
    ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } }));
  }
});

await send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
console.log(`snimam ${SECONDS}s (kill na ${KILL_AT}s)...`);

let killed = false;
const t0 = Date.now();
while ((Date.now() - t0) / 1000 < SECONDS) {
  const el = (Date.now() - t0) / 1000;
  if (!killed && KILL_AT > 0 && el >= KILL_AT) {
    killed = true;
    console.log(`  t+${el.toFixed(1)}s → KILL NODE`);
    try {
      const r = await fetch('https://api.braincore.pro/v1/chaos/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.NMQ_API_KEY ?? '' },
        body: JSON.stringify({ random: true }),
      });
      console.log('  kill HTTP', r.status, (await r.text()).slice(0, 120));
    } catch (e) { console.log('  kill greška:', e.message); }
  }
  await sleep(200);
}
await send('Page.stopScreencast');
console.log('frejmova sirovo:', frames.length);

// ── uzorkuj na ciljni fps da prenos ne bude ogroman ─────────────────────────
const targetFps = Math.min(FPS, 20);
const step = Math.max(1, Math.round(frames.length / (SECONDS * targetFps)));
const sampled = frames.filter((_, i) => i % step === 0);
console.log(`uzorkovano: ${sampled.length} frejmova (svaki ${step}., cilj ${targetFps} fps)`);

// ── enkodiranje u WebM preko MediaRecorder-a u browseru ──────────────────────
await send('Page.navigate', { url: 'about:blank' });
await sleep(800);
await send('Runtime.evaluate', { expression: `document.body.innerHTML='<canvas id="c" width="1280" height="720" style="width:1280px;height:720px"></canvas>';window.__f=[];` });
await sleep(300);

// frejmove guramo u KOMADIMA (jedan ogroman evaluate bi blokirao CDP)
const CHUNK = 25;
for (let i = 0; i < sampled.length; i += CHUNK) {
  const part = sampled.slice(i, i + CHUNK);
  await send('Runtime.evaluate', { expression: `window.__f.push(...${JSON.stringify(part)});` });
  if (i % (CHUNK * 8) === 0) console.log(`  preneseno ${Math.min(i + CHUNK, sampled.length)}/${sampled.length}`);
}

const fps = Math.max(8, Math.min(30, Math.round(sampled.length / SECONDS)));
console.log('fps za enkodiranje:', fps);
const expr = `(async () => {
  const cv = document.getElementById('c'); const ctx = cv.getContext('2d');
  const fps = ${fps};
  const MIMES = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mime = MIMES.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || 'video/webm';
  const stream = cv.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = () => res(new Blob(chunks, { type: mime })); });
  rec.start();
  const frames = window.__f;
  const img = new Image();
  for (let i = 0; i < frames.length; i++) {
    await new Promise((res) => { img.onload = res; img.onerror = res; img.src = 'data:image/jpeg;base64,' + frames[i]; });
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  await new Promise((r) => setTimeout(r, 400));
  rec.stop();
  const blob = await done;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const head = String.fromCharCode(...bytes.subarray(0, 12));
  let s = ''; const CH = 8192;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return JSON.stringify({ mime, head, b64: btoa(s) });
})()`;
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 300000 });
if (r.exceptionDetails) { console.error('enkodiranje palo:', JSON.stringify(r.exceptionDetails).slice(0, 400)); process.exit(1); }
const parsed = JSON.parse(r.result.value);
const buf = Buffer.from(parsed.b64, 'base64');
const outPath = parsed.mime.startsWith('video/mp4') ? outFile.replace(/\.webm$/i, '.mp4') : outFile;
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, buf);
console.log(`OK: ${outPath} (${(buf.length / 1048576).toFixed(2)} MB, ${sampled.length} frejmova, ~${fps} fps, ${parsed.mime})`);

try { proc.kill(); } catch { }
process.exit(0);
