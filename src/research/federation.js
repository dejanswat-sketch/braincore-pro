/**
 * FEDERATION — edge strana: šalje SAMO fitness (nikad sadržaj) i povlači update genoma.
 *
 * Po smernicama:
 *   ```js
 *   { genome_id: "abc-123", fitness: 0.87, tasks_done: 142, pheromone_efficiency: 0.92 }
 *   ```
 *   → centralni registry radi tournament selection, bira top 10% i vraća najbolji blob.
 *   → edge radi **hot-swap** (kroz kontrolnu ravan, sa rollback verzijom).
 *
 * Ovaj modul je namjerno „glup" po pitanju sadržaja: nema polja za tekst, nema logovanja teksta,
 * a `buildReport` baca grešku ako mu se prosledi bilo šta van dozvoljenih metrika.
 */
import crypto from 'node:crypto';
import { uid } from '../core/ids.js';
import { iso } from '../core/clock.js';
import { redact } from '../core/logger.js';
import { ValidationError, ClusterError } from '../core/errors.js';
import { ALLOWED_REPORT_FIELDS } from './genome-registry.js';

export function createFederationClient({ nodeId = uid('edge'), registryUrl = null, secret, registry = null, controlPlane = null, catalog = null, config = {}, logger, metrics, audit } = {}) {
  if (!secret) throw new ValidationError('Federation traži "secret" (HMAC potpis je obavezan)');
  const cfg = { autoHotSwap: false, minFitnessGain: 0.03, tenantHashSalt: 'nmq-federation', ...(config ?? {}) };
  const state = { genomeId: cfg.initialGenomeId ?? 'baseline-1', genomeBlob: null, lastReportAt: null, lastUpdateAt: null, history: [] };

  const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

  /**
   * Gradi izvještaj — TVRDO ograničen na metrike. Svako dodatno polje je greška, ne „pažljivo ignorisanje".
   */
  function buildReport({ fitness, tasksDone = 0, pheromoneEfficiency = 0, genomeId = null, tenantId = null } = {}) {
    if (fitness === undefined || fitness === null) throw new ValidationError('Fitness izvještaj traži "fitness"');
    const body = {
      node_id: nodeId,
      genome_id: genomeId ?? state.genomeId,
      fitness: Number(Number(fitness).toFixed(4)),
      tasks_done: Number(tasksDone),
      pheromone_efficiency: Number(Number(pheromoneEfficiency).toFixed(4)),
      ts: Date.now(),
    };
    if (tenantId) body.tenant_hash = crypto.createHash('sha256').update(`${cfg.tenantHashSalt}:${tenantId}`).digest('hex').slice(0, 16);
    const extra = Object.keys(body).filter((k) => !ALLOWED_REPORT_FIELDS.includes(k));
    if (extra.length) throw new ValidationError(`Federation ne smije slati polja: ${extra.join(', ')}`);
    return { ...body, sig: sign(JSON.stringify(body)) };
  }

  /** Mjeri iz stvarnih brojeva (npr. reward model) — nikad iz sadržaja. */
  function measureFromRewards({ rewards = [], tasksDone = 0 } = {}) {
    const list = Array.isArray(rewards) ? rewards : [];
    if (!list.length) return { fitness: 0, tasksDone, pheromoneEfficiency: 0 };
    const fitness = list.reduce((s, r) => s + Number(r.reward ?? r.fitness ?? 0), 0) / list.length;
    const withTools = list.filter((r) => (r.signals?.toolErrors ?? 0) === 0).length;
    return { fitness: Number(fitness.toFixed(4)), tasksDone: tasksDone || list.length, pheromoneEfficiency: Number((withTools / list.length).toFixed(4)) };
  }

  async function send(report) {
    if (registry?.report) {
      // In-process registry (embed režim, npr. u testovima ili single-tenant instalaciji)
      return registry.report(report);
    }
    if (!registryUrl) throw new ClusterError('Federation nema registry (postavi registryUrl ili proslijedi registry)');
    const res = await fetch(`${registryUrl.replace(/\/$/, '')}/v1/fitness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
    if (!res.ok) throw new ClusterError(`Registry je odbio izvještaj (HTTP ${res.status})`);
    return res.json();
  }

  return {
    nodeId,
    ALLOWED_REPORT_FIELDS,
    settings: cfg,
    get state() {
      return { ...state, history: state.history.slice(-20) };
    },
    buildReport,
    measureFromRewards,

    /** Pošalji fitness (samo metrike). Sadržaj se NIKAD ne dodaje — čak i ako ga pozivalac ima. */
    async reportFitness(input = {}) {
      const report = buildReport(input);
      const result = await send(report);
      state.lastReportAt = iso();
      state.history.push({ type: 'fitness', at: state.lastReportAt, fitness: report.fitness, genomeId: report.genome_id });
      if (state.history.length > 200) state.history.shift();
      metrics?.observe('federation_fitness_sent', {}, report.fitness);
      logger?.info?.('federation.fitness_sent', { nodeId, genomeId: report.genome_id, fitness: report.fitness });
      return { sent: true, report, result };
    },

    /** Povuci update (top genom) iz registra — bez sadržaja klijenta. */
    async pullUpdate({ k = 1 } = {}) {
      if (registry?.bestUpdate) return registry.bestUpdate({ k });
      if (!registryUrl) throw new ClusterError('Federation nema registry');
      const res = await fetch(`${registryUrl.replace(/\/$/, '')}/v1/genome/best?k=${k}`);
      if (!res.ok) throw new ClusterError(`Registry nije vratio update (HTTP ${res.status})`);
      return res.json();
    },

    /**
     * Hot-swap: primijeni bolji genom kroz kontrolnu ravan (sa rollback verzijom).
     * Ako je `autoHotSwap` isključen — vraća predlog (čovjek odlučuje), kao i svaka promjena granica.
     */
    async applyUpdate(update, { agentId = 'support', by = 'federation' } = {}) {
      if (!update?.blob) throw new ValidationError('applyUpdate traži "blob" (genom)');
      const gain = Number(update.fitness ?? 0);
      const currentFitness = state.currentFitness ?? 0;
      const better = gain - currentFitness >= cfg.minFitnessGain;
      if (!cfg.autoHotSwap || !better) {
        return { applied: false, reason: cfg.autoHotSwap ? `dobitak ${(gain - currentFitness).toFixed(3)} < ${cfg.minFitnessGain}` : 'autoHotSwap je isključen (safety default)', proposal: { agentId, genomeId: update.genomeId, fitness: gain, blobPreview: redact(String(JSON.stringify(update.blob)).slice(0, 200)) } };
      }
      const patch = typeof update.blob === 'string' ? { systemPrompt: update.blob } : update.blob;
      const deployed = await controlPlane.deploy(state.tenantId ?? 'nmq', agentId, { patch, actor: `federation:${by}`, note: `genom ${update.genomeId} (fitness ${gain})` });
      state.genomeId = update.genomeId;
      state.currentFitness = gain;
      state.lastUpdateAt = iso();
      state.history.push({ type: 'hot_swap', at: state.lastUpdateAt, genomeId: update.genomeId, fitness: gain, version: deployed.version });
      await audit?.append({ tenantId: state.tenantId ?? 'nmq', actor: `federation:${by}`, action: 'genome_hot_swap', args: { agentId, genomeId: update.genomeId, fitness: gain }, decision: 'allow', outcome: 'ok' });
      logger?.warn?.('federation.hot_swap', { agentId, genomeId: update.genomeId, fitness: gain, version: deployed.version });
      return { applied: true, deployed, genomeId: update.genomeId, fitness: gain };
    },

    async close() {
      return true;
    },
  };
}
