/**
 * Shared store — zajednička tabla i feromoni za CROSS-NODE swarm.
 *
 * Dva backenda, isti interfejs:
 *   • `file`  — direktorijum kao deljeni store. Atomski claim preko `mkdir` lock-a (POSIX/Windows:
 *               `mkdir` je atomska operacija — uspije samo jednom) + `leaseUntil` + append-only log.
 *               Radi za više PROCESA na istoj mašini ili na deljenom FS-u (NFS/SMB uz oprez).
 *   • `redis` — sopstveni RESP klijent (`src/cluster/redis.js`), atomski claim preko `HSETNX`
 *               (jedan pobjednik) + TTL; tabla i feromoni u hashovima, sortirani set za lease-ove.
 *
 * Garantovano: **at-most-one claim** po zadatku u datom trenutku (na oba backenda).
 * Nije garantovano: exactly-once izvršenje (pad čvora poslije claim-a → lease ističe → zadatak se
 * vraća na tablu; zato poslovi moraju biti idempotentni ili sa `meta.attempts` zaštitom).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendJsonl, exists } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { ClusterError, ValidationError } from '../core/errors.js';

const DEFAULT_LEASE_MS = 60_000;

// ───────────────────────────── file backend ─────────────────────────────

export function createFileStore({ dir, logger, metrics } = {}) {
  if (!dir) throw new ValidationError('File store traži "dir"');
  const tasksDir = () => path.join(dir, 'tasks');
  const locksDir = () => path.join(dir, 'locks');
  const log = () => path.join(dir, 'board.jsonl');
  const taskFile = (id) => path.join(tasksDir(), `${id}.json`);
  const lockDir = (id) => path.join(locksDir(), `${id}.lock`);

  async function ensure() {
    await fs.mkdir(tasksDir(), { recursive: true });
    await fs.mkdir(locksDir(), { recursive: true });
  }

  async function readTask(id) {
    const file = taskFile(id);
    if (!exists(file)) return null;
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  async function writeTask(task) {
    await ensure();
    const tmp = `${taskFile(task.id)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(task));
    await fs.rename(tmp, taskFile(task.id));
    return task;
  }

  return {
    kind: 'file',
    dir,
    async init() {
      await ensure();
      logger?.info?.('cluster.store_file_ready', { dir });
      return true;
    },
    async putTask(task) {
      await writeTask(task);
      await appendJsonl(log(), { ts: iso(), type: 'task_put', taskId: task.id, tenantId: task.tenantId }).catch(() => {});
      return task;
    },
    async getTask(id) {
      return readTask(id);
    },
    /** Atomski claim: `mkdir` je atomičan — drugi proces dobija EEXIST i gubi trku. */
    async claimTask(id, workerId, { leaseMs = DEFAULT_LEASE_MS } = {}) {
      await ensure();
      const lock = lockDir(id);
      const now = Date.now();
      try {
        await fs.mkdir(lock);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const task = await readTask(id);
        if (!task) return { claimed: false, reason: 'nema_zadatka' };
        if (task.state === 'done') return { claimed: false, reason: 'zavrsen' };
        // Aktivna lease → zauzet. VAŽNO: lock se NE smije oteti samo zato što zapis još kaže "open"
        // (drugi proces ga upravo drži i tek će upisati stanje) — to je bila trka sa dva pobjednika.
        if (task.state === 'claimed' && task.leaseUntil && new Date(task.leaseUntil).getTime() > now) {
          return { claimed: false, reason: 'zauzet', holder: task.claimedBy };
        }
        // Prekidamo lock ako je očigledno mrtav: zapis je `open` (niko ne drži pravo) i lock je star,
        // ili je zapis `claimed` sa isteklom lease-om. Bez ovoga zadatak ostaje trajno nedostupan.
        const stat = await fs.stat(lock).catch(() => null);
        const lockAge = stat ? now - stat.mtimeMs : 0;
        const leaseExpired = task.state === 'claimed' && task.leaseUntil && new Date(task.leaseUntil).getTime() <= now;
        const orphanOpen = task.state === 'open' && lockAge > 2000;
        if (leaseExpired || orphanOpen) {
          await fs.rmdir(lock).catch(() => {});
          return this.claimTask(id, workerId, { leaseMs });
        }
        return { claimed: false, reason: 'lock_se_drzi' };
      }
      try {
        const task = await readTask(id);
        if (!task) {
          await fs.rmdir(lock).catch(() => {});
          return { claimed: false, reason: 'nema_zadatka' };
        }
        if (task.state === 'done') {
          await fs.rmdir(lock).catch(() => {});
          return { claimed: false, reason: 'zavrsen' };
        }
        // Unutar zaključane sekcije se provjerava i lease (lock serializuje, zapis nosi pravo)
        if (task.state === 'claimed' && task.leaseUntil && new Date(task.leaseUntil).getTime() > now) {
          await fs.rmdir(lock).catch(() => {});
          return { claimed: false, reason: 'zauzet', holder: task.claimedBy };
        }
        const claimed = { ...task, state: 'claimed', claimedBy: workerId, attempts: (task.attempts ?? 0) + 1, leaseUntil: iso(now + leaseMs), updatedAt: iso() };
        await writeTask(claimed);
        await appendJsonl(log(), { ts: iso(), type: 'task_claimed', taskId: id, workerId }).catch(() => {});
        metrics?.inc('cluster_task_claims_total', { backend: 'file' });
        return { claimed: true, task: claimed };
      } finally {
        await fs.rmdir(lock).catch(() => {});
      }
    },
    async completeTask(id, { workerId, success = true, result = null } = {}) {
      const task = await readTask(id);
      if (!task) return null;
      const done = { ...task, state: success ? 'done' : 'open', claimedBy: null, leaseUntil: null, result, updatedAt: iso() };
      await writeTask(done);
      await appendJsonl(log(), { ts: iso(), type: 'task_completed', taskId: id, workerId, success }).catch(() => {});
      metrics?.inc('cluster_tasks_completed_total', { backend: 'file', success: String(success) });
      return done;
    },
    /** Produžava lease dok posao traje (bez ovoga posao duži od lease-a može biti preuzet drugi put). */
    async renewLease(id, workerId, { leaseMs = DEFAULT_LEASE_MS } = {}) {
      const task = await readTask(id);
      if (!task || task.state !== 'claimed') return { renewed: false, reason: 'nije_claimovan' };
      if (task.claimedBy !== workerId) return { renewed: false, reason: 'drugi_worker' };
      const updated = { ...task, leaseUntil: iso(Date.now() + leaseMs), updatedAt: iso() };
      await writeTask(updated);
      return { renewed: true, leaseUntil: updated.leaseUntil };
    },
    async openTasks(tenantId) {
      await ensure();
      const files = await fs.readdir(tasksDir());
      const out = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const task = await readTask(file.replace('.json', ''));
        if (!task) continue;
        if (tenantId && task.tenantId !== tenantId) continue;
        if (task.state === 'claimed' && new Date(task.leaseUntil).getTime() <= Date.now()) out.push({ ...task, state: 'open', expiredLease: true });
        else if (task.state === 'open') out.push(task);
      }
      return out;
    },
    async putPheromone(pheromone) {
      await ensure();
      await appendJsonl(path.join(dir, 'pheromones.jsonl'), pheromone).catch(() => {});
      return pheromone;
    },
    async activePheromones({ tenantId, now = Date.now(), ttlMs = 3_600_000 } = {}) {
      const file = path.join(dir, 'pheromones.jsonl');
      if (!exists(file)) return [];
      const raw = await fs.readFile(file, 'utf8');
      const rows = raw
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      return rows.filter((p) => (!tenantId || p.tenantId === tenantId) && now - new Date(p.ts).getTime() < ttlMs);
    },
    async stats() {
      const tasks = await this.openTasks(null);
      return { backend: 'file', dir, open: tasks.length };
    },
  };
}

// ───────────────────────────── redis backend ─────────────────────────────

const CLAIM_LUA = `
local key = KEYS[1]
local worker = ARGV[1]
local payload = ARGV[2]
local ttl = tonumber(ARGV[3])
local existing = redis.call('GET', key)
if existing then
  local ok, decoded = pcall(cjson.decode, existing)
  if ok and decoded.leaseUntil and tonumber(decoded.leaseUntil) > tonumber(ARGV[4]) then
    return {'busy'}
  end
end
redis.call('SET', key, payload, 'PX', ttl)
return {'claimed', worker}
`;

export function createRedisStore({ client, prefix = 'nmq:board:', logger, metrics } = {}) {
  if (!client) throw new ValidationError('Redis store traži "client"');
  const k = (suffix) => `${prefix}${suffix}`;

  return {
    kind: 'redis',
    client,
    prefix,
    async init() {
      await client.connect();
      const pong = await client.ping();
      logger?.info?.('cluster.store_redis_ready', { pong });
      return pong === 'PONG';
    },
    async putTask(task) {
      await client.hset(k('tasks'), { [task.id]: JSON.stringify(task) });
      await client.zadd(k('open'), task.value ?? 1, task.id);
      metrics?.inc('cluster_task_puts_total', { backend: 'redis' });
      return task;
    },
    async getTask(id) {
      const raw = (await client.hgetall(k('tasks')))[id];
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    async claimTask(id, workerId, { leaseMs = DEFAULT_LEASE_MS } = {}) {
      const task = await this.getTask(id);
      if (!task) return { claimed: false, reason: 'nema_zadatka' };
      if (task.state === 'done') return { claimed: false, reason: 'zavrsen' };
      const now = Date.now();
      const payload = JSON.stringify({ workerId, leaseUntil: now + leaseMs, claimedAt: now });
      let reply;
      try {
        reply = await client.eval(CLAIM_LUA, [k(`claim:${id}`)], [workerId, payload, String(leaseMs), String(now)]);
      } catch (err) {
        logger?.warn?.('cluster.claim_lua_failed', { error: err.message });
        // Fallback bez Lua: SET NX PX (takođe atomski)
        const set = await client.set(k(`claim:${id}`), payload, { nx: true, px: leaseMs });
        reply = set === 'OK' ? ['claimed', workerId] : ['busy'];
      }
      if (!Array.isArray(reply) || reply[0] !== 'claimed') return { claimed: false, reason: 'zauzet' };
      const claimed = { ...task, state: 'claimed', claimedBy: workerId, attempts: (task.attempts ?? 0) + 1, leaseUntil: iso(now + leaseMs), updatedAt: iso() };
      await client.hset(k('tasks'), { [id]: JSON.stringify(claimed) });
      await client.zrem(k('open'), id);
      await client.zadd(k('leases'), now + leaseMs, id);
      metrics?.inc('cluster_task_claims_total', { backend: 'redis' });
      return { claimed: true, task: claimed };
    },
    async completeTask(id, { workerId, success = true, result = null } = {}) {
      const task = await this.getTask(id);
      if (!task) return null;
      const done = { ...task, state: success ? 'done' : 'open', claimedBy: null, leaseUntil: null, result, updatedAt: iso() };
      await client.hset(k('tasks'), { [id]: JSON.stringify(done) });
      await client.del(k(`claim:${id}`));
      await client.zrem(k('leases'), id);
      if (!success) await client.zadd(k('open'), task.value ?? 1, id);
      metrics?.inc('cluster_tasks_completed_total', { backend: 'redis', success: String(success) });
      return done;
    },
    /** Produžava claim u Redis-u (TTL ključa + zapis). */
    async renewLease(id, workerId, { leaseMs = DEFAULT_LEASE_MS } = {}) {
      const task = await this.getTask(id);
      if (!task || task.state !== 'claimed') return { renewed: false, reason: 'nije_claimovan' };
      if (task.claimedBy !== workerId) return { renewed: false, reason: 'drugi_worker' };
      const now = Date.now();
      await client.set(k(`claim:${id}`), JSON.stringify({ workerId, leaseUntil: now + leaseMs, renewedAt: now }), { px: leaseMs });
      const updated = { ...task, leaseUntil: iso(now + leaseMs), updatedAt: iso() };
      await client.hset(k('tasks'), { [id]: JSON.stringify(updated) });
      return { renewed: true, leaseUntil: updated.leaseUntil };
    },
    async openTasks(tenantId) {
      const ids = (await client.zrangebyscore(k('open'), '-inf', '+inf')) ?? [];
      const out = [];
      for (const id of ids) {
        const task = await this.getTask(id);
        if (!task) continue;
        if (tenantId && task.tenantId !== tenantId) continue;
        out.push(task);
      }
      return out;
    },
    async putPheromone(pheromone) {
      await client.lpush(k('pheromones'), JSON.stringify(pheromone));
      await client.expire(k('pheromones'), 86_400);
      return pheromone;
    },
    async activePheromones({ tenantId, now = Date.now(), ttlMs = 3_600_000 } = {}) {
      const raw = (await client.cmd('LRANGE', k('pheromones'), '0', '999')) ?? [];
      return raw
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter((p) => (!tenantId || p.tenantId === tenantId) && now - new Date(p.ts).getTime() < ttlMs);
    },
    async stats() {
      const open = await this.openTasks(null);
      return { backend: 'redis', prefix, open: open.length };
    },
  };
}

/**
 * Bira backend: `redis` ako je dostupan (`NMQ_REDIS_URL` ili config), inače `file`.
 * Pad Redis-a NIJE fatalan — sistem se vraća na file store (fail-soft), ali to se loguje i mjeri.
 */
export async function createSharedStore({ config = {}, dataDir, logger, metrics, redisFactory }) {
  const wantRedis = Boolean(config.redisUrl);
  if (!wantRedis) {
    const store = createFileStore({ dir: path.join(dataDir, '_cluster', 'board'), logger, metrics });
    await store.init();
    return store;
  }
  try {
    const client = redisFactory ? redisFactory(config.redisUrl) : (await import('./redis.js')).createRedisClient({ url: config.redisUrl, logger });
    const store = createRedisStore({ client, prefix: config.keyPrefix ?? 'nmq:board:', logger, metrics });
    await store.init();
    return store;
  } catch (err) {
    metrics?.inc('cluster_redis_fallback_total', {});
    logger?.warn?.('cluster.redis_unavailable_fallback_file', { error: err.message });
    const store = createFileStore({ dir: path.join(dataDir, '_cluster', 'board'), logger, metrics });
    await store.init();
    return store;
  }
}
