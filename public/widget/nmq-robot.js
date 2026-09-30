/**
 * NMQ Robot — embed widget (jedan fajl, bez zavisnosti, Shadow DOM).
 *
 * Ugradnja na bilo koji sajt:
 *   <script src="https://robot.example.com/widget.js"
 *           data-tenant="demo-shop"
 *           data-agent="support"
 *           data-key="nmq_..."            (opciono; ako je requireAuth uključen — obavezno)
 *           data-title="Podrška"
 *           data-color="#ff6a00"
 *           data-greeting="Zdravo! Kako mogu da pomognem?"
 *           defer></script>
 *
 * Napredno (programski):
 *   const r = NMQRobot.init({ baseUrl, tenant, agent, key });
 *   r.open(); r.ask('Status narudžbine 1042'); r.on('done', (e) => console.log(e));
 */
(function () {
  'use strict';

  const SCRIPT = document.currentScript || document.querySelector('script[data-nmq-robot]');
  const DEFAULTS = {
    baseUrl: (SCRIPT && SCRIPT.src ? new URL(SCRIPT.src).origin : location.origin),
    tenant: (SCRIPT && SCRIPT.dataset.tenant) || 'nmq',
    agent: (SCRIPT && SCRIPT.dataset.agent) || 'support',
    key: (SCRIPT && SCRIPT.dataset.key) || '',
    title: (SCRIPT && SCRIPT.dataset.title) || 'NMQ Robot',
    subtitle: (SCRIPT && SCRIPT.dataset.subtitle) || 'AI asistent',
    color: (SCRIPT && SCRIPT.dataset.color) || '#ff6a00',
    greeting: (SCRIPT && SCRIPT.dataset.greeting) || 'Zdravo! Pitaj me bilo šta — odgovaram iz vaše dokumentacije i podataka.',
    position: (SCRIPT && SCRIPT.dataset.position) || 'right',
    suggested: (SCRIPT && SCRIPT.dataset.suggested ? SCRIPT.dataset.suggested.split('|') : ['Kako da resetujem lozinku?', 'Status narudžbine 1042', 'Koliko košta Pro paket?']),
    consentNote: (SCRIPT && SCRIPT.dataset.consentNote) || 'Razgovor se čuva radi kvaliteta usluge.',
  };

  const ICONS = {
    chat: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
  };

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif; }
  .launcher { position: fixed; bottom: 20px; width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer;
    background: var(--nmq-color); color: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.28); display: flex; align-items: center;
    justify-content: center; transition: transform .15s ease; z-index: 2147483000; }
  .launcher:hover { transform: scale(1.06); }
  .launcher.right { right: 20px; } .launcher.left { left: 20px; }
  .badge { position: absolute; top: -4px; right: -4px; background: #e11d48; color: #fff; font-size: 11px; border-radius: 10px;
    padding: 1px 6px; font-weight: 600; }
  .panel { position: fixed; bottom: 88px; width: 380px; max-width: calc(100vw - 32px); height: 560px; max-height: calc(100vh - 120px);
    background: #fff; border-radius: 16px; box-shadow: 0 24px 60px rgba(0,0,0,.32); display: flex; flex-direction: column;
    overflow: hidden; z-index: 2147483000; opacity: 0; transform: translateY(12px) scale(.98); pointer-events: none; transition: opacity .18s ease, transform .18s ease; }
  .panel.right { right: 20px; } .panel.left { left: 20px; }
  .panel.open { opacity: 1; transform: none; pointer-events: auto; }
  header { background: var(--nmq-color); color: #fff; padding: 14px 16px; display: flex; align-items: center; gap: 10px; }
  header .t { font-weight: 650; font-size: 15px; }
  header .s { font-size: 12px; opacity: .85; }
  header .spacer { flex: 1; }
  header button { background: transparent; border: none; color: #fff; cursor: pointer; opacity: .9; display: flex; }
  .log { flex: 1; overflow-y: auto; padding: 14px; background: #f7f8fa; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 86%; padding: 10px 13px; border-radius: 14px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user { align-self: flex-end; background: var(--nmq-color); color: #fff; border-bottom-right-radius: 4px; }
  .msg.bot { align-self: flex-start; background: #fff; color: #111827; border: 1px solid #e5e7eb; border-bottom-left-radius: 4px; }
  .msg.err { align-self: flex-start; background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
  .meta { font-size: 11px; color: #6b7280; align-self: flex-start; margin-top: -4px; }
  .steps { font-size: 11.5px; color: #4b5563; background: #eef2f7; border-radius: 8px; padding: 6px 9px; align-self: flex-start; max-width: 92%; }
  .suggested { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 10px; background: #f7f8fa; }
  .chip { border: 1px solid #d1d5db; background: #fff; color: #374151; border-radius: 999px; padding: 5px 11px; font-size: 12.5px; cursor: pointer; }
  .chip:hover { border-color: var(--nmq-color); color: var(--nmq-color); }
  footer { border-top: 1px solid #e5e7eb; padding: 10px; display: flex; gap: 8px; align-items: flex-end; background: #fff; }
  textarea { flex: 1; resize: none; border: 1px solid #d1d5db; border-radius: 10px; padding: 9px 11px; font-size: 14px;
    max-height: 96px; min-height: 40px; outline: none; }
  textarea:focus { border-color: var(--nmq-color); }
  .send { background: var(--nmq-color); border: none; color: #fff; border-radius: 10px; padding: 10px 12px; cursor: pointer; display: flex; }
  .send:disabled { opacity: .45; cursor: default; }
  .note { font-size: 10.5px; color: #9ca3af; text-align: center; padding: 0 10px 8px; background: #fff; }
  .fb { display: flex; gap: 8px; font-size: 11px; color: #6b7280; align-items: center; }
  .fb button { border: 1px solid #e5e7eb; background: #fff; border-radius: 8px; cursor: pointer; padding: 2px 7px; }
  .typing span { display: inline-block; width: 6px; height: 6px; margin-right: 3px; background: #9ca3af; border-radius: 50%; animation: b 1s infinite; }
  .typing span:nth-child(2) { animation-delay: .15s; } .typing span:nth-child(3) { animation-delay: .3s; }
  @keyframes b { 0%,60%,100% { opacity: .3 } 30% { opacity: 1 } }
  @media (prefers-color-scheme: dark) {
    .panel { background: #0f172a; } .log { background: #0b1220; } .msg.bot { background: #16233b; color: #e5e7eb; border-color: #22304a; }
    .msg.err { background: #3f1d1d; color: #fecaca; border-color: #7f1d1d; } footer, .note { background: #0f172a; border-color: #22304a; }
    textarea { background: #0b1220; color: #e5e7eb; border-color: #22304a; } .chip { background: #16233b; color: #cbd5e1; border-color: #22304a; }
    .steps { background: #16233b; color: #cbd5e1; } .fb button { background: #16233b; color: #cbd5e1; border-color: #22304a; }
  }
  `;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v !== undefined && v !== null) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return node;
  }

  function createRobotWidget(options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const listeners = new Map();
    const sessionKey = `nmq_session_${cfg.tenant}_${cfg.agent}`;
    const sessionId = sessionStorage.getItem(sessionKey) || `web_${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(sessionKey, sessionId);

    const host = el('div', { 'data-nmq-widget': '' });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(el('style', { html: CSS.replace(/var\(--nmq-color\)/g, cfg.color) }));
    shadow.style.setProperty('--nmq-color', cfg.color);

    const log = el('div', { class: 'log' });
    const launcher = el('button', { class: 'launcher ' + cfg.position, 'aria-label': 'Otvori chat', html: ICONS.chat });
    const panel = el('div', { class: 'panel ' + cfg.position });
    const badge = el('span', { class: 'badge', style: 'display:none' });
    launcher.appendChild(badge);

    const input = el('textarea', { rows: '1', placeholder: 'Napiši poruku…', 'aria-label': 'Poruka' });
    const sendBtn = el('button', { class: 'send', 'aria-label': 'Pošalji', html: ICONS.send });
    const chips = el('div', { class: 'suggested' }, cfg.suggested.map((s) => el('button', { class: 'chip', onclick: () => ask(s) }, s)));

    panel.append(
      el('header', {}, [
        el('div', {}, [el('div', { class: 't' }, cfg.title), el('div', { class: 's' }, cfg.subtitle)]),
        el('div', { class: 'spacer' }),
        el('button', { 'aria-label': 'Zatvori', html: ICONS.close, onclick: close }),
      ]),
      log,
      chips,
      el('footer', {}, [input, sendBtn]),
      el('div', { class: 'note' }, cfg.consentNote),
    );

    shadow.append(panel, launcher);
    document.body.appendChild(host);

    let open = false;
    let busy = false;
    let greeted = false;

    function emit(type, payload) {
      const fns = listeners.get(type) || [];
      for (const fn of fns) {
        try {
          fn(payload);
        } catch (e) {
          console.warn('[nmq-robot] listener error', e);
        }
      }
    }

    function bubble(role, text) {
      const node = el('div', { class: `msg ${role}` }, text);
      log.appendChild(node);
      log.scrollTop = log.scrollHeight;
      return node;
    }

    function openPanel() {
      open = true;
      panel.classList.add('open');
      badge.style.display = 'none';
      if (!greeted) {
        greeted = true;
        bubble('bot', cfg.greeting);
        systemLine(`tenant: ${cfg.tenant} · agent: ${cfg.agent}`);
      }
      setTimeout(() => input.focus(), 120);
      emit('open');
    }

    function close() {
      open = false;
      panel.classList.remove('open');
      emit('close');
    }

    function systemLine(text) {
      const node = el('div', { class: 'steps' }, text);
      log.appendChild(node);
      log.scrollTop = log.scrollHeight;
      return node;
    }

    launcher.addEventListener('click', () => (open ? close() : openPanel()));

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        ask(input.value);
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(96, input.scrollHeight)}px`;
    });
    sendBtn.addEventListener('click', () => ask(input.value));

    async function ask(text) {
      const question = String(text || '').trim();
      if (!question || busy) return;
      busy = true;
      sendBtn.disabled = true;
      input.value = '';
      input.style.height = 'auto';
      bubble('user', question);
      const botNode = el('div', { class: 'msg bot' }, el('span', { class: 'typing', html: '<span></span><span></span><span></span>' }));
      log.appendChild(botNode);
      log.scrollTop = log.scrollHeight;
      let buffer = '';
      emit('ask', { question });

      try {
        const res = await fetch(`${cfg.baseUrl}/v1/agents/${encodeURIComponent(cfg.agent)}/stream`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}),
          },
          body: JSON.stringify({ input: question, sessionId, tenantId: cfg.tenant, options: cfg.options || {} }),
        });
        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${errText.slice(0, 200)}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let raw = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
          const blocks = raw.split('\n\n');
          raw = blocks.pop();
          for (const block of blocks) {
            const evLine = block.split('\n').find((l) => l.startsWith('event:'));
            const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const type = evLine ? evLine.slice(6).trim() : 'message';
            let data;
            try {
              data = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }
            emit(type, data);
            if (type === 'token') {
              buffer += data.text || '';
              botNode.textContent = buffer;
              log.scrollTop = log.scrollHeight;
            } else if (type === 'step') {
              if (data.type === 'tool_start') systemLine(`🔧 ${data.name}`);
              if (data.type === 'routing') systemLine(`→ ${data.agentId} (${Math.round((data.confidence || 0) * 100)}%)`);
              if (data.type === 'plan') systemLine(`plan: ${data.subtasks?.length ?? 0} podzadataka`);
              if (data.type === 'handoff') systemLine(`↪ ${data.from} → ${data.to}`);
            } else if (type === 'done') {
              if (!buffer && data.output) botNode.textContent = data.output;
              const meta = el('div', { class: 'meta' }, `agent: ${data.agentId} · ${data.pattern} · ${(data.costUsd ?? 0).toFixed(4)} USD`);
              log.appendChild(meta);
              if (data.approvals?.length) {
                systemLine(`⏸ čeka odobrenje: ${data.approvals.map((a) => a.tool).join(', ')}`);
              }
              const fb = el('div', { class: 'fb' }, [
                'Ocijeni:',
                el('button', { onclick: () => feedback('up', data.runId, fb) }, '👍'),
                el('button', { onclick: () => feedback('down', data.runId, fb) }, '👎'),
              ]);
              log.appendChild(fb);
              log.scrollTop = log.scrollHeight;
            } else if (type === 'error') {
              throw new Error(data.message || 'greška');
            }
          }
        }
      } catch (err) {
        botNode.className = 'msg err';
        botNode.textContent = `Greška: ${err.message}`;
        emit('error', err);
      } finally {
        busy = false;
        sendBtn.disabled = false;
        log.scrollTop = log.scrollHeight;
      }
    }

    async function feedback(rating, runId, container) {
      try {
        await fetch(`${cfg.baseUrl}/v1/feedback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
          body: JSON.stringify({ rating, runId, tenantId: cfg.tenant, comment: '' }),
        });
        container.innerHTML = '<em>Hvala!</em>';
      } catch {
        container.innerHTML = '<em>Nije poslano</em>';
      }
    }

    return {
      open: openPanel,
      close,
      toggle: () => (open ? close() : openPanel()),
      ask,
      setBadge(n) {
        badge.textContent = String(n);
        badge.style.display = open ? 'none' : 'block';
      },
      on(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
        return () => listeners.get(type).splice(listeners.get(type).indexOf(fn), 1);
      },
      destroy() {
        host.remove();
        listeners.clear();
      },
      config: cfg,
      sessionId,
    };
  }

  window.NMQRobot = {
    init: createRobotWidget,
    version: '0.1.0',
    /** Auto-init ako je script tag imao data-auto="1" */
    auto: (() => {
      if (SCRIPT && SCRIPT.dataset.auto === '1') {
        const instance = createRobotWidget();
        if (SCRIPT.dataset.open === '1') instance.open();
        return instance;
      }
      return null;
    })(),
  };

  document.dispatchEvent(new CustomEvent('nmq-robot:ready', { detail: { version: '0.1.0' } }));
})();
