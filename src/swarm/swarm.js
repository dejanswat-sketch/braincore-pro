/**
 * Swarm runtime — decentralizovani roj bez centralnog orkestratora.
 *
 * Kako radi:
 *   - Svaki worker ima LOKALNA pravila: „uzmi najvrjedniji zadatak koji mogu, uradi ga, ostavi trag".
 *   - Nema koordinatora koji dodjeljuje posao: workeri se takmiče za zadatke na tabli (work stealing),
 *     a feromoni (tragovi drugih) mijenjaju prioritet.
 *   - Specijalizacija NIJE konfigurisana: mjeri se iz stvarnih završetaka i nastaje sama.
 *   - Sve što worker uradi prolazi kroz isti orchestrator (politike, budžet, autonomija) i governance roja.
 *
 * Rizik koji se ovim rješava: roj koji se sam organizuje može i da se sam „dogovori" protiv interesa
 * sistema. Zato svaki claim, poruka i feromon idu kroz nadzor (`safety.js`), a `lockdown()` gasi sve.
 */
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { PolicyError, ValidationError, NotFoundError } from '../core/errors.js';

export function createSwarm({ config = {}, blackboard, governance, safety, orchestrator, catalog, autonomy, rewards, audit, metrics, logger }) {
  const workers = new Map(); // workerId -> worker
  const roundStats = [];

  const tagOf = (task) => task?.payload?.tag ?? task?.meta?.tag ?? String(task?.title ?? '').split(' ')[0].toLowerCase();

  return {
    workers,
    blackboard,
    governance,
    safety,

    /** Registruje workera (jedan agent može imati više workera — npr. za paralelne zadatke). */
    registerWorker({ tenantId, agentId, name = null, skills = [], maxRunsPerTick = 1 }) {
      if (!catalog?.has?.(agentId)) throw new NotFoundError('Agent', agentId);
      governance?.assertWorkerQuota?.(tenantId, this.listWorkers(tenantId).length);
      const spec = catalog.get(agentId, tenantId);
      const worker = {
        id: uid('wrk'),
        tenantId,
        agentId,
        name: name ?? `${agentId}#${workers.size + 1}`,
        skills: skills.length ? skills : [spec?.domain ?? 'general', agentId],
        maxRunsPerTick,
        claims: 0,
        completed: 0,
        failed: 0,
        costUsd: 0,
        tags: {},
        createdAt: iso(),
      };
      workers.set(worker.id, worker);
      metrics?.inc('swarm_workers_total', { tenant: tenantId, agent: agentId });
      logger?.info?.('swarm.worker_registered', { tenantId, workerId: worker.id, agentId, skills: worker.skills });
      return worker;
    },

    listWorkers(tenantId) {
      return [...workers.values()].filter((w) => !tenantId || w.tenantId === tenantId);
    },

    /**
     * Mrežna politika roja: kad izolacija ne dozvoljava mrežu (`contained`/`locked`/`frozen`),
     * workerima se iz zakrpe IZBAJU mrežni alati — inače bi „izolacija" bila samo riječ u config-u.
     */
    networkPolicy(tenantId) {
      const allowed = governance?.canUseNetwork?.(tenantId) ?? false;
      const networkTools = config.networkTools ?? ['http_fetch', 'http_post', 'web_search', 'webhook_send', 'email_send'];
      const spec = { tools: null, blocked: [] };
      for (const worker of this.listWorkers(tenantId)) {
        const agentSpec = catalog.get(worker.agentId, tenantId);
        const tools = agentSpec?.tools ?? null;
        if (!allowed && Array.isArray(tools)) {
          const filtered = tools.filter((t) => !networkTools.includes(t));
          spec.blocked = [...new Set([...spec.blocked, ...tools.filter((t) => networkTools.includes(t))])];
          spec.tools = filtered;
        }
      }
      return { tenantId, networkAllowed: allowed, blockedTools: spec.blocked, effectiveTools: spec.tools };
    },

    /** Jedan „otkucaj" roja: svaki worker pokušava da uzme i uradi zadatak. */
    async tick(tenantId, { maxRuns = null, now = Date.now() } = {}) {
      const limit = maxRuns ?? governance?.quotas?.maxRunsPerTick ?? 8;
      const isolation = governance?.isolationOf?.(tenantId) ?? 'contained';
      if (isolation === 'locked' || isolation === 'frozen') {
        return { round: roundStats.length + 1, ran: 0, skipped: 'isolation', isolation };
      }

      let ran = 0;
      const results = [];
      for (const worker of this.listWorkers(tenantId)) {
        if (ran >= limit) break;
        if (safety?.isQuarantined?.(worker.id)) {
          results.push({ workerId: worker.id, skipped: 'quarantined' });
          continue;
        }
        const perWorker = Math.min(worker.maxRunsPerTick, limit - ran);
        for (let i = 0; i < perWorker; i += 1) {
          const task = await blackboard.claim(worker.id, { tenantId, skills: worker.skills, now });
          if (!task) {
            // nema posla za mene → ostavljam trag „tražim posao" (drugi workeri/voditelji to vide)
            if (governance?.assertCanPheromone) {
              try {
                governance.assertCanPheromone({ tenantId, by: worker.id });
                await blackboard.pheromone({ tenantId, type: 'help', by: worker.id, strength: 0.4, ttlMs: 120_000, payload: { skills: worker.skills } });
              } catch {
                /* kvota — preskoči */
              }
            }
            results.push({ workerId: worker.id, taskId: null, idle: true });
            break;
          }

          worker.claims += 1;
          safety?.observeClaim?.({ tenantId, workerId: worker.id, taskId: task.id, at: now });
          ran += 1;

          const agentId = task.meta?.agentId ?? worker.agentId;
          const input = task.payload?.input ?? task.title;
          const started = Date.now();
          try {
            // Satni budžet se provjerava PRIJE runa (procjena troška), a stvarni trošak se evidentira poslije
            await governance.assertCanRun({ tenantId, workerId: worker.id, riskLevel: task.meta?.riskLevel ?? 'low', task, costUsd: task.meta?.estimatedCostUsd ?? config.estimatedRunCostUsd ?? 0.01 });
            // Izolacija bez mreže = mrežni alati se izbacuju iz zakrpe za ovaj run
            const netPolicy = this.networkPolicy(tenantId);
            const specPatch = netPolicy.effectiveTools ? { tools: netPolicy.effectiveTools } : null;
            const result = await orchestrator.run({
              tenantId,
              agentId,
              pattern: task.meta?.pattern,
              input,
              userId: `swarm:${worker.id}`,
              sessionId: `swarm:${tenantId}:${task.id}`, // sesija po ZADATKU (ne po tagu) — bez miješanja konteksta
              options: specPatch ? { specPatch } : {},
              onEvent: undefined,
            });
            const ok = result.status === 'ok';
            await blackboard.complete(task.id, { workerId: worker.id, result: { output: String(result.output).slice(0, 2000), runId: result.runId, status: result.status }, success: ok, tenantId });
            governance?.recordCost?.(tenantId, { amountUsd: result.costUsd ?? 0, workerId: worker.id });
            worker.costUsd = Number((worker.costUsd + (result.costUsd ?? 0)).toFixed(6));
            worker.completed += ok ? 1 : 0;
            worker.failed += ok ? 0 : 1;
            const tag = tagOf(task);
            worker.tags[tag] = (worker.tags[tag] ?? 0) + (ok ? 1 : 0);
            if (rewards && result.runId) {
              await rewards.record(tenantId, {
                runId: result.runId,
                agentId: result.agentId,
                pattern: result.pattern,
                signals: { outcome: ok ? 'ok' : 'error', costUsd: result.costUsd ?? 0, durationMs: Date.now() - started, feedback: task.payload?.feedback ?? null },
              });
            }
            results.push({ workerId: worker.id, taskId: task.id, runId: result.runId, status: result.status, costUsd: result.costUsd, ms: Date.now() - started });
          } catch (err) {
            const policy = err instanceof PolicyError;
            await blackboard.complete(task.id, { workerId: worker.id, result: { error: err.message, code: err.code ?? 'UNKNOWN' }, success: false, tenantId });
            worker.failed += 1;
            if (!policy) logger?.warn?.('swarm.task_failed', { tenantId, workerId: worker.id, taskId: task.id, error: err.message });
            results.push({ workerId: worker.id, taskId: task.id, error: err.message, code: err.code ?? 'UNKNOWN', ms: Date.now() - started });
          }
        }
      }

      const round = { round: roundStats.length + 1, ts: iso(), tenantId, ran, results, isolation };
      roundStats.push(round);
      if (roundStats.length > 500) roundStats.shift();
      metrics?.observe('swarm_round_runs', { tenant: tenantId }, ran);
      return round;
    },

    /** Više rundi + detekcija emergentnih obrazaca poslije svake runde. */
    async run(tenantId, { rounds = 3, maxRuns = null, detectEvery = 1 } = {}) {
      const out = [];
      for (let r = 1; r <= rounds; r += 1) {
        const round = await this.tick(tenantId, { maxRuns });
        out.push(round);
        if (detectEvery && r % detectEvery === 0) {
          const findings = await safety.detect({ tenantId });
          round.findings = findings.map((f) => ({ type: f.type, severity: f.severity }));
          if (governance?.isolationOf?.(tenantId) === 'frozen') {
            logger?.error?.('swarm.frozen_during_run', { tenantId, round: r });
            break;
          }
        }
      }
      await audit?.append({
        tenantId,
        actor: 'swarm',
        action: 'swarm_run',
        args: { rounds, ran: out.reduce((s, r) => s + r.ran, 0) },
        decision: 'allow',
        outcome: 'ok',
        meta: { isolation: governance?.isolationOf?.(tenantId) ?? null },
      });
      return { rounds: out.length, ran: out.reduce((s, r) => s + r.ran, 0), results: out, stats: this.stats(tenantId) };
    },

    /** Emergentna specijalizacija: ko je stvarno postao najbolji za koji tip zadatka. */
    specialization(tenantId) {
      const perTag = {};
      for (const w of this.listWorkers(tenantId)) {
        for (const [tag, count] of Object.entries(w.tags)) {
          perTag[tag] = perTag[tag] ?? [];
          perTag[tag].push({ workerId: w.id, name: w.name, agentId: w.agentId, completed: count });
        }
      }
      const out = {};
      for (const [tag, list] of Object.entries(perTag)) {
        const sorted = list.sort((a, b) => b.completed - a.completed);
        const total = sorted.reduce((s, x) => s + x.completed, 0);
        out[tag] = { expert: sorted[0] ?? null, share: total ? Number(((sorted[0]?.completed ?? 0) / total).toFixed(2)) : 0, workers: sorted.length };
      }
      return out;
    },

    /** Kolektivno odlučivanje: glas workera (kroz safety nadzor). */
    async vote(tenantId, { proposalId, workerId, choice, rationale = null }) {
      if (!proposalId || !workerId || choice === undefined) throw new ValidationError('Glas traži proposalId, workerId i choice');
      if (!workers.has(workerId)) throw new ValidationError(`Nepoznat worker: ${workerId}`);
      if (safety?.isQuarantined?.(workerId)) throw new PolicyError(`Worker ${workerId} je u karantinu`, { workerId });
      safety?.observeVote?.({ tenantId, workerId, proposalId, choice });
      await blackboard.pheromone({ tenantId, type: 'opportunity', by: workerId, strength: 0.3, ttlMs: 60_000, payload: { proposalId, choice, rationale } });
      return this.consensus(tenantId, proposalId);
    },

    consensus(tenantId, proposalId) {
      const relevant = (safety?.votes ?? []).filter((v) => v.proposalId === proposalId && v.tenantId === tenantId);
      const tally = relevant.reduce((acc, v) => ({ ...acc, [String(v.choice)]: (acc[String(v.choice)] ?? 0) + 1 }), {});
      const total = relevant.length;
      const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      const top = sorted[0];
      return {
        proposalId,
        votes: total,
        tally,
        winner: top ? (top[1] / total > 0.5 ? top[0] : null) : null,
        unanimous: total > 0 && sorted.length === 1,
        participation: total,
        note: 'Glasanje je savjetodavno — izvršne odluke iznad niskog rizika i dalje traže čovjeka (board).',
      };
    },

    stats(tenantId) {
      const board = blackboard.snapshot({ tenantId });
      const list = this.listWorkers(tenantId);
      return {
        tenantId,
        isolation: governance?.isolationOf?.(tenantId) ?? null,
        workers: list.length,
        quarantined: list.filter((w) => safety?.isQuarantined?.(w.id)).length,
        claims: list.reduce((s, w) => s + w.claims, 0),
        completed: list.reduce((s, w) => s + w.completed, 0),
        failed: list.reduce((s, w) => s + w.failed, 0),
        costUsd: Number(list.reduce((s, w) => s + w.costUsd, 0).toFixed(6)),
        board: { open: board.open, claimed: board.claimed, done: board.done, pheromones: board.pheromones.length },
        specialization: this.specialization(tenantId),
        rounds: roundStats.length,
      };
    },

    history: () => roundStats.slice(-50),
  };
}
