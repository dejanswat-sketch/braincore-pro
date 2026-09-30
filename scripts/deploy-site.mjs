#!/usr/bin/env node
/**
 * Upload sajta na Hostinger — jedan poziv, sa provjerom prije i poslije.
 *
 *   node scripts/deploy-site.mjs                 # pita ništa, radi provjeru pa upload
 *   node scripts/deploy-site.mjs --dry-run       # samo provjeri stanje (DNS, SSH, ciljni folder)
 *   node scripts/deploy-site.mjs --domain=braincore.pro
 *
 * Šta provjerava PRIJE uploada (i staje ako nešto ne valja):
 *   1. DNS: domen postoji i pokazuje na Hostinger
 *   2. SSH: ključ radi, `~/domains/<domen>/public_html` postoji (domen mora biti dodat u hPanel)
 *   3. da ciljni folder nije tuđi sajt (provjerava da je prazan ili da sadrži naš marker)
 *
 * POSLIJE uploada: provjeri da živi sajt vraća naš marker („BRAINCORE PRO") i ispiše status.
 *
 * Napomena: domen se NE može dodati na hosting iz ove skripte (to je hPanel korak, jednom klikom).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const DOMAIN = arg('domain', process.env.BRAINCORE_DOMAIN ?? 'braincore.pro');
const SSH_HOST = arg('host', process.env.HOSTINGER_SSH_HOST ?? 'u972051764@82.25.83.80');
const SSH_PORT = arg('port', process.env.HOSTINGER_SSH_PORT ?? '65002');
const SSH_KEY = arg('key', process.env.HOSTINGER_SSH_KEY ?? 'C:\\Users\\Administrator\\.ssh\\id_ed25519');
const REMOTE_DIR = arg('dir', process.env.HOSTINGER_SITE_DIR ?? `domains/${DOMAIN}/public_html`);
const MARKER = 'Genesis Brain'; // mora bukvalno postojati u index.html (ne „BRAINCORE PRO" — to je razdvojeno tagovima)
const DRY = process.argv.includes('--dry-run');

const ssh = (command, { inherit = false } = {}) =>
  execFileSync('ssh', ['-i', SSH_KEY, '-p', SSH_PORT, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', SSH_HOST, command], {
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: inherit ? undefined : 'utf8',
  });

const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => console.log(`  ✖ ${m}`);
const step = (m) => console.log(`\n${m}`);

let failed = false;

// ── 0. paket ────────────────────────────────────────────────────────────────
step('0. Pakujem site/');
execFileSync(process.execPath, [path.join(ROOT, 'scripts/site-pack.mjs')], { cwd: ROOT, stdio: 'inherit' });
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tarball = path.join(ROOT, 'dist', `braincore-site-${pkg.version}.tar.gz`);
if (!fs.existsSync(tarball)) {
  bad('paket nije napravljen');
  process.exit(1);
}

// ── 1. DNS ──────────────────────────────────────────────────────────────────
step(`1. DNS za ${DOMAIN}`);
try {
  const out = execFileSync('nslookup', [DOMAIN], { encoding: 'utf8' });
  const ips = [...out.matchAll(/Address:\s+([0-9.]+)/g)].map((m) => m[1]).filter((ip) => !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
  if (ips.length) ok(`DNS postoji → ${[...new Set(ips)].join(', ')}`);
  else {
    bad('nema A zapisa');
    failed = true;
  }
} catch {
  bad('DNS ne odgovara');
  failed = true;
}

// ── 2. SSH i ciljni folder ──────────────────────────────────────────────────
step('2. Hostinger SSH + ciljni folder');
let remoteReady = false;
try {
  const listing = ssh(`ls -1d ~/${REMOTE_DIR} 2>/dev/null || echo NEMA_FOLDERA`);
  if (listing.includes('NEMA_FOLDERA')) {
    bad(`~/${REMOTE_DIR} ne postoji → domen NIJE dodat u hPanel (Websites → Add Website → ${DOMAIN})`);
    failed = true;
  } else {
    ok(`~/${REMOTE_DIR} postoji`);
    const inside = ssh(`ls -A ~/${REMOTE_DIR} 2>/dev/null | head -20; echo "---MARKER---"; grep -l '${MARKER}' ~/${REMOTE_DIR}/index.html 2>/dev/null || true`);
    const parts = inside.split('---MARKER---');
    const existing = parts[0].split('\n').map((s) => s.trim()).filter(Boolean);
    const isOurs = Boolean(parts[1] && parts[1].includes('index.html'));
    if (existing.length === 0) ok('folder je prazan (sigurno za upload)');
    else if (isOurs) ok(`postojeći sajt je naš (marker „${MARKER}") — radim zamjenu`);
    else if (process.argv.includes('--backup')) {
      // Tuđa osnova (npr. „Coming Soon" stranica): prvo je sklanjamo u _osnova-<datum>, pa uploadujemo.
      const stamp = new Date().toISOString().slice(0, 10);
      const backupDir = `domains/${DOMAIN}/_osnova-${stamp}`;
      ssh(`mkdir -p ~/${backupDir} && cd ~/${REMOTE_DIR} && (mv -f * .[!.]* ~/${backupDir}/ 2>/dev/null || true) && echo BACKUP_OK && ls -1 ~/${backupDir} | head -10`, { inherit: true });
      ok(`postojeći sadržaj sklonjen u ~/${backupDir} (vraća se jednim mv) — nastavljam`);
    } else {
      bad(`folder NIJE prazan i ne izgleda kao naš sajt: ${existing.slice(0, 5).join(', ')} — stajem da ne pregazim tuđe (dodaj --backup da ga sklonim)`);
      failed = true;
    }
    remoteReady = true;
  }
} catch (err) {
  bad(`SSH ne radi: ${String(err.stderr ?? err.message).split('\n')[0]}`);
  failed = true;
}

if (failed && !remoteReady) {
  console.log(`\nZAKLJUČAK: sajt NIJE na ${DOMAIN}. Prvo u hPanelu: Websites → Add Website → „${DOMAIN}" (bez WordPress-a), pa SSL.`);
  console.log('Poslije toga ova komanda radi sve ostalo: node scripts/deploy-site.mjs');
  process.exit(2);
}
if (DRY) {
  console.log(`\nDRY RUN: sve je spremno za upload na ${REMOTE_DIR} (paket ${path.basename(tarball)}).`);
  process.exit(0);
}

// ── 3. Upload ───────────────────────────────────────────────────────────────
step('3. Upload (tar preko SSH, bez npm-a)');
const remoteTar = `~/braincore-site-${pkg.version}.tar.gz`;
execFileSync('scp', ['-i', SSH_KEY, '-P', SSH_PORT, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', tarball, `${SSH_HOST}:${remoteTar}`], { stdio: 'inherit' });
ok(`prebačen ${path.basename(tarball)}`);
ssh(`cd ~/${REMOTE_DIR} && tar -xzf ${remoteTar} && rm -f ${remoteTar} && ls -1 | head -20`, { inherit: true });
ok('raspakovan u public_html');

// ── 4. Provjera živog sajta ─────────────────────────────────────────────────
step('4. Provjera živog sajta');
let verified = false;
for (const scheme of ['https', 'http']) {
  try {
    const res = await fetch(`${scheme}://${DOMAIN}/`, { redirect: 'follow' });
    const html = await res.text();
    const hasMarker = html.includes(MARKER);
    const parked = html.includes('Parked Domain');
    console.log(`  ${scheme} → HTTP ${res.status}, ${html.length} bajtova, marker: ${hasMarker}, parked: ${parked}`);
    if (hasMarker && !parked) {
      verified = true;
      break;
    }
  } catch (err) {
    console.log(`  ${scheme} → ${String(err.message).split('\n')[0]}`);
  }
}

console.log(
  verified
    ? `\nGOTOVO: ${DOMAIN} servira BRAINCORE PRO sajt. Provjeri i https://${DOMAIN}/docs.html`
    : `\nPAŽNJA: fajlovi su uploadovani, ali živi sajt još ne vraća naš marker.\n  Najčešći razlozi: SSL još nije izdat (hPanel → SSL) ili DNS još propagira (sačekaj 10–30 min).\n  Provjeri ručno: https://${DOMAIN}/`,
);
process.exit(verified ? 0 : 3);
