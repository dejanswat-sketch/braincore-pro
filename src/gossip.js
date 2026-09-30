/**
 * Gossip — UDP (dgram) SWIM pojednostavljen protokol. Bez ijedne npm zavisnosti.
 *
 * Specifikacija (iz „Punih smernica"):
 *   • `dgram.createSocket('udp4')`, PING / ACK / PING_REQ poruke
 *   • interval 300ms, fanout 2, failure timeout 1200ms
 *   • 3 node-a se moraju naći za <2s, nijedan nije master
 *   • Node.js built-ins samo: dgram, crypto, events
 *
 * Kako radi:
 *   1. PING nosi membership „tračeve" (dissemination) — nema dodatnog kanala.
 *   2. Svaki PING ide na `fanout` slučajno odabranih živih članova + na sve `peers` (bootstrap).
 *   3. Ako član ne odgovori `failureTimeoutMs` → `suspect`; ako ne odgovori 2× → `dead`.
 *   4. `incarnation` raste kad član „uskrsne" (refutacija lažne smrti).
 *   5. UDP broadcast (opciono) omogućava pronalaženje bez ikakve liste peer-ova (LAN).
 *   6. Svaka poruka je HMAC-potpisana tajnom klastera — tuđ potpis se odbija.
 */
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { iso } from './core/clock.js';
import { uid } from './core/ids.js';
import { ValidationError } from './core/errors.js';

export const GOSSIP_DEFAULTS = {
  intervalMs: 300, // spec: 300ms
  fanout: 2, // spec: fanout 2
  failureTimeoutMs: 1200, // spec: failure timeout 1200ms
  deadAfterMisses: 2,
  incarnationBumpMs: 2000,
  maxDatagramBytes: 8192, // UDP sigurnost (izbjegavamo fragmentaciju)
  broadcast: false,
  broadcastPort: 0, // 0 = isti port kao gossip (za LAN discovery)
  maxSeenIds: 2000,
  maxInboundPerMin: 1200, // zaštita UDP ulaza od floodinga (spec nije propisao broj)
};

export const MESSAGE_TYPES = ['PING', 'ACK', 'PING_REQ', 'LEAVE', 'DISSEMINATE'];

const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

/**
 * @param {object} opts
 * @param {string} opts.nodeId
 * @param {number} opts.port         UDP port (0 = efemerni)
 * @param {string} opts.host         adresa na koju se bind-uje
 * @param {string} opts.advertiseHost adresa koju objavljujemo drugima (za NAT/container)
 * @param {string} opts.secret       HMAC tajna (obavezno)
 * @param {string[]} opts.peers      bootstrap peer-ovi ("host:port")
 */
export function createGossip({ nodeId = uid('node'), port = 8001, host = '0.0.0.0', advertiseHost = '127.0.0.1', secret, peers = [], config = {}, logger, metrics, onMessage = null, onMembership = null, status = null } = {}) {
  if (!secret) throw new ValidationError('Gossip traži "secret" (bez potpisa svaki node bi mogao da se lažno predstavi)');
  const cfg = { ...GOSSIP_DEFAULTS, ...(config ?? {}) };
  const emitter = new EventEmitter();
  const members = new Map(); // nodeId -> { nodeId, host, port, incarnation, status, lastSeen, misses, self }
  const seen = new Map(); // messageId -> ts (deduplikacija)
  const pendingProbes = new Map(); // "nodeId" -> { sends, timer }
  let socket = null;
  let bcast = null;
  let boundPort = port;
  let incarnation = 1;
  let timer = null;
  let stopped = false;
  const stats = { sent: 0, received: 0, rejected: 0, duplicates: 0, timeouts: 0, rateLimited: 0 };
  const inbound = []; // vremenski žigovi ulaznih poruka (sliding window za rate limit)

  members.set(nodeId, { nodeId, host: advertiseHost, port, incarnation, status: 'alive', lastSeen: Date.now(), misses: 0, self: true });

  const peersParsed = new Set(
    (Array.isArray(peers) ? peers : String(peers).split(',')).filter(Boolean).map((p) => String(p).trim()),
  );

  // ── poruke ────────────────────────────────────────────────────────────────
  function frame(type, payload = {}, extra = {}) {
    if (!MESSAGE_TYPES.includes(type)) throw new ValidationError(`Nedozvoljen tip gossip poruke: ${type}`);
    const body = { v: 1, id: extra.id ?? uid('gp'), type, nodeId, incarnation, ts: Date.now(), payload, ...extra };
    const raw = JSON.stringify(body);
    if (Buffer.byteLength(raw) > cfg.maxDatagramBytes) {
      // Skrati disseminaciju umjesto da pošaljemo preveliki datagram (UDP fragmentacija = gubici)
      body.payload = { truncated: true, count: Array.isArray(payload?.items) ? payload.items.length : 0 };
    }
    const json = JSON.stringify(body);
    return Buffer.from(JSON.stringify({ body: JSON.parse(json), sig: sign(secret, json) }));
  }

  function verify(buf) {
    let outer;
    try {
      outer = JSON.parse(buf.toString('utf8'));
    } catch {
      return { ok: false, reason: 'nije_json' };
    }
    if (!outer?.body || !outer?.sig) return { ok: false, reason: 'nema_potpisa' };
    const raw = JSON.stringify(outer.body);
    if (!safeEqual(outer.sig, sign(secret, raw))) return { ok: false, reason: 'losi_potpis' };
    if (!MESSAGE_TYPES.includes(outer.body.type)) return { ok: false, reason: 'nedozvoljen_tip' };
    if (Math.abs(Date.now() - Number(outer.body.ts ?? 0)) > 120_000) return { ok: false, reason: 'istekao_timestamp' };
    return { ok: true, body: outer.body };
  }

  // ── membership ────────────────────────────────────────────────────────────
  /**
   * Upiši/obnovi člana.
   *
   * `direct: true` = poruka je STIGLA OD TOG ČVORA (PING/ACK) → to je dokaz života, `lastSeen` se osvježava.
   * `direct: false` = član je došao iz TUĐEG digest-a (tračevi) → smije ga samo UPISATI ako je nepoznat.
   * Bez ovoga bi tračevi vječno "produžavali život" mrtvom čvoru i failure detection ne bi radio
   * (dokazano chaos testom: node ubijen SIGKILL-om nije bio proglašen mrtvim >6s).
   */
  function upsertMember(info, { direct = true } = {}) {
    const existing = members.get(info.nodeId);
    if (existing && !direct) {
      // Znamo ga; liveness se NE dira na osnovu tuđih tračeva. Jedino karantin ostaje sticky.
      if (existing.quarantinedAt && existing.status !== 'dead') existing.status = 'dead';
      return existing;
    }
    let status = 'alive';
    // Karantin (iz safety sloja) je „sticky": PING od karantinovanog člana ga ne vraća u život
    if (existing?.quarantinedAt && !info.released) status = 'dead';
    const merged = {
      ...(existing ?? {}),
      nodeId: info.nodeId,
      host: info.host ?? existing?.host ?? null,
      port: info.port ?? existing?.port ?? null,
      incarnation: Math.max(Number(info.incarnation ?? 0), Number(existing?.incarnation ?? 0)),
      status,
      // Ne dozvoli da poruka BEZ statusa (npr. ACK bez opterećenja) pregazi poznato opterećenje
      load: info.load ?? existing?.load ?? null,
      tasksDone: info.tasksDone ?? existing?.tasksDone ?? null,
      lastSeen: Date.now(),
      misses: 0,
      self: info.nodeId === nodeId,
      quarantinedAt: existing?.quarantinedAt ?? null,
    };
    members.set(info.nodeId, merged);
    if (!existing || existing.status !== merged.status) {
      metrics?.inc('gossip_membership_changes_total', { status: merged.status });
      onMembership?.(merged, existing ? 'updated' : 'joined');
      emitter.emit('membership', merged);
    }
    return merged;
  }

  function markFailed(memberId) {
    const m = members.get(memberId);
    if (!m || m.self || m.quarantinedAt) return;
    m.misses = (m.misses ?? 0) + 1;
    const next = m.misses >= cfg.deadAfterMisses ? 'dead' : 'suspect';
    if (m.status !== next) {
      m.status = next;
      metrics?.inc('gossip_membership_changes_total', { status: next });
      onMembership?.(m, next);
      emitter.emit('membership', m);
      logger?.warn?.('gossip.member_status', { nodeId: memberId, status: next, misses: m.misses });
    }
  }

  function membershipList() {
    return [...members.values()].map(({ nodeId: id, host: h, port: p, incarnation: i, status, lastSeen, load, tasksDone }) => ({
      nodeId: id,
      host: h,
      port: p,
      incarnation: i,
      status,
      load: load ?? null,
      tasksDone: tasksDone ?? null,
      lastSeen: new Date(lastSeen).toISOString(),
    }));
  }

  /** Stanje čvora koje putuje uz svaki PING (za poređenje opterećenja: „ko je slobodniji"). */
  function statusPayload() {
    try {
      return status?.() ?? {};
    } catch {
      return {};
    }
  }

  /** „Tračevi" koje nosi svaki PING: živi članovi + opciona disseminacija. */
  function gossipDigest(extraItems = []) {
    const alive = membershipList().filter((m) => m.status !== 'dead' && m.nodeId !== nodeId);
    return { members: alive.slice(0, 12), items: extraItems.slice(0, 8), ...statusPayload() };
  }

  const outbox = []; // disseminacija koja čeka sljedeći PING

  function targetList() {
    const alive = [...members.values()].filter((m) => !m.self && m.status !== 'dead' && !m.quarantinedAt && m.host && m.port);
    const chosen = new Map();
    for (const p of peersParsed) {
      const [h, pt] = p.split(':');
      chosen.set(`${h}:${pt}`, { host: h, port: Number(pt) });
    }
    for (const m of alive.sort(() => Math.random() - 0.5).slice(0, Math.max(cfg.fanout, 1))) chosen.set(`${m.host}:${m.port}`, { host: m.host, port: m.port });
    return [...chosen.values()];
  }

  function send(target, buf) {
    if (!socket) return;
    stats.sent += 1;
    metrics?.inc('gossip_messages_sent_total', {});
    socket.send(buf, target.port, target.host, (err) => {
      if (err) logger?.debug?.('gossip.send_failed', { target, error: err.message });
    });
  }

  function probe() {
    if (stopped) return;
    const items = outbox.splice(0, 8);
    const targets = targetList();
    for (const t of targets) send(t, frame('PING', gossipDigest(items), { probe: `${nodeId}:${Date.now()}` }));
    // Timeout: ako u `failureTimeoutMs` nije stigao ni ACK ni PING od člana → suspect/dead
    for (const m of [...members.values()]) {
      if (m.self || m.quarantinedAt || m.status === 'dead') continue;
      const silence = Date.now() - (m.lastSeen ?? 0);
      if (silence > cfg.failureTimeoutMs) markFailed(m.nodeId);
    }
  }

  function handle(buf, rinfo) {
    stats.received += 1;
    // Rate limit na ULAZU: UDP nema vezu, pa je flooding realan rizik
    const nowMs = Date.now();
    while (inbound.length && nowMs - inbound[0] > 60_000) inbound.shift();
    if (inbound.length >= cfg.maxInboundPerMin) {
      stats.rateLimited = (stats.rateLimited ?? 0) + 1;
      metrics?.inc('gossip_rate_limited_total', {});
      return;
    }
    inbound.push(nowMs);
    const verdict = verify(buf);
    if (!verdict.ok) {
      stats.rejected += 1;
      metrics?.inc('gossip_rejected_total', { reason: verdict.reason });
      emitter.emit('rejected', { reason: verdict.reason, from: `${rinfo.address}:${rinfo.port}` });
      return;
    }
    const body = verdict.body;
    if (seen.has(body.id)) {
      stats.duplicates += 1;
      metrics?.inc('gossip_duplicates_total', {});
      return;
    }
    seen.set(body.id, Date.now());
    if (seen.size > cfg.maxSeenIds) seen.delete(seen.keys().next().value);

    // Refutacija: član za kojeg smo mislili da je mrtav, sa višom inkarnacijom
    const known = members.get(body.nodeId);
    if (known && known.status !== 'alive' && Number(body.incarnation) >= Number(known.incarnation)) {
      incarnation = Math.max(incarnation, Number(body.incarnation) + 1);
    }
    const info = { nodeId: body.nodeId, host: body.payload?.host ?? rinfo.address, port: body.payload?.port ?? rinfo.port, incarnation: body.incarnation, load: body.payload?.load ?? null, tasksDone: body.payload?.tasksDone ?? null };
    upsertMember(info);

    if (body.type === 'PING') {
      send({ host: rinfo.address, port: body.payload?.port ?? rinfo.port }, frame('ACK', { host: advertiseHost, port: boundPort, members: gossipDigest().members, ackTo: body.id, ...statusPayload() }));
      // nauči članove iz digest-a (samo ih UPISUJE; liveness se ne dira tuđim tračevima)
      for (const m of body.payload?.members ?? []) if (m.nodeId !== nodeId && m.status !== 'dead') upsertMember(m, { direct: false });
      // primi disseminaciju
      for (const item of body.payload?.items ?? []) deliver(item);
    }
    if (body.type === 'ACK') {
      for (const m of body.payload?.members ?? []) if (m.nodeId !== nodeId && m.status !== 'dead') upsertMember(m, { direct: false });
    }
    if (body.type === 'PING_REQ') {
      // Indirektna sonda: zamoli treći čvor da pinguje cilj (SWIM)
      const target = body.payload?.target;
      if (target) {
        const tm = members.get(target);
        if (tm) send({ host: tm.host, port: tm.port }, frame('PING', { host: advertiseHost, port: boundPort, indirectFor: body.nodeId }));
      }
    }
    if (body.type === 'LEAVE') {
      const m = members.get(body.nodeId);
      if (m) {
        m.status = 'left';
        onMembership?.(m, 'left');
        emitter.emit('membership', m);
      }
    }
    if (body.type === 'DISSEMINATE') deliver(body.payload);
    onMessage?.(body);
    emitter.emit('message', body);
    emitter.emit(body.type, body);
  }

  function deliver(item) {
    if (!item) return;
    emitter.emit('disseminate', item);
    onMessage?.({ type: 'DISSEMINATE_ITEM', nodeId: 'swarm', payload: item });
  }

  async function start() {
    await new Promise((resolve, reject) => {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('error', (err) => {
        logger?.error?.('gossip.socket_error', { error: err.message });
        reject(err);
      });
      socket.on('message', handle);
      socket.bind(port, host, () => {
        boundPort = socket.address().port;
        memberSelf().port = boundPort;
        resolve();
      });
    });
    if (cfg.broadcast) {
      try {
        bcast = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        bcast.on('error', () => {});
        bcast.bind(cfg.broadcastPort || boundPort, () => {
          bcast.setBroadcast(true);
          bcast.on('message', handle);
        });
      } catch (err) {
        logger?.warn?.('gossip.broadcast_unavailable', { error: err.message });
      }
    }
    if (timer) clearInterval(timer);
    timer = setInterval(probe, cfg.intervalMs);
    if (timer.unref) timer.unref();
    logger?.info?.('gossip.started', { nodeId, port: boundPort, peers: [...peersParsed], intervalMs: cfg.intervalMs, fanout: cfg.fanout, failureTimeoutMs: cfg.failureTimeoutMs });
    return { nodeId, port: boundPort };
  }

  function memberSelf() {
    return members.get(nodeId);
  }

  /** Dodaje trač u outbox — šalje se u sljedećem PING-u (epidemijski). */
  function disseminate(item) {
    outbox.push({ ...item, from: nodeId, ts: Date.now() });
    // Odmah pošalji fanout ciljevima (da ne čekamo interval kad je važno)
    for (const t of targetList()) send(t, frame('DISSEMINATE', item));
    return { queued: outbox.length };
  }

  const api = {
    nodeId,
    GOSSIP_DEFAULTS,
    MESSAGE_TYPES,
    settings: cfg,
    members,
    stats,
    get port() {
      return boundPort;
    },
    get incarnation() {
      return incarnation;
    },
    on: (...a) => emitter.on(...a),
    membershipList,
    aliveCount: () => membershipList().filter((m) => m.status === 'alive').length,
    isAlive: (id) => members.get(id)?.status === 'alive',
    start,
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      if (socket) {
        try {
          for (const t of targetList()) send(t, frame('LEAVE', { host: advertiseHost, port: boundPort }));
        } catch {
          /* ignore */
        }
        await new Promise((resolve) => socket.close(resolve));
      }
      if (bcast) bcast.close();
      return true;
    },
    join: async (list = []) => {
      const added = [];
      for (const p of Array.isArray(list) ? list : [p => p].map((f) => f)) {
        const peer = String(p).trim();
        if (!peer || peer === `${advertiseHost}:${boundPort}`) continue;
        peersParsed.add(peer);
        const [h, pt] = peer.split(':');
        send({ host: h, port: Number(pt) }, frame('PING', { host: advertiseHost, port: boundPort, join: true }));
        added.push(peer);
      }
      return { joined: added, peers: [...peersParsed] };
    },
    broadcast: (item) => disseminate(item),
    /** Ručno označavanje mrtvog/sumnjivog člana (npr. safety incident). */
    quarantineMember: (id, reason = 'manual') => {
      const m = members.get(id);
      if (!m) return { ok: false, reason: 'nepoznat_clan' };
      m.status = 'dead';
      m.quarantinedAt = iso();
      m.quarantineReason = reason;
      logger?.error?.('gossip.member_quarantined', { nodeId: id, reason });
      return { ok: true, nodeId: id, status: 'dead', sticky: true };
    },
    releaseMember: (id, { by = 'board' } = {}) => {
      const m = members.get(id);
      if (!m) return { ok: false, reason: 'nepoznat_clan' };
      m.quarantinedAt = null;
      m.quarantineReason = null;
      m.status = 'alive';
      m.lastSeen = Date.now();
      m.misses = 0;
      logger?.warn?.('gossip.member_released', { nodeId: id, by });
      return { ok: true, nodeId: id, status: 'alive' };
    },
    /** Test hook: ubaci sirov datagram (bez mreže). */
    handleRaw: (buf, rinfo = { address: '127.0.0.1', port: 1 }) => handle(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)), rinfo),
    frame,
    verify,
    _probe: probe,
  };

  return api;
}
