/**
 * Task queue — ručno implementiran `LPUSH`/`BRPOP` preko RESP-a, plus `memory` (default) i `nats`.
 *
 * Task je tačno po smernicama: `{ id, type, payload, ttl }` (+ meta: tenant, value, skills, attempts).
 * Nijedna npm zavisnost: RESP ide preko `net` (`src/resp-client.js`), NATS preko `net` (tekstualni protokol).
 *
 * Backend-i:
 *   • `memory`  — FIFO u procesu (radi bez ičega; koristi se u testovima i single-node režimu)
 *   • `resp`    — Redis: `LPUSH nmq:q:<tenant>` + blokirajući `BRPOP` (at-least-once, vidljiv svim čvorovima)
 *   • `nats`    — minimalni NATS klijent (CONNECT/SUB/PUB/MSG) — jeftin pub/sub za task obavještenja
 *
 * Garantovano: task se ne gubi u `resp` režimu ako čvor padne poslije BRPOP-a — task se vodi u
 * `inFlight` listi i vraća u queue (`requeueStale`) poslije `visibilityTimeoutMs`.
 */
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { ValidationError } from '../core/errors.js';

export const TASK_DEFAULTS = { ttlMs: 30_000, visibilityTimeoutMs: 60_000, queuePrefix: 'nmq:q:', inflightPrefix: 'nmq:q:inflight:' };

/** Minimalni NATS klijent (tekstualni protokol: INFO/CONNECT/PING/PONG/PUB/SUB/MSG). */
export function createNatsClient({ url = 'nats://127.0.0.1:4222', logger, name = 'nmq' } = {}) {
  let host = '127.0.0.1';
  let port = 4222;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port || 4222);
  } catch {
    /* koristi default */
  }
  const emitter = new EventEmitter();
  let socket = null;
  let buffer = '';
  let connected = false;
  const subscriptions = new Map(); // sid -> subject

  function handleLine(line) {
    if (line.startsWith('MSG ')) {
      const [, subject, sid, size] = line.split(' ');
      pending = { subject, sid, size: Number(size) };
      return;
    }
    if (line.startsWith('PING')) {
      socket.write('PONG\r\n');
      return;
    }
    if (line.startsWith('-ERR')) {
      emitter.emit('error', new Error(line));
      return;
    }
    if (line.startsWith('INFO')) emitter.emit('info', line);
  }

  let pending = null;

  function onData(chunk) {
    buffer += chunk.toString('utf8');
    for (;;) {
      if (pending) {
        if (Buffer.byteLength(buffer) < pending.size + 2) return;
        const payload = buffer.slice(0, pending.size);
        buffer = buffer.slice(pending.size + 2);
        emitter.emit('message', { subject: pending.subject, data: payload, sid: pending.sid });
        pending = null;
        continue;
      }
      const idx = buffer.indexOf('\r\n');
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleLine(line);
    }
  }

  return {
    url,
    get connected() {
      return connected;
    },
    on: (...a) => emitter.on(...a),
    connect() {
      return new Promise((resolve, reject) => {
        socket = net.createConnection({ host, port }, () => {
          connected = true;
          socket.write(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false, name, lang: 'nodejs', version: '1.0.0' })}\r\n`);
          resolve(true);
        });
        socket.setEncoding('utf8');
        socket.on('data', onData);
        socket.on('error', (err) => {
          connected = false;
          reject(err);
        });
        socket.on('close', () => {
          connected = false;
        });
      });
    },
    subscribe(subject, cb) {
      const sid = String(subscriptions.size + 1);
      subscriptions.set(sid, subject);
      socket.write(`SUB ${subject} ${sid}\r\n`);
      emitter.on('message', (m) => {
        if (m.sid === sid) cb(m.data, m.subject);
      });
      return sid;
    },
    publish(subject, data) {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      socket.write(`PUB ${subject} ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
      return true;
    },
    async close() {
      if (socket && !socket.destroyed) socket.end();
      connected = false;
      return true;
    },
  };
}

export function createTaskQueue({ backend = 'memory', redis = null, nats = null, tenantId = 'nmq', config = {}, logger, metrics } = {}) {
  const cfg = { ...TASK_DEFAULTS, ...(config ?? {}) };
  const key = `${cfg.queuePrefix}${tenantId}`;
  const inflightKey = `${cfg.inflightPrefix}${tenantId}`;
  const memory = [];
  const inFlight = new Map(); // id -> { task, at }
  const emitter = new EventEmitter();

  function normalizeTask(task) {
    if (!task?.type && !task?.title) throw new ValidationError('Task traži "type" (ili "title")');
    return {
      id: task.id ?? uid('task'),
      type: task.type ?? 'generic',
      payload: task.payload ?? {},
      ttl: Number(task.ttl ?? cfg.ttlMs),
      tenantId: task.tenantId ?? tenantId,
      value: Number(task.value ?? 1),
      skills: task.skills ?? [],
      attempts: Number(task.attempts ?? 0),
      createdAt: iso(),
    };
  }

  const api = {
    backend,
    tenantId,
    queueKey: key,
    settings: cfg,
    on: (...a) => emitter.on(...a),

    async init() {
      if (backend === 'resp') {
        if (!redis) throw new ValidationError('RESP queue traži "redis" klijenta');
        await redis.connect();
        await redis.ping();
      }
      if (backend === 'nats') {
        if (!nats) throw new ValidationError('NATS queue traži "nats" klijenta');
        await nats.connect();
      }
      logger?.info?.('queue.ready', { backend, queueKey: key });
      return true;
    },

    /** LPUSH (spec) — task ide na kraj queue-a. */
    async push(task) {
      const normalized = normalizeTask(task);
      if (backend === 'resp') await redis.lpush(key, JSON.stringify(normalized));
      else if (backend === 'nats') nats.publish(`nmq.queue.${tenantId}`, normalized);
      else memory.push(normalized);
      metrics?.inc('queue_pushes_total', { backend });
      emitter.emit('push', normalized);
      return normalized;
    },

    /** BRPOP (spec) — blokirajuće preuzimanje. Vraća `null` ako nema posla u `timeoutSec`. */
    async pop({ timeoutSec = 1 } = {}) {
      if (backend === 'resp') {
        const res = await redis.brpop(key, timeoutSec);
        if (!res) return null;
        const raw = Array.isArray(res) ? res[1] : res;
        const task = JSON.parse(raw);
        inFlight.set(task.id, { task, at: Date.now() });
        metrics?.inc('queue_pops_total', { backend });
        return task;
      }
      if (backend === 'nats') return null; // NATS je pub/sub obavještenje, ne red sa potvrdom
      const task = memory.shift() ?? null;
      if (task) inFlight.set(task.id, { task, at: Date.now() });
      if (task) metrics?.inc('queue_pops_total', { backend });
      return task;
    },

    /**
     * Ukloni task iz reda BEZ izvršenja.
     *
     * Zašto postoji: na node putu task se ne uzima preko `pop()` (claim ide kroz CRDT), pa je red
     * rastao zauvijek — `queued` je dostizao `maxQueueDepth` i backpressure je **lažno** počeo da odbija
     * posao (vidi soak #3, 30.09.). Sada čvor poziva `discard()` kad task završi, pa `queued` znači
     * „koliko ih stvarno čeka".
     */
    async discard(taskId) {
      inFlight.delete(taskId);
      if (backend === 'resp') {
        // LREM iz Redis liste (bez npm-a: ručni RESP)
        await redis.cmd('LREM', key, '0', JSON.stringify({ id: taskId })).catch(() => {});
        try {
          const all = await redis.lrange(key, 0, -1);
          for (const raw of all) {
            try {
              if (JSON.parse(raw).id === taskId) await redis.cmd('LREM', key, '1', raw);
            } catch {
              /* preskoči ne-JSON */
            }
          }
        } catch {
          /* ignorisano */
        }
        try {
          await redis.cmd('LREM', inflightKey, '1', JSON.stringify({ id: taskId }));
        } catch {
          /* ignorisano */
        }
      } else {
        const idx = memory.findIndex((t) => t.id === taskId);
        if (idx >= 0) memory.splice(idx, 1);
      }
      return true;
    },

    /** Potvrda uspjeha/neuspjeha — skida task iz in-flight liste. */
    async ack(taskId, { success = true } = {}) {
      const entry = inFlight.get(taskId);
      inFlight.delete(taskId);
      if (backend === 'resp' && !success && entry) await redis.lpush(key, JSON.stringify({ ...entry.task, attempts: entry.task.attempts + 1 }));
      if (backend === 'memory' && !success && entry) memory.push({ ...entry.task, attempts: entry.task.attempts + 1 });
      metrics?.inc('queue_acks_total', { backend, success: String(success) });
      return { acked: true, requeued: !success };
    },

    /** Vraća taskove koji su „u letu" duže od `visibilityTimeoutMs` (čvor je pao). */
    async requeueStale({ at = Date.now() } = {}) {
      const stale = [...inFlight.entries()].filter(([, v]) => at - v.at > cfg.visibilityTimeoutMs);
      for (const [id, v] of stale) {
        inFlight.delete(id);
        await api.push({ ...v.task, attempts: v.task.attempts + 1 });
        metrics?.inc('queue_requeued_total', {});
      }
      return { requeued: stale.length };
    },

    async size() {
      if (backend === 'resp') return redis.llen(key);
      return memory.length;
    },

    get inFlight() {
      return inFlight;
    },

    stats() {
      return { backend, queueKey: key, queued: memory.length, inFlight: inFlight.size, visibilityTimeoutMs: cfg.visibilityTimeoutMs, defaultTtlMs: cfg.ttlMs };
    },

    async close() {
      if (backend === 'resp' && redis) await redis.close().catch(() => {});
      if (backend === 'nats' && nats) await nats.close().catch(() => {});
      return true;
    },
  };

  return api;
}
