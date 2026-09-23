# CarbonBoard

## Build & Release

- Build installer: `npm run build && npx electron-builder --win`
- Installer output: `dist/CarbonBoard Setup 1.0.0.exe`
- When rebuilding the installer, always upload it to the GitHub release (`gh release`)

## Groups: one tile that flies out (2026-09-18)

A **group** (`sub_categories`, "Add Group" inside a category) is, by default, ONE tile on the
board — a stacked square showing up to four of its members' art and a count. Clicking it opens
a **flyout** anchored to the tile with every member as a normal `SoundCard` (click plays; the
flyout stays open so you can fire several); **shift-click** the tile, the dice on it, or
**Random** in the flyout plays a random member (never the same one twice in a row). Right-click:
Open / Play random / Rename / Show inline / Delete. "Show inline" (`collapsed = false`) turns
it back into the old header-plus-section layout, and the section header's collapse arrow
reverses it. The row (list-view) form opens the same flyout. Component: `src/components/GroupStack.tsx`;
wiring in `SoundGrid.tsx` (stacks render ahead of the ungrouped sounds; a sound dragged onto a
stack joins it; dropping on the board around it ungroups).

The phone remote (`electron/web-remote.html`) draws the same stacks, opening a bottom sheet
with the members and a RANDOM button. `/api/categories` carries `collapsed` per sub-category.

**The clip server owns groups too.** A server clip may carry `group` (`server/server.js`,
POST/PATCH `/api/clips`), and `clip-sync.ts` maps it to a sub-category by name inside the
clip's category — created collapsed on first sight. The console's Edit-clip sheet sets it. Sync
writes `subCategoryId` only when the server names a group (`COALESCE`), so a sound dragged into
a purely local group stays there. Groups' names are the only thing not stored per clip: rename
one on the desktop and the server's `group` string is unchanged, so the next sync creates the
old name again — rename from the console (edit each clip) if the group came from the server.

**Drag to combine / drop into a flyout.** Dragging a sound onto the MIDDLE of another card
(inner 50%) shows "Group together" and drops the pair into a new group (rename asked at once),
or into the target's existing group; the edges still reorder. Dropping into an open flyout, or
onto the tile, joins that group; dragging a member out of the flyout onto the board ungroups it.

**Tile size** (the resize glyph in the board header): width in px drives `repeat(auto-fill,
minmax(W, 1fr))`, height is the art area in px (tiles can be wide, tall or square); both live
in settings (`tileWidth`, `tileHeight`, 0 = the responsive default).

**The renderer must reload the LIBRARY on `settings:updated`**, not just settings — the
clip-server sync sends that same signal when it adds rows, and until 2026-09-18 the window kept
its boot-time list: a clip synced after launch was invisible on the board and, because
`hotkey:triggered` looked the id up in that stale list, `/api/play-clip` answered `success`
while nothing played. That is exactly how the fresh dog barks "never played" while every older
clip did. The hotkey handler now also fetches an unknown id from main before giving up.

**Seek** rides on `POST /api/pause` as `action: "seek:<seconds>"` (position within the trimmed
clip) because the node agent forwards only `action`/`soundId`/`clipId` to that route; the
console's transport bar uses it (click or drag the progress line).

The clip server also stores `imagePos {x,y}` (percent, null = centre) — where the button art's
subject is, applied as `object-position` on the console's cover-cropped tiles and set from the
console's Edit-clip crop control. CarbonBoard's own thumbnails are separate files and do not
read it (yet).

## The microphone chain (read before touching anything in `src/lib/store.tsx`)

The app is the only thing between the physical microphone and Discord: it captures one
mic and renders it into CABLE Input, which every other app listens to. So **the app must
hold exactly one capture stream at a time**, and that stream must always be reachable
from `micStreamRef` G�� a stream nothing holds a reference to can never be stopped again,
and it keeps the device open for the life of the process.

Two things used to break that invariant, and both are fixed (2026-09-11):

- `startMicPassthrough` stops the existing stream *before* it awaits `getUserMedia`, so
  two overlapping calls each opened a stream and only the last one was stored. Many
  things can overlap it: two `devicechange` listeners, the 30 s health check, the
  retry timers, the track-ended recovery, and the profile-switch effects. It is now
  serialised by `micStartGenRef` G�� a start that has been superseded closes the stream it
  just opened, and `stopMicPassthrough` invalidates anything still in flight. **Keep the
  generation check immediately after every `getUserMedia` await.**
- `refreshAudioDevices` opened a real (arbitrary, non-cable) microphone on *every*
  `devicechange` and every 30 s health check, purely to unlock the device labels that
  `enumerateDevices()` hides until the page has held a mic once. That permission is
  granted once and stays granted, so it now probes only while the labels are still
  hidden. **Do not make that probe unconditional again.**

The symptom when it goes wrong is not subtle in the logs and invisible in the UI: the app
reports a healthy mic while the audio-session list shows CarbonBoard holding two capture
devices. On 2026-09-11 it held the Astro A50 headset mic for half an hour after the
profile had moved to the Insta360.

### `micwatch.ps1` G�� the watchdog

Runs every 5 minutes from a scheduled task, in the **interactive session** (session 0 sees
no audio sessions at all). It does not ask the app how it is doing: it reads the Windows
audio sessions via `_who2.ps1` and compares them with the profile the app says is active.
On a mismatch it re-applies the profile; if that does not clear it, it **restarts
CarbonBoard**, because re-applying a profile cannot close an orphaned stream G�� only
ending the process can. A 30-minute cooldown (`micwatch.restart`) keeps a genuinely
broken machine from restart-looping; past that it falls back to a `msg.exe` box.
Log: `micwatch.log`.

### `micguard.ps1` — keeping the Cetra's own mic disabled

The ROG Cetra True Wireless SpeedNova carries playback and microphone over one 2.4 GHz
link, and the buds drop that link to a mono narrowband telephony profile the moment
**anything** opens their microphone — playback immediately goes tinny and robotic.
Muting does not help: a muted stream is still an open stream. That mic is never wanted
here, because the "In Ear" profile pairs the Cetras with the Insta360 lapel. So the cure
is to keep the Cetra **capture** endpoint disabled and let nothing open it.

Disabling it by hand does not stick, which is the whole reason this script exists.
Windows stores the disabled flag per **device instance**, and the instance path contains
the USB port the dongle is in — so moving the dongle to another port enumerates a
brand-new, *enabled* endpoint and the tinny audio is back. `micguard.ps1` re-applies it
every minute from the `CetraMicGuard` scheduled task (SYSTEM, highest, 1-minute
repetition). Unlike `micwatch` it does not need the interactive session: PnP is
session-agnostic, only audio *sessions* are not.

Safety rail, do not remove it: under `SWD\MMDEVAPI` a render endpoint is `{0.0.0.*}` and
a capture endpoint is `{0.0.1.*}`. A target must match `{0.0.1.*}` **and** a name pattern
in `$blocked`, so the guard cannot disable the headphones themselves — the worst a bad
pattern can do is mute a microphone. Add a device by adding a pattern; do **not**
blocklist the Astro A50, whose mic the "Headphones" profile genuinely uses.

It logs only when it acts or fails (`micguard.log`); the task's Last Run Time is the
liveness proof. Verified end to end on 2026-09-12 by re-enabling the endpoint by hand and
watching the guard put it back within 60 s.

One diagnostic trap, because it cost an hour on 2026-09-12: the symptom was first blamed
on CarbonBoard holding the wrong microphone, on the strength of the Windows per-app
privacy flag (`CapabilityAccessManager\ConsentStore\microphone`, `LastUsedTimeStop == 0`).
**That flag is per app, not per device** — it says an app has *a* mic open, never which
one. Two days of `micwatch.log` and the live audio-session list both showed CarbonBoard
holding only the Insta360. Use `_who2.ps1` (endpoint to PID, ground truth) instead, and
remember it must run in the interactive session.

### The feed can die below JavaScript, and nothing above it can tell — 2026-09-15

For 75 minutes the passthrough was "healthy" by every check that existed: the right mic
captured, the AudioContext running, the `<audio>` element playing, CarbonBoard listed in the
Windows session list rendering into CABLE Input, `micwatch.log` saying `ok` every five
minutes. Peak meters on the CABLE Input endpoint read exact digital silence the whole time —
for clips as well as the mic — and Rober had to point Discord at the headset directly.

Chromium shares **one physical output stream per device** across every element routed to it
(the mixer behind `setSinkId`). That stream died when the 08:52 profile switch restarted the
Windows audio engine, and it stayed dead: "playing" is a property of the element, not of the
audio, so every element routed to the cable — the passthrough and every clip — played into
nothing. Re-applying the same profile does not restart the passthrough (same label, nothing
to change), so the key press at 10:06 changed nothing either. Stopping the passthrough,
waiting, and starting it again rebuilt the sink and everything flowed.

The cure is now automatic, and it works by **signal, not state** (`electron/chain-watch.ts`):

- A resident PowerShell meter reads `IAudioMeterInformation` on the CABLE Input endpoint five
  times a second (re-opened every minute, because a meter on a re-enumerated endpoint reads
  0 forever). The renderer reports every 500 ms whether anything *should* be on the cable:
  gate open (someone speaking) or a clip playing.
- Signal expected for 3 s with nothing on the cable = dead. Heal = `mic:restart` to the
  renderer, which stops every clip, stops the passthrough, waits 800 ms and starts it. Clips
  are stopped on purpose: anything still routed to the cable keeps the dead stream referenced.
- One heal per 20 s; three failed heals inside ten minutes relaunch the app (a fresh audio
  service is all that is left to try), with a 30-minute cooldown stamp (`chain.relaunch`) so
  it cannot loop. It never acts without a live meter reading.
- Trail: `carbonboard-data/chain.log` (events only), and **`renderer.log`** — the renderer
  console (warnings, errors, anything mentioning the audio path) is now on disk, so the next
  silent failure comes with its own story instead of a CDP relaunch after the fact.
- `GET /api/audio/status` carries a `chain` block (`meterAlive`, `cablePeak`,
  `cableSignalAgoMs`, `expecting`, `gateOpen`, `level`, `stuckForMs`, `deadEvents`,
  `relaunches`) and `POST /api/audio/passthrough/restart` is the manual handle. `micwatch.ps1`
  logs the chain summary on every run, re-opens the passthrough as part of its heal, and
  escalates to an app restart when `stuckForMs` passes 90 s.

### The gate chopped words, and called it a dropout -- 2026-09-15 (later the same day)

The chain watch above answers "is the cable dead"; it says nothing about a cable that is
alive and carrying half of every sentence. The noise gate (`updateLevel` in `src/lib/store.tsx`)
closed the instant the level fell below `threshold - 15` and re-opened only once the next word
was already above `threshold`. Speech is full of 100-300 ms holes below any sane threshold,
so each one cut the cable and cost the first consonant of the next word -- which on the far
end of a Discord call is "the mic keeps dropping out". Discord then ran its own VAD on top of
the chopped signal.

- The gate now HOLDS 400 ms before closing (any sample back above the close threshold resets
  the clock), opens in 5 ms and releases over 60 ms, with every ramp scheduled from the current
  gain so an open cannot fight a half-finished close.
- The noise floor is sampled only once the gate has been closed for 600 ms; before, the tail
  of the last word went into the floor and dragged the threshold up mid-conversation.
- The floor is capped at 25 (threshold at 50). A gate that can no longer open is the worse
  failure: noise that gets through meets Discord's Krisp, speech that does not is simply gone.
- Every open and close is logged to `renderer.log` (`gate open lvl=.. thr=.. quiet-for=..ms`,
  `gate closed after ..ms open`). Read that first on the next "dropping out" report: many
  short opens with sub-second `quiet-for` gaps means the gate is still chopping; no lines at
  all while he is talking means the level never reaches the threshold (floor too high, or the
  wrong microphone); a healthy conversation is opens of seconds separated by gaps of seconds.
- The rest of the chain is unchanged: `micNoiseSuppression` (Chromium NS) stays on, Discord
  keeps its own sensitivity. If the gate still gets in the way, the honest next step is to turn
  it OFF (manual mode, threshold 0) and let Discord be the only gate -- but `expects()` in
  `chain-watch.ts` uses `gateOpen`, so an always-open gate must be paired with a level-based
  "expecting" or the watch will judge every quiet moment a dead feed and re-open the mic every
  20 s.

Diagnosing this by hand: `_who3.ps1` (interactive session only) lists every audio session
with its volume, mute and a peak meter, plus the endpoint meters and the default device per
role. **Do not play clips as a test** — the cable is Discord's microphone, everyone on the
call hears it. Let his own speech be the signal: a peak on the headset capture session with
nothing on CABLE Input is the proof.

### "Virtual mic through the A50 broken again" with every check green (2026-09-19)

Sessions were right (CarbonBoard held `Headset Microphone (3- Astro A50 Voice)`, rendered to
CABLE Input, the game held CABLE Output), the chain watch said alive, `micwatch` said `ok` --
and he could not be heard. Two faults, neither in the app's routing:

1. **The Windows endpoint volumes had been lowered.** The A50 Voice capture endpoint sat at
   **50%** and CABLE Output at **48%**. Speech reached the app at ~-36 dBFS and read **15-18**
   on the gate (threshold 12) where it read 28-45 on 09-17, so the gate opened four times in
   eighteen hours. Nothing in this app touches endpoint volume; something else lowers it (a
   game's mic slider, Discord's sensitivity, a driver re-enumeration -- unknown). Fixed by
   setting both to 100% from the interactive session (`_setvol.ps1`), and **held** from now on:
   `volguard.ps1` runs inside every `micwatch.ps1` pass and restores the active mic endpoint
   and CABLE Output to unity, logging `volume  restored <endpoint>  was 50% -> 100%` when it
   had to. That log line is the evidence for whatever is lowering it; read `micwatch.log` for
   it before blaming the app again. (Endpoint volume is the WINDOWS level -- distinct from the
   app's own `micVolume` gain and from the session volume a game sets on itself.)
2. **The capture-silence heal re-opened a healthy stream every 2 minutes, 1347 times.**
   `judgeSilence()` in `chain-watch.ts` assumed a live microphone never reads exactly 0. The
   A50's own hardware gate emits digital silence between words, so every quiet 45 s became a
   "silent capture" and every 2 min a re-open (~1.5 s of no mic each, and a word lost if he
   started talking into one). It now heals only when the Windows meter on the mic endpoint is
   **blind**; while that meter is alive, `judgeCapture()` (endpoint loud + app deaf) is the
   only judge, and a silent endpoint is left alone and reported as `silent` in the tray.

Diagnose in this order next time: `_who3.ps1` from the interactive session (which app holds
CABLE Output -- on 09-19 it was **bf6**, not Discord, which had no voice session at all), the
**endpoint `vol=`** column on the mic and on CABLE Output, then `gate open lvl=` in
`renderer.log` against the 28-45 a healthy A50 reads, then `chain.log` heal cadence.

## Playback transport + loudness over the HTTP API (2026-09-15)

- `GET /api/playing` (also embedded as `playback` in `/api/audio/status`, which is what the
  Cortex gateway's existing `soundboard.audio_status` RPC reads): every clip playing right
  now — `id`, `clipId` (the clip-server id, what the console keys its tiles on), `name`,
  `position`, `duration` (both in trimmed seconds), `paused`, `startedAt` — plus
  `allowConcurrentPlayback`, `masterVolume`, `monitorVolume`. The renderer reports it over
  `playback:state` 4x a second while anything plays (`store.tsx`, next to the mic
  telemetry); a report older than 3 s is answered as empty rather than frozen.
- `POST /api/pause` and `POST /api/stop` now take an optional body `{ action?: pause|resume|toggle,
  soundId? | clipId? }` — one clip while several are layered. No body = the old behaviour
  (toggle the last-started clip / stop everything). Delivered to the renderer as
  `playback:control`.
- **Loudness past 100%.** An `<audio>` element caps at 1.0, so `playSound` now routes each
  clip through its own `AudioContext` + `GainNode` (`attachGain`), `setSinkId` on the
  context for device routing, and the master/monitor sliders go to **400%**
  (`clampGain`, ceiling 8 = 2x clip boost x 4x master; past 0 dBFS it clips on purpose).
  When a sink refuses a context (an older Chromium, or a special id like `communications`)
  it falls back to the element path, clamped to 100% as before. Contexts are closed when the
  clip ends or is stopped, so the chain-watch heal (`stopAllSounds`) still releases the
  cable's shared output stream.

### CarbonBoard did not start at logon (2026-09-16) — what the logs could and could not say

Boot 09:38:29, logon 09:39:07, `micwatch` popped "CarbonBoard is not running - your Discord mic is
dead" at 09:40:37 and then did nothing; `_watchdog.ps1` (logon trigger, repeat 2 min) started it at
09:40:35. Nothing from the app itself between logon and that start — no renderer.log, no chain.log
"start watching" — so the main process either never launched from the Run key or died before
`whenReady`, and there was no main-process log to say which. Three changes:
- `electron/main.ts` `bootLog()` → `carbonboard-data/main.log`: start (version, exe, argv), lock
  handoff, ready, before-quit, render/child-process-gone, uncaught errors. **Read this first** the
  next time the app is missing at logon.
- `micwatch.ps1` DOWN branch now STARTS CarbonBoard (or restarts a hung one) and waits for :9502
  before it will pop a message box.
- `CarbonBoardWatchdog` task: logon trigger with a 30 s delay, repeating every 1 min (was no delay,
  2 min); `_watchdog.ps1` logs every run (`ok pid=… since …` / `restarted`).

### The tray icon is the mic's control panel (2026-09-17)

`electron/tray.ts`. Left- or right-click the CarbonBoard icon in the notification area
(bottom-right of Windows) for the mic feed's controls, built fresh on every open from
in-memory caches so it pops instantly:

- **Header** — the chain's verdict (`ChainWatch.verdict()`): `● Mic feed OK - <mic>`,
  `✕ Mic feed DEAD for Ns`, `✕ Mic silent for Ns`, `✕ Mic feed: no word from the app
  window`, `○ Mic feed OFF`. The same verdict paints a **dot on the icon** (red = dead or
  silent, amber = blind or muted, none = fine) and the tooltip, refreshed every 2 s, so a
  dead feed is visible before anyone on the call has to say so.
- **Restart mic feed** = `chain.heal('tray')`: the same re-open the watch does on its own.
- **Re-pin cable as the Windows mic** = `ensureCablePinned` + `ensureCableFormat`.
- **Profile ▸** radio list from `audio-profiles.json` → `applyProfile` (+ toast).
- **Microphone ▸** every active capture endpoint except the cable → `setCaptureMic(label)`;
  the renderer follows the label and re-opens the stream. **Headphones / speakers ▸** every
  active render endpoint except CABLE Input → `setDefaultOutput`; the device watch then
  adopts a matching profile as if a Stream Deck key had done it. Lists come from
  `audioRig.listDevices()` (now a real `ListNames` enumeration, refreshed every 30 s in the
  background; "Refresh list" forces it).
- **Mute mic** (checkbox) flips `micPassthroughEnabled`. Then Show / Stop all / Open logs
  folder / **Restart CarbonBoard** (`app.relaunch`) / Quit.

### The capture side can die too, and nothing judged it (2026-09-17)

The mic sat dead from 2026-09-16 12:47 to 2026-09-17 13:18 — no gate open in `renderer.log`
for 24 hours, `micwatch` "ok" every five minutes, `chain.log` empty — because the chain watch
only judged the OUTPUT: signal expected (gate open or a clip) and none on the cable. A capture
stream that delivers exactly zero never opens the gate, so nothing was ever "expected" and the
feed read healthy. A profile flip (which re-opens the passthrough) fixed it by hand.

`judgeCapture()` in `chain-watch.ts` closes that: with the passthrough on, the renderer's own
level meter reading **exactly 0 for 45 s** is a capture carrying nothing (a live mic on this rig
never reads below 5 even between words). It re-opens the passthrough at most every 2 min,
and **never counts towards a relaunch**. As of 2026-09-19, this fallback only re-opens
when the Windows mic meter is blind; a metered, quiet microphone is left alone. As of
2026-09-23, silence and its recovery are log-only: no "Mic is silent" / "Mic is live again"
popups, since not talking is normal. Automatic refresh timing, tray status, and proven
dead-feed/recovery alerts remain unchanged. `chain.log` lines: `SILENT  capture reads 0 for Ns …`, `capture signal
back after Ns`. `/api/audio/status` → `chain.captureSilentForMs` / `captureHeals`; `micwatch`
logs `capture=signal|SILENT-Ns` on every run.

### The capture side, judged by signal too (2026-09-17, later the same day)

The exact-zero rule above did not catch the next one. 13:47: `_who3` showed the Insta360
endpoint peaking at -17 dBFS with CarbonBoard its only session, while CarbonBoard's analyser
read 0-3 of 100 and CABLE Input carried nothing. A dead Chromium capture stream still has a
little dither, so it never reads exactly 0. `mic:restart` (a re-open) did not fix it; killing
and relaunching the app did — same class as the 09-15 output death, one layer over.

So the capture side is now judged the way the output side is, by **signal against signal**:

- The resident meter reads TWO endpoints: CABLE Input (render) and the profile's capture mic
  (capture, by label from `carbonboard-data/chain.mic`, which `syncMicFile()` rewrites when the
  profile's mic changes; the meter re-opens on a change and every 60 s).
- `judgeCapture()`: on ticks where the mic endpoint is loud (> -30 dBFS) and the app's `peak`
  (max analyser level since its last report — `store.tsx` telemetry) is under 10, that tick is
  "unheard". Four loud ticks in six seconds, all unheard = **dead capture**. Any heard tick =
  alive. Quiet mic = unknown, so silence and a mic that is off never count.
- Output-dead and capture-dead share ONE escalation: re-open (20 s cooldown), three strikes in
  ten minutes → `app.relaunch` (30 min cooldown). `chain.log` says which: `DEAD    capture --
  mic endpoint peak=0.141 while the app's stream reads 3`. Status carries `micPeak`,
  `micMeterAlive`, `deadWhy`; the tray header reads "Mic DEAD - app hears nothing".
- The exact-zero rule stays as `judgeSilence()` (re-open only, never a relaunch).

Ground truth for the next one is still `_who3.ps1` from the desktop session: the Insta360
row with a peak and the CABLE Input row at 0.0000 is the whole diagnosis. Discord itself was
fine that afternoon once its Input Device was put back on CABLE Output — it had been moved
to the lapel directly as a workaround, which is why "the virtual mic isn't showing" looked
like a Discord problem first.
