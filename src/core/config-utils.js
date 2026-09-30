/** Duboki merge objekata (desni pobjednik). Nizovi se zamjenjuju, ne spajaju. */
export function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override === undefined ? base : override;
  if (base && typeof base === 'object' && override && typeof override === 'object') {
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) out[k] = k in base ? deepMerge(base[k], v) : v;
    return out;
  }
  return override === undefined ? base : override;
}

/** Bezbjedno čitanje putanje: get(obj, 'a.b.c', default) */
export function get(obj, pathStr, fallback) {
  const parts = String(pathStr).split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
}

/** Interpolacija "{{var}}" u stringu. */
export function interpolate(template, vars = {}) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
    const v = get(vars, key);
    return v === undefined || v === null ? m : String(v);
  });
}

/**
 * Interpolacija kroz strukturu (objekat/niz/string) — BEZ pretvaranja u JSON string.
 * Koristi ovo za argumente alata: vrijednosti sa novim redovima i navodnicima ostaju validne.
 */
export function interpolateDeep(value, vars = {}) {
  if (typeof value === 'string') return interpolate(value, vars);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateDeep(v, vars);
    return out;
  }
  return value;
}

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'da'].includes(String(value).toLowerCase());
}

export function parseNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseList(value, { separator = ',' } = {}) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
}
