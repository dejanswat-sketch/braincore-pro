# -*- coding: utf-8 -*-
"""Skida priloge iz određenog mejla (po ID-u ili temi) sa Gmail-a preko IMAP."""
from __future__ import annotations

import email
import imaplib
import sys
from email.header import decode_header
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gmail_pregled import dekodiraj, ucitaj  # noqa: E402

IZLAZ = Path(r"E:\NMQ-PROGRAMI\nmq-robot\docs\biznisoft\snimak")


def _bezbedno(ime: str) -> str:
    s = "".join(c if c.isalnum() or c in " .-_()[]" else "_" for c in ime).strip()
    return (s or "fajl")[:120]


def main() -> None:
    c = ucitaj()
    m = imaplib.IMAP4_SSL(c["host"])
    m.login(c["user"], c["pass"])
    m.select("INBOX")

    # nađi poruku: po ID-u iz arg ili po temi koja sadrži 'BizniSoft'
    cilj_id = sys.argv[1] if len(sys.argv) > 1 else ""
    ids: list[bytes] = []
    if cilj_id:
        ids = [cilj_id.encode()]
    else:
        typ, data = m.search(None, '(SUBJECT "BizniSoft")')
        ids = data[0].split()
        if not ids:
            typ, data = m.search(None, '(SUBJECT "Snimak")')
            ids = data[0].split()
    if not ids:
        print("Nema poruke.")
        return

    IZLAZ.mkdir(parents=True, exist_ok=True)
    ukupno = 0
    for i in ids[-5:]:
        typ, d = m.fetch(i, "(RFC822)")
        if typ != "OK":
            continue
        msg = email.message_from_bytes(d[0][1])
        tema = dekodiraj(msg.get("Subject"))
        print(f"=== [{i.decode()}] {tema}")
        for deo in msg.walk():
            ime = deo.get_filename()
            if not ime:
                continue
            ime = dekodiraj(ime)
            podaci = deo.get_payload(decode=True) or b""
            if not podaci:
                continue
            put = IZLAZ / _bezbedno(ime)
            n = 1
            while put.exists():
                put = IZLAZ / f"{put.stem}_{n}{put.suffix}"
                n += 1
            put.write_bytes(podaci)
            ukupno += 1
            print(f"    SAČUVANO: {put.name} ({len(podaci)//1024} KB, {deo.get_content_type()})")
    m.logout()
    print(f"\nukupno priloga: {ukupno} → {IZLAZ}")


if __name__ == "__main__":
    main()
