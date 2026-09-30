/**
 * Katalog agenata: čita definicije iz config/agents/*.json.
 * Novi agent = novi JSON fajl. Nema izmjene koda.
 */
export function createAgentCatalog(config, logger) {
  const byId = new Map();
  const agents = config.agents ?? [];

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
      ragK: spec.ragK,
      routingHints: (spec.routingHints ?? []).map((h) => h.toLowerCase()),
      patternConfig: spec.patternConfig ?? {},
      escalation: spec.escalation ?? null,
      kpi: spec.kpi ?? [],
    };
    byId.set(normalized.id, normalized);
    for (const alias of normalized.aliases) byId.set(alias, normalized);
  }

  return {
    all: () => agents.map((a) => byId.get(a.id)),
    get: (id) => byId.get(id) ?? null,
    has: (id) => byId.has(id),
    ids: () => [...new Set([...byId.values()].map((a) => a.id))],
    byDomain: (domain) => [...new Set([...byId.values()])].filter((a) => a.domain === domain),
    /** Za LLM prompt rutera: kratak spisak bez tajni. */
    routingTable: () =>
      [...new Set([...byId.values()])].map((a) => ({
        id: a.id,
        name: a.name,
        domain: a.domain,
        description: a.description,
        hints: a.routingHints,
      })),
    size: () => new Set([...byId.values()].map((a) => a.id)).size,
    logger,
  };
}
