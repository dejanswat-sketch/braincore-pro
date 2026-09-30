/**
 * EXECUTION CLUSTER (fasada iz smernica: `/src/clusters/execution`).
 *
 *   • toolRunner — jedina tačka izvršenja alata (politika + sandbox + audit)
 *   • run()      — izvrši task koji je ovaj čvor claim-ovao (poziva ga node.runTask kroz `runner`)
 *   • stats()    — šta je izvršeno i koliko je trajalo
 *
 * Node.js podrazumijeva da `runner` vrati `{ output }`; ova fasada to radi kroz alate kad je robot prisutan,
 * a inače vraća deterministički „echo" (korisno u testovima i na praznom čvoru).
 */
import { createToolRunner } from '../execution/tool-runner.js';

export function createExecutionCluster({ robot = null, node = null, tenantId = 'nmq', logger, metrics, audit } = {}) {
  const toolRunner = robot
    ? createToolRunner({ tools: robot.tools, policyResolver: robot.policyResolver, sandbox: robot.sandbox, audit: robot.audit ?? audit, metrics, logger, tenantId })
    : null;

  return {
    name: 'execution',
    toolRunner,

    /**
     * Runner za swarm node. Task može nositi `payload.tool` + `payload.args` (tada ide kroz alate uz politiku),
     * ili samo tekst (tada agent/orchestrator, ako je robot prisutan), ili ništa (echo).
     */
    async run(task, { nodeId = node?.nodeId ?? 'node' } = {}) {
      const payload = task.payload ?? {};
      if (toolRunner && payload.tool) {
        const result = await toolRunner.run(payload.tool, payload.args ?? {}, { tenantId: task.tenantId ?? tenantId, agentId: payload.agentId ?? null, approved: payload.approved === true });
        return { output: result.result, via: 'tool', tool: payload.tool, ms: result.ms };
      }
      if (robot?.orchestrator && payload.text) {
        const res = await robot.orchestrator.run({ tenantId: task.tenantId ?? tenantId, agentId: payload.agentId ?? null, input: payload.text, userId: `node:${nodeId}`, sessionId: `swarm:${task.id}` });
        return { output: res.output, via: 'orchestrator', runId: res.runId, costUsd: res.costUsd };
      }
      return { output: `executed ${task.type} on ${nodeId}`, via: 'echo', taskId: task.id };
    },

    stats() {
      return toolRunner ? toolRunner.stats() : { total: 0, byTool: {} };
    },
  };
}

export default createExecutionCluster;
