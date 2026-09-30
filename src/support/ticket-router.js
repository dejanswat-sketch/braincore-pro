/**
 * SUPPORT CLUSTER — ticket router.
 *
 * Ono što poster zove „client support / monitoring / logging", a smernice `src/support/ticket-router.js`.
 *
 * Radi tri stvari, mjerljivo:
 *   1. KLASIFIKUJE ticket u tip (billing, technical, refund, sales, other) — jeftinim heuristikama,
 *      bez LLM poziva (LLM tek ako je neophodno i ako je uključen).
 *   2. IZABERE agenta iz kataloga po tipu i vještinama, uz poštovanje politika/autonomije.
 *   3. STAVI task u queue (shared/queue.js) i ostavi feromon (`hot`/`claimed`) tako da drugi čvorovi
 *      vide gdje ima posla — koordinacija bez centralne komande.
 */
import { uid } from '../core/ids.js';
import { iso } from '../core/clock.js';
import { ValidationError } from '../core/errors.js';

// Napomena (EN tržište): engleski ključni pojmovi su DODATI postojećim srpskim obrascima, redoslijed
// pravila je nepromijenjen. Bez toga bi svaki engleski ticket (osim slučajnih poklapanja poput "order"
// ili "error") završio u `other`, pa zlatni set na engleskom ne bi mjerio stvarnu klasifikaciju.
export const TICKET_RULES = [
  { type: 'refund', agent: 'support', patterns: [/povra[ćc]aj|refund|vratite novac|storno|money back|chargeback/i], pheromone: 'hot', priority: 3 },
  { type: 'billing', agent: 'finance', patterns: [/faktur|ra[čc]un|uplata|pdv|invoice|naplat|billing|charged|charge|payment|receipt|subscription/i], pheromone: 'hot', priority: 2 },
  { type: 'technical', agent: 'dev', patterns: [/gre[šs]k|error|ne radi|puklo|bug|deploy|api|crash|not working|broken|stack trace|timeout|latency|downtime/i], pheromone: 'problem', priority: 2 },
  { type: 'ecommerce', agent: 'ecommerce', patterns: [/narud[žz]bin|dostav|isporuk|order|paket|status po[šs]iljke|shipping|delivery|parcel|tracking|package|return label|in stock|restock/i], pheromone: 'hot', priority: 2 },
  { type: 'sales', agent: 'sales', patterns: [/ponud|cjen|kupovin|lead|popust|offer|quote|quotation|pricing|price|purchase|demo|discount|interested in/i], pheromone: 'opportunity', priority: 1 },
  { type: 'other', agent: 'support', patterns: [], pheromone: 'help', priority: 1 },
];

export function createTicketRouter({ catalog, queue, pheromone, autonomy, governance, logger, metrics, audit, tenantId = 'nmq' } = {}) {
  function classify(text) {
    const input = String(text ?? '');
    for (const rule of TICKET_RULES) {
      if (rule.patterns.some((re) => re.test(input))) return rule;
    }
    return TICKET_RULES[TICKET_RULES.length - 1];
  }

  function route(ticket) {
    const rule = classify(ticket.text ?? ticket.subject ?? '');
    const agentId = ticket.agentId ?? rule.agent;
    const spec = catalog?.get?.(agentId, ticket.tenantId ?? tenantId) ?? null;
    // Ako agent iz pravila ne postoji u katalogu, padni na support (i to se vidi u rezultatu)
    const fallback = !spec ? { agentId: 'support', reason: `agent "${agentId}" nije u katalogu` } : null;
    return {
      ticketId: ticket.id ?? uid('tkt'),
      type: rule.type,
      agentId: fallback ? fallback.agentId : agentId,
      priority: Number(ticket.priority ?? rule.priority),
      pheromoneType: rule.pheromone,
      fallback,
      matchedRule: rule.type,
    };
  }

  return {
    TICKET_RULES,
    classify,
    route,

    /** Klasifikuj + nađi agenta + stavi u queue + ostavi trag. */
    async submit(ticket, { dryRun = false } = {}) {
      if (!ticket?.subject && !ticket?.text) throw new ValidationError('Ticket traži "subject" ili "text"');
      const decision = route(ticket);
      const result = { ...decision, queued: null, pheromone: null, at: iso() };

      if (governance?.assertCanRun) {
        // riskLevel: nizak (rutiranje je interna operacija), ali poštujemo izolaciju roja
        await governance.assertCanRun({ tenantId: ticket.tenantId ?? tenantId, workerId: 'ticket-router', riskLevel: 'low', autonomous: false });
      }
      if (dryRun) return result;

      if (queue) {
        result.queued = await queue.push({
          type: `support.${decision.type}`,
          tenantId: ticket.tenantId ?? tenantId,
          value: decision.priority,
          skills: [decision.type],
          ttl: ticket.ttl ?? 30_000,
          payload: {
            ticketId: decision.ticketId,
            subject: ticket.subject ?? null,
            text: ticket.text ?? null,
            agentId: decision.agentId,
            customerId: ticket.customerId ?? null,
            input: ticket.text ?? ticket.subject ?? '',
          },
        });
      }
      if (pheromone) {
        result.pheromone = await pheromone.deposit({
          tenantId: ticket.tenantId ?? tenantId,
          type: decision.pheromoneType,
          taskId: result.queued?.id ?? decision.ticketId,
          by: 'ticket-router',
          strength: 1 + decision.priority * 0.2,
          payload: { ticketType: decision.type, agentId: decision.agentId },
        });
      }
      metrics?.inc('support_tickets_routed_total', { type: decision.type, agent: decision.agentId });
      await audit?.append({
        tenantId: ticket.tenantId ?? tenantId,
        actor: 'ticket-router',
        action: 'ticket_routed',
        args: { ticketId: decision.ticketId, type: decision.type, agentId: decision.agentId },
        decision: 'allow',
        outcome: 'ok',
      });
      logger?.info?.('support.ticket_routed', { ticketId: decision.ticketId, type: decision.type, agentId: decision.agentId });
      return result;
    },
  };
}
