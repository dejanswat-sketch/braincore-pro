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
// TRAFFIC=n → šalje ~n taskova/s na API tokom snimanja (da roj bude ŽIV u kadru)
const TRAFFIC = Number(process.env.TRAFFIC ?? 0);
const API = (process.env.BRAINCORE_API ?? 'https://api.braincore.pro').replace(/\/$/, '');
// SCENES="0:https://braincore.pro,18:https://live.braincore.pro/live" — navigacija u toku snimanja
const SCENES = String(process.env.SCENES ?? '').split(',').filter(Boolean).map((s) => {
  const i = s.indexOf(':');
  return { t: Number(s.slice(0, i)), url: s.slice(i + 1), done: false };
});
// CAPTIONS="2:tekst|18:drugi tekst" — titl na dnu kadra (voiceover nije moguć, titl jeste)
const CAPTIONS = String(process.env.CAPTIONS ?? '').split('|').filter(Boolean).map((s) => {
  const i = s.indexOf(':');
  return { t: Number(s.slice(0, i)), text: s.slice(i + 1), done: false };
});
let curCaption = '';

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
let sent = 0, ok = 0;

const captionJs = (text) => `(() => {
  let el = document.getElementById('__cap');
  if (!el) {
    el = document.createElement('div'); el.id = '__cap';
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;padding:18px 26px;z-index:2147483647;'
      + 'background:linear-gradient(180deg,rgba(2,6,12,0),rgba(2,6,12,.92));color:#eaf4ff;'
      + 'font:600 26px/1.35 Inter,"Space Grotesk",system-ui,sans-serif;text-align:center;letter-spacing:.2px;'
      + 'text-shadow:0 2px 18px rgba(0,0,0,.9);pointer-events:none;transition:opacity .3s';
    document.body.appendChild(el);
  }
  el.innerHTML = ${JSON.stringify(text)};
})()`;

async function injectCaption(text) {
  if (!text) return;
  curCaption = text;
  try { await send('Runtime.evaluate', { expression: captionJs(text) }); } catch { }
}

const t0 = Date.now();
while ((Date.now() - t0) / 1000 < SECONDS) {
  const el = (Date.now() - t0) / 1000;
  // scene: navigacija u toku snimanja (npr. sajt → live dashboard)
  for (const sc of SCENES) {
    if (!sc.done && el >= sc.t) {
      sc.done = true;
      console.log(`  t+${el.toFixed(1)}s → scena ${sc.url}`);
      await send('Page.navigate', { url: sc.url });
      await sleep(3000);
      if (curCaption) await injectCaption(curCaption); // titl se izgubio navigacijom — vrati ga
    }
  }
  // titlovi
  for (const c of CAPTIONS) {
    if (!c.done && el >= c.t) { c.done = true; console.log(`  t+${el.toFixed(1)}s titl: ${c.text.slice(0, 48)}`); await injectCaption(c.text); }
  }
  if (TRAFFIC > 0) {
    const want = Math.round(TRAFFIC * el) - sent;
    for (let i = 0; i < want; i++) {
      sent++;
      fetch(`${API}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'support.ticket', payload: { text: `demo task #${sent}` } }),
      }).then((r) => { if (r.ok) ok++; }).catch(() => { });
    }
  }
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
console.log(`frejmova sirovo: ${frames.length} · taskova poslano: ${sent} (prihvaćeno ${ok})`);

// ── uzorkuj na ciljni fps da prenos ne bude ogroman ─────────────────────────
const targetFps = Math.min(FPS, 20);
const step = Math.max(1, Math.round(frames.length / (SECONDS * targetFps)));
const sampled = frames.filter((_, i) => i % step === 0);
console.log(`uzorkovano: ${sampled.length} frejmova (svaki ${step}., cilj ${targetFps} fps)`);

// still frejm (za dokaz/provjeru sadržaja) — frejmovi su već JPEG
try {
  const stillAt = Number(process.env.STILL_AT ?? Math.floor(sampled.length * 0.6));
  const still = Buffer.from(sampled[Math.min(stillAt, sampled.length - 1)], 'base64');
  fs.writeFileSync(outFile.replace(/\.(webm|mp4)$/i, '.still.jpg'), still);
  console.log('still:', outFile.replace(/\.(webm|mp4)$/i, '.still.jpg'));
} catch (e) { console.log('still greška:', e.message); }

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

// Video ide DIREKTNO na disk kroz browser download (base64 kroz CDP je prevelik za duge snimke)
const dlDir = path.resolve(path.dirname(path.resolve(outFile)), '.recdl');
fs.mkdirSync(dlDir, { recursive: true });
for (const f of fs.readdirSync(dlDir)) { try { fs.unlinkSync(path.join(dlDir, f)); } catch { } }
try {
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });
} catch {
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
}
const expr = `(async () => {
  const cv = document.getElementById('c'); const ctx = cv.getContext('2d');
  const fps = ${fps};
  const MIMES = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mime = MIMES.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || 'video/webm';
  const stream = cv.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3000000 });
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
  await new Promise((r) => setTimeout(r, 500));
  rec.stop();
  const blob = await done;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // snimi kroz <a download> → CDP download dir (bez ogromnog base64 kroz WebSocket)
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = ${JSON.stringify(path.basename(outFile))};
  document.body.appendChild(a); a.click();
  await new Promise((r) => setTimeout(r, 1200));
  return JSON.stringify({ mime, size: bytes.length, head: String.fromCharCode(...bytes.subarray(0, 8)) });
})()`;
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 300000 });
if (r.exceptionDetails) { console.error('enkodiranje palo:', JSON.stringify(r.exceptionDetails).slice(0, 400)); process.exit(1); }
const parsed = JSON.parse(r.result.value);
// sačekaj da download stigne na disk
let got = null;
for (let i = 0; i < 60; i++) {
  const cand = fs.readdirSync(dlDir).filter((f) => !f.endsWith('.crdownload'));
  if (cand.length) { got = path.join(dlDir, cand[0]); break; }
  await sleep(500);
}
if (!got) { console.error('download nije stigao u', dlDir); process.exit(1); }
const outPath = parsed.mime.startsWith('video/mp4') ? outFile.replace(/\.webm$/i, '.mp4') : outFile;
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.copyFileSync(got, outPath);
const buf = fs.readFileSync(outPath);
fs.rmSync(dlDir, { recursive: true, force: true });
console.log(`OK: ${outPath} (${(buf.length / 1048576).toFixed(2)} MB, ${sampled.length} frejmova, ~${fps} fps, ${parsed.mime})`);

try { proc.kill(); } catch { }
process.exit(0);
