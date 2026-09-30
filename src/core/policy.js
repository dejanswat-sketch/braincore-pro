/**
 * Governance politike: allow / deny / require_approval.
 *
 * Politika se sastoji iz:
 *   defaults  — važi za sve tenantе
 *   tenants   — override po tenantu (deep merge nad defaults)
 *
 * Oblik (vidi config/policies.json):
 * {
 *   "defaults": {
 *     "tools": { "allow": ["*"], "deny": ["shell_exec"], "requireApproval": ["email_send"] },
 *     "agents": { "support": { "deny": ["payment_create"] } },
 *     "risk": { "high": "require_approval", "medium": "allow" },
 *     "pii": { "redact": ["card", "iban", "jmbg"] },
 *     "maxSteps": 12,
 *     "budget": { "runUsd": 0.5, "monthlyUsd": 50 },
 *     "rateLimitPerMin": 60,
 *     "businessHoursOnly": false
 *   }
 * }
 */
import { deepMerge } from './config-utils.js';
import { PolicyError, ApprovalRequiredError } from './errors.js';

export const DECISIONS = { ALLOW: 'allow', DENY: 'deny', APPROVAL: 'require_approval' };

/** Glob-lite: podržava '*' i prefiks 'crm:*'. */
export function matchesPattern(pattern, value) {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(value);
}

const matchesAny = (patterns = [], value) => patterns.some((p) => matchesPattern(p, value));

/** Spaja politiku tenantа nad default-ima. */
export function resolvePolicy(policies, tenantId, { agentId } = {}) {
  const base = policies?.defaults ?? {};
  const tenant = policies?.tenants?.[tenantId] ?? {};
  const merged = deepMerge(base, tenant);
  if (agentId && merged.agents?.[agentId]) merged.__agentOverride = merged.agents[agentId];
  return merged;
}

/**
 * Odlučuje smije li se akcija izvršiti.
 * @returns {{decision:'allow'|'deny'|'require_approval', reason:string, rule?:string}}
 */
export function evaluate(policy = {}, action = {}) {
  const { tool, agentId, riskLevel = 'low', args = {}, tenantId } = action;
  const p = policy;

  // 1) eksplicitna zabrana alata (globalna ili po agentu)
  const agentPolicy = p.agents?.[agentId] ?? p.__agentOverride ?? {};
  if (tool && matchesAny(agentPolicy.deny ?? [], tool)) {
    return { decision: DECISIONS.DENY, reason: `Alat "${tool}" je zabranjen za agenta "${agentId}"`, rule: `agents.${agentId}.deny` };
  }
  if (tool && matchesAny(p.tools?.deny ?? [], tool)) {
    return { decision: DECISIONS.DENY, reason: `Alat "${tool}" je globalno zabranjen`, rule: 'tools.deny' };
  }

  // 2) allow lista (ako postoji i nije '*')
  const allow = [...(p.tools?.allow ?? ['*']), ...(agentPolicy.allow ?? [])];
  if (tool && !matchesAny(allow, tool)) {
    return { decision: DECISIONS.DENY, reason: `Alat "${tool}" nije na allow listi`, rule: 'tools.allow' };
  }

  // 3) radno vrijeme
  if (p.businessHoursOnly) {
    const hour = new Date().getHours();
    if (hour < 8 || hour >= 20) {
      return { decision: DECISIONS.DENY, reason: 'Agent radi samo u radno vrijeme (08-20)', rule: 'businessHoursOnly' };
    }
  }

  // 4) eksplicitno odobrenje (po alatu ili agentu)
  if (tool && matchesAny(agentPolicy.requireApproval ?? [], tool)) {
    return { decision: DECISIONS.APPROVAL, reason: `Alat "${tool}" zahtijeva odobrenje (agent)`, rule: `agents.${agentId}.requireApproval` };
  }
  if (tool && matchesAny(p.tools?.requireApproval ?? [], tool)) {
    return { decision: DECISIONS.APPROVAL, reason: `Alat "${tool}" zahtijeva odobrenje`, rule: 'tools.requireApproval' };
  }

  // 5) nivo rizika
  const riskRule = p.risk?.[riskLevel];
  if (riskRule === 'deny') return { decision: DECISIONS.DENY, reason: `Rizik "${riskLevel}" nije dozvoljen`, rule: `risk.${riskLevel}` };
  if (riskRule === 'require_approval') {
    return { decision: DECISIONS.APPROVAL, reason: `Rizik "${riskLevel}" zahtijeva odobrenje`, rule: `risk.${riskLevel}` };
  }

  // 6) dodatni uslovi po alatu (npr. limit iznosa)
  const condition = p.tools?.conditions?.[tool];
  if (condition?.maxAmountUsd !== undefined && Number(args.amountUsd ?? 0) > condition.maxAmountUsd) {
    return {
      decision: DECISIONS.APPROVAL,
      reason: `Iznos ${args.amountUsd} USD prelazi limit ${condition.maxAmountUsd} USD`,
      rule: `tools.conditions.${tool}.maxAmountUsd`,
    };
  }

  return { decision: DECISIONS.ALLOW, reason: 'dozvoljeno', rule: 'default' };
}

/** evaluate + bacanje greške (za upotrebu u tool registry-ju). */
export function assertAllowed(policy, action) {
  const verdict = evaluate(policy, action);
  if (verdict.decision === DECISIONS.DENY) {
    throw new PolicyError(verdict.reason, { tool: action.tool, agentId: action.agentId, rule: verdict.rule });
  }
  if (verdict.decision === DECISIONS.APPROVAL) {
    throw new ApprovalRequiredError(verdict.reason, { tool: action.tool, agentId: action.agentId, rule: verdict.rule });
  }
  return verdict;
}

/** Redakcija PII u tekstu prije logovanja/embedovanja. */
const PII_RULES = {
  email: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g,
  phone: /\+?\d[\d\s/()-]{7,}\d/g,
  card: /\b(?:\d[ -]?){13,19}\b/g,
  iban: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g,
  jmbg: /\b\d{13}\b/g,
};

export function redactPii(text, kinds = ['email', 'card', 'iban', 'jmbg']) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const kind of kinds) {
    const re = PII_RULES[kind];
    if (re) out = out.replace(re, `[${kind.toUpperCase()}_REDACTED]`);
  }
  return out;
}
