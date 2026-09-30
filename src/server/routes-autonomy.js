/**
 * Rute autonomnog nivoa (v0.3):
 *   - javne A2A rute: /.well-known/agent.json, /a2a/tasks, /a2a/negotiations (+ SSE)
 *   - admin rute: ciljevi, watcheri, prijedlozi poboljšanja, eksperimenti, self-play, RSI,
 *     organizacija (org chart, ciklus, pregovori), autonomija, poravnanja
 *
 * Admin rute traže rolu `admin`; javne A2A rute se autentikuju isto kao i ostale (API ključ tenanta).
 */
import { ValidationError, NotFoundError } from '../core/errors.js';
import { openSse, sseSink } from './stream.js';
import { buildAgentCard } from '../a2a/card.js';

export function createAutonomyRoutes({ robot, config, tenants, logger, metrics }) {
  const need = (name) => {
    if (!robot[name]) throw new NotFoundError(name, 'nije inicijalizovan');
    return robot[name];
  };

  return [
    // ───────────────────────── A2A (javno) ─────────────────────────
    {
      method: 'GET',
      path: '/.well-known/agent.json',
      handler: async ({ tenantId }) => buildAgentCard({ robot, tenantId, baseUrl: config.env.publicUrl }),
    },
    {
      method: 'GET',
      path: '/a2a/card',
      handler: async ({ tenantId }) => buildAgentCard({ robot, tenantId, baseUrl: config.env.publicUrl }),
    },
    {
      method: 'POST',
      path: '/a2a/tasks',
      requiredRole: 'run',
      handler: async ({ body, tenantId, auth }) => {
        const a2a = need('a2a');
        const task = await a2a.send({
          tenantId,
          message: body.message ?? body.input,
          skillId: body.skillId ?? body.agentId ?? body.params?.agentId ?? null,
          sessionId: body.sessionId ?? null,
          fromAgent: body.fromAgent ?? auth.keyId ?? 'external',
          params: body.params ?? {},
          wait: body.wait === true,
        });
        const { promise, ...clean } = task; // promise se ne serijalizuje
        void promise;
        return clean;
      },
    },
    {
      method: 'GET',
      path: '/a2a/tasks',
      requiredRole: 'read',
      handler: async ({ tenantId, query }) => ({ tasks: await need('a2a').list(tenantId, { state: query.state, limit: Number(query.limit ?? 50) }) }),
    },
    {
      method: 'GET',
      path: '/a2a/tasks/:taskId',
      requiredRole: 'read',
      handler: async ({ tenantId, params }) => {
        const task = await need('a2a').get(tenantId, params.taskId);
        const { promise, ...clean } = task;
        void promise;
        return clean;
      },
    },
    {
      method: 'POST',
      path: '/a2a/tasks/:taskId/cancel',
      requiredRole: 'run',
      handler: async ({ tenantId, params }) => need('a2a').cancel(tenantId, params.taskId),
    },
    {
      method: 'POST',
      path: '/a2a/tasks/:taskId/resume',
      requiredRole: 'approve',
      handler: async ({ tenantId, params, body, auth }) =>
        need('a2a').resume(tenantId, params.taskId, { approve: body?.approve !== false, approvedTools: body?.approvedTools ?? [], by: body?.by ?? auth.keyId ?? 'human' }),
    },
    {
      method: 'GET',
      path: '/a2a/tasks/:taskId/events',
      requiredRole: 'read',
      handler: async ({ req, res, tenantId, params }) => {
        const task = await need('a2a').get(tenantId, params.taskId);
        const sse = openSse(res);
        sse.send('state', { taskId: task.id, state: task.state, output: task.output, error: task.error ?? null });
        if (['completed', 'failed', 'cancelled'].includes(task.state)) {
          sse.close();
          return;
        }
        const off = robot.bus.on(`a2a.task.${task.id}`, sseSink(sse));
        req.on('close', () => {
          off();
          sse.close();
        });
      },
    },
    {
      method: 'POST',
      path: '/a2a/negotiations',
      requiredRole: 'run',
      handler: async ({ body, tenantId }) => {
        if (!body.counterparty || !body.topic) throw new ValidationError('Pregovor traži "counterparty" i "topic"');
        return need('negotiator').open({
          tenantId,
          counterparty: body.counterparty,
          topic: body.topic,
          ourOffer: body.offer ?? null,
          constraints: body.constraints ?? {},
          direction: body.direction ?? 'outbound',
        });
      },
    },
    {
      method: 'GET',
      path: '/a2a/negotiations',
      requiredRole: 'read',
      handler: async ({ tenantId, query }) => ({ negotiations: await need('negotiator').list(tenantId, { state: query.state, limit: Number(query.limit ?? 50) }) }),
    },
    {
      method: 'GET',
      path: '/a2a/negotiations/:id',
      requiredRole: 'read',
      handler: async ({ tenantId, params }) => need('negotiator').get(tenantId, params.id),
    },
    {
      method: 'POST',
      path: '/a2a/negotiations/:id/respond',
      requiredRole: 'run',
      handler: async ({ tenantId, params, body, auth }) =>
        need('negotiator').respond(tenantId, params.id, { offer: body.offer ?? null, accept: body.accept === true, by: body.by ?? auth.keyId ?? 'counterparty', note: body.note ?? null }),
    },
    {
      method: 'POST',
      path: '/a2a/negotiations/:id/close',
      requiredRole: 'approve',
      handler: async ({ tenantId, params, body }) => need('negotiator').close(tenantId, params.id, { by: body?.by ?? 'human', currency: body?.currency }),
    },
    {
      method: 'GET',
      path: '/a2a/settlements',
      requiredRole: 'read',
      handler: async ({ tenantId, query }) => ({
        totals: await need('settlement').totals(tenantId),
        settlements: await need('settlement').list(tenantId, { limit: Number(query.limit ?? 50) }),
        note: 'Interni ledger (simulacija). Pravo plaćanje traži adapter (Stripe/SEPA/x402) — planirano.',
      }),
    },

    // ───────────────────────── Ciljevi ─────────────────────────
    {
      method: 'GET',
      path: '/v1/admin/goals',
      requiredRole: 'admin',
      handler: async ({ tenantId, query }) => (query.portfolio === '1' ? need('goals').portfolio(tenantId) : { goals: await need('goals').list(tenantId, { status: query.status }) }),
    },
    {
      method: 'POST',
      path: '/v1/admin/goals',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => need('goals').create(tenantId, body),
    },
    {
      method: 'GET',
      path: '/v1/admin/goals/:goalId',
      requiredRole: 'admin',
      handler: async ({ tenantId, params }) => need('goals').get(tenantId, params.goalId),
    },
    {
      method: 'POST',
      path: '/v1/admin/goals/:goalId/decompose',
      requiredRole: 'admin',
      handler: async ({ tenantId, params }) => need('goals').decompose(tenantId, params.goalId),
    },
    {
      method: 'POST',
      path: '/v1/admin/goals/:goalId/progress',
      requiredRole: 'admin',
      handler: async ({ tenantId, params, body }) => need('goals').recordProgress(tenantId, params.goalId, body),
    },
    {
      method: 'POST',
      path: '/v1/admin/goals/:goalId/replan',
      requiredRole: 'admin',
      handler: async ({ tenantId, params }) => need('goals').replan(tenantId, params.goalId),
    },
    {
      method: 'POST',
      path: '/v1/admin/goals/:goalId/schedule',
      requiredRole: 'admin',
      handler: async ({ tenantId, params, body }) => need('goals').schedule(tenantId, params.goalId, body ?? {}),
    },
    {
      method: 'POST',
      path: '/v1/admin/goals/:goalId/status',
      requiredRole: 'admin',
      handler: async ({ tenantId, params, body }) => {
        if (!body.status) throw new ValidationError('Polje "status" je obavezno');
        return need('goals').setStatus(tenantId, params.goalId, body.status);
      },
    },
    {
      method: 'GET',
      path: '/v1/admin/goals/:goalId/history',
      requiredRole: 'admin',
      handler: async ({ tenantId, query }) => ({ history: await need('goals').history(tenantId, { limit: Number(query.limit ?? 100) }) }),
    },

    // ───────────────────────── Watcheri (proaktivnost) ─────────────────────────
    {
      method: 'GET',
      path: '/v1/admin/watchers',
      requiredRole: 'admin',
      handler: async ({ tenantId }) => ({ rules: need('watchers').listRules(tenantId), stats: need('watchers').stats() }),
    },
    {
      method: 'POST',
      path: '/v1/admin/watchers/tick',
      requiredRole: 'admin',
      handler: async ({ tenantId }) => ({ fired: await need('watchers').tick([tenantId]) }),
    },
    {
      method: 'POST',
      path: '/v1/admin/watchers/metrics',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => {
        if (!body.metric || body.value === undefined) throw new ValidationError('Polja "metric" i "value" su obavezna');
        return need('watchers').recordMetric(tenantId, body.metric, body.value, body.meta ?? {});
      },
    },

    // ───────────────────────── Self-improvement ─────────────────────────
    {
      method: 'GET',
      path: '/v1/admin/proposals',
      requiredRole: 'admin',
      handler: async ({ tenantId, query }) => ({ proposals: await need('improvements').list(tenantId, { status: query.status, kind: query.kind }), stats: await need('improvements').stats(tenantId) }),
    },
    {
      method: 'POST',
      path: '/v1/admin/proposals',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => need('improvements').createProposal(tenantId, body),
    },
    {
      method: 'GET',
      path: '/v1/admin/proposals/:id',
      requiredRole: 'admin',
      handler: async ({ tenantId, params }) => need('improvements').get(tenantId, params.id),
    },
    {
      method: 'POST',
      path: '/v1/admin/proposals/:id',
      requiredRole: 'admin',
      handler: async ({ tenantId, params, body }) => need('improvements').updateProposal(tenantId, params.id, body ?? {}),
    },
    {
      method: 'POST',
      path: '/v1/admin/proposals/:id/decide',
      requiredRole: 'approve',
      handler: async ({ tenantId, params, body, auth }) => need('improvements').decide(tenantId, params.id, { approve: body.approve !== false, by: body.by ?? auth.keyId, note: body.note ?? null }),
    },
    {
      method: 'POST',
      path: '/v1/admin/proposals/:id/apply',
      requiredRole: 'admin',
      handler: async ({ tenantId, params, body, auth }) => need('improvements').apply(tenantId, params.id, { by: body?.by ?? auth.keyId }),
    },
    {
      method: 'POST',
      path: '/v1/admin/proposals/:id/rollback',
      requiredRole: 'admin',
      handler: async ({ tenantId, params, body, auth }) => need('improvements').rollback(tenantId, params.id, { by: body?.by ?? auth.keyId }),
    },
    {
      method: 'GET',
      path: '/v1/admin/proposals/:id/impact',
      requiredRole: 'admin',
      handler: async ({ tenantId, params }) => need('rsi').impact(tenantId, params.id),
    },
    {
      method: 'GET',
      path: '/v1/admin/experiments',
      requiredRole: 'admin',
      handler: async ({ tenantId, query }) => ({ experiments: await need('improvements').listExperiments(tenantId, { status: query.status }), variants: await need('rewards').variantComparison(tenantId) }),
    },
    {
      method: 'POST',
      path: '/v1/admin/experiments',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => need('improvements').createExperiment(tenantId, body),
    },
    {
      method: 'POST',
      path: '/v1/admin/experiments/:id/conclude',
      requiredRole: 'admin',
      handler: async ({ tenantId, params, body, auth }) => need('improvements').concludeExperiment(tenantId, params.id, { by: body?.by ?? auth.keyId, promote: body?.promote !== false }),
    },

    // ───────────────────────── Self-play ─────────────────────────
    {
      method: 'POST',
      path: '/v1/admin/selfplay',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => need('selfplay').run(tenantId, body ?? {}),
    },
    {
      method: 'GET',
      path: '/v1/admin/selfplay/dataset',
      requiredRole: 'admin',
      handler: async ({ tenantId, query }) => need('selfplay').dataset(tenantId, { onlyPassed: query.all !== '1', limit: Number(query.limit ?? 200) }),
    },
    {
      method: 'GET',
      path: '/v1/admin/selfplay/curriculum',
      requiredRole: 'admin',
      handler: async ({ tenantId }) => need('selfplay').curriculum(tenantId),
    },

    // ───────────────────────── RSI ─────────────────────────
    {
      method: 'GET',
      path: '/v1/admin/rsi/analyze',
      requiredRole: 'admin',
      handler: async ({ tenantId, query }) => need('rsi').analyze(tenantId, { sinceDays: Number(query.sinceDays ?? 7) }),
    },
    {
      method: 'POST',
      path: '/v1/admin/rsi/cycle',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => need('rsi').cycle(tenantId, { sinceDays: body?.sinceDays ?? 7, autoPropose: body?.autoPropose !== false }),
    },
    {
      method: 'GET',
      path: '/v1/admin/rewards',
      requiredRole: 'admin',
      handler: async ({ tenantId, query }) => ({
        ranking: await need('rewards').ranking(tenantId, { groupBy: query.groupBy ?? 'agent', sinceMs: Number(query.sinceDays ?? 7) * 86_400_000 }),
        recent: await need('rewards').recent(tenantId, { limit: Number(query.limit ?? 30) }),
        weights: need('rewards').weights,
      }),
    },

    // ───────────────────────── Organizacija ─────────────────────────
    {
      method: 'GET',
      path: '/v1/admin/org',
      requiredRole: 'admin',
      handler: async ({ tenantId }) => need('company').chart(tenantId),
    },
    {
      method: 'GET',
      path: '/v1/admin/org/kpis',
      requiredRole: 'admin',
      handler: async ({ tenantId }) => need('company').kpis(tenantId),
    },
    {
      method: 'POST',
      path: '/v1/admin/org/cycle',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => need('company').cycle(tenantId, body ?? {}),
    },
    {
      method: 'POST',
      path: '/v1/admin/org/negotiate',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => {
        if (!body.topic || !Array.isArray(body.between) || body.between.length !== 2) throw new ValidationError('Pregovor traži "topic" i "between": [ulogaA, ulogaB]');
        return need('company').negotiate(tenantId, body);
      },
    },
    {
      method: 'GET',
      path: '/v1/admin/org/history',
      requiredRole: 'admin',
      handler: async ({ tenantId, query }) => ({ history: await need('company').history(tenantId, { limit: Number(query.limit ?? 20) }) }),
    },

    // ───────────────────────── Eval (zlatni set) ─────────────────────────
    {
      method: 'POST',
      path: '/v1/admin/eval',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => need('eval').run(tenantId, { name: body?.set ?? 'golden', caseIds: body?.caseIds ?? null, maxCases: body?.maxCases ?? 50 }),
    },
    {
      method: 'GET',
      path: '/v1/admin/eval/sets',
      requiredRole: 'admin',
      handler: async ({ tenantId }) => {
        const set = await need('eval').loadSet(tenantId).catch(() => null);
        return { tenantId, goldenSet: set ? { name: set.name, cases: set.cases.length, threshold: set.threshold ?? 0.8, file: set.file } : null };
      },
    },
    {
      method: 'GET',
      path: '/v1/admin/eval/history',
      requiredRole: 'admin',
      handler: async ({ tenantId, query }) => ({ history: await need('eval').history(tenantId, { limit: Number(query.limit ?? 20) }) }),
    },

    // ───────────────────────── Autonomija ─────────────────────────
    {
      method: 'GET',
      path: '/v1/admin/autonomy',
      requiredRole: 'admin',
      handler: async ({ tenantId }) => ({ ...need('autonomy').snapshot(), forTenant: need('autonomy').describe(tenantId) }),
    },
    {
      method: 'POST',
      path: '/v1/admin/autonomy',
      requiredRole: 'owner',
      handler: async ({ tenantId, body }) => {
        if (!body.level) throw new ValidationError('Polje "level" je obavezno (L0–L4)');
        return need('autonomy').setLevel(tenantId, body.agentId ?? null, body.level);
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/autonomy/check',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => need('autonomy').evaluate({ tenantId, agentId: body.agentId, riskLevel: body.riskLevel ?? 'low', kind: body.kind ?? 'act', detail: body.detail ?? {} }),
    },
  ];
}
