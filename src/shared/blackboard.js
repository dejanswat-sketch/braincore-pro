/**
 * CRDT blackboard — „Map + vector clock + sync" iz smernica.
 *
 * Model (bez ijedne zavisnosti, sve deterministički):
 *   • Svaki ključ je **LWW-Register sa vektorskim satom**: vrijednost + (counter, nodeId) + vector clock.
 *   • Konflikt se rješava: prvo `counter` (veći pobjeđuje), pa `nodeId` (leksikografski) — deterministički,
 *     pa svi čvorovi na kraju imaju **identično** stanje bez obzira na redoslijed dolaska poruka.
 *   • `delete` je „tombstone" (uklanjanje je takođe operacija sa istim pravilom pobjede).
 *   • `merge(remote)` spaja dva stanja i vraća listu ključeva koji su se promijenili (za peer sync).
 *   • `sync()` proizvodi kompaktan delta-objekat za slanje gossip-om (PING piggyback).
 *
 * Zašto vektorski sat, a ne samo timestamp: `Date.now()` se razlikuje između mašina; vektorski sat
 * pamti „ko je šta vidio" i omogućava idempotentno spajanje (dupli paketi ne mijenjaju stanje).
 */
import { EventEmitter } from 'node:events';
import { iso } from '../core/clock.js';
import { ValidationError } from '../core/errors.js';

export function createCrdtBlackboard({ nodeId = 'node', logger, metrics, maxKeys = 20_000 } = {}) {
  if (!nodeId) throw new ValidationError('CRDT blackboard traži "nodeId"');
  const state = new Map(); // key -> { value, deleted, counter, nodeId, clock: {nodeId: counter}, ts }
  const emitter = new EventEmitter();
  let counter = 0;

  const tick = () => {
    counter += 1;
    return counter;
  };

  /** Pobjednik: veći counter; kod izjednačenja leksikografski veći nodeId. */
  function wins(a, b) {
    if (!b) return true;
    if (a.counter !== b.counter) return a.counter > b.counter;
    return String(a.nodeId) > String(b.nodeId);
  }

  function clockMerge(a = {}, b = {}) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = Math.max(Number(out[k] ?? 0), Number(v));
    return out;
  }

  const api = {
    nodeId,
    get size() {
      return state.size;
    },
    on: (...a) => emitter.on(...a),

    /** Lokalni upis (LWW + vektorski sat). */
    set(key, value, { meta = null } = {}) {
      if (!key) throw new ValidationError('CRDT set traži "key"');
      const entry = {
        key,
        value,
        meta,
        deleted: false,
        counter: tick(),
        nodeId,
        clock: clockMerge({}, { [nodeId]: counter }),
        ts: iso(),
      };
      const existing = state.get(key);
      if (wins(entry, existing)) {
        state.set(key, entry);
        emitter.emit('change', entry);
      }
      if (state.size > maxKeys) {
        // evict najstarijeg po (counter, nodeId) — deterministički
        const oldest = [...state.values()].sort((a, b) => a.counter - b.counter)[0];
        if (oldest) state.delete(oldest.key);
      }
      return state.get(key);
    },

    get(key) {
      const e = state.get(key);
      return e && !e.deleted ? e.value : undefined;
    },

    /** Tombstone — i brisanje učestvuje u LWW trci. */
    delete(key) {
      if (!state.has(key)) return false;
      const entry = { key, value: null, meta: null, deleted: true, counter: tick(), nodeId, clock: clockMerge({}, { [nodeId]: counter }), ts: iso() };
      state.set(key, entry);
      emitter.emit('change', entry);
      return true;
    },

    entries({ includeDeleted = false } = {}) {
      return [...state.values()].filter((e) => includeDeleted || !e.deleted);
    },

    toObject() {
      const out = {};
      for (const e of api.entries()) out[e.key] = e.value;
      return out;
    },

    /**
     * Spaja udaljeno stanje. Vraća `{ changed, applied, rejected }`.
     * Idempotentno: isti paket dva puta ne mijenja stanje.
     */
    merge(remote = []) {
      const list = Array.isArray(remote) ? remote : Object.values(remote ?? {});
      const changed = [];
      let applied = 0;
      let rejected = 0;
      for (const r of list) {
        if (!r?.key || typeof r.counter !== 'number') continue;
        const existing = state.get(r.key);
        if (wins(r, existing)) {
          const merged = { ...r, clock: clockMerge(existing?.clock, r.clock) };
          state.set(r.key, merged);
          changed.push(r.key);
          applied += 1;
          emitter.emit('change', merged);
        } else if (existing) {
          // Naš zapis je noviji — spojimo samo vektorski sat (da znamo šta je udaljeni vidio)
          existing.clock = clockMerge(existing.clock, r.clock);
          rejected += 1;
        }
      }
      if (applied) metrics?.inc('crdt_merges_applied_total', { applied: String(applied) });
      metrics?.observe('crdt_size', {}, state.size);
      return { changed, applied, rejected };
    },

    /** Delta za slanje: sve što je novije od datog vektorskog sata (po čvoru koji je zapis napisao). */
    delta(remoteClock = {}) {
      const out = [];
      for (const e of state.values()) {
        const seen = Number(remoteClock?.[e.nodeId] ?? 0);
        if (e.counter > seen) out.push(e);
      }
      return out;
    },

    /** Cijelo stanje (za bootstrap novog člana). */
    snapshot() {
      return [...state.values()];
    },

    /** Vektorski sat: najveći brojač po čvoru (ono što je lokalno poznato iz svih zapisa). */
    vectorClock() {
      const vc = {};
      for (const e of state.values()) {
        vc[e.nodeId] = Math.max(vc[e.nodeId] ?? 0, e.counter);
        for (const [node, c] of Object.entries(e.clock ?? {})) vc[node] = Math.max(vc[node] ?? 0, Number(c));
      }
      return vc;
    },

    /** Za testove: deterministički otisak stanja (isti kod svih čvorova = konvergirano). */
    fingerprint() {
      return api
        .entries({ includeDeleted: true })
        .map((e) => `${e.key}=${e.deleted ? '∅' : JSON.stringify(e.value)}@${e.counter}:${e.nodeId}`)
        .sort()
        .join('|');
    },

    clear() {
      state.clear();
      return true;
    },
  };

  return api;
}
