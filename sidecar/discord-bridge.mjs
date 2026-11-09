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
// Args: --sb-ws-url=ws://127.0.0.1:8080/ · --guard-port=7495 · --exit-on-sb-close=1|0
//       (an argument wins over the matching environment variable below)
// Env:  SB_WS_URL (default ws://127.0.0.1:8080/) · GREENROOM_GUARD_PORT (7495)
//       GREENROOM_EXIT_ON_SB_CLOSE (1/0 — override settings.exitOnSbClose) ·
//       GREENROOM_SB_EXIT_GRACE_MS (default 8000, the leave-when-SB-closes window)
//       DISCORD_BRIDGE_CONFIG / DISCORD_BRIDGE_TOKENS (test hooks: file paths)
//       DISCORD_BRIDGE_API (test hook: a loopback http URL used as Discord's REST base)
//       GREENROOM_TEST_HOOKS=1 (test hooks: the test-* commands, GREENROOM_BRIDGE_VERSION)
//
// ONE POLICY FOR CRASHES AND EXITS (GRN-129): every way out goes through shutdown(code): signals, the quit
// command, exit-on-SB-close and a crash. It sets `stopping` first (nothing else is pushed), closes the guard,
// leaves voice once, sends ONE clearing state (stopped, hb 0, no users) to Streamer.bot and exits from the send
// callback (not sooner than 300 ms, not later than 1.5 s). An unhandled rejection is logged and the bridge goes on;
// an uncaught exception shuts down with code 1 and the error in rpc.error.

import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, writeSync } from 'node:fs';
import { createServer, connect as netConnect } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import WebSocket from 'ws';

// Node first, then the heavy imports: an old Node says so instead of failing inside discord.js (GRN-22).
{
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    process.stderr.write(`Node >= 22.12 required, found ${process.versions.node}\n`);
    process.exit(1);
  }
}
const { Client, GatewayIntentBits } = await import('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = await import('@discordjs/voice');

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.DISCORD_BRIDGE_CONFIG || resolve(__dirname, 'discord-voice-config.json');
const EXAMPLE_PATH = resolve(__dirname, 'discord-voice-config.example.json');
// Secrets (the bot token) live in a SEPARATE gitignored file — never in config.
const TOKENS_PATH = process.env.DISCORD_BRIDGE_TOKENS || resolve(__dirname, 'discord-tokens.json');
const TEST_HOOKS = process.env.GREENROOM_TEST_HOOKS === '1';
// The command line wins over the environment (GRN-142): `--name=value`.
const argOf = (name) => {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit === undefined ? undefined : hit.slice(p.length);
};
const SB_WS_URL = argOf('sb-ws-url') || process.env.SB_WS_URL || `ws://127.0.0.1:${process.env.SB_WS_PORT || 8080}/`;
// Single-instance guard: a second launch (double-click + SB action) exits cleanly
// instead of double-pushing and fighting over the voice connection. The guard speaks:
// it sends a banner (name, pid, version) so a newer build can replace an older one (GRN-22, GRN-110).
const GUARD_PORT = Number(argOf('guard-port')) || Number(process.env.GREENROOM_GUARD_PORT) || 7495;
const VERSION = (() => {
  if (TEST_HOOKS && process.env.GREENROOM_BRIDGE_VERSION) return String(process.env.GREENROOM_BRIDGE_VERSION);
  try { return String(JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version || '0.0.0'); } catch { return '0.0.0'; }
})();
const HEARTBEAT_MS = 5000;
// Numeric, part by part: 1.0.9 is older than 1.0.10.
const cmpVersion = (a, b) => {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0), pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
};
// Exit-when-Streamer.bot-closes: how long to wait after the SB WebSocket drops
// before deciding SB is gone for good and shutting down. A short blip or an SB
// restart reconnects well inside this window and cancels the shutdown. The
// behaviour itself is opt-in (settings.exitOnSbClose or the env override below).
const SB_EXIT_GRACE_MS = Math.max(1000, Number(process.env.GREENROOM_SB_EXIT_GRACE_MS) || 8000);

const DEFAULT_SETTINGS = {
  streamerUserId: '', // set yours in the control page (streamer-first roster order)
  avatarPx: 56,
  streamerPx: 72,
  height: 180,
  accent: 'cyan', // 'cyan' | 'magenta' | 'neon-green'
  scanlines: true,
  neonBlink: true,
  hideWhenAbsent: true,
  // Lifecycle (not a render setting): when true, the sidecar gracefully leaves
  // the voice call and exits once Streamer.bot closes — so the bot doesn't linger
  // in the channel after you close SB. The env var GREENROOM_EXIT_ON_SB_CLOSE
  // overrides this when set. Opt-in (default off preserves reconnect-forever).
  exitOnSbClose: false,
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
let sbEverConnected = false;  // gate exit-on-close on having actually reached SB
let sbGoneTimer = null;       // grace countdown to graceful shutdown after SB drops
let sbLost = false;           // the SB socket closed after having been open, and has not been open again

// Throttle the voice feed: leading-edge push + ~100ms trailing coalesce.
const PUSH_MIN_MS = 100;
let pushTimer = null;
let pushPending = false;
let heartbeatTimer = null;   // a push every HEARTBEAT_MS, so the overlays can tell a live bridge from a dead one (hb in the payload)
let stopping = false;        // shutdown(code) has begun: nothing else is pushed, and nothing starts
let guardServer = null;      // the single-instance guard (acquireGuard)
const guardSockets = new Set();
const logins = new WeakMap(); // Client -> { settled, destroyWanted }: a client is destroyed only after its login settles (GRN-130)
let loginRetryTimer = null;   // the relaunch after an invalidated session

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
  if (updates.exitOnSbClose !== undefined) next.exitOnSbClose = !!updates.exitOnSbClose;
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

// A test hook: Discord's REST base, loopback only (the token goes with every request, so it can never be pointed elsewhere).
function restOptions() {
  const api = process.env.DISCORD_BRIDGE_API;
  return api && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(api) ? { rest: { api } } : {};
}

function startBot() {
  if (bot || stopping) return;
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates], ...restOptions() });
  bot = client;
  const login = { settled: false, destroyWanted: false };
  logins.set(client, login);
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
    if (creds.enabled && !stopping) loginRetryTimer = setTimeout(() => { loginRetryTimer = null; if (creds.enabled && !bot && !stopping) startBot(); }, 5000);
  });
  client.login(creds.botToken).then(() => {
    login.settled = true;
    if (login.destroyWanted) destroyClient(client); // it was stopped while it dialed: now that the login is over, close it
  }, (e) => {
    login.settled = true;
    if (login.destroyWanted) destroyClient(client);
    // A login that was replaced or stopped meanwhile says nothing about the bot that is running now (GRN-130).
    if (bot !== client) return;
    // Bad token or network error — surface it and wait for the operator (don't
    // hammer the login endpoint with a known-bad token).
    rpc.error = 'Bot login failed: ' + (e?.message || e);
    log(rpc.error);
    stopBot();
    schedulePush();
  });
}

// A gateway socket that is still being dialed raises an 'error' when it is closed: listen for it so it can never be uncaught (GRN-76).
function hushGateway(b) {
  try {
    const shards = b.ws && b.ws.manager && b.ws.manager.shards;
    if (shards && typeof shards.forEach === 'function') shards.forEach((sh) => { const c = sh && sh.connection; if (c && typeof c.on === 'function') c.on('error', () => {}); });
  } catch { /* internals differ: the destroy below is still guarded */ }
}
function destroyClient(b) {
  hushGateway(b);
  try { b.destroy(); } catch { /* already gone */ }
}

function stopBot() {
  destroyVoice();
  if (bot) {
    const b = bot; bot = null;
    try { b.removeAllListeners(); b.on('error', () => {}); } catch {}
    const login = logins.get(b);
    // A login in flight is closed when it settles (destroying a client that is still dialing can throw from inside discord.js).
    if (login && !login.settled) login.destroyWanted = true; else destroyClient(b);
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
  speaking.on('start', (userId) => { try { setSpeaking(userId, true); schedulePush(); } catch (e) { log(`speaking start: ${e.message}`); } });
  speaking.on('end', (userId) => { try { setSpeaking(userId, false); schedulePush(); } catch (e) { log(`speaking end: ${e.message}`); } });
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
  try {
    if (!currentChannelId) return;
    const member = newState.member || oldState.member;
    if (!member || member.user?.bot) return; // ignore bots (incl. ourselves)
    const inNow = newState.channelId === currentChannelId;
    const wasIn = oldState.channelId === currentChannelId;
    if (inNow) { upsertMember(member); schedulePush(); }
    else if (wasIn) {
      if (voiceUsers[member.id]) { delete voiceUsers[member.id]; schedulePush(); }
    }
  } catch (e) { log(`voice state update: ${e.message}`); }
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

const sbOpen = () => !!sbWs && sbWs.readyState === WebSocket.OPEN;

function connectSb() {
  if (stopping || (sbWs && (sbWs.readyState === WebSocket.OPEN || sbWs.readyState === WebSocket.CONNECTING))) return;
  try {
    // handshakeTimeout: a connect that hangs half-open logs an error and is retried (GRN-142).
    const sock = new WebSocket(SB_WS_URL, { handshakeTimeout: 5000 });
    sbWs = sock;
    sock.on('open', () => {
      if (sbReconnectTimer) { clearTimeout(sbReconnectTimer); sbReconnectTimer = null; }
      sbEverConnected = true;
      // SB is back (or up for the first time) — cancel any pending exit countdown.
      const wasLost = sbLost; sbLost = false;
      if (sbGoneTimer) { clearTimeout(sbGoneTimer); sbGoneTimer = null; log('Streamer.bot reconnected — cancelling shutdown.'); }
      else if (wasLost && shouldExitOnSbClose()) log('Streamer.bot reconnected on the last attempt — staying up.');
      // Lowercase `general` — the SB Subscribe case gotcha (delivered events carry
      // capitalized 'General'; a capitalized Subscribe silently receives nothing).
      sock.send(JSON.stringify({ request: 'Subscribe', id: String(++sbMsgId), events: { general: ['Custom'] } }));
      log(`Connected to Streamer.bot at ${SB_WS_URL}`);
      // Hand the current roster to a freshly (re)connected SB: through the same 100 ms window as every other push, so a burst of
      // changes at connect is one frame (GRN-02).
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      pushPending = false;
      schedulePush();
    });
    sock.on('close', () => { if (sbWs === sock) sbWs = null; if (sbEverConnected) sbLost = true; scheduleSbReconnect(); armSbGoneTimer(); });
    sock.on('error', (e) => { log(`SB WS error: ${e.message} — is SB's WebSocket Server on ${SB_WS_URL} with auth OFF?`); });
    sock.on('message', (raw) => {
      try {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m && m.id && !m.event) return; // request acks
        if (!(m && m.event && m.event.source === 'General' && m.event.type === 'Custom')) return;
        let d = m.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
        // Echo-loop guard: this client also hears its own discord:voice:update
        // broadcasts (and vdoninja:update). Consume ONLY the command channel.
        if (!d || typeof d !== 'object' || d.type !== 'discord:voice:command') return;
        // Anyone on the bus can send any JSON: a command is a string and a value is a string or absent. Anything else is dropped
        // (String() on an object with a hostile toString throws), and only the types are logged.
        if (typeof d.command !== 'string' || !(d.value == null || typeof d.value === 'string')) {
          log(`dropped a command frame: command is ${typeof d.command}, value is ${typeof d.value}`);
          return;
        }
        dispatch(d.command, d.value == null ? '' : d.value);
      } catch (e) { log(`message handler: ${e && e.message}`); }
    });
  } catch {
    scheduleSbReconnect();
  }
}

// While the exit-on-SB-close countdown is running the retry is quick (about every 750 ms), so a Streamer.bot that comes back
// inside the grace window is found well before it ends (GRN-180).
function scheduleSbReconnect() {
  if (sbReconnectTimer || stopping) return;
  sbReconnectTimer = setTimeout(() => { sbReconnectTimer = null; connectSb(); }, sbGoneTimer ? 750 : 3000);
}

// Opt-in: leave the call + shut down when Streamer.bot closes. The env var wins
// when set (GREENROOM_EXIT_ON_SB_CLOSE=1/0); otherwise the persisted setting.
function shouldExitOnSbClose() {
  const arg = argOf('exit-on-sb-close');
  if (arg !== undefined && arg !== '') return /^(1|true|yes|on)$/i.test(arg.trim());
  const env = process.env.GREENROOM_EXIT_ON_SB_CLOSE;
  if (env !== undefined && env !== '') return /^(1|true|yes|on)$/i.test(env.trim());
  return !!state.settings.exitOnSbClose;
}

// SB's WS just dropped. If the operator opted in and we had actually been
// connected (so a never-yet-reached SB during dev doesn't quit us), start a
// grace countdown. A reconnect within the window clears it (see the open
// handler); if it fires, SB is gone for good — disconnect from voice and exit
// so the bot doesn't linger in the channel.
function armSbGoneTimer() {
  if (stopping || !shouldExitOnSbClose() || !sbEverConnected || sbGoneTimer) return;
  log(`Streamer.bot connection lost — will leave voice and exit in ${SB_EXIT_GRACE_MS}ms if it doesn't return (exitOnSbClose).`);
  sbGoneTimer = setTimeout(() => {
    sbGoneTimer = null;
    if (sbOpen()) return; // came back in the meantime
    // One last attempt before giving up: a Streamer.bot that is back but not yet found keeps the bridge alive (GRN-180).
    log('Streamer.bot has not returned within the grace window — one last attempt.');
    if (sbReconnectTimer) { clearTimeout(sbReconnectTimer); sbReconnectTimer = null; }
    connectSb();
    setTimeout(() => {
      if (stopping || sbOpen()) return;
      log('Streamer.bot did not return — disconnecting from voice and shutting down.');
      shutdown(0, 'Streamer.bot closed');
    }, 1000);
  }, SB_EXIT_GRACE_MS);
}

// Command dispatch — the inbound half of the two-way bus. `value` is always a
// plain string on the wire; structured commands carry JSON the control page
// pre-serialized (docs/PROTOCOL.md).
function dispatch(command, value) {
  if (stopping) return;
  const parsed = (() => { try { return value ? JSON.parse(value) : null; } catch { return null; } })();
  const done = (p) => p && typeof p.then === 'function'
    ? p.then(() => schedulePush()).catch((e) => { log(`command ${command} failed: ${e.message}`); schedulePush(); })
    : schedulePush();
  log(`command: ${clean(command, 40)}${value ? ' ' + value.slice(0, 80) : ''}`);
  try {
    switch (command) {
      case 'connect':        return done(connectRpc());
      case 'leave':          return done(leaveVoice());
      case 'reset-auth':     return done(resetAuth());
      case 'set-current':    return done(parsed ? setCurrent(parsed.serverId, parsed.channelId) : null);
      case 'favorite-add':   return done(parsed ? addFavorite(parsed.name, parsed.serverId, parsed.channelId) : null);
      case 'favorite-update': return done(parsed ? updateFavorite(parsed.id, parsed) : null);
      case 'favorite-remove': return done(parsed ? removeFavorite(parsed.id) : null);
      case 'set-settings':   return done(parsed ? setSettings(parsed) : null);
      case 'quit':           return void shutdown(0, 'quit command'); // the clean stop (a newer build asks the same of an older one)
      default:
        // Test hooks (GREENROOM_TEST_HOOKS=1 only): the crash policy is exercised on the real process.
        if (TEST_HOOKS && command === 'test-throw-sync') throw new Error('forced synchronous throw');
        if (TEST_HOOKS && command === 'test-throw') { setTimeout(() => { throw new Error(value || 'forced throw from a timer'); }, 10); return; }
        if (TEST_HOOKS && command === 'test-reject') { Promise.reject(new Error('forced rejection')); return; }
        if (TEST_HOOKS && command === 'test-signal') { process.emit(String(value), String(value)); return; }
        log(`unknown command "${clean(command, 40)}" — ignored`); // mock-burst etc. are mock-only
        return;
    }
  } catch (e) { log(`command ${clean(command, 40)} failed: ${e && e.message}`); schedulePush(); }
}

// Leading-edge push + ~100ms trailing coalesce so rapid speaking toggles stay
// responsive without flooding SB's action queue (worst case ~10 DoActions/s).
function schedulePush() {
  if (stopping) return;                        // the clearing state is sent by shutdown(), once
  if (!sbOpen()) return;                       // nothing to send to; the open handler pushes when SB is back
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
    rpc: { enabled: creds.enabled, hasToken: !!creds.botToken, error: redact(clean(rpc.error, 300)) },
    favorites: state.favorites.map((f) => ({ ...f })),
    current: state.current ? { ...state.current } : null,
    // Liveness and identity (additive; docs/PROTOCOL.md): a push every `hb` ms while the bridge runs (0 once it is stopping),
    // `stopped` on the last frame it sends, and the build that sent it.
    hb: stopping ? 0 : HEARTBEAT_MS,
    stopped: stopping,
    bridgeVersion: VERSION,
  };
}

function frameOut() {
  return JSON.stringify({
    request: 'DoAction',
    id: String(++sbMsgId),
    action: { name: 'Discord Voice Push' },
    args: { payload: JSON.stringify(payloadOut()) },
  });
}

function pushNow() {
  if (stopping || !sbOpen()) return;
  try { sbWs.send(frameOut()); } catch { /* SB closing */ }
}

// ── Logging: off the main thread, so a console that stops draining cannot stall the bridge (GRN-69) ──
// A console window in QuickEdit mode freezes the process that writes to it as soon as someone clicks in it. The lines go to a
// worker thread that does the (blocking) fd write; if that blocks, the bridge keeps pushing. Control characters are replaced and
// the bot token is never written (GRN-16).
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, n);
const redact = (s) => {
  const t = creds && creds.botToken;
  return t && String(t).length >= 8 ? String(s).split(String(t)).join('[bot token]') : String(s);
};
let logWorker = null;
try {
  logWorker = new Worker(
    "const { parentPort } = require('node:worker_threads'); const fs = require('node:fs');" +
    "parentPort.on('message', (m) => { if (typeof m === 'string') { try { fs.writeSync(1, m); } catch (e) {} } else if (m && m.flush) parentPort.postMessage(m.flush); });",
    { eval: true });
  logWorker.on('error', () => { logWorker = null; });
  logWorker.unref();
} catch { logWorker = null; }

function log(msg) {
  const line = `[${new Date().toISOString()}] [discord-bridge] ${redact(clean(msg, 2000))}\n`;
  if (logWorker) { try { logWorker.postMessage(line); return; } catch { /* fall through */ } }
  try { writeSync(1, line); } catch { /* no console */ }
}
// Wait (at most `ms`) until the worker has written everything posted so far. A blocked console never answers: the caller goes on.
function flushLog(ms) {
  return new Promise((res) => {
    if (!logWorker) return res();
    const id = Math.random();
    const t = setTimeout(res, ms);
    const onMsg = (m) => { if (m === id) { clearTimeout(t); logWorker && logWorker.off('message', onMsg); res(); } };
    try { logWorker.on('message', onMsg); logWorker.postMessage({ flush: id }); } catch { clearTimeout(t); res(); }
  });
}
function logNow(msg) { // main thread, for the last lines before an exit (a crash stack)
  try { writeSync(2, `[${new Date().toISOString()}] [discord-bridge] ${redact(clean(msg, 2000))}\n`); } catch { /* no console */ }
}

// ── One way out (GRN-129) ─────────────────────────────────────────────────────

// The clearing frame: stopped, hb 0, nobody in voice. Sent once, from shutdown().
function pushFinal(cb) {
  if (!sbOpen()) return cb();
  try { sbWs.send(frameOut(), () => cb()); } catch { cb(); }
}

function shutdown(code, why) {
  if (stopping) return;
  stopping = true;
  const t0 = Date.now();
  try {
    log(`shutting down (${why})`);
    closeGuard();                                // first, so a relaunch can take over (GRN-180)
    if (sbReconnectTimer) { clearTimeout(sbReconnectTimer); sbReconnectTimer = null; }
    if (sbGoneTimer) { clearTimeout(sbGoneTimer); sbGoneTimer = null; }
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (loginRetryTimer) { clearTimeout(loginRetryTimer); loginRetryTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    pushPending = false;
    stopBot();                                   // leaves voice once; schedulePush() is a no-op from here on
    voiceUsers = {}; rpc.connected = false; rpc.hostInChannel = false; currentChannelId = null;
  } catch (e) { logNow(`shutdown: ${e && e.message}`); }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    flushLog(250).then(() => process.exit(code), () => process.exit(code));
  };
  setTimeout(finish, 1500).unref?.();            // never later than 1.5 s
  pushFinal(() => setTimeout(finish, Math.max(0, 300 - (Date.now() - t0)))); // never sooner than 300 ms: the leave frames flush
}

// ── Entry point ───────────────────────────────────────────────────────────────

const closeGuard = () => {
  try { guardServer && guardServer.close(); } catch { /* not open */ }
  for (const s of guardSockets) { try { s.destroy(); } catch { /* gone */ } }
  guardSockets.clear();
  guardServer = null;
};

// What an old holder is asked, and by whom: a banner out, one "quit <version>" line in.
function guardConnection(s) {
  guardSockets.add(s);
  s.on('error', () => {});
  s.on('close', () => guardSockets.delete(s));
  s.setTimeout(1000, () => s.destroy());
  try { s.write(JSON.stringify({ name: 'greenroom-bridge', pid: process.pid, version: VERSION }) + '\n'); } catch { /* peer gone */ }
  s.setEncoding('utf8');
  let buf = '';
  s.on('data', (d) => {
    buf += d;
    if (buf.length > 200) { s.destroy(); return; }
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const m = /^quit (\S{1,40})$/.exec(buf.slice(0, nl).trim());
    buf = buf.slice(nl + 1);
    if (m && cmpVersion(m[1], VERSION) > 0) {
      log(`a newer bridge (${m[1]}) asked this one (${VERSION}) to quit — leaving voice and exiting.`);
      shutdown(0, 'replaced by a newer bridge');
    }
  });
}

// Who holds the guard port? Connects, reads the banner (a line of JSON), gives up after ~500 ms. null = no Greenroom banner.
function readBanner(port) {
  return new Promise((res) => {
    let done = false, buf = '';
    const s = netConnect(port, '127.0.0.1');
    const end = (v, quit) => { if (done) return; done = true; clearTimeout(t); if (quit) { try { s.write(quit + '\n'); } catch { /* gone */ } setTimeout(() => s.destroy(), 100); } else s.destroy(); res(v); };
    const t = setTimeout(() => end(null), 500);
    s.setEncoding('utf8');
    s.on('error', () => end(null));
    s.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0 && buf.length < 300) return;
      let b = null; try { b = JSON.parse(buf.slice(0, nl < 0 ? buf.length : nl)); } catch { /* not ours */ }
      if (b && b.name === 'greenroom-bridge' && typeof b.version === 'string') {
        // a newer build asks the older holder to quit on this same socket (GRN-110)
        if (cmpVersion(VERSION, b.version) > 0) { s.removeAllListeners('data'); end(b, `quit ${VERSION}`); } else end(b);
      } else end(null);
    });
  });
}

const listenGuard = () => new Promise((res) => {
  const server = createServer(guardConnection);
  server.once('error', (err) => res({ err }));
  server.listen(GUARD_PORT, '127.0.0.1', () => { server.removeAllListeners('error'); server.on('error', () => {}); res({ server }); });
});

async function acquireGuard() {
  let got = await listenGuard();
  if (got.server) { guardServer = got.server; return; }
  if (got.err.code !== 'EADDRINUSE') {
    log(`guard port error: ${got.err.message} — continuing without the single-instance guard`);
    return;
  }
  const holder = await readBanner(GUARD_PORT);
  if (!holder) {
    log(`guard port :${GUARD_PORT} is held by another program or by a Greenroom bridge older than this release (it sends no banner): stop it, or set --guard-port or GREENROOM_GUARD_PORT`);
    await flushLog(300);
    process.exit(1);
  }
  if (cmpVersion(VERSION, holder.version) <= 0) {
    log(`a Greenroom bridge (version ${holder.version}, pid ${holder.pid}) is already running and is the same version or newer than this one (${VERSION}) — exiting.`);
    await flushLog(300);
    process.exit(0);
  }
  log(`a Greenroom bridge ${holder.version} (pid ${holder.pid}) is running: this is ${VERSION}, taking over (it was asked to quit).`);
  for (let i = 0; i < 24; i++) { // the holder closes its guard first, then leaves voice
    await new Promise((r) => setTimeout(r, 250));
    got = await listenGuard();
    if (got.server) { guardServer = got.server; return; }
  }
  log(`the bridge ${holder.version} on guard port :${GUARD_PORT} did not quit — stop it (end node.exe) and start again.`);
  await flushLog(300);
  process.exit(1);
}

async function main() {
  // The way out first: signals and the last-resort handlers exist before anything else starts (GRN-129, GRN-128).
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => shutdown(0, sig));
  process.on('unhandledRejection', (reason) => { log(`unhandled rejection: ${reason && reason.message ? reason.message : reason}`); });
  process.on('uncaughtException', (err) => {
    logNow(`uncaught exception: ${(err && err.stack) || err}`);
    rpc.error = 'Bridge crashed: ' + ((err && err.message) || err);
    shutdown(1, 'uncaught exception');
    setTimeout(() => process.exit(1), 2000).unref?.(); // belt and braces
  });
  log(`Greenroom Discord bridge ${VERSION} starting (config: ${CONFIG_PATH})`);
  await acquireGuard();
  await init();
  connectSb();
  heartbeatTimer = setInterval(schedulePush, HEARTBEAT_MS);
}

main().catch((e) => { rpc.error = 'Bridge failed to start: ' + ((e && e.message) || e); logNow(`startup failed: ${(e && e.stack) || e}`); shutdown(1, 'startup failed'); });
