#!/usr/bin/env node
/**
 * eval-real.mjs — runner za PRAVI model nad zlatnim setom `eval/golden/cases.json` (24 slučaja, engleski).
 *
 *   node scripts/eval-real.mjs                 # DRY-RUN (default): nula mreže, nula troška
 *   node scripts/eval-real.mjs --dry-run       # isto, eksplicitno
 *   node scripts/eval-real.mjs --live          # PRAVI pozivi — traži DEEPSEEK_API_KEY i odobrenje korisnika
 *
 * Zašto postoji pored `scripts/eval.mjs`:
 *   - `eval.mjs` je stari CLI nad harness setom tenanta (6 slučajeva, srpski, mock LLM);
 *   - ovaj runner koristi 24 engleska slučaja, ISPISUJE PROCJENU TROŠKA prije ijednog poziva,
 *     traži izričit `--live`, i upisuje istoriju u `data/_control/eval-history.json`.
 *
 * Pravila:
 *   - `--dry-run` nikad ne otvara mrežu (nema fetch, nema MCP, nema LLM provajdera) i ne piše istoriju;
 *   - prolaznost se računa ISTOM logikom kao `src/eval/harness.js` (`robot.eval.checkCase`), ne duplira se;
 *   - nula npm zavisnosti: samo `node:fs`, `node:path` i ugrađeni `fetch` (za `--live` ga koristi provajder).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvalHarness } from '../src/eval/harness.js';
import { priceFor, priceSource, computeCost } from '../src/observability/cost.js';
import { loadEnvFile } from './env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile({ root: ROOT });

// ─────────────────────────────── CLI ───────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const LIVE = has('live') && !has('dry-run');
const CASES_FILE = path.resolve(ROOT, flag('file', 'eval/golden/cases.json'));
const HISTORY_FILE = path.resolve(ROOT, flag('history', 'data/_control/eval-history.json'));
const TENANT = flag('tenant', 'golden');
const MODEL = flag('model', process.env.NMQ_LLM_MODEL || 'deepseek-chat');
const LIMIT = Number(flag('limit', '0')) || null;
const CATEGORY_FILTER = flag('category', null);
const CASE_FILTER = flag('cases', null) ? String(flag('cases')).split(',').map((s) => s.trim()).filter(Boolean) : null;
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.NMQ_LLM_API_KEY || '';

// ─────────────────── cijene: zvanični izvor (provjereno 30.09.2026) ───────────────────
/**
 * Zvanični cjenovnik DeepSeeka, očitan sa https://api-docs.deepseek.com/quick_start/pricing
 * (datum provjere: 30.09.2026). Jedinica: USD za 1M tokena.
 * ⚠️ Peak sati: 01:00–04:00 i 06:00–10:00 UTC, pon–pet (bez kineskih praznika); sve ostalo je off-peak.
 * Za procjenu koristimo PEAK cijenu (konzervativnije: procjena je gornja granica).
 */
const OFFICIAL_PRICING = Object.freeze({
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
  checkedAt: '2026-09-30',
  'deepseek-flash': { inPeak: 0.3, outPeak: 1.2, inOffPeak: 0.15, outOffPeak: 0.6 },
  'deepseek-v4-pro': { inPeak: 1.32, outPeak: 3.96, inOffPeak: 0.66, outOffPeak: 1.98 },
  // starija imena se i dalje prihvataju i naplaćuju po cijeni Flash modela
  'deepseek-chat': { inPeak: 0.3, outPeak: 1.2, inOffPeak: 0.15, outOffPeak: 0.6 },
  'deepseek-reasoner': { inPeak: 1.32, outPeak: 3.96, inOffPeak: 0.66, outOffPeak: 1.98 },
});
const officialPrice = (model) =>
  OFFICIAL_PRICING[model] ??
  OFFICIAL_PRICING[Object.keys(OFFICIAL_PRICING).find((k) => typeof OFFICIAL_PRICING[k] === 'object' && model.startsWith(k))] ??
  OFFICIAL_PRICING['deepseek-chat'];

/** Peak li je sada (po UTC satu i danu) — određuje koja se zvanična cijena citira. */
function isPeakNow(d = new Date()) {
  const day = d.getUTCDay(); // 0 = nedjelja
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

// ─────────────────── procjena tokena (konzervativno) ───────────────────
/**
 * Procjena je GORNJA GRANICA, ne mjerenje:
 *   - 1 token ≈ 3.2 znaka (za engleski je realno ~4; 3.2 namjerno precijenjuje);
 *   - POZIVI_PO_SLUCAJU=1.6 pokriva više LLM poziva u jednom run-u (ruter/provjera + agent + eventualni kritičar);
 *   - izlaz = min(procijenjeni budžet iz `expect.maxWords`/`json`, 800) + 120 tokena rezerve.
 */
const TOKENS = Object.freeze({
  charsPerToken: 3.2,
  callsPerCase: 1.6,
  outputFloorTokens: 320,
  outputCeilingTokens: 800,
  outputReserveTokens: 120,
  systemPromptFallbackChars: 700,
});

/** Sistemski prompt se čita iz STVARNOG config/agents/*.json (bez mreže, samo fajl). */
async function loadSystemPromptChars() {
  const dir = path.join(ROOT, 'config', 'agents');
  const files = await fs.readdir(dir).catch(() => []);
  const sizes = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(dir, f), 'utf8').catch(() => '');
    if (!raw) continue;
    try {
      const spec = JSON.parse(raw);
      if (spec.systemPrompt) sizes.push({ id: spec.id ?? f, chars: spec.systemPrompt.length + (spec.description?.length ?? 0) });
    } catch {
      /* neispravan JSON nije razlog da runner padne */
    }
  }
  return sizes;
}

function estimateCase(testCase, systemChars) {
  const inputChars = String(testCase.input ?? '').length;
  const maxWords = testCase.expect?.maxWords ?? testCase.checks?.maxWords ?? 0;
  const jsonCase = Boolean(testCase.expect?.json);
  const outByWords = maxWords ? Math.round(maxWords * 1.4) : 0;
  const budget = jsonCase ? 200 : outByWords || TOKENS.outputFloorTokens;
  const outTokens = Math.min(budget, TOKENS.outputCeilingTokens) + TOKENS.outputReserveTokens;
  const inTokens = Math.ceil((systemChars + inputChars) / TOKENS.charsPerToken);
  return {
    id: testCase.id,
    category: testCase.category ?? 'uncategorized',
    inTokens: Math.ceil(inTokens * TOKENS.callsPerCase),
    outTokens: Math.ceil(outTokens * TOKENS.callsPerCase),
  };
}

function estimateSet(cases, systemChars) {
  const perCase = cases.map((c) => estimateCase(c, systemChars));
  const tokensIn = perCase.reduce((a, c) => a + c.inTokens, 0);
  const tokensOut = perCase.reduce((a, c) => a + c.outTokens, 0);
  const peak = isPeakNow();
  const official = officialPrice(MODEL);
  const usdOfficial = (tokensIn / 1e6) * (peak ? official.inPeak : official.inOffPeak) + (tokensOut / 1e6) * (peak ? official.outPeak : official.outOffPeak);
  const repoPrice = priceFor(MODEL);
  const usdRepo = (tokensIn / 1e6) * repoPrice.in + (tokensOut / 1e6) * repoPrice.out;
  return {
    cases: cases.length,
    tokensIn,
    tokensOut,
    tokensTotal: tokensIn + tokensOut,
    peak,
    officialPrice: official,
    usdOfficial: Number(usdOfficial.toFixed(6)),
    repoPrice,
    repoPriceSource: priceSource(MODEL),
    usdRepo: Number(usdRepo.toFixed(6)),
    perCase,
    byCategory: groupSum(perCase, 'category'),
  };
}

function groupSum(rows, key) {
  const out = {};
  for (const r of rows) {
    out[r[key]] ??= { cases: 0, inTokens: 0, outTokens: 0 };
    out[r[key]].cases += 1;
    out[r[key]].inTokens += r.inTokens;
    out[r[key]].outTokens += r.outTokens;
  }
  return out;
}

// ─────────────────── mašinski provjerljiva `expect` pravila ───────────────────
// Ovo su provjere koje `src/eval/harness.js` NE poznaje (on ih ignoriše), a zlatni set ih koristi.
const REFUSAL_RE = /\b(i\s*(can\s*not|can'?t|cannot|won'?t|will not|am not able|'m not able)|not able to|unable to|i must decline|i have to decline|i cannot (share|give|provide|advise)|ne mogu|nije dozvoljeno)\b/i;
const ENGLISH_STOPWORDS = [' the ', ' and ', ' to ', ' of ', ' is ', ' for ', ' you ', ' your ', ' we ', ' will ', ' with '];
const SERBIAN_STOPWORDS = [' i ', ' je ', ' da ', ' se ', ' na ', ' za ', ' ne ', ' kao ', ' koji ', ' koja '];

export function wordCount(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}
export function sentenceCount(text) {
  return String(text ?? '').split(/[.!?]+(?:\s|$)/).map((s) => s.trim()).filter(Boolean).length;
}

/** Regex iz JSON-a: toleriše i string i "/.../i" oblik. */
function toRegExp(pattern, { global = false } = {}) {
  if (pattern instanceof RegExp) return pattern;
  const s = String(pattern);
  const m = /^\/(.*)\/([a-z]*)$/.exec(s);
  const body = m ? m[1] : s;
  const flags = (m ? m[2] : '') + (global && !(m?.[2] ?? '').includes('g') ? 'g' : '');
  return new RegExp(body, flags);
}

/** schema-lite: type/properties/required/additionalProperties/items/enum/minItems/maxItems/minLength/maxLength. */
export function checkJsonLite(value, schema, pathLabel = '$') {
  const failures = [];
  if (!schema || typeof schema !== 'object') return failures;
  if (schema.enum && !schema.enum.includes(value)) failures.push(`${pathLabel}: vrijednost nije u enum [${schema.enum.join(', ')}]`);
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${pathLabel}: mora biti objekat`];
    for (const req of schema.required ?? []) if (!(req in value)) failures.push(`${pathLabel}: nema obavezno polje "${req}"`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(schema.properties ?? {})[key]) failures.push(`${pathLabel}: neočekivano polje "${key}"`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in value) failures.push(...checkJsonLite(value[key], sub, `${pathLabel}.${key}`));
    return failures;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${pathLabel}: mora biti niz`];
    if (schema.minItems !== undefined && value.length < schema.minItems) failures.push(`${pathLabel}: manje od ${schema.minItems} elemenata`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) failures.push(`${pathLabel}: više od ${schema.maxItems} elemenata`);
    if (schema.items) value.forEach((v, i) => failures.push(...checkJsonLite(v, schema.items, `${pathLabel}[${i}]`)));
    return failures;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return [`${pathLabel}: mora biti string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) failures.push(`${pathLabel}: kraći od ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) failures.push(`${pathLabel}: duži od ${schema.maxLength}`);
    return failures;
  }
  if (schema.type === 'number' && typeof value !== 'number') failures.push(`${pathLabel}: mora biti broj`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') failures.push(`${pathLabel}: mora biti boolean`);
  return failures;
}

/** Prvi JSON objekat/niz u tekstu (model često umota JSON u rečenicu ili ``` blok). */
export function extractJson(text) {
  const s = String(text ?? '');
  const start = s.search(/[[{]/);
  if (start < 0) return { ok: false, reason: 'nema JSON-a u izlazu' };
  const opener = s[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) {
        try {
          return { ok: true, value: JSON.parse(s.slice(start, i + 1)) };
        } catch (err) {
          return { ok: false, reason: `JSON se ne parsira: ${err.message}` };
        }
      }
    }
  }
  return { ok: false, reason: 'neuzatvoren JSON' };
}

/**
 * Provjere iz `expect` (ono što harness ne pokriva). Vraća listu razloga za pad.
 * @param {object} testCase zlatni slučaj
 * @param {object} result   { output, status, agentId, ticketType, costUsd }
 */
export function checkExpectations(testCase, result, toolsOverride = null) {
  const exp = testCase.expect ?? {};
  const out = String(result?.output ?? '');
  const lower = out.toLowerCase();
  const failures = [];

  if (exp.agentId && result?.agentId && result.agentId !== exp.agentId) failures.push(`agent ${result.agentId} ≠ ${exp.agentId}`);
  if (exp.ticketType && result?.ticketType && result.ticketType !== exp.ticketType) failures.push(`tip ticketa ${result.ticketType} ≠ ${exp.ticketType}`);
  if (exp.output === 'json') {
    // provjerava se i kroz `json` schemu ispod
  }
  if (exp.mustRefuse && !REFUSAL_RE.test(out)) failures.push('nije odbio zahtjev (nema jasnog "I can\'t / I will not")');
  for (const p of exp.mustMatch ?? []) if (!toRegExp(p).test(out)) failures.push(`nema obrazac /${toRegExp(p).source}/`);
  for (const p of exp.mustNotMatch ?? []) if (toRegExp(p).test(out)) failures.push(`sadrži zabranjen obrazac /${toRegExp(p).source}/`);
  if (exp.maxWords !== undefined && wordCount(out) > exp.maxWords) failures.push(`${wordCount(out)} riječi > ${exp.maxWords}`);
  if (exp.maxSentences !== undefined && sentenceCount(out) > exp.maxSentences) failures.push(`${sentenceCount(out)} rečenica > ${exp.maxSentences}`);
  if (exp.language === 'en') {
    const srStop = SERBIAN_STOPWORDS.filter((w) => lower.includes(w)).length;
    const enStop = ENGLISH_STOPWORDS.filter((w) => lower.includes(w)).length;
    if (srStop > 1 && enStop === 0) failures.push('izlaz nije na engleskom');
  }
  if (exp.json) {
    const parsed = extractJson(out);
    if (!parsed.ok) failures.push(`JSON: ${parsed.reason}`);
    else failures.push(...checkJsonLite(parsed.value, exp.json));
  }
  if (exp.expectedNumbers?.length) {
    const found = new Set((out.match(/\d+/g) ?? []).map(Number));
    for (const n of exp.expectedNumbers) if (!found.has(n)) failures.push(`nema traženi broj ${n} iz datih činjenica`);
  }
  const tools = toolsOverride ?? [];
  if (exp.requiresOrderLookup && !tools.includes('order_lookup')) failures.push('nije provjerio narudžbinu (order_lookup)');
  return failures;
}

// ─────────────────────────────── ispis ───────────────────────────────
const bar = (n = 64) => '─'.repeat(n);
function printHeader(title) {
  console.log('');
  console.log(`  ${title}`);
  console.log(`  ${bar(title.length)}`);
}

async function loadCases() {
  const raw = await fs.readFile(CASES_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  const cases = Array.isArray(parsed) ? parsed : parsed.cases;
  if (!Array.isArray(cases) || !cases.length) throw new Error(`${CASES_FILE} nema "cases"`);
  return { meta: Array.isArray(parsed) ? {} : parsed, cases };
}

/**
 * Samoprovjera seta BEZ mreže: svaki slučaj se propusti kroz `harness.checkCase` sa svojim `probeOutput`.
 * Ako "idealan" odgovor padne vlastite provjere — set je pogrešan, a ne model.
 */
function selfCheck(cases) {
  const harness = createEvalHarness({ dataDir: ROOT, root: ROOT, orchestrator: null, tracer: null });
  const rows = [];
  for (const c of cases) {
    if (typeof c.probeOutput !== 'string') {
      rows.push({ id: c.id, passed: false, failures: ['nema probeOutput (set se ne može samoprovjeriti)'] });
      continue;
    }
    const tools = ['order_lookup', 'memory_search']; // probeOutput je zamišljen kao ispravan odgovor agenta sa pristupom alatima
    const harnessVerdict = harness.checkCase(c, { output: c.probeOutput, status: 'ok', costUsd: 0, result: { steps: tools.map((name) => ({ type: 'tool', ok: true, name })) } }, tools);
    const expectFailures = checkExpectations(c, { output: c.probeOutput, agentId: c.expect?.agentId ?? 'support', ticketType: c.expect?.ticketType ?? null }, tools);
    const failures = [...harnessVerdict.failures, ...expectFailures].filter((f) => !/maxCostUsd/.test(f));
    rows.push({ id: c.id, category: c.category, passed: failures.length === 0, failures });
  }
  return rows;
}

function printCategoryTable(cases, perCase) {
  const byCat = {};
  for (const c of cases) {
    byCat[c.category ?? 'uncategorized'] ??= { n: 0, inTokens: 0, outTokens: 0 };
    byCat[c.category ?? 'uncategorized'].n += 1;
  }
  for (const r of perCase) {
    byCat[r.category].inTokens += r.inTokens;
    byCat[r.category].outTokens += r.outTokens;
  }
  console.log('  kategorija     slučajeva   ulaz(tok)   izlaz(tok)');
  for (const [cat, v] of Object.entries(byCat)) {
    console.log(`  ${cat.padEnd(14)} ${String(v.n).padStart(6)} ${String(v.inTokens).padStart(11)} ${String(v.outTokens).padStart(12)}`);
  }
}

// ─────────────────────────────── DRY RUN ───────────────────────────────
async function dryRun(cases, system, meta) {
  printHeader(`EVAL (PRAVI MODEL) — DRY-RUN · set "${meta.name ?? 'golden'}" · model ${MODEL}`);
  console.log('  ⚠️  DRY-RUN: nijedan mrežni poziv se ne izvršava. Nema LLM API-ja, nema MCP-a, nema troška.');
  console.log(`  set:     ${path.relative(ROOT, CASES_FILE)}`);
  console.log(`  slučajeva: ${cases.length}  ·  jezik: ${meta.language ?? 'en'}  ·  prag: ${meta.threshold ?? 0.8}`);
  const cats = {};
  for (const c of cases) cats[c.category ?? '?'] = (cats[c.category ?? '?'] ?? 0) + 1;
  console.log(`  kategorije: ${Object.entries(cats).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log('');

  // 1) samoprovjera seta
  const rows = selfCheck(cases);
  const setOk = rows.filter((r) => r.passed).length;
  console.log(`  1) samoprovjera seta (probeOutput kroz harness.checkCase): ${setOk}/${rows.length} ${setOk === rows.length ? '✔' : '✖'}`);
  for (const r of rows.filter((x) => !x.passed)) console.log(`     ✖ ${r.id}: ${r.failures.join('; ')}`);

  // 2) procjena tokena i troška
  const est = estimateSet(cases, system.chars);
  console.log('');
  console.log('  2) procjena obima (GORNJA GRANICA, nije mjerenje):');
  console.log(`     sistemski prompt: pod ${system.maxChars} znakova (${system.maxDesc}) · pretpostavka ${TOKENS.charsPerToken} znaka/token`);
  console.log(`     ulaz:  ${est.tokensIn.toLocaleString('en-US')} tokena`);
  console.log(`     izlaz: ${est.tokensOut.toLocaleString('en-US')} tokena`);
  console.log(`     ukupno: ${est.tokensTotal.toLocaleString('en-US')} tokena  (${TOKENS.callsPerCase} LLM poziva po slučaju)`);
  console.log(`     udio ulaza: ${((est.tokensIn / est.tokensTotal) * 100).toFixed(1)} % (sistemski prompt se šalje u svakom pozivu)`);

  // 3) trošak
  const off = est.officialPrice;
  console.log('');
  console.log('  3) procjena troška (USD):');
  console.log(`     cjenovnik: ${OFFICIAL_PRICING.source}`);
  console.log(`     provjereno: ${OFFICIAL_PRICING.checkedAt} · sada je ${est.peak ? 'PEAK' : 'OFF-PEAK'} (UTC ${new Date().toISOString().slice(11, 16)})`);
  console.log(`     zvanično (${MODEL}): ${est.peak ? off.inPeak : off.inOffPeak} USD/1M ulaz · ${est.peak ? off.outPeak : off.outOffPeak} USD/1M izlaz`);
  console.log(`     ➜ PROCJENA (zvanični cjenovnik, peak-safe): ~$${est.usdOfficial.toFixed(4)} za ${est.cases} slučaja`);
  console.log(`       (${est.peak ? `off-peak bi bilo ~$${(est.usdOfficial / 2).toFixed(4)}` : `da run padne u peak: ~$${(est.usdOfficial * 2).toFixed(4)}`})`);
  console.log(`     interni cjenovnik repo-a (src/observability/cost.js, izvor=${est.repoPriceSource}): ${est.repoPrice.in}/${est.repoPrice.out} USD/1M → ~$${est.usdRepo.toFixed(4)}`);
  if (est.usdRepo < est.usdOfficial * 0.8) {
    console.log('     ⚠️  interni cjenovnik je NIŽI od zvaničnog — tarifa `deepseek-chat` u repou je zastarjela;');
    console.log('         live mjerenje zato upisuje trošak po ZVANIČNOM cjenovniku (polje costUsd), a interni u costUsdRepo.');
  }
  console.log(`     rezerva: ×2 sigurnosna margina → ~$${(est.usdOfficial * 2).toFixed(4)} prije nego što tražimo odobrenje`);
  console.log('');
  printCategoryTable(cases, est.perCase);

  // 4) istorija
  const history = await readHistory();
  console.log('');
  console.log(`  4) istorija: ${path.relative(ROOT, HISTORY_FILE)} · unosa: ${history.length}`);
  const last = history[history.length - 1];
  if (last) console.log(`     posljednji: ${last.ts} · ${last.model} · ${last.passed}/${last.cases} = ${(Number(last.score) * 100).toFixed(1)} % · $${Number(last.costUsd ?? 0).toFixed(4)}`);
  else console.log('     (prazna — dry-run NE upisuje; upisuje samo --live)');

  printHeader('ZAKLJUČAK DRY-RUN');
  console.log(`  ${setOk === rows.length ? '✔' : '✖'} set je ${setOk === rows.length ? 'validan' : 'NEVALIDAN'} (${setOk}/${rows.length} probe prolazi svoje provjere)`);
  console.log(`  procijenjeni trošak za pun set: ~$${est.usdOfficial.toFixed(4)} (zvanični cjenovnik, ${est.peak ? 'peak' : 'off-peak'})`);
  console.log('  za pravo mjerenje: `node scripts/eval-real.mjs --live` — traži DEEPSEEK_API_KEY i ODOBRENJE KORISNIKA.');
  console.log('  trenutno stanje: pravi rezultat još ne postoji; eval se izvršava na MOCK modelu (scripts/eval.mjs).');
  console.log('');
  return setOk === rows.length ? 0 : 1;
}

async function readHistory() {
  const raw = await fs.readFile(HISTORY_FILE, 'utf8').catch(() => '');
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function appendHistory(record) {
  const history = await readHistory();
  history.push(record);
  await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  await fs.writeFile(HISTORY_FILE, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  return history.length;
}

// ─────────────────────────────── LIVE ───────────────────────────────
async function liveRun(cases, meta) {
  if (!API_KEY) {
    console.error('');
    console.error('  ✖ --live traži DEEPSEEK_API_KEY (ili NMQ_LLM_API_KEY) u okruženju ili .env fajlu.');
    console.error('    Bez ključa se NE poziva nijedan model i ništa se ne troši.');
    console.error('    Ključ se ne ispisuje. Postavi ga i traži odobrenje korisnika za trošak.');
    console.error('');
    return 2;
  }

  printHeader(`EVAL (PRAVI MODEL) — LIVE · set "${meta.name ?? 'golden'}" · model ${MODEL}`);
  console.log(`  ključ: postavljen (${process.env.DEEPSEEK_API_KEY ? 'DEEPSEEK_API_KEY' : 'NMQ_LLM_API_KEY'})`);
  console.log('  ovo TROŠI novac — pokreće se samo na izričit zahtjev korisnika.');
  console.log('');

  const { createRobot } = await import('../src/index.js');
  const robot = await createRobot({
    root: ROOT,
    dataDir: flag('data', process.env.NMQ_DATA_DIR || './data/_eval-real'),
    connectMcp: false,
    env: {
      ...process.env,
      NMQ_LLM_API_KEY: API_KEY,
      NMQ_LLM_MODEL: MODEL,
      // fail-closed: ako pravi provider padne, NE pada tiho na mock (inače bi rezultat bio lažno zelen)
      NMQ_ALLOW_MOCK_FALLBACK: process.env.NMQ_ALLOW_MOCK_FALLBACK ?? '0',
      NMQ_LOG_LEVEL: process.env.NMQ_LOG_LEVEL ?? 'warn',
    },
    overrides: {
      logLevel: 'warn',
      scheduler: false,
    },
  });

  try {
    const report = await runGoldenSet(robot, cases, meta);
    printLiveReport(report, cases);

    const record = {
      ts: new Date().toISOString(),
      model: MODEL,
      cases: report.total,
      passed: report.passed,
      score: report.passRate,
      durationMs: report.durationMs,
      costUsd: report.costUsdOfficial,
      costUsdRepo: report.costUsd,
      pricingSource: OFFICIAL_PRICING.source,
      pricingCheckedAt: OFFICIAL_PRICING.checkedAt,
      tenant: TENANT,
      set: path.relative(ROOT, CASES_FILE),
      byCategory: report.byCategory,
      failures: report.failures.map((f) => ({ id: f.caseId, category: f.category, reasons: f.failures })),
    };
    const n = await appendHistory(record);
    console.log(`  istorija: upisano u ${path.relative(ROOT, HISTORY_FILE)} (unosa: ${n})`);
    console.log('');
    return report.passRate >= (meta.threshold ?? 0.8) ? 0 : 1;
  } finally {
    await robot.close();
  }
}

/**
 * Pokreće set slučaj-po-slučaj kroz orchestrator i ocjenjuje ISTIM harness pravilima
 * (`checkCase`) + `expect` pravilima. Ne duplira logiku ocjenjivanja.
 */
async function runGoldenSet(robot, cases, meta) {
  const harness = createEvalHarness({
    dataDir: robot.config.dataDir,
    root: ROOT,
    logger: robot.logger,
    metrics: robot.metrics,
    audit: robot.audit,
    orchestrator: robot.orchestrator,
    tracer: robot.tracer,
  });

  const results = [];
  const startedAll = Date.now();
  for (const testCase of cases) {
    const started = Date.now();
    let result = null;
    let err = null;
    try {
      result = await robot.orchestrator.run({
        tenantId: TENANT,
        agentId: testCase.agentId ?? null,
        pattern: testCase.pattern,
        input: testCase.input,
        sessionId: `eval-real:${testCase.id}`,
        userId: 'eval-real',
        options: {
          ...(testCase.options ?? {}),
          maxRunUsd: testCase.checks?.maxCostUsd ?? 0.05,
          // Ako slučaj traži JSON šemu, pozivalac je ZADaje (kao što bi to radio integracijom preko API-ja).
          // Sistem je prisilno primjenjuje u guardrails sloju — bez sečenja iz proze.
          outputSchema: testCase.expect?.json ?? testCase.outputSchema ?? null,
        },
      });
    } catch (e) {
      err = e;
    }
    const durationMs = Date.now() - started;
    const tools = result ? harness.toolsUsed(result) : [];
    const verdict = err
      ? { passed: false, failures: [err.message], tools: [] }
      : harness.checkCase(testCase, result, tools);
    const expectFailures = err ? [] : checkExpectations(testCase, { output: result.output, agentId: result.agentId, ticketType: result.ticketType ?? null }, tools);
    const failures = [...verdict.failures, ...expectFailures];
    const run = result?.runId ? robot.tracer?.get?.(result.runId) : null;
    const tokensIn = run?.usage?.tokensIn ?? 0;
    const tokensOut = run?.usage?.tokensOut ?? 0;
    const priced = computeCost(MODEL, { promptTokens: tokensIn, completionTokens: tokensOut });
    const official = officialPrice(MODEL);
    const peak = isPeakNow();
    const costUsdOfficial = (tokensIn / 1e6) * (peak ? official.inPeak : official.inOffPeak) + (tokensOut / 1e6) * (peak ? official.outPeak : official.outOffPeak);

    results.push({
      caseId: testCase.id,
      category: testCase.category ?? 'uncategorized',
      passed: failures.length === 0,
      failures,
      status: result?.status ?? 'error',
      agentId: result?.agentId ?? null,
      durationMs,
      tokensIn,
      tokensOut,
      costUsd: result?.costUsd ?? 0,
      costUsdRepo: priced.usd,
      costUsdOfficial: Number(costUsdOfficial.toFixed(8)),
      tools,
      output: String(result?.output ?? '').slice(0, 400),
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const byCategory = {};
  for (const r of results) {
    byCategory[r.category] ??= { passed: 0, total: 0 };
    byCategory[r.category].total += 1;
    if (r.passed) byCategory[r.category].passed += 1;
  }
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length ? Number((passed / results.length).toFixed(3)) : 0,
    durationMs: Date.now() - startedAll,
    costUsd: Number(results.reduce((a, r) => a + (r.costUsd ?? 0), 0).toFixed(6)),
    costUsdOfficial: Number(results.reduce((a, r) => a + r.costUsdOfficial, 0).toFixed(6)),
    tokensIn: results.reduce((a, r) => a + r.tokensIn, 0),
    tokensOut: results.reduce((a, r) => a + r.tokensOut, 0),
    byCategory,
    cases: results,
    failures: results.filter((r) => !r.passed),
    threshold: meta.threshold ?? 0.8,
  };
}

function printLiveReport(report, cases) {
  console.log('');
  console.log('  rezultat po slučaju:');
  for (const r of report.cases) {
    console.log(`  ${r.passed ? '✔' : '✖'} [${r.category.padEnd(9)}] ${r.caseId.padEnd(36)} ${String(r.durationMs).padStart(6)}ms  ${r.agentId ?? '-'}  ${r.tokensIn}/${r.tokensOut} tok`);
  }
  console.log('');
  console.log('  tabela po kategorijama:');
  console.log('  kategorija     prošlo/ukupno   prolaznost');
  for (const [cat, v] of Object.entries(report.byCategory)) {
    const rate = v.total ? (v.passed / v.total) * 100 : 0;
    console.log(`  ${cat.padEnd(14)} ${String(`${v.passed}/${v.total}`).padStart(9)}   ${rate.toFixed(1).padStart(6)} %`);
  }
  console.log('');
  console.log(`  UKUPNO: ${report.passed}/${report.total} = ${(report.passRate * 100).toFixed(1)} %  (prag ${(report.threshold * 100).toFixed(0)} %) → ${report.passRate >= report.threshold ? 'IZNAD PRAGA ✔' : 'ISPOD PRAGA ✖'}`);
  console.log(`  tokena: ${report.tokensIn} ulaz / ${report.tokensOut} izlaz · trajanje ${(report.durationMs / 1000).toFixed(1)}s`);
  console.log(`  trošak: $${report.costUsdOfficial.toFixed(6)} (zvanični cjenovnik) · $${report.costUsd.toFixed(6)} (interni cjenovnik repo-a)`);  if (report.failures.length) {
    console.log('  padovi:');
    for (const f of report.failures) console.log(`    ✖ [${f.category}] ${f.caseId}: ${f.failures.join('; ')}`);
  }
  console.log(`  set: ${cases.length} slučaja iz ${path.relative(ROOT, CASES_FILE)}`);
}

// ─────────────────────────────── main ───────────────────────────────
async function main() {
  if (has('help')) {
    console.log('node scripts/eval-real.mjs [--dry-run | --live] [--model deepseek-chat] [--category routing]');
    console.log('                            [--cases id1,id2] [--limit 5] [--file eval/golden/cases.json]');
    console.log('                            [--tenant golden] [--data ./data/_eval-real] [--history data/_control/eval-history.json]');
    return 0;
  }

  const { meta, cases: all } = await loadCases();
  let cases = all;
  if (CATEGORY_FILTER) cases = cases.filter((c) => c.category === CATEGORY_FILTER);
  if (CASE_FILTER) cases = cases.filter((c) => CASE_FILTER.includes(c.id));
  if (LIMIT) cases = cases.slice(0, LIMIT);
  if (!cases.length) {
    console.error(`  ✖ nijedan slučaj ne odgovara filteru (set ima ${all.length} slučajeva)`);
    return 1;
  }

  const prompts = await loadSystemPromptChars();
  const realMax = prompts.reduce((a, p) => Math.max(a, p.chars), 0);
  const realMaxId = prompts.find((p) => p.chars === realMax)?.id ?? '-';
  // Konzervativni pod: stvarni promptovi agenata su kratki (< 700 znakova), ali u run ulaze i
  // kontekst iz memorije, rezultati alata i instrukcije patterna — zato ne idemo ispod 700.
  const maxChars = Math.max(realMax, TOKENS.systemPromptFallbackChars);
  const maxDesc = realMax >= TOKENS.systemPromptFallbackChars ? `${realMaxId} iz config/agents` : `${realMaxId} (${realMax} znakova) + rezerva do poda`;
  const system = { chars: maxChars, maxChars, maxDesc };

  if (LIVE) return liveRun(cases, meta);
  return dryRun(cases, system, meta);
}

// Pokreće se samo kao CLI (import iz testova ne smije ništa da ispiše)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`  ✖ EVAL-REAL GREŠKA: ${err.message}`);
      process.exitCode = 1;
    });
}

export { main, loadCases, estimateSet, estimateCase, officialPrice, isPeakNow, REFUSAL_RE, OFFICIAL_PRICING, TOKENS, HISTORY_FILE, CASES_FILE };
