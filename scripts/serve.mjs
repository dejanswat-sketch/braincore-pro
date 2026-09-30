#!/usr/bin/env node
/**
 * Pokreće NMQ Robot gateway.
 *
 *   node scripts/serve.mjs                     # koristi .env ako postoji
 *   NMQ_PORT=9000 node scripts/serve.mjs       # env ima prioritet nad .env
 *   NMQ_LLM_PROVIDER=mock node scripts/serve.mjs   # demo bez API ključa
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRobot } from '../src/index.js';
import { loadEnvFile } from './env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = loadEnvFile({ root: ROOT });

const robot = await createRobot({ root: ROOT });
const addr = await robot.listen();

console.log('');
console.log('  NMQ Robot je pokrenut');
console.log('  ────────────────────────────────────────────────────────────');
console.log(`  URL:            http://${robot.config.env.host}:${addr.port}`);
console.log(`  Demo stranica:  http://127.0.0.1:${addr.port}/`);
console.log(`  Widget:         http://127.0.0.1:${addr.port}/widget.js`);
console.log(`  Agenti:         ${robot.catalog.size()}   Alata: ${robot.tools.size()}   MCP: ${robot.mcp.list().length}`);
console.log(`  LLM:            ${robot.llm.providers.map((p) => p.name).join(' → ')}${robot.llm.isMock ? '  ⚠️  MOCK (nema NMQ_LLM_API_KEY)' : ''}`);
console.log(`  Podaci:         ${robot.config.dataDir}`);
console.log(`  .env:           ${envFile.loaded ? `${envFile.path} (${envFile.count} varijabli)` : 'nema (radi sa default-ima)'}`);
console.log(`  Auth:           ${robot.config.requireAuth ? 'OBAVEZAN API ključ' : 'otvoren (dev režim) — u produkciji postavi requireAuth: true'}`);
console.log('  ────────────────────────────────────────────────────────────');
console.log('  Primjer:');
console.log(`    curl -X POST http://127.0.0.1:${addr.port}/v1/agents/support/run -H "content-type: application/json" -d "{\\"input\\":\\"Kako da resetujem lozinku?\\"}"`);
console.log('');

const shutdown = async (signal) => {
  console.log(`\n  ${signal} — gasim…`);
  await robot.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => robot.logger.error('unhandledRejection', { error: err?.message }));
process.on('uncaughtException', (err) => {
  robot.logger.error('uncaughtException', { error: err?.message, stack: err?.stack });
  process.exit(1);
});
