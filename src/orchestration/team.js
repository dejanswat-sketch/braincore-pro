/**
 * Pattern: team — specijalistički tim sa jasnim ulogama (planing → research → extraction → validation →
 * decision → execution → reflection), na kraju team-lead sinteza.
 *
 * Koristi se za zadatke gdje jedan agent nije dovoljan: "istraži tržište i predloži ponudu",
 * "obradi ovaj zahtjev od početka do kraja", "pripremi odluku sa provjerama".
 *
 * config: {
 *   skip: ['research'],                    // preskoči uloge koje nisu potrebne
 *   stages: [ { role, agent, input } ],    // potpuno custom tim (opciono)
 *   maxStageUsd: 0.2
 * }
 */
import { interpolateDeep } from '../core/config-utils.js';

export const DEFAULT_STAGES = [
  { role: 'plan', agent: 'planner', input: 'Napravi plan rješavanja zadatka (koraci, redoslijed, rizici).\n\nZADATAK:\n{{input}}' },
  { role: 'research', agent: 'researcher', input: 'Prikupi činjenice i izvore potrebne za zadatak.\n\nZADATAK:\n{{input}}\n\nPLAN:\n{{plan}}' },
  { role: 'extract', agent: 'extractor', input: 'Izvuci strukturirane podatke (ključ: vrijednost) iz materijala.\n\nZADATAK:\n{{input}}\n\nMATERIJAL:\n{{research}}' },
  { role: 'validate', agent: 'validator', input: 'Provjeri tačnost i konzistentnost izvučenih podataka. Označi šta ne možeš potvrditi.\n\nPODACI:\n{{extract}}' },
  { role: 'decide', agent: 'decider', input: 'Donesi odluku po pravilima i obrazloži je u 3 tačke. Ako nema dovoljno podataka, reci šta fali.\n\nZADATAK:\n{{input}}\n\nPODACI:\n{{extract}}\n\nPROVJERA:\n{{validate}}' },
  { role: 'execute', agent: 'executor', input: 'Izvrši ono što odluka nalaže, koristeći alate. Ako akcija traži odobrenje, jasno to navedi.\n\nODLUKA:\n{{decide}}' },
  { role: 'reflect', agent: 'reflector', input: 'Ocijeni ishod: šta je dobro, šta je rizično, šta bi sljedeći put trebalo drugačije.\n\nISHOD:\n{{execute}}', optional: true },
];

export function createTeamPattern({ runAgent, catalog, helpers, logger }) {
  async function run({ input, ctx, config = {} }) {
    const cat = ctx.catalog ?? catalog;
    const task = typeof input === 'string' ? input : JSON.stringify(input);
    const stages = (config.stages ?? DEFAULT_STAGES).filter((s) => !(config.skip ?? []).includes(s.role));
    const available = stages.filter((s) => cat.get(s.agent));
    const missing = stages.filter((s) => !cat.get(s.agent)).map((s) => s.agent);

    ctx.onEvent?.({ type: 'team_start', stages: available.map((s) => `${s.role}:${s.agent}`), missing });

    const results = [];
    const blackboard = { input: task, ...(ctx.blackboard ?? {}) };
    const usage = { tokensIn: 0, tokensOut: 0 };
    let costUsd = 0;
    const approvals = [];
    const handoffs = [];
    const maxStageUsd = config.maxStageUsd;

    for (const stage of available) {
      const spec = cat.get(stage.agent);
      const vars = { ...blackboard, previous: results.at(-1)?.output ?? task };
      const stageInput = typeof stage.input === 'string' ? interpolateDeep(stage.input, vars) : stage.input ?? task;

      ctx.onEvent?.({ type: 'team_stage_start', role: stage.role, agent: spec.id });
      try {
        const res = await runAgent(spec, stageInput, {
          ...ctx,
          agentId: spec.id,
          pattern: 'team',
          blackboard,
          options: { ...(ctx.options ?? {}), maxRunUsd: maxStageUsd ?? ctx.options?.maxRunUsd },
        });
        blackboard[stage.role] = res.output;
        usage.tokensIn += res.usage?.tokensIn ?? 0;
        usage.tokensOut += res.usage?.tokensOut ?? 0;
        costUsd += res.costUsd ?? 0;
        approvals.push(...(res.approvals ?? []));
        handoffs.push(...(res.handoffs ?? []));
        results.push({ role: stage.role, agent: spec.id, ok: true, output: res.output, status: res.status, costUsd: res.costUsd, chars: res.output.length });
        ctx.onEvent?.({ type: 'team_stage_end', role: stage.role, agent: spec.id, ok: true });
      } catch (err) {
        results.push({ role: stage.role, agent: spec.id, ok: false, error: err.message, code: err.code });
        ctx.onEvent?.({ type: 'team_stage_end', role: stage.role, agent: spec.id, ok: false, error: err.message });
        logger?.warn?.('team.stage_failed', { role: stage.role, agent: spec.id, error: err.message });
        if (stage.optional) {
          blackboard[stage.role] = '';
          continue;
        }
        if (config.failFast !== false) throw err;
        blackboard[stage.role] = `Korak ${stage.role} nije uspio: ${err.message}`;
      }
    }

    // Team-lead sinteza: jedan odgovor iz svega
    let output = results.filter((r) => r.ok).at(-1)?.output ?? '';
    if (config.synthesize !== false && results.some((r) => r.ok)) {
      try {
        const synth = await helpers.callLlm(ctx, {
          role: 'team-lead',
          temperature: 0.2,
          maxTokens: config.synthesisMaxTokens ?? 900,
          messages: [
            {
              role: 'system',
              content: [
                'Ti si vođa tima. Od rezultata specijalista napravi JEDAN odgovor za korisnika.',
                'Ne opisuj proces po koracima. Daj: zaključak, ključne činjenice, odluku/akciju i šta ostaje otvoreno.',
                'Ako je neki korak pao ili nešto nije potvrđeno, reci to jasno u jednoj rečenici.',
              ].join('\n'),
            },
            {
              role: 'user',
              content: `ZADATAK: ${task}\n\nREZULTATI TIMA:\n${results
                .filter((r) => r.ok)
                .map((r) => `### ${r.role} (${r.agent})\n${r.output}`)
                .join('\n\n')
                .slice(0, 9000)}`,
            },
          ],
        });
        output = synth.text || output;
        usage.tokensIn += synth.usage.tokensIn;
        usage.tokensOut += synth.usage.tokensOut;
        costUsd += synth.costUsd;
      } catch (err) {
        logger?.warn?.('team.synthesis_failed', { error: err.message });
      }
    }

    return {
      output,
      stages: results.map((r) => ({ role: r.role, agent: r.agent, ok: r.ok, status: r.status ?? null, chars: r.chars ?? 0, error: r.error ?? null })),
      missingAgents: missing,
      blackboardKeys: Object.keys(blackboard),
      usage,
      costUsd: Number(costUsd.toFixed(6)),
      approvals,
      handoffs,
    };
  }

  return { name: 'team', run };
}
