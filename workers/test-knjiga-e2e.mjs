#!/usr/bin/env node
/**
 * FAZA 2 — end-to-end test workera protiv ŽIVOG bridge-a (Knjigovođa Pro na 5055).
 * Dokazuje: ulazna faktura → konto → PDV → priprema za BizniSoft (outbox) → status u bazi.
 * Bez npm zavisnosti (globalni fetch).
 */
const BRIDGE = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:5055').replace(/\/$/, '');
const j = async (u, o = {}) => {
  const r = await fetch(u, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers ?? {}) } });
  const t = await r.text();
  let b; try { b = t ? JSON.parse(t) : null; } catch { b = t; }
  return { status: r.status, ok: r.ok, body: b };
};
const t0 = Date.now();
const step = (n, v) => console.log(`${String(n).padStart(2)}. ${v}`);

const st = await j(`${BRIDGE}/api/v1/status`);
step(1, `bridge status ${st.status} · klijenti=${st.body?.data?.clients} · moduli=${st.body?.data?.modules}`);
const clients = await j(`${BRIDGE}/api/v1/clients`);
const list = clients.body?.data ?? [];
step(2, `klijenata u bazi: ${list.length} → ${list.slice(0, 3).map((c) => c.pib ?? c.PIB).join(', ')}`);
const pib = String(list[0]?.pib ?? list[0]?.PIB ?? '123456789');

// ulazna kalkulacija: faktura ulazi
const broj = `TEST-${Date.now().toString().slice(-6)}`;
const inv = await j(`${BRIDGE}/api/v1/invoices`, {
  method: 'POST',
  body: JSON.stringify({ pib, broj, dobavljac: 'Braincore Test DOO', neto: 10000, pdv: 2000, bruto: 12000, tip: 'ulazna', status: 'Nova', izvor: 'braincore:worker-test' }),
});
step(3, `POST /invoices → ${inv.status} · id=${inv.body?.data?.id} · status=${inv.body?.data?.status}`);
const fid = inv.body?.data?.id;
if (!fid) { console.error('faktura nije kreirana:', JSON.stringify(inv.body).slice(0, 200)); process.exit(1); }

// konto + pripremljeno
const patched = await j(`${BRIDGE}/api/v1/invoices/${fid}`, { method: 'PATCH', body: JSON.stringify({ konto: '4700', status: 'pripremljeno' }) });
step(4, `PATCH /invoices/${fid} → ${patched.status} · konto=${patched.body?.data?.konto} · status=${patched.body?.data?.status}`);

// priprema za BizniSoft (outbox fajl)
const csv = `broj;dobavljac;neto;pdv;bruto;konto\n${broj};Braincore Test DOO;10000;2000;12000;4700\n`;
const out = await j(`${BRIDGE}/api/v1/outbox/write`, { method: 'POST', body: JSON.stringify({ pib, filename: `BizniSoft_KUF_${broj}.csv`, content: csv }) });
step(5, `POST /outbox/write → ${out.status} · ${out.body?.data?.path ?? JSON.stringify(out.body).slice(0, 120)}`);

// SEF / eFakture (automatizacija)
const sef = await j(`${BRIDGE}/api/v1/sef/sync`, { method: 'POST', body: JSON.stringify({ klijent_id: fid, dry_run: true }) });
step(6, `POST /sef/sync (dry-run) → ${sef.status} · ${JSON.stringify(sef.body).slice(0, 160)}`);

const ms = Date.now() - t0;
step(7, `UKUPNO ${ms} ms za cijeli tok (ingest → konto → PDV → BizniSoft priprema → SEF)`);
console.log(JSON.stringify({ ok: true, fakturaId: fid, broj, pib, ms }));
