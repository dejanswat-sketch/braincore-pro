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
    if (part.startsWith('*/')) {
      const step = Number(part.slice(2));
      if (step > 0 && value % step === 0) return true;
      continue;
    }
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && value >= a && value <= b) return true;
      continue;
    }
    if (Number(part) === value) return true;
  }
  return false;
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
