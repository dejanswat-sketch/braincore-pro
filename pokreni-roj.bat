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

REM ── ROBOT BRIDGE: HTTP API Knjigovodje (mora biti gore prije workera) ──
echo   [1/3] Robot bridge (Knjigovodja :5055)...
start "robot-bridge" cmd /c "cd /d E:\NMQ-PROGRAMI\knjigovodja && python services\robot_bridge.py"
timeout /t 6 /nobreak >nul

echo   [2/3] Roj (3 cvora)...
start "BRAINCORE-roj" node src\index.js --port 8001 --api-port 8081 --nodes 3
timeout /t 12 /nobreak >nul

echo   [3/3] Knjiga worker...
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
echo   TOK — ROBOT PRIPREMA, MAJA ODOBRAVA:
echo     1. Robot predlozi konto i PDV i faktura ide u "Ceka odobrenje"
echo     2. Otvori Knjigovodja Pro  -^>  tab "Kontrolna soba"
echo     3. Pregledaj fakturu i klikni ODOBRI  (nista se ne knjizi bez toga)
echo     4. Posle odobrenja: izvoz XLSX za BizniSoft
echo     5. U BizniSoftu: U obradi  -^>  F11 Potvrdi
echo.
echo   (Ovaj prozor drzi procese; ne zatvaraj ga dok radis.)
pause
