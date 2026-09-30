/**
 * RESEARCH CLUSTER — extractor.
 *
 * Iz teksta izvlači strukturisane činjenice i ubacuje ih u bazu znanja (vektore) tenanta.
 * Radi u dva režima:
 *   • heuristika (default, bez troška): e-mail, telefon, IBAN, iznosi, datumi, brojevi dokumenata
 *   • LLM (ako je proslijeđen `llm`): traži JSON listu {text, kind, confidence}
 *
 * Namjerno NIKAD ne izmišlja: ono što nije našlo, vraća kao `missing`, a ne popunjava prazninom.
 */
import { uid } from '../core/ids.js';
import { redact } from '../core/logger.js';

export const HEURISTICS = [
  { kind: 'email', re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g },
  { kind: 'phone', re: /(?:\+?\d{2,3}[\s/-]?)?(?:\(?0?\d{2,3}\)?[\s/-]?)?\d{3}[\s/-]?\d{3,4}/g },
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g },
  { kind: 'amount', re: /\b\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?\s?(?:EUR|USD|RSD|din|€|\$)\b/gi },
  { kind: 'date', re: /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g },
  { kind: 'document', re: /\b(?:faktura|račun|narudžbina|ugovor|order|invoice)\s*(?:br\.?|broj|#|no\.?)?\s*([A-Z0-9-]{3,})\b/gi },
];

export function createExtractor({ memory, llm = null, logger, metrics, audit, tenantId = 'nmq' } = {}) {
  /** Heurističko izvlačenje (bez troška, deterministički). */
  function extractHeuristic(text) {
    const input = String(text ?? '');
    const facts = [];
    for (const rule of HEURISTICS) {
      const matches = input.match(rule.re) ?? [];
      for (const raw of [...new Set(matches)]) {
        facts.push({ text: raw.trim(), kind: rule.kind, confidence: rule.kind === 'phone' ? 0.6 : 0.9, source: 'heuristic' });
      }
    }
    const missing = [];
    for (const kind of ['email', 'amount', 'date']) {
      if (!facts.some((f) => f.kind === kind)) missing.push(kind);
    }
    return { facts, missing };
  }

  /** LLM izvlačenje — traži strogi JSON; ako model ne vrati JSON, pada na heuristiku. */
  async function extractWithLlm(text, { agentId = 'data' } = {}) {
    if (!llm) return null;
    const prompt = [
      'Izvuci činjenice iz teksta. Vrati ISKLJUČIVO JSON: {"facts":[{"text":"...","kind":"...","confidence":0..1}]}',
      'Ne izmišljaj. Ako nešto nema u tekstu, nemoj ga dodavati.',
      '',
      `TEKST:\n${redact(String(text).slice(0, 4000))}`,
    ].join('\n');
    const res = await llm.complete({ agentId, messages: [{ role: 'user', content: prompt }], temperature: 0, maxTokens: 500 });
    try {
      const parsed = JSON.parse(String(res.text).replace(/^```json|```$/g, '').trim());
      const facts = (parsed.facts ?? []).filter((f) => f?.text).map((f) => ({ text: String(f.text), kind: String(f.kind ?? 'other'), confidence: Number(f.confidence ?? 0.5), source: 'llm' }));
      return { facts, missing: [], costUsd: res.costUsd ?? 0 };
    } catch {
      logger?.warn?.('research.extractor_llm_parse_failed', {});
      return null;
    }
  }

  return {
    HEURISTICS,
    extractHeuristic,
    extractWithLlm,

    /**
     * Izvuci i (opciono) ubaci u KB. Vraća izvještaj sa brojem činjenica i `ingested` chunkova.
     */
    async extract(text, { ingest = true, useLlm = false, tenantId: t = tenantId, agentId = 'data', docId = null, source = 'extractor' } = {}) {
      const id = docId ?? uid('doc');
      let result = extractHeuristic(text);
      let costUsd = 0;
      if (useLlm) {
        const llmResult = await extractWithLlm(text, { agentId });
        if (llmResult && llmResult.facts.length) {
          result = { facts: [...result.facts, ...llmResult.facts], missing: llmResult.missing };
          costUsd = llmResult.costUsd ?? 0;
        }
      }
      let ingested = 0;
      if (ingest && memory?.vectors && result.facts.length) {
        const kbText = result.facts.map((f) => `${f.kind}: ${f.text}`).join('\n');
        const res = await memory.vectors.ingest(t, { text: kbText, source: `${source}:${id}`, docId: id, metadata: { facts: result.facts.length, extractor: true } });
        ingested = res?.chunks ?? 0;
      }
      metrics?.observe('research_facts_extracted', { tenant: t }, result.facts.length);
      await audit?.append({
        tenantId: t,
        actor: 'research-extractor',
        action: 'facts_extracted',
        args: { docId: id, facts: result.facts.length, ingested, useLlm },
        decision: 'allow',
        outcome: 'ok',
      });
      return { docId: id, tenantId: t, facts: result.facts, missing: result.missing, ingested, costUsd, byKind: result.facts.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }), {}) };
    },
  };
}
