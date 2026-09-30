import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const exists = (p) => fs.existsSync(p);

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== null) return fallback;
    if (err instanceof SyntaxError) throw new Error(`Neispravan JSON u ${file}: ${err.message}`);
    if (err.code === 'ENOENT') throw new Error(`Fajl ne postoji: ${file}`);
    throw err;
  }
}

/** Jedinstveno ime privremenog fajla — sprječava sudar dva paralelna upisa (ENOENT na rename). */
let tmpCounter = 0;
const tmpName = (file) => `${file}.${process.pid}.${(tmpCounter += 1).toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;

/** Atomski upis (tmp + rename) — da prekid ne ostavi polovičan fajl. */
export async function writeJson(file, value, { pretty = true } = {}) {
  await ensureDir(path.dirname(file));
  const tmp = tmpName(file);
  await fsp.writeFile(tmp, JSON.stringify(value, null, pretty ? 2 : 0), 'utf8');
  await fsp.rename(tmp, file);
  return file;
}

export async function appendJsonl(file, record) {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function appendText(file, text) {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, text, 'utf8');
}

/** Atomski upis sirovog teksta (npr. prepisivanje JSONL-a bez obrisanih zapisa). */
export async function writeTextFile(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = tmpName(file);
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
  return file;
}

const readLines = (raw) =>
  raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Čita JSONL; toleriše polomljenu poslednju liniju (npr. prekinut upis). */
export async function readJsonl(file, { limit = 0, tail = false } = {}) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  let lines = readLines(raw);
  if (tail) lines = lines.slice(-limit);
  else if (limit > 0) lines = lines.slice(0, limit);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* preskoči oštećenu liniju */
    }
  }
  return out;
}

export async function listFiles(dir, filter = () => true) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && filter(e.name)).map((e) => path.join(dir, e.name));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function listDirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Uklanja string vrijednosti iz objekta po ključu (za logovanje/config). */
export function stripSecrets(value, secretKeys = ['apiKey', 'api_key', 'token', 'secret', 'password', 'authorization']) {
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, secretKeys));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = secretKeys.some((s) => k.toLowerCase().includes(s)) && typeof v === 'string' ? '***' : stripSecrets(v, secretKeys);
    }
    return out;
  }
  return value;
}
