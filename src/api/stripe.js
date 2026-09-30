/**
 * Stripe webhook → izdavanje API ključa (bez npm zavisnosti: `crypto` za HMAC verifikaciju).
 *
 * Tok (po smernicama): sajt na Hostingeru vodi na Stripe Checkout; poslije plaćanja
 * (`checkout.session.completed`) Stripe zove `POST /v1/stripe/webhook` na api.braincore.pro;
 * mi verifikujemo potpis i izdajemo API ključ za mašinu (klijent ga koristi za svoj edge node).
 *
 * Sigurnost:
 *   • potpis: `Stripe-Signature: t=<ts>,v1=<hmac>` gdje je HMAC-SHA256 nad `${t}.${rawBody}` sa `STRIPE_WEBHOOK_SECRET`
 *   • tolerancija na vrijeme (default 300s) — protiv replay-a
 *   • čuva se SAMO SHA-256 hash ključa (`data/keys.json`), pun ključ se vraća jednom
 *   • idempotencija: isti `event.id` se ne obrađuje dva puta (Stripe ume ponoviti webhook)
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { exists, readJson, writeJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { AuthError, ValidationError } from '../core/errors.js';

const statSafe = (file) => stat(file).catch(() => null);

export const DEFAULT_TOLERANCE_SEC = 300;

/** Verifikuj Stripe potpis. Vraća `{ ok, reason }`. */
export function verifyStripeSignature({ rawBody, header, secret, toleranceSec = DEFAULT_TOLERANCE_SEC, now = Date.now() }) {
  if (!secret) throw new ValidationError('verifyStripeSignature traži "secret" (STRIPE_WEBHOOK_SECRET)');
  if (!header) return { ok: false, reason: 'nema_potpisa' };
  const parts = Object.fromEntries(
    String(header)
      .split(',')
      .map((kv) => kv.split('='))
      .filter((kv) => kv.length === 2),
  );
  if (!parts.t || !parts.v1) return { ok: false, reason: 'nepotpun_potpis' };
  const ts = Number(parts.t);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'losi_timestamp' };
  if (Math.abs(now / 1000 - ts) > toleranceSec) return { ok: false, reason: 'istekao_timestamp' };
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'losi_potpis' };
  return { ok: true };
}

/** Potpiši tijelo (koristi se u testovima i za lokalnu provjeru integracije). */
export function signPayload({ rawBody, secret, timestamp = Math.floor(Date.now() / 1000) }) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

export function createKeyIssuer({ dataDir, logger, metrics, audit, prefix = 'bnc_' } = {}) {
  const file = dataDir ? path.join(dataDir, '_control', 'api-keys.json') : null;
  let cache = null;
  let cacheMtime = 0;

  /**
   * Učitaj stanje. Fajl je izvor istine: ako ga je promijenio DRUGI proces (CLI, drugi node, admin alat),
   * keš se osvježava po `mtime` — inače bi opoziv ključa u jednom procesu bio nevidljiv u drugom.
   */
  async function load() {
    if (!file) {
      cache = cache ?? { keys: [], events: [] };
      return cache;
    }
    const stat = await statSafe(file);
    if (!cache || (stat && stat.mtimeMs !== cacheMtime)) {
      cache = exists(file) ? await readJson(file, { keys: [], events: [] }) : { keys: [], events: [] };
      cacheMtime = stat?.mtimeMs ?? 0;
    }
    if (!cache.keys) cache.keys = [];
    if (!cache.events) cache.events = [];
    return cache;
  }

  async function persist() {
    if (!file) return;
    await writeJson(file, cache);
    const stat = await statSafe(file);
    cacheMtime = stat?.mtimeMs ?? Date.now();
  }

  const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

  return {
    file,
    hashKey,

    /** Izdaj novi ključ (pun ključ se vraća SAMO ovdje, poslije se čuva hash). */
    async issue({ tenantId = 'nmq', email = null, plan = 'pro-999', stripeSessionId = null, metered = true } = {}) {
      const state = await load();
      const key = `${prefix}${crypto.randomBytes(24).toString('base64url')}`;
      const record = {
        id: `key_${crypto.randomBytes(6).toString('hex')}`,
        hash: hashKey(key),
        preview: `${key.slice(0, 8)}…${key.slice(-4)}`,
        tenantId,
        email,
        plan,
        metered,
        stripeSessionId,
        createdAt: iso(),
        revokedAt: null,
        calls: 0,
      };
      state.keys.push(record);
      await persist();
      metrics?.inc('billing_keys_issued_total', { plan });
      logger?.warn?.('billing.key_issued', { id: record.id, tenantId, plan, preview: record.preview });
      await audit?.append({ tenantId, actor: 'stripe-webhook', action: 'api_key_issued', args: { id: record.id, plan, stripeSessionId }, decision: 'allow', outcome: 'ok' });
      return { key, record };
    },

    /** Provjeri ključ (hash pažljivo, konstantno vrijeme). */
    async verify(key) {
      const state = await load();
      const h = Buffer.from(hashKey(key));
      for (const record of state.keys) {
        if (record.revokedAt) continue;
        const r = Buffer.from(record.hash);
        if (r.length === h.length && crypto.timingSafeEqual(r, h)) {
          record.calls = (record.calls ?? 0) + 1;
          return record;
        }
      }
      return null;
    },

    async revoke(id, { by = 'board' } = {}) {
      const state = await load();
      const record = state.keys.find((k) => k.id === id);
      if (!record) throw new ValidationError(`Nepoznat ključ: ${id}`);
      record.revokedAt = iso();
      record.revokedBy = by;
      await persist();
      return record;
    },

    async list() {
      const state = await load();
      return state.keys.map(({ hash, ...rest }) => rest);
    },

    /** Idempotencija webhook-ova: vraća `true` ako je događaj već obrađen. */
    async seenEvent(eventId) {
      const state = await load();
      if (!eventId) return false;
      if (state.events.includes(eventId)) return true;
      state.events.push(eventId);
      if (state.events.length > 1000) state.events.shift();
      await persist();
      return false;
    },
  };
}

/**
 * Obradi Stripe webhook: verifikuj potpis, provjeri idempotenciju i na uspješno plaćanje izdaj ključ.
 * @returns {{ status:number, body:object }}
 */
export async function handleStripeWebhook({ rawBody, signature, secret, issuer, logger, metrics, toleranceSec = DEFAULT_TOLERANCE_SEC }) {
  const check = verifyStripeSignature({ rawBody, header: signature, secret, toleranceSec });
  if (!check.ok) {
    metrics?.inc('billing_webhook_rejected_total', { reason: check.reason });
    logger?.warn?.('billing.webhook_rejected', { reason: check.reason });
    throw new AuthError(`Stripe potpis nije ispravan (${check.reason})`);
  }
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new ValidationError('Webhook tijelo nije JSON');
  }
  if (await issuer.seenEvent(event.id)) return { status: 200, body: { received: true, duplicate: true } };

  const type = event.type ?? 'unknown';
  metrics?.inc('billing_webhook_total', { type });
  if (type === 'checkout.session.completed' || type === 'customer.subscription.created') {
    const session = event.data?.object ?? {};
    const email = session.customer_details?.email ?? session.customer_email ?? null;
    const plan = session.metadata?.plan ?? (session.amount_total >= 99_900 ? 'pro-999' : 'starter');
    const { key, record } = await issuer.issue({ tenantId: session.metadata?.tenant ?? 'nmq', email, plan, stripeSessionId: session.id ?? null });
    return { status: 200, body: { received: true, issued: true, key, keyId: record.id, plan, note: 'Ključ se prikazuje samo jednom; sačuvaj ga u svom edge node-u (NMQ_API_KEY).' } };
  }
  return { status: 200, body: { received: true, ignored: type } };
}
