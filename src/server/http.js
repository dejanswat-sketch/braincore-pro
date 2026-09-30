/**
 * HTTP gateway bez zavisnosti: micro-router + CORS + auth + rate limit + SSE.
 * Rute se zadaju kao { method, path: '/v1/agents/:id/run', auth: true, rate: true, handler(ctx) }
 */
import http from 'node:http';
import { toErrorPayload, ValidationError, NmqError } from '../core/errors.js';
import { uid, truncate } from '../core/ids.js';
import { iso } from '../core/clock.js';

const MAX_BODY = 1_000_000; // 1 MB

export function compileRoutes(routes) {
  return routes.map((route) => ({
    ...route,
    method: route.method.toUpperCase(),
    segments: route.path.split('/').filter(Boolean),
  }));
}

export function matchRoute(routes, method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method && route.method !== 'ALL') continue;
    if (route.segments.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < route.segments.length; i += 1) {
      const seg = route.segments[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

export function createRequestHandler({ routes, robot, logger, metrics, config, tenants }) {
  const compiled = compileRoutes(routes);

  return async function handler(req, res) {
    const started = Date.now();
    const requestId = req.headers['x-request-id'] ?? uid('req');
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const origin = req.headers.origin ?? '*';

    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-api-key, x-request-id, x-tenant');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-robot-version', robot.version);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const match = matchRoute(compiled, req.method, url.pathname);
    if (!match) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `Nema rute ${req.method} ${url.pathname}` } });
      return;
    }
    const { route, params } = match;

    try {
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      const query = Object.fromEntries(url.searchParams.entries());

      let auth = { tenantId: null, role: 'viewer', keyId: null, auth: 'public' };
      if (route.auth !== false) {
        const apiKey = extractKey(req);
        auth = tenants.authenticate({
          apiKey,
          tenantHint: req.headers['x-tenant'] ?? body?.tenantId ?? query.tenant,
          required: route.auth === 'required' || config.requireAuth,
        });
        if (tenants.isSuspended(auth.tenantId)) throw new NmqError('Tenant je suspendovan', { code: 'TENANT_SUSPENDED', status: 403 });
      }

      if (route.rate !== false && auth.tenantId) {
        const tenant = auth.tenantId ? config.tenant(auth.tenantId) : null;
        const perMin = route.rateLimit ?? tenant?.rateLimitPerMin ?? config.env.rateLimitPerMin;
        const rl = tenants.rateLimit(auth.tenantId, perMin);
        res.setHeader('x-ratelimit-remaining', String(rl.remaining ?? 0));
        if (!rl.ok) {
          res.setHeader('retry-after', String(rl.retryAfterSec ?? 60));
          metrics?.inc('rate_limited_total', { tenant: auth.tenantId });
          sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: `Previše zahtjeva (${perMin}/min)` } });
          return;
        }
      }

      if (route.requiredRole) tenants.assertCan(auth.role, route.requiredRole);

      const result = await route.handler({
        req,
        res,
        params,
        query,
        body: body ?? {},
        auth,
        tenantId: auth.tenantId,
        role: auth.role,
        robot,
        config,
        tenants,
        logger,
        metrics,
        requestId,
        origin,
        url,
      });

      if (res.writableEnded) {
        logAccess(req, url, res.statusCode, Date.now() - started, requestId, auth);
        return;
      }
      if (result === undefined) {
        sendJson(res, 204, null);
      } else if (result && typeof result === 'object' && ('status' in result && 'body' in result)) {
        sendJson(res, result.status, result.body, result.headers);
      } else {
        sendJson(res, 200, result);
      }
      logAccess(req, url, res.statusCode, Date.now() - started, requestId, auth);
    } catch (err) {
      const { status, body } = toErrorPayload(err);
      metrics?.inc('http_errors_total', { code: err?.code ?? 'INTERNAL', status: String(status) });
      if (status >= 500) logger?.error?.('http.error', { requestId, path: url.pathname, error: err?.message, code: err?.code, stack: truncate(err?.stack, 600) });
      else logger?.debug?.('http.client_error', { requestId, path: url.pathname, code: err?.code, message: err?.message });
      sendJson(res, status, { ...body, requestId });
      logAccess(req, url, status, Date.now() - started, requestId, { tenantId: null });
    }
  };
}

function logAccess(req, url, status, durationMs, requestId, auth) {
  // access log ide kroz metrics + debug logger; ne logujemo tijelo
  if (process.env.NMQ_ACCESS_LOG === '1') {
    process.stdout.write(`${iso()} ${req.method} ${url.pathname} ${status} ${durationMs}ms tenant=${auth?.tenantId ?? '-'} req=${requestId}\n`);
  }
}

export function createHttpServer({ routes, robot, logger, metrics, config, tenants }) {
  const handler = createRequestHandler({ routes, robot, logger, metrics, config, tenants });
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      logger?.error?.('http.unhandled', { error: err?.message, stack: truncate(err?.stack, 500) });
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Interna greška' } });
      else res.end();
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  return server;
}

function sendJson(res, status, payload, headers = {}) {
  const body = payload === null || payload === undefined ? '' : JSON.stringify(payload, null, process.env.NMQ_PRETTY_JSON === '1' ? 2 : 0);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function extractKey(req) {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return req.headers['x-api-key'] ?? null;
}

async function readBody(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ValidationError(`Tijelo zahtjeva je preveliko (${limit} bajtova)`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  const ctype = req.headers['content-type'] ?? '';
  if (ctype.includes('application/json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new ValidationError('Neispravan JSON u tijelu zahtjeva');
    }
  }
  return { raw: text };
}

export function listen(server, { port, host }) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address()));
  });
}
