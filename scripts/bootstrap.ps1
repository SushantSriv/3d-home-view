<#
.SYNOPSIS
    One-time setup for the stitching side of the project, plus an environment doctor.

.DESCRIPTION
    Checks your tooling, fetches the upstream stitching pipeline submodule, creates
    a virtualenv in .venv and installs the Python dependencies. Safe to re-run.

.EXAMPLE
    ./scripts/bootstrap.ps1
    ./scripts/bootstrap.ps1 -CheckOnly     # report only, change nothing
#>
[CmdletBinding()]
param(
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $repo '.venv'
$problems = @()

function Say($msg, $kind = 'info') {
    $c = @{ info = 'Gray'; ok = 'Green'; warn = 'Yellow'; bad = 'Red'; head = 'Cyan' }[$kind]
    $p = @{ info = '   '; ok = ' OK  '; warn = 'WARN '; bad = 'FAIL '; head = '' }[$kind]
    Write-Host "$p$msg" -ForegroundColor $c
}

Say "360 Home Tour - bootstrap" head
Say ("=" * 46) head

# ---------------------------------------------------------------- python ---

# The Microsoft Store ships a `python.exe` stub on PATH that is not an interpreter.
# It prints an advert and exits 9009, so probe by actually asking for a version.
$python = $null
foreach ($cand in @('python', 'python3', 'py -3.12', 'py -3')) {
    try {
        $parts = $cand -split ' '
        $out = & $parts[0] @($parts[1..($parts.Length - 1)] + '--version') 2>&1 | Out-String
        if ($out -match 'Python (\d+)\.(\d+)\.(\d+)') {
            $major = [int]$Matches[1]; $minor = [int]$Matches[2]
            if ($major -eq 3 -and $minor -ge 10) {
                $python = $cand
                Say "Python $($Matches[0]) via '$cand'" ok
                if ($minor -lt 12) { Say "Upstream targets Python 3.12; $major.$minor should work but is untested." warn }
                break
            }
        }
    } catch { }
}

if (-not $python) {
    Say "No usable Python found." bad
    Say "Install Python 3.12 from https://www.python.org/downloads/ and tick 'Add python.exe to PATH'." info
    Say "The 'python' currently on your PATH is the Microsoft Store stub, which is not an interpreter." info
    $problems += 'python'
}

# ------------------------------------------------------------------- git ---

try {
    $null = git --version
    Say "git $((git --version) -replace 'git version ','')" ok
} catch {
    Say "git not found." bad
    $problems += 'git'
}

# ------------------------------------------------------------- submodule ---

$upstream = Join-Path $repo 'third_party/360-spherical-stitching'
if (Test-Path (Join-Path $upstream 'run.py')) {
    Say "Stitching pipeline present." ok
} elseif ($CheckOnly) {
    Say "Stitching pipeline not fetched yet." warn
} else {
    Say "Fetching the stitching pipeline submodule..." info
    Push-Location $repo
    try {
        git submodule update --init --recursive
        if (Test-Path (Join-Path $upstream 'run.py')) { Say "Stitching pipeline fetched." ok }
        else { Say "Submodule did not materialise - check network access to github.com." bad; $problems += 'submodule' }
    } finally { Pop-Location }
}

# ----------------------------------------------------------------- venv ---

if ($python -and -not $CheckOnly) {
    if (-not (Test-Path $venv)) {
        Say "Creating virtualenv in .venv ..." info
        $parts = $python -split ' '
        & $parts[0] @($parts[1..($parts.Length - 1)] + @('-m', 'venv', $venv))
    }

    $pip = Join-Path $venv 'Scripts/python.exe'
    if (Test-Path $pip) {
        Say "Installing Python dependencies (this takes a minute the first time)..." info
        & $pip -m pip install --upgrade pip --quiet
        & $pip -m pip install -r (Join-Path $repo 'worker/requirements.txt') --quiet
        if ($LASTEXITCODE -eq 0) { Say "Dependencies installed." ok }
        else { Say "pip install failed - see the output above." bad; $problems += 'pip' }
    } else {
        Say "Virtualenv looks broken; delete .venv and re-run." bad
        $problems += 'venv'
    }
} elseif (Test-Path (Join-Path $venv 'Scripts/python.exe')) {
    Say "Virtualenv present." ok
} else {
    Say "No virtualenv yet." warn
}

# ------------------------------------------------------------------ env ---

if (Test-Path (Join-Path $repo '.env')) {
    $envText = Get-Content (Join-Path $repo '.env') -Raw
    if ($envText -match 'SUPABASE_SERVICE_KEY=\s*\S') { Say ".env has a service key." ok }
    else { Say ".env exists but SUPABASE_SERVICE_KEY is empty." warn; $problems += 'env' }
} else {
    Say "No .env yet - the worker needs one. Copy .env.example and fill it in (see supabase/README.md)." warn
    $problems += 'env'
}

# --------------------------------------------------------------- ffmpeg ---

if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { Say "ffmpeg present." ok }
else { Say "ffmpeg not installed. Optional - OpenCV decodes MP4 and MOV on its own." info }

# --------------------------------------------------------------- summary ---

Write-Host ''
Say ("=" * 46) head
if ($problems.Count -eq 0) {
    Say "Everything is ready." ok
    Write-Host ''
    Say "Try a stitch:" head
    Say "  .venv\Scripts\python.exe stitcher\stitch_room.py --video <clip.mp4> --out out\test" info
    Say "Or start the worker:" head
    Say "  .\worker\run_local.ps1" info
} else {
    Say "Outstanding: $($problems -join ', ')" warn
    Say "See PROGRESS.md section 3 for what to do about each." info
}
Write-Host ''
