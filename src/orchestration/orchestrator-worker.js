/**
 * Pattern 2: orchestrator-worker — planer razbija zadatak, worker agenti ga izvršavaju, orchestrator sintetiše.
 * Koristi se za kompleksne zadatke: "pripremi ponudu", "obradi ovaj mejl do kraja", "istraži i predloži".
 *
 * config: {
 *   maxWorkers: 5,
 *   parallel: false,
 *   workers: [ { agent: 'sales', goal: '...' } ]   // ako je zadato, planer (LLM) se preskače
 * }
 */
import { condenseList, runWithConcurrency } from './fanout.js';

export function createOrchestratorWorkerPattern({ runAgent, catalog, helpers, logger, config: robotConfig }) {
  async function makePlan(input, ctx, cfg) {
    if (Array.isArray(cfg.workers) && cfg.workers.length) return { goal: String(input), subtasks: cfg.workers, source: 'config' };

    const maxWorkers = cfg.maxWorkers ?? 5;
    const table = catalog
      .routingTable()
      .map((a) => `- ${a.id} (${a.domain}): ${a.description}`)
      .join('\n');
    try {
      const res = await helpers.callLlm(ctx, {
        role: 'planner',
        temperature: 0,
        maxTokens: 700,
        responseFormat: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'Ti si planer. Razbij zadatak na najviše ' + maxWorkers + ' podzadataka.',
              'Vrati JSON: {"goal":"...","subtasks":[{"agent":"<id sa spiska>","goal":"konkretan zadatak"}]}',
              'Pravila: koristi SAMO agente sa spiska; svaki podzadatak mora biti samostalan i provjerljiv; ne izmišljaj nove agente.',
              '',
              'Agenti:',
              table,
            ].join('\n'),
          },
          { role: 'user', content: String(input).slice(0, 4000) },
        ],
      });
      const parsed = helpers.parseJson(res.text, null);
      const subtasks = (parsed?.subtasks ?? [])
        .filter((s) => s?.goal && catalog.has(s.agent))
        .slice(0, maxWorkers)
        .map((s) => ({ agent: s.agent, goal: s.goal }));
      if (subtasks.length) return { goal: parsed?.goal ?? String(input), subtasks, source: 'llm' };
    } catch (err) {
      logger?.warn?.('orchestrator.plan_failed', { error: err.message });
    }
    return { goal: String(input), subtasks: [{ agent: ctx.agentId ?? 'support', goal: String(input) }], source: 'fallback' };
  }

  async function run({ input, ctx, config = {} }) {
    const plan = await makePlan(input, ctx, config);
    ctx.onEvent?.({ type: 'plan', goal: plan.goal, subtasks: plan.subtasks, source: plan.source });

    const workers = [];
    const usage = { tokensIn: 0, tokensOut: 0 };
    let costUsd = 0;
    const approvals = [];
    const handoffs = [];

    const delegate = async (sub, index) => {
      const spec = catalog.get(sub.agent);
      if (!spec) return { index, agent: sub.agent, ok: false, error: `nepoznat agent ${sub.agent}` };
      ctx.onEvent?.({ type: 'worker_start', index, agent: spec.id, goal: sub.goal });
      try {
        const res = await runAgent(spec, sub.goal, { ...ctx, agentId: spec.id, pattern: 'orchestrator-worker' });
        ctx.onEvent?.({ type: 'worker_end', index, agent: spec.id, ok: true, costUsd: res.costUsd });
        approvals.push(...(res.approvals ?? []));
        handoffs.push(...(res.handoffs ?? []));
        return { index, agent: spec.id, goal: sub.goal, ok: true, output: res.output, status: res.status, usage: res.usage, costUsd: res.costUsd };
      } catch (err) {
        ctx.onEvent?.({ type: 'worker_end', index, agent: spec.id, ok: false, error: err.message });
        logger?.warn?.('orchestrator.worker_failed', { agent: spec.id, error: err.message });
        return { index, agent: spec.id, goal: sub.goal, ok: false, error: err.message, code: err.code };
      }
    };

    const results = config.parallel
      ? await runWithConcurrency(plan.subtasks.map((s, i) => () => delegate(s, i)), config.concurrency ?? 4)
      : await (async () => {
          const out = [];
          for (let i = 0; i < plan.subtasks.length; i += 1) out.push(await delegate(plan.subtasks[i], i));
          return out;
        })();

    for (const r of results) {
      if (!r.ok) continue;
      workers.push(r);
      usage.tokensIn += r.usage?.tokensIn ?? 0;
      usage.tokensOut += r.usage?.tokensOut ?? 0;
      costUsd += r.costUsd ?? 0;
    }

    // Sinteza: jedan finalni odgovor iz svih rezultata
    let output = '';
    if (workers.length === 1 && config.synthesize !== true) {
      output = workers[0].output;
    } else if (workers.length) {
      try {
        const synth = await helpers.callLlm(ctx, {
          role: 'synthesizer',
          temperature: 0.2,
          maxTokens: config.synthesisMaxTokens ?? 900,
          messages: [
            {
              role: 'system',
              content:
                'Ti si orchestrator. Spoji rezultate podzadataka u JEDAN jasan odgovor za korisnika. Bez ponavljanja, bez nabrajanja procesa. Ako neki podzadatak nije uspio, navedi to kratko i predloži sljedeći korak.',
            },
            {
              role: 'user',
              content: `ZADATAK: ${plan.goal}\n\nREZULTATI:\n${condenseList(workers.map((w) => `### ${w.agent} — ${w.goal}\n${w.output}`), 6000)}`,
            },
          ],
        });
        output = synth.text || condenseList(workers.map((w) => w.output), 4000);
        usage.tokensIn += synth.usage.tokensIn;
        usage.tokensOut += synth.usage.tokensOut;
        costUsd += synth.costUsd;
      } catch (err) {
        logger?.warn?.('orchestrator.synthesis_failed', { error: err.message });
        output = condenseList(workers.map((w) => `### ${w.agent}\n${w.output}`), 4000);
      }
    } else {
      output = 'Nijedan podzadatak nije uspio. Provjeri dozvole alata i budžet.';
    }

    return {
      output,
      plan,
      workers: results,
      workersOk: workers.length,
      usage,
      costUsd: Number(costUsd.toFixed(6)),
      approvals,
      handoffs,
    };
  }

  return { name: 'orchestrator-worker', run, makePlan };
}
