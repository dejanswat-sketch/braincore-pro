/**
 * MCP klijent preko Streamable HTTP transporta (JSON-RPC 2.0 u tijelu POST-a).
 * Server može odgovoriti kao application/json ILI kao text/event-stream (SSE) — oba se podržavaju.
 */
import { ToolError, TimeoutError } from '../core/errors.js';
import { uid } from '../core/ids.js';

export function createHttpMcpClient({ id = uid('mcp'), url, headers = {}, logger, requestTimeoutMs = 20_000, fetchImpl = globalThis.fetch } = {}) {
  let nextId = 1;
  let sessionId = null;
  let serverInfo = null;

  async function rpc(method, params = {}) {
    const body = { jsonrpc: '2.0', id: nextId++, method, params };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), requestTimeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      sessionId = res.headers.get('mcp-session-id') ?? sessionId;
      if (!res.ok) throw new ToolError(`MCP HTTP ${res.status} za ${method}`, { id, url, method });
      const ctype = res.headers.get('content-type') ?? '';
      if (ctype.includes('text/event-stream')) {
        const text = await res.text();
        const payload = text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .find((m) => m.id === body.id);
        if (!payload) throw new ToolError(`MCP SSE odgovor bez rezultata za ${method}`, { id, url });
        if (payload.error) throw new ToolError(`MCP greška: ${payload.error.message}`, { id, url, method });
        return payload.result;
      }
      const json = await res.json();
      if (json.error) throw new ToolError(`MCP greška: ${json.error.message}`, { id, url, method });
      return json.result;
    } catch (err) {
      if (err?.message === 'timeout') throw new TimeoutError(`MCP "${id}" timeout na ${method}`, { url });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id,
    transport: 'http',
    url,
    get serverInfo() {
      return serverInfo;
    },
    async initialize({ clientName = 'nmq-robot', clientVersion = '0.1.0' } = {}) {
      const result = await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: clientName, version: clientVersion },
      });
      serverInfo = result?.serverInfo ?? null;
      await rpc('notifications/initialized', {}).catch(() => {});
      return result;
    },
    listTools: async () => (await rpc('tools/list', {}))?.tools ?? [],
    callTool: (name, toolArgs = {}) => rpc('tools/call', { name, arguments: toolArgs }),
    close: async () => {},
  };
}
