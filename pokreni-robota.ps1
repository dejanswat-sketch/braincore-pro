# pokreni-robota.ps1 — pouzdano pokretanje robota (bridge + roj + knjiga worker)
#
# ZAŠTO: `pokreni-roj.bat` koristi `start ... cmd /c` i završava sa `pause` —
# prozori se otvore i odmah zatvore, pa procesi padnu. Ova skripta ih drži.
#
# Pokreni:  powershell -NoProfile -ExecutionPolicy Bypass -File E:\NMQ-PROGRAMI\nmq-robot\pokreni-robota.ps1
# Zaustavi: ... -Stop

param([switch]$Stop)

$ErrorActionPreference = 'Continue'
$ROBOT = 'E:\NMQ-PROGRAMI\nmq-robot'
$KNJIGA = 'E:\NMQ-PROGRAMI\knjigovodja'
$NODE = 'C:\Program Files\nodejs\node.exe'
$LOG = "$ROBOT\logs"
New-Item -ItemType Directory -Force -Path $LOG | Out-Null

function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Add-Content "$LOG\robot.log" -Encoding UTF8 }

if ($Stop) {
    Log 'zaustavljam robota (bridge + roj + worker)'
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
        Where-Object { $_.CommandLine -match 'nmq-robot.*(src\\index|knjiga-biznissoft)' } |
        ForEach-Object { Log ("gasim node PID " + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" -EA SilentlyContinue |
        Where-Object { $_.CommandLine -match 'robot_bridge' } |
        ForEach-Object { Log ("gasim python PID " + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
    Log 'zaustavljeno'
    return
}

# okruzenje (Ollama na H: — devstral:24b)
$env:OLLAMA_MODELS = 'H:\AI-MODELI\ollama'
$env:NMQ_EXTERNAL_TYPES = 'knjiga-'
$env:NMQ_RATE_LIMIT_PER_MIN = '600'
$env:NMQ_DATA_DIR = "$ROBOT\data\_maja"
$env:BRAINCORE_API = 'http://127.0.0.1:8081'
$env:BRIDGE_URL = 'http://127.0.0.1:5055'
$env:NMQ_LLM_BASE_URL = 'http://127.0.0.1:11434/v1'
$env:NMQ_LLM_MODEL = 'devstral:24b'
$env:NMQ_LLM_FAST_MODEL = 'gemma3:4b'
$env:NMQ_LLM_API_KEY = 'ollama-local'

function Slusa($p) { [bool](@(Get-NetTCPConnection -State Listen -LocalPort $p -EA SilentlyContinue).Count) }

# ── 1) Robot bridge (Knjigovodja Pro :5055) ──
if (-not (Slusa 5055)) {
    Log 'pokrecem robot bridge (:5055)'
    Start-Process -FilePath 'python' -ArgumentList 'services\robot_bridge.py' -WorkingDirectory $KNJIGA -WindowStyle Hidden `
        -RedirectStandardOutput "$LOG\bridge-out.log" -RedirectStandardError "$LOG\bridge-err.log"
    for ($i = 0; $i -lt 20 -and -not (Slusa 5055); $i++) { Start-Sleep -Seconds 1 }
    Log ("bridge: " + $(if (Slusa 5055) { 'OK' } else { 'NIJE PODIGNUT' }))
} else { Log 'bridge vec radi (:5055)' }

# ── 2) Roj (3 cvora, API :8081) ──
if (-not (Slusa 8081)) {
    Log 'pokrecem roj (3 cvora, :8081)'
    Start-Process -FilePath $NODE -ArgumentList 'src\index.js','--port','8001','--api-port','8081','--nodes','3' -WorkingDirectory $ROBOT -WindowStyle Hidden `
        -RedirectStandardOutput "$LOG\roj-out.log" -RedirectStandardError "$LOG\roj-err.log"
    for ($i = 0; $i -lt 30 -and -not (Slusa 8081); $i++) { Start-Sleep -Seconds 1 }
    Log ("roj: " + $(if (Slusa 8081) { 'OK' } else { 'NIJE PODIGNUT' }))
} else { Log 'roj vec radi (:8081)' }

# ── 2b) GATEWAY :8787 (prima lekcije od nase masine: /v1/feedback) ── dodato 09.10.2026
# Zasto: masina FULL VIDLJIVOST salje dnevne lekcije na http://127.0.0.1:8787/v1/feedback.
# Bez ovoga je pisalo "nije poslano" (ruta je postojala, ali gateway nije bio podignut).
if (-not (Slusa 8787)) {
    Log 'pokrecem gateway (:8787)'
    Start-Process -FilePath $NODE -ArgumentList 'scripts\serve.mjs' -WorkingDirectory $ROBOT -WindowStyle Hidden `
        -RedirectStandardOutput "$LOG\serve-out.log" -RedirectStandardError "$LOG\serve-err.log"
    for ($i = 0; $i -lt 20 -and -not (Slusa 8787); $i++) { Start-Sleep -Seconds 1 }
    Log ("gateway: " + $(if (Slusa 8787) { 'OK' } else { 'NIJE PODIGNUT' }))
} else { Log 'gateway vec radi (:8787)' }

# ── 3) Knjiga worker (veza roj <-> knjigovodja) ──
$radi = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
    Where-Object { $_.CommandLine -match 'knjiga-biznissoft' }
if (-not $radi) {
    Log 'pokrecem knjiga worker'
    Start-Process -FilePath $NODE -ArgumentList 'workers\knjiga-biznissoft.js' -WorkingDirectory $ROBOT -WindowStyle Hidden `
        -RedirectStandardOutput "$LOG\worker-out.log" -RedirectStandardError "$LOG\worker-err.log"
    Start-Sleep -Seconds 6
} else { Log 'worker vec radi' }

# ── 4) Ruter worker (specijalizovani modeli po tipu zadatka) ──
$rw = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -match 'ruter-worker' }
if (-not $rw) {
  Log 'pokrecem ruter worker (ai-* zadaci -> specijalizovani modeli)'
  Start-Process -FilePath $NODE -ArgumentList 'workers\ruter-worker.js' -WorkingDirectory $ROBOT -WindowStyle Hidden `
    -RedirectStandardOutput "$LOG\ruter-worker-out.log" -RedirectStandardError "$LOG\ruter-worker-err.log"
  Start-Sleep -Seconds 4
} else { Log 'ruter worker vec radi' }

# ── rezultat ──
$b = Slusa 5055; $r = Slusa 8081
Log ("STANJE: bridge=" + $b + " roj=" + $r)
Write-Host ""
Write-Host "  ROBOT:" -ForegroundColor Cyan
Write-Host ("    bridge (Knjigovodja :5055)  " + $(if ($b) { 'RADI' } else { 'NE RADI' }))
Write-Host ("    roj    (3 cvora :8081)      " + $(if ($r) { 'RADI' } else { 'NE RADI' }))
Write-Host ("    model: devstral:24b (lokalna kartica, `$0)")
Write-Host ("    logovi: $LOG")
Write-Host ""

# VAZNO: Start-Process sa -RedirectStandardOutput ostavlja handle otvoren,
# pa PowerShell ume da ceka u nedogled iako su svi procesi pokrenuti.
# Zato eksplicitno izlazimo (04.10.2026).
exit 0
