/**
 * Recursive Self-Improvement (RSI) — meta-nivoi R0–R5, sa KAPIJAMA.
 *
 * Suština „prave" RSI arhitekture nije bolji odgovor, nego bolji NAČIN na koji sistem postaje bolji:
 *   R1 execution      — smije izvršiti unaprijed definisano poboljšanje (prompt/politika/KB/pattern)
 *   R2 strategy       — smije sam izabrati KOJU strategiju poboljšanja (prompt vs pattern vs trening)
 *   R3 experience     — smije sam pribaviti iskustvo (self-play, novi scenariji, novi eval slučajevi)
 *   R4 environment    — smije se prilagoditi novom domenu/jeziku/okruženju
 *   R5 meta           — smije predložiti poboljšanje SAMOG PROCESA poboljšavanja
 *
 * Ključna odluka (i razlika između „frontiera" i „igračke"): nivo se NE dodjeljuje sam.
 * Nivo mijenja board (čovjek), svaka promjena je auditovana, a čak i na R5 sve ide kao PRIJEDLOG —
 * sistem ne deployuje sopstvenu izmjenu bez odobrenja. Razlog: nema evaluacije koja je jeftinija od
 * rizika pogrešne meta-izmjene, a greška na meta-nivou kvari sve niže nivoe odjednom.
 *
 * Stanje: data/tenants/<id>/rsi/level.json + research-YYYY-MM.jsonl
 */
import path from 'node:path';
import { appendJsonl, exists, readJson, writeJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { PolicyError, ValidationError } from '../core/errors.js';

export const RSI_LEVELS = {
  R0: { rank: 0, name: 'none', can: [], requiresAutonomy: 'L0', human: false },
  R1: { rank: 1, name: 'improvement-execution', can: ['execute_improvement', 'run_experiment'], requiresAutonomy: 'L2', human: false },
  R2: { rank: 2, name: 'improvement-strategy', can: ['execute_improvement', 'run_experiment', 'design_experiment'], requiresAutonomy: 'L3', human: false },
  R3: { rank: 3, name: 'experience-acquisition', can: ['execute_improvement', 'run_experiment', 'design_experiment', 'acquire_experience'], requiresAutonomy: 'L3', human: false },
  R4: { rank: 4, name: 'environment-adaptation', can: ['execute_improvement', 'run_experiment', 'design_experiment', 'acquire_experience', 'adapt_environment'], requiresAutonomy: 'L4', human: true },
  R5: { rank: 5, name: 'recursive-meta-improvement', can: ['execute_improvement', 'run_experiment', 'design_experiment', 'acquire_experience', 'adapt_environment', 'meta_improve'], requiresAutonomy: 'L4', human: true },
};

export const DEFAULT_RSI = {
  defaultLevel: 'R1',
  // NAPOMENA: meta-izmjene se NIKAD ne primjenjuju automatski — to je hard-kodirana invarijanta
  // (ranije je postojala `autoMetaPromote` zastavica koju nijedan `if` nije čitao, pa je uklonjena).
  minLift: 0.03,
  maxCandidates: 6,
  strategySpace: ['prompt', 'temperature', 'maxTokens', 'pattern', 'self-play', 'retrieval'],
  environmentTargets: ['domain', 'language', 'kb', 'tools'],
};

export function createMetaRsi({ config = {}, dataDir, logger, metrics, audit, autonomy, improvements, evalHarness, evolution, selfplay, rewards, goals, catalog }) {
  const cfg = { ...DEFAULT_RSI, ...(config ?? {}) };
  const cache = new Map();

  const levelFile = (tenantId) => path.join(dataDir, 'tenants', tenantId, 'rsi', 'level.json');
  const researchFile = (tenantId, d = new Date()) => path.join(dataDir, 'tenants', tenantId, 'rsi', `research-${d.toISOString().slice(0, 7)}.jsonl`);

  async function levelOf(tenantId) {
    if (cache.has(tenantId)) return cache.get(tenantId);
    const file = levelFile(tenantId);
    // `readJson` baca grešku kad fajl ne postoji i default je null → provjeri postojanje
    const saved = exists(file) ? ((await readJson(file, null)) ?? { level: cfg.defaultLevel, history: [] }) : { level: cfg.defaultLevel, history: [] };
    cache.set(tenantId, saved);
    return saved;
  }

  async function saveLevel(tenantId, state) {
    cache.set(tenantId, state);
    await writeJson(levelFile(tenantId), state);
    return state;
  }

  function assertCan(level, action) {
    const info = RSI_LEVELS[level];
    if (!info) throw new ValidationError(`Nepoznat RSI nivo: ${level}`);
    if (!info.can.includes(action)) {
      throw new PolicyError(`RSI nivo ${level} (${info.name}) ne dozvoljava "${action}" — potreban viši nivo i odobrenje boarda`, { level, action });
    }
    return info;
  }

  async function logResearch(tenantId, entry) {
    const record = { id: uid('rsrch'), ts: iso(), tenantId, ...entry };
    await appendJsonl(researchFile(tenantId), record);
    return record;
  }

  const api = {
    RSI_LEVELS,
    settings: cfg,
    levelFile,
    researchFile,

    async level(tenantId) {
      const state = await levelOf(tenantId);
      const info = RSI_LEVELS[state.level] ?? RSI_LEVELS.R0;
      return { tenantId, ...info, level: state.level, since: state.since ?? null, changedBy: state.changedBy ?? null, autoApply: false };
    },

    /** Nivo mijenja ISKLJUČIVO board (čovjek) — auditovano. */
    async setLevel(tenantId, level, { by = 'board', reason = null } = {}) {
      if (!RSI_LEVELS[level]) throw new ValidationError(`Nepoznat RSI nivo: ${level} (dozvoljeno: ${Object.keys(RSI_LEVELS).join(', ')})`);
      const info = RSI_LEVELS[level];
      if (info.requiresAutonomy && autonomy?.levelOf) {
        const current = autonomy.levelOf(tenantId, null);
        const rank = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
        if ((rank[current] ?? 0) < (rank[info.requiresAutonomy] ?? 0)) {
          throw new PolicyError(`RSI ${level} traži autonomiju najmanje ${info.requiresAutonomy} (tenant je na ${current})`, { level, autonomy: current });
        }
      }
      const state = await levelOf(tenantId);
      state.level = level;
      state.since = iso();
      state.changedBy = by;
      state.history = [...(state.history ?? []).slice(-30), { level, by, reason, ts: iso() }];
      await saveLevel(tenantId, state);
      metrics?.inc('rsi_level_changes_total', { tenant: tenantId, level });
      await audit?.append({ tenantId, actor: by, action: 'rsi_level_changed', args: { level, reason, requiresHuman: info.human }, decision: info.human ? 'require_approval' : 'allow', outcome: 'ok' });
      logger?.warn?.('rsi.level_changed', { tenantId, rsiLevel: level, by, reason });
      return api.level(tenantId);
    },

    /** R2+: sam dizajnira eksperiment (koju strategiju i koje kandidate testirati). */
    async designExperiment(tenantId, { agentId, goal = 'povećati prolaznost na zlatnom setu', strategy = null, caseIds = null } = {}) {
      const state = await levelOf(tenantId);
      assertCan(state.level, 'design_experiment');
      const spec = catalog.get(agentId, tenantId);
      if (!spec) throw new ValidationError(`Nepoznat agent: ${agentId}`);

      // Izbor strategije: eksplicitno ili iz prostora strategija (na R2+ sistem bira sam)
      const chosen = strategy ?? cfg.strategySpace[Math.floor(Math.random() * cfg.strategySpace.length)];
      const base = evolution.genomeOf(tenantId, agentId);
      const candidates = [];
      const unique = (list) => {
        const seen = new Set();
        return list.filter((g) => {
          const key = `${g.temperature}|${g.maxTokens}|${g.defaultPattern}|${g.systemPromptSuffix}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };
      if (chosen === 'prompt') candidates.push({ ...base, systemPromptSuffix: evolution.settings.promptMutations[0] }, { ...base, systemPromptSuffix: evolution.settings.promptMutations[1] });
      else if (chosen === 'temperature') candidates.push({ ...base, temperature: 0 }, { ...base, temperature: 0.4 }, { ...base, temperature: 0.8 });
      else if (chosen === 'maxTokens') candidates.push({ ...base, maxTokens: 400 }, { ...base, maxTokens: 1200 });
      else if (chosen === 'pattern') candidates.push(...evolution.settings.patterns.slice(0, 3).map((p) => ({ ...base, defaultPattern: p })));
      else if (chosen === 'self-play') {
        // R3 strategija: ne mijenja prompt, nego mehanizam (refleksija = više internih koraka prije odgovora)
        candidates.push({ ...base, defaultPattern: 'reflection' }, { ...base, defaultPattern: 'agent', systemPromptSuffix: evolution.settings.promptMutations[3] });
      } else if (chosen === 'retrieval') {
        // R3 strategija: prisili pretragu baze znanja i citiranje (drugi mehanizam od običnog prompta)
        candidates.push(
          { ...base, systemPromptSuffix: 'UVIJEK prvo pretraži bazu znanja i navedi izvor ([1], [2]).' },
          { ...base, defaultPattern: 'sequential', systemPromptSuffix: 'Prvo pretraži bazu znanja, zatim odgovori sa citatom.' },
        );
      } else candidates.push(base, { ...base, systemPromptSuffix: evolution.settings.promptMutations[2] });

      const experiment = {
        id: uid('rxp'),
        ts: iso(),
        tenantId,
        agentId,
        goal,
        strategy: chosen,
        caseIds,
        status: 'designed',
        designedBy: `rsi:${state.level}`,
        candidates: candidates.slice(0, cfg.maxCandidates).map((g, i) => ({ label: `${chosen}-${i + 1}`, genome: { ...g, tenantId } })),
      };
      await logResearch(tenantId, { type: 'experiment_designed', ...experiment });
      metrics?.inc('rsi_experiments_total', { tenant: tenantId, strategy: chosen, phase: 'designed' });
      logger?.info?.('rsi.experiment_designed', { tenantId, id: experiment.id, strategy: chosen, candidates: experiment.candidates.length });
      return experiment;
    },

    /** R1+: izvršava eksperiment kroz eval harness (svaki kandidat = specPatch po runu). */
    async runExperiment(tenantId, experiment, { setName = 'golden', maxCases = 8, baseline = null } = {}) {
      if (!experiment?.candidates?.length) throw new ValidationError('Eksperiment nema kandidate');
      const state = await levelOf(tenantId);
      assertCan(state.level, 'run_experiment');

      const results = [];
      for (const candidate of experiment.candidates) {
        const evaluated = await evolution.evaluate(tenantId, candidate.genome, { setName, caseIds: experiment.caseIds, maxCases });
        results.push({
          label: candidate.label,
          genome: candidate.genome,
          fitness: evaluated.fitness,
          passRate: evaluated.report.passRate,
          costUsd: evaluated.report.costUsd,
          failures: evaluated.report.failures,
        });
      }
      results.sort((a, b) => b.fitness - a.fitness);
      const winner = results[0];
      const base = baseline ?? (await evolution.evaluate(tenantId, evolution.genomeOf(tenantId, experiment.agentId), { setName, caseIds: experiment.caseIds, maxCases })).fitness;
      const lift = Number((winner.fitness - base).toFixed(4));
      const verdict = lift >= cfg.minLift ? 'poboljšanje' : lift <= -cfg.minLift ? 'pogoršanje' : 'bez promjene';

      const finished = { ...experiment, status: 'completed', completedAt: iso(), results: results.map((r) => ({ ...r, genome: r.genome })), winner, baselineFitness: base, lift, verdict, setName };
      await logResearch(tenantId, {
        type: 'experiment_completed',
        id: experiment.id,
        tenantId,
        agentId: experiment.agentId,
        strategy: experiment.strategy,
        winner: winner.label,
        lift,
        verdict,
        baseline: base,
        passRate: winner.passRate,
        costUsd: winner.costUsd,
        // Bez `failures` u log-u `metaImprove` nikad ne bi mogao predložiti nove eval slučajeve iz padova
        failures: winner.failures ?? [],
      });
      metrics?.observe('rsi_experiment_lift', { tenant: tenantId, strategy: experiment.strategy }, lift);
      logger?.info?.('rsi.experiment_completed', { tenantId, id: experiment.id, winner: winner.label, lift, verdict });
      return finished;
    },

    /** Promocija pobjednika — UVIJEK kroz prijedlog (čovjek odobrava). */
    async promote(tenantId, experiment, { by = 'rsi', minLift = null } = {}) {
      if (!experiment?.winner) throw new ValidationError('Eksperiment nema pobjednika');
      const state = await levelOf(tenantId);
      assertCan(state.level, 'execute_improvement');
      const gate = minLift ?? cfg.minLift;
      if (experiment.lift < gate) {
        return { promoted: false, reason: `lift ${experiment.lift} je ispod kapije ${gate} — promjena se ne predlaže`, verdict: experiment.verdict };
      }
      if (!improvements) throw new PolicyError('Improvement engine nije dostupan');
      const agentId = experiment.agentId;
      const spec = catalog.get(agentId, tenantId);
      const suffix = experiment.winner.genome.systemPromptSuffix ?? '';
      const proposal = await improvements.createProposal(tenantId, {
        kind: 'prompt',
        target: agentId,
        current: spec?.systemPrompt?.slice(0, 300) ?? null,
        // Prijedlog nosi CIJELI genom (prompt + temperatura + maxTokens + pattern) — ranije se prenosio samo prompt
        proposed: {
          systemPrompt: `${spec?.systemPrompt ?? ''}\n\n${suffix}`.trim(),
          temperature: experiment.winner.genome.temperature,
          maxTokens: experiment.winner.genome.maxTokens,
          defaultPattern: experiment.winner.genome.defaultPattern,
        },
        rationale: `RSI eksperiment ${experiment.id} (strategija: ${experiment.strategy}): "${experiment.winner.label}" ima lift ${experiment.lift} na setu "${experiment.setName}"`,
        evidence: [{ experimentId: experiment.id, winner: experiment.winner.label, lift: experiment.lift, baseline: experiment.baselineFitness, fitness: experiment.winner.fitness, passRate: experiment.winner.passRate }],
        expectedImpact: `+${(experiment.lift * 100).toFixed(1)} p.p. na zlatnom setu`,
        riskLevel: 'medium',
        source: 'rsi',
      });
      await logResearch(tenantId, { type: 'promotion_proposed', id: experiment.id, tenantId, agentId, proposalId: proposal.id, lift: experiment.lift, by });
      metrics?.inc('rsi_promotions_total', { tenant: tenantId, result: 'proposed' });
      return { promoted: true, proposal, lift: experiment.lift, autoApplied: false, note: 'Primjena ide kroz human-in-the-loop odobrenje (docs/21, docs/31).' };
    },

    /** R3: sam pribavlja iskustvo (self-play) — dataset ostaje u tenantu, ništa se ne deployuje. */
    async acquireExperience(tenantId, { rounds = 3, agentId = 'support', domain = 'support' } = {}) {
      const state = await levelOf(tenantId);
      assertCan(state.level, 'acquire_experience');
      if (!selfplay) throw new PolicyError('Self-play nije dostupan');
      const cycle = await selfplay.run(tenantId, { rounds, solverAgent: agentId, domain, difficulty: 2 });
      const dataset = await selfplay.dataset(tenantId);
      await logResearch(tenantId, { type: 'experience_acquired', tenantId, agentId, rounds: cycle.rounds, passRate: cycle.passRate, dataset: dataset.total, costUsd: cycle.costUsd });
      metrics?.inc('rsi_experience_cycles_total', { tenant: tenantId });
      return { level: state.level, cycle: { rounds: cycle.rounds, passRate: cycle.passRate, costUsd: cycle.costUsd, proposalId: cycle.proposalId ?? null }, dataset: { total: dataset.total }, note: 'Iskustvo ostaje kao dataset u tenantu; trening modela je van procesa (docs/32).' };
    },

    /** R4: prilagođavanje novom okruženju — predlaže (nikad tiho ne mijenja alate/politike). */
    async adaptEnvironment(tenantId, { target = 'domain', value, agentId = null, rationale = null } = {}) {
      const state = await levelOf(tenantId);
      assertCan(state.level, 'adapt_environment');
      if (!cfg.environmentTargets.includes(target)) throw new ValidationError(`Nepoznat target: ${target} (dozvoljeno: ${cfg.environmentTargets.join(', ')})`);
      if (!value) throw new ValidationError('adaptEnvironment traži "value"');
      if (!improvements) throw new PolicyError('Improvement engine nije dostupan');

      const kind = target === 'kb' ? 'kb' : 'prompt';
      const proposal = await improvements.createProposal(tenantId, {
        kind,
        target: agentId,
        current: null,
        proposed: kind === 'kb' ? { text: String(value), source: `rsi:adapt:${target}` } : `Prilagodi se novom okruženju (${target}: ${value}).\n\n${catalog.get(agentId, tenantId)?.systemPrompt ?? ''}`.trim(),
        rationale: rationale ?? `R4 environment-adaptation: novi ${target} = "${value}"`,
        evidence: [{ level: state.level, target, value }],
        expectedImpact: `rad u novom okruženju (${target})`,
        riskLevel: target === 'tools' ? 'high' : 'medium',
        source: 'rsi',
      });
      await logResearch(tenantId, { type: 'environment_adaptation_proposed', tenantId, target, value, proposalId: proposal.id });
      return { proposed: true, proposal, note: target === 'tools' ? 'Promjena alata je visok rizik — traži board (docs/33).' : 'Ide kroz odobrenje.' };
    },

    /** R5: predlaže izmjenu SAMOG PROCESA poboljšavanja (meta). Nikad se ne primjenjuje samo. */
    async metaImprove(tenantId, { from = 'research_log' } = {}) {
      const state = await levelOf(tenantId);
      assertCan(state.level, 'meta_improve');
      const log = await api.researchLog(tenantId, { limit: 200 });
      const experiments = log.filter((e) => e.type === 'experiment_completed');
      const strategies = experiments.reduce((acc, e) => {
        const key = e.strategy ?? 'unknown';
        acc[key] = acc[key] ?? { runs: 0, lifts: [] };
        acc[key].runs += 1;
        acc[key].lifts.push(Number(e.lift ?? 0));
        return acc;
      }, {});
      const ranked = Object.entries(strategies)
        .map(([strategy, v]) => ({ strategy, runs: v.runs, avgLift: Number((v.lifts.reduce((s, x) => s + x, 0) / v.runs).toFixed(4)) }))
        .sort((a, b) => b.avgLift - a.avgLift);

      const best = ranked[0];
      const worst = ranked.at(-1);
      const plan = {
        id: uid('meta'),
        ts: iso(),
        tenantId,
        from,
        observations: {
          experiments: experiments.length,
          strategies: ranked,
          best: best ?? null,
          worst: worst ?? null,
        },
        proposals: [],
      };

      if (best && worst && best.strategy !== worst.strategy && best.avgLift - worst.avgLift > cfg.minLift) {
        plan.proposals.push({
          type: 'process_change',
          title: `Povećaj težinu strategije "${best.strategy}", smanji "${worst.strategy}"`,
          rationale: `"${best.strategy}" daje prosječan lift ${best.avgLift} na ${best.runs} eksperimenata, a "${worst.strategy}" ${worst.avgLift} na ${worst.runs}`,
          expectedImpact: 'brža konvergencija ka boljem kvalitetu uz isti broj runova',
          riskLevel: 'medium',
          autoApplicable: false,
        });
      }
      // predlog da se iz padova naprave novi eval slučajevi (proces uči šta ga je lomilo)
      const failureCases = experiments.flatMap((e) => (e.failures ?? []).map((f) => f.caseId)).filter(Boolean);
      const uniqueFailures = [...new Set(failureCases)];
      if (uniqueFailures.length) {
        plan.proposals.push({
          type: 'eval_extension',
          title: `Dodaj ${uniqueFailures.length} nove provjere u zlatni set iz stvarnih padova`,
          rationale: `Padovi uočeni u eksperimentima: ${uniqueFailures.slice(0, 6).join(', ')}`,
          expectedImpact: 'eval postaje teži tačno tamo gdje sistem greši',
          riskLevel: 'low',
          autoApplicable: false,
        });
      }

      await logResearch(tenantId, { type: 'meta_improvement', ...plan });
      metrics?.inc('rsi_meta_cycles_total', { tenant: tenantId });

      // svi meta-predlozi idu u inbox kao prijedlozi (kind: code) — čovjek odlučuje
      const created = [];
      for (const p of plan.proposals) {
        if (!improvements) break;
        const proposal = await improvements.createProposal(tenantId, {
          kind: 'code',
          target: 'rsi',
          current: null,
          proposed: p.title,
          rationale: p.rationale,
          evidence: [plan.observations],
          expectedImpact: p.expectedImpact,
          riskLevel: p.riskLevel,
          source: 'rsi-meta',
        });
        created.push({ ...p, proposalId: proposal.id });
      }
      plan.createdProposals = created;
      logger?.warn?.('rsi.meta_improvement', { tenantId, proposals: created.length, autoApply: false });
      return { ...plan, proposals: created, note: 'Meta-izmjene su PRIJEDLOZI: na R5 sistem predlaže kako da poboljša proces, ali ga ne mijenja sam.' };
    },

    async researchLog(tenantId, { limit = 100 } = {}) {
      const { readJsonl } = await import('../core/fsx.js');
      return readJsonl(researchFile(tenantId), { limit, tail: true });
    },

    /** Zbirni prikaz za board: nivo, eksperimenti, trend lifta, kapije. */
    async status(tenantId) {
      const info = await api.level(tenantId);
      const log = await api.researchLog(tenantId, { limit: 200 });
      const completed = log.filter((l) => l.type === 'experiment_completed');
      const lifts = completed.map((c) => Number(c.lift ?? 0));
      return {
        ...info,
        experiments: completed.length,
        avgLift: lifts.length ? Number((lifts.reduce((s, x) => s + x, 0) / lifts.length).toFixed(4)) : 0,
        bestLift: lifts.length ? Math.max(...lifts) : 0,
        promotionsProposed: log.filter((l) => l.type === 'promotion_proposed').length,
        metaCycles: log.filter((l) => l.type === 'meta_improvement').length,
        gates: Object.fromEntries(Object.entries(RSI_LEVELS).map(([k, v]) => [k, { name: v.name, requiresAutonomy: v.requiresAutonomy, human: v.human, actions: v.can }])),
        autoApply: false, // meta-izmjene se ne primjenjuju automatski (hard-kodirano)
        nextStep: info.rank >= 5 ? 'R5 je plafon: predlaži, ne primjenjuj — board odlučuje.' : `Sljedeći nivo (${Object.keys(RSI_LEVELS)[info.rank + 1]}) traži autonomiju ${RSI_LEVELS[Object.keys(RSI_LEVELS)[info.rank + 1]]?.requiresAutonomy} i odobrenje boarda.`,
      };
    },
  };

  return api;
}
