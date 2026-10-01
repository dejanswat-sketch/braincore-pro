// Popravlja deploy/grafana-dashboard.json: dodaje `DS` templating varijablu i eksplicitni
// datasource na svaki target (bez ovoga paneli sa "${DS}" ostaju prazni u Grafani).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = path.join(ROOT, 'deploy/grafana-dashboard.json');
const d = JSON.parse(fs.readFileSync(p, 'utf8'));

d.templating = d.templating ?? { list: [] };
d.templating.list = d.templating.list ?? [];
if (!d.templating.list.some((v) => v.name === 'DS')) {
  d.templating.list.unshift({
    name: 'DS',
    label: 'Data source',
    type: 'datasource',
    query: 'prometheus',
    current: {},
    hide: 0,
    refresh: 1,
    includeAll: false,
  });
}

let targets = 0;
const dsRef = { type: 'prometheus', uid: '${DS}' };
for (const panel of d.panels ?? []) {
  for (const t of panel.targets ?? []) { t.datasource = { ...dsRef }; targets += 1; }
}
delete d.__comment; // Grafana ne poznaje to polje

fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
console.log(`OK: templating DS dodat · targeta sa datasource: ${targets} · panela: ${(d.panels ?? []).length}`);
