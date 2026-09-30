/**
 * Reward model: od sirovih signala do jedne ocjene (0-1) po run-u, agentu, patternu i varijanti.
 *
 * Signali (svi već postoje u sistemu):
 *   feedback (👍/👎/1-5), odobrenje/odbijanje akcije, ishod (ok/error/awaiting_approval),
 *   odbijene politike, greške alata, eskalacije (handoff bez rješenja), citiranost, trošak, trajanje.
 *
 * Ovo NIJE zamjena za RLHF fine-tuning — ovo je ono što treba PRIJE njega:
 * mjerenje koje tačno kaže koji agent/pattern/prompt varijanta radi bolje i zašto.
 *
 * Stanje: data/tenants/<id>/learning/rewards.jsonl
 */
import path from 'node:path';
import { appendJsonl, readJsonl } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';

export const DEFAULT_WEIGHTS = {
  base: 0.5,
  feedbackUp: 0.3,
  feedbackDown: -0.35,
  ratingScale: 0.25,
  approved: 0.05,
  rejected: -0.25,
  pendingApproval: 0.0,
  outcomeOk: 0.15,
  outcomeError: -0.35,
  policyDenied: -0.1,
  toolError: -0.08,
  escalation: -0.12,
  uncited: -0.08,
  costPenaltyPerUsd: -2.0, // skup run bez rezultata se kažnjava
  slowPenaltyPer10s: -0.02,
};

export function createRewardModel({ dataDir, logger, metrics, weights = {} } = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const file = (tenantId, d = new Date()) => path.join(dataDir, 'tenants', tenantId, 'learning', `rewards-${d.toISOString().slice(0, 7)}.jsonl`);
  const cache = [];

  const clamp = (n) => Number(Math.max(0, Math.min(1, n)).toFixed(4));

  /** Računa nagradu iz skupa signala. */
  function score(signals = {}) {
    let reward = w.base;
    const reasons = [];
    const f = signals.feedback;
    if (f === 'up' || f === true) {
      reward += w.feedbackUp;
      reasons.push(`feedback+ (${w.feedbackUp})`);
    } else if (f === 'down' || f === false) {
      reward += w.feedbackDown;
      reasons.push(`feedback- (${w.feedbackDown})`);
    } else if (typeof f === 'number') {
      reward += ((f - 3) / 2) * w.ratingScale;
      reasons.push(`ocjena ${f}/5`);
    }
    if (signals.approval === 'approved') {
      reward += w.approved;
      reasons.push('odobreno');
    } else if (signals.approval === 'rejected') {
      reward += w.rejected;
      reasons.push('odbijeno');
    }
    if (signals.outcome === 'ok') reward += w.outcomeOk;
    if (signals.outcome === 'error') {
      reward += w.outcomeError;
      reasons.push('greška');
    }
    if (signals.policyDenied) {
      reward += w.policyDenied * Math.min(3, signals.policyDenied);
      reasons.push(`politika odbila ${signals.policyDenied}x`);
    }
    if (signals.toolErrors) {
      reward += w.toolError * Math.min(5, signals.toolErrors);
      reasons.push(`greške alata ${signals.toolErrors}`);
    }
    if (signals.escalations) {
      reward += w.escalation * Math.min(3, signals.escalations);
      reasons.push(`eskalacije ${signals.escalations}`);
    }
    if (signals.uncited) {
      reward += w.uncited;
      reasons.push('bez citata');
    }
    if (signals.costUsd) {
      reward += w.costPenaltyPerUsd * Number(signals.costUsd);
      reasons.push(`trošak ${Number(signals.costUsd).toFixed(4)} USD`);
    }
    if (signals.durationMs && signals.durationMs > 10_000) {
      reward += w.slowPenaltyPer10s * Math.floor(signals.durationMs / 10_000);
    }
    return { reward: clamp(reward), reasons };
  }

  return {
    weights: w,
    file,
    score,

    /** Zapisuje nagradu za jedan run. */
    async record(tenantId, entry = {}) {
      const { reward, reasons } = score(entry.signals ?? entry);
      const record = {
        id: entry.id ?? uid('rw'),
        ts: entry.ts ?? iso(),
        tenantId,
        runId: entry.runId ?? null,
        agentId: entry.agentId ?? null,
        pattern: entry.pattern ?? null,
        variant: entry.variant ?? null,
        goalId: entry.goalId ?? null,
        jobId: entry.jobId ?? null,
        reward,
        reasons,
        signals: entry.signals ?? {},
        costUsd: entry.signals?.costUsd ?? entry.costUsd ?? 0,
      };
      cache.push(record);
      if (cache.length > 2000) cache.shift();
      if (dataDir) await appendJsonl(file(tenantId, new Date(record.ts)), record);
      metrics?.observe('reward_value', { tenant: tenantId, agent: record.agentId ?? '-' }, reward);
      if (reward < 0.3) logger?.warn?.('reward.low', { tenantId, agentId: record.agentId, runId: record.runId, reward, reasons });
      return record;
    },

    async recent(tenantId, { limit = 100, agentId, variant } = {}) {
      const rows = (await readJsonl(file(tenantId), { limit: 2000, tail: true })).concat(cache.filter((r) => r.tenantId === tenantId).slice(-200));
      const uniq = new Map(rows.map((r) => [r.id, r]));
      return [...uniq.values()]
        .filter((r) => (!agentId || r.agentId === agentId) && (!variant || r.variant === variant))
        .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
        .slice(-limit)
        .reverse();
    },

    /** Agregacija po grupi (agent | pattern | variant | goalId) za zadati period. */
    async aggregate(tenantId, { groupBy = 'agent', sinceMs = 7 * 86_400_000, limit = 3000 } = {}) {
      const rows = (await readJsonl(file(tenantId), { limit })).concat(cache.filter((r) => r.tenantId === tenantId));
      const uniq = new Map(rows.map((r) => [r.id, r]));
      const since = Date.now() - sinceMs;
      const out = {};
      for (const r of uniq.values()) {
        if (new Date(r.ts).getTime() < since) continue;
        const field = { agent: 'agentId', agentId: 'agentId', pattern: 'pattern', variant: 'variant', goalId: 'goalId', jobId: 'jobId' }[groupBy] ?? groupBy;
        const key = r[field] ?? 'unknown';
        if (!out[key]) out[key] = { n: 0, sum: 0, avgReward: 0, costUsd: 0, lowRewards: 0 };
        out[key].n += 1;
        out[key].sum += r.reward;
        out[key].costUsd = Number((out[key].costUsd + (r.costUsd ?? 0)).toFixed(6));
        if (r.reward < 0.35) out[key].lowRewards += 1;
      }
      for (const v of Object.values(out)) v.avgReward = Number((v.sum / v.n).toFixed(4));
      return out;
    },

    /** Najbolji/najgori po grupi — osnova za RSI prijedloge. */
    async ranking(tenantId, { groupBy = 'agent', sinceMs = 7 * 86_400_000 } = {}) {
      const agg = await this.aggregate(tenantId, { groupBy, sinceMs });
      const rows = Object.entries(agg).map(([key, v]) => ({ key, ...v })).sort((a, b) => b.avgReward - a.avgReward);
      return { top: rows.slice(0, 3), bottom: rows.slice(-3).reverse(), all: rows };
    },

    /** Prosječna nagrada varijante (za A/B odluku). */
    async variantComparison(tenantId, { sinceMs = 7 * 86_400_000 } = {}) {
      const agg = await this.aggregate(tenantId, { groupBy: 'variant', sinceMs });
      return Object.entries(agg)
        .filter(([k]) => k && k !== 'unknown')
        .map(([variant, v]) => ({ variant, ...v }))
        .sort((a, b) => b.avgReward - a.avgReward);
    },
  };
}
