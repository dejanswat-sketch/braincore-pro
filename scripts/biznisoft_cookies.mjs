#!/usr/bin/env node
/** Uzima sesijske kolačiće iz prijavljenog Chroma (za download videa). */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const PROFIL = path.join(process.env.TEMP || '.', 'bs-obuka-profil');
const IZLAZ = 'E:\\NMQ-PROGRAMI\\nmq-robot\\docs\\biznisoft\\obuke\\cookies.txt';

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
await cmd('Network.enable');
await sleep(2000);
const r = await cmd('Network.getCookies', { urls: ['https://obuke.biznisoft.com/'] });
const kolacici = (r.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
fs.writeFileSync(IZLAZ, kolacici, 'utf8');
console.log(`kolačića: ${(r.cookies || []).length} | imena: ${(r.cookies || []).map((c) => c.name).join(', ')}`);
console.log('upisano u cookies.txt (sadržaj sakriven)');
ws.close();
