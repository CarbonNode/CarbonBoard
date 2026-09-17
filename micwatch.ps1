# CarbonBoard mic watchdog.
#
# The soundboard carries the microphone into Discord through a virtual cable.
# When that chain breaks it breaks SILENTLY -- the app still reports a healthy
# mic while actually holding the wrong device open, which is exactly how a
# lapel mic got captured for an unknown length of time while the headset sat
# unused and nobody could hear anything.
#
# So this does not ask the app how it is doing. It reads the Windows audio
# sessions -- ground truth for who has which endpoint open -- and compares them
# against the profile the app says is active. On a mismatch it re-applies the
# profile, which restarts the passthrough and shows a toast on the desktop.
#
# MUST run in the interactive session: session 0 sees no audio sessions at all.

$root = 'C:\Programming\CarbonBoard'
$log  = Join-Path $root 'micwatch.log'
$api  = 'http://127.0.0.1:9502'

function Write-Log($msg) {
  Add-Content -Path $log -Value ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
}

# Windows renumbers a duplicated endpoint inside its name ("3- Astro A50") and
# Chromium appends a USB id; neither means a different device.
function Norm($s) {
  if (-not $s) { return '' }
  $t = $s.ToLower()
  $t = [regex]::Replace($t, '\b\d+-\s*', '')
  $t = [regex]::Replace($t, '\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*', ' ')
  $t = [regex]::Replace($t, '\s+', ' ')
  return $t.Trim()
}

function Get-Sessions {
  $out = & (Join-Path $root '_who2.ps1') 2>$null
  $section = ''
  $rows = @()
  foreach ($l in $out) {
    $line = [string]$l
    if ($line -match 'CAPTURE sessions') { $section = 'capture'; continue }
    if ($line -match 'RENDER sessions')  { $section = 'render';  continue }
    if ($line -match '^(.*?)\s+<--\s+PID\s+(\d+)\s+(\w+)\s+=\s+(.*)$') {
      $rows += [pscustomobject]@{
        kind = $section
        dev  = $Matches[1].Trim()
        proc = $Matches[4].Trim()
      }
    }
  }
  return $rows
}

function Test-Chain($wantMic) {
  $rows  = Get-Sessions
  $cbCap = @($rows | Where-Object { $_.kind -eq 'capture' -and $_.proc -match 'CarbonBoard' })
  $cbRen = @($rows | Where-Object { $_.kind -eq 'render'  -and $_.proc -match 'CarbonBoard' })
  $bad = @()

  if ($cbCap.Count -eq 0) {
    $bad += 'no microphone open at all'
  } elseif ($cbCap.Count -gt 1) {
    $bad += ('{0} microphones open at once: {1}' -f $cbCap.Count, (($cbCap | ForEach-Object { $_.dev }) -join ' | '))
  } else {
    $got = $cbCap[0].dev
    if ((Norm $got) -match 'cable output|vb-audio') {
      $bad += 'capturing the virtual cable -- that is a feedback loop'
    } elseif ($wantMic -and (Norm $got) -ne (Norm $wantMic)) {
      $bad += ("wrong microphone: has '{0}' open, profile wants '{1}'" -f $got, $wantMic)
    }
  }

  if (-not ($cbRen | Where-Object { (Norm $_.dev) -match 'cable input' })) {
    $bad += 'not feeding CABLE Input, so Discord receives nothing'
  }

  return [pscustomobject]@{ problems = $bad; mic = $(if ($cbCap.Count -ge 1) { $cbCap[0].dev } else { '(none)' }) }
}

try {
  $status = (Invoke-WebRequest -UseBasicParsing "$api/api/audio/status" -TimeoutSec 8).Content | ConvertFrom-Json
} catch {
  # Not answering usually means not RUNNING -- and this script runs in the
  # interactive session, so it can start the app itself instead of telling a
  # human to. 2026-09-16: after a reinstall CarbonBoard did not come up at
  # logon; this branch popped "your Discord mic is dead" at boot+2min and
  # then did nothing, and Rober had to open it by hand. Start it, wait for the
  # API, and only speak up if that fails too. Electron's single-instance lock
  # makes a duplicate launch harmless (it hands off and exits).
  Write-Log ('DOWN    CarbonBoard is not answering on :9502 -- {0}' -f $_.Exception.Message)
  $exe = Join-Path $env:LOCALAPPDATA 'Programs\carbonboard\CarbonBoard.exe'
  if (Test-Path $exe) {
    if (-not (Get-Process CarbonBoard -ErrorAction SilentlyContinue)) {
      Write-Log 'start   CarbonBoard is not running -- starting it'
      Start-Process $exe -ArgumentList '--minimized'
    } else {
      Write-Log 'restart CarbonBoard is running but not answering -- restarting it'
      Get-Process CarbonBoard -ErrorAction SilentlyContinue | Stop-Process -Force
      Start-Sleep -Seconds 3
      Start-Process $exe -ArgumentList '--minimized'
    }
    $up = $false
    for ($i = 0; $i -lt 12 -and -not $up; $i++) {
      Start-Sleep -Seconds 5
      try { Invoke-WebRequest -UseBasicParsing "$api/api/audio/status" -TimeoutSec 5 | Out-Null; $up = $true } catch { }
    }
    if ($up) { Write-Log 'started CarbonBoard is answering again'; exit 0 }
  }
  & "$env:SystemRoot\System32\msg.exe" * "CarbonBoard is not running and could not be started - your Discord mic is dead." 2>$null
  exit 1
}

$profileName = $status.active
$wantMic     = $status.captureMic
$chain       = $status.chain

# The app's own signal-through watch (electron/chain-watch.ts) meters the cable
# and re-opens the feed when signal is expected and none arrives. This outer
# guard only escalates when THAT has given up: the feed has been judged dead
# for a while and the in-app heals did not bring it back. Sessions can look
# perfect while the cable is silent -- 2026-09-15 -- so this line is the one to
# read when someone says "nobody could hear me".
$chainNote = ''
$stuck = $false
if ($chain) {
  $chainNote = ('  cable={0} dead={1} relaunches={2} capture={3}' -f $(if ($chain.meterAlive) { 'metered' } else { 'NO-METER' }), $chain.deadEvents, $chain.relaunches, $(if ($chain.captureSilentForMs -gt 0) { ('SILENT-{0}s' -f [int]($chain.captureSilentForMs / 1000)) } else { 'signal' }))
  if ($chain.stuckForMs -gt 90000) {
    Write-Log ("STUCK   profile={0}  feed dead for {1}s despite the app's own heals{2}" -f $profileName, [int]($chain.stuckForMs / 1000), $chainNote)
    $stuck = $true
  }
}

# A deliberate mute is not a fault. Do not heal the user back on-air.
try {
  $settings = (Invoke-WebRequest -UseBasicParsing "$api/api/settings" -TimeoutSec 8).Content | ConvertFrom-Json
  if (-not $settings.micPassthroughEnabled) { Write-Log "idle    passthrough is switched off on purpose, leaving it alone"; exit 0 }
} catch { }

$check = Test-Chain $wantMic
if ($check.problems.Count -eq 0 -and -not $stuck) {
  Write-Log ("ok      profile={0}  mic={1}{2}" -f $profileName, $check.mic, $chainNote)
  exit 0
}
if ($stuck) { $check.problems += 'cable silent while signal expected, in-app heals exhausted' }

Write-Log ("BROKEN  profile={0}  {1}" -f $profileName, ($check.problems -join '; '))

# Heal by re-applying the active profile: that re-resolves the mic by name,
# restarts the passthrough, and toasts on the desktop so it is not silent.
try {
  $body = @{ profile = $profileName } | ConvertTo-Json -Compress
  Invoke-WebRequest -UseBasicParsing -Method POST -Uri "$api/api/audio/profile" `
    -Body $body -ContentType 'application/json' -TimeoutSec 25 | Out-Null
  # Re-applying the SAME profile does not restart the passthrough (same label,
  # nothing to change), and a dead output sink is only rebuilt by a re-open.
  Invoke-WebRequest -UseBasicParsing -Method POST -Uri "$api/api/audio/passthrough/restart" `
    -TimeoutSec 15 | Out-Null
  Write-Log ("heal    re-applied profile '{0}' and re-opened the passthrough" -f $profileName)
} catch {
  Write-Log ('heal    FAILED -- {0}' -f $_.Exception.Message)
}

Start-Sleep -Seconds 8

$after = Test-Chain $wantMic
if ($after.problems.Count -eq 0) {
  Write-Log ("healed  profile={0}  mic={1}" -f $profileName, $after.mic)
  exit 0
}

Write-Log ("STILL BROKEN  {0}" -f ($after.problems -join '; '))

# Re-applying the profile cannot close a capture stream the app has lost the
# handle to. That orphan lives in Chromium's audio service and outlives every
# heal, so the old behaviour was to pop a message box every five minutes and
# wait for a human to restart the app. Restart it here instead -- that is the
# only thing that clears an orphaned stream -- and only speak up if even that
# does not fix it.
$stamp = Join-Path $root 'micwatch.restart'
$last  = if (Test-Path $stamp) { (Get-Item $stamp).LastWriteTime } else { [datetime]::MinValue }
$exe   = Join-Path $env:LOCALAPPDATA 'Programs\carbonboard\CarbonBoard.exe'

# The cooldown stops a genuinely broken machine being restarted every five
# minutes forever; past it, telling the human is the right escalation.
if ((Test-Path $exe) -and ((Get-Date) - $last).TotalMinutes -ge 30) {
  Set-Content -Path $stamp -Value (Get-Date -Format 's')
  Write-Log 'restart  self-heal failed, restarting CarbonBoard'
  Get-Process CarbonBoard -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 3
  Start-Process $exe
  # Boot, enumerate the devices, re-apply the saved profile, open the mic.
  Start-Sleep -Seconds 30

  try {
    $status2     = (Invoke-WebRequest -UseBasicParsing "$api/api/audio/status" -TimeoutSec 8).Content | ConvertFrom-Json
    $profileName = $status2.active
    $wantMic     = $status2.captureMic
  } catch { }

  $final = Test-Chain $wantMic
  if ($final.problems.Count -eq 0) {
    Write-Log ("restarted  profile={0}  mic={1}" -f $profileName, $final.mic)
    exit 0
  }
  Write-Log ("STILL BROKEN AFTER RESTART  {0}" -f ($final.problems -join '; '))
  & "$env:SystemRoot\System32\msg.exe" * ("Mic chain broken, restarting CarbonBoard did not fix it: " + ($final.problems -join '; ')) 2>$null
  exit 2
}

& "$env:SystemRoot\System32\msg.exe" * ("Mic chain broken and self-heal failed: " + ($after.problems -join '; ')) 2>$null
exit 2
