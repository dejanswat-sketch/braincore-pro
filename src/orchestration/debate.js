/**
 * Pattern: debate — agenti zauzmu stavove, raspravljaju N rundi, pa sudija donosi odluku.
 * Koristi se za odluke sa trade-off-ima: "da li uvesti ovu funkciju", "koji paket preporučiti",
 * "isplati li se ovaj ugovor". Smanjuje jednostranost jednog modela.
 *
 * config: {
 *   rounds: 2,
 *   judge: 'critic',                     // agent koji presuđuje (default: critic ako postoji, inače prvi debater)
 *   debaters: [ { agent: 'finance', stance: 'za' }, { agent: 'legal', stance: 'protiv' } ]
 * }
 */
export function createDebatePattern({ runAgent, catalog, helpers, logger }) {
  async function run({ input, ctx, config = {} }) {
    const task = typeof input === 'string' ? input : JSON.stringify(input);
    const rounds = Math.max(1, Math.min(config.rounds ?? 2, 4));
    const debaters = (config.debaters ?? []).filter((d) => catalog.get(d.agent));
    if (debaters.length < 2) {
      // nema dovoljno debatera → ponašaj se kao reflection/agent (bez pada)
      logger?.warn?.('debate.not_enough_debaters', { count: debaters.length });
      const spec = catalog.get(ctx.agentId) ?? catalog.get('support');
      const res = await runAgent(spec, task, { ...ctx, agentId: spec.id, pattern: 'debate' });
      return { output: res.output, skipped: 'nedovoljno debatera (min 2)', usage: res.usage, costUsd: res.costUsd, approvals: res.approvals ?? [], handoffs: [], rounds: [] };
    }

    const usage = { tokensIn: 0, tokensOut: 0 };
    let costUsd = 0;
    const approvals = [];
    const transcript = []; // {round, agent, stance, text}
    let previousRound = '';

    for (let r = 1; r <= rounds; r += 1) {
      ctx.onEvent?.({ type: 'debate_round', round: r, max: rounds });
      const current = [];
      for (const d of debaters) {
        const spec = catalog.get(d.agent);
        const prompt = [
          `TEMA: ${task}`,
          '',
          `Ti zastupaš stav: ${d.stance ?? 'neutralno'}.`,
          r === 1
            ? 'Iznesi svoje argumente (3-5 tačaka), sa brojkama i rizicima. Kratko i konkretno.'
            : `Ovo je runda ${r}. Prethodne argumente drugih strana imaš ispod. Odgovori na najjači protivargument i dopuni svoj stav. Ako te je druga strana uvjerila u nečemu, priznaj to eksplicitno.\n\nARGUMENTI PROTIVNIKA:\n${previousRound}`,
          'Ne ponavljaj opšte fraze. Na kraju napiši jednu rečenicu: "Moj zaključak: ...".',
        ].join('\n');

        ctx.onEvent?.({ type: 'debater_start', round: r, agent: spec.id, stance: d.stance });
        const res = await runAgent(spec, prompt, { ...ctx, agentId: spec.id, pattern: 'debate' });
        usage.tokensIn += res.usage?.tokensIn ?? 0;
        usage.tokensOut += res.usage?.tokensOut ?? 0;
        costUsd += res.costUsd ?? 0;
        approvals.push(...(res.approvals ?? []));
        transcript.push({ round: r, agent: spec.id, stance: d.stance ?? null, text: res.output });
        current.push(`### ${spec.id} (${d.stance ?? 'neutralno'})\n${res.output}`);
      }
      previousRound = current.join('\n\n');
    }

    // Sudija: sintetiše odluku (i, ako je LLM, kroz helpers → trošak je naplaćen)
    const judgeSpec = catalog.get(config.judge ?? 'critic');
    let verdict = '';
    try {
      const synth = await helpers.callLlm(ctx, {
        role: 'debate-judge',
        temperature: 0.1,
        maxTokens: config.judgeMaxTokens ?? 900,
        messages: [
          {
            role: 'system',
            content: [
              'Ti si neutralni sudija u raspravi. Odluči na osnovu argumenata, ne na osnovu toga ko je duže pisao.',
              'Vrati: 1) ODLUKA (jedna rečenica) 2) obrazloženje (3-4 tačke) 3) šta bi promijenilo odluku 4) sljedeći korak sa rokom.',
              'Ako su argumenti izjednačeni, reci to eksplicitno i navedi uslov pod kojim bi jedna strana pobijedila.',
            ].join('\n'),
          },
          { role: 'user', content: `TEMA: ${task}\n\nRASPRAVA (${rounds} runde):\n${previousRound.slice(0, 9000)}` },
        ],
      });
      verdict = synth.text;
      usage.tokensIn += synth.usage.tokensIn;
      usage.tokensOut += synth.usage.tokensOut;
      costUsd += synth.costUsd;
    } catch (err) {
      logger?.warn?.('debate.judge_failed', { error: err.message });
      verdict = `Sudija nije dostupan. Argumenti strana:\n\n${previousRound}`;
    }

    return {
      output: verdict,
      rounds: rounds,
      debaters: debaters.map((d) => ({ agent: d.agent, stance: d.stance })),
      transcript: transcript.map((t) => ({ round: t.round, agent: t.agent, stance: t.stance, chars: t.text.length })),
      positions: Object.fromEntries(debaters.map((d) => [d.agent, transcript.filter((t) => t.agent === d.agent && t.round === rounds).at(-1)?.text ?? ''])),
      judge: judgeSpec?.id ?? 'helpers',
      usage,
      costUsd: Number(costUsd.toFixed(6)),
      approvals,
      handoffs: [],
    };
  }

  return { name: 'debate', run };
}
