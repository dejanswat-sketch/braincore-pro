import { iso } from './clock.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** Regex uzorci tajni koje NIKAD ne smiju u log. */
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:api[_-]?key|token|password|secret)\s*[=:]\s*["']?([^\s"',}]{8,})/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redact(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const re of SECRET_PATTERNS) text = text.replace(re, (m, g1) => (g1 ? m.replace(g1, '***') : '[REDACTED]'));
  return text;
}

function redactDeep(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
    return out;
  }
  return value;
}

/**
 * Strukturirani JSON logger (jedna linija = jedan event).
 * Tajne se redaktuju prije ispisa — namjerno, bez izuzetka.
 */
export function createLogger({ level = process.env.NMQ_LOG_LEVEL || 'info', bindings = {}, sink } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = sink ?? ((line) => process.stdout.write(`${line}\n`));

  const log = (lvl, msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    const line = JSON.stringify({
      ts: iso(),
      level: lvl,
      msg: redact(msg),
      ...redactDeep(bindings),
      ...redactDeep(fields),
    });
    write(line);
  };

  return {
    level,
    bindings,
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (extra) => createLogger({ level, bindings: { ...bindings, ...extra }, sink: write }),
  };
}

export const logger = createLogger();
