/**
 * A2A — zadaci (tasks) između agenata.
 *
 * Tok: drugi agent pošalje zadatak → naš agent ga izvrši (kroz orchestrator, sa svim politikama i budžetom)
 *      → zadatak ima stanje (submitted/working/completed/failed/cancelled) i tok događaja (SSE).
 *
 * Stanje: data/tenants/<id>/a2a/tasks.jsonl (append-only) + in-memory indeks za aktivne.
 */
import path from 'node:path';
import { appendJsonl, readJsonl, writeJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { NotFoundError, ValidationError } from '../core/errors.js';

const STATES = ['submitted', 'working', 'input_required', 'completed', 'failed', 'cancelled'];

export function createA2ATasks({ dataDir, logger, metrics, audit, orchestrator, bus, autonomy }) {
  const active = new Map(); // taskId -> task
  const controllers = new Map(); // taskId -> AbortController

  const file = (tenantId, d = new Date()) => path.join(dataDir, 'tenants', tenantId, 'a2a', `tasks-${d.toISOString().slice(0, 7)}.jsonl`);
  const snap = (tenantId) => path.join(dataDir, 'tenants', tenantId, 'a2a', 'tasks.active.json');

  function emit(task, event, data = {}) {
    bus?.emit(`a2a.task.${task.id}`, { taskId: task.id, state: task.state, event, ...data });
    bus?.emit('a2a.task', { taskId: task.id, state: task.state, event, tenantId: task.tenantId, ...data });
  }

  async function persist(tenantId) {
    const rows = [...active.values()].filter((t) => t.tenantId === tenantId);
    await writeJson(snap(tenantId), { tasks: rows.slice(-200) });
  }

  return {
    STATES,
    file,

    /**
     * Prima zadatak od drugog agenta (ili od A2A klijenta).
     * @param {object} req { tenantId, message, skillId, sessionId, fromAgent, params }
     */
    async send({ tenantId, message, skillId = null, sessionId = null, fromAgent = 'external', params = {}, wait = false } = {}) {
      if (!message) throw new ValidationError('A2A zadatak traži "message"');
      const task = {
        id: uid('task'),
        tenantId,
        state: 'submitted',
        skillId,
        sessionId: sessionId ?? uid('a2asess'),
        fromAgent,
        input: String(message).slice(0, 8000),
        params,
        createdAt: iso(),
        updatedAt: iso(),
        history: [{ ts: iso(), state: 'submitted', by: fromAgent }],
        output: null,
        runId: null,
        costUsd: 0,
        approvals: [],
      };
      active.set(task.id, task);
      await appendJsonl(file(tenantId), { ...task, _op: 'created' });
      await persist(tenantId);
      metrics?.inc('a2a_tasks_total', { tenant: tenantId, state: 'submitted' });
      emit(task, 'submitted');

      const execute = async () => {
        task.state = 'working';
        task.updatedAt = iso();
        emit(task, 'working');
        const controller = new AbortController();
        controllers.set(task.id, controller);
        let decision = { action: 'allow', level: 'unknown' };
        try {
          decision = autonomy?.evaluate({ tenantId, agentId: skillId, riskLevel: params.riskLevel ?? 'low', kind: 'act' }) ?? decision;
          const result = await orchestrator.run({
            tenantId,
            agentId: skillId ?? null,
            pattern: params.pattern,
            input: task.input,
            sessionId: task.sessionId,
            userId: `a2a:${fromAgent}`,
            signal: controller.signal,
            options: params.options ?? {},
          });
          task.runId = result.runId;
          task.costUsd = result.costUsd;
          task.approvals = result.approvals ?? [];
          task.state = result.status === 'awaiting_approval' ? 'input_required' : 'completed';
          task.output = result.output;
          task.agentId = result.agentId;
          task.pattern = result.pattern;
          task.autonomy = decision;
        } catch (err) {
          task.state = 'failed';
          task.error = { message: err.message, code: err.code ?? 'UNKNOWN' };
        } finally {
          controllers.delete(task.id);
          task.updatedAt = iso();
          task.history.push({ ts: iso(), state: task.state, by: 'nmq-robot' });
          await appendJsonl(file(tenantId), { ...task, _op: 'updated' });
          await persist(tenantId);
          metrics?.inc('a2a_tasks_total', { tenant: tenantId, state: task.state });
          if (task.state === 'completed') metrics?.observe('a2a_task_duration_seconds', { tenant: tenantId }, (new Date(task.updatedAt) - new Date(task.createdAt)) / 1000);
          await audit?.append({
            tenantId,
            actor: `a2a:${fromAgent}`,
            action: 'a2a_task',
            args: { taskId: task.id, skillId, state: task.state },
            decision: decision.action,
            outcome: task.state === 'completed' ? 'ok' : task.state === 'input_required' ? 'pending' : 'error',
            runId: task.runId,
            meta: { costUsd: task.costUsd, pattern: task.pattern },
          });
          emit(task, task.state, { output: task.output, error: task.error ?? null });
          logger?.info?.('a2a.task_finished', { tenantId, taskId: task.id, state: task.state, costUsd: task.costUsd });
        }
        return task;
      };

      const promise = execute();
      if (wait) return promise;
      task.promise = promise;
      return task;
    },

    async get(tenantId, taskId) {
      const task = active.get(taskId);
      if (task && task.tenantId === tenantId) return task;
      const rows = await readJsonl(file(tenantId), { limit: 500, tail: true });
      const found = rows.filter((r) => r.id === taskId).at(-1);
      if (!found) throw new NotFoundError('A2A zadatak', taskId);
      return found;
    },

    async cancel(tenantId, taskId) {
      const task = active.get(taskId);
      if (!task) throw new NotFoundError('A2A zadatak', taskId);
      if (task.tenantId !== tenantId) throw new NotFoundError('A2A zadatak', taskId);
      if (['completed', 'failed', 'cancelled'].includes(task.state)) return task;
      controllers.get(taskId)?.abort(new Error('cancelled-by-client'));
      task.state = 'cancelled';
      task.updatedAt = iso();
      task.history.push({ ts: iso(), state: 'cancelled', by: 'client' });
      await appendJsonl(file(tenantId), { ...task, _op: 'updated' });
      emit(task, 'cancelled');
      metrics?.inc('a2a_tasks_total', { tenant: tenantId, state: 'cancelled' });
      return task;
    },

    async list(tenantId, { state, limit = 50 } = {}) {
      const rows = await readJsonl(file(tenantId), { limit: 500, tail: true });
      const uniq = new Map(rows.map((r) => [r.id, r]));
      const all = [...uniq.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return (state ? all.filter((t) => t.state === state) : all).slice(0, limit);
    },

    /** Zadatak koji čeka ulaz (npr. odobrenje) — nastavlja se kroz /v1/approvals. */
    async resumeAfterApproval(tenantId, taskId) {
      const task = active.get(taskId);
      if (!task) throw new NotFoundError('A2A zadatak', taskId);
      task.history.push({ ts: iso(), state: 'approved', by: 'human' });
      task.updatedAt = iso();
      await appendJsonl(file(tenantId), { ...task, _op: 'updated' });
      return task;
    },

    stats: () => ({ active: active.size }),
  };
}
