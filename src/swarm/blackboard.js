/**
 * Swarm blackboard — zajedničko okruženje bez centralnog orchestratora.
 *
 * Tri mehanizma:
 *   1. ZADACI      — otvoreni poslovi sa vrijednošću i potrebnim vještinama; workeri ih sami uzimaju (work stealing)
 *   2. FEROMONI    — tragovi koje workeri ostavljaju (`hot`, `done`, `problem`, `opportunity`, `help`),
 *                    sa jačinom koja OPADA kroz vrijeme (stigmergija). Utiču na prioritet, ne komanduju.
 *   3. ARTEFAKTI   — rezultati; jedini način da drugi worker vidi šta je urađeno
 *
 * Namjerno NEMA direktne poruke agent→agent kroz ovaj modul: sva komunikacija ide kroz mediate bus
 * (`swarm.message`) gdje je vidljiva, logovana i provjerena (vidi `safety.js`).
 *
 * Stanje: in-memory + append-only `data/tenants/<id>/swarm/board.jsonl` (audit i rekonstrukcija).
 */
import path from 'node:path';
import { appendJsonl } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { ValidationError, NotFoundError } from '../core/errors.js';

export const PHEROMONE_TYPES = ['hot', 'done', 'problem', 'opportunity', 'help', 'blocked'];

export function createBlackboard({ dataDir, logger, metrics, halfLifeMs = 300_000, defaultLeaseMs = 60_000 } = {}) {
  const tasks = new Map(); // id -> task
  const pheromones = new Map(); // id -> pheromone
  const artifacts = new Map(); // taskId -> artifact
  const history = [];

  let taskGuard = null; // postavlja ga index.js: provjera kvote otvorenih zadataka prije upisa
  const logFile = (tenantId, d = new Date()) => path.join(dataDir, 'tenants', tenantId, 'swarm', `board-${d.toISOString().slice(0, 10)}.jsonl`);

  async function log(tenantId, entry) {
    history.push(entry);
    if (history.length > 5000) history.shift();
    if (dataDir) await appendJsonl(logFile(tenantId, new Date(entry.ts)), entry).catch((err) => logger?.warn?.('swarm.log_failed', { error: err.message }));
    return entry;
  }

  /** Opadanje jačine feromona (eksponencijalno, pola za `halfLifeMs`). */
  function decayedStrength(pheromone, now = Date.now()) {
    const age = now - new Date(pheromone.ts).getTime();
    return Number((pheromone.strength * Math.pow(0.5, age / (pheromone.halfLifeMs ?? halfLifeMs))).toFixed(4));
  }

  function activePheromones(now = Date.now(), { tenantId, types, minStrength = 0.01 } = {}) {
    const out = [];
    for (const [id, p] of pheromones) {
      const strength = decayedStrength(p, now);
      const expired = now - new Date(p.ts).getTime() > (p.ttlMs ?? 3_600_000) || strength < 0.001;
      if (expired) {
        pheromones.delete(id);
        continue;
      }
      if (tenantId && p.tenantId !== tenantId) continue;
      if (types && !types.includes(p.type)) continue;
      if (strength < minStrength) continue;
      out.push({ ...p, strength, currentStrength: strength });
    }
    return out.sort((a, b) => b.currentStrength - a.currentStrength);
  }

  return {
    PHEROMONE_TYPES,
    /** Postavlja provjeru kvote (npr. `maxTasksOpen`) koja se poziva prije upisa zadatka. */
    setGuard(fn) {
      taskGuard = fn;
      return true;
    },
    tasks,
    pheromones,
    artifacts,
    logFile,
    decayedStrength,

    /** Otvara zadatak na tabli (niko ga ne dodjeljuje — workeri ga sami uzimaju). */
    async postTask({ tenantId, title, payload = {}, value = 1, requiredSkills = [], createdBy = 'operator', deadline = null, meta = {} }) {
      if (!title) throw new ValidationError('Zadatak traži "title"');
      const openCount = [...tasks.values()].filter((t) => t.tenantId === tenantId && t.state === 'open').length;
      if (taskGuard) taskGuard(tenantId, openCount);
      const task = {
        id: uid('task'),
        tenantId,
        title,
        payload,
        value: Number(value),
        requiredSkills,
        createdBy,
        deadline,
        meta,
        state: 'open',
        claimedBy: null,
        leaseUntil: null,
        attempts: 0,
        createdAt: iso(),
        updatedAt: iso(),
      };
      tasks.set(task.id, task);
      metrics?.inc('swarm_tasks_posted_total', { tenant: tenantId });
      await log(tenantId, { ts: task.createdAt, type: 'task_posted', taskId: task.id, tenantId, title, value: task.value });
      logger?.debug?.('swarm.task_posted', { tenantId, taskId: task.id, value: task.value });
      return task;
    },

    /**
     * Work stealing: worker uzima najvrjedniji zadatak koji može da uradi.
     * Feromoni utiču na efektivnu vrijednost (`hot` podiže, `problem`/`blocked` spuštaju).
     */
    async claim(workerId, { tenantId, skills = [], now = Date.now(), maxValue = null } = {}) {
      // oslobodi istekle lease-ove
      for (const t of tasks.values()) {
        if (t.state === 'claimed' && t.leaseUntil && new Date(t.leaseUntil).getTime() < now) {
          t.state = 'open';
          t.claimedBy = null;
          t.leaseUntil = null;
          await log(tenantId, { ts: iso(now), type: 'task_lease_expired', taskId: t.id, tenantId });
        }
      }
      const pheromonesNow = activePheromones(now, { tenantId });
      const boost = (taskId) => {
        const hot = pheromonesNow.filter((p) => p.taskId === taskId && p.type === 'hot').reduce((s, p) => s + p.currentStrength, 0);
        const bad = pheromonesNow.filter((p) => p.taskId === taskId && ['problem', 'blocked'].includes(p.type)).reduce((s, p) => s + p.currentStrength, 0);
        const help = pheromonesNow.filter((p) => p.taskId === taskId && p.type === 'help').reduce((s, p) => s + p.currentStrength, 0);
        return hot * 2 + help - bad * 1.5;
      };

      const candidates = [...tasks.values()]
        .filter((t) => t.tenantId === tenantId && t.state === 'open')
        .filter((t) => (t.requiredSkills ?? []).every((s) => skills.includes(s)))
        .filter((t) => (maxValue === null ? true : t.value <= maxValue))
        .map((t) => ({ task: t, score: t.value + boost(t.id) + (t.attempts > 0 ? 0.2 : 0) }))
        .sort((a, b) => b.score - a.score || String(a.task.createdAt).localeCompare(String(b.task.createdAt)));

      const pick = candidates[0];
      if (!pick) return null;
      const task = pick.task;
      task.state = 'claimed';
      task.claimedBy = workerId;
      task.leaseUntil = iso(now + defaultLeaseMs);
      task.attempts += 1;
      task.updatedAt = iso(now);
      metrics?.inc('swarm_task_claims_total', { tenant: tenantId, worker: workerId });
      await log(tenantId, { ts: iso(now), type: 'task_claimed', tenantId, taskId: task.id, workerId, score: Number(pick.score.toFixed(3)) });
      return task;
    },

    /** Ostavlja feromon (trag) na tabli. */
    async pheromone({ tenantId, type, taskId = null, by, strength = 1, ttlMs = 3_600_000, payload = {} }) {
      if (!PHEROMONE_TYPES.includes(type)) throw new ValidationError(`Nepoznat tip feromona: ${type} (dozvoljeno: ${PHEROMONE_TYPES.join(', ')})`);
      const p = { id: uid('ph'), ts: iso(), tenantId, type, taskId, by, strength: Number(strength), ttlMs, halfLifeMs, payload };
      pheromones.set(p.id, p);
      metrics?.inc('swarm_pheromones_total', { tenant: tenantId, type, worker: by });
      await log(tenantId, { ts: p.ts, type: 'pheromone', tenantId, pheromoneId: p.id, kind: type, taskId, by, strength: p.strength });
      return p;
    },

    /** Završava zadatak i ostavlja trag `done`. */
    async complete(taskId, { workerId, result, success = true, tenantId } = {}) {
      const task = tasks.get(taskId);
      if (!task) throw new NotFoundError('Swarm zadatak', taskId);
      task.state = success ? 'done' : 'open';
      task.claimedBy = null;
      task.leaseUntil = null;
      task.updatedAt = iso();
      const artifact = { taskId, workerId, success, result, ts: iso() };
      artifacts.set(taskId, artifact);
      if (tenantId) {
        await this.pheromone({ tenantId, type: success ? 'done' : 'problem', taskId, by: workerId, strength: success ? 1 : 1.5, payload: { success } });
        await log(tenantId, { ts: artifact.ts, type: 'task_completed', tenantId, taskId, workerId, success });
      }
      metrics?.inc('swarm_tasks_completed_total', { tenant: task.tenantId, success: String(success) });
      return artifact;
    },

    snapshot({ tenantId } = {}) {
      const list = [...tasks.values()].filter((t) => !tenantId || t.tenantId === tenantId);
      return {
        open: list.filter((t) => t.state === 'open').length,
        claimed: list.filter((t) => t.state === 'claimed').length,
        done: list.filter((t) => t.state === 'done').length,
        tasks: list,
        pheromones: activePheromones(Date.now(), { tenantId }).map((p) => ({ type: p.type, taskId: p.taskId, by: p.by, currentStrength: p.currentStrength })),
      };
    },

    activePheromones,
    history: () => history.slice(-200),
    /** Očisti tablu (npr. poslije incidenta) — auditovano spolja. */
    reset({ tenantId } = {}) {
      const removedTaskIds = new Set();
      for (const [id, t] of [...tasks]) {
        if (!tenantId || t.tenantId === tenantId) {
          tasks.delete(id);
          removedTaskIds.add(id);
        }
      }
      for (const [id, p] of [...pheromones]) if (!tenantId || p.tenantId === tenantId) pheromones.delete(id);
      // artefakti se brišu SAMO za zadatke koji su zaista uklonjeni (ranije je uslov uvek bio istinit)
      for (const id of [...artifacts.keys()]) if (removedTaskIds.has(id)) artifacts.delete(id);
      return { cleared: true, tenantId: tenantId ?? '*', tasks: removedTaskIds.size, artifacts: artifacts.size };
    },
  };
}
