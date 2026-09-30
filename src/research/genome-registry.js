/**
 * GENOME REGISTRY — centralni (ili per-tenant) registar genoma, federativno učenje BEZ sadržaja.
 *
 * Po smernicama:
 *   • Edge čvor šalje SAMO: `{ genome_id, fitness, tasks_done, pheromone_efficiency }` + HMAC potpis.
 *   • Nikad ne šalje sadržaj taskova, ticket-a, kod, tekst — ni u logu ni u payload-u.
 *   • Registry radi **tournament selection**, uzima **top 10%** i distribuira pobjednički genom nazad.
 *   • Prag: genom se razmatra tek sa `minSamples` mjerenja (bez toga je šum, ne signal).
 *
 * Ovo je mjeračko učenje (federated *selection*), ne trening modela: registar ne vidi podatke,
 * samo brojeve. Zato je i privatnost provjerljiva testom (payload ne smije sadržati tekst).
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { iso } from '../core/clock.js';
import { ValidationError, AuthError } from '../core/errors.js';

const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

/** Dozvoljena polja fitness izvještaja — sve ostalo se ODBIJA (privatnost po dizajnu). */
export const ALLOWED_REPORT_FIELDS = ['node_id', 'genome_id', 'fitness', 'tasks_done', 'pheromone_efficiency', 'ts', 'sig', 'tenant_hash'];

export function createGenomeRegistry({ secret, config = {}, logger, metrics, audit } = {}) {
  const cfg = { minSamples: 3, topPercent: 10, maxReports: 20_000, ...(config ?? {}) };
  const reports = []; // { genomeId, fitness, tasksDone, pheromoneEfficiency, nodeId, ts }
  const genomes = new Map(); // genomeId -> { id, blob, stats, publishedAt }
  const emitter = new EventEmitter();

  function assertNoContent(payload) {
    const extra = Object.keys(payload).filter((k) => !ALLOWED_REPORT_FIELDS.includes(k));
    if (extra.length) {
      throw new ValidationError(`Fitness izvještaj smije sadržati SAMO metrike; nedozvoljena polja: ${extra.join(', ')}`);
    }
    // dodatna brava: nijedno polje ne smije biti dugačak tekst (moguć kanal za iznošenje sadržaja)
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string' && v.length > 128) throw new ValidationError(`Polje "${k}" izgleda kao sadržaj, a ne metrika (dužina ${v.length})`);
    }
    return true;
  }

  return {
    ALLOWED_REPORT_FIELDS,
    settings: cfg,
    genomes,
    on: (...a) => emitter.on(...a),

    /** Prijem fitness izvještaja (HMAC obavezan). */
    report(payload = {}) {
      if (!payload.sig || !payload.node_id || !payload.genome_id) throw new ValidationError('Izvještaj traži node_id, genome_id i sig');
      const { sig, ...body } = payload;
      assertNoContent(payload);
      if (!safeEqual(sig, sign(secret, JSON.stringify(body)))) throw new AuthError('Neispravan HMAC potpis fitness izvještaja');
      const entry = {
        nodeId: String(payload.node_id),
        genomeId: String(payload.genome_id),
        fitness: Number(payload.fitness ?? 0),
        tasksDone: Number(payload.tasks_done ?? 0),
        pheromoneEfficiency: Number(payload.pheromone_efficiency ?? 0),
        tenantHash: payload.tenant_hash ?? null,
        ts: Number(payload.ts ?? Date.now()),
        receivedAt: iso(),
      };
      reports.push(entry);
      if (reports.length > cfg.maxReports) reports.shift();
      metrics?.inc('genome_fitness_reports_total', {});
      emitter.emit('report', entry);
      logger?.debug?.('registry.fitness_report', { nodeId: entry.nodeId, genomeId: entry.genomeId, fitness: entry.fitness });
      return { accepted: true, totalReports: reports.length };
    },

    /** Statistika po genomu (prosječna fitness, broj mjerenja, efikasnost feromona). */
    stats() {
      const byGenome = new Map();
      for (const r of reports) {
        const s = byGenome.get(r.genomeId) ?? { genomeId: r.genomeId, samples: 0, sumFitness: 0, sumTasks: 0, sumPheromone: 0, nodes: new Set() };
        s.samples += 1;
        s.sumFitness += r.fitness;
        s.sumTasks += r.tasksDone;
        s.sumPheromone += r.pheromoneEfficiency;
        s.nodes.add(r.nodeId);
        byGenome.set(r.genomeId, s);
      }
      return [...byGenome.values()]
        .map((s) => ({ genomeId: s.genomeId, samples: s.samples, avgFitness: Number((s.sumFitness / s.samples).toFixed(4)), tasksDone: s.sumTasks, pheromoneEfficiency: Number((s.sumPheromone / s.samples).toFixed(4)), nodes: s.nodes.size }))
        .sort((a, b) => b.avgFitness - a.avgFitness);
    },

    /**
     * Tournament selection + top 10%: vraća listu pobjednika (samo oni sa dovoljno mjerenja).
     * Deterministićki: sortira po `avgFitness`, pa po broju uzoraka, pa po `genomeId`.
     */
    selectWinners({ k = null, minSamples = null } = {}) {
      const floor = minSamples ?? cfg.minSamples;
      const ranked = this.stats().filter((s) => s.samples >= floor);
      const top = k ?? Math.max(1, Math.ceil((ranked.length * cfg.topPercent) / 100));
      return ranked.slice(0, top);
    },

    /** Registruj genom (blob je npr. JSON prompt/parametri ili kod) — šalje se nazad čvorovima. */
    publish({ genomeId, blob, fitness = null, source = 'manual' } = {}) {
      if (!genomeId) throw new ValidationError('publish traži genomeId');
      const entry = { id: genomeId, blob, fitness, source, publishedAt: iso(), version: (genomes.get(genomeId)?.version ?? 0) + 1 };
      genomes.set(genomeId, entry);
      metrics?.inc('genome_published_total', { source });
      logger?.warn?.('registry.genome_published', { genomeId, source, fitness });
      return entry;
    },

    /** „Update" koji edge povlači: najbolji genom iz top 10% (ili eksplicitno traženi). */
    bestUpdate({ k = 1 } = {}) {
      const winners = this.selectWinners({ k });
      if (!winners.length) return { update: null, reason: `nema genoma sa najmanje ${cfg.minSamples} mjerenja` };
      const winner = winners[0];
      const published = genomes.get(winner.genomeId);
      if (!published) return { update: null, reason: `genom ${winner.genomeId} nije objavljen (samo metrike)` };
      const report = {
        genomeId: winner.genomeId,
        fitness: winner.avgFitness,
        samples: winner.samples,
        blob: published.blob,
        version: published.version,
        publishedAt: published.publishedAt,
        winners: winners.map((w) => w.genomeId),
      };
      metrics?.inc('genome_updates_served_total', {});
      return { update: report };
    },

    history({ limit = 100 } = {}) {
      return reports.slice(-limit).reverse();
    },

    reset() {
      reports.length = 0;
      genomes.clear();
      return true;
    },
  };
}
