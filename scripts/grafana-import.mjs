// Grafana dashboard import — cita deploy/grafana-dashboard.json, wrap-uje i POST-uje na Grafana API.
// Bez npm zavisnosti (Node >= 20 global fetch). Lozinka dolazi iz env GRAFANA_PASS (nikad se ne ispisuje).
import fs from 'node:fs';

const pass = process.env.GRAFANA_PASS;
if (!pass) {
  console.error('Nedostaje GRAFANA_PASS env.');
  process.exit(1);
}
const url = process.env.GRAFANA_URL ?? 'https://metrics.braincore.pro';

const dash = JSON.parse(fs.readFileSync('deploy/grafana-dashboard.json', 'utf8'));
delete dash.__comment; // Grafana ne poznaje to polje; ukloni da ne smeta
const body = { dashboard: dash, overwrite: true, folderUid: '' };

const res = await fetch(`${url}/api/dashboards/db`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Basic ${Buffer.from(`admin:${pass}`).toString('base64')}`,
  },
  body: JSON.stringify(body),
});

console.log('HTTP', res.status);
const text = await res.text();
console.log(text.slice(0, 300));
