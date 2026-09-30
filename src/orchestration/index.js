/**
 * Orchestracija: jedan ulaz (`run`) i 6 patterna iza njega.
 * Pattern se bira: eksplicitno (options.pattern) → default agenta (config/agents/*.json) → `router` ako nema agenta.
 */
import { createSequentialPattern } from './sequential.js';
import { createOrchestratorWorkerPattern } from './orchestrator-worker.js';
import { createFanoutPattern } from './fanout.js';
import { createHandoffPattern } from './handoff.js';
import { createMagenticPattern } from './magentic.js';
import { createReflectionPattern } from './reflection.js';
import { createDebatePattern } from './debate.js';
import { createTeamPattern } from './team.js';
import { createPatternHelpers } from './helpers.js';
import { createBudget } from '../core/budget.js';
import { NotFoundError, ValidationError, PolicyError } from '../core/errors.js';

/**
 * 11 ulaza: `agent` (ReAct petlja) i `react` (alias), `router`, `sequential`, `orchestrator-worker`,
 * `fanout`, `handoff`, `magentic`, `reflection`, `debate`, `team`.
 */
export const PATTERNS = ['agent', 'react', 'router', 'sequential', 'orchestrator-worker', 'fanout', 'handoff', 'magentic', 'reflection', 'debate', 'team'];

/**
 * Koliko koraka (LLM poziva + poziva alata) pattern tipično traži, u odnosu na jednog agenta.
 * Bez ovoga bi `team` (7 specijalista) pao na budžetu predviđenom za jedan razgovor.
 */
export const PATTERN_STEP_BUDGET = {
  agent: 1,
  react: 1,
  router: 2,
  sequential: 2,
  'orchestrator-worker': 3,
  fanout: 3,
  handoff: 3,
  magentic: 3,
  reflection: 3,
  debate: 5,
  team: 6,
};

export function createOrchestrator(services) {
  const { catalog, runAgent, tools, tracer, cost, metrics, logger, policyResolver, config } = services;
  const helpers = services.helpers ?? createPatternHelpers(services);

  const patterns = {
    agent: {
      name: 'agent',
      run: async ({ input, ctx }) => {
        const spec = (ctx.catalog ?? catalog).get(ctx.agentId) ?? (ctx.catalog ?? catalog).get('support');
        const res = await runAgent(spec, input, ctx);
        return { output: res.output, status: res.status, results: [res], usage: res.usage, costUsd: res.costUsd, approvals: res.approvals, handoffs: res.handoffs };
      },
    },
    sequential: createSequentialPattern({ ...services, helpers }),
    'orchestrator-worker': createOrchestratorWorkerPattern({ ...services, helpers }),
    fanout: createFanoutPattern({ ...services, helpers }),
    handoff: createHandoffPattern({ ...services, helpers }),
    magentic: createMagenticPattern({ ...services, helpers }),
    reflection: createReflectionPattern({ ...services, helpers }),
    debate: createDebatePattern({ ...services, helpers }),
    team: createTeamPattern({ ...services, helpers }),
  };
  patterns.react = patterns.agent; // ReAct = ista petlja (reason → act → observe), ime je samo eksplicitnije

  /**
   * @param {object} req
   * @param {string} req.tenantId
   * @param {string} [req.agentId]
   * @param {*} req.input
   * @param {string} [req.pattern]
   * @param {object} [req.options]  config za pattern
   */
  async function run(req = {}) {
    const { tenantId, agentId, input, options = {}, signal, onEvent, userId, sessionId, approvedTools } = req;
    if (!tenantId) throw new ValidationError('tenantId je obavezan');
    if (input === undefined || input === null || input === '') throw new ValidationError('input je obavezan');

    const tenant = config.tenant(tenantId);
    if (!tenant) throw new NotFoundError('Tenant', tenantId);
    // Per-tenant pogled na katalog: override (deploy) jednog klijenta ne dira druge klijente
    const tCatalog = catalog.view ? catalog.view(tenantId) : catalog;
    if (agentId && !tCatalog.get(agentId)) throw new NotFoundError('Agent', agentId);
    assertAgentAllowed(tenant, agentId);
    // Per-agent identitet i budžet (control plane) — agent ne smije potrošiti više od svog mjesečnog limita
    if (services.controlPlane?.assertAgentBudget) await services.controlPlane.assertAgentBudget(tenantId, agentId ?? 'router');

    const requestedPattern = req.pattern && PATTERNS.includes(req.pattern) ? req.pattern : null;
    const agentSpec = agentId ? tCatalog.get(agentId) : null;
    const initialPattern = requestedPattern ?? agentSpec?.defaultPattern ?? 'router';

    const policy = policyResolver(tenantId, { agentId: agentId ?? undefined });
    const run0 = tracer.startRun({
      tenantId,
      agentId: agentId ?? 'router',
      pattern: initialPattern,
      input,
      sessionId,
      userId,
    });

    const spentThisMonth = await cost.monthlySpent(tenantId);
    const baseMaxSteps = options.maxSteps ?? policy.maxSteps ?? tenant.maxSteps ?? config.env.maxSteps;
    const budget = createBudget({
      runUsd: options.maxRunUsd ?? tenant.budget?.runUsd ?? config.env.budget.runUsd,
      monthlyUsd: tenant.budget?.monthlyUsd ?? config.env.budget.monthlyUsd,
      spentThisMonthUsd: spentThisMonth,
      maxSteps: baseMaxSteps * (PATTERN_STEP_BUDGET[initialPattern] ?? 1),
      maxWallMs: options.maxWallMs ?? 180_000,
    });

    const ctx = {
      tenantId,
      agentId: agentId ?? null,
      userId: userId ?? null,
      sessionId: sessionId ?? null,
      runId: run0.runId,
      trace: run0,
      budget,
      policy,
      signal,
      pattern: initialPattern,
      approvedTools: normalizeApprovals(approvedTools),
      blackboard: options.blackboard ?? {},
      catalog: tCatalog,
      memory: services.memory ?? null,
      tools,
      llm: services.llm ?? null,
      helpers,
      sandbox: services.sandbox ?? null,
      options,
      jobId: options.jobId ?? options.patternConfig?.jobId ?? null,
      budgetPerRunUsd: options.maxRunUsd,
      onEvent: typeof onEvent === 'function' ? onEvent : undefined,
      monthlySpentUsd: spentThisMonth,
    };

    let result;
    let routing = null;
    let usedPattern = initialPattern;
    const startedAt = Date.now();

    try {
      if (initialPattern === 'router') {
        routing = await services.router.classify(input, { tenantId, useLlm: options.useLlmRouter !== false, signal, model: options.routerModel });
        const chosen = tCatalog.get(routing.agentId) ?? tCatalog.get('support');
        assertAgentAllowed(tenant, chosen.id);
        if (services.controlPlane?.assertAgentBudget) await services.controlPlane.assertAgentBudget(tenantId, chosen.id);
        usedPattern = chosen.defaultPattern && chosen.defaultPattern !== 'router' ? chosen.defaultPattern : 'agent';
        budget.setMaxSteps(baseMaxSteps * (PATTERN_STEP_BUDGET[usedPattern] ?? 1));
        ctx.agentId = chosen.id;
        ctx.pattern = usedPattern;
        run0.agentId = chosen.id;
        run0.pattern = usedPattern;
        onEvent?.({ type: 'routing', ...routing, pattern: usedPattern });
        const span = tracer.span(run0, 'router', { agentId: chosen.id, confidence: routing.confidence, method: routing.method });
        span.end({ candidates: routing.candidates?.length ?? 0 });
        result = await patterns[usedPattern].run({ input, ctx, config: patternConfigFor(chosen, usedPattern, options) });
      } else {
        const spec = agentSpec ?? tCatalog.get('support');
        ctx.agentId = spec.id;
        budget.setMaxSteps(baseMaxSteps * (PATTERN_STEP_BUDGET[initialPattern] ?? 1));
        result = await patterns[initialPattern].run({ input, ctx, config: { ...patternConfigFor(spec, initialPattern, options), ...(options.patternConfig ?? {}) } });
      }
    } catch (err) {
      const ended = await tracer.endRun(run0, { status: 'error', error: err, usage: { tokensIn: budget.state.tokensIn, tokensOut: budget.state.tokensOut }, costUsd: budget.state.usd });
      err.runId = ended.runId;
      err.traceId = ended.traceId;
      throw err;
    }

    const durationMs = Date.now() - startedAt;
    await tracer.endRun(run0, {
      output: result.output,
      status: result.status ?? 'ok',
      usage: { tokensIn: budget.state.tokensIn, tokensOut: budget.state.tokensOut },
      costUsd: budget.state.usd,
    });

    metrics?.inc('cost_usd_total', { tenant: tenantId, agent: ctx.agentId ?? '-' }, budget.state.usd);

    return {
      runId: run0.runId,
      traceId: run0.traceId,
      tenantId,
      agentId: ctx.agentId ?? null,
      pattern: usedPattern,
      status: result.status ?? (result.approvals?.length ? 'awaiting_approval' : 'ok'),
      output: result.output ?? '',
      routing,
      result,
      usage: { tokensIn: budget.state.tokensIn, tokensOut: budget.state.tokensOut },
      costUsd: Number(budget.state.usd.toFixed(6)),
      steps: budget.state.steps,
      spans: run0.spans.length,
      durationMs,
      approvals: result.approvals ?? [],
      handoffs: result.handoffs ?? [],
    };
  }

  function normalizeApprovals(approvedTools) {
    if (!approvedTools) return new Set();
    if (approvedTools instanceof Set) return approvedTools;
    if (Array.isArray(approvedTools)) return new Set(approvedTools);
    if (typeof approvedTools === 'object') return new Set(Object.keys(approvedTools).filter((k) => approvedTools[k]));
    return new Set();
  }

  /** Tenant može da ograniči koji agenti su mu dostupni (allowedAgents). */
  function assertAgentAllowed(tenant, agentIdToCheck) {
    if (!agentIdToCheck) return true;
    const allowed = tenant.allowedAgents;
    if (!allowed || allowed === '*' || (Array.isArray(allowed) && allowed.includes(agentIdToCheck))) return true;
    throw new PolicyError(`Agent "${agentIdToCheck}" nije dozvoljen za tenant "${tenant.id}"`, { agentId: agentIdToCheck, tenantId: tenant.id, allowed });
  }

  function patternConfigFor(spec, pattern, options) {
    const base = spec?.patternConfig ?? {};
    return { ...base, ...(options?.patternConfig ?? {}) };
  }

  return { run, patterns, helpers, PATTERNS };
}
