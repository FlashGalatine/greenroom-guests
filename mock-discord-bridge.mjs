// Token-less FAKE Discord bridge — proves both directions of the Streamer.bot bus
// with no Discord account, token, or network. It is the behavioral twin of
// sidecar/discord-bridge.mjs's bus layer:
//
//   outbound — connects to SB's WS, Subscribes (lowercase general), and pushes
//              scripted discordVoice payloads via DoAction "Discord Voice Push"
//              (the REAL path the sidecar uses; nothing is stubbed).
//   inbound  — consumes {type:'discord:voice:command'} broadcasts (and ONLY those:
//              it also hears its own discord:voice:update echoes and must ignore
//              them — the same echo-loop guard the real sidecar carries) and echoes
//              the state change back out, proving command round-trips end-to-end.
//
// Extra command (mock only; the real sidecar logs + ignores unknown commands):
//   mock-burst on|off — 20 synthetic users with a random 25% of speaking flags
//                       flipped every 100 ms: the doc-06 "20+ participants at the
//                       100 ms coalesce" scale question, made assertable offline.
//
// Run against the mock (`npm start` then `npm run mock:bridge`) or against REAL
// Streamer.bot (SB_WS_URL=ws://127.0.0.1:8080/) to drive overlays without Discord.

import { WebSocket } from 'ws';

const WS_URL = process.env.SB_WS_URL || `ws://127.0.0.1:${process.env.SB_WS_PORT || 8080}/`;
const RECONNECT_MS = 3000;

const STREAMER_ID = '110457699291906048';

const DEFAULT_SETTINGS = {
  streamerUserId: STREAMER_ID,
  avatarPx: 56,
  streamerPx: 72,
  height: 180,
  accent: 'cyan',
  scanlines: true,
  neonBlink: true,
  hideWhenAbsent: true,
};

// The three-user commentary channel every demo/test starts from on `connect`.
const embed = (n) => `https://cdn.discordapp.com/embed/avatars/${n}.png`;
const SEED_USERS = () => ({
  [STREAMER_ID]: { speaking: false, username: 'Ashe', avatarUrl: embed(1), mute: false, deaf: false },
  '200000000000000001': { speaking: false, username: 'Guest One', avatarUrl: embed(2), mute: true, deaf: false },
  '200000000000000002': { speaking: false, username: 'Guest Two', avatarUrl: embed(3), mute: false, deaf: true },
});

const state = {
  favorites: [{ id: 'fav1', name: 'Main Hang', serverId: '111', channelId: '222' }],
  current: { serverId: '111', channelId: '222' },
  settings: { ...DEFAULT_SETTINGS },
  rpc: { enabled: true, hasToken: true, error: null },
  connected: false,
  hostInChannel: false,
  channelId: null,
  users: {},
};

let ws = null;
let msgId = 0;
let favSeq = 1;
let speakTimer = null;
let burstTimer = null;

function payloadOut() {
  return {
    channelId: state.channelId,
    connected: state.connected,
    hostInChannel: state.hostInChannel,
    users: state.users,
    settings: state.settings,
    rpc: state.rpc,
    favorites: state.favorites,
    current: state.current,
  };
}

function pushNow() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    request: 'DoAction',
    id: String(++msgId),
    action: { name: 'Discord Voice Push' },
    args: { payload: JSON.stringify(payloadOut()) },
  }));
}

function stopTimers() {
  if (speakTimer) { clearInterval(speakTimer); speakTimer = null; }
  if (burstTimer) { clearInterval(burstTimer); burstTimer = null; }
}

// Scripted "someone is talking" loop — flips one seed user speaking on/off every
// 800 ms so glow toggles are observable without a live channel.
function startSpeakLoop() {
  stopTimers();
  const ids = Object.keys(state.users);
  let i = 0;
  speakTimer = setInterval(() => {
    if (!ids.length) return;
    const id = ids[i % ids.length];
    if (state.users[id]) state.users[id].speaking = !state.users[id].speaking;
    i++;
    pushNow();
  }, 800);
}

function startBurst() {
  stopTimers();
  state.connected = true;
  state.hostInChannel = true;
  state.channelId = state.current ? state.current.channelId : '222';
  state.users = {};
  for (let n = 1; n <= 20; n++) {
    const id = '30000000000000' + String(n).padStart(4, '0');
    state.users[id] = { speaking: false, username: `Burst ${n}`, avatarUrl: embed(n % 6), mute: n % 7 === 0, deaf: n % 11 === 0 };
  }
  pushNow();
  burstTimer = setInterval(() => {
    const ids = Object.keys(state.users);
    for (const id of ids) {
      if (Math.random() < 0.25) state.users[id].speaking = !state.users[id].speaking;
    }
    pushNow();
  }, 100);
}

function dispatch(command, value) {
  const parsed = (() => { try { return value ? JSON.parse(value) : null; } catch { return null; } })();
  switch (command) {
    case 'connect':
      state.connected = true;
      state.hostInChannel = true;
      state.channelId = state.current ? state.current.channelId : null;
      state.users = SEED_USERS();
      startSpeakLoop();
      break;
    case 'leave':
      stopTimers();
      state.hostInChannel = false;
      state.channelId = null;
      state.users = {};
      break;
    case 'reset-auth':
      stopTimers();
      state.rpc = { enabled: false, hasToken: false, error: null };
      state.connected = false;
      state.hostInChannel = false;
      state.channelId = null;
      state.users = {};
      break;
    case 'set-current':
      if (parsed && parsed.serverId && parsed.channelId) {
        state.current = { serverId: String(parsed.serverId), channelId: String(parsed.channelId) };
        if (state.connected && state.hostInChannel) state.channelId = state.current.channelId;
      }
      break;
    case 'favorite-add':
      if (parsed && parsed.name) {
        state.favorites.push({ id: 'fav' + (++favSeq), name: String(parsed.name), serverId: String(parsed.serverId || ''), channelId: String(parsed.channelId || '') });
      }
      break;
    case 'favorite-update':
      if (parsed && parsed.id) {
        const f = state.favorites.find((x) => x.id === parsed.id);
        if (f) {
          if (parsed.name != null) f.name = String(parsed.name);
          if (parsed.serverId != null) f.serverId = String(parsed.serverId);
          if (parsed.channelId != null) f.channelId = String(parsed.channelId);
        }
      }
      break;
    case 'favorite-remove':
      if (parsed && parsed.id) state.favorites = state.favorites.filter((x) => x.id !== parsed.id);
      break;
    case 'set-settings':
      if (parsed && typeof parsed === 'object') state.settings = { ...state.settings, ...parsed };
      break;
    case 'mock-burst':
      if (value === 'on') { startBurst(); return; } // startBurst pushes itself
      stopTimers();
      state.users = state.connected && state.hostInChannel ? SEED_USERS() : {};
      break;
    default:
      console.log(`[mock-bridge] unknown command "${command}" — ignored`);
      return;
  }
  console.log(`[mock-bridge] command: ${command}${value ? ' ' + value.slice(0, 60) : ''}`);
  pushNow();
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    // Lowercase `general` — the SB Subscribe case gotcha (same as the real sidecar).
    ws.send(JSON.stringify({ request: 'Subscribe', id: String(++msgId), events: { general: ['Custom'] } }));
    pushNow(); // seed the discord.state cache so late joiners see bot status/favorites
    console.log(`[mock-bridge] up — connected to ${WS_URL}`);
  });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m && m.id && !m.event) return; // acks
    if (!(m && m.event && m.event.source === 'General' && m.event.type === 'Custom')) return;
    let d = m.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
    // Echo-loop guard: this client also hears its own discord:voice:update
    // broadcasts (and vdoninja:update). Consume ONLY the command channel.
    if (!d || d.type !== 'discord:voice:command') return;
    dispatch(String(d.command || ''), String(d.value ?? ''));
  });
  ws.on('close', () => {
    stopTimers();
    console.log(`[mock-bridge] disconnected — retrying in ${RECONNECT_MS}ms`);
    setTimeout(connect, RECONNECT_MS);
  });
  ws.on('error', (err) => {
    console.log('[mock-bridge] WS error:', err.message);
  });
}

console.log('[mock-bridge] token-less fake Discord bridge (see mock-sb-server.mjs / verify.mjs)');
connect();
