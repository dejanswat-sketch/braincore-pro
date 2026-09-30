/* Braincore Pro — landing interactions (vanilla JS, zero dependencies)
   1. 360°-ish parallax rotation of the glass brain following the cursor
   2. scroll reveal
   3. copy-to-clipboard for command blocks
   4. live status pill + metrics fed by api.braincore.pro (graceful when offline)
   5. Stripe checkout guard when the payment link is not configured
*/
(() => {
  const API = 'https://api.braincore.pro';
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  // ── 1. brain parallax / rotation ──────────────────────────────────────
  const brain = document.getElementById('brain');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (brain && !reduced) {
    const stage = brain.parentElement;
    let raf = null;
    let target = { x: 0, y: 0 };
    let current = { x: 0, y: 0 };
    const tick = () => {
      current.x += (target.x - current.x) * 0.08;
      current.y += (target.y - current.y) * 0.08;
      brain.style.transform = `rotateY(${current.x}deg) rotateX(${current.y}deg) translateZ(0)`;
      raf = Math.abs(target.x - current.x) > 0.05 || Math.abs(target.y - current.y) > 0.05 ? requestAnimationFrame(tick) : null;
    };
    const move = (clientX, clientY) => {
      const rect = stage.getBoundingClientRect();
      const px = (clientX - rect.left) / rect.width - 0.5;
      const py = (clientY - rect.top) / rect.height - 0.5;
      target = { x: Math.max(-16, Math.min(16, px * 34)), y: Math.max(-12, Math.min(12, -py * 26)) };
      if (!raf) raf = requestAnimationFrame(tick);
    };
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY), { passive: true });
    window.addEventListener('touchmove', (e) => e.touches[0] && move(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    stage.addEventListener('mouseleave', () => {
      target = { x: 0, y: 0 };
      if (!raf) raf = requestAnimationFrame(tick);
    });
    setInterval(() => {
      if (raf) return;
      if (Math.abs(target.x) < 0.1 && Math.abs(target.y) < 0.1) {
        target = { x: Math.sin(Date.now() / 2600) * 5, y: Math.cos(Date.now() / 3400) * 3.4 };
        raf = requestAnimationFrame(tick);
      }
    }, 2600);
  }

  // ── 2. scroll reveal ──────────────────────────────────────────────────
  const revealables = [...document.querySelectorAll('.reveal')];
  if ('IntersectionObserver' in window && !reduced) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    revealables.forEach((el, i) => {
      el.style.transitionDelay = `${Math.min(i % 6, 5) * 60}ms`;
      io.observe(el);
    });
  } else {
    revealables.forEach((el) => el.classList.add('in'));
  }

  // ── 3. copy buttons ───────────────────────────────────────────────────
  for (const button of document.querySelectorAll('.copy')) {
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.dataset.copy);
      if (!target) return;
      const text = target.innerText.trim();
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'copied ✓';
      } catch {
        button.textContent = 'select & copy';
      }
      setTimeout(() => {
        button.textContent = 'copy';
      }, 1800);
    });
  }

  // ── 4. live API status + metrics ──────────────────────────────────────
  const dot = document.getElementById('api-dot');
  const label = document.getElementById('api-status');
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  async function refresh() {
    try {
      const health = await fetch(`${API}/health`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
      if (dot) {
        dot.classList.remove('bg-slate-500', 'text-slate-500');
        dot.classList.add('bg-emerald-400', 'text-emerald-400');
      }
      if (label) label.textContent = `api live · ${String(health.nodeId ?? '').slice(0, 16)}`;
      set('m-api', 'healthy');

      const m = await fetch(`${API}/metrics`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
      if (m) {
        set('m-nodes', (m.peersAlive ?? 0) + 1);
        set('m-done', m.tasksDone ?? 0);
        set('m-pher', m.pheromones?.active ?? 0);
        set('m-crdt', m.crdtSize ?? 0);
        set('m-ws', m.liveClients ?? 0);
      }
    } catch {
      if (dot) {
        dot.classList.add('bg-slate-500', 'text-slate-500');
        dot.classList.remove('bg-emerald-400', 'text-emerald-400');
      }
      if (label) label.textContent = 'api offline (demo)';
      set('m-api', 'unreachable');
    }
  }

  refresh();
  setInterval(refresh, 10_000);

  // ── 5. checkout guard (uključuje se kad se doda Stripe Payment Link) ──
  const checkout = document.getElementById('checkout');
  if (checkout && checkout.href.includes('REPLACE_WITH_YOUR_PAYMENT_LINK')) {
    checkout.addEventListener('click', (e) => {
      e.preventDefault();
      // eslint-disable-next-line no-alert
      alert('Stripe payment link is not configured yet.\n\nReplace REPLACE_WITH_YOUR_PAYMENT_LINK in site/index.html with your Stripe Payment Link, or point it at your own checkout endpoint.');
    });
  }
})();
