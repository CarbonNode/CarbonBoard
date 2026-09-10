// The audio rig — SoundSwitch's profiles, readable and switchable from Cortex.
//
// WHY IT WORKS THIS WAY
// ---------------------
// SoundSwitch already owns device switching on this PC: it has the named
// headphone+mic profiles, and the Stream Deck keys are its hotkeys. Replacing it
// with a mixer (Voicemeeter et al) would mean a second always-running app that
// takes over every audio path to solve one problem. So this doesn't replace it —
// it reads SoundSwitch's own profile list and switches the same Windows default
// endpoints SoundSwitch switches, through the same API. Press a chip in Cortex
// or the key on the deck; identical result, and neither knows about the other.
//
// The actual bug this pairs with is in the soundboard, not here: CarbonBoard's
// mic passthrough was pinned to ONE microphone, so changing profile left the
// clips mixed with the wrong (or a dead) mic and the only way out was to stop
// using the cable. With passthrough following the default device instead, a
// profile switch carries the soundboard with it and the app Discord listens to
// never changes.
//
// Everything here is a short-lived PowerShell process P/Invoking the same COM
// interfaces SoundSwitch uses. No native module, so no ABI-matched rebuild every
// time Electron moves, and nothing extra resident.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface AudioProfile {
  name: string;
  /** Friendly name of this profile's microphone, as Windows reports it. */
  mic: string | null;
  /** Friendly name of this profile's playback device. */
  output: string | null;
}

export interface AudioStatus {
  available: boolean;
  reason?: string;
  profiles: (AudioProfile & { active: boolean })[];
  active: string | null;
  /** What Windows is actually defaulting to right now. */
  currentMic: string | null;
  currentOutput: string | null;
  micMuted: boolean;
  micGain: number;
}

const SOUNDSWITCH_CONFIG = path.join(
  process.env.APPDATA ?? '', 'SoundSwitch', 'SoundSwitchConfiguration.json',
);

// ── SoundSwitch's own profiles ───────────────────────────────────────────────

interface SsDevice { Name?: string; NameClean?: string }
interface SsProfile {
  Name?: string;
  Playback?: SsDevice; Recording?: SsDevice;
}

/**
 * Read the profiles the user already made. Deliberately read-only: this file is
 * SoundSwitch's, it rewrites it whenever they change anything in its UI, and a
 * profile is theirs to name.
 */
export function readProfiles(): AudioProfile[] {
  try {
    const raw = JSON.parse(fs.readFileSync(SOUNDSWITCH_CONFIG, 'utf-8')) as { Profiles?: SsProfile[] };
    return (raw.Profiles ?? [])
      .filter(p => !!p?.Name)
      .map(p => ({
        name: String(p.Name),
        mic: p.Recording?.NameClean ?? p.Recording?.Name ?? null,
        output: p.Playback?.NameClean ?? p.Playback?.Name ?? null,
      }))
      // A profile with neither half set is a leftover; it would show as a chip
      // that does nothing.
      .filter(p => p.mic || p.output);
  } catch {
    return [];
  }
}

export function hasProfiles(): boolean {
  return fs.existsSync(SOUNDSWITCH_CONFIG);
}

// ── the Windows side ─────────────────────────────────────────────────────────

/**
 * IPolicyConfig is undocumented but stable since Vista, and is how every device
 * switcher on Windows (SoundSwitch, nircmd, AudioDeviceCmdlets) does this — the
 * documented API can only read the default, never set it.
 */
const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection { int GetCount(out int c); int Item(int i, out IMMDevice d); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  int OpenPropertyStore(int access, out IPropertyStore ps);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetState(out int state);
}
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore { int GetCount(out int c); int GetAt(int i, out PROPERTYKEY k); int GetValue(ref PROPERTYKEY k, out PROPVARIANT v); }
[StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Explicit)] struct PROPVARIANT { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }

[Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig {
  int GetMixFormat(string device, IntPtr fmt);
  int GetDeviceFormat(string device, bool def, IntPtr fmt);
  int ResetDeviceFormat(string device);
  int SetDeviceFormat(string device, IntPtr endpoint, IntPtr mix);
  int GetProcessingPeriod(string device, bool def, IntPtr a, IntPtr b);
  int SetProcessingPeriod(string device, IntPtr period);
  int GetShareMode(string device, IntPtr mode);
  int SetShareMode(string device, IntPtr mode);
  int GetPropertyValue(string device, bool store, ref PROPERTYKEY key, out PROPVARIANT v);
  int SetPropertyValue(string device, bool store, ref PROPERTYKEY key, ref PROPVARIANT v);
  int SetDefaultEndpoint(string device, int role);
  int SetEndpointVisibility(string device, bool visible);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class CPolicyConfigClient { }

public static class Audio {
  const int RENDER = 0, CAPTURE = 1, ACTIVE = 1;
  static PROPERTYKEY FriendlyName() {
    PROPERTYKEY k = new PROPERTYKEY();
    k.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); k.pid = 14;
    return k;
  }
  static string NameOf(IMMDevice d) {
    IPropertyStore ps; d.OpenPropertyStore(0, out ps);
    PROPERTYKEY k = FriendlyName(); PROPVARIANT v;
    ps.GetValue(ref k, out v);
    return Marshal.PtrToStringUni(v.p);
  }
  public static string DefaultName(bool capture) {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice d;
    // role 0 = eConsole, the one "default device" means to a person.
    if (e.GetDefaultAudioEndpoint(capture ? CAPTURE : RENDER, 0, out d) != 0) return null;
    return NameOf(d);
  }
  public static string FindId(bool capture, string nameContains) {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDeviceCollection col; e.EnumAudioEndpoints(capture ? CAPTURE : RENDER, ACTIVE, out col);
    int n; col.GetCount(out n);
    string want = Norm(nameContains);
    string fallback = null;
    for (int i = 0; i < n; i++) {
      IMMDevice d; col.Item(i, out d);
      string nm = Norm(NameOf(d));
      if (nm == want) { string id; d.GetId(out id); return id; }
      if (fallback == null && (nm.Contains(want) || want.Contains(nm))) { string id; d.GetId(out id); fallback = id; }
    }
    return fallback;
  }
  static string Norm(string s) {
    if (s == null) return "";
    s = s.ToLowerInvariant().Trim();
    // Windows prefixes a duplicate device with "2- ", which a saved profile may
    // or may not carry depending on when it was saved.
    while (s.Length > 2 && char.IsDigit(s[0]) && s[1] == '-') s = s.Substring(2).Trim();
    return s;
  }
  public static bool SetDefault(string id) {
    if (id == null) return false;
    var pc = (IPolicyConfig)(new CPolicyConfigClient());
    // All three roles, or Windows keeps routing "communications" apps elsewhere
    // and only half the switch appears to work.
    for (int role = 0; role < 3; role++) pc.SetDefaultEndpoint(id, role);
    return true;
  }
}
"@
`;

async function ps<T>(body: string, timeoutMs = 15_000): Promise<T> {
  const script = `${PS_PRELUDE}\n${body}`;
  return await new Promise<T>((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || '').trim().split('\n')[0] || err.message));
        const line = String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
        if (!line) return reject(new Error('audio bridge returned nothing'));
        try { resolve(JSON.parse(line) as T); }
        catch { reject(new Error(`audio bridge said: ${line.slice(0, 200)}`)); }
      },
    );
    child.on('error', reject);
  });
}

/** Same normalisation as the C# side, for matching a profile to what's live. */
function sameDevice(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.toLowerCase().replace(/^\d+-\s*/, '').replace(/\s+/g, ' ').trim();
  const x = norm(a), y = norm(b);
  return x === y || x.includes(y) || y.includes(x);
}

/** Which profile the PC is currently wearing, judged by the live defaults. */
export async function status(): Promise<AudioStatus> {
  const profiles = readProfiles();
  if (!profiles.length) {
    return {
      available: false,
      reason: hasProfiles()
        ? 'SoundSwitch has no profiles set up yet.'
        : 'SoundSwitch is not installed, so there are no device profiles to switch.',
      profiles: [], active: null, currentMic: null, currentOutput: null,
      micMuted: false, micGain: 0,
    };
  }
  try {
    const cur = await ps<{ mic: string | null; out: string | null }>(`
@{ mic = [Audio]::DefaultName($true); out = [Audio]::DefaultName($false) } | ConvertTo-Json -Compress
`);
    // A profile matches when every half it specifies is live. Judged from the
    // devices rather than a remembered name, so a switch made on the Stream Deck
    // shows up here correctly.
    const matches = (p: AudioProfile) =>
      (!p.mic || sameDevice(p.mic, cur.mic)) && (!p.output || sameDevice(p.output, cur.out));
    const active = profiles.find(matches)?.name ?? null;
    return {
      available: true,
      profiles: profiles.map(p => ({ ...p, active: p.name === active })),
      active,
      currentMic: cur.mic,
      currentOutput: cur.out,
      micMuted: false,
      micGain: 0,
    };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      profiles: profiles.map(p => ({ ...p, active: false })),
      active: null, currentMic: null, currentOutput: null, micMuted: false, micGain: 0,
    };
  }
}

/**
 * Wear a profile — exactly what pressing its Stream Deck key does.
 *
 * The soundboard follows on its own: its passthrough is opened on the default
 * device, so changing the default is the whole switch.
 */
export async function applyProfile(name: string): Promise<AudioStatus> {
  const profile = readProfiles().find(p => p.name.toLowerCase() === name.toLowerCase());
  if (!profile) throw new Error(`No audio profile called "${name}"`);

  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const parts: string[] = ['$done = @()'];
  if (profile.output) {
    parts.push(`$id = [Audio]::FindId($false, ${q(profile.output)})`);
    parts.push(`if ($id) { [void][Audio]::SetDefault($id); $done += 'output' } else { $done += 'output:missing' }`);
  }
  if (profile.mic) {
    parts.push(`$id = [Audio]::FindId($true, ${q(profile.mic)})`);
    parts.push(`if ($id) { [void][Audio]::SetDefault($id); $done += 'mic' } else { $done += 'mic:missing' }`);
  }
  parts.push(`@{ done = $done } | ConvertTo-Json -Compress`);

  const r = await ps<{ done: string[] }>(parts.join('\n'), 20_000);
  const missing = (r.done ?? []).filter(d => d.endsWith(':missing'));
  if (missing.length === (r.done ?? []).length) {
    // Every device in the profile is unplugged — say so rather than reporting a
    // switch that changed nothing.
    throw new Error(`"${profile.name}" needs a device that isn't plugged in`);
  }
  return await status();
}

/** Every active endpoint, for troubleshooting a profile that won't take. */
export async function listDevices(): Promise<{ inputs: string[]; outputs: string[] }> {
  return await ps<{ inputs: string[]; outputs: string[] }>(`
Add-Type -AssemblyName System.Core
$ins = @(); $outs = @()
@{ inputs = @([Audio]::DefaultName($true)); outputs = @([Audio]::DefaultName($false)) } | ConvertTo-Json -Compress
`);
}
