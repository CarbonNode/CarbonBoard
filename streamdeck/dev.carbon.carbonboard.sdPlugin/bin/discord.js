// The Discord half of the plugin: a key that shows the voice channel you are in, and a
// page of the people in it with volume up / down for each.
//
// It talks to the Discord client on this PC over its local RPC socket
// (ws://127.0.0.1:6463), signed in the way Discord's own StreamKit overlay signs in, so
// there is no Discord app to create and no secret to keep. Nothing leaves the PC except
// the one token exchange with streamkit.discord.com. CarbonBoard itself is not involved:
// these keys work with the soundboard closed.
//
// The keys show what Discord says, never what was last pressed: member list, volume and
// mute all come from Discord's own events. If Discord does not answer, the channel key
// says NO DISCORD instead of a guess.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CLIENT_ID = '207646673902501888';               // Discord StreamKit overlay
const ORIGIN = 'https://streamkit.discord.com';
const TOKEN_URL = 'https://streamkit.discord.com/overlay/token';
const SCOPES = ['rpc', 'messages.read', 'rpc.notifications.read'];
const PROFILE = 'CarbonBoard Discord';
const SLOTS = 4;      // member columns on the page
const STEP = 10;      // one press, in the percent Discord's own slider shows
const RETRY_MS = 5000;

const P = 'dev.carbon.carbonboard.';
const CHANNEL = P + 'discordchannel';
const BACK = P + 'discordback';
const USER = P + 'discorduser';
const UP = P + 'discordvolup';
const DOWN = P + 'discordvoldown';
const NEXT = P + 'discordnext';
const ACTIONS = new Set([CHANNEL, BACK, USER, UP, DOWN, NEXT]);

const root = path.join(__dirname, '..');
const tokenFile = path.join(root, 'data', 'discord-token.json');

let send = () => {};
let log = () => {};
let pluginUUID = '';

const keys = new Map();     // context -> { action, slot, info, device }
let ws = null;
let state = 'down';         // 'down' | 'connecting' | 'ready'
let retry = null;
let me = null;              // our own user id: never listed, Discord will not set it
let channel = null;         // { id, name } | null = not in a voice channel
let members = [];           // [{ id, name, avatar, volume, mute, speaking }] in join order
let page = 0;
let seq = 0;
const waiting = new Map();  // nonce -> { resolve, reject, timer }
const avatars = new Map();  // url -> data URI | null while it loads

// ---- Discord's volume scale ------------------------------------------------------------
// RPC carries an amplitude (100 = unchanged, 200 = the top of the slider); the slider in
// Discord shows a perceptual percent over a 50 dB range, with 6 dB of boost above 100.
// Same curve as the client, so the key reads the number the user sees in Discord.
function toPercent(amp) {
  if (!(amp > 0)) return 0;
  const db = 20 * Math.log10(amp / 100);
  return Math.round(100 * (db > 0 ? db / 6 + 1 : (50 + db) / 50));
}
function toAmplitude(percent) {
  if (!(percent > 0)) return 0;
  const db = percent > 100 ? ((percent - 100) / 100) * 6 : (percent / 100) * 50 - 50;
  return 100 * Math.pow(10, db / 20);
}

// ---- faces -----------------------------------------------------------------------------
// Sent as data:image/svg+xml with the SVG percent-encoded, like the mic keys: a raw '%'
// or '#' in the URI makes Stream Deck keep the old picture without a word.
const uri = (svg) => 'data:image/svg+xml,' + encodeURIComponent(svg);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const FONT = 'font-family="Arial, Helvetica, sans-serif" font-weight="bold" text-anchor="middle"';
const frame = (fill, body) => '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="' + fill + '"/>' + body + '</svg>';
const DARK = 'rgb(16,21,28)';
const GREY = 'rgb(51,55,61)';
const BLURPLE = 'rgb(88,101,242)';
const GREEN = 'rgb(61,220,132)';
const RED = 'rgb(237,66,69)';
const WHITE = 'rgb(255,255,255)';
const DIM = 'rgb(154,160,166)';

// A headset, so the key reads as "the call" at a glance.
const HEADSET = (colour) => '<g transform="translate(48 8) scale(2)" fill="none" stroke="' + colour + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M3 14a2 2 0 0 1 2-2h1v7H5a2 2 0 0 1-2-2Z"/><path d="M21 14a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2Z"/></g>';

// Break a name over at most two lines of about `width` characters, cutting what is left.
function wrap(text, width) {
  const words = String(text).trim().split(/\s+/);
  const lines = [''];
  for (const word of words) {
    const line = lines[lines.length - 1];
    if (!line) lines[lines.length - 1] = word;
    else if ((line + ' ' + word).length <= width) lines[lines.length - 1] = line + ' ' + word;
    else if (lines.length < 2) lines.push(word);
    else { lines[1] = line + ' ' + word; break; }
  }
  return lines.map((l) => (l.length > width ? l.slice(0, width - 1) + '…' : l));
}

function channelFace() {
  if (state !== 'ready') {
    return uri(frame(GREY, HEADSET(DIM) + '<text x="72" y="92" ' + FONT + ' font-size="22" fill="' + WHITE + '">NO</text><text x="72" y="120" ' + FONT + ' font-size="22" fill="' + WHITE + '">DISCORD</text>'));
  }
  if (!channel) {
    return uri(frame(DARK, HEADSET(DIM) + '<text x="72" y="92" ' + FONT + ' font-size="22" fill="' + DIM + '">NOT IN</text><text x="72" y="120" ' + FONT + ' font-size="22" fill="' + DIM + '">A CALL</text>'));
  }
  const lines = wrap(channel.name, 11);
  const size = lines.some((l) => l.length > 9) ? 20 : 24;
  const name = lines.length === 1
    ? '<text x="72" y="96" ' + FONT + ' font-size="' + size + '" fill="' + WHITE + '">' + esc(lines[0]) + '</text>'
    : '<text x="72" y="82" ' + FONT + ' font-size="' + size + '" fill="' + WHITE + '">' + esc(lines[0]) + '</text><text x="72" y="106" ' + FONT + ' font-size="' + size + '" fill="' + WHITE + '">' + esc(lines[1]) + '</text>';
  const count = members.length === 0 ? 'just you' : members.length === 1 ? '1 other' : members.length + ' others';
  return uri(frame(DARK, HEADSET(GREEN) + name + '<text x="72" y="132" ' + FONT + ' font-size="18" fill="' + GREEN + '">' + count + '</text>'));
}

const arrowFace = (text) => uri(frame(DARK, '<g fill="none" stroke="' + WHITE + '" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"><path d="M92 36 56 72l36 36"/></g>' + (text ? '<text x="72" y="134" ' + FONT + ' font-size="18" fill="' + DIM + '">' + esc(text) + '</text>' : '')));
const BACK_FACE = uri(frame(DARK, '<g fill="none" stroke="' + WHITE + '" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"><path d="M84 40 52 72l32 32"/></g><text x="72" y="134" ' + FONT + ' font-size="20" fill="' + DIM + '">BACK</text>'));
const stepFace = (plus, live) => uri(frame(DARK, '<g fill="none" stroke="' + (live ? (plus ? GREEN : RED) : GREY) + '" stroke-width="14" stroke-linecap="round"><path d="M40 72h64"/>' + (plus ? '<path d="M72 40v64"/>' : '') + '</g>'));
const EMPTY = uri(frame(DARK, ''));

function nextFace() {
  const pages = Math.max(1, Math.ceil(members.length / SLOTS));
  if (pages < 2) return uri(frame(DARK, '<text x="72" y="82" ' + FONT + ' font-size="22" fill="' + GREY + '">PAGE</text><text x="72" y="110" ' + FONT + ' font-size="22" fill="' + GREY + '">1 / 1</text>'));
  return uri(frame(DARK, '<g fill="none" stroke="' + WHITE + '" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"><path d="M56 26 88 58 56 90"/></g><text x="72" y="130" ' + FONT + ' font-size="22" fill="' + WHITE + '">' + (page + 1) + ' / ' + pages + '</text>'));
}

// A member key: the avatar with the name across the top and the volume across the bottom,
// each on its own dark band so they read over any picture. The ring is the state: green
// while they talk, red when muted for you.
function userFace(member) {
  if (!member) return EMPTY;
  const picture = avatars.get(member.avatar);
  const lines = wrap(member.name, 10);
  const percent = toPercent(member.volume);
  const ring = member.mute ? RED : member.speaking ? GREEN : null;
  const body =
    (picture
      ? '<image x="0" y="0" width="144" height="144" preserveAspectRatio="xMidYMid slice" href="' + picture + '" xlink:href="' + picture + '"/>'
      : '<circle cx="72" cy="72" r="34" fill="' + BLURPLE + '"/><text x="72" y="86" ' + FONT + ' font-size="40" fill="' + WHITE + '">' + esc((member.name[0] || '?').toUpperCase()) + '</text>') +
    // Two people called Jonathan are told apart by the second line, so it is kept.
    (lines.length === 1
      ? '<rect x="0" y="0" width="144" height="34" fill="rgb(0,0,0)" fill-opacity="0.72"/>' +
        '<text x="72" y="25" ' + FONT + ' font-size="' + (lines[0].length > 8 ? 19 : 22) + '" fill="' + WHITE + '">' + esc(lines[0]) + '</text>'
      : '<rect x="0" y="0" width="144" height="50" fill="rgb(0,0,0)" fill-opacity="0.72"/>' +
        '<text x="72" y="21" ' + FONT + ' font-size="19" fill="' + WHITE + '">' + esc(lines[0]) + '</text>' +
        '<text x="72" y="43" ' + FONT + ' font-size="19" fill="' + WHITE + '">' + esc(lines[1]) + '</text>') +
    '<rect x="0" y="106" width="144" height="38" fill="rgb(0,0,0)" fill-opacity="0.72"/>' +
    '<text x="72" y="135" ' + FONT + ' font-size="28" fill="' + (member.mute ? RED : WHITE) + '">' + (member.mute ? 'MUTED' : percent + '%') + '</text>' +
    (ring ? '<rect x="4" y="4" width="136" height="136" rx="10" fill="none" stroke="' + ring + '" stroke-width="8"/>' : '');
  return uri(frame(DARK, body));
}

// Avatars are fetched once and inlined: Stream Deck will not load a remote image from an
// SVG, and a key that waits on the network for its face is a key that is blank.
function loadAvatar(url) {
  if (!url || avatars.has(url)) return;
  avatars.set(url, null);
  fetch(url, { signal: AbortSignal.timeout(8000) })
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error('HTTP ' + res.status))))
    .then((buf) => { avatars.set(url, 'data:image/png;base64,' + Buffer.from(buf).toString('base64')); paintAll(); })
    .catch((err) => { avatars.delete(url); log('discord avatar failed: ' + err.message); });
}

const slotMember = (slot) => members[page * SLOTS + slot];

function paint(context, key) {
  let image;
  if (key.action === CHANNEL) image = channelFace();
  else if (key.action === BACK) image = BACK_FACE;
  else if (key.action === NEXT) image = nextFace();
  else if (key.action === USER) image = userFace(slotMember(key.slot));
  else image = stepFace(key.action === UP, !!slotMember(key.slot));
  if (key.last === image) return;   // every speaking flicker would otherwise repaint 15 keys
  key.last = image;
  send({ event: 'setImage', context, payload: { image, target: 0 } });
}
function paintAll() {
  const pages = Math.max(1, Math.ceil(members.length / SLOTS));
  if (page >= pages) page = pages - 1;
  for (const [context, key] of keys) paint(context, key);
}

// ---- Discord RPC -----------------------------------------------------------------------
function request(cmd, args, evt) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('not connected'));
    const nonce = 'cb' + (++seq);
    const timer = setTimeout(() => { waiting.delete(nonce); reject(new Error(cmd + ' timed out')); }, cmd === 'AUTHORIZE' ? 120000 : 15000);
    waiting.set(nonce, { resolve, reject, timer });
    ws.send(JSON.stringify(evt ? { cmd, args, evt, nonce } : { cmd, args, nonce }));
  });
}

function readToken() {
  try {
    const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    return typeof saved.access_token === 'string' ? saved.access_token : null;
  } catch { return null; }
}
function saveToken(token) {
  try { fs.mkdirSync(path.dirname(tokenFile), { recursive: true }); fs.writeFileSync(tokenFile, JSON.stringify({ access_token: token })); } catch { /* next start authorizes again */ }
}

// Discord shows its Authorize window the first time only; after that this is silent.
async function authorize() {
  let grant;
  try { grant = await request('AUTHORIZE', { client_id: CLIENT_ID, scopes: SCOPES, prompt: 'none' }); }
  catch { grant = await request('AUTHORIZE', { client_id: CLIENT_ID, scopes: SCOPES }); }
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: grant.code }), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('token exchange HTTP ' + res.status);
  const json = await res.json();
  if (typeof json.access_token !== 'string') throw new Error('token exchange gave no token');
  saveToken(json.access_token);
  return json.access_token;
}

async function signIn() {
  let token = readToken();
  let who;
  if (token) {
    try { who = await request('AUTHENTICATE', { access_token: token }); }
    catch { token = null; }   // expired (they last a week) or revoked
  }
  if (!token) {
    log('discord asking for access (Discord shows an Authorize window the first time)');
    who = await request('AUTHENTICATE', { access_token: await authorize() });
  }
  me = who.user.id;
  state = 'ready';
  log('discord signed in as ' + who.user.username);
  await request('SUBSCRIBE', {}, 'VOICE_CHANNEL_SELECT');
  await loadChannel();
}

const VOICE_EVENTS = ['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE', 'SPEAKING_START', 'SPEAKING_STOP'];

function fromVoiceState(vs, old) {
  const user = vs.user || {};
  return {
    id: user.id,
    name: vs.nick || user.global_name || user.username || 'Unknown',
    avatar: user.avatar ? 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png?size=64' : null,
    volume: typeof vs.volume === 'number' ? vs.volume : 100,
    mute: !!vs.mute,
    speaking: old ? old.speaking : false,
  };
}

async function loadChannel() {
  const old = channel;
  const next = await request('GET_SELECTED_VOICE_CHANNEL', {});
  if (old && (!next || next.id !== old.id)) {
    for (const evt of VOICE_EVENTS) request('UNSUBSCRIBE', { channel_id: old.id }, evt).catch(() => {});
  }
  if (!next || !next.id) {
    channel = null; members = []; page = 0;
    if (old) log('discord left ' + old.name);
  } else {
    channel = { id: next.id, name: next.name || 'Voice' };
    members = (next.voice_states || []).filter((vs) => vs.user && vs.user.id !== me).map((vs) => fromVoiceState(vs));
    if (!old || old.id !== next.id) {
      page = 0;
      for (const evt of VOICE_EVENTS) await request('SUBSCRIBE', { channel_id: next.id }, evt);
      log('discord in ' + channel.name + ' with ' + members.length + ' other(s)');
    }
    for (const member of members) loadAvatar(member.avatar);
  }
  paintAll();
}

function onEvent(evt, data) {
  if (evt === 'VOICE_CHANNEL_SELECT') {
    loadChannel().catch((err) => log('discord channel read failed: ' + err.message));
    return;
  }
  if (!channel || !data) return;
  if (evt === 'SPEAKING_START' || evt === 'SPEAKING_STOP') {
    const member = members.find((m) => m.id === data.user_id);
    if (member) { member.speaking = evt === 'SPEAKING_START'; paintAll(); }
    return;
  }
  const id = data.user && data.user.id;
  if (!id || id === me) return;
  const at = members.findIndex((m) => m.id === id);
  if (evt === 'VOICE_STATE_DELETE') {
    if (at >= 0) members.splice(at, 1);
  } else if (at >= 0) {
    members[at] = fromVoiceState(data, members[at]);
  } else {
    members.push(fromVoiceState(data));
  }
  if (evt !== 'VOICE_STATE_DELETE') loadAvatar((members.find((m) => m.id === id) || {}).avatar);
  paintAll();
}

function drop(why) {
  if (state !== 'down') log('discord lost: ' + why);
  state = 'down'; channel = null; members = []; page = 0;
  for (const [, w] of waiting) { clearTimeout(w.timer); w.reject(new Error('disconnected')); }
  waiting.clear();
  if (ws) { try { ws.close(); } catch { /* already gone */ } ws = null; }
  paintAll();
  if (!retry && keys.size) retry = setTimeout(() => { retry = null; connect(); }, RETRY_MS);
}

// Discord listens on the first free port of 6463-6472; the first one that answers is it.
function connect(port = 6463) {
  if (ws || !keys.size) return;
  state = 'connecting';
  let opened = false;
  const socket = new WebSocket('ws://127.0.0.1:' + port + '/?v=1&client_id=' + CLIENT_ID + '&encoding=json', { headers: { Origin: ORIGIN } });
  ws = socket;
  socket.addEventListener('open', () => { opened = true; log('discord socket open on ' + port); });
  socket.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.nonce && waiting.has(msg.nonce)) {
      const w = waiting.get(msg.nonce);
      waiting.delete(msg.nonce); clearTimeout(w.timer);
      if (msg.evt === 'ERROR') w.reject(new Error((msg.data && msg.data.message) || 'Discord refused ' + msg.cmd));
      else w.resolve(msg.data);
    } else if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
      signIn().catch((err) => drop('sign-in failed: ' + err.message));
    } else if (msg.cmd === 'DISPATCH') {
      onEvent(msg.evt, msg.data);
    }
  });
  const gone = (why) => {
    if (ws !== socket) return;
    ws = null;
    if (!opened && port < 6472) { connect(port + 1); return; }
    drop(opened ? why : 'Discord is not running');
  };
  socket.addEventListener('close', () => gone('socket closed'));
  socket.addEventListener('error', () => gone('socket error'));
}

// ---- keys ------------------------------------------------------------------------------
async function setVolume(member, percent) {
  const next = Math.max(0, Math.min(200, percent));
  await request('SET_USER_VOICE_SETTINGS', { user_id: member.id, volume: toAmplitude(next) });
  member.volume = toAmplitude(next);   // Discord's own event follows and has the last word
  log('discord ' + member.name + ' ' + next + '%');
}

async function press(context, key) {
  if (key.action === CHANNEL) {
    if (key.info || !key.device) return;   // the copy on the page itself only shows the name
    send({ event: 'switchToProfile', context: pluginUUID, device: key.device, payload: { profile: PROFILE } });
    return;
  }
  if (key.action === BACK) {
    if (key.device) send({ event: 'switchToProfile', context: pluginUUID, device: key.device, payload: {} });
    return;
  }
  if (key.action === NEXT) {
    const pages = Math.max(1, Math.ceil(members.length / SLOTS));
    page = (page + 1) % pages;
    paintAll();
    return;
  }
  const member = slotMember(key.slot);
  if (!member) return;
  try {
    if (key.action === USER) {
      await request('SET_USER_VOICE_SETTINGS', { user_id: member.id, mute: !member.mute });
      member.mute = !member.mute;
      log('discord ' + member.name + (member.mute ? ' muted' : ' unmuted'));
    } else {
      // Step on the tens the slider shows, so 71% goes to 80% and back down to 70%.
      const now = toPercent(member.volume);
      await setVolume(member, key.action === UP ? Math.floor(now / STEP) * STEP + STEP : Math.ceil(now / STEP) * STEP - STEP);
    }
    paintAll();
  } catch (err) {
    log('discord key failed: ' + err.message);
    send({ event: 'showAlert', context });
  }
}

function onMessage(msg) {
  if (msg.event === 'willAppear') {
    const settings = (msg.payload && msg.payload.settings) || {};
    keys.set(msg.context, { action: msg.action, slot: Number(settings.slot) || 0, info: !!settings.info, device: msg.device });
    paint(msg.context, keys.get(msg.context));
    if (!ws && !retry) connect();
  } else if (msg.event === 'willDisappear') {
    keys.delete(msg.context);
  } else if (msg.event === 'didReceiveSettings') {
    const key = keys.get(msg.context);
    const settings = (msg.payload && msg.payload.settings) || {};
    if (key) { key.slot = Number(settings.slot) || 0; key.info = !!settings.info; key.last = null; paint(msg.context, key); }
  } else if (msg.event === 'keyDown') {
    const key = keys.get(msg.context);
    if (key) void press(msg.context, key);
  }
}

module.exports = {
  handles: (action) => ACTIONS.has(action),
  onMessage,
  start(io) { send = io.send; log = io.log; pluginUUID = io.pluginUUID; },
  toPercent,
  toAmplitude,
};
