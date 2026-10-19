#!/usr/bin/env node
/** Otvara lekciju (snimak) i pronalazi izvor videa. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CRED = 'E:\\NMQ-PROGRAMI\\NMQ-CREDENTIALS\\NMQ_SAJTOVI_LOZINKE.txt';
const OUT = 'E:\\NMQ-PROGRAMI\\nmq-robot\\docs\\biznisoft\\obuke';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;
const PORTAL = 'https://obuke.biznisoft.com/';
const LEKCIJA = 'https://obuke.biznisoft.com/obuka/osnovna-obuka-l-19-08-2026/snimak/osnovna-obuka-l-19-08-2026/';

fs.mkdirSync(OUT, { recursive: true });
function kredencijali() {
  const t = fs.readFileSync(CRED, 'utf8');
  for (const b of t.split(/\nSAJT:\s*/).slice(1)) {
    if (!/obuke\.biznisoft\.com/i.test(b.split('\n')[0] || '')) continue;
    const u = /USER:\s*(\S+)/.exec(b), p = /PASS:\s*(\S+)/.exec(b);
    if (u && p) return { user: u[1], pass: p[1] };
  }
  throw new Error('nema kredencijala');
}
const kred = kredencijali();
const profil = path.join(process.env.TEMP || '.', 'bs-obuka-profil');
spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profil}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1500,1100',
  PORTAL], { detached: true, stdio: 'ignore' }).unref();
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
let id = 0; const cek = new Map(); const mreza = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && cek.has(m.id)) { cek.get(m.id)(m); cek.delete(m.id); }
  if (m.method === 'Network.responseReceived') {
    const u = m.params?.response?.url || '';
    const ct = m.params?.response?.headers?.['content-type'] || m.params?.response?.mimeType || '';
    if (/\.(mp4|m3u8|ts|webm|mov)(\?|$)/i.test(u) || /video/i.test(ct)) mreza.push({ url: u, ct });
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const cmd = (me, pr = {}) => new Promise((res, rej) => {
  const i = ++id; cek.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method: me, params: pr }));
});
const evalJs = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
const snimi = async (ime) => {
  const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, ime), Buffer.from(r.data, 'base64'));
  console.log('  snimak:', ime);
};
await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('Network.enable'); await sleep(2500);

await evalJs(`(() => {
  const u = document.querySelector('input[type="email"], input[type="text"]');
  const p = document.querySelector('input[type="password"]');
  if (!u || !p) return 'ok';
  u.value = ${JSON.stringify(kred.user)}; u.dispatchEvent(new Event('input',{bubbles:true}));
  p.value = ${JSON.stringify(kred.pass)}; p.dispatchEvent(new Event('input',{bubbles:true}));
  const b = document.querySelector('button[type="submit"], button'); if (b) b.click();
  return 'prijavljen';
})()`);
await sleep(5000);

await cmd('Page.navigate', { url: LEKCIJA });
await sleep(8000);
await snimi('03-lekcija.png');

const info = await evalJs(`(() => {
  const v = [...document.querySelectorAll('video')].map(x => ({ src: x.src, currentSrc: x.currentSrc, poster: x.poster, trajanje: x.duration }));
  const src = [...document.querySelectorAll('source')].map(s => ({ src: s.src, type: s.type }));
  const ifr = [...document.querySelectorAll('iframe')].map(f => f.src);
  const a = [...document.querySelectorAll('a[href]')].map(x => x.href).filter(h => /\\.(mp4|pdf|zip|docx?)(\\?|$)/i.test(h));
  return JSON.stringify({ naslov: document.title, video: v, source: src, iframe: ifr, fajlovi: a, tekst: document.body.innerText.slice(0,1500) }, null, 1);
})()`);
fs.writeFileSync(path.join(OUT, 'lekcija.json'), info || '{}', 'utf8');
console.log('--- LEKCIJA ---');
console.log((info || '').slice(0, 2000));
console.log('--- MREŽA (video) ---');
console.log(JSON.stringify([...new Map(mreza.map(x => [x.url, x])).values()], null, 1).slice(0, 2500));
fs.writeFileSync(path.join(OUT, 'mreza-video.json'), JSON.stringify(mreza, null, 1), 'utf8');
ws.close();
