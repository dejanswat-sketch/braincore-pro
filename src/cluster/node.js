/**
 * Cluster node — spaja gossip (membership + širenje) i shared store (zajednička tabla) u jedan čvor roja.
 *
 * Ključne odluke:
 *   • Zadatak se CLAIM-uje u shared store (atomski), pa dva čvora ne mogu uzeti isti zadatak.
 *   • ULAZNE poruke sa drugih čvorova prolaze kroz ISTU medijaciju kao lokalne (`safety.mediateMessage`):
 *     pošiljalac je `node:<id>` i mora biti POZNAT član, sadržaj se provjerava (entropija/oblik/fraza),
 *     kvote važe. Sumnjiv sadržaj → karantin TOG ČVORA + incident.
 *   • Ako Redis nije dostupan, store je `file` — čvorovi na istoj mašini (ili deljenom FS-u) i dalje
 *     dele tablu; gossip nosi membership i poruke.
 */
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { PolicyError, ValidationError, ClusterError } from '../core/errors.js';
import { createGossipNode } from './gossip.js';
import { createSharedStore } from './store.js';

/** Klaster događaji nisu vezani za jednog klijenta — idu u _global audit/telemetriju. */
export const CLUSTER_TENANT = '_global';

export async function createClusterNode({ config = {}, dataDir, logger, metrics, audit, bus, nodeId = null, host = '127.0.0.1', port = 0 }) {
  const id = nodeId ?? config.nodeId ?? `${host}:${port || 'auto'}-${uid('n').slice(-6)}`;
  const store = await createSharedStore({ config: config.store ?? config, dataDir, logger, metrics });
  const gossip = await createGossipNode({
    nodeId: id,
    host,
    port,
    advertiseHost: config.advertiseHost ?? host,
    secret: config.secret,
    config: config.gossip ?? {},
    logger,
    metrics,
    onMessage: (body) => inbound(body),
    onMembership: (member, change) => {
      metrics?.inc('cluster_membership_events_total', { change });
      bus?.emit('cluster.membership', { ...member, change });
    },
  });

  let deps = null; // { swarm, safety, governance, blackboard, orchestrator, catalog, rewards }
  const peers = new Set(config.peers ?? []);
  let started = false;

  function isKnownNode(candidate) {
    const member = gossip.members.get(candidate);
    return Boolean(member && member.status !== 'dead' && member.status !== 'left');
  }

  /** Ulazna poruka sa mreže — ovdje se primjenjuje ista politika kao za lokalne workere. */
  async function inbound(body) {
    if (!deps) {
      logger?.debug?.('cluster.inbound_dropped_not_attached', { type: body.type });
      return { ok: false, reason: 'nije_spojen' };
    }
    if (body.type !== 'swarm_message') return { ok: true, type: body.type };
    const { tenantId, from, to, msgType, payload } = body.payload ?? {};
    if (!tenantId || !msgType) return { ok: false, reason: 'nepotpuna_poruka' };
    try {
      await deps.safety.mediateMessage({ tenantId, from: `node:${body.from}`, to: to ?? 'swarm', type: msgType, payload: payload ?? {} });
      metrics?.inc('cluster_inbound_swarm_messages_total', { result: 'delivered' });
      return { ok: true };
    } catch (err) {
      metrics?.inc('cluster_inbound_swarm_messages_total', { result: 'rejected' });
      logger?.warn?.('cluster.inbound_rejected', { from: body.from, error: err.message });
      // Sumnjiv sadržaj sa udaljenog čvora → karantin tog čvora (ne samo lokalnog workera)
      if (err instanceof PolicyError) {
        gossip.quarantineMember(body.from, `safety:${err.code}`);
        await deps.safety.quarantine(`node:${body.from}`, `cluster:${err.code}`);
      }
      return { ok: false, reason: err.code ?? 'rejected' };
    }
  }

  const api = {
    nodeId: id,
    store,
    gossip,
    peers,
    get attached() {
      return Boolean(deps);
    },
    get port() {
      return gossip.port;
    },
    isKnownNode,
    membership: () => gossip.membershipList(),

    /** Spaja swarm/safety/governance koji su kreirani POSLIJE klastera (izbjegava kružnu zavisnost). */
    attach(dependencies) {
      deps = dependencies;
      logger?.info?.('cluster.attached', { nodeId: id, hasSwarm: Boolean(deps?.swarm) });
      return true;
    },

    async start() {
      const bound = await gossip.start();
      started = true;
      if (peers.size) await api.join([...peers]);
      await audit?.append({ tenantId: CLUSTER_TENANT, actor: 'cluster', action: 'cluster_start', args: { nodeId: id, port: bound.port, store: store.kind }, decision: 'allow', outcome: 'ok' });
      logger?.warn?.('cluster.started', { nodeId: id, port: bound.port, store: store.kind, peers: peers.size });
      return { nodeId: id, port: bound.port, store: store.kind };
    },

    /** Pridruživanje postojećem klasteru (peers: ["host:port", ...]). */
    async join(list) {
      const results = await gossip.join(list);
      for (const item of results) if (item.ok) peers.add(item.peer);
      metrics?.inc('cluster_joins_total', { result: results.every((r) => r.ok) ? 'ok' : 'partial' });
      return { nodeId: id, results, members: api.membership() };
    },

    /** Pošalji swarm poruku kroz mrežu (prolazi kroz medijaciju i na prijemu). */
    async publishSwarmMessage({ tenantId, from, to = 'swarm', type, payload = {} }) {
      if (!deps) throw new ClusterError('Klaster nije spojen sa swarm slojem');
      // Lokalna provjera PRIJE slanja: ne šaljemo ništa što ni sami ne bismo prihvatili
      await deps.safety.mediateMessage({ tenantId, from, to, type, payload, _checkOnly: false });
      const sent = await gossip.broadcast('swarm_message', { tenantId, from, to, msgType: type, payload });
      return { ...sent, checked: true };
    },

    /** Upis zadatka na ZAJEDNIČKU tablu (vidljiv svim čvorovima). */
    async postTask({ tenantId, title, payload = {}, value = 1, requiredSkills = [], createdBy = 'operator', meta = {} }) {
      if (!title) throw new ValidationError('Zadatak traži "title"');
      const task = {
        id: uid('ctask'),
        tenantId,
        title,
        payload,
        value: Number(value),
        requiredSkills,
        createdBy,
        meta,
        state: 'open',
        claimedBy: null,
        leaseUntil: null,
        attempts: 0,
        createdAt: iso(),
        updatedAt: iso(),
        node: id,
      };
      await store.putTask(task);
      await gossip.broadcast('task_announce', { taskId: task.id, tenantId, title: task.title, value: task.value });
      metrics?.inc('cluster_tasks_posted_total', { tenant: tenantId });
      return task;
    },

    /**
     * Claim sa zajedničke table: uzmi najvrjedniji zadatak za koje worker ima vještine.
     * Feromoni iz store-a utiču na prioritet (hot podiže, problem spušta).
     */
    async claimTask({ tenantId, workerId, skills = [], leaseMs = 60_000 }) {
      const open = await store.openTasks(tenantId);
      if (!open.length) return null;
      const pheromones = await store.activePheromones({ tenantId });
      const boost = (taskId) => {
        const hot = pheromones.filter((p) => p.taskId === taskId && p.type === 'hot').length * 1.5;
        const bad = pheromones.filter((p) => p.taskId === taskId && ['problem', 'blocked'].includes(p.type)).length * 1.5;
        return hot - bad;
      };
      const candidates = open
        .filter((t) => (t.requiredSkills ?? []).every((s) => skills.includes(s)))
        .map((t) => ({ task: t, score: (t.value ?? 1) + boost(t.id) }))
        .sort((a, b) => b.score - a.score);

      for (const candidate of candidates) {
        const res = await store.claimTask(candidate.task.id, workerId, { leaseMs });
        if (res.claimed) {
          await store.putPheromone({ id: uid('cph'), ts: iso(), tenantId, type: 'claimed', taskId: candidate.task.id, by: workerId, strength: 0.5, node: id });
          return res.task;
        }
      }
      return null;
    },

    async completeTask(taskId, { workerId, success = true, result = null, tenantId }) {
      const done = await store.completeTask(taskId, { workerId, success, result });
      if (tenantId) {
        await store.putPheromone({ id: uid('cph'), ts: iso(), tenantId, type: success ? 'done' : 'problem', taskId, by: workerId, strength: success ? 1 : 1.5, node: id });
      }
      return done;
    },

    /** Jedan otkucaj roja preko ZAJEDNIČKE table (cross-node work stealing). */
    async runOnce({ tenantId, maxRuns = 4, leaseMs = 60_000 } = {}) {
      if (!deps) throw new ClusterError('Klaster nije spojen sa swarm slojem');
      const workers = deps.swarm.listWorkers(tenantId);
      if (!workers.length) throw new ValidationError('Nema registrovanih workera na ovom čvoru');
      const results = [];
      let ran = 0;
      for (const worker of workers) {
        if (ran >= maxRuns) break;
        if (deps.safety.isQuarantined(worker.id)) {
          results.push({ workerId: worker.id, skipped: 'quarantined' });
          continue;
        }
        const task = await api.claimTask({ tenantId, workerId: worker.id, skills: worker.skills, leaseMs });
        if (!task) {
          results.push({ workerId: worker.id, idle: true });
          continue;
        }
        ran += 1;
        const started = Date.now();
        // Lease se produžava dok posao traje (inače posao duži od leaseMs može preuzeti drugi čvor)
        const renew = setInterval(() => {
          store.renewLease?.(task.id, worker.id, { leaseMs }).catch(() => {});
        }, Math.max(1000, Math.floor(leaseMs / 3)));
        if (renew.unref) renew.unref();
        try {
          await deps.governance.assertCanRun({ tenantId, workerId: worker.id, riskLevel: task.meta?.riskLevel ?? 'low', costUsd: task.meta?.estimatedCostUsd ?? 0.01 });
          const result = await deps.orchestrator.run({
            tenantId,
            agentId: task.meta?.agentId ?? worker.agentId,
            pattern: task.meta?.pattern,
            input: task.payload?.input ?? task.title,
            userId: `cluster:${worker.id}`,
            sessionId: `cluster:${tenantId}:${task.id}`,
          });
          const ok = result.status === 'ok';
          await api.completeTask(task.id, { workerId: worker.id, success: ok, result: { output: String(result.output).slice(0, 2000), runId: result.runId }, tenantId });
          deps.governance.recordCost(tenantId, { amountUsd: result.costUsd ?? 0, workerId: worker.id });
          worker.claims += 1;
          worker.completed += ok ? 1 : 0;
          worker.failed += ok ? 0 : 1;
          const tag = task.payload?.tag ?? String(task.title).split(' ')[0].toLowerCase();
          worker.tags[tag] = (worker.tags[tag] ?? 0) + (ok ? 1 : 0);
          results.push({ workerId: worker.id, taskId: task.id, status: result.status, ms: Date.now() - started, node: id });
          metrics?.inc('cluster_task_runs_total', { tenant: tenantId, result: result.status });
        } catch (err) {
          await api.completeTask(task.id, { workerId: worker.id, success: false, result: { error: err.message }, tenantId });
          worker.failed += 1;
          results.push({ workerId: worker.id, taskId: task.id, error: err.message, code: err.code ?? 'UNKNOWN', node: id });
        } finally {
          clearInterval(renew);
        }
      }
      return { nodeId: id, ran, results };
    },

    async stats({ tenantId } = {}) {
      const board = await store.stats();
      const members = api.membership();
      return {
        nodeId: id,
        port: gossip.port,
        started,
        attached: Boolean(deps),
        store: { kind: store.kind },
        board,
        members: members.length,
        alive: members.filter((m) => m.status === 'alive').length,
        suspect: members.filter((m) => m.status === 'suspect').length,
        dead: members.filter((m) => m.status === 'dead').length,
        peers: [...peers],
        incarnation: gossip.incarnation,
        tenantId: tenantId ?? null,
      };
    },

    async stop() {
      await gossip.leave().catch(() => {});
      await gossip.stop();
      if (store.client?.close) await store.client.close().catch(() => {});
      started = false;
      return true;
    },
  };

  return api;
}
