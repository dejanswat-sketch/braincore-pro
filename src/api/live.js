/* Braincore Pro — live swarm client (vanilla JS, bez zavisnosti) */
(() => {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const log = document.getElementById('log');
  const $ = (id) => document.getElementById(id);

  const state = { snapshot: null, self: null, particles: [], flashes: [], connected: false, t: 0 };

  function logLine(text, color) {
    const div = document.createElement('div');
    const time = new Date().toLocaleTimeString('en-GB');
    div.innerHTML = `<span class="t">${time}</span> · <span style="color:${color || '#c9d8f2'}">${text}</span>`;
    log.prepend(div);
    while (log.childElementCount > 120) log.lastElementChild.remove();
  }

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.w = rect.width;
    state.h = rect.height;
  }
  window.addEventListener('resize', resize);

  function positions(nodes) {
    const cx = state.w / 2;
    const cy = state.h / 2;
    const r = Math.min(state.w, state.h) * 0.32;
    const out = new Map();
    nodes.forEach((n, i) => {
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
      out.set(n.nodeId, { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, node: n });
    });
    return out;
  }

  function color(type) {
    return { hot: '#ffd479', done: '#7df0b0', problem: '#ff9fb1', blocked: '#ff9fb1', opportunity: '#c2a8ff', help: '#8fe4ff' }[type] || '#ffffff';
  }

  function draw() {
    const s = state.snapshot;
    if (!ctx || !state.w) return;
    // fade background
    ctx.fillStyle = 'rgba(2,4,10,0.35)';
    ctx.fillRect(0, 0, state.w, state.h);

    if (!s) return;
    const pos = positions(s.nodes || []);
    const selfPos = pos.get(state.self);

    // pheromone trails (from their origin node toward the task hub)
    for (const p of s.pheromones || []) {
      const from = pos.get(p.by) || selfPos;
      if (!from) continue;
      const strength = Math.max(0.05, Math.min(1, p.strength));
      const cx = state.w / 2;
      const cy = state.h / 2;
      ctx.strokeStyle = color(p.type);
      ctx.globalAlpha = 0.10 + strength * 0.5;
      ctx.lineWidth = 0.6 + strength * 3;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo((from.x + cx) / 2 + (Math.random() - 0.5) * 26, (from.y + cy) / 2 + (Math.random() - 0.5) * 26, cx, cy);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // links between alive nodes
    const nodes = (s.nodes || []).filter((n) => n.status === 'alive');
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = pos.get(nodes[i].nodeId);
        const b = pos.get(nodes[j].nodeId);
        if (!a || !b) continue;
        ctx.strokeStyle = 'rgba(150,190,255,0.18)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 7]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // nodes
    for (const [id, p] of pos) {
      const isSelf = id === state.self;
      const dead = p.node.status !== 'alive';
      const radius = isSelf ? 15 : 10;
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 3.4);
      glow.addColorStop(0, dead ? 'rgba(255,159,177,0.9)' : isSelf ? 'rgba(255,212,121,0.95)' : 'rgba(143,228,255,0.85)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = dead ? '#ff9fb1' : isSelf ? '#ffe9b0' : '#dff4ff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(230,240,255,0.92)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(`${id}${isSelf ? ' (this node)' : ''}`, p.x + radius + 7, p.y + 3.5);
      ctx.fillStyle = 'rgba(160,190,230,0.75)';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(`load ${p.node.load ?? 0} · done ${p.node.tasksDone ?? 0}`, p.x + radius + 7, p.y + 16);
    }

    // particles = tasks in flight (from origin to hub)
    const cx = state.w / 2;
    const cy = state.h / 2;
    for (const part of state.particles) {
      const from = pos.get(part.from) || { x: cx, y: cy };
      const k = 1 - part.life / part.ttl;
      const x = from.x + (cx - from.x) * k;
      const y = from.y + (cy - from.y) * k;
      ctx.fillStyle = part.ok === false ? '#ff9fb1' : '#7df0b0';
      ctx.globalAlpha = Math.max(0, part.life / part.ttl);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      part.life -= 1;
    }
    state.particles = state.particles.filter((p) => p.life > 0);

    // hub (task pool)
    const pulse = 1 + Math.sin(state.t / 18) * 0.06;
    ctx.strokeStyle = 'rgba(255,212,121,0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, 30 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,212,121,0.10)';
    ctx.beginPath();
    ctx.arc(cx, cy, 30 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,236,190,0.9)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('TASK POOL', cx, cy + 44);
    ctx.fillText(`${s.stats?.tasksKnown ?? 0} known · ${s.stats?.tasksDone ?? 0} done`, cx, cy + 58);
    ctx.textAlign = 'left';
    state.t += 1;
  }

  function apply(snap) {
    state.snapshot = snap;
    if (snap.node?.id) {
      state.self = snap.node.id;
      $('nodeId').textContent = `node ${snap.node.id} · udp :${snap.node.port}`;
    }
    $('sNodes').textContent = snap.nodes.filter((n) => n.status === 'alive').length;
    $('sTasks').textContent = snap.stats?.tasksKnown ?? 0;
    $('sDone').textContent = snap.stats?.tasksDone ?? 0;
    $('sPher').textContent = (snap.pheromones || []).length;
    $('sCrdt').textContent = snap.stats?.crdtSize ?? 0;
    $('sLoad').textContent = snap.node?.load ?? 0;
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/events`;
    $('wsUrl').textContent = url.replace(/^wss?:\/\//, '');
    const ws = new WebSocket(url);
    ws.onopen = () => {
      state.connected = true;
      $('conn').classList.remove('off');
      $('connText').textContent = 'connected';
      logLine('WebSocket connected', '#7df0b0');
    };
    ws.onclose = () => {
      state.connected = false;
      $('conn').classList.add('off');
      $('connText').textContent = 'reconnecting…';
      logLine('WebSocket closed — retrying in 2s', '#ff9fb1');
      setTimeout(connect, 2000);
    };
    ws.onerror = () => logLine('WebSocket error', '#ff9fb1');
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
          state.particles.push({ from: msg.nodeId || state.self, life: 60, ttl: 60, ok: true });
          logLine(`task done on <b>${msg.nodeId}</b> in ${msg.ms}ms`, '#7df0b0');
        } else if (msg.kind === 'task_failed') {
          state.particles.push({ from: msg.nodeId || state.self, life: 60, ttl: 60, ok: false });
          logLine(`task failed on ${msg.nodeId}: ${msg.error}`, '#ff9fb1');
        } else if (msg.kind === 'task_seen') {
          logLine(`task seen: ${msg.type} (${String(msg.taskId).slice(0, 12)}…) from ${msg.origin}`, '#8fe4ff');
        } else if (msg.kind === 'membership') {
          logLine(`node ${msg.nodeId} → ${msg.status} (load ${msg.load ?? '-'})`, msg.status === 'alive' ? '#7df0b0' : '#ffd479');
        }
      }
    };
  }

  /**
   * Demo/screenshot mode: bez servera, sintetički roj.
   * Koristi se za `?demo=1` (screenshotovi, prodajne demonstracije bez mreže) i za `file://`.
   */
  function demoMode() {
    const nodes = ['node-8001', 'node-8002', 'node-8003'].map((nodeId) => ({ nodeId, status: 'alive', load: 0, tasksDone: 0, lastSeen: new Date().toISOString() }));
    let tick = 0;
    let done = 0;
    state.self = 'node-8001';
    $('conn').classList.add('off');
    $('connText').textContent = 'demo snapshot (no server)';
    logLine('demo mode — synthetic swarm, no WebSocket', '#ffd479');
    setInterval(() => {
      tick += 1;
      const pher = [];
      for (let i = 0; i < 7; i += 1) {
        pher.push({
          id: `ph-${i}`,
          type: ['hot', 'done', 'problem', 'opportunity'][i % 4],
          taskId: `task-${100 + i}`,
          by: nodes[i % 3].nodeId,
          strength: 0.25 + 0.75 * Math.abs(Math.sin((tick + i * 7) / 14)),
        });
      }
      if (tick % 6 === 0) {
        done += 1;
        const nodeId = nodes[tick % 3].nodeId;
        const node = nodes.find((n) => n.nodeId === nodeId);
        node.tasksDone += 1;
        node.load = tick % 2;
        state.particles.push({ from: nodeId, life: 60, ttl: 60, ok: true });
        logLine(`task done on <b>${nodeId}</b> in ${180 + (tick % 5) * 40}ms`, '#7df0b0');
      }
      apply({
        type: 'snapshot',
        ts: Date.now(),
        node: { id: 'node-8001', port: 8001, uptimeMs: tick * 1000, load: tick % 2, syncMs: 42 },
        nodes,
        pheromones: pher,
        tasks: Array.from({ length: 6 }, (_, i) => ({ id: `task-${100 + i}`, type: 'support.ticket', value: 1, origin: nodes[i % 3].nodeId, createdAt: new Date().toISOString() })),
        results: [],
        stats: { peersAlive: 2, tasksKnown: 6 + done, tasksDone: done, crdtSize: 14 + done, claimsLost: 1, gossip: { sent: tick * 6, received: tick * 6, rejected: 0, duplicates: 2 } },
      });
    }, 1000);
  }

  resize();
  logLine('live.js ready — waiting for swarm snapshot', '#8fe4ff');
  const params = new URLSearchParams(location.search);
  if (params.get('demo') === '1' || location.protocol === 'file:') demoMode();
  else connect();
  (function loop() {
    draw();
    requestAnimationFrame(loop);
  })();
})();
