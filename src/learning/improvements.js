/**
 * Self-improvement: prijedlozi poboljšanja → odobrenje čovjeka → primjena → mjerenje → rollback.
 *
 * Tipovi prijedloga:
 *   prompt    — nova verzija system prompta agenta (ide kroz control plane deploy)
 *   pattern   — promjena default patterna agenta
 *   policy    — izmjena politike (allow/deny/approval/budžet) — runtime override, reverzibilan
 *   kb        — dopuna baze znanja (novi dokument/chunk)
 *   action    — predložena konkretna akcija (iz watchera) koju čovjek odobri i pokrene
 *   tool/code — traži izmjenu koda/MCP servera → ostaje kao zadatak za čovjeka (status needs_code)
 *
 * A/B: varijante se primjenjuju PO RUN-U (`options.specPatch`), pa više varijanti može živjeti istovremeno.
 * Stanje: data/tenants/<id>/learning/proposals.json + experiments.json
 */
import path from 'node:path';
import { readJson, writeJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid, sha256 } from '../core/ids.js';
import { ValidationError, NotFoundError, PolicyError } from '../core/errors.js';

const KINDS = ['prompt', 'pattern', 'policy', 'kb', 'action', 'tool', 'code'];
const APPLIABLE = ['prompt', 'pattern', 'policy', 'kb', 'action'];

export function createImprovementEngine({
  dataDir,
  logger,
  metrics,
  audit,
  rewards,
  controlPlane,
  policyOverrides,
  autonomy,
  orchestrator,
  memory,
  catalog,
  helpers,
} = {}) {
  const proposalCache = new Map();
  const experimentCache = new Map();

  const pFile = (tenantId) => path.join(dataDir, 'tenants', tenantId, 'learning', 'proposals.json');
  const eFile = (tenantId) => path.join(dataDir, 'tenants', tenantId, 'learning', 'experiments.json');

  async function loadProposals(tenantId) {
    if (proposalCache.has(tenantId)) return proposalCache.get(tenantId);
    const state = (await readJson(pFile(tenantId), { proposals: {} })) ?? { proposals: {} };
    if (!state.proposals) state.proposals = {};
    proposalCache.set(tenantId, state);
    return state;
  }
  async function loadExperiments(tenantId) {
    if (experimentCache.has(tenantId)) return experimentCache.get(tenantId);
    const state = (await readJson(eFile(tenantId), { experiments: {} })) ?? { experiments: {} };
    if (!state.experiments) state.experiments = {};
    experimentCache.set(tenantId, state);
    return state;
  }

  return {
    KINDS,
    APPLIABLE,

    /** Predlaže poboljšanje (iz RSI analize, self-play-a, watchera ili čovjeka). */
    async createProposal(tenantId, spec = {}) {
      if (!spec.kind || !KINDS.includes(spec.kind)) throw new ValidationError(`Prijedlog traži "kind" (${KINDS.join(', ')})`);
      if (!spec.rationale) throw new ValidationError('Prijedlog traži "rationale" (zašto)');
      const state = await loadProposals(tenantId);
      const proposal = {
        id: spec.id ?? uid('prop'),
        tenantId,
        ts: iso(),
        kind: spec.kind,
        target: spec.target ?? null,
        current: spec.current ?? null,
        proposed: spec.proposed ?? null,
        rationale: spec.rationale,
        evidence: spec.evidence ?? [],
        expectedImpact: spec.expectedImpact ?? null,
        riskLevel: spec.riskLevel ?? 'medium',
        source: spec.source ?? 'manual',
        status: 'proposed',
        requiresHuman: true,
        history: [{ ts: iso(), event: 'proposed', by: spec.source ?? 'system' }],
      };
      proposal.hash = sha256({ kind: proposal.kind, target: proposal.target, proposed: proposal.proposed }).slice(0, 16);
      state.proposals[proposal.id] = proposal;
      await writeJson(pFile(tenantId), state);
      metrics?.inc('improvement_proposals_total', { tenant: tenantId, kind: proposal.kind, source: proposal.source });
      await audit?.append({
        tenantId,
        actor: proposal.source,
        action: 'improvement_proposed',
        args: { proposalId: proposal.id, kind: proposal.kind, target: proposal.target, riskLevel: proposal.riskLevel },
        decision: 'require_approval',
        outcome: 'pending',
        meta: { rationale: proposal.rationale, expectedImpact: proposal.expectedImpact },
      });
      logger?.info?.('improvement.proposed', { tenantId, id: proposal.id, kind: proposal.kind, target: proposal.target });
      return proposal;
    },

    async list(tenantId, { status, kind } = {}) {
      const state = await loadProposals(tenantId);
      return Object.values(state.proposals)
        .filter((p) => (!status || p.status === status) && (!kind || p.kind === kind))
        .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    },

    async get(tenantId, id) {
      const state = await loadProposals(tenantId);
      const p = state.proposals[id];
      if (!p) throw new NotFoundError('Prijedlog', id);
      return p;
    },

    /** Dopuna prijedloga (npr. self-play naknadno doda predloženi prompt). */
    async updateProposal(tenantId, id, patch = {}) {
      const state = await loadProposals(tenantId);
      const p = state.proposals[id];
      if (!p) throw new NotFoundError('Prijedlog', id);
      if (!['proposed', 'approved'].includes(p.status)) throw new ValidationError(`Prijedlog se može dopuniti samo dok nije primijenjen (status: ${p.status})`);
      Object.assign(p, patch, { updatedAt: iso() });
      p.history = [...p.history, { ts: iso(), event: 'updated', fields: Object.keys(patch) }];
      await writeJson(pFile(tenantId), state);
      return p;
    },

    async decide(tenantId, id, { approve, by = 'human', note = null } = {}) {
      const state = await loadProposals(tenantId);
      const p = state.proposals[id];
      if (!p) throw new NotFoundError('Prijedlog', id);
      if (p.status !== 'proposed') throw new ValidationError(`Prijedlog je već odlučen (status: ${p.status})`);
      p.status = approve ? 'approved' : 'rejected';
      p.decidedAt = iso();
      p.decidedBy = by;
      p.decisionNote = note;
      p.history = [...p.history, { ts: iso(), event: approve ? 'approved' : 'rejected', by, note }];
      await writeJson(pFile(tenantId), state);
      metrics?.inc('improvement_decisions_total', { tenant: tenantId, kind: p.kind, decision: p.status });
      await audit?.append({
        tenantId,
        actor: by,
        action: 'improvement_decision',
        args: { proposalId: id, kind: p.kind, target: p.target },
        decision: approve ? 'approved' : 'rejected',
        outcome: 'ok',
        meta: { note },
      });
      return p;
    },

    /**
     * Primjenjuje odobreni prijedlog.
     * Ne dira config fajlove: prompt/pattern idu kroz control plane, politika kroz runtime override,
     * KB kroz vektorsku bazu — sve je reverzibilno.
     */
    async apply(tenantId, id, { by = 'human' } = {}) {
      const state = await loadProposals(tenantId);
      const p = state.proposals[id];
      if (!p) throw new NotFoundError('Prijedlog', id);
      if (p.status !== 'approved') throw new ValidationError(`Samo odobren prijedlog se primjenjuje (status: ${p.status})`);

      let result;
      switch (p.kind) {
        case 'prompt': {
          if (!controlPlane) throw new PolicyError('Control plane nije dostupan — prompt se ne može primijeniti');
          // `proposed` može biti tekst (samo prompt) ILI objekat sa više polja (genom iz evolucije/RSI:
          // systemPrompt, temperature, maxTokens, defaultPattern) — ranije se prenosio SAMO prompt.
          let patch;
          if (typeof p.proposed === 'string') {
            if (!p.proposed.trim() || p.proposed === 'null') {
              throw new ValidationError('Prijedlog nema predloženi prompt — dopuni ga prije primjene (PATCH /v1/admin/proposals/:id)');
            }
            patch = { systemPrompt: p.proposed };
          } else if (p.proposed && typeof p.proposed === 'object') {
            const allowed = ['systemPrompt', 'temperature', 'maxTokens', 'defaultPattern'];
            patch = {};
            for (const key of allowed) if (p.proposed[key] !== undefined && p.proposed[key] !== null) patch[key] = p.proposed[key];
            if (!Object.keys(patch).length) throw new ValidationError(`Objektni prijedlog mora sadržati bar jedno od: ${allowed.join(', ')}`);
            if (patch.temperature !== undefined && !(Number(patch.temperature) >= 0 && Number(patch.temperature) <= 2)) {
              throw new ValidationError(`Temperatura ${patch.temperature} je izvan dozvoljenog opsega 0–2`);
            }
            // Napomena: validnost `defaultPattern` se provjerava prije kreiranja prijedloga
            // (evolution.assertSafe / RSI designExperiment), ovdje se ne duplira lista patterna.
          } else {
            throw new ValidationError('Prijedlog nema predloženi sadržaj — dopuni ga prije primjene');
          }
          if (!catalog?.has?.(p.target)) throw new NotFoundError('Agent', p.target);
          result = await controlPlane.deploy(tenantId, p.target, { patch, actor: `improvement:${id}`, note: p.rationale });
          p.rollbackInfo = { type: 'control-plane', agentId: p.target, version: result.version };
          break;
        }
        case 'pattern': {
          if (!controlPlane) throw new PolicyError('Control plane nije dostupan');
          if (typeof p.proposed !== 'string' || !p.proposed.trim() || p.proposed === 'null') {
            throw new ValidationError('Prijedlog nema predloženi pattern — dopuni ga prije primjene');
          }
          if (!catalog?.has?.(p.target)) throw new NotFoundError('Agent', p.target);
          result = await controlPlane.deploy(tenantId, p.target, { patch: { defaultPattern: p.proposed }, actor: `improvement:${id}`, note: p.rationale });
          p.rollbackInfo = { type: 'control-plane', agentId: p.target, version: result.version };
          break;
        }
        case 'policy': {
          if (!policyOverrides) throw new PolicyError('Policy overrides nisu dostupni');
          result = await policyOverrides.apply(tenantId, { id: `po_${id}`, patch: p.proposed, rationale: p.rationale, proposalId: id });
          p.rollbackInfo = { type: 'policy-override', overrideId: `po_${id}` };
          break;
        }
        case 'kb': {
          if (!memory) throw new PolicyError('Memorija nije dostupna');
          const text = typeof p.proposed === 'string' ? p.proposed : p.proposed?.text;
          if (!text) throw new ValidationError('KB prijedlog traži tekst u "proposed"');
          result = await memory.vectors.ingest(tenantId, { text, source: p.proposed?.source ?? `self-improvement:${id}`, docId: p.proposed?.docId, metadata: { proposalId: id, tags: ['self-improvement'] } });
          p.rollbackInfo = { type: 'kb', proposalId: id };
          break;
        }
        case 'action': {
          if (!orchestrator) throw new PolicyError('Orchestrator nije dostupan');
          const decision = autonomy?.evaluate({ tenantId, agentId: p.target, riskLevel: p.proposed?.riskLevel ?? p.riskLevel, kind: 'act' }) ?? { action: 'allow' };
          if (decision.action === 'deny') throw new PolicyError(`Autonomija ne dozvoljava izvršenje: ${decision.reason}`);
          result = await orchestrator.run({ tenantId, agentId: p.target === 'router' ? null : p.target, pattern: p.proposed?.pattern, input: p.proposed?.input ?? p.rationale, userId: `improvement:${id}` });
          break;
        }
        default:
          p.status = 'needs_code';
          p.history = [...p.history, { ts: iso(), event: 'needs_code', by }];
          await writeJson(pFile(tenantId), state);
          return { proposal: p, result: null, message: 'Ovaj tip prijedloga traži izmjenu koda/MCP servera — ostaje kao zadatak.' };
      }

      p.status = 'applied';
      p.appliedAt = iso();
      p.appliedBy = by;
      p.applyResult = result?.runId ? { runId: result.runId } : result?.version ? { version: result.version } : result?.chunks ? { chunks: result.chunks } : result;
      p.history = [...p.history, { ts: iso(), event: 'applied', by }];
      await writeJson(pFile(tenantId), state);
      metrics?.inc('improvement_applied_total', { tenant: tenantId, kind: p.kind });
      await audit?.append({ tenantId, actor: by, action: 'improvement_applied', args: { proposalId: id, kind: p.kind, target: p.target }, decision: 'allow', outcome: 'ok', meta: { rollbackInfo: p.rollbackInfo ?? null } });
      logger?.warn?.('improvement.applied', { tenantId, id, kind: p.kind, target: p.target });
      return { proposal: p, result };
    },

    /** Vraća primijenjeni prijedlog (rollback). */
    async rollback(tenantId, id, { by = 'human' } = {}) {
      const state = await loadProposals(tenantId);
      const p = state.proposals[id];
      if (!p) throw new NotFoundError('Prijedlog', id);
      if (p.status !== 'applied') throw new ValidationError(`Samo primijenjen prijedlog se vraća (status: ${p.status})`);

      if (p.rollbackInfo?.type === 'control-plane' && controlPlane) {
        await controlPlane.rollback(tenantId, p.rollbackInfo.agentId, Math.max(0, p.rollbackInfo.version - 1));
      } else if (p.rollbackInfo?.type === 'policy-override' && policyOverrides) {
        await policyOverrides.revert(tenantId, p.rollbackInfo.overrideId);
      } else if (p.rollbackInfo?.type === 'kb' && memory) {
        // KB prijedlog se vraća brisanjem upravo unesenih zapisa (po metadata.proposalId)
        const removed = await memory.vectors.removeByMetadata?.(tenantId, { proposalId: p.rollbackInfo.proposalId });
        p.rollbackResult = removed ?? null;
      } else if (p.kind === 'action') {
        p.rollbackNote = 'Akcija je već izvršena (npr. poslan mejl) — nema automatskog vraćanja; evidentirano u auditu.';
      }
      p.status = 'rolled_back';
      p.rolledBackAt = iso();
      p.history = [...p.history, { ts: iso(), event: 'rolled_back', by }];
      await writeJson(pFile(tenantId), state);
      metrics?.inc('improvement_rollbacks_total', { tenant: tenantId, kind: p.kind });
      await audit?.append({ tenantId, actor: by, action: 'improvement_rollback', args: { proposalId: id, kind: p.kind }, decision: 'allow', outcome: 'ok' });
      return p;
    },

    // ─────────────── A/B eksperimenti ───────────────

    /**
     * Eksperiment: varijante se primjenjuju po run-u (specPatch), pa rade istovremeno.
     * @param {{variants:[{name, specPatch}], splitPct?:number, metric?:string}} spec
     */
    async createExperiment(tenantId, spec = {}) {
      if (!Array.isArray(spec.variants) || spec.variants.length < 2) throw new ValidationError('Eksperiment traži najmanje 2 varijante');
      if (!spec.agentId) throw new ValidationError('Eksperiment traži "agentId"');
      const state = await loadExperiments(tenantId);
      const exp = {
        id: spec.id ?? uid('ab'),
        tenantId,
        agentId: spec.agentId,
        metric: spec.metric ?? 'reward',
        variants: spec.variants.map((v) => ({ name: v.name, specPatch: v.specPatch ?? {}, n: 0, sumReward: 0, avgReward: 0 })),
        splitPct: spec.splitPct ?? 50, // % saobraćaja koji ulazi u eksperiment (ostatak = kontrola iz config-a)
        status: 'running',
        createdAt: iso(),
        source: spec.source ?? 'manual',
        minSamples: spec.minSamples ?? 10,
      };
      state.experiments[exp.id] = exp;
      await writeJson(eFile(tenantId), state);
      metrics?.inc('experiments_created_total', { tenant: tenantId, agentId: exp.agentId });
      await audit?.append({ tenantId, actor: 'api', action: 'experiment_create', args: { experimentId: exp.id, agentId: exp.agentId, variants: exp.variants.map((v) => v.name) }, decision: 'allow', outcome: 'ok' });
      return exp;
    },

    async listExperiments(tenantId, { status } = {}) {
      const state = await loadExperiments(tenantId);
      return Object.values(state.experiments).filter((e) => !status || e.status === status).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },

    async getExperiment(tenantId, id) {
      const state = await loadExperiments(tenantId);
      const e = state.experiments[id];
      if (!e) throw new NotFoundError('Eksperiment', id);
      return e;
    },

    /**
     * Odabir varijante za konkretan run (deterministički po sessionId/runId — isti korisnik ostaje u istoj varijanti).
     * @returns {{variant, specPatch}|null}
     */
    async assignVariant(tenantId, { agentId, sessionId, runId }) {
      const state = await loadExperiments(tenantId);
      const exp = Object.values(state.experiments).find((e) => e.status === 'running' && e.agentId === agentId);
      if (!exp) return null;
      const bucket = parseInt(sha256({ s: sessionId ?? runId ?? uid('x'), e: exp.id }).slice(0, 8), 16) % 100;
      if (bucket >= exp.splitPct) return { variant: 'control', specPatch: {}, experimentId: exp.id };
      const idx = bucket % exp.variants.length;
      const variant = exp.variants[idx];
      return { variant: variant.name, specPatch: variant.specPatch, experimentId: exp.id };
    },

    /** Dodaje mjerenje eksperimentu (poziva se iz reward toka). */
    async recordExperimentResult(tenantId, { experimentId, variant, reward }) {
      if (!experimentId) return null;
      const state = await loadExperiments(tenantId);
      const exp = state.experiments[experimentId];
      if (!exp) return null;
      const v = exp.variants.find((x) => x.name === variant);
      if (v) {
        v.n += 1;
        v.sumReward += reward;
        v.avgReward = Number((v.sumReward / v.n).toFixed(4));
      }
      await writeJson(eFile(tenantId), state);
      return exp;
    },

    /** Zaključuje eksperiment: pobjednik ide u control plane deploy (uz audit), ili se odbacuje. */
    async concludeExperiment(tenantId, id, { by = 'human', promote = true } = {}) {
      const state = await loadExperiments(tenantId);
      const exp = state.experiments[id];
      if (!exp) throw new NotFoundError('Eksperiment', id);
      const ranked = [...exp.variants].filter((v) => v.n >= exp.minSamples).sort((a, b) => b.avgReward - a.avgReward);
      if (!ranked.length) return { experiment: exp, decision: 'insufficient_data', ranked: exp.variants };

      const winner = ranked[0];
      const loser = ranked.at(-1);
      const lift = Number((winner.avgReward - loser.avgReward).toFixed(4));
      const significant = winner.n >= exp.minSamples && lift > 0.03;

      exp.status = 'concluded';
      exp.concludedAt = iso();
      exp.concludedBy = by;
      exp.result = { winner: winner.name, loser: loser.name, lift, significant, decision: significant && promote ? 'promoted' : 'no_change' };

      if (significant && promote && controlPlane) {
        await controlPlane.deploy(tenantId, exp.agentId, { patch: winner.specPatch, actor: `experiment:${id}`, note: `A/B pobjednik ${winner.name} (lift ${lift})` });
        exp.result.deployed = true;
      }
      await writeJson(eFile(tenantId), state);
      metrics?.inc('experiments_concluded_total', { tenant: tenantId, decision: exp.result.decision });
      await audit?.append({ tenantId, actor: by, action: 'experiment_conclude', args: { experimentId: id, agentId: exp.agentId }, decision: 'allow', outcome: 'ok', meta: exp.result });
      logger?.warn?.('experiment.concluded', { tenantId, id, ...exp.result });
      return { experiment: exp, ...exp.result, ranked };
    },

    async stats(tenantId) {
      const [proposals, experiments] = await Promise.all([this.list(tenantId), this.listExperiments(tenantId)]);
      const byStatus = proposals.reduce((acc, p) => ({ ...acc, [p.status]: (acc[p.status] ?? 0) + 1 }), {});
      return { proposals: proposals.length, byStatus, experiments: experiments.length, running: experiments.filter((e) => e.status === 'running').length };
    },
  };
}
