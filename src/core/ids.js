import { randomUUID, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Kratki, sortabilan ID sa prefiksom: uid('run') -> run_01J...  */
export function uid(prefix = 'id', time = Date.now()) {
  const t = time.toString(36).padStart(9, '0');
  const r = randomBytes(6).toString('hex');
  return `${prefix}_${t}${r}`;
}

export const uuid = () => randomUUID();

export const sha256 = (value) =>
  createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export const shortHash = (value, len = 12) => sha256(value).slice(0, len);

export const token = (bytes = 24) => randomBytes(bytes).toString('base64url');

/** Stabilan JSON (sortirani ključevi) — za hash lanac i keš ključeve. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Skrati tekst na N znakova uz oznaku. */
export const truncate = (text, max = 2000) =>
  typeof text === 'string' && text.length > max ? `${text.slice(0, max)}…[+${text.length - max}]` : text;
