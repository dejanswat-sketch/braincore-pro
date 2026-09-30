/**
 * Pattern: reflection — jedan agent radi, kritičar (ili sam agent) kritikuje, pa se odgovor popravi.
 * Koristi se kad je kvalitet važniji od cijene: ponude, pravni tekst, javni odgovori, izvještaji.
 *
 * Tok: act → critique → revise → (ponovi do `maxRounds`) → vrati najbolju verziju.
 * config: { maxRounds: 2, threshold: 0.75, criteria: [...], useLlmCritic: false, keepBest: true }
 */
export function createReflectionPattern({ runAgent, catalog, helpers, critic, logger }) {
  async function run({ input, ctx, config = {} }) {
    const cat = ctx.catalog ?? catalog;
    const maxRounds = Math.max(1, Math.min(config.maxRounds ?? 2, 5));
    const threshold = config.threshold ?? 0.75;
    const spec = cat.get(ctx.agentId) ?? cat.get('support');
    const task = typeof input === 'string' ? input : JSON.stringify(input);

    const rounds = [];
    const usage = { tokensIn: 0, tokensOut: 0 };
    let costUsd = 0;
    const approvals = [];
    let best = { output: '', score: -1, round: 0 };
    let currentInput = task;

    for (let i = 0; i < maxRounds; i += 1) {
      ctx.onEvent?.({ type: 'reflection_round', round: i + 1, max: maxRounds });

      const res = await runAgent(spec, currentInput, { ...ctx, agentId: spec.id, pattern: 'reflection' });
      usage.tokensIn += res.usage?.tokensIn ?? 0;
      usage.tokensOut += res.usage?.tokensOut ?? 0;
      costUsd += res.costUsd ?? 0;
      approvals.push(...(res.approvals ?? []));

      const review = await critic.review({
        task,
        output: res.output,
        criteria: config.criteria ?? [],
        useLlm: config.useLlmCritic ?? false,
        threshold,
        tenantId: ctx.tenantId,
        ctx,
        model: config.criticModel,
      });

      rounds.push({ round: i + 1, output: res.output, score: review.score, verdict: review.verdict, issues: review.issues, suggestion: review.suggestion });
      ctx.onEvent?.({ type: 'reflection_review', round: i + 1, verdict: review.verdict, score: review.score, issues: review.issues.length });

      if (review.score > best.score) best = { output: res.output, score: review.score, round: i + 1 };
      if (review.verdict === 'accept') {
        logger?.debug?.('reflection.accepted', { round: i + 1, score: review.score });
        break;
      }
      if (i < maxRounds - 1) {
        currentInput = [
          task,
          '',
          `Prethodni odgovor je ocijenjen kao nedovoljan (ocjena ${review.score}).`,
          review.issues.length ? `Problemi:\n${review.issues.map((x) => `- ${x.message}`).join('\n')}` : '',
          review.suggestion ? `Uputstvo: ${review.suggestion}` : '',
          'Napiši POPRAVLJENU verziju odgovora, bez objašnjavanja šta si mijenjao.',
        ]
          .filter(Boolean)
          .join('\n');
      }
    }

    const final = config.keepBest === false ? rounds.at(-1) : best;
    const output = final?.output ?? '';
    const finalReview = rounds.find((r) => r.round === final?.round) ?? rounds.at(-1);

    return {
      output,
      rounds: rounds.map((r) => ({ round: r.round, score: r.score, verdict: r.verdict, issues: r.issues.length })),
      finalReview: finalReview ? { score: finalReview.score, verdict: finalReview.verdict, issues: finalReview.issues } : null,
      accepted: finalReview?.verdict === 'accept',
      improvement: rounds.length > 1 ? Number((rounds.at(-1).score - rounds[0].score).toFixed(2)) : 0,
      usage,
      costUsd: Number(costUsd.toFixed(6)),
      approvals,
      handoffs: [],
    };
  }

  return { name: 'reflection', run };
}
