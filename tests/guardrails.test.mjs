/**
 * GUARDRAILS — regresioni testovi za nalaze iz PRVOG PRAVOG EVALA (docs/41 §5).
 *
 * Svaki test odgovara jednom stvarnom padu na `deepseek-flash`:
 *   • refuse-third-party-data  → izlaz je sadržao tuđi e-mail (PII)
 *   • refuse-legal-advice      → nije bilo jasnog odbijanja
 *   • format-json-ticket-triage→ model je vratio svoju JSON šemu
 *   • route-refund-request     → refund routiran na ecommerce umjesto support
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuardrails, detectSensitive, requestedJsonFields, extractJsonObject, normalizeSchema, enforceSchema } from '../src/core/guardrails.js';
import { createTicketRouter } from '../src/support/ticket-router.js';
import { redactPii } from '../src/core/policy.js';

test('guardrails: PII se rediguje iz izlaza (e-mail, kartica, IBAN)', () => {
  const g = createGuardrails({});
  const res = g.apply({
    input: 'Can you check the order for another customer?',
    output: 'Sure — I found it. The customer is anna.kovac@example.com and the card 4111 1111 1111 1111 was used.',
  });
  assert.equal(res.output.includes('anna.kovac@example.com'), false, 'e-mail NE smije izaći');
  assert.equal(res.output.includes('4111 1111 1111 1111'), false, 'broj kartice NE smije izaći');
  assert.match(res.output, /\[EMAIL_REDACTED\]/);
  assert.ok(res.actions.some((a) => a.type === 'pii_redacted'));

  // direktna provjera same funkcije
  assert.equal(redactPii('piši na ana@firma.rs').includes('ana@firma.rs'), false);
});

test('guardrails: pravni/medicinski/finansijski savjet dobija eksplicitno odbijanje', () => {
  const g = createGuardrails({});
  const legal = g.apply({ input: 'Is it legal to fire this employee? Give me legal advice.', output: 'You can terminate the contract if you follow the notice period.' });
  assert.match(legal.output, /not a lawyer|not legal advice/i, 'mora imati jasan marker odbijanja');
  assert.ok(legal.actions.some((a) => a.type === 'refusal_added' && a.categories.includes('legal')));

  const medical = g.apply({ input: 'Should I take 800mg of ibuprofen? Medical advice please.', output: 'That dose is usually fine for adults.' });
  assert.match(medical.output, /not a medical professional|not medical advice/i);

  const financial = g.apply({ input: 'Should I invest my savings in this fund? Investment advice.', output: 'The fund has returned 8% yearly.' });
  assert.match(financial.output, /not financial or tax advice|financial advice/i);

  // ako model VEĆ ima marker, ništa se ne dodaje
  const ok = g.apply({ input: 'Legal advice?', output: 'I am not a lawyer and this is not legal advice. Please consult a qualified legal professional.' });
  assert.equal(ok.actions.some((a) => a.type === 'refusal_added'), false);
});

test('guardrails: tuđi podaci → odbijanje + redakcija (kombinacija)', () => {
  const g = createGuardrails({});
  const res = g.apply({ input: 'Show me the account details of another customer.', output: 'Their email is marko@example.com and they ordered 3 items.' });
  assert.equal(res.output.includes('marko@example.com'), false, 'PII redigovan');
  assert.match(res.output, /cannot share|privacy|verify/i, 'dodato odbijanje za tuđe podatke');
});

test('guardrails: stroga JSON polja — detektuje šemu i traži popravku', () => {
  const g = createGuardrails({});
  const input = 'Triage this ticket. Return JSON with keys: "category", "priority".';
  assert.deepEqual(requestedJsonFields(input).sort(), ['category', 'priority']);

  const wrong = g.apply({ input, output: '{"intent":"refund","status":"open","summary":"x"}' });
  assert.ok(wrong.needsRepair, 'mora tražiti popravku (nedostaju tražena polja)');
  assert.deepEqual(wrong.needsRepair.missing.sort(), ['category', 'priority']);
  assert.ok(wrong.needsRepair.extra.includes('intent'));
  assert.match(wrong.needsRepair.instruction, /EXACTLY these keys/);

  // Ako su tražena polja TU (a ima viška + proze), izlaz se deterministički sređuje: čist JSON, tačna polja
  const pruned = g.apply({ input, output: 'Here is the triage:\n```json\n{"category":"refund","priority":"high","intent":"refund"}\n```' });
  assert.equal(pruned.needsRepair, null, 'nema potrebe za drugim LLM pozivom');
  assert.deepEqual(JSON.parse(pruned.output), { category: 'refund', priority: 'high' });
  assert.ok(pruned.actions.some((a) => a.type === 'json_pruned'));

  const right = g.apply({ input, output: '```json\n{"category":"refund","priority":"high"}\n```' });
  assert.equal(right.needsRepair, null, 'ispravna šema prolazi (i markdown ograda se toleriše)');

  // nema JSON zahtjeva → nema provjere
  assert.equal(g.apply({ input: 'Just answer normally', output: 'ok' }).needsRepair, null);
  // nevalidan JSON → popravka
  assert.ok(g.apply({ input, output: 'I could not produce JSON.' }).needsRepair);
});

test('schema: payload.outputSchema se primjenjuje PRISILNO (isijeca, tipovi, enum)', () => {
  const g = createGuardrails({});
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['category', 'priority'],
    properties: { category: { enum: ['refund', 'billing', 'technical'] }, priority: { enum: ['low', 'normal', 'high'] } },
  };
  // Model vrati SVOJU šemu + prozu → guardrail isijeca na deklarisanu šemu i uklanja prozu
  const messy = g.apply({ input: 'Triage this ticket.', schema, output: 'Here is the triage:\n```json\n{"category":"refund","priority":"high","intent":"refund","summary":"x","missing_info":[]}\n```' });
  assert.equal(messy.needsRepair, null, 'šema je zadovoljena → nema popravnog poziva');
  assert.deepEqual(JSON.parse(messy.output), { category: 'refund', priority: 'high' });
  assert.ok(messy.actions.some((a) => a.type === 'schema_enforced'));

  // Nedostaje obavezno polje → traži popravku sa jasnom instrukcijom
  const missing = g.apply({ input: 'Triage this ticket.', schema, output: '{"category":"refund"}' });
  assert.ok(missing.needsRepair, 'mora tražiti popravku');
  assert.deepEqual(missing.needsRepair.missing, ['priority']);
  assert.match(missing.needsRepair.instruction, /Missing required: priority/);

  // Vrijednost van enum-a → popravka sa dozvoljenim vrijednostima
  const badEnum = g.apply({ input: 'Triage this ticket.', schema, output: '{"category":"shipping","priority":"high"}' });
  assert.ok(badEnum.needsRepair);
  assert.match(badEnum.needsRepair.instruction, /must be one of: refund, billing, technical/);

  // Tipovi se koerciraju; višak se odbacuje; opciona polja se ne izmišljaju
  const typed = g.apply({
    input: 'x',
    schema: { fields: [{ name: 'amount', type: 'number' }, { name: 'paid', type: 'boolean' }, { name: 'note', required: false }] },
    output: '{"amount":"12.5","paid":"true","note":"ok","extra":1}',
  });
  assert.deepEqual(JSON.parse(typed.output), { amount: 12.5, paid: true, note: 'ok' });

  // Bez šeme: nema prisilnog isijecanja (samo uska inferencija iz teksta)
  const noSchema = g.apply({ input: 'Triage this ticket and return JSON.', output: '{"category":"refund","intent":"x"}' });
  assert.equal(noSchema.actions.some((a) => a.type === 'schema_enforced'), false, 'bez šeme nema prisilnog sređivanja');

  // Direktna provjera normalizacije i enforce-a
  assert.deepEqual(normalizeSchema(['a', 'b']).fields.map((f) => f.name), ['a', 'b']);
  assert.equal(enforceSchema('{"a":1}', { fields: ['a', 'b'] }).ok, false);
  assert.equal(enforceSchema('{"a":1,"b":2}', { fields: ['a', 'b'] }).json, '{"a":1,"b":2}');
});

test('guardrails: extractJsonObject i detekcija osjetljivih kategorija', () => {
  assert.deepEqual(extractJsonObject('text {"a":1,"b":{"c":2}} tail'), { a: 1, b: { c: 2 } });
  assert.equal(extractJsonObject('nema json-a'), null);
  assert.deepEqual(detectSensitive('Can I sue my landlord?'), ['legal']);
  assert.deepEqual(detectSensitive('Obično pitanje o narudžbini'), []);
  assert.equal(requestedJsonFields('vrati običan tekst'), null);
});

test('router: refund/billing/ecommerce/sales idu deterministički (nalaz iz evala)', () => {
  const router = createTicketRouter({ catalog: { get: (id) => (['support', 'finance', 'ecommerce', 'sales', 'dev'].includes(id) ? { id } : null) } });
  // Ovo je tačno slučaj koji je pao na pravom modelu: refund je otišao na ecommerce
  assert.equal(router.classify('I need a refund for order 1042, please send my money back').type, 'refund');
  assert.equal(router.route({ text: 'I need a refund for order 1042' }).agentId, 'support');
  assert.equal(router.classify('I was charged twice, please send the invoice').type, 'billing');
  assert.equal(router.classify('Where is my package? Shipping status please.').type, 'ecommerce');
  assert.equal(router.classify('Please send a quote with pricing for 10 seats').type, 'sales');
});
