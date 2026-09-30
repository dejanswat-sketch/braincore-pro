/**
 * Minimalni .env loader (bez zavisnosti).
 * Postojeće env varijable imaju prioritet — .env nikad ne pregazi ono što je već postavljeno.
 */
import fs from 'node:fs';
import path from 'node:path';

export function loadEnvFile({ root = process.cwd(), file = '.env', override = false } = {}) {
  const full = path.isAbsolute(file) ? file : path.join(root, file);
  if (!fs.existsSync(full)) return { loaded: false, path: full, count: 0 };
  const text = fs.readFileSync(full, 'utf8');
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!override && process.env[key] !== undefined && process.env[key] !== '') continue;
    process.env[key] = value;
    count += 1;
  }
  return { loaded: true, path: full, count };
}
