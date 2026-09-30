/**
 * Swarm governance — pravila na nivou SWARM-a, ne agenta.
 *
 * Zašto: kod decentralizovanog roja per-agent zaštita nije dovoljna (agent koji je „siguran" sam
 * postaje nesiguran u kolektivu). Zato ovdje stoje:
 *   - IZOLACIONI NIVOI: open → contained → locked (swarm-wide) i `frozen` (kill switch)
 *   - KVOTE: broj workera, runova, feromona, peer poruka, trošak po satu
 *   - DOZVOLE: alati i egress koje swarm smije koristiti (nikad šire od politike tenanta)
 *   - BOARD: izmjene izolacije/kvota traže čovjeka (role owner) i idu u audit
 *
 * Sve provjere su fail-closed: ako se ne može dokazati da je dozvoljeno → blokada.
 */
import path from 'node:path';
import { appendJsonl, exists, readJson, writeJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { PolicyError, ValidationError } from '../core/errors.js';

export const ISOLATION_LEVELS = {
  open: { rank: 3, canRun: true, canUseNetwork: true, canPeerMessage: true, maxRisk: 'low' },
  contained: { rank: 2, canRun: true, canUseNetwork: false, canPeerMessage: true, maxRisk: 'low' },
  locked: { rank: 1, canRun: false, canUseNetwork: false, canPeerMessage: false, maxRisk: 'low' },
  frozen: { rank: 0, canRun: false, canUseNetwork: false, canPeerMessage: false, maxRisk: 'none' },
};

export const DEFAULT_QUOTAS = {
  maxWorkers: 12,
  maxRunsPerTick: 8,
  maxCostPerHourUsd: 2,
  maxPheromonesPerMin: 120,
  maxPeerMessagesPerMin: 60,
  maxTasksOpen: 200,
  maxClaimsPerWorkerPerMin: 20,
};

export function createSwarmGovernance({ config = {}, dataDir, logger, metrics, audit, autonomy }) {
  const globalQuotas = { ...DEFAULT_QUOTAS, ...(config.quotas ?? {}) };
  const tenantQuotas = new Map(); // tenantId -> patch; kvote su PER-TENANT (ranije su bile globalne)
  const effectiveQuotas = (tenantId) => ({ ...globalQuotas, ...(tenantQuotas.get(tenantId) ?? {}) });
  const stateFile = dataDir ? path.join(dataDir, '_control', 'swarm.json') : null;
  const rateWindows = new Map(); // `${tenantId}::${kind}::${id}` -> timestamps[]
  let state = { isolation: {}, frozen: {}, frozenReason: {}, updatedAt: null };

  async function persist() {
    if (!stateFile) return;
    await writeJson(stateFile, { ...state, updatedAt: iso() }).catch((err) => logger?.warn?.('swarm.persist_failed', { error: err.message }));
  }

  function isolationOf(tenantId) {
    if (state.frozen[tenantId]) return 'frozen';
    return state.isolation[tenantId] ?? config.defaultIsolation ?? 'contained';
  }

  function allowRate(tenantId, kind, id, limitPerMin) {
    const key = `${tenantId}::${kind}::${id}`;
    const now = Date.now();
    const arr = (rateWindows.get(key) ?? []).filter((t) => now - t < 60_000);
    if (arr.length >= limitPerMin) {
      rateWindows.set(key, arr);
      return false;
    }
    arr.push(now);
    rateWindows.set(key, arr);
    return true;
  }

  const api = {
    ISOLATION_LEVELS,
    get quotas() {
      return globalQuotas;
    },
    quotasFor: effectiveQuotas,
    tenantQuotas,
    stateFile,

    async load() {
      if (!stateFile || !exists(stateFile)) return { loaded: false };
      const saved = await readJson(stateFile, null);
      if (saved) state = { ...state, ...saved };
      logger?.warn?.('swarm.governance_loaded', { frozen: Object.keys(state.frozen ?? {}).length, isolation: state.isolation ?? {} });
      return { loaded: true, state };
    },

    isolationOf,
    describe(tenantId) {
      const level = isolationOf(tenantId);
      return { tenantId, level, ...ISOLATION_LEVELS[level], frozenReason: state.frozenReason?.[tenantId] ?? null, quotas: effectiveQuotas(tenantId) };
    },

    /** Board (čovjek) mijenja izolaciju — auditovano. */
    async setIsolation(tenantId, level, { by = 'human', reason = null } = {}) {
      if (!ISOLATION_LEVELS[level]) throw new ValidationError(`Nepoznat izolacioni nivo: ${level}`);
      state.isolation[tenantId] = level;
      if (level !== 'frozen') state.frozen[tenantId] = false;
      await persist();
      metrics?.inc('swarm_isolation_changes_total', { tenant: tenantId, level });
      await audit?.append({ tenantId, actor: by, action: 'swarm_isolation_set', args: { level, reason }, decision: 'allow', outcome: 'ok' });
      logger?.warn?.('swarm.isolation_set', { tenantId, isolationLevel: level, by, reason });
      return api.describe(tenantId);
    },

    /** Kill switch na nivou roja: zaustavlja SVE runove tog tenanta odmah. */
    async freeze(tenantId, { reason = 'manual', by = 'human' } = {}) {
      state.frozen[tenantId] = true;
      state.frozenReason[tenantId] = reason;
      state.isolation[tenantId] = 'frozen';
      await persist();
      metrics?.inc('swarm_freeze_total', { tenant: tenantId, reason });
      await audit?.append({ tenantId, actor: by, action: 'swarm_freeze', args: { reason }, decision: 'deny', outcome: 'blocked' });
      logger?.error?.('swarm.frozen', { tenantId, reason, by });
      return api.describe(tenantId);
    },

    async unfreeze(tenantId, { by = 'human', level = 'contained' } = {}) {
      state.frozen[tenantId] = false;
      state.frozenReason[tenantId] = null;
      state.isolation[tenantId] = level;
      await persist();
      await audit?.append({ tenantId, actor: by, action: 'swarm_unfreeze', args: { level }, decision: 'allow', outcome: 'ok' });
      logger?.warn?.('swarm.unfrozen', { tenantId, by, isolationLevel: level });
      return api.describe(tenantId);
    },

    /** Smije li worker izvršiti ovaj zadatak (izolacija + autonomija + kvote). */
    async assertCanRun({ tenantId, workerId, riskLevel = 'low', task = null, costUsd = 0, autonomous = true }) {
      const quotas = effectiveQuotas(tenantId);
      const level = isolationOf(tenantId);
      const rules = ISOLATION_LEVELS[level];
      if (!rules.canRun) throw new PolicyError(`Swarm je u stanju "${level}" — izvršavanje je zaustavljeno`, { level, tenantId });
      if (riskLevel === 'high' || riskLevel === 'medium') {
        throw new PolicyError(`Swarm izvršava samo nizak rizik (zadatak traži ${riskLevel})`, { level, riskLevel });
      }
      if (!allowRate(tenantId, 'claims', workerId, quotas.maxClaimsPerWorkerPerMin)) {
        metrics?.inc('swarm_quota_blocks_total', { tenant: tenantId, kind: 'claims' });
        throw new PolicyError(`Worker ${workerId} prekoračio ${quotas.maxClaimsPerWorkerPerMin} preuzimanja u minuti`, { workerId });
      }
      if (costUsd > 0) {
        const spent = (rateWindows.get(`${tenantId}::cost`) ?? []).filter((t) => Date.now() - t.ts < 3_600_000);
        const total = spent.reduce((s, x) => s + (x.amountUsd ?? 0), 0);
        if (total + costUsd > quotas.maxCostPerHourUsd) {
          metrics?.inc('swarm_quota_blocks_total', { tenant: tenantId, kind: 'cost' });
          throw new PolicyError(`Swarm je dostigao satni budžet (${quotas.maxCostPerHourUsd} USD)`, { total, costUsd });
        }
      }
      // Autonomija: ako swarm radi proaktivno, mora imati dozvolu agenta
      if (autonomous && autonomy?.evaluate) {
        const verdict = autonomy.evaluate({ tenantId, agentId: task?.meta?.agentId ?? null, riskLevel, kind: 'act' });
        if (verdict.action === 'deny') throw new PolicyError(`Autonomija ne dozvoljava swarm akciju: ${verdict.reason}`, { verdict });
      }
      return { allowed: true, level, quotas };
    },

    /** Smije li peer poruka (covert channel je zabranjen; sve ide kroz mediate bus). */
    assertCanPeerMessage({ tenantId, from, to }) {
      const quotas = effectiveQuotas(tenantId);
      const level = isolationOf(tenantId);
      if (!ISOLATION_LEVELS[level].canPeerMessage) throw new PolicyError(`Swarm u stanju "${level}" ne dozvoljava peer poruke`, { level });
      if (!allowRate(tenantId, 'peer', `${from}->${to}`, quotas.maxPeerMessagesPerMin)) {
        metrics?.inc('swarm_quota_blocks_total', { tenant: tenantId, kind: 'peer' });
        throw new PolicyError(`Prekoračen broj peer poruka (${quotas.maxPeerMessagesPerMin}/min)`, { from, to });
      }
      return true;
    },

    assertCanPheromone({ tenantId, by }) {
      const quotas = effectiveQuotas(tenantId);
      if (!allowRate(tenantId, 'pheromone', by ?? 'swarm', quotas.maxPheromonesPerMin)) {
        metrics?.inc('swarm_quota_blocks_total', { tenant: tenantId, kind: 'pheromone' });
        throw new PolicyError(`Prekoračen broj feromona (${quotas.maxPheromonesPerMin}/min)`, { by });
      }
      return true;
    },

    /** Koliko workera tenant smije imati — kvota se STVARNO provjerava pri registraciji. */
    assertWorkerQuota(tenantId, currentWorkers) {
      const quotas = effectiveQuotas(tenantId);
      if (currentWorkers >= quotas.maxWorkers) {
        metrics?.inc('swarm_quota_blocks_total', { tenant: tenantId, kind: 'workers' });
        throw new PolicyError(`Dostignut maksimum workera za tenant (${quotas.maxWorkers})`, { currentWorkers, maxWorkers: quotas.maxWorkers });
      }
      return true;
    },

    /** Koliko otvorenih zadataka tabla smije imati. */
    assertTaskQuota(tenantId, openTasks) {
      const quotas = effectiveQuotas(tenantId);
      if (openTasks >= quotas.maxTasksOpen) {
        metrics?.inc('swarm_quota_blocks_total', { tenant: tenantId, kind: 'tasks' });
        throw new PolicyError(`Dostignut maksimum otvorenih zadataka (${quotas.maxTasksOpen})`, { openTasks });
      }
      return true;
    },

    canUseNetwork: (tenantId) => ISOLATION_LEVELS[isolationOf(tenantId)].canUseNetwork,

    /** Board (owner) mijenja kvote — auditovano. */
    async setQuotas(tenantId, patch = {}, { by = 'board' } = {}) {
      const current = tenantQuotas.get(tenantId) ?? {};
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in DEFAULT_QUOTAS)) throw new ValidationError(`Nepoznata kvota: ${k}`);
        if (!(Number(v) > 0)) throw new ValidationError(`Kvota ${k} mora biti pozitivna`);
        current[k] = Number(v);
      }
      tenantQuotas.set(tenantId, current);
      await persist();
      await audit?.append({ tenantId, actor: by, action: 'swarm_quotas_set', args: patch, decision: 'allow', outcome: 'ok' });
      logger?.warn?.('swarm.quotas_set', { tenantId, patch, by });
      return effectiveQuotas(tenantId);
    },

    /** Satni trošak se evidentira pri svakom runu (za kvotu). */
    recordCost(tenantId, { amountUsd, workerId = null }) {
      const key = `${tenantId}::cost`;
      const arr = (rateWindows.get(key) ?? []).filter((t) => Date.now() - t.ts < 3_600_000);
      arr.push({ ts: Date.now(), amountUsd: Number(amountUsd) || 0, workerId });
      rateWindows.set(key, arr);
      return arr.reduce((s, x) => s + x.amountUsd, 0);
    },

    /** Stanje (izolacija/freeze) — koristi se pri seedovanju iz config-a da se ne pregazi perzistirano. */
    get state() {
      return state;
    },

    async history(tenantId, { limit = 50 } = {}) {
      if (!dataDir) return []; // bez dataDir nema fajla (ranije je bacalo TypeError)
      const file = path.join(dataDir, 'tenants', tenantId, 'swarm', 'governance.jsonl');
      const { readJsonl } = await import('../core/fsx.js');
      return readJsonl(file, { limit, tail: true });
    },

    async auditChange(tenantId, { action, args, by = 'board' }) {
      if (dataDir) await appendJsonl(path.join(dataDir, 'tenants', tenantId, 'swarm', 'governance.jsonl'), { ts: iso(), tenantId, action, args, by });
      return audit?.append({ tenantId, actor: by, action, args, decision: 'allow', outcome: 'ok' });
    },
  };

  return api;
}
