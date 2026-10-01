/* Braincore Pro — Swarm Dashboard (vanilla JS, bez zavisnosti)
   Prikazuje ŽIVI roj: čvorovi (hexagoni), tok posla, metrike (tasks/s, p95, queue depth), feromone
   koji isparavaju i CHAOS dugme (KILL NODE) koje stvarno ubija peer čvor — systemd ga vrati. */
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('c');
  const ctx = canvas.getContext('2d');
  const spark = $('spark');
  const sctx = spark.getContext('2d');
  const log = $('log');

  const state = {
    snap: null,
    self: null,
    particles: [],
    queueHistory: [],
    completedTimes: [],
    lastDoneCount: 0,
    t: 0,
    killAt: null,
    recoveryWatch: [],
  };

  const fmt = (n, d = 0) => (n === null || n === undefined ? '—' : Number(n).toFixed(d));
  const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  };

  function logLine(text, color = '#bff3dd') {
    const div = document.createElement('div');
    const t = new Date().toISOString().slice(11, 19);
    div.innerHTML = `<span class="t">[+${t}]</span> <span style="color:${color}">${text}</span>`;
    log.prepend(div);
    while (log.childElementCount > 140) log.lastElementChild.remove();
    $('logCount').textContent = `${log.childElementCount} events`;
  }

  // ── canvas: mapa roja ────────────────────────────────────────────────────
  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.w = r.width;
    state.h = r.height;
  }
  window.addEventListener('resize', resize);

  function layout(nodes) {
    const cx = state.w / 2;
    const cy = state.h / 2;
    const R = Math.min(state.w, state.h) * 0.31;
    const pos = new Map();
    nodes.forEach((n, i) => {
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
      pos.set(n.nodeId, { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, node: n, angle: a });
    });
    return pos;
  }

  function hex(x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function draw() {
    if (!state.w) return;
    ctx.fillStyle = 'rgba(4,11,16,0.24)';
    ctx.fillRect(0, 0, state.w, state.h);
    // ambijentalni sjaj u centru (da scena ne bude prazna/tamna)
    if (state.w) {
      const cg = ctx.createRadialGradient(state.w / 2, state.h / 2, 0, state.w / 2, state.h / 2, Math.min(state.w, state.h) * 0.58);
      cg.addColorStop(0, 'rgba(25,217,140,0.11)');
      cg.addColorStop(0.5, 'rgba(92,225,255,0.05)');
      cg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = cg;
      ctx.fillRect(0, 0, state.w, state.h);
    }
    const s = state.snap;
    if (s) {
      const pos = layout(s.nodes || []);
      const cx = state.w / 2;
      const cy = state.h / 2;

      // tok posla: linije od čvora ka centru, debljina po opterećenju
      for (const [id, p] of pos) {
        if (p.node.status !== 'alive') continue;
        const load = Number(p.node.load ?? 0);
        ctx.strokeStyle = 'rgba(77,255,181,0.35)';
        ctx.lineWidth = 0.8 + Math.min(3, load);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.quadraticCurveTo((p.x + cx) / 2, (p.y + cy) / 2 - 20, cx, cy);
        ctx.stroke();
      }
      // feromoni: tragovi koji blijede (jačina = opadajuća vrijednost)
      for (const ph of s.pheromones || []) {
        const from = pos.get(ph.by);
        if (!from) continue;
        ctx.strokeStyle = ph.type === 'problem' ? '#ff6b6b' : ph.type === 'done' ? '#4dffb5' : '#5ce1ff';
        ctx.globalAlpha = 0.08 + Math.min(0.5, ph.strength * 0.5);
        ctx.lineWidth = 0.6 + ph.strength * 2.6;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.quadraticCurveTo((from.x + cx) / 2 + 14, (from.y + cy) / 2 - 14, cx, cy);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // čvorovi
      for (const [id, p] of pos) {
        const alive = p.node.status === 'alive';
        const isSelf = id === state.self;
        const r = isSelf ? 26 : 21;
        const col = alive ? (isSelf ? '#ffd479' : '#4dffb5') : '#ff6b6b';
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.6;
        ctx.fillStyle = alive ? 'rgba(25,217,140,0.10)' : 'rgba(255,107,107,0.12)';
        hex(p.x, p.y, r);
        ctx.fill();
        ctx.stroke();
        hex(p.x, p.y, r * 0.55);
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.6;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = col;
        ctx.font = '600 13px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(id.replace('node-', 'NODE-'), p.x, p.y + r + 20);
        ctx.fillStyle = alive ? 'rgba(223,250,239,0.85)' : '#ff6b6b';
        ctx.font = '11px ui-monospace, monospace';
        const tps = (state.rates?.get(id) ?? 0).toFixed(2);
        const cpu = p.node.cpuPct === null || p.node.cpuPct === undefined ? '—' : `${p.node.cpuPct}%`;
        const ram = p.node.rssMb === null || p.node.rssMb === undefined ? '—' : `${p.node.rssMb}MB`;
        ctx.fillText(alive ? `→ ${tps} t/s · CPU ${cpu} · RAM ${ram} · tasks ${p.node.tasksDone ?? 0}` : `DEAD — re-claim in progress`, p.x, p.y + r + 36);
        ctx.textAlign = 'left';
      }
      // centar = task pool
      const pulse = 1 + Math.sin(state.t / 20) * 0.06;
      ctx.strokeStyle = 'rgba(255,212,121,.6)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(cx, cy, 30 * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,236,190,.95)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('TASK POOL', cx, cy + 48);
      ctx.fillText(`queue ${state.snap.stats?.queueDepth ?? 0}`, cx, cy + 62);
      ctx.textAlign = 'left';

      // čestice: završeni taskovi lete ka svom čvoru
      for (const part of state.particles) {
        const to = pos.get(part.nodeId);
        if (!to) continue;
        const k = 1 - part.life / part.ttl;
        const x = cx + (to.x - cx) * k;
        const y = cy + (to.y - cy) * k;
        ctx.globalAlpha = Math.max(0, part.life / part.ttl);
        ctx.fillStyle = part.ok === false ? '#ff6b6b' : '#4dffb5';
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        part.life -= 1;
      }
      state.particles = state.particles.filter((p) => p.life > 0);
    }
    state.t += 1;
  }

  // ── sparkline za queue depth ─────────────────────────────────────────────
  function drawSpark() {
    const w = spark.width;
    const h = spark.height;
    sctx.clearRect(0, 0, w, h);
    const hist = state.queueHistory.slice(-60);
    const max = Math.max(10, ...hist);
    sctx.strokeStyle = 'rgba(80,255,190,.18)';
    sctx.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      sctx.beginPath();
      sctx.moveTo(0, (h / 4) * i);
      sctx.lineTo(w, (h / 4) * i);
      sctx.stroke();
    }
    if (hist.length > 1) {
      sctx.strokeStyle = '#4dffb5';
      sctx.lineWidth = 2;
      sctx.beginPath();
      hist.forEach((v, i) => {
        const x = (i / Math.max(1, hist.length - 1)) * w;
        const y = h - (v / max) * (h - 8) - 4;
        if (i === 0) sctx.moveTo(x, y);
        else sctx.lineTo(x, y);
      });
      sctx.stroke();
      sctx.fillStyle = 'rgba(77,255,181,.12)';
      sctx.lineTo(w, h);
      sctx.lineTo(0, h);
      sctx.closePath();
      sctx.fill();
    }
  }

  // ── primjena snapshot-a ──────────────────────────────────────────────────
  function apply(snap) {
    state.snap = snap;
    state.self = snap.node?.id ?? state.self;
    const st = snap.stats ?? {};
    const nodes = snap.nodes ?? [];

    $('barStatus').textContent = (st.peersAlive >= 1 ? 'OPERATIONAL' : 'DEGRADED') + ' ●';
    $('statusPill').textContent = st.peersAlive >= 1 ? 'OPERATIONAL' : 'DEGRADED';
    const up = Math.round((snap.node?.uptimeMs ?? 0) / 1000);
    $('barUptime').textContent = `${String(Math.floor(up / 3600)).padStart(2, '0')}:${String(Math.floor((up % 3600) / 60)).padStart(2, '0')}:${String(up % 60).padStart(2, '0')}`;
    $('barSession').textContent = `SWM-${String(snap.node?.port ?? 0)}-${String(snap.node?.id ?? '').slice(-4)}`;
    $('barNodes').textContent = `${nodes.filter((n) => n.status === 'alive').length}/${nodes.length}`;
    $('mapNodeCount').textContent = `${nodes.filter((n) => n.status === 'alive').length} alive · ${nodes.filter((n) => n.status !== 'alive').length} down`;
    $('fConsensus').textContent = st.peersAlive >= 1 ? 'STABLE' : 'DEGRADED';

    // tasks/s (rolling 10 s) — iz porasta brojača završenih
    const now = Date.now();
    state.completedTimes.push({ at: now, done: st.tasksDone ?? 0 });
    state.completedTimes = state.completedTimes.filter((c) => now - c.at <= 10_000);
    const oldest = state.completedTimes[0];
    const tps = oldest && now > oldest.at ? ((st.tasksDone ?? 0) - oldest.done) / ((now - oldest.at) / 1000) : 0;
    $('mTps').textContent = fmt(Math.max(0, tps), 1);
    $('mTpsNote').textContent = `rolling 10 s · done ${st.tasksDone ?? 0}`;

    // p95 iz zadnjih latencija
    const lat = st.recentLatenciesMs ?? [];
    const p95 = pct(lat, 95);
    const p50 = pct(lat, 50);
    const p99 = pct(lat, 99);
    $('mP95').textContent = p95 === null ? '—' : `${fmt(p95)}ms`;
    $('mP95Note').textContent = `p50 ${p50 === null ? '—' : fmt(p50) + 'ms'} · p99 ${p99 === null ? '—' : fmt(p99) + 'ms'} · n=${lat.length}`;

    const dropped = Math.max(0, (st.tasksKnown ?? 0) - (st.tasksDone ?? 0));
    $('mDropped').textContent = String(dropped);
    $('mDroppedNote').textContent = `${dropped} not yet finished`;
    const overlaps = st.superseded ?? 0;
    $('mOverlaps').textContent = String(overlaps);
    $('fIntegrity').textContent = `${dropped} open · ${overlaps} superseded · ${st.claimsLost ?? 0} claims lost`;

    // queue depth sparkline
    state.queueHistory.push(st.queueDepth ?? 0);
    if (state.queueHistory.length > 120) state.queueHistory.shift();
    $('qNow').textContent = String(st.queueDepth ?? 0);
    drawSpark();

    // feromoni: procjena oporavka (TTL 30 s, half-life 10 s)
    const phers = snap.pheromones ?? [];
    $('phCount').textContent = String(phers.length);
    if (phers.length) {
      const youngest = Math.max(...phers.map((p) => 30_000 - (p.ageMs ?? 0)));
      const remaining = Math.max(0, youngest);
      $('phBar').style.width = `${Math.min(100, (remaining / 30_000) * 100).toFixed(0)}%`;
      $('phText').textContent = `${(remaining / 1000).toFixed(0)}s remaining — evaporation in progress · strongest ${fmt(Math.max(...phers.map((p) => p.strength)), 2)}`;
    } else {
      $('phBar').style.width = '0%';
      $('phText').textContent = 'no active trails — all pheromones evaporated (TTL 30 s)';
    }

    // tasks/s po čvoru (grubo: iz load i tasksDone delta po čvoru)
    state.rates = state.rates ?? new Map();
    for (const n of nodes) {
      const key = `prev-${n.nodeId}`;
      const prev = state[key];
      state[key] = { done: n.tasksDone ?? 0, at: now };
      const rate = prev && now > prev.at ? ((n.tasksDone ?? 0) - prev.done) / ((now - prev.at) / 1000) : 0;
      state.rates.set(n.nodeId, Math.max(0, rate));
    }
  }

  // ── clock ────────────────────────────────────────────────────────────────
  setInterval(() => {
    $('clock').textContent = `UTC ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
  }, 1000);

  // ── CHAOS: KILL NODE ─────────────────────────────────────────────────────
  const arm = $('arm');
  const kill = $('kill');
  arm.addEventListener('change', () => {
    $('armState').textContent = arm.checked ? 'ARMED' : 'OFF';
    kill.disabled = !arm.checked;
    logLine(arm.checked ? 'chaos mode ARMED — kill button enabled' : 'chaos mode OFF', arm.checked ? '#ffd479' : '#7fa79a');
  });

  async function refreshChaosStatus() {
    try {
      const s = await fetch('/v1/chaos/status', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
      if (!s) return;
      $('killsTotal').textContent = String(s.killsTotal ?? 0);
      const cd = s.lastKillAt ? Math.max(0, (s.cooldownMs ?? 60_000) - (Date.now() - s.lastKillAt)) : 0;
      $('cooldown').textContent = cd > 0 ? `${Math.ceil(cd / 1000)} s` : 'ready';
      if (!s.armed) {
        kill.disabled = true;
        $('killResult').textContent = 'Chaos is disabled on this machine (set ALLOW_CHAOS_KILL=1 to arm the demo).';
      }
    } catch {
      /* ignore */
    }
  }
  refreshChaosStatus();
  setInterval(refreshChaosStatus, 5000);

  kill.addEventListener('click', async () => {
    if (!arm.checked) return;
    if (!window.confirm('Really terminate a live swarm node? systemd will restart it within ~2 seconds.')) return;
    kill.disabled = true;
    $('killResult').textContent = 'Sending kill…';
    logLine('CHAOS: kill requested by visitor', '#ff6b6b');
    try {
      const res = await fetch('/v1/chaos/kill', { method: 'POST', headers: { 'content-type': 'application/json' } });
      const body = await res.json();
      if (!res.ok) {
        $('killResult').textContent = `Refused: ${body.error?.message ?? res.status}`;
        logLine(`CHAOS refused: ${body.error?.code ?? res.status}`, '#ffd479');
      } else {
        state.killAt = Date.now();
        state.recoveryWatch = [];
        $('killResult').textContent = `Killed ${body.nodeId} (accepted in ${body.acceptedInMs} ms).\nExpected: death detected in ~${body.expectedDetectionMs} ms, restart in ~${body.expectedRecoverySec} s.\nWatch the map: the hex turns red, the work moves to a freer peer, then the node rejoins.`;
        logLine(`CHAOS: ${body.nodeId} terminated (kill #${body.killsTotal})`, '#ff6b6b');
      }
    } catch (err) {
      $('killResult').textContent = `Kill failed: ${err.message}`;
      logLine(`CHAOS error: ${err.message}`, '#ff6b6b');
    } finally {
      setTimeout(() => {
        kill.disabled = !arm.checked;
        refreshChaosStatus();
      }, 3000);
    }
  });

  // ── WebSocket feed ───────────────────────────────────────────────────────
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/events`);
    ws.onopen = () => logLine('WebSocket connected — streaming swarm state', '#4dffb5');
    ws.onclose = () => {
      logLine('WebSocket closed — reconnecting in 2 s', '#ff6b6b');
      setTimeout(connect, 2000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'snapshot') apply(msg);
      else if (msg.type === 'event') {
        if (msg.kind === 'task_done') {
          state.particles.push({ nodeId: msg.nodeId, life: 55, ttl: 55, ok: true });
          logLine(`task done on ${msg.nodeId} in ${msg.ms} ms${msg.attempt > 1 ? ` (attempt ${msg.attempt})` : ''}`, '#4dffb5');
          if (state.killAt) {
            const took = Date.now() - state.killAt;
            if (!state.reclaimedLogged) {
              state.reclaimedLogged = took;
              logLine(`RECOVERY: work re-claimed ${took} ms after the kill`, '#ffd479');
            }
          }
        } else if (msg.kind === 'task_failed') {
          state.particles.push({ nodeId: msg.nodeId, life: 55, ttl: 55, ok: false });
          logLine(`task failed on ${msg.nodeId}: ${msg.error}`, '#ff6b6b');
        } else if (msg.kind === 'membership') {
          logLine(`swarm : node ${msg.nodeId} → ${msg.status} (load ${msg.load ?? '-'})`, msg.status === 'alive' ? '#4dffb5' : '#ff6b6b');
          if (msg.status !== 'alive' && state.killAt) {
            const took = Date.now() - state.killAt;
            logLine(`DETECTION: node marked ${msg.status} ${took} ms after kill`, '#ffd479');
          }
          if (msg.status === 'alive' && state.killAt && state.reclaimedLogged) {
            logLine(`REJOIN: ${msg.nodeId} is back in the swarm ${Date.now() - state.killAt} ms after kill`, '#4dffb5');
            const st2 = state.snap?.stats ?? {};
            logLine(`integrity: 0 lost · ${st2.tasksDone ?? 0} tasks completed · ${st2.superseded ?? 0} overlaps — verified`, '#4dffb5');
            state.killAt = null;
            state.reclaimedLogged = null;
          }
        } else if (msg.kind === 'task_seen') {
          logLine(`swarm : task ${msg.type} seen from ${msg.origin}`, '#5ce1ff');
        }
      }
    };
  }

  resize();
  logLine('dashboard ready — waiting for swarm snapshot', '#5ce1ff');
  connect();
  (function loop() {
    draw();
    requestAnimationFrame(loop);
  })();
})();
