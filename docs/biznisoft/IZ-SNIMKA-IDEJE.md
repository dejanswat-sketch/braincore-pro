# Šta još ima u snimku obuke — i šta možemo da iskoristimo

> Izvor: zvanični snimak „Osnovna obuka 19.08.2026." (191 min), **BizniSoft v13**.
> Kadrovi po minutu: `obuke/kadrovi/{minut}m{sekunda}s.jpg` · OCR: `obuke/OCR2-INDEKS.json`

---

## 1. Glavni ekran — 23 ikonice (kadar 180m)

BizniSoft v13 „Početna" nije samo meni — to je **radna tabla**:

| Ikonica | Šta radi |
|---|---|
| BS kartica firme | PIB, adresa, brzi pristup |
| **POSLOVNI PARTNERI** | šifarnik kupaca/dobavljača |
| **ARTIKLI I USLUGE** | šifarnik |
| Objekat (PRODAVNICA BR.01) | promena objekta |
| **NOVA FAKTURA** / **NOVA NABAVKA** | brzi unos |
| **PREGLED POSLOVANJA** | dashboard |
| **NOVI NALOG GLAVNE KNJIGE** | ručni nalog |
| **KNJIŽENJE NALOGA** | posting |
| **BizniSoft KONFIGURATOR** | parametri |
| **PROFIL OPERATERA** | koji operater radi |
| Izveštaji (finansijski / robni) | izveštaji |
| **BizniSoft TOUCH MENI** | 📱 UI za tablet/dodir |
| **BizniSoft FORMULAR** | 🖨️ **dizajner sopstvenih formulara/štampe** |
| **OBAVEZE I POTRAŽIVANJA** | ⭐ opomene, rokovi naplate |
| **STANJE ZALIHA OBJEKTA** | zalihe |
| **PODACI O PROGRAMU** | verzija, licenca |
| Pregled dokumenata **firme / objekta / operatera** | 3 nivoa pregleda |
| **BizniSoft PLANER** | 📅 kalendar/planer |

---

## 2. ADMINISTRACIJA — 22 funkcije (kadrovi 146m, 150m, 180m)

Ovo je najbogatiji dio koji **nismo iskoristili**:

| Funkcija | Zašto je zanimljiva NAMA |
|---|---|
| **Uvoz/Izvoz podataka iz baze** | ⭐⭐ **direktan uvoz/izvoz iz baze** — najjači kanal integracije |
| **SQL Monitor** | ⭐ BizniSoft radi na **SQL bazi** → podaci su dostupni |
| **Elektronska razmena podataka** | ⭐ **EDI** — dokumentovan format razmjene |
| **Elektronsko potpisivanje dokumenata** | KEP potpis |
| **Upravljanje izgledom tabela** | ⭐ objašnjava `Alt+F1` trik za uvoz |
| **Upravljanje ovlašćenjima** | uloge/dozvole operatera |
| **Upravljanje korisnicima** | korisnici |
| **Zaključavanje perioda knjiženja** | ⭐ zaštita od greške (bitno za kontrolu!) |
| **Provera integriteta podataka** | ⭐ kontrolna provjera |
| **Nova poslovna godina** | ⭐ dio završnog računa |
| **Upravljanje arhivom podataka** | arhiva |
| **Definisanje opšte štampe** / opcija štampe | štampa |
| **Definisanje obaveštenja o prometu** | obaveštenja |
| **BizniSoft status i dijagnostika** | dijagnostika |
| **Interna kontrola i nedostupno** | interna kontrola |
| **Izvršni sinhronizacije/replikaciju** | replikacija |
| **Upravljanje sinhronizacijom tabela** | više filijala |
| **Upravljanje transakcijama** | transakcije |
| **Data terminal** | terminal |
| **Poslovni referentni objekti** | šifarnik |
| **Podaci o programu i licenci** | licenca, moduli |

---

## 3. Parametri (kadrovi 146m, 150m) — preko 1.100 šifara

BizniSoft ima sistem **parametara sa šiframa** (`PARAMETRI`, `KONFIGURISANJE PARAMETARA`,
`UPRAVLJANJE PARAMETRIMA`):

| Šifra | Parametar |
|---|---|
| `10405` | **WMS integracija** ⭐ (integracija sa skladištem!) |
| `10468` | WMS integracija — tip 2 |
| `10406` | WMS elektronski |
| `10407` | WMS podrška FEDEN 64 |
| `10412` | WMS — šifra magacina |
| `11031` | **email/SMTP Port** = 465 |
| `11032` | email/SMTP user |
| `11034` | email/SMTP Password (sakriveno) |
| `11142` | email/URL Password |
| `11130` | email/UseSSL |
| `11052` | eFaktura — **KJuC za autorizaciju** |
| `11144` | eOtpremnica — KJuC za autorizaciju |
| `10312` | Zaključivanje na 2 decimale kod nabavke |

**Zaključak:** BizniSoft **šalje mejl sam** (SMTP 465) i ima **WMS integraciju**.

---

## 4. Šta od ovoga možemo da ISKORISTIMO (po prioritetu)

### 🔴 P1 — „Upravljanje izgledom tabela" + „Uvoz/Izvoz iz baze"
- **Šta:** zvaničan način da se podaci razmijene.
- **Kako:** ako Maja može da izveze **dnevnik knjiženja** i **šifarnik partnera** — naš program
  to uči (već imamo: „Uvezi BizniSoft izveštaj" i „Uči iz BizniSofta").
- **Naš zadatak:** proširiti uvoz da prima i **kontni plan**, **radnike**, **osnovna sredstva**.

### 🔴 P1 — „Zaključavanje perioda knjiženja" + „Provera integriteta podataka"
- **Šta:** BizniSoft ima ugrađenu kontrolu.
- **Kako iskoristiti:** naš program može da **upozori** „period je zaključan — ne diraj" i da
  prije izvoza provjeri integritet (mi to već radimo kroz kontrolnu sobu).
- **Predlog:** dodati u naš Rokovnik napomenu o zaključavanju perioda.

### 🟠 P2 — „Nova poslovna godina"
- **Šta:** otvaranje nove godine u BizniSoftu.
- **Kako:** dio je završnog računa — naš FR-1/FR-2 se uvozi **posle** otvaranja nove godine.
- **Predlog:** dodati u naše uputstvo korak „prvo Nova poslovna godina, pa FR nalozi".

### 🟠 P2 — **BizniSoft FORMULAR** (dizajner štampe)
- **Šta:** Maja može da dizajnira svoju štampu.
- **Kako iskoristiti:** naši PDF-ovi (potvrde, platni listići, rešenja) već imaju **njeno zaglavlje
  i logo**. Ako želi da izgleda **identično** kao BizniSoft štampa — pošalji nam jedan BS PDF pa
  da poravnamo.

### 🟠 P2 — **OBAVEZE I POTRAŽIVANJA** (opomene)
- **Šta:** BizniSoft prati rokove naplate.
- **Kako iskoristiti:** naš **Rokovnik** može da računa **rokove plaćanja** po fakturi i da
  upozori „ovaj kupac kasni".
- **Predlog:** dodati u Rokovnik: „opomena pred utuženje" kao tip roka.

### 🟡 P3 — **WMS integracija** (`10405`)
- **Šta:** BizniSoft se povezuje sa skladištem.
- **Za nas:** zanimljivo samo ako Maja ima klijenta sa skladištem. Za sada **ne diramo**.

### 🟡 P3 — **BizniSoft TOUCH MENI** / **PLANER**
- **Šta:** UI za tablet / kalendar.
- **Za nas:** Maja radi na računaru — nije prioritet.

### ⚪ Ne diramo (BizniSoft radi bolje)
- **SQL Monitor** — čitanje baze direktno je **rizično** (može da pokvari podatke). Ne radimo.
- **Elektronska razmena podataka (EDI)** — treba dokumentacija od BizniSofta.
- **Elektronsko potpisivanje** — KEP certifikat je Majin.

---

## 5. Konkretni predlozi za naš program (3 stvari)

### 1) Rokovnik — rokovi plaćanja i opomene
```
Nova vrsta roka: "Opomena pred utuženje"
- računa se od datuma fakture + rok plaćanja (npr. 15/30/45 dana)
- upozorenje 3 dana prije
```

### 2) Uputstvo — korak „Nova poslovna godina" prije FR naloga
```
Završni račun (dopuna):
1. BizniSoft: Administracija -> Nova poslovna godina
2. Zatim uvoz FR-1/FR-2 naloga
```

### 3) Provjera zaključanog perioda prije izvoza
```
Prije izvoza u BizniSoft: ako je period zaključan — upozori Maju
(da ne uvozi u zatvorenu godinu)
```

---

## 6. Kako da nađeš bilo šta u snimku

1. Otvori `2-SADRZAJ-OBUKE.txt` (33 teme po delovima)
2. Nađi temu → premotaj snimak
3. Ili traži kadar: `obuke/kadrovi/{minut}m{sekunda}s.jpg`

**Poznati minuti:**
| Minut | Tema |
|---|---|
| 4–9 | glavni ekran, moduli, konfigurator |
| 29–31 | šifarnik partnera |
| 37–41 | barkod |
| 87–89 | dnevni pazari |
| 110 | pravila za automatsko knjiženje |
| 140–150 | **ADMINISTRACIJA + parametri** |
| 168–170 | eFakture (SEF) |
| 180–184 | glavna tabla + administracija |
| 187–191 | Excel / račun troška |
