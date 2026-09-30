/**
 * Vektorska memorija (RAG) sa strogom izolacijom po tenantu.
 *
 * Implementacija: brute-force cosine u memoriji + JSONL na disku po tenantu.
 * Interfejs je namjerno isti kao za pgvector/Qdrant — zamjena ne dira agente.
 *
 * PRAVILO: svaki dokument nosi metadata.tenantId i mora se poklopiti sa tenantId upita.
 * Dokument bez podudarnog tenanta se NIKAD ne vraća (testirano u tests/memory.test.mjs).
 */
import path from 'node:path';
import { appendJsonl, readJsonl, writeJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { cosineSimilarity, chunkText } from './embeddings.js';

export function createVectorStore({ dataDir, embeddings, logger, defaultDim = 384 } = {}) {
  const tenants = new Map(); // tenantId -> Map<id, doc>
  const loaded = new Set();

  const nsKey = (tenantId) => tenantId;
  const docsFile = (tenantId) => path.join(dataDir, 'tenants', tenantId, 'vectors', 'docs.jsonl');

  function bucket(tenantId) {
    if (!tenants.has(nsKey(tenantId))) tenants.set(nsKey(tenantId), new Map());
    return tenants.get(nsKey(tenantId));
  }

  async function ensureLoaded(tenantId) {
    if (!dataDir || loaded.has(tenantId)) return;
    loaded.add(tenantId);
    const rows = await readJsonl(docsFile(tenantId));
    const b = bucket(tenantId);
    for (const row of rows) if (row?.id) b.set(row.id, row);
  }

  async function upsert(tenantId, doc) {
    await ensureLoaded(tenantId);
    const text = String(doc.text ?? '');
    const embedding = doc.embedding ?? (await embeddings.embedOne(text));
    const record = {
      id: doc.id ?? uid('doc'),
      tenantId,
      text,
      embedding,
      dim: embedding.length,
      metadata: { ...(doc.metadata ?? {}), tenantId },
      createdAt: doc.createdAt ?? iso(),
      updatedAt: iso(),
    };
    bucket(tenantId).set(record.id, record);
    if (dataDir) await appendJsonl(docsFile(tenantId), record);
    return { id: record.id, dim: record.dim, metadata: record.metadata };
  }

  /** Ingestion dokumenta: chunk → embed → upsert. */
  async function ingest(tenantId, { text, source, docId, metadata = {}, chunk = {} }) {
    const pieces = chunkText(text, chunk);
    const vectors = await embeddings.embed(pieces);
    const ids = [];
    for (let i = 0; i < pieces.length; i += 1) {
      const res = await upsert(tenantId, {
        text: pieces[i],
        embedding: vectors[i],
        metadata: { ...metadata, source, docId: docId ?? uid('kb'), chunk: i, chunks: pieces.length },
      });
      ids.push(res.id);
    }
    logger?.debug?.('vector.ingest', { tenantId, docId, chunks: pieces.length });
    return { docId: docId ?? null, chunks: pieces.length, ids };
  }

  /**
   * Pretraga. Filter se primjenjuje PRIJE licitiranja (i tenant filter je obavezan).
   */
  async function query(tenantId, { text, embedding, k = 6, filter = {}, minScore = 0.05 } = {}) {
    await ensureLoaded(tenantId);
    const b = bucket(tenantId);
    if (!b.size) return [];
    const qvec = embedding ?? (await embeddings.embedOne(text ?? ''));
    const results = [];
    for (const doc of b.values()) {
      if (doc.tenantId !== tenantId) continue; // tvrda brava protiv cross-tenant curenja
      if (!matchFilter(doc.metadata, filter)) continue;
      const score = cosineSimilarity(qvec, doc.embedding);
      if (score < minScore) continue;
      results.push({ id: doc.id, score: Number(score.toFixed(4)), text: doc.text, metadata: doc.metadata });
    }
    return results.sort((a, b2) => b2.score - a.score).slice(0, k);
  }

  return {
    upsert,
    ingest,
    query,
    dim: embeddings?.dim ?? defaultDim,
    embedder: embeddings?.name ?? 'unknown',

    async remove(tenantId, id) {
      await ensureLoaded(tenantId);
      return bucket(tenantId).delete(id);
    },

    /** Briše sve zapise koji zadovoljavaju filter (npr. { userId } ili { docId }) — za GDPR. */
    async removeByMetadata(tenantId, filter = {}) {
      await ensureLoaded(tenantId);
      const b = bucket(tenantId);
      let removed = 0;
      for (const [id, doc] of [...b.entries()]) {
        if (matchFilter(doc.metadata, filter)) {
          b.delete(id);
          removed += 1;
        }
      }
      if (removed) logger?.warn?.('vector.remove_by_metadata', { tenantId, removed, filter: Object.keys(filter) });
      return { removed, filter };
    },

    async count(tenantId) {
      await ensureLoaded(tenantId);
      return bucket(tenantId).size;
    },

    /** Snimi trenutno stanje (kompaktno) — za backup/migraciju. */
    async compact(tenantId) {
      if (!dataDir) return null;
      const file = path.join(dataDir, 'tenants', tenantId, 'vectors', 'docs.compact.json');
      await writeJson(file, [...bucket(tenantId).values()]);
      return file;
    },

    async clearTenant(tenantId) {
      bucket(tenantId).clear();
      loaded.delete(tenantId);
    },

    /** Kontekst za prompt sa citatima (obavezan za support/legal domene). */
    async contextFor(tenantId, question, { k = 6, maxChars = 4000, filter = {} } = {}) {
      const hits = await query(tenantId, { text: question, k, filter, minScore: 0.05 });
      if (!hits.length) return { text: '', hits: [] };
      let used = 0;
      const parts = [];
      const cited = [];
      hits.forEach((h, i) => {
        const block = `[${i + 1}] (${h.metadata?.source ?? 'izvor'}, score ${h.score})\n${h.text}`;
        if (used + block.length > maxChars) return;
        used += block.length;
        parts.push(block);
        cited.push({ n: i + 1, id: h.id, source: h.metadata?.source ?? null, score: h.score });
      });
      return { text: parts.join('\n\n'), hits: cited };
    },
  };
}

function matchFilter(metadata = {}, filter = {}) {
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined || v === null) continue;
    const mv = metadata?.[k];
    if (Array.isArray(v)) {
      if (!v.includes(mv)) return false;
    } else if (typeof v === 'function') {
      if (!v(mv)) return false;
    } else if (mv !== v) {
      return false;
    }
  }
  return true;
}

export { chunkText };
