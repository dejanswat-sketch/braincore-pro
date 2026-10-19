#!/usr/bin/env node
/**
 * Ulazi u kurs "Osnovna obuka" na obuke.biznisoft.com i snima materijal:
 * spisak lekcija, video linkove i snimke ekrana svake lekcije.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CRED = 'E:\\NMQ-PROGRAMI\\NMQ-CREDENTIALS\\NMQ_SAJTOVI_LOZINKE.txt';
const OUT = 'E:\\NMQ-PROGRAMI\\nmq-robot\\docs\\biznisoft\\obuke';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const PORTAL = 'https://obuke.biznisoft.com/';
const KURS = 'https://obuke.biznisoft.com/obuka/osnovna-obuka-l-19-08-2026/';

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
const ch = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profil}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1500,1100',
  PORTAL], { detached: true, stdio: 'ignore' });
ch.unref();
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
const cmd = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; cek.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expr) => (await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
const snimi = async (ime) => {
  const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, ime), Buffer.from(r.data, 'base64'));
  console.log('  snimak:', ime);
};
await cmd('Page.enable'); await cmd('Runtime.enable'); await sleep(2500);

// prijava
await evalJs(`(() => {
  const u = document.querySelector('input[type="email"], input[type="text"]');
  const p = document.querySelector('input[type="password"]');
  if (!u || !p) return 'vec prijavljen ili nema forme';
  u.value = ${JSON.stringify(kred.user)}; u.dispatchEvent(new Event('input',{bubbles:true}));
  p.value = ${JSON.stringify(kred.pass)}; p.dispatchEvent(new Event('input',{bubbles:true}));
  const b = document.querySelector('button[type="submit"], button'); if (b) b.click();
  return 'prijavljen';
})()`);
await sleep(5000);

// otvori kurs
await cmd('Page.navigate', { url: KURS });
await sleep(5000);
await snimi('02-kurs.png');

const kursInfo = await evalJs(`(() => {
  const t = document.body.innerText;
  const lekcije = [...document.querySelectorAll('a')]
    .map(a => ({ tekst: (a.textContent||'').trim(), href: a.href }))
    .filter(x => /lekcij|kviz|test|obuka|video|tema/i.test(x.href + ' ' + x.tekst) && x.tekst.length > 2);
  const videi = [...document.querySelectorAll('video, iframe, source')].map(v => ({ tag: v.tagName, src: v.src || v.getAttribute('data-src') || '' }));
  return JSON.stringify({ naslov: document.title, tekst: t.slice(0, 4000), lekcije, videi }, null, 1);
})()`);
fs.writeFileSync(path.join(OUT, 'kurs.json'), kursInfo || '{}', 'utf8');
console.log('--- KURS ---');
console.log((kursInfo || '').slice(0, 3500));

ws.close();
console.log('\nsnimci u:', OUT);
