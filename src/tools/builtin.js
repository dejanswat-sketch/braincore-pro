/**
 * Ugrađeni alati (bez zavisnosti i bez mreže, osim http_fetch i integracija koje se eksplicitno uključe).
 * Svaki alat: { name, description, params (JSON Schema), riskLevel, scopes, tags, handler(args, ctx) }
 *
 * RiskLevel je ugovor sa politikom:
 *   low    — čitanje/računanje, bez spoljnih efekata
 *   medium — upis u internu bazu ili spoljni GET/POST bez novca
 *   high   — spoljna komunikacija, novac, brisanje → po pravilu traži odobrenje
 */
import path from 'node:path';
import { appendJsonl, readJsonl } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { PolicyError, ValidationError, NotFoundError } from '../core/errors.js';
import { get } from '../core/config-utils.js';
import { redact } from '../core/logger.js';

const tpath = (dataDir, tenantId, ...parts) => path.join(dataDir, 'tenants', tenantId, ...parts);

export function registerBuiltinTools(registry, services = {}) {
  const { dataDir, memory, env = {}, logger, metrics } = services;
  const allowlist = env.httpAllowlist?.length ? env.httpAllowlist : [];

  const store = (tenantId, kind) => tpath(dataDir, tenantId, kind, `${kind}.jsonl`);

  /** Upsert u append-only JSONL: čita poslednje stanje, dopisuje novu verziju. */
  const upsertJsonl = async (file, record) => {
    const rows = await readJsonl(file);
    const prev = rows.filter((r) => r.id === record.id).at(-1);
    await appendJsonl(file, { ...prev, ...record, _op: prev ? 'update' : 'insert', _v: (prev?._v ?? 0) + 1 });
    return { ...prev, ...record };
  };

  registry.registerAll([
    // ---------- 1. vrijeme ----------
    {
      name: 'current_time',
      description: 'Vraća trenutno vrijeme (ISO i lokalno) i dan u nedjelji.',
      params: { type: 'object', properties: { timezone: { type: 'string', description: 'npr. Europe/Belgrade' } }, additionalProperties: false },
      riskLevel: 'low',
      tags: ['core'],
      handler: async ({ timezone = 'Europe/Belgrade' } = {}) => {
        const now = new Date();
        return {
          iso: now.toISOString(),
          timezone,
          local: now.toLocaleString('sr-RS', { timeZone: timezone }),
          weekday: now.toLocaleDateString('sr-RS', { weekday: 'long', timeZone: timezone }),
        };
      },
    },

    // ---------- 2. kalkulator ----------
    {
      name: 'calculator',
      description: 'Bezbjedan matematički kalkulator (+, -, *, /, %, ^, zagrade, sqrt/abs/round/min/max/pow/log/exp). Bez eval().',
      params: { type: 'object', properties: { expression: { type: 'string', description: 'npr. (1200*1.2)+150' } }, required: ['expression'], additionalProperties: false },
      riskLevel: 'low',
      tags: ['core'],
      handler: async ({ expression }) => ({ expression, value: evaluateMath(expression) }),
    },

    // ---------- 3. http_fetch ----------
    {
      name: 'http_fetch',
      description: 'HTTP zahtjev prema dozvoljenom domenu (allowlist u NMQ_HTTP_ALLOWLIST). Vraća status, zaglavlja i tijelo (do 20k znakova).',
      params: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          headers: { type: 'object' },
          body: { type: 'string', description: 'JSON string ili tekst' },
          timeoutMs: { type: 'number' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      riskLevel: 'medium',
      tags: ['integration'],
      handler: async ({ url, method = 'GET', headers = {}, body, timeoutMs = 10_000 }, ctx) => {
        assertUrlAllowed(url, allowlist, env);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
        const onAbort = () => ac.abort(new Error('aborted'));
        ctx.signal?.addEventListener?.('abort', onAbort, { once: true });
        try {
          const res = await fetch(url, {
            method,
            headers: { 'content-type': 'application/json', ...headers },
            body: method === 'GET' || method === 'DELETE' ? undefined : body,
            signal: ac.signal,
          });
          const text = await res.text();
          metrics?.inc('http_fetch_total', { tenant: ctx.tenantId, status: String(res.status) });
          return {
            url,
            status: res.status,
            ok: res.ok,
            contentType: res.headers.get('content-type'),
            body: text.length > 20_000 ? `${text.slice(0, 20_000)}…[skraćeno]` : text,
          };
        } finally {
          clearTimeout(timer);
          ctx.signal?.removeEventListener?.('abort', onAbort);
        }
      },
    },

    // ---------- 4. pretraga memorije ----------
    {
      name: 'memory_search',
      description: 'Pretraga dugoročne memorije i baze znanja (RAG) za tenant. Vraća najrelevantnije fragmente sa izvorima.',
      params: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          k: { type: 'number', description: 'broj rezultata (default 5)' },
          scope: { type: 'string', enum: ['all', 'events', 'kb'] },
        },
        required: ['query'],
        additionalProperties: false,
      },
      riskLevel: 'low',
      tags: ['memory'],
      handler: async ({ query, k = 5, scope = 'all' }, ctx) => {
        const out = { query, events: [], kb: [] };
        if (scope !== 'kb') out.events = await memory.longterm.search(ctx.tenantId, { query, k });
        if (scope !== 'events') out.kb = await memory.vectors.query(ctx.tenantId, { text: query, k });
        return out;
      },
    },

    // ---------- 5. ingest u bazu znanja ----------
    {
      name: 'kb_ingest',
      description: 'Dodaje dokument u bazu znanja tenanta (chunk + embedding + metadata). Koristi se za FAQ, politike, cjenovnike, SOP-ove.',
      params: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          source: { type: 'string', description: 'naziv izvora, npr. "FAQ 2026"' },
          docId: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'source'],
        additionalProperties: false,
      },
      riskLevel: 'medium',
      tags: ['memory'],
      handler: async ({ text, source, docId, tags = [] }, ctx) => memory.vectors.ingest(ctx.tenantId, { text, source, docId, metadata: { tags } }),
    },

    // ---------- 6. CRM upis ----------
    {
      name: 'crm_upsert',
      description: 'Kreira ili ažurira zapis u CRM-u (contact | company | deal) za tenant. Vraća sačuvani zapis.',
      params: {
        type: 'object',
        properties: {
          entityType: { type: 'string', enum: ['contact', 'company', 'deal'] },
          id: { type: 'string' },
          fields: { type: 'object' },
        },
        required: ['entityType', 'fields'],
        additionalProperties: false,
      },
      riskLevel: 'medium',
      tags: ['crm'],
      handler: async ({ entityType, id, fields }, ctx) => {
        const record = { id: id ?? uid(entityType.slice(0, 3)), entityType, ...fields, updatedAt: iso(), tenantId: ctx.tenantId };
        return upsertJsonl(store(ctx.tenantId, 'crm'), record);
      },
    },

    // ---------- 7. CRM čitanje ----------
    {
      name: 'crm_get',
      description: 'Čita zapis iz CRM-a tenanta po tipu i ID-u.',
      params: { type: 'object', properties: { entityType: { type: 'string', enum: ['contact', 'company', 'deal'] }, id: { type: 'string' } }, required: ['entityType', 'id'], additionalProperties: false },
      riskLevel: 'low',
      tags: ['crm'],
      handler: async ({ entityType, id }, ctx) => {
        const rows = await readJsonl(store(ctx.tenantId, 'crm'));
        const found = rows.filter((r) => r.entityType === entityType && r.id === id).at(-1);
        if (!found) throw new NotFoundError(`${entityType}`, id);
        return found;
      },
    },

    // ---------- 8. slanje mejla ----------
    {
      name: 'email_send',
      description: 'Šalje mejl. Ako je konfigurisan NMQ_EMAIL_WEBHOOK — šalje preko njega; inače upisuje u outbox (dry-run) i vraća id.',
      params: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          cc: { type: 'string' },
          replyTo: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false,
      },
      riskLevel: 'high',
      tags: ['communication'],
      handler: async (args, ctx) => {
        const message = { id: uid('mail'), ts: iso(), tenantId: ctx.tenantId, from: env.emailFrom ?? 'robot@nmq.local', ...args, status: 'queued' };
        const webhook = env.emailWebhook || process.env.NMQ_EMAIL_WEBHOOK;
        if (webhook) {
          const res = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
          message.status = res.ok ? 'sent' : 'failed';
          message.providerStatus = res.status;
        }
        await appendJsonl(tpath(dataDir, ctx.tenantId, 'outbox', 'emails.jsonl'), message);
        logger?.info?.('email.queued', { tenantId: ctx.tenantId, id: message.id, status: message.status });
        return { id: message.id, status: message.status, to: message.to, subject: message.subject, preview: redact(String(args.body).slice(0, 400)) };
      },
    },

    // ---------- 9. notifikacija ----------
    {
      name: 'notify',
      description: 'Interna notifikacija (Slack/Teams/mejl) — upisuje u outbox i, ako je webhook konfigurisan, šalje ga.',
      params: {
        type: 'object',
        properties: { channel: { type: 'string', enum: ['slack', 'teams', 'email', 'internal'] }, message: { type: 'string' }, severity: { type: 'string', enum: ['info', 'warning', 'critical'] } },
        required: ['message'],
        additionalProperties: false,
      },
      riskLevel: 'medium',
      tags: ['communication'],
      handler: async ({ channel = 'internal', message, severity = 'info' }, ctx) => {
        const entry = { id: uid('ntf'), ts: iso(), tenantId: ctx.tenantId, channel, severity, message };
        const webhook = process.env[`NMQ_${channel.toUpperCase()}_WEBHOOK`];
        if (webhook) {
          const res = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) });
          entry.status = res.ok ? 'sent' : 'failed';
        } else entry.status = 'queued';
        await appendJsonl(tpath(dataDir, ctx.tenantId, 'outbox', 'notifications.jsonl'), entry);
        return entry;
      },
    },

    // ---------- 10. faktura ----------
    {
      name: 'invoice_create',
      description: 'Pravi fakturu (broj, stavke, PDV, ukupno, markdown) i upisuje je u evidenciju tenanta. Ne naplaćuje — za naplatu koristi payment_link_create.',
      params: {
        type: 'object',
        properties: {
          customer: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, vatId: { type: 'string' } }, required: ['name'] },
          items: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, qty: { type: 'number' }, unitPrice: { type: 'number' } }, required: ['description', 'qty', 'unitPrice'] } },
          currency: { type: 'string' },
          vatRate: { type: 'number' },
          dueDays: { type: 'number' },
        },
        required: ['customer', 'items'],
        additionalProperties: false,
      },
      riskLevel: 'high',
      tags: ['finance'],
      handler: async ({ customer, items, currency = 'EUR', vatRate = 0.2, dueDays = 15 }, ctx) => {
        if (!items?.length) throw new ValidationError('Faktura mora imati najmanje jednu stavku');
        const subtotal = items.reduce((s, it) => s + Number(it.qty) * Number(it.unitPrice), 0);
        const vat = Number((subtotal * vatRate).toFixed(2));
        const total = Number((subtotal + vat).toFixed(2));
        const due = new Date(Date.now() + dueDays * 86400_000).toISOString().slice(0, 10);
        const rows = await readJsonl(store(ctx.tenantId, 'invoices'));
        const invoice = {
          id: uid('inv'),
          number: `INV-${new Date().getFullYear()}-${String(rows.length + 1).padStart(4, '0')}`,
          ts: iso(),
          tenantId: ctx.tenantId,
          customer,
          items,
          currency,
          vatRate,
          subtotal: Number(subtotal.toFixed(2)),
          vat,
          total,
          dueDate: due,
          status: 'draft',
        };
        invoice.markdown = renderInvoice(invoice);
        await appendJsonl(store(ctx.tenantId, 'invoices'), invoice);
        return invoice;
      },
    },

    // ---------- 11. izvještaj ----------
    {
      name: 'report_generate',
      description: 'Sastavlja izvještaj (markdown) od sekcija i tabela; vraća markdown i JSON.',
      params: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' }, table: { type: 'object' } } } },
        },
        required: ['title', 'sections'],
        additionalProperties: false,
      },
      riskLevel: 'low',
      tags: ['reporting'],
      handler: async ({ title, sections }) => {
        const parts = [`# ${title}`, '', `_Generisano: ${iso()}_`, ''];
        for (const s of sections ?? []) {
          parts.push(`## ${s.heading ?? ''}`, '');
          if (s.body) parts.push(String(s.body), '');
          if (s.table?.columns && s.table?.rows) {
            parts.push(`| ${s.table.columns.join(' | ')} |`, `| ${s.table.columns.map(() => '---').join(' | ')} |`);
            for (const row of s.table.rows) parts.push(`| ${row.map((c) => String(c)).join(' | ')} |`);
            parts.push('');
          }
        }
        const markdown = parts.join('\n');
        return { title, markdown, length: markdown.length, sections: sections?.length ?? 0 };
      },
    },

    // ---------- 12. kvalifikacija leada ----------
    {
      name: 'lead_score',
      description: 'Deterministička kvalifikacija leada (A/B/C) na osnovu signala: budžet, hitnost, veličina firme, odgovornost sagovornika, jasan problem.',
      params: {
        type: 'object',
        properties: {
          budget: { type: 'number', description: '0-10' },
          urgency: { type: 'number' },
          companySize: { type: 'number' },
          authority: { type: 'number' },
          needClarity: { type: 'number' },
        },
        additionalProperties: false,
      },
      riskLevel: 'low',
      tags: ['sales'],
      handler: async (signals) => {
        const weights = { budget: 0.3, urgency: 0.2, companySize: 0.15, authority: 0.2, needClarity: 0.15 };
        let score = 0;
        for (const [k, w] of Object.entries(weights)) score += (Number(signals[k] ?? 5) / 10) * w;
        const pct = Math.round(score * 100);
        const grade = pct >= 75 ? 'A' : pct >= 50 ? 'B' : 'C';
        return { score: pct, grade, nextStep: grade === 'A' ? 'zakazati demo u 24h' : grade === 'B' ? 'poslati case study pa pratiti' : 'dodati u nurture sekvencu', inputs: signals };
      },
    },

    // ---------- 13. narudžbina (e-commerce) ----------
    {
      name: 'order_lookup',
      description: 'Provjerava status narudžbine u internom skladištu tenanta (sinkronizacija sa Shopify/Woo ide preko MCP-a).',
      params: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'], additionalProperties: false },
      riskLevel: 'low',
      tags: ['ecommerce'],
      handler: async ({ orderId }, ctx) => {
        const rows = await readJsonl(store(ctx.tenantId, 'orders'));
        const found = rows.filter((r) => r.id === orderId).at(-1);
        if (!found) throw new NotFoundError('Narudžbina', orderId);
        return found;
      },
    },

    // ---------- 14. ticket ----------
    {
      name: 'ticket_create',
      description: 'Otvara ticket u internom helpdesk-u tenanta (klasifikacija, prioritet, tagovi).',
      params: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          body: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          requester: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['subject'],
        additionalProperties: false,
      },
      riskLevel: 'medium',
      tags: ['support'],
      handler: async ({ subject, body = '', priority = 'normal', requester = null, tags = [] }, ctx) => {
        const ticket = { id: uid('tkt'), ts: iso(), tenantId: ctx.tenantId, subject, body, priority, requester, tags, status: 'open' };
        await appendJsonl(store(ctx.tenantId, 'tickets'), ticket);
        return ticket;
      },
    },

    // ---------- 15. handoff (peer-to-peer) ----------
    {
      name: 'handoff',
      description: 'Predaje kontrolu drugom specijalizovanom agentu uz obavezan razlog i sažetak konteksta.',
      params: {
        type: 'object',
        properties: { toAgent: { type: 'string' }, reason: { type: 'string' }, summary: { type: 'string' } },
        required: ['toAgent', 'reason'],
        additionalProperties: false,
      },
      riskLevel: 'low',
      tags: ['orchestration'],
      handler: async ({ toAgent, reason, summary = '' }) => ({ handoff: true, toAgent, reason, summary }),
    },

    // ---------- 16. zahtjev za odobrenje ----------
    {
      name: 'approval_request',
      description: 'Traži odobrenje čovjeka za osjetljivu akciju (novac, brisanje, spoljna komunikacija).',
      params: {
        type: 'object',
        properties: { action: { type: 'string' }, reason: { type: 'string' }, payload: { type: 'object' } },
        required: ['action', 'reason'],
        additionalProperties: false,
      },
      riskLevel: 'medium',
      tags: ['governance'],
      handler: async ({ action, reason, payload = {} }, ctx) => ({ approvalRequested: true, action, reason, payload, runId: ctx.runId, tenantId: ctx.tenantId }),
    },

    // ---------- 17. čitanje iz JSON-a po putanji ----------
    {
      name: 'json_query',
      description: 'Izvlači vrijednost iz JSON objekta po tačkastoj putanji (npr. "customer.address.city").',
      params: { type: 'object', properties: { data: { type: 'object' }, path: { type: 'string' } }, required: ['data', 'path'], additionalProperties: false },
      riskLevel: 'low',
      tags: ['core'],
      handler: async ({ data, path: p }) => ({ path: p, value: get(data, p, null) }),
    },

    // ---------- 18. plan koraka ----------
    {
      name: 'make_plan',
      description: 'Pravi eksplicitni plan (lista koraka) za zadatak — koristi ga orchestrator prije delegiranja.',
      params: {
        type: 'object',
        properties: { goal: { type: 'string' }, steps: { type: 'array', items: { type: 'object', properties: { step: { type: 'string' }, agent: { type: 'string' }, tool: { type: 'string' } } } } },
        required: ['goal', 'steps'],
        additionalProperties: false,
      },
      riskLevel: 'low',
      tags: ['orchestration'],
      handler: async ({ goal, steps }) => ({ goal, steps, count: steps?.length ?? 0 }),
    },
  ]);

  return registry;
}

/** Provjera domena za http_fetch. */
export function assertUrlAllowed(url, allowlist = [], env = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`Neispravan URL: ${url}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new PolicyError(`Protokol ${parsed.protocol} nije dozvoljen`);
  const list = allowlist.length ? allowlist : env.httpAllowlist ?? [];
  if (!list.length) throw new PolicyError('http_fetch nema allowlistu (postavi NMQ_HTTP_ALLOWLIST)');
  if (list.includes('*')) return true;
  const host = parsed.hostname;
  const ok = list.some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (!ok) throw new PolicyError(`Domen "${host}" nije na allowlisti`, { host, allowlist: list });
  return true;
}

function renderInvoice(inv) {
  const rows = inv.items.map((it) => `| ${it.description} | ${it.qty} | ${it.unitPrice} | ${(it.qty * it.unitPrice).toFixed(2)} |`);
  return [
    `# Faktura ${inv.number}`,
    '',
    `**Datum:** ${inv.ts.slice(0, 10)}  `,
    `**Rok plaćanja:** ${inv.dueDate}  `,
    `**Kupac:** ${inv.customer.name}${inv.customer.vatId ? ` (VAT: ${inv.customer.vatId})` : ''}`,
    '',
    '| Opis | Kol. | Cijena | Ukupno |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `Međusuma: **${inv.subtotal} ${inv.currency}**  `,
    `PDV (${(inv.vatRate * 100).toFixed(0)}%): **${inv.vat} ${inv.currency}**  `,
    `**UKUPNO: ${inv.total} ${inv.currency}**`,
  ].join('\n');
}

/** Bezbedan parser aritmetike (bez eval). */
export function evaluateMath(expression) {
  const tokens = String(expression)
    .replace(/\s+/g, '')
    .match(/\d+\.?\d*|[a-z]+|[+\-*/%^(),]/gi);
  if (!tokens) throw new ValidationError('Prazan izraz');
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t) => {
    if (tokens[pos] !== t) throw new ValidationError(`Očekivano "${t}" na poziciji ${pos}, dobijeno "${tokens[pos]}"`);
    pos += 1;
  };
  const FUNCS = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
    log: Math.log,
    exp: Math.exp,
    min: Math.min,
    max: Math.max,
    pow: Math.pow,
  };

  const parseExpr = () => {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[pos++];
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const parseTerm = () => {
    let v = parseFactor();
    while (['*', '/', '%'].includes(peek())) {
      const op = tokens[pos++];
      const r = parseFactor();
      if (op === '*') v *= r;
      else if (op === '/') {
        if (r === 0) throw new ValidationError('Dijeljenje nulom');
        v /= r;
      } else v %= r;
    }
    return v;
  };
  const parseFactor = () => {
    const base = parseUnary();
    if (peek() === '^') {
      pos += 1;
      return base ** parseFactor();
    }
    return base;
  };
  const parseUnary = () => {
    if (peek() === '-') {
      pos += 1;
      return -parseUnary();
    }
    if (peek() === '+') {
      pos += 1;
      return parseUnary();
    }
    return parsePrimary();
  };
  const parsePrimary = () => {
    const tok = peek();
    if (tok === '(') {
      eat('(');
      const v = parseExpr();
      eat(')');
      return v;
    }
    if (/^[a-z]+$/i.test(tok ?? '')) {
      const fn = FUNCS[tok.toLowerCase()];
      if (!fn) throw new ValidationError(`Nepoznata funkcija: ${tok}`);
      pos += 1;
      eat('(');
      const args = [parseExpr()];
      while (peek() === ',') {
        pos += 1;
        args.push(parseExpr());
      }
      eat(')');
      return fn(...args);
    }
    if (/^\d/.test(tok ?? '')) {
      pos += 1;
      return Number(tok);
    }
    throw new ValidationError(`Neočekivan token: ${tok}`);
  };

  const value = parseExpr();
  if (pos !== tokens.length) throw new ValidationError(`Neočekivan ostatak izraza: ${tokens.slice(pos).join('')}`);
  if (!Number.isFinite(value)) throw new ValidationError('Rezultat nije konačan broj');
  return value;
}
