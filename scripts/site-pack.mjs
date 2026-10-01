#!/usr/bin/env node
/**
 * Pakuje `site/` u `dist/braincore-site-<verzija>.tar.gz` — spremno za upload na Hostinger.
 *
 *   node scripts/site-pack.mjs
 *
 * Bez npm zavisnosti: koristi sistemski `tar` (Windows 10+ ima bsdtar, Linux svuda).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const DIST = path.join(ROOT, 'dist');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const out = path.join(DIST, `braincore-site-${pkg.version}.tar`);

if (!fs.existsSync(SITE)) {
  console.error('Nema site/ foldera.');
  process.exit(1);
}
fs.mkdirSync(DIST, { recursive: true });

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(path.relative(SITE, full).split(path.sep).join('/'));
  }
};
walk(SITE);

// Nikad ne pakuj radne screenshotove (_*.png) u javni sajt
const publishable = files.filter((f) => !path.basename(f).startsWith('_'));
const skipped = files.filter((f) => !publishable.includes(f));
if (!publishable.includes('index.html')) {
  console.error('site/index.html nedostaje — prekidam.');
  process.exit(2);
}

// NEkompresovani tar (`-cf`, ne `-czf`): Hostinger LVE limit ne dozvoljava fork gzip child-a pri
// `tar -xzf` („Cannot fork: Resource temporarily unavailable"), pa se koristi običan tar bez gzip-a.
execFileSync('tar', ['-cf', out, '-C', SITE, ...publishable], { stdio: 'inherit' });
const kb = (fs.statSync(out).size / 1024).toFixed(0);

console.log(`\nOK: ${path.relative(ROOT, out)} (${kb} KB, ${publishable.length} fajlova)`);
if (skipped.length) console.log(`Preskočeno (radne slike): ${skipped.join(', ')}`);
console.log('\nSadržaj:');
for (const f of publishable.sort()) console.log(`  ${f}`);
console.log('\nUpload: bash deploy/deploy-site.sh   (ili node scripts/deploy-site.mjs)');
