/**
 * Router: bira agenta za nepoznat ulaz.
 * Prvo bez LLM-a (keyword + embedding), pa LLM samo ako je neodlučno — jeftinije i brže.
 */
import { cosineSimilarity } from '../memory/embeddings.js';

export function createRouter({ catalog, llm, embedder, logger, metrics } = {}) {
  const agents = catalog.all();

  function keywordScores(input) {
    const text = ` ${String(input ?? '').toLowerCase()} `;
    const words = new Set(text.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
    return agents.map((a) => {
      let hits = 0;
      let total = 0;
      for (const hint of a.routingHints ?? []) {
        total += 1;
        const h = hint.toLowerCase();
        if (h.includes(' ')) {
          if (text.includes(h)) hits += 1.5;
        } else if (words.has(h) || text.includes(` ${h}`) || text.includes(`${h} `)) {
          hits += 1;
        }
      }
      const score = total ? Math.min(1, hits / Math.max(2, Math.ceil(total * 0.35))) : 0;
      return { agentId: a.id, score, hits, hints: total };
    });
  }

  async function embeddingScores(input) {
    if (!embedder) return [];
    const agentsWithDesc = agents.filter((a) => a.description);
    if (!agentsWithDesc.length) return [];
    const [qvec, ...avec] = await embedder.embed([String(input ?? ''), ...agentsWithDesc.map((a) => `${a.name}. ${a.description} ${(a.routingHints ?? []).join(', ')}`)]);
    return agentsWithDesc.map((a, i) => ({ agentId: a.id, score: Math.max(0, cosineSimilarity(qvec, avec[i])), method: 'embedding' }));
  }

  async function llmClassify(input, { tenantId, model, signal } = {}) {
    const table = catalog.routingTable().map((a) => `- ${a.id} (${a.domain}): ${a.description}`).join('\n');
    const res = await llm.chat({
      model,
      temperature: 0,
      maxTokens: 200,
      responseFormat: { type: 'json_object' },
      signal,
      tenantId,
      messages: [
        {
          role: 'system',
          content: `Ti si ruter. Izaberi TAČNO JEDNOG agenta sa spiska i vrati JSON: {"agentId":"...","confidence":0-1,"reason":"kratko"}. Ako nijedan ne odgovara, vrati "support".\n\nAgenti:\n${table}`,
        },
        { role: 'user', content: String(input ?? '').slice(0, 2000) },
      ],
    });
    const parsed = safeJson(res.text);
    if (parsed?.agentId && catalog.has(parsed.agentId)) {
      return { agentId: parsed.agentId, confidence: clamp01(parsed.confidence ?? 0.7), reason: parsed.reason ?? 'LLM klasifikacija', method: 'llm', usage: res.usage };
    }
    return null;
  }

  return {
    /**
     * @returns {Promise<{agentId, confidence, reason, method, candidates}>}
     */
    async classify(input, { tenantId, useLlm = true, minConfidence = 0.45, model, signal } = {}) {
      const kw = keywordScores(input);
      const em = await embeddingScores(input).catch(() => []);
      const merged = new Map();
      for (const s of kw) merged.set(s.agentId, { agentId: s.agentId, keyword: s.score, embedding: 0, score: s.score * 0.7 });
      for (const s of em) {
        const cur = merged.get(s.agentId) ?? { agentId: s.agentId, keyword: 0, embedding: 0, score: 0 };
        cur.embedding = s.score;
        cur.score = cur.keyword * 0.5 + s.score * 0.5;
        merged.set(s.agentId, cur);
      }
      const ranked = [...merged.values()].map((c) => ({ ...c, score: Number(c.score.toFixed(4)) })).sort((a, b) => b.score - a.score);
      const top = ranked[0] ?? null;

      if (top && top.score >= minConfidence) {
        metrics?.inc('router_decisions_total', { method: 'heuristic', agent: top.agentId });
        return { agentId: top.agentId, confidence: top.score, reason: `keyword/embedding skor ${top.score}`, method: 'heuristic', candidates: ranked.slice(0, 4) };
      }

      if (useLlm && llm) {
        try {
          const res = await llmClassify(input, { tenantId, model, signal });
          if (res) {
            metrics?.inc('router_decisions_total', { method: 'llm', agent: res.agentId });
            return { ...res, candidates: ranked.slice(0, 4) };
          }
        } catch (err) {
          logger?.warn?.('router.llm_failed', { error: err.message });
        }
      }

      const fallback = top?.agentId ?? 'support';
      metrics?.inc('router_decisions_total', { method: 'fallback', agent: fallback });
      return { agentId: fallback, confidence: top?.score ?? 0, reason: 'nema jasnog poklapanja → fallback', method: 'fallback', candidates: ranked.slice(0, 4) };
    },

    scores: keywordScores,
  };
}

function clamp01(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0.7;
  return Math.max(0, Math.min(1, num));
}

function safeJson(text) {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
