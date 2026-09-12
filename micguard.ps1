# ROG Cetra mic guard -- MAINGAMINGRIG
#
# The ROG Cetra True Wireless SpeedNova carries playback and microphone over
# ONE 2.4GHz link, and the buds drop that link to a mono narrowband telephony
# profile the moment ANYTHING opens their microphone. Playback then sounds
# tinny and robotic until the mic is released. Muting does not help: a muted
# stream is still an open stream.
#
# That microphone is never wanted on this rig. With the Cetras in, capture is
# the Insta360 lapel (CarbonBoard's "In Ear" profile), so the cure is to keep
# the Cetra CAPTURE endpoint disabled and let nothing open it.
#
# Why this is a watchdog and not a one-time click: Windows stores the disabled
# flag per DEVICE INSTANCE, and the instance path contains the USB port the
# dongle is in. Plug the dongle into a different port and Windows enumerates a
# brand-new, ENABLED endpoint -- and the tinny audio is back. So this re-applies
# it every minute, whatever port the dongle lands in.
#
# SAFETY: this only ever touches capture endpoints. Under SWD\MMDEVAPI a render
# (playback) endpoint is {0.0.0.*} and a capture endpoint is {0.0.1.*}. A target
# must match {0.0.1.*} AND a name pattern below, so the guard cannot disable the
# headphones themselves -- the worst a bad pattern can do is mute a microphone.
#
# Quiet by design: it logs only when it acts or fails. The scheduled task's
# "Last Run Time" is the proof it is alive; a heartbeat every minute would bury
# the lines that matter.

$log = 'C:\Programming\CarbonBoard\micguard.log'

# Devices whose OWN microphone must never be opened. One pattern per device.
$blocked = @('*ROG CETRA*', '*SPEEDNOVA*')

function Write-Log($m) {
  Add-Content -Path $log -Value ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}

$all = Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue
if (-not $all) { Write-Log 'ERROR   could not enumerate audio endpoints'; exit 1 }

$targets = foreach ($d in $all) {
  if ($d.InstanceId -notlike 'SWD\MMDEVAPI\{0.0.1.*') { continue }   # capture only
  $hit = $false
  foreach ($p in $blocked) { if ($d.FriendlyName -like $p) { $hit = $true } }
  if ($hit) { $d }
}

# Dongle unplugged, or the endpoint has not been enumerated: nothing to do.
if (-not $targets) { exit 0 }

$failed = 0
foreach ($d in $targets) {
  # CM_PROB_DISABLED = 22. Already disabled is the steady state: say nothing.
  $pc = $null
  try {
    $pc = (Get-PnpDeviceProperty -InstanceId $d.InstanceId `
             -KeyName 'DEVPKEY_Device_ProblemCode' -ErrorAction Stop).Data
  } catch { }
  if ($pc -eq 22) { continue }

  try {
    Disable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false -ErrorAction Stop
    Write-Log ('disabled  {0}   [{1}]' -f $d.FriendlyName, $d.InstanceId)
  } catch {
    $failed++
    Write-Log ('FAILED    {0}   [{1}] -- {2}' -f $d.FriendlyName, $d.InstanceId, $_.Exception.Message)
  }
}

if ($failed -gt 0) { exit 2 }
exit 0
