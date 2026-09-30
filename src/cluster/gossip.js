/**
 * ZASTARJELO (v0.6.0): ovo je stariji **TCP** gossip sa `net` modulom (v0.5).
 * Smernice traže **UDP (dgram)** SWIM — kanonska implementacija je `src/gossip.js`.
 * Ovaj fajl ostaje zbog kompatibilnosti `src/cluster/node.js`; nove stvari idu u `src/gossip.js`.
 *
 * Gossip protokol — membership i epidemijsko širenje poruka preko TCP-a, bez npm zavisnosti.
 *
 * Model (klasičan SWIM-ov duh, pojednostavljen):
 *   • svaki čvor ima `nodeId` (stabilan) i `incarnation` (raste kad čvor „uskrsne" poslije lažne smrti)
 *   • `heartbeat` svakih `intervalMs`; čvor koji se ne javi `suspectMs` → `suspect`, `deadMs` → `dead`
 *   • poruke se šire epidemijski: `disseminate` sa `ttl` hopova (nema beskonačnog kruženja)
 *   • svaka poruka je HMAC-potpisana (`NMQ_CLUSTER_SECRET`) — nepotpisan/tuđ potpis se odbija
 *
 * Sigurnosna namjera: ovaj sloj NE dozvoljava proizvoljan sadržaj. Dozvoljeni su samo tipovi iz
 * `ALLOWED_MESSAGE_TYPES`, a sadržaj dodatno prolazi kroz swarm medijaciju u `node.js`.
 */
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { iso } from '../core/clock.js';
import { uid } from '../core/ids.js';
import { ClusterError, ValidationError } from '../core/errors.js';

export const ALLOWED_MESSAGE_TYPES = ['join', 'welcome', 'heartbeat', 'membership', 'disseminate', 'swarm_message', 'task_announce', 'leave'];

export const DEFAULT_GOSSIP = {
  intervalMs: 2000,
  suspectMs: 6000,
  deadMs: 15_000,
  fanout: 3,
  ttl: 4,
  maxMessageBytes: 32 * 1024,
  maxInboundPerMin: 600,
};

const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');
export const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

/**
 * Pokreće jedan gossip čvor.
 * @param {object} opts { nodeId, host, port, secret, config, logger, metrics, onMessage }
 */
export async function createGossipNode({ nodeId = uid('node'), host = '127.0.0.1', port = 0, advertiseHost = null, secret, config = {}, logger, metrics, onMessage = null, onMembership = null }) {
  if (!secret) throw new ValidationError('Gossip traži "secret" (NMQ_CLUSTER_SECRET) — bez potpisa svaki čvor bi mogao da se lažno predstavi');
  const cfg = { ...DEFAULT_GOSSIP, ...(config ?? {}) };
  const emitter = new EventEmitter();
  const members = new Map(); // nodeId -> { nodeId, host, port, incarnation, status, lastSeen, joinedAt }
  const seen = new Map(); // messageId -> ts (deduplikacija epidemijskog širenja)
  const inboundWindow = [];
  let incarnation = 1;
  let server = null;
  let boundPort = port;
  let timer = null;
  let stopped = false;

  members.set(nodeId, { nodeId, host: advertiseHost ?? host, port, incarnation, status: 'alive', lastSeen: Date.now(), joinedAt: iso(), self: true });

  function envelope(type, payload, { ttl = cfg.ttl, hops = 0, messageId = null } = {}) {
    if (!ALLOWED_MESSAGE_TYPES.includes(type)) throw new ValidationError(`Nedozvoljen tip gossip poruke: ${type}`);
    const body = { v: 1, id: messageId ?? uid('gmsg'), type, from: nodeId, incarnation, ttl, hops, ts: Date.now(), payload };
    const raw = JSON.stringify(body);
    if (Buffer.byteLength(raw) > cfg.maxMessageBytes) throw new ClusterError(`Gossip poruka je prevelika (${Buffer.byteLength(raw)} B > ${cfg.maxMessageBytes} B)`);
    return JSON.stringify({ body, sig: sign(secret, raw) });
  }

  function verify(frame) {
    if (!frame || typeof frame !== 'object' || !frame.body || !frame.sig) return { ok: false, reason: 'nema_potpisa' };
    const raw = JSON.stringify(frame.body);
    if (!safeEqual(frame.sig, sign(secret, raw))) return { ok: false, reason: 'losi_potpis' };
    if (!ALLOWED_MESSAGE_TYPES.includes(frame.body.type)) return { ok: false, reason: 'nedozvoljen_tip' };
    if (Math.abs(Date.now() - Number(frame.body.ts ?? 0)) > 120_000) return { ok: false, reason: 'istekao_timestamp' };
    return { ok: true, body: frame.body };
  }

  function allowInbound() {
    const now = Date.now();
    while (inboundWindow.length && now - inboundWindow[0] > 60_000) inboundWindow.shift();
    if (inboundWindow.length >= cfg.maxInboundPerMin) return false;
    inboundWindow.push(now);
    return true;
  }

  function upsertMember(info) {
    const existing = members.get(info.nodeId);
    // VAŽNO: `self` se NIKAD ne preuzima od udaljenog čvora — inače tuđi zapis postane „ja" i watchdog
    // ga preskače (bug: član nikad ne postane suspect/dead jer ga sweep preskoči kao sebe).
    const merged = { ...(existing ?? {}), ...info, self: info.nodeId === nodeId, lastSeen: Date.now(), status: 'alive' };
    // Karantin je STICKY: heartbeat od karantinovanog člana ne smije ga vratiti u život
    // (inače bi čvor koji je poslao skriveni kanal „ozdravio" čim pošalje sljedeći heartbeat).
    if (existing?.quarantinedAt && !merged.releasedAt) {
      merged.status = 'dead';
      merged.quarantinedAt = existing.quarantinedAt;
      merged.quarantineReason = existing.quarantineReason;
    }
    members.set(info.nodeId, merged);
    onMembership?.(merged, existing ? 'updated' : 'joined');
    emitter.emit('membership', merged);
    return merged;
  }

  function membershipList() {
    return [...members.values()].map(({ nodeId: id, host: h, port: p, incarnation: inc, status, lastSeen }) => ({ nodeId: id, host: h, port: p, incarnation: inc, status, lastSeen: new Date(lastSeen).toISOString() }));
  }

  async function sendTo(member, frame, { timeout = 1500 } = {}) {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: member.host, port: member.port }, () => {
        // newline je delimiter okvira na žici (server čita do '\n' ili do 'end')
        socket.write(`${frame}\n`);
        socket.end();
      });
      const done = (result) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(timeout, () => done({ ok: false, reason: 'timeout' }));
      socket.on('error', (err) => done({ ok: false, reason: err.code ?? err.message }));
      socket.on('close', () => done({ ok: true }));
    });
  }

  /** Epidemijsko širenje: pošalji `fanout` slučajno odabranim živim članovima (osim sebe). */
  async function disseminate(type, payload, { ttl = cfg.ttl } = {}) {
    const frame = envelope(type, payload, { ttl });
    const body = JSON.parse(frame).body;
    seen.set(body.id, Date.now());
    const targets = membershipList()
      .filter((m) => !m.self && m.status === 'alive')
      .sort(() => Math.random() - 0.5)
      .slice(0, cfg.fanout);
    const results = await Promise.all(targets.map((m) => sendTo(m, frame)));
    metrics?.inc('cluster_gossip_sent_total', { type });
    return { messageId: body.id, targets: targets.length, delivered: results.filter((r) => r.ok).length };
  }

  function handleFrame(raw) {
    if (!allowInbound()) {
      metrics?.inc('cluster_gossip_rate_limited_total', {});
      return { ok: false, reason: 'rate_limit' };
    }
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'nije_json' };
    }
    const verdict = verify(frame);
    if (!verdict.ok) {
      metrics?.inc('cluster_gossip_rejected_total', { reason: verdict.reason });
      emitter.emit('rejected', { reason: verdict.reason, from: frame?.body?.from ?? null });
      return verdict;
    }
    const body = verdict.body;
    // Deduplikacija: već viđenu poruku NE obrađujemo ponovo (sprečava petlje i duple efekte).
    // Ranije se `seen` samo punio, a nikad čitao.
    if (seen.has(body.id)) {
      metrics?.inc('cluster_gossip_duplicates_total', { type: body.type });
      return { ok: true, type: body.type, duplicate: true };
    }
    seen.set(body.id, Date.now());
    // Refutacija: poruka od člana kojeg smo proglasili mrtvim, sa VIŠOM incarnacijom, oživljava člana
    const knownMember = members.get(body.from);
    if (knownMember && !knownMember.self && knownMember.status !== 'alive' && Number(body.incarnation ?? 0) > Number(knownMember.incarnation ?? 0)) {
      knownMember.incarnation = Number(body.incarnation);
      knownMember.status = 'alive';
      knownMember.lastSeen = Date.now();
      metrics?.inc('cluster_membership_refutations_total', {});
      logger?.warn?.('cluster.member_refuted', { nodeId: body.from, incarnation: body.incarnation });
    }
    metrics?.inc('cluster_gossip_received_total', { type: body.type });

    if (body.type === 'join') {
      upsertMember({ nodeId: body.from, host: body.payload?.host, port: body.payload?.port, incarnation: body.incarnation });
      // Odgovori odmah (welcome) — bez ovoga novi član čeka sljedeći heartbeat i membership je spor/flaky
      const joiner = { host: body.payload?.host, port: body.payload?.port };
      if (joiner.host && joiner.port) {
        sendTo(joiner, envelope('welcome', { host: advertiseHost ?? host, port: boundPort, members: membershipList() })).catch(() => {});
      }
    }
    if (body.type === 'welcome' || body.type === 'heartbeat') upsertMember({ nodeId: body.from, host: body.payload?.host, port: body.payload?.port, incarnation: body.incarnation });
    if (body.type === 'leave') {
      const m = members.get(body.from);
      if (m) {
        m.status = 'left';
        onMembership?.(m, 'left');
        emitter.emit('membership', m);
      }
    }
    if (body.type === 'membership' || body.type === 'welcome') {
      upsertMember({ nodeId: body.from, host: body.payload?.host, port: body.payload?.port, incarnation: body.incarnation });
      for (const info of body.payload?.members ?? []) if (info.nodeId !== nodeId) upsertMember(info);
    }

    onMessage?.(body);
    emitter.emit('message', body);
    emitter.emit(body.type, body);

    // Prosleđivanje dalje (epidemijski) — samo ako TTL dozvoljava i poruku nismo već vidjeli
    if (body.ttl > 0 && body.hops < 16) {
      const forward = envelope(body.type, body.payload, { ttl: body.ttl - 1, hops: body.hops + 1, messageId: body.id });
      const targets = membershipList()
        .filter((m) => !m.self && m.status === 'alive' && m.nodeId !== body.from)
        .sort(() => Math.random() - 0.5)
        .slice(0, cfg.fanout);
      for (const target of targets) sendTo(target, forward).catch(() => {});
    }
    return { ok: true, type: body.type };
  }

  function startServer() {
    return new Promise((resolve, reject) => {
      server = net.createServer((socket) => {
        let data = '';
        let processed = false;
        socket.setEncoding('utf8');
        socket.setTimeout(2500, () => socket.destroy());
        const processBuffer = () => {
          if (processed) return;
          const line = data
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)[0];
          if (!line) return;
          processed = true;
          handleFrame(line);
        };
        socket.on('data', (chunk) => {
          data += chunk;
          if (data.length > cfg.maxMessageBytes) {
            socket.destroy();
            return;
          }
          if (data.includes('\n')) {
            processBuffer();
            socket.end();
          }
        });
        // Fallback: ako klijent ne pošalje '\n', obradi ono što je stiglo kad se veza zatvori
        socket.on('end', processBuffer);
        socket.on('close', processBuffer);
        socket.on('error', () => {});
      });
      server.on('error', reject);
      server.listen(port, host, () => {
        boundPort = server.address().port;
        // `unref` da server sam ne drži event loop živ (proces se može ugasiti kad se sve ostalo zatvori)
        if (server.unref) server.unref();
        const self = members.get(nodeId);
        self.port = boundPort;
        resolve(boundPort);
      });
    });
  }

  function sweep() {
    const now = Date.now();
    for (const m of members.values()) {
      if (m.self || m.status === 'left' || m.quarantinedAt) continue; // karantinovane ne „oživljavamo" automatski
      const silence = now - m.lastSeen;
      const next = silence > cfg.deadMs ? 'dead' : silence > cfg.suspectMs ? 'suspect' : 'alive';
      if (next !== m.status) {
        m.status = next;
        metrics?.inc('cluster_membership_changes_total', { status: next });
        onMembership?.(m, next);
        emitter.emit('membership', m);
        logger?.warn?.('cluster.member_status', { nodeId: m.nodeId, status: next });
      }
    }
    for (const [id, ts] of seen) if (now - ts > 300_000) seen.delete(id);
  }

  const api = {
    nodeId,
    ALLOWED_MESSAGE_TYPES,
    settings: cfg,
    members,
    get port() {
      return boundPort;
    },
    get incarnation() {
      return incarnation;
    },
    on: (...a) => emitter.on(...a),
    membershipList,
    memberCount: () => membershipList().filter((m) => m.status === 'alive').length,

    async start() {
      await startServer();
      if (timer) clearInterval(timer);
      timer = setInterval(async () => {
        if (stopped) return;
        sweep();
        await api.broadcast('heartbeat', { host: advertiseHost ?? host, port: boundPort }, { ttl: 1 }).catch(() => {});
      }, cfg.intervalMs);
      if (timer.unref) timer.unref();
      logger?.info?.('cluster.gossip_started', { nodeId, host, port: boundPort, members: members.size });
      return { nodeId, host, port: boundPort };
    },

    async join(peers = []) {
      const list = Array.isArray(peers) ? peers : [peers];
      const results = [];
      for (const peer of list) {
        const [h, p] = String(peer).split(':');
        const target = { host: h, port: Number(p) };
        const frame = envelope('join', { host: advertiseHost ?? host, port: boundPort });
        const res = await sendTo(target, frame);
        results.push({ peer, ...res });
        if (res.ok) {
          const tempMember = { nodeId: `unknown:${peer}`, host: target.host, port: target.port };
          await sendTo(tempMember, envelope('membership', { members: membershipList() }));
        }
      }
      metrics?.inc('cluster_join_attempts_total', {});
      return results;
    },

    async leave() {
      const res = await api.broadcast('leave', {}, { ttl: 2 }).catch(() => null);
      stopped = true;
      if (timer) clearInterval(timer);
      return res;
    },

    broadcast: (type, payload, opts) => disseminate(type, payload, opts),

    /** Test hook: ubaci sirov okvir (za provjeru HMAC-a i odbijanja). */
    handleRaw: (raw) => handleFrame(raw),
    envelope,
    verify,

    /** Označi člana kao suspect/dead ručno (npr. kad safety otkrije sumnjivo ponašanje). */
    quarantineMember(id, reason = 'manual') {
      const m = members.get(id);
      if (!m) return { ok: false, reason: 'nepoznat_clan' };
      m.status = 'dead';
      m.quarantinedAt = iso();
      m.quarantineReason = reason;
      logger?.error?.('cluster.member_quarantined', { nodeId: id, reason });
      return { ok: true, nodeId: id, status: 'dead', reason, sticky: true };
    },

    /** Skida karantin (samo čovjek/board) — poslije ovoga član ponovo može biti živ. */
    releaseMember(id, { by = 'board' } = {}) {
      const m = members.get(id);
      if (!m) return { ok: false, reason: 'nepoznat_clan' };
      m.quarantinedAt = null;
      m.quarantineReason = null;
      m.releasedAt = iso();
      m.status = 'alive';
      m.lastSeen = Date.now();
      logger?.warn?.('cluster.member_released', { nodeId: id, by });
      return { ok: true, nodeId: id, status: 'alive' };
    },

    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
      return true;
    },
  };

  return api;
}
