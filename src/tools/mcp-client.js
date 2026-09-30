/**
 * MCP most: spaja MCP servere u interni Tool registry.
 * Alat dobija ime "<serverId>.<toolName>" da se nikad ne sudara sa ugrađenim.
 *
 * Primjer iz config/tools.json:
 * {
 *   "id": "nmq-crm",
 *   "transport": "stdio",
 *   "command": "node",
 *   "args": ["mcp/example-server.mjs"],
 *   "enabled": true,
 *   "riskLevel": "medium",
 *   "scopes": ["crm:read", "crm:write"],
 *   "tools": { "crm_note_add": { "riskLevel": "high" } }
 * }
 */
import { createStdioMcpClient } from './mcp-stdio.js';
import { createHttpMcpClient } from './mcp-http.js';
import { ToolError } from '../core/errors.js';
import { redact } from '../core/logger.js';
import path from 'node:path';

export function createMcpManager({ registry, logger, metrics, root = process.cwd(), sandbox } = {}) {
  const clients = new Map();

  async function connect(cfg) {
    // Sandbox: podproces dobija očišćen env (samo allowlist + NMQ_*) — nikad tajne hosta
    sandbox?.assertCanSpawn?.(cfg.command);
    const safeEnv = sandbox?.scrubEnv ? sandbox.scrubEnv(cfg.env ?? {}) : { ...process.env, ...(cfg.env ?? {}) };
    const limits = sandbox?.limits?.() ?? { maxTimeoutMs: cfg.timeoutMs ?? 30_000 };

    const client =
      cfg.transport === 'http' || cfg.url
        ? createHttpMcpClient({ id: cfg.id, url: cfg.url, headers: cfg.headers, logger, requestTimeoutMs: cfg.timeoutMs })
        : createStdioMcpClient({
            id: cfg.id,
            command: cfg.command,
            args: cfg.args ?? [],
            cwd: cfg.cwd ? path.resolve(root, cfg.cwd) : root,
            env: cfg.env ?? {},
            processEnv: safeEnv,
            logger,
            requestTimeoutMs: Math.min(cfg.timeoutMs ?? 30_000, limits.maxTimeoutMs ?? 30_000),
          });

    await client.initialize();
    const remoteTools = await client.listTools();
    const registered = [];

    for (const rt of remoteTools) {
      const override = cfg.tools?.[rt.name] ?? {};
      const name = `${cfg.id}.${rt.name}`;
      registry.register({
        name,
        description: rt.description ?? `MCP alat ${rt.name} (${cfg.id})`,
        params: rt.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true },
        riskLevel: override.riskLevel ?? cfg.riskLevel ?? 'medium',
        scopes: override.scopes ?? cfg.scopes ?? [],
        source: `mcp:${cfg.id}`,
        tags: ['mcp', cfg.id, ...(cfg.tags ?? [])],
        timeoutMs: cfg.timeoutMs ?? 30_000,
        retries: cfg.retries ?? 0,
        handler: async (args, ctx) => {
          metrics?.inc('mcp_calls_total', { server: cfg.id, tool: rt.name });
          const started = Date.now();
          try {
            const result = await client.callTool(rt.name, args);
            const text = extractText(result);
            return {
              server: cfg.id,
              tool: rt.name,
              isError: Boolean(result?.isError),
              text,
              structured: result?.structuredContent ?? null,
              raw: result,
              durationMs: Date.now() - started,
            };
          } catch (err) {
            metrics?.inc('mcp_errors_total', { server: cfg.id, tool: rt.name });
            logger?.warn?.('mcp.call_failed', { server: cfg.id, tool: rt.name, error: err.message });
            throw new ToolError(`MCP "${cfg.id}" alat "${rt.name}" pao: ${err.message}`, { server: cfg.id, tool: rt.name });
          }
        },
      });
      registered.push(name);
    }

    clients.set(cfg.id, { client, cfg, tools: registered });
    logger?.info?.('mcp.connected', { id: cfg.id, transport: client.transport, tools: registered.length });
    return { id: cfg.id, tools: registered, serverInfo: client.serverInfo };
  }

  return {
    clients,
    /** Povezuje sve enabled servere; greška jednog ne ruši ostale. */
    async connectAll(servers = []) {
      const results = [];
      for (const cfg of servers.filter((s) => s.enabled !== false)) {
        try {
          results.push(await connect(cfg));
        } catch (err) {
          logger?.error?.('mcp.connect_failed', { id: cfg.id, error: redact(err.message) });
          results.push({ id: cfg.id, tools: [], error: err.message });
        }
      }
      return results;
    },
    get: (id) => clients.get(id),
    list: () => [...clients.values()].map(({ cfg, tools, client }) => ({ id: cfg.id, transport: client.transport, tools })),
    async closeAll() {
      for (const { client } of clients.values()) await client.close().catch(() => {});
      clients.clear();
    },
  };
}

function extractText(result) {
  const parts = result?.content ?? [];
  return parts
    .map((p) => (p.type === 'text' ? p.text : `[${p.type}]`))
    .join('\n')
    .trim();
}
