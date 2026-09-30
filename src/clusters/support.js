/**
 * SUPPORT CLUSTER (fasada iz smernica: `/src/clusters/support`).
 *
 * Grupise sve što „support" klaster radi u jednom objektu, da se u kodu vidi ista slika kao na posteru:
 *   • ticketRouter   — klasifikacija i rutiranje ticketa (src/support/ticket-router.js)
 *   • intake()       — jedan poziv: ticket → queue + pheromone + (opciono) izvršavanje agentom
 *   • queueStats()   — koliko posla čeka
 */
import { createTicketRouter } from '../support/ticket-router.js';

export function createSupportCluster({ node, robot = null, tenantId = 'nmq', logger, metrics, audit } = {}) {
  const router = createTicketRouter({
    catalog: robot?.catalog ?? null,
    queue: node?.queue ?? null,
    pheromone: node?.pheromone ?? null,
    autonomy: robot?.autonomy ?? null,
    governance: robot?.swarmGovernance ?? null,
    logger,
    metrics,
    audit,
    tenantId,
  });

  return {
    name: 'support',
    ticketRouter: router,

    /** Prijem ticketa: klasifikuj → queue → trag. */
    async intake(ticket, opts) {
      return router.submit(ticket, opts);
    },

    /** Koliko ticketa čeka i kakvi su tragovi. */
    queueStats() {
      return { queue: node?.queue?.stats?.() ?? null, pheromone: node?.pheromone?.stats?.() ?? null };
    },

    /** Zdravlje klastera: koliko je posla završeno na ovom čvoru. */
    health() {
      return { tickets: node?.done?.length ?? 0, peers: node?.stats?.().peersAlive ?? 0, load: node?.load?.() ?? 0 };
    },
  };
}

export default createSupportCluster;
