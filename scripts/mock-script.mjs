/**
 * Skriptovani mock LLM za demo i smoke — deterministički odgovara na SVE promptove koje robot koristi
 * (planer, ruter, goal-decomposer/replanner, self-play proposer/improver, org CEO, pregovaranje, agenti).
 *
 * Koristi se samo kada nema `NMQ_LLM_API_KEY` (ili kad je provider izričito `mock`).
 */
export function createScriptedLlm() {
  return ({ messages }) => {
    const system = String(messages.find((m) => m.role === 'system')?.content ?? '');
    const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
    const user = String([...messages].reverse().find((m) => m.role === 'user')?.content ?? '');

    if (system.includes('Ti si strateg')) {
      return {
        text: JSON.stringify({
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
        }),
      };
    }
    if (system.includes('Cilj kasni')) {
      return { text: JSON.stringify({ diagnosis: 'Ponude propadaju zbog slabe kvalifikacije', actions: [{ step: 'Uvedi lead_score prije ponude', agent: 'sales', when: 'nedjelja 1' }], drop: ['Masovni newsletter'], expectedEffect: '+8% konverzije' }) };
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
      return { text: JSON.stringify({ offer: { amountUsd: asked > 0 ? Math.round(asked * 0.95) : 80, terms: 'mjesečno, 30 dana plaćanja' }, reasoning: 'Držim se mandata i marže.', accept: asked > 0 }) };
    }
    if (system.includes('planer') || system.includes('ruter')) {
      return {
        text: JSON.stringify({
          goal: 'Obraditi zahtjev',
          subtasks: [
            { agent: 'support', goal: 'Provjeri bazu znanja i odgovori' },
            { agent: 'finance', goal: 'Provjeri da li postoji faktura' },
          ],
        }),
      };
    }
    if (system.includes('analitičar')) return { text: 'SINTEZA: pravni rizik nizak, komercijalni uslovi prihvatljivi, rokovi izvodljivi. Preporuka: potpisati uz izmjenu člana 7 (penali).' };
    if (system.includes('Ti si orchestrator')) return { text: 'PONUDA (sinteza): Pro paket, 149 EUR/mjesečno, uvođenje 2 nedjelje.' };
    if (system.includes('iterativno')) return { text: 'PLAN: 1) pregledaj log deploy-a 2) uporedi sa poslednjim dobrim buildom 3) predloži popravku' };
    if (system.includes('Ocijeni odgovor') || system.includes('kritičar')) return { text: JSON.stringify({ score: 0.9, issues: [], suggestion: 'u redu' }) };
    if (system.includes('Sažmi razgovor')) return { text: 'Sažetak: korisnik pita o lozinci.' };
    if (lastTool) return { text: `Na osnovu alata: ${String(lastTool.content).slice(0, 180)}` };

    if (/lozink|prijava|reset/i.test(user)) return { toolCalls: [{ name: 'memory_search', arguments: { query: 'reset lozinke', k: 3 } }] };
    if (/ponudu|ponuda/i.test(user)) return { toolCalls: [{ name: 'lead_score', arguments: { budget: 9, urgency: 8, companySize: 8, authority: 9, needClarity: 7 } }] };
    return { text: `Odgovor agenta: ${user.slice(0, 140)}` };
  };
}
