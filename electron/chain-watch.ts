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
}

const SIGNAL_FLOOR = 0.001;      // ~-60 dBFS: a peak meter reads this on real audio, never on a dead stream
const DEAD_AFTER_MS = 3000;      // signal expected for this long with nothing on the cable
const HEAL_COOLDOWN_MS = 20_000; // one re-open per this window, so a bad state cannot flap the mic
const STRIKES_TO_RELAUNCH = 3;   // heals that failed inside STRIKE_WINDOW_MS before the app restarts itself
const STRIKE_WINDOW_MS = 10 * 60_000;
const RELAUNCH_COOLDOWN_MS = 30 * 60_000;
const METER_SILENT_MS = 6000;    // no line from the meter for this long = it is dead, respawn it

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
  public static object Open(string want){
    var e=(IE)(new EE()); IC c; e.EnumAudioEndpoints(0,1,out c); int n; c.GetCount(out n);
    for(int i=0;i<n;i++){ ID d; c.Item(i,out d); IP ps; d.OpenPropertyStore(0,out ps);
      PK k=new PK(); k.f=new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); k.p=14; PV v; ps.GetValue(ref k,out v);
      string nm=Marshal.PtrToStringUni(v.p);
      if(nm!=null && nm.IndexOf(want,StringComparison.OrdinalIgnoreCase)>=0){
        Guid iid=new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"); object o; d.Activate(ref iid,23,IntPtr.Zero,out o); return o; } }
    return null;
  }
  public static float Peak(object o){ float p; ((IMeter)o).GetPeakValue(out p); return p; }
}
"@
$m = $null
$opened = [datetime]::MinValue
$inv = [Globalization.CultureInfo]::InvariantCulture
while ($true) {
  # Re-open every minute regardless: a meter on an endpoint Windows has since
  # re-enumerated keeps returning 0 forever and would read as a dead feed.
  if ($m -eq $null -or ((Get-Date) - $opened).TotalSeconds -ge 60) {
    try { $m = [CableMeter]::Open('CABLE Input') } catch { $m = $null }
    $opened = Get-Date
  }
  if ($m -eq $null) { [Console]::Out.WriteLine('p=nf') }
  else { try { [Console]::Out.WriteLine('p=' + [CableMeter]::Peak($m).ToString($inv)) } catch { $m = $null; [Console]::Out.WriteLine('p=err') } }
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
  }

  start(hooks: ChainHooks): void {
    this.hooks = hooks;
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
    };
  }

  // ── the judge ──────────────────────────────────────────────────────────────

  private expects(t: MicTelemetry): boolean {
    return t.passthrough && (t.gateOpen || t.clips > 0);
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

    const fresh = !!this.tel && now - this.telAt < 3000;
    const expecting = fresh && this.expects(this.tel!);
    if (!expecting) {
      this.expectingSince = 0;
      // Signal seen while nothing was expected is fine (Discord's own test, a
      // browser tab); it just proves the cable alive.
      if (this.deadSince && now - this.lastSignalAt < DEAD_AFTER_MS) this.recovered('signal returned');
      return;
    }
    if (!this.expectingSince) this.expectingSince = now;

    if (!this.meterAlive(now)) return; // cannot judge blind; never heal on no evidence

    const silentFor = this.lastSignalAt ? now - this.lastSignalAt : now - this.expectingSince;
    const expectingFor = now - this.expectingSince;
    const alive = silentFor < DEAD_AFTER_MS;

    if (alive) {
      if (this.deadSince) this.recovered('signal returned');
      return;
    }
    if (expectingFor < DEAD_AFTER_MS) return;

    // Dead: something should be on the cable and has not been for DEAD_AFTER_MS.
    if (!this.deadSince) {
      this.deadSince = now;
      this.deadEvents++;
      this.lastDeadAt = new Date(now).toISOString();
      this.log(`DEAD    ${this.describe()} -- cable silent ${Math.round(silentFor / 1000)}s while signal expected`);
    }
    if (now - this.lastHealAt < HEAL_COOLDOWN_MS) return;

    this.strikes = this.strikes.filter(s => now - s < STRIKE_WINDOW_MS);
    if (this.strikes.length >= STRIKES_TO_RELAUNCH) {
      this.relaunch();
      return;
    }
    this.strikes.push(now);
    this.hooks?.toast('Mic feed died - re-opening', this.hooks.captureMic());
    this.heal(`dead #${this.deadEvents}, strike ${this.strikes.length}/${STRIKES_TO_RELAUNCH}`);
  }

  private recovered(why: string): void {
    const ms = Date.now() - this.deadSince;
    this.deadSince = 0;
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
          '-EncodedCommand', Buffer.from(METER_PS, 'utf16le').toString('base64')],
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
    const v = line.slice(2);
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
