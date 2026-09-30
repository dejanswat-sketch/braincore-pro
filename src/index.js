/**
 * NMQ Robot — javni ulaz u sistem.
 * Ovdje se spajaju svi slojevi: config → llm → memory → tools/MCP → agenti → orchestracija → server.
 */
import { loadConfig } from './core/config.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createSwarmNode } from './node.js';
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
import { createTicketRouter } from './support/ticket-router.js';
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
import { createAutonomy } from './core/autonomy.js';
import { deepMerge } from './core/config-utils.js';
import { createBus } from './core/events.js';
import { createJobStore } from './scheduler/store.js';
import { createScheduler } from './scheduler/index.js';
import { createControlPlane } from './controlplane/registry.js';
import { createOtelExporter } from './observability/otel.js';
import { createPolicyOverrides } from './learning/policy-overrides.js';
import { createRewardModel } from './learning/rewards.js';
import { createImprovementEngine } from './learning/improvements.js';
import { createSelfPlay } from './learning/selfplay.js';
import { createRsi } from './learning/rsi.js';
import { createGoalManager } from './goals/manager.js';
import { createWatchers } from './goals/watchers.js';
import { createCompany } from './org/company.js';
import { createA2ATasks } from './a2a/tasks.js';
import { createSettlement, createNegotiator } from './a2a/negotiation.js';
import { createAutonomyRoutes } from './server/routes-autonomy.js';
import { createEvalHarness } from './eval/harness.js';
import { createSwarmRoutes } from './server/routes-swarm.js';
import { createClusterRoutes } from './server/routes-cluster.js';
import { createClusterNode } from './cluster/node.js';
import { createBlackboard } from './swarm/blackboard.js';
import { createSwarmGovernance } from './swarm/governance.js';
import { createSwarmSafety } from './swarm/safety.js';
import { createSwarm } from './swarm/swarm.js';
import { createEvolution } from './evolution/genome.js';
import { createMetaRsi } from './rsi/meta.js';

export const VERSION = '1.2.0';

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

  const policyOverrides = overrides.policyOverrides ?? createPolicyOverrides({ dataDir: config.dataDir, logger });
  const policyResolver = (tenantId, { agentId } = {}) => {
    const t = tenantId ?? config.env.defaultTenant;
    const base = resolvePolicy(config.policies, t, { agentId });
    const extra = policyOverrides.activeSync(t);
    return extra && Object.keys(extra).length ? deepMerge(base, extra) : base;
  };

  // Autonomija: koliko agent smije sam (L0-L4) — centralna brava za sve proaktivne akcije
  const autonomy = overrides.autonomy ?? createAutonomy({ config: config.autonomy ?? {}, dataDir: config.dataDir, logger, metrics, audit });
  await autonomy.load(); // perzistirane promjene imaju prioritet nad config-om
  for (const [tenantId, levels] of Object.entries(config.autonomy?.tenants ?? {})) {
    for (const [agentId, level] of Object.entries(levels)) {
      const id = agentId === '*' ? null : agentId;
      if (!autonomy.hasLevel(tenantId, id)) autonomy.setLevel(tenantId, id, level);
    }
  }

  // Reward model: jedna ocjena po run-u (feedback, odobrenja, ishod, trošak, greške)
  const rewards = overrides.rewards ?? createRewardModel({ dataDir: config.dataDir, logger, metrics, weights: config.autonomy?.rewardWeights });

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
    // Deterministička pravila za support tickete (refund→support, billing→finance, …) — nadjačavaju LLM router.
    // Uvedeno poslije prvog realnog evala: refund je bio routiran na `ecommerce` (docs/41 §5).
    ticketRouter: createTicketRouter({ catalog, logger, metrics, audit, tenantId: config?.defaultTenant ?? 'nmq' }),
  });

  // ── Autonomni nivo (v0.3): self-improvement, ciljevi, organizacija, A2A ──
  const improvements = overrides.improvements ?? createImprovementEngine({
    dataDir: config.dataDir,
    logger,
    metrics,
    audit,
    rewards,
    controlPlane,
    policyOverrides,
    autonomy,
    orchestrator,
    memory,
    catalog,
    helpers: patternHelpers,
  });

  // Scheduler: persistentni poslovi i event triggeri (može se ugasiti sa NMQ_SCHEDULER=0 ili overrides.scheduler=false)
  const schedulerEnabled = overrides.scheduler !== false && (config.env.scheduler ?? true);
  const scheduler = overrides.schedulerInstance ?? (schedulerEnabled ? createScheduler({ robot, store: jobs, logger, metrics, tickMs: config.env.schedulerTickMs ?? 1000 }) : null);

  const goals = overrides.goals ?? createGoalManager({
    dataDir: config.dataDir,
    llm,
    catalog,
    scheduler,
    controlPlane,
    cost,
    logger,
    metrics,
    audit,
    helpers: patternHelpers,
  });

  const selfplay = createSelfPlay({ dataDir: config.dataDir, logger, metrics, audit, catalog, runAgent, critic, helpers: patternHelpers, rewards, improvements });
  const rsi = createRsi({ logger, metrics, audit, rewards, improvements, goals, tracer, catalog, cost, autonomy, memory });
  const company = createCompany({ config: config.company ?? {}, dataDir: config.dataDir, logger, metrics, audit, catalog, goals, rewards, controlPlane, autonomy, improvements, helpers: patternHelpers, cost });
  const watchers = createWatchers({
    config: config.watchers ?? {},
    dataDir: config.dataDir,
    metrics,
    logger,
    audit,
    goals,
    rewards,
    createProposal: (tenantId, spec) => improvements.createProposal(tenantId, spec),
    orchestrator,
    autonomy,
  });

  const settlement = createSettlement({ dataDir: config.dataDir, logger, metrics, audit });
  const negotiator = createNegotiator({
    dataDir: config.dataDir,
    logger,
    metrics,
    audit,
    settlement,
    autonomy,
    improvements,
    defaultConstraints: { maxAmountUsd: 5000, requireHumanAboveUsd: 250, maxRounds: 5 },
  });
  const a2a = createA2ATasks({ dataDir: config.dataDir, logger, metrics, audit, orchestrator, bus, autonomy });
  const evalHarness = overrides.eval ?? createEvalHarness({ dataDir: config.dataDir, root, logger, metrics, audit, orchestrator, tracer });

  // ── v0.4: swarm (decentralizovani roj) + governance + safety ──────────────
  const blackboard = overrides.blackboard ?? createBlackboard({ dataDir: config.dataDir, logger, metrics });
  const swarmGovernance = overrides.swarmGovernance ?? createSwarmGovernance({ config: config.swarm ?? {}, dataDir: config.dataDir, logger, metrics, audit, autonomy });
  await swarmGovernance.load();
  for (const [tenantId, tc] of Object.entries(config.swarm?.tenants ?? {})) {
    if (tc?.isolation && !swarmGovernance.state?.isolation?.[tenantId]) await swarmGovernance.setIsolation(tenantId, tc.isolation, { by: 'config' });
    if (tc?.quotas) await swarmGovernance.setQuotas(tenantId, tc.quotas, { by: 'config' });
  }
  blackboard.setGuard?.((tenantId, openCount) => swarmGovernance.assertTaskQuota(tenantId, openCount));

  // ── v0.5: cross-node klaster (gossip + zajednička tabla) ──────────────────
  const clusterEnabled = Boolean(overrides.cluster) || config.env.cluster || config.cluster?.enabled;
  const clusterSecret = config.env.clusterSecret ?? process.env.NMQ_CLUSTER_SECRET ?? overrides.clusterSecret ?? null;
  if (clusterEnabled && !clusterSecret && !overrides.cluster) {
    // Fail-closed: bez tajne svaki čvor bi mogao da se lažno predstavi u mreži
    throw new Error('Klaster je uključen ali NMQ_CLUSTER_SECRET nije postavljen (fail-closed: bez potpisa nema klaster poruka)');
  }
  const cluster =
    overrides.cluster ??
    (clusterEnabled
      ? await createClusterNode({
          config: {
            ...(config.cluster ?? {}),
            secret: clusterSecret,
            store: { ...(config.cluster?.store ?? {}), redisUrl: config.env.redisUrl ?? config.cluster?.store?.redisUrl ?? null },
          },
          dataDir: config.dataDir,
          logger,
          metrics,
          audit,
          bus,
          host: config.cluster?.host ?? '127.0.0.1',
          port: config.env.clusterPort ?? config.cluster?.port ?? 0,
        })
      : null);

  const swarmSafety =
    overrides.swarmSafety ??
    createSwarmSafety({
      config: config.swarm ?? {},
      dataDir: config.dataDir,
      logger,
      metrics,
      audit,
      bus,
      governance: swarmGovernance,
      blackboard,
      // spoofing zaštita: pošiljalac je registrovan worker ILI POZNAT član klastera (`node:<id>`)
      isKnownWorker: (id) => {
        if (robot?.swarm?.workers?.has?.(id)) return true;
        if (typeof id === 'string' && id.startsWith('node:') && cluster) return cluster.isKnownNode(id.slice(5));
        return false;
      },
    });
  await swarmSafety.load();
  const swarm = overrides.swarm ?? createSwarm({ config: config.swarm ?? {}, blackboard, governance: swarmGovernance, safety: swarmSafety, orchestrator, catalog, autonomy, rewards, audit, metrics, logger });
  if (cluster) {
    cluster.attach({ swarm, safety: swarmSafety, governance: swarmGovernance, blackboard, orchestrator, catalog, rewards, audit });
    if (clusterEnabled) await cluster.start();
  }
  // Interne rute swarm-a (tick/run) takođe prolaze kroz governance: zaključavamo mrežu u sandboxu kad je contained
  const swarmWorkersSeed = config.swarm?.workers ?? null;

  // ── v0.4: evolucija agenata + RSI meta-nivoi ──────────────────────────────
  const evolutionEngine = overrides.evolution ?? createEvolution({ config: config.evolution ?? {}, dataDir: config.dataDir, logger, metrics, audit, evalHarness, improvements, controlPlane, catalog, safety: swarmSafety });
  const metaRsi = overrides.metaRsi ?? createMetaRsi({ config: config.rsi ?? {}, dataDir: config.dataDir, logger, metrics, audit, autonomy, improvements, evalHarness, evolution: evolutionEngine, selfplay, rewards, goals, catalog });
  for (const [tenantId, level] of Object.entries(config.rsi?.tenants ?? {})) {
    const current = await metaRsi.level(tenantId);
    if (current.level !== level && !current.changedBy) {
      await metaRsi.setLevel(tenantId, level, { by: 'config', reason: 'inicijalni nivo iz config/rsi.json' }).catch((err) => logger?.warn?.('rsi.seed_failed', { tenantId, level, error: err.message }));
    }
  }

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
    policyOverrides,
    runAgent,
    critic,
    router,
    orchestrator,
    sandbox,
    jobs,
    controlPlane,
    otel,
    autonomy,
    rewards,
    improvements,
    selfplay,
    rsi,
    goals,
    company,
    watchers,
    settlement,
    negotiator,
    a2a,
    eval: evalHarness,
    swarm,
    blackboard,
    swarmGovernance,
    swarmSafety,
    evolution: evolutionEngine,
    metaRsi,
    cluster,
    swarmWorkersSeed,
    overrides,
    scheduler,
  });

  /**
   * Zapisuje ishod run-a u reward model (+ A/B mjerenje). Zovu ga rute poslije svakog izvršavanja.
   */
  robot.recordRunOutcome = async ({ tenantId, result, variant = null, experimentId = null, feedback = null, approval = null, jobId = null, goalId = null }) => {
    try {
      const steps = result?.result?.results?.[0]?.steps ?? result?.result?.steps ?? [];
      const toolErrors = steps.filter((s) => s.type === 'tool' && s.ok === false).length;
      const policyDenied = steps.filter((s) => s.code === 'POLICY_DENIED').length;
      const escalation = result?.handoffs?.length ?? 0;
      const record = await rewards.record(tenantId, {
        runId: result?.runId,
        agentId: result?.agentId,
        pattern: result?.pattern,
        variant,
        jobId,
        goalId,
        signals: {
          feedback,
          approval,
          outcome: result?.status === 'ok' ? 'ok' : result?.status === 'awaiting_approval' ? 'pending' : 'error',
          costUsd: result?.costUsd ?? 0,
          durationMs: result?.durationMs ?? 0,
          toolErrors,
          policyDenied,
          escalations: escalation,
        },
      });
      if (experimentId) await improvements.recordExperimentResult(tenantId, { experimentId, variant, reward: record.reward });
      return record;
    } catch (err) {
      logger?.warn?.('reward.record_failed', { tenantId, error: err.message });
      return null;
    }
  };

  // Događaji sa bus-a → watcheri (proaktivnost) i scheduler (poslovi koji slušaju)
  bus.on('hook.*', (env) => {
    watchers.onEvent(env.event, env.payload).catch((err) => logger?.warn?.('watchers.event_failed', { error: err.message }));
  });
  robot.watchersTimer = null;
  robot.startWatchers = (everyMs = config.env.watchersTickMs ?? 60_000) => {
    if (robot.watchersTimer || !(config.watchers?.rules ?? []).length) return false;
    robot.watchersTimer = setInterval(() => {
      watchers.tick(config.tenants.map((t) => t.id)).catch((err) => logger?.warn?.('watchers.tick_failed', { error: err.message }));
    }, everyMs);
    robot.watchersTimer.unref?.();
    logger.info('watchers.started', { everyMs, rules: config.watchers.rules.length });
    return true;
  };

  robot.routes = [
    ...createRoutes({ robot, config, logger, metrics, tenants, dataDir: config.dataDir }),
    ...createAdminRoutes({ robot, config, tenants, logger, metrics }),
    ...createAutonomyRoutes({ robot, config, tenants, logger, metrics }),
    ...createSwarmRoutes({ robot, config, tenants, logger, metrics }),
    ...createClusterRoutes({ robot, config, tenants, logger, metrics }),
  ];
  // Gauge mora postojati i kad je nula — inače alert/panel ne vidi metriku
  for (const t of config.tenants) metrics.set('approvals_pending', { tenant: t.id }, 0);
  robot.server = createHttpServer({ routes: robot.routes, robot, logger, metrics, config, tenants });

  robot.listen = async ({ port = config.env.port, host = config.env.host } = {}) => {
    const addr = await httpListen(robot.server, { port, host });
    robot.address = addr;
    if (robot.scheduler && !robot.scheduler.isRunning()) robot.scheduler.start();
    robot.startWatchers();
    logger.info('robot.listening', {
      url: `http://${host}:${addr.port}`,
      tenants: config.tenants.length,
      agents: catalog.size(),
      tools: tools.size(),
      scheduler: Boolean(robot.scheduler),
      sandbox: sandbox.level,
      watchers: (config.watchers?.rules ?? []).length,
      autonomy: config.autonomy?.default ?? 'L1',
    });
    return addr;
  };

  robot.close = async () => {
    robot.scheduler?.stop?.();
    if (robot.watchersTimer) clearInterval(robot.watchersTimer);
    // Klaster drži TCP server i (opciono) Redis vezu — moraju se zatvoriti da proces može da se ugasi
    await robot.cluster?.stop?.().catch(() => {});
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
export { createAutonomy, AUTONOMY_LEVELS, HUMAN_ONLY } from './core/autonomy.js';
export { createGoalManager } from './goals/manager.js';
export { createWatchers } from './goals/watchers.js';
export { createRewardModel } from './learning/rewards.js';
export { createImprovementEngine } from './learning/improvements.js';
export { createSelfPlay } from './learning/selfplay.js';
export { createRsi } from './learning/rsi.js';
export { createPolicyOverrides } from './learning/policy-overrides.js';
export { createCompany } from './org/company.js';
export { buildAgentCard } from './a2a/card.js';
export { createA2ATasks } from './a2a/tasks.js';
export { createSettlement, createNegotiator } from './a2a/negotiation.js';
export { createEvalHarness } from './eval/harness.js';
export { createBlackboard, PHEROMONE_TYPES } from './swarm/blackboard.js';
export { createSwarmGovernance, ISOLATION_LEVELS, DEFAULT_QUOTAS } from './swarm/governance.js';
export { createSwarmSafety, MESSAGE_TYPES } from './swarm/safety.js';
export { createSwarm } from './swarm/swarm.js';
export { createEvolution, MUTABLE_FIELDS, FORBIDDEN_FIELDS } from './evolution/genome.js';
export { createMetaRsi, RSI_LEVELS } from './rsi/meta.js';
export { createClusterNode } from './cluster/node.js';
export { createGossipNode, ALLOWED_MESSAGE_TYPES } from './cluster/gossip.js';
export { createFileStore, createRedisStore, createSharedStore } from './cluster/store.js';
export { createRedisClient, encodeCommand, parseReply } from './cluster/redis.js';
export { evaluate, resolvePolicy, redactPii, DECISIONS } from './core/policy.js';
export * from './core/errors.js';

// ── exporti slojeva po smernicama (poster → kod) ─────────────────────────────
export { createGossip, GOSSIP_DEFAULTS } from './gossip.js';
export { createRespClient, encodeCommand as encodeRespCommand, parseReply as parseRespReply } from './resp-client.js';
export { createCrdtBlackboard } from './shared/blackboard.js';
export { createPheromoneStore, PHEROMONE_DEFAULTS } from './shared/pheromone.js';
export { createTaskQueue, createNatsClient, TASK_DEFAULTS } from './shared/queue.js';
export { createTicketRouter } from './support/ticket-router.js';
export { createToolRunner } from './execution/tool-runner.js';
export { createExtractor } from './research/extractor.js';
export { createGenomeRegistry, ALLOWED_REPORT_FIELDS } from './research/genome-registry.js';
export { createFederationClient } from './research/federation.js';
export { createSwarmNode, createSupportCluster, createExecutionCluster, createResearchCluster, NODE_DEFAULTS } from './node.js';
// ── BRAINCORE PRO: clusters fasade, API sloj, live feed ──────────────────────
export { createSupportCluster as createSupportClusterFacade } from './clusters/support.js';
export { createResearchCluster as createResearchClusterFacade } from './clusters/research.js';
export { createExecutionCluster as createExecutionClusterFacade } from './clusters/execution.js';
export { createApiServer, API_DEFAULTS } from './api/server.js';
export { createKeyIssuer, verifyStripeSignature, signPayload, handleStripeWebhook } from './api/stripe.js';
export { attachWebSocket, encodeFrame, parseFrame, acceptKey } from './live/ws.js';
export { createLiveFeed } from './live/feed.js';
export { encryptPayload, decryptPayload, deriveKey } from './shared/crypto.js';

// ── CLI: `node src/index.js --port=8001 --peers=127.0.0.1:8002,...` ──────────
// Jedan proces = jedan node roja. Nema mastera; sve ide preko gossip-a i CRDT-a.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const hasPortArg = process.argv.some((a) => a === '--port' || a.startsWith('--port='));
if (isMain && hasPortArg) {
  const arg = (name, fallback = null) => {
    const withEq = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (withEq) return withEq.split('=').slice(1).join('=');
    const idx = process.argv.indexOf(`--${name}`);
    return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
  };
  const nodePort = Number(arg('port', 8001));
  const peers = String(arg('peers', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const secret = arg('secret', process.env.NMQ_CLUSTER_SECRET ?? 'genesis-local-dev-secret');
  const tenantId = arg('tenant', process.env.NMQ_DEFAULT_TENANT ?? 'nmq');
  const logLevel = arg('log', process.env.NMQ_LOG_LEVEL ?? 'info');
  const bootLogger = createLogger({ level: logLevel, service: `nmq-node-${nodePort}` });
  const node = await createSwarmNode({
    nodeId: arg('id', `node-${nodePort}`),
    port: nodePort,
    host: arg('host', '0.0.0.0'),
    advertiseHost: arg('advertise', '127.0.0.1'),
    peers,
    secret,
    tenantId,
    logger: bootLogger,
    runner: async (task) => ({ output: `node ${nodePort} obradio ${task.id}` }),
  });
  const started = await node.start();
  bootLogger.info('node.boot', { ...started, peers: peers.length });
  // Ispis u formatu iz smernica: „SYNCED in 1.2s, 3 peers alive"
  const peersAlive = node.stats().peersAlive;
  const humanMs = (started.syncMs / 1000).toFixed(1);
  // eslint-disable-next-line no-console
  console.log(`${started.synced ? 'SYNCED' : 'PARTIAL'} in ${humanMs}s, ${peersAlive + 1} nodes alive (udp :${started.port}, http :${started.httpPort}, tenant ${tenantId})`);

  // ── BRAINCORE PRO: javni API + live feed (api.braincore.pro / live.braincore.pro) ──
  // Pokreće se samo na jednom čvoru (nginx `api.` i `live.` pokazuju na njega).
  const apiPort = arg('api-port', null);
  let apiServer = null;
  if (apiPort) {
    const { createApiServer } = await import('./api/server.js');
    apiServer = await createApiServer({
      node,
      config: { port: Number(apiPort), dataDir: arg('data', process.env.NMQ_DATA_DIR ?? path.join(process.cwd(), 'data')) },
      logger: bootLogger,
      env: process.env,
    });
    const apiAddr = await apiServer.listen();
    // eslint-disable-next-line no-console
    console.log(`API on http://${apiAddr.host}:${apiAddr.port} · live /live · ws /events · zero npm`);
  }

  const shutdown = async () => {
    if (apiServer) await apiServer.close().catch(() => {});
    await node.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
