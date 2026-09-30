/**
 * Kratkoročna memorija sesije: klizni prozor poruka + sažetak + činjenice o korisniku.
 * MVP: u memoriji + JSONL na disku (tenant se nikad ne miješa — ključ sadrži tenantId).
 */
import path from 'node:path';
import { appendJsonl, readJsonl, writeJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { redactPii } from '../core/policy.js';

export function createSessionStore({ dataDir, logger, maxMessages = 40, keepRecent = 12, ttlMs = 7 * 24 * 3600 * 1000, piiKinds = ['email', 'card', 'iban', 'jmbg'] } = {}) {
  const sessions = new Map();
  const key = (tenantId, sessionId) => `${tenantId}::${sessionId}`;
  // Ime fajla mora biti sigurno za fajl-sistem (sessionId može sadržati ':' ili '/' — npr. "eval:golden:case1")
  const safeId = (sessionId) => String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  const sessionFile = (tenantId, sessionId) => path.join(dataDir, 'tenants', tenantId, 'sessions', `${safeId(sessionId)}.jsonl`);

  function create(tenantId, { sessionId = uid('sess'), agentId = null, userId = null, meta = {} } = {}) {
    const session = {
      sessionId,
      tenantId,
      agentId,
      userId,
      createdAt: iso(),
      updatedAt: iso(),
      summary: '',
      facts: {},
      messages: [],
      meta,
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    };
    sessions.set(key(tenantId, sessionId), session);
    return session;
  }

  function get(tenantId, sessionId) {
    const s = sessions.get(key(tenantId, sessionId));
    if (!s) return null;
    if (Date.now() - new Date(s.updatedAt).getTime() > ttlMs) {
      sessions.delete(key(tenantId, sessionId));
      return null;
    }
    return s;
  }

  function getOrCreate(tenantId, sessionId, opts = {}) {
    return (sessionId && get(tenantId, sessionId)) || create(tenantId, { sessionId, ...opts });
  }

  return {
    create,
    get,
    getOrCreate,

    /** Dodaje poruku; PII se redaktuje prije trajnog upisa. */
    append(session, message) {
      const entry = {
        role: message.role,
        content: message.content ?? '',
        name: message.name,
        toolCallId: message.toolCallId,
        toolCalls: message.toolCalls,
        ts: iso(),
      };
      session.messages.push(entry);
      session.updatedAt = entry.ts;
      if (session.messages.length > maxMessages) {
        const dropped = session.messages.splice(0, session.messages.length - maxMessages);
        session.summary = [session.summary, dropped.map((m) => `${m.role}: ${String(m.content).slice(0, 240)}`).join('\n')]
          .filter(Boolean)
          .join('\n')
          .slice(-4000);
      }
      if (dataDir) {
        const persisted = { ...entry, tenantId: session.tenantId, sessionId: session.sessionId };
        if (typeof persisted.content === 'string') persisted.content = redactPii(persisted.content, piiKinds);
        appendJsonl(sessionFile(session.tenantId, session.sessionId), persisted).catch((err) =>
          logger?.warn?.('session.persist_failed', { error: err.message }),
        );
      }
      return entry;
    },

    /** Poruke za LLM: sažetak + poslednjih N. */
    toMessages(session, { system } = {}) {
      const recent = session.messages.slice(-keepRecent).map((m) => {
        if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.toolCallId, name: m.name };
        if (m.role === 'assistant' && m.toolCalls?.length) return { role: 'assistant', content: m.content ?? '', tool_calls: m.toolCalls };
        return { role: m.role, content: m.content };
      });
      return [...(system ? [{ role: 'system', content: system }] : []), ...(session.summary ? [{ role: 'system', content: `Sažetak prethodnog razgovora:\n${session.summary}` }] : []), ...recent];
    },

    setFact(session, keyName, value) {
      session.facts[keyName] = value;
      session.updatedAt = iso();
      return session.facts;
    },

    factsText(session) {
      const entries = Object.entries(session.facts ?? {});
      if (!entries.length) return '';
      return `Poznato o korisniku:\n${entries.map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')}`;
    },

    async snapshot(session) {
      if (!dataDir) return null;
      const file = path.join(dataDir, 'tenants', session.tenantId, 'sessions', `${session.sessionId}.json`);
      await writeJson(file, { ...session, messages: session.messages.slice(-keepRecent) });
      return file;
    },

    async loadFromDisk(tenantId, sessionId) {
      const rows = await readJsonl(sessionFile(tenantId, sessionId));
      if (!rows.length) return null;
      const session = create(tenantId, { sessionId });
      session.messages = rows.slice(-maxMessages);
      session.updatedAt = rows.at(-1).ts;
      return session;
    },

    async summarize(session, llm, { model, maxChars = 1200 } = {}) {
      if (!llm || session.messages.length < 8) return session.summary;
      const text = session.messages.map((m) => `${m.role}: ${String(m.content).slice(0, 500)}`).join('\n');
      try {
        const res = await llm.chat({
          model,
          messages: [
            { role: 'system', content: 'Sažmi razgovor u najviše 12 kratkih činjenica i otvorenih zadataka. Bez uvoda.' },
            { role: 'user', content: text },
          ],
          maxTokens: 400,
          temperature: 0,
        });
        session.summary = res.text.slice(0, maxChars);
      } catch (err) {
        logger?.warn?.('session.summarize_failed', { error: err.message });
      }
      return session.summary;
    },

    count: () => sessions.size,
    clear: () => sessions.clear(),
    keys: () => [...sessions.keys()],
  };
}
