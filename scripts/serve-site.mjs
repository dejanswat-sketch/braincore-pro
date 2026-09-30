#!/usr/bin/env node
/**
 * Statički server za `site/` — samo za lokalno gledanje (bez npm zavisnosti).
 *
 *   node scripts/serve-site.mjs                 # http://127.0.0.1:8080
 *   node scripts/serve-site.mjs --port=9000
 *
 * Nije za produkciju: bez keša, bez kompresije, bez TLS-a. Produkcija je Hostinger (vidi deploy/).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const PORT = Number(arg('port', process.env.SITE_PORT ?? 8080));
const HOST = arg('host', '127.0.0.1');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(SITE, path.normalize(rel).replace(/^([/\\])+/, ''));
  // Ne izlazi iz site/ foldera
  if (!full.startsWith(SITE)) {
    res.writeHead(403).end('Zabranjeno');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<h1>404</h1><p>Nema ${rel} — probaj <a href="/">/</a></p>`);
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`SITE  →  http://${HOST}:${PORT}/            (sajt)`);
  // eslint-disable-next-line no-console
  console.log(`      →  http://${HOST}:${PORT}/docs.html   (API dokumentacija)`);
  // eslint-disable-next-line no-console
  console.log(`      →  http://${HOST}:${PORT}/?api=http://127.0.0.1:8081   (sajt + živi lokalni API)`);
});
