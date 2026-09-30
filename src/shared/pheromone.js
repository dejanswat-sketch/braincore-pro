/**
 * Pheromone — tragovi sa TTL-om **i stvarnim opadanjem** (decay interval).
 *
 * Razlika od v0.5 „mock" feromona (Map sa TTL koji samo expires):
 *   • `strength` opada eksponencijalno kroz vrijeme (`halfLifeMs`), pa trag „isparava" postepeno
 *   • TTL je tvrd rok (`ttlMs`) poslije kojeg se zapis briše
 *   • `decayJob()` se poziva na intervalu i čisti isparilo
 *   • Uz RESP backend koristi `SETEX` (TTL na Redis strani) — preživljava restart procesa
 *
 * Jači trag = više agenata ide tamo (koordinacija bez centralne komande).
 */
import { EventEmitter } from 'node:events';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { ValidationError } from '../core/errors.js';

export const PHEROMONE_TYPES = ['hot', 'done', 'problem', 'opportunity', 'help', 'blocked', 'claimed'];

export const PHEROMONE_DEFAULTS = {
  ttlMs: 30_000, // spec: pheromone ispari nakon 30s
  halfLifeMs: 10_000, // jačina se prepolovi za 10s
  minStrength: 0.02, // ispod ovoga trag se briše
  decayIntervalMs: 1000,
  maxEntries: 5000,
  redisPrefix: 'nmq:ph:',
};

export function createPheromoneStore({ config = {}, logger, metrics, redis = null, keyPrefix = null, now = () => Date.now() } = {}) {
  const cfg = { ...PHEROMONE_DEFAULTS, ...(config ?? {}) };
  const prefix = keyPrefix ?? cfg.redisPrefix;
  const entries = new Map(); // id -> pheromone
  const emitter = new EventEmitter();
  let timer = null;

  function decayed(p, at = now()) {
    const age = Math.max(0, at - new Date(p.ts).getTime());
    return Number((p.strength * Math.pow(0.5, age / (p.halfLifeMs ?? cfg.halfLifeMs))).toFixed(4));
  }

  function expired(p, at = now()) {
    const age = at - new Date(p.ts).getTime();
    return age >= (p.ttlMs ?? cfg.ttlMs) || decayed(p, at) < cfg.minStrength;
  }

  async function persist(p) {
    if (!redis) return;
    try {
      // SETEX: TTL na Redis strani (preživljava restart procesa)
      const ttlSeconds = Math.max(1, Math.ceil((p.ttlMs ?? cfg.ttlMs) / 1000));
      if (typeof redis.set === 'function') await redis.set(`${prefix}${p.id}`, JSON.stringify(p), { ex: ttlSeconds });
      else if (typeof redis.cmd === 'function') await redis.cmd('SETEX', `${prefix}${p.id}`, String(ttlSeconds), JSON.stringify(p));
    } catch (err) {
      logger?.debug?.('pheromone.persist_failed', { error: err.message });
    }
  }

  const api = {
    PHEROMONE_TYPES,
    settings: cfg,
    entries,
    on: (...a) => emitter.on(...a),

    async deposit({ tenantId = null, type, taskId = null, by = 'agent', strength = 1, ttlMs = null, halfLifeMs = null, payload = {} } = {}) {
      if (!PHEROMONE_TYPES.includes(type)) throw new ValidationError(`Nepoznat tip feromona: ${type} (dozvoljeno: ${PHEROMONE_TYPES.join(', ')})`);
      const p = {
        id: uid('ph'),
        ts: iso(now()),
        tenantId,
        type,
        taskId,
        by,
        strength: Number(strength),
        ttlMs: ttlMs ?? cfg.ttlMs,
        halfLifeMs: halfLifeMs ?? cfg.halfLifeMs,
        payload,
      };
      entries.set(p.id, p);
      if (entries.size > cfg.maxEntries) {
        const oldest = [...entries.values()].sort((a, b) => new Date(a.ts) - new Date(b.ts))[0];
        if (oldest) entries.delete(oldest.id);
      }
      await persist(p);
      metrics?.inc('pheromone_deposits_total', { type });
      emitter.emit('deposit', p);
      return p;
    },

    /** Aktivni tragovi sa trenutnom (opadajućom) jačinom, sortirani od najjačeg. */
    active({ tenantId = null, types = null, taskId = null, minStrength = null, at = now() } = {}) {
      const floor = minStrength ?? cfg.minStrength;
      const out = [];
      for (const [id, p] of entries) {
        if (expired(p, at)) {
          entries.delete(id);
          continue;
        }
        if (tenantId && p.tenantId !== tenantId) continue;
        if (types && !types.includes(p.type)) continue;
        if (taskId && p.taskId !== taskId) continue;
        const s = decayed(p, at);
        if (s < floor) continue;
        out.push({ ...p, currentStrength: s, ageMs: at - new Date(p.ts).getTime() });
      }
      return out.sort((a, b) => b.currentStrength - a.currentStrength);
    },

    /** „Gdje ima posla" — suma jačine po zadatku (pozitivni tragovi minus problemi). */
    heat({ tenantId = null, at = now() } = {}) {
      const map = new Map();
      for (const p of api.active({ tenantId, at })) {
        const key = p.taskId ?? 'global';
        const signed = ['problem', 'blocked'].includes(p.type) ? -p.currentStrength * 1.5 : p.currentStrength;
        map.set(key, Number(((map.get(key) ?? 0) + signed).toFixed(4)));
      }
      return [...map.entries()].map(([taskId, heat]) => ({ taskId, heat })).sort((a, b) => b.heat - a.heat);
    },

    /** Decay interval: briše isparilo i mjeri koliko je ostalo. */
    decayJob({ at = now() } = {}) {
      let removed = 0;
      let alive = 0;
      for (const [id, p] of entries) {
        if (expired(p, at)) {
          entries.delete(id);
          removed += 1;
        } else alive += 1;
      }
      metrics?.gauge?.('pheromone_active', {}, alive);
      if (removed) {
        metrics?.inc('pheromone_evaporated_total', { removed: String(removed) });
        emitter.emit('evaporated', { removed, alive });
      }
      return { removed, alive };
    },

    startDecay() {
      if (timer) clearInterval(timer);
      timer = setInterval(() => api.decayJob(), cfg.decayIntervalMs);
      if (timer.unref) timer.unref();
      return true;
    },

    stopDecay() {
      if (timer) clearInterval(timer);
      timer = null;
      return true;
    },

    /** Učitaj iz Redis-a (npr. poslije restarta) — koristi KEYS samo u testu/malim instalacijama. */
    async loadFromRedis({ tenantId = null } = {}) {
      if (!redis || typeof redis.cmd !== 'function') return { loaded: 0 };
      const keys = (await redis.cmd('KEYS', `${prefix}*`)) ?? [];
      let loaded = 0;
      for (const key of keys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        try {
          const p = JSON.parse(raw);
          if (tenantId && p.tenantId !== tenantId) continue;
          entries.set(p.id, p);
          loaded += 1;
        } catch {
          /* preskoči neispravan zapis */
        }
      }
      return { loaded };
    },

    stats({ at = now() } = {}) {
      const active = api.active({ at });
      return {
        total: entries.size,
        active: active.length,
        strongest: active[0] ? { type: active[0].type, strength: active[0].currentStrength, taskId: active[0].taskId } : null,
        byType: active.reduce((acc, p) => ({ ...acc, [p.type]: (acc[p.type] ?? 0) + 1 }), {}),
        halfLifeMs: cfg.halfLifeMs,
        ttlMs: cfg.ttlMs,
      };
    },

    clear() {
      entries.clear();
      return true;
    },

    decayed,
    expired,
  };

  return api;
}
