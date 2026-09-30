# 36 — Cross-node swarm: roj preko više procesa i mašina

> **Svrha:** ovaj dokument opisuje **stvarno stanje koda** za nivo v0.5 (cross-node swarm): kako je roj
> razvezan preko više procesa i mašina, šta je deljeno a šta lokalno, kako se garantuje (i gdje **ne**
> garantuje) da dva workera ne uzmu isti zadatak, kako radi gossip, HMAC i cross-node safety — i šta
> **nije** implementirano. Svaka tvrdnja nosi fajl i funkciju; sve što je planirano piše **planirano**.
>
> **Vezano za kod:** `src/cluster/redis.js` (225 linija), `src/cluster/store.js` (316),
> `src/cluster/gossip.js` (327), `src/cluster/node.js` (262), `src/server/routes-cluster.js` (110),
> `config/cluster.json` (21), `src/index.js` (linije 245–294, 411), `src/core/config.js` (21–23, 80),
> `src/swarm/{blackboard,swarm,governance,safety}.js`, `tests/cluster.test.mjs` (470).
>
> **Kako je provjereno (na dan pisanja, revizija fajlova od 11:31–11:38):**
>
> | Provjera | Rezultat |
> |---|---|
> | `node --test tests/cluster.test.mjs` | **11/14 prolazi, 3 padaju** (§4.6 i §7.4 navode koje i zašto) |
> | trka dva procesa na istom zadatku (file store, 30 ponavljanja) | **30/30 tačno jedan pobjednik** (`lock_se_drzi` kod gubitnika) |
> | ista trka na **starijoj** reviziji `store.js` (30 ponavljanja) | **dva pobjednika** — vidi §4.6 (nalaz koji je popravljen, sa dokazom) |
> | stale lock + `open` zadatak (probe) | zadatak se **ne može** claim-ovati dok se lock ručno ne obriše (§4.6, otvorena greška) |
> | `NMQ_CLUSTER_PORT=0` (probe `loadConfig`) | efektivni port je **8790** iz `config/cluster.json`, ne 0 (§9.4) |
> | ulaz u klaster bez `NMQ_CLUSTER_SECRET` | **fail-closed** — `createRobot` baca grešku (`tests/cluster.test.mjs`, zadnji test) |
>
> **Nikad se u ovaj dokument ne upisuju vrijednosti ključeva** — samo imena env varijabli.
> Verzija: 1.0 · Vlasnik: NMQ (Dejan Milošević PR).

---

## 1. Zašto single-node nije dovoljno

Roj u v0.4 je cio živio u **jednom procesu**: tabla (`src/swarm/blackboard.js`) su tri `Map` strukture
(`tasks`, `pheromones`, `artifacts`), kvote i rate limiti su `Map` u `src/swarm/governance.js`
(`rateWindows`), a detekcija gleda **in-memory** nizove `claims`/`votes` u `src/swarm/safety.js`.
To je svjesna odluka za v0.4, ali pravi tri posljedice koje se ne mogu zaobići kodom unutar jednog procesa.

**(a) Kapacitet — jedan proces je jedan event loop.** `swarm.tick()` je sekvencijalna petlja
(`src/swarm/swarm.js`, `tick()`): za svakog workera uzmi zadatak, pa `orchestrator.run(...)`. Svaki run
je asinhron (LLM + alati), ali svaki `claim`, svaki feromon i svaki `blackboard.complete()` se vraćaju u
**isti** event loop. Posljedica nije „malo sporije": kad tabla i roj žive u jednom procesu, **broj
workera ne povećava propusnost** preko onoga što jedan proces može da drži, a svaki `await` na LLM-u
drži memoriju (sesija, trace, kontekst) tog procesa. Horizontalno skaliranje stoga ne postoji: druga
instanca ne vidi prvi proces, ne vidi njegove zadatke i ne može mu pomoći.

**(b) Otpornost — restart briše tablu i kvote.** `tasks`, `pheromones`, `artifacts`, `rateWindows`,
`claims` i `votes` nisu perzistirani (jedini izuzetak u v0.4 je `governance` stanje —
`data/_control/swarm.json`, `src/swarm/governance.js`, `persist()`). Artefakti postoje **samo u
memoriji**: `blackboard.complete()` upisuje `artifacts.set(taskId, artifact)`, a na disk ide samo
`task_completed` red u `board-YYYY-MM-DD.jsonl`. Posljedica: pad procesa posred run-a ne ostavlja
„preuzeto pa napušteno" stanje na tabli — ne ostavlja **ni tablu**. Isto važi za rate limite: kvota
`maxClaimsPerWorkerPerMin` se poslije restarta resetuje, pa „rate limit" nije sigurnosna granica nego
stanje jednog procesa.

**(c) Nadzor — rate limit i karantin su in-memory.** `safety.quarantine()` upisuje u `quarantined` (`Map`)
i perzistira u `data/_control/swarm-safety.json` (`safety.js`, `persist()`), ali `governance.allowRate()`
radi nad `rateWindows` u memoriji. Ako se pokrenu dvije replike istog tenanta, svaka ima **svoje**
prozore: dva workera mogu zajedno potrošiti dvostruku kvotu, a da nijedna replika ne prekorači svoju.
Još važnije za nadzor: detektor `collusion_lockstep` (`safety.js`, `detect()` dio 1) gleda **sekvencu**
preuzimanja; ako preuzimanja idu u dva procesa, nijedna replika ne vidi cijelu sekvencu, pa je koluzija
između replika **nevidljiva** (to je i eksplicitno zapisano u `docs/33`, §9.1).

**Zato v0.5 uvodi dva sloja:** (1) **deljeni store** koji nosi tablu i feromone preko procesa/mašina, i
(2) **gossip mesh** koji nosi membership i poruke. Oba sloja su aditivna — lokalni `blackboard` ostaje
za single-node rad, a `cluster` se uključuje prekidačem (`NMQ_CLUSTER=1` ili `config/cluster.json →
enabled: true`, `src/index.js`, linija 246).

---

## 2. Arhitektura (dijagram)

```
                 ┌─────────────────────────── čvor A (proces 1 / mašina 1) ───────────────────────────┐
                 │  HTTP /v1/admin/cluster/*   (src/server/routes-cluster.js)                         │
                 │                                                                                   │
                 │  ┌── cluster node (src/cluster/node.js) ──────────┐    ┌── lokalni swarm ───────┐  │
                 │  │  claimTask()  postTask()  completeTask()       │    │ blackboard (Map)       │  │
                 │  │  runOnce()  publishSwarmMessage()              │◄──►│ swarm.tick()/workers   │  │
                 │  │  inbound() → safety.mediateMessage()           │    │ governance (kvote)     │  │
                 │  └───────┬──────────────────────────┬─────────────┘    │ safety (detekcija)     │  │
                 │          │                          │                  └────────────────────────┘  │
                 │   ┌──────▼───────┐          ┌───────▼────────┐                                   │
                 │   │ gossip node  │          │ shared store   │                                   │
                 │   │ (gossip.js)  │          │ (store.js)     │                                   │
                 │   └──────┬───────┘          └───────┬────────┘                                   │
                 └──────────┼──────────────────────────┼────────────────────────────────────────────┘
                            │ TCP, HMAC               │ file (deljeni dir) ili Redis (RESP)
        ┌───────────────────┴───────────┐              │
        │        GOSSIP MESH            │              │
        │  membership + broadcast       │              │
        │  join/welcome/heartbeat/      │              │
        │  membership/disseminate/      │              │
        │  swarm_message/task_announce/ │              │
        │  leave                        │              │
        └───────┬───────────────┬───────┘              │
                │               │                      │
   ┌────────────▼───┐   ┌───────▼────────┐    ┌────────▼─────────┐
   │   čvor B       │   │   čvor C       │    │   SHARED STORE   │
   │ (proces/mašina)│   │ (proces/mašina)│    │  tasks + pherom. │
   │ gossip+store   │   │ gossip+store   │◄──►│  + lease/lock    │
   └────────────────┘   └────────────────┘    └──────────────────┘
```

**Šta je DELJENO (preko mreže/fajla):**

| Podatak | Gdje živi | Ko piše | Ko čita |
|---|---|---|---|
| Zadatak (`ctask_…`) | `store.putTask` → `data/_cluster/board/tasks/<id>.json` (file) ili Redis hash `nmq:board:tasks` | bilo koji čvor | svi čvorovi (`store.openTasks`) |
| Zauzetost zadatka (lease) | polje `leaseUntil`/`claimedBy` u zapisu zadatka + lock (`locks/<id>.lock`) ili Redis ključ `nmq:board:claim:<id>` | čvor koji je claim-ovao | svi čvorovi |
| Feromoni | `store.putPheromone` → `pheromones.jsonl` ili Redis lista `nmq:board:pheromones` | svi čvorovi | svi (`activePheromones`) |
| Membership | gossip `members` (`Map` u `gossip.js`) | svaki čvor o sebi + tuđi `membership`/`welcome` | svi članovi |
| Swarm poruke preko mreže | `gossip.broadcast('swarm_message', …)` | pošiljalac | primaoci (kroz medijaciju) |
| Audit klastera | `data/tenants/_global/audit/audit.jsonl` (`CLUSTER_TENANT = '_global'`, `node.js`) | svaki čvor | pregled/verifikacija |

**Šta je LOKALNO (ne dijeli se):**

| Podatak | Zašto je lokalno | Posljedica |
|---|---|---|
| `blackboard` (`tasks`/`pheromones`/`artifacts` kao `Map`) | to je tabla jednog procesa; cross-node tabla je `store` | lokalni `swarm.tick()` i cross-node `cluster.runOnce()` su **dva različita toka** |
| Kvote i rate windowi (`governance.rateWindows`) | in-memory `Map` | kvota važi **po čvoru**, ne po klasteru → vidi §10 (planirano: distribuirani budžet) |
| Detekcija (`safety.claims`/`votes`) | in-memory nizovi | koluzija preko čvorova je **nevidljiva** → §7.3 |
| Registar workera (`swarm.workers`) | `Map` u procesu | worker postoji samo na čvoru koji ga je registrovao |
| Izolacija/freeze (`governance.state`) | `data/_control/swarm.json` **po procesu** | `freeze` na jednom čvoru ne zamrzava druge čvorove → §7.4 |
| Artefakti (`blackboard.artifacts`) | `Map` u procesu; cross-node ide `result` u zapis zadatka | cross-node artefakt je `{output ≤ 2000 znakova, runId}` u `store.completeTask` |

---

## 3. Shared store

Interfejs je jedan (`store.js`), a implementacije dvije. Bira ih `createSharedStore({ config, dataDir, … })`
(`store.js`, linija 297): `config.redisUrl` (dolazi iz `NMQ_REDIS_URL` ili `config/cluster.json →
store.redisUrl`, vidi `src/index.js`, linija 259) → Redis; inače `file`.

| Backend | Kada se koristi | Atomski claim | TTL / lease | Perzistencija |
|---|---|---|---|---|
| `file` (**default**) | kad nema `redisUrl`: više **procesa na istoj mašini** ili na deljenom FS-u (NFS/SMB — uz oprez, vidi §10) | `fs.mkdir(<id>.lock)` (atomično: drugi dobija `EEXIST`) + provera `leaseUntil` u zapisu + `fs.rmdir` u `finally` (`store.js`, `claimTask`, linije 74–123) | `leaseUntil = now + leaseMs` (default `DEFAULT_LEASE_MS = 60_000`) u zapisu zadatka; **lock se otima** samo ako je zadatak `claimed` i star lock > `min(leaseMs, 5000)` (`store.js`, linije 91–97) | JSON fajl po zadatku + append-only `board.jsonl` i `pheromones.jsonl` (`data/_cluster/board/`) |
| `redis` | kad je `redisUrl` postavljen i dostupan; za **više mašina** | Lua skript `CLAIM_LUA` preko `client.eval(...)` (`store.js`, linije 178–192, 231): `GET claim:<id>` → ako je tuđi `leaseUntil` u budućnosti `busy`, inače `SET … PX` → `claimed`. Fallback ako Lua padne: `SET NX PX` (`store.js`, linija 235) | `PX leaseMs` na ključu `claim:<id>` **i** `leaseUntil` u zapisu zadatka; `ZADD nmq:board:leases <ts> <id>` za pregled | hash `nmq:board:tasks` (bez TTL-a), zset `open`/`leases`, lista `pheromones` sa `EXPIRE 86400` (`store.js`, linija 270) |

**Važno o nazivu komandi (nalaz):** komentar u zaglavlju `store.js` (linija 8) kaže da Redis claim ide
preko **`HSETNX`**, ali `HSETNX` se u kodu **ne poziva nijednom** (`grep 'HSETNX' src/cluster/` → 1
pogodak, i to u komentaru). Stvarni atomski put je **Lua + `SET NX/PX`**. Dokumentacija mora pratiti kod,
ne komentar — zato je u tabeli gore upisano ono što se zaista izvršava.

**Zašto `file` postoji kao default.** `D2` (`docs/DECISIONS.md`) zabranjuje obavezne npm zavisnosti, a
Redis je dodatni servis za održavanje. Zato file store radi bez ijedne instalacije — dovoljno je da dva
procesa pokažu na isti `NMQ_DATA_DIR`. To pokriva dva realna scenarija: (1) više procesa na istoj mašini
(radnik + web), (2) deljeni volumen u kontejneru.

**Zašto Postgres NIJE implementiran.** `D8` predviđa PostgreSQL 16 + pgvector kao produkcijski backend, ali
u ovom sloju backend **ne postoji** ni kao kostur — u `createSharedStore` postoje tačno dvije grane
(`file`, `redis`) i nijedna treća. Razlog je koliko koda traži wire protocol, a ne koliko je Postgres
dobar: **Redis protokol je tekstualni RESP** i staje u 225 linija (`redis.js`), dok Postgres traži
binary wire protocol (startup poruka, `md5`/`scram-sha-256` autentikacija, `Parse`/`Bind`/`Execute`,
`DataRow`/`RowDescription`, tipovi i NULL bitmapa) plus pool, transakcije i reconnect — red veličine
više koda od cijelog klaster sloja, sa realnim rizikom tihih grešaka u parsiranju.

Šta bi Postgres backend tražio od koda (planirano, ne implementirano):

1. **Implementaciju wire protokola** (`src/cluster/pg.js`) — kao `redis.js`: `encodeStartup`, `parseMessage`
   za `T`/`D`/`C`/`E`/`Z`, i autentikaciju (`scram-sha-256` je obavezan za moderne servere).
2. **Atomski claim u jednoj izjavi** (bez advisory lock-a, da radi i preko connection pool-a):
   `UPDATE cluster_tasks SET state='claimed', claimed_by=$2, lease_until=now()+$3 WHERE id=$1 AND
   (state='open' OR lease_until < now()) RETURNING *` — `rowCount = 0` znači „izgubio si trku";
   to je **jednako jako** kao Redis Lua i jače od file lock-a.
3. **Tabelu** `cluster_tasks(id text primary key, tenant_id text, state text, claimed_by text,
   lease_until timestamptz, attempts int, payload jsonb, value numeric)` + `cluster_pheromones(...)` sa
   `created_at` i indeksom za prozor; `CHECK` na `state`.
4. **`NOTIFY`/`LISTEN` kao alternativa gossipu za male klastere** (ne bi zamijenilo membership, ali bi
   dalo trenutnu propagaciju bez poll-a) — to je opcija, ne obaveza.
5. **Migracije** (jedan `schema.sql` uz `IF NOT EXISTS`, bez frameworka) i **test protiv prave baze** u
   `node --test`, jer mock ne dokazuje atomski claim.

Do tada: `redis` je jedini backend koji stvarno dijeli tablu preko mašina.

---

## 4. Atomski claim (najvažniji dio)

Pitanje na koje ovaj sloj mora dati odgovor: **dva workera na dva čvora u istom trenutku uzimaju isti
zadatak — šta se dešava?** Postoje dva odgovora, po backendu.

### 4.1 File backend — šta zaista garantuje

`claimTask(id, workerId, { leaseMs })` (`store.js`, linije 74–123):

1. `fs.mkdir(locks/<id>.lock)` — na POSIX-u i Windows-u **atomično**: tačno jedan poziv uspije, ostali
   dobiju `EEXIST`.
2. **Pobjednik** ulazi u zaključanu sekciju i ponovo čita zapis; ako je zadatak `done` → `zavrsen`;
   ako je `claimed` sa `leaseUntil` u budućnosti → `zauzet` (i lock se oslobađa); inače upisuje
   `state: 'claimed'`, `claimedBy`, `attempts + 1`, `leaseUntil = now + leaseMs`
   (`store.js`, linije 100–119). `finally` uvijek radi `fs.rmdir(lock)`.
3. **Gubitnik** (`EEXIST`) čita zapis: `done` → `zavrsen`; `claimed` sa aktivnim lease-om → `zauzet`
   (`holder` je tačan `claimedBy`); ako je zadatak `claimed` **i** je lock stariji od
   `min(leaseMs, 5000)` → `fs.rmdir(lock)` i **jedan** ponovni pokušaj (rekurzivni `this.claimTask`);
   inače `lock_se_drzi`.

Zapis se piše **atomarno kroz temp fajl + `rename`** (`writeTask`, `store.js`, linije 50–56; temp ime nosi
`process.pid` i 4 slučajna bajta).

**Šta je garantovano:** dok `leaseUntil` traje, **najviše jedan** worker drži zadatak, a gubitnik dobija
jasan razlog (`zauzet` + `holder`, ili `lock_se_drzi`). Mjereno na trenutnoj reviziji: paralelan
`Promise.all([a.claimTask(...), b.claimTask(...)])` kroz **30 ponavljanja → 30/30 tačno jedan pobjednik**,
30/30 gubitnika sa `lock_se_drzi`.

### 4.2 Redis backend — šta zaista garantuje

`claimTask` (`store.js`, linije 223–245) prvo čita zapis (`hgetall`), pa radi **jednu** Lua operaciju nad
ključem `claim:<id>`: ako tuđi `leaseUntil` još traje → `busy`; inače `SET key payload PX leaseMs` →
`claimed`. Redis izvršava Lua **atomarno** (jedan thread, bez preklapanja), pa je to „jedan pobjednik"
bez ikakvog lock fajla. Poslije toga pobjednik upisuje stanje u hash zadatka (`hset`), skida `id` iz
`open` zset-a i dodaje ga u `leases`. Ako Lua nije dostupna (npr. `EVAL` zabranjen), pada na
`SET NX PX` — takođe atomski (`store.js`, linija 235).

### 4.3 Tabela scenarija

| Scenario | File backend | Redis backend |
|---|---|---|
| Dva claim-a **u istom trenutku** | `mkdir` serijalizuje: jedan `claimed`, drugi `zauzet`/`lock_se_drzi` (30/30 u mjerenju) | Lua serijalizuje: jedan `claimed`, drugi `busy` (test `EVAL` u `tests/cluster.test.mjs`) |
| **Istekao lease** (čvor pao poslije claim-a) | zadatak je `claimed` + `leaseUntil < now` → drugi otima lock (`rmdir` + ponovni pokušaj) i dobija ga sa `attempts + 1`; `openTasks` prije toga već nudi zapis kao `open` uz `expiredLease: true` | `GET claim:<id>` je istekao (PX) → `claimed`; zapis u hashu se prepisuje novim `claimedBy` |
| **Pad čvora koji je držao zadatak** | lease ističe poslije `leaseMs` (default 60 s) → zadatak se vraća; **`result` se ne upisuje** — posao je izgubljen i mora se ponoviti (at-least-once) | isto (PX na `claim:<id>`) |
| **Dupli `complete`** | drugi `completeTask` prepisuje `state`/`result` (nema `if state === 'done'` provjere u `completeTask`) — zadnji upis pobjeđuje | isto (`hset` bez uslovne provjere) |
| **`complete(success:false)`** | zadatak se vraća u `open`, artefakt nosi `error` | isto (+ `zadd open`) |
| **Stale lock uz `open` zadatak** | **ne može se claim-ovati** — vidi §4.6 | nema lock fajla; `SET NX` ne blokira vječno (PX ističe) |

### 4.4 At-least-once, ne exactly-once

Ključna rečenica je u zaglavlju `store.js`: garantovan je **at-most-one claim u datom trenutku**, a
**nije** garantovano exactly-once izvršenje. Ako čvor uzme zadatak i padne prije `completeTask`, lease
ističe i zadatak se izvršava **ponovo** (na istom ili drugom čvoru). Zato:

- svaki cross-node zadatak mora biti **idempotentan** ili nositi zaštitu (npr. `meta.attempts` /
  dedup ključ u `payload`);
- `attempts` se **inkrementira** pri svakom claim-u (`store.js`, oba backenda), pa je „koliko je puta
  ovaj zadatak uziman" vidljivo u zapisu i u `board.jsonl` (`task_claimed` redovi);
- `completeTask` **nije** uslovljen: nema provjere da je pozivaoc baš onaj koji drži lease. Napad ili
  bug koji pošalje tuđi `taskId` u `complete` prepisaće tuđi rezultat.

### 4.5 Dupli `complete` — šta se vidi u podacima

`completeTask` mijenja zapis i upisuje red u `board.jsonl`. Dvostruki `complete` daje **dva**
`task_completed` reda i **zadnji** `result` u zapisu. To je namjerno ostavljeno jednostavno (nema
transakcija), ali znači da je `board.jsonl` jedini trag o tome da je zadatak završen dvaput — i da se
ta činjenica mora čitati iz log-a, ne iz stanja.

### 4.6 Nalazi iz mjerenja (ono što dokument mora priznati)

**(a) Popravljena trka sa dva pobjednika (istorijski nalaz, sa dokazom).** Starija revizija `store.js`
imala je u `EEXIST` grani uslov koji je propuštao claim kad je zapis još `state: 'open'` (prvi proces
ga još nije upisao). Izmjereno na toj reviziji: **15/20 (75%) pokretanja sa DVA pobjednika**, a u
preostalih 5 jedan proces je padao sa `EPERM` na `rename` — dakle *nijedno* pokretanje nije dalo
„tačno jedan pobjednik + čist gubitnik". Trenutna revizija to rješava i mjeri **30/30 tačno jedan**.
Ako se ovaj kod ikad vraća na stariju logiku (npr. „optimizacija" koja izbaci proveru lease-a **unutar**
zaključane sekcije, `store.js` linija 111), trka se vraća — zato je ta provera dio ugovora, ne detalj.

**(b) Otvorena greška: stale lock trajno blokira zadatak koji je `open`.** Lock se otima **samo** ako je
zapis `state: 'claimed'` i lock stariji od `min(leaseMs, 5000)` (`store.js`, linije 91–97). Ako proces
padne između `completeTask(success:false)` (koji vraća zadatak u `open` ranije nego što `finally` obriše
lock) i brisanja lock-a, ostaje **`open` zadatak sa mrtvim lock-om**. Izmjereno probom: tri uzastopna
claim-a vraćaju `lock_se_drzi`, a `openTasks` i dalje nudi zadatak → on je **vječno nedostupan** dok se
`locks/<id>.lock` ne obriše ručno. Popravka (planirano): otimanje lock-a po **starosti lock-a** nezavisno
od `state` (npr. `lockAge > leaseMs` → `rmdir` + jedan pokušaj), uz test koji to dokazuje.

**(c) Nema heartbeat-a.** Zaglavlje `store.js` pominje „`leaseUntil` + heartbeat", ali u kodu **nema**
funkcije koja produžava lease: `claimTask` je jedina koja ga postavlja. Worker koji radi duže od
`leaseMs` (default 60 s) **gubi** zadatak usred posla, a drugi čvor ga legitimno preuzima. To je
prihvatljivo samo ako su poslovi kratki ili idempotentni; inače je potreban `renewLease(taskId, workerId)`
i poziv iz `runOnce` u toku izvršavanja (planirano).

---

## 5. Gossip protokol

Jedan čvor = jedan TCP server (`net.createServer`, `gossip.js`, `startServer()`) i jedan `setInterval`
heartbeat. Poruka na žici je **jedan JSON okvir + `\n`**, oblika
`{"body": {v,id,type,from,incarnation,ttl,hops,ts,payload}, "sig": "<hmac-sha256 hex>"}`
(`envelope()`, `gossip.js`, linije 59–65).

**Poruke (`ALLOWED_MESSAGE_TYPES`, `gossip.js`, linija 20):**

| Tip | Ko šalje | Šta nosi | Šta primalac radi |
|---|---|---|---|
| `join` | novi čvor, na `POST /v1/admin/cluster/join` ili `config.peers` | `{host, port}` | `upsertMember(from)` + **odmah odgovara `welcome`** (`gossip.js`, linije 149–156) |
| `welcome` | član koji je primio `join` | `{host, port, members[]}` | upisuje pošiljaoca i sve `members` iz snimka |
| `heartbeat` | svaki čvor, svakih `intervalMs` | `{host, port}` | `upsertMember(from)` → `lastSeen = now`, status `alive` |
| `membership` | član poslije uspješnog `join` | `{members[]}` | upisuje sve navedene članove (osim sebe) |
| `disseminate` | bilo ko (`POST /v1/admin/cluster/broadcast`) | proizvoljan `payload` | prosleđuje dalje (fanout) dok `ttl > 0` |
| `swarm_message` | `cluster.publishSwarmMessage` | `{tenantId, from, to, msgType, payload}` | **prolazi kroz `safety.mediateMessage`** (`node.js`, `inbound()`) |
| `task_announce` | `cluster.postTask` | `{taskId, tenantId, title, value}` | samo obavijest (tabla se čita iz store-a) |
| `leave` | `cluster.stop()` preko `gossip.leave()` | `{}` | status člana → `left` |

**Epidemijsko širenje i TTL.** `disseminate()` šalje okvir na `fanout` (default 3) **slučajno odabranih
živih** članova (`sort(() => Math.random() - 0.5).slice(0, fanout)`). Primalac prosleđuje dalje ako
`body.ttl > 0 && body.hops < 16`, sa `ttl - 1` i `hops + 1`, i to **ne** vraća pošiljaocu
(`gossip.js`, linije 176–183). Zato kruženje nije beskonačno: svaki hop smanjuje TTL, a hop-broj je
tvrdi prekidač na 16. Deduplikacija **nije** implementirana (vidi nalaz (b) ispod).

**`incarnation`.** Polje postoji u okviru i u zapisu člana (`members.get(x).incarnation`), ali je
vrijednost **konstantna**: `let incarnation = 1` (`gossip.js`, linija 51) i **nema** nijednog mjesta u
kodu koje je povećava (nema `refute`, nema `incarnation++`; provjereno grep-om). Zaglavlje fajla
(linija 5) tvrdi da incarnation „raste kad čvor uskrsne poslije lažne smrti" — **to trenutno nije
tačno**. Praktično danas: čvor koji je bio `dead`, a zatim pošalje `heartbeat`/`welcome`, vraća se u
`alive` preko `upsertMember()` (koji **uvijek** postavlja `status: 'alive'`), bez ikakvog poređenja
inkarnacija. Za „lažnu smrt" to znači: nema zaštite od toga da stari `dead` status „pojede" živ čvor —
ali nema ni prave SWIM refutacije (planirano, §11).

**Parametri (default u `DEFAULT_GOSSIP`, `gossip.js`, linije 22–30; `config/cluster.json` ih ponavlja):**

| Parametar | Default (`gossip.js` / `config/cluster.json`) | Posljedica promjene |
|---|---|---|
| `intervalMs` | 2000 / 2000 | manje → brža detekcija smrti, više TCP konekcija i CPU-a; više → sporiji `suspect`/`dead` |
| `suspectMs` | 6000 / 6000 | manje → češći lažni `suspect` na sporoj mreži; više → kasnije reagovanje na pravi pad |
| `deadMs` | 15 000 / 15 000 | manje → brže izbacivanje iz fanout-a, ali i izbacivanje čvora koji samo kasni (GC pauza, CPU spike) |
| `fanout` | 3 / 3 | manje → manje duplih poruka, sporije širenje (i veća šansa da poruka ne stigne); više → brže, ali O(n) saobraćaj |
| `ttl` | 4 / 4 | manje → poruka ne stigne dalje od susjeda; više → više duplih obrada (nema dedup-a, §5 nalaz (b)) |
| `maxMessageBytes` | 32 768 / 32 768 | manje → `envelope()` baca `ClusterError` („prevelika"); štiti od memory spike-a na serveru |
| `maxInboundPerMin` | 600 / 600 | manje → `handleFrame` vraća `rate_limit` i poruka se **odbacuje prije** verifikacije (klizni prozor 60 s, `allowInbound()`) |

**Nalazi u gossip sloju (da se ne tvrdi više nego što kod radi):**

**(a) Nema deduplikacije.** `seen` (`Map` id → ts) se **upisuje** na dva mjesta (`disseminate`, linija 118
i `handleFrame`, linija 146) i **nikad se ne čita** za odluku — `handleFrame` ne sadrži `seen.has(body.id)`.
Isti okvir koji stigne kroz dva puta (dijamant u mesh-u) biće obrađen **dvaput**. TTL i `hops < 16` samo
ograničavaju kruženje, ne dupliranje. Za `swarm_message` to znači: ista poruka može dva puta ući u
`mediateMessage` (dva zapisa u `messages.jsonl`, dvije potrošene kvote) — ne i dva izvršenja zadatka, jer
zadatke štiti store, ne gossip.

**(b) Potpis pokriva sadržaj, ne prenos.** `sign(secret, raw)` računa HMAC nad `JSON.stringify(body)` i
`verify()` ga provjerava nad **pristiglim** tijelom (`gossip.js`, `verify()`, linije 67–74). Pošto se u
prosleđivanju gradi **novi** okvir (`envelope(body.type, body.payload, {ttl-1, hops+1, messageId})`),
svaki hop **ponovo potpisuje** poruku. To znači: verifikacija dokazuje da je poruku poslao **neposredni
pošiljalac** (član sa tajnom), a **ne** da je sadržaj potekao od onog koga `payload.from` tvrdi. Za
`swarm_message` je zato `inbound()` i postavlja pošiljaoca na `node:<body.from>` (neposredni čvor), pa se
tvrdo „ko je autor" ne može dokazati (vidi §6 i §10).

**(c) Jedan okvir po konekciji.** Server čita prvi `\n` i obrađuje **jedan** okvir
(`processBuffer()` sa `processed` zastavicom i `socket.end()`). To je namjerno pojednostavljenje
(poruka = konekcija), ali znači i: ako klijent pošalje dva okvira u jednom potezu, drugi se **ignoriše**.

---

## 6. Bezbednost čvora

**HMAC potpis.** Svaki okvir je potpisan `HMAC-SHA256` sa tajnom iz env varijable **`NMQ_CLUSTER_SECRET`**
(`gossip.js`, `sign()` i `envelope()`). Poređenje potpisa je **vremenski konstantno**
(`safeEqual()` → `crypto.timingSafeEqual` nakon provjere dužine). Bez tajne gossip čvor se **ne može**
ni konstruisati: `createGossipNode` baca `ValidationError` („Gossip traži secret"), a `createRobot`
baca grešku na startu ako je klaster uključen bez tajne (`src/index.js`, linije 246–251; dokazano
testom „bez `NMQ_CLUSTER_SECRET` klaster je fail-closed").

**Nonce/timestamp protiv replay-a — djelimično.** Postoji **timestamp** provjera:
`Math.abs(Date.now() - body.ts) > 120_000` → `istekao_timestamp` (`gossip.js`, `verify()`). Postoji i
polje `id` (nonce), ali se **ne pamti** kao „viđen" za odbacivanje (`seen` se ne čita — §5 nalaz (a)).
Praktično: napadač koji je jednom snimio valjan okvir može ga **ponoviti u roku od 120 sekundi** i on
će proći verifikaciju (i biti obrađen kao nov). Replay kroz duži period je odbijen (timestamp), replay
unutar 2 minute — **nije**. Popravka je jeftina (provjera `seen.has(id)` uz TTL), ali je u ovom trenutku
nema.

**Odbijanje nepotpisanih/isteklih poruka.** `handleFrame` prvo primjenjuje rate limit
(`allowInbound`), pa `verify`, i svaki neuspjeh **odbija poruku prije obrade** i bilježi metriku
`cluster_gossip_rejected_total` + emituje `rejected` događaj sa razlogom
(`nema_potpisa` / `losi_potpis` / `nedozvoljen_tip` / `istekao_timestamp` / `nije_json` / `rate_limit`).

**Šta se dešava sa sumnjivim SADRŽAJEM (ne potpisom).** Sadržaj nije stvar gossip sloja: gossip propušta
samo tipove iz `ALLOWED_MESSAGE_TYPES` i **ne** tumači `payload` (jedini izuzetak je `swarm_message`, koji
`cluster.inbound()` šalje kroz `safety.mediateMessage`). Time je zadovoljeno pravilo `D52`
(„nijedan direktan kanal"): na žici ne postoji tip poruke koji bi zaobišao medijaciju i ušao u roj.

**Nalaz `unauthenticated_node` — nije implementiran.** Dokumentacija zahtijeva nalaz
`unauthenticated_node` + incident za nepotpisanu poruku. U kodu se nepotpisana poruka odbija na nivou
gossip-a (`nema_potpisa`) i to je **sve**: nema `safety` nalaza, nema incidenta, nema karantina čvora, a
`onMessage` se **ne** poziva (jer `handleFrame` izlazi prije). Metrika `cluster_gossip_rejected_total` je
jedini trag. Ovaj dokument to zato vodi kao **planirano** (faza (b) u §11), a ne kao postojeće stanje.

**Šta NIJE pokriveno (iskreno):**

| Rupa | Zašto je važna | Kako se rješava (planirano) |
|---|---|---|
| **Nema TLS-a u ovom sloju** | gossip ide preko golog TCP-a; HMAC štiti **integritet i autentičnost**, ali ne **povjerljivost**. Svako na putu vidi `payload` poruka i membership | mTLS (klijentski sertifikati po čvoru) ili WireGuard tunel između čvorova; u aplikaciji `tls.createServer`/`tls.connect` umjesto `net` |
| **Nema rotacije ključa** | `NMQ_CLUSTER_SECRET` je jedan ključ za cijeli klaster; kompromitovanje jednog čvora = mogućnost potpisivanja kao bilo koji čvor; promjena ključa traži restart svih | rotacija kroz board: novi ključ u `data/_control` + period prihvatanja **dva** ključa (verifikacija proba `current`, pa `previous`), pa ukidanje starog |
| **Nema reputacije čvora** | čvor koji je više puta odbijen (loš potpis, nepoznat tip) ne dobija nikakvu kaznu osim brojača | reputacija po `nodeId` (odbijeni/prihvaćeni okviri, starost, incidenti) → prag za automatski `quarantineMember` |
| **Nema autorizacije po čvoru** | tajna je *klasterska*, ne *per-node*: svaki član može poslati svaku dozvoljenu poruku (npr. `task_announce` u tuđe ime) | per-node ključ (kao per-agent API ključ u `D25`) + `scopes` po tipu poruke |
| **Rate limit je per-čvor i u memoriji** | napadač sa tajnom može poslati 600 okvira/min **po čvoru** i restartom se brojač resetuje | rate limit po `nodeId` (ne globalni), perzistiran ili u shared store-u |

---

## 7. Cross-node safety

Ulazna poruka sa mreže **ne ulazi direktno u roj**: `cluster.inbound()` (`node.js`, linije 50–72) je
jedina tačka ulaza i ona radi sljedeće:

1. Ako klaster nije spojen sa swarm slojem (`!deps`) — poruka se **odbacuje** (`nije_spojen`), bez obrade.
2. Sve osim `swarm_message` se ignorše za safety (membership tipovi); `swarm_message` traži
   `tenantId` i `msgType`, inače `nepotpuna_poruka`.
3. Poziva **istu** funkciju kao za lokalne workere:
   `deps.safety.mediateMessage({ tenantId, from: 'node:<id>', to, type: msgType, payload })`.

Time se na udaljene poruke primjenjuje **cijeli** lanac iz `src/swarm/safety.js`:

| Provjera (u `mediateMessage`) | Kako se vidi za poruku sa drugog čvora |
|---|---|
| Tip mora biti u `MESSAGE_TYPES` (`task_offer`, `task_request`, `help`, `status`, `proposal`, `vote`, `handoff_request`, `artifact_ready`) | `msgType` iz `payload` mora biti jedan od njih — inače `ValidationError` i nalaz `unknown_message_type` |
| Pošiljalac mora biti poznat (`isKnownWorker`) | `src/index.js` (linije 283–287) prosleđuje funkciju koja prihvata `node:<id>` **samo** ako je `cluster.isKnownNode(id)`, a `isKnownNode` traži člana u gossip `members` sa statusom različitim od `dead`/`left` |
| Kvota i izolacija | `governance.assertCanPeerMessage({tenantId, from, to})` — `canPeerMessage` po izolacionom nivou + `maxPeerMessagesPerMin` (60) **po paru** `from->to` |
| Sadržaj (entropija/oblik/fraza) | `inspectPayload(payload)`: `looksEncoded()` (entropija/razmaci/udio slova), `encoded_blob` (token > 64), kontrolni znaci, 12 fraza iz `SUSPICIOUS_PHRASES` |
| Ishod kad sadržaj padne | poruka se **ne dostavlja** (`PolicyError`), nalaz `covert_channel_suspected`, **incident** `covert_channel` (perzistiran) i **auto-karantin pošiljaoca** |

### 7.1 Karantin TOG čvora, na oba mjesta

Kad medijacija baci `PolicyError`, `inbound()` radi **dvije** stvari (`node.js`, linije 66–69):

1. `gossip.quarantineMember(body.from, 'safety:<code>')` — član u membership listi lokalnog čvora ide u
   `status: 'dead'` (i pamti `quarantinedAt`/`quarantineReason`), pa `isKnownNode()` za njega vraća
   `false` i njegove buduće poruke padaju na provjeri pošiljaoca;
2. `deps.safety.quarantine('node:<id>', 'cluster:<code>')` — karantin u swarm safety sloju (perzistiran
   u `data/_control/swarm-safety.json`, `safety.js`, `persist()`).

**Otvorena slabost u ovom mehanizmu (nalaz):** `quarantineMember` postavlja `status: 'dead'`, ali
`gossip.sweep()` na svakom otkucaju **preračunava** status iz `lastSeen` (`next = deadMs ? 'dead' :
suspectMs ? 'suspect' : 'alive'`) i pri tome **ne gleda** `quarantinedAt`. Čvor koji je karantinovan, a
i dalje šalje `heartbeat` (ili je u međuvremenu poslao `welcome`), biće vraćen u `alive` — tj. karantin
nije trajan nego se drži dok „osumnjičeni" ćuti. Isto važi za `POST /v1/admin/cluster/quarantine/:nodeId`
(ruta to izričito radi preko `gossip.quarantineMember` + `swarmSafety.quarantine`). Popravka (planirano):
`sweep()` mora preskočiti članove sa `quarantinedAt` (ili tražiti eksplicitni `release`).

### 7.2 Incident na oba čvora

Incident se otvara **na čvoru koji je primio poruku** (`openIncident` u `safety.js`), sa `evidence`
koja sadrži poruku. Audit zapis ide u `data/tenants/<tenantId>/audit/audit.jsonl` (hash-chained) tog
čvora. **Ne postoji** mehanizam da se incident **propagira** na druge čvorove: onaj ko je poruku poslao
neće dobiti nikakvu vijest da je njegov čvor karantinovan kod primaoca. To znači da je „incident na oba"
u praksi **incident na primaocu + karantin pošiljaoca u lokalnoj membership listi**; drugi čvorovi
saznaju samo ako sami dobiju sumnjivu poruku ili ako čovjek pogleda `GET /v1/admin/cluster/members`.
Propagacija incidenta/karantina kroz gossip (novi tip poruke npr. `safety_alert`) je **planirana** i
zahtijeva svijest da je to i sam kanal koji treba medijaciju.

### 7.3 Zašto je detekcija koluzije u distribuciji TEŽA

Detektori u `safety.detect()` gledaju **sekvencu i udjele** u jednom procesu: `claims` (niz sa `seq`) i
`votes` (niz). Kad se roj razveže na N čvorova:

- **Sekvenca je podijeljena.** Lockstep detektor poredi **susjedna** preuzimanja (`recent[i]` vs
  `recent[i+1]`) unutar jednog `claims` niza. Ako A radi na čvoru 1, a B na čvoru 2, nijedan proces ne
  vidi par (A,B) u istoj sekvenci → **nema nalaza**, iako je koordinacija stvarna. Ovo nije teorija: to
  je ista logika koja u `docs/33` §9.1 već stoji kao ograničenje single-node sloja.
- **Udio je iskrivljen.** `resource_concentration` dijeli po `total` **lokalnih** preuzimanja; sa dva
  čvora isti worker izgleda kao 100% na svom čvoru i 0% na drugom.
- **Glasovi su razdvojeni.** `collusion_votes` traži `pv.length >= 3` **u jednom** `votes` nizu;
  glasanje preko čvorova se nikad ne sabira (glas ide kroz `swarm.vote()` u jednom procesu; poruka tipa
  `vote` kroz mrežu **ne ulazi** u `votes` — vidi `docs/33` §4.2).
- **Delimičan uvid je asimetričan.** Onaj ko kontroliše dva čvora vidi cijelu sliku; onaj ko brani ima
  samo lokalne prozore. Zato u distribuciji **napadač ima prednost u informaciji**.

**Planirano (faza (a) u §11): globalni prozor događaja.** Umjesto oslanjanja na lokalne nizove, svaki
čvor bi slao **sažete** zapise o preuzimanjima/glasovima (`{tenantId, workerId, taskId, seq, ts, node}`)
u shared store (npr. lista/sortirani set sa TTL-om), a detekcija bi radila nad **spojenim** prozorom
(globalni `seq` po tenant-u). Time se lockstep i glasački blok mogu vidjeti preko čvorova. Cijena:
novi kanal za telemetriju (koji mora biti ograničen i validiran), veći obim podataka i novi rizik
(lažni zapisi → lažni nalazi), pa je uz to potreban i **potpis/verifikacija** tih zapisa.

### 7.4 Freeze i izolacija NISU klasterski

`governance.freeze()` perzistira stanje u `data/_control/swarm.json` **lokalnog procesa**
(`governance.js`, `persist()`; putanja ne sadrži `nodeId`). Ako čvorovi dijele `dataDir`, freeze se širi
„slučajno" preko fajla; ako ne dijele (tipično za više mašina), **freeze na čvoru A ne zaustavlja čvor B**.
Uz to, u `cluster.runOnce()` provjera `assertCanRun()` se izvršava **poslije** `claimTask()`
(`node.js`, linije 196 vs 204) i `PolicyError` se hvata u istom `catch`-u koji vraća zadatak u `open`
(linija 224) — dakle zamrznut roj **neće izvršiti** zadatak, ali će ga **uzeti i vratiti**, što je
suprotno duhu kill switch-a (dokaz: test „bez `NMQ_CLUSTER_SECRET`" pokriva start, ali **nema** testa
„freeze na čvoru A zaustavlja i čvor B"). Planirano: provjera izolacije **prije** claim-a + broadcast
`freeze`/`unfreeze` kroz gossip kao poseban dozvoljeni tip.

---

## 8. Konzistentnost i kompromisi

| Pitanje | Izbor u ovom kodu | Zašto (i šta košta) |
|---|---|---|
| **CAP za tablu** | **AP** (dostupnost > konzistentnost): `putTask` upisuje lokalno, `openTasks` čita ono što vidi, claim je idempotentan po zadatku | Zadatak koji se izvrši dvaput (rijetko) je bolji od table koja ne prima zadatke kad Redis padne; cijena: dupli rad i potreba za idempotentnim poslovima |
| **CAP za membership** | **AP**: `sweep()` mijenja statuse lokalno, bez konsenzusa | Membership je „mekana" informacija (ko je živ) — greška znači samo lošiji fanout; cijena: lažni `suspect`/`dead` na mrežnom zastoju i (za sada) mogućnost da karantinovani čvor „uskrsne" (§7.1) |
| **Konzistentnost zapisa zadatka** | **best effort**, posljednji upis pobjeđuje (`completeTask` bez uslovne provjere) | Nema transakcija ni verzionisanja; cijena: dupli `complete` prepisuje rezultat, a `attempts` je jedini trag o ponavljanju |
| **Operacije koje su idempotentne** | `putTask` (isti `id` → isti zapis), `completeTask` (ponovni poziv ne mijenja semantiku osim `result`), `claimTask` (drugi claim na aktivni lease **ne** prolazi) | To je ono na šta se smije osloniti u retry logici; **ne** smije se osloniti na „tačno jednom" |
| **Particija mreže (split-brain)** | dva čvora bez veze mogu uzeti **različite** zadatke (Redis tu pomaže; file store na deljenom FS-u takođe, jer lock je na FS-u) | Prihvatljivo: dupli rad nad **različitim** zadacima nije šteta, samo trošak |
| **Split-brain — šta NIJE prihvatljivo** | dva čvora uzmu **isti** zadatak | To je jedina prava opasnost; file lock i Redis Lua je sprečavaju **dok su oba čvora spojena na isti store**. Ako čvorovi koriste **različite** store-ove (različiti `dataDir` bez Redisa i bez deljenog FS-a), sloj **ne može** ništa garantovati — to nije klaster, to su dvije nezavisne instance |
| **Particija + bez shared store-a** | `file` na lokalnom disku svakog čvora = **nema** zajedničke table | Zato je za više mašina obavezan Redis (ili deljeni FS); `GET /v1/admin/cluster` to i kaže kroz polje `warning` (`routes-cluster.js`, linija 23) |
| **Vrijeme** | `Date.now()` na svakom čvoru za `leaseUntil` (zapis zadatka), `claimedAt` (Redis payload), `ts` (gossip okvir) i `lastSeen` (membership) | Drift (NTP korekcija, različite zone/mašine) direktno pomjera „koliko lease traje": čvor sa satom unaprijed **otima** tuđe lease-ove prije vremena, a sa satom unazad **drži** zadatak duže |
| **Monotoni sat** | **Nije implementiran.** Postoji `src/core/clock.js` (`iso()`, `now()`), ali lease/rokovi se računaju iz `Date.now()`, a `iso()` samo formatira | Posljedica: mjerenja trajanja i rokovi nisu imuni na skok sata. Planirano: `process.hrtime.bigint()` (monotoni) za **lokalne** rokove i mjerenja, a `Date.now()` samo za `ts` u zapisima (koji se porede među čvorovima) — uz toleranciju drifta (npr. `maxClockSkewMs`) |

**Preporuka za operaciju (iz koda, ne želja):** svi čvorovi moraju imati NTP; tolerancija drifta bi u
budućnosti trebala biti **eksplicitna** vrijednost (ne pretpostavka), jer `verify()` već koristi prozor od
120 s za `ts`, a lease koristi `leaseMs` bez ikakve tolerancije.

---

## 9. Operacije

### 9.1 Pokretanje 3-čvornog klastera lokalno

Klaster je uključen ili env varijablom ili config fajlom (`src/index.js`, linija 246):
`NMQ_CLUSTER=1` **ili** `config/cluster.json → enabled: true`. Tajna **mora** postojati, inače start pada
(fail-closed): `NMQ_CLUSTER_SECRET` (§6). Port dolazi iz `NMQ_CLUSTER_PORT` ili `config/cluster.json →
port` (default u fajlu je 8790) — **ali vidi §9.4** (vrijednost `0` ne radi).

```bash
# čvor 1 — čuvar klastera (prvi); tajna se NIKAD ne piše u fajl ni u dokument
NMQ_CLUSTER=1 NMQ_CLUSTER_SECRET="<tajna>" NMQ_DATA_DIR=./data \
NMQ_CLUSTER_PORT=8790 node src/cli.js serve

# čvor 2 — isti DATA_DIR (file store!) i drugi port
NMQ_CLUSTER=1 NMQ_CLUSTER_SECRET="<tajna>" NMQ_DATA_DIR=./data \
NMQ_CLUSTER_PORT=8791 node src/cli.js serve

# čvor 3
NMQ_CLUSTER=1 NMQ_CLUSTER_SECRET="<tajna>" NMQ_DATA_DIR=./data \
NMQ_CLUSTER_PORT=8792 node src/cli.js serve
```

Sva tri procesa na istoj mašini **moraju** dijeliti `NMQ_DATA_DIR` da bi `file` store bio zajednička
tabla; za tri **mašine** obavezno postaviti `NMQ_REDIS_URL` (inače svaka mašina ima svoju tablu):

```bash
NMQ_REDIS_URL=redis://<host>:6379 NMQ_CLUSTER=1 NMQ_CLUSTER_SECRET="<tajna>" node src/cli.js serve
```

**Env varijable (imena, bez vrijednosti):**

| Varijabla | Gdje se čita | Efekat |
|---|---|---|
| `NMQ_CLUSTER` | `src/core/config.js`, linija 21 (`'1'`/`'true'`) | uključuje klaster (`config.env.cluster`) |
| `NMQ_CLUSTER_PORT` | `src/core/config.js`, linija 22; `src/index.js`, linija 267 | TCP port gossip-a (vidi §9.4 za `0`) |
| `NMQ_CLUSTER_SECRET` | `src/index.js`, linija 247 | HMAC tajna klastera; **bez nje nema klastera** |
| `NMQ_REDIS_URL` | `src/core/config.js`, linija 23 → `src/index.js`, linija 259 | bira `redis` backend mjesto `file` |
| `NMQ_DATA_DIR` | `src/core/config.js`, linija 11 | korijen za `_cluster/board` i `_control` |

> Napomena (nalaz): `.env.example` **ne sadrži** nijednu od `NMQ_CLUSTER*`/`NMQ_REDIS_URL` — u primjeru
> env fajla ih nema (provjereno), pa se otkrivaju samo iz koda i ovog dokumenta.

### 9.2 Pridruživanje čvora

Čvor se pridružuje **eksplicitno**, sa `owner` ključem (`routes-cluster.js`, `POST /v1/admin/cluster/join`):

```bash
curl -sS -X POST "$NMQ_BASE/v1/admin/cluster/join" \
  -H "Authorization: Bearer $NMQ_KEY" -H "content-type: application/json" -H "x-tenant: nmq" \
  -d '{"peers":["127.0.0.1:8791"]}'
# odgovor: { nodeId, results: [{peer, ok}], members: [...] }
```

Alternativa bez HTTP-a: `peers: ["host:port", ...]` u `config/cluster.json` — `cluster.start()` ih
odmah poziva (`node.js`, linija 98). Poslije `join`, čvor šalje i `membership` snimak, a primalac
odgovara `welcome` sa svojom listom (§5), pa se obje strane upoznaju **bez** čekanja na heartbeat.
Ako `join` ne uspije (`ok: false`), rezultat nosi `reason` (`timeout`, `ECONNREFUSED`, …) — nema
automatskog ponavljanja (nema retry petlje).

### 9.3 Izbacivanje i karantin

| Radnja | Ruta | Rola | Šta se dešava |
|---|---|---|---|
| mirno napuštanje | `POST /v1/admin/cluster/leave` (`owner`) | `owner` | `gossip.leave()` → broadcast `leave` (TTL 2) → članovi ga označe `left` |
| prinudni karantin čvora | `POST /v1/admin/cluster/quarantine/:nodeId` | `owner` | `gossip.quarantineMember(id, reason)` (status `dead`) + `swarmSafety.quarantine('node:<id>', …)` + audit `cluster_quarantine_node` |
| automatski karantin (sadržaj) | nema rute — dešava se u `inbound()` | — | `PolicyError` iz medijacije → karantin čvora **i** `node:<id>` u safety (§7.1) |

Nepoznat `nodeId` vraća `{ok: false, reason: 'nepoznat_clan'}` (dokazano u `tests/cluster.test.mjs`).
Karantin **nije** trajan dok je čvor živ (§7.1).

### 9.4 Rute (tabela sa rolama)

Role su iz `src/tenancy/store.js` (`ROLES`): `owner` = `['*']`, `admin` = `run, read, write, approve,
manage-kb`, `operator` = `run, read, approve`, `agent` = `run, read`, `viewer` = `read`.
U tabeli je navedena **minimalna** rola iz `requiredRole` (`routes-cluster.js`).

| Metoda i put | `requiredRole` | Handler (funkcija u kodu) | Šta vraća / radi |
|---|---|---|---|
| `GET /v1/admin/cluster` | `read` | `cluster.stats({tenantId})` | `nodeId, port, started, attached, store.kind, board, members/alive/suspect/dead, peers, incarnation` + `warning` o file store-u |
| `GET /v1/admin/cluster/members` | `read` | `cluster.membership()` | `nodeId, members[]` (svaki: `nodeId, host, port, incarnation, status, lastSeen, self`) |
| `POST /v1/admin/cluster/join` | `owner` | `cluster.join(peers)` | pokreće `gossip.join` i dodaje peer-ove; audit `cluster_join` |
| `POST /v1/admin/cluster/leave` | `owner` | `gossip.leave()` | broadcast `leave`; **ne** zaustavlja HTTP server |
| `POST /v1/admin/cluster/broadcast` | `admin` | `gossip.broadcast(type, payload, {ttl})` | zahtijeva `type` (mora biti u `ALLOWED_MESSAGE_TYPES`, inače `ValidationError`) |
| `POST /v1/admin/cluster/quarantine/:nodeId` | `owner` | `gossip.quarantineMember` + `swarmSafety.quarantine` | status `dead` + karantin `node:<id>`; audit `cluster_quarantine_node` |
| `POST /v1/admin/cluster/tasks` | `run` | `cluster.postTask(...)` po zadatku | upis na zajedničku tablu + `task_announce`; vraća `{tenantId, created, board}` |
| `GET /v1/admin/cluster/board` | `read` | `store.openTasks` + `store.activePheromones` | otvoreni zadaci (uključujući istekle lease-ove kao `expiredLease: true`) i feromoni |
| `POST /v1/admin/cluster/run` | `admin` | `cluster.runOnce({maxRuns, leaseMs})` | cross-node otkucaj: claim sa zajedničke table → `assertCanRun` → `orchestrator.run` → `completeTask` |
| `POST /v1/admin/cluster/message` | `run` | `cluster.publishSwarmMessage({...})` | lokalna medijacija **prije** slanja + broadcast `swarm_message`; vraća `{messageId, targets, delivered, checked}` |

Uz to, swarm rute iz v0.4 ostaju na snazi (`src/server/routes-swarm.js`): `POST /v1/admin/swarm/message`
je **lokalna** medijacija (jedini poziv `mediateMessage` van klastera), `POST /v1/admin/swarm/workers`
registruje workere koje `cluster.runOnce` koristi, a `freeze`/`isolation`/`quotas` su `owner`.

### 9.5 Šta gledati u metrikama i logovima

| Metrika | Značenje | Kada je alarm |
|---|---|---|
| `cluster_task_claims_total` (`backend: file|redis`) | uspješni claim-ovi | nagli skok bez `completed` → zadaci se otimaju (lease prekratak? §4.6c) |
| `cluster_tasks_completed_total` (`success`) | završeni zadaci | pad `success` uz stabilan `claims` → posao puca (`board.jsonl`) |
| `cluster_tasks_posted_total` | novi zadaci na tabli | — |
| `cluster_task_runs_total` (`result`) | cross-node runovi (`runOnce`) | `result != 'ok'` u nizu |
| `cluster_redis_fallback_total` | Redis je pao i store se vratio na `file` | **kritično** ako čvorovi ne dijele `dataDir` — tabla se tiho razdvojila |
| `cluster_gossip_rejected_total` (`reason`) | odbijeni okviri (`losi_potpis`, `nema_potpisa`, `istekao_timestamp`, `rate_limit`, `nedozvoljen_tip`) | `losi_potpis`/`nema_potpisa` > 0 → neko bez tajne pokušava u mesh |
| `cluster_gossip_rate_limited_total` | prekoračen `maxInboundPerMin` | može biti i legitimna oluja heartbeat-a |
| `cluster_membership_changes_total` (`status`) | prelasci `alive/suspect/dead/left` | mnogo `suspect↔alive` → mreža/GC, ne pravi padovi |
| `cluster_joins_total` (`ok`/`partial`) | pridruživanja | `partial` → neki peer nedostupan |
| `cluster_inbound_swarm_messages_total` (`delivered`/`rejected`) | poruke sa mreže kroz medijaciju | svaki `rejected` je nalaz u `swarm/safety.jsonl` |
| `cluster_membership_events_total` (`change`) | `joined/updated/left/alive/suspect/dead` | — |

**Logovi i fajlovi kao dokaz:** `data/tenants/_global/audit/audit.jsonl` (`cluster_start`, `cluster_join`,
`cluster_quarantine_node`), `data/tenants/<tenant>/audit/audit.jsonl` (incidenti iz medijacije),
`data/_cluster/board/board.jsonl` (`task_put`, `task_claimed`, `task_completed`),
`data/_cluster/board/pheromones.jsonl`, `data/_control/swarm-safety.json` (incidenti/karantin),
`data/_control/swarm.json` (izolacija/freeze), log linije `cluster.*` (`store_file_ready`,
`store_redis_ready`, `gossip_started`, `member_status`, `inbound_rejected`, `redis_unavailable_fallback_file`).

**Dijagnostika koja ne postoji (nalaz):** nema `/metrics` metrike za **broj dva-puta-claim-ovanih**
zadataka (nema brojača `attempts > 1` kao metrike), nema alerta (u `infra/observability/alerts.yml` nema
nijednog `cluster_gossip_rejected_total` pravila — provjereno u `docs/33` §9.8 za swarm, isto važi za
klaster), i nema rute za listu zaključanih zadataka (`locks/`) — stale lock se otkriva tek čitanjem
`GET /v1/admin/cluster/board` i poređenjem sa `locks/` na disku.

---

## 10. Ograničenja (iskreno)

1. **Nema Raft/BFT konsenzusa.** Nema izbora lidera, nema kvarnog dogovora, nema log replikacije.
   „Konzistentnost" se svodi na atomski claim u store-u i idempotentne operacije (§4, §8).
2. **Nema transakcija preko više zadataka.** `completeTask` mijenja **jedan** zapis; nema „sve ili
   ništa" nad više zadataka, nema kompenzacionih transakcija (saga).
3. **Nema perzistencije gossip membership-a.** `members` je `Map` u procesu; restart čvora = gubi svoju
   listu (ostaje samo `self`) i mora ponovo `join` (ili `config.peers`). `data/_cluster` **ne sadrži**
   fajl membership-a.
4. **Nema cross-node autentikacije identiteta AGENATA — samo čvorova.** Medijacija provjerava pošiljaoca
   kao `node:<id>` (poznat član), ali **ne** dokazuje koji je *agent/worker* na tom čvoru poslao poruku;
   `workerId` je runtime `uid('wrk')` (`docs/33` §9.2). Tvrdo „dokazano je ko je poslao" bilo bi netačno.
5. **Nema mrežne izolacije na nivou OS-a.** Gossip port je otvoren TCP; zaštita je HMAC + rate limit, ne
   firewall/namespace. `src/core/sandbox.js` je aplikativni sloj (`D27`) i **ne** pokriva gossip socket.
6. **Redis klijent pokriva samo podskup komandi.** `redis.js` implementira: `PING, GET, SET (NX/PX), DEL,
   HSET, HGETALL, HDEL, EXPIRE, INCR, ZADD, ZRANGEBYSCORE, ZREM, ZCARD, LPUSH, BRPOPLPUSH, EVAL, INFO`,
   plus generički `cmd(...)`. **Nema**: `SCAN`, `MULTI/EXEC`, `SUBSCRIBE/PUBLISH`, `AUTH`/`SELECT`,
   `TLS` (`rediss://`), `CLUSTER`, pipelining. Posljedica: `AUTH` se ne može poslati (Redis sa lozinkom
   **neće** raditi bez izmjene koda), a `HSETNX` nije u API-ju iako ga zaglavlje `store.js` pominje.
7. **Nema heartbeat produžavanja lease-a** (§4.6c) i **nema popravke stale lock-a nad `open` zadatkom**
   (§4.6b) — dvije konkretne greške koje mogu izgubiti ili trajno blokirati zadatak.
8. **Nema deduplikacije ni replay zaštite u gossip-u** (§5 nalaz (a), §6) — `seen` se puni i ne čita.
9. **`incarnation` je mrtvo polje** (uvijek 1, bez refutacije) — „lažna smrt" i povratak čvora se
   rješavaju samo preko `upsertMember()` koji uvijek postavlja `alive` (§5).
10. **Karantin čvora nije trajan** i **freeze izolacija nije klasterska** (§7.1, §7.4).
11. **File store nije dokazano siguran na NFS/SMB.** `mkdir` je atomski na POSIX-u, ali mrežni FS-ovi
    imaju različite garancije (keširanje atributa, `rmdir` na drugom klijentu); zaglavlje `store.js`
    zato i kaže „uz oprez". Za više mašina: Redis.
12. **`NMQ_CLUSTER_PORT=0` ne radi.** `src/index.js` (linija 267) koristi `config.env.clusterPort ||
    config.cluster?.port || 0`, a `0` je falsy → uzima se port iz `config/cluster.json` (8790).
    Posljedica u praksi: dva test procesa ne mogu paralelno (jedan dobije `EADDRINUSE`), a na mašini gdje
    je 8790 zauzet klaster se ne diže. Popravka je jednolinijska (`??` mjesto `||`).

---

## 11. Roadmap

| Faza | Šta se dodaje | Dokaz (šta mora postojati da se tvrdi da je urađeno) |
|---|---|---|
| **(a) Globalni prozor događaja za koluziju** | Sažeti zapisi o preuzimanjima/glasovima u shared store (`{tenantId, workerId, taskId, seq, ts, node}`), TTL prozor; `safety.detect()` čita **spojeni** prozor mjesto samo lokalnih nizova; verifikacija zapisa (potpis čvora) da lažni zapisi ne prave lažne nalaze | Test: dva čvora naizmjenično claim-uju kroz zajedničku tablu → **jedan** `collusion_lockstep` nalaz (a ne nula kao danas); test da lažni zapis bez potpisa **ne** ulazi u prozor |
| **(b) mTLS / WireGuard** | TLS server+klijent u `gossip.js` (`tls.createServer`/`tls.connect`) sa klijentskim sertifikatom po čvoru **ili** dokumentovan WireGuard tunel; per-node ključ mjesto klasterske tajne; rotacija kroz board (dva aktivna ključa) | Test: čvor bez valjanog klijentskog sertifikata **ne** može otvoriti konekciju (ne samo da padne HMAC); test rotacije: stari ključ prihvaćen u prelaznom periodu, pa odbijen |
| **(c) Postgres backend** | `src/cluster/pg.js` (wire protocol + scram), tabela `cluster_tasks`/`cluster_pheromones`, claim kao jedan `UPDATE … WHERE state='open' OR lease_until < now() RETURNING *`; `createSharedStore` treća grana; `schema.sql` | Test protiv **prave** Postgres instance: paralelan claim → `rowCount` 0/1; istekao lease → preuzimanje; restart klijenta → isti red se vidi; migracija na praznu bazu bez ručnih koraka |
| **(d) Distribuirani budžet (kvote preko čvorova)** | Kvota i rate limit u shared store-u (Redis `INCR` + `EXPIRE` ili atomski Lua), brojanje **po tenantu i po klasteru**, a ne po procesu; `governance.assertCanRun` čita stanje iz store-a | Test: dva čvora potroše tačno `maxCostPerHourUsd` (ne dvostruko); test da pad čvora ne vraća budžet unazad (ili se vraća uz eksplicitni prozor) |
| **(e) Canary / rolling restart čvora** | Procedura: novi čvor sa novim kodom se pridruži, uzme dio posla; stari se `leave`-uje, njegovi `claimed` zadaci se **čekaju** ili eksplicitno vraćaju na tablu (`renewLease`/`releaseLease`); `GET /v1/admin/cluster` prikazuje verziju koda po članu | Test: rolling restart sa 3 čvora **bez** izgubljenog zadatka (nijedan `task_claimed` bez `task_completed` poslije restarta) i **bez** dva izvršenja istog zadatka |
| **(f) Chaos testovi particije** | Testovi koji u toku rada sijeku vezu (zatvaranje socket-a, `iptables`/`netsh` blokada u CI-ju, ili test-dvostruki store), pa mjere: koliko zadataka je duplo izvršeno, koliko ih je „izgubljeno" (claimed bez complete), koliko traje `suspect→dead→rejoin` | Izvještaj iz testa: `duploIzvršeno`, `izgubljeno`, `vrijemeOporavka` + pragovi (npr. 0 izgubljenih, ≤ 1 dupli na 100 zadataka) |

---

## Otvorena pitanja

1. **Koliki `leaseMs` je ispravan za naše poslove?** Default je 60 s (`DEFAULT_LEASE_MS`), a tipičan run
   (LLM + alati) može trajati duže. Ako je lease prekratak bez heartbeat-a (§4.6c), isti zadatak se radi
   dvaput; ako je predugačak, pad čvora drži zadatak neaktivnim. Treba li `leaseMs` po tipu zadatka
   (u `meta`) i da li uvodimo `renewLease` prije svega drugog?
2. **Da li `file` store smije biti „produkcijski" na deljenom FS-u (NFS/SMB)?** Kod tvrdi da radi, ali
   garancije `mkdir`/`rmdir` preko mrežnog FS-a nisu provjerene. Je li politika „file samo jedan čvor,
   Redis za sve ostalo" — i da li to onda znači da je `file` **samo za razvoj**?
3. **Šta je tačno „globalni prozor" za detekciju koluzije (faza a):** koliko dugo čuvamo događaje
   (10 min kao `windowMs`?), koliko to podataka nosi za 12 workera i 200 zadataka, i **ko** verifikuje
   zapise — svaki čvor potpisuje svoje, ali šta sprečava čvor da **ne pošalje** svoje događaje
   (selektivno ćutanje) i time sakrije koluziju?
4. **Kako se karantin čvora zaista sprovodi?** Danas je to lokalna oznaka u `members` (`status: 'dead'`)
   koja se može vratiti heartbeat-om (§7.1). Treba li karantin biti **globalna odluka** (board, propagirana
   kroz gossip kao potpisana poruka) i šta ako je čvor sa kojim se ne slažemo upravo onaj koji širi tu
   odluku?
5. **Da li je mTLS dovoljan bez per-node identiteta AGENATA (ograničenje 4)?** Ako čvor ima valjan
   sertifikat, ali na njemu radi 8 workera, medijacija i dalje vidi samo `node:<id>`. Treba li poruka
   nositi i **per-agent potpis** (ključ iz `D25`) da bi se tvrdilo „ovaj agent je poslao"?
6. **Kada se prelazi na Postgres (faza c) mjesto Redisa?** Redis pokriva claim i liste, ali ne daje
   upite nad istorijom zadataka ni transakcije; Postgres traži wire protocol (mnogo koda). Koji je
   **konkretan okidač** (broj čvorova? potreba za izvještajima? zahtjev klijenta?) i da li uvodimo
   Postgres samo za **istoriju/analitiku**, a Redis ostavljamo za claim?
