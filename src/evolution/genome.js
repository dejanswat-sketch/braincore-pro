/**
 * Evolucija agenata — „genom" koji se mutira, križa i bira MERENJEM (eval), ne osjećajem.
 *
 * Genom = ono što smije da se mijenja kod agenta: prompt (stil/instrukcije), temperatura, maxTokens,
 * default pattern i (opciono) skup alata. **Safety polja su zabranjena za mutaciju**: autonomija,
 * budžeti, politike odobrenja, dozvole alata — njih mijenja samo čovjek.
 *
 * Fitness = prolaznost na zlatnom setu (eval) − kazna za trošak/latenciju. Pobjednik se NE deployuje
 * sam: ide kroz `improvements` kao prijedlog (human-in-the-loop), osim ako je u config-u izričito
 * dozvoljen auto-promote uz prolaz kapije (default: isključeno).
 *
 * Stanje: data/tenants/<id>/evolution/population.json + generations-YYYY-MM.jsonl
 */
import path from 'node:path';
import { appendJsonl, readJson, writeJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid, sha256 } from '../core/ids.js';
import { ValidationError, PolicyError } from '../core/errors.js';

/** Polja koja evolucija SMIJE mijenjati. */
export const MUTABLE_FIELDS = ['systemPromptSuffix', 'temperature', 'maxTokens', 'defaultPattern'];

/** Polja koja evolucija NIKAD ne smije dirati (safety invarijanta). */
export const FORBIDDEN_FIELDS = [
  'autonomy',
  'budget',
  'budgetUsd',
  'tools',
  'maxRisk',
  'policy',
  'policies',
  'requireApproval',
  'allowedTools',
  'sandbox',
  'maxToolCalls',
  'maxToolRepeats',
];

export const DEFAULT_EVOLUTION = {
  populationSize: 6,
  generations: 3,
  mutationRate: 0.4,
  eliteCount: 2,
  maxTemperature: 1.0,
  minTemperature: 0.0,
  maxTokensRange: [200, 2000],
  patterns: ['agent', 'reflection', 'sequential', 'magentic'],
  promptMutations: [
    'Prije odgovora provjeri bazu znanja i navedi izvor.',
    'Odgovori u najviše 5 rečenica, bez uvoda.',
    'Ako nemaš podatak, reci šta ti treba umjesto da pretpostaviš.',
    'Na kraju navedi jedan konkretan sljedeći korak sa rokom.',
    'Koristi tabele kada porediš više od dvije opcije.',
    'Navedi pretpostavke eksplicitno prema kojima radiš.',
  ],
  autoPromote: false, // pobjednik ide kroz prijedlog (čovjek odobrava)
  minFitnessGain: 0.05,
  costPenaltyPerUsd: 5,
  latencyPenaltyPerSecond: 0.002,
};

export function createEvolution({ config = {}, dataDir, logger, metrics, audit, evalHarness, improvements, controlPlane, catalog, safety }) {
  const cfg = { ...DEFAULT_EVOLUTION, ...(config ?? {}) };
  const cache = new Map();
  const evaluationCache = new Map(); // `${tenant}::${set}::${cases}::${max}::${hash}` -> ocjena (bez ponovnog trošenja tokena)

  const popFile = (tenantId) => path.join(dataDir, 'tenants', tenantId, 'evolution', 'population.json');
  const genFile = (tenantId, d = new Date()) => path.join(dataDir, 'tenants', tenantId, 'evolution', `generations-${d.toISOString().slice(0, 7)}.jsonl`);

  async function load(tenantId) {
    if (cache.has(tenantId)) return cache.get(tenantId);
    const state = (await readJson(popFile(tenantId), { populations: {} })) ?? { populations: {} };
    if (!state.populations) state.populations = {};
    cache.set(tenantId, state);
    return state;
  }

  async function persist(tenantId) {
    const state = await load(tenantId);
    await writeJson(popFile(tenantId), state);
    return state;
  }

  /** Genom iz agenta + slobodna polja koja evolucija smije dirati. */
  function genomeOf(tenantId, agentId, overrides = {}) {
    const spec = catalog.get(agentId, tenantId);
    if (!spec) throw new ValidationError(`Nepoznat agent: ${agentId}`);
    const genome = {
      id: uid('gen'),
      agentId,
      temperature: spec.temperature ?? 0.2,
      maxTokens: spec.maxTokens ?? 900,
      // Agent može imati pattern van evolucione liste (npr. `handoff`) — tada seed ide na prvi dozvoljeni
      defaultPattern: cfg.patterns.includes(spec.defaultPattern) ? spec.defaultPattern : cfg.patterns[0],
      systemPromptSuffix: '',
      ...overrides,
      hash: null,
    };
    // Svaki genom ima stabilan hash (i seed) — koristi se u izvještajima i za rollback referencu
    genome.hash = sha256({ agentId: genome.agentId, temperature: genome.temperature, maxTokens: genome.maxTokens, pattern: genome.defaultPattern, suffix: genome.systemPromptSuffix }).slice(0, 12);
    return genome;
  }

  function assertSafe(genome) {
    // Rekurzivna provjera: zabranjena polja se NE smiju kriti u pod-objektima (npr. meta.budget)
    const seen = new Set();
    const walk = (obj, pathStr = '') => {
      if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
      seen.add(obj);
      for (const [key, value] of Object.entries(obj)) {
        const full = pathStr ? `${pathStr}.${key}` : key;
        if (FORBIDDEN_FIELDS.includes(key)) throw new PolicyError(`Evolucija ne smije mijenjati polje "${full}" — to je safety invarijanta`, { field: full });
        if (value && typeof value === 'object') walk(value, full);
      }
    };
    walk(genome);
    if (genome.temperature !== undefined) {
      if (genome.temperature < cfg.minTemperature || genome.temperature > cfg.maxTemperature) {
        throw new PolicyError(`Temperatura ${genome.temperature} je izvan dozvoljenog opsega ${cfg.minTemperature}–${cfg.maxTemperature}`, { temperature: genome.temperature });
      }
    }
    if (genome.maxTokens !== undefined) {
      const [lo, hi] = cfg.maxTokensRange;
      if (genome.maxTokens < lo || genome.maxTokens > hi) throw new PolicyError(`maxTokens ${genome.maxTokens} je izvan opsega ${lo}–${hi}`);
    }
    if (genome.defaultPattern !== undefined && !cfg.patterns.includes(genome.defaultPattern)) throw new PolicyError(`Pattern "${genome.defaultPattern}" nije na dozvoljenoj listi`);
    // Granica „najviše 3 dodatne instrukcije" važi i za seed/promociju, ne samo za mutaciju
    const instructions = String(genome.systemPromptSuffix ?? '').split('\n').filter(Boolean);
    if (instructions.length > 3) throw new PolicyError(`Genom smije imati najviše 3 dodatne instrukcije (ima ${instructions.length})`);
    return true;
  }

  /** Zakrpa koju orchestrator primjenjuje SAMO na taj run (options.specPatch). */
  function patchOf(genome) {
    const patch = { temperature: genome.temperature, maxTokens: genome.maxTokens, defaultPattern: genome.defaultPattern };
    if (genome.systemPromptSuffix) {
      const base = catalog.get(genome.agentId, genome.tenantId)?.systemPrompt ?? '';
      patch.systemPrompt = `${base}\n\n${genome.systemPromptSuffix}`.trim();
    }
    return patch;
  }

  function mutate(genome, { rng = Math.random } = {}) {
    const child = { ...genome, id: uid('gen'), parentId: genome.id };
    const roll = () => rng();
    if (roll() < cfg.mutationRate) child.temperature = Number(Math.min(cfg.maxTemperature, Math.max(cfg.minTemperature, genome.temperature + (roll() - 0.5) * 0.6)).toFixed(2));
    if (roll() < cfg.mutationRate) {
      const [lo, hi] = cfg.maxTokensRange;
      child.maxTokens = Math.round(Math.min(hi, Math.max(lo, genome.maxTokens * (0.6 + roll() * 0.9))));
    }
    if (roll() < cfg.mutationRate) child.defaultPattern = cfg.patterns[Math.floor(roll() * cfg.patterns.length)];
    if (roll() < cfg.mutationRate) {
      const add = cfg.promptMutations[Math.floor(roll() * cfg.promptMutations.length)];
      const lines = new Set(String(child.systemPromptSuffix ?? '').split('\n').filter(Boolean));
      lines.add(add);
      child.systemPromptSuffix = [...lines].slice(-3).join('\n'); // najviše 3 dodatne instrukcije
    }
    assertSafe(child);
    child.hash = sha256({ agentId: child.agentId, temperature: child.temperature, maxTokens: child.maxTokens, pattern: child.defaultPattern, suffix: child.systemPromptSuffix }).slice(0, 12);
    child.origin = 'mutation';
    return child;
  }

  function crossover(a, b, { rng = Math.random } = {}) {
    const pick = (x, y) => (rng() < 0.5 ? x : y);
    const child = {
      id: uid('gen'),
      agentId: a.agentId,
      temperature: pick(a.temperature, b.temperature),
      maxTokens: pick(a.maxTokens, b.maxTokens),
      defaultPattern: pick(a.defaultPattern, b.defaultPattern),
      systemPromptSuffix: [a.systemPromptSuffix, b.systemPromptSuffix].filter(Boolean).slice(0, 2).join('\n'),
      parentId: `${a.id}+${b.id}`,
      origin: 'crossover',
    };
    assertSafe(child);
    child.hash = sha256({ agentId: child.agentId, temperature: child.temperature, maxTokens: child.maxTokens, pattern: child.defaultPattern, suffix: child.systemPromptSuffix }).slice(0, 12);
    return child;
  }

  /** Fitness: prolaznost na eval-u minus trošak i latencija. */
  function fitness({ passRate, costUsd = 0, avgDurationMs = 0, failures = 0 }) {
    const score = passRate - cfg.costPenaltyPerUsd * costUsd - cfg.latencyPenaltyPerSecond * (avgDurationMs / 1000) - failures * 0.01;
    return Number(score.toFixed(4));
  }

  return {
    MUTABLE_FIELDS,
    FORBIDDEN_FIELDS,
    settings: cfg,
    genomeOf,
    patchOf,
    assertSafe,
    mutate,
    crossover,
    fitness,
    popFile,
    genFile,

    /** Ocjenjuje genom stvarnim pokretanjem zlatnog seta (specPatch po runu). Rezultati se keširaju po hash-u. */
    async evaluate(tenantId, genome, { setName = 'golden', caseIds = null, maxCases = 12 } = {}) {
      assertSafe(genome);
      const cacheKey = `${tenantId}::${setName}::${caseIds ?? 'all'}::${maxCases}::${genome.hash ?? 'nohash'}`;
      if (evaluationCache.has(cacheKey)) {
        metrics?.inc('evolution_eval_cache_hits_total', { tenant: tenantId });
        return evaluationCache.get(cacheKey);
      }
      const report = await evalHarness.run(tenantId, { name: setName, caseIds, maxCases, specPatch: patchOf({ ...genome, tenantId }) });
      const score = fitness(report);
      metrics?.observe('evolution_fitness', { tenant: tenantId, agent: genome.agentId }, score);
      const evaluated = { genome: { ...genome, tenantId }, report, fitness: score };
      evaluationCache.set(cacheKey, evaluated);
      return evaluated;
    },

    /**
     * Pokreće evoluciju: populacija → ocjena → elitizam → križanje/mutacija → nova generacija.
     * Vraća izvještaj; promocija pobjednika je ODLUKA (prijedlog), ne automatska radnja.
     */
    async evolve(tenantId, { agentId, populationSize = null, generations = null, setName = 'golden', caseIds = null, maxCases = 8, seed = null, rngSeed = null } = {}) {
      if (!agentId) throw new ValidationError('Evolucija traži "agentId"');
      const size = Math.max(4, Math.min(populationSize ?? cfg.populationSize, 20));
      const gens = Math.max(1, Math.min(generations ?? cfg.generations, 10));
      // Deterministički PRNG (mulberry32) — evolucija je ponovljiva kad se zada `rngSeed`
      let seedState = rngSeed ?? null;
      const rng = seedState === null ? Math.random : () => {
        seedState = (seedState + 0x6d2b79f5) | 0;
        let t = seedState;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };

      // Baseline = fitness seed genoma (bez mutacija); kapija se mjeri PREMA NJEMU
      const baselineEval = await this.evaluate(tenantId, { ...genomeOf(tenantId, agentId), tenantId }, { setName, caseIds, maxCases });
      const baselineFitness = baselineEval.fitness;

      let population = (seed ?? []).map((g) => ({ ...genomeOf(tenantId, agentId, g), tenantId }));
      while (population.length < size) {
        population.push(population.length === 0 ? { ...genomeOf(tenantId, agentId), tenantId } : mutate(population[Math.floor(rng() * population.length)], { rng }));
      }

      const state = await load(tenantId);
      const history = [];
      let best = null;

      for (let gen = 1; gen <= gens; gen += 1) {
        const scored = [];
        for (const genome of population) {
          const evaluated = await this.evaluate(tenantId, genome, { setName, caseIds, maxCases });
          scored.push(evaluated);
        }
        scored.sort((a, b) => b.fitness - a.fitness);
        if (!best || scored[0].fitness > best.fitness) best = scored[0];

        const record = {
          ts: iso(),
          tenantId,
          agentId,
          generation: gen,
          populationSize: scored.length,
          best: { hash: scored[0].genome.hash, fitness: scored[0].fitness, passRate: scored[0].report.passRate, costUsd: scored[0].report.costUsd, genome: scored[0].genome },
          worst: { hash: scored.at(-1).genome.hash, fitness: scored.at(-1).fitness },
          average: Number((scored.reduce((s, x) => s + x.fitness, 0) / scored.length).toFixed(4)),
          diversity: new Set(scored.map((x) => x.genome.hash)).size / scored.length,
        };
        history.push(record);
        await appendJsonl(genFile(tenantId), record);
        metrics?.observe('evolution_best_fitness', { tenant: tenantId, agent: agentId, generation: String(gen) }, scored[0].fitness);
        logger?.info?.('evolution.generation', { tenantId, agentId, gen, best: scored[0].fitness, avg: record.average, diversity: record.diversity });

        // elitizam + reprodukcija
        const elites = scored.slice(0, cfg.eliteCount).map((x) => ({ ...x.genome }));
        const next = [...elites];
        const poolSize = Math.max(2, Math.floor(size / 2));
        while (next.length < size) {
          const parentA = scored[Math.floor(rng() * poolSize)].genome;
          const parentB = scored[Math.floor(rng() * poolSize)].genome;
          const child = rng() < 0.5 ? crossover(parentA, parentB, { rng }) : mutate(parentA, { rng });
          next.push({ ...child, tenantId });
        }
        population = next;
      }

      state.populations[agentId] = {
        agentId,
        tenantId,
        updatedAt: iso(),
        bestGenome: best.genome,
        bestFitness: best.fitness,
        bestPassRate: best.report.passRate,
        baselineFitness,
        gainOverBaseline: Number((best.fitness - baselineFitness).toFixed(4)),
        generations: (state.populations[agentId]?.generations ?? 0) + gens,
        history: [...(state.populations[agentId]?.history ?? []).slice(-20), ...history],
      };
      await persist(tenantId);

      await audit?.append({
        tenantId,
        actor: 'evolution',
        action: 'evolution_run',
        args: { agentId, generations: gens, populationSize: size, setName },
        decision: 'allow',
        outcome: 'ok',
        meta: { bestFitness: best.fitness, bestPassRate: best.report.passRate, bestHash: best.genome.hash },
      });

      return {
        agentId,
        generations: gens,
        populationSize: size,
        best: { genome: best.genome, fitness: best.fitness, passRate: best.report.passRate, costUsd: best.report.costUsd },
        baseline: { fitness: baselineFitness, passRate: baselineEval.report.passRate },
        gainOverBaseline: Number((best.fitness - baselineFitness).toFixed(4)),
        history,
        improvement: history.length > 1 ? Number((history.at(-1).best.fitness - history[0].best.fitness).toFixed(4)) : 0,
      };
    },

    /** Pobjednika pretvara u PRIJEDLOG (čovjek odobrava) — nikad tiho deploy. */
    async proposePromotion(tenantId, { agentId, genome = null, baselineFitness = null } = {}) {
      const state = await load(tenantId);
      const entry = state.populations[agentId];
      const best = genome ?? entry?.bestGenome;
      if (!best) throw new ValidationError(`Nema evoluisanog genoma za agenta ${agentId} — pokreni evolve prvo`);
      if (!improvements) throw new PolicyError('Improvement engine nije dostupan — promocija ide kroz njega');
      const gain = baselineFitness === null ? null : Number((entry.bestFitness - baselineFitness).toFixed(4));
      const proposal = await improvements.createProposal(tenantId, {
        kind: 'prompt',
        target: agentId,
        current: catalog.get(agentId, tenantId)?.systemPrompt?.slice(0, 300) ?? null,
        // Cijeli genom (ne samo prompt) — inače se temperatura/maxTokens/pattern izmjere ali ne mogu primijeniti
        proposed: {
          systemPrompt: `${catalog.get(agentId, tenantId)?.systemPrompt ?? ''}\n\n${best.systemPromptSuffix ?? ''}`.trim(),
          temperature: best.temperature,
          maxTokens: best.maxTokens,
          defaultPattern: best.defaultPattern,
        },
        rationale: `Evolucija: genom ${best.hash} (temperatura ${best.temperature}, maxTokens ${best.maxTokens}, pattern ${best.defaultPattern}) ima fitness ${entry.bestFitness}${gain === null ? '' : ` (${gain > 0 ? '+' : ''}${gain} u odnosu na baseline)`}`,
        evidence: [{ genome: best, fitness: entry.bestFitness, passRate: entry.bestPassRate, generations: entry.generations }],
        expectedImpact: 'veća prolaznost na zlatnom setu uz isti budžet',
        riskLevel: 'medium',
        source: 'evolution',
      });
      metrics?.inc('evolution_promotions_proposed_total', { tenant: tenantId, agent: agentId });
      logger?.warn?.('evolution.promotion_proposed', { tenantId, agentId, proposalId: proposal.id, fitness: entry.bestFitness });
      return { proposal, genome: best, fitness: entry.bestFitness, autoPromote: false };
    },

    /** Ako je auto-promote izričito uključen I kapija prolazi — primijeni (inače samo prijedlog). */
    async maybeAutoPromote(tenantId, { agentId, minGain = null } = {}) {
      if (!cfg.autoPromote) return { promoted: false, reason: 'auto-promote je isključen u config/evolution.json (safety default)' };
      const state = await load(tenantId);
      const entry = state.populations[agentId];
      if (!entry) throw new ValidationError(`Nema populacije za agenta ${agentId}`);
      const gate = minGain ?? cfg.minFitnessGain;
      // Kapija se mjeri prema BASELINE-u (seed genom): ranije je `bestFitness >= 0.05` prolazilo uvijek,
      // čak i kad je evolucija POGORŠALA rezultat.
      const gain = Number(((entry.bestFitness ?? 0) - (entry.baselineFitness ?? 0)).toFixed(4));
      if (gain < gate) return { promoted: false, reason: `dobitak nad baseline-om ${gain} ne prelazi kapiju ${gate}` };
      const deployed = await controlPlane.deploy(tenantId, agentId, {
        patch: { temperature: entry.bestGenome.temperature, maxTokens: entry.bestGenome.maxTokens, defaultPattern: entry.bestGenome.defaultPattern },
        actor: 'evolution:auto',
        note: `auto-promote genoma ${entry.bestGenome.hash} (fitness ${entry.bestFitness})`,
      });
      await audit?.append({ tenantId, actor: 'evolution', action: 'evolution_auto_promote', args: { agentId, hash: entry.bestGenome.hash }, decision: 'allow', outcome: 'ok' });
      logger?.error?.('evolution.auto_promoted', { tenantId, agentId, fitness: entry.bestFitness });
      return { promoted: true, deployed };
    },

    async population(tenantId, { agentId } = {}) {
      const state = await load(tenantId);
      return agentId ? (state.populations[agentId] ?? null) : state.populations;
    },
  };
}
