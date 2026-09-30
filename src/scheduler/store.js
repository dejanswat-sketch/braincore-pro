/**
 * Trajno skladište poslova (persistentni agenti).
 * Stanje: data/tenants/<id>/jobs/jobs.json (snapshot) + runs-YYYY-MM.jsonl (istorija izvršavanja).
 */
import path from 'node:path';
import { appendJsonl, readJson, readJsonl, writeJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';

export function createJobStore({ dataDir, logger } = {}) {
  const cache = new Map(); // tenantId -> { jobs: { id: job } }

  const dir = (tenantId) => path.join(dataDir, 'tenants', tenantId, 'jobs');
  const file = (tenantId) => path.join(dir(tenantId), 'jobs.json');
  const runsFile = (tenantId, d = new Date()) => path.join(dir(tenantId), `runs-${d.toISOString().slice(0, 7)}.jsonl`);

  async function load(tenantId) {
    if (cache.has(tenantId)) return cache.get(tenantId);
    const state = await readJson(file(tenantId), { jobs: {} });
    if (!state.jobs) state.jobs = {};
    cache.set(tenantId, state);
    return state;
  }

  async function persist(tenantId) {
    const state = await load(tenantId);
    if (dataDir) await writeJson(file(tenantId), state);
    return state;
  }

  return {
    dir,
    file,
    runsFile,
    load,
    persist,

    async upsert(tenantId, job) {
      const state = await load(tenantId);
      const existing = state.jobs[job.id];
      const merged = {
        ...existing,
        ...job,
        id: job.id,
        tenantId,
        createdAt: existing?.createdAt ?? iso(),
        updatedAt: iso(),
      };
      state.jobs[merged.id] = merged;
      await persist(tenantId);
      logger?.debug?.('job.upsert', { tenantId, jobId: merged.id, enabled: merged.enabled !== false });
      return merged;
    },

    async create(tenantId, job) {
      const id = job.id ?? uid('job');
      return this.upsert(tenantId, { enabled: true, runs: 0, ...job, id });
    },

    async get(tenantId, jobId) {
      const state = await load(tenantId);
      return state.jobs[jobId] ?? null;
    },

    async list(tenantId, { enabledOnly = false } = {}) {
      const state = await load(tenantId);
      return Object.values(state.jobs).filter((j) => !enabledOnly || j.enabled !== false);
    },

    async remove(tenantId, jobId) {
      const state = await load(tenantId);
      const existed = Boolean(state.jobs[jobId]);
      delete state.jobs[jobId];
      await persist(tenantId);
      return existed;
    },

    async appendRun(tenantId, record) {
      if (!dataDir) return record;
      await appendJsonl(runsFile(tenantId), record);
      return record;
    },

    async listRuns(tenantId, { limit = 50 } = {}) {
      return readJsonl(runsFile(tenantId), { limit, tail: true });
    },

    /** Svi tenanti koji imaju poslove (za scheduler tick). */
    tenantsWithJobs: () => [...cache.keys()],
    invalidate: (tenantId) => cache.delete(tenantId),
  };
}
