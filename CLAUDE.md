# CarbonBoard

## Build & Release

- Build installer: `npm run build && npx electron-builder --win`
- Installer output: `dist/CarbonBoard Setup 1.0.0.exe`
- When rebuilding the installer, always upload it to the GitHub release (`gh release`)

## The microphone chain (read before touching anything in `src/lib/store.tsx`)

The app is the only thing between the physical microphone and Discord: it captures one
mic and renders it into CABLE Input, which every other app listens to. So **the app must
hold exactly one capture stream at a time**, and that stream must always be reachable
from `micStreamRef` GÇö a stream nothing holds a reference to can never be stopped again,
and it keeps the device open for the life of the process.

Two things used to break that invariant, and both are fixed (2026-09-11):

- `startMicPassthrough` stops the existing stream *before* it awaits `getUserMedia`, so
  two overlapping calls each opened a stream and only the last one was stored. Many
  things can overlap it: two `devicechange` listeners, the 30 s health check, the
  retry timers, the track-ended recovery, and the profile-switch effects. It is now
  serialised by `micStartGenRef` GÇö a start that has been superseded closes the stream it
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

### `micwatch.ps1` GÇö the watchdog

Runs every 5 minutes from a scheduled task, in the **interactive session** (session 0 sees
no audio sessions at all). It does not ask the app how it is doing: it reads the Windows
audio sessions via `_who2.ps1` and compares them with the profile the app says is active.
On a mismatch it re-applies the profile; if that does not clear it, it **restarts
CarbonBoard**, because re-applying a profile cannot close an orphaned stream GÇö only
ending the process can. A 30-minute cooldown (`micwatch.restart`) keeps a genuinely
broken machine from restart-looping; past that it falls back to a `msg.exe` box.
Log: `micwatch.log`.

### `micguard.ps1` â€” keeping the Cetra's own mic disabled

The ROG Cetra True Wireless SpeedNova carries playback and microphone over one 2.4 GHz
link, and the buds drop that link to a mono narrowband telephony profile the moment
**anything** opens their microphone â€” playback immediately goes tinny and robotic.
Muting does not help: a muted stream is still an open stream. That mic is never wanted
here, because the "In Ear" profile pairs the Cetras with the Insta360 lapel. So the cure
is to keep the Cetra **capture** endpoint disabled and let nothing open it.

Disabling it by hand does not stick, which is the whole reason this script exists.
Windows stores the disabled flag per **device instance**, and the instance path contains
the USB port the dongle is in â€” so moving the dongle to another port enumerates a
brand-new, *enabled* endpoint and the tinny audio is back. `micguard.ps1` re-applies it
every minute from the `CetraMicGuard` scheduled task (SYSTEM, highest, 1-minute
repetition). Unlike `micwatch` it does not need the interactive session: PnP is
session-agnostic, only audio *sessions* are not.

Safety rail, do not remove it: under `SWD\MMDEVAPI` a render endpoint is `{0.0.0.*}` and
a capture endpoint is `{0.0.1.*}`. A target must match `{0.0.1.*}` **and** a name pattern
in `$blocked`, so the guard cannot disable the headphones themselves â€” the worst a bad
pattern can do is mute a microphone. Add a device by adding a pattern; do **not**
blocklist the Astro A50, whose mic the "Headphones" profile genuinely uses.

It logs only when it acts or fails (`micguard.log`); the task's Last Run Time is the
liveness proof. Verified end to end on 2026-09-12 by re-enabling the endpoint by hand and
watching the guard put it back within 60 s.

One diagnostic trap, because it cost an hour on 2026-09-12: the symptom was first blamed
on CarbonBoard holding the wrong microphone, on the strength of the Windows per-app
privacy flag (`CapabilityAccessManager\ConsentStore\microphone`, `LastUsedTimeStop == 0`).
**That flag is per app, not per device** â€” it says an app has *a* mic open, never which
one. Two days of `micwatch.log` and the live audio-session list both showed CarbonBoard
holding only the Insta360. Use `_who2.ps1` (endpoint to PID, ground truth) instead, and
remember it must run in the interactive session.
