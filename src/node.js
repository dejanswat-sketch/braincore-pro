/**
 * Swarm NODE — jedan proces u roju. Nema mastera: svaki node je ravnopravan.
 *
 * `node src/index.js --port=8001 --peers=127.0.0.1:8002,127.0.0.1:8003`
 *
 * Sastav (po smernicama):
 *   • UDP gossip (dgram)      — ko je živ, koliko je opterećen  → `src/gossip.js`
 *   • CRDT blackboard         — dijeljeno stanje taskova i claim-ova (LWW + vektorski sat)
 *   • Task queue (LPUSH/BRPOP)— lokalni red; može i preko RESP-a (`src/shared/queue.js`)
 *   • Pheromone (TTL + decay) — tragovi koji koordiniraju bez komande
 *
 * Ključno ponašanje: **task ubačen u node A završava u node B ako je B slobodniji.**
 *   – A objavi task u CRDT (`task:<id>`) i pošalje ga gossip-om (piggyback uz PING)
 *   – svaki node vidi task; CLAIM ide kroz CRDT (deterministički LWW pobjednik)
 *   – node se prijavljuje za claim samo ako je **najslobodniji** (load ≤ najmanji load među živima)
 *   – poslije claim-a slijedi kratka verifikacija (ako je neko drugi pobijedio, node odustaje)
 *
 * Sve bez ijedne npm zavisnosti: `dgram`, `net`, `http`, `crypto`, `events`.
 */
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createGossip } from './gossip.js';
import { createCrdtBlackboard } from './shared/blackboard.js';
import { createPheromoneStore } from './shared/pheromone.js';
import { createTaskQueue } from './shared/queue.js';
import { createTicketRouter } from './support/ticket-router.js';
import { createToolRunner } from './execution/tool-runner.js';
import { createExtractor } from './research/extractor.js';
import { createGenomeRegistry } from './research/genome-registry.js';
import { createFederationClient } from './research/federation.js';
import { encryptPayload, decryptPayload } from './shared/crypto.js';
import { iso } from './core/clock.js';
import { uid } from './core/ids.js';
import { ValidationError, QueueFullError } from './core/errors.js';

export const NODE_DEFAULTS = {
  claimIntervalMs: 50,
  syncIntervalMs: 300, // CRDT sync (delta lokalnih zapisa) — nezavisan od claim petlje
  claimLeaseMs: 10_000, // koliko claim važi ako vlasnik ne odgovara (poslije toga se task vraća u igru)
  claimGraceMs: 3_000, // > najgora IZMJERENA detekcija smrti (2,2 s): bez ovoga nastaje restart-trka (soak #5: 11 duplih)
  /**
   * Koliko čekamo da vidimo da li je neko drugi preuzeo isti task.
   * MORA biti najmanje 2× gossip interval (300 ms) — inače claim drugog čvora stigne POSLIJE naše
   * verifikacije i oba čvora izvrše isti task. Chaos test je to pokazao: sa 120 ms bilo je 2 dupla
   * izvršenja u 24 taska; sa 600 ms (2× interval) to nestaje na loopback-u.
   */
  claimConfirmMs: 600,
  minClaimConfirmMs: 600,
  /** Koliko čekamo odgovor roja na `result-query` prije ponovnog izvršavanja (2× gossip interval). */
  reclaimProbeMs: 600,
  /** Durable submit: task se vraća tek kad ga bar jedan peer potvrdi (`task-received`). */
  durableSubmit: true,
  submitAckMs: 400,
  /**
   * BACKPRESSURE: koliko taskova smije čekati u redu prije nego počnemo odbijati (429).
   * Mjereno soak testom: 3 node-a u jednom procesu drže ~8 taskova/s; iznad toga red raste i p95
   * skače sa 0,8 s na 9 s. Odbijanje je iskrenije od neograničenog čekanja.
   */
  maxQueueDepth: 500,
  shedWhenBusy: true,
  /** Chaos demo: dozvoli `POST /shutdown` (systemd `Restart=always` ga vrati). Default: isključeno. */
  allowShutdown: false,
  shutdownToken: null,
  /** Kompakcija CRDT-a (GC tombstone-a) — koliko često i koliko star zapis smije biti obrisan. */
  compactionIntervalMs: 300_000,
  compactionAgeMs: 600_000,
  /** GC cijelih task:/result:/claim: zapisa (ne samo tombstone-a) — 1h soak je pokazao da tabla raste vječno. */
  gcAgeMs: 600_000, // 10 min: drži heap ispod 100 MB (15 min je davalo 124 MB pri 4,8 t/s)
  claimConfirmMs: 120, // koliko čekamo da vidimo da li je neko drugi preuzeo isti task
  taskTtlMs: 30_000,
  maxInFlight: 3,
  autoLoop: true, // claim petlja se vrti sama; u testovima se isključuje (deterministički tick)
  encryptTaskPayload: true, // payload taska ide šifrovan preko UDP-a (AES-256-GCM iz tajne klastera)
  httpAdmin: true,
  gossip: {},
};

export async function createSwarmNode({
  nodeId = null,
  port = 8001,
  host = '0.0.0.0',
  advertiseHost = '127.0.0.1',
  peers = [],
  secret,
  tenantId = 'nmq',
  dataDir = null,
  runner = null,
  robot = null,
  config = {},
  logger,
  metrics,
  audit,
  registry = null,
} = {}) {
  const cfg = { ...NODE_DEFAULTS, ...(config ?? {}) };
  // Claim verifikacija nikad kraća od 2× gossip intervala (inače trka u claim-u, dokazano chaos testom)
  const gossipInterval = Number(cfg.gossip?.intervalMs ?? 300);
  cfg.claimConfirmMs = Math.max(Number(cfg.claimConfirmMs ?? 0), cfg.minClaimConfirmMs, gossipInterval * 2);
  // Prozori pouzdanosti claim-a — izloženi da testovi provjere PRAVILO, a ne da ga pogađaju.
  // `derived` je minimum koji garantuje da je prozor veći od IZMJERENE detekcije smrti (aktivira se u
  // koraku 3); aktivne vrijednosti se ovdje NE mijenjaju (Dio 1 samo mjeri i izlaže).
  const detectionMs = Number(cfg.gossip?.failureTimeoutMs ?? 1300);
  const explicitGrace = config?.claimGraceMs != null;
  const explicitConfirm = config?.claimConfirmMs != null;
  const derivedWindows = () => ({
    graceMs: Math.max(NODE_DEFAULTS.claimGraceMs, Math.ceil(detectionMs * 1.5)),
    confirmMs: Math.max(cfg.minClaimConfirmMs, gossipInterval * 2, Math.ceil(detectionMs * 1.25)),
  });
  const id = nodeId ?? `node-${port}`;
  const emitter = new EventEmitter();
  const tasks = new Map(); // taskId -> task (lokalno poznati)
  const inFlight = new Map();
  const pendingAcks = new Map(); // taskId -> { confirmedBy:Set, resolvers:[] } za durable submit
  let closed = false; // poslije close() nijedna petlja ne smije raditi
  const done = [];
  const startedAt = Date.now();

  const crdt = createCrdtBlackboard({ nodeId: id, logger, metrics });
  const pheromone = createPheromoneStore({ logger, metrics, config: { ttlMs: cfg.taskTtlMs, halfLifeMs: Math.max(1000, Math.floor(cfg.taskTtlMs / 3)) } });
  const queue = createTaskQueue({ backend: 'memory', tenantId, logger, metrics, config: { ttlMs: cfg.taskTtlMs, visibilityTimeoutMs: cfg.taskTtlMs * 2 } });

  const load = () => inFlight.size;

  /** ID ovog PROCESA (ne čvora): poslije restarta se promijeni, pa stari claim-ovi ne mogu biti naslijeđeni. */
  const instanceId = randomUUID();

  // Sopstvena potrošnja: CPU procenat od zadnjeg mjerenja + RSS u MB (bez npm, samo process.*)
  let cpuMark = process.cpuUsage();
  let cpuMarkAt = Date.now();
  function selfUsage() {
    const now = Date.now();
    const usage = process.cpuUsage(cpuMark);
    const elapsedMs = Math.max(1, now - cpuMarkAt);
    cpuMark = process.cpuUsage();
    cpuMarkAt = now;
    const cpuPct = Number((((usage.user + usage.system) / 1000 / elapsedMs) * 100).toFixed(1));
    return { cpuPct, rssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(0)) };
  }
  const minPeerLoad = () => {
    const peersAlive = gossip.membershipList().filter((m) => m.nodeId !== id && m.status === 'alive' && m.load !== null);
    if (!peersAlive.length) return null;
    return Math.min(...peersAlive.map((m) => Number(m.load)));
  };

  /**
   * Da li je claim još „živ"? Claim je zapis u CRDT-u, ali onaj ko ga je uzeo može umrijeti.
   * Zato claim ima **lease** (vremenski rok) i provjeru da je vlasnik živ:
   *   • vlasnik je ovaj čvor → živ
   *   • vlasnik je član koji je `alive` → živ
   *   • inače: ako je istekao lease (ili je prošao kratki grace poslije claim-a) → task se vraća u igru
   * Bez ovoga task koji je držao ubijeni čvor ostaje zauvijek „preuzet" (dokazano chaos testom: 5 izgubljenih).
   */
  function isClaimLive(claim) {
    if (!claim) return false;
    const age = Date.now() - Number(claim.at ?? 0);
    // FENCING: claim je „naš" samo ako se poklapa i nodeId I instanceId tekućeg procesa. Poslije restarta
    // novi proces ima novi instanceId, pa su svi stari claim-ovi TUĐI — inače bi ih naslijedio i izvršio
    // task drugi put (43 duplih u soak-u #4, ~8 po restartu).
    if (claim.nodeId === id && (!claim.instanceId || claim.instanceId === instanceId)) return age < cfg.claimLeaseMs;
    if (claim.nodeId === id) return age < cfg.claimGraceMs; // naš stari claim iz prethodnog procesa
    if (gossip.isAlive(claim.nodeId)) return age < cfg.claimLeaseMs;
    // Vlasnik nije živ (ili nije poznat): kratki grace da ne otmemo task kolegi koji upravo verifikuje claim
    return age < cfg.claimGraceMs;
  }

  const gossip = createGossip({
    nodeId: id,
    port,
    host,
    advertiseHost,
    secret,
    secretPrev: cfg.secretPrev ?? process.env.NMQ_CLUSTER_SECRET_PREV ?? null, // rotacija ključa bez prekida
    peers,
    config: cfg.gossip,
    logger,
    metrics,
    // CPU% i RSS se oglašavaju kroz gossip — dashboard tako prikazuje STVARNO opterećenje svakog čvora
    status: () => ({ load: load(), tasksDone: done.length, uptimeMs: Date.now() - startedAt, ...selfUsage() }),
    onMessage: (msg) => {
      if (msg.type === 'DISSEMINATE_ITEM') onDisseminate(msg.payload);
    },
  });

  /** Task bez payload-a — to je ono što smije u CRDT (dijeli se preko mreže). */
  function metaOf(task) {
    const { payload, ...meta } = task;
    return { ...meta, payloadEncrypted: true };
  }

  function onDisseminate(item) {
    if (!item) return;
    if (item.kind === 'crdt') {
      const res = crdt.merge(item.entries);
      if (res.applied) emitter.emit('crdt', res);
      return;
    }
    if (item.kind === 'result-query' && item.taskId) {
      // Neko pita da li imamo rezultat za task (prije nego što ga ponovo izvrši) → odgovori svojim zapisima
      const keys = [`result:${item.taskId}`, `task:${item.taskId}`, `claim:${item.taskId}`];
      const entries = crdt.snapshot().filter((e) => keys.includes(e.key) && e.nodeId === id);
      if (entries.length) {
        gossip.broadcast({ kind: 'crdt', entries });
        metrics?.inc('node_result_answers_total', { node: id });
        logger?.debug?.('node.result_query_answered', { taskId: item.taskId, to: item.from ?? null, entries: entries.length });
      }
      return;
    }
    if (item.kind === 'task' && item.task) {
      // Task sa drugog čvora: payload je ŠIFROVAN (UDP je čist tekst), pa ga dešifrujemo ovdje
      let task = item.task;
      if (item.payloadEnc) {
        try {
          task = { ...item.task, payload: decryptPayload(secret, item.payloadEnc, { aad: item.task.id }) };
        } catch (err) {
          metrics?.inc('node_payload_decrypt_failed_total', {});
          logger?.warn?.('node.payload_decrypt_failed', { taskId: item.task.id, error: err.message });
          return; // bez ključa se task NE izvršava (fail-closed)
        }
      }
      if (!task.payload) task = { ...task, payload: {} };
      if (!crdt.get(`task:${task.id}`)) crdt.set(`task:${task.id}`, metaOf(task));
      if (!tasks.has(task.id)) tasks.set(task.id, task); // dekriptovan payload ostaje samo lokalno
      // Potvrdi pošiljaocu da task imamo (durable submit) — jeftino, jedan mali UDP okvir
      gossip.broadcast({ kind: 'task-received', taskId: task.id, from: id });
      emitter.emit('task', task);
    }
    if (item.kind === 'task-received' && item.taskId) {
      acknowledgeTask(item.taskId, item.from ?? 'nepoznat');
      return;
    }
  }

  /**
   * DURABLE SUBMIT: task je prihvaćen tek kad ga bar JEDAN peer potvrdi.
   *
   * Zašto: chaos test je pokazao da task koji čvor primi i umre prije nego što ga raširi (gossip je
   * best-effort, interval 300 ms) nestaje zajedno s njim — 3 taska bez ijednog traga u runu 8/9.
   * Ovim se „primljeno" pretvara u „primljeno i još negdje zapisano".
   *
   * Semantika (iskreno): ako u roju NEMA drugih čvorova, task je „durable" u smislu da nema kome da
   * se izgubi — ali tada ne postoji replika. Zato odgovor nosi `confirmedBy` (ko ga ima) i `durable`.
   */
  async function waitForTaskAck(taskId, timeoutMs) {
    const waiter = pendingAcks.get(taskId) ?? { confirmedBy: new Set(), resolvers: [] };
    pendingAcks.set(taskId, waiter);
    if (waiter.confirmedBy.size) return [...waiter.confirmedBy];
    const result = await new Promise((resolve) => {
      // NAPOMENA: tajmer se NE unref-uje — ako bi bio unref-ovan, `await` bi mogao ostati vječno
      // nerazriješen kad nema drugog posla u event loop-u (zakačilo se u testovima).
      const timer = setTimeout(() => resolve([...waiter.confirmedBy]), timeoutMs);
      waiter.resolvers.push((by) => {
        clearTimeout(timer);
        resolve(by);
      });
    });
    pendingAcks.delete(taskId);
    return result;
  }

  function acknowledgeTask(taskId, from) {
    const waiter = pendingAcks.get(taskId);
    if (!waiter) return false;
    waiter.confirmedBy.add(from);
    for (const resolve of waiter.resolvers.splice(0)) resolve([...waiter.confirmedBy]);
    return true;
  }

  /** Objavi task SVIMA: lokalno + CRDT + gossip. */
  async function submitTask(task, { durable = cfg.durableSubmit } = {}) {
    // BACKPRESSURE: ako je red pun, odbij odmah (klijent treba da uspori) — vidi QueueFullError
    if (cfg.shedWhenBusy) {
      // STVARNI backlog: taskovi u CRDT-u koji nisu završeni (red se na node putu ne prazni preko pop())
      const depth = crdt
        .entries()
        .filter((e) => e.key.startsWith('task:'))
        .map((e) => e.value)
        .filter((t) => t && t.state !== 'done' && !crdt.get(`result:${t.id}`)).length;
      if (depth >= cfg.maxQueueDepth) {
        metrics?.inc('node_submit_shed_total', { node: id });
        logger?.warn?.('node.submit_shed', { nodeId: id, queueDepth: depth, maxQueueDepth: cfg.maxQueueDepth });
        throw new QueueFullError({ queueDepth: depth, maxQueueDepth: cfg.maxQueueDepth, inFlight: inFlight.size });
      }
    }
    const normalized = {
      id: task.id ?? uid('task'),
      type: task.type ?? 'generic',
      payload: task.payload ?? {},
      ttl: Number(task.ttl ?? cfg.taskTtlMs),
      tenantId: task.tenantId ?? tenantId,
      value: Number(task.value ?? 1),
      skills: task.skills ?? [],
      createdAt: iso(),
      origin: id,
      // At-least-once isporuka: efekti MORAJU biti idempotentni po ovom ključu (default = id taska)
      idempotencyKey: task.idempotencyKey ?? task.id,
    };
    tasks.set(normalized.id, normalized);
    crdt.set(`task:${normalized.id}`, metaOf(normalized)); // u CRDT idu SAMO metapodaci (payload ostaje lokalno)
    await queue.push(normalized);
    // Preko žice ide METAPODACI + ŠIFROVAN payload (UDP je čist tekst; HMAC daje integritet, ne tajnost)
    if (cfg.encryptTaskPayload) {
      const { payload, ...meta } = normalized;
      gossip.broadcast({ kind: 'task', task: { ...meta, payloadEncrypted: true }, payloadEnc: encryptPayload(secret, payload, { aad: normalized.id }) });
    } else {
      gossip.broadcast({ kind: 'task', task: normalized });
    }
    metrics?.inc('node_tasks_submitted_total', { node: id });
    logger?.info?.('node.task_submitted', { nodeId: id, taskId: normalized.id, type: normalized.type });

    if (!durable) return { ...normalized, durable: false, confirmedBy: [] };

    const peersAlive = gossip.aliveCount() - 1;
    if (peersAlive <= 0) {
      // Nema kome da se izgubi — ali nema ni replike (iskreno u odgovoru)
      return { ...normalized, durable: true, confirmedBy: [], note: 'single-node (nema peer-ova)' };
    }
    let confirmed = await waitForTaskAck(normalized.id, cfg.submitAckMs);
    if (!confirmed.length) {
      // Jedan ponovni pokušaj (jednostavan, bez backoff-a — gossip je ionako periodičan)
      retryBroadcast(normalized);
      confirmed = await waitForTaskAck(normalized.id, cfg.submitAckMs);
    }
    if (confirmed.length) {
      metrics?.observe('node_submit_ack_ms', {}, Date.now() - Date.parse(normalized.createdAt));
      return { ...normalized, durable: true, confirmedBy: confirmed };
    }
    metrics?.inc('node_submit_not_durable_total', { node: id });
    logger?.warn?.('node.submit_not_durable', { nodeId: id, taskId: normalized.id, peersAlive });
    return { ...normalized, durable: false, confirmedBy: [], warning: `nijedan od ${peersAlive} peer-ova nije potvrdio task u ${cfg.submitAckMs} ms` };
  }

  /** Ponovno oglašavanje taska (isti oblik kao u submitTask) — koristi se kad prvi ACK izostane. */
  function retryBroadcast(normalized) {
    if (cfg.encryptTaskPayload) {
      const { payload, ...meta } = normalized;
      gossip.broadcast({ kind: 'task', task: { ...meta, payloadEncrypted: true }, payloadEnc: encryptPayload(secret, payload, { aad: normalized.id }) });
    } else {
      gossip.broadcast({ kind: 'task', task: normalized });
    }
  }

  /** Claim u CRDT-u + kratka verifikacija (deterministički LWW pobjednik). */
  async function tryClaim(task) {
    const claimKey = `claim:${task.id}`;
    const existing = crdt.get(claimKey);
    if (existing && isClaimLive(existing)) return { claimed: false, reason: 'već preuzet', by: existing.nodeId };

    /**
     * PONOVNO PREUZIMANJE: prije nego što task izvršimo DRUGI put, pitamo roj da li neko već ima
     * rezultat. Ovo rješava najčešći realan slučaj — čvor je završio posao, pa umro PRIJE nego što
     * je rezultat stigao do ostalih; bez ovog upita roj bi isti posao uradio ponovo.
     * (Chaos test: 2–4 ponovna izvršenja u 24–30 taskova dok ovog upita nije bilo.)
     */
    if (existing) {
      const known = crdt.get(`result:${task.id}`) ?? crdt.get(`task:${task.id}`);
      const alreadyDone = crdt.get(`result:${task.id}`) || (crdt.get(`task:${task.id}`)?.state === 'done');
      if (alreadyDone) {
        metrics?.inc('node_claims_skipped_done_total', { node: id });
        return { claimed: false, reason: 'već završen (rezultat poznat)', by: known?.nodeId ?? known?.doneBy ?? null };
      }
      gossip.broadcast({ kind: 'result-query', taskId: task.id, from: id });
      metrics?.inc('node_result_queries_total', { node: id });
      await new Promise((r) => setTimeout(r, cfg.reclaimProbeMs));
      const answer = crdt.get(`result:${task.id}`);
      if (answer || crdt.get(`task:${task.id}`)?.state === 'done') {
        metrics?.inc('node_claims_skipped_after_probe_total', { node: id });
        return { claimed: false, reason: 'rezultat nađen u roju (nema ponovnog rada)', by: answer?.nodeId ?? null };
      }
    }

    if (existing) metrics?.inc('node_claims_reclaimed_total', { node: id });
    // FENCING TOKEN: svaki novi claim nosi veći `attempt`. Tako se u tragovima vidi da li je task
    // izvršen DVA PUTA u istom pokušaju (prava greška) ili je riječ o ponovnom pokušaju (očekivano
    // kod „at-least-once" isporuke kad čvor umre poslije posla, a prije potvrde).
    const attempt = Number(existing?.attempt ?? 0) + 1;
    crdt.set(claimKey, { nodeId: id, instanceId, at: Date.now(), load: load(), leaseMs: cfg.claimLeaseMs, attempt });
    // Šaljemo SAMO novi claim zapis (ne cijeli snapshot) — ostatak širi periodični CRDT sync
    const fresh = crdt.delta({ [id]: lastBroadcast }).filter((e) => e.nodeId === id);
    if (fresh.length) {
      lastBroadcast = Math.max(...fresh.map((e) => e.counter));
      gossip.broadcast({ kind: 'crdt', entries: fresh });
    }
    await new Promise((r) => setTimeout(r, cfg.claimConfirmMs));
    const winner = crdt.get(claimKey);
    if (!winner || winner.nodeId !== id) {
      metrics?.inc('node_claims_lost_total', { node: id });
      return { claimed: false, reason: 'izgubio trku (LWW)', by: winner?.nodeId ?? null };
    }
    if (inFlight.size >= cfg.maxInFlight) {
      crdt.delete(claimKey);
      return { claimed: false, reason: 'preopterećen' };
    }
    inFlight.set(task.id, { task, at: Date.now() });
    await pheromone.deposit({ tenantId: task.tenantId, type: 'claimed', taskId: task.id, by: id, strength: 0.8 });
    queue.inFlight.set(task.id, { task, at: Date.now() });
    metrics?.inc('node_tasks_claimed_total', { node: id, type: task.type });
    return { claimed: true, task, attempt };
  }

  async function runTask(task, { attempt = 1 } = {}) {
    const started = Date.now();
    /**
     * OBNOVLJANJE CLAIM LEASE-A (obavezno).
     *
     * Zašto: 1h soak je pokazao da pod zasićenjem izvršenje traje duže od `claimLeaseMs` (10 s), pa je
     * lease isticao DOK VLASNIK JOŠ RADI — drugi čvorovi su preuzimali isti task → 11 200 duplih
     * izvršenja u 25 707 taskova. Sada vlasnik osvježava `claim.at` svakih lease/3 i oglašava to roju,
     * pa zdravi vlasnik NIKAD ne izgubi claim, a mrtvi ga izgubi odmah.
     */
    const renewEveryMs = Math.max(400, Math.floor(cfg.claimLeaseMs / 3));
    const renew = setInterval(() => {
      try {
        const cur = crdt.get(`claim:${task.id}`);
        if (cur && (cur.nodeId !== id || (cur.instanceId && cur.instanceId !== instanceId))) {
          clearInterval(renew); // izgubili smo claim — ne obnavljamo tuđi zapis
          metrics?.inc('node_claim_renew_stopped_total', { node: id });
          return;
        }
        crdt.set(`claim:${task.id}`, { nodeId: id, instanceId, at: Date.now(), load: load(), leaseMs: cfg.claimLeaseMs, attempt, renewed: true });
        const fresh = crdt.delta({ [id]: lastBroadcast }).filter((e) => e.nodeId === id);
        if (fresh.length) {
          lastBroadcast = Math.max(...fresh.map((e) => e.counter));
          gossip.broadcast({ kind: 'crdt', entries: fresh });
        }
        metrics?.inc('node_claim_renewed_total', { node: id });
      } catch (err) {
        logger?.warn?.('node.claim_renew_failed', { taskId: task.id, error: err.message });
      }
    }, renewEveryMs);
    if (renew.unref) renew.unref();

    try {
      const output = runner ? await runner(task, { nodeId: id, robot, attempt, idempotencyKey: task.idempotencyKey ?? task.id }) : { output: `obrađeno na ${id}` };
      // Provjera vlasništva POSLIJE posla: ako je neko drugi u međuvremenu preuzeo claim, naš rezultat
      // se bilježi kao `superseded` i NE proglašava task završenim (važi rezultat trenutnog vlasnika).
      // Ovo ne sprječava dupli RAD (to je „at-least-once" priroda), ali sprečava dvostruku ISTINU u tabeli.
      const owner = crdt.get(`claim:${task.id}`);
      const stillOwner = !owner || owner.nodeId === id;
      const record = { taskId: task.id, nodeId: id, attempt, ok: true, superseded: !stillOwner, ms: Date.now() - started, output: output?.output ?? null, at: iso() };
      done.push(record);
      crdt.set(`result:${task.id}`, { nodeId: id, attempt, ok: true, superseded: !stillOwner, ms: record.ms, at: record.at });
      if (stillOwner) {
        crdt.set(`task:${task.id}`, { ...task, state: 'done', doneBy: id, attempt });
      } else {
        metrics?.inc('node_tasks_superseded_total', { node: id });
        logger?.warn?.('node.task_superseded', { nodeId: id, taskId: task.id, attempt, owner: owner.nodeId });
      }
      await pheromone.deposit({ tenantId: task.tenantId, type: 'done', taskId: task.id, by: id, strength: stillOwner ? 1 : 0.4 });
      await queue.ack(task.id, { success: true });
      metrics?.inc('node_tasks_done_total', { node: id, type: task.type });
      emitter.emit('done', record);
      logger?.info?.('node.task_done', { nodeId: id, taskId: task.id, ms: record.ms, attempt, superseded: record.superseded });
      return record;
    } catch (err) {
      const record = { taskId: task.id, nodeId: id, attempt, ok: false, error: err.message, ms: Date.now() - started, at: iso() };
      done.push(record);
      crdt.set(`result:${task.id}`, { nodeId: id, attempt, ok: false, error: err.message, at: record.at });
      crdt.delete(`claim:${task.id}`); // vrati task u igru
      await pheromone.deposit({ tenantId: task.tenantId, type: 'problem', taskId: task.id, by: id, strength: 1.5 });
      await queue.ack(task.id, { success: false });
      emitter.emit('failed', record);
      logger?.warn?.('node.task_failed', { nodeId: id, taskId: task.id, error: err.message, attempt });
      return record;
    } finally {
      clearInterval(renew);
      inFlight.delete(task.id);
      await queue.discard?.(task.id).catch?.(() => {}); // red ostaje tačan (queued = stvarno čeka)
    }
  }

  /** Jedan ciklus: pogledaj CRDT, claim-uj ako si najslobodniji, izvrši. */
  async function tick() {
    if (closed) return { idle: true, reason: 'closed' }; // čvor je zatvoren — ne diraj ništa
    if (inFlight.size >= cfg.maxInFlight) return { idle: true, reason: 'maxInFlight' };
    const myLoad = load();
    const peerMin = minPeerLoad();
    // Ako je neki drugi node slobodniji — NE uzimamo task (task u A završava u B)
    if (peerMin !== null && peerMin < myLoad) return { idle: true, reason: 'peer_freer', myLoad, peerMin };

    // Kandidati: taskovi iz CRDT-a koji nisu preuzeti i nisu završeni
    const candidates = crdt
      .entries()
      .filter((e) => e.key.startsWith('task:'))
      .map((e) => e.value)
      .filter((t) => t && t.state !== 'done' && !inFlight.has(t.id))
      .filter((t) => !crdt.get("result:" + t.id)) // vec ima rezultat (i ako state nije stigao) -> ne izvrsavaj ponovo
      .filter((t) => !isClaimLive(crdt.get(`claim:${t.id}`)))
      .sort((a, b) => (b.value ?? 1) - (a.value ?? 1) || String(a.createdAt).localeCompare(String(b.createdAt)));

    const task = candidates[0];
    if (!task) {
      // Razlikujemo „nema posla" od „sve je već preuzeto" — operateru to mnogo znači
      const known = crdt.entries().filter((e) => e.key.startsWith('task:')).map((e) => e.value).filter((t) => t && t.state !== 'done');
      return { idle: true, reason: known.length ? 'sva_preuzeta' : 'nema_posla', knownTasks: known.length };
    }
    const full = tasks.get(task.id) ?? task; // payload je lokalno
    const claim = await tryClaim(full);
    if (!claim.claimed) return { idle: true, reason: claim.reason, by: claim.by ?? null, taskId: task.id };
    const record = await runTask(full, { attempt: claim.attempt ?? 1 });
    return { ran: true, ...record };
  }

  let loopRefs = null;
  function startLoops() {
    const claimTimer = setInterval(() => {
      tick().catch((err) => logger?.warn?.('node.tick_failed', { error: err.message }));
    }, cfg.claimIntervalMs);
    if (claimTimer.unref) claimTimer.unref();
    const queueTimer = setInterval(() => queue.requeueStale().catch(() => {}), Math.max(1000, cfg.taskTtlMs));
    if (queueTimer.unref) queueTimer.unref();
    // Kompakcija CRDT-a: uklanja tombstone-e starije od `compactionAgeMs` (tabla ne raste u nedogled)
    const compactTimer = setInterval(() => {
      try {
        crdt.compact({ olderThanMs: cfg.compactionAgeMs });
        // GC: briše završene/zapuštene task:/result:/claim: zapise starije od gcAgeMs,
        // a NIKAD ono što je ovaj čvor trenutno preuzeo (inFlight) ni task koji još nije završen.
        crdt.gc({
          olderThanMs: cfg.gcAgeMs,
          protect: (key, entry) => {
            const taskId = key.split(':').slice(1).join(':');
            if (inFlight.has(taskId)) return true;
            if (key.startsWith('task:')) {
              const done = entry?.value?.state === 'done';
              const hasResult = Boolean(crdt.get("result:" + taskId));
              return !done && !hasResult; // nezavršen task se čuva
            }
            if (key.startsWith('claim:')) return isClaimLive(entry?.value ?? null); // živ claim se čuva
            return false;
          },
        });
      } catch (err) {
        logger?.warn?.('node.compact_failed', { error: err.message });
      }
    }, cfg.compactionIntervalMs);
    if (compactTimer.unref) compactTimer.unref();
    pheromone.startDecay();
    loopRefs = { claimTimer, queueTimer, compactTimer };
    return loopRefs;
  }

  /**
   * CRDT sync: periodično oglašava SAMO nove LOKALNE zapise (delta po vektorskom satu).
   * Bez ovoga bi se stanje spojilo tek kad neko claim-uje (tada se šalje snapshot) — a rezultati
   * i završeni taskovi moraju se vidjeti svuda.
   */
  let lastBroadcast = 0;
  function startSync() {
    const timer = setInterval(() => {
      const fresh = crdt
        .delta({ [id]: lastBroadcast })
        .filter((e) => e.nodeId === id)
        .map((e) => ({ key: e.key, value: e.value, meta: e.meta, deleted: e.deleted, counter: e.counter, nodeId: e.nodeId, clock: e.clock, ts: e.ts }));
      if (!fresh.length) return;
      lastBroadcast = Math.max(...fresh.map((e) => e.counter));
      gossip.broadcast({ kind: 'crdt', entries: fresh });
      metrics?.inc('node_crdt_sync_total', { node: id, entries: String(fresh.length) });
    }, cfg.syncIntervalMs);
    if (timer.unref) timer.unref();
    return timer;
  }

  // ── HTTP admin (isti broj porta, TCP; UDP gossip je odvojen namespace) ──────
  let server = null;
  let syncRef = null;
  function startHttp() {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
        const send = (code, body) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.method === 'GET' && url.pathname === '/status') {
          return send(200, { ...api.stats(), membership: gossip.membershipList() });
        }
        if (req.method === 'GET' && url.pathname === '/tasks') {
          return send(200, { tasks: [...tasks.values()], done: done.slice(-50), crdt: crdt.toObject() });
        }
        if (req.method === 'POST' && url.pathname === '/task') {
          let raw = '';
          req.on('data', (d) => {
            raw += d;
            if (raw.length > 1_000_000) req.destroy();
          });
          req.on('end', async () => {
            try {
              const body = raw ? JSON.parse(raw) : {};
              const task = await submitTask(body);
              send(200, { accepted: true, task });
            } catch (err) {
              send(400, { error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
            }
          });
          return undefined;
        }
        if (req.method === 'POST' && url.pathname === '/tick') {
          tick()
            .then((r) => send(200, r))
            .catch((err) => send(500, { error: { message: err.message } }));
          return undefined;
        }
        /**
         * /shutdown — „chaos dugme" za DEMO: čvor se sam ugasi, a systemd ga vrati (`Restart=always`).
         * Zašto tako: API proces nema root i ne treba mu — dovoljno je da čvor izađe, a supervisor ga
         * podigne. Posjetilac na live.braincore.pro tako vidi stvarnu smrt i stvarni oporavak roja.
         * Sigurnost: ruta je ISKLJUČENA osim ako je `NMQ_ALLOW_SHUTDOWN=1` (ili config), i traži token ako je zadan.
         */
        if (req.method === 'POST' && url.pathname === '/shutdown') {
          const allowed = cfg.allowShutdown === true || process.env.NMQ_ALLOW_SHUTDOWN === '1';
          if (!allowed) return send(403, { error: { code: 'SHUTDOWN_DISABLED', message: 'Gašenje čvora nije dozvoljeno' } });
          const token = req.headers['x-shutdown-token'] ?? null;
          if (cfg.shutdownToken && token !== cfg.shutdownToken) return send(401, { error: { code: 'BAD_TOKEN', message: 'Neispravan token za gašenje' } });
          const reason = url.searchParams.get('reason') ?? 'chaos';
          logger?.warn?.('node.shutdown_requested', { nodeId: id, reason });
          audit
            ?.append({ tenantId, actor: 'chaos', action: 'node_shutdown', args: { nodeId: id, reason }, decision: 'allow', outcome: 'ok' })
            .catch(() => {});
          send(200, { shuttingDown: true, nodeId: id, reason, expectedRestartSec: 2 });
          setTimeout(async () => {
            await api.close().catch(() => {});
            process.exit(0); // systemd `Restart=always` ga vraća u roj
          }, 150);
          return undefined;
        }
        return send(404, { error: { code: 'NOT_FOUND', message: `nema rute ${url.pathname}` } });
      });
      server.listen(port, host === '0.0.0.0' ? undefined : host, () => resolve(server.address().port));
    });
  }

  const api = {
    nodeId: id,
    tenantId,
    crdt,
    pheromone,
    queue,
    gossip,
    tasks,
    done,
    get closed() {
      return closed;
    },
    get port() {
      return gossip.port;
    },
    get httpPort() {
      return server?.address()?.port ?? null;
    },
    load,
    minPeerLoad,
    on: (...a) => emitter.on(...a),
    submitTask,
    tick,
    runTask,
    startLoops,

    async start() {
      await queue.init();
      if (cfg.httpAdmin) await startHttp();
      const t0 = Date.now();
      await gossip.start();
      // Claim petlja se vrti sama; u testovima se isključuje da bi tick bio deterministički
      if (cfg.autoLoop) startLoops();
      // CRDT sync se vrti UVIJEK (i u testovima) — inače se stanje ne bi širilo
      syncRef = startSync();
      // Ako imamo peer-ove, javi se odmah (bez čekanja prvog intervala)
      if (peers?.length) await gossip.join(peers);
      const discovery = await api.waitForPeers({ expected: (peers?.length ?? 0), timeoutMs: 2000 });
      const syncMs = Date.now() - t0;
      logger?.info?.('node.started', { nodeId: id, port: api.port, httpPort: api.httpPort, peers: gossip.aliveCount() - 1, syncMs });
      return { nodeId: id, port: api.port, httpPort: api.httpPort, syncMs, ...discovery };
    },

    /**
     * Čeka da se pojavi `expected` živih peer-ova.
     * Spec: 3 node-a se moraju naći za <2s.
     */
    async waitForPeers({ expected = 2, timeoutMs = 2000, pollMs = 25 } = {}) {
      const t0 = Date.now();
      for (;;) {
        const alive = gossip.aliveCount() - 1;
        if (alive >= expected) return { synced: true, alivePeers: alive, syncMs: Date.now() - t0 };
        if (Date.now() - t0 >= timeoutMs) return { synced: alive > 0, alivePeers: alive, syncMs: Date.now() - t0, timedOut: true };
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },

    stats() {
      // Roj-široki brojači: svoj `done` + ono što su peer-ovi objavili u statusu (PING/ACK nosi tasksDone).
      const peers = gossip.membershipList().filter((m) => m.nodeId !== id && m.status === 'alive');
      const swarmTasksDone = done.length + peers.reduce((sum, m) => sum + Number(m.tasksDone ?? 0), 0);
      return {
        nodeId: id,
        port: api.port,
        httpPort: api.httpPort,
        tenantId,
        uptimeMs: Date.now() - startedAt,
        load: load(),
        inFlight: inFlight.size,
        tasksKnown: tasks.size,
        tasksDone: done.length,
        swarmTasksDone,
        swarmNodes: peers.length + 1,
        peersAlive: gossip.aliveCount() - 1,
        alive: gossip.membershipList().filter((m) => m.status === 'alive').map((m) => `${m.nodeId}@${m.host}:${m.port}`),
        crdtSize: crdt.size,
        pheromone: pheromone.stats(),
        queue: queue.stats(),
        gossipStats: gossip.stats,
      };
    },

    /**
     * Prozori pouzdanosti claim-a (za testove i dijagnostiku).
     * `active` = trenutne vrijednosti, `derived` = izračunati minimum (prozor > izmjerena detekcija),
     * `explicit` = da li je pozivalac zadao vrijednost (tada derivacija NE smije da je prepiše).
     */
    claimWindows: () => {
      const derived = derivedWindows();
      return {
        graceMs: cfg.claimGraceMs,
        confirmMs: cfg.claimConfirmMs,
        totalMs: Number(cfg.claimGraceMs) + Number(cfg.claimConfirmMs),
        detectionMs,
        derived,
        derivedTotalMs: derived.graceMs + derived.confirmMs,
        explicit: { grace: explicitGrace, confirm: explicitConfirm },
      };
    },

    /** Zatvaranje čvora MORA zaustaviti sve njegove petlje.
     * Soak test (restart čvora pod opterećenjem) je pokazao da su claim/sync/queue tajmeri nastavljali
     * da rade poslije `close()`, pa je log punio `node.tick_failed: Not running` — čvor je „mrtav", a
     * još kuca. Sada se svi tajmeri gase i `closed` flag sprječava dalji rad.
     */
    async close() {
      closed = true;
      pheromone.stopDecay();
      if (syncRef) clearInterval(syncRef);
      if (loopRefs) {
        clearInterval(loopRefs.claimTimer);
        clearInterval(loopRefs.queueTimer);
        if (loopRefs.compactTimer) clearInterval(loopRefs.compactTimer);
        loopRefs = null;
      }
      await gossip.stop().catch(() => {});
      if (server) await new Promise((resolve) => server.close(resolve));
      await queue.close().catch(() => {});
      return true;
    },
  };

  return api;
}

/**
 * Pomoćne tvornice za klastere iz postera (isti node, ali sa fasadama po domenima).
 */
export function createSupportCluster(args) {
  const router = createTicketRouter({ catalog: args.robot?.catalog, queue: args.queue, pheromone: args.pheromone, autonomy: args.robot?.autonomy, governance: args.robot?.swarmGovernance, logger: args.logger, metrics: args.metrics, audit: args.robot?.audit, tenantId: args.tenantId });
  return { ticketRouter: router, submit: (ticket, opts) => router.submit(ticket, opts) };
}

export function createExecutionCluster(args) {
  return createToolRunner({ tools: args.robot?.tools, policyResolver: args.robot?.policyResolver, sandbox: args.robot?.sandbox, audit: args.robot?.audit, metrics: args.metrics, logger: args.logger, tenantId: args.tenantId });
}

export function createResearchCluster(args) {
  const extractor = createExtractor({ memory: args.robot?.memory, llm: args.robot?.llm, logger: args.logger, metrics: args.metrics, audit: args.robot?.audit, tenantId: args.tenantId });
  const registry = args.registry ?? createGenomeRegistry({ secret: args.secret, logger: args.logger, metrics: args.metrics, audit: args.robot?.audit });
  const federation = createFederationClient({ nodeId: args.nodeId, secret: args.secret, registry, controlPlane: args.robot?.controlPlane, logger: args.logger, metrics: args.metrics, audit: args.robot?.audit });
  return { extractor, registry, federation };
}
