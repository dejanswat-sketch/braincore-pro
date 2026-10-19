# -*- coding: utf-8 -*-
"""Izvlači kadrove iz snimka BizniSoft obuke + pravi kontakt-tabele za pregled."""
from __future__ import annotations

import sys
from pathlib import Path

try:
    import cv2
except ImportError:
    print("nema cv2")
    sys.exit(1)

VIDEO = Path(r"E:\NMQ-PROGRAMI\nmq-robot\docs\biznisoft\obuke\Osnovna-obuka-19.08.2026.mp4")
KADROVI = VIDEO.parent / "kadrovi"
TABELE = VIDEO.parent / "tabele"
KADROVI.mkdir(parents=True, exist_ok=True)
TABELE.mkdir(parents=True, exist_ok=True)

KORAK_S = 60          # svakih 60 sekundi
KOLONE, REDOVI = 3, 3  # 9 kadrova po tabeli

cap = cv2.VideoCapture(str(VIDEO))
if not cap.isOpened():
    print("ne mogu da otvorim video")
    sys.exit(1)

fps = cap.get(cv2.CAP_PROP_FPS) or 25
ukupno = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
trajanje = (ukupno / fps) if fps else 0
print(f"fps: {fps:.2f} | kadrova: {ukupno} | trajanje: {trajanje/60:.1f} min")

def ts(sek: float) -> str:
    m, s = divmod(int(sek), 60)
    return f"{m:02d}m{s:02d}s"

kadrovi: list[tuple[float, Path]] = []
sek = 0.0
while sek < trajanje:
    cap.set(cv2.CAP_PROP_POS_MSEC, sek * 1000)
    ok, frame = cap.read()
    if ok:
        # smanji na 960 širine (dovoljno za čitanje, manje fajlova)
        h, w = frame.shape[:2]
        if w > 1280:
            frame = cv2.resize(frame, (1280, int(h * 1280 / w)))
        p = KADROVI / f"{ts(sek)}.jpg"
        cv2.imwrite(str(p), frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
        kadrovi.append((sek, p))
    sek += KORAK_S

cap.release()
print(f"izvučeno kadrova: {len(kadrovi)}")

# ── kontakt-tabele ──
import numpy as np

po_tabeli = KOLONE * REDOVI
for t in range(0, len(kadrovi), po_tabeli):
    grupa = kadrovi[t:t + po_tabeli]
    slike = []
    for s, p in grupa:
        img = cv2.imread(str(p))
        if img is None:
            continue
        img = cv2.resize(img, (640, 360))
        cv2.rectangle(img, (0, 0), (150, 28), (0, 0, 0), -1)
        cv2.putText(img, ts(s), (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
        slike.append(img)
    if not slike:
        continue
    while len(slike) < po_tabeli:
        slike.append(np.zeros((360, 640, 3), dtype=np.uint8))
    redovi_img = [np.hstack(slike[i:i + KOLONE]) for i in range(0, po_tabeli, KOLONE)]
    tabla = np.vstack(redovi_img)
    broj = t // po_tabeli + 1
    prvi, zadnji = ts(grupa[0][0]), ts(grupa[-1][0])
    cv2.imwrite(str(TABELE / f"tabela-{broj:02d}_{prvi}-{zadnji}.jpg"), tabla,
                [cv2.IMWRITE_JPEG_QUALITY, 85])

print(f"kontakt-tabela: {len(list(TABELE.glob('*.jpg')))} → {TABELE}")
