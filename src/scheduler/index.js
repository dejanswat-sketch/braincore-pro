/**
 * Scheduler — ono što robota čini „uvek uključenim".
 *
 * Podržava:
 *   - poslove po rasporedu: `once`, `interval`, `cron`
 *   - poslove na događaj: `triggers: [{ type: 'event', event: 'hook.shopify' }]`
 *   - dugoročne procese: `type: 'process'` sa koracima koji se izvršavaju kroz dane/nedjelje (checkpoint u fajlu)
 *
 * Svaki posao ima svoj budžet, svoju istoriju izvršavanja i ide kroz isti orchestrator (patterni, politike, audit).
 * Leasing sprječava duplo izvršavanje kad radi više instanci (K8s: više replika).
 */
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { BudgetExceededError, ApprovalRequiredError, PolicyError } from '../core/errors.js';
import { nextCronAt, describeSchedule, validateCron } from './cron.js';
import { ValidationError } from '../core/errors.js';

const DEFAULT_LEASE_MS = 60_000;

export function createScheduler({ robot, store, logger, metrics, tickMs = 1000, maxConcurrent = 3 } = {}) {
  let timer = null;
  let ticking = false;
  let active = 0;
  let stopped = true;
  const runningJobs = new Set();

  const now = () => Date.now();

  function computeNextRun(job, from = now()) {
    const schedule = job.schedule ?? {};
    if (schedule.type === 'once' || !schedule.type) return null;
    if (schedule.type === 'interval') return from + Math.max(1000, Number(schedule.everyMs ?? 3_600_000));
    if (schedule.type === 'cron') {
      try {
        return nextCronAt(schedule.cron, from);
      } catch (err) {
        logger?.warn?.('job.bad_cron', { jobId: job.id, cron: schedule.cron, error: err.message });
        return null;
      }
    }
    return null;
  }

  function isDue(job, at = now()) {
    if (job.enabled === false) return false;
    if (job.status === 'completed' || job.status === 'failed') return false;
    if (job.schedule?.type === 'once' && job.runs > 0) return false;
    if (job.nextRunAt === null || job.nextRunAt === undefined) return false;
    return job.nextRunAt <= at;
  }

  /** Leasing: samo jedan izvršilac smije uzeti posao. */
  async function acquireLease(tenantId, jobId, owner = process.pid) {
    const job = await store.get(tenantId, jobId);
    if (!job) return null;
    const at = now();
    if (job.lease && job.lease.until > at && job.lease.owner !== owner) return null;
    const leased = await store.upsert(tenantId, { id: jobId, lease: { owner, until: at + DEFAULT_LEASE_MS } });
    return leased;
  }

  async function releaseLease(tenantId, jobId, patch = {}) {
    return store.upsert(tenantId, { id: jobId, lease: null, ...patch });
  }

  /** Jedan korak dugoročnog procesa. */
  function nextProcessStep(job) {
    const steps = job.process?.steps ?? [];
    const done = new Set(job.process?.done ?? []);
    const index = steps.findIndex((s, i) => !done.has(s.id ?? String(i)));
    return index === -1 ? null : { step: steps[index], index: steps[index].id ?? String(index) };
  }

  async function runJob(tenantId, job, { reason = 'schedule', event = null, manual = false } = {}) {
    const startedAt = Date.now();
    const runId = uid('jobrun');
    active += 1;
    metrics?.set('jobs_active', {}, active);
    metrics?.inc('jobs_runs_total', { tenant: tenantId, job: job.id, reason });

    try {
      let input = job.input ?? job.name ?? 'Izvrši zadatak';
      let pattern = job.pattern;
      let agentId = job.agentId ?? 'router';
      const contextExtra = {};

      if (job.type === 'process') {
        const next = nextProcessStep(job);
        if (!next) {
          const finished = await releaseLease(tenantId, job.id, {
            status: 'completed',
            nextRunAt: null,
            process: { ...(job.process ?? {}), state: 'completed' },
          });
          logger?.info?.('job.process_completed', { tenantId, jobId: job.id });
          await store.appendRun(tenantId, { runId, ts: iso(), tenantId, jobId: job.id, reason, status: 'completed', durationMs: Date.now() - startedAt });
          return { status: 'completed', job: finished };
        }
        input = next.step.input ?? input;
        agentId = next.step.agentId ?? agentId;
        pattern = next.step.pattern ?? pattern;
        contextExtra.stepIndex = next.index;
        contextExtra.stepName = next.step.name ?? next.index;
      }

      const result = await robot.orchestrator.run({
        tenantId,
        agentId: agentId === 'router' ? null : agentId,
        pattern: pattern ?? (agentId === 'router' ? 'router' : undefined),
        input,
        userId: job.userId ?? `job:${job.id}`,
        sessionId: job.sessionId ?? `job_${job.id}`,
        options: {
          maxRunUsd: job.budgetPerRunUsd,
          // jobId ide agentu — bez toga alat `process_update` ne zna koji proces pomjera
          jobId: job.id,
          patternConfig: { ...(job.patternConfig ?? {}), jobId: job.id, ...contextExtra },
        },
        approvedTools: job.approvedTools,
      });

      const success = result.status === 'ok' || result.status === 'awaiting_approval';
      const patch = {
        runs: (job.runs ?? 0) + 1,
        attempts: 0, // uspjeh resetuje brojač pokušaja
        status: 'ok',
        lastError: null,
        lastRunAt: iso(),
        lastRunId: result.runId,
        lastStatus: result.status,
        lastCostUsd: result.costUsd,
        totalCostUsd: Number(((job.totalCostUsd ?? 0) + (result.costUsd ?? 0)).toFixed(6)),
        enabled: job.schedule?.type === 'once' ? false : job.enabled !== false,
      };

      if (job.type === 'process') {
        // Agent je u toku run-a mogao sam promijeniti proces (alat process_update) — ne gazimo njegove izmjene
        const fresh = (await store.get(tenantId, job.id)) ?? job;
        const agentTouched = Boolean(fresh.updatedAt && new Date(fresh.updatedAt).getTime() > startedAt);
        const baseProcess = agentTouched ? (fresh.process ?? {}) : (job.process ?? {});
        const done = [...new Set([...(baseProcess.done ?? []), contextExtra.stepIndex])];
        const remaining = (job.process?.steps ?? []).length - done.length;
        const agentState = baseProcess.state && !['pending', 'in_progress'].includes(baseProcess.state) ? baseProcess.state : null;
        patch.process = {
          ...baseProcess,
          done,
          state: agentState ?? (remaining > 0 ? 'in_progress' : 'awaiting_final'),
          log: [...(baseProcess.log ?? []).slice(-20), { ts: iso(), step: contextExtra.stepName, runId: result.runId, status: result.status }],
        };
        const agentPostponed = agentTouched && fresh.nextRunAt && fresh.nextRunAt > now();
        patch.nextRunAt = agentPostponed ? fresh.nextRunAt : remaining > 0 ? now() + Number(job.process?.stepDelayMs ?? 0) : null;
        if (remaining === 0) patch.status = 'completed';
      } else {
        patch.nextRunAt = job.schedule?.type === 'once' ? null : computeNextRun(job);
      }

      if (result.status === 'awaiting_approval') {
        // ⚠️ Raspored se ZAUSTAVLJA dok čovjek ne odobri — inače bi se isti posao izvršio dvaput
        // (jednom kroz odobrenje, jednom po rasporedu). Nastavak: POST /v1/admin/jobs/:id/resume
        patch.status = 'waiting_approval';
        patch.nextRunAt = null;
        patch.pausedReason = `čeka odobrenje: ${(result.approvals ?? []).map((a) => a.tool).join(', ')}`;
        metrics?.inc('jobs_waiting_approval_total', { tenant: tenantId, job: job.id });
      }

      await releaseLease(tenantId, job.id, patch);
      await store.appendRun(tenantId, {
        runId,
        ts: iso(),
        tenantId,
        jobId: job.id,
        reason,
        event,
        manual,
        agentId: result.agentId,
        pattern: result.pattern,
        status: result.status,
        durationMs: Date.now() - startedAt,
        costUsd: result.costUsd,
        tokensIn: result.usage?.tokensIn ?? 0,
        tokensOut: result.usage?.tokensOut ?? 0,
        output: String(result.output ?? '').slice(0, 500),
        approvals: result.approvals?.length ?? 0,
      });
      await robot.audit?.append({
        tenantId,
        actor: `scheduler:${job.id}`,
        action: manual ? 'job_run_manual' : 'job_run',
        tool: null,
        args: { jobId: job.id, agentId: result.agentId, pattern: result.pattern, reason, event },
        decision: 'allow',
        outcome: success ? 'ok' : 'error',
        runId: result.runId,
        meta: { costUsd: result.costUsd, status: result.status, durationMs: Date.now() - startedAt },
      });

      metrics?.inc('jobs_finished_total', { tenant: tenantId, job: job.id, status: result.status });
      logger?.info?.('job.run', { tenantId, jobId: job.id, runId: result.runId, status: result.status, costUsd: result.costUsd });
      return { status: result.status, runId: result.runId, output: result.output, costUsd: result.costUsd, approvals: result.approvals };
    } catch (err) {
      const attempts = (job.attempts ?? 0) + 1;
      const maxAttempts = job.retry?.max ?? 2;
      const isPolicy = err instanceof PolicyError || err instanceof ApprovalRequiredError;
      const isBudget = err instanceof BudgetExceededError;
      const retry = !isPolicy && !isBudget && attempts <= maxAttempts;

      const patch = {
        attempts,
        lastError: { message: err.message, code: err.code ?? 'UNKNOWN', at: iso() },
        status: retry ? 'retrying' : isPolicy ? 'blocked' : 'failed',
        // eksponencijalni backoff (max 10 min)
        nextRunAt: retry ? now() + Math.min(600_000, (job.retry?.backoffMs ?? 5000) * 2 ** (attempts - 1)) : null,
        enabled: retry ? job.enabled !== false : false,
      };
      await releaseLease(tenantId, job.id, patch);
      await store.appendRun(tenantId, {
        runId,
        ts: iso(),
        tenantId,
        jobId: job.id,
        reason,
        status: 'error',
        error: err.message,
        code: err.code ?? 'UNKNOWN',
        attempts,
        durationMs: Date.now() - startedAt,
      });
      await robot.audit?.append({
        tenantId,
        actor: `scheduler:${job.id}`,
        action: 'job_run',
        args: { jobId: job.id, reason, attempts },
        decision: isPolicy ? 'deny' : 'allow',
        outcome: 'error',
        meta: { error: err.message, code: err.code },
      });
      metrics?.inc('jobs_failed_total', { tenant: tenantId, job: job.id, code: err.code ?? 'UNKNOWN' });
      logger?.warn?.('job.failed', { tenantId, jobId: job.id, error: err.message, attempts, retry });
      return { status: 'error', error: err.message, code: err.code };
    } finally {
      active = Math.max(0, active - 1);
      metrics?.set('jobs_active', {}, active);
      runningJobs.delete(`${tenantId}:${job.id}`);
    }
  }

  async function tick() {
    if (ticking || stopped) return 0;
    ticking = true;
    let executed = 0;
    try {
      for (const tenantId of store.tenantsWithJobs()) {
        if (active >= maxConcurrent) break;
        const jobs = await store.list(tenantId, { enabledOnly: true });
        for (const job of jobs) {
          if (active >= maxConcurrent) break;
          if (!isDue(job)) continue;
          const key = `${tenantId}:${job.id}`;
          if (runningJobs.has(key)) continue;
          runningJobs.add(key);
          const leased = await acquireLease(tenantId, job.id);
          if (!leased) {
            runningJobs.delete(key);
            continue;
          }
          executed += 1;
          runJob(tenantId, leased, { reason: 'schedule' }); // namjerno bez await — tick ne čeka
        }
      }
    } catch (err) {
      logger?.error?.('scheduler.tick_failed', { error: err.message });
    } finally {
      ticking = false;
    }
    return executed;
  }

  return {
    store,
    isRunning: () => Boolean(timer),
    start() {
      if (timer) return;
      stopped = false;
      timer = setInterval(() => tick().catch(() => {}), tickMs);
      timer.unref?.();
      logger?.info?.('scheduler.started', { tickMs, maxConcurrent });
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      logger?.info?.('scheduler.stopped', {});
    },
    tick,
    describeSchedule,

    async createJob(tenantId, spec) {
      // Validacija rasporeda ODMAH — bolje greška pri kreiranju nego posao koji se nikad ne izvrši
      if (spec.schedule?.type === 'cron') {
        try {
          validateCron(spec.schedule.cron);
        } catch (err) {
          throw new ValidationError(`Neispravan cron raspored: ${err.message}`, { cron: spec.schedule.cron });
        }
      }
      if (spec.schedule && !['once', 'interval', 'cron'].includes(spec.schedule.type)) {
        throw new ValidationError(`Nepoznat tip rasporeda: "${spec.schedule.type}" (dozvoljeno: once, interval, cron)`);
      }
      if (spec.schedule?.type === 'interval' && !(Number(spec.schedule.everyMs) > 0)) {
        throw new ValidationError('Raspored "interval" traži "everyMs" veći od nule');
      }
      const job = {
        id: spec.id ?? uid('job'),
        tenantId,
        name: spec.name ?? spec.id ?? 'posao',
        type: spec.type ?? 'task',
        agentId: spec.agentId ?? 'router',
        pattern: spec.pattern,
        input: spec.input,
        schedule: spec.schedule ?? { type: 'interval', everyMs: 3_600_000 },
        triggers: spec.triggers ?? [],
        process: spec.process,
        patternConfig: spec.patternConfig,
        budgetPerRunUsd: spec.budgetPerRunUsd,
        approvedTools: spec.approvedTools,
        userId: spec.userId,
        sessionId: spec.sessionId,
        retry: spec.retry ?? { max: 2, backoffMs: 5000 },
        enabled: spec.enabled !== false,
        goalId: spec.goalId ?? null,
        meta: spec.meta ?? {},
        status: 'pending',
        runs: 0,
      };
      job.nextRunAt = spec.runNow ? now() : computeNextRun(job) ?? (job.schedule?.type === 'once' ? (spec.schedule?.at ?? now()) : null);
      const saved = await store.upsert(tenantId, job);
      await robot.audit?.append({ tenantId, actor: 'control-plane', action: 'job_create', args: { jobId: saved.id, agentId: saved.agentId, schedule: saved.schedule }, decision: 'allow', outcome: 'ok', meta: { enabled: saved.enabled } });
      logger?.info?.('job.created', { tenantId, jobId: saved.id, schedule: describeSchedule(saved.schedule), agentId: saved.agentId });
      metrics?.inc('jobs_created_total', { tenant: tenantId });
      return saved;
    },

    list: (tenantId) => store.list(tenantId),
    get: (tenantId, jobId) => store.get(tenantId, jobId),
    runs: (tenantId, opts) => store.listRuns(tenantId, opts),

    async pause(tenantId, jobId) {
      const job = await store.get(tenantId, jobId);
      if (!job) return null;
      return store.upsert(tenantId, { id: jobId, enabled: false, status: 'paused' });
    },

    async resume(tenantId, jobId, { everyMs } = {}) {
      const job = await store.get(tenantId, jobId);
      if (!job) return null;
      const schedule = everyMs ? { ...(job.schedule ?? {}), type: 'interval', everyMs } : job.schedule;
      return store.upsert(tenantId, {
        id: jobId,
        enabled: true,
        status: 'pending',
        attempts: 0,
        schedule,
        nextRunAt: computeNextRun({ ...job, schedule }) ?? now(),
      });
    },

    async remove(tenantId, jobId) {
      const removed = await store.remove(tenantId, jobId);
      if (removed) await robot.audit?.append({ tenantId, actor: 'control-plane', action: 'job_remove', args: { jobId }, decision: 'allow', outcome: 'ok' });
      return removed;
    },

    /** Ručno pokretanje (ne čeka raspored). */
    async runNow(tenantId, jobId, { reason = 'manual' } = {}) {
      const job = await acquireLease(tenantId, jobId);
      if (!job) return { status: 'busy' };
      runningJobs.add(`${tenantId}:${jobId}`);
      return runJob(tenantId, job, { reason, manual: true });
    },

    /** Događaj iz spoljnog svijeta (webhook) → poslovi koji ga slušaju. */
    async triggerEvent(event, payload = {}) {
      let fired = 0;
      for (const tenantId of store.tenantsWithJobs()) {
        const jobs = await store.list(tenantId, { enabledOnly: true });
        for (const job of jobs) {
          const match = (job.triggers ?? []).some((t) => t.type === 'event' && matchesEvent(t.event, event));
          if (!match) continue;
          const key = `${tenantId}:${job.id}`;
          if (runningJobs.has(key)) continue;
          const leased = await acquireLease(tenantId, job.id);
          if (!leased) continue;
          runningJobs.add(key);
          fired += 1;
          metrics?.inc('jobs_triggered_total', { tenant: tenantId, job: job.id, event });
          runJob(tenantId, { ...leased, input: job.inputTemplate ? renderTemplate(job.inputTemplate, payload) : job.input }, { reason: 'event', event });
        }
      }
      return fired;
    },

    stats() {
      return { running: Boolean(timer), active, runningJobs: [...runningJobs] };
    },
  };
}

/** Poklapanje događaja: tačno ime, '*' (svi) ili prefiks wildcard 'hook.*'. */
function matchesEvent(pattern, event) {
  if (!pattern) return false;
  if (pattern === '*' || pattern === event) return true;
  if (pattern.endsWith('.*')) return String(event).startsWith(pattern.slice(0, -1));
  return false;
}

function renderTemplate(template, payload) {  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, path) => {
    const value = path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), payload);
    return value === undefined || value === null ? m : typeof value === 'string' ? value : JSON.stringify(value);
  });
}
