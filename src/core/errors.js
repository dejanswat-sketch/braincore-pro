/**
 * Greške NMQ Robota. Svaka nosi: code (za klijenta), status (HTTP), retryable i details.
 * Klasifikacija: policy (ne smije) > budget (nema para) > retryable (probaćemo opet) > fatal (čovjek).
 */
export class NmqError extends Error {
  constructor(message, { code = 'NMQ_ERROR', status = 500, retryable = false, details = {}, cause } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
    if (cause) this.cause = cause;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details, retryable: this.retryable } };
  }
}

export class ValidationError extends NmqError {
  constructor(message, details) {
    super(message, { code: 'VALIDATION_ERROR', status: 400, details });
  }
}

export class NotFoundError extends NmqError {
  constructor(what, id) {
    super(`${what} nije nađen: ${id}`, { code: 'NOT_FOUND', status: 404, details: { what, id } });
  }
}

/**
 * BACKPRESSURE: red je pun — bolje odbiti odmah (429) nego pustiti da latencija eksplodira.
 * Uvedeno poslije soak testa: iznad ~8 taskova/s po procesu (runner 120 ms) red raste, a p95 skače
 * sa 0,8 s na 9 s. Klijent tada treba da uspori (Retry-After), a ne da čeka u nedogled.
 */
export class QueueFullError extends NmqError {
  constructor(details = {}) {
    super(
      `Roj je preko kapaciteta (red ${details.queueDepth ?? '?'} ≥ ${details.maxQueueDepth ?? '?'}); pokušaj ponovo uskoro`,
      { code: 'QUEUE_FULL', status: 429, retryable: true, details },
    );
  }
}

export class AuthError extends NmqError {
  constructor(message = 'Neautorizovan pristup') {
    super(message, { code: 'UNAUTHORIZED', status: 401 });
  }
}

export class PolicyError extends NmqError {
  constructor(message, details) {
    super(message, { code: 'POLICY_DENIED', status: 403, details });
  }
}

export class BudgetExceededError extends NmqError {
  constructor(message, details) {
    super(message, { code: 'BUDGET_EXCEEDED', status: 402, details });
  }
}

export class ApprovalRequiredError extends NmqError {
  constructor(message, details) {
    super(message, { code: 'APPROVAL_REQUIRED', status: 409, details });
  }
}

export class ToolError extends NmqError {
  constructor(message, details, { retryable = true } = {}) {
    super(message, { code: 'TOOL_ERROR', status: 502, retryable, details });
  }
}

export class LlmError extends NmqError {
  constructor(message, details, { retryable = true } = {}) {
    super(message, { code: 'LLM_ERROR', status: 502, retryable, details });
  }
}

export class TimeoutError extends NmqError {
  constructor(message, details) {
    super(message, { code: 'TIMEOUT', status: 504, retryable: true, details });
  }
}

/** Greška u klaster sloju (Redis/gossip/store) — retryable po defaultu jer je najčešće mrežna. */
export class RedisError extends NmqError {
  constructor(message, details) {
    super(message, { code: 'REDIS_ERROR', status: 502, retryable: true, details });
  }
}

export class ClusterError extends NmqError {
  constructor(message, details, { retryable = true } = {}) {
    super(message, { code: 'CLUSTER_ERROR', status: 503, retryable, details });
  }
}

/** Klasifikacija za retry/eskalaciju. */
export function classifyError(err) {
  if (err instanceof NmqError) {
    if (err.code === 'POLICY_DENIED' || err.code === 'APPROVAL_REQUIRED') return 'policy';
    if (err.code === 'BUDGET_EXCEEDED') return 'policy';
    if (err.retryable) return 'retryable';
    return 'fatal';
  }
  return 'fatal';
}

export const isAbort = (err) => err?.name === 'AbortError' || err?.code === 'ABORT_ERR';

export function toErrorPayload(err) {
  if (err instanceof NmqError) return { status: err.status, body: err.toJSON() };
  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: err?.message ?? 'Nepoznata greška', details: {} } },
  };
}
