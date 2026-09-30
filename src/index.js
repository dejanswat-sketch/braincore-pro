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
import { createHttpServer, listen as httpListen } from './server/http.js';

export const VERSION = '0.1.0';

/**
 * Gradi kompletan robot. Testovi i skripte ga pozivaju sa `overrides` da zamijene LLM ili skladište.
 */
export async function createRobot({ root = process.cwd(), env = process.env, dataDir, overrides = {}, connectMcp = undefined } = {}) {
  const config = await loadConfig({ root, env, dataDir });
  const level = overrides.logLevel ?? config.env.logLevel;
  const logger = overrides.logger ?? createLogger({ level, sink: overrides.logSink });
  const metrics = overrides.metrics ?? createMetrics();
  const tracer = createTracer({ dataDir: config.dataDir, logger, metrics });
  const audit = createAuditLog({ dataDir: config.dataDir, logger });
  const cost = createCostTracker({ dataDir: config.dataDir, logger });
  const llm = overrides.llm ? wrapLlmProvider(overrides.llm, logger) : createLlm({ env: config.env, logger, metrics });
  const memory = overrides.memory ?? createMemory({ dataDir: config.dataDir, llm, env: config.env, logger });
  const catalog = createAgentCatalog(config, logger);
  const tenants = createTenantStore({ config, dataDir: config.dataDir, logger, env: config.env });
  await tenants.loadStatuses();

  const policyResolver = (tenantId, { agentId } = {}) => resolvePolicy(config.policies, tenantId ?? config.env.defaultTenant, { agentId });

  const tools = createToolRegistry({ logger, metrics, audit, policyResolver });
  registerBuiltinTools(tools, { dataDir: config.dataDir, memory, env: config.env, logger, metrics });

  const robot = { version: VERSION, startedAt: new Date().toISOString() };

  const mcp = createMcpManager({ registry: tools, logger, metrics, root });
  const shouldConnect = connectMcp ?? config.env.mcpAutoConnect ?? true;
  let mcpReport = [];
  if (shouldConnect) mcpReport = await mcp.connectAll(config.tools.mcpServers ?? []);

  const { runAgent } = createAgentRunner({ config, llm, tools, memory, tracer, cost, metrics, logger, policyResolver });
  // Svi LLM pozivi van agenata (planer, sinteza, kritičar) idu kroz helpers.callLlm → budžet + trošak + span.
  const patternHelpers = createPatternHelpers({ llm, cost, tracer, logger, metrics });
  const critic = createCritic({ llm, logger, metrics, callLlm: patternHelpers.callLlm });
  const router = createRouter({ catalog, llm, embedder: memory.embedder, logger, metrics });
  const orchestrator = createOrchestrator({ config, catalog, runAgent, tools, tracer, cost, metrics, logger, policyResolver, router, critic, llm, memory, helpers: patternHelpers });

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
    overrides,
  });

  robot.routes = createRoutes({ robot, config, logger, metrics, tenants, dataDir: config.dataDir });
  robot.server = createHttpServer({ routes: robot.routes, robot, logger, metrics, config, tenants });

  robot.listen = async ({ port = config.env.port, host = config.env.host } = {}) => {
    const addr = await httpListen(robot.server, { port, host });
    robot.address = addr;
    logger.info('robot.listening', { url: `http://${host}:${addr.port}`, tenants: config.tenants.length, agents: catalog.size(), tools: tools.size() });
    return addr;
  };

  robot.close = async () => {
    await mcp.closeAll().catch(() => {});
    await new Promise((resolve) => robot.server.close(() => resolve()));
    logger.info('robot.closed', {});
  };

  return robot;
}

export { loadConfig } from './core/config.js';
export { createLlm, createMockProvider, createOpenAiCompatibleProvider } from './llm/index.js';
export { createMemory } from './memory/index.js';
export { createToolRegistry } from './tools/registry.js';
export { registerBuiltinTools, evaluateMath, assertUrlAllowed } from './tools/builtin.js';
export { createOrchestrator, PATTERNS } from './orchestration/index.js';
export { createAgentRunner, buildSystemPrompt, allowsTool } from './agents/agent.js';
export { createTenantStore, ROLES } from './tenancy/store.js';
export { evaluate, resolvePolicy, redactPii, DECISIONS } from './core/policy.js';
export * from './core/errors.js';
