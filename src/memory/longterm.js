/**
 * Dugoročna memorija: append-only istorija događaja + izvučene činjenice (facts).
 * Sve je particionisano po tenantu (fizički: data/tenants/<tenantId>/memory/).
 */
import path from 'node:path';
import { appendJsonl, readJson, readJsonl, writeJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid, sha256 } from '../core/ids.js';
import { redactPii } from '../core/policy.js';

const EVENT_TYPES = ['user_message', 'agent_message', 'tool_call', 'tool_result', 'decision', 'approval', 'outcome', 'fact', 'note'];

export function createLongTermMemory({ dataDir, logger, piiKinds = ['email', 'card', 'iban', 'jmbg'] } = {}) {
  const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
  const eventsFile = (tenantId, d = new Date()) => path.join(dataDir, 'tenants', tenantId, 'memory', `events-${monthKey(d)}.jsonl`);
  const factsFile = (tenantId) => path.join(dataDir, 'tenants', tenantId, 'memory', 'facts.json');

  return {
    EVENT_TYPES,

    /** Upisuje događaj u istoriju. */
    async append(tenantId, { type = 'note', agentId = null, sessionId = null, userId = null, runId = null, content, data = {}, importance = 0.5 } = {}) {
      if (!EVENT_TYPES.includes(type)) throw new Error(`Nepoznat tip događaja: ${type}`);
      const event = {
        id: uid('evt'),
        ts: iso(),
        tenantId,
        type,
        agentId,
        sessionId,
        userId,
        runId,
        content: typeof content === 'string' ? redactPii(content, piiKinds) : content ?? '',
        data: redactObj(data, piiKinds),
        importance,
      };
      if (dataDir) await appendJsonl(eventsFile(tenantId), event);
      return event;
    },

    async recent(tenantId, { limit = 50, type, sessionId } = {}) {
      const rows = await readJsonl(eventsFile(tenantId), { limit: limit * 3, tail: true });
      return rows
        .filter((r) => (!type || r.type === type) && (!sessionId || r.sessionId === sessionId))
        .slice(-limit)
        .reverse();
    },

    /** Prosta pretraga po preklapanju riječi (bez vektora) — brza i jeftina. */
    async search(tenantId, { query, k = 8, types } = {}) {
      const rows = await readJsonl(eventsFile(tenantId), { limit: 2000, tail: true });
      const terms = tokenize(query);
      if (!terms.length) return rows.slice(-k).reverse();
      const scored = rows
        .filter((r) => !types || types.includes(r.type))
        .map((r) => {
          const text = `${r.content ?? ''} ${JSON.stringify(r.data ?? {})}`.toLowerCase();
          const score = terms.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0) / terms.length;
          return { row: r, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || String(b.row.ts).localeCompare(String(a.row.ts)))
        .slice(0, k);
      return scored.map((s) => ({ ...s.row, _score: Number(s.score.toFixed(3)) }));
    },

    // ---- facts (trajne činjenice o korisniku/kompaniji) ----

    async readFacts(tenantId) {
      return readJson(factsFile(tenantId), {});
    },

    async upsertFact(tenantId, key, value, { source = 'agent', confidence = 0.7 } = {}) {
      const facts = await readJson(factsFile(tenantId), {});
      const existing = facts[key];
      facts[key] = {
        key,
        value,
        confidence: existing ? Math.max(existing.confidence ?? 0, confidence) : confidence,
        source,
        firstSeen: existing?.firstSeen ?? iso(),
        updatedAt: iso(),
        revisions: (existing?.revisions ?? 0) + (existing && existing.value !== value ? 1 : 0),
      };
      if (dataDir) await writeJson(factsFile(tenantId), facts);
      return facts[key];
    },

    async forget(tenantId, { key, userId } = {}) {
      const facts = await readJson(factsFile(tenantId), {});
      if (key) delete facts[key];
      const before = Object.keys(facts).length;
      await writeJson(factsFile(tenantId), facts);
      return { removed: key ? 1 : before, remaining: Object.keys(facts).length };
    },

    factsFile,
    eventsFile,
  };
}

function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3)
    .slice(0, 24);
}

function redactObj(obj, kinds) {
  const json = redactPii(JSON.stringify(obj ?? {}), kinds);
  try {
    return JSON.parse(json);
  } catch {
    return { raw: json };
  }
}

export { tokenize as tokenizeForSearch, sha256 };
