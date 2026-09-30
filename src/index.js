/**
 * NMQ Robot — javni ulaz u sistem.
 * Ovdje se spajaju svi slojevi: config → llm → memory → tools/MCP → agenti → orchestracija → server.
 */
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { createMetrics } from './observability/metrics.js';
import { createTracer } from './observability/trace.js';
import { createAuditLog } from './observability/audit.js';
import { createCostTracker } from './observability/cost.js';
import { createLlm, wrapLlmProvider } from './llm/index.js';
import { createMemory } from './memory/index.js';
import { createToolRegistry } from './tools/registry.js';
import { registerBuiltinTools } from './tools/builtin.js';
import { createMcpManager } from './tools/mcp-client.js';
import { createAgentCatalog } from './agents/catalog.js';
import { createAgentRunner } from './agents/agent.js';
import { createCritic } from './agents/critic.js';
import { createRouter } from './agents/router-agent.js';
import { createOrchestrator } from './orchestration/index.js';
import { createPatternHelpers } from './orchestration/helpers.js';
import { createTenantStore } from './tenancy/store.js';
import { resolvePolicy } from './core/policy.js';
import { createRoutes } from './server/routes.js';
import { createAdminRoutes } from './server/routes-admin.js';
import { createHttpServer, listen as httpListen } from './server/http.js';
import { createSandbox } from './core/sandbox.js';
import { createBus } from './core/events.js';
import { createJobStore } from './scheduler/store.js';
import { createScheduler } from './scheduler/index.js';
import { createControlPlane } from './controlplane/registry.js';
import { createOtelExporter } from './observability/otel.js';

export const VERSION = '0.2.0';

/**
 * Gradi kompletan robot. Testovi i skripte ga pozivaju sa `overrides` da zamijene LLM ili skladište.
 */
export async function createRobot({ root = process.cwd(), env = process.env, dataDir, overrides = {}, connectMcp = undefined } = {}) {
  const config = await loadConfig({ root, env, dataDir });
  const level = overrides.logLevel ?? config.env.logLevel;
  const logger = overrides.logger ?? createLogger({ level, sink: overrides.logSink });
  const metrics = overrides.metrics ?? createMetrics();
  const bus = overrides.bus ?? createBus();
  const otel = overrides.otel ?? createOtelExporter({ dataDir: config.dataDir, file: config.env.otelFile !== false, endpoint: config.env.otelEndpoint, headers: config.env.otelHeaders, logger, serviceName: 'nmq-robot', serviceVersion: VERSION });
  const tracer = createTracer({ dataDir: config.dataDir, logger, metrics, otel });
  const audit = createAuditLog({ dataDir: config.dataDir, logger });
  const cost = createCostTracker({ dataDir: config.dataDir, logger, metrics });
  const llm = overrides.llm ? wrapLlmProvider(overrides.llm, logger) : createLlm({ env: config.env, logger, metrics });
  const memory = overrides.memory ?? createMemory({ dataDir: config.dataDir, llm, env: config.env, logger });
  const catalog = createAgentCatalog(config, logger);
  const tenants = createTenantStore({ config, dataDir: config.dataDir, logger, env: config.env });
  await tenants.loadStatuses();

  const isProduction = (config.env.nodeEnv ?? process.env.NODE_ENV) === 'production' || (config.env.nmqEnv ?? process.env.NMQ_ENV) === 'production';
  if (isProduction && !config.env.masterKey) {
    throw new Error('NMQ_MASTER_KEY je obavezan u produkciji (bez njega se tenant tajne ne mogu bezbjedno čuvati)');
  }

  // Sandbox: aplikativne granice za alate i MCP podprocese
  const sandboxCfg = config.tools?.sandbox ?? {};
  const sandbox = overrides.sandbox ?? createSandbox({
    level: sandboxCfg.level ?? 'restricted',
    networkAllowlist: sandboxCfg.networkAllowlist ?? config.env.httpAllowlist ?? [],
    fsReadRoots: [config.root, config.dataDir],
    fsWriteRoots: [config.dataDir],
    envAllowlist: sandboxCfg.envAllowlist ?? [],
    maxMemoryMb: sandboxCfg.maxMemoryMb ?? 256,
    maxTimeoutMs: sandboxCfg.maxTimeoutMs ?? 20_000,
    allowChildProcess: sandboxCfg.allowChildProcess !== false,
    production: isProduction,
    logger,
  });

  const policyResolver = (tenantId, { agentId } = {}) => resolvePolicy(config.policies, tenantId ?? config.env.defaultTenant, { agentId });

  // Trajno skladište poslova mora postojati prije alata (alat `process_update` ga koristi)
  const jobs = overrides.jobs ?? createJobStore({ dataDir: config.dataDir, logger });
  // Warm-up: poslije restarta scheduler mora odmah vidjeti poslove svih tenanta
  // (bez ovoga bi prvi tick bio prazan dok se tenant ne učita kroz neki drugi poziv)
  if (jobs.load) {
    for (const t of config.tenants) await jobs.load(t.id).catch((err) => logger.warn('jobs.warmup_failed', { tenant: t.id, error: err.message }));
  }

  const tools = createToolRegistry({ logger, metrics, audit, policyResolver });
  registerBuiltinTools(tools, { dataDir: config.dataDir, memory, env: config.env, logger, metrics, sandbox, jobs });

  const robot = { version: VERSION, startedAt: new Date().toISOString(), bus };

  const mcp = createMcpManager({ registry: tools, logger, metrics, root, sandbox });
  const shouldConnect = connectMcp ?? config.env.mcpAutoConnect ?? true;
  let mcpReport = [];
  if (shouldConnect) mcpReport = await mcp.connectAll(config.tools.mcpServers ?? []);

  const { runAgent } = createAgentRunner({ config, llm, tools, memory, tracer, cost, metrics, logger, policyResolver });
  // Svi LLM pozivi van agenata (planer, sinteza, kritičar) idu kroz helpers.callLlm → budžet + trošak + span.
  const patternHelpers = createPatternHelpers({ llm, cost, tracer, logger, metrics });
  const critic = createCritic({ llm, logger, metrics, callLlm: patternHelpers.callLlm });
  const router = createRouter({ catalog, llm, embedder: memory.embedder, logger, metrics });

  // Control plane (OCE-stil): verzije agenata, per-agent identitet i mjesečni budžet
  const controlPlane = overrides.controlPlane ?? createControlPlane({ config, catalog, dataDir: config.dataDir, logger, metrics, audit, cost, tenants, env: config.env });
  await controlPlane.load();
  for (const tenant of config.tenants) {
    for (const [agentId, budget] of Object.entries(tenant.agentBudgets ?? {})) {
      const current = controlPlane.get(tenant.id, agentId);
      if (current.budgetUsdMonth === null || current.budgetUsdMonth === undefined) await controlPlane.setBudget(tenant.id, agentId, budget);
    }
  }

  const orchestrator = createOrchestrator({
    config,
    catalog,
    runAgent,
    tools,
    tracer,
    cost,
    metrics,
    logger,
    policyResolver,
    router,
    critic,
    llm,
    memory,
    sandbox,
    controlPlane,
    helpers: patternHelpers,
  });

  Object.assign(robot, {
    config,
    logger,
    metrics,
    tracer,
    audit,
    cost,
    llm,
    memory,
    catalog,
    tools,
    mcp,
    mcpReport,
    tenants,
    policyResolver,
    runAgent,
    critic,
    router,
    orchestrator,
    sandbox,
    jobs,
    controlPlane,
    otel,
    overrides,
  });

  // Scheduler: persistentni poslovi i event triggeri (može se ugasiti sa NMQ_SCHEDULER=0 ili overrides.scheduler=false)
  const schedulerEnabled = overrides.scheduler !== false && (config.env.scheduler ?? true);
  robot.scheduler = overrides.schedulerInstance ?? (schedulerEnabled ? createScheduler({ robot, store: jobs, logger, metrics, tickMs: config.env.schedulerTickMs ?? 1000 }) : null);

  robot.routes = [
    ...createRoutes({ robot, config, logger, metrics, tenants, dataDir: config.dataDir }),
    ...createAdminRoutes({ robot, config, tenants, logger, metrics }),
  ];
  // Gauge mora postojati i kad je nula — inače alert/panel ne vidi metriku
  for (const t of config.tenants) metrics.set('approvals_pending', { tenant: t.id }, 0);
  robot.server = createHttpServer({ routes: robot.routes, robot, logger, metrics, config, tenants });

  robot.listen = async ({ port = config.env.port, host = config.env.host } = {}) => {
    const addr = await httpListen(robot.server, { port, host });
    robot.address = addr;
    if (robot.scheduler && !robot.scheduler.isRunning()) robot.scheduler.start();
    logger.info('robot.listening', {
      url: `http://${host}:${addr.port}`,
      tenants: config.tenants.length,
      agents: catalog.size(),
      tools: tools.size(),
      scheduler: Boolean(robot.scheduler),
      sandbox: sandbox.level,
    });
    return addr;
  };

  robot.close = async () => {
    robot.scheduler?.stop?.();
    await mcp.closeAll().catch(() => {});
    await new Promise((resolve) => robot.server.close(() => resolve()));
    logger.info('robot.closed', {});
  };

  return robot;
}

export { loadConfig } from './core/config.js';
export { createLlm, createMockProvider, createOpenAiCompatibleProvider, wrapLlmProvider } from './llm/index.js';
export { createMemory } from './memory/index.js';
export { createEpisodicMemory } from './memory/episodic.js';
export { createToolRegistry } from './tools/registry.js';
export { registerBuiltinTools, evaluateMath, assertUrlAllowed } from './tools/builtin.js';
export { createOrchestrator, PATTERNS } from './orchestration/index.js';
export { DEFAULT_STAGES } from './orchestration/team.js';
export { createAgentRunner, buildSystemPrompt, allowsTool } from './agents/agent.js';
export { createTenantStore, ROLES } from './tenancy/store.js';
export { createScheduler } from './scheduler/index.js';
export { createJobStore } from './scheduler/store.js';
export { cronMatches, nextCronAt } from './scheduler/cron.js';
export { createControlPlane } from './controlplane/registry.js';
export { createSandbox, SANDBOX_LEVELS } from './core/sandbox.js';
export { createOtelExporter } from './observability/otel.js';
export { evaluate, resolvePolicy, redactPii, DECISIONS } from './core/policy.js';
export * from './core/errors.js';
