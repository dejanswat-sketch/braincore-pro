#!/usr/bin/env node
/**
 * NMQ Robot CLI.
 *
 *   node src/cli.js serve                       # digne gateway
 *   node src/cli.js agents                      # lista agenata
 *   node src/cli.js tools                       # lista alata
 *   node src/cli.js run support "Kako da..."    # jedan run iz terminala
 *   node src/cli.js patterns                    # lista patterna
 *   node src/cli.js cost                        # potrošnja po tenantu (tekući mjesec)
 *   node src/cli.js audit-verify                # provjera hash lanca
 *   node src/cli.js keys <tenantId> [role]      # novi API ključ (ispisuje ključ i hash)
 *   node src/cli.js hook <source> "<tekst>"     # simulira webhook ulaz
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRobot } from './index.js';
import { token } from './core/ids.js';
import { iso } from './core/clock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...args] = process.argv.slice(2);

function tenantFromArgs(fallback) {
  return process.env.NMQ_DEFAULT_TENANT || fallback || 'nmq';
}

async function withRobot(fn, opts = {}) {
  const robot = await createRobot({ root: ROOT, connectMcp: opts.connectMcp ?? false });
  try {
    return await fn(robot);
  } finally {
    if (robot.server.listening) await robot.close();
  }
}

const commands = {
  async serve() {
    const robot = await createRobot({ root: ROOT });
    await robot.listen();
    const shutdown = async (sig) => {
      robot.logger.info('shutdown', { signal: sig });
      await robot.close();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  },

  async agents() {
    await withRobot(async (robot) => {
      for (const a of robot.catalog.all()) {
        console.log(`${a.id.padEnd(12)} ${a.domain.padEnd(12)} ${String(a.defaultPattern).padEnd(20)} ${a.description}`);
      }
      console.log(`\nUkupno: ${robot.catalog.size()} agenata`);
    });
  },

  async tools() {
    await withRobot(async (robot) => {
      for (const t of robot.tools.list()) {
        console.log(`${t.name.padEnd(28)} ${t.riskLevel.padEnd(7)} ${t.source.padEnd(16)} ${String(t.description).slice(0, 70)}`);
      }
      console.log(`\nUkupno: ${robot.tools.size()} alata`);
    });
  },

  async patterns() {
    await withRobot(async (robot) => console.log(robot.orchestrator.PATTERNS.join('\n')));
  },

  async run() {
    const agentId = args[0];
    const input = args.slice(1).join(' ') || 'Zdravo, šta možeš?';
    await withRobot(async (robot) => {
      const tenantId = tenantFromArgs();
      const result = await robot.orchestrator.run({ tenantId, agentId: agentId === 'router' ? null : agentId, pattern: agentId === 'router' ? 'router' : undefined, input });
      console.log('\n=== REZULTAT ===');
      console.log(result.output);
      console.log('\n=== META ===');
      console.log(JSON.stringify({ runId: result.runId, agent: result.agentId, pattern: result.pattern, status: result.status, usage: result.usage, costUsd: result.costUsd, steps: result.steps, durationMs: result.durationMs, approvals: result.approvals }, null, 2));
    });
  },

  async hook() {
    const source = args[0] ?? 'email';
    const text = args.slice(1).join(' ') || 'Klijent pita za status narudžbine.';
    await withRobot(async (robot) => {
      const tenantId = tenantFromArgs();
      const agentId = source === 'shopify' ? 'ecommerce' : source === 'github' ? 'dev' : 'support';
      const result = await robot.orchestrator.run({ tenantId, agentId, input: `[${source}] ${text}` });
      console.log(result.output);
      console.log(JSON.stringify({ runId: result.runId, agent: result.agentId, costUsd: result.costUsd }, null, 2));
    });
  },

  async cost() {
    await withRobot(async (robot) => {
      for (const t of robot.config.tenants) {
        const summary = await robot.cost.summary(t.id);
        console.log(`${t.id.padEnd(14)} ${summary.month}  ${summary.usd.toFixed(4)} USD  poziva=${summary.calls}  tokena=${summary.tokensIn + summary.tokensOut}`);
      }
    });
  },

  async 'audit-verify'() {
    await withRobot(async (robot) => {
      for (const t of robot.config.tenants) {
        const res = await robot.audit.verify(t.id);
        console.log(`${t.id.padEnd(14)} lanac=${res.ok ? 'OK' : 'POLOMLJEN'} zapisa=${res.checked}${res.firstBadSeq ? ` prviLoš=${res.firstBadSeq} (${res.reason})` : ''}`);
      }
    });
  },

  async keys() {
    const tenantId = args[0];
    const role = args[1] ?? 'owner';
    if (!tenantId) {
      console.error('Upotreba: node src/cli.js keys <tenantId> [role]');
      process.exit(1);
    }
    await withRobot(async (robot) => {
      const key = `nmq_${token(24)}`;
      const hash = robot.tenants.hashKey(key);
      console.log('API ključ (prikaži SAMO sada):', key);
      console.log('Hash za config/tenants.json:', hash);
      console.log(`\nDodaj u config/tenants.json → tenants[].apiKeys: [{ "id": "key_${Date.now()}", "hash": "${hash}", "role": "${role}" }]`);
      console.log(`\nProvjera: curl -H "Authorization: Bearer <ključ>" ${robot.config.env.publicUrl}/v1/agents`);
    });
  },

  async version() {
    console.log(`nmq-robot ${(await import('./index.js')).VERSION} · node ${process.version} · ${iso()}`);
  },

  async help() {
    console.log(
      [
        'NMQ Robot CLI',
        '',
        'Komande:',
        '  serve                          digne HTTP gateway',
        '  agents                         lista agenata',
        '  tools                          lista alata',
        '  patterns                       lista orchestration patterna',
        '  run <agent|router> "<tekst>"   jedan run iz terminala',
        '  hook <source> "<tekst>"        simulira webhook (email, shopify, github…)',
        '  cost                           potrošnja po tenantu',
        '  audit-verify                   provjera hash lanca audita',
        '  keys <tenantId> [role]         generiše API ključ i hash',
        '  version                        verzija',
      ].join('\n'),
    );
  },
};

const fn = commands[cmd] ?? commands.help;
try {
  await fn();
} catch (err) {
  console.error(`Greška: ${err.message}`);
  if (process.env.NMQ_DEBUG === '1') console.error(err.stack);
  process.exit(1);
}
