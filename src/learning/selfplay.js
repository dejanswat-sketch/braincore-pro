/**
 * Self-play: agent sam sebi pravi trening scenarije, rješava ih i ocjenjuje.
 *
 *   Proposer (planer) → generiše realan scenario iz domena, sa očekivanim ishodom i težinom
 *   Solver (agent domena) → rješava scenario kroz alate
 *   Judge (kritičar) → ocjenjuje rješenje (deterministički + LLM opciono)
 *
 * Rezultat:
 *   1) `learning/training-YYYY-MM.jsonl` — dataset za budući fine-tune (SFT/DPO) i za eval zlatni set
 *   2) kurikulum: ako solver padne na klasi zadataka → prijedlog poboljšanja (prompt/KB) u inbox
 *   3) metrike: prolaznost po težini, trošak po scenariju
 *
 * ⚠️ Iskreno: ovo NE trenira model. Ovo proizvodi (a) dokaze gdje agent pada i (b) dataset za fine-tune
 * koji se pokreće van ovog procesa (GPU/API). Bez tog koraka nema pravog „self-improving modela".
 */
import path from 'node:path';
import { appendJsonl, readJsonl } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { ValidationError } from '../core/errors.js';

export function createSelfPlay({ dataDir, logger, metrics, audit, catalog, runAgent, critic, helpers, rewards, improvements }) {
  const dsFile = (tenantId, d = new Date()) => path.join(dataDir, 'tenants', tenantId, 'learning', `training-${d.toISOString().slice(0, 7)}.jsonl`);

  async function proposeScenario(tenantId, { domain, difficulty, seedFailures = [], ctx }) {
    const res = await helpers.callLlm(ctx, {
      role: 'selfplay-proposer',
      temperature: 0.8,
      maxTokens: 600,
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'Ti si proposer u self-play treningu. Napravi JEDAN realan scenario za agenta u datom domenu.',
            'Vrati JSON: {"task":"konkretan zahtjev korisnika","context":"detalji","expected":"šta je dobar ishod","difficulty":1-5,"checks":["kako provjeriti"]}',
            `Težina: ${difficulty}/5. Scenario mora biti iz stvarnog posla, ne izmišljeni test.`,
            seedFailures.length ? 'Uzmi u obzir oblasti gdje je agent ranije padao (dolje navedeno) — napravi varijantu tog problema.' : '',
            seedFailures.length ? `Prethodni problemi:\n${seedFailures.map((f) => `- ${f}`).join('\n')}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
        { role: 'user', content: `DOMEN: ${domain}\nTEŽINA: ${difficulty}/5` },
      ],
    });
    const parsed = helpers.parseJson(res.text, null);
    if (!parsed?.task) throw new ValidationError('Proposer nije vratio scenario');
    return { ...parsed, difficulty: Number(parsed.difficulty ?? difficulty), costUsd: res.costUsd, usage: res.usage };
  }

  return {
    dsFile,

    /**
     * Jedan self-play ciklus.
     * @param {object} opts { domain, rounds, solverAgent, proposerAgent, judge, difficulty, seedFailures, maxCostUsd }
     */
    async run(tenantId, opts = {}) {
      const rounds = Math.max(1, Math.min(opts.rounds ?? 3, 20));
      const solverAgent = opts.solverAgent ?? 'support';
      const domain = opts.domain ?? catalog.get(solverAgent, tenantId)?.domain ?? 'support';
      const solver = catalog.get(solverAgent, tenantId);
      if (!solver) throw new ValidationError(`Nepoznat solver agent: ${solverAgent}`);

      let difficulty = Number(opts.difficulty ?? 2);
      const results = [];
      const usage = { tokensIn: 0, tokensOut: 0 };
      let costUsd = 0;
      let passes = 0;

      for (let i = 0; i < rounds; i += 1) {
        const ctx = { tenantId, agentId: solverAgent, pattern: 'selfplay', budget: opts.budget, trace: opts.trace, runId: opts.runId, signal: opts.signal };
        const scenario = await proposeScenario(tenantId, { domain, difficulty, seedFailures: opts.seedFailures ?? [], ctx });
        costUsd += scenario.costUsd ?? 0;

        const started = Date.now();
        let solution = null;
        let error = null;
        try {
          solution = await runAgent(solver, `${scenario.task}\n\nKontekst: ${scenario.context ?? ''}\n\nOčekivano: ${scenario.expected ?? ''}`, {
            ...ctx,
            pattern: 'selfplay',
            recordEpisode: false,
            options: { maxRunUsd: opts.maxPerScenarioUsd },
          });
        } catch (err) {
          error = err.message;
        }
        const durationMs = Date.now() - started;

        const review = await critic.review({
          task: scenario.task,
          output: solution?.output ?? '',
          criteria: scenario.checks ?? [],
          useLlm: opts.useLlmJudge ?? false,
          threshold: opts.threshold ?? 0.7,
          tenantId,
          ctx,
        });
        const passed = !error && review.verdict === 'accept';
        if (passed) passes += 1;

        const example = {
          id: uid('sp'),
          ts: iso(),
          tenantId,
          domain,
          difficulty: scenario.difficulty,
          scenario: { task: scenario.task, context: scenario.context ?? null, expected: scenario.expected ?? null, checks: scenario.checks ?? [] },
          solution: String(solution?.output ?? '').slice(0, 4000),
          error,
          score: review.score,
          verdict: review.verdict,
          issues: review.issues?.map((x) => x.message) ?? [],
          durationMs,
          costUsd: Number((scenario.costUsd ?? 0) + (solution?.costUsd ?? 0)).toFixed(6),
          passed,
        };
        await appendJsonl(dsFile(tenantId), example);
        results.push(example);
        usage.tokensIn += (scenario.usage?.tokensIn ?? 0) + (solution?.usage?.tokensIn ?? 0);
        usage.tokensOut += (scenario.usage?.tokensOut ?? 0) + (solution?.usage?.tokensOut ?? 0);

        // kurikulum: prolaz → teže; pad → lakše (i zabilježi klasu problema)
        difficulty = passed ? Math.min(5, difficulty + 1) : Math.max(1, difficulty - 1);
      }

      const passRate = Number((passes / rounds).toFixed(3));
      metrics?.inc('selfplay_rounds_total', { tenant: tenantId, domain, solver: solverAgent }, rounds);
      metrics?.observe('selfplay_pass_rate', { tenant: tenantId, solver: solverAgent }, passRate);
      await audit?.append({
        tenantId,
        actor: 'self-play',
        action: 'selfplay_cycle',
        args: { domain, solverAgent, rounds, passRate },
        decision: 'allow',
        outcome: 'ok',
        runId: opts.runId ?? null,
        meta: { costUsd: Number(costUsd.toFixed(6)) },
      });
      logger?.info?.('selfplay.cycle', { tenantId, domain, solverAgent, rounds, passRate, costUsd });

      // Ako solver pada na klasi zadataka → prijedlog poboljšanja (nikad automatska izmjena)
      let proposal = null;
      if (improvements && passRate < (opts.proposeBelow ?? 0.5)) {
        const failures = results.filter((r) => !r.passed);
        proposal = await improvements.createProposal(tenantId, {
          kind: 'prompt',
          target: solverAgent,
          current: solver.systemPrompt?.slice(0, 400) ?? null,
          proposed: null,
          rationale: `Self-play: prolaznost ${Math.round(passRate * 100)}% u domenu "${domain}" (${failures.length}/${rounds} padova). Prompt agenta treba doradu.`,
          evidence: failures.slice(0, 5).map((f) => ({ task: f.scenario.task, score: f.score, issues: f.issues })),
          expectedImpact: 'veća prolaznost na istoj klasi zadataka',
          riskLevel: 'medium',
          source: 'self-play',
        });
        // dataset je već zapisan — LLM predlaže novi prompt iz padova
        try {
          const improved = await helpers.callLlm(
            { tenantId, agentId: solverAgent, pattern: 'selfplay-prompt', trace: opts.trace, runId: opts.runId, signal: opts.signal },
            {
              role: 'selfplay-improver',
              temperature: 0.2,
              maxTokens: 900,
              messages: [
                { role: 'system', content: 'Ti poboljšavaš system prompt agenta na osnovu konkretnih padova. Vrati SAMO novi system prompt, bez objašnjenja.' },
                { role: 'user', content: `TRENUTNI PROMPT:\n${solver.systemPrompt}\n\nPADOVI:\n${failures.map((f) => `- ${f.scenario.task} → ocjena ${f.score}; problemi: ${f.issues.join('; ')}`).join('\n')}` },
              ],
            },
          );
          proposal.proposed = improved.text;
          await improvements.updateProposal(tenantId, proposal.id, { proposed: improved.text });
        } catch (err) {
          logger?.warn?.('selfplay.improver_failed', { error: err.message });
        }
      }

      return {
        domain,
        solverAgent,
        rounds,
        passes,
        passRate,
        finalDifficulty: difficulty,
        costUsd: Number(costUsd.toFixed(6)),
        usage,
        results: results.map((r) => ({ task: r.scenario.task, difficulty: r.difficulty, score: r.score, passed: r.passed, issues: r.issues })),
        proposalId: proposal?.id ?? null,
      };
    },

    /** Dataset za fine-tune / eval (samo uspješni primjeri, ili svi ako se traži). */
    async dataset(tenantId, { onlyPassed = true, limit = 1000 } = {}) {
      const rows = await readJsonl(dsFile(tenantId), { limit });
      const filtered = onlyPassed ? rows.filter((r) => r.passed) : rows;
      return {
        total: rows.length,
        returned: filtered.length,
        passRate: rows.length ? Number((rows.filter((r) => r.passed).length / rows.length).toFixed(3)) : null,
        examples: filtered.map((r) => ({ task: r.scenario.task, context: r.scenario.context, solution: r.solution, difficulty: r.difficulty, score: r.score })),
        note: 'Format je spreman za SFT/DPO; sam trening se pokreće van ovog procesa (GPU ili API fine-tune).',
      };
    },

    /** Kurikulum: koje težine i domene treba vježbati (na osnovu istorije). */
    async curriculum(tenantId, { limit = 500 } = {}) {
      const rows = await readJsonl(dsFile(tenantId), { limit });
      const byDifficulty = {};
      const byDomain = {};
      for (const r of rows) {
        byDifficulty[r.difficulty] = byDifficulty[r.difficulty] ?? { n: 0, passed: 0 };
        byDifficulty[r.difficulty].n += 1;
        if (r.passed) byDifficulty[r.difficulty].passed += 1;
        byDomain[r.domain] = byDomain[r.domain] ?? { n: 0, passed: 0 };
        byDomain[r.domain].n += 1;
        if (r.passed) byDomain[r.domain].passed += 1;
      }
      const rate = (v) => (v.n ? Number((v.passed / v.n).toFixed(3)) : null);
      const weak = Object.entries(byDomain).map(([domain, v]) => ({ domain, passRate: rate(v), n: v.n })).filter((x) => x.passRate !== null && x.passRate < 0.6);
      return {
        samples: rows.length,
        byDifficulty: Object.fromEntries(Object.entries(byDifficulty).map(([k, v]) => [k, { ...v, passRate: rate(v) }])),
        byDomain: Object.fromEntries(Object.entries(byDomain).map(([k, v]) => [k, { ...v, passRate: rate(v) }])),
        weakDomains: weak,
        recommended: weak.length ? `vježbaj: ${weak.map((w) => w.domain).join(', ')}` : 'nema slabih domena u uzorku',
      };
    },
  };
}
