# -*- coding: utf-8 -*-
"""Snima mejl (BizniSoft obuka) + kredencijale na bezbedno mesto.

NE ispisuje lozinku u konzolu.
"""
from __future__ import annotations

import email
import imaplib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gmail_pregled import dekodiraj, ucitaj  # noqa: E402

IZLAZ = Path(r"E:\NMQ-PROGRAMI\nmq-robot\docs\biznisoft\snimak")
CRED_SITE = Path(r"E:\NMQ-PROGRAMI\NMQ-CREDENTIALS\NMQ_SAJTOVI_LOZINKE.txt")


def main() -> None:
    c = ucitaj()
    m = imaplib.IMAP4_SSL(c["host"])
    m.login(c["user"], c["pass"])
    m.select("INBOX")
    typ, d = m.fetch(b"12675", "(RFC822)")
    msg = email.message_from_bytes(d[0][1])

    tekstovi = []
    for deo in msg.walk():
        if deo.get_content_type() == "text/plain" and not deo.get_filename():
            t = (deo.get_payload(decode=True) or b"").decode("utf-8", errors="replace")
            if t.strip():
                tekstovi.append(t)
    telo = max(tekstovi, key=len) if tekstovi else ""
    linije = [l.rstrip() for l in telo.splitlines()]
    cisto = "\n".join(l for l in linije if l.strip())

    IZLAZ.mkdir(parents=True, exist_ok=True)
    put = IZLAZ / "MEJL-BizniSoft-obuka.txt"
    zaglavlje = (
        f"Predmet: {dekodiraj(msg.get('Subject'))}\n"
        f"Datum: {dekodiraj(msg.get('Date'))}\n"
        f"Od: {dekodiraj(msg.get('From'))}\n"
        f"Prilozi: slika ekrana (image_1_2_3_4_5_6_7_8_9.png) + ikone potpisa\n"
        f"{'=' * 70}\n\n"
    )
    put.write_text(zaglavlje + cisto, encoding="utf-8")
    print(f"mejl sačuvan: {put.name} ({len(cisto)} znakova teksta)")

    # ── izvuci kredencijale (bez ispisa) ──
    import re

    url = ""
    mu = re.search(r"https?://obuke\.biznisoft\.com/?", cisto)
    if mu:
        url = mu.group(0)
    me = re.search(r"[\w.\-]+@[\w.\-]+\.\w+", cisto.split("Unesite Vaš")[-1] if "Unesite Vaš" in cisto else cisto)
    korisnik = me.group(0) if me else ""
    # šifra: red posle 'Kopirajte šifru'
    sifra = ""
    ls = cisto.splitlines()
    for i, l in enumerate(ls):
        if "Kopirajte" in l and "ifru" in l:
            for nxt in ls[i + 1: i + 4]:
                if nxt.strip() and "@" not in nxt and "http" not in nxt:
                    sifra = nxt.strip()
                    break
            break

    if url and korisnik and sifra:
        try:
            with CRED_SITE.open("a", encoding="utf-8") as f:
                f.write(
                    "\nSAJT: " + url + "\n"
                    "USER: " + korisnik + "\n"
                    "PASS: " + sifra + "\n"
                    "NAPOMENA: BizniSoft online obuka (snimak Osnovna obuka), pristup 90 dana od 07.09.2026.\n"
                )
            print(f"kredencijali upisani u store (duzina sifre: {len(sifra)} znakova, sadrzaj sakriven)")
        except Exception as e:
            print("greska pri upisu:", type(e).__name__)
    else:
        print(f"kredencijali: url={'da' if url else 'ne'} korisnik={'da' if korisnik else 'ne'} sifra={'da' if sifra else 'ne'}")
    m.logout()


if __name__ == "__main__":
    main()
