# -*- coding: utf-8 -*-
"""OCR v2 — kvalitetan tekst iz kadrova obuke (eng + 3x uvecanje + psm 6).

Izlaz: obuke/ocr2/{minut}m{sekunda}s.txt + obuke/OCR2-INDEKS.json
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import cv2

KADROVI = Path(r"E:\NMQ-PROGRAMI\nmq-robot\docs\biznisoft\obuke\kadrovi")
OCR = KADROVI.parent / "ocr2"
TESS = r"C:\Program Files\Tesseract-OCR\tesseract.exe"


def ocr(put: Path) -> str:
    img = cv2.imread(str(put))
    if img is None:
        return ""
    big = cv2.resize(img, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    g = cv2.cvtColor(big, cv2.COLOR_BGR2GRAY)
    tmp = OCR / "_tmp.png"
    cv2.imwrite(str(tmp), g)
    try:
        r = subprocess.run([TESS, str(tmp), "stdout", "-l", "eng", "--psm", "6"],
                           capture_output=True, timeout=180)
        return r.stdout.decode("utf-8", errors="replace")
    except Exception:
        return ""


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
        if izlaz.is_file() and izlaz.stat().st_size > 40:
            txt = izlaz.read_text(encoding="utf-8", errors="replace")
        else:
            txt = ocr(p)
            izlaz.write_text(txt, encoding="utf-8")
        indeks[p.stem] = re.sub(r"[ \t]+", " ", txt).strip()
        if i % 20 == 0:
            print(f"  {i}/{len(kadrovi)}")
    tmp = OCR / "_tmp.png"
    if tmp.is_file():
        tmp.unlink()
    (OCR.parent / "OCR2-INDEKS.json").write_text(
        json.dumps(indeks, ensure_ascii=False, indent=1), encoding="utf-8")
    print("ukupno znakova:", sum(len(v) for v in indeks.values()))


if __name__ == "__main__":
    main()
