/**
 * Minimalni cron (bez zavisnosti). Podržava: * , brojeve, liste (1,2,3), raspone (1-5), korake (x/n).
 * Format: "minut sat danUMjesecu mjesec danUNedjelji" — npr. "0 8 * * 1-5" (radnim danima u 08:00).
 */
export function cronMatches(expr, date = new Date()) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Neispravan cron izraz: "${expr}" (očekivano 5 polja)`);
  const [min, hour, dom, mon, dow] = parts;
  return (
    fieldMatches(min, date.getMinutes()) &&
    fieldMatches(hour, date.getHours()) &&
    fieldMatches(dom, date.getDate()) &&
    fieldMatches(mon, date.getMonth() + 1) &&
    fieldMatches(dow, date.getDay())
  );
}

function fieldMatches(pattern, value) {
  if (pattern === '*') return true;
  for (const part of String(pattern).split(',')) {
    const token = part.trim();
    if (token.startsWith('*/')) {
      const step = Number(token.slice(2));
      if (!Number.isInteger(step) || step <= 0) throw new Error(`Neispravan korak u cron izrazu: "${token}"`);
      if (value % step === 0) return true;
      continue;
    }
    if (token.includes('-')) {
      const [a, b] = token.split('-').map((x) => Number(x.trim()));
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`Neispravan raspon u cron izrazu: "${token}"`);
      if (value >= a && value <= b) return true;
      continue;
    }
    const num = Number(token);
    if (!Number.isInteger(num)) {
      // Imenovani mjeseci/dani (JAN, MON) namjerno NISU podržani — bolje glasna greška nego tiha.
      throw new Error(`Nepoznat cron token: "${token}" (podržano: brojevi, *, liste, rasponi, */n)`);
    }
    if (num === value) return true;
  }
  return false;
}

/** Dozvoljeni opsezi po polju: minut, sat, dan u mjesecu, mjesec, dan u nedjelji. */
const FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** Provjera izraza prije upotrebe — sintaksna, baca grešku sa objašnjenjem. */
export function validateCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Neispravan cron izraz: "${expr}" (očekivano 5 polja: minut sat dan mjesec dan-nedjelje)`);
  parts.forEach((field, i) => {
    const [min, max] = FIELD_RANGES[i];
    for (const rawToken of field.split(',')) {
      const token = rawToken.trim();
      if (token === '*') continue;
      if (token.startsWith('*/')) {
        const step = Number(token.slice(2));
        if (!Number.isInteger(step) || step <= 0) throw new Error(`Neispravan korak "${token}" u polju ${i + 1}`);
        continue;
      }
      if (token.includes('-')) {
        const [a, b] = token.split('-').map((x) => Number(x.trim()));
        if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`Neispravan raspon "${token}" u polju ${i + 1}`);
        if (a < min || b > max || a > b) throw new Error(`Raspon "${token}" je izvan opsega ${min}-${max} (polje ${i + 1})`);
        continue;
      }
      const num = Number(token);
      if (!Number.isInteger(num)) throw new Error(`Nepoznat token "${token}" u polju ${i + 1} (imena mjeseci/dana nisu podržana)`);
      if (num < min || num > max) throw new Error(`Vrijednost ${num} je izvan opsega ${min}-${max} (polje ${i + 1})`);
    }
  });
  return true;
}

/** Sljedeći trenutak koji zadovoljava cron, počev od `from` (isključivo). */
export function nextCronAt(expr, from = Date.now(), { maxMinutes = 366 * 24 * 60 } = {}) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < maxMinutes; i += 1) {
    if (cronMatches(expr, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

export function describeSchedule(schedule = {}) {
  switch (schedule.type) {
    case 'once':
      return `jednom (${schedule.at ? new Date(schedule.at).toISOString() : 'odmah'})`;
    case 'interval':
      return `svakih ${Math.round((schedule.everyMs ?? 0) / 1000)}s`;
    case 'cron':
      return `cron "${schedule.cron}"`;
    default:
      return 'ručno pokretanje';
  }
}
