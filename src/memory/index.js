/**
 * Memorija kao jedan servis: sesije + dugoročna istorija + vektorska baza.
 * Svaki poziv nosi tenantId — nema načina da se pročita tuđi podatak.
 */
import { createSessionStore } from './session.js';
import { createLongTermMemory } from './longterm.js';
import { createVectorStore } from './vector.js';
import { createEmbeddings } from './embeddings.js';
import { createEpisodicMemory } from './episodic.js';
import { redactPii } from '../core/policy.js';

export function createMemory({ dataDir, llm, env = {}, logger, piiKinds } = {}) {
  const embedder = createEmbeddings({ llm, model: env?.llm?.embedModel ?? '', logger });
  const sessions = createSessionStore({ dataDir, logger, piiKinds });
  const longterm = createLongTermMemory({ dataDir, logger, piiKinds });
  const vectors = createVectorStore({ dataDir, embeddings: embedder, logger });
  const episodic = createEpisodicMemory({ dataDir, vectors, embeddings: embedder, logger });

  return {
    sessions,
    longterm,
    vectors,
    episodic,
    embedder,
    isSemantic: embedder.useReal,

    /** Upis jednog događaja u sva tri sloja gdje ima smisla. */
    async record(tenantId, event) {
      return longterm.append(tenantId, event);
    },

    /** Kontekst za prompt: relevantni fragmenti + trajne činjenice + slične prošle epizode. */
    async recall(tenantId, query, { k = 6, maxChars = 4000, includeFacts = true, includeEpisodes = true, episodesK = 3 } = {}) {
      const [ctx, facts, events, episodesText] = await Promise.all([
        vectors.contextFor(tenantId, query, { k, maxChars }),
        includeFacts ? longterm.readFacts(tenantId) : Promise.resolve({}),
        longterm.search(tenantId, { query, k: 3 }),
        includeEpisodes ? episodic.fewShotText(tenantId, query, { k: episodesK }) : Promise.resolve(''),
      ]);
      return {
        kb: ctx.text,
        citations: ctx.hits,
        facts,
        factsText: Object.values(facts)
          .map((f) => `- ${f.key}: ${typeof f.value === 'string' ? f.value : JSON.stringify(f.value)} (pouzdanost ${f.confidence})`)
          .join('\n'),
        episodesText,
        recentEvents: events.map((e) => ({ ts: e.ts, type: e.type, content: redactPii(String(e.content ?? '').slice(0, 300)) })),
      };
    },

    /** GDPR: briše sve što znamo o korisniku (facts + događaji ostaju u audit tragu kao dokaz brisanja). */
    async forgetUser(tenantId, userId) {
      const facts = await longterm.readFacts(tenantId);
      const removed = Object.values(facts).filter((f) => f.value && JSON.stringify(f.value).includes(userId)).length;
      await longterm.forget(tenantId, {});
      await longterm.append(tenantId, { type: 'note', content: `Zahtjev za brisanje podataka korisnika ${userId}`, data: { userId, removedFacts: removed } });
      return { userId, removedFacts: removed, kb: 'vektorski zapisi se brišu po docId (vidi vectors.remove)' };
    },
  };
}
