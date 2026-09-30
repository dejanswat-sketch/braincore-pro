/**
 * Trace/span model — jedan run = jedan trace, svaki agent/tool/LLM poziv = span.
 * MVP: JSONL po tenantu i danu. v1: OpenTelemetry export (isti model).
 */
import path from 'node:path';
import { appendJsonl, readJsonl } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid, truncate } from '../core/ids.js';

export function createTracer({ dataDir, logger, metrics } = {}) {
  const runs = new Map();
  const MAX_RUNS_IN_MEMORY = 500;
  let activeRuns = 0;

  const traceFile = (tenantId, date = new Date()) =>
    path.join(dataDir, 'tenants', tenantId, 'traces', `${date.toISOString().slice(0, 10)}.jsonl`);

  function startRun({ tenantId, agentId, pattern = 'agent', input, sessionId, userId, parentRunId }) {
    const run = {
      runId: uid('run'),
      traceId: parentRunId ? runs.get(parentRunId)?.traceId ?? uid('trace') : uid('trace'),
      parentRunId: parentRunId ?? null,
      tenantId,
      agentId,
      pattern,
      sessionId: sessionId ?? null,
      userId: userId ?? null,
      input: truncate(typeof input === 'string' ? input : JSON.stringify(input), 2000),
      startedAt: iso(),
      endedAt: null,
      status: 'running',
      spans: [],
      error: null,
      usage: { tokensIn: 0, tokensOut: 0 },
      costUsd: 0,
    };
    runs.set(run.runId, run);
    if (runs.size > MAX_RUNS_IN_MEMORY) {
      const oldest = [...runs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
      if (oldest?.status !== 'running') runs.delete(oldest.runId);
    }
    metrics?.inc('runs_started_total', { tenant: tenantId, agent: agentId, pattern });
    activeRuns += 1;
    metrics?.set('runs_active', {}, activeRuns);
    logger?.debug?.('run.start', { runId: run.runId, traceId: run.traceId, tenantId, agentId, pattern });
    return run;
  }

  /** Otvara span; vrati { end(attrs) }. */
  function span(run, name, attrs = {}) {
    const s = {
      spanId: uid('span'),
      name,
      parentSpanId: run.spans.at(-1)?.spanId ?? null,
      startedAt: iso(),
      startMs: Date.now(),
      durationMs: 0,
      attrs: sanitize(attrs),
      status: 'ok',
    };
    run.spans.push(s);
    const started = Date.now();
    return {
      id: s.spanId,
      end(extra = {}, status = 'ok') {
        s.durationMs = Date.now() - started;
        s.attrs = { ...s.attrs, ...sanitize(extra) };
        s.status = status;
        if (status !== 'ok') metrics?.inc('span_errors_total', { tenant: run.tenantId, name });
        return s;
      },
      fail(err, extra = {}) {
        s.durationMs = Date.now() - started;
        s.attrs = { ...s.attrs, ...sanitize(extra), error: String(err?.message ?? err).slice(0, 500) };
        s.status = 'error';
        metrics?.inc('span_errors_total', { tenant: run.tenantId, name });
        return s;
      },
      data: s,
    };
  }

  async function endRun(run, { output, status = 'ok', error, usage, costUsd } = {}) {
    run.endedAt = iso();
    run.status = error ? 'error' : status;
    run.error = error ? { message: String(error.message ?? error).slice(0, 1000), code: error.code ?? 'UNKNOWN' } : null;
    if (usage) run.usage = usage;
    if (costUsd !== undefined) run.costUsd = costUsd;
    run.output = truncate(typeof output === 'string' ? output : JSON.stringify(output), 4000);
    const durationMs = new Date(run.endedAt) - new Date(run.startedAt);
    metrics?.inc('runs_finished_total', { tenant: run.tenantId, agent: run.agentId, status: run.status });
    activeRuns = Math.max(0, activeRuns - 1);
    metrics?.set('runs_active', {}, activeRuns);
    metrics?.observe('run_duration_seconds', { tenant: run.tenantId, agent: run.agentId, pattern: run.pattern }, durationMs / 1000);
    metrics?.observe('run_cost_usd', { tenant: run.tenantId, agent: run.agentId }, run.costUsd ?? 0);
    logger?.debug?.('run.end', { runId: run.runId, status: run.status, durationMs, costUsd: run.costUsd });
    if (dataDir) {
      try {
        await appendJsonl(traceFile(run.tenantId), run);
      } catch (err) {
        logger?.warn?.('trace.persist_failed', { runId: run.runId, error: err.message });
      }
    }
    return run;
  }

  return {
    startRun,
    span,
    endRun,
    get: (runId) => runs.get(runId) ?? null,
    list: ({ tenantId, limit = 20 } = {}) =>
      [...runs.values()]
        .filter((r) => !tenantId || r.tenantId === tenantId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit),
    async readFromDisk({ tenantId, date = new Date(), limit = 100 }) {
      return readJsonl(traceFile(tenantId, date), { limit, tail: true });
    },
  };
}

function sanitize(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (typeof v === 'string') out[k] = truncate(v, 500);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else out[k] = truncate(JSON.stringify(v), 500);
  }
  return out;
}
