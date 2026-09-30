/**
 * Rute v0.5: cross-node swarm (klaster).
 *
 * Sigurnosna namjera: klaster mijenja samo `owner`/`admin` (board) — pridruživanje čvora, izbacivanje
 * člana i broadcast su privilegovane operacije, a svaka ide u audit. Čitanje je dozvoljeno ulozi `read`.
 */
import { PolicyError, ValidationError } from '../core/errors.js';

export function createClusterRoutes({ robot, config, tenants, logger, metrics }) {
  const need = () => {
    const cluster = robot.cluster;
    if (!cluster) {
      throw new PolicyError('Klaster nije uključen (postavi NMQ_CLUSTER=1 ili config/cluster.json → enabled: true)');
    }
    return cluster;
  };

  return [
    {
      method: 'GET',
      path: '/v1/admin/cluster',
      requiredRole: 'read',
      handler: async ({ tenantId }) => ({ ...(await need().stats({ tenantId })), warning: 'Bez `redisUrl` tabla je deljena preko direktorijuma (file store) — za više mašina koristi Redis.' }),
    },
    {
      method: 'GET',
      path: '/v1/admin/cluster/members',
      requiredRole: 'read',
      handler: async () => ({ nodeId: need().nodeId, members: need().membership() }),
    },
    {
      method: 'POST',
      path: '/v1/admin/cluster/join',
      requiredRole: 'owner',
      handler: async ({ body, auth }) => {
        const peers = body?.peers ?? (body?.peer ? [body.peer] : []);
        if (!peers.length) throw new ValidationError('Traži se "peers": ["host:port", ...]');
        const result = await need().join(peers);
        await robot.audit?.append({ tenantId: '_global', actor: auth?.keyId ?? 'board', action: 'cluster_join', args: { peers }, decision: 'allow', outcome: 'ok' });
        return result;
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/cluster/leave',
      requiredRole: 'owner',
      handler: async ({ body }) => ({ left: await need().gossip.leave(), reason: body?.reason ?? null }),
    },
    {
      method: 'POST',
      path: '/v1/admin/cluster/broadcast',
      requiredRole: 'admin',
      handler: async ({ body }) => {
        if (!body?.type) throw new ValidationError('Traži se "type"');
        return need().gossip.broadcast(body.type, body.payload ?? {}, { ttl: body.ttl ?? undefined });
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/cluster/quarantine/:nodeId',
      requiredRole: 'owner',
      handler: async ({ params, body, auth }) => {
        const result = need().gossip.quarantineMember(params.nodeId, body?.reason ?? 'manual');
        await robot.swarmSafety?.quarantine(`node:${params.nodeId}`, `board:${body?.reason ?? 'manual'}`);
        await robot.audit?.append({ tenantId: '_global', actor: auth?.keyId ?? 'board', action: 'cluster_quarantine_node', args: { nodeId: params.nodeId, reason: body?.reason ?? null }, decision: 'deny', outcome: 'blocked' });
        return result;
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/cluster/release/:nodeId',
      requiredRole: 'owner',
      handler: async ({ params, auth }) => {
        const result = need().gossip.releaseMember(params.nodeId, { by: auth?.keyId ?? 'board' });
        await robot.swarmSafety?.release(`node:${params.nodeId}`);
        await robot.audit?.append({ tenantId: '_global', actor: auth?.keyId ?? 'board', action: 'cluster_release_node', args: { nodeId: params.nodeId }, decision: 'allow', outcome: 'ok' });
        return result;
      },
    },
    {
      method: 'POST',
      path: '/v1/admin/cluster/tasks',
      requiredRole: 'run',
      handler: async ({ tenantId, body, auth }) => {
        const list = Array.isArray(body?.tasks) ? body.tasks : [body];
        const created = [];
        for (const t of list) {
          if (!t?.title) throw new ValidationError('Svaki zadatak traži "title"');
          created.push(await need().postTask({ tenantId, createdBy: auth?.keyId ?? 'operator', ...t }));
        }
        return { tenantId, created, board: await need().store.stats() };
      },
    },
    {
      method: 'GET',
      path: '/v1/admin/cluster/board',
      requiredRole: 'read',
      handler: async ({ tenantId }) => ({
        tenantId,
        open: await need().store.openTasks(tenantId),
        pheromones: await need().store.activePheromones({ tenantId }),
        store: need().store.kind,
      }),
    },
    {
      method: 'POST',
      path: '/v1/admin/cluster/run',
      requiredRole: 'admin',
      handler: async ({ tenantId, body }) => need().runOnce({ tenantId, maxRuns: body?.maxRuns ?? 4, leaseMs: body?.leaseMs ?? 60_000 }),
    },
    {
      method: 'POST',
      path: '/v1/admin/cluster/message',
      requiredRole: 'run',
      handler: async ({ tenantId, body }) => {
        if (!body?.from || !body?.type) throw new ValidationError('Traži se "from" i "type"');
        return need().publishSwarmMessage({ tenantId, from: body.from, to: body.to ?? 'swarm', type: body.type, payload: body.payload ?? {} });
      },
    },
  ];
}
