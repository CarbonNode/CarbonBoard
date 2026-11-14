# Deploy CarbonBoard on MAINGAMINGRIG at an exact commit: build, swap the installed app's
# resources, start it again, prove it is up, roll back if it is not.
#
# Run by Conduit's `deploy { project: "CarbonBoard" }` (deploy.conduit.json), which fast-forwards
# this checkout to the ref first and runs this from an interactive one-shot task, i.e. as the
# signed-in user in the desktop session -- the session CarbonBoard has to live in.
#
# Why swap app.asar instead of running the NSIS installer: the installer has to run in the user's
# session through the launcher, re-registers shortcuts, and leaves nothing to roll back to. The
# swap keeps resources\app.asar.previous (+ app.asar.unpacked.previous) and restores it when the
# new build does not come up.
param([Parameter(Mandatory = $true)][string]$Ref)
# Continue, not Stop: under Windows PowerShell 5.1 a native tool's stderr line (npm prints its
# warnings there) becomes an error record, and Stop would end the deploy on a warning. Exit codes
# decide instead, and the cmdlets that must not fail quietly say -ErrorAction Stop themselves.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Straight to the console, never the pipeline: a function that calls Say must still return only
# its own value (Install-From returning @("...", $false) would read as success).
function Say($m) { [Console]::Out.WriteLine(("{0}  {1}" -f (Get-Date -Format s), $m)) }
function Fail($m) { Say "CARBONBOARD_DEPLOY_FAIL $m"; exit 1 }

# Start a process that must outlive this task (whatever job object the runner uses): the WMI
# host starts it outside any job, same session. Same as _watchdog.ps1.
function Start-Detached([string]$File, [string]$Arguments = '') {
  $cmd = ('"{0}" {1}' -f $File, $Arguments).Trim()
  try {
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd } -ErrorAction Stop
    if ($r.ReturnValue -eq 0) { return }
  } catch { }
  Start-Process explorer.exe -ArgumentList $cmd
}

# ── 1. the tree is exactly the ref ──────────────────────────────────────────
$head = (& git rev-parse HEAD).Trim()
if ($head -notlike "$Ref*" -and $Ref -notlike "$head*") { Fail "checkout is at $head, not $Ref" }
$dirty = @(& git status --porcelain --untracked-files=no)
if ($dirty.Count) { Fail ("tracked files differ from the commit: " + ($dirty -join '; ')) }
Say "building $head"

# ── 2. build (nothing installed is touched until this passes) ────────────────
$t0 = Get-Date
& npm.cmd run build 2>&1 | Select-Object -Last 15 | ForEach-Object { Say "  build: $_" }
if ($LASTEXITCODE -ne 0) { Fail 'npm run build failed' }
& npx.cmd electron-builder --win --dir 2>&1 | Select-Object -Last 8 | ForEach-Object { Say "  pack: $_" }
if ($LASTEXITCODE -ne 0) { Fail 'electron-builder failed' }
$built = Join-Path $root 'dist\win-unpacked\resources'
$asar = Join-Path $built 'app.asar'
if (-not (Test-Path $asar) -or (Get-Item $asar).LastWriteTime -lt $t0) { Fail 'no fresh app.asar in dist\win-unpacked' }
$newHash = (Get-FileHash $asar -Algorithm SHA256).Hash

# ── 3. find the installed app ────────────────────────────────────────────────
$running = Get-Process CarbonBoard -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1
$exe = if ($running) { $running.Path } else { Join-Path $env:LOCALAPPDATA 'Programs\carbonboard\CarbonBoard.exe' }
if (-not (Test-Path $exe)) { Fail "CarbonBoard is not installed at $exe" }
$res = Join-Path (Split-Path -Parent $exe) 'resources'
$mainLog = Join-Path $env:APPDATA 'carbonboard\carbonboard-data\main.log'

function Stop-Board {
  Get-Process CarbonBoard -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 40 -and (Get-Process CarbonBoard -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }
}

# The watchdog (every minute) and micwatch restart a missing CarbonBoard, so one of them can grab
# app.asar between the stop and the copy. Stop and copy again until the copy lands.
function Install-From([string]$fromAsar, [string]$fromUnpacked) {
  for ($try = 1; $try -le 5; $try++) {
    Stop-Board
    try {
      Copy-Item $fromAsar (Join-Path $res 'app.asar') -Force -ErrorAction Stop
      if (Test-Path $fromUnpacked) {
        & robocopy $fromUnpacked (Join-Path $res 'app.asar.unpacked') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy exit $LASTEXITCODE" }
      }
      return $true
    } catch { Say "  copy attempt $try failed: $($_.Exception.Message)"; Start-Sleep -Seconds 1 }
  }
  return $false
}

function Wait-Up([datetime]$since) {
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Get-Process CarbonBoard -ErrorAction SilentlyContinue)) { continue }
    $ready = $false
    if (Test-Path $mainLog) {
      $ready = [bool](Get-Content $mainLog -Tail 20 | Where-Object {
        $_ -match '^(\S+)\s+ready' -and ([datetime]$Matches[1]).ToUniversalTime() -ge $since.ToUniversalTime().AddSeconds(-2)
      })
    }
    $http = $false
    try { Invoke-WebRequest 'http://127.0.0.1:9502/' -UseBasicParsing -TimeoutSec 2 | Out-Null; $http = $true }
    catch { if ($_.Exception.Response) { $http = $true } }  # any HTTP answer, a 404 included, is the API up
    if ($ready -and $http) { return $true }
  }
  return $false
}

# ── 4. keep the current install, swap, start ─────────────────────────────────
Copy-Item (Join-Path $res 'app.asar') (Join-Path $res 'app.asar.previous') -Force -ErrorAction Stop
if (Test-Path (Join-Path $res 'app.asar.unpacked')) {
  & robocopy (Join-Path $res 'app.asar.unpacked') (Join-Path $res 'app.asar.unpacked.previous') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
}
Say "installing into $res"
if (-not (Install-From $asar (Join-Path $built 'app.asar.unpacked'))) {
  Start-Detached $exe '--minimized'
  Fail 'could not replace app.asar (still locked); the previous build is untouched'
}
$started = Get-Date
Start-Detached $exe '--minimized'
$liveHash = (Get-FileHash (Join-Path $res 'app.asar') -Algorithm SHA256).Hash
if ($liveHash -ne $newHash) { Fail "installed app.asar $liveHash is not the build $newHash" }

if (Wait-Up $started) {
  Say "CARBONBOARD_DEPLOY_OK $head (app.asar $($newHash.Substring(0,12)), up and answering on :9502)"
  exit 0
}

# ── 5. it did not come up: put the previous build back ───────────────────────
Say 'new build did not report ready within 60 s; rolling back'
$restored = Install-From (Join-Path $res 'app.asar.previous') (Join-Path $res 'app.asar.unpacked.previous')
$back = Get-Date
Start-Detached $exe '--minimized'
$prevUp = $restored -and (Wait-Up $back)
Fail ("new build never became ready; previous build " + $(if ($prevUp) { 'restored and running' } else { 'restore FAILED - CarbonBoard may be down' }))
