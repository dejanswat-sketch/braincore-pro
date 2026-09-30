/**
 * Ručni RESP klijent (Redis protokol) — bez ijedne npm zavisnosti (`net` modul).
 * Kanonsko ime iz smernica; implementacija živi ovdje (≤ ~200 linija bez komentara).
 *
 * Podržano (dovoljno za queue/blackboard/pheromone):
 *   PING, GET, SET (NX/PX/EX), DEL, HSET/HGETALL/HDEL, EXPIRE, INCR,
 *   LPUSH, RPUSH, BRPOP, LRANGE, LLEN, ZADD/ZRANGEBYSCORE/ZREM/ZCARD, EVAL (Lua)
 */
import net from 'node:net';

/** Kodira niz argumenata u RESP komandu. */
export function encodeCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const str = String(arg);
    parts.push(`$${Buffer.byteLength(str)}\r\n${str}\r\n`);
  }
  return parts.join('');
}

/** Parsira jedan RESP odgovor; vraća `{ value, offset, isError? }` ili `null` ako treba još bajtova. */
export function parseReply(buf, offset = 0) {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  const lineEnd = buf.indexOf('\r\n', offset + 1);
  if (lineEnd === -1) return null;
  const line = buf.toString('utf8', offset + 1, lineEnd);
  if (type === '+') return { value: line, offset: lineEnd + 2 };
  if (type === '-') return { value: new Error(line), offset: lineEnd + 2, isError: true };
  if (type === ':') return { value: Number(line), offset: lineEnd + 2 };
  if (type === '$') {
    const len = Number(line);
    if (len === -1) return { value: null, offset: lineEnd + 2 };
    const start = lineEnd + 2;
    const end = start + len;
    if (buf.length < end + 2) return null;
    return { value: buf.toString('utf8', start, end), offset: end + 2 };
  }
  if (type === '*') {
    const count = Number(line);
    if (count === -1) return { value: null, offset: lineEnd + 2 };
    const items = [];
    let cursor = lineEnd + 2;
    for (let i = 0; i < count; i += 1) {
      const parsed = parseReply(buf, cursor);
      if (!parsed) return null;
      items.push(parsed.value);
      cursor = parsed.offset;
    }
    return { value: items, offset: cursor };
  }
  throw new Error(`Nepoznat RESP tip: ${type}`);
}

export function createRespClient({ url = 'redis://127.0.0.1:6379', host = null, port = null, logger, timeoutMs = 5000 } = {}) {
  let parsedUrl = null;
  try {
    parsedUrl = new URL(url);
  } catch {
    parsedUrl = null;
  }
  const opts = { host: host ?? parsedUrl?.hostname ?? '127.0.0.1', port: Number(port ?? parsedUrl?.port ?? 6379) };
  let socket = null;
  let buffer = Buffer.alloc(0);
  const queue = [];
  let connecting = null;
  let connected = false;

  const flush = (err) => {
    while (queue.length) {
      const item = queue.shift();
      clearTimeout(item.timer);
      item.reject(err);
    }
  };

  function pump() {
    while (queue.length) {
      const parsed = parseReply(buffer);
      if (!parsed) return;
      buffer = buffer.subarray(parsed.offset);
      const item = queue.shift();
      clearTimeout(item.timer);
      if (parsed.isError) item.reject(parsed.value);
      else item.resolve(parsed.value);
    }
  }

  function connect() {
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      socket = net.createConnection(opts, () => {
        connected = true;
        resolve(true);
      });
      socket.setNoDelay(true);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
          pump();
        } catch (err) {
          flush(err);
        }
      });
      socket.on('error', (err) => {
        connected = false;
        flush(err);
        connecting = null;
        reject(err);
      });
      socket.on('close', () => {
        connected = false;
        connecting = null;
        flush(new Error('RESP veza zatvorena'));
      });
    });
    return connecting;
  }

  function send(args, { timeout = timeoutMs } = {}) {
    const run = async () => {
      if (!connected) await connect();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = queue.findIndex((q) => q.reject === reject);
          if (idx >= 0) queue.splice(idx, 1);
          reject(new Error(`RESP komanda istekla (${args[0]})`));
        }, timeout);
        if (timer.unref) timer.unref();
        queue.push({ resolve, reject, timer });
        socket.write(encodeCommand(args));
      });
    };
    return run();
  }

  return {
    url,
    options: opts,
    get connected() {
      return connected;
    },
    connect: async () => connect(),
    cmd: (...args) => send(args),
    ping: () => send(['PING']),
    get: (k) => send(['GET', k]),
    set: (k, v, { nx = false, px = null, ex = null } = {}) => {
      const args = ['SET', k, v];
      if (nx) args.push('NX');
      if (px) args.push('PX', String(px));
      if (ex) args.push('EX', String(ex));
      return send(args);
    },
    del: (...keys) => send(['DEL', ...keys]),
    expire: (k, s) => send(['EXPIRE', k, String(s)]),
    incr: (k) => send(['INCR', k]),
    hset: (k, obj) => {
      const flat = [];
      for (const [f, v] of Object.entries(obj)) flat.push(f, typeof v === 'object' ? JSON.stringify(v) : String(v));
      return flat.length ? send(['HSET', k, ...flat]) : 0;
    },
    hgetall: async (k) => {
      const flat = (await send(['HGETALL', k])) ?? [];
      const out = {};
      for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
      return out;
    },
    hdel: (k, ...fields) => send(['HDEL', k, ...fields]),
    lpush: (k, ...vals) => send(['LPUSH', k, ...vals]),
    rpush: (k, ...vals) => send(['RPUSH', k, ...vals]),
    lrange: (k, a, b) => send(['LRANGE', k, String(a), String(b)]),
    llen: (k) => send(['LLEN', k]),
    /** Blokirajući BRPOP: koristi se za task queue (spec: LPUSH/BRPOP). */
    brpop: (k, seconds = 1) => send(['BRPOP', k, String(seconds)], { timeout: (Number(seconds) + 3) * 1000 }),
    zadd: (k, score, member) => send(['ZADD', k, String(score), member]),
    zrangebyscore: (k, min, max) => send(['ZRANGEBYSCORE', k, String(min), String(max)]),
    zrem: (k, ...members) => send(['ZREM', k, ...members]),
    zcard: (k) => send(['ZCARD', k]),
    eval: (script, keys = [], argv = []) => send(['EVAL', script, String(keys.length), ...keys, ...argv]),
    close: async () => {
      if (socket && !socket.destroyed) socket.end();
      connected = false;
      connecting = null;
      return true;
    },
  };
}

export default createRespClient;
