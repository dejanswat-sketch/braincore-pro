/**
 * AI organizacija: tim agenata sa ulogama, KPI-jevima, budžetima i pregovaranjem.
 *
 * Org chart je PODATAK (`config/company.json`), ne kod:
 *   { roles: [ { id:'ceo', agentId:'decider', reportsTo:null, mandate:'...', kpis:[], budgetUsd: 200 },
 *               { id:'cro', agentId:'sales', reportsTo:'ceo', ... }, ... ] }
 *
 * Ciklus (mjesečno/kvartalno):
 *   1) CEO alocira ciljeve na uloge (top-down)
 *   2) svaka uloga predlaže plan za svoj dio (bottom-up)
 *   3) CFO vs CRO pregovaraju o budžetu (strukturisano, max N rundi)
 *   4) odluka se primjenjuje SAMO ako je autonomija dozvoljava; inače ide u inbox za odobrenje
 *
 * Stanje: data/tenants/<id>/org/cycles.jsonl
 */
import path from 'node:path';
import { appendJsonl, readJsonl } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { ValidationError, NotFoundError } from '../core/errors.js';

export function createCompany({ config = {}, dataDir, logger, metrics, audit, catalog, goals, rewards, controlPlane, autonomy, improvements, helpers, cost }) {
  const roles = config.roles ?? [];
  const cycleFile = (tenantId, d = new Date()) => path.join(dataDir, 'tenants', tenantId, 'org', `cycles-${d.toISOString().slice(0, 7)}.jsonl`);

  const roleById = (id) => roles.find((r) => r.id === id) ?? null;

  return {
    roles,
    roleById,

    /** Org chart sa trenutnim stanjem: ciljevi, nagrada, potrošnja, budžet. */
    async chart(tenantId) {
      const [goalList, rewardAgg] = await Promise.all([goals ? goals.list(tenantId) : [], rewards ? rewards.aggregate(tenantId, { groupBy: 'agent' }) : {}]);
      const spend = cost ? await cost.summary(tenantId) : null;
      return {
        tenantId,
        roles: roles.map((r) => {
          const owned = goalList.filter((g) => g.owner === r.id || g.owner === r.agentId);
          const agentSpend = spend?.byAgent?.[r.agentId] ?? 0;
          return {
            ...r,
            reportsTo: r.reportsTo ?? null,
            goals: owned.map((g) => ({ id: g.id, title: g.title, status: g.status, pct: g.progressPct })),
            goalsAtRisk: owned.filter((g) => ['at_risk', 'off_track', 'missed'].includes(g.status)).length,
            avgReward: rewardAgg[r.agentId]?.avgReward ?? null,
            samples: rewardAgg[r.agentId]?.n ?? 0,
            spendUsd: Number(agentSpend.toFixed(6)),
            budgetUsd: r.budgetUsd ?? null,
            budgetUsedPct: r.budgetUsd ? Number(((agentSpend / r.budgetUsd) * 100).toFixed(1)) : null,
            autonomy: autonomy?.levelOf(tenantId, r.agentId) ?? null,
          };
        }),
      };
    },

    /**
     * Strukturisano pregovaranje između dvije uloge (npr. CFO vs CRO o budžetu).
     * Svaka strana ima mandate i granice; sudija (CEO) presuđuje ako nema dogovora.
     */
    async negotiate(tenantId, { topic, between = [], maxRounds = 3, context = {} } = {}) {
      const [aId, bId] = between;
      const a = roleById(aId);
      const b = roleById(bId);
      if (!a || !b) throw new ValidationError(`Pregovor traži dvije poznate uloge (dobijeno: ${between.join(', ')})`);

      const offers = [];
      let lastOffer = null;
      for (let round = 1; round <= maxRounds; round += 1) {
        const speaker = round % 2 === 1 ? a : b;
        const responder = round % 2 === 1 ? b : a;
        const ctx = { tenantId, agentId: speaker.agentId, pattern: 'org-negotiation', trace: context.trace, runId: context.runId, signal: context.signal };
        const res = await helpers.callLlm(ctx, {
          role: `org-negotiation-${speaker.id}`,
          temperature: 0.3,
          maxTokens: 400,
          responseFormat: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: [
                `Ti si ${speaker.title ?? speaker.id} u firmi. Mandat: ${speaker.mandate ?? 'vodi svoju funkciju'}.`,
                `KPI-jevi: ${(speaker.kpis ?? []).join('; ')}.`,
                speaker.budgetUsd ? `Tvoj budžet: ${speaker.budgetUsd} USD.` : '',
                `Pregovaraš sa ${responder.title ?? responder.id} (mandat: ${responder.mandate ?? '-'}).`,
                'Vrati JSON: {"offer":{"amountUsd":0,"terms":"..."},"reasoning":"2-3 rečenice","accept":false}',
                'Ako je prethodna ponuda prihvatljiva, stavi "accept": true i ponovi uslove. Ne prelazi svoj budžet.',
              ]
                .filter(Boolean)
                .join('\n'),
            },
            {
              role: 'user',
              content: `TEMA: ${topic}\nKONTEKST: ${JSON.stringify(context)}\nPRETHODNA PONUDA: ${lastOffer ? JSON.stringify(lastOffer) : '(nema — ti otvaraš)'}`,
            },
          ],
        });
        const parsed = helpers.parseJson(res.text, null) ?? { offer: null, reasoning: res.text };
        const entry = { round, role: speaker.id, agentId: speaker.agentId, ...parsed, costUsd: res.costUsd };
        offers.push(entry);
        lastOffer = parsed.offer ?? lastOffer;
        if (parsed.accept) {
          const record = { id: uid('neg'), ts: iso(), tenantId, topic, between: [a.id, b.id], rounds: round, status: 'agreed', outcome: lastOffer, transcript: offers, context };
          await appendJsonl(cycleFile(tenantId), { type: 'negotiation', ...record });
          metrics?.inc('org_negotiations_total', { tenant: tenantId, status: 'agreed' });
          await audit?.append({ tenantId, actor: 'org', action: 'org_negotiation', args: { topic, between: [a.id, b.id], rounds: round }, decision: 'allow', outcome: 'agreed', meta: { outcome: lastOffer } });
          return record;
        }
      }

      // nema dogovora → eskalacija na CEO (ili čovjeka)
      const escalationProposal = improvements
        ? await improvements.createProposal(tenantId, {
            kind: 'action',
            target: (roleById('ceo') ?? a).agentId,
            proposed: { input: `Presudi u pregovoru "${topic}" između ${a.id} i ${b.id}. Zadnja ponuda: ${JSON.stringify(lastOffer)}` },
            current: null,
            rationale: `Pregovor "${topic}" nije završen u ${maxRounds} rundi`,
            evidence: offers.map((o) => ({ round: o.round, role: o.role, amountUsd: o.offer?.amountUsd ?? null })),
            expectedImpact: 'odblokirati odluku o budžetu',
            riskLevel: 'medium',
            source: 'org-negotiation',
          })
        : null;

      const record = { id: uid('neg'), ts: iso(), tenantId, topic, between: [a.id, b.id], rounds: maxRounds, status: 'escalated', outcome: lastOffer, transcript: offers, proposalId: escalationProposal?.id ?? null, context };
      await appendJsonl(cycleFile(tenantId), { type: 'negotiation', ...record });
      metrics?.inc('org_negotiations_total', { tenant: tenantId, status: 'escalated' });
      await audit?.append({ tenantId, actor: 'org', action: 'org_negotiation', args: { topic, between: [a.id, b.id], rounds: maxRounds }, decision: 'require_approval', outcome: 'escalated', meta: { proposalId: escalationProposal?.id ?? null } });
      return record;
    },

    /**
     * Ciklus planiranja: alokacija ciljeva → planovi uloga → pregovor o budžetu.
     * Ne izvršava ništa samo: predlaže i (uz autonomiju L3+) zakazuje poslove iz plana.
     */
    async cycle(tenantId, { period = 'month', topic = 'budžet za sljedeći period', context = {} } = {}) {
      const chart = await this.chart(tenantId);
      const portfolio = goals ? await goals.portfolio(tenantId) : { goals: [], atRisk: [] };
      const ctx = { tenantId, agentId: roleById('ceo')?.agentId, pattern: 'org-cycle', trace: context.trace, runId: context.runId, signal: context.signal };

      const res = await helpers.callLlm(ctx, {
        role: 'org-ceo',
        temperature: 0.2,
        maxTokens: 900,
        responseFormat: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'Ti si CEO AI firme. Napravi plan ciklusa i alociraj ciljeve na uloge.',
              'Vrati JSON: {"priorities":["..."],"allocation":[{"role":"cro","goals":["..."],"budgetUsd":0}],"risks":["..."],"decisions_needed":["..."]}',
              `Uloge: ${roles.map((r) => `${r.id}(${r.agentId})`).join(', ')}`,
              'Ne dodjeljuj više budžeta nego što uloga ima, osim ako to izričito obrazložiš.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `PERIOD: ${period}\nCILJEVI:\n${portfolio.goals.map((g) => `- ${g.title}: ${g.progressPct}% (${g.status}), rok ${g.deadline}, vlasnik ${g.owner}`).join('\n') || '(nema)'}\nSTANJE ULOGA:\n${chart.roles.map((r) => `- ${r.id}: nagrada ${r.avgReward ?? '-'}, budžet iskorišten ${r.budgetUsedPct ?? '-'}%, ciljeva u riziku ${r.goalsAtRisk}`).join('\n')}`,
          },
        ],
      });
      const plan = helpers.parseJson(res.text, null) ?? { priorities: [], allocation: [], risks: [], decisions_needed: [] };

      // pregovor o budžetu: CFO štiti maržu, CRO traži rast
      let negotiation = null;
      if (roleById('cfo') && roleById('cro')) {
        negotiation = await this.negotiate(tenantId, {
          topic,
          between: ['cfo', 'cro'],
          maxRounds: context.maxRounds ?? 3,
          context: { period, plan: plan.allocation, margin: context.margin ?? 0.7 },
        });
      }

      const record = {
        id: uid('cycle'),
        ts: iso(),
        tenantId,
        period,
        type: 'org_cycle',
        plan,
        negotiation: negotiation ? { id: negotiation.id, status: negotiation.status, outcome: negotiation.outcome, rounds: negotiation.rounds } : null,
        chartAtCycle: chart.roles.map((r) => ({ role: r.id, agentId: r.agentId, avgReward: r.avgReward, budgetUsedPct: r.budgetUsedPct })),
        costUsd: Number(((res.costUsd ?? 0) + (negotiation?.transcript ?? []).reduce((s, t) => s + (t.costUsd ?? 0), 0)).toFixed(6)),
      };
      await appendJsonl(cycleFile(tenantId), record);
      metrics?.inc('org_cycles_total', { tenant: tenantId, period });
      await audit?.append({ tenantId, actor: 'ceo', action: 'org_cycle', args: { period, priorities: plan.priorities?.length ?? 0, allocations: plan.allocation?.length ?? 0 }, decision: 'allow', outcome: 'ok', meta: { negotiation: record.negotiation } });
      logger?.info?.('org.cycle', { tenantId, period, priorities: plan.priorities?.length ?? 0, negotiation: record.negotiation?.status });
      return record;
    },

    async history(tenantId, { limit = 20 } = {}) {
      const rows = await readJsonl(cycleFile(tenantId), { limit: limit * 3, tail: true });
      return rows.slice(-limit).reverse();
    },

    /** KPI tabla: ko ispunjava svoje KPI-jeve (grubo, iz ciljeva i nagrada). */
    async kpis(tenantId) {
      const chart = await this.chart(tenantId);
      return {
        tenantId,
        roles: chart.roles.map((r) => ({
          role: r.id,
          agentId: r.agentId,
          kpis: r.kpis ?? [],
          measured: {
            goalsOwned: r.goals.length,
            goalsAtRisk: r.goalsAtRisk,
            avgReward: r.avgReward,
            budgetUsedPct: r.budgetUsedPct,
          },
        })),
      };
    },
  };
}
