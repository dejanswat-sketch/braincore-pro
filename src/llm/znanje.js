/**
 * znanje.js — RAG sloj: ucitava nase znanje (docs/*.md) i daje ga agentima.
 *
 * ZASTO: testirano 04.10.2026 — fine-tune malog modela (3B, 34 para) IZMISLJA
 * brojeve, a isti podaci u kontekstu (RAG) sa 24B modelom daju TACNE odgovore.
 * Zato: znanje ide u system prompt (kratak rezime) + pun tekst na zahtjev.
 *
 * Kako radi:
 *   - cita docs/*.md (nase znanje) i data/facts/*.json
 *   - pravi KRATAK rezime (~250 tokena) koji ide u SVAKI system prompt
 *   - pun tekst se daje alatom/kad agent izricito zatrazi (stedi tokene!)
 *   - kesira u memoriji (ne cita disk svaki put)
 *
 * Env:
 *   NMQ_ZNANJE_DIR   (default: <robot>/docs)
 *   NMQ_ZNANJE_MAX   (max znakova rezimea, default 1200)
 */
import fs from 'node:fs';
import path from 'node:path';

const KES_MS = 60_000; // 1 min

export function createZnanje({ dataDir, logger, dirs } = {}) {
  const baze = dirs ?? [
    process.env.NMQ_ZNANJE_DIR,
    dataDir ? path.join(dataDir, '..', 'docs') : null,
    'E:\\NMQ-PROGRAMI\\nmq-robot\\docs',
    'C:\\Users\\Administrator\\.dsh\\NMQ\\data\\knjigovodja-trening',
  ].filter(Boolean);

  // ARHIVA: pun tekst razgovora (17.000+ fajlova, ~130 MB) — NIKAD u rezime,
  // samo za pretragu (nadji). Inace bi rezime eksplodirao.
  const arhive = process.env.NMQ_ARHIVA_DIR
    ? [process.env.NMQ_ARHIVA_DIR]
    : ['C:\\Users\\Administrator\\.dsh\\NMQ\\data\\cursor-razgovori'];
  const ARHIVA_MIN_BAJTOVA = Number(process.env.NMQ_ARHIVA_MIN || 2048); // samo veci razgovori
  const ARHIVA_MAX = Number(process.env.NMQ_ARHIVA_MAX || 6);

  let kes = { at: 0, rezime: '', fajlovi: [], ukupno: 0 };
  let kesArhiva = { at: 0, fajlovi: [] };

  // Prioritet: nase znanje o ustedi ide PRVO u rezime (ostalo su dokumenti robota).
  const PRIORITET = [/ZNANJE-OD-RADA/i, /CURSOR-ZNANJE/i, /USTEDA-TOKENA/i, /usteda-znanje/i, /DNEVNIK-RADA/i, /facts/i];
  const MAX_U_REZIME = Number(process.env.NMQ_ZNANJE_FAJLOVA || 6);

  /** Ucitaj sve .md/.json fajlove iz baza (bez rekurzije u node_modules). */
  function ucitaj() {
    const fajlovi = [];
    const videno = new Set();
    for (const b of baze) {
      let st;
      try { st = fs.statSync(b); } catch { continue; }
      if (!st.isDirectory()) continue;
      let lista = [];
      try { lista = fs.readdirSync(b, { withFileTypes: true }); } catch { continue; }
      for (const e of lista) {
        if (!e.isFile()) continue;
        if (!/\.(md|json)$/i.test(e.name)) continue;
        if (/package|tsconfig/i.test(e.name)) continue;
        const kljuc = e.name.toLowerCase();
        if (videno.has(kljuc)) continue; // dedup po imenu (isti fajl u vise baza)
        const p = path.join(b, e.name);
        let tekst = '';
        try { tekst = fs.readFileSync(p, 'utf8'); } catch { continue; }
        if (tekst.length < 80) continue;
        videno.add(kljuc);
        const prioritet = PRIORITET.findIndex((re) => re.test(e.name));
        fajlovi.push({ ime: e.name, putanja: p, tekst, velicina: tekst.length, prioritet: prioritet < 0 ? 99 : prioritet });
      }
    }
    // prioritetni prvo, pa ostali po velicini (veci = vise informacija)
    fajlovi.sort((a, b) => (a.prioritet - b.prioritet) || (b.velicina - a.velicina));
    return fajlovi;
  }

  /** Kratak rezime za system prompt — naslovi + kljucne brojke (da ne trosi tokene). */
  function napraviRezime(fajlovi, maxZnakova = Number(process.env.NMQ_ZNANJE_MAX || 7000)) {
    const dijelovi = [];
    for (const f of fajlovi.slice(0, MAX_U_REZIME)) {
      const linije = f.tekst.split('\n').filter((l) => l.trim());
      const naslovi = linije.filter((l) => /^#{1,3}\s/.test(l)).slice(0, 5).map((l) => l.replace(/^#+\s*/, '').trim());
      const bulleti = linije.filter((l) => /^\s*[-*]\s/.test(l)).slice(0, 14).map((l) => l.replace(/^\s*[-*]\s*/, '').trim().slice(0, 150));
      // KLJUCNE BROJKE: linije sa $, % ili velikim brojevima (12.581, 4,5 milijardi, $35,43)
      const brojke = linije
        .filter((l) => /(\$\s?\d|\d+[.,]\d+\s*%|\d{1,3}(\.\d{3})+|\d+\s*(milijard|miliona|M\b))/.test(l))
        .slice(0, 18)
        .map((l) => l.replace(/^\s*[-*#|]+\s*/, '').trim().slice(0, 150));
      const blok = [`### ${f.ime.replace(/\.(md|json)$/i, '')}`];
      if (naslovi.length) blok.push(naslovi.join(' · '));
      if (brojke.length) blok.push('KLJUCNE BROJKE:\n' + brojke.map((b) => '- ' + b).join('\n'));
      if (bulleti.length) blok.push(bulleti.map((b) => '- ' + b).join('\n'));
      dijelovi.push(blok.join('\n'));
    }
    let s = dijelovi.join('\n\n');
    if (s.length > maxZnakova) s = s.slice(0, maxZnakova) + '\n…';
    return s;
  }

  function osvjezi(force = false) {
    const sada = Date.now();
    if (!force && kes.rezime && sada - kes.at < KES_MS) return kes;
    const fajlovi = ucitaj();
    const rezime = napraviRezime(fajlovi);
    kes = {
      at: sada,
      rezime,
      fajlovi: fajlovi.map((f) => ({ ime: f.ime, putanja: f.putanja, velicina: f.velicina })),
      ukupno: fajlovi.reduce((a, f) => a + f.velicina, 0),
    };
    logger?.info?.('znanje.ucitano', { fajlova: kes.fajlovi.length, znakova: kes.ukupno, rezime: rezime.length });
    return kes;
  }

  /**
   * Spisak fajlova ARHIVE (17.000+ razgovora) — samo oni veci od ARHIVA_MIN_BAJTOVA,
   * sortirani od najveceg. Ne ucitava sadrzaj (samo velicinu) — brzo je.
   */
  function arhivaFajlovi(force = false) {
    const sada = Date.now();
    if (!force && kesArhiva.fajlovi.length && sada - kesArhiva.at < KES_MS * 5) return kesArhiva.fajlovi;
    const fajlovi = [];
    for (const d of arhive) {
      let lista = [];
      try { lista = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of lista) {
        if (!e.isFile() || !/\.md$/i.test(e.name) || e.name === 'INDEX.md') continue;
        const p = path.join(d, e.name);
        let vel = 0;
        try { vel = fs.statSync(p).size; } catch { continue; }
        if (vel < ARHIVA_MIN_BAJTOVA) continue;
        fajlovi.push({ ime: e.name, putanja: p, velicina: vel });
      }
    }
    fajlovi.sort((a, b) => b.velicina - a.velicina);
    kesArhiva = { at: sada, fajlovi };
    logger?.info?.('znanje.arhiva', { fajlova: fajlovi.length, min_bajtova: ARHIVA_MIN_BAJTOVA });
    return fajlovi;
  }

  return {
    /** Kratak rezime znanja za system prompt (~250 tokena). */
    rezime() {
      return osvjezi().rezime;
    },

    /** Da li ima znanja. */
    ima() {
      return osvjezi().fajlovi.length > 0;
    },

    /** Spisak fajlova znanja (za alat/prikaz). */
    fajlovi() {
      return osvjezi().fajlovi;
    },

    /** PUN tekst odredjenog fajla (kad agent izricito zatrazi — stedi tokene). */
    procitaj(ime) {
      const k = osvjezi();
      const f = k.fajlovi.find((x) => x.ime === ime || x.ime.startsWith(ime));
      if (!f) return null;
      try { return fs.readFileSync(f.putanja, 'utf8'); } catch { return null; }
    },

    /** Pretraga kroz znanje (vraca dijelove koji sadrze pojam). */
    nadji(pojam, { max = 5, arhiva = true } = {}) {
      const k = osvjezi();
      const rez = [];
      const p = String(pojam || '').toLowerCase();
      if (!p) return rez;
      for (const f of k.fajlovi) {
        let tekst = '';
        try { tekst = fs.readFileSync(f.putanja, 'utf8'); } catch { continue; }
        const linije = tekst.split('\n');
        for (let i = 0; i < linije.length; i++) {
          if (linije[i].toLowerCase().includes(p)) {
            rez.push({ fajl: f.ime, linija: i + 1, tekst: linije.slice(Math.max(0, i - 1), i + 3).join('\n').slice(0, 400) });
            if (rez.length >= max) return rez;
          }
        }
      }
      // i kroz ARHIVU (17.000+ razgovora) — samo veci fajlovi, da bude brzo
      if (arhiva && rez.length < max) {
        for (const f of arhivaFajlovi()) {
          let tekst = '';
          try {
            const fd = fs.openSync(f.putanja, 'r');
            const buf = Buffer.alloc(Math.min(f.velicina, 400_000));
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            fs.closeSync(fd);
            tekst = buf.subarray(0, n).toString('utf8');
          } catch { continue; }
          const linije = tekst.split('\n');
          for (let i = 0; i < linije.length; i++) {
            if (linije[i].toLowerCase().includes(p)) {
              rez.push({ fajl: 'ARHIVA/' + f.ime, linija: i + 1, tekst: linije.slice(Math.max(0, i - 1), i + 3).join('\n').slice(0, 400), arhiva: true });
              if (rez.length >= max) return rez;
            }
          }
        }
      }
      return rez;
    },

    /** Koliko razgovora ima u arhivi (za prikaz). */
    arhivaInfo() {
      const f = arhivaFajlovi();
      return { fajlova: f.length, mb: Number((f.reduce((a, x) => a + x.velicina, 0) / 1048576).toFixed(1)) };
    },

    osvjezi,
    osvjeziArhivu(force = false) { kesArhiva.at = 0; return arhivaFajlovi(force); },
  };
}
