/**
 * Pattern 3: fan-out / fan-in — isti ulaz, više agenata paralelno, pa spajanje rezultata.
 * Koristi se za analizu iz više uglova (tehnički + poslovni + pravni), provjeru i "voting".
 *
 * config: {
 *   workers: [ { agent: 'legal', angle: 'rizici' }, { agent: 'finance', angle: 'cijena' } ],
 *   concurrency: 4,
 *   merge: 'synthesis' | 'concat' | 'vote'
 * }
 */
export function createFanoutPattern({ runAgent, catalog, helpers, logger }) {
  async function run({ input, ctx, config = {} }) {
    const cat = ctx.catalog ?? catalog;
    const workers = Array.isArray(config.workers) && config.workers.length ? config.workers : [{ agent: ctx.agentId, angle: 'general' }];
    const concurrency = Math.max(1, Math.min(config.concurrency ?? 4, 8));
    const merge = config.merge ?? (workers.length > 1 ? 'synthesis' : 'concat');

    ctx.onEvent?.({ type: 'fanout_start', count: workers.length, concurrency, merge });

    const tasks = workers.map((w, index) => async () => {
      const spec = cat.get(w.agent);
      if (!spec) return { index, agent: w.agent, ok: false, error: `nepoznat agent ${w.agent}` };
      const angle = w.angle ? `\n\nUgao analize: ${w.angle}` : '';
      ctx.onEvent?.({ type: 'worker_start', index, agent: spec.id, angle: w.angle });
      try {
        const res = await runAgent(spec, `${typeof input === 'string' ? input : JSON.stringify(input)}${angle}`, { ...ctx, agentId: spec.id, pattern: 'fanout' });
        ctx.onEvent?.({ type: 'worker_end', index, agent: spec.id, ok: true });
        return { index, agent: spec.id, angle: w.angle ?? null, ok: true, output: res.output, usage: res.usage, costUsd: res.costUsd, approvals: res.approvals ?? [], handoffs: res.handoffs ?? [] };
      } catch (err) {
        ctx.onEvent?.({ type: 'worker_end', index, agent: spec.id, ok: false, error: err.message });
        logger?.warn?.('fanout.worker_failed', { agent: spec.id, error: err.message });
        return { index, agent: spec.id, ok: false, error: err.message, code: err.code };
      }
    });

    const settled = await runWithConcurrency(tasks, concurrency);
    const ok = settled.filter((r) => r?.ok);
    const failed = settled.filter((r) => r && !r.ok);

    const usage = ok.reduce(
      (acc, r) => {
        acc.tokensIn += r.usage?.tokensIn ?? 0;
        acc.tokensOut += r.usage?.tokensOut ?? 0;
        return acc;
      },
      { tokensIn: 0, tokensOut: 0 },
    );
    let costUsd = ok.reduce((acc, r) => acc + (r.costUsd ?? 0), 0);
    const approvals = ok.flatMap((r) => r.approvals ?? []);
    const handoffs = ok.flatMap((r) => r.handoffs ?? []);

    let output = '';
    if (!ok.length) {
      output = 'Svi paralelni agenti su pali. Provjeri dozvole alata, budžet i dostupnost modela.';
    } else if (merge === 'vote') {
      const counts = new Map();
      for (const r of ok) {
        const key = String(r.output ?? '').trim().toLowerCase().slice(0, 200);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const [[winner, votes]] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const chosen = ok.find((r) => String(r.output ?? '').trim().toLowerCase().slice(0, 200) === winner);
      output = `${chosen?.output ?? ''}\n\n_(glasova: ${votes}/${ok.length})_`;
    } else if (merge === 'concat') {
      output = condenseList(ok.map((r) => `### ${r.agent}${r.angle ? ` (${r.angle})` : ''}\n${r.output}`), 6000);
    } else {
      try {
        const synth = await helpers.callLlm(ctx, {
          role: 'fanin-synthesis',
          temperature: 0.2,
          maxTokens: config.synthesisMaxTokens ?? 900,
          messages: [
            {
              role: 'system',
              content:
                'Ti si analitičar. Spoji paralelne analize u jedan odgovor: gdje se slažu, gdje se razilaze, šta je zaključak i koje su 2-3 preporuke. Ne ponavljaj sve — izvuci suštinu i navedi koji agent tvrdi šta.',
            },
            { role: 'user', content: `PITANJE/ZADATAK: ${typeof input === 'string' ? input : JSON.stringify(input)}\n\nANALIZE:\n${condenseList(ok.map((r) => `### ${r.agent}${r.angle ? ` (${r.angle})` : ''}\n${r.output}`), 7000)}` },
          ],
        });
        output = synth.text || condenseList(ok.map((r) => r.output), 4000);
        usage.tokensIn += synth.usage.tokensIn;
        usage.tokensOut += synth.usage.tokensOut;
        costUsd += synth.costUsd;
      } catch (err) {
        logger?.warn?.('fanout.synthesis_failed', { error: err.message });
        output = condenseList(ok.map((r) => `### ${r.agent}\n${r.output}`), 4000);
      }
    }

    return {
      output,
      workers: settled,
      failed: failed.map((f) => ({ agent: f.agent, error: f.error })),
      merge,
      usage,
      costUsd: Number(costUsd.toFixed(6)),
      approvals,
      handoffs,
    };
  }

  return { name: 'fanout', run };
}

/** Ograničena konkurentnost: najviše `limit` zadataka u isto vrijeme. */
export async function runWithConcurrency(tasks, limit = 4) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await tasks[index]();
      } catch (err) {
        results[index] = { ok: false, error: err?.message ?? String(err) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export function condenseList(items, max = 4000) {
  const text = items.join('\n\n');
  return text.length > max ? `${text.slice(0, max)}…[skraćeno]` : text;
}
