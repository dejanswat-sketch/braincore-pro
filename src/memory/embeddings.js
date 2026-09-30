/**
 * Embeddings.
 *  - hashEmbedder: potpuno offline, determinističan, bez ključa i bez troška (dovoljno za demo i testove).
 *  - createEmbeddings: koristi pravi embedding model ako je konfigurisan, inače hash fallback.
 *
 * Napomena: hash-embedder NE razumije semantiku kao pravi model — koristi se za razvoj i kao fallback,
 * u produkciji uvijek uključiti NMQ_LLM_EMBED_MODEL.
 */

const DIM_DEFAULT = 384;

/** Tokenizacija: riječi (2+ znaka) + trigrami — daje blagi "fuzzy" efekat. */
function tokenize(text) {
  const norm = String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = norm.split(' ').filter((w) => w.length >= 2);
  const grams = [];
  for (const w of words) {
    for (let i = 0; i + 3 <= w.length; i += 1) grams.push(w.slice(i, i + 3));
  }
  return [...words, ...grams];
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministicki embedding iz teksta (nema mreže, nema troška). */
export function hashEmbedding(text, { dim = DIM_DEFAULT } = {}) {
  const vec = new Float64Array(dim);
  const tokens = tokenize(text);
  if (!tokens.length) return new Array(dim).fill(0);
  for (const tok of tokens) {
    const h = fnv1a(tok);
    const idx = h % dim;
    const sign = (h >>> 31) & 1 ? -1 : 1;
    vec[idx] += sign * (tok.length > 3 ? 1 : 0.5);
  }
  let norm = 0;
  for (let i = 0; i < dim; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => v / norm);
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * @param {object} opts
 * @param {object} [opts.llm]  LLM sa .embed(texts, {model})
 * @param {string} [opts.model] embedding model (ako nije zadat → hash)
 */
export function createEmbeddings({ llm, model = '', dim = DIM_DEFAULT, cacheSize = 500, logger } = {}) {
  const cache = new Map();
  const useReal = Boolean(llm && model && !llm.isMock);

  async function embed(texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    if (!useReal) return list.map((t) => hashEmbedding(t, { dim }));

    const out = new Array(list.length);
    const missing = [];
    list.forEach((t, i) => {
      const key = `${model}:${t}`;
      if (cache.has(key)) out[i] = cache.get(key);
      else missing.push({ t, i, key });
    });
    if (missing.length) {
      try {
        const res = await llm.embed(
          missing.map((m) => m.t),
          { model },
        );
        res.vectors.forEach((vec, j) => {
          const { i, key } = missing[j];
          out[i] = vec;
          if (cache.size >= cacheSize) cache.delete(cache.keys().next().value);
          cache.set(key, vec);
        });
      } catch (err) {
        logger?.warn?.('embeddings.real_failed_fallback_hash', { error: err.message });
        return list.map((t) => hashEmbedding(t, { dim }));
      }
    }
    return out;
  }

  return {
    name: useReal ? `real:${model}` : 'hash',
    dim,
    useReal,
    embed,
    embedOne: async (text) => (await embed([text]))[0],
  };
}

/** Dijeli dokument na chunkove po ~size znakova uz preklop, po granicama pasusa. */
export function chunkText(text, { size = 1000, overlap = 150, min = 80 } = {}) {
  const clean = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (clean.length <= size) return clean ? [clean] : [];
  const paragraphs = clean.split(/\n{2,}/);
  const chunks = [];
  let current = '';
  const push = () => {
    const t = current.trim();
    if (t.length >= min) chunks.push(t);
    current = t.slice(-overlap);
  };
  for (const p of paragraphs) {
    if ((current + p).length > size) {
      push();
      // veoma dugačak pasus → sijeci na tvrdo
      if (p.length > size) {
        for (let i = 0; i < p.length; i += size - overlap) {
          const piece = p.slice(i, i + size);
          if (piece.trim().length >= min) chunks.push(piece.trim());
        }
        current = '';
        continue;
      }
    }
    current += (current ? '\n\n' : '') + p;
  }
  const tail = current.trim();
  if (tail.length >= min) chunks.push(tail);
  return chunks;
}
