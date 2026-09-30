/**
 * OpenTelemetry izvoz (bez zavisnosti): run → OTLP/JSON `resourceSpans`.
 *
 * Dva načina:
 *   - `file`: svaki run se dopisuje kao OTLP/JSON linija → kasnije otprema OTel Collector-om ili `filelog` receiver-om
 *   - `endpoint`: POST na OTLP HTTP endpoint (/v1/traces) — ako padne, greška se samo loguje (ne ruši run)
 *
 * Konvencija atributa: `nmq.tenant`, `nmq.agent`, `nmq.pattern`, `nmq.run_id`, `nmq.cost_usd`, `gen_ai.*`.
 */
import path from 'node:path';
import { appendText } from '../core/fsx.js';
import { iso } from '../core/clock.js';

export function createOtelExporter({
  dataDir,
  file = true,
  endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '',
  headers = {},
  serviceName = 'nmq-robot',
  serviceVersion = '0.1.0',
  logger,
  fetchImpl = globalThis.fetch,
} = {}) {
  const traceFile = dataDir ? path.join(dataDir, '_global', 'otel-traces.jsonl') : null;
  let exported = 0;

  const hex = (id) => String(id ?? '').replace(/[^a-f0-9]/gi, '').padEnd(32, '0').slice(0, 32);
  const spanId = (id) => String(id ?? '').replace(/[^a-f0-9]/gi, '').padEnd(16, '0').slice(0, 16);

  function toOtlp(run) {
    const startMs = new Date(run.startedAt).getTime();
    const endMs = run.endedAt ? new Date(run.endedAt).getTime() : startMs;
    const resource = {
      attributes: [
        { key: 'service.name', value: { stringValue: serviceName } },
        { key: 'service.version', value: { stringValue: serviceVersion } },
        { key: 'nmq.tenant', value: { stringValue: run.tenantId } },
        { key: 'deployment.environment', value: { stringValue: process.env.NMQ_ENV ?? process.env.NODE_ENV ?? 'production' } },
      ],
    };
    const spans = (run.spans ?? []).map((s) => {
      const sStart = new Date(s.startedAt).getTime();
      return {
        traceId: hex(run.traceId),
        spanId: spanId(s.spanId),
        parentSpanId: s.parentSpanId ? spanId(s.parentSpanId) : undefined,
        name: s.name,
        kind: 1, // SPAN_KIND_INTERNAL
        startTimeUnixNano: `${sStart}000000`,
        endTimeUnixNano: `${sStart + Math.round((s.durationMs ?? 0))}000000`,
        attributes: [
          { key: 'nmq.agent', value: { stringValue: run.agentId ?? 'unknown' } },
          { key: 'nmq.pattern', value: { stringValue: run.pattern ?? 'agent' } },
          { key: 'nmq.run_id', value: { stringValue: run.runId } },
          { key: 'nmq.status', value: { stringValue: s.status ?? 'ok' } },
          ...Object.entries(s.attrs ?? {}).map(([k, v]) => ({
            key: `nmq.${k}`,
            value: typeof v === 'number' ? { doubleValue: v } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) },
          })),
        ],
        status: { code: s.status === 'error' ? 2 : 1 },
      };
    });

    // korijenski span cijelog run-a
    spans.push({
      traceId: hex(run.traceId),
      spanId: spanId(`${run.runId}root`),
      name: `agent.run ${run.pattern ?? ''}`.trim(),
      kind: 1,
      startTimeUnixNano: `${startMs}000000`,
      endTimeUnixNano: `${endMs}000000`,
      attributes: [
        { key: 'gen_ai.system', value: { stringValue: 'nmq-robot' } },
        { key: 'gen_ai.request.model', value: { stringValue: run.model ?? 'unknown' } },
        { key: 'nmq.tenant', value: { stringValue: run.tenantId } },
        { key: 'nmq.cost_usd', value: { doubleValue: run.costUsd ?? 0 } },
        { key: 'nmq.tokens_in', value: { intValue: run.usage?.tokensIn ?? 0 } },
        { key: 'nmq.tokens_out', value: { intValue: run.usage?.tokensOut ?? 0 } },
        { key: 'nmq.status', value: { stringValue: run.status ?? 'ok' } },
      ],
      status: { code: run.status === 'error' ? 2 : 1 },
    });

    return { resourceSpans: [{ resource, scopeSpans: [{ scope: { name: 'nmq-robot' }, spans }] }] };
  }

  return {
    enabled: Boolean(file || endpoint),
    get exported() {
      return exported;
    },
    /** Poziva se iz tracer.endRun — nikad ne baca grešku dalje. */
    async exportRun(run) {
      try {
        const payload = toOtlp(run);
        exported += 1;
        if (file && traceFile) await appendText(traceFile, `${JSON.stringify({ ts: iso(), ...payload })}\n`);
        if (endpoint) {
          const res = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/v1/traces`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(payload),
          });
          if (!res.ok) logger?.warn?.('otel.export_failed', { status: res.status, runId: run.runId });
        }
        return payload;
      } catch (err) {
        logger?.warn?.('otel.export_error', { error: err.message, runId: run?.runId });
        return null;
      }
    },
    traceFile,
  };
}
