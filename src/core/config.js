import path from 'node:path';
import { readJson, listFiles, stripSecrets } from './fsx.js';
import { deepMerge, parseBool, parseNumber, parseList } from './config-utils.js';

/** Env sloj (najniži prioritet posle fajlova). */
export function envConfig(env = process.env) {
  return {
    port: parseNumber(env.NMQ_PORT, 8787),
    host: env.NMQ_HOST || '127.0.0.1',
    publicUrl: env.NMQ_PUBLIC_URL || `http://${env.NMQ_HOST || '127.0.0.1'}:${parseNumber(env.NMQ_PORT, 8787)}`,
    dataDir: env.NMQ_DATA_DIR || './data',
    logLevel: env.NMQ_LOG_LEVEL || 'info',
    nodeEnv: env.NODE_ENV || '',
    nmqEnv: env.NMQ_ENV || '',
    defaultTenant: env.NMQ_DEFAULT_TENANT || 'nmq',
    allowAnonymous: parseBool(env.NMQ_ALLOW_ANONYMOUS, true),
    masterKey: env.NMQ_MASTER_KEY || '',
    httpAllowlist: parseList(env.NMQ_HTTP_ALLOWLIST, { separator: ',' }),
    maxSteps: parseNumber(env.NMQ_MAX_STEPS, 12),
    maxTokens: parseNumber(env.NMQ_MAX_TOKENS, 0) || null, // null = bez tvrdog limita tokena
    cluster: env.NMQ_CLUSTER === '1' || env.NMQ_CLUSTER === 'true',
    clusterPort: parseNumber(env.NMQ_CLUSTER_PORT, 0),
    clusterSecret: env.NMQ_CLUSTER_SECRET ?? null, // nikad se ne upisuje u config fajl
    redisUrl: env.NMQ_REDIS_URL ?? null,
    rateLimitPerMin: parseNumber(env.NMQ_RATE_LIMIT_PER_MIN, 60),
    /** Persistentni agenti: scheduler i OTel izvoz */
    scheduler: parseBool(env.NMQ_SCHEDULER, true),
    schedulerTickMs: parseNumber(env.NMQ_SCHEDULER_TICK_MS, 1000),
    watchersTickMs: parseNumber(env.NMQ_WATCHERS_TICK_MS, 60000),
    otelFile: parseBool(env.NMQ_OTEL_FILE, true),
    otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || '',
    otelHeaders: safeJson(env.NMQ_OTEL_HEADERS, {}),
    budget: {
      monthlyUsd: parseNumber(env.NMQ_BUDGET_MONTHLY_USD, 50),
      runUsd: parseNumber(env.NMQ_BUDGET_RUN_USD, 0.5),
    },
    llm: {
      provider: env.NMQ_LLM_PROVIDER || 'openai-compatible',
      baseUrl: env.NMQ_LLM_BASE_URL || 'https://api.deepseek.com/v1',
      model: env.NMQ_LLM_MODEL || 'deepseek-chat',
      fastModel: env.NMQ_LLM_FAST_MODEL || env.NMQ_LLM_MODEL || 'deepseek-chat',
      embedModel: env.NMQ_LLM_EMBED_MODEL || '',
      apiKey: env.NMQ_LLM_API_KEY || env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || '',
      timeoutMs: parseNumber(env.NMQ_LLM_TIMEOUT_MS, 60_000),
      maxRetries: parseNumber(env.NMQ_LLM_MAX_RETRIES, 2),
      fallbacks: safeJson(env.NMQ_LLM_FALLBACKS, []),
    },
  };
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Učitava cijelu konfiguraciju: env + config/*.json + config/agents/*.json.
 * Prioritet: env (server/LLM) > fajlovi (agenti, politike, tenanti) > ugrađeni default-i.
 */
export async function loadConfig({ root = process.cwd(), env = process.env, dataDir } = {}) {
  const envCfg = envConfig(env);
  const configDir = path.join(root, 'config');

  const agentFiles = await listFiles(path.join(configDir, 'agents'), (n) => n.endsWith('.json'));
  const agents = [];
  for (const file of agentFiles.sort()) agents.push(await readJson(file));

  const tools = await readJson(path.join(configDir, 'tools.json'), { builtin: {}, mcpServers: [] });
  const policies = await readJson(path.join(configDir, 'policies.json'), { defaults: {}, tenants: {} });
  const tenantsFile = await readJson(path.join(configDir, 'tenants.json'), { tenants: [] });
  const company = await readJson(path.join(configDir, 'company.json'), { roles: [] });
  const watchers = await readJson(path.join(configDir, 'watchers.json'), { rules: [] });
  const autonomy = await readJson(path.join(configDir, 'autonomy.json'), { default: 'L1', tenants: {} });
  const swarm = await readJson(path.join(configDir, 'swarm.json'), { defaultIsolation: 'contained', quotas: {}, safety: {}, tenants: {} });
  const rsiConfig = await readJson(path.join(configDir, 'rsi.json'), { defaultLevel: 'R1', autoMetaPromote: false, tenants: {} });
  const evolutionConfig = await readJson(path.join(configDir, 'evolution.json'), { populationSize: 6, generations: 3, autoPromote: false });
  const cluster = await readJson(path.join(configDir, 'cluster.json'), { enabled: false, peers: [], store: {}, gossip: {} });

  const resolvedDataDir = path.resolve(root, dataDir ?? envCfg.dataDir);

  const cfg = {
    root,
    configDir,
    env: envCfg,
    dataDir: resolvedDataDir,
    agents,
    tools,
    policies,
    company,
    watchers,
    autonomy,
    swarm,
    rsi: rsiConfig,
    evolution: evolutionConfig,
    cluster,
    tenants: tenantsFile.tenants ?? [],
    requireAuth: parseBool(tenantsFile.requireAuth, false),

    tenant(id) {
      const t = cfg.tenants.find((x) => x.id === id);
      if (!t) return null;
      return {
        ...t,
        budget: deepMerge(envCfg.budget, t.budget ?? {}),
        maxSteps: t.maxSteps ?? envCfg.maxSteps,
        rateLimitPerMin: t.rateLimitPerMin ?? envCfg.rateLimitPerMin,
        path: path.join(resolvedDataDir, 'tenants', t.id),
      };
    },

    agent(id) {
      return cfg.agents.find((a) => a.id === id || (a.aliases ?? []).includes(id)) ?? null;
    },

    /** Konfiguracija bez tajni — bezbjedna za API odgovor. */
    publicConfig() {
      return {
        dataDir: stripSecrets(resolvedDataDir),
        defaultTenant: envCfg.defaultTenant,
        requireAuth: cfg.requireAuth,
        llm: { provider: envCfg.llm.provider, model: envCfg.llm.model, embedModel: envCfg.llm.embedModel || null },
        agents: cfg.agents.map((a) => ({
          id: a.id,
          name: a.name,
          domain: a.domain,
          description: a.description,
          defaultPattern: a.defaultPattern,
          tools: a.tools,
          riskLevel: a.riskLevel ?? 'low',
        })),
        mcpServers: (tools.mcpServers ?? []).map((s) => ({ id: s.id, transport: s.transport, enabled: s.enabled !== false })),
        tenants: cfg.tenants.map((t) => ({ id: t.id, name: t.name, plan: t.plan })),
      };
    },
  };

  return cfg;
}
