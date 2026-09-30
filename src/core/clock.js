export const now = () => Date.now();
export const iso = (t = Date.now()) => new Date(t).toISOString();
export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });

/** Mjeri trajanje u ms. */
export function timer() {
  const start = process.hrtime.bigint();
  return () => Number(process.hrtime.bigint() - start) / 1e6;
}

/** Vremenski budžet za jedan run. */
export function deadline(ms, signal) {
  const started = Date.now();
  return {
    started,
    ms,
    remaining: () => Math.max(0, ms - (Date.now() - started)),
    expired: () => Date.now() - started > ms || Boolean(signal?.aborted),
  };
}
