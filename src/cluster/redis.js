/**
 * ZASTARJELO (v0.6.0): ovaj fajl je bio samostalan RESP klijent (225 linija).
 * Kanonska implementacija je `src/resp-client.js` (189 linija, ime iz smernica), pa se ovdje samo
 * re-eksportuje — bez dupliranja koda i bez prelaska granice od 200 linija.
 *
 * Ako ti treba RESP klijent: `import { createRespClient } from '../resp-client.js'`.
 */
export {
  createRespClient as createRedisClient,
  createRespClient,
  encodeCommand,
  parseReply,
} from '../resp-client.js';

export { createRespClient as default } from '../resp-client.js';
