# CarbonBoard on the Stream Deck

`dev.carbon.carbonboard.sdPlugin` is a Stream Deck plugin with one action, **Mic Mute**.

The key mutes whatever microphone CarbonBoard is passing through to the cable, so it
keeps working across audio profiles. Mute is CarbonBoard's passthrough switch, the same
one as the tray's "Mute mic" and the Cortex soundboard connector's `mic` tool.

| Key face | Meaning |
|---|---|
| green mic, LIVE | the mic is going out |
| red slashed mic, MUTED | the passthrough is off; nothing reaches the cable |
| grey mic, NO APP | CarbonBoard did not answer on 127.0.0.1:9502; the key will not guess |

It reads `GET /api/audio/mic` once a second while the key is on screen and presses
`POST /api/audio/mic {"toggle":true}`. Both skip the audio stack on purpose:
`/api/audio/status` spawns a PowerShell per call and must never be polled from a key.

## Install or update

1. Quit Stream Deck (it only loads plugins at start).
2. Copy the `.sdPlugin` folder to `%APPDATA%\Elgato\StreamDeck\Plugins\`.
3. Start Stream Deck; drag **CarbonBoard > Mic Mute** onto a key.

Plain Node, no dependencies, no build: it runs on the Node 24 that Stream Deck 7 bundles
(global `WebSocket` and `fetch`). State changes and failures are logged to
`logs/plugin.log` inside the installed folder; read that first when the key looks wrong.
