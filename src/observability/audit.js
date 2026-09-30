/**
 * Audit log sa hash lancem: svaki zapis sadrži hash prethodnog.
 * Brisanje/mijenjanje bilo kog zapisa obara verifikaciju lanca — to je dokaz za compliance.
 */
import path from 'node:path';
import { appendJsonl, readJsonl } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { sha256, stableStringify } from '../core/ids.js';
import { redact } from '../core/logger.js';
import { stripSecrets } from '../core/fsx.js';

export function createAuditLog({ dataDir, logger } = {}) {
  const heads = new Map(); // tenantId -> { seq, hash }

  const auditFile = (tenantId) => path.join(dataDir, 'tenants', tenantId, 'audit', 'audit.jsonl');
  const GENESIS = '0'.repeat(64);

  async function head(tenantId) {
    if (heads.has(tenantId)) return heads.get(tenantId);
    const rows = await readJsonl(auditFile(tenantId), { limit: 1, tail: true });
    const last = rows.at(-1);
    const h = last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS };
    heads.set(tenantId, h);
    return h;
  }

  return {
    /**
     * Upisuje audit zapis. Sadržaj se redaktuje (tajne i PII) prije upisa.
     * @returns {Promise<object>} zapis sa seq i hash
     */
    async append({ tenantId, actor = 'system', action, tool = null, args = {}, decision = 'allow', outcome = 'ok', runId = null, userId = null, meta = {} }) {
      const prev = await head(tenantId);
      const body = {
        ts: iso(),
        seq: prev.seq + 1,
        tenantId,
        actor,
        userId,
        runId,
        action,
        tool,
        args: safeArgs(args),
        decision,
        outcome,
        prevHash: prev.hash,
        meta: stripSecrets(meta),
      };
      const hash = sha256(stableStringify(body));
      const entry = { ...body, hash };
      if (dataDir) {
        try {
          await appendJsonl(auditFile(tenantId), entry);
        } catch (err) {
          logger?.warn?.('audit.persist_failed', { tenantId, error: err.message });
        }
      }
      heads.set(tenantId, { seq: entry.seq, hash });
      logger?.debug?.('audit.append', { tenantId, action, tool, decision, outcome, seq: entry.seq });
      return entry;
    },

    /** Verifikuje cijeli lanac za tenant. */
    async verify(tenantId) {
      const rows = await readJsonl(auditFile(tenantId));
      let prevHash = GENESIS;
      for (const row of rows) {
        const { hash, ...body } = row;
        if (body.prevHash !== prevHash) return { ok: false, checked: rows.length, firstBadSeq: row.seq, reason: 'prevHash se ne poklapa' };
        const expected = sha256(stableStringify(body));
        if (expected !== hash) return { ok: false, checked: rows.length, firstBadSeq: row.seq, reason: 'hash se ne poklapa (zapis je mijenjan)' };
        prevHash = hash;
      }
      return { ok: true, checked: rows.length, head: prevHash };
    },

    async read(tenantId, { limit = 50, tail = true } = {}) {
      return readJsonl(auditFile(tenantId), { limit, tail });
    },

    path: auditFile,
  };
}

function safeArgs(args) {
  const cleaned = stripSecrets(args ?? {});
  return JSON.parse(redact(JSON.stringify(cleaned)));
}
