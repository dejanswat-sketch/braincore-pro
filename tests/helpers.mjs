/**
 * Test pomoćnici: robot sa mock LLM-om, u privremenom dataDir-u, bez mreže.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRobot } from '../src/index.js';
import { createMockProvider } from '../src/llm/mock.js';

export const ROOT = path.resolve(import.meta.dirname, '..');

export async function tempDataDir(label = 'test') {
  const dir = path.join(os.tmpdir(), `nmq-robot-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * "Pametan" mock: odgovara na osnovu sistemskog prompta, pa jedan skript pokriva sve patterne.
 */
export function smartScript({ planJson, handoffTo = null } = {}) {
  return ({ messages, callIndex }) => {
    const system = String(messages.find((m) => m.role === 'system')?.content ?? '');
    const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
    const user = String([...messages].reverse().find((m) => m.role === 'user')?.content ?? '');

    if (system.includes('planer') || system.includes('ruter')) {
      return {
        text: JSON.stringify(
          planJson ?? {
            goal: 'Obraditi zahtjev',
            subtasks: [
              { agent: 'support', goal: 'Provjeri bazu znanja i odgovori na pitanje' },
              { agent: 'finance', goal: 'Provjeri da li postoji faktura' },
            ],
          },
        ),
      };
    }
    if (system.includes('analitičar')) return { text: 'SINTEZA: svi uglovi se slažu da je rizik nizak.' };
    if (system.includes('Ti si orchestrator') || system.includes('Spоji rezultate')) {
      return { text: 'FINALNO: zadatak je obrađen kroz podzadatke.' };
    }
    if (system.includes('Ocijeni odgovor') || system.includes('kritičar')) return { text: JSON.stringify({ score: 0.9, issues: [], suggestion: 'u redu' }) };
    if (system.includes('Sažmi razgovor')) return { text: 'Sažetak: korisnik pita o lozinci.' };
    if (system.includes('iterativno')) return { text: 'PLAN: 1) provjeri logove 2) nađi uzrok 3) predloži popravku' };

    if (lastTool) {
      return { text: `Na osnovu alata: ${String(lastTool.content).slice(0, 200)}` };
    }
    if (handoffTo && callIndex === 0) {
      return { toolCalls: [{ name: 'handoff', arguments: { toAgent: handoffTo, reason: 'Nije moja nadležnost', summary: 'Klijent traži povraćaj novca.' } }] };
    }
    if (/lozink|prijava|reset/i.test(user)) {
      return {
        toolCalls: [{ name: 'memory_search', arguments: { query: 'reset lozinke', k: 2 } }],
      };
    }
    return { text: `Odgovor: ${user.slice(0, 120)}` };
  };
}

export async function buildTestRobot({ script, dataDir, env = {}, connectMcp = false, scheduler = false, overrides: extraOverrides = {} } = {}) {
  const dir = dataDir ?? (await tempDataDir('robot'));
  const llm = createMockProvider({ script: script ?? smartScript(), model: 'deepseek-chat' });
  const robot = await createRobot({
    root: ROOT,
    dataDir: dir,
    connectMcp,
    env: { ...process.env, NMQ_LOG_LEVEL: 'silent', ...env },
    overrides: { llm, logLevel: 'silent', scheduler, ...extraOverrides },
  });
  robot.__dir = dir;
  return robot;
}

export async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Skupi SSE događaje iz fetch odgovora. */
export async function collectSse(response) {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((block) => {
      const ev = block.split('\n').find((l) => l.startsWith('event:'));
      const data = block.split('\n').find((l) => l.startsWith('data:'));
      if (!data) return null;
      try {
        return { event: ev ? ev.slice(6).trim() : 'message', data: JSON.parse(data.slice(5).trim()) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
