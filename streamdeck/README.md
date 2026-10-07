# CarbonBoard on the Stream Deck

`dev.carbon.carbonboard.sdPlugin` is a Stream Deck plugin with two sets of keys: the mic keys (**Mic Mute**, **Mic Boost Up**, **Mic Boost Down**) and the **Discord Call** keys.

The key mutes whatever microphone CarbonBoard is passing through to the cable, so it
keeps working across audio profiles. Mute is CarbonBoard's passthrough switch, the same
one as the tray's "Mute mic" and the Cortex soundboard connector's `mic` tool.

| Key face | Meaning |
|---|---|
| green mic, LIVE | the mic is going out |
| red slashed mic, MUTED | the passthrough is off; nothing reaches the cable |
| grey mic, NO APP | CarbonBoard did not answer on 127.0.0.1:9502; the key will not guess |

**Mic Boost Up / Down** move CarbonBoard's own mic slider 10% a press, between 0% and 200%
(100% is the mic untouched), and show the level on the key. Above 100% loud speech can clip.

It reads `GET /api/audio/mic` once a second while the key is on screen and presses
`POST /api/audio/mic` with `{"toggle":true}` or `{"volumeStep":0.1}`. Both skip the audio stack on purpose:
`/api/audio/status` spawns a PowerShell per call and must never be polled from a key.

## Discord Call keys (`bin/discord.js`)

**Discord Call** shows the voice channel you are in and how many others are in it. Press it
and the deck switches to the bundled **CarbonBoard Discord** page: four people at a time,
each a column of Louder / the person / Quieter, with Back, the channel name and Next People
down the left.

| Key face | Meaning |
|---|---|
| green headset, channel name, "4 others" | you are in that voice channel |
| grey headset, NOT IN A CALL | Discord is running, you are in no voice channel |
| grey key, NO DISCORD | the Discord client did not answer; the key retries every 5 s |
| person: picture, name, 70% | how loud they are for you, the same number as Discord's own slider |
| person with a green ring | they are talking |
| person with a red ring, MUTED | you have muted them for yourself; press the person to undo |

Louder / Quieter move one person 10% a press between 0% and 200%, for you only. Pressing a
person mutes or unmutes them for you. Nobody else in the call is affected by any of it.

It talks to the Discord client on this PC over its local RPC socket (`ws://127.0.0.1:6463`
to `:6472`) and signs in the way Discord's StreamKit overlay does (client id
`207646673902501888`, `Origin: https://streamkit.discord.com`, the code exchanged at
`https://streamkit.discord.com/overlay/token`). So there is no Discord application to
create and no client secret anywhere. The token lasts a week and is kept in
`data/discord-token.json` inside the installed folder; when it expires the plugin asks
again, silently. The very first time on a new Discord account, Discord shows an Authorize
window once. CarbonBoard itself is not involved: these keys work with the soundboard closed.

Discord's RPC carries volume as an amplitude (100 = unchanged) while its slider shows a
perceptual percent; `toPercent` / `toAmplitude` are the client's own curve (50 dB below 100,
6 dB of boost above), so the key and Discord always show the same number.

The page is a bundled profile (`CarbonBoard Discord.streamDeckProfile`, declared under
`Profiles` in the manifest): a plugin may only switch to a profile it ships. Each key on it
carries its column in its settings (`{"slot":0}` to `{"slot":3}`), and the channel key on the
page itself carries `{"info":true}` so pressing it there does nothing.

## Install or update

1. Quit Stream Deck (it only loads plugins at start).
2. Copy the `.sdPlugin` folder to `%APPDATA%\Elgato\StreamDeck\Plugins\`.
3. Start Stream Deck; drag **CarbonBoard > Mic Mute** onto a key, and **CarbonBoard > Discord Call**
   onto another. The first press of Discord Call offers to install its page.

Plain Node, no dependencies, no build: it runs on the Node 24 that Stream Deck 7 bundles
(global `WebSocket` and `fetch`). State changes and failures are logged to
`logs/plugin.log` inside the installed folder; read that first when a key looks wrong (the
Discord lines start with `discord`).
