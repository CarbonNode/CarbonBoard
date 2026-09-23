// The mic chain, judged by SIGNAL rather than by state.
//
// WHY THIS EXISTS (2026-09-15)
// ----------------------------
// The passthrough sat "healthy" for 75 minutes while Discord heard nothing. Every
// check we had passed: the capture stream was open on the right microphone, the
// AudioContext was running, the <audio> element was playing, the Windows session
// list showed CarbonBoard rendering into CABLE Input, and micwatch logged "ok"
// every five minutes. Peak meters on the cable endpoint read exact digital
// silence the whole time, for clips as well as the mic. The output sink had died
// somewhere below JavaScript (Chromium shares ONE physical stream per output
// device across every element routed to it, and that stream had gone dead
// after the 08:52 profile switch restarted the Windows audio engine). Nothing
// above it could see that, because "playing" is a property of the element,
// not of the audio. Stopping and re-opening the passthrough rebuilt the sink
// and everything flowed again.
//
// So this does not ask the pipeline whether it is fine. It asks Windows what is
// on the cable, and it asks the renderer whether anything SHOULD be: the gate is
// open (someone is speaking) or a clip is playing. Signal expected + cable silent
// for a few seconds = the feed is dead, whatever the objects say. The heal is the
// thing that worked by hand: tear the output path down and open it again. If
// that keeps failing, relaunch the app, because only a fresh audio service is
// left to try.
//
// The meter is a resident PowerShell process reading IAudioMeterInformation on
// the CABLE Input endpoint five times a second. Resident, because spawning one
// per read costs ~300 ms of CPU each time; PowerShell, because that is how the
// rest of the audio rig talks to Windows (no native module, nothing to rebuild
// when Electron moves).

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app, WebContents } from 'electron';

/** What the renderer reports every 500 ms. */
export interface MicTelemetry {
  passthrough: boolean;
  level: number;
  /** Max level since the previous report (speech is bursty; the instantaneous level misses it). */
  peak?: number;
  gateOpen: boolean;
  threshold: number;
  floor: number;
  clips: number;
}

export interface ChainStatus {
  /** The resident meter is delivering readings. */
  meterAlive: boolean;
  /** Last peak read on CABLE Input, 0..1. */
  cablePeak: number;
  /** ms since the cable last carried anything above -60 dBFS; null = never. */
  cableSignalAgoMs: number | null;
  /** ms since the renderer last reported; null = never. */
  telemetryAgoMs: number | null;
  /** Something should be on the cable right now (gate open or a clip playing). */
  expecting: boolean;
  expectingForMs: number;
  gateOpen: boolean;
  level: number;
  threshold: number;
  floor: number;
  clips: number;
  /** ms the feed has been judged dead without a successful heal; 0 = fine. */
  stuckForMs: number;
  deadEvents: number;
  lastDeadAt: string | null;
  lastHealAt: string | null;
  relaunches: number;
  /** ms the capture has read exactly 0 with the passthrough on; 0 = it carries signal. */
  captureSilentForMs: number;
  /** Re-opens made because the capture side was silent. */
  captureHeals: number;
  /** Windows meter on the microphone the app captures, 0..1; the mic's own truth. */
  micPeak: number;
  micMeterAlive: boolean;
  /** Which side the current dead state is on. */
  deadWhy: 'output' | 'capture' | null;
}

/** One line a person can act on, for the tray and its tooltip. */
export interface ChainVerdict {
  state: 'ok' | 'dead' | 'silent' | 'blind' | 'off';
  title: string;
  detail: string;
}

const SIGNAL_FLOOR = 0.001;      // ~-60 dBFS: a peak meter reads this on real audio, never on a dead stream
const DEAD_AFTER_MS = 3000;      // signal expected for this long with nothing on the cable
const HEAL_COOLDOWN_MS = 20_000; // one re-open per this window, so a bad state cannot flap the mic
const STRIKES_TO_RELAUNCH = 3;   // heals that failed inside STRIKE_WINDOW_MS before the app restarts itself
const STRIKE_WINDOW_MS = 10 * 60_000;
const RELAUNCH_COOLDOWN_MS = 30 * 60_000;
const METER_SILENT_MS = 6000;    // no line from the meter for this long = it is dead, respawn it
// The CAPTURE side. A live microphone never reads exactly 0 on the analyser: the
// observed floor on this rig is 5-9 even between words (renderer.log). Exactly 0
// for this long, with the passthrough on, is a capture stream that carries
// nothing -- a dead stream below JavaScript, a receiver whose transmitter is off,
// or a device that went away without ending its track. The gate can never open on
// it, so the output-side judge above is blind to it: that is how the mic sat dead
// from 2026-09-16 12:47 to 2026-09-17 13:18 with every check green.
const CAPTURE_SILENT_MS = 45_000;
const CAPTURE_HEAL_COOLDOWN_MS = 2 * 60_000;  // re-open at most this often; a re-open of a silent stream is inaudible
// The CAPTURE side, judged the same way as the output: by what Windows sees on
// the microphone endpoint versus what the app's own analyser sees on the stream
// it opened from that endpoint. 2026-09-17 13:47: the Insta360 endpoint peaked at
// -17 dBFS while CarbonBoard's stream read 0-3 of 100 -- a re-open did not fix
// it, a relaunch did. "Exactly 0" above never fired, because a dead Chromium
// stream still carries a little dither.
const MIC_LOUD = 0.03;            // ~-30 dBFS on the endpoint meter: someone is speaking into that mic
const RENDERER_QUIET = 10;        // the analyser reads below this on a dead stream; speech reads 30+
const CAPTURE_WINDOW_TICKS = 12;  // 6 s of ticks
const CAPTURE_MIN_LOUD_TICKS = 4; // this many loud-mic ticks in the window, all unheard by the app = dead

const METER_PS = `
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IE { int EnumAudioEndpoints(int f,int m,out IC c); int GetDefaultAudioEndpoint(int f,int r,out ID d); }
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IC { int GetCount(out int c); int Item(int i,out ID d); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ID { int Activate(ref Guid g,int c,IntPtr p,[MarshalAs(UnmanagedType.IUnknown)] out object o); int OpenPropertyStore(int a,out IP ps); int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); int GetState(out int s); }
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IP { int GetCount(out int c); int GetAt(int i,out PK k); int GetValue(ref PK k,out PV v); }
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMeter { int GetPeakValue(out float p); }
[StructLayout(LayoutKind.Sequential)] struct PK { public Guid f; public int p; }
[StructLayout(LayoutKind.Explicit)] struct PV { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class EE { }
public static class CableMeter {
  static string Norm(string s){ if(s==null) return ""; s=s.ToLowerInvariant().Trim(); s=System.Text.RegularExpressions.Regex.Replace(s, @"\\b\\d+-\\s*", ""); return System.Text.RegularExpressions.Regex.Replace(s, @"\\s+", " ").Trim(); }
  public static object Open(int flow, string want){
    var e=(IE)(new EE()); IC c; e.EnumAudioEndpoints(flow,1,out c); int n; c.GetCount(out n);
    string w=Norm(want); object fallback=null;
    for(int i=0;i<n;i++){ ID d; c.Item(i,out d); IP ps; d.OpenPropertyStore(0,out ps);
      PK k=new PK(); k.f=new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); k.p=14; PV v; ps.GetValue(ref k,out v);
      string nm=Norm(Marshal.PtrToStringUni(v.p));
      if(nm.Length==0 || w.Length==0) continue;
      bool exact = nm==w, loose = nm.IndexOf(w)>=0 || w.IndexOf(nm)>=0;
      if(exact || (loose && fallback==null)){
        Guid iid=new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"); object o; d.Activate(ref iid,23,IntPtr.Zero,out o);
        if(exact) return o; fallback=o; } }
    return fallback;
  }
  public static float Peak(object o){ float p; ((IMeter)o).GetPeakValue(out p); return p; }
}
"@
$m = $null
$mic = $null
$micWant = ''
$micFile = '__MICFILE__'
$opened = [datetime]::MinValue
$inv = [Globalization.CultureInfo]::InvariantCulture
while ($true) {
  # Re-open every minute regardless: a meter on an endpoint Windows has since
  # re-enumerated keeps returning 0 forever and would read as a dead feed.
  $want = ''
  try { $want = ([IO.File]::ReadAllText($micFile)).Trim() } catch { }
  if ($m -eq $null -or $want -ne $micWant -or ((Get-Date) - $opened).TotalSeconds -ge 60) {
    try { $m = [CableMeter]::Open(0, 'CABLE Input') } catch { $m = $null }
    $micWant = $want
    if ($want.Length -gt 0) { try { $mic = [CableMeter]::Open(1, $want) } catch { $mic = $null } } else { $mic = $null }
    $opened = Get-Date
  }
  $mp = 'nf'
  if ($mic -ne $null) { try { $mp = [CableMeter]::Peak($mic).ToString($inv) } catch { $mic = $null; $mp = 'err' } }
  if ($m -eq $null) { [Console]::Out.WriteLine('p=nf m=' + $mp) }
  else { try { [Console]::Out.WriteLine('p=' + [CableMeter]::Peak($m).ToString($inv) + ' m=' + $mp) } catch { $m = $null; [Console]::Out.WriteLine('p=err m=' + $mp) } }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 200
}
`;

export interface ChainHooks {
  /** Ask the renderer to tear down and re-open the mic output path. */
  restartPassthrough: () => boolean;
  /** Tell the person, on screen. */
  toast: (title: string, detail: string | null) => void;
  /** The physical mic the profile says is live, for the log line. */
  captureMic: () => string | null;
}

export class ChainWatch {
  private meter: ChildProcess | null = null;
  private meterSpawns = 0;
  private lastLineAt = 0;
  private cablePeak = 0;
  private lastSignalAt = 0;
  private meterOpenFailures = 0;

  private tel: MicTelemetry | null = null;
  private telAt = 0;
  private expectingSince = 0;

  private micPeak = 0;
  private micLineAt = 0;
  private micWritten: string | null = null;
  private readonly micFile: string;
  private capWindow: { micLoud: boolean; heard: boolean }[] = [];
  private deadWhy: 'output' | 'capture' | null = null;

  private captureSilentSince = 0;
  private captureSilentJudged = false;
  private captureHeals = 0;
  private lastCaptureHealAt = 0;

  private deadSince = 0;
  private deadEvents = 0;
  private lastDeadAt: string | null = null;
  private lastHealAt = 0;
  private strikes: number[] = [];
  private relaunches = 0;

  private timer: NodeJS.Timeout | null = null;
  private hooks: ChainHooks | null = null;
  private readonly logFile: string;
  private readonly relaunchStamp: string;

  constructor(dataDir: string) {
    this.logFile = path.join(dataDir, 'chain.log');
    this.relaunchStamp = path.join(dataDir, 'chain.relaunch');
    this.micFile = path.join(dataDir, 'chain.mic');
  }

  /** Tell the meter which microphone to watch (the profile's capture mic, by label). */
  private syncMicFile(): void {
    const label = this.hooks?.captureMic() ?? '';
    if (label === this.micWritten) return;
    try {
      fs.writeFileSync(this.micFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(label, 'utf8')]));
      this.micWritten = label;
      this.log(`meter   watching microphone "${label || '(none)'}"`);
    } catch { /* next tick */ }
  }

  start(hooks: ChainHooks): void {
    this.hooks = hooks;
    this.syncMicFile();
    this.spawnMeter();
    this.timer = setInterval(() => this.tick(), 500);
    this.log('start   watching CABLE Input by meter');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.killMeter();
  }

  onTelemetry(t: MicTelemetry): void {
    this.tel = t;
    this.telAt = Date.now();
  }

  /** Re-open the output path now, whatever the meter says (API / a human). */
  heal(reason: string): boolean {
    const ok = this.hooks?.restartPassthrough() ?? false;
    this.lastHealAt = Date.now();
    this.log(`heal    ${reason} -> ${ok ? 'renderer asked to re-open the passthrough' : 'no renderer to ask'}`);
    return ok;
  }

  status(): ChainStatus {
    const now = Date.now();
    const t = this.tel;
    const fresh = !!t && now - this.telAt < 3000;
    return {
      meterAlive: this.meterAlive(now),
      cablePeak: this.cablePeak,
      cableSignalAgoMs: this.lastSignalAt ? now - this.lastSignalAt : null,
      telemetryAgoMs: this.telAt ? now - this.telAt : null,
      expecting: fresh && this.expects(t!),
      expectingForMs: this.expectingSince ? now - this.expectingSince : 0,
      gateOpen: fresh ? t!.gateOpen : false,
      level: fresh ? t!.level : 0,
      threshold: fresh ? t!.threshold : 0,
      floor: fresh ? t!.floor : 0,
      clips: fresh ? t!.clips : 0,
      stuckForMs: this.deadSince ? now - this.deadSince : 0,
      deadEvents: this.deadEvents,
      lastDeadAt: this.lastDeadAt,
      lastHealAt: this.lastHealAt ? new Date(this.lastHealAt).toISOString() : null,
      relaunches: this.relaunches,
      captureSilentForMs: this.captureSilentSince ? now - this.captureSilentSince : 0,
      captureHeals: this.captureHeals,
      micPeak: this.micPeak,
      micMeterAlive: this.micLineAt > 0 && now - this.micLineAt < METER_SILENT_MS,
      deadWhy: this.deadSince ? this.deadWhy : null,
    };
  }

  /** What the tray shows: the worst thing that is true right now. */
  verdict(): ChainVerdict {
    const st = this.status();
    const mic = this.hooks?.captureMic() ?? 'microphone';
    const secs = (ms: number) => `${Math.round(ms / 1000)}s`;
    if (st.telemetryAgoMs === null || st.telemetryAgoMs > 5000) {
      return { state: 'blind', title: 'Mic feed: no word from the app window', detail: 'The soundboard window is not reporting. Restart CarbonBoard.' };
    }
    if (this.tel && !this.tel.passthrough) {
      return { state: 'off', title: 'Mic feed OFF', detail: 'The passthrough is switched off, so Discord hears nothing.' };
    }
    if (st.stuckForMs > 0) {
      return st.deadWhy === 'capture'
        ? { state: 'dead', title: `Mic DEAD for ${secs(st.stuckForMs)} - app hears nothing`, detail: `${mic} has sound on it but the app's stream is silent. Re-opening; then a relaunch.` }
        : { state: 'dead', title: `Mic feed DEAD for ${secs(st.stuckForMs)}`, detail: `You are speaking but nothing reaches the cable (heals: ${st.deadEvents}).` };
    }
    if (st.captureSilentForMs >= CAPTURE_SILENT_MS) {
      return { state: 'silent', title: `Mic silent for ${secs(st.captureSilentForMs)}`, detail: `${mic} is delivering nothing at all. Off, unplugged, or a dead stream.` };
    }
    if (!st.meterAlive) {
      return { state: 'blind', title: 'Mic feed: cable meter down', detail: 'Cannot see the cable; re-opening the meter.' };
    }
    const sig = st.cableSignalAgoMs === null ? 'never' : `${secs(st.cableSignalAgoMs)} ago`;
    return { state: 'ok', title: `Mic feed OK - ${mic}`, detail: `Cable last carried audio ${sig} - level ${st.level}, gate ${st.gateOpen ? 'open' : 'closed'}.` };
  }

  // ── the judge ──────────────────────────────────────────────────────────────

  private expects(t: MicTelemetry): boolean {
    // An open gate only means signal is expected if the analyser actually has
    // some: with a low manual threshold the gate sits open through silence, and
    // a microphone that is switched off would otherwise read as a dead OUTPUT and
    // walk the app into a relaunch it cannot fix (2026-09-17).
    const speaking = t.gateOpen && (t.peak ?? t.level) >= RENDERER_QUIET;
    return t.passthrough && (speaking || t.clips > 0);
  }

  private meterAlive(now: number): boolean {
    return !!this.meter && now - this.lastLineAt < METER_SILENT_MS;
  }

  private tick(): void {
    const now = Date.now();

    if (this.meter && now - this.lastLineAt > METER_SILENT_MS && this.lastLineAt > 0) {
      this.log('meter   stopped reporting, respawning it');
      this.spawnMeter();
    }
    this.syncMicFile();

    const fresh = !!this.tel && now - this.telAt < 3000;
    this.judgeSilence(now, fresh);

    const out = this.judgeOutput(now, fresh);
    const cap = this.judgeCapture(now, fresh);

    if (out !== 'dead' && cap !== 'dead') {
      if (this.deadSince) {
        const back = this.deadWhy === 'capture'
          ? cap === 'alive'
          : out === 'alive' || now - this.lastSignalAt < DEAD_AFTER_MS;
        if (back) this.recovered(this.deadWhy === 'capture' ? 'the app hears the microphone again' : 'signal returned');
      }
      return;
    }

    // Dead on one side or the other. Same escalation for both: re-open, then relaunch.
    const why: 'output' | 'capture' = cap === 'dead' ? 'capture' : 'output';
    if (!this.deadSince) {
      this.deadSince = now;
      this.deadWhy = why;
      this.deadEvents++;
      this.lastDeadAt = new Date(now).toISOString();
      this.log(why === 'capture'
        ? `DEAD    capture -- mic endpoint peak=${this.micPeak.toFixed(3)} while the app's stream reads ${this.tel?.peak ?? this.tel?.level ?? '?'}; ${this.describe()}`
        : `DEAD    output -- ${this.describe()} -- cable silent ${Math.round((now - (this.lastSignalAt || this.expectingSince)) / 1000)}s while signal expected`);
    }
    if (now - this.lastHealAt < HEAL_COOLDOWN_MS) return;

    this.strikes = this.strikes.filter(s => now - s < STRIKE_WINDOW_MS);
    if (this.strikes.length >= STRIKES_TO_RELAUNCH) {
      this.relaunch();
      return;
    }
    this.strikes.push(now);
    this.hooks?.toast(why === 'capture' ? 'Mic dead - app hears nothing, re-opening' : 'Mic feed died - re-opening', this.hooks.captureMic());
    this.heal(`${why} dead #${this.deadEvents}, strike ${this.strikes.length}/${STRIKES_TO_RELAUNCH}`);
  }

  /** The output side: signal expected (gate open / clip) and none on the cable. */
  private judgeOutput(now: number, fresh: boolean): 'dead' | 'alive' | 'unknown' {
    const expecting = fresh && this.expects(this.tel!);
    if (!expecting) { this.expectingSince = 0; return 'unknown'; }
    if (!this.expectingSince) this.expectingSince = now;
    if (!this.meterAlive(now)) return 'unknown'; // cannot judge blind; never heal on no evidence
    const silentFor = this.lastSignalAt ? now - this.lastSignalAt : now - this.expectingSince;
    if (silentFor < DEAD_AFTER_MS) return 'alive';
    if (now - this.expectingSince < DEAD_AFTER_MS) return 'unknown';
    return 'dead';
  }

  /**
   * The capture side, by signal: Windows' meter on the microphone endpoint says
   * someone is speaking into it; the app's analyser on the stream it opened from
   * that very endpoint says nothing. Several such moments in a row, none heard,
   * is a dead capture stream (2026-09-17 13:47). Judged only on ticks where the
   * mic is actually loud, so silence and a mic that is switched off are simply
   * "unknown", never dead.
   */
  private judgeCapture(now: number, fresh: boolean): 'dead' | 'alive' | 'unknown' {
    const t = this.tel;
    const micFresh = this.micLineAt > 0 && now - this.micLineAt < METER_SILENT_MS;
    if (!fresh || !t || !t.passthrough || !micFresh) { this.capWindow = []; return 'unknown'; }
    const heardLevel = t.peak ?? t.level;
    this.capWindow.push({ micLoud: this.micPeak > MIC_LOUD, heard: heardLevel >= RENDERER_QUIET });
    if (this.capWindow.length > CAPTURE_WINDOW_TICKS) this.capWindow.shift();
    if (this.capWindow.some(w => w.heard)) return 'alive';
    const loud = this.capWindow.filter(w => w.micLoud).length;
    if (loud >= CAPTURE_MIN_LOUD_TICKS) return 'dead';
    return 'unknown';
  }

  /**
   * The capture side: is the microphone delivering ANYTHING? Judged by the
   * renderer's own level meter reading exactly zero, so it needs no Windows
   * meter and works whether or not anyone is speaking. Heals by the same re-open
   * as the output side, but never counts towards a relaunch: a microphone that
   * is switched off looks identical, and restarting the app will not turn it on.
   */
  private judgeSilence(now: number, fresh: boolean): void {
    const t = this.tel;
    if (!fresh || !t || !t.passthrough) {
      // Nothing to judge (window gone, or the passthrough is off -- including the
      // ~1 s it is off during our own re-open). The clock restarts; the "judged"
      // flag stays, so a re-open that WORKS is logged when signal appears.
      this.captureSilentSince = 0;
      return;
    }
    if (t.level > 0) {
      if (this.captureSilentJudged) {
        this.log(`capture signal back after ${Math.round((now - this.captureSilentSince) / 1000)}s of silence`);
      }
      this.captureSilentSince = 0;
      this.captureSilentJudged = false;
      return;
    }
    if (!this.captureSilentSince) this.captureSilentSince = now;
    const silentFor = now - this.captureSilentSince;
    if (silentFor < CAPTURE_SILENT_MS) return;

    // A microphone CAN read exactly 0 for minutes. The Astro A50's own hardware
    // gate emits digital silence between words, so this heal re-opened a
    // perfectly good stream 1347 times between 09-17 and 09-19 (every 2 min,
    // all night), each re-open ~1.5 s of no mic. While the Windows meter on the
    // endpoint is alive, judgeCapture() is the authority (endpoint loud + app
    // deaf = dead, healed there); an endpoint that is itself silent is a quiet
    // room or a mic switched off, and a re-open cannot change that. Heal from
    // here only when that meter is blind and nothing else can judge.
    const micMeterAlive = this.micLineAt > 0 && now - this.micLineAt < METER_SILENT_MS;
    if (!this.captureSilentJudged) {
      this.captureSilentJudged = true;
      this.log(`SILENT  capture reads 0 for ${Math.round(silentFor / 1000)}s -- ${this.describe()}; ${micMeterAlive ? 'endpoint metered, leaving the stream alone' : 'mic meter blind, re-opening the microphone'}`);
    }
    // Silence can simply mean nobody is talking. Keep its fallback refresh and
    // recovery in the log; only proven dead-feed events above need a popup.
    if (micMeterAlive) return;
    if (now - this.lastCaptureHealAt < CAPTURE_HEAL_COOLDOWN_MS) return;
    this.lastCaptureHealAt = now;
    this.lastHealAt = now;
    this.captureHeals++;
    this.heal(`capture silent ${Math.round(silentFor / 1000)}s (#${this.captureHeals})`);
  }

  private recovered(why: string): void {
    const ms = Date.now() - this.deadSince;
    this.deadSince = 0;
    this.deadWhy = null;
    this.log(`healed  ${why} after ${Math.round(ms / 1000)}s`);
    this.hooks?.toast('Mic feed is back', this.hooks.captureMic());
  }

  private relaunch(): void {
    const last = this.stampAge();
    if (last !== null && last < RELAUNCH_COOLDOWN_MS) {
      // Relaunched recently and it is dead again: this is not a stuck stream,
      // keep re-opening and leave the trail for a human instead of looping.
      this.log(`stuck   dead again ${Math.round(last / 60_000)} min after a relaunch; not relaunching again yet`);
      this.strikes = [];
      return;
    }
    try { fs.writeFileSync(this.relaunchStamp, new Date().toISOString()); } catch { /* best effort */ }
    this.relaunches++;
    this.log(`RELAUNCH re-opening the passthrough ${STRIKES_TO_RELAUNCH} times did not bring the cable back; restarting the app`);
    this.hooks?.toast('Mic feed stuck - restarting CarbonBoard', null);
    setTimeout(() => {
      app.relaunch({ args: process.argv.slice(1).filter(a => a !== '--minimized').concat('--minimized') });
      app.exit(0);
    }, 1500);
  }

  private stampAge(): number | null {
    try { return Date.now() - fs.statSync(this.relaunchStamp).mtimeMs; } catch { return null; }
  }

  private describe(): string {
    const t = this.tel;
    if (!t) return 'no telemetry';
    return `gate=${t.gateOpen ? 'open' : 'closed'} level=${t.level} thr=${t.threshold} clips=${t.clips} mic=${this.hooks?.captureMic() ?? '?'}`;
  }

  // ── the meter ──────────────────────────────────────────────────────────────

  private spawnMeter(): void {
    this.killMeter();
    this.meterSpawns++;
    let child: ChildProcess;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
          '-EncodedCommand', Buffer.from(METER_PS.replace('__MICFILE__', this.micFile.replace(/'/g, "''")), 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      this.log(`meter   failed to spawn: ${(err as Error).message}`);
      setTimeout(() => this.spawnMeter(), 30_000);
      return;
    }
    this.meter = child;
    this.lastLineAt = Date.now(); // grace for Add-Type compile
    let buf = '';
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        this.onMeterLine(line);
      }
    });
    child.stderr?.on('data', (d: Buffer) => this.log(`meter   stderr: ${d.toString().trim().split('\n')[0]}`));
    child.on('exit', (code) => {
      if (this.meter !== child) return;
      this.meter = null;
      this.log(`meter   exited (${code}); respawn in ${Math.min(30, 5 * this.meterSpawns)}s`);
      setTimeout(() => { if (!this.meter && this.timer) this.spawnMeter(); }, Math.min(30_000, 5000 * this.meterSpawns));
    });
  }

  private onMeterLine(line: string): void {
    if (!line.startsWith('p=')) return;
    this.lastLineAt = Date.now();
    const mm = / m=(\S+)/.exec(line);
    if (mm) {
      const mv = Number(mm[1]);
      if (Number.isFinite(mv)) { this.micPeak = mv; this.micLineAt = this.lastLineAt; }
      else { this.micPeak = 0; this.micLineAt = 0; } // nf/err: no microphone to read; the capture judge stays blind
    }
    const v = line.split(' ')[0].slice(2);
    if (v === 'nf' || v === 'err') {
      // CABLE Input is not there (driver restart, mid re-enumeration). Say so
      // once per streak; the judge already refuses to act without a live meter.
      if (this.meterOpenFailures++ === 0) this.log(`meter   CABLE Input not readable (${v})`);
      this.cablePeak = 0;
      return;
    }
    if (this.meterOpenFailures) { this.log('meter   CABLE Input readable again'); this.meterOpenFailures = 0; }
    const p = Number(v);
    if (!Number.isFinite(p)) return;
    this.cablePeak = p;
    if (p > SIGNAL_FLOOR) this.lastSignalAt = this.lastLineAt;
  }

  private killMeter(): void {
    const m = this.meter;
    this.meter = null;
    if (m && !m.killed) { try { m.kill(); } catch { /* gone already */ } }
  }

  private log(msg: string): void {
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, `${new Date().toISOString()}  ${msg}\n`);
    } catch { /* never fail the watch over its own logging */ }
  }
}

/**
 * The renderer's console, on disk.
 *
 * Every mic bug so far has explained itself in the renderer console, and every
 * time it had to be reached by relaunching the app under a debugger after the
 * fact. Warnings, errors and anything mentioning the audio path are kept in
 * renderer.log, rotated at 2 MB, so the next failure comes with its own story.
 */
export function wireRendererLog(wc: WebContents, dataDir: string): void {
  const file = path.join(dataDir, 'renderer.log');
  const keep = /mic|passthrough|cable|audio|device|sink|gate|stream/i;
  const levels = ['debug', 'info', 'WARN', 'ERROR'];
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level < 2 && !keep.test(message)) return;
    try {
      try { if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* no file yet */ }
      const where = sourceId ? ` (${path.basename(sourceId)}:${line})` : '';
      fs.appendFileSync(file, `${new Date().toISOString()}  ${levels[level] ?? level}  ${message}${where}\n`);
    } catch { /* logging must never break the app */ }
  });
}
