# Deploy — NMQ Robot

Dvije opcije, iste komande za provjeru. Prvo pročitaj `docs/DECISIONS.md` §5 (zamke).

---

## A. Hetzner VPS (preporučeno — primarni)

Postojeći server: `nmq-server` (Finska/Helsinki), `ssh root@<VPS_IP>`, ključ `VPS_SSH_KEY`.

```bash
# 1) korisnik i folderi (jednom)
adduser --system --group --home /opt/nmq-robot nmq
mkdir -p /opt/nmq-robot /var/lib/nmq-robot
chown -R nmq:nmq /opt/nmq-robot /var/lib/nmq-robot

# 2) kod (sa lokalne mašine)
tar --exclude=./data --exclude=./.git -czf nmq-robot.tgz .
scp nmq-robot.tgz root@<VPS_IP>:/tmp/
ssh root@<VPS_IP> 'tar -xzf /tmp/nmq-robot.tgz -C /opt/nmq-robot && chown -R nmq:nmq /opt/nmq-robot'

# 3) .env (tajne se NE prenose tar-om)
ssh root@<VPS_IP> 'cp /opt/nmq-robot/.env.example /opt/nmq-robot/.env && chmod 600 /opt/nmq-robot/.env'
ssh root@<VPS_IP> 'nano /opt/nmq-robot/.env'   # NMQ_LLM_API_KEY, NMQ_MASTER_KEY, NMQ_HTTP_ALLOWLIST

# 4) systemd
ssh root@<VPS_IP> 'cp /opt/nmq-robot/infra/nmq-robot.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now nmq-robot'
systemctl status nmq-robot --no-pager
journalctl -u nmq-robot -f
```

Provjera poslije deploy-a (obavezno):

```bash
curl -s localhost:8787/healthz
curl -s localhost:8787/readyz
node /opt/nmq-robot/scripts/smoke.mjs   # NMQ_SMOKE_URL=http://127.0.0.1:8787
```

### Objava na internet (Cloudflare tunnel — već postoji `cloudflared` na VPS-u)

```yaml
# ~/.cloudflared/config.yml — dodaj novi hostname
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: robot.aicommandcenter.pro
    service: http://127.0.0.1:8787
  - service: http_status:404
```

```bash
cloudflared tunnel route dns <TUNNEL_ID> robot.aicommandcenter.pro
systemctl restart cloudflared
```

Zatim u `config/tenants.json` postavi `requireAuth: true`, generiši ključ i podijeli ga klijentu:

```bash
node src/cli.js keys nmq owner
```

### Docker (alternativa systemd-u)

```bash
cd /opt/nmq-robot
cp .env.example .env && nano .env
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml logs -f robot
```

---

## B. Hostinger (shared hosting — lagani tenant / demo)

Zamke koje su već naučene na ovom hostingu:
- **Nema `npm install`** u build koraku (LVE limiti) → NMQ Robot namjerno ima `dependencies: {}`, pa build ne postoji.
- Node **nije na PATH-u** u non-interactive shell-u: koristi `/opt/alt/alt-nodejs22/root/bin/node`.
- Passenger restart je `touch tmp/restart.txt`.
- Statika se **mora** slati sa `no-cache` (vidi `src/server/routes.js` → `serveFile`) i uz `?v=` pri deploy-u, inače CDN servira stare fajlove.

```bash
ssh -p 65002 u972051764@82.25.83.80
cd ~/domains/<domen>/nodejs
# Passenger aplikacija: app.js koji samo uvozi NMQ Robot gateway
```

`app.js` (Passenger ulaz):

```js
// Passenger očekuje export aplikacije, ne server.listen()
import { createRobot } from './src/index.js';
const robot = await createRobot({ root: import.meta.dirname });
export default robot.server;   // node:http server je direktno kompatibilan
```

```bash
touch tmp/restart.txt
curl -s https://<domen>/healthz
```

> Preporuka: Hostinger koristi samo za demo/landing + widget; produkcijski agenti idu na VPS.

---

## C. Lokalno (razvoj)

```bash
node --test                                   # svi testovi
node scripts/demo.mjs                         # demo svih patterna (mock LLM, bez troška)
NMQ_LLM_PROVIDER=mock node scripts/serve.mjs  # server bez API ključa
node scripts/smoke.mjs                        # 13 provjera protiv živog servera
```

---

## D. Rutina poslije svakog deploy-a

1. `curl /healthz` i `/readyz` (readyz mora imati `llmIsMock: false` u produkciji).
2. `node scripts/smoke.mjs` — 13/13.
3. `node src/cli.js audit-verify` — lanac audita ispravan za svaki tenant.
4. Provjeri `GET /v1/usage` — da nema skoka u potrošnji.
5. Ako je mijenjan widget — provjeri `?v=` i `cache-control: no-cache`.
6. Backup: postojeći restic (04:00) pokriva `data/`; prije većih izmjena pokreni ručno.
