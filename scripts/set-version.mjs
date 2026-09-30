#!/usr/bin/env node
/**
 * Postavi verziju u package.json i src/index.js (bez shell escaping problema).
 *   node scripts/set-version.mjs 1.7.2
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Upotreba: node scripts/set-version.mjs 1.7.2');
  process.exit(1);
}

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const indexPath = path.join(ROOT, 'src/index.js');
let src = fs.readFileSync(indexPath, 'utf8');
src = src.replace(/export const VERSION = '[^']+';/, `export const VERSION = '${version}';`);
fs.writeFileSync(indexPath, src);

console.log(`verzija postavljena: package.json=${pkg.version} · src/index.js=${/export const VERSION = '([^']+)'/.exec(src)[1]}`);
