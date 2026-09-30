/** SSE pomoćnici — jedan tok događaja po run-u. */
export function openSse(res, { headers = {} } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...headers,
  });
  res.write(`: nmq-robot stream ${new Date().toISOString()}\n\n`);

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15_000);

  return {
    send(event, data) {
      if (res.writableEnded) return false;
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      res.write(`event: ${event}\ndata: ${payload}\n\n`);
      return true;
    },
    comment(text) {
      if (!res.writableEnded) res.write(`: ${text}\n\n`);
    },
    close() {
      clearInterval(keepAlive);
      if (!res.writableEnded) res.end();
    },
    get closed() {
      return res.writableEnded;
    },
  };
}

/** Pretvara onEvent iz orchestratora u SSE događaje. */
export function sseSink(sse) {
  return (event) => {
    if (!event?.type) return;
    if (event.type === 'token') return sse.send('token', { text: event.text ?? event.delta ?? '' });
    if (event.type === 'usage') return sse.send('usage', event.usage ?? {});
    if (event.type === 'final') return sse.send('final', { text: event.text ?? '' });
    return sse.send('step', event);
  };
}
