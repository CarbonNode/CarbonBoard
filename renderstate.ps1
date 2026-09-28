# renderstate.ps1 -- report (and optionally fix) the WINDOWS render endpoint volume/mute
# for the default playback device and every active render endpoint.
param([switch]$Fix, [float]$Target = 1.0)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface RS_IE { int EnumAudioEndpoints(int f,int m,out RS_IC c); int GetDefaultAudioEndpoint(int f,int r,out RS_ID d); }
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface RS_IC { int GetCount(out int c); int Item(int i,out RS_ID d); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface RS_ID { int Activate(ref Guid g,int c,IntPtr p,[MarshalAs(UnmanagedType.IUnknown)] out object o); int OpenPropertyStore(int a,out RS_IP ps); int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); int GetState(out int s); }
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface RS_IP { int GetCount(out int c); int GetAt(int i,out RS_PK k); int GetValue(ref RS_PK k,out RS_PV v); }
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface RS_IAEV { int RegisterControlChangeNotify(IntPtr p); int UnregisterControlChangeNotify(IntPtr p); int GetChannelCount(out int c); int SetMasterVolumeLevel(float l, ref Guid g); int SetMasterVolumeLevelScalar(float l, ref Guid g); int GetMasterVolumeLevel(out float l); int GetMasterVolumeLevelScalar(out float l); int SetChannelVolumeLevel(int c,float l, ref Guid g); int SetChannelVolumeLevelScalar(int c,float l, ref Guid g); int GetChannelVolumeLevel(int c,out float l); int GetChannelVolumeLevelScalar(int c,out float l); int SetMute(bool m, ref Guid g); int GetMute(out bool m); }
[StructLayout(LayoutKind.Sequential)] public struct RS_PK { public Guid f; public int p; }
[StructLayout(LayoutKind.Explicit)] public struct RS_PV { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class RS_EE { }
public static class RS {
  static RS_PK FN(){ RS_PK k=new RS_PK(); k.f=new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); k.p=14; return k; }
  static string Name(RS_ID d){ RS_IP ps; d.OpenPropertyStore(0,out ps); RS_PK k=FN(); RS_PV v; ps.GetValue(ref k,out v); return Marshal.PtrToStringUni(v.p); }
  static RS_IAEV Vol(RS_ID d){ Guid g=new Guid("5CDF2C82-841E-4546-9722-0CF74078229A"); object o; d.Activate(ref g,23,IntPtr.Zero,out o); return (RS_IAEV)o; }
  public static string DefaultId(){ var e=(RS_IE)(new RS_EE()); RS_ID d; e.GetDefaultAudioEndpoint(0,0,out d); string id; d.GetId(out id); return id; }
  public static string[] Report(){
    var res=new List<string>(); string def=DefaultId();
    var e=(RS_IE)(new RS_EE()); RS_IC c; e.EnumAudioEndpoints(0,1,out c); int n; c.GetCount(out n);
    for(int i=0;i<n;i++){ RS_ID d; c.Item(i,out d); string id; d.GetId(out id); var v=Vol(d);
      float vol; v.GetMasterVolumeLevelScalar(out vol); bool mu; v.GetMute(out mu);
      res.Add((id==def?"* ":"  ")+Name(d)+"  vol="+(vol*100).ToString("0")+"%"+(mu?"  MUTED":"")); }
    return res.ToArray();
  }
  public static string FixDefault(float target){
    var e=(RS_IE)(new RS_EE()); RS_ID d; e.GetDefaultAudioEndpoint(0,0,out d); var v=Vol(d);
    float before; v.GetMasterVolumeLevelScalar(out before); bool mu; v.GetMute(out mu);
    Guid ctx=Guid.Empty; if(mu) v.SetMute(false, ref ctx); if(before < target - 0.005f) v.SetMasterVolumeLevelScalar(target, ref ctx);
    float after; v.GetMasterVolumeLevelScalar(out after); bool mu2; v.GetMute(out mu2);
    return Name(d)+"  was "+(before*100).ToString("0")+"%"+(mu?" MUTED":"")+"  -> "+(after*100).ToString("0")+"%"+(mu2?" MUTED":" unmuted");
  }
}
"@
if ($Fix) { 'FIX: ' + [RS]::FixDefault($Target) }
'DEFAULT RENDER ENDPOINT marked *'
[RS]::Report()

