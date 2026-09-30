/**
 * Pattern 5: magentic / open-ended — plan → akcija → refleksija → korekcija, dok nije dovoljno dobro.
 * Koristi se kad nema unaprijed definisanog plana: "istraži zašto je prodaja pala i predloži 3 akcije".
 *
 * config: {
 *   maxIterations: 3,
 *   threshold: 0.7,
 *   useLlmCritic: false,
 *   criteria: ['tačnost', 'konkretne brojke', 'akcioni plan']
 * }
 */
export function createMagenticPattern({ runAgent, catalog, helpers, critic, logger }) {
  async function run({ input, ctx, config = {} }) {
    const cat = ctx.catalog ?? catalog;
    const maxIterations = Math.max(1, Math.min(config.maxIterations ?? 3, 6));
    const threshold = config.threshold ?? 0.7;
    const spec = cat.get(ctx.agentId) ?? cat.get('support');
    const task = typeof input === 'string' ? input : JSON.stringify(input);

    const iterations = [];
    const usage = { tokensIn: 0, tokensOut: 0 };
    let costUsd = 0;
    const approvals = [];
    let output = '';
    let lastScore = -1;
    let stagnant = 0;

    for (let i = 0; i < maxIterations; i += 1) {
      ctx.onEvent?.({ type: 'magentic_iteration', iteration: i + 1, max: maxIterations });

      // 1) PLAN — kratak eksplicitni plan prije akcije
      let planText = '';
      try {
        const plan = await helpers.callLlm(ctx, {
          role: 'magentic-planner',
          temperature: 0.1,
          maxTokens: 400,
          messages: [
            {
              role: 'system',
              content: [
                'Ti si agent koji rješava zadatak iterativno.',
                'Napravi kratak plan u najviše 4 koraka: šta provjeriti, koje alate pozvati, kako ćeš znati da je gotovo.',
                'Bez uvoda, samo plan.',
                i > 0 ? 'Ovo je nova iteracija — ispravi ono što je prethodno ocijenjeno kao nedovoljno.' : '',
              ].join('\n'),
            },
            {
              role: 'user',
              content: i === 0 ? task : `${task}\n\nPrethodni rezultat:\n${output}\n\nProblemi iz refleksije:\n${(iterations.at(-1)?.review?.issues ?? []).map((x) => `- ${x.message}`).join('\n')}`,
            },
          ],
        });
        planText = plan.text;
        usage.tokensIn += plan.usage.tokensIn;
        usage.tokensOut += plan.usage.tokensOut;
        costUsd += plan.costUsd;
      } catch (err) {
        logger?.warn?.('magentic.plan_failed', { error: err.message });
      }

      // 2) ACT — agent izvršava sa planom u kontekstu
      const actInput = planText ? `${task}\n\nPlan:\n${planText}` : task;
      const res = await runAgent(spec, actInput, { ...ctx, agentId: spec.id, pattern: 'magentic' });
      usage.tokensIn += res.usage?.tokensIn ?? 0;
      usage.tokensOut += res.usage?.tokensOut ?? 0;
      costUsd += res.costUsd ?? 0;
      approvals.push(...(res.approvals ?? []));
      output = res.output;

      // 3) REFLECT
      const review = await critic.review({
        task,
        output,
        criteria: config.criteria ?? [],
        useLlm: config.useLlmCritic ?? false,
        threshold,
        tenantId: ctx.tenantId,
        signal: ctx.signal,
        ctx,
        model: config.criticModel,
      });
      iterations.push({ iteration: i + 1, plan: planText, output, review, costUsd: res.costUsd });
      ctx.onEvent?.({ type: 'magentic_review', iteration: i + 1, verdict: review.verdict, score: review.score, issues: review.issues.length });

      if (review.verdict === 'accept') break;
      if (review.score <= lastScore) {
        stagnant += 1;
        if (stagnant >= (config.maxStagnant ?? 2)) {
          logger?.info?.('magentic.stagnant_stop', { iteration: i + 1, score: review.score });
          break;
        }
      } else stagnant = 0;
      lastScore = review.score;
    }

    const finalReview = iterations.at(-1)?.review ?? { verdict: 'unknown', score: 0, issues: [] };

    return {
      output,
      iterations: iterations.map((it) => ({ iteration: it.iteration, plan: it.plan, score: it.review.score, verdict: it.review.verdict, issues: it.review.issues.length })),
      finalReview,
      accepted: finalReview.verdict === 'accept',
      usage,
      costUsd: Number(costUsd.toFixed(6)),
      approvals,
      handoffs: [],
    };
  }

  return { name: 'magentic', run };
}
