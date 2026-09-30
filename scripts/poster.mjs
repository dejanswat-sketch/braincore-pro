#!/usr/bin/env node
/**
 * Renderuje HTML dokument (poster arhitekture) u PNG preko instaliranog Edge/Chrome headless.
 *
 *   node scripts/poster.mjs
 *   node scripts/poster.mjs docs/35-SWARM-ARHITEKTURA-VIZUAL.html docs/35-swarm-arhitektura.png 1600 1250
 *
 * Nema npm zavisnosti: koristi `msedge`/`chrome` koji su već na sistemu. Ako browser nije nađen,
 * ispisuje putanju do HTML-a (poster se uvijek može otvoriti ručno).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [, , htmlArg = 'docs/35-SWARM-ARHITEKTURA-VIZUAL.html', pngArg = 'docs/35-swarm-arhitektura.png', wArg = '1600', hArg = '1250', scaleArg = '1'] = process.argv;

// htmlArg može imati query (npr. index.html?hero=1) — odvoji putanju od query-ja
const [htmlPath, htmlQuery = ''] = String(htmlArg).split('?');
const html = path.resolve(ROOT, htmlPath);
const png = path.resolve(ROOT, pngArg);
if (!fs.existsSync(html)) {
  console.error(`Nema HTML-a: ${html}`);
  process.exit(1);
}

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) {
  console.error(`Browser nije nađen. Otvori ručno: ${html}`);
  process.exit(2);
}

fs.mkdirSync(path.dirname(png), { recursive: true });
// `--wait=<ms>` (ili env POSTER_WAIT_MS): sačekaj prije snimka — za stranice koje same crtaju (live feed, animacije)
const waitArg = Number((process.argv.find((a) => a.startsWith('--wait=')) ?? '').split('=')[1] ?? process.env.POSTER_WAIT_MS ?? 0) || 0;
const args = [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  /// `scale` > 1 daje 2x/3x render (npr. 4K wallpaper iz iste HTML scene)
  `--force-device-scale-factor=${scaleArg}`,
  `--window-size=${wArg},${hArg}`,
  ...(waitArg ? [`--virtual-time-budget=${waitArg}`] : []),
  // `--transparent`: snimi PNG sa prozirnom podlogom (za hero sliku na sajtu)
  ...(process.argv.includes('--transparent') ? ['--default-background-color=00000000'] : []),
  `--screenshot=${png}`,
  pathToFileURL(html).href + (htmlQuery ? `?${htmlQuery}` : ''),
];
const res = spawnSync(browser, args, { stdio: 'ignore', timeout: 120_000 });
if (res.error) {
  console.error(`Render greška: ${res.error.message}`);
  process.exit(3);
}
if (!fs.existsSync(png)) {
  console.error('Screenshot nije napravljen.');
  process.exit(4);
}
const kb = (fs.statSync(png).size / 1024).toFixed(0);
console.log(`OK: ${path.relative(ROOT, png)} (${kb} KB, ${wArg}x${hArg} @${scaleArg}x)`);
