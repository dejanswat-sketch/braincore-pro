#!/usr/bin/env node
/**
 * Prijava na obuke.biznisoft.com preko Chrome DevTools Protocol.
 * Čita kredencijale iz NMQ store-a (ne ispisuje lozinku).
 *
 * Upotreba: node biznisoft_obuka.mjs [--snimi]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CRED = 'E:\\NMQ-PROGRAMI\\NMQ-CREDENTIALS\\NMQ_SAJTOVI_LOZINKE.txt';
const OUT = 'E:\\NMQ-PROGRAMI\\nmq-robot\\docs\\biznisoft\\obuke';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const URL_PORTAL = 'https://obuke.biznisoft.com/';

fs.mkdirSync(OUT, { recursive: true });

// ── kredencijali za obuke.biznisoft.com ──
function nadjiKredencijale() {
  const t = fs.readFileSync(CRED, 'utf8');
  const blokovi = t.split(/\nSAJT:\s*/).slice(1);
  for (const b of blokovi) {
    const prva = b.split('\n')[0] || '';
    if (!/obuke\.biznisoft\.com/i.test(prva)) continue;
    const u = /USER:\s*(\S+)/.exec(b);
    const p = /PASS:\s*(\S+)/.exec(b);
    if (u && p) return { sajt: prva.trim(), user: u[1], pass: p[1] };
  }
  return null;
}

const kred = nadjiKredencijale();
if (!kred) {
  console.error('Nema kredencijala za obuke.biznisoft.com u store-u.');
  process.exit(1);
}
console.log(`kredencijali nađeni: ${kred.user} (šifra ${kred.pass.length} znakova — sakrivena)`);

// ── pokreni Chrome sa debug portom ──
const profil = path.join(process.env.TEMP || '.', 'bs-obuka-profil');
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profil}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1400,1000',
  URL_PORTAL,
], { detached: true, stdio: 'ignore' });
chrome.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nadjiStranicu() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const ls = await r.json();
      const p = ls.find((x) => x.type === 'page' && /obuke\.biznisoft/i.test(x.url));
      if (p) return p;
    } catch { /* još se diže */ }
    await sleep(500);
  }
  throw new Error('Chrome se nije pokrenuo / nema stranice');
}

const stranica = await nadjiStranicu();
console.log('stranica:', stranica.url);

const ws = new WebSocket(stranica.webSocketDebuggerUrl);
let id = 0;
const cekajuci = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && cekajuci.has(m.id)) {
    cekajuci.get(m.id)(m);
    cekajuci.delete(m.id);
  }
});
await new Promise((r) => ws.addEventListener('open', r));

function cmd(method, params = {}) {
  const myId = ++id;
  return new Promise((res, rej) => {
    cekajuci.set(myId, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}

async function evalJs(expr) {
  const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
}

async function snimi(ime) {
  const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const p = path.join(OUT, ime);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('  snimak:', ime);
  return p;
}

await cmd('Page.enable');
await cmd('Runtime.enable');
await sleep(2500);

// ── prijava ──
console.log('popunjavam formu...');
const popunjeno = await evalJs(`(() => {
  const u = document.querySelector('input[type="email"], input[name*="mail" i], input[name*="user" i], input[id*="mail" i], input[type="text"]');
  const p = document.querySelector('input[type="password"]');
  if (!u || !p) return 'nema polja: ' + (u?'':'user ') + (p?'':'pass');
  u.focus(); u.value = ${JSON.stringify(kred.user)};
  u.dispatchEvent(new Event('input', {bubbles:true}));
  u.dispatchEvent(new Event('change', {bubbles:true}));
  p.focus(); p.value = ${JSON.stringify(kred.pass)};
  p.dispatchEvent(new Event('input', {bubbles:true}));
  p.dispatchEvent(new Event('change', {bubbles:true}));
  const b = document.querySelector('button[type="submit"], input[type="submit"], button');
  if (b) { b.click(); return 'popunjeno i kliknuto: ' + (b.textContent||'').trim().slice(0,20); }
  return 'popunjeno, nema dugmeta';
})()`);
console.log(' ', popunjeno);

await sleep(6000);
await cmd('Page.navigate', { url: URL_PORTAL });
await sleep(4000);
await snimi('01-nakon-prijave.png');

// ── šta je na portalu ──
const pregled = await evalJs(`(() => {
  const t = document.body ? document.body.innerText.slice(0, 3000) : '';
  const linkovi = [...document.querySelectorAll('a')].map(a => (a.textContent||'').trim()+' -> '+a.href).filter(x=>x.length>4).slice(0,40);
  const video = [...document.querySelectorAll('video, iframe')].map(v => v.tagName+': '+(v.src||'')).slice(0,20);
  return JSON.stringify({ naslov: document.title, tekst: t, linkovi, video }, null, 1);
})()`);
fs.writeFileSync(path.join(OUT, 'pregled-portala.json'), pregled || '{}', 'utf8');
console.log('--- PREGLED ---');
console.log((pregled || '').slice(0, 2000));

ws.close();
console.log('\nsnimci u:', OUT);
