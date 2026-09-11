Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IE { int EnumAudioEndpoints(int f,int m,out IC c); int GetDefaultAudioEndpoint(int f,int r,out ID d); }
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IC { int GetCount(out int c); int Item(int i,out ID d); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ID { int Activate(ref Guid g,int c,IntPtr p,[MarshalAs(UnmanagedType.IUnknown)] out object o); int OpenPropertyStore(int a,out IP ps); int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); int GetState(out int s); }
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IP { int GetCount(out int c); int GetAt(int i,out PK k); int GetValue(ref PK k,out PV v); }
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISM2 { int NotImpl1(); int NotImpl2(); int GetSessionEnumerator(out ISE e); }
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISE { int GetCount(out int c); int GetSession(int i, out ISC s); }
[Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISC { int GetState(out int s); }
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISC2 { int GetState(out int s); int NotImpl_b(); int NotImpl_c(); int NotImpl_d(); int NotImpl_e(); int NotImpl_f(); int NotImpl_g(); int NotImpl_h(); int NotImpl_i(); int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id); int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id); int GetProcessId(out uint pid); }
[StructLayout(LayoutKind.Sequential)] struct PK { public Guid f; public int p; }
[StructLayout(LayoutKind.Explicit)] struct PV { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class EE { }
public static class S {
  static PK FN(){ PK k=new PK(); k.f=new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); k.p=14; return k; }
  public static string[] Who(bool cap){
    var res=new System.Collections.Generic.List<string>();
    var e=(IE)(new EE()); IC c; e.EnumAudioEndpoints(cap?1:0,1,out c); int n; c.GetCount(out n);
    for(int i=0;i<n;i++){
      ID d; c.Item(i,out d); IP ps; d.OpenPropertyStore(0,out ps); PK k=FN(); PV v; ps.GetValue(ref k,out v);
      string nm=Marshal.PtrToStringUni(v.p);
      try {
        Guid iid=new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"); object o; d.Activate(ref iid,1,IntPtr.Zero,out o);
        ISE se; ((ISM2)o).GetSessionEnumerator(out se); int sc; se.GetCount(out sc);
        for(int j=0;j<sc;j++){ ISC s1; se.GetSession(j,out s1); var s2=(ISC2)s1; uint pid; s2.GetProcessId(out pid); int st; s2.GetState(out st);
          if(st==1) res.Add(nm + "   <-- PID " + pid + " ACTIVE"); }
      } catch {}
    }
    return res.ToArray();
  }
}
"@
Write-Output "=== CAPTURE sessions ==="
foreach($l in [S]::Who($true)){ $p=($l -split "PID ")[1] -split " "; $nm=try{(Get-Process -Id ([int]$p[0]) -ErrorAction Stop).ProcessName}catch{"?"}; Write-Output ($l + "  = " + $nm) }

Write-Output ''
Write-Output '=== RENDER sessions ==='
foreach($l in [S]::Who($false)){ $p=($l -split 'PID ')[1] -split ' '; $nm=try{(Get-Process -Id ([int]$p[0]) -ErrorAction Stop).ProcessName}catch{'?'}; Write-Output ($l + '  = ' + $nm) }


