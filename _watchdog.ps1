# Keeps CarbonBoard alive. It is not just the soundboard any more: with the
# virtual cable pinned as the Windows default microphone, Discord is listening to
# a cable that ONLY CarbonBoard feeds. If it dies, the mic goes silent rather
# than falling back to a real one - so this has to be watched, not assumed.
#
# Every run logs one line, so "did the watchdog even run at logon" is answerable
# from the log (2026-09-16: CarbonBoard did not come up at logon and the log had
# no way of saying whether the watchdog had looked).
$log = "$env:APPDATA\carbonboard\carbonboard-data\watchdog.log"
$exe = "$env:LOCALAPPDATA\Programs\CarbonBoard\CarbonBoard.exe"
# Start a process that must OUTLIVE this script. Both watchdog tasks run under
# CortexHiddenRun.exe, whose job object has KILL_ON_JOB_CLOSE and no breakaway:
# a Start-Process child dies the instant the script exits. 2026-09-19 13:45-13:50
# CarbonBoard was "restarted" nine times and lived under a minute each time (no
# quit line in main.log = hard kill) until nothing was feeding the cable at all.
# Win32_Process.Create runs in the WMI host -- outside the job, same session.
function Start-Detached([string]$File, [string]$Arguments = '') {
  $cmd = ('"{0}" {1}' -f $File, $Arguments).Trim()
  try {
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd } -ErrorAction Stop
    if ($r.ReturnValue -eq 0) { return }
  } catch { }
  # Fallback: explorer is outside the job too.
  Start-Process explorer.exe -ArgumentList $cmd
}
$p = Get-Process CarbonBoard -ErrorAction SilentlyContinue
if (-not $p) {
  Start-Detached $exe "--minimized"
  Add-Content -Path $log -Value ("{0}  restarted CarbonBoard (session {1})" -f (Get-Date -Format s), (Get-Process -Id $PID).SessionId)
} else {
  Add-Content -Path $log -Value ("{0}  ok  pid={1} since {2}" -f (Get-Date -Format s), ($p | Select-Object -First 1).Id, ($p | Sort-Object StartTime | Select-Object -First 1).StartTime.ToString('s'))
}
