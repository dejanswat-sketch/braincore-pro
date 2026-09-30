/**
 * Epizodična memorija: pamti CJJELE EPIZODE (problem → šta je urađeno → ishod → pouka).
 * Kasnije se slične epizode ubacuju u prompt kao few-shot primjeri ("ovako smo riješili prošli put").
 */
import path from 'node:path';
import { appendJsonl, readJsonl } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';

export function createEpisodicMemory({ dataDir, vectors, embeddings, logger, maxPromptChars = 1500 } = {}) {
  const file = (tenantId) => path.join(dataDir, 'tenants', tenantId, 'memory', 'episodes.jsonl');

  return {
    file,

    /**
     * Upisuje epizodu i (ako imamo vektore) indeksira je za kasniju sličnost.
     * @param {object} episode { problem, actions[], solution, outcome, success, lessons[], tools[], agentId, runId, costUsd, durationMs, tags[] }
     */
    async record(tenantId, episode = {}) {
      const record = {
        id: episode.id ?? uid('ep'),
        ts: iso(),
        tenantId,
        agentId: episode.agentId ?? null,
        runId: episode.runId ?? null,
        problem: String(episode.problem ?? '').slice(0, 2000),
        actions: (episode.actions ?? []).slice(0, 20),
        solution: String(episode.solution ?? '').slice(0, 4000),
        outcome: episode.outcome ?? (episode.success ? 'success' : 'unknown'),
        success: episode.success !== false,
        lessons: (episode.lessons ?? []).slice(0, 10),
        tools: (episode.tools ?? []).slice(0, 20),
        costUsd: episode.costUsd ?? 0,
        durationMs: episode.durationMs ?? null,
        tags: episode.tags ?? [],
        score: 0, // koliko je puta epizoda bila korisna (feedback)
      };
      if (dataDir) await appendJsonl(file(tenantId), record);

      if (vectors && (record.success || record.lessons.length)) {
        try {
          await vectors.upsert(tenantId, {
            id: `epvec_${record.id}`,
            text: `${record.problem}\nIshod: ${record.outcome}\n${record.solution.slice(0, 1200)}\nPouke: ${record.lessons.join('; ')}`,
            metadata: { kind: 'episode', episodeId: record.id, agentId: record.agentId, success: record.success, ts: record.ts },
          });
        } catch (err) {
          logger?.warn?.('episodic.index_failed', { tenantId, error: err.message });
        }
      }
      logger?.debug?.('episodic.recorded', { tenantId, id: record.id, success: record.success });
      return record;
    },

    /** Slične epizode (za few-shot u promptu). */
    async similar(tenantId, problem, { k = 3, minScore = 0.15, onlySuccess = false } = {}) {
      if (!vectors) return [];
      const hits = await vectors.query(tenantId, {
        text: String(problem ?? ''),
        k: k * 2,
        minScore,
        filter: { kind: 'episode', ...(onlySuccess ? { success: true } : {}) },
      });
      const rows = await readJsonl(file(tenantId), { limit: 500, tail: true });
      const byId = new Map(rows.map((r) => [r.id, r]));
      return hits
        .map((h) => ({ ...(byId.get(h.metadata.episodeId) ?? {}), score: h.score }))
        .filter((e) => e.id)
        .sort((a, b) => b.score + (b.success ? 0.1 : 0) - (a.score + (a.success ? 0.1 : 0)))
        .slice(0, k);
    },

    /** Tekst za prompt (few-shot). */
    async fewShotText(tenantId, problem, { k = 3, minScore = 0.1 } = {}) {
      const eps = await this.similar(tenantId, problem, { k, minScore });
      if (!eps.length) return '';
      let out = '';
      for (const e of eps) {
        const block = [
          `### Sličan prošli slučaj (${e.success ? 'uspješno' : 'neuspješno'}, pouzdanost ${e.score})`,
          `Problem: ${String(e.problem).slice(0, 400)}`,
          e.actions?.length ? `Koraci: ${e.actions.join(' → ')}` : '',
          `Ishod: ${e.outcome}`,
          e.lessons?.length ? `Pouke: ${e.lessons.join('; ')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        if (out.length + block.length > maxPromptChars) break;
        out += `${block}\n\n`;
      }
      return out.trim();
    },

    /** Ishod + pouka (nakon što čovjek ili kritičar ocijeni). */
    async addLesson(tenantId, episodeId, { lesson, success } = {}) {
      const rows = await readJsonl(file(tenantId));
      const ep = rows.filter((r) => r.id === episodeId).at(-1);
      if (!ep) return null;
      const updated = { ...ep, lessons: [...(ep.lessons ?? []), ...(lesson ? [lesson] : [])], success: success ?? ep.success, updatedAt: iso() };
      await appendJsonl(file(tenantId), { ...updated, _op: 'update' });
      return updated;
    },

    async stats(tenantId) {
      const rows = await readJsonl(file(tenantId));
      const unique = new Map(rows.map((r) => [r.id, r]));
      const all = [...unique.values()];
      return {
        total: all.length,
        success: all.filter((e) => e.success).length,
        failed: all.filter((e) => !e.success).length,
        byAgent: all.reduce((acc, e) => ({ ...acc, [e.agentId ?? 'unknown']: (acc[e.agentId ?? 'unknown'] ?? 0) + 1 }), {}),
        lastAt: all.at(-1)?.ts ?? null,
      };
    },

    async recent(tenantId, { limit = 20 } = {}) {
      const rows = await readJsonl(file(tenantId), { limit: limit * 3, tail: true });
      const unique = new Map(rows.map((r) => [r.id, r]));
      return [...unique.values()].slice(-limit).reverse();
    },
  };
}
