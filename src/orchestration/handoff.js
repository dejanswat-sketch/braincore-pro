/**
 * Pattern 4: peer-to-peer handoff — agent predaje kontrolu specijalisti preko `handoff` alata.
 * Koristi se kad podrška treba billing, pa tehničkog specijalistu.
 *
 * Zaštita od ping-ponga: max N predaja, agent koji je već bio u lancu se ne posjećuje ponovo,
 * svaka predaja mora imati razlog.
 *
 * config: { entry: 'support', maxHandoffs: 3, includeTranscript: true }
 */
export function createHandoffPattern({ runAgent, catalog, helpers, logger }) {
  async function run({ input, ctx, config = {} }) {
    const maxHandoffs = Math.max(1, Math.min(config.maxHandoffs ?? 3, 6));
    const visited = [];
    const transcript = [];
    const usage = { tokensIn: 0, tokensOut: 0 };
    let costUsd = 0;
    const approvals = [];
    const handoffChain = [];

    let current = catalog.get(config.entry ?? ctx.agentId) ?? catalog.get('support');
    let payload = typeof input === 'string' ? input : JSON.stringify(input);
    let output = '';
    let status = 'ok';

    for (let i = 0; i <= maxHandoffs; i += 1) {
      visited.push(current.id);
      ctx.onEvent?.({ type: 'handoff_start', agent: current.id, depth: i });
      const res = await runAgent(current, payload, { ...ctx, agentId: current.id, pattern: 'handoff' });
      usage.tokensIn += res.usage?.tokensIn ?? 0;
      usage.tokensOut += res.usage?.tokensOut ?? 0;
      costUsd += res.costUsd ?? 0;
      approvals.push(...(res.approvals ?? []));
      output = res.output;
      transcript.push({ agent: current.id, output: res.output, status: res.status, costUsd: res.costUsd });

      const handoff = (res.handoffs ?? [])[0];
      if (!handoff) {
        ctx.onEvent?.({ type: 'handoff_end', agent: current.id, resolved: true });
        return {
          output,
          transcript,
          handoffChain,
          resolvedBy: current.id,
          handoffs: handoffChain.length,
          visited,
          usage,
          costUsd: Number(costUsd.toFixed(6)),
          approvals,
        };
      }

      if (i === maxHandoffs) {
        logger?.warn?.('handoff.max_depth', { visited, to: handoff.toAgent });
        output = `${output}\n\n_(Prekinuto: dostignut maksimum od ${maxHandoffs} predaja.)_`;
        status = 'max_handoffs';
        break;
      }
      if (visited.includes(handoff.toAgent)) {
        logger?.warn?.('handoff.loop_prevented', { from: current.id, to: handoff.toAgent });
        output = `${output}\n\n_(Prekinuto: agent ${handoff.toAgent} je već bio uključen — spriječena petlja.)_`;
        status = 'handoff_loop';
        break;
      }
      const next = catalog.get(handoff.toAgent);
      if (!next) {
        logger?.warn?.('handoff.unknown_agent', { to: handoff.toAgent });
        output = `${output}\n\n_(Agent ${handoff.toAgent} ne postoji.)_`;
        status = 'handoff_unknown';
        break;
      }

      handoffChain.push({ from: current.id, to: next.id, reason: handoff.reason, summary: handoff.summary });
      ctx.onEvent?.({ type: 'handoff', from: current.id, to: next.id, reason: handoff.reason });
      payload = [
        `Originalni zadatak: ${typeof input === 'string' ? input : JSON.stringify(input)}`,
        '',
        `Predao ti je agent ${current.id}. Razlog: ${handoff.reason}`,
        handoff.summary ? `Sažetak konteksta: ${handoff.summary}` : '',
        config.includeTranscript === false ? '' : `\nPrethodni odgovor agenta ${current.id}:\n${String(res.output).slice(0, 1500)}`,
        `\nTi si sada nadležan (${next.id}). Ne predaji dalje osim ako je zaista neophodno.`,
      ]
        .filter(Boolean)
        .join('\n');
      current = next;
    }

    return {
      output,
      transcript,
      handoffChain,
      resolvedBy: null,
      status,
      handoffs: handoffChain.length,
      visited,
      usage,
      costUsd: Number(costUsd.toFixed(6)),
      approvals,
    };
  }

  return { name: 'handoff', run };
}
