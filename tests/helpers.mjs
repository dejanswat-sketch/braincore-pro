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
export function smartScript({ planJson, handoffTo = null, goalPlan, negotiation } = {}) {
  return ({ messages, callIndex }) => {
    const system = String(messages.find((m) => m.role === 'system')?.content ?? '');
    const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
    const user = String([...messages].reverse().find((m) => m.role === 'user')?.content ?? '');

    // ── v0.3: ciljevi, self-play, organizacija ──
    if (system.includes('Ti si strateg')) {
      return {
        text: JSON.stringify(
          goalPlan ?? {
            subgoals: [
              { title: 'Povećati konverziju ponuda', metric: 'conversion_pct', target: 25, owner: 'sales' },
              { title: 'Smanjiti trošak podrške', metric: 'support_cost_eur', target: 400, owner: 'support' },
            ],
            plan: [
              { step: 'Analiziraj zašto ponude propadaju', agent: 'data', when: 'nedjelja 1' },
              { step: 'Novi šablon ponude + A/B test', agent: 'sales', when: 'nedjelja 2-3' },
              { step: 'Dopuni KB za najčešća pitanja', agent: 'support', when: 'nedjelja 4' },
            ],
            kpis: ['konverzija ponuda', 'prosječno vrijeme odgovora'],
          },
        ),
      };
    }
    if (system.includes('Cilj kasni')) {
      return { text: JSON.stringify({ diagnosis: 'Previše leadova bez kvalifikacije', actions: [{ step: 'Uvedi lead_score prije ponude', agent: 'sales', when: 'nedjelja 1' }], drop: ['Masovni newsletter'], expectedEffect: '+8% konverzije' }) };
    }
    if (system.includes('proposer u self-play treningu')) {
      return { text: JSON.stringify({ task: 'Kupac traži povraćaj za narudžbinu 1042', context: 'Narudžbina kasni 10 dana', expected: 'Tačan odgovor sa rokom i politikom', difficulty: 3, checks: ['navodi politiku', 'nudi konkretan rok'] }) };
    }
    if (system.includes('poboljšavaš system prompt')) {
      return { text: 'Ti si support agent. UVIJEK prvo provjeri politiku povraćaja i navedi tačan rok.' };
    }
    if (system.includes('Ti si CEO AI firme')) {
      return { text: JSON.stringify({ priorities: ['konverzija ponuda', 'trošak podrške'], allocation: [{ role: 'cro', goals: ['konverzija'], budgetUsd: 50 }, { role: 'cso', goals: ['KB'], budgetUsd: 40 }], risks: ['preopterećenje podrške'], decisions_needed: ['budžet za kampanju'] }) };
    }
    if (system.includes('u firmi. Mandat:')) {
      const asked = Number((String(user).match(/"amountUsd":\s*(\d+)/) ?? [])[1] ?? 0);
      const accept = negotiation === 'agree' ? asked > 0 : negotiation === 'never' ? false : callIndex % 2 === 1;
      return { text: JSON.stringify({ offer: { amountUsd: asked > 0 ? Math.round(asked * 0.9) : 80, terms: 'mjesečno, 30 dana plaćanja' }, reasoning: 'Držim se svog mandata i marže.', accept }) };
    }

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
