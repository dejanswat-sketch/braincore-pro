/**
 * Eval harness — zlatni set pitanja po tenantu i automatska ocjena odgovora.
 *
 * Ovo je preduslov za svaku ozbiljnu automatizaciju (self-improvement, A/B, RSI):
 * bez mjerenja „da li je bolje" svaka promjena prompta je nagađanje.
 *
 * Zlatni set: `eval/<tenantId>.json` (u repou, verzionisan)
 * Rezultati:   `data/tenants/<id>/eval/results-YYYY-MM.jsonl`
 *
 * Provjere po pitanju (`checks`):
 *   mustInclude[]    — odgovor mora sadržati sve navedene podstringove
 *   mustNotInclude[] — ne smije sadržati nijedan
 *   mustCite         — mora imati citat iz baze znanja ([1], [2]…)
 *   mustUseTool[]    — mora pozvati navedene alate (iz trace koraka)
 *   mustNotUseTool[] — ne smije pozvati navedene alate
 *   expectStatus     — očekivan status run-a (default 'ok')
 *   agentId          — kojim agentom se rješava (default: ruter)
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { appendJsonl, readJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { ValidationError, NotFoundError } from '../core/errors.js';

export function createEvalHarness({ dataDir, root, logger, metrics, audit, orchestrator, tracer }) {
  const setFile = (tenantId, name = 'golden') => path.join(root, 'eval', `${tenantId}${name === 'golden' ? '' : `.${name}`}.json`);
  const resultsFile = (tenantId, d = new Date()) => path.join(dataDir, 'tenants', tenantId, 'eval', `results-${d.toISOString().slice(0, 7)}.jsonl`);

  async function loadSet(tenantId, name = 'golden') {
    const file = setFile(tenantId, name);
    try {
      const set = await readJson(file, null);
      if (!set) throw new NotFoundError('Eval set', file);
      if (!Array.isArray(set.cases) || !set.cases.length) throw new ValidationError(`Eval set ${file} nema "cases"`);
      return { ...set, file };
    } catch (err) {
      if (err.code === 'NOT_FOUND' || err.message?.includes('ne postoji')) throw new NotFoundError('Eval set', file);
      throw err;
    }
  }

  /**
   * Koje je alate run stvarno pozvao — čita se iz TRACE-a (radi za sve patterne, uključujući handoff i team),
   * a ako trace nije dostupan, padne na korake patterna.
   */
  function toolsUsed(result) {
    const run = result?.runId && tracer?.get ? tracer.get(result.runId) : null;
    const fromSpans = (run?.spans ?? []).filter((s) => String(s.name).startsWith('tool ')).map((s) => String(s.name).slice(5));
    if (fromSpans.length) return [...new Set(fromSpans)];
    const steps = result?.result?.results?.[0]?.steps ?? result?.result?.steps ?? [];
    return [...new Set(steps.filter((s) => s.type === 'tool' && s.ok).map((s) => s.name))];
  }

  function checkCase(testCase, result, toolsOverride = null) {
    const checks = testCase.checks ?? {};
    const output = String(result.output ?? '');
    const tools = toolsOverride ?? toolsUsed(result);
    const failures = [];

    if (checks.expectStatus && result.status !== checks.expectStatus) failures.push(`status ${result.status} ≠ ${checks.expectStatus}`);
    for (const needle of checks.mustInclude ?? []) if (!output.toLowerCase().includes(String(needle).toLowerCase())) failures.push(`nema "${needle}"`);
    for (const needle of checks.mustNotInclude ?? []) if (output.toLowerCase().includes(String(needle).toLowerCase())) failures.push(`sadrži zabranjeno "${needle}"`);
    if (checks.mustCite && !/\[\d+\]/.test(output)) failures.push('nema citata ([1], [2]…)');
    for (const tool of checks.mustUseTool ?? []) if (!tools.includes(tool)) failures.push(`nije pozvao alat ${tool}`);
    for (const tool of checks.mustNotUseTool ?? []) if (tools.includes(tool)) failures.push(`nije smio pozvati alat ${tool}`);
    if (checks.maxCostUsd !== undefined && (result.costUsd ?? 0) > checks.maxCostUsd) failures.push(`trošak ${result.costUsd} > ${checks.maxCostUsd}`);

    return { passed: failures.length === 0, failures, tools };
  }

  return {
    setFile,
    resultsFile,
    loadSet,
    checkCase,
    toolsUsed,

    /**
     * Pokreće zlatni set i vraća izvještaj.
     * @param {object} opts { name, caseIds, maxCases, specPatch } — `specPatch` se primjenjuje na SVAKI run
     *        (koristi ga evolucija i RSI da ocijene genom bez mijenjanja kataloga)
     */
    async run(tenantId, { name = 'golden', caseIds = null, maxCases = 50, specPatch = null } = {}) {
      const set = await loadSet(tenantId, name);
      const cases = set.cases.filter((c) => !caseIds || caseIds.includes(c.id)).slice(0, maxCases);
      const results = [];
      let costUsd = 0;
      let durationMs = 0;

      for (const testCase of cases) {
        const started = Date.now();
        let result = null;
        let error = null;
        try {
          result = await orchestrator.run({
            tenantId,
            agentId: testCase.agentId ?? null,
            pattern: testCase.pattern,
            input: testCase.input,
            sessionId: `eval:${set.name}:${testCase.id}`,
            userId: 'eval-harness',
            options: { ...(testCase.options ?? {}), maxRunUsd: testCase.checks?.maxCostUsd ?? undefined, ...(specPatch ? { specPatch } : {}) },
          });
        } catch (err) {
          error = { message: err.message, code: err.code ?? 'UNKNOWN' };
        }
        const elapsed = Date.now() - started;
        const verdict = error ? { passed: false, failures: [error.message], tools: [] } : checkCase(testCase, result);
        const record = {
          ts: iso(),
          tenantId,
          set: set.name,
          caseId: testCase.id,
          question: testCase.input,
          agentId: result?.agentId ?? testCase.agentId ?? null,
          pattern: result?.pattern ?? null,
          status: result?.status ?? 'error',
          passed: verdict.passed,
          failures: verdict.failures,
          tools: verdict.tools,
          costUsd: result?.costUsd ?? 0,
          durationMs: elapsed,
          output: String(result?.output ?? '').slice(0, 1000),
        };
        results.push(record);
        costUsd += record.costUsd;
        durationMs += elapsed;
        await appendJsonl(resultsFile(tenantId), record);
      }

      const passed = results.filter((r) => r.passed).length;
      const report = {
        tenantId,
        set: set.name,
        threshold: set.threshold ?? 0.8,
        total: results.length,
        passed,
        failed: results.length - passed,
        passRate: results.length ? Number((passed / results.length).toFixed(3)) : 0,
        meetsThreshold: results.length ? passed / results.length >= (set.threshold ?? 0.8) : false,
        costUsd: Number(costUsd.toFixed(6)),
        avgCostUsd: results.length ? Number((costUsd / results.length).toFixed(6)) : 0,
        avgDurationMs: results.length ? Math.round(durationMs / results.length) : 0,
        failures: results.filter((r) => !r.passed).map((r) => ({ caseId: r.caseId, failures: r.failures, status: r.status })),
        cases: results.map((r) => ({ caseId: r.caseId, passed: r.passed, costUsd: r.costUsd, durationMs: r.durationMs, tools: r.tools })),
        at: iso(),
      };
      metrics?.observe('eval_pass_rate', { tenant: tenantId, set: set.name }, report.passRate);
      metrics?.inc('eval_runs_total', { tenant: tenantId, set: set.name, result: report.meetsThreshold ? 'pass' : 'fail' });
      await audit?.append({
        tenantId,
        actor: 'eval-harness',
        action: 'eval_run',
        args: { set: set.name, cases: report.total, passRate: report.passRate, threshold: report.threshold },
        decision: 'allow',
        outcome: report.meetsThreshold ? 'ok' : 'below_threshold',
        meta: { costUsd: report.costUsd, failures: report.failures.length },
      });
      logger?.info?.('eval.run', { tenantId, set: set.name, total: report.total, passRate: report.passRate, meetsThreshold: report.meetsThreshold });
      return report;
    },

    /** Historija rezultata (za trend kroz nedjelje). */
    async history(tenantId, { limit = 20 } = {}) {
      const file = resultsFile(tenantId);
      const raw = await fs.readFile(file, 'utf8').catch(() => '');
      const rows = raw
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const byRun = new Map();
      for (const r of rows) {
        const key = r.ts.slice(0, 16); // minut kao „run"
        if (!byRun.has(key)) byRun.set(key, { at: r.ts, set: r.set, total: 0, passed: 0 });
        const agg = byRun.get(key);
        agg.total += 1;
        if (r.passed) agg.passed += 1;
      }
      return [...byRun.values()]
        .map((a) => ({ ...a, passRate: a.total ? Number((a.passed / a.total).toFixed(3)) : 0 }))
        .slice(-limit)
        .reverse();
    },
  };
}
