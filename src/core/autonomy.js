/**
 * Autonomija: koliko agent smije sam, i koje brave to drže.
 *
 * Nivoi (po tenantu i po agentu):
 *   L0 assistant      — samo odgovara na zahtjev; ništa ne inicira
 *   L1 propose        — smije da PREDLOŽI akciju (ulazi u inbox za odobrenje)
 *   L2 supervised     — smije sam da izvrši akcije niskog rizika; srednji/visok → odobrenje
 *   L3 goal           — smije sam da juri cilj (planira, zakazuje poslove), uz budžet i nedjeljni pregled
 *   L4 autonomous     — smije i akcije srednjeg rizika; visok rizik (novac, pravno, brisanje) UVIJEK čovjek
 *
 * Pravila koja važe na SVIM nivoima (nema izuzetka):
 *   - `high` rizik uvijek traži odobrenje čovjeka
 *   - mjesečni budžet tenanta i per-agent budžet su tvrdi
 *   - kill switch (tenant suspend / agent paused) je iznad svega
 *   - svaka autonomna akcija ostavlja audit zapis sa nivoom autonomije
 */
import path from 'node:path';
import { exists, readJson, writeJson } from './fsx.js';
import { PolicyError, ValidationError } from './errors.js';

export const AUTONOMY_LEVELS = {
  L0: { name: 'assistant', rank: 0, canPropose: false, canActLow: false, canActMedium: false, canPlan: false },
  L1: { name: 'propose', rank: 1, canPropose: true, canActLow: false, canActMedium: false, canPlan: false },
  L2: { name: 'supervised', rank: 2, canPropose: true, canActLow: true, canActMedium: false, canPlan: true },
  L3: { name: 'goal', rank: 3, canPropose: true, canActLow: true, canActMedium: false, canPlan: true },
  L4: { name: 'autonomous', rank: 4, canPropose: true, canActLow: true, canActMedium: true, canPlan: true },
};

/** Rizik koji se NIKAD ne pušta bez čovjeka, na svim nivoima. */
export const HUMAN_ONLY = ['financial', 'legal', 'destructive', 'external_communication'];

export function createAutonomy({
  config = {},
  dataDir,
  logger,
  metrics,
  audit,
} = {}) {
  const levels = new Map(); // `${tenantId}::${agentId}` -> 'L2'
  const stateFile = dataDir ? path.join(dataDir, '_control', 'autonomy.json') : null;

  const key = (tenantId, agentId) => `${tenantId}::${agentId ?? '*'}`;

  async function persist() {
    if (!stateFile) return;
    await writeJson(stateFile, { updatedAt: new Date().toISOString(), levels: Object.fromEntries(levels) }).catch((err) => logger?.warn?.('autonomy.persist_failed', { error: err.message }));
  }

  /** Nivo za tenant/agenta: specifičan agent → tenant default → globalni default. */
  function levelOf(tenantId, agentId) {
    return (
      levels.get(key(tenantId, agentId)) ??
      levels.get(key(tenantId, '*')) ??
      levels.get(key('*', '*')) ??
      config.default ??
      'L1'
    );
  }

  function describe(tenantId, agentId) {
    const level = levelOf(tenantId, agentId);
    return { level, ...AUTONOMY_LEVELS[level] };
  }

  return {
    AUTONOMY_LEVELS,
    HUMAN_ONLY,
    stateFile,

    /** Učitava nivoe iz `data/_control/autonomy.json` — promjene preživljavaju restart. */
    async load() {
      if (!stateFile || !exists(stateFile)) return { loaded: 0 };
      const saved = await readJson(stateFile, { levels: {} });
      let loaded = 0;
      for (const [k, level] of Object.entries(saved?.levels ?? {})) {
        if (AUTONOMY_LEVELS[level]) {
          levels.set(k, level);
          loaded += 1;
        }
      }
      if (loaded) logger?.info?.('autonomy.loaded', { loaded });
      return { loaded };
    },

    setLevel(tenantId, agentId, level) {
      if (!AUTONOMY_LEVELS[level]) throw new ValidationError(`Nepoznat nivo autonomije: ${level} (dozvoljeno: ${Object.keys(AUTONOMY_LEVELS).join(', ')})`);
      levels.set(key(tenantId, agentId), level);
      persist();
      logger?.warn?.('autonomy.level_changed', { tenantId, agentId: agentId ?? '*', autonomyLevel: level });
      metrics?.inc('autonomy_level_changes_total', { tenant: tenantId, level });
      return { tenantId, agentId: agentId ?? '*', level };
    },
    hasLevel: (tenantId, agentId) => levels.has(key(tenantId, agentId)),
    levelOf,
    describe,
    list: () => [...levels.entries()].map(([k, level]) => { const [tenantId, agentId] = k.split('::'); return { tenantId, agentId, level }; }),
    snapshot: () => ({ default: config.default ?? 'L1', levels: Object.fromEntries(levels) }),

    /**
     * Centralna provjera prije bilo koje proaktivne/autonomne akcije.
     * @param {object} req { tenantId, agentId, riskLevel, kind, detail }
     * @returns {{level, action: 'allow'|'require_approval'|'deny', reason}}
     */
    evaluate({ tenantId, agentId, riskLevel = 'low', kind = 'act', detail = {} } = {}) {
      const level = levelOf(tenantId, agentId);
      const def = AUTONOMY_LEVELS[level];

      // 1) prijedlog (npr. watcher predlaže akciju) — dozvoljen od L1
      if (kind === 'propose') {
        return def.canPropose
          ? { level, action: 'allow', reason: `L${def.rank} ${def.name}: predlaganje je dozvoljeno` }
          : { level, action: 'deny', reason: `L${def.rank} ${def.name}: agent još ne smije ni predlagati akcije` };
      }

      // 2) planiranje (pravi planove, zakazuje poslove)
      if (kind === 'plan') {
        return def.canPlan
          ? { level, action: 'allow', reason: `L${def.rank} ${def.name}: planiranje je dozvoljeno` }
          : { level, action: 'deny', reason: `L${def.rank} ${def.name}: planiranje nije dozvoljeno (podigni nivo na L2+)` };
      }

      // 3) izvršenje
      const humanOnly = (detail.tags ?? []).some((t) => HUMAN_ONLY.includes(t)) || detail.category && HUMAN_ONLY.includes(detail.category);
      if (riskLevel === 'high' || humanOnly) {
        return { level, action: 'require_approval', reason: 'visok rizik / kategorija rezervisana za čovjeka (važi na svim nivoima)' };
      }
      if (riskLevel === 'medium') {
        return def.canActMedium
          ? { level, action: 'allow', reason: `L${def.rank} ${def.name}: srednji rizik je dozvoljen` }
          : { level, action: 'require_approval', reason: `L${def.rank} ${def.name}: srednji rizik traži odobrenje (L4 ga izvršava sam)` };
      }
      return def.canActLow
        ? { level, action: 'allow', reason: `L${def.rank} ${def.name}: nizak rizik je dozvoljen` }
        : { level, action: 'require_approval', reason: `L${def.rank} ${def.name}: agent ne izvršava sam — predlaže` };
    },

    /** evaluate + audit + bacanje greške (za upotrebu u rutama i watcherima). */
    async assert({ tenantId, agentId, riskLevel = 'low', kind = 'act', detail = {}, actor = 'autonomy' } = {}) {
      const verdict = this.evaluate({ tenantId, agentId, riskLevel, kind, detail });
      metrics?.inc('autonomy_decisions_total', { tenant: tenantId, level: verdict.level, action: verdict.action, kind });
      if (verdict.action === 'deny') {
        await audit?.append({ tenantId, actor, action: 'autonomy_denied', args: { agentId, kind, riskLevel, detail }, decision: 'deny', outcome: 'blocked', meta: verdict });
        throw new PolicyError(`Autonomija ne dozvoljava: ${verdict.reason}`, { ...verdict, agentId, kind });
      }
      await audit?.append({
        tenantId,
        actor,
        action: 'autonomy_decision',
        args: { agentId, kind, riskLevel },
        decision: verdict.action === 'allow' ? 'allow' : 'require_approval',
        outcome: verdict.action === 'allow' ? 'ok' : 'pending',
        meta: verdict,
      });
      return verdict;
    },
  };
}
