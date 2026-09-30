/**
 * Katalog agenata: čita definicije iz config/agents/*.json.
 * Novi agent = novi JSON fajl. Nema izmjene koda.
 *
 * Control plane može u toku rada da primijeni `overrides` (deploy nove verzije / rollback)
 * bez restarta — `get()` i `all()` uvijek vraćaju efektivnu verziju.
 *
 * ⚠️ Override-i su **po tenantu** (`tenantId::agentId`). Bez toga bi deploy za jednog klijenta
 * promijenio ponašanje agenta i kod drugog klijenta u istom procesu.
 */
export function createAgentCatalog(config, logger) {
  const byId = new Map();
  const agents = config.agents ?? [];
  const overrides = new Map(); // `${tenantId}::${agentId}` -> patch

  for (const spec of agents) {
    const normalized = {
      id: spec.id,
      name: spec.name ?? spec.id,
      domain: spec.domain ?? 'general',
      description: spec.description ?? '',
      systemPrompt: spec.systemPrompt ?? '',
      defaultPattern: spec.defaultPattern ?? 'agent',
      aliases: spec.aliases ?? [],
      tools: spec.tools ?? ['*'],
      toolScopes: spec.toolScopes ?? [],
      maxRisk: spec.maxRisk ?? 'high',
      maxSteps: spec.maxSteps,
      model: spec.model ?? 'default',
      temperature: spec.temperature ?? 0.2,
      maxTokens: spec.maxTokens ?? 900,
      useKnowledge: spec.useKnowledge !== false,
      episodic: spec.episodic !== false,
      ragK: spec.ragK,
      routingHints: (spec.routingHints ?? []).map((h) => h.toLowerCase()),
      patternConfig: spec.patternConfig ?? {},
      escalation: spec.escalation ?? null,
      kpi: spec.kpi ?? [],
    };
    byId.set(normalized.id, normalized);
    for (const alias of normalized.aliases) byId.set(alias, normalized);
  }

  const canonical = (id) => byId.get(id)?.id ?? null;
  const ovKey = (tenantId, agentId) => `${tenantId ?? '*'}::${agentId}`;

  const effective = (base, tenantId) => {
    const perTenant = overrides.get(ovKey(tenantId, base.id));
    const global = overrides.get(ovKey('*', base.id));
    if (!perTenant && !global) return base;
    return { ...base, ...(global ?? {}), ...(perTenant ?? {}) };
  };

  /** Zajedničke metode vezane za jedan tenant (koristi ih orchestration kroz `ctx.catalog`). */
  function view(tenantId) {
    return {
      tenantId,
      all: () => agents.map((a) => effective(byId.get(a.id), tenantId)),
      get: (id) => {
        const base = byId.get(id);
        return base ? effective(base, tenantId) : null;
      },
      has: (id) => byId.has(id),
      ids: () => [...new Set([...byId.values()].map((a) => a.id))],
      byDomain: (domain) => [...new Set([...byId.values()])].filter((a) => a.domain === domain).map((b) => effective(b, tenantId)),
      routingTable: () =>
        [...new Set([...byId.values()])].map((b) => effective(b, tenantId)).map((a) => ({ id: a.id, name: a.name, domain: a.domain, description: a.description, hints: a.routingHints })),
      size: () => new Set([...byId.values()].map((a) => a.id)).size,
      overrides: () => Object.fromEntries([...overrides].filter(([k]) => k.startsWith(`${tenantId ?? '*'}::`))),
      effectivePatch: (id) => overrides.get(ovKey(tenantId, canonical(id) ?? id)) ?? overrides.get(ovKey('*', canonical(id) ?? id)) ?? null,
    };
  }

  const api = {
    all: (tenantId) => view(tenantId).all(),
    get: (id, tenantId) => view(tenantId).get(id),
    has: (id) => byId.has(id),
    ids: () => view().ids(),
    byDomain: (domain, tenantId) => view(tenantId).byDomain(domain),
    routingTable: (tenantId) => view(tenantId).routingTable(),
    size: () => view().size(),
    view,

    /** Control plane: primijeni zakrpu na agenta ZA JEDAN TENANT, u toku rada. */
    setOverride(tenantId, id, patch) {
      const cid = canonical(id) ?? id;
      if (!byId.get(cid)) return null;
      const key = ovKey(tenantId, cid);
      const merged = { ...(overrides.get(key) ?? {}), ...patch };
      overrides.set(key, merged);
      logger?.info?.('catalog.override_applied', { tenantId: tenantId ?? '*', agentId: cid, keys: Object.keys(patch) });
      return api.get(cid, tenantId);
    },
    clearOverride(tenantId, id) {
      const cid = canonical(id) ?? id;
      const had = overrides.delete(ovKey(tenantId, cid));
      logger?.info?.('catalog.override_cleared', { tenantId: tenantId ?? '*', agentId: cid, had });
      return had;
    },
    overrides: () => Object.fromEntries(overrides),
    effectivePatch: (id, tenantId) => view(tenantId).effectivePatch(id),
    logger,
  };

  return api;
}
