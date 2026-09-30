/**
 * A2A — pregovaranje (cena, uslovi, rok) i poravnanje (settlement).
 *
 * ⚠️ Iskreno o granicama:
 *   - Pregovaranje JE implementirano kao stroga mašina stanja sa granicama (max iznos, minimalna marža,
 *     dozvoljeni partneri, obavezan čovjek iznad praga). Agent ne može „pobjeći" iz svojih granica.
 *   - Poravnanje je INTERNI LEDGER (simulacija). Nema pravog novca, nema blockchain-a.
 *     Za pravo plaćanje se kači Stripe/SEPA ili x402 — vidi `method` i `settle()` hook.
 *   - Smart contract potpisivanje NIJE implementirano; ugovor se sklapa kao strukturisan zapis
 *     koji čovjek (ili pravni agent) pregleda prije potpisa.
 *
 * Stanje: data/tenants/<id>/a2a/negotiations.jsonl · settlements.jsonl
 */
import path from 'node:path';
import { appendJsonl, readJsonl, writeJson, readJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { ValidationError, NotFoundError, PolicyError } from '../core/errors.js';

export function createSettlement({ dataDir, logger, metrics, audit, defaultCurrency = 'EUR' } = {}) {
  const file = (tenantId, d = new Date()) => path.join(dataDir, 'tenants', tenantId, 'a2a', `settlements-${d.toISOString().slice(0, 7)}.jsonl`);

  return {
    file,
    /**
     * Kreće poravnanje. `method: 'internal'` = simulacija (ledger), 'stripe'/'x402' = planirano (zakači adapter).
     */
    async create({ tenantId, from, to, amountUsd, currency = defaultCurrency, reference, method = 'internal', terms = {}, metadata = {} }) {
      if (!(Number(amountUsd) > 0)) throw new ValidationError('Poravnanje traži pozitivan "amountUsd"');
      const entry = {
        id: uid('set'),
        ts: iso(),
        tenantId,
        from,
        to,
        amountUsd: Number(Number(amountUsd).toFixed(6)),
        currency,
        reference: reference ?? null,
        method,
        terms,
        metadata,
        status: method === 'internal' ? 'settled' : 'pending',
        settledAt: method === 'internal' ? iso() : null,
        note: method === 'internal' ? 'Interni ledger (simulacija) — nema stvarnog prenosa novca.' : `Metod "${method}" traži adapter (planirano).`,
      };
      await appendJsonl(file(tenantId), entry);
      metrics?.inc('settlements_total', { tenant: tenantId, method, status: entry.status });
      await audit?.append({ tenantId, actor: 'a2a', action: 'settlement_create', args: { id: entry.id, from, to, amountUsd: entry.amountUsd, method }, decision: 'allow', outcome: 'ok', meta: { status: entry.status } });
      logger?.info?.('settlement.created', { tenantId, id: entry.id, amountUsd: entry.amountUsd, method, status: entry.status });
      return entry;
    },

    /** Ručno okončanje (kad adapter javi da je plaćanje prošlo). */
    async settle(tenantId, id, { externalRef = null } = {}) {
      const rows = await readJsonl(file(tenantId));
      const entry = rows.filter((r) => r.id === id).at(-1);
      if (!entry) throw new NotFoundError('Poravnanje', id);
      if (entry.status === 'settled') return entry;
      const updated = { ...entry, status: 'settled', settledAt: iso(), externalRef, _op: 'update' };
      await appendJsonl(file(tenantId), updated);
      metrics?.inc('settlements_settled_total', { tenant: tenantId, method: entry.method });
      await audit?.append({ tenantId, actor: 'a2a', action: 'settlement_settled', args: { id, externalRef }, decision: 'allow', outcome: 'ok' });
      return updated;
    },

    async list(tenantId, { limit = 50 } = {}) {
      const rows = await readJsonl(file(tenantId), { limit, tail: true });
      const uniq = new Map(rows.map((r) => [r.id, r]));
      return [...uniq.values()].reverse();
    },

    async totals(tenantId) {
      const rows = await readJsonl(file(tenantId), { limit: 5000 });
      const uniq = new Map(rows.map((r) => [r.id, r]));
      const all = [...uniq.values()];
      const sum = (arr) => Number(arr.reduce((s, r) => s + r.amountUsd, 0).toFixed(6));
      return {
        count: all.length,
        settled: sum(all.filter((r) => r.status === 'settled')),
        pending: sum(all.filter((r) => r.status === 'pending')),
        byMethod: all.reduce((acc, r) => ({ ...acc, [r.method]: Number(((acc[r.method] ?? 0) + r.amountUsd).toFixed(6)) }), {}),
      };
    },
  };
}

export function createNegotiator({ dataDir, logger, metrics, audit, settlement, autonomy, improvements, defaultConstraints = {} }) {
  const file = (tenantId) => path.join(dataDir, 'tenants', tenantId, 'a2a', 'negotiations.jsonl');
  const active = new Map();

  const constraintsFor = (tenantId, overrides = {}) => ({
    maxAmountUsd: defaultConstraints.maxAmountUsd ?? 1000,
    minUnitPriceUsd: defaultConstraints.minUnitPriceUsd ?? 0,
    allowedCounterparties: defaultConstraints.allowedCounterparties ?? ['*'],
    requireHumanAboveUsd: defaultConstraints.requireHumanAboveUsd ?? 250,
    maxRounds: defaultConstraints.maxRounds ?? 5,
    ...overrides,
  });

  function assertCounterparty(cons, counterparty) {
    const allowed = cons.allowedCounterparties ?? ['*'];
    if (allowed.includes('*')) return true;
    if (!allowed.includes(counterparty)) throw new PolicyError(`Partner "${counterparty}" nije na listi dozvoljenih`, { counterparty, allowed });
    return true;
  }

  return {
    file,
    constraintsFor,

    /** Otvara pregovor (naša strana daje prvu ponudu ili prima tuđu). */
    async open({ tenantId, counterparty, topic, ourOffer, constraints = {}, direction = 'outbound' }) {
      const cons = constraintsFor(tenantId, constraints);
      assertCounterparty(cons, counterparty);
      if (ourOffer?.amountUsd !== undefined) {
        if (Number(ourOffer.amountUsd) > cons.maxAmountUsd) {
          throw new PolicyError(`Ponuda ${ourOffer.amountUsd} prelazi dozvoljeni maksimum ${cons.maxAmountUsd}`, { cons });
        }
      }
      const neg = {
        id: uid('neg'),
        tenantId,
        counterparty,
        topic,
        direction,
        constraints: cons,
        state: 'open',
        round: 0,
        offers: ourOffer ? [{ ts: iso(), by: 'us', ...ourOffer }] : [],
        current: ourOffer ?? null,
        createdAt: iso(),
        updatedAt: iso(),
        requiresHuman: Number(ourOffer?.amountUsd ?? 0) > cons.requireHumanAboveUsd,
        settlementId: null,
      };
      active.set(neg.id, neg);
      await appendJsonl(file(tenantId), { ...neg, _op: 'created' });
      metrics?.inc('negotiations_total', { tenant: tenantId, state: 'open' });
      await audit?.append({ tenantId, actor: 'a2a', action: 'negotiation_open', args: { id: neg.id, counterparty, topic, amountUsd: ourOffer?.amountUsd ?? null }, decision: neg.requiresHuman ? 'require_approval' : 'allow', outcome: 'ok', meta: { constraints: cons } });
      logger?.info?.('negotiation.opened', { tenantId, id: neg.id, counterparty, requiresHuman: neg.requiresHuman });
      return neg;
    },

    async get(tenantId, id) {
      const neg = active.get(id);
      if (neg && neg.tenantId === tenantId) return neg;
      const rows = await readJsonl(file(tenantId), { limit: 500, tail: true });
      const found = rows.filter((r) => r.id === id).at(-1);
      if (!found) throw new NotFoundError('Pregovor', id);
      return found;
    },

    async list(tenantId, { state, limit = 50 } = {}) {
      const rows = await readJsonl(file(tenantId), { limit: 500, tail: true });
      const uniq = new Map(rows.map((r) => [r.id, r]));
      const all = [...uniq.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return (state ? all.filter((n) => n.state === state) : all).slice(0, limit);
    },

    /**
     * Odgovor na pregovor: kontraponuda ili prihvatanje.
     * Sve granice se provjeravaju PRIJE upisa — agent ne može dogovoriti više nego što smije.
     */
    async respond(tenantId, id, { offer, accept = false, by = 'counterparty', note = null } = {}) {
      const neg = await this.get(tenantId, id);
      if (neg.state !== 'open') throw new ValidationError(`Pregovor je zatvoren (${neg.state})`);
      if (neg.round >= neg.constraints.maxRounds) throw new ValidationError('Dostignut maksimum rundi — pregovor ide na odluku čovjeka');

      const next = { ...neg, round: neg.round + 1, updatedAt: iso(), offers: [...neg.offers] };
      if (offer) {
        if (offer.amountUsd !== undefined && Number(offer.amountUsd) > neg.constraints.maxAmountUsd) {
          const proposal = improvements
            ? await improvements.createProposal(tenantId, {
                kind: 'action',
                target: 'sales',
                proposed: { input: `Ponuda ${offer.amountUsd} USD od ${neg.counterparty} prelazi limit ${neg.constraints.maxAmountUsd}. Odluči.` },
                current: null,
                rationale: 'A2A ponuda prelazi dozvoljeni budžet',
                evidence: [{ negotiationId: neg.id, offer }],
                expectedImpact: 'nastavak pregovora',
                riskLevel: 'high',
                source: 'a2a-negotiation',
              })
            : null;
          next.state = 'escalated';
          next.proposalId = proposal?.id ?? null;
        } else if (neg.constraints.minUnitPriceUsd && offer.unitPriceUsd !== undefined && Number(offer.unitPriceUsd) < neg.constraints.minUnitPriceUsd) {
          next.state = 'rejected';
          next.reason = `Jedinična cijena ${offer.unitPriceUsd} je ispod minimuma ${neg.constraints.minUnitPriceUsd}`;
        } else {
          next.current = offer;
        }
      }
      next.offers.push({ ts: iso(), by, offer: offer ?? null, accept, note });

      if (accept && next.state === 'open') {
        const amountUsd = Number(next.current?.amountUsd ?? 0);
        if (amountUsd > next.constraints.requireHumanAboveUsd) {
          // iznad praga: dogovor je postignut ali izvršenje čeka čovjeka
          next.state = 'awaiting_human';
          const proposal = improvements
            ? await improvements.createProposal(tenantId, {
                kind: 'action',
                target: 'finance',
                proposed: { input: `Odobri i pokreni poravnanje ${amountUsd} USD sa ${neg.counterparty} (pregovor ${neg.id}).` },
                current: null,
                rationale: `Dogovorena cijena ${amountUsd} USD prelazi prag za automatsko izvršenje (${next.constraints.requireHumanAboveUsd} USD)`,
                evidence: [{ negotiationId: neg.id, terms: next.current }],
                expectedImpact: 'zaključenje posla',
                riskLevel: 'high',
                source: 'a2a-negotiation',
              })
            : null;
          next.proposalId = proposal?.id ?? null;
        } else {
          next.state = 'agreed';
          next.agreedAt = iso();
        }
      } else if (next.round >= next.constraints.maxRounds && next.state === 'open') {
        next.state = 'expired';
      }

      active.set(next.id, next);
      await appendJsonl(file(tenantId), { ...next, _op: 'updated' });
      metrics?.inc('negotiations_total', { tenant: tenantId, state: next.state });
      await audit?.append({
        tenantId,
        actor: by,
        action: 'negotiation_response',
        args: { id: next.id, round: next.round, accept, amountUsd: offer?.amountUsd ?? null },
        decision: next.state === 'agreed' ? 'allow' : 'require_approval',
        outcome: next.state,
        meta: { state: next.state, proposalId: next.proposalId ?? null },
      });
      logger?.info?.('negotiation.response', { tenantId, id: next.id, state: next.state, round: next.round });
      return next;
    },

    /** Zaključivanje: pravi poravnanje (interni ledger) i vraća ugovor-zapis. */
    async close(tenantId, id, { by = 'human', currency = 'EUR' } = {}) {
      const neg = await this.get(tenantId, id);
      if (neg.state !== 'agreed') throw new ValidationError(`Samo dogovoren pregovor se zaključuje (state: ${neg.state})`);
      const amountUsd = Number(neg.current?.amountUsd ?? 0);
      const entry = await settlement.create({
        tenantId,
        from: 'nmq-robot',
        to: neg.counterparty,
        amountUsd,
        currency,
        reference: `neg:${neg.id}`,
        method: 'internal',
        terms: neg.current ?? {},
        metadata: { topic: neg.topic, rounds: neg.round },
      });
      const closed = { ...neg, state: 'closed', settlementId: entry.id, closedAt: iso(), contract: { topic: neg.topic, parties: ['nmq-robot', neg.counterparty], terms: neg.current, rounds: neg.round, signature: null, note: 'Radni zapis ugovora — potpis (digitalni/pravni) je sljedeći korak, van ovog modula.' } };
      active.set(closed.id, closed);
      await appendJsonl(file(tenantId), { ...closed, _op: 'closed' });
      await audit?.append({ tenantId, actor: by, action: 'negotiation_close', args: { id, settlementId: entry.id, amountUsd }, decision: 'allow', outcome: 'ok' });
      metrics?.inc('negotiations_closed_total', { tenant: tenantId });
      return { negotiation: closed, settlement: entry };
    },
  };
}
