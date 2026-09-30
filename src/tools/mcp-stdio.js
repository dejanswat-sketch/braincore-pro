/**
 * MCP klijent preko stdio transporta (JSON-RPC 2.0, jedna linija = jedna poruka).
 * Nema zavisnosti — koristi node:child_process.
 */
import { spawn } from 'node:child_process';
import { ToolError, TimeoutError } from '../core/errors.js';
import { uid } from '../core/ids.js';

export function createStdioMcpClient({ id = uid('mcp'), command, args = [], env = {}, processEnv, cwd, logger, requestTimeoutMs = 20_000 } = {}) {
  const pending = new Map();
  const notificationHandlers = new Set();
  let buffer = '';
  let nextId = 1;
  let closed = false;
  let serverInfo = null;

  const child = spawn(command, args, {
    cwd,
    env: processEnv ?? { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.on('error', (err) => {
    logger?.error?.('mcp.spawn_failed', { id, command, error: err.message });
    for (const [, p] of pending) p.reject(new ToolError(`MCP server "${id}" nije pokrenut: ${err.message}`, { id }));
    pending.clear();
  });

  child.on('exit', (code, signal) => {
    closed = true;
    for (const [, p] of pending) p.reject(new ToolError(`MCP server "${id}" je prekinut (code=${code}, signal=${signal})`, { id }));
    pending.clear();
    logger?.warn?.('mcp.exited', { id, code, signal });
  });

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) handleLine(line);
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (text) logger?.debug?.('mcp.stderr', { id, text: text.slice(0, 400) });
  });

  function handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      logger?.debug?.('mcp.bad_json', { id, line: line.slice(0, 200) });
      return;
    }
    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new ToolError(`MCP greška (${msg.error.code}): ${msg.error.message}`, { id, method: p.method, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }
    for (const h of notificationHandlers) h(msg);
  }

  function request(method, params = {}) {
    if (closed) return Promise.reject(new ToolError(`MCP server "${id}" je zatvoren`, { id, method }, { retryable: false }));
    const id2 = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id2);
        reject(new TimeoutError(`MCP "${id}" nije odgovorio na ${method} u ${requestTimeoutMs}ms`, { id, method }));
      }, requestTimeoutMs);
      pending.set(id2, { resolve, reject, timer, method });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: id2, method, params })}\n`);
    });
  }

  function notify(method, params = {}) {
    if (closed) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  return {
    id,
    transport: 'stdio',
    get serverInfo() {
      return serverInfo;
    },
    onNotification: (h) => {
      notificationHandlers.add(h);
      return () => notificationHandlers.delete(h);
    },
    async initialize({ clientName = 'nmq-robot', clientVersion = '0.1.0' } = {}) {
      const result = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: { roots: { listChanged: false }, sampling: {} },
        clientInfo: { name: clientName, version: clientVersion },
      });
      serverInfo = result?.serverInfo ?? null;
      notify('notifications/initialized', {});
      return result;
    },
    listTools: async () => {
      const result = await request('tools/list', {});
      return result?.tools ?? [];
    },
    callTool: async (name, toolArgs = {}) => request('tools/call', { name, arguments: toolArgs }),
    async close() {
      if (closed) return;
      closed = true;
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      const killer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2000);
      child.once('exit', () => clearTimeout(killer));
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}
