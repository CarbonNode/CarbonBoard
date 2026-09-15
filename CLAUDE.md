# CarbonBoard

## Build & Release

- Build installer: `npm run build && npx electron-builder --win`
- Installer output: `dist/CarbonBoard Setup 1.0.0.exe`
- When rebuilding the installer, always upload it to the GitHub release (`gh release`)

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

Diagnosing this by hand: `_who3.ps1` (interactive session only) lists every audio session
with its volume, mute and a peak meter, plus the endpoint meters and the default device per
role. **Do not play clips as a test** — the cable is Discord's microphone, everyone on the
call hears it. Let his own speech be the signal: a peak on the headset capture session with
nothing on CABLE Input is the proof.
