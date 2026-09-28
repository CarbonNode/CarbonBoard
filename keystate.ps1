# keystate.ps1 -- report which modifier keys Windows believes are held, and
# optionally force them up. Interactive session only: GetAsyncKeyState in
# session 0 reads session 0's desktop and always says "up".
#   -Release   send a KEYUP for every modifier (clears a latched Ctrl/Alt/Shift/Win)
param([switch]$Release)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class KS {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern short GetKeyState(int vKey);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  public static void Up(byte vk){ keybd_event(vk,0,0x0002,IntPtr.Zero); }
}
"@
$keys = [ordered]@{
  'VK_CONTROL(0x11)' = 0x11; 'VK_LCONTROL(0xA2)' = 0xA2; 'VK_RCONTROL(0xA3)' = 0xA3
  'VK_SHIFT(0x10)'   = 0x10; 'VK_LSHIFT(0xA0)'   = 0xA0; 'VK_RSHIFT(0xA1)'   = 0xA1
  'VK_MENU(0x12)'    = 0x12; 'VK_LMENU(0xA4)'    = 0xA4; 'VK_RMENU(0xA5)'    = 0xA5
  'VK_LWIN(0x5B)'    = 0x5B; 'VK_RWIN(0x5C)'     = 0x5C
  'VK_CAPITAL(0x14)' = 0x14; 'VK_NUMLOCK(0x90)'  = 0x90; 'VK_SCROLL(0x91)'   = 0x91
}
$out = 'C:\Programming\CarbonBoard\_keystate.txt'
$lines = @('=== ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' session ' + (Get-Process -Id $PID).SessionId + ($(if ($Release) { ' RELEASE' } else { ' report' })))
foreach ($k in $keys.Keys) {
  $vk = $keys[$k]
  $a = [KS]::GetAsyncKeyState($vk); $s = [KS]::GetKeyState($vk)
  $downA = (($a -band 0x8000) -ne 0); $downS = (($s -band 0x8000) -ne 0); $toggled = (($s -band 1) -ne 0)
  $lines += ('{0,-20} async={1,-6} sync={2,-6} toggled={3,-6} raw(async)=0x{4:X4} raw(sync)=0x{5:X4}' -f $k, $downA, $downS, $toggled, ($a -band 0xFFFF), ($s -band 0xFFFF))
}
if ($Release) {
  foreach ($vk in 0x11,0xA2,0xA3,0x10,0xA0,0xA1,0x12,0xA4,0xA5,0x5B,0x5C) { [KS]::Up([byte]$vk) }
  Start-Sleep -Milliseconds 300
  $lines += '=== after release'
  foreach ($k in $keys.Keys) {
    $vk = $keys[$k]; $a = [KS]::GetAsyncKeyState($vk); $s = [KS]::GetKeyState($vk)
    $lines += ('{0,-20} async={1,-6} sync={2,-6}' -f $k, ((($a -band 0x8000) -ne 0)), ((($s -band 0x8000) -ne 0)))
  }
}
$lines += '=== done'
$lines | Set-Content $out

