/**
 * Mock provider — deterministički LLM za testove i demo bez interneta i bez troška.
 *
 * Skripta može biti:
 *   - niz odgovora:  [{ text }, { toolCalls:[{name,arguments}] }, …]  (prazna skripta → default odgovor)
 *   - funkcija:      ({ messages, tools, callIndex, lastToolResult }) => odgovor
 * Odgovor: { text, toolCalls:[{id,name,arguments}], usage:{promptTokens,completionTokens}, finishReason }
 */
import { PolicyError } from '../core/errors.js';

export function createMockProvider({ script = [], name = 'mock', model = 'mock', usagePerCall = { promptTokens: 320, completionTokens: 160 }, latencyMs = 0 } = {}) {
  const calls = [];
  let index = 0;

  const nextResponse = (ctx) => {
    let resp;
    if (typeof script === 'function') resp = script(ctx);
    else if (index < script.length) resp = script[index];
    else
      resp = {
        text: `[mock] Odgovor na: ${lastUserText(ctx.messages).slice(0, 160)}`,
      };
    index += 1;
    return resp ?? { text: '' };
  };

  return {
    name,
    model,
    isMock: true,
    supportsTools: true,
    supportsStreaming: true,
    get callCount() {
      return calls.length;
    },
    get calls() {
      return calls;
    },
    reset() {
      calls.length = 0;
      index = 0;
    },
    push(resp) {
      if (Array.isArray(script)) script.push(resp);
      else throw new PolicyError('Mock skripta je funkcija — push nije podržan');
    },

    async chat({ messages = [], tools = [], onDelta, signal, model: modelOverride } = {}) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const ctx = {
        messages,
        tools,
        callIndex: calls.length,
        lastToolResult: [...messages].reverse().find((m) => m.role === 'tool')?.content,
      };
      const resp = nextResponse(ctx);
      const out = {
        text: resp.text ?? '',
        toolCalls: (resp.toolCalls ?? []).map((tc, i) => ({
          id: tc.id ?? `mock_call_${calls.length}_${i}`,
          name: tc.name,
          arguments: tc.arguments ?? {},
          rawArguments: JSON.stringify(tc.arguments ?? {}),
        })),
        usage: { ...usagePerCall, ...(resp.usage ?? {}) },
        model: modelOverride ?? model,
        finishReason: resp.finishReason ?? (resp.toolCalls?.length ? 'tool_calls' : 'stop'),
      };
      calls.push({ messages, tools: tools.map((t) => t.name), response: out });
      if (typeof onDelta === 'function' && out.text) {
        for (const piece of chunk(out.text, 24)) {
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          onDelta(piece);
          if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
        }
      }
      return out;
    },

    async embed(texts) {
      return { model: 'mock-embed', vectors: texts.map(() => new Array(8).fill(0.1)), usage: { promptTokens: 0, completionTokens: 0 } };
    },
  };
}

function chunk(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

function lastUserText(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}
