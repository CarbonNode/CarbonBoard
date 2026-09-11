# CarbonBoard

## Build & Release

- Build installer: `npm run build && npx electron-builder --win`
- Installer output: `dist/CarbonBoard Setup 1.0.0.exe`
- When rebuilding the installer, always upload it to the GitHub release (`gh release`)

## The microphone chain (read before touching anything in `src/lib/store.tsx`)

The app is the only thing between the physical microphone and Discord: it captures one
mic and renders it into CABLE Input, which every other app listens to. So **the app must
hold exactly one capture stream at a time**, and that stream must always be reachable
from `micStreamRef` G현 a stream nothing holds a reference to can never be stopped again,
and it keeps the device open for the life of the process.

Two things used to break that invariant, and both are fixed (2026-09-11):

- `startMicPassthrough` stops the existing stream *before* it awaits `getUserMedia`, so
  two overlapping calls each opened a stream and only the last one was stored. Many
  things can overlap it: two `devicechange` listeners, the 30 s health check, the
  retry timers, the track-ended recovery, and the profile-switch effects. It is now
  serialised by `micStartGenRef` G현 a start that has been superseded closes the stream it
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

### `micwatch.ps1` G현 the watchdog

Runs every 5 minutes from a scheduled task, in the **interactive session** (session 0 sees
no audio sessions at all). It does not ask the app how it is doing: it reads the Windows
audio sessions via `_who2.ps1` and compares them with the profile the app says is active.
On a mismatch it re-applies the profile; if that does not clear it, it **restarts
CarbonBoard**, because re-applying a profile cannot close an orphaned stream G현 only
ending the process can. A 30-minute cooldown (`micwatch.restart`) keeps a genuinely
broken machine from restart-looping; past that it falls back to a `msg.exe` box.
Log: `micwatch.log`.
