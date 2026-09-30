/**
 * Cost tracking: cijena po modelu, akumulacija po tenantu/agentu/danu.
 *
 * ⚠️ Cijene su PROCJENA i mijenjaju se — provjeriti kod providera prije naplate klijentu.
 * Jedinica: USD za 1M tokena.
 */
import path from 'node:path';
import { appendJsonl, readJsonl } from '../core/fsx.js';
import { iso } from '../core/clock.js';

export const PRICING = {
  // OpenAI-kompatibilni provideri (provjeriti!)
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10.0 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'llama-3.3-70b-versatile': { in: 0.59, out: 0.79 },
  'qwen2.5:14b': { in: 0, out: 0 }, // lokalno (Ollama)
  mock: { in: 0, out: 0 },
};

export function priceFor(model, { fallback = { in: 1.0, out: 3.0 } } = {}) {
  if (!model) return fallback;
  if (PRICING[model]) return PRICING[model];
  const key = Object.keys(PRICING).find((k) => model.startsWith(k));
  return key ? PRICING[key] : fallback;
}

/** Cijena za usage objekat { promptTokens, completionTokens }. */
export function computeCost(model, usage = {}) {
  const price = priceFor(model);
  const tin = Number(usage.promptTokens ?? usage.input_tokens ?? 0);
  const tout = Number(usage.completionTokens ?? usage.output_tokens ?? 0);
  const usd = (tin / 1e6) * price.in + (tout / 1e6) * price.out;
  return { usd: Number(usd.toFixed(8)), price, tokensIn: tin, tokensOut: tout, model };
}

export function createCostTracker({ dataDir, logger } = {}) {
  const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
  const usageFile = (tenantId, d = new Date()) => path.join(dataDir, 'tenants', tenantId, 'usage', `${monthKey(d)}.jsonl`);

  return {
    /**
     * Zapisuje jedan LLM poziv i vraća { usd, model, tokensIn, tokensOut }.
     */
    async record({ tenantId, agentId, runId, model, usage, provider = 'llm', meta = {} }) {
      const cost = computeCost(model, usage);
      const entry = {
        ts: iso(),
        tenantId,
        agentId,
        runId,
        provider,
        model: cost.model,
        tokensIn: cost.tokensIn,
        tokensOut: cost.tokensOut,
        usd: cost.usd,
        ...meta,
      };
      if (dataDir) await appendJsonl(usageFile(tenantId), entry);
      logger?.debug?.('cost.record', { tenantId, agentId, usd: entry.usd, model: entry.model });
      return entry;
    },

    /** Suma potrošnje za tenant (mjesec ili sve). */
    async summary(tenantId, { month = monthKey() } = {}) {
      const rows = await readJsonl(usageFile(tenantId, new Date(`${month}-01T00:00:00Z`)));
      const total = rows.reduce(
        (acc, r) => {
          acc.usd += r.usd ?? 0;
          acc.tokensIn += r.tokensIn ?? 0;
          acc.tokensOut += r.tokensOut ?? 0;
          acc.calls += 1;
          acc.byAgent[r.agentId ?? 'unknown'] = (acc.byAgent[r.agentId ?? 'unknown'] ?? 0) + (r.usd ?? 0);
          acc.byModel[r.model ?? 'unknown'] = (acc.byModel[r.model ?? 'unknown'] ?? 0) + (r.usd ?? 0);
          return acc;
        },
        { month, usd: 0, tokensIn: 0, tokensOut: 0, calls: 0, byAgent: {}, byModel: {} },
      );
      total.usd = Number(total.usd.toFixed(6));
      for (const k of Object.keys(total.byAgent)) total.byAgent[k] = Number(total.byAgent[k].toFixed(6));
      for (const k of Object.keys(total.byModel)) total.byModel[k] = Number(total.byModel[k].toFixed(6));
      return total;
    },

    async monthlySpent(tenantId) {
      const s = await this.summary(tenantId);
      return s.usd;
    },

    /** Predračun za prompt (grubo: ~4 znaka = 1 token). */
    estimate({ promptChars = 0, maxOutTokens = 800, model }) {
      const price = priceFor(model);
      const tin = Math.ceil(promptChars / 4);
      return Number(((tin / 1e6) * price.in + (maxOutTokens / 1e6) * price.out).toFixed(8));
    },
  };
}
