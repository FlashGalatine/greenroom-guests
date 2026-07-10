// Greenroom Discord bridge — the one Node sidecar. A small discord.js bot joins
// the target voice channel muted-but-listening (selfMute: true, selfDeaf: false —
// a deaf bot receives no speaking events; this one never transmits and decodes no
// audio) and feeds a live per-user { speaking, username, avatarUrl, mute, deaf }
// map to the overlays through Streamer.bot's WebSocket:
//
//   outbound  every (coalesced) roster change → DoAction "Discord Voice Push"
//             with the pre-serialized discordVoice payload (docs/PROTOCOL.md)
//   inbound   subscribes to General.Custom and consumes
//             { type:'discord:voice:command', command, value } broadcasts emitted
//             by the control page via the "Discord Voice Command" action
//
// Ported near-verbatim from the toolkit's ControlPanel/src/discord-voice.js (the
// battle-tested rejoin races, error taxonomy, and BigInt avatar math survive
// unchanged); only the transport moved from the old :7070 relay to SB's WS, and
// the payload grew settings/rpc/favorites/current so the control page can render
// status without a private channel.
//
// SECRETS: the bot token lives ONLY in the gitignored discord-tokens.json next to
// this file ({ "botToken": "...", "enabled": true }). It NEVER travels the bus —
// every broadcast reaches every subscribed client. There is deliberately no
// command that carries a token.
//
// Run:  start-discord-bridge.bat  ·  npm run bridge (repo root)  ·  the optional
//       "Discord Bridge Start" SB action. Requires Node >= 22.12 (discord.js 14 /
//       @discordjs/voice 0.19 floor) and `npm install` in sidecar/.
// Env:  SB_WS_URL (default ws://127.0.0.1:8080/) · GREENROOM_GUARD_PORT (7495)
//       DISCORD_BRIDGE_CONFIG / DISCORD_BRIDGE_TOKENS (test hooks: file paths)

import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.DISCORD_BRIDGE_CONFIG || resolve(__dirname, 'discord-voice-config.json');
const EXAMPLE_PATH = resolve(__dirname, 'discord-voice-config.example.json');
// Secrets (the bot token) live in a SEPARATE gitignored file — never in config.
const TOKENS_PATH = process.env.DISCORD_BRIDGE_TOKENS || resolve(__dirname, 'discord-tokens.json');
const SB_WS_URL = process.env.SB_WS_URL || `ws://127.0.0.1:${process.env.SB_WS_PORT || 8080}/`;
// Single-instance guard: a second launch (double-click + SB action) exits cleanly
// instead of double-pushing and fighting over the voice connection.
const GUARD_PORT = Number(process.env.GREENROOM_GUARD_PORT) || 7495;

const DEFAULT_SETTINGS = {
  streamerUserId: '', // set yours in the control page (streamer-first roster order)
  avatarPx: 56,
  streamerPx: 72,
  height: 180,
  accent: 'cyan', // 'cyan' | 'magenta' | 'neon-green'
  scanlines: true,
  neonBlink: true,
  hideWhenAbsent: true,
};

let state = {
  favorites: [],      // [{ id, name, serverId, channelId }]
  current: null,      // { serverId, channelId } | null
  settings: { ...DEFAULT_SETTINGS },
};

let creds = {
  botToken: '',
  enabled: false, // auto-connect the bot at startup when true
};

// Live, ephemeral (never persisted): { [userId]: { speaking, username, avatarUrl, mute, deaf } }
let voiceUsers = {};
let currentChannelId = null;   // the voice channel the bot is currently joined to

// Runtime status surfaced to the control page (no secrets).
let rpc = {
  connected: false,     // bot logged in to the gateway
  hostInChannel: false, // bot has joined + is receiving in a voice channel
  error: '',            // last human-readable error (login/join failure)
};

let bot = null;              // discord.js Client
let voiceConn = null;        // current @discordjs/voice VoiceConnection
let wantVoice = true;        // operator intent: should the bot be in voice? (a
                             // manual Leave sets false so it won't auto-rejoin)

// Streamer.bot WS client (replaces the old StreamService :7070 relay client).
let sbWs = null;
let sbReconnectTimer = null;
let sbMsgId = 0;

// Throttle the voice feed: leading-edge push + ~100ms trailing coalesce.
const PUSH_MIN_MS = 100;
let pushTimer = null;
let pushPending = false;

async function init() {
  let loaded = false;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    adoptConfig(JSON.parse(raw));
    loaded = true;
    log(`Loaded ${state.favorites.length} favorite(s)`);
  } catch (err) {
    if (err.code !== 'ENOENT') log(`Could not load config: ${err.message}`);
  }
  if (!loaded) {
    // First run: seed the gitignored config from the tracked example.
    try {
      adoptConfig(JSON.parse(await readFile(EXAMPLE_PATH, 'utf-8')));
      await persist();
      log('Seeded discord-voice-config.json from the example');
    } catch { /* example missing — defaults stand */ }
  }

  // Load the gitignored bot token and, if enabled, start the bot at startup.
  try {
    const raw = await readFile(TOKENS_PATH, 'utf-8');
    const t = JSON.parse(raw);
    creds = {
      botToken: String(t.botToken ?? '').trim(),
      enabled: !!t.enabled,
    };
    if (creds.enabled && creds.botToken) startBot();
  } catch (err) {
    if (err.code !== 'ENOENT') log(`Could not load discord-tokens.json: ${err.message}`);
    else log('No discord-tokens.json yet — create it to enable the bot (docs/STREAMERBOT-SETUP.md)');
  }
}

function adoptConfig(parsed) {
  state = {
    favorites: Array.isArray(parsed.favorites)
      ? parsed.favorites
          .filter((f) => f && typeof f === 'object')
          .map((f) => ({
            id: String(f.id ?? makeId()),
            name: String(f.name ?? '').slice(0, 80),
            serverId: String(f.serverId ?? '').replace(/\D/g, ''),
            channelId: String(f.channelId ?? '').replace(/\D/g, ''),
          }))
          .filter((f) => f.serverId && f.channelId)
      : [],
    current: parsed.current && typeof parsed.current === 'object'
      ? {
          serverId: String(parsed.current.serverId ?? '').replace(/\D/g, ''),
          channelId: String(parsed.current.channelId ?? '').replace(/\D/g, ''),
        }
      : null,
    settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
  };
}

async function addFavorite(name, serverId, channelId) {
  const fav = sanitizeFavorite({ name, serverId, channelId });
  if (!fav) return null;
  fav.id = makeId();
  state.favorites.push(fav);
  await persist();
  return fav;
}

async function updateFavorite(id, updates) {
  const f = state.favorites.find((x) => x.id === String(id));
  if (!f) return false;
  if (updates.name !== undefined) f.name = String(updates.name).slice(0, 80);
  if (updates.serverId !== undefined) f.serverId = String(updates.serverId).replace(/\D/g, '');
  if (updates.channelId !== undefined) f.channelId = String(updates.channelId).replace(/\D/g, '');
  if (!f.serverId || !f.channelId) return false;
  await persist();
  return true;
}

async function removeFavorite(id) {
  const before = state.favorites.length;
  state.favorites = state.favorites.filter((f) => f.id !== String(id));
  if (state.favorites.length === before) return false;
  await persist();
  return true;
}

async function setCurrent(serverId, channelId) {
  const sId = String(serverId ?? '').replace(/\D/g, '');
  const cId = String(channelId ?? '').replace(/\D/g, '');
  state.current = sId && cId ? { serverId: sId, channelId: cId } : null;
  if (state.current) wantVoice = true; // picking a channel means "be in voice"
  await persist();
  // If the bot is live, move it to the newly-selected channel (or leave voice).
  if (bot && rpc.connected) joinCurrentChannel().catch((e) => log(`rejoin failed: ${e.message}`));
  return state.current;
}

async function setSettings(updates) {
  if (!updates || typeof updates !== 'object') return false;
  const next = { ...state.settings };
  if (updates.streamerUserId !== undefined) {
    next.streamerUserId = String(updates.streamerUserId).replace(/\D/g, '');
  }
  if (updates.avatarPx !== undefined) next.avatarPx = clampInt(updates.avatarPx, 24, 128, DEFAULT_SETTINGS.avatarPx);
  if (updates.streamerPx !== undefined) next.streamerPx = clampInt(updates.streamerPx, 32, 160, DEFAULT_SETTINGS.streamerPx);
  if (updates.height !== undefined) next.height = clampInt(updates.height, 100, 400, DEFAULT_SETTINGS.height);
  if (updates.accent !== undefined) {
    const accent = String(updates.accent);
    if (['cyan', 'magenta', 'neon-green'].includes(accent)) next.accent = accent;
  }
  if (updates.scanlines !== undefined) next.scanlines = !!updates.scanlines;
  if (updates.neonBlink !== undefined) next.neonBlink = !!updates.neonBlink;
  if (updates.hideWhenAbsent !== undefined) next.hideWhenAbsent = !!updates.hideWhenAbsent;
  state.settings = next;
  await persist();
  return true;
}

function sanitizeFavorite({ name, serverId, channelId }) {
  const sId = String(serverId ?? '').replace(/\D/g, '');
  const cId = String(channelId ?? '').replace(/\D/g, '');
  if (!sId || !cId) return null;
  return {
    name: String(name ?? '').slice(0, 80) || `${sId.slice(-4)}/${cId.slice(-4)}`,
    serverId: sId,
    channelId: cId,
  };
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function persist() {
  await writeFile(CONFIG_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

async function persistTokens() {
  const out = { botToken: creds.botToken, enabled: creds.enabled };
  await writeFile(TOKENS_PATH, JSON.stringify(out, null, 2), 'utf-8');
}

// ── Operator commands (arrive over the bus; see dispatch() below) ────────────

// Operator clicked "Connect" — (re)start the bot with the FILE token. There is no
// token-over-the-bus path by design.
async function connectRpc() {
  if (!creds.botToken) {
    rpc.error = 'No bot token — create sidecar/discord-tokens.json (docs/STREAMERBOT-SETUP.md), then restart the bridge or press Connect again.';
    // The token file may have appeared since boot — try a quiet reload once.
    try {
      const t = JSON.parse(await readFile(TOKENS_PATH, 'utf-8'));
      creds.botToken = String(t.botToken ?? '').trim();
    } catch { /* still missing */ }
    if (!creds.botToken) { schedulePush(); return; }
  }
  creds.enabled = true;
  rpc.error = '';
  wantVoice = true;
  await persistTokens();
  stopBot();
  startBot();
}

// Gracefully leave the voice channel but stay logged in — proper voice
// disconnect (not a kick). Clears the intent so it won't auto-rejoin on the
// next login; USE/Connect brings it back.
function leaveVoice() {
  wantVoice = false;
  destroyVoice();
  voiceUsers = {};
  schedulePush();
}

// Forget the saved bot token (the file keeps `enabled` but loses the token).
async function resetAuth() {
  creds.botToken = '';
  await persistTokens();
  stopBot();
  schedulePush();
}

// ── Bot lifecycle (unchanged from the toolkit implementation) ────────────────

function startBot() {
  if (bot) return;
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  bot = client;
  // discord.js ≥14.22 name — 'ready' is deprecated (removal in v15) and logs a
  // DeprecationWarning on every login.
  client.once('clientReady', () => { onBotReady().catch((e) => log(`ready handler: ${e.message}`)); });
  client.on('voiceStateUpdate', onVoiceStateUpdate);
  client.on('error', (e) => log(`bot error: ${e.message}`));
  // discord.js auto-reconnects the gateway; just reflect the state.
  client.on('shardResume', () => { rpc.connected = true; schedulePush(); });
  client.on('shardDisconnect', () => { rpc.connected = false; schedulePush(); });
  // Session killed for good — relaunch once if still enabled.
  client.on('invalidated', () => {
    log('bot session invalidated');
    stopBot();
    if (creds.enabled) setTimeout(() => { if (creds.enabled && !bot) startBot(); }, 5000);
  });
  client.login(creds.botToken).catch((e) => {
    // Bad token or network error — surface it and wait for the operator (don't
    // hammer the login endpoint with a known-bad token).
    rpc.error = 'Bot login failed: ' + (e?.message || e);
    log(rpc.error);
    stopBot();
    schedulePush();
  });
}

function stopBot() {
  destroyVoice();
  if (bot) {
    const b = bot; bot = null;
    try { b.removeAllListeners(); b.destroy(); } catch {}
  }
  rpc.connected = false;
  rpc.hostInChannel = false;
  currentChannelId = null;
  voiceUsers = {};
  schedulePush();
}

async function onBotReady() {
  rpc.connected = true;
  rpc.error = '';
  log(`Bot logged in as ${bot?.user?.tag || '?'}`);
  if (wantVoice) await joinCurrentChannel();
  else schedulePush();
}

// ── Voice channel join + roster ─────────────────────────────────────────────

function destroyVoice() {
  if (voiceConn) { try { voiceConn.destroy(); } catch {} voiceConn = null; }
  currentChannelId = null;
  rpc.hostInChannel = false;
}

async function joinCurrentChannel() {
  if (!bot) return;
  const target = state.current; // { serverId, channelId } | null
  destroyVoice();
  voiceUsers = {};
  if (!target || !target.channelId) { schedulePush(); return; }
  try {
    const guild = await bot.guilds.fetch(target.serverId);
    const channel = await guild.channels.fetch(target.channelId);
    if (!channel || !channel.isVoiceBased()) {
      rpc.error = 'That channel is not a voice channel.';
      schedulePush();
      return;
    }
    seedFromChannel(channel);
    const conn = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // must not be deaf to receive speaking events
      selfMute: true,  // never transmit
    });
    voiceConn = conn;
    currentChannelId = channel.id;

    conn.on('error', (e) => log(`voice error: ${e.message}`));
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5000),
        ]);
        // Reconnecting — @discordjs/voice is handling it.
      } catch {
        if (voiceConn === conn) { destroyVoice(); schedulePush(); }
      }
    });

    attachReceiver(conn);
    schedulePush();
  } catch (e) {
    const raw = e?.message || String(e);
    const code = e?.code;
    if (code === 10004 || /unknown guild/i.test(raw)) {
      rpc.error = "Bot isn't in that server — invite it there, or pick a channel in a server the bot has joined.";
    } else if (code === 10003 || /unknown channel/i.test(raw)) {
      rpc.error = 'Channel not found — check the Channel ID.';
    } else if (code === 50001 || /missing access/i.test(raw)) {
      rpc.error = 'Missing access — give the bot View Channel + Connect on that channel.';
    } else if (code === 50013 || /missing permissions/i.test(raw)) {
      rpc.error = 'Missing permissions — the bot needs Connect on that voice channel.';
    } else {
      rpc.error = 'Join failed: ' + raw;
    }
    log(rpc.error);
    schedulePush();
  }
}

async function attachReceiver(conn) {
  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 20000);
  } catch (e) {
    rpc.error = 'Voice connection not ready: ' + (e?.message || e);
    log(rpc.error);
    return;
  }
  if (voiceConn !== conn) return; // superseded while connecting
  rpc.hostInChannel = true;
  rpc.error = '';
  const speaking = conn.receiver.speaking;
  speaking.on('start', (userId) => { setSpeaking(userId, true); schedulePush(); });
  speaking.on('end', (userId) => { setSpeaking(userId, false); schedulePush(); });
  log(`Joined voice channel ${currentChannelId} (${Object.keys(voiceUsers).length} present)`);
  schedulePush();
}

function seedFromChannel(channel) {
  voiceUsers = {};
  const members = channel.members; // Collection<id, GuildMember> currently in voice
  if (members && typeof members.forEach === 'function') {
    for (const [, member] of members) upsertMember(member);
  }
}

function onVoiceStateUpdate(oldState, newState) {
  if (!currentChannelId) return;
  const member = newState.member || oldState.member;
  if (!member || member.user?.bot) return; // ignore bots (incl. ourselves)
  const inNow = newState.channelId === currentChannelId;
  const wasIn = oldState.channelId === currentChannelId;
  if (inNow) { upsertMember(member); schedulePush(); }
  else if (wasIn) {
    if (voiceUsers[member.id]) { delete voiceUsers[member.id]; schedulePush(); }
  }
}

function upsertMember(member) {
  const user = member.user;
  if (!user || user.bot) return;
  const id = user.id;
  const prev = voiceUsers[id] || {};
  let avatarUrl;
  try { avatarUrl = user.displayAvatarURL({ extension: 'png', size: 256 }); }
  catch { avatarUrl = buildAvatarUrl(id, user.avatar ?? null); }
  const vs = member.voice || {};
  voiceUsers[id] = {
    speaking: prev.speaking || false,
    username: member.displayName || user.username || prev.username || '',
    avatarUrl,
    mute: !!(vs.mute || vs.selfMute || vs.serverMute),
    deaf: !!(vs.deaf || vs.selfDeaf || vs.serverDeaf),
  };
}

function setSpeaking(userId, val) {
  const id = String(userId ?? '');
  if (!id) return;
  if (!voiceUsers[id]) {
    voiceUsers[id] = { speaking: false, username: '', avatarUrl: buildAvatarUrl(id, null), mute: false, deaf: false };
  }
  voiceUsers[id].speaking = !!val;
}

function buildAvatarUrl(userId, avatarHash) {
  if (avatarHash) {
    const ext = String(avatarHash).startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=256`;
  }
  // Default embed avatar. BigInt is mandatory: a plain Number shift overflows the
  // 64-bit snowflake and returns the wrong index.
  let idx = 0;
  try { idx = Number((BigInt(userId) >> 22n) % 6n); } catch { idx = 0; }
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

// ── Streamer.bot WS client (replaces the :7070 relay client) ─────────────────

function connectSb() {
  if (sbWs && sbWs.readyState === WebSocket.OPEN) return;
  try {
    sbWs = new WebSocket(SB_WS_URL);
    sbWs.on('open', () => {
      if (sbReconnectTimer) { clearTimeout(sbReconnectTimer); sbReconnectTimer = null; }
      // Lowercase `general` — the SB Subscribe case gotcha (delivered events carry
      // capitalized 'General'; a capitalized Subscribe silently receives nothing).
      sbWs.send(JSON.stringify({ request: 'Subscribe', id: String(++sbMsgId), events: { general: ['Custom'] } }));
      log(`Connected to Streamer.bot at ${SB_WS_URL}`);
      pushNow(); // hand the current roster to a freshly (re)connected SB
    });
    sbWs.on('close', () => { sbWs = null; scheduleSbReconnect(); });
    sbWs.on('error', (e) => { log(`SB WS error: ${e.message} — is SB's WebSocket Server on ${SB_WS_URL} with auth OFF?`); });
    sbWs.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m && m.id && !m.event) return; // request acks
      if (!(m && m.event && m.event.source === 'General' && m.event.type === 'Custom')) return;
      let d = m.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
      // Echo-loop guard: this client also hears its own discord:voice:update
      // broadcasts (and vdoninja:update). Consume ONLY the command channel.
      if (!d || typeof d !== 'object' || d.type !== 'discord:voice:command') return;
      dispatch(String(d.command ?? ''), String(d.value ?? ''));
    });
  } catch {
    scheduleSbReconnect();
  }
}

function scheduleSbReconnect() {
  if (sbReconnectTimer) return;
  sbReconnectTimer = setTimeout(() => { sbReconnectTimer = null; connectSb(); }, 3000);
}

// Command dispatch — the inbound half of the two-way bus. `value` is always a
// plain string on the wire; structured commands carry JSON the control page
// pre-serialized (docs/PROTOCOL.md).
function dispatch(command, value) {
  const parsed = (() => { try { return value ? JSON.parse(value) : null; } catch { return null; } })();
  const done = (p) => p && typeof p.then === 'function'
    ? p.then(() => schedulePush()).catch((e) => { log(`command ${command} failed: ${e.message}`); schedulePush(); })
    : schedulePush();
  log(`command: ${command}${value ? ' ' + value.slice(0, 80) : ''}`);
  switch (command) {
    case 'connect':        return done(connectRpc());
    case 'leave':          return done(leaveVoice());
    case 'reset-auth':     return done(resetAuth());
    case 'set-current':    return done(parsed ? setCurrent(parsed.serverId, parsed.channelId) : null);
    case 'favorite-add':   return done(parsed ? addFavorite(parsed.name, parsed.serverId, parsed.channelId) : null);
    case 'favorite-update': return done(parsed ? updateFavorite(parsed.id, parsed) : null);
    case 'favorite-remove': return done(parsed ? removeFavorite(parsed.id) : null);
    case 'set-settings':   return done(parsed ? setSettings(parsed) : null);
    default:
      log(`unknown command "${command}" — ignored`); // mock-burst etc. are mock-only
      return;
  }
}

// Leading-edge push + ~100ms trailing coalesce so rapid speaking toggles stay
// responsive without flooding SB's action queue (worst case ~10 DoActions/s).
function schedulePush() {
  if (pushTimer) { pushPending = true; return; }
  pushNow();
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (pushPending) { pushPending = false; schedulePush(); }
  }, PUSH_MIN_MS);
}

function payloadOut() {
  return {
    channelId: currentChannelId,
    connected: rpc.connected,
    hostInChannel: rpc.hostInChannel,
    users: voiceUsers,
    // Superset fields (overlays ignore them; the control page + roster overlay
    // consume them): renderer settings, bot status, and the channel book-keeping.
    settings: { ...state.settings },
    rpc: { enabled: creds.enabled, hasToken: !!creds.botToken, error: rpc.error },
    favorites: state.favorites.map((f) => ({ ...f })),
    current: state.current ? { ...state.current } : null,
  };
}

function pushNow() {
  if (!sbWs || sbWs.readyState !== WebSocket.OPEN) return;
  try {
    sbWs.send(JSON.stringify({
      request: 'DoAction',
      id: String(++sbMsgId),
      action: { name: 'Discord Voice Push' },
      args: { payload: JSON.stringify(payloadOut()) },
    }));
  } catch { /* SB closing */ }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] [discord-bridge] ${msg}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

function acquireGuard() {
  return new Promise((res) => {
    const guard = createServer();
    guard.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log(`Another bridge instance is already running (guard port :${GUARD_PORT}) — exiting.`);
        process.exit(0);
      }
      log(`guard port error: ${err.message} — continuing without the single-instance guard`);
      res();
    });
    guard.listen(GUARD_PORT, '127.0.0.1', () => res());
  });
}

async function main() {
  log(`Greenroom Discord bridge starting (config: ${CONFIG_PATH})`);
  await acquireGuard();
  await init();
  connectSb();
  const shutdown = () => {
    log('shutting down');
    stopBot();
    try { sbWs?.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
