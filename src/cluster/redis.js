/**
 * Minimalni RESP (REdis Serialization Protocol) klijent — bez ijedne npm zavisnosti.
 *
 * Zašto sopstveni klijent: pravilo projekta je `dependencies: {}` (nema `npm install`), a za
 * distribuiranu tablu nam treba samo podskup komandi: SET (NX PX), GET, DEL, HSET/HGETALL, EXPIRE,
 * INCR, ZADD/ZRANGEBYSCORE/ZREM, LPUSH/BRPOP i EVAL (Lua za atomski claim).
 *
 * Protokol: https://redis.io/docs/latest/develop/reference/protocol-spec/ — dovoljno je
 * parsirati `+jednostavan`, `-greška`, `:broj`, `$bulk` i `*niz`.
 */
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { RedisError } from '../core/errors.js';

/** Kodira niz argumenata u RESP komandu. */
export function encodeCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const str = String(arg);
    parts.push(`$${Buffer.byteLength(str)}\r\n${str}\r\n`);
  }
  return parts.join('');
}

/** Parsira jedan RESP odgovor iz bafera; vraća `{ value, offset }` ili `null` ako treba još podataka. */
export function parseReply(buf, offset = 0) {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  const lineEnd = buf.indexOf('\r\n', offset + 1);
  if (lineEnd === -1) return null;
  const line = buf.toString('utf8', offset + 1, lineEnd);

  if (type === '+') return { value: line, offset: lineEnd + 2 };
  if (type === '-') return { value: new RedisError(line), offset: lineEnd + 2, isError: true };
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
      if (!parsed) return null; // niz još nije kompletan
      items.push(parsed.value);
      cursor = parsed.offset;
    }
    return { value: items, offset: cursor };
  }
  throw new RedisError(`Nepoznat RESP tip: ${type}`);
}

/**
 * Klijent sa lenjim povezivanjem, redom komandi i automatskim ponovnim spajanjem.
 * Sve komande vraćaju Promise sa parsiranim odgovorom (greška → throw).
 */
export function createRedisClient({ url = 'redis://127.0.0.1:6379', logger, timeoutMs = 5000 } = {}) {
  const parsed = new URL(url);
  const options = { host: parsed.hostname, port: Number(parsed.port || 6379) };
  const emitter = new EventEmitter();
  let socket = null;
  let buffer = Buffer.alloc(0);
  const queue = [];
  let connecting = null;
  let connected = false;

  function failAll(err) {
    while (queue.length) {
      const item = queue.shift();
      clearTimeout(item.timer);
      item.reject(err);
    }
  }

  function pump() {
    while (queue.length) {
      const parsedReply = parseReply(buffer);
      if (!parsedReply) return;
      buffer = buffer.subarray(parsedReply.offset);
      const item = queue.shift();
      clearTimeout(item.timer);
      if (parsedReply.isError) item.reject(parsedReply.value);
      else item.resolve(parsedReply.value);
    }
  }

  function connect() {
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      socket = net.createConnection(options, () => {
        connected = true;
        emitter.emit('ready');
        resolve(true);
      });
      socket.setNoDelay(true);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
          pump();
        } catch (err) {
          failAll(err);
        }
      });
      socket.on('error', (err) => {
        connected = false;
        failAll(err);
        if (!socket.destroyed) socket.destroy();
        reject(err);
        connecting = null;
      });
      socket.on('close', () => {
        connected = false;
        connecting = null;
        failAll(new RedisError('Veza sa Redis-om je zatvorena'));
      });
      socket.on('connect', () => socket.setKeepAlive?.(true, 10_000));
    });
    return connecting;
  }

  async function send(args, { timeout = timeoutMs } = {}) {
    if (!connected) await connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = queue.findIndex((q) => q.reject === reject);
        if (idx >= 0) queue.splice(idx, 1);
        reject(new RedisError(`Redis komanda je istekla (${args[0]})`));
      }, timeout);
      if (timer.unref) timer.unref();
      queue.push({ resolve, reject, timer });
      socket.write(encodeCommand(args));
    });
  }

  const api = {
    url,
    options,
    get connected() {
      return connected;
    },
    on: (...a) => emitter.on(...a),
    async connect() {
      await connect();
      return true;
    },
    send,
    /** Komandni interfejs: `client.cmd('SET', 'k', 'v', 'NX', 'PX', 5000)` */
    cmd: (...args) => send(args),
    async ping() {
      return send(['PING']);
    },
    async get(key) {
      return send(['GET', key]);
    },
    async set(key, value, { nx = false, px = null } = {}) {
      const args = ['SET', key, value];
      if (nx) args.push('NX');
      if (px) args.push('PX', String(px));
      return send(args);
    },
    async del(...keys) {
      return send(['DEL', ...keys]);
    },
    async hset(key, obj) {
      const flat = [];
      for (const [k, v] of Object.entries(obj)) flat.push(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      return flat.length ? send(['HSET', key, ...flat]) : 0;
    },
    async hgetall(key) {
      const flat = await send(['HGETALL', key]);
      const out = {};
      for (let i = 0; i < (flat?.length ?? 0); i += 2) out[flat[i]] = flat[i + 1];
      return out;
    },
    async hdel(key, ...fields) {
      return send(['HDEL', key, ...fields]);
    },
    async expire(key, seconds) {
      return send(['EXPIRE', key, String(seconds)]);
    },
    async incr(key) {
      return send(['INCR', key]);
    },
    async zadd(key, score, member) {
      return send(['ZADD', key, String(score), member]);
    },
    async zrangebyscore(key, min, max) {
      return send(['ZRANGEBYSCORE', key, String(min), String(max)]);
    },
    async zrem(key, ...members) {
      return send(['ZREM', key, ...members]);
    },
    async zcard(key) {
      return send(['ZCARD', key]);
    },
    async lpush(key, ...values) {
      return send(['LPUSH', key, ...values]);
    },
    async brpoplpush(src, dst, seconds = 1) {
      return send(['BRPOPLPUSH', src, dst, String(seconds)], { timeout: (seconds + 2) * 1000 });
    },
    /** Lua skript (koristi se za atomske operacije nad tablom). */
    async eval(script, keys = [], argv = []) {
      return send(['EVAL', script, String(keys.length), ...keys, ...argv]);
    },
    async info(section = 'server') {
      return send(['INFO', section]);
    },
    async close() {
      if (socket && !socket.destroyed) socket.end();
      connected = false;
      connecting = null;
      return true;
    },
  };

  return api;
}
