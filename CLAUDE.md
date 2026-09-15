# CarbonBoard

## Build & Release

- Build installer: `npm run build && npx electron-builder --win`
- Installer output: `dist/CarbonBoard Setup 1.0.0.exe`
- When rebuilding the installer, always upload it to the GitHub release (`gh release`)

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
