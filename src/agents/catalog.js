/**
 * Katalog agenata: čita definicije iz config/agents/*.json.
 * Novi agent = novi JSON fajl. Nema izmjene koda.
 *
 * Control plane može u toku rada da primijeni `overrides` (deploy nove verzije / rollback)
 * bez restarta — `get()` i `all()` uvijek vraćaju efektivnu verziju.
 */
export function createAgentCatalog(config, logger) {
  const byId = new Map();
  const agents = config.agents ?? [];
  const overrides = new Map(); // canonicalId -> patch

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
  const effective = (base) => {
    const patch = overrides.get(base.id);
    return patch ? { ...base, ...patch } : base;
  };

  return {
    all: () => agents.map((a) => effective(byId.get(a.id))),
    get: (id) => {
      const base = byId.get(id);
      return base ? effective(base) : null;
    },
    has: (id) => byId.has(id),
    ids: () => [...new Set([...byId.values()].map((a) => a.id))],
    byDomain: (domain) => [...new Set([...byId.values()])].filter((a) => a.domain === domain).map(effective),
    /** Za LLM prompt rutera: kratak spisak bez tajni. */
    routingTable: () =>
      [...new Set([...byId.values()])].map(effective).map((a) => ({
        id: a.id,
        name: a.name,
        domain: a.domain,
        description: a.description,
        hints: a.routingHints,
      })),
    size: () => new Set([...byId.values()].map((a) => a.id)).size,

    /** Control plane: primijeni zakrpu na agenta u toku rada. */
    setOverride(id, patch) {
      const cid = canonical(id) ?? id;
      const base = byId.get(cid);
      if (!base) return null;
      const merged = { ...(overrides.get(cid) ?? {}), ...patch };
      overrides.set(cid, merged);
      logger?.info?.('catalog.override_applied', { agentId: cid, keys: Object.keys(patch) });
      return this.get(cid);
    },
    clearOverride(id) {
      const cid = canonical(id) ?? id;
      const had = overrides.delete(cid);
      logger?.info?.('catalog.override_cleared', { agentId: cid, had });
      return had;
    },
    overrides: () => Object.fromEntries(overrides),
    effectivePatch: (id) => overrides.get(canonical(id) ?? id) ?? null,
    logger,
  };
}
