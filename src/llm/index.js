/**
 * LLM fabrika: bira provider, gradi fallback lanac i dodaje keš.
 * Prioritet: mock (ako je izričito tražen ili nema ključa u dev modu) → primarni → fallback-ovi.
 */
import { createOpenAiCompatibleProvider } from './openai-compatible.js';
import { createMockProvider } from './mock.js';
import { LlmError, classifyError } from '../core/errors.js';
import { sha256, stableStringify } from '../core/ids.js';

export function createLlm({ env, logger, metrics } = {}) {
  const built = [];

  const wantMock = env?.llm?.provider === 'mock' || (!env?.llm?.apiKey && process.env.NMQ_ALLOW_MOCK_FALLBACK !== '0');

  if (wantMock) {
    built.push(createMockProvider({ name: 'mock', model: env?.llm?.model || 'mock' }));
  }

  if (env?.llm?.apiKey && env.llm.provider !== 'mock') {
    built.push(
      createOpenAiCompatibleProvider({
        baseUrl: env.llm.baseUrl,
        apiKey: env.llm.apiKey,
        model: env.llm.model,
        embedModel: env.llm.embedModel,
        timeoutMs: env.llm.timeoutMs,
        maxRetries: env.llm.maxRetries,
        name: 'primary',
      }),
    );
    for (const fb of env.llm.fallbacks ?? []) {
      const key = process.env[fb.apiKeyEnv] ?? '';
      if (!key) continue;
      built.push(
        createOpenAiCompatibleProvider({
          baseUrl: fb.baseUrl,
          apiKey: key,
          model: fb.model,
          embedModel: fb.embedModel ?? '',
          timeoutMs: env.llm.timeoutMs,
          maxRetries: 1,
          name: `fallback:${fb.model}`,
        }),
      );
    }
  }

  if (!built.length) built.push(createMockProvider({ name: 'mock-empty' }));

  const cache = new Map();
  const CACHE_MAX = 200;

  const api = {
    providers: built,
    get primary() {
      return built[0];
    },
    supportsTools: built.some((p) => p.supportsTools),
    isMock: built.every((p) => p.isMock),

    /**
     * Poziva LLM sa fallback lancem i opcionim kešom.
     * @returns {Promise<{text, toolCalls, usage, model, provider, cached}>}
     */
    async chat({ cache: useCache = true, cacheKeyExtra = '', ...req }) {
      // tenantId ide u keš ključ — bez toga bi odgovor jednog tenanta mogao "pobjeći" drugom
      const cacheKey = useCache && !req.onDelta
        ? sha256(stableStringify({ tenant: req.tenantId ?? '-', model: req.model, messages: req.messages, tools: (req.tools ?? []).map((t) => t.name), extra: cacheKeyExtra }))
        : null;
      if (cacheKey && cache.has(cacheKey)) {
        metrics?.inc('llm_cache_hits_total', { tenant: req.tenantId ?? '-' });
        return { ...cache.get(cacheKey), cached: true };
      }

      let lastErr;
      for (const provider of built) {
        const started = Date.now();
        try {
          const result = await provider.chat(req);
          metrics?.observe('llm_duration_seconds', { provider: provider.name, model: result.model }, (Date.now() - started) / 1000);
          metrics?.inc('llm_calls_total', { provider: provider.name, model: result.model, status: 'ok' });
          metrics?.inc('tokens_total', { provider: provider.name, type: 'in' }, result.usage?.promptTokens ?? 0);
          metrics?.inc('tokens_total', { provider: provider.name, type: 'out' }, result.usage?.completionTokens ?? 0);
          const out = { ...result, provider: provider.name };
          if (cacheKey) {
            if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
            cache.set(cacheKey, out);
          }
          return { ...out, cached: false };
        } catch (err) {
          lastErr = err;
          metrics?.inc('llm_calls_total', { provider: provider.name, model: req.model ?? provider.model, status: 'error' });
          if (classifyError(err) === 'policy' || err.name === 'AbortError') throw err;
          logger?.warn?.('llm.provider_failed', { provider: provider.name, error: err.message });
        }
      }
      throw lastErr ?? new LlmError('Nijedan LLM provider nije uspio', {}, { retryable: false });
    },

    async embed(texts, opts = {}) {
      const withEmbed = built.find((p) => p.embed && !p.isMock && opts.preferReal !== false);
      if (withEmbed) {
        try {
          return await withEmbed.embed(texts, opts);
        } catch (err) {
          logger?.warn?.('llm.embed_failed', { error: err.message });
        }
      }
      return built[0].embed(texts, opts);
    },

    clearCache: () => cache.clear(),
  };

  return api;
}

export { createMockProvider, createOpenAiCompatibleProvider };

/**
 * Umotava pojedinačni provider u isti interfejs koji `createLlm` vraća.
 * Koristi se u testovima i kod zamjene LLM-a (overrides.llm) — da `robot.llm.providers` uvijek postoji.
 */
export function wrapLlmProvider(provider, logger) {
  if (provider?.providers) return provider; // već je facade
  return {
    providers: [provider],
    get primary() {
      return provider;
    },
    isMock: Boolean(provider?.isMock),
    supportsTools: provider?.supportsTools !== false,
    async chat(req) {
      const res = await provider.chat(req);
      return { ...res, provider: provider.name, cached: false };
    },
    async embed(texts, opts = {}) {
      if (typeof provider.embed === 'function') return provider.embed(texts, opts);
      throw new LlmError('Provider ne podržava embeddings', { provider: provider?.name }, { retryable: false });
    },
    clearCache() {
      provider.reset?.();
      logger?.debug?.('llm.cache_cleared', {});
    },
  };
}
