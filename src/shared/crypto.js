/**
 * Klaster kripto — povjerljivost podataka na žici (UDP gossip je čist tekst, HMAC daje samo integritet).
 *
 * Zašto: `src/node.js` šalje task (uključujući `payload`) preko UDP-a. HMAC potpis dokazuje da poruka
 * nije mijenjana, ali je **ne krije** — svako ko snima mrežu vidio bi sadržaj ticketa. Zato se payload
 * šifruje AES-256-GCM ključem izvedenim iz `NMQ_CLUSTER_SECRET` (HKDF preko SHA-256 sa oznakom namjene).
 *
 * Šta je garantovano:
 *   • povjerljivost: bez tajne klastera sadržaj se ne može pročitati (GCM auth tag to i dokazuje)
 *   • integritet: GCM auth tag pada ako je i jedan bit promijenjen
 *   • svježina: `iv` je slučajan po poruci (12 bajtova), pa ista poruka daje različit ciphertext
 *
 * Šta NIJE: nema rotacije ključa (dodaj `keyId` u budućoj fazi), nema zaštite od replay-a na ovom sloju
 * (gossip poruke nose `ts` i deduplikaciju po `id`, ali to nije kriptografski anti-replay).
 */
import crypto from 'node:crypto';
import { ValidationError } from '../core/errors.js';

const HKDF_INFO = 'nmq-cluster-payload-v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Izvedi 32-bajtni ključ iz tajne klastera (deterministički, bez eksternih zavisnosti). */
export function deriveKey(secret) {
  if (!secret) throw new ValidationError('deriveKey traži tajnu klastera');
  return crypto.hkdfSync('sha256', Buffer.from(String(secret)), Buffer.from('nmq-cluster-salt'), Buffer.from(HKDF_INFO), 32);
}

/**
 * Šifruj proizvoljan JSON kao `{ v, iv, tag, data, bytes, sha256 }` (base64).
 * `sha256` je otisak ČISTOG teksta (za provjeru poslije dešifrovanja i za dedup bez otkrivanja sadržaja).
 */
export function encryptPayload(secret, value, { aad = null } = {}) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad)));
  const plaintext = Buffer.from(JSON.stringify(value ?? null), 'utf8');
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
    bytes: plaintext.length,
    sha256: crypto.createHash('sha256').update(plaintext).digest('hex').slice(0, 32),
  };
}

/** Dešifruj; baca grešku ako tajna nije ista ili je sadržaj mijenjan. */
export function decryptPayload(secret, envelope, { aad = null } = {}) {
  if (!envelope || envelope.v !== 1) throw new ValidationError('Nepoznat format šifrovanog payload-a');
  const key = deriveKey(secret);
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new ValidationError('Neispravan iv/tag');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(Buffer.from(String(aad)));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex').slice(0, 32);
  if (envelope.sha256 && hash !== envelope.sha256) throw new ValidationError('Otisak sadržaja se ne poklapa');
  return JSON.parse(plaintext.toString('utf8'));
}

/** Da li objekat izgleda kao šifrovani payload (za razlikovanje od čistog teksta u logovima/testovima). */
export function isEncrypted(value) {
  return Boolean(value && typeof value === 'object' && value.v === 1 && value.data && value.iv && value.tag);
}
