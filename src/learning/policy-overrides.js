/**
 * Runtime izmjene politika (ono što self-improvement smije sam da mijenja — uz odobrenje čovjeka).
 * Politika se NIKAD ne mijenja u `config/policies.json` iz koda: izmjene žive ovdje i merge-uju se
 * preko config-a. Tako se vidi razlika između „tvorničke" i „naučene" politike, i može se vratiti.
 *
 * Stanje: data/tenants/<id>/learning/policy-overrides.json
 */
import path from 'node:path';
import { readJson, writeJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { deepMerge } from '../core/config-utils.js';

export function createPolicyOverrides({ dataDir, logger } = {}) {
  const cache = new Map();
  const file = (tenantId) => path.join(dataDir, 'tenants', tenantId, 'learning', 'policy-overrides.json');

  async function load(tenantId) {
    if (cache.has(tenantId)) return cache.get(tenantId);
    const state = (await readJson(file(tenantId), { overrides: [] })) ?? { overrides: [] };
    if (!Array.isArray(state.overrides)) state.overrides = [];
    cache.set(tenantId, state);
    return state;
  }

  return {
    file,
    async load(tenantId) {
      return load(tenantId);
    },
    /** Aktivna (merge-ovana) izmjena za tenanta. */
    async active(tenantId) {
      const state = await load(tenantId);
      return state.overrides.filter((o) => o.active).reduce((acc, o) => deepMerge(acc, o.patch), {});
    },
    /** Aktivna izmjena za tenanta, sinhrono iz keša (za policyResolver). */
    activeSync(tenantId) {
      const state = cache.get(tenantId);
      if (!state) return {};
      return state.overrides.filter((o) => o.active).reduce((acc, o) => deepMerge(acc, o.patch), {});
    },
    async apply(tenantId, { id, patch, rationale, source = 'self-improvement', proposalId = null }) {
      const state = await load(tenantId);
      const entry = { id, patch, rationale, source, proposalId, active: true, appliedAt: iso() };
      state.overrides = [...state.overrides, entry];
      await writeJson(file(tenantId), state);
      logger?.warn?.('policy_override.applied', { tenantId, id, keys: Object.keys(patch) });
      return entry;
    },
    async revert(tenantId, id) {
      const state = await load(tenantId);
      const entry = state.overrides.find((o) => o.id === id);
      if (!entry) return null;
      entry.active = false;
      entry.revertedAt = iso();
      await writeJson(file(tenantId), state);
      logger?.warn?.('policy_override.reverted', { tenantId, id });
      return entry;
    },
    async list(tenantId) {
      const state = await load(tenantId);
      return state.overrides;
    },
  };
}
