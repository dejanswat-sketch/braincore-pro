/**
 * Rute v0.4: swarm (roj), swarm governance (board), swarm safety (incidenti),
 * evolucija agenata i RSI meta-nivoi.
 *
 * Sigurnosna namjera: sve što mijenja granice roja (izolacija, kvote, RSI nivo, promocija genoma)
 * traži role `admin`/`owner` (čovjek) i ide u hash-chained audit — a ne u ruke agentu.
 */
import { PolicyError, ValidationError, NotFoundError } from '../core/errors.js';

export function createSwarmRoutes({ robot, config, tenants, logger, metrics }) {
  const need = (name) => {
    const value = robot[name];
    if (!value) throw new PolicyError(`Komponenta "${name}" nije dostupna`);
    return value;
  };
  const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

  return [
    // ───────────────────────── SWARM (roj) ─────────────────────────
    {
      method: 'GET',
      path: '/v1/admin/swarm',
      requiredRole: 'read',
      handler: async ({ tenantId }) => ({ ...need('swarm').stats(tenantId), safety: need('swarmSafety').report({ tenantId }), history: need('swarm').history().slice(-10) }),
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/workers',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => {
        const list = asArray(body?.agentId ?? body?.agents);
        if (!list.length) throw new ValidationError('Traži se "agentId" ili "agents" (lista)');
        const created = list.map((agentId) =>
          need('swarm').registerWorker({
            tenantId,
            agentId: typeof agentId === 'string' ? agentId : agentId.agentId,
            skills: typeof agentId === 'string' ? (body?.skills ?? []) : (agentId.skills ?? body?.skills ?? []),
            maxRunsPerTick: body?.maxRunsPerTick ?? 1,
          }),
        );
        metrics?.gauge?.('swarm_workers_active', { tenant: tenantId }, created.length);
        return { tenantId, workers: created, total: need('swarm').listWorkers(tenantId).length };
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/tasks',
      requiredRole: 'run',
      handler: async ({ tenantId, body, auth }) => {
        const list = asArray(body?.tasks ?? body);
        if (!list.length) throw new ValidationError('Traži se "tasks" (lista) ili jedan zadatak sa "title"');
        const created = [];
        for (const t of list) created.push(await need('blackboard').postTask({ tenantId, createdBy: auth?.keyId ?? 'operator', ...t }));
        return { tenantId, created, board: need('blackboard').snapshot({ tenantId }) };
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/tick',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => need('swarm').tick(tenantId, { maxRuns: body?.maxRuns ?? null }),
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/run',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => {
        if (!need('swarm').listWorkers(tenantId).length) throw new ValidationError('Nema registrovanih workera — prvo POST /v1/admin/swarm/workers');
        return need('swarm').run(tenantId, { rounds: body?.rounds ?? 2, maxRuns: body?.maxRuns ?? null, detectEvery: body?.detectEvery ?? 1 });
      },
    },
    {
      method: 'GET',
      path: '/v1/admin/swarm/board',
      requiredRole: 'read',
      handler: async ({ tenantId }) => need('blackboard').snapshot({ tenantId }),
    },
    {
      method: 'GET',
      path: '/v1/admin/swarm/pheromones',
      requiredRole: 'read',
      handler: async ({ tenantId, query }) => ({
        tenantId,
        pheromones: need('blackboard').activePheromones(Date.now(), { tenantId, types: query.type ? [query.type] : null, minStrength: Number(query.minStrength ?? 0.01) }),
        types: need('blackboard').PHEROMONE_TYPES,
      }),
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/pheromone',
      requiredRole: 'run',
      handler: async ({ tenantId, body }) => {
        need('swarmGovernance').assertCanPheromone({ tenantId, by: body?.by ?? 'operator' });
        return need('blackboard').pheromone({ tenantId, type: body?.type, taskId: body?.taskId ?? null, by: body?.by ?? 'operator', strength: body?.strength ?? 1, ttlMs: body?.ttlMs ?? 3_600_000, payload: body?.payload ?? {} });
      },
    },
    {
      method: 'GET',
      path: '/v1/admin/swarm/specialization',
      requiredRole: 'read',
      handler: async ({ tenantId }) => ({ tenantId, specialization: need('swarm').specialization(tenantId), note: 'Specijalizacija NIJE konfigurisana — mjeri se iz stvarno završenih zadataka.' }),
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/vote',
      requiredRole: 'run',
      handler: async ({ tenantId, body }) => need('swarm').vote(tenantId, { proposalId: body?.proposalId, workerId: body?.workerId, choice: body?.choice, rationale: body?.rationale ?? null }),
    },
    {
      method: 'GET',
      path: '/v1/admin/swarm/consensus/:proposalId',
      requiredRole: 'read',
      handler: async ({ tenantId, params }) => need('swarm').consensus(tenantId, params.proposalId),
    },

    // ───────────────────────── SWARM GOVERNANCE (board) ─────────────────────────
    {
      method: 'GET',
      path: '/v1/admin/swarm/governance',
      requiredRole: 'read',
      handler: async ({ tenantId }) => need('swarmGovernance').describe(tenantId),
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/governance/isolation',
      requiredRole: 'owner',
      handler: async ({ tenantId, body, auth }) => need('swarmGovernance').setIsolation(tenantId, body?.level, { by: auth?.keyId ?? 'board', reason: body?.reason ?? null }),
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/governance/quotas',
      requiredRole: 'owner',
      handler: async ({ tenantId, body, auth }) => need('swarmGovernance').setQuotas(tenantId, body ?? {}, { by: auth?.keyId ?? 'board' }),
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/freeze',
      requiredRole: 'owner',
      handler: async ({ tenantId, body, auth }) => need('swarmGovernance').freeze(tenantId, { reason: body?.reason ?? 'manual', by: auth?.keyId ?? 'board' }),
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/unfreeze',
      requiredRole: 'owner',
      handler: async ({ tenantId, body, auth }) => need('swarmGovernance').unfreeze(tenantId, { by: auth?.keyId ?? 'board', level: body?.level ?? 'contained' }),
    },

    // ───────────────────────── SWARM SAFETY ─────────────────────────
    {
      method: 'GET',
      path: '/v1/admin/swarm/safety',
      requiredRole: 'read',
      handler: async ({ tenantId }) => need('swarmSafety').report({ tenantId }),
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/safety/detect',
      requiredRole: 'admin',
      handler: async ({ tenantId }) => ({ findings: await need('swarmSafety').detect({ tenantId }) }),
    },
    {
      method: 'GET',
      path: '/v1/admin/swarm/incidents',
      requiredRole: 'read',
      handler: async ({ tenantId, query }) => ({ incidents: need('swarmSafety').listIncidents({ tenantId, status: query.status ?? 'open' }) }),
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/incidents/:id/resolve',
      requiredRole: 'admin',
      handler: async ({ params, body, auth }) => need('swarmSafety').resolveIncident(params.id, { by: auth?.keyId ?? 'human', note: body?.note ?? null }),
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/quarantine',
      requiredRole: 'admin',
      handler: async ({ body }) => {
        if (!body?.workerId) throw new ValidationError('Traži se "workerId"');
        return need('swarmSafety').quarantine(body.workerId, body.reason ?? 'manual');
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/quarantine/:workerId/release',
      requiredRole: 'admin',
      handler: async ({ params }) => need('swarmSafety').release(params.workerId),
    },
    {
      method: 'POST',
      path: '/v1/admin/swarm/message',
      requiredRole: 'run',
      handler: async ({ tenantId, body }) => need('swarmSafety').mediateMessage({ tenantId, from: body?.from, to: body?.to, type: body?.type, payload: body?.payload ?? {} }),
    },

    // ───────────────────────── EVOLUCIJA ─────────────────────────
    {
      method: 'GET',
      path: '/v1/admin/evolution',
      requiredRole: 'read',
      handler: async ({ tenantId, query }) => ({ tenantId, population: await need('evolution').population(tenantId, { agentId: query.agentId ?? null }), mutableFields: need('evolution').MUTABLE_FIELDS, forbiddenFields: need('evolution').FORBIDDEN_FIELDS, settings: { autoPromote: need('evolution').settings.autoPromote, populationSize: need('evolution').settings.populationSize, generations: need('evolution').settings.generations } }),
    },
    {
      method: 'POST',
      path: '/v1/admin/evolution/evolve',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => {
        if (!body?.agentId) throw new ValidationError('Traži se "agentId"');
        return need('evolution').evolve(tenantId, { agentId: body.agentId, populationSize: body?.populationSize ?? null, generations: body?.generations ?? null, setName: body?.setName ?? 'golden', caseIds: body?.caseIds ?? null, maxCases: body?.maxCases ?? 8 });
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/evolution/promote',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => {
        if (!body?.agentId) throw new ValidationError('Traži se "agentId"');
        return need('evolution').proposePromotion(tenantId, { agentId: body.agentId, baselineFitness: body?.baselineFitness ?? null });
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/evolution/auto-promote',
      requiredRole: 'owner',
      handler: async ({ tenantId, body }) => need('evolution').maybeAutoPromote(tenantId, { agentId: body?.agentId, minGain: body?.minGain ?? null }),
    },

    // ───────────────────────── RSI META ─────────────────────────
    {
      method: 'GET',
      path: '/v1/admin/rsi',
      requiredRole: 'read',
      handler: async ({ tenantId }) => need('metaRsi').status(tenantId),
    },
    {
      method: 'POST',
      path: '/v1/admin/rsi/level',
      requiredRole: 'owner',
      handler: async ({ tenantId, body, auth }) => need('metaRsi').setLevel(tenantId, body?.level, { by: auth?.keyId ?? 'board', reason: body?.reason ?? null }),
    },
    {
      method: 'GET',
      path: '/v1/admin/rsi/research',
      requiredRole: 'read',
      handler: async ({ tenantId, query }) => ({ tenantId, log: await need('metaRsi').researchLog(tenantId, { limit: Number(query.limit ?? 100) }) }),
    },
    {
      method: 'POST',
      path: '/v1/admin/rsi/experiment',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => {
        if (!body?.agentId) throw new ValidationError('Traži se "agentId"');
        const designed = await need('metaRsi').designExperiment(tenantId, { agentId: body.agentId, goal: body?.goal ?? undefined, strategy: body?.strategy ?? null, caseIds: body?.caseIds ?? null });
        if (body?.run === false) return designed;
        const finished = await need('metaRsi').runExperiment(tenantId, designed, { setName: body?.setName ?? 'golden', maxCases: body?.maxCases ?? 6 });
        const promotion = body?.promote ? await need('metaRsi').promote(tenantId, finished, { minLift: body?.minLift ?? null }) : null;
        return { experiment: finished, promotion };
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/rsi/experience',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => need('metaRsi').acquireExperience(tenantId, { rounds: body?.rounds ?? 3, agentId: body?.agentId ?? 'support', domain: body?.domain ?? 'support' }),
    },
    {
      method: 'POST',
      path: '/v1/admin/rsi/adapt',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => need('metaRsi').adaptEnvironment(tenantId, { target: body?.target ?? 'domain', value: body?.value, agentId: body?.agentId ?? null, rationale: body?.rationale ?? null }),
    },
    {
      method: 'POST',
      path: '/v1/admin/rsi/meta',
      requiredRole: 'admin',
      handler: async ({ tenantId }) => need('metaRsi').metaImprove(tenantId),
    },
  ];
}
