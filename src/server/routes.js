/**
 * Rute gateway-a. Jedno mjesto gdje se vidi sve što robot izlaže.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { NotFoundError, ValidationError, NmqError } from '../core/errors.js';
import { openSse, sseSink } from './stream.js';
import { iso } from '../core/clock.js';

const HOOK_AGENTS = {
  email: 'support',
  gmail: 'support',
  slack: 'ops',
  shopify: 'ecommerce',
  woocommerce: 'ecommerce',
  github: 'dev',
  gitlab: 'dev',
  jira: 'dev',
  stripe: 'finance',
  form: 'sales',
  webform: 'sales',
  whatsapp: 'support',
  telegram: 'support',
};

const APPROVAL_TTL_MS = 24 * 3600 * 1000;

export function createRoutes({ robot, config, logger, metrics, tenants, dataDir }) {
  const pendingApprovals = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [runId, p] of pendingApprovals) if (now - p.createdAt > APPROVAL_TTL_MS) pendingApprovals.delete(runId);
  }, 3600_000);
  cleanup.unref?.();

  const runOptions = (body) => ({
    pattern: body.pattern,
    options: body.options ?? {},
  });

  async function executeRun({ body, tenantId, role, onEvent, signal }) {
    tenants.assertCan(role, 'run');
    const { agentId, pattern, input, sessionId, userId, options, approvedTools } = body;
    if (input === undefined || input === null || input === '') throw new ValidationError('Polje "input" je obavezno');

    const result = await robot.orchestrator.run({
      tenantId,
      agentId: agentId ?? null,
      pattern,
      input,
      sessionId,
      userId,
      options: options ?? {},
      approvedTools,
      onEvent,
      signal,
    });

    if (result.approvals?.length) {
      pendingApprovals.set(result.runId, {
        tenantId,
        agentId: result.agentId,
        pattern: result.pattern,
        input,
        sessionId,
        userId,
        options: options ?? {},
        approvals: result.approvals,
        createdAt: Date.now(),
        output: result.output,
      });
    }

    metrics?.inc('runs_total', { tenant: tenantId, agent: result.agentId ?? '-', pattern: result.pattern });
    return result;
  }

  return [
    // ---------------- javno / ops ----------------
    {
      method: 'GET',
      path: '/healthz',
      auth: false,
      rate: false,
      handler: async () => ({ ok: true, version: robot.version, uptimeSec: Math.round(process.uptime()), now: iso() }),
    },
    {
      method: 'GET',
      path: '/readyz',
      auth: false,
      rate: false,
      handler: async () => {
        const ready = {
          agents: robot.catalog.size(),
          tools: robot.tools.size(),
          llm: robot.llm.providers.map((p) => p.name),
          llmIsMock: robot.llm.isMock,
          mcp: robot.mcp.list(),
          memory: { semantic: robot.memory.isSemantic, embedder: robot.memory.embedder.name },
          dataDir: config.dataDir,
        };
        const problems = [];
        if (ready.agents === 0) problems.push('nema agenata (config/agents/*.json)');
        if (ready.tools === 0) problems.push('nema alata');
        if (ready.llmIsMock) problems.push('LLM je mock (postavi NMQ_LLM_API_KEY)');
        return { ok: problems.length === 0, problems, ...ready };
      },
    },
    {
      method: 'GET',
      path: '/metrics',
      auth: false,
      rate: false,
      handler: async ({ res }) => {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        res.end(metrics.render());
      },
    },
    {
      method: 'GET',
      path: '/',
      auth: false,
      rate: false,
      handler: async ({ res }) => serveFile(res, path.join(config.root, 'public', 'index.html'), 'text/html'),
    },
    {
      method: 'GET',
      path: '/widget.js',
      auth: false,
      rate: false,
      handler: async ({ res }) => serveFile(res, path.join(config.root, 'public', 'widget', 'nmq-robot.js'), 'application/javascript'),
    },

    // ---------------- konfiguracija i katalog ----------------
    {
      method: 'GET',
      path: '/v1/config',
      handler: async () => config.publicConfig(),
    },
    {
      method: 'GET',
      path: '/v1/agents',
      handler: async () => ({
        count: robot.catalog.size(),
        agents: robot.catalog.all().map((a) => ({
          id: a.id,
          name: a.name,
          domain: a.domain,
          description: a.description,
          defaultPattern: a.defaultPattern,
          tools: a.tools,
          maxRisk: a.maxRisk,
          kpi: a.kpi,
        })),
      }),
    },
    {
      method: 'GET',
      path: '/v1/agents/:id',
      handler: async ({ params }) => {
        const agent = robot.catalog.get(params.id);
        if (!agent) throw new NotFoundError('Agent', params.id);
        const policy = robot.policyResolver(null, { agentId: agent.id });
        return {
          ...agent,
          allowedTools: robot.tools.specsFor({ policy, agentId: agent.id, scopes: agent.toolScopes, maxRisk: agent.maxRisk }).map((t) => t.name),
        };
      },
    },
    {
      method: 'GET',
      path: '/v1/tools',
      handler: async () => ({
        count: robot.tools.size(),
        tools: robot.tools.list().map((t) => ({ name: t.name, riskLevel: t.riskLevel, source: t.source, description: t.description, tags: t.tags })),
      }),
    },
    {
      method: 'GET',
      path: '/v1/patterns',
      handler: async () => ({ patterns: robot.orchestrator.PATTERNS }),
    },
    {
      method: 'GET',
      path: '/v1/mcp',
      handler: async () => ({ servers: robot.mcp.list() }),
    },

    // ---------------- izvršavanje ----------------
    {
      method: 'POST',
      path: '/v1/run',
      requiredRole: 'run',
      handler: async ({ body, tenantId, role, req, res }) => {
        const result = await executeRun({ body, tenantId, role });
        return result;
      },
    },
    {
      method: 'POST',
      path: '/v1/agents/:id/run',
      requiredRole: 'run',
      handler: async ({ params, body, tenantId, role }) =>
        executeRun({ body: { ...body, agentId: params.id }, tenantId, role }),
    },
    {
      method: 'POST',
      path: '/v1/router/run',
      requiredRole: 'run',
      handler: async ({ body, tenantId, role }) => executeRun({ body: { ...body, agentId: null, pattern: 'router' }, tenantId, role }),
    },
    {
      method: 'POST',
      path: '/v1/run/stream',
      requiredRole: 'run',
      handler: async ({ body, tenantId, role, req, res }) => streamRun({ body, tenantId, role, req, res }),
    },
    {
      method: 'POST',
      path: '/v1/agents/:id/stream',
      requiredRole: 'run',
      handler: async ({ params, body, tenantId, role, req, res }) => streamRun({ body: { ...body, agentId: params.id }, tenantId, role, req, res }),
    },

    // ---------------- runovi i odobrenja ----------------
    {
      method: 'GET',
      path: '/v1/runs',
      handler: async ({ tenantId, query }) => ({ runs: robot.tracer.list({ tenantId, limit: Number(query.limit ?? 20) }) }),
    },
    {
      method: 'GET',
      path: '/v1/runs/:runId',
      handler: async ({ params }) => {
        const run = robot.tracer.get(params.runId);
        if (!run) throw new NotFoundError('Run', params.runId);
        return run;
      },
    },
    {
      method: 'GET',
      path: '/v1/approvals',
      handler: async ({ tenantId }) => ({
        pending: [...pendingApprovals.entries()]
          .filter(([, p]) => p.tenantId === tenantId)
          .map(([runId, p]) => ({ runId, agentId: p.agentId, approvals: p.approvals, requestedAt: iso(p.createdAt), preview: String(p.output ?? '').slice(0, 400) })),
      }),
    },
    {
      method: 'POST',
      path: '/v1/approvals/:runId',
      handler: async ({ params, body, tenantId, role }) => {
        tenants.assertCan(role, 'approve');
        const pending = pendingApprovals.get(params.runId);
        if (!pending) throw new NotFoundError('Zahtjev za odobrenje', params.runId);
        if (pending.tenantId !== tenantId) throw new NmqError('Zahtjev pripada drugom tenantu', { code: 'FORBIDDEN', status: 403 });

        const approve = body.approve !== false;
        await robot.audit.append({
          tenantId,
          actor: body.approvedBy ?? 'human',
          action: 'approval_decision',
          tool: pending.approvals.map((a) => a.tool).join(','),
          args: { approve, note: body.note ?? null },
          decision: approve ? 'approved' : 'rejected',
          outcome: approve ? 'ok' : 'blocked',
          runId: params.runId,
          meta: { approvals: pending.approvals },
        });

        if (!approve) {
          pendingApprovals.delete(params.runId);
          await robot.memory.longterm.append(tenantId, { type: 'decision', content: `Odobrenje odbijeno za run ${params.runId}`, data: { note: body.note ?? null } });
          return { runId: params.runId, approved: false, note: body.note ?? null };
        }

        const approvedTools = [...new Set([...(body.approvedTools ?? []), ...pending.approvals.map((a) => a.tool)])];
        pendingApprovals.delete(params.runId);
        const result = await robot.orchestrator.run({
          tenantId,
          agentId: pending.agentId,
          pattern: pending.pattern,
          input: pending.input,
          sessionId: pending.sessionId,
          userId: pending.userId,
          options: pending.options,
          approvedTools,
        });
        return { approved: true, approvedTools, ...result };
      },
    },

    // ---------------- memorija ----------------
    {
      method: 'POST',
      path: '/v1/kb',
      requiredRole: 'manage-kb',
      handler: async ({ body, tenantId }) => {
        if (!body.text || !body.source) throw new ValidationError('Polja "text" i "source" su obavezna');
        const res = await robot.memory.vectors.ingest(tenantId, { text: body.text, source: body.source, docId: body.docId, metadata: { tags: body.tags ?? [] } });
        await robot.memory.longterm.append(tenantId, { type: 'note', content: `KB dokument "${body.source}" (${res.chunks} dijelova)`, data: res });
        return res;
      },
    },
    {
      method: 'POST',
      path: '/v1/kb/search',
      handler: async ({ body, tenantId }) => {
        const hits = await robot.memory.vectors.query(tenantId, { text: body.query, k: Number(body.k ?? 6), filter: body.filter ?? {} });
        return { query: body.query, count: hits.length, hits };
      },
    },
    {
      method: 'GET',
      path: '/v1/memory/facts',
      handler: async ({ tenantId }) => ({ facts: await robot.memory.longterm.readFacts(tenantId) }),
    },
    {
      method: 'POST',
      path: '/v1/memory/facts',
      handler: async ({ body, tenantId }) => {
        if (!body.key) throw new ValidationError('Polje "key" je obavezno');
        return robot.memory.longterm.upsertFact(tenantId, body.key, body.value, { source: body.source ?? 'api', confidence: body.confidence ?? 0.9 });
      },
    },
    {
      method: 'GET',
      path: '/v1/memory/history',
      handler: async ({ tenantId, query }) => ({ events: await robot.memory.longterm.recent(tenantId, { limit: Number(query.limit ?? 30) }) }),
    },
    {
      method: 'DELETE',
      path: '/v1/memory/user/:userId',
      requiredRole: 'admin',
      handler: async ({ params, tenantId }) => robot.memory.forgetUser(tenantId, params.userId),
    },

    // ---------------- ulazi iz spoljnih sistema ----------------
    {
      method: 'POST',
      path: '/v1/hooks/:source',
      requiredRole: 'run',
      handler: async ({ params, body, tenantId, role }) => {
        const source = params.source.toLowerCase();
        const mapping = config.tenant(tenantId)?.hooks?.[source] ?? { agentId: HOOK_AGENTS[source] ?? 'support' };
        const input = normalizeHookInput(source, body);
        const result = await executeRun({ body: { ...mapping, input, userId: body.userId ?? null }, tenantId, role });
        return { accepted: true, source, ...result };
      },
    },
    {
      method: 'POST',
      path: '/v1/feedback',
      handler: async ({ body, tenantId, auth }) => {
        const event = await robot.memory.longterm.append(tenantId, {
          type: 'note',
          content: `Ocjena: ${body.rating}${body.comment ? ` — ${body.comment}` : ''}`,
          runId: body.runId ?? null,
          userId: auth.keyId,
          data: { rating: body.rating, comment: body.comment ?? null },
          importance: 0.8,
        });
        metrics?.inc('feedback_total', { tenant: tenantId, rating: String(body.rating) });
        return { saved: true, id: event.id };
      },
    },

    // ---------------- posmatranje i naplata ----------------
    {
      method: 'GET',
      path: '/v1/usage',
      handler: async ({ tenantId, query }) => ({
        tenantId,
        summary: await robot.cost.summary(tenantId, { month: query.month }),
      }),
    },
    {
      method: 'GET',
      path: '/v1/audit',
      handler: async ({ tenantId, query }) => ({
        verify: await robot.audit.verify(tenantId),
        entries: await robot.audit.read(tenantId, { limit: Number(query.limit ?? 30) }),
      }),
    },
    {
      method: 'GET',
      path: '/v1/tenants/:id/secrets',
      requiredRole: 'admin',
      handler: async ({ params, tenantId }) => {
        if (params.id !== tenantId) throw new NmqError('Možeš čitati samo svoj tenant', { code: 'FORBIDDEN', status: 403 });
        return { secrets: await tenants.listSecrets(tenantId) };
      },
    },
    {
      method: 'POST',
      path: '/v1/tenants/:id/secrets',
      requiredRole: 'owner',
      handler: async ({ params, body, tenantId }) => {
        if (params.id !== tenantId) throw new NmqError('Možeš mijenjati samo svoj tenant', { code: 'FORBIDDEN', status: 403 });
        if (!body.provider || !body.value) throw new ValidationError('Polja "provider" i "value" su obavezni');
        return tenants.setSecret(tenantId, body.provider, body.value);
      },
    },
  ];

  async function streamRun({ body, tenantId, role, req, res }) {
    const sse = openSse(res, { headers: { 'access-control-allow-origin': req.headers.origin ?? '*' } });
    const controller = new AbortController();
    req.on('close', () => controller.abort(new Error('client-closed')));
    try {
      sse.send('start', { tenantId, agentId: body.agentId ?? null, at: iso() });
      const result = await executeRun({ body, tenantId, role, onEvent: sseSink(sse), signal: controller.signal });
      sse.send('done', {
        runId: result.runId,
        agentId: result.agentId,
        pattern: result.pattern,
        status: result.status,
        output: result.output,
        usage: result.usage,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        approvals: result.approvals,
      });
    } catch (err) {
      sse.send('error', { code: err?.code ?? 'INTERNAL', message: err?.message ?? 'greška', status: err?.status ?? 500 });
    } finally {
      sse.close();
    }
  }
}

async function serveFile(res, file, contentType) {
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': `${contentType}; charset=utf-8`,
      'cache-control': 'no-cache, no-store, must-revalidate', // zamka sa Hostinger kešom
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Nema fajla: ${path.basename(file)}`);
  }
}

function normalizeHookInput(source, body) {
  if (typeof body.text === 'string' && body.text) return body.text;
  if (body.subject) return `[${source}] ${body.subject}\n\n${body.body ?? body.description ?? ''}`.trim();
  if (body.message) return `[${source}] ${typeof body.message === 'string' ? body.message : JSON.stringify(body.message)}`;
  return `[${source}] ${JSON.stringify(body).slice(0, 4000)}`;
}
