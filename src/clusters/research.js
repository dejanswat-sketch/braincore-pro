/**
 * RESEARCH CLUSTER (fasada iz smernica: `/src/clusters/research`).
 *
 *   • extractor  — izvlačenje činjenica u bazu znanja (src/research/extractor.js)
 *   • registry   — Genome Registry: prima SAMO metrike, bira top 10% (src/research/genome-registry.js)
 *   • federation — edge klijent: šalje fitness, povlači update (src/research/federation.js)
 *
 * Ovo je „mozak koji uči iz brojeva": nijedan sadržaj klijenta ne izlazi iz edge čvora.
 */
import { createExtractor } from '../research/extractor.js';
import { createGenomeRegistry } from '../research/genome-registry.js';
import { createFederationClient } from '../research/federation.js';

export function createResearchCluster({ node, robot = null, secret, registry = null, tenantId = 'nmq', logger, metrics, audit, nodeId = 'edge' } = {}) {
  const extractor = createExtractor({ memory: robot?.memory ?? null, llm: robot?.llm ?? null, logger, metrics, audit, tenantId });
  const genomeRegistry = registry ?? createGenomeRegistry({ secret, logger, metrics, audit });
  const federation = createFederationClient({
    nodeId: node?.nodeId ?? nodeId,
    secret,
    registry: genomeRegistry,
    controlPlane: robot?.controlPlane ?? null,
    logger,
    metrics,
    audit,
  });

  return {
    name: 'research',
    extractor,
    registry: genomeRegistry,
    federation,

    /** Edge ruta: izmjeri lokalno (iz nagrada) i pošalji SAMO metrike. */
    async reportFromRewards({ rewards = [], tasksDone = 0 } = {}) {
      const measured = federation.measureFromRewards({ rewards, tasksDone });
      return federation.reportFitness(measured);
    },

    /** Centralna ruta: pobjednik turnira (top 10%) sa pragom uzoraka. */
    best({ k = 1 } = {}) {
      return genomeRegistry.bestUpdate({ k });
    },

    stats() {
      return { genomes: genomeRegistry.stats().slice(0, 10), reports: genomeRegistry.history({ limit: 20 }).length };
    },
  };
}

export default createResearchCluster;
