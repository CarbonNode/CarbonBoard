// CarbonBoard's Stream Deck plugin: a key that mutes the mic, and two that
// turn it up and down.
//
// "The mic" is whatever microphone CarbonBoard is passing through to the cable,
// so the keys follow a profile change with nothing to reconfigure. Mute is
// CarbonBoard's own passthrough switch and the level is its own mic slider
// (0-200%), so the keys, the tray and the window always agree.
//
// The keys show what CarbonBoard says, never what was last pressed: they read
// GET /api/audio/mic once a second while any of them is on screen. If
// CarbonBoard does not answer they show NO APP instead of a guess, because a
// mute key that says "muted" while the mic is live is worse than no key.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://127.0.0.1:9502';
const POLL_MS = 1000;
const STEP = 0.1; // one press of a boost key, on the app's 0..2 mic volume
const MUTE = 'dev.carbon.carbonboard.micmute';
const UP = 'dev.carbon.carbonboard.micboostup';
const DOWN = 'dev.carbon.carbonboard.micboostdown';

const root = path.join(__dirname, '..');
const svg = (name) => fs.readFileSync(path.join(root, 'imgs', name + '.svg'), 'utf8');
// Stream Deck percent-decodes a data: URI, so the SVG has to be encoded: sent
// raw, the '%' in "160%" is a broken escape and the key keeps its old face.
const uri = (text) => 'data:image/svg+xml,' + encodeURIComponent(text);
const OFFLINE = uri(svg('offline'));
// The boost faces carry the level where the file says BOOST.
const BOOST = { [UP]: svg('boost-up'), [DOWN]: svg('boost-down') };
const boostFace = (action, text) => uri(BOOST[action].replace('>BOOST<', '>' + text + '<'));

const logFile = path.join(root, 'logs', 'plugin.log');
fs.mkdirSync(path.dirname(logFile), { recursive: true });
try { if (fs.statSync(logFile).size > 256 * 1024) fs.unlinkSync(logFile); } catch { /* no log yet */ }
function log(line) {
  try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + line + '\n'); } catch { /* never fatal */ }
}

const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];

const keys = new Map();   // context -> action, for the keys currently on screen
let mic;                  // { muted, volume } | null = CarbonBoard did not answer
let timer = null;
let reading = false;

const ws = new WebSocket('ws://127.0.0.1:' + arg('-port'));
const send = (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
const percent = () => Math.round(mic.volume * 100) + '%';

function paint(context, action) {
  if (action !== MUTE) {
    send({ event: 'setImage', context, payload: { image: boostFace(action, mic ? percent() : 'NO APP'), target: 0 } });
    return;
  }
  if (!mic) {
    send({ event: 'setImage', context, payload: { image: OFFLINE, target: 0 } });
    return;
  }
  send({ event: 'setImage', context, payload: { target: 0 } }); // back to the state's own image
  send({ event: 'setState', context, payload: { state: mic.muted ? 1 : 0 } });
}

function show(next, why) {
  if (mic !== undefined && (next === mic || (next && mic && next.muted === mic.muted && next.volume === mic.volume))) return;
  mic = next;
  log('mic ' + (mic ? (mic.muted ? 'MUTED ' : 'live ') + percent() : 'UNKNOWN') + ' (' + why + ')');
  for (const [context, action] of keys) paint(context, action);
}

async function call(method, body) {
  const res = await fetch(BASE + '/api/audio/mic', {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(900),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  if (typeof json.micMuted !== 'boolean' || typeof json.micVolume !== 'number') throw new Error('unexpected answer');
  return { muted: json.micMuted, volume: json.micVolume };
}

async function poll() {
  if (reading) return;
  reading = true;
  try { show(await call('GET'), 'poll'); }
  catch (err) { show(null, 'poll failed: ' + err.message); }
  finally { reading = false; }
}

async function press(context, action) {
  const body = action === MUTE ? { toggle: true } : { volumeStep: action === UP ? STEP : -STEP };
  try { show(await call('POST', body), 'key'); }
  catch (err) {
    show(null, 'key failed: ' + err.message);
    send({ event: 'showAlert', context });
  }
}

ws.addEventListener('open', () => {
  send({ event: arg('-registerEvent'), uuid: arg('-pluginUUID') });
  log('registered with Stream Deck');
});

ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.action !== MUTE && msg.action !== UP && msg.action !== DOWN) return;
  if (msg.event === 'willAppear') {
    keys.set(msg.context, msg.action);
    if (mic !== undefined) paint(msg.context, msg.action);
    if (!timer) timer = setInterval(poll, POLL_MS);
    void poll();
  } else if (msg.event === 'willDisappear') {
    keys.delete(msg.context);
    if (!keys.size && timer) { clearInterval(timer); timer = null; }
  } else if (msg.event === 'keyDown') {
    void press(msg.context, msg.action);
  }
});

ws.addEventListener('close', () => process.exit(0));
ws.addEventListener('error', () => { log('lost Stream Deck'); process.exit(1); });
process.on('uncaughtException', (err) => log('uncaught: ' + (err && err.stack || err)));
