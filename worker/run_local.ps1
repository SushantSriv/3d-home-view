<#
.SYNOPSIS
    Run the stitching worker on this machine until you stop it.

.DESCRIPTION
    Polls the Supabase queue and stitches any room video the studio has uploaded.
    Leave it running in a terminal while you build a tour.

.EXAMPLE
    ./worker/run_local.ps1
    ./worker/run_local.ps1 -Once            # drain the queue and exit
    ./worker/run_local.ps1 -Interval 30
#>
[CmdletBinding()]
param(
    [switch]$Once,
    [int]$Interval = 15,
    [switch]$KeepSource
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$python = Join-Path $repo '.venv/Scripts/python.exe'

if (-not (Test-Path $python)) {
    Write-Host "No virtualenv found. Run ./scripts/bootstrap.ps1 first." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $repo '.env'))) {
    Write-Host "No .env found. Copy .env.example and add your service key (see supabase/README.md)." -ForegroundColor Red
    exit 1
}

$argsList = @((Join-Path $repo 'worker/worker.py'))
if ($Once) { $argsList += '--once' } else { $argsList += @('--loop', '--interval', $Interval) }
if ($KeepSource) { $argsList += '--keep-source' }

& $python @argsList
exit $LASTEXITCODE
