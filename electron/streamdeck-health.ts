// Stream Deck health: notice a deck the Stream Deck app has given up on, and fix it in one click.
//
// WHY (2026-11-13)
// ----------------
// At 12:54 a USB hub on the rig re-enumerated and both decks dropped. The Stream
// Deck+ came back; the 15-key MK.2 -- the one carrying every audio-profile key --
// failed its first re-open ("Preheat  Read FW version: FAILED", "Problem with
// connecting HID device: -1"), the app purged it, and it never tried again. Windows
// listed the device as present and OK the whole time, so nothing looked wrong: the
// keys simply did nothing for hours. A restart of that one USB device (or of the
// Stream Deck app) brought it straight back.
//
// So this module does two things, both cheap and both off the click path:
//   - reads the TAIL of Stream Deck's own log (the only place that knows the app
//     dropped a deck Windows still sees) and reports a deck that is plugged in but
//     not open as `stuck`;
//   - restarts the Stream Deck app on request -- no admin needed, unlike pnputil --
//     launched through Win32_Process.Create so it lives outside any job object
//     (the same reason _watchdog.ps1 starts CarbonBoard that way), then reads the
//     fresh log to say which decks actually came back.

import { app } from 'electron';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface DeckState {
  /** Stream Deck's own id, e.g. `@(1)[4057/128/DL27L2A87911]`. */
  id: string;
  name: string;
  serial: string;
  /** Plugged in, as far as the app's log knows (null: never seen attach or detach). */
  present: boolean | null;
  /** The app has the device open and is driving it. */
  open: boolean;
  /** When the app last lost it (ms), for "dropped at 12:55". */
  droppedAt: number | null;
  /** The last event of any kind for this deck (ms). */
  at: number;
}

export interface RestartResult {
  ok: boolean;
  error?: string;
  /** Decks that answered after the restart. */
  back: string[];
  /** Decks that were plugged in before and still are not open. */
  missing: string[];
}

/** USB product ids (decimal, as Stream Deck writes them) of the Elgato decks we know. */
const MODELS: Record<number, string> = {
  0x60: 'Stream Deck',
  0x63: 'Stream Deck Mini',
  0x6c: 'Stream Deck XL',
  0x6d: 'Stream Deck',
  0x80: 'Stream Deck MK.2 (15 keys)',
  0x84: 'Stream Deck +',
  0x86: 'Stream Deck Pedal',
  0x8f: 'Stream Deck XL',
};

/** A plugged-in deck that has not been open this long is stuck, not just mid-reconnect. */
const STUCK_AFTER_MS = 8_000;
/** Enough tail to cover a day of an idle log; the whole file can grow for weeks. */
const TAIL_BYTES = 1024 * 1024;
const VERIFY_TIMEOUT_MS = 25_000;

export function logPath(): string {
  return path.join(app.getPath('appData'), 'Elgato', 'StreamDeck', 'logs', 'StreamDeck.log');
}

function readTail(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function deckName(id: string): { name: string; serial: string } {
  const m = /\[(\d+)\/(\d+)\/([^\]]+)\]/.exec(id);
  if (!m) return { name: 'Stream Deck', serial: id };
  const pid = Number(m[2]);
  const serial = m[3]!;
  return { name: MODELS[pid] ?? `Stream Deck (${serial.slice(-4)})`, serial };
}

// Each line starts with its own timestamp: `2026-11-13T12:55:38.334-06:00  43172-49108  ...`.
const ID = '(@\\(1\\)\\[4057\\/[^\\]]+\\])';
const RULES: Array<{ re: RegExp; apply: (s: DeckState) => void; drop?: boolean }> = [
  { re: new RegExp(`device status changed ${ID}: connected`), apply: s => { s.present = true; s.open = true; } },
  { re: new RegExp(`device status changed ${ID}: disconnected`), apply: s => { s.open = false; }, drop: true },
  { re: new RegExp(`device purged ${ID}`), apply: s => { s.open = false; }, drop: true },
  // The app saw it, tried to open it and failed: it IS plugged in.
  { re: new RegExp(`Problem with connecting HID device ${ID}`), apply: s => { s.present = true; s.open = false; }, drop: true },
  { re: new RegExp(`device attached ${ID}`), apply: s => { s.present = true; } },
  { re: new RegExp(`device detached ${ID}`), apply: s => { s.present = false; s.open = false; } },
];

/**
 * Every USB deck the log mentions, replayed event by event. Pure: `sinceMs`
 * ignores lines before a moment (used after a restart, so the old app's last
 * words cannot read as the new app's state).
 */
export function parseDeckLog(text: string, sinceMs = 0): Map<string, DeckState> {
  const decks = new Map<string, DeckState>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('4057/')) continue;
    const at = Date.parse(line.slice(0, 29));
    if (!Number.isFinite(at) || at < sinceMs) continue;
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const id = m[1]!;
      let s = decks.get(id);
      if (!s) {
        const { name, serial } = deckName(id);
        s = { id, name, serial, present: null, open: false, droppedAt: null, at };
        decks.set(id, s);
      }
      const wasOpen = s.open;
      rule.apply(s);
      if (rule.drop && wasOpen) s.droppedAt = at;
      s.at = at;
      break;
    }
  }
  return decks;
}

/** Plugged in, not open, and not merely in the middle of opening. */
export function isStuck(s: DeckState, now = Date.now()): boolean {
  return s.present === true && !s.open && now - s.at > STUCK_AFTER_MS;
}

export function readDecks(): DeckState[] {
  try {
    return [...parseDeckLog(readTail(logPath())).values()];
  } catch {
    return []; // No Stream Deck app, or no log yet: nothing to report.
  }
}

// ── restarting the app ───────────────────────────────────────────────────────

// Win32_Process.Create starts StreamDeck.exe in the WMI host -- outside any job
// object, same session -- so it outlives this PowerShell and CarbonBoard itself.
// `--runinbk` is how the Run key starts it: in the tray, no window over a game.
const RESTART_PS = String.raw`
$ErrorActionPreference = 'Stop'
function Out($o) { $o | ConvertTo-Json -Compress; exit }
$sd = @(Get-Process StreamDeck -ErrorAction SilentlyContinue)
$exe = ($sd | Where-Object Path | Select-Object -First 1).Path
if (-not $exe) { $exe = Join-Path $env:ProgramFiles 'Elgato\StreamDeck\StreamDeck.exe' }
if (-not (Test-Path $exe)) { Out @{ ok = $false; error = 'Stream Deck is not installed' } }
$ids = @($sd | ForEach-Object Id)
$kids = @()
if ($ids.Count) { $kids = @(Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ParentProcessId }) }
$sd | Stop-Process -Force -ErrorAction SilentlyContinue
$kids | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
for ($i = 0; $i -lt 40 -and (Get-Process StreamDeck -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }
if (Get-Process StreamDeck -ErrorAction SilentlyContinue) { Out @{ ok = $false; error = 'Stream Deck would not close' } }
$started = $false
try {
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('"{0}" --runinbk' -f $exe) }
  $started = ($r.ReturnValue -eq 0)
} catch { }
if (-not $started) { Start-Process explorer.exe -ArgumentList ('"{0}"' -f $exe) }
for ($i = 0; $i -lt 60 -and -not (Get-Process StreamDeck -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }
if (-not (Get-Process StreamDeck -ErrorAction SilentlyContinue)) { Out @{ ok = $false; error = 'Stream Deck did not start again' } }
Out @{ ok = $true; killed = $ids.Count; plugins = $kids.Count }
`;

function runPs(script: string, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    const child = execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        const line = String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
        if (line) {
          try { resolve(JSON.parse(line)); return; } catch { /* fall through */ }
        }
        resolve({ ok: false, error: (String(stderr).trim().split('\n')[0] || err?.message || 'no answer').slice(0, 160) });
      },
    );
    child.on('error', e => resolve({ ok: false, error: e.message }));
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let restarting = false;
export function isRestarting(): boolean { return restarting; }

/**
 * Restart the Stream Deck app, then wait for every deck that was plugged in
 * before to report itself open in the NEW log. The answer is what the app says,
 * not that a process exists.
 */
export async function restartStreamDeck(log: (msg: string) => void = () => {}): Promise<RestartResult> {
  if (restarting) return { ok: false, error: 'Already reconnecting', back: [], missing: [] };
  restarting = true;
  try {
    const before = readDecks().filter(d => d.present !== false);
    const t0 = Date.now();
    log(`restart: before ${before.map(d => `${d.name}=${d.open ? 'open' : d.present ? 'stuck' : '?'}`).join(', ') || 'no decks in log'}`);
    const r = await runPs(RESTART_PS, 40_000);
    if (!r.ok) {
      log(`restart: FAILED ${r.error}`);
      return { ok: false, error: r.error, back: [], missing: before.map(d => d.name) };
    }
    // Stream Deck rotates its log at start, so the fresh file holds only the new app.
    const want = new Set(before.map(d => d.id));
    let after = new Map<string, DeckState>();
    while (Date.now() - t0 < VERIFY_TIMEOUT_MS) {
      await sleep(1000);
      try { after = parseDeckLog(readTail(logPath()), t0); } catch { continue; }
      const open = [...after.values()].filter(d => d.open);
      if (want.size ? [...want].every(id => after.get(id)?.open) : open.length > 0) break;
    }
    const back = [...after.values()].filter(d => d.open).map(d => d.name);
    const missing = before.filter(d => !after.get(d.id)?.open).map(d => d.name);
    log(`restart: back [${back.join(', ')}] missing [${missing.join(', ')}] in ${Date.now() - t0}ms`);
    return { ok: missing.length === 0, back, missing };
  } finally {
    restarting = false;
  }
}

// ── watching ─────────────────────────────────────────────────────────────────

/**
 * Re-read the log only when it changed, and call `onStuck` once per deck per
 * episode (a deck that comes back and drops again warns again).
 */
export function watchDecks(onStuck: (d: DeckState) => void, everyMs = 10_000): () => DeckState[] {
  let mtime = 0;
  let decks: DeckState[] = [];
  const warned = new Set<string>();
  const tick = () => {
    try {
      const m = fs.statSync(logPath()).mtimeMs;
      if (m !== mtime) { mtime = m; decks = readDecks(); }
    } catch { decks = []; }
    for (const d of decks) {
      if (d.open || d.present === false) warned.delete(d.id);
      else if (isStuck(d) && !warned.has(d.id) && !restarting) { warned.add(d.id); onStuck(d); }
    }
  };
  tick();
  setInterval(tick, everyMs);
  return () => decks;
}
