/**
 * Control plane (OCE-stil, bez zavisnosti):
 *   - Agent registry sa VERZIJAMA: deploy, rollback, pause/resume/retire
 *   - Per-agent identitet: sopstveni API ključ, role/scope, posljednja upotreba
 *   - Per-agent budžet: mjesečni limit po agentu (iz cost trackera), tvrdi prekid
 *   - Audit svake lifecycle akcije
 *
 * Stanje: data/_control/agents.json  (globalno; po tenantu unutra)
 */
import path from 'node:path';
import { exists, readJson, writeJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid, token, sha256, safeEqual } from '../core/ids.js';
import { PolicyError, NotFoundError, ValidationError } from '../core/errors.js';

export function createControlPlane({ config, catalog, dataDir, logger, metrics, audit, cost, tenants, env = {} } = {}) {
  const file = path.join(dataDir, '_control', 'agents.json');
  let state = { version: 1, updatedAt: null, tenants: {} };

  const emptyTenant = () => ({ agents: {} });
  const ensureTenant = (tenantId) => {
    if (!state.tenants[tenantId]) state.tenants[tenantId] = emptyTenant();
    return state.tenants[tenantId];
  };

  const emptyAgent = (agentId) => ({
    id: agentId,
    status: 'active',
    activeVersion: 0,
    versions: [],
    overrides: {},
    keys: [],
    budgetUsdMonth: null,
    createdAt: iso(),
  });

  const ensureAgent = (tenantId, agentId) => {
    const t = ensureTenant(tenantId);
    if (!t.agents[agentId]) t.agents[agentId] = emptyAgent(agentId);
    return t.agents[agentId];
  };

  const hashKey = (key) => sha256(`${env.apiKeyPepper ?? process.env.NMQ_API_KEY_PEPPER ?? 'nmq-robot'}:${key}`);

  async function persist() {
    state.updatedAt = iso();
    if (dataDir) await writeJson(file, state);
    return state;
  }

  async function load() {
    if (dataDir) {
      const saved = exists(file) ? await readJson(file, {}) : null;
      if (saved?.tenants) state = saved;
    }
    // primijeni aktivne overrides na katalog (poslije restarta)
    for (const [tenantId, t] of Object.entries(state.tenants)) {
      for (const [agentId, a] of Object.entries(t.agents ?? {})) {
        if (a.status === 'active' && a.overrides && Object.keys(a.overrides).length) {
          catalog.setOverride(tenantId, agentId, a.overrides);
          logger?.info?.('controlplane.override_restored', { tenantId, agentId, version: a.activeVersion });
        }
      }
    }
    return state;
  }

  function agentSpend(tenantId, agentId, summary) {
    return Number(summary?.byAgent?.[agentId] ?? 0);
  }

  async function auditLifecycle({ tenantId, actor, action, agentId, meta = {}, decision = 'allow', outcome = 'ok' }) {
    await audit?.append({ tenantId, actor: actor ?? 'control-plane', action, tool: null, args: { agentId }, decision, outcome, meta });
  }

  return {
    file,
    load,
    get state() {
      return state;
    },

    /** Lista agenata sa statusom, verzijom, potrošnjom i budžetom. */
    async list(tenantId, { withSpend = true } = {}) {
      if (!tenants.has(tenantId)) throw new NotFoundError('Tenant', tenantId);
      const t = ensureTenant(tenantId);
      const summary = withSpend && cost ? await cost.summary(tenantId) : null;
      const known = catalog.ids();
      const rows = known.map((agentId) => {
        const a = t.agents[agentId] ?? emptyAgent(agentId);
        const spendUsd = summary ? agentSpend(tenantId, agentId, summary) : 0;
        return {
          id: agentId,
          status: a.status,
          activeVersion: a.activeVersion,
          versions: a.versions.length,
          overrides: Object.keys(a.overrides ?? {}),
          keys: (a.keys ?? []).length,
          budgetUsdMonth: a.budgetUsdMonth,
          spendUsd,
          budgetUsedPct: a.budgetUsdMonth ? Number(((spendUsd / a.budgetUsdMonth) * 100).toFixed(1)) : null,
          lastDeployAt: a.versions.at(-1)?.createdAt ?? null,
        };
      });
      // agenti koji postoje samo u control plane-u (obrisani iz config-a)
      for (const [agentId, a] of Object.entries(t.agents)) {
        if (!known.includes(agentId)) rows.push({ id: agentId, status: a.status, activeVersion: a.activeVersion, versions: a.versions.length, missingInConfig: true });
      }
      return rows;
    },

    get(tenantId, agentId) {
      const t = ensureTenant(tenantId);
      const a = t.agents[agentId] ?? emptyAgent(agentId);
      return { ...a, effective: catalog.get(agentId, tenantId) ?? null };
    },

    /**
     * Deploy nove verzije agenta: zakrpa (npr. {systemPrompt, tools, temperature, maxSteps}) postaje aktivna odmah.
     * Rollback vraća prethodnu verziju.
     */
    async deploy(tenantId, agentId, { patch = {}, actor = 'control-plane', note = null } = {}) {
      if (!tenants.has(tenantId)) throw new NotFoundError('Tenant', tenantId);
      const base = catalog.get(agentId, tenantId);
      if (!base) throw new NotFoundError('Agent', agentId);
      if (!patch || typeof patch !== 'object' || !Object.keys(patch).length) throw new ValidationError('Deploy traži najmanje jedno polje u "patch"');

      const a = ensureAgent(tenantId, agentId);
      const version = (a.activeVersion ?? 0) + 1;
      a.overrides = { ...(a.overrides ?? {}), ...patch };
      a.activeVersion = version;
      a.status = 'active';
      a.versions = [...(a.versions ?? []), { version, patch, actor, note, createdAt: iso(), specHash: sha256({ agentId, patch }) }];
      await persist();
      catalog.setOverride(tenantId, agentId, a.overrides);
      metrics?.inc('controlplane_deploys_total', { tenant: tenantId, agent: agentId });
      await auditLifecycle({ tenantId, actor, action: 'agent_deploy', agentId, meta: { version, fields: Object.keys(patch), note } });
      logger?.info?.('controlplane.deploy', { tenantId, agentId, version, fields: Object.keys(patch) });
      return { agentId, version, active: catalog.get(agentId, tenantId), patch };
    },

    async rollback(tenantId, agentId, version) {
      const t = ensureTenant(tenantId);
      const a = t.agents[agentId];
      if (!a) throw new NotFoundError('Agent u control plane-u', agentId);
      const target = version === 0 ? { version: 0, patch: {} } : version ? a.versions.find((v) => v.version === version) : a.versions.at(-2);
      if (!target) throw new ValidationError(`Nema verzije ${version ?? '(prethodna)'} za agenta ${agentId}`);

      // rekonstruiši overrides sabiranjem svih verzija do ciljne
      const accumulated = {};
      for (const v of a.versions.filter((x) => x.version <= target.version)) Object.assign(accumulated, v.patch);
      const rolledBackFrom = a.activeVersion;
      a.overrides = accumulated;
      a.activeVersion = target.version;
      a.versions = [...a.versions, { version: target.version, patch: accumulated, actor: 'rollback', note: `rollback sa v${rolledBackFrom}`, createdAt: iso(), specHash: sha256({ agentId, patch: accumulated }) }];
      await persist();
      if (Object.keys(accumulated).length) catalog.setOverride(tenantId, agentId, accumulated);
      else catalog.clearOverride(tenantId, agentId);
      metrics?.inc('controlplane_rollbacks_total', { tenant: tenantId, agent: agentId });
      await auditLifecycle({ tenantId, action: 'agent_rollback', agentId, meta: { from: rolledBackFrom, to: target.version }, outcome: 'ok' });
      logger?.warn?.('controlplane.rollback', { tenantId, agentId, from: rolledBackFrom, to: target.version });
      return { agentId, activeVersion: target.version, overrides: accumulated };
    },

    async setStatus(tenantId, agentId, status, { actor = 'control-plane', reason = null } = {}) {
      if (!['active', 'paused', 'retired'].includes(status)) throw new ValidationError(`Nepoznat status: ${status}`);
      const a = ensureAgent(tenantId, agentId);
      a.status = status;
      a.statusReason = reason;
      await persist();
      if (status === 'active' && Object.keys(a.overrides ?? {}).length) catalog.setOverride(tenantId, agentId, a.overrides);
      else if (status !== 'active') catalog.clearOverride(tenantId, agentId);
      metrics?.inc('controlplane_status_changes_total', { tenant: tenantId, agent: agentId, status });
      await auditLifecycle({ tenantId, actor, action: `agent_${status}`, agentId, meta: { reason } });
      return { agentId, status };
    },

    async setBudget(tenantId, agentId, budgetUsdMonth, { actor = 'control-plane' } = {}) {
      const a = ensureAgent(tenantId, agentId);
      a.budgetUsdMonth = budgetUsdMonth === null ? null : Number(budgetUsdMonth);
      await persist();
      await auditLifecycle({ tenantId, actor, action: 'agent_budget_set', agentId, meta: { budgetUsdMonth: a.budgetUsdMonth } });
      return { agentId, budgetUsdMonth: a.budgetUsdMonth };
    },

    /**
     * Tvrda provjera prije svakog run-a: agent pauziran/penzionisan ili preko mjesečnog budžeta → prekid.
     */
    async assertAgentBudget(tenantId, agentId) {
      const t = state.tenants[tenantId];
      const a = t?.agents?.[agentId];
      if (!a) return true;
      if (a.status === 'paused' || a.status === 'retired') {
        metrics?.inc('controlplane_blocked_total', { tenant: tenantId, agent: agentId, reason: a.status });
        throw new PolicyError(`Agent "${agentId}" je ${a.status === 'paused' ? 'pauziran' : 'penzionisan'}`, { agentId, status: a.status });
      }
      if (a.budgetUsdMonth) {
        const summary = await cost.summary(tenantId);
        const spend = agentSpend(tenantId, agentId, summary);
        if (spend >= a.budgetUsdMonth) {
          metrics?.inc('controlplane_blocked_total', { tenant: tenantId, agent: agentId, reason: 'budget' });
          await auditLifecycle({ tenantId, action: 'agent_budget_block', agentId, meta: { spend, budget: a.budgetUsdMonth }, decision: 'deny', outcome: 'blocked' });
          throw new PolicyError(`Agent "${agentId}" je potrošio mjesečni budžet (${spend.toFixed(4)} / ${a.budgetUsdMonth} USD)`, { agentId, spend, budget: a.budgetUsdMonth });
        }
      }
      return true;
    },

    // ---------- per-agent identitet (service account) ----------

    async issueAgentKey(tenantId, agentId, { role = 'agent', scopes = [], actor = 'control-plane', label = null } = {}) {
      const a = ensureAgent(tenantId, agentId);
      const key = `nmqa_${token(24)}`;
      const record = { id: uid('akey'), hash: hashKey(key), role, scopes, label, createdAt: iso(), createdBy: actor, lastUsedAt: null, revokedAt: null };
      a.keys = [...(a.keys ?? []), record];
      await persist();
      await auditLifecycle({ tenantId, actor, action: 'agent_key_issued', agentId, meta: { keyId: record.id, role, scopes } });
      logger?.info?.('controlplane.agent_key_issued', { tenantId, agentId, keyId: record.id });
      return { key, keyId: record.id, agentId, tenantId, role, scopes, warning: 'Ključ se prikazuje samo sada — sačuvaj ga.' };
    },

    async revokeAgentKey(tenantId, agentId, keyId, { actor = 'control-plane' } = {}) {
      const a = state.tenants[tenantId]?.agents?.[agentId];
      const rec = a?.keys?.find((k) => k.id === keyId);
      if (!rec) throw new NotFoundError('Agent ključ', keyId);
      rec.revokedAt = iso();
      await persist();
      await auditLifecycle({ tenantId, actor, action: 'agent_key_revoked', agentId, meta: { keyId } });
      return { keyId, revokedAt: rec.revokedAt };
    },

    /** Provjera agent ključa (service account). Vraća {tenantId, agentId, role, scopes} ili null. */
    authenticateAgentKey(key) {
      if (!key) return null;
      const candidateHash = hashKey(key);
      for (const [tenantId, t] of Object.entries(state.tenants)) {
        for (const [agentId, a] of Object.entries(t.agents ?? {})) {
          for (const rec of a.keys ?? []) {
            if (rec.revokedAt) continue;
            if (safeEqual(rec.hash, candidateHash)) {
              rec.lastUsedAt = iso();
              // Perzistiraj upotrebu ključa (bez čekanja — ne blokira zahtjev)
              persist().catch((err) => logger?.debug?.('controlplane.persist_failed', { error: err.message }));
              metrics?.inc('agent_key_auth_total', { tenant: tenantId, agent: agentId });
              return { tenantId, agentId, role: rec.role, scopes: rec.scopes ?? [], keyId: rec.id, auth: 'agent-key' };
            }
          }
        }
      }
      return null;
    },

    async snapshot() {
      return { updatedAt: state.updatedAt, tenants: Object.keys(state.tenants).length, agents: Object.values(state.tenants).reduce((n, t) => n + Object.keys(t.agents ?? {}).length, 0) };
    },
  };
}
