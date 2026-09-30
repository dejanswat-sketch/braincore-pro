#!/usr/bin/env node
/**
 * Primjer internog MCP servera (stdio, JSON-RPC 2.0, bez zavisnosti).
 * Ovo je šablon po kojem se pišu MCP serveri za interne NMQ API-je i baze klijenata.
 *
 * VAŽNO: stdout je rezervisan za JSON-RPC. Svi logovi idu na stderr.
 *
 * Pokretanje: node mcp/example-server.mjs
 * Registracija: config/tools.json → mcpServers[]
 */
import readline from 'node:readline';

const SERVER_INFO = { name: 'nmq-example-crm', version: '0.1.0' };
const PROTOCOL = '2025-06-18';

// --- "baza" u memoriji (u pravom serveru: vaš API / SQL) ---
const db = {
  contacts: [
    { id: 'c1', name: 'Petar Petrović', email: 'petar@example.com', company: 'Prima d.o.o.', plan: 'Pro', mrr: 149, since: '2025-03-11' },
    { id: 'c2', name: 'Ana Anić', email: 'ana@shop-example.rs', company: 'Shop Example', plan: 'Starter', mrr: 39, since: '2026-01-20' },
  ],
  notes: [],
  tickets: [
    { id: 't100', subject: 'Ne mogu da se prijavim', status: 'open', priority: 'high', requester: 'petar@example.com' },
    { id: 't101', subject: 'Pitanje o fakturi', status: 'pending', priority: 'normal', requester: 'ana@shop-example.rs' },
  ],
};

const TOOLS = [
  {
    name: 'crm_contact_lookup',
    description: 'Traži kontakt u CRM-u po mejlu ili imenu. Vraća nalog, plan i MRR.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'mejl ili dio imena' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'crm_note_add',
    description: 'Dodaje bilješku na kontakt (npr. sažetak razgovora).',
    inputSchema: {
      type: 'object',
      properties: { contactId: { type: 'string' }, note: { type: 'string' } },
      required: ['contactId', 'note'],
      additionalProperties: false,
    },
  },
  {
    name: 'tickets_search',
    description: 'Pretraga ticketa po tekstu ili statusu.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, status: { type: 'string' } },
      additionalProperties: false,
    },
  },
];

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });

async function callTool(name, args = {}) {
  switch (name) {
    case 'crm_contact_lookup': {
      const q = String(args.query ?? '').toLowerCase();
      const hits = db.contacts.filter((c) => c.email.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || c.company.toLowerCase().includes(q));
      if (!hits.length) return text(`Nema kontakta za "${args.query}".`);
      return text(hits);
    }
    case 'crm_note_add': {
      const contact = db.contacts.find((c) => c.id === args.contactId);
      if (!contact) return { content: [{ type: 'text', text: `Nepoznat kontakt ${args.contactId}` }], isError: true };
      const note = { id: `n${db.notes.length + 1}`, contactId: args.contactId, note: args.note, ts: new Date().toISOString() };
      db.notes.push(note);
      return text({ saved: true, note });
    }
    case 'tickets_search': {
      const q = String(args.query ?? '').toLowerCase();
      const hits = db.tickets.filter((t) => (!args.status || t.status === args.status) && (!q || `${t.subject} ${t.requester}`.toLowerCase().includes(q)));
      return text(hits.length ? hits : 'Nema rezultata.');
    }
    default:
      return { content: [{ type: 'text', text: `Nepoznat alat: ${name}` }], isError: true };
  }
}

/** Jednostavan uslovni "approval" hook — u pravom serveru: provjera tenanta i dozvola. */
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stderr.write('nmq-example-crm: neispravan JSON\n');
    return;
  }

  const isNotification = msg.id === undefined || msg.id === null;
  const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
  const fail = (code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } })}\n`);

  try {
    switch (msg.method) {
      case 'initialize':
        reply({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
        break;
      case 'notifications/initialized':
        break;
      case 'ping':
        reply({});
        break;
      case 'tools/list':
        reply({ tools: TOOLS });
        break;
      case 'tools/call':
        reply(await callTool(msg.params?.name, msg.params?.arguments ?? {}));
        break;
      default:
        if (!isNotification) fail(-32601, `Nepoznat metod: ${msg.method}`);
    }
  } catch (err) {
    process.stderr.write(`nmq-example-crm greška: ${err.message}\n`);
    if (!isNotification) fail(-32603, err.message);
  }
});

rl.on('close', () => process.exit(0));
process.stderr.write(`nmq-example-crm spreman (stdio, ${TOOLS.length} alata)\n`);
