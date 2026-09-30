/**
 * Minimalni async event bus (bez zavisnosti).
 * Koristi se za: streaming ka klijentu, metrike, audit, hookove (webhook → agent).
 */
export function createBus() {
  const handlers = new Map();

  const on = (event, handler) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
    return () => off(event, handler);
  };

  const off = (event, handler) => handlers.get(event)?.delete(handler);

  const once = (event, handler) => {
    const wrapped = (...args) => {
      off(event, wrapped);
      handler(...args);
    };
    return on(event, wrapped);
  };

  const emit = (event, payload) => {
    const direct = handlers.get(event);
    const wildcard = handlers.get('*');
    if (!direct && !wildcard) return 0;
    let n = 0;
    for (const handler of direct ?? []) {
      n += 1;
      safeCall(handler, payload, event);
    }
    for (const handler of wildcard ?? []) {
      n += 1;
      safeCall(handler, { event, payload }, event);
    }
    return n;
  };

  const safeCall = (handler, payload, event) => {
    try {
      const result = handler(payload);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => process.emitWarning(`bus handler [${event}] pao: ${err?.message}`));
      }
    } catch (err) {
      process.emitWarning(`bus handler [${event}] pao: ${err?.message}`);
    }
  };

  return { on, off, once, emit, clear: () => handlers.clear() };
}

export const bus = createBus();
