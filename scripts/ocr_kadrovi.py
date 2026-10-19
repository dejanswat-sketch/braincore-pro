# -*- coding: utf-8 -*-
"""OCR svih kadrova obuke (Tesseract) → indeks teksta po minutu.

Rezultat:
  obuke/ocr/{minut}m{sekunda}s.txt   — tekst svakog kadra
  obuke/OCR-INDEKS.json              — {minut: tekst}
  obuke/TEME-PO-MINUTIMA.md          — tema → minut (traženje ključnih reči)
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

KADROVI = Path(r"E:\NMQ-PROGRAMI\nmq-robot\docs\biznisoft\obuke\kadrovi")
OCR = KADROVI.parent / "ocr"
TESS = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

# teme iz kursa (redom) — ključne reči za prepoznavanje u kadru
TEME = [
    ("I deo — Logovanje", ["prijava", "login", "korisničko ime", "lozinka"]),
    ("I deo — Izgled glavnog ekrana", ["glavni ekran", "meni", "moduli", "osnovni šifarnici"]),
    ("I deo — Osnovna pravila", ["pravila", "f2", "izmene", "tasteri"]),
    ("I deo — Otvaranje firme", ["otvaranje firme", "firma", "nova firma", "podaci o firmi"]),
    ("I deo — Objekti/magacini", ["objekat", "magacin", "prodavnica", "mesto troška"]),
    ("I deo — Šifarnik partnera", ["partner", "kupac", "dobavljač", "pib", "maticni"]),
    ("I deo — Šifarnik artikala", ["artikal", "šifra artikla", "jedinica mere", "tarifna"]),
    ("I deo — Ulaz robe / Kalkulacija", ["kalkulacija", "ulaz robe", "veleprodaja", "maloprodaja"]),
    ("I deo — Izlaz robe / Izlazna faktura", ["izlazna faktura", "izlaz robe", "kupac", "račun"]),
    ("I deo — Napomene u dokumentu", ["napomena", "napomene"]),
    ("I deo — Knjiženje naloga", ["knjiženje", "nalog", "glavna knjiga", "evidencija"]),
    ("I deo — Storniranje", ["storno", "storniranje", "vraćanje u obradu"]),
    ("I deo — Profaktura", ["profaktura", "avans", "predračun"]),
    ("I deo — Interni prenos robe", ["interni prenos", "prenos robe"]),
    ("I deo — Stanje zaliha", ["stanje zaliha", "zalihe", "lager"]),
    ("II deo — Početno stanje", ["početno stanje", "otvaranje stanja"]),
    ("II deo — Dnevni pazari (finansijsko)", ["pazar", "dnevni pazar", "eFiskalizacija"]),
    ("II deo — Dnevni pazari (robno)", ["pazar", "robno", "dnevni pazar"]),
    ("II deo — Račun troška sa PDV", ["račun troška", "trošak", "odbitak", "ulazna faktura"]),
    ("II deo — Izvodi banaka", ["izvod", "banka", "uvoz izvoda"]),
    ("II deo — Izveštaji (finansijski)", ["izveštaj", "bilans", "finansijski"]),
    ("II deo — Izveštaji (robni)", ["izveštaj", "robni", "promet"]),
    ("II deo — KIR/KPR", ["kir", "kpr", "knjiga primljenih", "knjiga izdatih"]),
    ("II deo — Obračun PDV-a", ["pdv", "obrazac", "ppp-pdv", "prijava"]),
    ("II deo — Backup/Arhiviranje", ["backup", "arhiviranje", "kopija"]),
    ("III deo — Konfigurator", ["konfigurator", "parametri"]),
    ("III deo — eFakture (parametri)", ["efaktura", "sef", "parametri"]),
    ("III deo — Sinhronizacija eFaktura", ["sinhronizacija", "efaktura", "primljene"]),
    ("III deo — Slanje eFakture", ["slanje", "efaktura", "sef", "potpisivanje"]),
    ("III deo — eOtpremnice", ["eotpremnica", "otpremnica"]),
    ("III deo — Račun troška i kalkulacija", ["račun troška", "kalkulacija"]),
]


def main() -> None:
    if not Path(TESS).is_file():
        print("nema tesseract")
        sys.exit(1)
    OCR.mkdir(parents=True, exist_ok=True)
    kadrovi = sorted(KADROVI.glob("*.jpg"))
    print(f"kadrova: {len(kadrovi)}")
    indeks: dict[str, str] = {}
    for i, p in enumerate(kadrovi, 1):
        izlaz = OCR / (p.stem + ".txt")
        if not izlaz.is_file() or izlaz.stat().st_size < 5:
            try:
                subprocess.run(
                    [TESS, str(p), str(izlaz.with_suffix("")), "-l", "srp+eng", "--psm", "11"],
                    capture_output=True, timeout=90,
                )
            except Exception:
                pass
        txt = ""
        if izlaz.is_file():
            txt = izlaz.read_text(encoding="utf-8", errors="replace")
        indeks[p.stem] = re.sub(r"\s+", " ", txt).strip()
        if i % 25 == 0:
            print(f"  {i}/{len(kadrovi)}")
    (OCR.parent / "OCR-INDEKS.json").write_text(
        json.dumps(indeks, ensure_ascii=False, indent=1), encoding="utf-8")
    print("teksta ukupno:", sum(len(v) for v in indeks.values()), "znakova")

    # ── tema → minuti ──
    def minuti(kljuc: str) -> int:
        m = re.match(r"(\d+)m", kljuc)
        return int(m.group(1)) if m else 0

    linije = ["# BizniSoft obuka — tema → minut (OCR kadrova)", ""]
    for naziv, reci in TEME:
        hitovi = []
        for k, t in sorted(indeks.items(), key=lambda x: minuti(x[0])):
            tl = t.lower()
            if sum(1 for r in reci if r.lower() in tl) >= 2:
                hitovi.append(minuti(k))
        if hitovi:
            prvi, zadnji = min(hitovi), max(hitovi)
            linije.append(f"- **{naziv}** — oko **{prvi}–{zadnji} min** "
                          f"({len(hitovi)} kadrova sa poklapanjem)")
        else:
            linije.append(f"- {naziv} — (nema jakog poklapanja u OCR-u)")
    (OCR.parent / "TEME-PO-MINUTIMA.md").write_text("\n".join(linije), encoding="utf-8")
    print("TEME-PO-MINUTIMA.md napravljen")


if __name__ == "__main__":
    main()
