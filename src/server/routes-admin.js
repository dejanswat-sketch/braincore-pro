/**
 * Admin (control plane) rute — lifecycle agenata, per-agent identitet i budžet, poslovi, epizode.
 * Sve rute traže rolu `admin` (owner ima '*').
 */
import { ValidationError, NotFoundError } from '../core/errors.js';
import { iso } from '../core/clock.js';

export function createAdminRoutes({ robot, config, tenants, logger, metrics }) {
  const cp = () => {
    if (!robot.controlPlane) throw new NotFoundError('Control plane', 'nije inicijalizovan');
    return robot.controlPlane;
  };
  const sched = () => {
    if (!robot.scheduler) throw new NotFoundError('Scheduler', 'nije pokrenut');
    return robot.scheduler;
  };

  return [
    // ---------------- identitet ----------------
    {
      method: 'GET',
      path: '/v1/whoami',
      handler: async ({ auth }) => ({ tenantId: auth.tenantId, role: auth.role, keyId: auth.keyId, auth: auth.auth }),
    },

    // ---------------- pregled kontrolne ravni ----------------
    {
      method: 'GET',
      path: '/v1/admin/health',
      requiredRole: 'admin',
      handler: async ({ tenantId }) => ({
        controlPlane: await cp().snapshot(),
        scheduler: robot.scheduler ? robot.scheduler.stats() : null,
        agents: robot.catalog.size(),
        tools: robot.tools.size(),
        sandbox: robot.sandbox?.describe?.() ?? null,
        mcp: robot.mcp.list().map((s) => ({ id: s.id, tools: s.tools.length })),
        jobs: robot.scheduler ? (await robot.scheduler.list(tenantId)).length : 0,
        otel: robot.otel ? { enabled: robot.otel.enabled, exported: robot.otel.exported } : null,
      }),
    },

    // ---------------- agent lifecycle ----------------
    {
      method: 'GET',
      path: '/v1/admin/agents',
      requiredRole: 'admin',
      handler: async ({ tenantId }) => ({ agents: await cp().list(tenantId) }),
    },
    {
      method: 'GET',
      path: '/v1/admin/agents/:agentId',
      requiredRole: 'admin',
      handler: async ({ tenantId, params }) => cp().get(tenantId, params.agentId),
    },
    {
      method: 'POST',
      path: '/v1/admin/agents/:agentId/deploy',
      requiredRole: 'admin',
      handler: async ({ tenantId, params, body, auth }) => {
        if (!body.patch || typeof body.patch !== 'object') throw new ValidationError('Tijelo mora imati "patch" (objekat sa poljima agenta)');
        metrics?.inc('controlplane_deploy_requests_total', { tenant: tenantId, agent: params.agentId });
        return cp().deploy(tenantId, params.agentId, { patch: body.patch, note: body.note ?? null, actor: body.actor ?? auth.keyId });
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/agents/:agentId/rollback',
      requiredRole: 'admin',
      handler: async ({ tenantId, params, body }) => cp().rollback(tenantId, params.agentId, body.version),
    },
    {
      method: 'POST',
      path: '/v1/admin/agents/:agentId/status',
      requiredRole: 'admin',
      handler: async ({ tenantId, params, body }) => {
        if (!body.status) throw new ValidationError('Polje "status" je obavezno (active | paused | retired)');
        return cp().setStatus(tenantId, params.agentId, body.status, { reason: body.reason ?? null });
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/agents/:agentId/budget',
      requiredRole: 'owner',
      handler: async ({ tenantId, params, body }) => cp().setBudget(tenantId, params.agentId, body.budgetUsdMonth ?? null),
    },
    {
      method: 'POST',
      path: '/v1/admin/agents/:agentId/keys',
      requiredRole: 'admin',
      handler: async ({ tenantId, params, body }) => cp().issueAgentKey(tenantId, params.agentId, { role: body.role ?? 'agent', scopes: body.scopes ?? [], label: body.label ?? null }),
    },
    {
      method: 'DELETE',
      path: '/v1/admin/agents/:agentId/keys/:keyId',
      requiredRole: 'admin',
      handler: async ({ tenantId, params }) => cp().revokeAgentKey(tenantId, params.agentId, params.keyId),
    },

    // ---------------- persistentni poslovi ----------------
    {
      method: 'GET',
      path: '/v1/admin/jobs',
      requiredRole: 'admin',
      handler: async ({ tenantId }) => ({ jobs: await sched().list(tenantId), scheduler: sched().stats() }),
    },
    {
      method: 'POST',
      path: '/v1/admin/jobs',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => {
        if (!body.agentId && !body.pattern) throw new ValidationError('Posao traži "agentId" ili "pattern"');
        return sched().createJob(tenantId, body);
      },
    },
    {
      method: 'GET',
      path: '/v1/admin/jobs/:jobId',
      requiredRole: 'admin',
      handler: async ({ tenantId, params }) => {
        const job = await sched().get(tenantId, params.jobId);
        if (!job) throw new NotFoundError('Posao', params.jobId);
        return job;
      },
    },
    {
      method: 'GET',
      path: '/v1/admin/jobs/:jobId/runs',
      requiredRole: 'admin',
      handler: async ({ tenantId, params, query }) => {
        const runs = await sched().runs(tenantId, { limit: Number(query.limit ?? 20) });
        return { runs: runs.filter((r) => r.jobId === params.jobId) };
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/jobs/:jobId/run',
      requiredRole: 'admin',
      handler: async ({ tenantId, params }) => sched().runNow(tenantId, params.jobId),
    },
    {
      method: 'POST',
      path: '/v1/admin/jobs/:jobId/pause',
      requiredRole: 'admin',
      handler: async ({ tenantId, params }) => {
        const job = await sched().pause(tenantId, params.jobId);
        if (!job) throw new NotFoundError('Posao', params.jobId);
        return job;
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/jobs/:jobId/resume',
      requiredRole: 'admin',
      handler: async ({ tenantId, params, body }) => {
        const job = await sched().resume(tenantId, params.jobId, { everyMs: body?.everyMs });
        if (!job) throw new NotFoundError('Posao', params.jobId);
        return job;
      },
    },
    {
      method: 'DELETE',
      path: '/v1/admin/jobs/:jobId',
      requiredRole: 'admin',
      handler: async ({ tenantId, params }) => ({ removed: await sched().remove(tenantId, params.jobId) }),
    },

    // ---------------- epizodična memorija ----------------
    {
      method: 'GET',
      path: '/v1/admin/episodes',
      requiredRole: 'admin',
      handler: async ({ tenantId, query }) => ({
        stats: await robot.memory.episodic.stats(tenantId),
        episodes: await robot.memory.episodic.recent(tenantId, { limit: Number(query.limit ?? 20) }),
      }),
    },
    {
      method: 'POST',
      path: '/v1/admin/episodes',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => {
        if (!body.problem || !body.solution) throw new ValidationError('Polja "problem" i "solution" su obavezna');
        return robot.memory.episodic.record(tenantId, { ...body, source: 'admin-api' });
      },
    },

    // ---------------- procesi (dugoročni) ----------------
    {
      method: 'POST',
      path: '/v1/admin/processes',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => {
        if (!Array.isArray(body.steps) || !body.steps.length) throw new ValidationError('Proces traži "steps" (niz koraka)');
        const job = await sched().createJob(tenantId, {
          ...body,
          type: 'process',
          schedule: body.schedule ?? { type: 'interval', everyMs: body.stepDelayMs ?? 60_000 },
          process: { steps: body.steps.map((s, i) => ({ id: s.id ?? String(i), ...s })), done: [], state: 'pending', stepDelayMs: body.stepDelayMs ?? 0, log: [] },
          runNow: body.runNow !== false,
          name: body.name ?? `proces ${iso()}`,
        });
        return { jobId: job.id, steps: job.process.steps.length, nextRunAt: job.nextRunAt, description: 'Koraci se izvršavaju jedan po jedan; proces pamti stanje i preživljava restart.' };
      },
    },
  ];
}
