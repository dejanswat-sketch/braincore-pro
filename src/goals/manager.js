/**
 * Goal manager: visokonivo cilj → podciljevi → plan → KPI → mjerenje → replan.
 *
 * Cilj nije prompt — cilj je zapis sa metrikom, rokom, vlasnikom i istorijom.
 * Agent ga juri kroz poslove (scheduler), mjeri KPI-je i sam predlaže korekciju kad skrene.
 *
 * Stanje: data/tenants/<id>/goals/goals.json (+ progress-YYYY-MM.jsonl)
 */
import path from 'node:path';
import { appendJsonl, readJson, readJsonl, writeJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { ValidationError, NotFoundError } from '../core/errors.js';

const STATUSES = ['draft', 'active', 'on_track', 'at_risk', 'off_track', 'achieved', 'missed', 'paused', 'cancelled'];

export function createGoalManager({ dataDir, llm, catalog, scheduler, controlPlane, cost, logger, metrics, audit, helpers }) {
  const cache = new Map();

  const dir = (tenantId) => path.join(dataDir, 'tenants', tenantId, 'goals');
  const file = (tenantId) => path.join(dir(tenantId), 'goals.json');
  const progressFile = (tenantId, d = new Date()) => path.join(dir(tenantId), `progress-${d.toISOString().slice(0, 7)}.jsonl`);

  async function load(tenantId) {
    if (cache.has(tenantId)) return cache.get(tenantId);
    const state = (await readJson(file(tenantId), { goals: {} })) ?? { goals: {} };
    if (!state.goals) state.goals = {};
    cache.set(tenantId, state);
    return state;
  }

  async function persist(tenantId) {
    const state = await load(tenantId);
    await writeJson(file(tenantId), state);
    return state;
  }

  /** Napredak cilja: koliko je prešao put od baseline do target-a. */
  function progressPct(goal) {
    const { baseline = 0, target = 0 } = goal;
    const current = goal.current ?? baseline;
    const span = target - baseline;
    if (span === 0) return current >= target ? 100 : 0;
    return Number((((current - baseline) / span) * 100).toFixed(1));
  }

  /** Očekivani napredak srazmjerno proteklom vremenu (da znamo da li kasni). */
  function expectedPct(goal, at = Date.now()) {
    const start = new Date(goal.startAt ?? goal.createdAt).getTime();
    const end = new Date(goal.deadline).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return Number(Math.min(100, Math.max(0, ((at - start) / (end - start)) * 100)).toFixed(1));
  }

  function health(goal, at = Date.now()) {
    const pct = progressPct(goal);
    const expected = expectedPct(goal, at);
    if (expected === null) return { status: pct >= 100 ? 'achieved' : 'active', pct, expected };
    if (pct >= 100) return { status: 'achieved', pct, expected };
    if (new Date(goal.deadline).getTime() < at && pct < 100) return { status: 'missed', pct, expected };
    const gap = expected - pct;
    const status = gap <= 10 ? 'on_track' : gap <= 30 ? 'at_risk' : 'off_track';
    return { status, pct, expected, gap: Number(gap.toFixed(1)) };
  }

  return {
    STATUSES,
    dir,
    file,
    STATUS_LIST: STATUSES,

    async load(tenantId) {
      return load(tenantId);
    },

    async create(tenantId, spec = {}) {
      if (!spec.title) throw new ValidationError('Cilj traži "title"');
      if (!spec.metric) throw new ValidationError('Cilj traži "metric" (npr. "monthly_revenue_eur")');
      if (spec.target === undefined) throw new ValidationError('Cilj traži "target"');
      if (!spec.deadline) throw new ValidationError('Cilj traži "deadline" (ISO datum)');

      const goal = {
        id: spec.id ?? uid('goal'),
        tenantId,
        title: spec.title,
        description: spec.description ?? '',
        metric: spec.metric,
        unit: spec.unit ?? '',
        baseline: Number(spec.baseline ?? 0),
        target: Number(spec.target),
        current: Number(spec.baseline ?? 0),
        deadline: spec.deadline,
        startAt: spec.startAt ?? iso(),
        owner: spec.owner ?? 'ceo',
        subgoals: spec.subgoals ?? [],
        kpis: spec.kpis ?? [],
        plan: spec.plan ?? [],
        status: spec.status ?? 'active',
        cadence: spec.cadence ?? 'weekly',
        budgetUsd: spec.budgetUsd ?? null,
        createdAt: iso(),
        updatedAt: iso(),
        progress: [],
        replans: [],
        source: spec.source ?? 'api',
      };
      const state = await load(tenantId);
      state.goals[goal.id] = goal;
      await persist(tenantId);
      metrics?.inc('goals_created_total', { tenant: tenantId, owner: goal.owner });
      await audit?.append({ tenantId, actor: goal.owner, action: 'goal_create', args: { goalId: goal.id, metric: goal.metric, target: goal.target }, decision: 'allow', outcome: 'ok' });
      logger?.info?.('goal.created', { tenantId, goalId: goal.id, title: goal.title, deadline: goal.deadline });
      return this.decorate(goal);
    },

    decorate(goal, at = Date.now()) {
      const h = health(goal, at);
      return { ...goal, progressPct: h.pct, expectedPct: h.expected, status: goal.status === 'paused' ? 'paused' : h.status };
    },

    async get(tenantId, goalId) {
      const state = await load(tenantId);
      const goal = state.goals[goalId];
      if (!goal) throw new NotFoundError('Cilj', goalId);
      return this.decorate(goal);
    },

    async list(tenantId, { status } = {}) {
      const state = await load(tenantId);
      const rows = Object.values(state.goals).map((g) => this.decorate(g));
      return status ? rows.filter((g) => g.status === status) : rows.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
    },

    /** Razbija cilj na podciljeve i plan koraka (LLM), i veže ga na agente iz kataloga. */
    async decompose(tenantId, goalId, ctx = {}) {
      const state = await load(tenantId);
      const goal = state.goals[goalId];
      if (!goal) throw new NotFoundError('Cilj', goalId);
      const cat = catalog?.view ? catalog.view(tenantId) : catalog;
      const agentList = (cat?.routingTable?.() ?? []).map((a) => `- ${a.id} (${a.domain}): ${a.description}`).join('\n');

      const res = await helpers.callLlm(
        { tenantId, agentId: goal.owner, budget: ctx.budget, trace: ctx.trace, runId: ctx.runId, signal: ctx.signal, pattern: 'goal-decompose' },
        {
          role: 'goal-decomposer',
          temperature: 0.2,
          maxTokens: 900,
          responseFormat: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: [
                'Ti si strateg. Razbij cilj na 3-6 podciljeva i plan koraka.',
                'Vrati JSON: {"subgoals":[{"title":"...","metric":"...","target":0,"owner":"<agent id>"}],"plan":[{"step":"...","agent":"<agent id>","when":"nedjelja 1"}],"kpis":["..."]}',
                'Podciljevi moraju biti mjerljivi. Koristi SAMO agente sa spiska.',
                'Plan ne smije imati više od 8 koraka i mora pokriti cijeli rok cilja.',
                '',
                'Agenti:',
                agentList,
              ].join('\n'),
            },
            {
              role: 'user',
              content: `CILJ: ${goal.title}\nMETRIKA: ${goal.metric} (${goal.baseline} → ${goal.target} ${goal.unit})\nROK: ${goal.deadline}\nOPIS: ${goal.description}`,
            },
          ],
        },
      );
      const parsed = helpers.parseJson(res.text, null) ?? { subgoals: [], plan: [], kpis: [] };
      goal.subgoals = (parsed.subgoals ?? []).slice(0, 8).map((s) => ({ ...s, id: uid('sg'), status: 'active' }));
      goal.plan = (parsed.plan ?? []).slice(0, 12);
      goal.kpis = parsed.kpis ?? goal.kpis;
      goal.updatedAt = iso();
      await persist(tenantId);
      await audit?.append({ tenantId, actor: goal.owner, action: 'goal_decompose', args: { goalId, subgoals: goal.subgoals.length, plan: goal.plan.length }, decision: 'allow', outcome: 'ok', meta: { costUsd: res.costUsd } });
      logger?.info?.('goal.decomposed', { tenantId, goalId, subgoals: goal.subgoals.length, steps: goal.plan.length });
      return { goal: this.decorate(goal), costUsd: res.costUsd, usage: res.usage };
    },

    /** Upis mjerenja metrike (iz sistema, agenta ili čovjeka). */
    async recordProgress(tenantId, goalId, { value, note = null, source = 'manual', at = iso() } = {}) {
      if (value === undefined || value === null || Number.isNaN(Number(value))) throw new ValidationError('Mjerenje traži numeričku "value"');
      const state = await load(tenantId);
      const goal = state.goals[goalId];
      if (!goal) throw new NotFoundError('Cilj', goalId);
      const entry = { ts: at, value: Number(value), note, source };
      goal.current = Number(value);
      goal.progress = [...(goal.progress ?? []).slice(-200), entry];
      const h = health(goal, new Date(at).getTime());
      goal.status = h.status;
      goal.updatedAt = iso();
      await persist(tenantId);
      await appendJsonl(progressFile(tenantId, new Date(at)), { goalId, tenantId, ...entry, progressPct: h.pct, status: h.status });
      metrics?.inc('goal_progress_updates_total', { tenant: tenantId, goal: goalId, status: h.status });
      if (['at_risk', 'off_track', 'missed'].includes(h.status)) {
        metrics?.inc('goals_at_risk_total', { tenant: tenantId, status: h.status });
        logger?.warn?.('goal.at_risk', { tenantId, goalId, status: h.status, pct: h.pct, expected: h.expected });
      }
      return this.decorate(goal);
    },

    /**
     * Replan: kad cilj skrene, agent predlaže izmjenu plana (i, ako je autonomija L2+, sam ga primijeni).
     * @returns {Promise<{goal, proposal, costUsd}>}
     */
    async replan(tenantId, goalId, ctx = {}) {
      const state = await load(tenantId);
      const goal = state.goals[goalId];
      if (!goal) throw new NotFoundError('Cilj', goalId);
      const h = health(goal);
      const res = await helpers.callLlm(
        { tenantId, agentId: goal.owner, budget: ctx.budget, trace: ctx.trace, runId: ctx.runId, signal: ctx.signal, pattern: 'goal-replan' },
        {
          role: 'goal-replanner',
          temperature: 0.3,
          maxTokens: 800,
          responseFormat: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: [
                'Cilj kasni. Predloži konkretnu korekciju taktike.',
                'Vrati JSON: {"diagnosis":"...","actions":[{"step":"...","agent":"...","when":"..."}],"drop":["..."],"expectedEffect":"..."}',
                'Ne mijenjaj sam cilj (target/rok) — mijenjaj put do cilja.',
              ].join('\n'),
            },
            {
              role: 'user',
              content: `CILJ: ${goal.title}\nMETRIKA: ${goal.metric}\nTRENUTNO: ${goal.current} / CILJ: ${goal.target}\nSTATUS: ${h.status} (ostvareno ${h.pct}%, očekivano ${h.expected}%)\nPLAN:\n${(goal.plan ?? []).map((p, i) => `${i + 1}. ${p.step} (${p.agent}, ${p.when})`).join('\n')}`,
            },
          ],
        },
      );
      const parsed = helpers.parseJson(res.text, null) ?? { diagnosis: 'nepoznato', actions: [] };
      goal.replans = [...(goal.replans ?? []).slice(-10), { ts: iso(), status: h.status, pct: h.pct, diagnosis: parsed.diagnosis, actions: parsed.actions, dropped: parsed.drop ?? [] }];
      goal.updatedAt = iso();
      await persist(tenantId);
      await audit?.append({ tenantId, actor: goal.owner, action: 'goal_replan', args: { goalId, status: h.status, actions: (parsed.actions ?? []).length }, decision: 'allow', outcome: 'ok' });
      metrics?.inc('goal_replans_total', { tenant: tenantId, goal: goalId });
      return { goal: this.decorate(goal), proposal: parsed, costUsd: res.costUsd, usage: res.usage };
    },

    /**
     * Zakazuje poslove iz plana cilja (persistentni agenti ga onda jure sami).
     * Vraća listu kreiranih poslova; traži scheduler.
     */
    async schedule(tenantId, goalId, { startInMs = 0, stepDelayMs = 3_600_000 } = {}) {
      if (!scheduler) throw new ValidationError('Scheduler nije dostupan — cilj ne može da zakaže poslove');
      const goal = await this.get(tenantId, goalId);
      const jobs = [];
      for (const [i, step] of (goal.plan ?? []).entries()) {
        jobs.push(
          await scheduler.createJob(tenantId, {
            name: `cilj:${goal.id} korak ${i + 1}: ${String(step.step).slice(0, 60)}`,
            agentId: step.agent ?? goal.owner,
            pattern: step.pattern,
            input: `CILJ: ${goal.title}\nKORAK ${i + 1}/${goal.plan.length}: ${step.step}\nTrenutno stanje metrike ${goal.metric}: ${goal.current} (cilj ${goal.target} do ${goal.deadline}).\nUradi ovaj korak i na kraju upiši novo mjerenje metrike ako ga možeš izmjeriti.`,
            schedule: { type: 'once', at: Date.now() + startInMs + i * stepDelayMs },
            enabled: true,
            goalId: goal.id,
            retry: { max: 2, backoffMs: 10_000 },
          }),
        );
      }
      goal.jobs = jobs.map((j) => j.id);
      goal.updatedAt = iso();
      const state = await load(tenantId);
      state.goals[goalId] = { ...state.goals[goalId], jobs: goal.jobs };
      await persist(tenantId);
      logger?.info?.('goal.scheduled', { tenantId, goalId, jobs: jobs.length });
      return { goalId, jobs: jobs.map((j) => ({ id: j.id, name: j.name, at: j.nextRunAt })) };
    },

    async setStatus(tenantId, goalId, status) {
      if (!STATUSES.includes(status)) throw new ValidationError(`Nepoznat status cilja: ${status}`);
      const state = await load(tenantId);
      const goal = state.goals[goalId];
      if (!goal) throw new NotFoundError('Cilj', goalId);
      goal.status = status;
      goal.updatedAt = iso();
      await persist(tenantId);
      await audit?.append({ tenantId, actor: 'api', action: 'goal_status', args: { goalId, status }, decision: 'allow', outcome: 'ok' });
      return this.decorate(goal);
    },

    /** Pregled portfolija: koliko ciljeva je na putu, koliko kasni. */
    async portfolio(tenantId) {
      const goals = await this.list(tenantId);
      const byStatus = goals.reduce((acc, g) => ({ ...acc, [g.status]: (acc[g.status] ?? 0) + 1 }), {});
      const atRisk = goals.filter((g) => ['at_risk', 'off_track', 'missed'].includes(g.status));
      return {
        total: goals.length,
        byStatus,
        atRisk: atRisk.map((g) => ({ id: g.id, title: g.title, status: g.status, pct: g.progressPct, expected: g.expectedPct, deadline: g.deadline, owner: g.owner })),
        goals,
      };
    },

    async addSubgoal(tenantId, goalId, subgoal) {
      const state = await load(tenantId);
      const goal = state.goals[goalId];
      if (!goal) throw new NotFoundError('Cilj', goalId);
      const sg = { id: uid('sg'), status: 'active', ...subgoal };
      goal.subgoals = [...(goal.subgoals ?? []), sg];
      goal.updatedAt = iso();
      await persist(tenantId);
      return sg;
    },

    async history(tenantId, { limit = 100 } = {}) {
      return readJsonl(progressFile(tenantId), { limit, tail: true });
    },
  };
}
