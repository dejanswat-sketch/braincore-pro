@echo off
chcp 65001 >nul
title BRAINCORE PRO — roj za Maju (BizniSoft veza)
cd /d "%~dp0"

echo.
echo  ======================================================
echo   BRAINCORE PRO — pokrecem roj (3 cvora) + knjiga worker
echo  ======================================================
echo.

REM ── TAČNA LINIJA (poznata zamka: NMQ_EXTERNAL_TYPES MORA biti ispred) ──
set NMQ_EXTERNAL_TYPES=knjiga-
set NMQ_RATE_LIMIT_PER_MIN=600
set NMQ_DATA_DIR=%~dp0data\_maja

REM ── worker vuce taskove SA lokalnog roja i pise u Knjigovodja Pro (5055) ──
set BRAINCORE_API=http://127.0.0.1:8081
set BRIDGE_URL=http://127.0.0.1:5055

start "BRAINCORE-roj" node src\index.js --port 8001 --api-port 8081 --nodes 3
timeout /t 12 /nobreak >nul

start "knjiga-worker" node workers\knjiga-biznissoft.js

echo.
echo  ======================================================
echo   Roj je gore:   http://127.0.0.1:8081  (3 cvora)
echo   Worker:        knjiga-biznissoft (prati knjiga-* taskove)
echo   Bridge:        Knjigovodja Pro na 127.0.0.1:5055
echo   Ulaz:          E:\knjige\ulaz\
echo   Za provjeru:    E:\knjige\za-proveru\
echo  ======================================================
echo.
echo   Sada u BizniSoftu:
echo     Upravljanje eFakturama -> Kreiranje ulaznih kalkulacija
echo     na osnovu primljenih eFaktura -> vidi "U obradi" -> F11 Potvrdi
echo.
echo   (Ovaj prozor drzi procese; ne zatvaraj ga dok radis.)
pause
