# 38 — Build po smernicama: od postera do koda (v0.6.0)

> Ovaj dokument je **izvještaj o izgradnji**, ne plan i ne obećanje. Svaka tvrdnja nosi `fajl:linija`
> ili ime testa koji se može pokrenuti. Gdje nešto nije napisano u kodu, piše **„planirano"**.
> Ni jedna vrijednost ključa/tajne se ne navodi — samo imena env varijabli.

**Stanje na dan pisanja (dokazi iz ove sesije):**

| Provjera | Rezultat |
|---|---|
| `node --test` (cijeli repo) | **221/221 pass**, `fail 0`, trajanje ~7.9s |
| `node --test tests/3-nodes.test.mjs` (checklist) | **16/16 pass**, trajanje ~3.0s |
| `node_modules` | **ne postoji** (`Test-Path node_modules` → `False`) |
| `package.json.dependencies` | `{}` (prazan objekat) |
| `package.json.version` | `0.6.0` — **izmijenjeno u radnoj kopiji, još NIJE commitovano** (HEAD je `10a0747 NMQ Robot v0.5.0`) |
| Bare importi u `src/**/*.js` (bez `node:` i bez relativnih) | **nijedan** |

---

## 1. Pravilo: poster je za prodaju, kod je istina

Ovaj repo ima dva izvora istine i oni se **ne smiju miješati**:

1. **Poster** (`docs/35-SWARM-ARHITEKTURA-VIZUAL.html`, PNG `docs/35-swarm-arhitektura.png`,
   `docs/37-GENESIS-BRAIN.html`) — vizualni identitet i prodajna slika. Poster **sam sebe**
   ispravlja u sekciji „Poster obećava — kod pokazuje" (`docs/35-SWARM-ARHITEKTURA-VIZUAL.html:334–380`),
   gdje eksplicitno piše da je „Genesis Brain — centralni mozak" **kontradikcija** i da se **ne radi**
   (`:350`), i da je emergentni jezik **namjerno zabranjen** (`:349`).
2. **Smernice („Pune smernice")** — tekstualni zahtjev korisnika iz kojeg je nastao v0.6.0. To je
   *specifikacija*, i ono što je od nje izgrađeno je u ovom dokumentu označeno kao **SADA**;
   ono što nije — **SLEDEĆE / POSLE / KASNIJE**.

**Pravilo po kojem se radi (i koje je zapisano kao odluka):** *ako se dokument i kod razlikuju,
ispravlja se dokument* — `docs/DECISIONS.md:147` (§6, tačka 4). Testovi su treći arbitar.

### 1.1 Šta je „stvarno izgrađeno" (SADA, u kodu, sa dokazom)

| Sposobnost | Fajl | Dokaz |
|---|---|---|
| UDP SWIM gossip (PING/ACK/PING_REQ/LEAVE/DISSEMINATE) | `src/gossip.js` | `tests/3-nodes.test.mjs` „3 node-a se nalaze za <2s", „failure detection … lažnog potpisa" |
| Ručni RESP klijent (`net`, bez npm) | `src/resp-client.js` (189 linija) | test „RESP parser: kodiranje i parsiranje", „queue: LPUSH/BRPOP … visibility timeout" |
| CRDT tabla (LWW + vektorski sat) | `src/shared/blackboard.js` | testovi „CRDT: LWW … konvergira", „CRDT: delta i vektorski sat" |
| Task queue (`memory` / RESP LPUSH+BRPOP / NATS) | `src/shared/queue.js` | test „queue: LPUSH/BRPOP preko ručnog RESP klijenta" |
| Pheromone (TTL 30s + decay, half-life 10s) | `src/shared/pheromone.js` | test „pheromone: TTL 30s, decay (pola za 10s) i heat" |
| Cross-node izvršavanje („task u A pada u B") | `src/node.js:189–211` | test „task ubačen u node A završava u node B ako je B slobodniji" |
| Support / Execution / Research klaster kao fasade | `src/node.js:356–370` | testovi „support cluster…", „execution cluster…", „research cluster…" |
| Federacija: samo metrike + HMAC | `src/research/federation.js`, `src/research/genome-registry.js` | testovi „federation: šalje SAMO metrike…", „federation: hot-swap je isključen po defaultu" |
| CLI jedan-proces-jedan-čvor | `src/index.js:505–546` | test „CLI: node src/index.js --port=… se diže i odgovara na /status" |

### 1.2 Šta je „planirano" (i tako se zove, bez uljepšavanja)

| Stavka | Status | Zašto nije SADA |
|---|---|---|
| Autentifikacija **identiteta AGENTA** na gossip ulazu | **planirano** | HMAC pokriva **čvor**, ne agenta; vidi §10 |
| Perzistencija membership-a preko restarta | **planirano** | `members` je `Map` u memoriji (`src/gossip.js:60`); restart = ponovni `join` |
| Pravi Redis u CI | **planirano** | test koristi `fakeRedisServer()` (`tests/3-nodes.test.mjs:291–352`) |
| NATS protiv pravog servera | **planirano** | `createNatsClient` postoji (`src/shared/queue.js:24–122`) ali nema testa protiv brokera |
| mTLS / WireGuard između čvorova | **planirano** | veza je otvoreni UDP + HMAC u payload-u |
| Rate limit na **gossip** ulazu | **planirano** | `maxInboundPerMin` postoji **samo** u TCP sloju (`src/cluster/gossip.js:29`), ne u `src/gossip.js` |
| Cross-node budžet (satni budžet podijeljen među čvorovima) | **planirano** | budžet je in-process (`src/core/budget.js`) |
| `maxInFlight` kao **globalna** kvota | **planirano** | danas je per-node (`src/node.js:39`) |
| Trening modela iz federacije | **planirano / van opsega** | federacija je **selekcija genoma**, ne trening; vidi §7 |
| Cijene iz smernica ($999/mo, $0.12/agent-hour) | **iz SMJERNICA/plana** | to su *planske* cijene iz prodajnog materijala, **ne ostvareni prihod**; u kodu ne postoje kao konstanta |

> **Otvoreno priznanje o verziji:** `package.json` je podignut na `0.6.0`, ali `git log` pokazuje HEAD
> `10a0747 … v0.5.0`, a `git status` daje 4 modifikovana fajla (`docs/DECISIONS.md`, `package.json`,
> `scripts/demo.mjs`, `src/index.js`). Znači: **v0.6.0 postoji u radnoj kopiji i u testovima, ali nije
> objavljen kao commit/tag.** Ko čita ovaj dokument poslije commita — provjeri `git log -1`.

---

## 2. Mapiranje poster → kod

Tabela se čita: **element sa slike | gdje živi | šta tačno radi | dokaz.**

| Element sa slike | Folder / fajl | Šta tačno radi (provjereno u kodu) | Dokaz |
|---|---|---|---|
| **SUPPORT CLUSTER** (`docs/35…html:210`) „korisnički upiti · monitoring · logovanje" | `src/support/ticket-router.js` (109 linija) | `TICKET_RULES` (`:17–24`) klasifikuje ticket u `refund`/`billing`/`technical`/`ecommerce`/`sales`/`other` **regex heuristikom, bez LLM poziva**; `route()` (`:35–50`) bira agenta iz kataloga sa **vidljivim fallback-om** ako agent ne postoji; `submit()` (`:58–107`) radi tri stvari: `queue.push` (`:70`), `pheromone.deposit` (`:87`, jačina `1 + priority*0.2`) i `audit.append` (`:97`) | test „support cluster: ticket-router klasifikuje, stavlja u queue i ostavlja feromon" (5 slučajeva: refund→support, billing→finance, technical→**fallback** support, ecommerce, sales) |
| **RESEARCH CLUSTER** (`:267`) „analiza · izvlačenje znanja · evaluacija" | `src/research/extractor.js` (98), `src/research/genome-registry.js` (145), `src/research/federation.js` (129) | **extractor**: 6 heuristika (`HEURISTICS`, `:14–21` — email/phone/iban/amount/date/document), `missing[]` umjesto izmišljanja (`:34–38`), opcioni LLM režim sa strogim JSON-om i padom na heuristiku (`:42–59`), ingest u vektore (`:81–85`). **genome-registry**: prijem fitness izvještaja sa HMAC-om (`report`, `:54–75`), `assertNoContent` (`:35–45`), `stats()` (`:78–92`), `selectWinners()` = tournament + top 10% + `minSamples` (`:98–103`), `publish`/`bestUpdate` (`:106–133`). **federation**: `buildReport` (`:31–45`), `measureFromRewards` (`:48–54`), `reportFitness` (`:82–91`), `pullUpdate` (`:94–100`), `applyUpdate` sa hot-swap kapijom (`:106–123`) | testovi „research cluster: extractor izvlači činjenice i ne izmišlja", „federation: šalje SAMO metrike…", „federation: hot-swap je isključen po defaultu…" |
| **EXECUTION CLUSTER** | `src/execution/tool-runner.js` (86 linija) | **Jedina tačka izvršenja alata** (`docs/DECISIONS.md:292` D65). `check()` (`:17–29`) spaja politiku tenanta (`tools[toolName] ?? defaultTool`) sa sandbox odlukom; `run()` (`:35–73`) je **fail-closed**: `deny` → `PolicyError`, `require_approval` bez `approved:true` → `PolicyError` (`:41–44`); mjeri `ms`, upisuje u `executions` (cap 2000, `:58`), emituje metriku `tool_runner_ms` i **uvijek** piše audit (`:61–71`, u `finally`) | test „execution cluster: tool-runner poštuje politiku i sandbox (fail-closed)" — provjerava `deny`, `require_approval`, `approved:true` i sandbox blok, i da su izvršena **tačno 2** alata |
| **SHARED ENVIRONMENT** | `src/shared/blackboard.js` (170), `src/shared/queue.js` (239), `src/shared/pheromone.js` (191) | **blackboard** = CRDT: `wins()` (`:31–35`), `set` (`:51–74`), `delete` tombstone (`:82–88`), `merge` idempotentno (`:104–127`), `delta(remoteClock)` (`:130–137`), `vectorClock()` (`:145–152`), `fingerprint()` (`:155–161`). **queue**: `normalizeTask` (`{id,type,payload,ttl,value,skills,attempts}`, `:132–145`), `push` LPUSH / `pop` BRPOP (`:169–195`), `ack` sa requeue na neuspjeh (`:198–205`), `requeueStale` po `visibilityTimeoutMs` (`:208–216`). **pheromone**: `decayed()` eksponencijalno (`:35–38`), `expired()` TTL **ili** ispod `minStrength` (`:40–43`), `active()`, `heat()` (`:108–116`), `decayJob()` + `startDecay()` (`:119–141`), RESP `SETEX` perzistencija (`:45–55`) | testovi „CRDT: …", „CRDT: delta i vektorski sat", „queue: LPUSH/BRPOP …", „pheromone: TTL 30s …" |
| **COMMUNICATION** (`:293 COMMUNICATION LAYER`) | `src/gossip.js` (395 linija) | UDP `dgram` SWIM: `GOSSIP_DEFAULTS` (`:25–35`), `frame()`/`verify()` sa HMAC-SHA256 (`:39`, `:78–103`), `probe()` interval + timeout detekcija (`:199–210`), `handle()` za 5 tipova poruka (`:212–268`), `disseminate()` outbox + fanout (`:314–319`), `leave` pri `stop()` (`:344`), karantin „sticky" (`:367–386`) | testovi „3 node-a se nalaze za <2s", „gossip: failure detection (suspect/dead) i zabrana lažnog potpisa" |
| **COORDINATION** — stigmergija + pheromone + `src/swarm/*` | `src/shared/pheromone.js` + `src/swarm/blackboard.js` (zajednička tabla) + `src/swarm/swarm.js` (`tick` `:80–167`) | Dva sloja: (a) **mrežni** — `src/node.js:189–211` claim kroz CRDT, „najslobodniji preuzima"; (b) **in-process** — `swarm/blackboard.js` `claim()` sa `lease`, feromoni; `swarm.js` workeri sami uzimaju posao (**work stealing**), a kad nema posla ostavljaju `help` feromon (`swarm.js:99–107`). Nema koordinatora koji dodjeljuje posao | test „atomski claim preko CRDT-a: dva node-a ne mogu uzeti isti task"; `tests/swarm.test.mjs` |
| **EMERGENCE** (`:313 EMERGENCE LAYER`) | `src/swarm/swarm.js` — `specialization()` (`:197–212`) | Specijalizacija se **mjeri, ne propisuje**: `worker.tags[tag]` se puni **samo** iz stvarnih završetaka (`:141–142`), a `specialization()` računa „eksperta" po tagu i njegov `share` (`:206–210`). Uz to `vote`/`consensus` (`:215–239`) — glasanje je **savjetodavno**, izričito u `note` (`:237`) | `tests/swarm.test.mjs`; `swarm.stats().specialization` (`swarm.js:254`) |
| **META (RSI)** (`:323 META-IMPROVEMENT (RSI LOOP)`) | `src/rsi/meta.js` (392 linija) | Nivoi `R0–R5` sa kapijama (`RSI_LEVELS`, `:24–31`); nivo mijenja **isključivo board** (`setLevel`, `:93–113`, uz provjeru autonomije `:96–102`); `designExperiment` (`:116–166`), `runExperiment` kroz eval harness (`:169–211`), `promote` **uvijek kao prijedlog** (`:214–246`, `autoApplied: false` na `:245`), `acquireExperience` (`:249–258`), `adaptEnvironment` (`:261–282`), `metaImprove` (`:285–364`). `DEFAULT_RSI` nosi komentar da je `autoMetaPromote` **uklonjen** jer ga nijedan `if` nije čitao (`:35–36`) | `tests/revision.test.mjs`, `tests/max.test.mjs`; `rsi.level()` vraća `autoApply: false` (`:89`) |
| **META — zašto je „za kasnije"** | — | RSI je **posljednji** sloj jer mu trebaju **mjerenja** (nagrade, trace, eval zlatni set) da bi uopšte imao šta optimizovati: `metaImprove` čita `researchLog` i **prazan log vraća prazne predloge** (`:288–301`). Redoslijed je zato: komunikacija → koordinacija → izvršavanje → mjerenje → meta. Osim toga, svaka meta-izmjena je po dizajnu **prijedlog**, pa nema šta „pobjeći" — ali nema ni koristi dok nema istorije eksperimenata | `src/rsi/meta.js:301–339` |

**Napomena o posteru koja se mora reći naglas:** poster na `:297` tvrdi **„Gossip preko TCP"**, a v0.6.0
komunikacioni sloj je **UDP**. Oba postoje u repou: TCP gossip je stariji `src/cluster/gossip.js`
(`node:net`, `ALLOWED_MESSAGE_TYPES` na `:20`, `intervalMs: 2000` / `fanout: 3` na `:23–29`), a novi
UDP je `src/gossip.js`. Poster i `config/cluster.json` opisuju **stariji TCP sloj**; „Pune smernice"
opisuju **novi UDP sloj**. Vidi §4.

---

## 3. Četiri sloja i redoslijed gradnje

Redoslijed gradnje je bio obavezan: **ne možeš koordinirati ono što ne možeš prenijeti, ni izvršiti
ono što nije koordinirano, ni mjeriti emergenciju prije nego što imaš izvršenja.**

| Sloj | Tehnologija | Status | Gdje je u kodu | Dokaz |
|---|---|---|---|---|
| 1. COMMUNICATION | UDP `dgram`, JSON frame + HMAC-SHA256, 5 tipova poruka | **SADA** | `src/gossip.js` (`GOSSIP_DEFAULTS:25`, `verify:90`) | „3 node-a se nalaze za <2s"; „failure detection … lažnog potpisa" |
| 2. COORDINATION | CRDT LWW + vektorski sat; queue `memory`/RESP/NATS; pheromone TTL+decay | **SADA** | `src/shared/blackboard.js`, `src/shared/queue.js`, `src/shared/pheromone.js` | „CRDT: LWW … konvergira"; „queue: LPUSH/BRPOP…"; „pheromone: TTL 30s…" |
| 3. EXECUTION | claim → verifikacija → run → rezultat u CRDT; tool-runner kao jedina kapija | **SADA** | `src/node.js:135–211`, `src/execution/tool-runner.js` | „task ubačen u node A završava u node B…"; „atomski claim…"; „execution cluster…" |
| 4. EMERGENCE | mjerena specijalizacija (bez propisivanja), savjetodavno glasovanje | **SADA (mjerenje)** | `src/swarm/swarm.js:197–239` | `tests/swarm.test.mjs`; `swarm.stats().specialization` |
| 4b. Emergentni jezik | — | **NE RADIMO** | — | `docs/33-SWARM-SAFETY-I-GOVERNANCE.md`; poster `:317`, `:349` |
| 5. META (RSI) | R0–R5 kapije, eksperimenti kroz eval, prijedlozi u inbox | **SADA (mehanika)** / **mjerenja su SLEDEĆE** | `src/rsi/meta.js` | `tests/revision.test.mjs`; `autoApply: false` (`meta.js:89`, `:385`) |
| 6. FEDERACIJA | fitness-only izvještaj + HMAC, tournament + top 10%, hot-swap kapija | **SADA (in-process registry)** | `src/research/federation.js`, `src/research/genome-registry.js` | „federation: šalje SAMO metrike…"; „hot-swap je isključen po defaultu" |
| 6b. Federacija preko mreže | `fetch()` na `registryUrl` | **POSLE** | `federation.js:56–69` (`send`), `:94–100` (`pullUpdate`) | Putanja postoji, ali **nema testa protiv pravog registry servera** (u testu se koristi `registry` objekat u procesu, `:57–60`) |
| 7. Perzistentni membership | — | **KASNIJE** | — | `src/gossip.js:60` je in-memory `Map` |
| 8. mTLS / NAT traversal / chaos testovi | — | **KASNIJE** | — | §10, §11 |

**Zašto baš ovaj redoslijed (konkretno, iz koda):** `src/node.js` na jednom mjestu zavisi od svih nižih
slojeva — `gossip` (`:81`), `crdt` (`:70`), `pheromone` (`:71`), `queue` (`:72`) — a `tick()` (`:189`)
ih spaja u jednu odluku. Da je bilo koji niži sloj nedostajao, `tick()` se ne bi mogao ni napisati.

---

## 4. Communication layer: sopstveni gossip (UDP)

### 4.1 Zašto UDP, a ne TCP za ovaj sloj

- **Membership je idempotentan i ponavlja se.** Ako PING izgubi paket, sljedeći interval (300ms) nosi
  isti sadržaj. Nema transakcije koju treba dokazati — pa nema ni razloga da se plaća TCP handshake,
  retransmisija i držanje veze po peer-u (`src/gossip.js:2–16`).
- **Nema `master`-a, nema konekcije koju treba uspostaviti.** Svaki čvor šalje na `fanout` slučajno
  odabranih živih članova **plus** na bootstrap `peers` (`targetList()`, `:179–188`). TCP bi značio
  matricu veza N×(N−1) i logiku ponovnog spajanja po svakoj.
- **Discovery bez ikakve liste** je moguć: `broadcast: true` otvara drugi socket i radi UDP broadcast
  (`:290–301`, `broadcastPort` na `:33`).
- **Cijena koju plaćamo i zato je CRDT obavezan:** UDP ne garantuje isporuku, redoslijed ni
  jedinstvenost. Zato poruke nose `id` za deduplikaciju (`:227–228`, `maxSeenIds` `:34`) i `ts` sa
  dozvoljenim odstupanjem ±120s (`:101`), a sve što je *stanje* (a ne *signal*) ide kroz CRDT `merge`,
  koji je idempotentan (`blackboard.js:104–127`).

### 4.2 Poruke: tipovi i polja

`MESSAGE_TYPES` je **zatvoren** spisak (`src/gossip.js:37`), a `frame()` baca `ValidationError` za
bilo koji drugi tip (`:79`). Svaki frame je `{ body, sig }` gdje je `sig = HMAC-SHA256(secret, JSON(body))`
(`:39`, `:87`), a `verify()` provjerava **potpis, tip i timestamp** (`:90–103`).

| Tip | Ko šalje | Obavezna polja u `body` | Šta nosi u `payload` | Gdje se obrađuje |
|---|---|---|---|---|
| `PING` | svaki čvor svakih `intervalMs` | `v,id,type,nodeId,incarnation,ts` | `members[]` (do 12 živih, `gossipDigest:172–175`), `items[]` (do 8 disseminacija), **`load`, `tasksDone`, `uptimeMs`** iz `status()` (`src/node.js:91`), `probe`, opciono `join:true` | `handle` `:238–244` |
| `ACK` | čvor koji je primio PING | isto | `host, port`, `members[]`, `ackTo`, **`load`/`tasksDone`** | `:245–247` |
| `PING_REQ` | čvor koji sumnja | `target` u payload-u | ime ciljnog čvora — traži **indirektnu sondu** (SWIM): treći čvor pinga cilj u ime pošiljaoca | `:248–255` |
| `LEAVE` | čvor pri `stop()` | — | `host, port` | `:256–263` → status `left` |
| `DISSEMINATE` | `gossip.broadcast()` / `disseminate()` | — | proizvoljni `item` (u `src/node.js` to je `{kind:'crdt', entries}` ili `{kind:'task', task}`) | `:264` → `deliver()` `:270–274` |

**Ključna dizajn-odluka:** PING **nosi** membership tračeve i status opterećenja, pa ne postoji
„drugi kanal" za dijeljenje stanja — sve ide u istom datagramu (`gossipDigest`, `:171–175`).
Ograničenje veličine je `maxDatagramBytes: 8192` (`:31`); ako bi frame prešao limit, **skraćuje se
disseminacija**, a ne šalje fragmentovan paket (`:82–85`, komentar: „UDP fragmentacija = gubici").

### 4.3 Parametri iz smernica i gdje se mijenjaju

| Parametar iz smernica | Vrijednost u kodu | Gdje se mijenja |
|---|---|---|
| interval | **300 ms** | `GOSSIP_DEFAULTS.intervalMs` — `src/gossip.js:26`; `probe` se veže na `setInterval` u `start()` (`:303`); može se prebiti `config.gossip.intervalMs` (`src/node.js:88`) |
| fanout | **2** | `GOSSIP_DEFAULTS.fanout` — `src/gossip.js:27`; koristi se u `targetList()` (`:186`) i `disseminate()` (`:317`) |
| failure timeout | **1200 ms** | `GOSSIP_DEFAULTS.failureTimeoutMs` — `src/gossip.js:28`; primjenjuje se u `probe()` (`:205–209`), gdje tišina > timeout znači `markFailed` |
| prelazak u `dead` | 2 promašaja | `deadAfterMisses: 2` (`:29`), logika u `markFailed` (`:135–147`) |
| refutacija | `incarnationBumpMs: 2000`, `incarnation` u svakom frame-u | `:30`, `:80`, refutacija u `handle` (`:231–234`) |
| deduplikacija | `maxSeenIds: 2000` | `:34`, `seen` u `handle` (`:222–228`) |
| UDP broadcast discovery | `broadcast:false`, `broadcastPort:0` | `:32–33`, `start()` (`:290–301`) |
| tajna klastera | **nema default u kodu** — `createGossip` baca `ValidationError` bez `secret` | `src/gossip.js:57` (fail-closed); u CLI-ju dolazi iz env **`NMQ_CLUSTER_SECRET`** (`src/index.js:518`) |

**⚠️ Zamka koju treba znati:** `config/cluster.json:12–20` sadrži **drugačije** parametre
(`intervalMs: 2000`, `fanout: 3`, `suspectMs: 6000`, `deadMs: 15000`, `maxInboundPerMin: 600`).
To **nije** konfiguracija UDP gossip-a — to je konfiguracija **starijeg TCP sloja**
(`src/cluster/gossip.js:23–29`, koji je i sam `enabled: false` na `cluster.json:3`).
Ako mijenjaš ponašanje novog sloja, mijenjaš `GOSSIP_DEFAULTS` u `src/gossip.js` ili
`config.gossip` koji se predaje kroz `src/node.js:88`.

### 4.4 Zašto HMAC na svakoj poruci

`sign`/`safeEqual` (`:39–45`) i `verify` (`:90–103`) znače: **nepotpisan, tuđe potpisan ili istekao
datagram se odbija** i broji u `stats.rejected`, uz metriku `gossip_rejected_total` i event `rejected`
(`:215–220`). Test to dokazuje doslovno: čvor sa **drugim** secretom pošalje PING i tvrdi se
`a.stats.rejected > before` **i** da napadač **ne ulazi** u membership
(`tests/3-nodes.test.mjs:96–100`). Poređenje potpisa je `crypto.timingSafeEqual` uz provjeru dužine
(`:40–45`).

### 4.5 Kako se mjeri „<2s discovery" (dokaz)

Mjerenje je dio **koda**, ne ručno opažanje:

1. `node.start()` pamti `t0`, pokreće gossip, i ako ima peer-ova odmah zove `join(peers)`
   (`src/node.js:295–300`) — ne čeka prvi interval.
2. `waitForPeers({ expected, timeoutMs: 2000, pollMs: 25 })` (`src/node.js:311–319`) vrti petlju i
   mjeri `syncMs` dok `aliveCount() - 1 >= expected`.
3. Test za tri čvora tvrdi `s.syncMs < 2000` **za svaki** čvor i `alivePeers === 2`
   (`tests/3-nodes.test.mjs:65–84`), plus da je membership **obostran** i da nijedan nije `self` za
   drugoga (`:72–77`).
4. CLI ispisuje istu mjeru čovjeku: `console.log('SYNCED in Xs, N nodes alive …')`
   (`src/index.js:539`), a test provjerava da linija postoji (`tests/3-nodes.test.mjs:612`).

**Izmjereno u ovoj sesiji:** `✔ 3 node-a se nalaze za <2s (bez mastera, UDP gossip) (47.76ms)` —
dakle dva reda veličine ispod granice, na loopback-u i u jednom procesu.

**Iskrena granica ovog dokaza:** test koristi `port: 0` (efemerni) i `host: '127.0.0.1'`
(`tests/3-nodes.test.mjs:38–41`), pa **mjeri discovery na loopback-u**, ne preko NAT-a ili između
mašina. CLI putanja ima dodatnu razliku: `start()` šalje `join` samo za `peers` iz `--peers`
(`src/node.js:300`), a `--advertise` je default `127.0.0.1` (`src/index.js:526`) — za razdvojene
mašine se `--host`/`--advertise` moraju postaviti ručno. To je **planirano** za dokumentovanje u §11.

---

## 5. Coordination layer: CRDT tabla + queue + pheromone

### 5.1 CRDT pravilo pobjede (i zašto baš tako)

Pravilo je u `wins()` (`src/shared/blackboard.js:31–35`):

```js
if (a.counter !== b.counter) return a.counter > b.counter;   // prvo brojač (lokalni, monotono raste)
return String(a.nodeId) > String(b.nodeId);                  // pa nodeId, leksikografski
```

**Zašto `counter` pa `nodeId`:** da bi pobjednik bio **deterministički i identičan na svim čvorovima**
bez ikakve komunikacije. Kad bi pobjedu odlučivao `Date.now()`, dva čvora sa različitim satom (ili
samo različitim trenutkom dolaska) mogla bi trajno ostati u različitom stanju. Ovako je odluka funkcija
**sadržaja zapisa**, pa je `fingerprint()` isti na svim čvorovima — što je i dokazano: sva tri čvora
primaju zapise u **različitom redoslijedu i sa duplim paketima**, a `fingerprint()` je jednak
(`tests/3-nodes.test.mjs:193–238`).

**Zašto vektorski sat, a ne timestamp:** vektorski sat pamti **ko je šta vidio**. Zato `merge()` može
biti idempotentan (isti paket dva puta → `applied: 0`, `:118–122` i test `:229–233`) i zato `delta()`
može poslati samo ono što drugi **nije vidio** (`:130–137`, test `:240–255`: poslije sync-a
`B.delta(A.vectorClock()).length === 0`). Kod odbačenog zapisa **spaja se samo sat**, da čvor zna šta
je udaljeni vidio (`:118–122`) — inače bi delta stalno slala isto.

**Tombstones:** brisanje je **operacija**, ne odsustvo zapisa: `delete()` upisuje zapis sa
`deleted: true` i **novim, većim `counter`-om** (`:82–88`), pa on učestvuje u istoj LWW trci kao i
vrijednost. Bez toga bi čvor koji nije vidio brisanje „vaskrsao" obrisani ključ pri sljedećem merge-u.
Test to provjerava: B vidi `task:2`, pa ga obriše → svi na kraju vide `undefined`
(`tests/3-nodes.test.mjs:203–205`, `:236–237`).

**Kapacitet:** `maxKeys: 20_000` (`:19`) uz determinističko izbacivanje najstarijeg po `counter`
(`:68–72`) — i to je kompromis, ne garancija (vidi §10).

**`fingerprint()`** (`:155–161`) sortira zapise i spaja `key=value@counter:nodeId`, sa `∅` za tombstone
— to je ono što se poredi u testovima konvergencije.

### 5.2 Queue

| Mehanizam | Kod | Napomena |
|---|---|---|
| Oblik taska | `normalizeTask` `src/shared/queue.js:132–145` | `{id, type, payload, ttl, tenantId, value, skills, attempts, createdAt}`; `ttl` default 30s (`:21`) |
| Ključevi | `nmq:q:<tenant>` / `nmq:q:inflight:<tenant>` | `TASK_DEFAULTS` `:21`, `key`/`inflightKey` `:126–127` |
| Ubackvanje | `push()` → `LPUSH` (`:171`) | memory: `memory.push`; nats: `publish` |
| Preuzimanje | `pop()` → `BRPOP` (`:182–184`) | vremenski limit klijenta je `(seconds+3)*1000` (`src/resp-client.js:174`) da BRPOP ne istekne prije servera |
| Vidljivost | `inFlight` `Map` + `visibilityTimeoutMs: 60_000` (`:21`) | task se vodi dok traje, pa se **ne gubi** ako čvor padne |
| Povrat | `ack(id, {success:false})` → ponovni `LPUSH` sa `attempts+1` (`:201–202`) | at-least-once, `attempts` je vidljiv |
| Stale | `requeueStale()` (`:208–216`) | u `src/node.js` se zove na `max(1000, taskTtlMs)` (`:218`) |
| NATS | `createNatsClient` (`:24–122`) | **`pop()` vraća `null`** — komentar u kodu: „NATS je pub/sub obavještenje, ne red sa potvrdom" (`:190`). Dakle NATS **nije** queue sa ack-om |

### 5.3 Pheromone

| Mehanizam | Kod | Vrijednost |
|---|---|---|
| TTL | `PHEROMONE_DEFAULTS.ttlMs` `src/shared/pheromone.js:20` | **30 000 ms** (spec) |
| Half-life | `PHEROMONE_DEFAULTS.halfLifeMs` `:21` | **10 000 ms** — `decayed()` koristi `0.5 ** (age/halfLife)` (`:35–38`) |
| Tvrdi pod | `minStrength: 0.02` `:22` | ispod ovoga zapis se briše (`expired()` `:40–43`) |
| Decay job | `decayJob()` `:119–134`, `startDecay()` `:136–141` | interval `decayIntervalMs: 1000` (`:23`); broji `removed`/`alive`, emituje `pheromone_evaporated_total` |
| „heat" | `heat()` `:108–116` | sabira jačinu po `taskId`; `problem` i `blocked` se **množe sa −1.5** |
| Perzistencija | `persist()` `:45–55` | RESP `SETEX` (TTL na Redis strani → preživljava restart procesa); u `src/node.js` pheromone je **bez** redis-a (`src/node.js:71`) |
| Tipovi | `PHEROMONE_TYPES` `:17` | `hot, done, problem, opportunity, help, blocked, claimed` |

**Dva sloja feromona — i to je namjerno:** `src/shared/pheromone.js` (mrežni, 30s/10s po smernicama) i
`src/swarm/blackboard.js` (`halfLifeMs = 300_000` na `:23`, `ttlMs = 3_600_000` na `:147` — in-process
roj). Poster na `:305` navodi **„pola za 5 min"**, što je **stariji in-process sloj**; novi mrežni sloj
po smernicama je **30s TTL / 10s half-life**. Oba broja su u kodu, oba su testirana, i nisu zamjena
jedan za drugi.

### 5.4 Tabela: šta koji mehanizam garantuje, a šta NE

| Mehanizam | Šta garantuje | Šta **NE** garantuje |
|---|---|---|
| CRDT `merge` (LWW + VC) | **Determinističku konvergenciju**: svi čvorovi na kraju imaju isti `fingerprint()`; **idempotenciju** (dupli paket ne mijenja stanje) | Ne garantuje da je pobjednik „tačan" — pobjeđuje veći `counter`, pa čvor koji je duže radio ima prednost; ne garantuje ni da je stanje potpuno (eviction na `maxKeys`) |
| Tombstone | Da obrisani ključ neće „vaskrsnuti" | Ne garantuje brisanje na čvoru koji nikad nije primio tombstone i sam upiše ključ sa većim `counter`-om |
| `delta(remoteClock)` | Da se ne šalje sve, nego samo novo | Ne garantuje potpunost ako je `remoteClock` pogrešan/nepotpun — `sync()` iz smernica nije implementiran kao posebna metoda; koristi se `delta` + `snapshot` |
| Queue RESP (`LPUSH`/`BRPOP`) | **At-least-once** isporuku i da task ne nestane tiho (uz `inFlight` + `requeueStale`) | **Ne** garantuje exactly-once: isti task može biti izvršen dva puta (zato `attempts` i idempotencija, `docs/DECISIONS.md:277` D60) |
| Queue memory | Radi bez ičega, FIFO u procesu | Ne preživljava restart i **nije** dijeljen između čvorova (`src/node.js:72` koristi `memory` backend) |
| NATS klijent | Pub/sub obavještenje | **Nije** red sa potvrdom — `pop()` vraća `null` (`queue.js:190`); nije testiran protiv pravog servera |
| Pheromone decay | Postepeno slabljenje + tvrdi TTL + `heat` kao prioritet | Ne garantuje fer raspodjelu ni „ispravan" prioritet — to je **signal**, ne komanda (`swarm/blackboard.js:7`) |
| Claim kroz CRDT | **Tačno jednog pobjednika** za dati task (test to dokazuje) | Ne garantuje da će task biti izvršen ako svi čvorovi padnu poslije claim-a — tada `requeueStale`/`taskTtlMs` vraća posao |

---

## 6. Cross-node izvršavanje: „task u A završava u B ako je B slobodniji"

### 6.1 Korak po korak (svaki korak ima liniju u kodu)

1. **Objava.** `submitTask(task)` (`src/node.js:113–132`) normalizuje task (`origin: id`), upiše ga u
   lokalni `tasks` Map, **upiše u CRDT** kao `task:<id>` (`:126`), pushne u lokalni queue (`:127`) i
   **pošalje gossip-om**: `gossip.broadcast({ kind:'task', task })` (`:129`).
2. **Prihvat na drugim čvorovima.** `onDisseminate` (`:97–110`): `kind:'task'` → ako CRDT još ne zna
   task, `crdt.set('task:<id>', task)` (`:106`); ako lokalni `tasks` još ne zna, upiše (`:107`).
   Dodatno, svaki PING nosi `items[]` disseminacije (`src/gossip.js:174`, `:243`), pa se task širi i
   **bez** posebnog DISSEMINATE paketa — epidemijski, uz svaki otkucaj.
3. **Odluka „da li se uopšte prijavljujem".** `tick()` (`:189–211`) prvo računa **svoj** `load()`
   (`inFlight.size`, `:74`) i **najmanji load među živim peer-ovima** (`minPeerLoad()`, `:75–79`, koji
   čita `load` iz membership-a — a taj `load` stiže iz `status()` kroz PING/ACK, `:91` + `gossip.js:119`).
   Ako je `peerMin < myLoad` → **odustaje odmah**, sa razlogom `peer_freer` (`:194`). Ovo je doslovno
   „najslobodniji node preuzima".
4. **Kandidati.** Filtrira CRDT zapise sa prefiksom `task:`, izbacuje `state === 'done'`, izbacuje one
   koji su već u lokalnom `inFlight` i one koji **već imaju claim** (`:197–203`), pa sortira po
   `value` (opadajuće) i po `createdAt` (rastuće) — dakle vrjednije prvo, pa starije prvo.
5. **Claim kroz CRDT + verifikacija.** `tryClaim(task)` (`:135–157`):
   - ako `claim:<id>` već postoji → `{claimed:false, reason:'već preuzet'}` (`:138`);
   - inače **zapiše claim u CRDT** sa svojim `nodeId`, `at` i `load` (`:139`);
   - pošalje **cijeli snapshot** CRDT-a gossip-om (`:141`) da svi vide claim;
   - **čeka `claimConfirmMs` (default 120ms, u testu 80ms)** (`:142`);
   - pa **ponovo pročita claim iz CRDT-a**: ako pobjednik nije on → `{claimed:false, reason:'izgubio trku (LWW)'}` (`:143–147`). Ovo je srce mehanizma: pobjeda nije „ko je prvi poslao", nego **čiji zapis pobjeđuje po `wins()`**.
   - dodatna brava: ako je `inFlight.size >= maxInFlight` (default 3, `:39`), **briše svoj claim**
     (`:149`) i odustaje sa `preopterećen`.
6. **Prijava i izvršenje.** Ako je claim prošao: `inFlight.set` (`:152`), feromon `claimed` jačine 0.8
   (`:153`), i `queue.inFlight.set` da i queue zna (`:154`). Zatim `runTask(task)` (`:159–186`):
   pokreće `runner` (`:162` — u CLI-ju je to `async (task) => ({output: 'node <port> obradio <id>'})`,
   `src/index.js:531`), pa u CRDT upisuje `result:<id>` (`:165`) i **prepisuje `task:<id>` sa
   `state:'done', doneBy:id`** (`:166`), ostavlja `done` feromon (`:167`) i `queue.ack(success:true)`
   (`:168`).
7. **Neuspjeh je takođe poruka.** U `catch`-u (`:173–182`): `result:<id>` sa `ok:false`, **`crdt.delete('claim:<id>')`** da task vrati u igru (`:177`), `problem` feromon jačine 1.5 (`:178`) i
   `queue.ack(success:false)` → ponovni LPUSH sa `attempts+1` (`queue.js:201`).

### 6.2 ASCII dijagram

```
   ┌──────────── NODE A (load 1: spor task) ────────────┐
   │  submitTask(taskX)                                 │
   │    ├─ tasks.set(taskX)                             │
   │    ├─ crdt.set("task:"+id, taskX)   ← stanje       │
   │    ├─ queue.push(taskX)             ← lokalni red  │
   │    └─ gossip.broadcast({kind:'task'})              │
   │                        │                           │
   │  tick(): myLoad=1, minPeerLoad()=0                 │
   │    └─ peerMin < myLoad  →  IDLE "peer_freer"       │  ◄── A NE uzima task
   └────────────────────────┼───────────────────────────┘
                            │  UDP PING/ACK: nosi load + items[] (disseminacija)
                            ▼
   ┌──────────── NODE B (load 0) ───────────────────────┐
   │  onDisseminate({kind:'task'})                      │
   │    └─ crdt.set("task:"+id)                         │
   │  tick(): myLoad=0, peerMin=1  → 0 < 1 → NASTAVLJA   │
   │    ├─ tryClaim(): crdt.set("claim:"+id,{nodeId:B}) │
   │    │     gossip.broadcast({kind:'crdt', snapshot}) │
   │    │     čekaj claimConfirmMs (120ms)              │
   │    │     crdt.get("claim:"+id).nodeId === B ? ✅   │
   │    ├─ runTask(): runner(task)                      │
   │    ├─ crdt.set("result:"+id, {ok:true})            │
   │    ├─ crdt.set("task:"+id, {state:'done',doneBy:B})│
   │    ├─ pheromone.deposit(type:'done')               │
   │    └─ queue.ack(id,{success:true})                 │
   └────────────────────────┬───────────────────────────┘
                            │  result + task.doneBy putuju nazad kroz CRDT merge
                            ▼
   ┌──────────── NODE C (posmatrač) ────────────────────┐
   │  crdt.get("task:"+id).doneBy === "node-B"   ✅     │
   │  crdt.get("claim:"+id).nodeId === "node-B"  ✅     │
   └────────────────────────────────────────────────────┘
```

Kad dva čvora krenu **istovremeno**, oba upišu `claim:<id>`; LWW pravilo (`wins()`,
`blackboard.js:31–35`) daje **istog** pobjednika na oba čvora, pa gubitnik u koraku 5 vidi tuđi
`nodeId` i odustaje — test to mjeri kao „tačno jedan smije izvršiti"
(`tests/3-nodes.test.mjs:173–189`).

### 6.3 Šta je tačno mjereno u testu (dokaz)

Test „task ubačen u node A završava u node B ako je B slobodniji" (`tests/3-nodes.test.mjs:121–171`):

| Korak testa | Linija | Tvrdnja |
|---|---|---|
| A dobije spor runner (1.5s) | `:124–127` | simulira „A je zauzet" |
| A uzme prvi task i ostane zauzet | `:131–134` | `assert.ok(a.load() >= 1)` |
| A **mora vidjeti** da je B slobodan | `:136–142` | `assert.equal(a.minPeerLoad(), 0)` — dokaz da `load` stvarno putuje gossip-om |
| Novi task ide u A | `:145` | `submitTask` na A |
| **A odbija** | `:146–148` | `aTick.idle === true` **i** `aTick.reason === 'peer_freer'` |
| **B izvršava** | `:151–158` | `doneOnB.nodeId === 'node-B'` |
| A **nije** izvršio | `:159` | `a.done.some(...) === false` |
| CRDT zna ko je završio (i to vide svi) | `:162–164` | B: `task:<id>.doneBy === 'node-B'`; **C** (treći čvor): `claim:<id>.nodeId === 'node-B'` |

**Izmjereno u ovoj sesiji:** `✔ task ubačen u node A završava u node B ako je B slobodniji (1631.27ms)`
i `✔ atomski claim preko CRDT-a: dva node-a ne mogu uzeti isti task (111.74ms)`.

**Ono što ovaj test NE dokazuje** (i tako treba čitati): sve tri instance su u **jednom procesu** i na
**loopback-u**; `inFlight`/`load` je lokalno stanje tog objekta, a ne OS procesa. Dokaz je za
*logiku odluke i konvergenciju*, ne za mrežni partition ili stvarnu mašinsku razliku u brzini.

---

## 7. Privatnost: federacija šalje SAMO fitness

### 7.1 Tačan oblik izvještaja

Do 8 polja, ni jedno više. `ALLOWED_REPORT_FIELDS` (`src/research/genome-registry.js:27`):

```js
['node_id', 'genome_id', 'fitness', 'tasks_done', 'pheromone_efficiency', 'ts', 'sig', 'tenant_hash']
```

`buildReport()` (`src/research/federation.js:31–45`) gradi **tijelo** i onda potpisuje:

```js
{ node_id, genome_id, fitness, tasks_done, pheromone_efficiency, ts, [tenant_hash], sig }
```

- `fitness` i `pheromone_efficiency` se zaokružuju na 4 decimale (`:36`, `:38`);
- `tenant_hash` se **dodaje samo ako je tenant proslijeđen** (`:41`) i računa se kao
  `sha256(salt + ':' + tenantId).slice(0,16)` gdje je salt `cfg.tenantHashSalt` (default
  `'nmq-federation'`, `:23`);
- `sig = HMAC-SHA256(secret, JSON(body))` (`:26`, `:44`) — dakle potpis je **nad tijelom bez `sig` polja**.

### 7.2 Šta se ODBIJA (dvije nezavisne brave)

| Brava | Kod | Ponašanje |
|---|---|---|
| **Zatvoren spisak polja** | `federation.buildReport` `:42–43`; `registry.assertNoContent` `:35–39` | Bilo koje polje van `ALLOWED_REPORT_FIELDS` → `ValidationError` („Federation ne smije slati polja…"). **Nije** ignorisanje — jeste greška. Test podmeće `email_text` i očekuje odbijanje (`tests/3-nodes.test.mjs:484`) |
| **Dužina stringa ≤ 128** | `registry.assertNoContent` `:40–43` | Svaki `string` duži od 128 znakova → `ValidationError` („izgleda kao sadržaj, a ne metrika"). Razlog u komentaru: to je **moguć kanal za iznošenje sadržaja**. Test podmeće `'x'.repeat(200)` i očekuje odbijanje (`tests/3-nodes.test.mjs:485`) |
| **HMAC** | `registry.report` `:54–58` | `sig` se odvaja od tijela, pa se poredi `safeEqual(sig, sign(secret, JSON.stringify(body)))` (`:58`); neispravan → `AuthError`. Test podmeće `'a'.repeat(64)` (`tests/3-nodes.test.mjs:487`) |
| **Obavezna polja** | `registry.report` `:55` | Bez `sig`, `node_id` ili `genome_id` → `ValidationError` |
| **Nema logovanja sadržaja** | `federation.js:89` loguje **samo** `nodeId, genomeId, fitness`; `registry.js:73` isto | Nema `logger.debug(rawPayload)` nigdje u ovoj putanji |
| **Blob se ne loguje** | `federation.js:112` | U predlogu hot-swapa blob ide kroz `redact(String(JSON.stringify(blob)).slice(0,200))` — dakle maskiran i skraćen |

### 7.3 Selekcija: tournament + top 10% + `minSamples` + hot-swap kapija

- `minSamples: 3`, `topPercent: 10`, `maxReports: 20_000` — `genome-registry.js:30`.
- `stats()` agregira po genomu: `samples`, `avgFitness`, `tasksDone`, `pheromoneEfficiency`, broj
  **različitih čvorova** (`:78–92`).
- `selectWinners()` filtrira `samples >= minSamples`, uzima
  `top = k ?? max(1, ceil(ranked.length * topPercent / 100))` (`:98–103`); sortiranje je
  **deterministički** (po `avgFitness`, pa samples, pa `genomeId` — kako piše u komentaru `:96`).
- `bestUpdate()` (`:116–133`) traži **objavljeni blob** za pobjednika; ako ga nema vraća
  `{update:null, reason:'genom … nije objavljen (samo metrike)'}` — dakle metrika bez bloba ne može
  postati update.
- **Hot-swap je isključen po defaultu:** `cfg = { autoHotSwap: false, minFitnessGain: 0.03, … }`
  (`federation.js:23`). `applyUpdate()` (`:106–123`) vraća `applied:false` uz
  `reason: 'autoHotSwap je isključen (safety default)'` (`:112`) i **ne poziva** `controlPlane.deploy`.
  Čak i sa `autoHotSwap: true`, traži se dobitak ≥ `minFitnessGain` (`:110–111`). Kod primjene ide
  `controlPlane.deploy(...)` sa `actor: federation:<by>` (`:115`) i audit zapisom (`:120`).
- Test dokazuje oba stanja: default → `applied:false`, `deploy` pozvan **0 puta**; sa
  `autoHotSwap:true` + `minFitnessGain:0.01` → `applied:true` (`tests/3-nodes.test.mjs:514–532`).
- **Test dokazuje i `minSamples`:** genom `genom-D` sa jednim mjerenjem se **ne razmatra**
  (`tests/3-nodes.test.mjs:499–502`).

### 7.4 Tabela: prijetnja → kako je spriječena → dokaz

| Prijetnja | Kako je spriječena | Dokaz u testu |
|---|---|---|
| Sadržaj klijenta (tekst ticketa/maila) izlazi sa edge-a | Zatvoren spisak od 8 polja; `text`/`payload`/`email_text` nisu među njima i **ne mogu** biti dodati | `assert.throws(registry.report({...report, email_text:'kupac@firma.com'}))` `:484`; `assert.ok(!('text' in report))` `:480`; `ALLOWED_REPORT_FIELDS.includes('text') === false` `:481` |
| Sadržaj prokrijumčaren kroz „metriku" (dugačak string) | Druga brava: `string.length > 128` → odbijanje | `assert.throws(registry.report({...report, extra:'x'.repeat(200)}))` `:485` |
| Lažni čvor šalje tuđe rezultate | HMAC nad tijelom; neispravan potpis → `AuthError` | `assert.throws(registry.report({...report, sig:'a'.repeat(64)}), AuthError)` `:487` |
| Šum iz jednog mjerenja postaje „pobjednik" | `minSamples: 3` kapija | `assert.ok(!winners.some(w => w.genomeId === 'genom-D'))` `:502` |
| Loš genom se sam instalira na edge | `autoHotSwap: false` → samo predlog; uz uključen hot-swap traži se `minFitnessGain` | `off.applied === false`, `deployed.length === 0` `:524–526` |
| Sadržaj u logu | Log nose samo `nodeId`, `genomeId`, `fitness` | `federation.js:89`, `genome-registry.js:73` (kod, ne test) |
| Sadržaj u tekstu prijedloga hot-swapa | `redact(...)` + `.slice(0,200)` | `federation.js:112` (kod, ne test) |
| Tenantski identitet u čistom obliku | `tenant_hash` = salted SHA-256, prvih 16 hex znakova | `federation.js:41`; **i `tenant_hash` je opcion** (samo ako je tenant proslijeđen) |
| Veliki broj izvještaja raste u beskonačno | `maxReports: 20_000` sa `shift()` | `genome-registry.js:30`, `:70` |

**Izmjereno u ovoj sesiji:** `✔ federation: šalje SAMO metrike (nikad sadržaj), HMAC obavezan, top 10% se distribuira (1.65ms)`,
`✔ federation: hot-swap je isključen po defaultu (predlog), a sa uključenim radi kroz control plane (0.67ms)`.

**Šta federacija NIJE (i to je u kodu, ne u marketingu):** `genome-registry.js:10–11` — „Ovo je
mjeračko učenje (federated *selection*), **ne trening modela**: registar ne vidi podatke, samo brojeve."
Registry prima **skalarne metrike** i vraća **blob koji je neko drugi objavio** (`publish` `:106–113`).

---

## 8. Checklist iz smernica (dokazano / djelimično)

| Stavka iz smernica | Status | Dokaz (komanda ili test) | Šta fali |
|---|---|---|---|
| `node src/index.js --port=...` radi bez errora | **DOKAZANO** | test „CLI: node src/index.js --port=… se diže i odgovara na /status (checklist)" (`tests/3-nodes.test.mjs:572–616`) — spawnuje proces, čeka `GET /status`, POST-uje task, čeka da bude izvršen, provjerava `SYNCED\|PARTIAL` liniju. Kod: `src/index.js:509–546` | Test koristi `--log=warn` i **nasumičan port** `18900+rand(80)`; nema testa za `--peers` iz CLI-ja (nema multi-proces CLI testa) |
| 3 node-a se vide za **<2s** | **DOKAZANO** (loopback, jedan proces) | test `:65–84` tvrdi `syncMs < 2000` i `alivePeers === 2` za svaki čvor; mjereno **47.76ms**. Kod: `waitForPeers` `src/node.js:311–319` | Nije mjereno na stvarnoj mreži/NAT-u; nema dokaza za 3 **procesa**/**mašine** |
| Task u **A** završi u **B** | **DOKAZANO** | test `:121–171` — A `reason:'peer_freer'`, B `doneBy:'node-B'`, C vidi `claim.nodeId === 'node-B'`; mjereno **1631.27ms** | Jedan proces, loopback; `load` je lokalno stanje objekta |
| Pheromone ispari **30s** | **DOKAZANO** | test `:259–287` — `now += 10_000` → 0.5, još 10s → 0.25, još 10s → `active().length === 0` i `stats().total === 0`. Defaulti: `src/shared/pheromone.js:20–21` | Test koristi **injektovani `now()`** (`:261`) — dokaz je za matematiku decay-a, ne za zidni sat; `src/node.js:71` veže TTL na `taskTtlMs` (30s), a half-life na `taskTtlMs/3` (10s) |
| **Nema `node_modules`** | **DOKAZANO** | test `:539` — `assert.rejects(fs.access(ROOT/node_modules))`; u ovoj sesiji `Test-Path node_modules` → `False`; `package.json.dependencies === {}` (`:538`) | — |
| Samo built-in moduli (`net`, `dgram`, `fs`, `crypto`, `events`) | **DOKAZANO** (i šire) | test `:536–568` skenira **sve `src/**/*.js`**, skida komentare, i traži bare importe + crnu listu `['ioredis','libp2p','bullmq','express','axios','lodash','ws','redis','kafkajs','amqplib']`; tvrdi `violations === []` i `files.length > 30` | Stvarno korišteni built-in moduli su **9**, ne 5: `node:crypto, node:dgram, node:events, node:fs, node:fs/promises, node:http, node:net, node:path, node:url`. `http` i `path/url/fs` su legitimni built-ini (admin ruta, putanje, `pathToFileURL`), ali **spisak iz smernica nije potpun** — treba ga proširiti u smernicama, ne u kodu |
| RESP parser **≤ 200 linija** | **DOKAZANO** | `src/resp-client.js` = **189 linija** (cijeli fajl, sa komentarima). Sam parser `parseReply` je `:22–53` (**32 linije**), enkoder `encodeCommand` `:12–19` (**8 linija**) | 189 ≤ 200 ✅ — ali **stariji** `src/cluster/redis.js` ima **225 linija**, dakle duplikat **prelazi** prag. Ako se prag čita kao „u repou postoji samo jedan RESP parser ≤200", treba ga čitati kao „**kanonski** je `src/resp-client.js` (189)" i stariji fajl označiti kao legacy |

**Zbirno za checklistu:** 6 od 6 stavki **dokazano** u automatskim testovima; uz to 16/16 u
`tests/3-nodes.test.mjs` i **221/221** u cijelom repou (`fail 0`).

---

## 9. Šta NAMJERNO ne radimo (i zašto)

| Ne radimo | Zašto (argument iz koda i dokumenata) | Gdje je to zapisano |
|---|---|---|
| **Centralni orkestrator / master** | Poster sam tvrdi „no central orchestrator", a crta mozak u centru — to je kontradikcija (`docs/35…html:374–376`). U kodu je **tabla**: `src/node.js` nema rutu koja dodjeljuje posao drugom čvoru; svaki čvor odlučuje sam u `tick()` (`:189`) na osnovu svog `load`-a i `minPeerLoad()`-a (`:75–79`). Čak i CRDT nema koordinatora — pobjeda je deterministička funkcija zapisa (`blackboard.js:31–35`) | `docs/DECISIONS.md:299` (D67), `docs/35…html:350`, `:374–376` |
| **npm zavisnosti** | Traženo kao tvrdo pravilo; provjereno **skenerom koda**, ne obećanjem: test `:536–568` čita svaki `src/**/*.js`, uklanja komentare i odbija svaki bare import; `package.json.dependencies` je `{}`; `node_modules` ne smije postojati (`:539`). Zato su `src/resp-client.js`, `src/cluster/redis.js`, NATS klijent (`shared/queue.js:24–122`) i gossip napisani ručno | `tests/3-nodes.test.mjs:536–568`; `docs/DECISIONS.md:302` (D70) |
| **`libp2p`** | Teška zavisnost za ono što nam treba (membership + dissemination). Sopstveni UDP gossip je 395 linija i **nema nijednu** zavisnost (`src/gossip.js:2`) | `docs/35…html:298` („NE RADIMO — libp2p") |
| **`bullmq` / `express`** | Queue je `LPUSH`/`BRPOP` nad ručnim RESP-om (`shared/queue.js:171`, `:182`), a HTTP admin je `node:http` (`src/node.js:20`, `:228`) — sve što je potrebno za `/status`, `/tasks`, `/task`, `/tick`. Uvlačenje frameworka bi značilo i `node_modules` | `src/node.js:224–267` |
| **Fake AI obećanja** | Extractor **nikad ne izmišlja**: ono što nije našao vraća kao `missing`, ne popunjava prazninom (`extractor.js:9`, `:34–38`); test to provjerava praznim tekstom → `facts.length === 0` i `missing === ['amount','date','email']` (`tests/3-nodes.test.mjs:465–468`). Slično, federacija ne tvrdi da „uči model" — `genome-registry.js:10–11` izričito kaže da je to **selekcija**, ne trening | `tests/3-nodes.test.mjs:451–469` |
| **Emergentni jezik** | **Ovo je najvažnije „ne".** Jezik koji čovjek ne čita je **po definiciji skriveni kanal** — a skriveni kanal je tačno ono što `docs/33` dokumentuje kao glavni rizik roja: „Skriveni kanal postoji i kad su svi 'pošteni'" (`docs/33-SWARM-SAFETY-I-GOVERNANCE.md:43`), a detektori u `src/swarm/safety.js` traže kodiran sadržaj (entropija + hex blobovi, fail-closed). Zato: (a) `MESSAGE_TYPES` je zatvoren spisak (`src/gossip.js:37`, `src/cluster/gossip.js:20`) i nepoznat tip se odbija (`gossip.js:79`, `:100`); (b) `PHEROMONE_TYPES` je takođe zatvoren (`shared/pheromone.js:17`) i nepoznat tip baca grešku (`:64`); (c) `swarm/blackboard.js:10–11` izričito **nema** direktne poruke agent→agent — sve ide kroz medijaciju gdje je vidljivo i logovano. Poster to ponavlja na dva mjesta (`:317`, `:349`, i objašnjenje `:369–371`) | `docs/33`, `docs/35…html:317`, `:349`, `:369–371` |
| **BFT konsensus** | Procjena u posteru: 2–3 mjeseca rada, „i pitanje koristi" (`docs/35…html:364`). Danas je glasanje **savjetodavno** i to je u kodu napisano: `note: 'Glasanje je savjetodavno — izvršne odluke iznad niskog rizika i dalje traže čovjeka (board)'` (`src/swarm/swarm.js:237`) | `src/swarm/swarm.js:224–239` |
| **Roj koji mijenja sopstvene granice** | Granice (autonomija, budžet, alati, RSI nivo) mijenja **čovjek**: RSI nivo samo kroz `setLevel` sa `by: 'board'` (`src/rsi/meta.js:93–113`), hot-swap genoma isključen po defaultu (`federation.js:23`, `:111–112`), a `DEFAULT_RSI` nosi komentar da je zastavica `autoMetaPromote` **uklonjena** jer je nijedan `if` nije čitao (`meta.js:35–36`) | `docs/35…html:318`, `src/rsi/meta.js:35–36` |

**O cijenama (obavezno pošteno):** smernice/plan pominju vrijednosti tipa **$999/mo** i
**$0.12/agent-hour**. To su **cijene iz SMJERNICA/plana (prodajni materijal)** — u kodu ih **nema**
kao konstanta, nema ih u `package.json`, i **nisu ostvareni prihod**. Jedina mjesta gdje se u repou
pojavljuje broj 999 su nevezane stvari: limit ponude u A2A testu (`docs/25-A2A-EKONOMIJA.md:572`)
i CSS `border-radius` (`docs/35…html:47`). Ako se te cifre ikad navedu van konteksta plana, to je
pogrešno predstavljanje.

---

## 10. Iskreno: rupe i rizici

| Rupa | Posljedica | Plan / šta već ublažava |
|---|---|---|
| **UDP ne garantuje isporuku** (nema retransmisije, nema redoslijeda) | PING/ACK može se izgubiti → član privremeno `suspect`; disseminacija može stići dvaput ili nikako | Ublaženo **idempotencijom**: `seen` deduplikacija po `id` (`src/gossip.js:222–228`), a sve *stanje* ide kroz CRDT `merge` koji je idempotentan (`blackboard.js:104–127`). `suspect` se sam ispravlja sljedećim PING-om. **Nije** ublaženo: trajni gubitak svih kopija disseminacije (nema retry queue-a) |
| **Gossip nije autentifikovan po identitetu AGENTA — samo čvor HMAC-om** | Svaki proces koji ima `NMQ_CLUSTER_SECRET` može se predstaviti kao **bilo koji `nodeId`** (npr. `node-A`) i slati tuđe `load`/`tasksDone`; HMAC dokazuje *članstvo u klubu*, ne *identitet člana* | Trenutno ublaženo time što je secret jedna tajna klastera i što se `nodeId` ne koristi za prava (nema autorizacije po `nodeId`). **Planirano:** per-node ključevi + potpis sa `nodeId` u AAD; mTLS kao transport. Vidi §11 |
| **Nema perzistencije membership-a (restart = ponovni join)** | Poslije restarta čvor ne zna ko je bio živ dok ne razmijeni PING-ove; u međuvremenu `minPeerLoad()` vraća `null` (`src/node.js:75–79`) → čvor **ne odustaje** ni pred kim i može uzeti task koji je „trebao" slobodnijem | Ublaženo: `join(peers)` se zove odmah u `start()` (`:300`), pa je prozor ~jedan interval. **Planirano:** snimiti membership na disk i učitati pri startu |
| **NATS klijent nije testiran protiv pravog NATS servera** | `createNatsClient` (`shared/queue.js:24–122`) implementira `INFO/CONNECT/PING/PONG/PUB/SUB/MSG`, ali nijedan test ne pokreće broker. Parser (`onData` `:59–76`) je ručni i može imati rubove (npr. `MSG` payload koji sadrži `\r\n`) | Kod je izolovan i `pop()` za NATS **namjerno vraća `null`** (`:190`), pa NATS ne može tiho „izgubiti" task u queue logici. **Planirano:** integracioni test sa `nats-server` u CI |
| **Redis test koristi fake server u testu** | Test „queue: LPUSH/BRPOP preko ručnog RESP klijenta" (`tests/3-nodes.test.mjs:291–387`) vrti **sopstveni** `fakeRedisServer()` (`:291–352`) koji podržava samo `PING/LPUSH/RPUSH/LLEN/BRPOP/SET/SETEX/GET`. To znači: test dokazuje **naš** parser i **našu** queue logiku, ali **ne** kompatibilnost sa stvarnim Redis-om (npr. `BRPOP` timeout semantika, `EVAL`, tipovi odgovora) | **Planirano:** pravi Redis (i `redis:7`) u CI; tada i `EVAL`/Lua putanja iz `cluster/store.js` dobija dokaz |
| **`tenant_hash` je salted hash, ne anonimizacija u pravnom smislu** | `sha256(salt + ':' + tenantId).slice(0,16)` (`federation.js:41`). Salt je **konfiguracija** (`tenantHashSalt`, default `'nmq-federation'`, `:23`) — ako je salt poznat, tenantId se može **brute-force**-ovati (prostor tenant ID-jeva je mali). Osim toga prvih 16 hex znakova = 64 bita, što je za korelaciju dovoljno | Ublaženo: `tenant_hash` je **opcion** (šalje se samo ako je tenant proslijeđen). **Planirano:** HMAC sa tajnom umjesto golog SHA-256, puna dužina, i pisano upozorenje da to **nije** GDPR anonimizacija |
| **Nema rate limita na gossip ulazu (UDP sloj)** | `src/gossip.js` prima svaki potpisani datagram i obradi ga; nema `maxInboundPerMin`. Napadač koji ima secret (ili samo flooduje) može trošiti CPU i puniti `seen` | Djelimično ublaženo: `seen` je ograničen (`maxSeenIds: 2000`, `:34` → `:228`), a `maxDatagramBytes: 8192` ograničava veličinu (`:31`, `:82`). **`maxInboundPerMin: 600` postoji samo u TCP sloju** (`src/cluster/gossip.js:29`) — **planirano** prenijeti u UDP (`src/gossip.js`) |
| **Nema TLS/WireGuard** | Sav gossip saobraćaj je čist UDP; HMAC daje integritet i autentičnost, ali **ne** povjerljivost — `load`, `tasksDone`, `nodeId` i disseminirani CRDT zapisi (uključujući `task.payload`!) su čitljivi na žici | **Ovo je najozbiljnija rupa u privatnosti mreže:** `src/node.js:129` disseminira **cijeli task** (uključujući `payload`), pa sadržaj zadatka putuje nešifrovan. Plan: WireGuard/mTLS kao transport ili šifrovanje payload-a; do tada se klaster smije vrtjeti samo u povjerenoj mreži |
| **`maxInFlight` je per-node** | `maxInFlight: 3` (`src/node.js:39`) ograničava **jedan** čvor. Deset čvorova = do 30 istovremenih runova; nema globalne kvote | Ublaženo: `queue.js` ima `visibilityTimeoutMs`, a `swarm` sloj ima per-tenant kvote (`governance.quotas`, `swarm.js:81`). **Planirano:** cross-node budžet i kvota (vidi §11) |
| **Federacija je selekcija genoma, NE trening modela** | Registry ne trenira ništa: prima skalarne metrike (`report` `:54–75`) i vraća **blob koji je neko objavio** (`publish` `:106–113`, `bestUpdate` `:116–133`). Nema gradijenata, nema agregacije težina, nema FedAvg | To je **namjerno** i napisano u kodu (`genome-registry.js:10–11`). Ako neko očekuje „federated learning" u ML smislu — to nije ovo i **planirano** je da tako i ostane (trening modela je van procesa, `src/rsi/meta.js:257`) |

**Dodatne rupe koje sam našao čitajući kod (nisu u smernicama, ali su stvarne):**

| Rupa | Posljedica | Plan |
|---|---|---|
| **Dva paralelna gossip sloja** (`src/gossip.js` UDP vs `src/cluster/gossip.js` TCP) i **dva RESP klijenta** (`src/resp-client.js` vs `src/cluster/redis.js`) | Zabuna: `config/cluster.json` opisuje TCP sloj koji je `enabled: false`, a poster na `:297` tvrdi „Gossip preko TCP" dok je novi sloj UDP. Održavanje dva puta | **Planirano:** jedan put označiti kao kanonski (`src/gossip.js`, `src/resp-client.js`), drugi kao legacy sa `@deprecated` i rokom uklanjanja; `config/cluster.json` dobiti `$comment` koji kaže **koji** sloj konfiguriše |
| **`src/shared/queue.js` referencira `src/resp-client.js`, ali `src/cluster/store.js:8` koristi `src/cluster/redis.js`** | Dva RESP puta u istom repou za istu namjenu | **Planirano:** konsolidacija na `src/resp-client.js` (189 linija ≤ 200), pa `cluster/redis.js` ukloniti |
| **`claimConfirmMs: 120` je fiksno čekanje** (`src/node.js:37`, `:142`) | Na mreži sa RTT > 120ms verifikacija može proći **prije** nego što tuđi claim stigne → dva čvora mogu oba misliti da su pobijedila; spašava ih samo kasniji `merge` (jedan će na kraju vidjeti tuđi veći `counter`) | Ublaženo: `crdt.merge` će ipak konvergirati, a `result:<id>` je posljednji zapis. **Planirano:** verifikacija vezana na izmjereni RTT (npr. `2 × max RTT`) umjesto konstante |
| **`delta()` bez `sync()` metode** | Smernice pominju `sync()`; u kodu postoje `delta()` i `snapshot()` (`blackboard.js:130`, `:140`), koji se koriste ručno (`src/node.js:141` šalje **cijeli** snapshot, ne deltu!) | **Planirano:** koristiti `delta(remoteClock)` + `vectorClock()` u `src/node.js` umjesto `snapshot()` — to je već implementirano i testirano, samo nije spojeno na mrežni put |
| **`sha256` skraćen na 16 hex znakova za `tenant_hash`** | 64 bita → kolizije nisu realne, ali korelacija i brute-force malog prostora tenant ID-jeva jesu | Vidi red o `tenant_hash` gore |
| **`load()` je `inFlight.size`, a `inFlight` se puni tek poslije claim-a** (`src/node.js:152`) | Između `submitTask` i klaima `load` je 0, pa dva čvora mogu oba krenuti u claim istog taska (rješava LWW) — ali i **različite** taskove u istom trenutku, što je u redu, samo nije „opterećenje" u smislu CPU-a | Prihvaćeno kao dizajn (broj zadataka u letu = opterećenje). Alternativa (CPU/mem) je **planirana** |

---

## 11. Sljedeći koraci

| Faza | Šta | Dokaz koji **mora** dati |
|---|---|---|
| **F1 — pravi Redis u CI** | `redis:7` servis u CI; `queue: resp` protiv njega; `cluster/store.js` `HSETNX` claim | Integracioni test sa **stvarnim** Redis-om (ne `fakeRedisServer`): `LPUSH`/`BRPOP` timeout, `SET NX PX`, `EVAL`, `HSETNX`; test mora pasti ako se `resp-client.js` razlikuje od protokola |
| **F2 — pravi NATS u CI** | `nats-server` u CI; `createNatsClient` (CONNECT/SUB/PUB/MSG) | Test: `subscribe` → `publish` → `cb` primio payload; test sa payload-om koji sadrži `\r\n` (rub rucnog parsera, `queue.js:59–76`) |
| **F3 — cross-node budžet** | Satni budžet/kvote podijeljeni među čvorovima (danas per-process) | Test: 3 čvora, `maxRunsPerTick`/satni budžet; ukupan broj runova **ne** prelazi budžet kad sva tri rade paralelno |
| **F4 — mTLS / WireGuard** | Povjerljivost gossip saobraćaja (danas je `task.payload` na žici čitljiv, `src/node.js:129`) | Test koji **odbija** čitanje payload-a bez ključa; dokaz da je HMAC i dalje prisutan kao drugi sloj |
| **F5 — perzistentni membership** | Snimiti `members` na disk i učitati pri startu | Test: restart čvora → `minPeerLoad()` **nije** `null` u prvom `tick()`-u poslije restarta (danas jeste, `src/node.js:75–79`) |
| **F6 — chaos testovi particije** | Mrežna particija, `SIGKILL` čvora u sredini claim-a, duplirani paketi, reorder | Test: poslije particije oba dijela konvergiraju na **isti `fingerprint()`**; task preuzet pa ubijen čvor se **vraća** i izvršava tačno jednom (uz vidljiv `attempts`) |
| **F7 — rate limit na UDP ulazu** | Prenijeti `maxInboundPerMin` iz TCP sloja (`src/cluster/gossip.js:29`) u `src/gossip.js` | Test: 10× više datagrama od limita → `stats.rejected` raste, CPU/`seen` ne raste linearno |
| **F8 — per-node identitet** | Potpis vezan na `nodeId` (per-node ključ) umjesto jedne tajne klastera | Test: čvor sa **svojim** ključem ne može poslati frame kao drugi `nodeId` (danas može — vidi §10) |
| **F9 — `sync()` na mreži** | U `src/node.js` koristiti `delta(vectorClock)` umjesto `snapshot()` (`:141`) | Test: poslije prvog sync-a, drugi `broadcast` šalje **0** zapisa (danas šalje sve); mjerljivo manji saobraćaj u `gossip.stats.sent` |
| **F10 — konsolidacija duplikata** | Jedan RESP klijent i jedan gossip sloj (legacy označen i uklonjen) | Test: nema dva fajla koja implementiraju `parseReply`; `src/resp-client.js` ostaje ≤ 200 linija |
| **F11 — NAT/`--advertise`** | Dokumentovati i testirati razdvojene mašine (danas test samo loopback, `--advertise` default `127.0.0.1`, `src/index.js:526`) | Test: dva procesa na različitim hostovima/interfejsima se nađu za <2s uz eksplicitni `--host`/`--advertise` |
| **F12 — merenje emergencije** | `specialization()` postoji (`swarm.js:197–212`) ali nema testa koji dokazuje da se specijalizacija **stvarno** pojavi iz serije zadataka | Test: N rundi sa tagovima → `stats().specialization[tag].expert` je stabilan i `share` raste kroz runde |

**Redoslijed koji ima smisla:** F1/F2 (dokazi za infrastrukturu) → F9/F7/F5 (jeftine popravke u
postojećem kodu) → F8/F4 (identitet i povjerljivost) → F3/F12 (skaliranje i mjerenje) → F6 (tek kad
postoji mreža koja se može particionisati i mjeriti) → F10/F11 (čišćenje i dokumentacija).

---

## Otvorena pitanja

1. **Koji je gossip sloj kanonski — UDP ili TCP?** `src/gossip.js` (UDP, 300ms/fanout 2/1200ms) je novi
   po smernicama, ali `config/cluster.json` + poster (`docs/35…html:297`) opisuju TCP sloj
   (`src/cluster/gossip.js`, 2000ms/fanout 3). Držimo oba dok se ne odluči, ili gasimo TCP?
2. **`claimConfirmMs: 120` na mreži sa velikim RTT-om.** Da li verifikaciju vezati na izmjereni RTT
   (npr. `2 × max RTT`) ili uvesti dvofazni claim (rezervacija → potvrda) koji ne zavisi od sata?
3. **`tenant_hash`: HMAC ili hash?** Danas je `sha256(salt:tenantId).slice(0,16)` sa saltom u konfiguraciji
   (`federation.js:41`). Prelazimo na HMAC sa tajnom i punom dužinom, ili **uklanjamo** `tenant_hash`
   dok ne postoji pravna analiza (jer nije anonimizacija)?
4. **Da li disseminacija smije nositi `task.payload`?** Danas nosi (`src/node.js:129`), pa sadržaj
   zadatka ide nešifrovan UDP-om. Šaljemo samo `{id, type, value, skills}` i pustimo da čvor koji
   claim-uje povuče payload tačkasto — ili čekamo WireGuard/mTLS?
5. **`maxInFlight` i budžet: per-node ili globalno?** Danas je per-node (`src/node.js:39`). Globalna
   kvota traži koordinaciju (CRDT brojač? token bucket kroz tablu?) — što je tačno ono što bismo htjeli
   izbjeći. Koji je najmanji mehanizam koji daje globalnu granicu bez koordinatora?
6. **Koliko dugo držimo duplikate (dva gossip sloja, dva RESP klijenta)?** Konsolidacija je jeftina
   (F10), ali stariji TCP sloj ima `maxInboundPerMin` i medijaciju (`docs/DECISIONS.md:280–281`, D63)
   koje novi UDP sloj **još nema**. Da li prvo prenijeti te dvije stvari, pa ugasiti TCP — ili obrnuto?
7. **Da li se `sync()`/`delta` uopšte spaja na mrežni put?** `delta(remoteClock)` je implementiran i
   testiran (`blackboard.js:130–137`, test `:240–255`), ali `src/node.js:141` šalje **cijeli**
   `snapshot()`. Prelazak na deltu je gotovo besplatan (F9) — samo treba odlučiti da li je rizik
   nepotpune delte manji od dobitka u saobraćaju.
