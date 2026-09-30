/**
 * Proaktivni watcheri: agent sam primijeti priliku/problem i predloži (ili izvrši) akciju.
 *
 * Pravilo (config/watchers.json):
 * {
 *   "id": "tickets_rastu",
 *   "when": { "type": "metric", "metric": "support_tickets_open", "op": ">", "value": 40 },
 *   "then": { "kind": "propose", "agentId": "support", "input": "Otvoreno je {{value}} ticketa. Predloži 3 akcije." },
 *   "cooldownMs": 3600000, "maxPerDay": 3, "riskLevel": "low"
 * }
 *
 * Tipovi uslova: `metric` (mjerenja koja sistem upisuje), `goal_status` (cilj skrenuo),
 * `event` (događaj sa bus-a), `reward` (prosječna nagrada agenta ispod praga), `schedule` (periodično).
 *
 * Watcher NIKAD ne izvršava akciju visokog rizika — takve idu u inbox za odobrenje.
 */
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';

export function createWatchers({ config = {}, dataDir, metrics, logger, audit, goals, rewards, createProposal, orchestrator, autonomy, embedder }) {
  const rules = [...(config.rules ?? [])];
  const state = new Map(); // ruleId -> {lastRunAt, runsToday, day}
  const metricsStore = new Map(); // `${tenantId}::${metric}` -> [{ts, value}]

  const now = () => Date.now();
  const ruleKey = (tenantId, ruleId) => `${tenantId}::${ruleId}`;

  function canRun(tenantId, rule) {
    const key = ruleKey(tenantId, rule.id);
    const s = state.get(key) ?? { lastRunAt: 0, runsToday: 0, day: new Date().toISOString().slice(0, 10) };
    const today = new Date().toISOString().slice(0, 10);
    if (s.day !== today) {
      s.day = today;
      s.runsToday = 0;
    }
    if (now() - s.lastRunAt < (rule.cooldownMs ?? 3_600_000)) return false;
    if (rule.maxPerDay && s.runsToday >= rule.maxPerDay) return false;
    return true;
  }

  function markRun(tenantId, rule) {
    const key = ruleKey(tenantId, rule.id);
    const s = state.get(key) ?? { lastRunAt: 0, runsToday: 0, day: new Date().toISOString().slice(0, 10) };
    s.lastRunAt = now();
    s.runsToday += 1;
    state.set(key, s);
  }

  /** Upis mjerenja koje watcheri prate (npr. iz sistema, agenta ili webhook-a). */
  function recordMetric(tenantId, metric, value, meta = {}) {
    const key = `${tenantId}::${metric}`;
    const arr = metricsStore.get(key) ?? [];
    arr.push({ ts: iso(), value: Number(value), ...meta });
    metricsStore.set(key, arr.slice(-500));
    metrics?.set('watcher_metric', { tenant: tenantId, metric }, Number(value));
    return { tenantId, metric, value: Number(value) };
  }

  function latestMetric(tenantId, metric) {
    const arr = metricsStore.get(`${tenantId}::${metric}`);
    return arr?.at(-1)?.value ?? null;
  }

  const OPS = { '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '==': (a, b) => a === b, '!=': (a, b) => a !== b };

  async function evaluateCondition(tenantId, rule) {
    const when = rule.when ?? {};
    switch (when.type) {
      case 'metric': {
        const value = latestMetric(tenantId, when.metric);
        if (value === null) return { met: false, value: null, reason: `nema mjerenja za ${when.metric}` };
        const op = OPS[when.op ?? '>'];
        const met = op(value, Number(when.value));
        return { met, value, reason: `${when.metric}=${value} ${when.op ?? '>'} ${when.value} → ${met}` };
      }
      case 'goal_status': {
        if (!goals) return { met: false, reason: 'goal manager nije dostupan' };
        const portfolio = await goals.portfolio(tenantId);
        const hits = portfolio.goals.filter((g) => (when.statuses ?? ['at_risk', 'off_track']).includes(g.status) && (!when.owner || g.owner === when.owner));
        return { met: hits.length > 0, value: hits.length, reason: `${hits.length} ciljeva u statusu ${(when.statuses ?? ['at_risk', 'off_track']).join('/')}`, detail: hits.map((h) => ({ id: h.id, title: h.title, status: h.status, pct: h.progressPct })) };
      }
      case 'reward': {
        if (!rewards) return { met: false, reason: 'reward model nije dostupan' };
        const agg = await rewards.aggregate(tenantId, { groupBy: when.groupBy ?? 'agent', sinceMs: when.windowMs ?? 7 * 86_400_000 });
        const rows = Object.entries(agg).filter(([, v]) => v.n >= (when.minSamples ?? 5));
        const bad = rows.filter(([, v]) => v.avgReward < Number(when.below ?? 0.4));
        return { met: bad.length > 0, value: bad.length, reason: `${bad.length} grupa ispod praga ${when.below ?? 0.4}`, detail: bad.map(([k, v]) => ({ key: k, avgReward: v.avgReward, n: v.n })) };
      }
      case 'schedule': {
        const key = ruleKey(tenantId, rule.id);
        const s = state.get(key);
        const elapsed = now() - (s?.lastRunAt ?? 0);
        return { met: elapsed >= (when.everyMs ?? 86_400_000), value: Math.round(elapsed / 1000), reason: `proteklo ${Math.round(elapsed / 1000)}s` };
      }
      case 'event':
        // Događajni watcheri se pozivaju kroz `onEvent`, ne u tick-u
        return { met: false, reason: 'event rule se okida događajem' };
      default:
        return { met: false, reason: `nepoznat tip uslova: ${when.type}` };
    }
  }

  async function fire(tenantId, rule, condition, { reason = 'watcher' } = {}) {
    const then = rule.then ?? {};
    const input = String(then.input ?? then.inputTemplate ?? `Proaktivna provjera: ${rule.name ?? rule.id}`).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => {
      const val = k === 'value' ? condition.value : k === 'reason' ? condition.reason : condition.detail ? JSON.stringify(condition.detail) : m;
      return val === undefined ? m : String(val);
    });

    const decision = autonomy?.evaluate({ tenantId, agentId: then.agentId, riskLevel: then.riskLevel ?? 'low', kind: then.kind === 'run' ? 'act' : 'propose' }) ?? { action: 'require_approval', level: 'L0' };

    const record = {
      id: uid('wf'),
      ts: iso(),
      tenantId,
      ruleId: rule.id,
      ruleName: rule.name ?? rule.id,
      condition: { value: condition.value, reason: condition.reason, detail: condition.detail ?? null },
      decision,
      action: decision.action === 'allow' && then.kind === 'run' ? 'run' : 'propose',
      agentId: then.agentId ?? 'router',
      reason,
    };

    let result = null;
    if (record.action === 'run' && orchestrator) {
      try {
        result = await orchestrator.run({ tenantId, agentId: then.agentId ?? null, pattern: then.pattern, input, userId: `watcher:${rule.id}`, sessionId: `watcher_${rule.id}` });
        record.runId = result.runId;
        record.costUsd = result.costUsd;
      } catch (err) {
        record.error = err.message;
      }
    } else if (createProposal) {
      const proposal = await createProposal(tenantId, {
        kind: 'action',
        target: then.agentId ?? 'router',
        proposed: { input, pattern: then.pattern ?? null, riskLevel: then.riskLevel ?? 'low' },
        current: null,
        rationale: `Proaktivni watcher "${rule.name ?? rule.id}": ${condition.reason}`,
        evidence: [{ watcher: rule.id, condition: condition.reason, detail: condition.detail ?? null }],
        expectedImpact: then.expectedImpact ?? 'nepoznato',
        riskLevel: then.riskLevel ?? 'low',
        source: 'watcher',
      });
      record.proposalId = proposal.id;
    }

    markRun(tenantId, rule);
    metrics?.inc('watchers_fired_total', { tenant: tenantId, rule: rule.id, action: record.action });
    if (record.error) metrics?.inc('watchers_failed_total', { tenant: tenantId, rule: rule.id });
    logger?.info?.('watcher.fired', { tenantId, rule: rule.id, action: record.action, reason: condition.reason });
    await audit?.append({
      tenantId,
      actor: `watcher:${rule.id}`,
      action: 'watcher_fire',
      args: { ruleId: rule.id, action: record.action, condition: condition.reason },
      decision: decision.action,
      outcome: record.error ? 'error' : 'ok',
      runId: record.runId ?? null,
      meta: { level: decision.level, proposalId: record.proposalId ?? null },
    });
    return record;
  }

  /** Jedan prolaz kroz sva pravila (poziva ga scheduler ili ruta). */
  async function tick(tenantIds = []) {
    const fired = [];
    for (const tenantId of tenantIds) {
      const tenantRules = rules.filter((r) => !r.tenantId || r.tenantId === tenantId);
      for (const rule of tenantRules) {
        if (rule.enabled === false) continue;
        if (rule.when?.type === 'event') continue;
        if (!canRun(tenantId, rule)) continue;
        const condition = await evaluateCondition(tenantId, rule);
        if (!condition.met) continue;
        fired.push(await fire(tenantId, rule, condition));
      }
    }
    return fired;
  }

  /** Događaj sa bus-a → watcheri sa `when.type = event`. */
  async function onEvent(event, payload = {}) {
    const tenantId = payload.tenantId;
    if (!tenantId) return [];
    const fired = [];
    for (const rule of rules.filter((r) => r.when?.type === 'event' && r.enabled !== false)) {
      if (rule.tenantId && rule.tenantId !== tenantId) continue;
      if (rule.when.event !== event && rule.when.event !== '*' && !(String(rule.when.event).endsWith('.*') && event.startsWith(String(rule.when.event).slice(0, -1)))) continue;
      if (!canRun(tenantId, rule)) continue;
      fired.push(await fire(tenantId, rule, { met: true, value: 1, reason: `događaj ${event}` }));
    }
    return fired;
  }

  return {
    rules,
    tick,
    onEvent,
    fire,
    recordMetric,
    latestMetric,
    metricsStore,
    state,
    stats: () => ({ rules: rules.length, fired: [...state.entries()].length }),
    listRules: (tenantId) => rules.filter((r) => !r.tenantId || r.tenantId === tenantId),
  };
}
