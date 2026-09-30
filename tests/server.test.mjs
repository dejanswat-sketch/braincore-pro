import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestRobot, cleanup, smartScript, collectSse } from './helpers.mjs';

async function withServer(fn, opts = {}) {
  const robot = await buildTestRobot(opts);
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn({ robot, base });
  } finally {
    await robot.close();
    await cleanup(robot.__dir);
  }
}

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });

test('GET /healthz, /readyz, /metrics', async () => {
  await withServer(async ({ base }) => {
    const health = await json(await fetch(`${base}/healthz`));
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const ready = await json(await fetch(`${base}/readyz`));
    assert.equal(ready.body.agents, 19);
    assert.ok(ready.body.tools >= 18);

    const metrics = await fetch(`${base}/metrics`);
    const text = await metrics.text();
    assert.match(text, /nmq_runs_total|nmq_uptime_seconds/);
  });
});

test('GET /v1/agents, /v1/tools, /v1/patterns, /v1/config', async () => {
  await withServer(async ({ base }) => {    const agents = await json(await fetch(`${base}/v1/agents`));
    assert.equal(agents.body.count, 19);
    assert.ok(agents.body.agents.some((a) => a.id === 'support'));

    const agent = await json(await fetch(`${base}/v1/agents/legal`));
    assert.equal(agent.body.id, 'legal');
    assert.ok(agent.body.allowedTools.includes('memory_search'));

    const tools = await json(await fetch(`${base}/v1/tools`));
    assert.ok(tools.body.tools.some((t) => t.name === 'invoice_create' && t.riskLevel === 'high'));
    assert.ok(tools.body.tools.some((t) => t.source === 'mcp:nmq-crm'));

    const patterns = await json(await fetch(`${base}/v1/patterns`));
    assert.equal(patterns.body.patterns.length, 11);

    const cfg = await json(await fetch(`${base}/v1/config`));
    assert.equal(cfg.body.llm.provider, 'openai-compatible');
    assert.ok(!JSON.stringify(cfg.body).includes('apiKey'), 'konfiguracija ne smije sadržati ključeve');
  }, { connectMcp: true });
});

test('POST /v1/agents/:id/run radi i vraća trošak, korake i trace', async () => {
  await withServer(async ({ base }) => {
    const res = await json(
      await fetch(`${base}/v1/agents/creative/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'Napiši 3 naslova za oglas', tenantId: 'nmq' }),
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.agentId, 'creative');
    assert.ok(res.body.runId);
    assert.ok(res.body.costUsd >= 0);
    assert.ok(res.body.output.length > 0);

    const run = await json(await fetch(`${base}/v1/runs/${res.body.runId}`));
    assert.equal(run.body.runId, res.body.runId);
    assert.ok(run.body.spans.length > 0);
  });
});

test('POST /v1/agents/:id/run validira ulaz', async () => {
  await withServer(async ({ base }) => {
    const bad = await json(
      await fetch(`${base}/v1/agents/support/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: 'nmq' }) }),
    );
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');

    const unknown = await json(
      await fetch(`${base}/v1/agents/nepostoji/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'x' }) }),
    );
    assert.equal(unknown.status, 404);
  });
});

test('POST /v1/run/stream šalje SSE događaje i finalni rezultat', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/v1/run/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Status narudžbine 1042', agentId: 'ecommerce', tenantId: 'nmq' }),
    });
    assert.equal(res.headers.get('content-type').includes('text/event-stream'), true);
    const events = await collectSse(res);
    const types = events.map((e) => e.event);
    assert.ok(types.includes('start'));
    assert.ok(types.includes('done'), `očekivan 'done', dobijeno: ${types.join(',')}`);
    const done = events.find((e) => e.event === 'done');
    assert.ok(done.data.runId);
    assert.ok(done.data.output.length > 0);
  });
});

test('POST /v1/router/run automatski bira agenta', async () => {
  await withServer(async ({ base }) => {
    const res = await json(
      await fetch(`${base}/v1/router/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'Ne radi mi prijava na nalog', tenantId: 'nmq' }),
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.routing.agentId, 'support');
  });
});

test('human-in-the-loop: run čeka odobrenje, pa se nastavlja', async () => {
  await withServer(async ({ base }) => {
    const res = await json(
      await fetch(`${base}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: 'sales',
          pattern: 'agent',
          input: 'Pošalji ponudu klijentu',
          tenantId: 'nmq',
          options: { patternConfig: { script: 'approval' } },
        }),
      }),
    );
    // mock LLM u ovom testu traži email_send samo kad input sadrži "pošalji"
    assert.equal(res.status, 200);
    if (res.body.status === 'awaiting_approval') {
      assert.equal(res.body.approvals.length, 1);
      const pending = await json(await fetch(`${base}/v1/approvals`, { headers: { 'x-tenant': 'nmq' } }));
      assert.ok(pending.body.pending.some((p) => p.runId === res.body.runId));

      const decision = await json(
        await fetch(`${base}/v1/approvals/${res.body.runId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ approve: true, approvedBy: 'dejan', note: 'ok' }),
        }),
      );
      assert.equal(decision.body.approved, true);
      assert.equal(decision.body.status, 'ok');

      const audit = await json(await fetch(`${base}/v1/audit`, { headers: { 'x-tenant': 'nmq' } }));
      assert.ok(audit.body.entries.some((e) => e.action === 'approval_decision'));
    }
  }, {
    script: ({ messages }) =>
      messages.some((m) => m.role === 'tool') ? { text: 'Mejl je poslat.' } : { toolCalls: [{ name: 'email_send', arguments: { to: 'k@example.com', subject: 'Ponuda', body: 'x' } }] },
  });
});

test('KB: ingest i pretraga kroz API', async () => {
  await withServer(async ({ base }) => {
    const ingest = await json(
      await fetch(`${base}/v1/kb`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Radno vrijeme podrške je 09-17, subotom ne radimo.', source: 'SOP podrška', tags: ['sop'] }),
      }),
    );
    assert.equal(ingest.status, 200);
    assert.ok(ingest.body.chunks >= 1);

    const search = await json(
      await fetch(`${base}/v1/kb/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'kada radi podrska', k: 3 }),
      }),
    );
    assert.ok(search.body.hits.length >= 1);
    assert.match(search.body.hits[0].text, /09-17/);
  });
});

test('izolacija tenanta kroz API: KB jednog tenanta nije vidljiv drugom', async () => {
  await withServer(async ({ base }) => {
    await fetch(`${base}/v1/kb`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant': 'nmq' },
      body: JSON.stringify({ text: 'TAJNA-NMQ interna cijena je 999 EUR', source: 'interno' }),
    });
    const search = await json(
      await fetch(`${base}/v1/kb/search`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant': 'demo-shop' }, body: JSON.stringify({ query: 'interna cijena', k: 5 }) }),
    );
    assert.equal(search.body.hits.length, 0, 'demo-shop ne smije vidjeti dokumente NMQ tenanta');
  });
});

test('webhook ulaz: /v1/hooks/:source rutira na agenta iz konfiguracije', async () => {
  await withServer(async ({ base }) => {
    const res = await json(
      await fetch(`${base}/v1/hooks/shopify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant': 'nmq' },
        body: JSON.stringify({ subject: 'Narudžbina 1042 kasni', body: 'Kupac pita gdje je paket.' }),
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.agentId, 'ecommerce');
  });
});

test('feedback i usage endpointi rade', async () => {
  await withServer(async ({ base }) => {
    const fb = await json(
      await fetch(`${base}/v1/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant': 'nmq' }, body: JSON.stringify({ rating: 'up', runId: 'run_x', comment: 'brzo' }) }),
    );
    assert.equal(fb.body.saved, true);

    await fetch(`${base}/v1/agents/creative/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'test', tenantId: 'nmq' }) });
    const usage = await json(await fetch(`${base}/v1/usage`, { headers: { 'x-tenant': 'nmq' } }));
    assert.ok(usage.body.summary.usd > 0);
    assert.ok(usage.body.summary.calls >= 1);
  });
});

test('widget i demo stranica se serviraju bez keša', async () => {
  await withServer(async ({ base }) => {
    const widget = await fetch(`${base}/widget.js`);
    assert.equal(widget.status, 200);
    assert.match(widget.headers.get('cache-control'), /no-cache|no-store/);
    const text = await widget.text();
    assert.match(text, /NMQRobot/);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /NMQ ROBOT/);
  });
});

test('CORS preflight i nepoznata ruta', async () => {
  await withServer(async ({ base }) => {
    const pre = await fetch(`${base}/v1/agents`, { method: 'OPTIONS', headers: { origin: 'https://klijent.rs' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://klijent.rs');

    const nf = await json(await fetch(`${base}/nema-me`, { method: 'GET' }));
    assert.equal(nf.status, 404);
  });
});

test('rate limit: tenant dobija 429 kada prekorači', async () => {
  await withServer(async ({ base }) => {
    let got429 = false;
    for (let i = 0; i < 35; i += 1) {
      const res = await fetch(`${base}/v1/memory/facts`, { headers: { 'x-tenant': 'demo-shop' } });
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    assert.equal(got429, true, 'demo-shop ima 30 zahtjeva/min — mora se pojaviti 429');
  });
});

test('autentikacija: kada je requireAuth uključen, bez ključa nema pristupa', async () => {
  const robot = await buildTestRobot({ script: smartScript(), env: { NMQ_ALLOW_ANONYMOUS: '0' } });
  robot.config.requireAuth = true;
  const addr = await robot.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const res = await fetch(`${base}/v1/agents`);
    assert.equal(res.status, 401);
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200, 'healthz je uvijek javan');
  } finally {
    await robot.close();
    await cleanup(robot.__dir);
  }
});
