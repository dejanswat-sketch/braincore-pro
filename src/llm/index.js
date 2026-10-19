/**
 * LLM fabrika: bira provider, gradi fallback lanac i dodaje keš.
 * Prioritet: mock (ako je izričito tražen ili nema ključa u dev modu) → primarni → fallback-ovi.
 */
import { createOpenAiCompatibleProvider } from './openai-compatible.js';
import { createMockProvider } from './mock.js';
import { LlmError, classifyError } from '../core/errors.js';
import { sha256, stableStringify } from '../core/ids.js';
import { smijeCloud, zabiljezi, peakInfo } from '../core/peakGate.js';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

/** Zajednicki log: koji je provider/model odgovorio (za tablu i ucenje rutera). */
const LLM_USAGE_LOG =
  process.env.NMQ_LLM_USAGE_LOG ||
  path.join(process.env.NMQ_DATA_DIR || process.env.TEMP || '.', 'llm-usage.jsonl');

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

  // ── HIBRID: brzi model (npr. gemma3:4b) za klasifikaciju, rutiranje i kratke zadatke ──
  // Prije ove izmjene (04.10.2026) `fastModel` se citao iz .env u config.js, ali ga
  // LLM sloj NIKAD nije koristio — sve je islo kroz glavni model (devstral:24b),
  // pa su i trivijalni zadaci trosili veliki model. Sada: chat({ fast: true }).
  let fastProvider = null;
  if (
    env?.llm?.apiKey &&
    env.llm.provider !== 'mock' &&
    env.llm.fastModel &&
    env.llm.fastModel !== env.llm.model
  ) {
    fastProvider = createOpenAiCompatibleProvider({
      baseUrl: env.llm.baseUrl,
      apiKey: env.llm.apiKey,
      model: env.llm.fastModel,
      timeoutMs: Math.min(env.llm.timeoutMs ?? 60_000, 60_000),
      maxRetries: 1,
      name: `fast:${env.llm.fastModel}`,
    });
  }

  // ── statistika: koji je provider stvarno odgovorio (lokalno vs cloud) ──
  const usage = { ukupno: 0, poProvideru: {}, poModelu: {}, fallbackPuta: 0, fastPuta: 0 };
  function zabiljezi(providerName, model, ms, ok, tokensIn, tokensOut) {
    usage.ukupno += 1;
    usage.poProvideru[providerName] = (usage.poProvideru[providerName] ?? 0) + 1;
    usage.poModelu[model || '?'] = (usage.poModelu[model || '?'] ?? 0) + 1;
    if (String(providerName).startsWith('fallback:')) usage.fallbackPuta += 1;
    if (String(providerName).startsWith('fast:')) usage.fastPuta += 1;
    try {
      appendFileSync(
        LLM_USAGE_LOG,
        JSON.stringify({ at: new Date().toISOString(), provider: providerName, model, ms, ok, tokensIn, tokensOut }) + '\n',
      );
    } catch { /* log nikad ne obara */ }
  }


  const cache = new Map();
  const CACHE_MAX = 200;

  const api = {
    providers: built,
    get primary() {
      return built[0];
    },
    /** Brzi model za klasifikaciju/rutiranje (null ako nije podesen). */
    get fastProvider() {
      return fastProvider;
    },
    /** Da li je hibrid aktivan (fast model + lokalni + fallback). */
    get hybrid() {
      return {
        fast: fastProvider?.model ?? null,
        primary: env?.llm?.model ?? null,
        fallbacks: (env?.llm?.fallbacks ?? []).map((f) => f.model),
        lokalno: /127\.0\.0\.1|localhost/.test(env?.llm?.baseUrl ?? ''),
      };
    },
    /** Statistika: koliko je koji provider odradio (lokalno vs cloud). */
    get usage() {
      return { ...usage, poProvideru: { ...usage.poProvideru }, poModelu: { ...usage.poModelu } };
    },
    supportsTools: built.some((p) => p.supportsTools),
    isMock: built.every((p) => p.isMock),

    /**
     * Poziva LLM sa fallback lancem i opcionim kešom.
     *
     * HIBRID: `fast: true` prvo pokusa brzi model (gemma3:4b) pa tek onda glavni i fallback.
     * Koristi za klasifikaciju, rutiranje, kratke odgovore — stedi vrijeme i VRAM.
     *
     * @returns {Promise<{text, toolCalls, usage, model, provider, cached}>}
     */
    async chat({ cache: useCache = true, cacheKeyExtra = '', fast = false, ...req }) {
      // tenantId ide u keš ključ — bez toga bi odgovor jednog tenanta mogao "pobjeći" drugom
      const cacheKey = useCache && !req.onDelta
        ? sha256(stableStringify({ tenant: req.tenantId ?? '-', model: req.model, fast, messages: req.messages, tools: (req.tools ?? []).map((t) => t.name), extra: cacheKeyExtra }))
        : null;
      if (cacheKey && cache.has(cacheKey)) {
        metrics?.inc('llm_cache_hits_total', { tenant: req.tenantId ?? '-' });
        return { ...cache.get(cacheKey), cached: true };
      }

      // HIBRID: fast ide ispred glavnog lanca (i dalje ima fallback ako padne)
      const lanac = fast && fastProvider ? [fastProvider, ...built] : built;

      let lastErr;
      for (const provider of lanac) {
        // PEAK GATE: u PEAK satima DeepSeek naplacuje DUPLO (izmereno: $47,24 vs $23,62
        // za 5 dana). Zato preskacemo cloud fallback u peak-u — bolje lokalno nego duplo.
        const jeFallback = String(provider.name).startsWith('fallback:');
        if (jeFallback && !smijeCloud()) {
          const pi = peakInfo();
          zabiljezi('odlozeno', { provider: provider.name, lokalno: pi.lokalnoVrijeme, minDoOffPeak: pi.minDoOffPeak });
          logger?.warn?.('llm.peak_gate_skip', { provider: provider.name, minDoOffPeak: pi.minDoOffPeak });
          continue;
        }
        const started = Date.now();
        try {
          const result = await provider.chat(req);
          const ms = Date.now() - started;
          metrics?.observe('llm_duration_seconds', { provider: provider.name, model: result.model }, ms / 1000);
          metrics?.inc('llm_calls_total', { provider: provider.name, model: result.model, status: 'ok' });
          metrics?.inc('tokens_total', { provider: provider.name, type: 'in' }, result.usage?.promptTokens ?? 0);
          metrics?.inc('tokens_total', { provider: provider.name, type: 'out' }, result.usage?.completionTokens ?? 0);
          zabiljezi(provider.name, result.model, ms, true, result.usage?.promptTokens ?? 0, result.usage?.completionTokens ?? 0);
          const out = { ...result, provider: provider.name, fast: Boolean(fast && provider === fastProvider) };
          if (cacheKey) {
            if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
            cache.set(cacheKey, out);
          }
          return { ...out, cached: false };
        } catch (err) {
          lastErr = err;
          zabiljezi(provider.name, req.model ?? provider.model, Date.now() - started, false, 0, 0);
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
