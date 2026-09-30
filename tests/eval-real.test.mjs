/**
 * Zlatni set na engleskom (Sprint 1, `eval/golden/cases.json`) + runner `scripts/eval-real.mjs`.
 *
 * Testovi NIKAD ne pozivaju mrežu i ne troše novac — provjeravaju strukturu seta, mašinsku
 * provjerljivost `expect` pravila, samoprovjeru preko harness-a i dry-run procjenu.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createEvalHarness } from '../src/eval/harness.js';
import {
  loadCases,
  estimateSet,
  checkExpectations,
  checkJsonLite,
  extractJson,
  wordCount,
  sentenceCount,
  isPeakNow,
  officialPrice,
} from '../scripts/eval-real.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CATEGORY_EXPECTED = { routing: 6, grounding: 6, refusal: 4, format: 4, language: 4 };
const caseFile = await loadCases();

test('eval-real: zlatni set ima 24 slučaja, kategorije 6/6/4/4/4 i sva obavezna polja', () => {
  const { cases } = caseFile;
  assert.equal(cases.length, 24, `set mora imati 24 slučaja, ima ${cases.length}`);
  const byCat = {};
  for (const c of cases) byCat[c.category] = (byCat[c.category] ?? 0) + 1;
  assert.deepEqual(byCat, CATEGORY_EXPECTED);
  for (const c of cases) {
    assert.match(c.id, /^[a-z0-9-]+$/, `id "${c.id}" nije kebab-case`);
    assert.ok(c.input && c.input.length > 10, `${c.id}: input je previše kratak`);
    assert.ok(c.expect && typeof c.expect === 'object', `${c.id}: nema expect`);
    assert.ok(c.checks && typeof c.checks === 'object', `${c.id}: nema checks`);
    assert.ok(c.notes && c.notes.length > 20, `${c.id}: notes mora objasniti zašto je slučaj važan`);
    assert.ok(c.probeOutput, `${c.id}: nema probeOutput`);
    // nijedan slučaj ne smije biti "subjektivno dobro" — svaki ima bar jedno mašinsko pravilo
    const rules = [
      ...Object.keys(c.checks),
      ...Object.keys(c.expect).filter((k) => k !== 'expectedNumbers' && k !== 'refusalReason'),
    ];
    assert.ok(rules.length >= 2, `${c.id}: premalo mašinskih provjera`);
  }
  const ids = cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'id-evi moraju biti jedinstveni');
});

test('eval-real: svi slučajevi su na engleskom (ciljno tržište je strano)', () => {
  for (const c of caseFile.cases) {
    assert.doesNotMatch(c.input, /[čćžđš]/i, `${c.id}: input sadrži srpsko slovo`);
    assert.doesNotMatch(c.input, /\b(molim|povraćaj|narudžbina|faktura|lozinka|ponuda)\b/i, `${c.id}: input je na srpskom`);
  }
});

test('eval-real: "idealan" probeOutput prolazi i harness i expect provjere (set je samoprovjerljiv)', () => {
  const harness = createEvalHarness({ dataDir: ROOT, root: ROOT, orchestrator: null, tracer: null });
  const tools = ['order_lookup', 'memory_search'];
  for (const c of caseFile.cases) {
    const verdict = harness.checkCase(c, { output: c.probeOutput, status: 'ok', costUsd: 0 }, tools);
    const expectFailures = checkExpectations(c, { output: c.probeOutput, agentId: c.expect.agentId ?? 'support', ticketType: c.expect.ticketType ?? null }, tools);
    assert.deepEqual([...verdict.failures, ...expectFailures], [], `${c.id}: probeOutput ne prolazi svoje provjere`);
  }
});

test('eval-real: provjere stvarno padaju na pogrešnom odgovoru (nema lažno zelenih)', () => {
  const harness = createEvalHarness({ dataDir: ROOT, root: ROOT, orchestrator: null, tracer: null });
  const bad = 'Ne znam. Your refund has been approved and the money is already back. I give 500 mg per day. anna.kovac@example.com';
  const fails = [];
  for (const c of caseFile.cases) {
    const verdict = harness.checkCase(c, { output: bad, status: 'ok', costUsd: 0 }, []);
    const expectFailures = checkExpectations(c, { output: bad, agentId: 'support', ticketType: 'refund' }, []);
    if (verdict.failures.length + expectFailures.length > 0) fails.push(c.id);
  }
  // isti, očigledno pogrešan odgovor mora pasti veliku većinu slučajeva
  assert.ok(fails.length >= 18, `samo ${fails.length}/24 slučaja pada na pogrešnom odgovoru — provjere su preblage`);
});

test('eval-real: refusal provjere zahtijevaju jasno odbijanje, ne samo pristojnost', () => {
  const refusalCases = caseFile.cases.filter((c) => c.category === 'refusal');
  assert.equal(refusalCases.length, 4);
  for (const c of refusalCases) {
    const without = checkExpectations(c, { output: 'Sure, here is everything you asked for. Send me the details.' }, []);
    assert.ok(without.some((f) => /nije odbio/.test(f)), `${c.id}: mora pasti bez odbijanja`);
  }
  // odbijanje + alternativa = prolaz (bez obzira na to što je tema osjetljiva)
  const ok = checkExpectations(
    { expect: { mustRefuse: true } },
    { output: 'I cannot share another customer data. I must decline. I am not a lawyer.' },
    [],
  );
  assert.deepEqual(ok, []);
});

test('eval-real: JSON schema-lite i izvlačenje JSON-a iz teksta', () => {
  assert.equal(extractJson('{"a":1}').ok, true);
  assert.equal(extractJson('```json\n{"a":[1,2]}\n```').value.a.length, 2);
  assert.equal(extractJson('Obavještenje: {"a":"}"} i kraj').value.a, '}');
  assert.equal(extractJson('nema json-a').ok, false);
  assert.equal(extractJson('{"a":}').ok, false);

  const schema = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { enum: ['x'] } } };
  assert.deepEqual(checkJsonLite({ a: 'x' }, schema), []);
  assert.equal(checkJsonLite({ a: 'y' }, schema).length, 1);
  assert.equal(checkJsonLite({}, schema).length, 1);
  assert.equal(checkJsonLite({ a: 'x', b: 1 }, schema).length, 1);
  assert.equal(checkJsonLite('nije objekat', schema).length, 1);
});

test('eval-real: wordCount/sentenceCount i regex iz JSON-a (string i /obrazac/i)', () => {
  assert.equal(wordCount('one two  three\nfour'), 4);
  assert.equal(wordCount('   '), 0);
  assert.equal(sentenceCount('First one. Second one! Third?'), 3);
  const c = { id: 'x', expect: { maxWords: 2, mustMatch: ['Frida(y|ys)'], mustNotMatch: ['/\\d{3,}/'] } };
  assert.deepEqual(checkExpectations(c, { output: 'Friday' }, []), []);
  assert.ok(checkExpectations(c, { output: 'Friday 500' }, []).length >= 1);
  assert.ok(checkExpectations(c, { output: 'one two three' }, []).some((f) => /riječi/.test(f)));
});

test('eval-real: routing slučajevi odgovaraju STVARNOJ logici ticket-routera', async () => {
  const { TICKET_RULES } = await import('../src/support/ticket-router.js');
  const typeToAgent = Object.fromEntries(TICKET_RULES.map((r) => [r.type, r.agent]));
  const classify = (text) => {
    for (const rule of TICKET_RULES) if (rule.patterns.some((re) => re.test(text))) return rule.type;
    return 'other';
  };
  for (const c of caseFile.cases.filter((x) => x.category === 'routing')) {
    assert.equal(classify(c.input), c.expect.ticketType, `${c.id}: klasifikacija se razlikuje od ticket-router.js`);
    assert.equal(typeToAgent[c.expect.ticketType], c.expect.agentId, `${c.id}: agent se razlikuje od TICKET_RULES`);
  }
});

test('eval-real: procjena troška je deterministička, pozitivna i pokriva sve kategorije', () => {
  const est = estimateSet(caseFile.cases, 700);
  assert.equal(est.cases, 24);
  assert.ok(est.tokensIn > 0 && est.tokensOut > 0);
  assert.ok(est.usdOfficial > 0 && est.usdOfficial < 1, `procjena ${est.usdOfficial} USD nije razumna`);
  assert.equal(est.usdOfficial, estimateSet(caseFile.cases, 700).usdOfficial);
  assert.deepEqual(Object.keys(est.byCategory).sort(), ['format', 'grounding', 'language', 'refusal', 'routing']);
  // peak pravilo: 01-04 i 06-10 UTC radnim danom
  assert.equal(isPeakNow(new Date('2026-09-30T02:00:00Z')), true);
  assert.equal(isPeakNow(new Date('2026-09-30T07:30:00Z')), true);
  assert.equal(isPeakNow(new Date('2026-09-30T12:50:00Z')), false);
  assert.equal(isPeakNow(new Date('2026-09-27T02:00:00Z')), false, 'nedjelja nije peak');
  assert.equal(officialPrice('deepseek-chat').inPeak, 0.3);
  assert.equal(officialPrice('nepoznat-model').inPeak, 0.3, 'nepoznat model pada na najjeftiniju tarifu');
});
