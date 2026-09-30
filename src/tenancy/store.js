/**
 * Tenancy: identitet tenanta, API ključevi, tajne integracija, rate limit, kill switch.
 * Pravilo: nijedna memorijska/alatna operacija ne prolazi bez tenantId — ovdje se tenant dokazuje.
 */
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readJson, writeJson, exists } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { AuthError, NotFoundError, ValidationError, NmqError } from '../core/errors.js';

export const ROLES = {
  owner: ['*'],
  admin: ['run', 'read', 'write', 'approve', 'manage-kb'],
  operator: ['run', 'read', 'approve'],
  viewer: ['read'],
};

export const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export function createTenantStore({ config, dataDir, logger, env = {} } = {}) {
  const rates = new Map(); // tenantId -> timestamps[]
  const suspended = new Map();

  const tenantDir = (tenantId) => path.join(dataDir, 'tenants', tenantId);
  const statusFile = (tenantId) => path.join(tenantDir(tenantId), 'status.json');
  const secretsFile = (tenantId) => path.join(tenantDir(tenantId), 'secrets', 'secrets.enc.json');

  function validateId(tenantId) {
    if (!TENANT_ID_RE.test(String(tenantId ?? ''))) throw new ValidationError(`Neispravan tenantId: ${tenantId}`, { pattern: TENANT_ID_RE.source });
    return tenantId;
  }

  /** Hash API ključa: sha256(pepper + ključ). Vrijednost ključa se NIKAD ne čuva. */
  function hashKey(key) {
    return createHash('sha256').update(`${env.apiKeyPepper ?? process.env.NMQ_API_KEY_PEPPER ?? 'nmq-robot'}:${key}`).digest('hex');
  }

  function deriveMasterKey(tenantId) {
    const material = env.masterKey || process.env.NMQ_MASTER_KEY || 'nmq-dev-master-key';
    return scryptSync(material, `nmq-tenant:${tenantId}`, 32);
  }

  return {
    validateId,
    hashKey,
    list: () => config.tenants.map((t) => ({ id: t.id, name: t.name, plan: t.plan, suspended: suspended.get(t.id) ?? false })),

    get(tenantId) {
      const tenant = config.tenant(tenantId);
      if (!tenant) throw new NotFoundError('Tenant', tenantId);
      return tenant;
    },

    has: (tenantId) => Boolean(config.tenant(tenantId)),

    /**
     * Dokazuje API ključ. Vraća {tenantId, role, keyId} ili baca AuthError.
     * Ako tenant nema definisanih ključeva, a NMQ_ALLOW_ANONYMOUS nije isključen → vraća default tenant (dev režim).
     */
    authenticate({ apiKey, tenantHint, required = config.requireAuth }) {
      const hashes = hashKey(apiKey ?? '');
      for (const tenant of config.tenants) {
        for (const key of tenant.apiKeys ?? []) {
          const a = Buffer.from(hashes);
          const b = Buffer.from(key.hash ?? '');
          if (a.length === b.length && timingSafeEqual(a, b)) {
            if (suspended.get(tenant.id) || tenant.suspended) throw new AuthError(`Tenant ${tenant.id} je suspendovan`);
            return { tenantId: tenant.id, role: key.role ?? 'operator', keyId: key.id ?? 'key', auth: 'api-key' };
          }
        }
      }
      if (!required && (config.env.allowAnonymous || tenantHint)) {
        const tenantId = tenantHint || config.env.defaultTenant;
        if (config.tenant(tenantId)) return { tenantId, role: 'owner', keyId: 'anonymous', auth: 'anonymous' };
      }
      if (apiKey) throw new AuthError('Nepoznat ili opozvan API ključ');
      if (required) throw new AuthError('Nedostaje API ključ (Authorization: Bearer <ključ>)');
      return { tenantId: config.env.defaultTenant, role: 'owner', keyId: 'anonymous', auth: 'anonymous' };
    },

    /** Dozvola po roli: action mora biti u listi (ili '*'). */
    can(role, action) {
      const perms = ROLES[role] ?? [];
      return perms.includes('*') || perms.includes(action);
    },

    assertCan(role, action) {
      if (!this.can(role, action)) throw new NmqError(`Rola "${role}" ne smije: ${action}`, { code: 'FORBIDDEN', status: 403 });
      return true;
    },

    /** Sliding-window rate limit po tenantu (u memoriji; Redis u produkciji). */
    rateLimit(tenantId, perMin = 60) {
      const now = Date.now();
      const windowStart = now - 60_000;
      const arr = (rates.get(tenantId) ?? []).filter((t) => t > windowStart);
      if (arr.length >= perMin) {
        rates.set(tenantId, arr);
        return { ok: false, remaining: 0, retryAfterSec: Math.ceil((arr[0] + 60_000 - now) / 1000) };
      }
      arr.push(now);
      rates.set(tenantId, arr);
      return { ok: true, remaining: perMin - arr.length, limit: perMin };
    },

    async setSuspended(tenantId, value, reason = null) {
      validateId(tenantId);
      suspended.set(tenantId, Boolean(value));
      await writeJson(statusFile(tenantId), { tenantId, suspended: Boolean(value), reason, updatedAt: iso() });
      logger?.warn?.('tenant.suspended', { tenantId, value, reason });
      return { tenantId, suspended: Boolean(value) };
    },

    isSuspended: (tenantId) => Boolean(suspended.get(tenantId)),

    async loadStatuses() {
      for (const t of config.tenants) {
        if (exists(statusFile(t.id))) {
          const s = await readJson(statusFile(t.id), null);
          if (s?.suspended) suspended.set(t.id, true);
        }
      }
      return [...suspended.entries()];
    },

    // ---------- tajne integracija (AES-256-GCM) ----------

    async setSecret(tenantId, provider, value) {
      validateId(tenantId);
      const store = await readJson(secretsFile(tenantId), {});
      const key = deriveMasterKey(tenantId);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`${tenantId}:v1`));
      const enc = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
      store[provider] = {
        v: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: enc.toString('base64'),
        updatedAt: iso(),
      };
      await writeJson(secretsFile(tenantId), store);
      logger?.info?.('tenant.secret_set', { tenantId, provider });
      return { tenantId, provider, updated: true };
    },

    async getSecret(tenantId, provider) {
      validateId(tenantId);
      const store = await readJson(secretsFile(tenantId), {});
      const rec = store[provider];
      if (!rec) return null;
      const key = deriveMasterKey(tenantId);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${tenantId}:v1`));
      decipher.setAuthTag(Buffer.from(rec.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(rec.data, 'base64')), decipher.final()]).toString('utf8');
    },

    async listSecrets(tenantId) {
      const store = await readJson(secretsFile(tenantId), {});
      return Object.entries(store).map(([provider, rec]) => ({ provider, updatedAt: rec.updatedAt }));
    },

    async deleteSecret(tenantId, provider) {
      const store = await readJson(secretsFile(tenantId), {});
      delete store[provider];
      await writeJson(secretsFile(tenantId), store);
      return { tenantId, provider, deleted: true };
    },

    paths: { tenantDir, secretsFile, statusFile },
  };
}
