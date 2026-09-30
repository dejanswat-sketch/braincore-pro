/**
 * Metrike u Prometheus tekst formatu — bez zavisnosti.
 * Podržava counter, gauge i histogram (sa fiksnim bucket-ima).
 */
export function createMetrics({ prefix = 'nmq' } = {}) {
  const counters = new Map();
  const gauges = new Map();
  const histograms = new Map();
  const startedAt = Date.now();

  const key = (name, labels = {}) => {
    const parts = Object.keys(labels)
      .filter((k) => labels[k] !== undefined && labels[k] !== null)
      .sort()
      .map((k) => `${k}="${String(labels[k]).replace(/(["\\])/g, '\\$1')}"`);
    return parts.length ? `${name}{${parts.join(',')}}` : name;
  };

  const baseName = (full) => full.split('{')[0];

  const api = {
    inc(name, labels = {}, value = 1) {
      const k = key(`${prefix}_${name}`, labels);
      counters.set(k, (counters.get(k) ?? 0) + value);
    },
    set(name, labels = {}, value = 0) {
      const k = key(`${prefix}_${name}`, labels);
      gauges.set(k, value);
    },
    observe(name, labels = {}, value = 0, buckets = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60]) {
      const k = key(`${prefix}_${name}`, labels);
      let h = histograms.get(k);
      if (!h) {
        h = { buckets: [...buckets], counts: new Array(buckets.length + 1).fill(0), sum: 0, count: 0, name: `${prefix}_${name}`, labels };
        histograms.set(k, h);
      }
      h.sum += value;
      h.count += 1;
      const idx = h.buckets.findIndex((b) => value <= b);
      h.counts[idx === -1 ? h.buckets.length : idx] += 1;
    },
    /** Tekst za GET /metrics */
    render() {
      const lines = [];
      const seenTypes = new Set();
      const header = (name, type, help) => {
        if (seenTypes.has(name)) return;
        seenTypes.add(name);
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      };
      for (const [k, v] of counters) {
        header(baseName(k), 'counter', `${baseName(k)} (counter)`);
        lines.push(`${k} ${v}`);
      }
      for (const [k, v] of gauges) {
        header(baseName(k), 'gauge', `${baseName(k)} (gauge)`);
        lines.push(`${k} ${v}`);
      }
      for (const h of histograms.values()) {
        header(h.name, 'histogram', `${h.name} (histogram)`);
        let cumulative = 0;
        h.buckets.forEach((b, i) => {
          cumulative += h.counts[i];
          const lbl = key(`${h.name}_bucket`, { ...h.labels, le: b });
          lines.push(`${lbl} ${cumulative}`);
        });
        cumulative += h.counts[h.buckets.length];
        lines.push(`${key(`${h.name}_bucket`, { ...h.labels, le: '+Inf' })} ${cumulative}`);
        lines.push(`${key(`${h.name}_sum`, h.labels)} ${h.sum}`);
        lines.push(`${key(`${h.name}_count`, h.labels)} ${h.count}`);
      }
      lines.push(`${prefix}_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`);
      lines.push(`${prefix}_process_rss_bytes ${process.memoryUsage().rss}`);
      return `${lines.join('\n')}\n`;
    },
    reset() {
      counters.clear();
      gauges.clear();
      histograms.clear();
    },
    snapshot() {
      return {
        counters: Object.fromEntries(counters),
        gauges: Object.fromEntries(gauges),
        histograms: Object.fromEntries([...histograms].map(([k, v]) => [k, { count: v.count, sum: v.sum }])),
      };
    },
  };

  return api;
}
