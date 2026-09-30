/**
 * EXECUTION CLUSTER — tool runner.
 *
 * Sve što agent „radi" u svijetu prolazi kroz ovdje: politika (allow/deny/approval), sandbox,
 * mjerenje trajanja i troška, audit. Ovo je jedina tačka izvršenja — nema drugog puta do alata.
 */
import { iso } from '../core/clock.js';
import { PolicyError, ValidationError } from '../core/errors.js';

export function createToolRunner({ tools, policyResolver, sandbox, audit, metrics, logger, tenantId = 'nmq' } = {}) {
  const executions = [];

  return {
    executions,

    /** Provjeri politiku za alat (bez izvršenja) — koristi se u „dry run" i testovima. */
    check(toolName, { tenantId: t = tenantId, agentId = null, args = {} } = {}) {
      const policy = policyResolver?.(t, { agentId, toolName }) ?? {};
      const all = policy.tools ?? {};
      const verdict = all[toolName] ?? policy.defaultTool ?? 'allow';
      const sandboxCheck = sandbox?.evaluate ? sandbox.evaluate({ toolName, args, tenantId: t }) : { allowed: true, reason: null };
      return {
        toolName,
        policy: verdict,
        allowed: verdict !== 'deny' && sandboxCheck.allowed !== false,
        requiresApproval: verdict === 'require_approval',
        sandbox: sandboxCheck,
      };
    },

    /**
     * Izvrši alat. Vraća `{ ok, result, ms, code }`.
     * Politika `deny` i sandbox odbijanje bacaju PolicyError (fail-closed).
     */
    async run(toolName, args = {}, { tenantId: t = tenantId, agentId = null, runId = null, approved = false, sandboxContext = {} } = {}) {
      const check = this.check(toolName, { tenantId: t, agentId, args });
      if (!check.allowed) {
        metrics?.inc('tool_runner_blocked_total', { tool: toolName, reason: check.policy });
        throw new PolicyError(`Alat "${toolName}" je zabranjen politikom (${check.policy})`, { check });
      }
      if (check.requiresApproval && !approved) {
        metrics?.inc('tool_runner_approval_required_total', { tool: toolName });
        throw new PolicyError(`Alat "${toolName}" traži odobrenje čovjeka`, { check });
      }
      const started = Date.now();
      let result = null;
      let code = 'OK';
      try {
        result = await tools.execute(toolName, args, { tenantId: t, agentId, runId, sandbox: sandboxContext });
        return { ok: true, result, ms: Date.now() - started, code };
      } catch (err) {
        code = err.code ?? 'TOOL_ERROR';
        metrics?.inc('tool_runner_errors_total', { tool: toolName, code });
        throw err;
      } finally {
        const record = { ts: iso(), tenantId: t, agentId, toolName, ms: Date.now() - started, code, ok: code === 'OK' };
        executions.push(record);
        if (executions.length > 2000) executions.shift();
        metrics?.observe('tool_runner_ms', { tool: toolName }, record.ms);
        logger?.debug?.('execution.tool_run', record);
        await audit
          ?.append({
            tenantId: t,
            actor: `agent:${agentId ?? 'unknown'}`,
            action: 'tool_executed',
            args: { tool: toolName, runId },
            decision: 'allow',
            outcome: code === 'OK' ? 'ok' : 'error',
            meta: { ms: record.ms },
          })
          .catch(() => {});
      }
    },

    stats() {
      const byTool = {};
      for (const e of executions) {
        byTool[e.toolName] = byTool[e.toolName] ?? { runs: 0, errors: 0, avgMs: 0 };
        byTool[e.toolName].runs += 1;
        byTool[e.toolName].errors += e.ok ? 0 : 1;
        byTool[e.toolName].avgMs = Math.round((byTool[e.toolName].avgMs * (byTool[e.toolName].runs - 1) + e.ms) / byTool[e.toolName].runs);
      }
      return { total: executions.length, byTool };
    },
  };
}
