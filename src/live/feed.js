/**
 * Live feed — pretvara stanje roja u JSON snapshot za WebSocket (live.braincore.pro).
 *
 * Šalje se jedno: `snapshot` (svakih `intervalMs`) + `event` (odmah kad se nešto desi).
 * Sadržaj snapshot-a:
 *   • nodes: članovi sa statusom, opterećenjem i brojem završenih taskova
 *   • pheromones: aktivni tragovi sa TRENUTNOM (opadajućom) jačinom — vidi se kako isparavaju
 *   • tasks: poznati taskovi i ko ih je završio
 *   • stats: brojači (zadaci, claim-ovi, propušteni claim-ovi, CRDT veličina)
 */
import { EventEmitter } from 'node:events';

export const FEED_DEFAULTS = { intervalMs: 1000, maxTasks: 40, maxPheromones: 60 };

export function createLiveFeed({ node, config = {}, logger, metrics } = {}) {
  const cfg = { ...FEED_DEFAULTS, ...(config ?? {}) };
  const emitter = new EventEmitter();
  const events = [];
  let timer = null;

  function snapshot() {
    const stats = node.stats();
    const pheromones = node.pheromone
      .active({})
      .slice(0, cfg.maxPheromones)
      .map((p) => ({ id: p.id, type: p.type, taskId: p.taskId, by: p.by, strength: p.currentStrength, ageMs: p.ageMs }));
    const tasks = [...node.tasks.values()]
      .slice(-cfg.maxTasks)
      .map((t) => ({ id: t.id, type: t.type, value: t.value, origin: t.origin, createdAt: t.createdAt }));
    return {
      type: 'snapshot',
      ts: Date.now(),
      node: { id: stats.nodeId, port: stats.port, uptimeMs: stats.uptimeMs, load: stats.load, syncMs: node.syncMs ?? null },
      nodes: node.gossip.membershipList().map((m) => ({ nodeId: m.nodeId, status: m.status, load: m.load, tasksDone: m.tasksDone, lastSeen: m.lastSeen })),
      pheromones,
      tasks,
      results: node.done.slice(-cfg.maxTasks).map((d) => ({ taskId: d.taskId, nodeId: d.nodeId, ok: d.ok, ms: d.ms, at: d.at })),
      stats: {
        peersAlive: stats.peersAlive,
        swarmNodes: stats.swarmNodes ?? stats.peersAlive + 1,
        tasksKnown: stats.tasksKnown,
        // Roj-široko: koliko je zadataka završeno na SVIM čvorovima (ne samo na ovom)
        tasksDone: stats.swarmTasksDone ?? stats.tasksDone,
        tasksDoneLocal: stats.tasksDone,
        crdtSize: stats.crdtSize,
        claimsLost: node.claimsLost ?? 0,
        gossip: { sent: node.gossip.stats.sent, received: node.gossip.stats.received, rejected: node.gossip.stats.rejected, duplicates: node.gossip.stats.duplicates },
      },
    };
  }

  function push(kind, data = {}) {
    const event = { type: 'event', kind, ts: Date.now(), ...data };
    events.push(event);
    if (events.length > 200) events.shift();
    emitter.emit('event', event);
    metrics?.inc('live_feed_events_total', { kind });
    return event;
  }

  return {
    settings: cfg,
    on: (...a) => emitter.on(...a),
    snapshot,
    push,
    recent: () => events.slice(-50),

    /** Spaja se na događaje čvora i šalje sve pretplatnicima (callback prima JSON string/objekat). */
    start(send) {
      const wrapped = (payload) => {
        const sent = typeof send === 'function' ? send(payload) : 0;
        return sent;
      };
      emitter.on('event', wrapped);
      timer = setInterval(() => wrapped(snapshot()), cfg.intervalMs);
      if (timer.unref) timer.unref();
      logger?.info?.('live.feed_started', { intervalMs: cfg.intervalMs });
      return true;
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      return true;
    },
  };
}
