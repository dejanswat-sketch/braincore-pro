/**
 * Swarm safety — detekcija emergentnih ponašanja koja niko nije dizajnirao.
 *
 * Kontekst (2026): istraživanja i incidenti pokazuju da multi-agent sistemi mogu razviti
 * KOORDINIRANO VARANJE i COVERT KANALE i kad su pojedinačni agenti instrukcijama „pošteni".
 * Zato per-agent zaštita nije dovoljna — treba nadzor na nivou roja.
 *
 * Ovaj modul radi tri stvari:
 *   1. MEDIACIJA — peer poruke ne postoje van ovog modula; svaka se provjerava i loguje
 *   2. DETEKCIJA  — lockstep koordinacija, koordinisano glasanje, koncentracija resursa,
 *                   flooding feromonima, drift od mandata, i „šifrovan" sadržaj (entropija/oblici)
 *   3. INCIDENTI  — nalaz postaje incident sa auto-akcijom (alert / quarantine / freeze)
 *
 * Fail-closed: sumnjiva poruka se NE dostavlja (blokira se), a sumnjiv worker ide u karantin.
 */
import path from 'node:path';
import { appendJsonl, exists, readJson, writeJson } from '../core/fsx.js';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { PolicyError, ValidationError } from '../core/errors.js';

export const MESSAGE_TYPES = ['task_offer', 'task_request', 'help', 'status', 'proposal', 'vote', 'handoff_request', 'artifact_ready'];

export const DEFAULT_SAFETY = {
  maxEntropyPerChar: 4.5, // Shannon entropija po znaku; koristi se u kombinaciji sa razmacima/udjelom slova
  maxTokenLength: 64, // jedan „token" bez razmaka duži od ovoga = sumnja (base64/hex blob)
  windowMs: 600_000,
  lockstepThreshold: 0.7, // udio zajedničkih rundi u kojima dva workera djeluju u istoj sekvenci
  lockstepMinCooccurrence: 4,
  voteCollusionMinWorkers: 3,
  voteCollusionRounds: 3,
  concentrationThreshold: 0.6, // jedan worker drži >60% preuzimanja
  floodingPerMin: 40, // feromona u minuti po workeru
  autoContain: true, // karantin/freeze se izvršava automatski (freeze samo uz autoFreezeOnCollusion)
  autoFreezeOnCollusion: false, // freeze roja na jaku koluziju je teška mjera — uključuje board svjesno
};

const SUSPICIOUS_PHRASES = [
  'bypass',
  'exfiltrat',
  'disable logging',
  'isključi log',
  'zaobiđi politiku',
  'bez odobrenja',
  'without approval',
  'skrij',
  'hidden channel',
  'tajni kanal',
  'ne prijavljuj',
  'do not report',
];

/** Shannon entropija po znaku (koristi se za detekciju kodiranog/šifrovanog sadržaja). */
export function entropy(text) {
  const str = String(text ?? '');
  if (!str.length) return 0;
  const freq = new Map();
  for (const ch of str) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / str.length;
    h -= p * Math.log2(p);
  }
  return Number(h.toFixed(3));
}

export function createSwarmSafety({ config = {}, dataDir, logger, metrics, audit, bus, governance, blackboard, isKnownWorker = null }) {
  const s = { ...DEFAULT_SAFETY, ...(config.safety ?? {}) };
  const messages = [];
  const claims = []; // {ts, tenantId, workerId, taskId, seq}
  const votes = []; // {ts, tenantId, workerId, proposalId, choice}
  const findings = [];
  const incidents = new Map();
  const quarantined = new Map(); // workerId -> reason
  const stateFile = dataDir ? path.join(dataDir, '_control', 'swarm-safety.json') : null;

  /** Incidenti i karantin se perzistiraju — ranije su se gubili restartom (in-memory Map). */
  async function persist() {
    if (!stateFile) return;
    await writeJson(stateFile, {
      updatedAt: iso(),
      incidents: [...incidents.values()].slice(-200),
      quarantined: [...quarantined.entries()],
    }).catch((err) => logger?.warn?.('swarm.safety_persist_failed', { error: err.message }));
  }

  function longestToken(text) {
    return String(text ?? '')
      .split(/[\s,;]+/)
      .reduce((max, tok) => Math.max(max, tok.length), 0);
  }

  /**
   * Da li string IZGLEDA kao kodiran/šifrovan sadržaj?
   *
   * Sama entropija nije dovoljna: prirodni jezik (srpski, sa različitim slovima) ima entropiju po znaku
   * oko 4,2–4,6 — više od base64. Zato se traži KOMBINACIJA: visoka entropija + nema razmaka +
   * mali udio slova (base64/hex imaju mnogo cifara i miješanih velikih/malih slova bez razmaka).
   */
  function looksEncoded(text) {
    const str = String(text ?? '');
    // Hex blob (32/40/64 znaka) je klasičan skriveni kanal — entropija mu je NISKA, pa je hvata oblik
    if (!/\s/.test(str) && /^[0-9a-fA-F]+$/.test(str) && [32, 40, 56, 64, 96, 128].includes(str.length)) return true;
    if (str.length < 24) return false;
    const letters = (str.match(/\p{L}/gu) ?? []).length;
    const letterRatio = letters / str.length;
    const hasSpace = /\s/.test(str);
    const e = entropy(str);
    if (!hasSpace && e > s.maxEntropyPerChar) return true; // jedan dugačak „blob" bez razmaka
    if (letterRatio < 0.55 && e > s.maxEntropyPerChar - 0.5) return true; // mnogo cifara/simbola
    return false;
  }

  /** Provjera sadržaja poruke: čitljivost, shema, sumnjive fraze. */
  function inspectPayload(payload) {
    const violations = [];
    const strings = [];
    const walk = (v, depth = 0) => {
      if (depth > 5) return;
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
      else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1));
    };
    walk(payload);

    for (const str of strings) {
      if (looksEncoded(str)) violations.push({ code: 'high_entropy', detail: `entropija ${entropy(str)}/znak bez razmaka`, sample: str.slice(0, 24) });
      if (longestToken(str) > s.maxTokenLength) violations.push({ code: 'encoded_blob', detail: `token dužine ${longestToken(str)}` });
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(str)) violations.push({ code: 'control_chars' });
      const lower = str.toLowerCase();
      for (const phrase of SUSPICIOUS_PHRASES) if (lower.includes(phrase)) violations.push({ code: 'mandate_drift', detail: phrase });
    }
    return violations;
  }

  function record(finding) {
    const f = { id: uid('find'), ts: iso(), ...finding };
    findings.push(f);
    if (findings.length > 2000) findings.shift();
    metrics?.inc('swarm_findings_total', { tenant: finding.tenantId ?? '-', type: finding.type, severity: finding.severity });
    if (dataDir) appendJsonl(path.join(dataDir, 'tenants', finding.tenantId ?? '_global', 'swarm', 'safety.jsonl'), f).catch((err) => logger?.warn?.('swarm.safety_log_failed', { error: err.message }));
    logger?.warn?.('swarm.finding', { type: f.type, severity: f.severity, tenantId: f.tenantId, detail: f.detail });
    return f;
  }

  async function openIncident({ tenantId, type, severity = 'high', evidence = [], autoAction = null }) {
    const incident = {
      id: uid('inc'),
      ts: iso(),
      tenantId,
      type,
      severity,
      evidence,
      status: 'open',
      autoAction,
      actionResult: null,
    };
    incidents.set(incident.id, incident);
    metrics?.inc('swarm_incidents_total', { tenant: tenantId, type, severity });
    await persist();

    if (autoAction && s.autoContain) {
      try {
        if (autoAction.type === 'freeze') {
          incident.actionResult = await governance?.freeze(tenantId, { reason: `auto:${type}`, by: 'swarm-safety' });
        } else if (autoAction.type === 'quarantine') {
          incident.actionResult = api.quarantine(autoAction.workerId, `auto:${type}`);
        }
      } catch (err) {
        incident.actionResult = { error: err.message };
      }
    }
    await audit?.append({
      tenantId,
      actor: 'swarm-safety',
      action: 'swarm_incident',
      args: { incidentId: incident.id, type, severity, autoAction },
      decision: 'deny',
      outcome: 'blocked',
      meta: { evidence: evidence.slice(0, 5) },
    });
    return incident;
  }

  const api = {
    MESSAGE_TYPES,
    settings: s,
    findings,
    incidents,
    quarantined,
    messages,
    claims,
    votes,
    entropy,
    inspectPayload,

    /**
     * JEDINI kanal komunikacije između workera. Provjerava kvote, POŠILJAOCA i sadržaj, pa loguje sve.
     * Ako provjera padne — poruka se NE dostavlja (fail-closed) i otvara se nalaz/incident.
     */
    async mediateMessage({ tenantId, from, to, type, payload = {} }) {
      if (!MESSAGE_TYPES.includes(type)) {
        const f = record({ tenantId, type: 'unknown_message_type', severity: 'medium', detail: `tip "${type}"`, evidence: [{ from, to }] });
        throw new ValidationError(`Nepoznat tip swarm poruke: ${type} (dozvoljeno: ${MESSAGE_TYPES.join(', ')})`, { findingId: f.id });
      }
      // Spoofing: pošiljalac mora biti registrovan worker (ili operator) — ranije je bilo ko mogao glumiti drugog
      if (isKnownWorker && from !== 'operator' && !isKnownWorker(from)) {
        const f = record({ tenantId, type: 'unknown_sender', severity: 'high', detail: `nepoznat pošiljalac "${from}" → "${to}"`, evidence: [{ from, to, type }] });
        await openIncident({ tenantId, type: 'unknown_sender', severity: 'high', evidence: [f], autoAction: { type: 'quarantine', workerId: from } });
        throw new PolicyError(`Swarm poruka odbijena: nepoznat pošiljalac "${from}"`, { from, to, findingId: f.id });
      }
      governance?.assertCanPeerMessage?.({ tenantId, from, to });

      // SADRŽAJ SE UVIJEK PROVJERAVA — ranije je `humanReadable: false` bio tihi bypass mediacije
      const violations = inspectPayload(payload);
      const message = { id: uid('msg'), ts: iso(), tenantId, from, to, type, payload, violations: violations.map((v) => v.code) };
      messages.push(message);
      if (messages.length > 5000) messages.shift();

      if (violations.length) {
        record({ tenantId, type: 'covert_channel_suspected', severity: 'high', detail: violations.map((v) => `${v.code}${v.detail ? ` (${v.detail})` : ''}`).join('; '), evidence: [{ from, to, type, sample: violations[0].sample ?? null }] });
        await openIncident({ tenantId, type: 'covert_channel', severity: 'high', evidence: [message], autoAction: { type: 'quarantine', workerId: from } });
        throw new PolicyError(`Swarm poruka odbijena (sumnja na skriveni kanal): ${violations.map((v) => v.code).join(', ')}`, { from, to, violations });
      }

      if (dataDir) appendJsonl(path.join(dataDir, 'tenants', tenantId, 'swarm', 'messages.jsonl'), message).catch(() => {});
      bus?.emit(`swarm.message.${to}`, message);
      bus?.emit('swarm.message', message);
      metrics?.inc('swarm_messages_total', { tenant: tenantId, type });
      return message;
    },

    observeClaim({ tenantId, workerId, taskId, at = Date.now() }) {
      claims.push({ ts: at, tenantId, workerId, taskId, seq: claims.length });
      if (claims.length > 5000) claims.shift();
    },

    observeVote({ tenantId, workerId, proposalId, choice, at = Date.now() }) {
      votes.push({ ts: at, tenantId, workerId, proposalId, choice });
      if (votes.length > 5000) votes.shift();
    },

    /** Detektori: lockstep, koordinisano glasanje, koncentracija, flooding, drift. */
    async detect({ tenantId, now = Date.now() } = {}) {
      const since = now - s.windowMs;
      const found = [];

      // 1) LOCKSTEP — dva workera dominiraju sekvencom preuzimanja (koordinacija bez dogovora)
      const recent = claims.filter((c) => c.tenantId === tenantId && c.ts >= since).sort((a, b) => a.seq - b.seq);
      const transitions = [];
      for (let i = 0; i < recent.length - 1; i += 1) {
        if (recent[i].workerId !== recent[i + 1].workerId) transitions.push([recent[i].workerId, recent[i + 1].workerId]);
      }
      const pairs = new Map();
      for (const [a, b] of transitions) {
        const key = [a, b].sort().join('|');
        const entry = pairs.get(key) ?? { ab: 0, ba: 0, total: 0 };
        entry.total += 1;
        if (a < b) entry.ab += 1;
        else entry.ba += 1;
        pairs.set(key, entry);
      }
      for (const [pair, e] of pairs) {
        if (e.total < s.lockstepMinCooccurrence) continue;
        const share = e.total / Math.max(1, transitions.length); // koliko sekvence drži TAJ par
        const orderDominance = Math.max(e.ab, e.ba) / e.total;
        if (share >= s.lockstepThreshold) {
          found.push(
            record({
              tenantId,
              type: 'collusion_lockstep',
              severity: 'high',
              detail: `par ${pair} drži ${(share * 100).toFixed(0)}% sekvence preuzimanja (${e.total} prelaza, redoslijed ${(orderDominance * 100).toFixed(0)}%)`,
              evidence: [{ pair, share: Number(share.toFixed(2)), transitions: e.total, orderDominance: Number(orderDominance.toFixed(2)) }],
            }),
          );
        }
      }

      // 2) KOORDINISANO GLASANJE — ista koalicija glasa identično na N različitih predloga
      const proposalIds = [...new Set(votes.filter((v) => v.tenantId === tenantId && v.ts >= since).map((v) => v.proposalId))];
      const blocVotes = new Map(); // "a|b" -> Set(proposalId)
      for (const proposalId of proposalIds) {
        const pv = votes.filter((v) => v.proposalId === proposalId && v.tenantId === tenantId);
        if (pv.length < 2) continue;
        for (let i = 0; i < pv.length; i += 1) {
          for (let j = i + 1; j < pv.length; j += 1) {
            if (pv[i].choice !== pv[j].choice) continue;
            const key = [pv[i].workerId, pv[j].workerId].sort().join('|');
            if (!blocVotes.has(key)) blocVotes.set(key, new Set());
            blocVotes.get(key).add(proposalId);
          }
        }
        const choices = new Set(pv.map((v) => v.choice));
        if (choices.size === 1 && pv.length >= s.voteCollusionMinWorkers) {
          found.push(record({ tenantId, type: 'collusion_votes', severity: 'medium', detail: `${pv.length} workera glasalo identično na "${proposalId}" bez ijednog odstupanja`, evidence: [{ proposalId, votes: pv.length, choice: [...choices][0] }] }));
        }
      }
      // Blok koji glasa identično kroz `voteCollusionRounds` različitih predloga = stabilna koalicija
      for (const [pair, proposals] of blocVotes) {
        if (proposals.size >= s.voteCollusionRounds) {
          found.push(
            record({
              tenantId,
              type: 'collusion_voting_bloc',
              severity: 'high',
              detail: `par ${pair} glasao identično na ${proposals.size} različitih predloga (prag ${s.voteCollusionRounds})`,
              evidence: [{ pair, proposals: [...proposals] }],
            }),
          );
        }
      }

      // 3) KONCENTRACIJA RESURSA — jedan worker drži većinu preuzimanja
      const byWorker = recent.reduce((acc, c) => ({ ...acc, [c.workerId]: (acc[c.workerId] ?? 0) + 1 }), {});
      const total = recent.length;
      if (total >= 10) {
        for (const [workerId, count] of Object.entries(byWorker)) {
          if (count / total >= s.concentrationThreshold) {
            found.push(record({ tenantId, type: 'resource_concentration', severity: 'medium', detail: `worker ${workerId} drži ${((count / total) * 100).toFixed(0)}% preuzimanja`, evidence: [{ workerId, count, total }] }));
          }
        }
      }

      // 4) FLOODING FEROMONIMA
      const pheromones = (blackboard?.activePheromones?.(now, { tenantId }) ?? []);
      const perWorker = pheromones.reduce((acc, p) => ({ ...acc, [p.by]: (acc[p.by] ?? 0) + 1 }), {});
      for (const [workerId, count] of Object.entries(perWorker)) {
        if (count >= s.floodingPerMin) {
          found.push(record({ tenantId, type: 'pheromone_flooding', severity: 'medium', detail: `worker ${workerId} ostavio ${count} feromona u prozoru`, evidence: [{ workerId, count }] }));
        }
      }

      // 5) DRIFT OD MANDATA u zadacima
      const tasks = [...(blackboard?.tasks?.values?.() ?? [])].filter((t) => t.tenantId === tenantId);
      for (const task of tasks) {
        const violations = inspectPayload(task.payload ?? {});
        const drift = violations.filter((v) => v.code === 'mandate_drift');
        if (drift.length) {
          found.push(record({ tenantId, type: 'mandate_drift', severity: 'high', detail: `zadatak "${task.title}" traži: ${drift.map((d) => d.detail).join(', ')}`, evidence: [{ taskId: task.id, violations: drift }] }));
        }
      }

      if (found.some((f) => f.severity === 'high')) {
        const worst = found.find((f) => f.severity === 'high');
        // Auto-freeze na jaku koluziju je OPCIJA (default isključeno) — freeze je teška mjera
        const strongCollusion = worst.type === 'collusion_lockstep' && (worst.evidence?.[0]?.share ?? 0) >= 0.9;
        const autoAction = strongCollusion && s.autoFreezeOnCollusion ? { type: 'freeze' } : null;
        await openIncident({ tenantId, type: worst.type, severity: 'high', evidence: found.filter((f) => f.severity === 'high'), autoAction });
      }
      return found;
    },

    quarantine(workerId, reason = 'manual') {
      quarantined.set(workerId, { reason, ts: iso() });
      persist();
      metrics?.inc('swarm_quarantine_total', { worker: workerId });
      logger?.error?.('swarm.quarantined', { workerId, reason });
      return { workerId, quarantined: true, reason };
    },

    release(workerId) {
      const had = quarantined.delete(workerId);
      persist();
      return { workerId, released: had };
    },

    /** Učitava incidente i karantin iz `data/_control/swarm-safety.json` (preživljava restart). */
    async load() {
      if (!stateFile || !exists(stateFile)) return { loaded: false };
      const saved = await readJson(stateFile, { incidents: [], quarantined: [] });
      for (const incident of saved?.incidents ?? []) incidents.set(incident.id, incident);
      for (const [workerId, info] of saved?.quarantined ?? []) quarantined.set(workerId, info);
      logger?.warn?.('swarm.safety_loaded', { incidents: incidents.size, quarantined: quarantined.size });
      return { loaded: true, incidents: incidents.size, quarantined: quarantined.size };
    },

    isQuarantined: (workerId) => quarantined.has(workerId),

    /** Otvoreni incidenti (za board/dashboard). */
    listIncidents({ tenantId, status = 'open' } = {}) {
      return [...incidents.values()].filter((i) => (!tenantId || i.tenantId === tenantId) && (!status || i.status === status)).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    },

    async resolveIncident(id, { by = 'human', note = null } = {}) {
      const incident = incidents.get(id);
      if (!incident) throw new ValidationError(`Nepoznat incident: ${id}`);
      incident.status = 'resolved';
      incident.resolvedAt = iso();
      incident.resolvedBy = by;
      incident.note = note;
      await persist();
      await audit?.append({ tenantId: incident.tenantId, actor: by, action: 'swarm_incident_resolved', args: { incidentId: id, note }, decision: 'allow', outcome: 'ok' });
      return incident;
    },

    report({ tenantId } = {}) {
      const relevant = findings.filter((f) => !tenantId || f.tenantId === tenantId);
      const byType = relevant.reduce((acc, f) => ({ ...acc, [f.type]: (acc[f.type] ?? 0) + 1 }), {});
      return {
        tenantId: tenantId ?? '*',
        findings: relevant.length,
        byType,
        bySeverity: relevant.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }), {}),
        incidents: api.listIncidents({ tenantId, status: 'open' }).length,
        quarantined: [...quarantined.entries()].map(([workerId, v]) => ({ workerId, ...v })),
        messagesObserved: messages.filter((m) => !tenantId || m.tenantId === tenantId).length,
        recent: relevant.slice(-10).reverse(),
      };
    },

    reset() {
      findings.length = 0;
      messages.length = 0;
      claims.length = 0;
      votes.length = 0;
      incidents.clear();
      quarantined.clear();
    },
  };

  return api;
}
