#!/usr/bin/env node
/**
 * Mobilni upload za Knjigovođa Pro — prima račune sa telefona i čeka da ih
 * Majin program povuče (sinhronizacija).
 *
 * Bez npm zavisnosti (samo Node stdlib).
 *   POST /api/upload            (multipart ili raw)  -> čuva fajl
 *   GET  /api/pending?token=X                        -> lista fajlova
 *   GET  /api/download/ID?token=X                    -> skida fajl
 *   POST /api/ack?token=X {id}                       -> briše posle preuzimanja
 *   GET  /api/health
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.MOBIL_PORT || '3001', 10);
const BASE = process.env.MOBIL_DIR || '/opt/braincore/mobil';
const DATA = path.join(BASE, 'data');
const PUBLIC = path.join(BASE, 'public');
const TOKEN_FILE = path.join(BASE, 'token.txt');
const MAX_BYTES = parseInt(process.env.MOBIL_MAX_MB || '150', 10) * 1024 * 1024; // default 150 MB

// ── token (za povlačenje sa Majinog računara) ──
let TOKEN = '';
try {
  TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
} catch {
  TOKEN = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(BASE, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
  } catch {}
}

fs.mkdirSync(DATA, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function safePib(p) {
  const s = String(p || '').replace(/\D/g, '');
  return s.length >= 8 && s.length <= 12 ? s : '';
}

function safeName(n) {
  const base = path.basename(String(n || 'racun.jpg'));
  const clean = base.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  return clean || 'racun.jpg';
}

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  return path.join(dir, `${stem}-${stamp}-${crypto.randomBytes(3).toString('hex')}${ext}`);
}

// ── minimalni multipart parser ──
function parseMultipart(buf, boundary) {
  const out = { fields: {}, files: [] };
  const delim = Buffer.from('--' + boundary);
  let pos = buf.indexOf(delim);
  if (pos < 0) return out;
  pos += delim.length;

  while (pos < buf.length) {
    // kraj?
    if (buf.slice(pos, pos + 2).toString() === '--') break;
    // preskoči CRLF
    if (buf.slice(pos, pos + 2).toString() === '\r\n') pos += 2;

    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) break;
    const headers = buf.slice(pos, headEnd).toString('utf8');
    const bodyStart = headEnd + 4;
    const next = buf.indexOf(delim, bodyStart);
    if (next < 0) break;
    let bodyEnd = next;
    if (buf.slice(bodyEnd - 2, bodyEnd).toString() === '\r\n') bodyEnd -= 2;
    const content = buf.slice(bodyStart, bodyEnd);

    const nameM = /name="([^"]+)"/i.exec(headers);
    const fileM = /filename="([^"]*)"/i.exec(headers);
    const ctM = /content-type:\s*([^\r\n;]+)/i.exec(headers);
    const field = nameM ? nameM[1] : '';
    if (fileM && fileM[1]) {
      out.files.push({
        field,
        filename: fileM[1],
        contentType: ctM ? ctM[1].trim() : 'application/octet-stream',
        data: content,
      });
    } else if (field) {
      out.fields[field] = content.toString('utf8');
    }
    pos = next + delim.length;
  }
  return out;
}

function readBody(req, limit = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function listPending() {
  const items = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(DATA, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return items;
  }
  for (const d of dirs) {
    const pib = d.name;
    const full = path.join(DATA, pib);
    let files = [];
    try {
      files = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(full, f));
        items.push({
          id: `${pib}/${f}`,
          pib,
          filename: f,
          size: st.size,
          uploaded_at: st.mtime.toISOString(),
        });
      } catch {}
    }
  }
  items.sort((a, b) => (a.uploaded_at < b.uploaded_at ? -1 : 1));
  return items;
}

async function handleUpload(req, res, url) {
  const ctype = String(req.headers['content-type'] || '');
  const body = await readBody(req);

  let pib = safePib(url.searchParams.get('pib') || req.headers['x-pib'] || '');
  let files = [];

  if (ctype.startsWith('multipart/form-data')) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
    const boundary = m ? (m[1] || m[2]).trim() : '';
    if (!boundary) return json(res, 400, { ok: false, error: 'nema boundary' });
    const parsed = parseMultipart(body, boundary);
    if (!pib) pib = safePib(parsed.fields.pib || parsed.fields.PIB || '');
    files = parsed.files.map((f) => ({ filename: f.filename, data: f.data }));
  } else {
    // raw body: ime fajla iz ?name= ili zaglavlja
    const name = url.searchParams.get('name') || req.headers['x-filename'] || 'racun.jpg';
    files = [{ filename: name, data: body }];
  }

  if (!pib) return json(res, 400, { ok: false, error: 'PIB je obavezan (8-12 cifara)' });
  if (!files.length) return json(res, 400, { ok: false, error: 'nema fajla' });

  const dir = path.join(DATA, pib);
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const f of files) {
    if (!f.data || !f.data.length) continue;
    const dest = uniquePath(dir, safeName(f.filename));
    fs.writeFileSync(dest, f.data);
    saved.push({ id: `${pib}/${path.basename(dest)}`, filename: path.basename(dest), size: f.data.length });
    console.log(`[upload] PIB=${pib} fajl=${path.basename(dest)} (${f.data.length} B)`);
  }
  return json(res, 200, { ok: true, pib, saved });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-PIB,X-Filename',
    });
    return res.end();
  }

  try {
    if (p === '/api/health') return json(res, 200, { ok: true, pending: listPending().length });

    if (p === '/api/upload' && req.method === 'POST') return await handleUpload(req, res, url);

    // ── zaštićeno tokenom (samo Majin program) ──
    if (p.startsWith('/api/')) {
      const token = url.searchParams.get('token') || req.headers['x-token'] || '';
      if (!TOKEN || token !== TOKEN) return json(res, 401, { ok: false, error: 'neovlašćeno' });

      if (p === '/api/pending') return json(res, 200, { ok: true, items: listPending() });

      if (p.startsWith('/api/download/')) {
        const id = decodeURIComponent(p.slice('/api/download/'.length));
        const full = path.join(DATA, id);
        if (!full.startsWith(DATA) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
          return json(res, 404, { ok: false, error: 'nema fajla' });
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${path.basename(full)}"`,
          'Cache-Control': 'no-store',
        });
        return fs.createReadStream(full).pipe(res);
      }

      if (p === '/api/ack' && req.method === 'POST') {
        const body = await readBody(req, 64 * 1024);
        let ids = [];
        try {
          const j = JSON.parse(body.toString('utf8') || '{}');
          ids = Array.isArray(j.ids) ? j.ids : j.id ? [j.id] : [];
        } catch {}
        let deleted = 0;
        for (const id of ids) {
          const full = path.join(DATA, String(id));
          if (full.startsWith(DATA) && fs.existsSync(full)) {
            try {
              fs.unlinkSync(full);
              deleted++;
            } catch {}
          }
        }
        return json(res, 200, { ok: true, deleted });
      }
      return json(res, 404, { ok: false, error: 'nepoznata ruta' });
    }

    // ── PWA (statički) ──
    let rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const full = path.join(PUBLIC, rel);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return json(res, 404, { ok: false, error: 'nema' });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    return fs.createReadStream(full).pipe(res);
  } catch (err) {
    console.error('[greska]', err && err.message);
    return json(res, 500, { ok: false, error: 'server error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mobil-upload sluša na 127.0.0.1:${PORT} | data=${DATA} | token=${TOKEN ? 'postavljen' : 'NEMA'}`);
});
