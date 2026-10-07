// CarbonBoard's Stream Deck plugin. One action: a key that mutes the mic.
//
// "The mic" is whatever microphone CarbonBoard is passing through to the cable,
// so the key follows a profile change with nothing to reconfigure. Mute is
// CarbonBoard's own passthrough switch (POST /api/audio/mic), the same one the
// tray and the Cortex soundboard connector use, so all three agree.
//
// The key shows what CarbonBoard says, never what was last pressed: it reads
// GET /api/audio/mic once a second while it is on screen. If CarbonBoard does
// not answer it shows NO APP instead of a guess, because a mute key that says
// "muted" while the mic is live is worse than no key.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://127.0.0.1:9502';
const POLL_MS = 1000;
const ACTION = 'dev.carbon.carbonboard.micmute';

const root = path.join(__dirname, '..');
const OFFLINE = 'data:image/svg+xml;charset=utf8,' + fs.readFileSync(path.join(root, 'imgs', 'offline.svg'), 'utf8');

const logFile = path.join(root, 'logs', 'plugin.log');
fs.mkdirSync(path.dirname(logFile), { recursive: true });
try { if (fs.statSync(logFile).size > 256 * 1024) fs.unlinkSync(logFile); } catch { /* no log yet */ }
function log(line) {
  try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + line + '\n'); } catch { /* never fatal */ }
}

const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];

const keys = new Set();   // contexts of the keys currently on screen
let muted;                // true | false | null = CarbonBoard did not answer
let timer = null;
let reading = false;

const ws = new WebSocket('ws://127.0.0.1:' + arg('-port'));
const send = (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

function paint(context) {
  if (muted == null) {
    send({ event: 'setImage', context, payload: { image: OFFLINE, target: 0 } });
    return;
  }
  send({ event: 'setImage', context, payload: { target: 0 } }); // back to the state's own image
  send({ event: 'setState', context, payload: { state: muted ? 1 : 0 } });
}

function show(next, why) {
  if (next === muted) return;
  muted = next;
  log('mic ' + (muted == null ? 'UNKNOWN' : muted ? 'MUTED' : 'live') + ' (' + why + ')');
  for (const context of keys) paint(context);
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
  if (typeof json.micMuted !== 'boolean') throw new Error('no micMuted in the answer');
  return json.micMuted;
}

async function poll() {
  if (reading) return;
  reading = true;
  try { show(await call('GET'), 'poll'); }
  catch (err) { show(null, 'poll failed: ' + err.message); }
  finally { reading = false; }
}

async function press(context) {
  try { show(await call('POST', { toggle: true }), 'key'); }
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
  if (msg.action !== ACTION) return;
  if (msg.event === 'willAppear') {
    keys.add(msg.context);
    if (muted !== undefined) paint(msg.context);
    if (!timer) timer = setInterval(poll, POLL_MS);
    void poll();
  } else if (msg.event === 'willDisappear') {
    keys.delete(msg.context);
    if (!keys.size && timer) { clearInterval(timer); timer = null; }
  } else if (msg.event === 'keyDown') {
    void press(msg.context);
  }
});

ws.addEventListener('close', () => process.exit(0));
ws.addEventListener('error', () => { log('lost Stream Deck'); process.exit(1); });
process.on('uncaughtException', (err) => log('uncaught: ' + (err && err.stack || err)));
