import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashEmbedding, cosineSimilarity, chunkText, createEmbeddings } from '../src/memory/embeddings.js';
import { createVectorStore } from '../src/memory/vector.js';
import { createSessionStore } from '../src/memory/session.js';
import { createLongTermMemory } from '../src/memory/longterm.js';
import { buildTestRobot, cleanup, tempDataDir } from './helpers.mjs';

test('embeddings: hash embedding je determinističan i normalizovan', () => {
  const a = hashEmbedding('reset lozinke korisnički nalog');
  const b = hashEmbedding('reset lozinke korisnički nalog');
  assert.deepEqual(a, b);
  const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `norma treba biti 1, dobijeno ${norm}`);
  const c = hashEmbedding('potpuno druga tema o fakturama');
  assert.ok(cosineSimilarity(a, b) > cosineSimilarity(a, c));
});

test('chunking: poštuje veličinu i preklop', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Pasus ${i} ` + 'x'.repeat(120)).join('\n\n');
  const chunks = chunkText(text, { size: 600, overlap: 100, min: 50 });
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((c) => c.length <= 700));
});

test('vektorska memorija: izolacija po tenantu je tvrda', async () => {
  const embedder = createEmbeddings({ dim: 512 });
  const store = createVectorStore({ embeddings: embedder });
  await store.upsert('tenant-a', { text: 'Cjenovnik Pro paketa je 149 EUR mjesečno', metadata: { source: 'cjenovnik' } });
  await store.upsert('tenant-b', { text: 'Tajna druga firma ima popust 90%', metadata: { source: 'interno' } });

  const hitsA = await store.query('tenant-a', { text: 'koliko košta Pro paket', k: 5, minScore: 0 });
  assert.equal(hitsA.length, 1);
  assert.match(hitsA[0].text, /149 EUR/);
  assert.ok(hitsA.every((h) => h.metadata.tenantId === 'tenant-a'));

  const hitsB = await store.query('tenant-b', { text: 'koliko košta Pro paket', k: 5, minScore: 0 });
  assert.ok(hitsB.every((h) => h.metadata.tenantId === 'tenant-b'));
  assert.ok(!hitsB.some((h) => h.text.includes('149 EUR')), 'tenant B ne smije vidjeti podatke tenanta A');

  // dokument sa tuđim tenantId u metadata se normalizuje na tenant u koji se upisuje
  await store.upsert('tenant-a', { text: 'podmetnut dokument', metadata: { tenantId: 'tenant-b' } });
  const after = await store.query('tenant-a', { text: 'podmetnut dokument', k: 5, minScore: 0 });
  const found = after.find((h) => h.text === 'podmetnut dokument');
  assert.ok(found, 'dokument mora biti u tenantu u koji je upisan');
  assert.equal(found.metadata.tenantId, 'tenant-a', 'metadata.tenantId se ne smije podmetnuti');

  // čak i sa filterom na tuđi tenant, upit ne vraća ništa
  const crossTenant = await store.query('tenant-a', { text: 'podmetnut dokument', k: 5, minScore: 0, filter: { tenantId: 'tenant-b' } });
  assert.equal(crossTenant.length, 0, 'cross-tenant upit mora vratiti prazno');
});

test('vektorska memorija: contextFor daje citate', async () => {
  const store = createVectorStore({ embeddings: createEmbeddings({ dim: 96 }) });
  await store.ingest('nmq', { text: 'Politika povraćaja: kupac ima 14 dana od dostave uz račun.', source: 'Politika povraćaja', docId: 'kb-1' });
  const ctx = await store.contextFor('nmq', 'koliko dana imam za povraćaj', { k: 3 });
  assert.ok(ctx.text.includes('[1]'));
  assert.equal(ctx.hits.length, 1);
  assert.equal(ctx.hits[0].source, 'Politika povraćaja');
});

test('sesija: klizni prozor, sažetak i činjenice', async () => {
  const dir = await tempDataDir('sess');
  const sessions = createSessionStore({ dataDir: dir, maxMessages: 5, keepRecent: 2 });
  const s = sessions.getOrCreate('nmq', 's1', { agentId: 'support' });
  for (let i = 0; i < 9; i += 1) sessions.append(s, { role: 'user', content: `poruka ${i}` });
  assert.equal(s.messages.length, 5);
  assert.ok(s.summary.includes('poruka 0'));
  const msgs = sessions.toMessages(s, { system: 'SISTEM' });
  assert.equal(msgs[0].content, 'SISTEM');
  assert.ok(msgs.length <= 5);
  sessions.setFact(s, 'ime', 'Petar');
  assert.match(sessions.factsText(s), /ime: Petar/);
  await cleanup(dir);
});

test('sesija: PII se redaktuje prije upisa na disk', async () => {
  const dir = await tempDataDir('pii');
  const sessions = createSessionStore({ dataDir: dir });
  const s = sessions.getOrCreate('nmq', 's2');
  sessions.append(s, { role: 'user', content: 'Moj mejl je petar@example.com i kartica 4111111111111111' });
  await new Promise((r) => setTimeout(r, 60));
  const { readJsonl } = await import('../src/core/fsx.js');
  const rows = await readJsonl(`${dir}/tenants/nmq/sessions/s2.jsonl`);
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].content.includes('petar@example.com'));
  assert.ok(!rows[0].content.includes('4111111111111111'));
  await cleanup(dir);
});

test('dugoročna memorija: izolacija, pretraga i facts', async () => {
  const dir = await tempDataDir('lt');
  const lt = createLongTermMemory({ dataDir: dir });
  await lt.append('a', { type: 'user_message', content: 'Trazim povracaj za narudzbinu 1042', userId: 'u1' });
  await lt.append('b', { type: 'user_message', content: 'Interna biljeska druge firme', userId: 'u2' });

  const resA = await lt.search('a', { query: 'povracaj narudzbina' });
  assert.equal(resA.length, 1);
  assert.match(resA[0].content, /1042/);

  const resB = await lt.search('b', { query: 'povracaj narudzbina' });
  assert.equal(resB.length, 0, 'tenant B ne smije naći tuđe događaje');

  await lt.upsertFact('a', 'plan', 'Pro', { confidence: 0.8 });
  await lt.upsertFact('a', 'plan', 'Enterprise', { confidence: 0.9 });
  const facts = await lt.readFacts('a');
  assert.equal(facts.plan.value, 'Enterprise');
  assert.equal(facts.plan.revisions, 1);
  await cleanup(dir);
});

test('memorija u robotu: recall spaja KB, facts i događaje', async () => {
  const robot = await buildTestRobot({ script: () => ({ text: 'ok' }) });
  try {
    await robot.memory.vectors.ingest('nmq', { text: 'Radno vrijeme podrške je 09-17 radnim danima.', source: 'SOP podrška' });
    await robot.memory.longterm.upsertFact('nmq', 'klijent', 'Prima d.o.o.');
    const ctx = await robot.memory.recall('nmq', 'kada radi podrška');
    assert.ok(ctx.kb.includes('09-17'));
    assert.match(ctx.factsText, /Prima d\.o\.o\./);
    assert.ok(Array.isArray(ctx.citations));
  } finally {
    await cleanup(robot.__dir);
  }
});
