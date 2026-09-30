/**
 * Tool registry — jedina ulazna tačka za izvršavanje alata.
 * Redoslijed: validacija → politika (allow/deny/approval) → budžet → izvršenje (timeout/retry) → audit → metrike.
 * Nijedan alat se NE smije pozvati mimo ovoga (ni MCP, ni ugrađeni).
 */
import { PolicyError, ApprovalRequiredError, ToolError, ValidationError, TimeoutError, NotFoundError } from '../core/errors.js';
import { evaluate, DECISIONS } from '../core/policy.js';
import { createBudget } from '../core/budget.js';
import { iso, timer, sleep } from '../core/clock.js';
import { truncate } from '../core/ids.js';

const RISK_ORDER = { low: 1, medium: 2, high: 3 };

export function createToolRegistry({ logger, metrics, audit, policyResolver, defaultTimeoutMs = 20_000 } = {}) {
  const tools = new Map();

  function register(tool) {
    if (!tool?.name) throw new ValidationError('Alat mora imati name');
    if (typeof tool.handler !== 'function') throw new ValidationError(`Alat ${tool.name} nema handler`);
    const def = {
      name: tool.name,
      description: tool.description ?? '',
      params: tool.params ?? { type: 'object', properties: {}, additionalProperties: true },
      riskLevel: tool.riskLevel ?? 'low',
      scopes: tool.scopes ?? [],
      source: tool.source ?? 'builtin',
      timeoutMs: tool.timeoutMs ?? defaultTimeoutMs,
      retries: tool.retries ?? 0,
      tags: tool.tags ?? [],
      handler: tool.handler,
    };
    tools.set(def.name, def);
    return def;
  }

  function get(name) {
    return tools.get(name) ?? null;
  }

  function list({ source, tag } = {}) {
    return [...tools.values()].filter((t) => (!source || t.source === source) && (!tag || t.tags.includes(tag)));
  }

  /** Definicije alata za LLM, filtrirane politikom (agent ne vidi što ne smije). */
  function specsFor({ policy = {}, agentId, scopes = [], maxRisk = 'high' } = {}) {
    return list()
      .filter((t) => RISK_ORDER[t.riskLevel] <= RISK_ORDER[maxRisk])
      .filter((t) => {
        const verdict = evaluate(policy, { tool: t.name, agentId, riskLevel: t.riskLevel });
        return verdict.decision !== DECISIONS.DENY;
      })
      .filter((t) => !scopes.length || t.scopes.some((s) => scopes.includes(s)) || t.scopes.length === 0)
      .map((t) => ({ name: t.name, description: t.description, params: t.params, riskLevel: t.riskLevel, requiresApproval: requiresApproval(policy, t, agentId) }));
  }

  function requiresApproval(policy, tool, agentId) {
    return evaluate(policy, { tool: tool.name, agentId, riskLevel: tool.riskLevel }).decision === DECISIONS.APPROVAL;
  }

  /**
   * Izvršava alat.
   * @param {string} name
   * @param {object} args
   * @param {object} ctx  { tenantId, agentId, runId, userId, policy, signal, approvedTools:Set, budget, dryRun }
   */
  async function execute(name, args = {}, ctx = {}) {
    const tool = tools.get(name);
    if (!tool) throw new NotFoundError('Alat', name);

    const policy = ctx.policy ?? policyResolver?.(ctx.tenantId, { agentId: ctx.agentId }) ?? {};
    const verdict = evaluate(policy, { tool: name, agentId: ctx.agentId, riskLevel: tool.riskLevel, args, tenantId: ctx.tenantId });

    const approved = ctx.approvedTools instanceof Set ? ctx.approvedTools.has(name) : Boolean(ctx.approvedTools?.[name]);
    if (verdict.decision === DECISIONS.DENY) {
      metrics?.inc('policy_denied_total', { tenant: ctx.tenantId ?? '-', tool: name, agentId: ctx.agentId ?? '-' });
      await audit?.append({
        tenantId: ctx.tenantId,
        actor: ctx.agentId ?? 'agent',
        action: 'tool_call',
        tool: name,
        args,
        decision: 'deny',
        outcome: 'blocked',
        runId: ctx.runId,
        userId: ctx.userId,
        meta: { rule: verdict.rule, reason: verdict.reason },
      });
      throw new PolicyError(verdict.reason, { tool: name, rule: verdict.rule });
    }
    if (verdict.decision === DECISIONS.APPROVAL && !approved) {
      metrics?.inc('approvals_required_total', { tenant: ctx.tenantId ?? '-', tool: name });
      await audit?.append({
        tenantId: ctx.tenantId,
        actor: ctx.agentId ?? 'agent',
        action: 'tool_call',
        tool: name,
        args,
        decision: 'require_approval',
        outcome: 'pending',
        runId: ctx.runId,
        userId: ctx.userId,
        meta: { rule: verdict.rule, reason: verdict.reason },
      });
      throw new ApprovalRequiredError(verdict.reason, { tool: name, rule: verdict.rule, riskLevel: tool.riskLevel });
    }

    if (ctx.dryRun) {
      return { tool: name, dryRun: true, wouldRun: true, riskLevel: tool.riskLevel, args: redactArgs(args) };
    }

    const budget = ctx.budget ?? createBudget({ maxWallMs: tool.timeoutMs * (tool.retries + 1) + 5000, maxSteps: tool.retries + 1 });
    const elapsed = timer();
    let attempt = 0;
    let lastErr;

    while (attempt <= tool.retries) {
      attempt += 1;
      budget.assertCanContinue({ label: `tool:${name}` });
      budget.addStep();
      // Span alata ide u trace preko tracer-a (ranije je bilo `ctx.trace.span`, što ne postoji → nijedan span alata)
      const span = ctx.tracer?.span?.(ctx.trace, `tool ${name}`, { attempt, riskLevel: tool.riskLevel });
      try {
        const result = await withTimeout(
          (signal) => tool.handler(args, { ...ctx, policy, tool, signal, logger }),
          tool.timeoutMs,
          ctx.signal,
          `${name} timeout (${tool.timeoutMs}ms)`,
        );
        const durationMs = Math.round(elapsed());
        metrics?.inc('tool_calls_total', { tenant: ctx.tenantId ?? '-', tool: name, status: 'ok' });
        metrics?.observe('tool_duration_seconds', { tool: name }, durationMs / 1000);
        span?.end({ durationMs, status: 'ok' });
        await audit?.append({
          tenantId: ctx.tenantId,
          actor: ctx.agentId ?? 'agent',
          action: 'tool_call',
          tool: name,
          args,
          decision: verdict.decision,
          outcome: 'ok',
          runId: ctx.runId,
          userId: ctx.userId,
          meta: { durationMs, attempt, resultPreview: preview(result) },
        });
        return { tool: name, riskLevel: tool.riskLevel, durationMs, attempt, result };
      } catch (err) {
        lastErr = err;
        span?.fail(err, { attempt });
        metrics?.inc('tool_calls_total', { tenant: ctx.tenantId ?? '-', tool: name, status: 'error' });
        const retryable = err?.retryable !== false && !(err instanceof PolicyError) && !(err instanceof ApprovalRequiredError) && !(err instanceof ValidationError);
        if (!retryable || attempt > tool.retries) break;
        logger?.warn?.('tool.retry', { tool: name, attempt, error: err.message });
        await sleep(Math.min(3000, 250 * 2 ** attempt), ctx.signal);
      }
    }

    metrics?.inc('tool_errors_total', { tenant: ctx.tenantId ?? '-', tool: name });
    await audit?.append({
      tenantId: ctx.tenantId,
      actor: ctx.agentId ?? 'agent',
      action: 'tool_call',
      tool: name,
      args,
      decision: verdict.decision,
      outcome: 'error',
      runId: ctx.runId,
      userId: ctx.userId,
      meta: { error: truncate(String(lastErr?.message ?? lastErr), 300), attempts: attempt },
    });
    throw lastErr instanceof Error ? lastErr : new ToolError(String(lastErr), { tool: name });
  }

  return {
    register,
    registerAll: (list2) => list2.map(register),
    get,
    list,
    specsFor,
    execute,
    size: () => tools.size,
    names: () => [...tools.keys()],
  };
}

/**
 * Izvršava handler sa tvrdim timeout-om.
 * ⚠️ Race je obavezan: alat koji ignoriše `signal` bi inače visio beskonačno.
 */
function withTimeout(fn, ms, outerSignal, message) {
  const ac = new AbortController();
  const onAbort = () => ac.abort(new Error('aborted'));
  outerSignal?.addEventListener?.('abort', onAbort, { once: true });
  let timerId;

  const guard = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      ac.abort(new Error('timeout'));
      reject(new TimeoutError(message, { timeoutMs: ms }));
    }, ms);
    ac.signal.addEventListener(
      'abort',
      () => {
        if (ac.signal.reason?.message === 'timeout') return;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      },
      { once: true },
    );
  });

  return Promise.race([Promise.resolve().then(() => fn(ac.signal)), guard]).finally(() => {
    clearTimeout(timerId);
    outerSignal?.removeEventListener?.('abort', onAbort);
  });
}

function preview(result) {
  const json = JSON.stringify(result ?? null);
  return truncate(json, 240);
}

function redactArgs(args) {
  return JSON.parse(JSON.stringify(args ?? {}, (k, v) => (/token|key|secret|password/i.test(k) ? '***' : v)));
}

export { iso };
