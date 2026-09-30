/**
 * OpenAI-kompatibilni provider (DeepSeek, OpenAI, Groq, OpenRouter, Ollama, vLLM…).
 * Jedina spoljna zavisnost je `fetch` (ugrađen u Node 18+).
 */
import { LlmError, TimeoutError, isAbort } from '../core/errors.js';
import { sleep } from '../core/clock.js';

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export function toOpenAiTools(tools = []) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.params ?? { type: 'object', properties: {}, additionalProperties: true },
    },
  }));
}

export function createOpenAiCompatibleProvider({
  baseUrl = 'https://api.deepseek.com/v1',
  apiKey = '',
  model = 'deepseek-chat',
  embedModel = '',
  timeoutMs = 60_000,
  maxRetries = 2,
  fetchImpl = globalThis.fetch,
  name = 'openai-compatible',
  headers = {},
} = {}) {
  const root = baseUrl.replace(/\/+$/, '');

  async function request(path, body, { signal, retries = maxRetries, method = 'POST' } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('llm-timeout')), timeoutMs);
      const onAbort = () => ac.abort(new Error('aborted'));
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        const res = await fetchImpl(`${root}${path}`, {
          method,
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            ...headers,
          },
          body: method === 'GET' ? undefined : JSON.stringify(body),
          signal: ac.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new LlmError(`LLM HTTP ${res.status}: ${text.slice(0, 400)}`, { status: res.status, provider: name }, { retryable: RETRYABLE_STATUS.has(res.status) });
          if (!err.retryable || attempt === retries) throw err;
          lastErr = err;
        } else {
          return res;
        }
      } catch (err) {
        if (isAbort(signal)) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (err.message === 'llm-timeout' || err.name === 'AbortError') {
          lastErr = new TimeoutError(`LLM nije odgovorio u ${timeoutMs}ms`, { provider: name });
        } else if (err instanceof LlmError) {
          lastErr = err;
        } else {
          lastErr = new LlmError(`LLM mrežna greška: ${err.message}`, { provider: name }, { retryable: true });
        }
        if (!lastErr.retryable || attempt === retries) throw lastErr;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
      const backoff = Math.min(8000, 400 * 2 ** attempt) + Math.random() * 200;
      await sleep(backoff, signal);
    }
    throw lastErr ?? new LlmError('LLM nepoznata greška', { provider: name });
  }

  return {
    name,
    model,
    supportsTools: true,
    supportsStreaming: true,

    /** @returns {Promise<{text, toolCalls, usage, model, finishReason, raw}>} */
    async chat({ messages, tools = [], toolChoice, temperature = 0.2, maxTokens = 1200, model: modelOverride, responseFormat, signal, onDelta } = {}) {
      const usedModel = modelOverride || model;
      const wantsStream = typeof onDelta === 'function';
      const body = {
        model: usedModel,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(tools.length ? { tools: toOpenAiTools(tools) } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(responseFormat ? { response_format: responseFormat } : {}),
        ...(wantsStream ? { stream: true, stream_options: { include_usage: true } } : {}),
      };

      if (!wantsStream) {
        const res = await request('/chat/completions', body, { signal });
        const json = await res.json();
        const choice = json.choices?.[0] ?? {};
        return {
          text: choice.message?.content ?? '',
          toolCalls: (choice.message?.tool_calls ?? []).map(normalizeToolCall),
          usage: {
            promptTokens: json.usage?.prompt_tokens ?? 0,
            completionTokens: json.usage?.completion_tokens ?? 0,
            totalTokens: json.usage?.total_tokens ?? 0,
          },
          model: json.model ?? usedModel,
          finishReason: choice.finish_reason ?? 'stop',
          raw: json,
        };
      }

      const res = await request('/chat/completions', body, { signal });
      return parseSseStream(res.body, { onDelta, fallbackModel: usedModel });
    },

    async embed(texts, { model: embedOverride, signal } = {}) {
      const usedModel = embedOverride || embedModel;
      if (!usedModel) throw new LlmError('Embedding model nije konfigurisan', { provider: name }, { retryable: false });
      const res = await request('/embeddings', { model: usedModel, input: texts }, { signal });
      const json = await res.json();
      return {
        model: json.model ?? usedModel,
        vectors: (json.data ?? []).map((d) => d.embedding),
        usage: { promptTokens: json.usage?.prompt_tokens ?? 0, completionTokens: 0 },
      };
    },
  };
}

function normalizeToolCall(tc) {
  return {
    id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name: tc.function?.name ?? tc.name,
    arguments: safeParse(tc.function?.arguments ?? tc.arguments ?? '{}'),
    rawArguments: tc.function?.arguments ?? '{}',
  };
}

function safeParse(text) {
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text || '{}');
  } catch {
    return { __unparsed: text };
  }
}

/** Parsira SSE tok iz OpenAI-kompatibilnog API-ja. */
export async function parseSseStream(stream, { onDelta, fallbackModel } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason = 'stop';
  let model = fallbackModel;
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const toolAcc = new Map();

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      model = json.model ?? model;
      if (json.usage) {
        usage = {
          promptTokens: json.usage.prompt_tokens ?? usage.promptTokens,
          completionTokens: json.usage.completion_tokens ?? usage.completionTokens,
          totalTokens: json.usage.total_tokens ?? usage.totalTokens,
        };
      }
      const choice = json.choices?.[0];
      if (!choice) continue;
      finishReason = choice.finish_reason ?? finishReason;
      const delta = choice.delta ?? {};
      if (delta.content) {
        text += delta.content;
        onDelta?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = toolAcc.get(idx) ?? { id: null, name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        toolAcc.set(idx, cur);
      }
    }
  }

  return {
    text,
    toolCalls: [...toolAcc.values()].map((t) => ({
      id: t.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
      name: t.name,
      arguments: safeParse(t.args),
      rawArguments: t.args,
    })),
    usage,
    model,
    finishReason,
  };
}
