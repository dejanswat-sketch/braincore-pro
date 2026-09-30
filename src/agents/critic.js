/**
 * Critic: provjerava kvalitet odgovora prije nego ode korisniku.
 * Prvo determinističke provjere (brzo, besplatno), pa LLM ocjena (opciono).
 */
export function createCritic({ llm, logger, metrics, callLlm } = {}) {
  function heuristics({ output, task, context = {}, criteria = [] }) {
    const issues = [];
    const text = String(output ?? '').trim();

    if (!text) issues.push({ severity: 'high', code: 'empty', message: 'Odgovor je prazan.' });
    if (text && text.length < 40) issues.push({ severity: 'medium', code: 'too_short', message: 'Odgovor je prekratak da bi bio koristan.' });

    const claims = ['garantujem', 'sigurno će', '100% ', 'garantovano', 'nikad neće'];
    for (const c of claims) {
      if (text.toLowerCase().includes(c)) issues.push({ severity: 'medium', code: 'overclaim', message: `Pretjerana tvrdnja: "${c}"` });
    }

    if (context.kb && !/\[\d+\]/.test(text) && context.requireCitations) {
      issues.push({ severity: 'medium', code: 'missing_citations', message: 'Nema citata iz baze znanja, a odgovor se oslanja na dokumente.' });
    }

    if (/\b(api[_ -]?key|token|password)\b\s*[:=]\s*\S{8,}/i.test(text)) {
      issues.push({ severity: 'high', code: 'secret_leak', message: 'Odgovor sadrži nešto što liči na tajnu.' });
    }

    if (task && text.length > 20) {
      const taskWords = new Set(String(task).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5));
      const outWords = new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u));
      const overlap = [...taskWords].filter((w) => outWords.has(w)).length;
      if (taskWords.size >= 4 && overlap === 0) {
        issues.push({ severity: 'low', code: 'off_topic', message: 'Odgovor ne koristi nijedan ključni pojam iz zadatka.' });
      }
    }

    const weights = { high: 0.4, medium: 0.15, low: 0.05 };
    const score = Math.max(0, 1 - issues.reduce((acc, i) => acc + (weights[i.severity] ?? 0.1), 0));
    return { issues, score: Number(score.toFixed(2)) };
  }

  return {
    /**
     * @returns {Promise<{verdict:'accept'|'revise', score:number, issues:Array, suggestion:string, method:string}>}
     * `ctx` (opciono) nosi budžet/trace/tenant — LLM poziv tada ide kroz callLlm, pa je trošak naplaćen.
     */
    async review({ task, output, context = {}, criteria = [], useLlm = false, threshold = 0.7, tenantId, model, signal, ctx } = {}) {
      const h = heuristics({ output, task, context, criteria });
      let verdict = h.score >= threshold && !h.issues.some((i) => i.severity === 'high') ? 'accept' : 'revise';
      let suggestion = h.issues.length ? `Popravi: ${h.issues.map((i) => i.message).join('; ')}` : 'U redu.';
      let method = 'heuristic';

      if (useLlm && llm && verdict === 'accept' && criteria.length) {
        try {
          const messages = [
            { role: 'system', content: `Ocijeni odgovor prema kriterijima: ${criteria.join('; ')}. Vrati JSON {"score":0-1,"issues":["..."],"suggestion":"..."}.` },
            { role: 'user', content: `ZADATAK:\n${String(task ?? '').slice(0, 1000)}\n\nODGOVOR:\n${String(output ?? '').slice(0, 3000)}` },
          ];
          // Ako imamo ctx — koristimo callLlm (budžet + cost + span). Inače direktan poziv (samo za testove).
          const res =
            ctx && callLlm
              ? await callLlm(ctx, { messages, temperature: 0, maxTokens: 250, model, role: 'critic' })
              : await llm.chat({ model, messages, temperature: 0, maxTokens: 250, signal, tenantId, responseFormat: { type: 'json_object' } });
          const parsed = safeJson(res.text);
          if (parsed) {
            method = 'llm';
            const score = Math.max(0, Math.min(1, Number(parsed.score ?? h.score)));
            const issues = [...h.issues, ...(parsed.issues ?? []).map((m) => ({ severity: 'medium', code: 'llm', message: String(m) }))];
            verdict = score >= threshold ? 'accept' : 'revise';
            suggestion = parsed.suggestion ?? suggestion;
            metrics?.inc('critic_reviews_total', { verdict, method });
            return { verdict, score: Number(score.toFixed(2)), issues, suggestion, method };
          }
        } catch (err) {
          logger?.warn?.('critic.llm_failed', { error: err.message });
        }
      }

      metrics?.inc('critic_reviews_total', { verdict, method });
      return { verdict, score: h.score, issues: h.issues, suggestion, method };
    },

    heuristics,
  };
}

function safeJson(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
