# -*- coding: utf-8 -*-
"""Povezivanje na Gmail preko IMAP i pregled pošte (bez ispisivanja lozinki)."""
from __future__ import annotations

import email
import imaplib
import sys
from email.header import decode_header
from pathlib import Path

CRED = Path(r"C:\Users\Administrator\.dsh\.credentials.yaml")


def _nadji(rec: dict, kljuc: str):
    """Traži ključ u (moguće ugnježdenom) rečniku."""
    if kljuc in rec:
        return rec[kljuc]
    for v in rec.values():
        if isinstance(v, dict):
            r = _nadji(v, kljuc)
            if r is not None:
                return r
    return None


def ucitaj():
    import yaml

    d = yaml.safe_load(CRED.read_text(encoding="utf-8")) or {}
    return {
        "host": _nadji(d, "IMAP_HOST") or "imap.gmail.com",
        "user": _nadji(d, "IMAP_USER") or "",
        "pass": _nadji(d, "IMAP_PASSWORD") or "",
    }


def dekodiraj(v) -> str:
    if not v:
        return ""
    delovi = []
    for t, enc in decode_header(v):
        if isinstance(t, bytes):
            try:
                delovi.append(t.decode(enc or "utf-8", errors="replace"))
            except Exception:
                delovi.append(t.decode("utf-8", errors="replace"))
        else:
            delovi.append(str(t))
    return " ".join(delovi)


def main() -> None:
    c = ucitaj()
    if not c["user"] or not c["pass"]:
        print("NEMA IMAP kredencijala (user/pass)")
        return
    print(f"host: {c['host']} | korisnik: {c['user'][:3]}***{c['user'][-10:] if len(c['user']) > 13 else ''}")
    try:
        m = imaplib.IMAP4_SSL(c["host"])
        m.login(c["user"], c["pass"])
    except Exception as e:
        print(f"LOGIN NEUSPEŠAN: {type(e).__name__}: {str(e)[:120]}")
        return
    print("LOGIN OK")
    m.select("INBOX")
    typ, data = m.search(None, "ALL")
    ids = data[0].split()
    print(f"poruka u INBOX: {len(ids)}")
    print("\n=== POSLEDNJIH 15 ===")
    for i in ids[-15:][::-1]:
        typ, d = m.fetch(i, "(RFC822.HEADER)")
        if typ != "OK":
            continue
        msg = email.message_from_bytes(d[0][1])
        print(f"[{i.decode()}] {dekodiraj(msg.get('Date'))[:31]}")
        print(f"     OD: {dekodiraj(msg.get('From'))[:70]}")
        print(f"     TEMA: {dekodiraj(msg.get('Subject'))[:90]}")
    m.logout()


if __name__ == "__main__":
    main()
