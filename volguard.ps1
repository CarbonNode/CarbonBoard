# volguard.ps1 -- keep the mic chain's capture endpoints at 100% and unmuted.
#
# 2026-09-19: "virtual mic through Astro A50 broken again". Every session was
# right (CarbonBoard held the A50, fed CABLE Input, the game held CABLE Output)
# and the chain watch said alive -- but the A50 Voice capture endpoint sat at
# 50% in Windows and CABLE Output at 48%, so speech reached the app at ~-36 dBFS,
# read 15-18 on the gate (threshold 12; it read 28-45 two days earlier) and the
# gate barely opened. Nothing in this app sets endpoint volume, so something
# else does (a game, Discord's sensitivity, a driver re-enumeration). Rather
# than find it, hold the levels: unity on the mic and on the virtual cable.
# The endpoint volume is the WINDOWS level, not the app's own gain.
#
# Returns one line per endpoint it changed (nothing when all is well).
# Interactive session only, like everything else in this chain.
# Runs as its OWN powershell process (-File) from micwatch.ps1: an Add-Type in the
# watchdog's process broke _who2.ps1's own Add-Type (2026-09-19 13:45, three false
# 'no microphone open at all' verdicts and a needless CarbonBoard restart).
param([string]$Mic = 'Astro A50 Voice', [float]$Target = 1.0)
$Patterns = @($Mic, 'CABLE Output')

Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface VG_IE { int EnumAudioEndpoints(int f,int m,out VG_IC c); int GetDefaultAudioEndpoint(int f,int r,out VG_ID d); }
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface VG_IC { int GetCount(out int c); int Item(int i,out VG_ID d); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface VG_ID { int Activate(ref Guid g,int c,IntPtr p,[MarshalAs(UnmanagedType.IUnknown)] out object o); int OpenPropertyStore(int a,out VG_IP ps); int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); int GetState(out int s); }
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface VG_IP { int GetCount(out int c); int GetAt(int i,out VG_PK k); int GetValue(ref VG_PK k,out VG_PV v); }
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface VG_IAEV { int RegisterControlChangeNotify(IntPtr p); int UnregisterControlChangeNotify(IntPtr p); int GetChannelCount(out int c); int SetMasterVolumeLevel(float l, ref Guid g); int SetMasterVolumeLevelScalar(float l, ref Guid g); int GetMasterVolumeLevel(out float l); int GetMasterVolumeLevelScalar(out float l); int SetChannelVolumeLevel(int c,float l, ref Guid g); int SetChannelVolumeLevelScalar(int c,float l, ref Guid g); int GetChannelVolumeLevel(int c,out float l); int GetChannelVolumeLevelScalar(int c,out float l); int SetMute(bool m, ref Guid g); int GetMute(out bool m); }
[StructLayout(LayoutKind.Sequential)] public struct VG_PK { public Guid f; public int p; }
[StructLayout(LayoutKind.Explicit)] public struct VG_PV { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class VG_EE { }
public static class VolGuard {
  static VG_PK FN(){ VG_PK k=new VG_PK(); k.f=new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); k.p=14; return k; }
  static string Name(VG_ID d){ VG_IP ps; d.OpenPropertyStore(0,out ps); VG_PK k=FN(); VG_PV v; ps.GetValue(ref k,out v); return Marshal.PtrToStringUni(v.p); }
  // Windows numbers a duplicated endpoint INSIDE the name ("3- Astro A50"); strip it anywhere before comparing.
  static string Norm(string s){ return System.Text.RegularExpressions.Regex.Replace(s ?? "", @"\b\d+-\s*", "").ToLowerInvariant(); }
  public static string[] Hold(string[] patterns, float target){
    var res=new List<string>(); var e=(VG_IE)(new VG_EE()); VG_IC c; e.EnumAudioEndpoints(1,1,out c); int n; c.GetCount(out n);
    for(int i=0;i<n;i++){
      VG_ID d; c.Item(i,out d); string nm=Name(d); string nn=Norm(nm); bool hit=false;
      foreach(var p in patterns){ if(string.IsNullOrEmpty(p)) continue; if(nn.IndexOf(Norm(p))>=0) hit=true; }
      if(!hit) continue;
      Guid g=new Guid("5CDF2C82-841E-4546-9722-0CF74078229A"); object o; d.Activate(ref g,23,IntPtr.Zero,out o); var v=(VG_IAEV)o;
      float before; v.GetMasterVolumeLevelScalar(out before); bool mute; v.GetMute(out mute);
      if(before >= target - 0.005f && !mute) continue;
      Guid ctx=Guid.Empty; v.SetMasterVolumeLevelScalar(target, ref ctx); if(mute) v.SetMute(false, ref ctx);
      float after; v.GetMasterVolumeLevelScalar(out after);
      res.Add(nm+"  was "+(before*100).ToString("0")+"%"+(mute?" MUTED":"")+"  -> "+(after*100).ToString("0")+"%");
    }
    return res.ToArray();
  }
}
"@
[VolGuard]::Hold($Patterns, $Target)
