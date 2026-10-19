# BizniSoft v13 — mapa programa (iz zvanične obuke)

> Izvor: **zvanični snimak obuke „Osnovna obuka 19.08.2026." (191 min)**, preuzet sa
> `obuke.biznisoft.com` (pristup preko SIM AGENCIJA, 90 dana od 07.09.2026).
> Verzija u snimku: **BizniSoft v13** (`www.biznisoft.com`).
>
> Fajlovi: `obuke/Osnovna-obuka-19.08.2026.mp4` (1,45 GB) · `obuke/kadrovi/` (192 kadra po minutu)
> · `obuke/tabele/` (22 kontakt-tabele)

## 1. Moduli (levi meni — glavni ekran)

| Modul | Sadržaj |
|---|---|
| **OSNOVNI ŠIFARNICI** | partneri, artikli, mesta troška, konti… |
| **FINANSIJSKO POSLOVANJE** | kontni plan firme · **Obrada naloga za glavnu knjigu** · **Knjiženje naloga** · finansijska transferi knjiženja · pregled analitike · **Obrada izvoda u elektronskom obliku** · registar računa · **Pravila za automatsko knjiženje** · **Uvoz izvoda u XML format** · **Uvoz izvoda u TXT format** · **Uvoz podataka finansijskog** · **Obrada dnevnih pazara** · poslovne knjige · **Blagajničko poslovanje** · obračun poreza po odbitku · preknjižavanje prometa · **Obračun poreza na dodatu vrednost** · obračun razlike u ceni · obračun kursnih razlika · sravnjenja · **Pregled finansijskih izveštaja** · finansijske analize i statistike |
| **PDV EVIDENCIJA I SEF** | opšta PDV evidencija · elektronska evidencija PDV · posebne evidencije PDV · **prijem PDV evidencije preko SEF-a** · prikaz PDV evidencije · priprema i pregled eFaktura · **Slanje eFakture na SEF** · **izvoz/sinhronizacija eFakture** · pregled primljenih eFaktura · pregled poslatih eFaktura · pregled nepravilnih dokumenata · **prijem elektronskih dokumenata** · **podešavanje eFaktura** |
| **ROBNO TRGOVINA** | ulaz/izlaz robe, kalkulacije, zalihe |
| **PROIZVODNJA** | radni nalozi, specifikacije |
| **FINANSIJSKA OPERATIVA** | nalozi za plaćanje, blagajna |
| **OBRAČUN ZARADA** | plate, PPP-PD |
| **STALNA SREDSTVA I INVENTAR** | osnovna sredstva, amortizacija |
| **UPRAVLJANJE KADROVIMA** | evidencija zaposlenih, ugovori |
| **UPRAVLJANJE DOKUMENTIMA** | arhiva |
| **SPECIFIČNI POSLOVNI POKRETAČI** | — |
| **ADMINISTRACIJA** | korisnici, parametri, backup, **uvoz/izvoz podataka** |

## 2. Glavni ekran (ono što Maja vidi svaki dan)

- **Gornji meni:** Štampa · F2-Pomoć · Izbaci · Storno · Partner · Artikal · **OBRADA DOKUMENTA**
- **Tabela dokumenata** (kolone): `Konto plan · Firma · SIF.Plać · Vrsta dokumenta · Polje · Tip provere · Vrednost polja · KtoDob. · KtoZadu · Analitika · Mesto TR. · Nosilac TR.`
- **Statusna linija (dole):** `firma · mesto · adresa · PIB · matični · žiro račun` + `objekat · protivpiša · T.R.X`
- **Desno:** kalendar (za brzi datum) + panel za štampu

## 3. Ulazna faktura / račun troška (ključno za nas)

Tabovi na dokumentu:
`Stavke dokumenta · Valute i plaćanja · Avansni računi · Napomene · Specifikacija/POS · eOtpremnice · Paket i faktura · **Knjiženja** · Dodaci · Polja po želji · Vezni dokumenti · Srpski brojevi · Obaveštenja · Garancije`

**eFaktura kolone (SEF):** `OBr · Broj računa · Datum · Kupac/Naziv partnera · PIB · Broj dokumenta · Datum PDV · Dostava · Status · Ukupno iznos · **eFaktura (čekboks)** · Storno · Fizička · POP · Pravna · Virman · PDV · Operater`

→ Dakle: **eFaktura se šalje čekiranjem kolone „eFaktura"** na dokumentu, a status ide kroz `POPUNJENO / PROKNJIŽENO / OBAVEŠTENJE`.

## 4. Uvoz podataka (način da naš program „uđe" u BizniSoft)

BizniSoft ima **uvoz iz XLS/XLSX u svaku tabelu** (zvanično uputstvo):
1. Otvori tabelu → **Alt+F1** (prikaži sve kolone)
2. **F2 – Izmene** (omogući upis)
3. **Desni klik → „Uvezi iz Excela"**
4. Izaberi fajl → **Pregled XLS/XLSX tabele** → **mapiranje polja**

⚠️ Mapiraju se **samo polja vidljiva u grid-u**.

Pored toga, u **FINANSIJSKO POSLOVANJE** postoje gotovi uvozi:
**Uvoz izvoda u XML format** · **Uvoz izvoda u TXT format** · **Uvoz podataka finansijskog** (bankovni izvodi).

## 5. Šta ovo znači za Knjigovođa Pro

| Naš modul | Kako ulazi u BizniSoft v13 |
|---|---|
| Ulazne fakture | **KUF XLSX** → `C:\BizniSoft\Import\{PIB}\` → uvoz dokumenata |
| **Obračun zarada** | XLSX (radnici + obračun) → **Uvezi iz Excela** u „OBRAČUN ZARADA" ILI knjiženje 520/450… kroz KUF |
| **Osnovna sredstva** | XLSX → „STALNA SREDSTVA I INVENTAR" + nalog amortizacije (540/029) |
| **Blagajna** | „Blagajničko poslovanje" (FINANSIJSKO POSLOVANJE) |
| **Nalozi za plaćanje** | „FINANSIJSKA OPERATIVA" (ili e-banking izvoz iz BS-a) |
| **eFakture (SEF)** | čekiranje kolone **eFaktura** na dokumentu → „Slanje eFakture na SEF" |
| **Izvodi banaka** | „Uvoz izvoda u XML/TXT format" — BS to sam radi |

**Zaključak:** PPP-PD, e-banking i uvoz izvoda **BizniSoft radi sam**. Naš program treba da
pripremi **tačne ulazne podatke** i **kontroliše obračun**.

## 6. Sadržaj obuke (33 teme) — gde šta gledati

**I DEO (0–87 min):** Logovanje · Izgled glavnog ekrana · Osnovna pravila · Otvaranje firme ·
Otvaranje objekata/magacina · Šifarnik partnera · Šifarnik artikala · Ulaz robe – Kalkulacija ·
Izlaz robe – Izlazna faktura · Napomene u dokumentu · **Knjiženje naloga i pregled u evidencijama** ·
Storniranje · Profaktura · Interni prenos robe · Stanje zaliha

**II DEO (87–145 min):** Početno stanje (robno + finansijsko) · **Dnevni pazari – Finansijsko** ·
**Dnevni pazari – Robno** · **Račun troška sa odbitkom PDV** · **Izvodi banaka** · Izveštaji
(finansijski) · Izveštaji (robni) · **KIR/KPR** · **Obračun PDV-a i nalog za knjiženje** · Backup

**III DEO (145–191 min):** **BizniSoft konfigurator** · **Podešavanje parametara za eFakture** ·
Sinhronizacija eFaktura · Slanje/registracija eFakture · **eOtpremnice** · Račun troška i kalkulacija

> ⏱ Vremena su procena (191 min / 33 teme ≈ 5,8 min po temi). Kadrovi po minutu su u `obuke/kadrovi/`
> (`{minut}m{sekunda}s.jpg`) — traži temu po kadru.
