/**
 * A2A (agent-to-agent) — agent card.
 *
 * Karta opisuje šta naš agent umije, kako se autentifikuje i koje skillove izlaže.
 * Objavljuje se na `/.well-known/agent.json`, pa ga drugi agenti (ili A2A klijenti) mogu otkriti.
 * Format prati ideju A2A protokola (agent card + tasks), bez vezivanja za konkretnu biblioteku.
 */
export function buildAgentCard({ robot, tenantId, baseUrl, includeSkills = true } = {}) {
  const cat = robot.catalog?.view ? robot.catalog.view(tenantId) : robot.catalog;
  const agents = (cat?.all?.() ?? []).filter((a) => a.domain !== 'core' || ['researcher', 'critic', 'planner'].includes(a.id));
  const tenant = robot.config?.tenant?.(tenantId);

  return {
    protocolVersion: '1.0',
    name: `NMQ Robot — ${tenant?.name ?? tenantId}`,
    description:
      'Univerzalni AI agent: support, prodaja, operacije, finansije, HR, dev, podaci, e-trgovina, pravno i kreativa. ' +
      'Izvodi akcije kroz alate (MCP), uz politike, budžete i dokazivi audit trag.',
    url: `${baseUrl ?? ''}/a2a`,
    version: robot.version,
    provider: { organization: 'NMQ — Dejan Milošević PR', url: baseUrl ?? '' },
    tenantId,
    capabilities: {
      streaming: true, // GET /a2a/tasks/:id/events (SSE)
      pushNotifications: false, // planirano
      stateTransitionHistory: true,
      negotiation: true, // /a2a/negotiations
      settlement: true, // interni ledger (simulirano; Stripe/x402 planirano)
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    authentication: {
      schemes: ['bearer'],
      note: 'API ključ tenanta (Authorization: Bearer) ili per-agent ključ (nmqa_…)',
    },
    limits: {
      rateLimitPerMin: tenant?.rateLimitPerMin ?? robot.config?.env?.rateLimitPerMin ?? 60,
      monthlyBudgetUsd: tenant?.budget?.monthlyUsd ?? null,
      autonomyDefault: robot.autonomy?.levelOf(tenantId, '*') ?? 'L1',
    },
    skills: includeSkills
      ? agents.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          domain: a.domain,
          tags: a.routingHints?.slice(0, 8) ?? [],
          defaultPattern: a.defaultPattern,
          examples: a.kpi ?? [],
        }))
      : [],
  };
}
