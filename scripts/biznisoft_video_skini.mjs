#!/usr/bin/env node
/** Skida video obuke iz prijavljenog Chroma (download anchor + CDP). */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;
const PROFIL = path.join(process.env.TEMP || '.', 'bs-obuka-profil');
const OUT = 'E:\\NMQ-PROGRAMI\\nmq-robot\\docs\\biznisoft\\obuke';
const VIDEO = 'https://obuke.biznisoft.com/videos/Osnovna%20obuka_19.08.2026.mp4';

fs.mkdirSync(OUT, { recursive: true });
spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFIL}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  'https://obuke.biznisoft.com/nalog/'], { detached: true, stdio: 'ignore' }).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stranica() {
  for (let i = 0; i < 40; i++) {
    try {
      const ls = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = ls.find((x) => x.type === 'page' && /biznisoft/i.test(x.url));
      if (p) return p;
    } catch {}
    await sleep(500);
  }
  throw new Error('nema stranice');
}
const st = await stranica();
const ws = new WebSocket(st.webSocketDebuggerUrl);
let id = 0; const cek = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && cek.has(m.id)) { cek.get(m.id)(m); cek.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
const cmd = (me, pr = {}) => new Promise((res, rej) => {
  const i = ++id; cek.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method: me, params: pr }));
});
const evalJs = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;

await cmd('Page.enable'); await cmd('Runtime.enable'); await sleep(2500);
try {
  await cmd('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT, eventsEnabled: true });
  console.log('download folder postavljen');
} catch (e) { console.log('setDownloadBehavior:', e.message); }

// sesija provera
const sesija = await evalJs(`document.body.innerText.includes('Odjavite se') ? 'prijavljen' : 'NIJE prijavljen'`);
console.log('sesija:', sesija);

// pokreni download iz konteksta stranice
const r = await evalJs(`(() => {
  const a = document.createElement('a');
  a.href = ${JSON.stringify(VIDEO)};
  a.download = 'Osnovna-obuka-19.08.2026.mp4';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  return 'kliknuto: ' + a.href.slice(0, 60);
})()`);
console.log(r);

// čekaj da fajl poraste
let prethodno = 0;
for (let i = 0; i < 60; i++) {
  await sleep(5000);
  const fajlovi = fs.readdirSync(OUT).filter((f) => /\.mp4$/i.test(f) || /\.crdownload$/i.test(f));
  if (fajlovi.length) {
    const f = fajlovi[0];
    const vel = fs.statSync(path.join(OUT, f)).size;
    if (vel !== prethodno) {
      console.log(`  ${f}: ${(vel / 1048576).toFixed(1)} MB`);
      prethodno = vel;
    }
    if (!/\.crdownload$/i.test(f) && vel > 1_000_000) {
      console.log('GOTOVO:', f, `${(vel / 1048576).toFixed(1)} MB`);
      break;
    }
  }
}
ws.close();
console.log('folder:', OUT);
