/**
 * peak-gate.mjs — ZAUSTAVLJA skupe DeepSeek pozive u PEAK satima.
 *
 * ZASTO (iz analize 5 dana): off-peak $23,62 vs peak $47,24 — PEAK sam DUPLO
 * povecao racun. Razlika $23,62 je najveca pojedinacna poluga ustede.
 *
 * PEAK (Europe/Belgrade): 03-06h i 08-12h · vikendom UVIJEK off-peak.
 *
 * Kako se koristi:
 *   import { smijeCloud, cekajOffPeak, peakInfo } from './peak-gate.mjs';
 *   if (!smijeCloud()) { ... radi lokalno ili odlozi ... }
 *
 * CLI:
 *   node peak-gate.mjs            -> ispise stanje
 *   node peak-gate.mjs --cekaj    -> ceka do off-peak (max 4h) pa izlazi
 *   node peak-gate.mjs --json     -> JSON za druge skripte
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.NMQ_DATA_DIR || 'C:\\Users\\Administrator\\.dsh\\NMQ\\data';
const LOG = path.join(DATA, 'peak-gate.jsonl');

/** PEAK sati u UTC (DeepSeek zvanicno): 01-04 i 06-10 UTC */
const PEAK_UTC = [[1, 4], [6, 10]];

/** Da li je sada PEAK (po DeepSeek cjenovniku)? */
export function peakInfo(now = new Date()) {
  const dan = now.getUTCDay(); // 0=nedjelja, 6=subota
  const vikend = dan === 0 || dan === 6;
  const h = now.getUTCHours();
  const utcPeak = PEAK_UTC.some(([od, do_]) => h >= od && h < do_);
  const peak = utcPeak && !vikend; // vikendom je uvijek off-peak
  // srpsko vrijeme = UTC+2 (ljeto) / +1 (zima)
  const pomak = -now.getTimezoneOffset() / 60;
  const lokalno = `${String((h + pomak + 24) % 24).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // koliko minuta do off-peak
  let minDoOff = 0;
  if (peak) {
    let hh = h;
    for (let i = 0; i < 24 * 60; i++) {
      const t = new Date(now.getTime() + i * 60_000);
      const th = t.getUTCHours();
      const td = t.getUTCDay();
      const tv = td === 0 || td === 6;
      if (!PEAK_UTC.some(([o, d]) => th >= o && th < d) || tv) { minDoOff = i; break; }
      hh = th;
    }
  }
  return {
    peak,
    vikend,
    utcSat: h,
    lokalnoVrijeme: lokalno,
    minDoOffPeak: minDoOff,
    opis: peak ? 'PEAK — DeepSeek naplacuje DUPLO' : 'off-peak — normalna cijena',
  };
}

/** Da li smijemo zvati cloud sada (off-peak ili je vikend)? */
export function smijeCloud(now = new Date()) {
  return !peakInfo(now).peak;
}

/** Zabiljezi odluku (za tablu: koliko je poziva odlozeno/dozvoljeno). */
export function zabiljezi(radnja, detalj = {}) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), radnja, ...detalj }) + '\n');
  } catch { /* log nikad ne obara */ }
}

/** Statistika: koliko je poziva odlozeno zbog peak-a. */
export function statistika() {
  const r = { dozvoljeno: 0, odlozeno: 0, ukupno: 0 };
  try {
    for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        r.ukupno++;
        if (j.radnja === 'odlozeno') r.odlozeno++;
        else if (j.radnja === 'dozvoljeno') r.dozvoljeno++;
      } catch { /* */ }
    }
  } catch { /* */ }
  return r;
}

/** Ceka do off-peak (max `maxMin` minuta). Vraca koliko je cekao u sekundama. */
export async function cekajOffPeak({ maxMin = 240, naCekanju } = {}) {
  const t0 = Date.now();
  while (true) {
    const p = peakInfo();
    if (!p.peak) break;
    if ((Date.now() - t0) / 60_000 > maxMin) break;
    naCekanju?.(p.minDoOffPeak);
    await new Promise((r) => setTimeout(r, 60_000));
  }
  return Math.round((Date.now() - t0) / 1000);
}

// ── CLI ──
const jeCli = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('peak-gate.mjs');
if (jeCli) {
  const p = peakInfo();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...p, smijeCloud: smijeCloud(), statistika: statistika() }, null, 2));
  } else if (process.argv.includes('--cekaj')) {
    console.log('  ' + p.opis + ' (' + p.lokalnoVrijeme + ' lokalno)');
    if (!p.peak) { console.log('  vec je off-peak — nema cekanja'); process.exit(0); }
    console.log('  cekam do off-peak (do ' + p.minDoOffPeak + ' min)...');
    const sek = await cekajOffPeak({ naCekanju: (m) => console.log('    jos ' + m + ' min') });
    console.log('  cekao ' + sek + ' s — sada: ' + peakInfo().opis);
  } else {
    console.log('');
    console.log('  PEAK GATE — ' + p.opis);
    console.log('  lokalno vrijeme: ' + p.lokalnoVrijeme + '  (UTC ' + p.utcSat + 'h' + (p.vikend ? ', vikend' : '') + ')');
    console.log('  smije cloud: ' + (smijeCloud() ? 'DA' : 'NE — radi lokalno ili odlozi'));
    if (p.peak) console.log('  do off-peak: ' + p.minDoOffPeak + ' min');
    const st = statistika();
    console.log('  istorija: dozvoljeno ' + st.dozvoljeno + ' · odlozeno ' + st.odlozeno);
    console.log('');
  }
}
