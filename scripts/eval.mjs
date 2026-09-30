#!/usr/bin/env node
/**
 * Eval CLI — pokreće zlatni set i kaže da li je kvalitet iznad praga.
 *
 *   node scripts/eval.mjs                          # tenant nmq, mock LLM (bez troška)
 *   node scripts/eval.mjs --tenant demo-shop
 *   NMQ_LLM_API_KEY=... node scripts/eval.mjs       # pravi model (mjeri stvarni kvalitet i trošak)
 *   node scripts/eval.mjs --threshold 0.9 --cases support-reset-lozinke,sales-kvalifikacija
 *
 * Exit kod: 0 = iznad praga, 1 = ispod praga ili greška (pogodno za CI).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRobot } from '../src/index.js';
import { createMockProvider } from '../src/llm/mock.js';
import { createScriptedLlm } from './mock-script.mjs';
import { loadEnvFile } from './env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile({ root: ROOT });

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const tenantId = flag('tenant', process.env.NMQ_DEFAULT_TENANT || 'nmq');
const setName = flag('set', 'golden');
const threshold = Number(flag('threshold', '0'));
const onlyCases = flag('cases') ? String(flag('cases')).split(',').map((s) => s.trim()) : null;
const dataDir = flag('data', process.env.NMQ_DATA_DIR || './data/_eval');

const robot = await createRobot({
  root: ROOT,
  dataDir,
  connectMcp: false,
  env: { ...process.env, NMQ_LOG_LEVEL: process.env.NMQ_LOG_LEVEL ?? 'warn' },
  overrides: process.env.NMQ_LLM_API_KEY ? {} : { llm: createMockProvider({ script: createScriptedLlm(), model: 'deepseek-chat' }), logLevel: 'warn', scheduler: false },
});

try {
  const report = await robot.eval.run(tenantId, { name: setName, caseIds: onlyCases, maxCases: Number(flag('max', '50')) });
  const effectiveThreshold = threshold || report.threshold;

  console.log('');
  console.log(`  EVAL — tenant ${tenantId}, set "${report.set}"${robot.llm.isMock ? ' (mock LLM)' : ` (${robot.config.env.llm.model})`}`);
  console.log('  ────────────────────────────────────────────────────────────');
  for (const c of report.cases) {
    console.log(`  ${c.passed ? '✔' : '✖'} ${c.caseId.padEnd(28)} ${String(c.durationMs).padStart(5)}ms  ${c.costUsd.toFixed(6)} USD  ${c.tools.join(',') || '-'}`);
  }
  console.log('  ────────────────────────────────────────────────────────────');
  console.log(`  prolaznost: ${report.passed}/${report.total} = ${(report.passRate * 100).toFixed(1)}%  (prag ${(effectiveThreshold * 100).toFixed(0)}%)`);
  console.log(`  trošak: ${report.costUsd.toFixed(6)} USD (prosjek ${report.avgCostUsd.toFixed(6)}) · prosječno trajanje ${report.avgDurationMs}ms`);
  if (report.failures.length) {
    console.log('  padovi:');
    for (const f of report.failures) console.log(`    - ${f.caseId}: ${f.failures.join('; ')}`);
  }
  const ok = report.passRate >= effectiveThreshold;
  console.log(`  zaključak: ${ok ? 'IZNAD PRAGA ✔' : 'ISPOD PRAGA ✖'}`);
  console.log('');
  if (!report.meetsThreshold && threshold) process.exitCode = 1;
  if (threshold && !ok) process.exitCode = 1;
} catch (err) {
  console.error(`EVAL GREŠKA: ${err.message}`);
  process.exitCode = 1;
} finally {
  await robot.close();
}
