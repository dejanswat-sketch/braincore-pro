/**
 * Pattern 1: sequential pipeline — koraci jedan za drugim, izlaz prethodnog je ulaz sljedećeg.
 * Koristi se za linearne procese: parse → extract → validate → summarize → store, onboarding, obrada dokumenta.
 *
 * config: {
 *   failFast: true,
 *   steps: [
 *     { agent: 'data',      input: 'Analiziraj: {{input}}' },
 *     { agent: 'finance',   input: 'Na osnovu analize: {{previous}} napravi fakturu.' },
 *     { tool: 'report_generate', args: { title: 'Sažetak', sections: [] } }
 *   ]
 * }
 */
import { interpolate, interpolateDeep } from '../core/config-utils.js';

export function createSequentialPattern({ runAgent, catalog, tools, helpers, logger }) {
  async function run({ input, ctx, config = {} }) {
    const cat = ctx.catalog ?? catalog;
    const steps = config.steps ?? [];
    if (!steps.length) {
      // default: jedan agent (agent iz ctx-a)
      const spec = cat.get(ctx.agentId) ?? cat.get('support');
      const res = await runAgent(spec, input, ctx);
      return { output: res.output, results: [res], usage: res.usage, costUsd: res.costUsd, approvals: res.approvals ?? [], handoffs: res.handoffs ?? [] };
    }

    const results = [];
    const outputs = [];
    let previous = typeof input === 'string' ? input : JSON.stringify(input);
    const usage = { tokensIn: 0, tokensOut: 0 };
    let costUsd = 0;
    const approvals = [];
    const handoffs = [];

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const vars = { input: typeof input === 'string' ? input : JSON.stringify(input), previous, step: i + 1, total: steps.length };

      if (step.tool) {
        const args = interpolateDeep(step.args ?? {}, vars);
        ctx.onEvent?.({ type: 'step_start', kind: 'tool', name: step.tool, index: i + 1 });
        const res = await tools.execute(step.tool, args, { ...ctx, agentId: step.agent ?? ctx.agentId });
        previous = typeof res.result === 'string' ? res.result : JSON.stringify(res.result);
        results.push({ kind: 'tool', name: step.tool, ok: true, output: previous, durationMs: res.durationMs });
        outputs.push(previous);
        ctx.onEvent?.({ type: 'step_end', kind: 'tool', name: step.tool, index: i + 1, ok: true });
        if (step.outputKey) ctx.blackboard && (ctx.blackboard[step.outputKey] = previous);
        continue;
      }

      const spec = cat.get(step.agent ?? ctx.agentId);
      if (!spec) throw new Error(`sequential: nepoznat agent "${step.agent}"`);
      const stepInput = interpolate(step.input ?? '{{previous}}', vars);
      ctx.onEvent?.({ type: 'step_start', kind: 'agent', name: spec.id, index: i + 1 });

      try {
        const res = await runAgent(spec, stepInput, { ...ctx, agentId: spec.id, pattern: 'sequential' });
        previous = res.output;
        outputs.push(previous);
        results.push({ kind: 'agent', agentId: spec.id, ok: true, output: res.output, steps: res.steps, usage: res.usage, costUsd: res.costUsd });
        usage.tokensIn += res.usage?.tokensIn ?? 0;
        usage.tokensOut += res.usage?.tokensOut ?? 0;
        costUsd += res.costUsd ?? 0;
        approvals.push(...(res.approvals ?? []));
        handoffs.push(...(res.handoffs ?? []));
        if (step.outputKey) ctx.blackboard && (ctx.blackboard[step.outputKey] = previous);
        ctx.onEvent?.({ type: 'step_end', kind: 'agent', name: spec.id, index: i + 1, ok: true });
      } catch (err) {
        results.push({ kind: 'agent', agentId: spec.id, ok: false, error: err.message, code: err.code });
        ctx.onEvent?.({ type: 'step_end', kind: 'agent', name: spec.id, index: i + 1, ok: false, error: err.message });
        logger?.warn?.('sequential.step_failed', { index: i + 1, agent: spec.id, error: err.message });
        if (config.failFast !== false) throw err;
        previous = `Korak ${i + 1} nije uspio: ${err.message}`;
        outputs.push(previous);
      }
    }

    return {
      output: outputs.at(-1) ?? '',
      results,
      usage,
      costUsd: Number(costUsd.toFixed(6)),
      approvals,
      handoffs,
      stepsCount: steps.length,
    };
  }

  return { name: 'sequential', run };
}
