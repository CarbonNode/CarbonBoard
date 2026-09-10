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
  /** Electron accelerator, e.g. "Control+Alt+Shift+P". Null = no hotkey. */
  hotkey: string | null;
}

export interface AudioStatus {
  available: boolean;
  reason?: string;
  profiles: (AudioProfile & { active: boolean })[];
  active: string | null;
  /** What Windows is actually defaulting to right now. */
  currentMic: string | null;
  currentOutput: string | null;
  /** The physical mic being mixed into the clip feed. */
  captureMic: string | null;
  /** Is the virtual cable pinned as the system recording device? */
  cablePinned: boolean;
  micMuted: boolean;
  micGain: number;
}

const SOUNDSWITCH_CONFIG = path.join(
  process.env.APPDATA ?? '', 'SoundSwitch', 'SoundSwitchConfiguration.json',
);

/** Our own copy, so SoundSwitch can be uninstalled without losing the profiles. */
let profilesPath = '';
export function setProfilesPath(p: string): void { profilesPath = p; }

// SoundSwitch stores a hotkey as a virtual-key code plus a modifier bitmask.
// Reading them rather than inventing new ones is the whole point: the Stream Deck
// keys are these combinations, so importing them means the deck keeps working
// against us with nothing rebound and nothing to remember.
const SS_MOD = { CTRL: 2, ALT: 1, SHIFT: 4 } as const;

function ssHotkey(hk: { Keys?: number; Modifier?: number; Enabled?: boolean } | undefined): string | null {
  if (!hk?.Enabled || typeof hk.Keys !== 'number') return null;
  const mod = hk.Modifier ?? 0;
  const parts: string[] = [];
  if (mod & SS_MOD.CTRL) parts.push('Control');
  if (mod & SS_MOD.ALT) parts.push('Alt');
  if (mod & SS_MOD.SHIFT) parts.push('Shift');
  const key = vkToAccelerator(hk.Keys);
  if (!key) return null;
  parts.push(key);
  return parts.join('+');
}

/** Windows virtual-key code → the name Electron's accelerator parser wants. */
function vkToAccelerator(vk: number): string | null {
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);           // 0-9
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);           // A-Z
  if (vk >= 0x70 && vk <= 0x7b) return `F${vk - 0x6f}`;                   // F1-F12
  const punct: Record<number, string> = {
    0xbd: '-', 0xbb: '=', 0xdb: '[', 0xdd: ']', 0xdc: '\\',
    0xba: ';', 0xde: "'", 0xbc: ',', 0xbe: '.', 0xbf: '/', 0xc0: '`',
  };
  return punct[vk] ?? null;
}

interface SsDevice { Name?: string; NameClean?: string }
interface SsProfile {
  Name?: string;
  Playback?: SsDevice; Recording?: SsDevice;
  Triggers?: { HotKey?: { Keys?: number; Modifier?: number; Enabled?: boolean } }[];
}

/** One-time import of the profiles (and their hotkeys) SoundSwitch already had. */
export function importFromSoundSwitch(): AudioProfile[] {
  try {
    const raw = JSON.parse(fs.readFileSync(SOUNDSWITCH_CONFIG, 'utf-8')) as { Profiles?: SsProfile[] };
    return (raw.Profiles ?? [])
      .filter(p => !!p?.Name)
      .map(p => ({
        name: String(p.Name),
        mic: p.Recording?.NameClean ?? p.Recording?.Name ?? null,
        output: p.Playback?.NameClean ?? p.Playback?.Name ?? null,
        hotkey: ssHotkey(p.Triggers?.[0]?.HotKey),
      }))
      .filter(p => p.mic || p.output)
      // A profile whose mic IS the virtual cable was a workaround for the very
      // problem this replaces — with the cable pinned as the system default it
      // would mean "capture my own output", which is a feedback loop.
      .filter(p => !/cable output|vb-audio/i.test(p.mic ?? ''));
  } catch {
    return [];
  }
}

export function readProfiles(): AudioProfile[] {
  try {
    const raw = JSON.parse(fs.readFileSync(profilesPath, 'utf-8')) as unknown;
    if (Array.isArray(raw) && raw.length) {
      return raw.filter((p): p is AudioProfile => !!p && typeof (p as AudioProfile).name === 'string');
    }
  } catch { /* fall through to the import */ }
  // First run (or the file was emptied): adopt SoundSwitch's, then own them.
  const imported = importFromSoundSwitch();
  if (imported.length) writeProfiles(imported);
  return imported;
}

export function writeProfiles(profiles: AudioProfile[]): void {
  fs.mkdirSync(path.dirname(profilesPath), { recursive: true });
  fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
}

export function hasProfiles(): boolean {
  return readProfiles().length > 0;
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
    // Windows numbers a duplicated endpoint — "Headset Microphone (3- Astro A50
    // Voice)" — and that number appears INSIDE the parenthesis, not just at the
    // start, while a profile saved before the renumber has no number at all.
    // Strip the counter wherever it sits, or every profile reads as inactive.
    // NOTE the doubled backslashes: this C# lives inside a JS TEMPLATE LITERAL,
    // so \\b would reach PowerShell as a BACKSPACE character (U+0008) and \\d as a
    // bare "d". The emitted regex was "<BS>d+-s*", which matches nothing — so the
    // "3- " Windows adds to a duplicated endpoint was never stripped and every
    // profile failed to find its device with a confident "isn't plugged in".
    s = System.Text.RegularExpressions.Regex.Replace(s, @"\\b\\d+-\\s*", "");
    return System.Text.RegularExpressions.Regex.Replace(s, @"\\s+", " ").Trim();
  }
  /**
   * The endpoint's "Default Format" — the Advanced tab in mmsys.cpl. Reading it
   * needs GetDeviceFormat, whose out-param is a WAVEFORMATEX** the caller owns.
   */
  public static int RateOf(bool capture, string nameContains) {
    string id = FindId(capture, nameContains);
    if (id == null) return -1;
    var pc = (IPolicyConfig)(new CPolicyConfigClient());
    IntPtr pp = Marshal.AllocHGlobal(IntPtr.Size);
    Marshal.WriteIntPtr(pp, IntPtr.Zero);
    int hr = pc.GetDeviceFormat(id, true, pp);
    IntPtr fmt = Marshal.ReadIntPtr(pp);
    Marshal.FreeHGlobal(pp);
    if (hr != 0 || fmt == IntPtr.Zero) return -1;
    int rate = Marshal.ReadInt32(fmt, 4);
    Marshal.FreeCoTaskMem(fmt);
    return rate;
  }
  /**
   * Set that format. The registry copy under MMDevices is ACL-protected — even
   * SYSTEM is refused — so IPolicyConfig is not merely convenient here, it is the
   * only way to change it without taking ownership of a system key.
   */
  public static int SetFormat(bool capture, string nameContains, int rate) {
    string id = FindId(capture, nameContains);
    if (id == null) return -1;
    short ch = 2, bits = 24;
    short blockAlign = (short)(ch * bits / 8);
    byte[] w = new byte[40];                                  // WAVEFORMATEXTENSIBLE
    BitConverter.GetBytes((ushort)0xFFFE).CopyTo(w, 0);       // wFormatTag
    BitConverter.GetBytes((ushort)ch).CopyTo(w, 2);
    BitConverter.GetBytes((uint)rate).CopyTo(w, 4);
    BitConverter.GetBytes((uint)(rate * blockAlign)).CopyTo(w, 8);
    BitConverter.GetBytes((ushort)blockAlign).CopyTo(w, 12);
    BitConverter.GetBytes((ushort)bits).CopyTo(w, 14);
    BitConverter.GetBytes((ushort)22).CopyTo(w, 16);          // cbSize
    BitConverter.GetBytes((ushort)bits).CopyTo(w, 18);        // wValidBitsPerSample
    BitConverter.GetBytes((uint)3).CopyTo(w, 20);             // FL | FR
    new Guid("00000001-0000-0010-8000-00aa00389b71").ToByteArray().CopyTo(w, 24); // PCM
    IntPtr p = Marshal.AllocHGlobal(40);
    Marshal.Copy(w, 0, p, 40);
    var pc2 = (IPolicyConfig)(new CPolicyConfigClient());
    int hr2 = pc2.SetDeviceFormat(id, p, p);
    Marshal.FreeHGlobal(p);
    return hr2;
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
  // Same rule as the C# side: Windows' duplicate-endpoint counter can sit
  // anywhere in the name ("Headset Microphone (3- Astro A50 Voice)").
  const norm = (s: string) => s.toLowerCase().replace(/\b\d+-\s*/g, '').replace(/\s+/g, ' ').trim();
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
      captureMic: null, cablePinned: false, micMuted: false, micGain: 0,
    };
  }
  try {
    const cur = await ps<{ mic: string | null; out: string | null }>(`
@{ mic = [Audio]::DefaultName($true); out = [Audio]::DefaultName($false) } | ConvertTo-Json -Compress
`);
    const cablePinned = isCable(cur.mic);
    const captureMic = getCaptureMic();
    // A profile matches when every half it specifies is live. Judged from the
    // devices rather than a remembered name, so a switch made on the Stream Deck
    // shows up here correctly.
    // Which profile is worn is judged by the PHYSICAL mic being captured and the
    // playback device — never by the default recording device, which is pinned to
    // the cable for good and would match every profile or none.
    const matches = (p: AudioProfile) =>
      (!p.mic || sameDevice(p.mic, captureMic)) && (!p.output || sameDevice(p.output, cur.out));
    const active = profiles.find(matches)?.name ?? null;
    return {
      available: true,
      profiles: profiles.map(p => ({ ...p, active: p.name === active })),
      active,
      currentMic: cur.mic,
      currentOutput: cur.out,
      captureMic,
      cablePinned,
      micMuted: false,
      micGain: 0,
    };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      profiles: profiles.map(p => ({ ...p, active: false })),
      active: null, currentMic: null, currentOutput: null,
      captureMic: null, cablePinned: false, micMuted: false, micGain: 0,
    };
  }
}

/**
 * Wear a profile — exactly what pressing its Stream Deck key does.
 *
 * The soundboard follows on its own: its passthrough is opened on the default
 * device, so changing the default is the whole switch.
 */
export interface ApplyResult { applied: string; output: string | null; mic: string | null }

export async function applyProfile(name: string): Promise<ApplyResult> {
  const profile = readProfiles().find(p => p.name.toLowerCase() === name.toLowerCase());
  if (!profile) throw new Error(`No audio profile called "${name}"`);

  // What a profile switch does NOT do: touch the default recording device. That
  // stays pinned to the virtual cable permanently, which is the whole reason
  // Discord/OBS/games can sit on "Windows Default" and still hear the clips.
  if (profile.output) {
    const q = `'${profile.output.replace(/'/g, "''")}'`;
    const r = await ps<{ ok: boolean }>(`
$id = [Audio]::FindId($false, ${q})
if ($id) { [void][Audio]::SetDefault($id); @{ ok = $true } | ConvertTo-Json -Compress }
else { @{ ok = $false } | ConvertTo-Json -Compress }
`, 20_000);
    if (!r.ok) throw new Error(`"${profile.name}" needs ${profile.output}, which isn't plugged in`);
  }

  // The mic is a CarbonBoard setting, not a Windows one: the app captures this
  // physical device and mixes it with the clips.
  if (profile.mic) setCaptureMic(profile.mic);

  // Deliberately does NOT re-read the audio stack before answering. Changing the
  // default endpoint restarts the audio engine, and enumerating devices while
  // that is settling blocks for a long time — long enough that the caller's
  // request times out even though the switch itself already happened. The whole
  // point of a profile key is that it feels instant, so we report what we set
  // and let the next poll observe it.
  void ensureCablePinned();
  return { applied: profile.name, output: profile.output, mic: profile.mic };
}

// ── the pinned cable ─────────────────────────────────────────────────────────

const CABLE_RE = /cable output|vb-audio/i;
export function isCable(name: string | null | undefined): boolean {
  return !!name && CABLE_RE.test(name);
}

let captureMic: string | null = null;
let onCaptureChange: ((label: string) => void) | null = null;
export function setCaptureChangeHandler(fn: (label: string) => void): void { onCaptureChange = fn; }
export function getCaptureMic(): string | null { return captureMic; }
/**
 * Adopt the persisted mic on boot WITHOUT re-notifying.
 *
 * captureMic is an in-memory mirror of a setting that survives restarts, so
 * after a crash the passthrough came back on the right microphone while status
 * reported "no profile active" — the audio was right and the display was
 * lying, which is the worse of the two failures to leave in.
 */
export function primeCaptureMic(label: string | null): void { captureMic = label; }
export function setCaptureMic(label: string): void {
  captureMic = label;
  onCaptureChange?.(label);
}

/**
 * Make the virtual cable the system recording device, if it isn't already.
 *
 * Called on boot and after every profile switch. This is the one piece of Windows
 * configuration the whole design depends on, so it is asserted continuously
 * rather than set up once: anything that steals the default back (a driver
 * update, plugging in a headset that grabs it, a leftover SoundSwitch profile)
 * would otherwise silently take the clips out of the mic feed with no symptom
 * except people saying they cannot hear them.
 */
export async function ensureCablePinned(): Promise<boolean> {
  try {
    const r = await ps<{ was: string | null; pinned: boolean }>(`
$cur = [Audio]::DefaultName($true)
if ($cur -match 'CABLE Output|VB-Audio') {
  @{ was = $cur; pinned = $true } | ConvertTo-Json -Compress
} else {
  $id = [Audio]::FindId($true, 'CABLE Output')
  if ($id) { [void][Audio]::SetDefault($id); @{ was = $cur; pinned = $true } | ConvertTo-Json -Compress }
  else { @{ was = $cur; pinned = $false } | ConvertTo-Json -Compress }
}
`, 20_000);
    return r.pinned;
  } catch {
    return false;
  }
}

/**
 * Both ends of the cable must run at 48 kHz, because that is what everything
 * else in the chain already is.
 *
 * This is the fix for the bug that looked like Discord's: a permanent solid
 * green speaking ring, with the cable measurably at digital silence. Windows had
 * the endpoints' default formats at 192000 Hz (CABLE Input) and 88200 Hz (CABLE
 * Output) while VB-CABLE's own driver runs at 48000 (`VBAudioCableWDM_SR`), so
 * every sample crossed two asynchronous resamplers — and 88.2k is the 44.1k
 * family, not 48k's, so the conversion never lands on a whole ratio. The
 * resampler's continuous artifacts are generated INSIDE Discord's capture path,
 * downstream of anything an endpoint peak meter can see, which is why the cable
 * reads as perfectly silent while Discord's voice-activity gate never closes:
 * its trailing hangover is re-armed faster than it can expire.
 *
 * Asserted on the same schedule as the pin rather than set once — the Sound
 * control panel, a driver update, or an app that requests a different shared
 * format can all move it back, and the only symptom is a green ring nobody can
 * explain. Reads first and only writes when it is actually wrong, so the common
 * case does not restart the audio engine every minute.
 */
export async function ensureCableFormat(rate = 48_000): Promise<boolean> {
  try {
    const r = await ps<{ input: number; output: number; changed: boolean }>(`
$inRate  = [Audio]::RateOf($false, 'CABLE Input')
$outRate = [Audio]::RateOf($true,  'CABLE Output')
$changed = $false
if ($inRate  -gt 0 -and $inRate  -ne ${rate}) { [void][Audio]::SetFormat($false, 'CABLE Input',  ${rate}); $changed = $true }
if ($outRate -gt 0 -and $outRate -ne ${rate}) { [void][Audio]::SetFormat($true,  'CABLE Output', ${rate}); $changed = $true }
@{ input = $inRate; output = $outRate; changed = $changed } | ConvertTo-Json -Compress
`, 20_000);
    if (r.changed) {
      console.log(`[audio-rig] cable format corrected to ${rate} Hz (was in=${r.input} out=${r.output})`);
    }
    return true;
  } catch {
    return false;
  }
}

/** Every active endpoint, for troubleshooting a profile that won't take. */
export async function listDevices(): Promise<{ inputs: string[]; outputs: string[] }> {
  return await ps<{ inputs: string[]; outputs: string[] }>(`
Add-Type -AssemblyName System.Core
$ins = @(); $outs = @()
@{ inputs = @([Audio]::DefaultName($true)); outputs = @([Audio]::DefaultName($false)) } | ConvertTo-Json -Compress
`);
}

// ── noticing a switch we did not make ────────────────────────────────────────

/**
 * Watch the default PLAYBACK device and react to whoever changed it.
 *
 * Not every switch comes through us. Two of the Stream Deck keys are Elgato
 * Multi-Action routines rather than hotkeys — they set the device themselves and
 * never send a keystroke, so the app that owns the mic would otherwise be the
 * last to know. Watching the endpoint instead of trusting the trigger means the
 * A50 key works exactly like the In Ear key without either being re-authored,
 * and anything added later works too.
 *
 * When the output moves to a device a profile names, this adopts that profile:
 * the capture mic follows, so the clips stay mixed with the right microphone.
 */
export function startDeviceWatch(
  onExternalSwitch: (profile: AudioProfile) => void,
  intervalMs = 2500,
): void {
  let last: string | null = null;
  let busy = false;

  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const cur = await ps<{ out: string | null }>(
        `@{ out = [Audio]::DefaultName($false) } | ConvertTo-Json -Compress`, 12_000);
      const out = cur.out ?? null;
      if (out && last && out !== last) {
        const hit = readProfiles().find(p => p.output && sameDevice(p.output, out));
        // Only when it lands somewhere we have a name for. A device with no
        // profile is a legitimate manual choice, not something to narrate.
        if (hit && hit.mic && !sameDevice(hit.mic, captureMic)) {
          setCaptureMic(hit.mic);
          onExternalSwitch(hit);
        }
      }
      last = out;
    } catch {
      // A poll that fails is not worth reporting; the next one usually works.
    } finally {
      busy = false;
    }
  };

  void tick();
  setInterval(() => { void tick(); }, Math.max(1000, intervalMs));
}
