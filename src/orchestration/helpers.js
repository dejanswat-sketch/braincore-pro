/**
 * Zajednički pomoćnici za orchestration patterne.
 * Svaki LLM poziv van agenta (planer, sinteza, refleksija) ide kroz `callLlm` — da cost i budžet ostanu tačni.
 */
import { interpolate } from '../core/config-utils.js';
import { BudgetExceededError } from '../core/errors.js';

export function createPatternHelpers({ llm, cost, tracer, logger, metrics }) {
  /**
   * LLM poziv sa automatskim cost tracking-om i budžetom.
   * @returns {Promise<{text, usage, costUsd, model, provider}>}
   */
  async function callLlm(ctx, { messages, tools = [], temperature = 0.1, maxTokens = 700, model, responseFormat, onDelta, role = 'pattern' }) {
    const estimate = cost.estimate({ promptChars: JSON.stringify(messages).length, maxOutTokens: maxTokens, model: model ?? 'default' });
    ctx.budget?.assertCanContinue({ estimatedUsd: estimate, label: role });
    ctx.budget?.addStep();
    const span = ctx.trace ? tracer.span(ctx.trace, `llm:${role}`, { model: model ?? 'default' }) : null;
    try {
      const res = await llm.chat({ messages, tools, temperature, maxTokens, model, responseFormat, onDelta, signal: ctx.signal, tenantId: ctx.tenantId });
      const rec = await cost.record({
        tenantId: ctx.tenantId,
        agentId: ctx.agentId ?? role,
        runId: ctx.runId,
        model: res.model,
        usage: res.usage,
        provider: res.provider,
        meta: { pattern: ctx.pattern, role },
      });
      ctx.budget?.spend({ usd: rec.usd, tokensIn: rec.tokensIn, tokensOut: rec.tokensOut });
      metrics?.inc('pattern_llm_calls_total', { pattern: ctx.pattern ?? '-', role });
      span?.end({ tokensIn: rec.tokensIn, tokensOut: rec.tokensOut, usd: rec.usd });
      return { text: res.text ?? '', toolCalls: res.toolCalls ?? [], usage: { tokensIn: rec.tokensIn, tokensOut: rec.tokensOut }, costUsd: rec.usd, model: res.model, provider: res.provider };
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }

  /** JSON iz LLM odgovora, sa fallback-om. */
  function parseJson(text, fallback = null) {
    if (!text) return fallback;
    const match = String(text).match(/[[{][\s\S]*[\]}]/);
    if (!match) return fallback;
    try {
      return JSON.parse(match[0]);
    } catch {
      return fallback;
    }
  }

  /** Sažme predugačak rezultat prije nego ide u sljedeći korak. */
  function condense(value, max = 2500) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    if (!text) return '';
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…[skraćeno ${text.length - max} znakova]`;
  }

  /** Popuni {{previous}}, {{input}}, {{step}} … u stringu. */
  function render(template, vars) {
    return interpolate(template, vars);
  }

  const sumUsage = (items = []) =>
    items.reduce(
      (acc, r) => {
        acc.tokensIn += r?.usage?.tokensIn ?? 0;
        acc.tokensOut += r?.usage?.tokensOut ?? 0;
        acc.costUsd += r?.costUsd ?? 0;
        return acc;
      },
      { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    );

  return { callLlm, parseJson, condense, render, sumUsage, BudgetExceededError };
}
