# The entry the Conduit recipe (Carbon Cortex deploy.conduit.json, cortex-console prod-carbonboard)
# embeds VERBATIM as base64 and launches in the desktop session through launcher-MAINGAMINGRIG__launch.
# It must not depend on the checkout being at the ref yet: it fast-forwards first, then runs that
# commit's scripts/deploy.ps1, and records one verdict line the recipe's poll reads:
#   C:\ProgramData\CarbonBoardDeploy\deploy-status.txt   CARBONBOARD_DEPLOY_OK|FAIL <sha> run=<key> ...
#   C:\ProgramData\CarbonBoardDeploy\deploy-<sha>.log     everything git and deploy.ps1 printed
# Change this file and the recipe's base64 together (regenerate with: base64 -w0 scripts/deploy-entry.ps1).
param([string]$Ref, [string]$RunKey)
$ErrorActionPreference = 'Continue'
$dir = 'C:\ProgramData\CarbonBoardDeploy'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir "deploy-$Ref.log"
$status = Join-Path $dir 'deploy-status.txt'
function Done([string]$verdict, [string]$why) {
  Add-Content -Path $status -Value ('{0} {1} run={2} {3} {4}' -f $verdict, $Ref, $RunKey, (Get-Date -Format s), $why)
}
if ($Ref -notmatch '^[0-9a-f]{40}$') { Done 'CARBONBOARD_DEPLOY_FAIL' 'ref must be a full 40-character sha'; exit 1 }
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
Set-Location 'C:\Programming\CarbonBoard'
& git fetch --quiet origin *>> $log
& git merge --ff-only $Ref *>> $log
if ($LASTEXITCODE -ne 0) { Done 'CARBONBOARD_DEPLOY_FAIL' 'git could not fast-forward to the ref (see the log)'; exit 1 }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 -Ref $Ref *>> $log
$code = $LASTEXITCODE
$last = (Get-Content $log -Tail 60 | Select-String 'CARBONBOARD_DEPLOY_(OK|FAIL)' | Select-Object -Last 1).Line
if ($code -eq 0) { Done 'CARBONBOARD_DEPLOY_OK' "$last" } else { Done 'CARBONBOARD_DEPLOY_FAIL' "exit $code $last" }
exit $code
