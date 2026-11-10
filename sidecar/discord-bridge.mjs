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
// Ported from the toolkit's ControlPanel/src/discord-voice.js (the error taxonomy
// and the BigInt avatar math carried over); the transport moved from the old :7070
// relay to SB's WS, the payload grew settings/rpc/favorites/current so the control
// page can render status without a private channel, and the voice side is this
// plugin's own: the target is checked before the working channel is left, a dropped
// connection is rejoined with a backoff (2, 5, 15, then 30 s), a removal by Discord
// (voice close 4014/4021/4022) parks the bridge until USE or Connect, and the roster
// is reconciled when the gateway resumes or re-identifies. The intent to be in voice
// lives in memory only: a bridge restart wants voice again.
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
//       GREENROOM_TEST_HOOKS=1 (test hooks: the test-* commands, GREENROOM_BRIDGE_VERSION,
//       GREENROOM_REFUSAL_MS: how long the refusal of a USE stays on the status line)
//
// ONE POLICY FOR CRASHES AND EXITS (GRN-129): every way out goes through shutdown(code): signals, the quit
// command, exit-on-SB-close and a crash. It sets `stopping` first (nothing else is pushed), closes the guard,
// leaves voice once, sends ONE clearing state (stopped, hb 0, no users) to Streamer.bot and exits from the send
// callback (not sooner than 300 ms, not later than 3.5 s: the config and token writes in flight get up to 2 s to land first).
// An unhandled rejection is logged and the bridge goes on;
// an uncaught exception shuts down with code 1 and the error in rpc.error.

import { readFile, open, rename, rm, copyFile, realpath, stat } from 'node:fs/promises';
import { readFileSync, writeSync } from 'node:fs';
import { createServer, connect as netConnect } from 'node:net';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import WebSocket from 'ws';
import { DEFAULT_SETTINGS, sanitizeSettings, digitsOnly, cutName, parseJson, parseJsonLossless, normalizeFavorite, SNOWFLAKE_RE } from './settings.mjs';

// Node first, then the heavy imports: an old Node says so instead of failing inside discord.js (GRN-22).
{
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    process.stderr.write(`Node >= 22.12 required, found ${process.versions.node}\n`);
    process.exit(1);
  }
}
const { Client, GatewayIntentBits, ChannelType, Status } = await import('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, VoiceConnectionDisconnectReason, entersState } = await import('@discordjs/voice');

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
// How long the refusal of a USE stays on the status line: the bot is still working in its channel, so the message is news for a
// minute, not for the rest of the stream (a refusal at login stays: nothing is joined).
const REFUSAL_MS = (TEST_HOOKS && Number(process.env.GREENROOM_REFUSAL_MS)) || 60000;
// The timers of the voice and login recovery (GRN-49, 141, 53, 52, 174). The test hooks can shorten them with GREENROOM_TIMING, a JSON
// object (0 turns a watchdog off). The backoff steps are for a rejoin after a loss; the last one repeats.
const TIMING = (() => {
  const t = {
    notReadyMs: 20000,       // a connection that is not Ready after this long gets a warning (it is never destroyed for it)
    stallWarnMs: 10000,      // a connection that WAS Ready and is outside Ready this long: hostInChannel false + a message
    stallLostMs: 30000,      // outside Ready this long (Ready or not): the connection is dropped and rebuilt
    backoffMs: [2000, 5000, 15000, 30000],
    disconnectRaceMs: 5000,  // a Disconnected connection that does not start reconnecting within this long is lost
    sessionDropMs: 15000,    // a 4014 this soon after a gateway reconnect is a dropped session, not a kick
    loginStartMs: 5000, loginCapMs: 300000, // the login retry: 5 s, doubling, up to 5 minutes
    speakingStaleMs: 300000, // no speaking start for this long with someone unmuted in the call: rpc.speakingStale
    stuckGlowMs: 180000,     // a glow that has been on this long with no end: rpc.speakingStale
    writeDelayMs: 0,         // (test hook) a slow disk: every atomic write waits this long before its rename
  };
  if (TEST_HOOKS && process.env.GREENROOM_TIMING) {
    try { const o = JSON.parse(process.env.GREENROOM_TIMING); for (const k of Object.keys(t)) if (o[k] !== undefined) t[k] = o[k]; } catch { /* keep the defaults */ }
  }
  return t;
})();
// Discord's voice close codes that mean "do not reconnect": 4014 disconnected (removed from the call, or the channel deleted), 4021 rate
// limited, 4022 call terminated. @discordjs/voice makes a Disconnected state out of 4014 only; the bridge catches 4021 and 4022 where
// the library sees them (see joinCurrentChannel).
const PARK_CODES = new Set([4014, 4021, 4022]);
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
  reconnecting: false,  // the gateway is resuming or re-identifying (status only: `connected` stays true)
};

let bot = null;              // discord.js Client
let voiceConn = null;        // current @discordjs/voice VoiceConnection
let wantVoice = true;        // operator intent: should the bot be in voice? (a manual Leave sets false so it won't
                             // rejoin; USE and Connect set it again. In memory only: a bridge restart wants voice.)
let useSeq = 0;              // the newest USE: a check that finishes for an older one is dropped (GRN-204)
let joinGen = 0;             // the newest join, leave or stop: an older join that is still waiting does nothing more
let currentRefused = false;  // the saved current channel failed its check (at login or at a rejoin) for a configuration reason: not joined (payload `currentRefused`)
let refusalText = '';        // the text of the refusal of the last USE while it is on the status line
let refusalTimer = null;
// Names and avatars seen on VOICE_STATE_UPDATE frames, by user id (GRN-210): a guest invited into the call has no cached GuildMember
// in discord.js, so the frame is where their name comes from. Refreshed by every frame, bounded.
const seenUsers = new Map();
const SEEN_USERS_MAX = 300;
const looking = new Set();   // guests whose name is being looked up (REST)
// Voice recovery (GRN-49): the intended target is state.current while wantVoice is true (set by USE and Connect, cleared by Leave).
let rejoinTimer = null;      // the backoff before the next rejoin
let rejoinStep = 0;          // how many rejoins in a row have been scheduled (reset by Ready, USE, Connect, Leave)
let voiceParked = false;     // Discord removed the bot from the call (4014/4021/4022): nothing rejoins until USE or Connect
let lastGatewayAt = 0;       // the last shard reconnect, resume or ready: a 4014 this soon after is a dropped session
let loginStep = 0;           // the login retry backoff step (GRN-52)
const voiceWatch = new WeakMap(); // connection -> its stall clocks
const armed = new WeakSet();      // connections that have their Ready listener (GRN-53)
const wired = new WeakSet();      // connections that have their speaking listeners
let wiredAt = 0, lastSpeakStartAt = 0; // GRN-174
const joinedGuilds = new Set(); // servers the bridge has put the bot in a call in (this run): a leave that was lost is looked for there (GRN-150)
let readyGuildIds = null;    // the servers the last READY listed: a current server that is missing from a new session was left or deleted (GRN-141)
let currentUnreadable = false; // the bot was dragged into a channel whose roster the bridge cannot read (a Stage)
const speakingSince = new Map();  // user id -> when the glow came on
let testKeptConn = null;     // (test hook) a connection kept to prove that its events are ignored later

// Streamer.bot WS client (replaces the old StreamService :7070 relay client).
let sbWs = null;
let sbReconnectTimer = null;
let sbMsgId = 0;
let sbEverConnected = false;  // gate exit-on-close on having actually reached SB
let sbGoneTimer = null;       // grace countdown to graceful shutdown after SB drops
let sbLastTry = false;        // the one last connect at the end of the exit grace window is running
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
let loginRetryTimer = null;   // the backoff before the next login attempt after a failed one (GRN-52)

// ── Files: loading, writing, and what is kept when a file is bad (GRN-19, 93, 77, 92, 68) ──────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT_FS = new Set(['EBUSY', 'EPERM', 'EACCES']); // a lock that usually goes away: a scanner, OneDrive, an editor
// Saved ids are 17 to 20 digits. The tests' fixtures use short ones, so they switch the strictness off (test hooks only).
const ID_RE = TEST_HOOKS && process.env.GREENROOM_LOOSE_IDS === '1' ? /^\d{1,20}$/ : SNOWFLAKE_RE;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// One reader for every JSON file: a Buffer, decoded as UTF-16 (a BOM FF FE or FE FF: what PowerShell's `>` writes; UTF-16 without a BOM is not
// recognised) or UTF-8 (a BOM is stripped), parsed by `parse` (ids kept as text by default). It says WHY it failed: missing (ENOENT: the only
// case that is seeded from the example), unreadable (locked or refused for about 2 s: EBUSY, EPERM, EACCES) or invalid (not JSON, or not a
// file that can be read). On success the raw bytes come back too (so a writer can tell whether the file changed under it).
async function loadJson(path, parse = parseJson) {
  let buf = null, lastErr = null;
  for (let i = 0; i < 11 && !buf; i++) {
    try { buf = await readFile(path); }
    catch (e) {
      if (e && e.code === 'ENOENT') return { status: 'missing' };
      lastErr = e;
      if (!(e && TRANSIENT_FS.has(e.code))) return { status: 'invalid', error: e };
      if (i < 10) await sleep(200);
    }
  }
  if (!buf) return { status: 'unreadable', error: lastErr };
  let text;
  try {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
    else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { const sw = Buffer.from(buf.subarray(2)); sw.swap16(); text = sw.toString('utf16le'); }
    else text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { status: 'ok', value: parse(text), raw: buf };
  } catch (e) { return { status: 'invalid', error: e }; }
}

// Write a file so that a crash or a lock never leaves half of it: a temp file written and flushed (beside the real file when the path is a
// symlink), renamed over the target (a few retries while the target is locked), and if the rename keeps failing a flushed in-place write
// (`inPlace`), with the original bytes put back if that fails too. A temp file that could not be written (a full disk) leaves the target
// untouched. `precheck` runs before each rename and may refuse ('ECHANGED': the file is no longer what the caller read). The temp file is always
// removed. A rename gives the file the permissions of the folder (on Windows its inherited ACL): the mode is kept where the system has modes.
async function atomicWrite(path, text, { inPlace = true, precheck = null } = {}) {
  let real = path; try { real = await realpath(path); } catch { /* not there yet */ }
  const tmp = real + '.tmp';
  let mode; try { mode = (await stat(real)).mode & 0o777; } catch { /* a new file */ }
  const flushTo = async (p, data, m) => {
    const fh = await open(p, 'w');
    try { await fh.writeFile(data); if (m !== undefined) { try { await fh.chmod(m); } catch { /* no modes here */ } } await fh.sync(); } finally { await fh.close(); }
  };
  let written = false;
  try {
    await flushTo(tmp, text, mode);
    written = true;
    if (TIMING.writeDelayMs) await sleep(TIMING.writeDelayMs); // (test hook: a slow disk)
    for (let i = 0; ; i++) {
      if (precheck && !(await precheck())) { const e = new Error('the file changed'); e.code = 'ECHANGED'; throw e; }
      try { await rename(tmp, real); return; }
      catch (e) { if (!(e && TRANSIENT_FS.has(e.code)) || i >= 4) throw e; await sleep(50 * (i + 1)); }
    }
  } catch (first) {
    if (!written || !inPlace || (first && first.code === 'ECHANGED')) throw first;
    let original = null; try { original = await readFile(real); } catch { /* a new file */ }
    try { await flushTo(real, text); }
    catch (second) { if (original) { try { await flushTo(real, original); } catch { /* best effort */ } } throw second; }
  } finally {
    try { await rm(tmp, { force: true }); } catch { /* gone */ }
  }
}

// Writes happen one at a time per file, in the order they were asked for, each of the state as it is when the write starts. The queue is what
// persist() and persistTokens() return, so a command that pushes after its save has landed pushes the saved state; the exit waits for it.
const writeChains = new Map(); // path -> the tail of that file's queue
function enqueueWrite(path, job) {
  const run = (writeChains.get(path) || Promise.resolve()).then(job);
  writeChains.set(path, run.catch(() => {}));
  return run;
}

// Problems with the files, in fixed words (never an error's own text: this goes to every bus client). Load problems stay for the session; a
// write problem goes when the next write of that file works. Sent as rpc.configWarning, which nothing else clears (rpc.error is cleared by a login).
const configWarnings = new Map();
function setWarning(key, text) { if (configWarnings.get(key) !== text) { configWarnings.set(key, text); log(`config warning: ${text}`); } schedulePush(); }
function clearWarning(key) { if (configWarnings.delete(key)) schedulePush(); }
let configReadOnly = false; // the config could be neither read nor copied aside: it is left alone for the whole session
let configSnapshot = null;  // {size, mtimeMs} of a bad config at startup: a later change to it is somebody fixing it, not to be overwritten
let skippedFavorites = [];  // the favorites adoptConfig refused

const TOKENS_BAD = 'discord-tokens.json exists but is not valid JSON: re-save it as UTF-8 (no BOM) with { "botToken": "…", "enabled": true }.';
const TOKENS_LOCKED = 'discord-tokens.json could not be read (it is locked or access is denied): close whatever has it open, then press Connect.';
const NO_TOKEN = 'No bot token — create sidecar/discord-tokens.json (docs/STREAMERBOT-SETUP.md), then press Connect again.';

// discord-tokens.json as a whole object (S17 reads the SB password from it too), or why not. A bare integer written in any field keeps its
// exact digits when the object is written back (JSON.rawJSON). A problem with the file is also a sticky warning, gone when it reads again.
const parseTokens = (text) => parseJsonLossless(text);
async function loadTokens() {
  const r = await loadJson(TOKENS_PATH, parseTokens);
  if (r.status === 'ok' && isObject(r.value)) { clearWarning('tokens-load'); return { status: 'ok', tokens: r.value, raw: r.raw }; }
  if (r.status === 'missing') { clearWarning('tokens-load'); return { status: 'missing' }; }
  const status = r.status === 'unreadable' ? 'unreadable' : 'invalid';
  setWarning('tokens-load', status === 'unreadable' ? TOKENS_LOCKED : TOKENS_BAD);
  return { status };
}

async function init() {
  // A temp file left by a crash in the middle of a write.
  for (const p of [CONFIG_PATH, TOKENS_PATH]) { try { await rm(p + '.tmp', { force: true }); } catch { /* fine */ } }

  let res = await loadJson(CONFIG_PATH);
  const keepCopy = async () => {
    const kept = `${CONFIG_PATH}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (TEST_HOOKS && process.env.GREENROOM_FAIL_COPY === '1') throw new Error('copy refused (test hook)');
    await copyFile(CONFIG_PATH, kept);
    return kept;
  };
  if (res.status === 'ok' && isObject(res.value)) {
    adoptConfig(res.value);
    log(`Loaded ${state.favorites.length} favorite(s)`);
    if (skippedFavorites.length) { // the file would lose them at the next save: keep a copy and say so
      const names = skippedFavorites.slice(0, 3).map((n) => `"${clean(n, 30)}"`).join(', ');
      try { const kept = await keepCopy(); setWarning('config-favorites', `${skippedFavorites.length} favorite(s) in the saved config were skipped (${names}${skippedFavorites.length > 3 ? ', …' : ''}): a server or channel id that is not 17 to 20 digits. The file is kept as ${basename(kept)}.`); }
      catch { setWarning('config-favorites', `${skippedFavorites.length} favorite(s) in the saved config were skipped (${names}): a server or channel id that is not 17 to 20 digits. They will be lost at the next save.`); }
    }
  } else if (res.status === 'missing') {
    // First run: seed the gitignored config from the tracked example. Only a MISSING file is seeded: a bad one is kept.
    const ex = await loadJson(EXAMPLE_PATH);
    if (ex.status === 'ok' && isObject(ex.value)) {
      adoptConfig(ex.value);
      try { await persist(); log('Seeded discord-voice-config.json from the example'); } catch (e) { log(`Could not write the first config (${e && e.code}): the settings stay in memory`); }
    } // (the example missing: the defaults stand)
  } else {
    // It exists and cannot be used (not JSON, a literal null, an array, locked): keep a copy, run on the defaults, and do not write it again
    // this session if even the copy fails.
    const why = res.status === 'ok' ? 'it is not a JSON object' : res.status === 'unreadable' ? 'it could not be read' : 'it is not valid JSON';
    log(`Could not load config: ${why}`);
    try {
      const kept = await keepCopy();
      // A copy that worked means the file can be read now: a lock that lifted a moment too late is not a bad file.
      const again = res.status === 'unreadable' ? await loadJson(CONFIG_PATH) : null;
      if (again && again.status === 'ok' && isObject(again.value)) { adoptConfig(again.value); log(`Loaded ${state.favorites.length} favorite(s) (the file became readable)`); try { await rm(kept, { force: true }); } catch { /* fine */ } }
      else {
        try { const st = await stat(CONFIG_PATH); configSnapshot = { size: st.size, mtimeMs: st.mtimeMs }; } catch { /* gone */ }
        setWarning('config-load', `The saved config could not be used (${why}): a copy was kept as ${basename(kept)} and the bridge runs on its defaults. To use the file again: stop the bridge, fix discord-voice-config.json (or rename the copy back) and start the bridge again.`);
      }
    } catch {
      configReadOnly = true;
      setWarning('config-load', `The saved config could not be used (${why}) and a copy could not be made, so it is left as it is and nothing is saved this session.`);
    }
  }

  // Load the gitignored bot token and, if enabled, start the bot at startup.
  const t = await loadTokens();
  if (t.status === 'ok') {
    creds = { botToken: String(t.tokens.botToken ?? '').trim(), enabled: t.tokens.enabled === true };
    if (creds.enabled && creds.botToken) startBot();
  } else if (t.status === 'missing') log('No discord-tokens.json yet — create it to enable the bot (docs/STREAMERBOT-SETUP.md)');
  else { rpc.error = t.status === 'unreadable' ? TOKENS_LOCKED : TOKENS_BAD; log('discord-tokens.json could not be read'); }
}

// What a saved config is held to: its favorites need a 17 to 20 digit server id and channel id (as text; a bare number keeps its digits
// through parseJson), repeated ids are made new, names are cut by code point, settings go through sanitizeSettings. The favorites that are
// refused are listed in skippedFavorites (init says so and keeps a copy).
function adoptConfig(parsed) {
  const favorites = [];
  const ids = new Set();
  skippedFavorites = [];
  for (const f of Array.isArray(parsed.favorites) ? parsed.favorites : []) {
    if (!isObject(f)) continue;
    const serverId = typeof f.serverId === 'string' ? f.serverId : '', channelId = typeof f.channelId === 'string' ? f.channelId : '';
    if (!ID_RE.test(serverId) || !ID_RE.test(channelId)) { skippedFavorites.push(String(f.name ?? '?')); log(`config: the favorite "${clean(f.name ?? '?', 40)}" was skipped: its server id and channel id must be 17 to 20 digits, as text`); continue; }
    let id = String(f.id ?? '');
    if (!id || ids.has(id)) { if (id) log(`config: the favorite id "${clean(id, 40)}" repeats: a new id was made`); do { id = makeId(); } while (ids.has(id)); }
    ids.add(id);
    favorites.push({ id, name: cutName(f.name ?? '', 80), serverId, channelId });
  }
  const cur = isObject(parsed.current) ? { serverId: digitsOnly(parsed.current.serverId), channelId: digitsOnly(parsed.current.channelId) } : null;
  state = { favorites, current: cur && cur.serverId && cur.channelId ? cur : null, settings: sanitizeSettings(DEFAULT_SETTINGS, parsed.settings) };
}

const BAD_FAVORITE_IDS = 'That favorite needs a server ID and a channel ID (17 to 20 digits each): the change was not kept.';

async function addFavorite(name, serverId, channelId) {
  const fav = normalizeFavorite({ name, serverId, channelId }, ID_RE);
  if (!fav) { refuse(BAD_FAVORITE_IDS, 'favorite add'); return null; }
  // A repeated Save adds nothing: the favorite that names the same server and channel stays (GRN-133).
  const same = state.favorites.find((f) => f.serverId === fav.serverId && f.channelId === fav.channelId);
  if (same) return same;
  fav.id = makeId();
  state.favorites.push(fav);
  await persist();
  return fav;
}

// A change is built as a candidate and checked before it touches the favorite: a change that would leave it without a valid server or channel
// (the same rule the saved config is held to) is refused (and says so) and the favorite stays as it was (GRN-138).
async function updateFavorite(id, updates) {
  const f = state.favorites.find((x) => x.id === String(id));
  if (!f || !isObject(updates)) return false;
  const cand = normalizeFavorite({
    name: updates.name !== undefined ? updates.name : f.name,
    serverId: updates.serverId !== undefined ? updates.serverId : f.serverId,
    channelId: updates.channelId !== undefined ? updates.channelId : f.channelId,
  }, ID_RE);
  if (!cand) { refuse(BAD_FAVORITE_IDS, 'favorite update'); return false; }
  Object.assign(f, cand);
  await persist();
  return true;
}

async function removeFavorite(id) {
  const before = state.favorites.length;
  const gone = state.favorites.find((f) => f.id === String(id));
  state.favorites = state.favorites.filter((f) => f.id !== String(id));
  if (state.favorites.length === before) return false;
  // Removing the favorite that is the current channel makes the bot leave it (GRN-153), unless another favorite (a duplicate) still names it.
  const names = (f, c) => f.serverId === c.serverId && f.channelId === c.channelId;
  if (gone && state.current && names(gone, state.current) && !state.favorites.some((f) => names(f, state.current))) {
    state.current = null;
    currentRefused = false;
    if (online()) rpc.error = ''; // the message was about the channel that is gone
    leaveVoice();
  }
  await persist();
  return true;
}

// The bot is logged in: a USE can be checked now.
const online = () => !!(bot && rpc.connected);

// Can the bot watch this channel? A server it is in, a channel that exists, a regular voice channel (a Stage has speakers and an audience:
// this bridge cannot read it, GRN-80) that it can join. Returns { guild, channel } or { error } (a message for the operator).
async function checkTarget(serverId, channelId) {
  const b = bot; // (the bot can be stopped while a lookup is out)
  if (!b) return { error: 'The bot is not logged in — press Connect.', permanent: false };
  try {
    const guild = await b.guilds.fetch(serverId);
    const channel = await guild.channels.fetch(channelId);
    if (!channel) return { error: 'Channel not found — check the Channel ID.', permanent: true };
    if (channel.type === ChannelType.GuildStageVoice) return { error: 'That is a Stage channel — pick a regular voice channel instead.', permanent: true };
    if (!channel.isVoiceBased()) return { error: 'That channel is not a voice channel.', permanent: true };
    // Permissions first (a configuration problem: the operator fixes it). discord.js folds the user limit into `joinable`; it is checked on its
    // own below, because a full channel is not permanent.
    if (!canConnect(channel, b)) return { error: 'The bot cannot join that channel — give it View Channel + Connect there.', permanent: true };
    // discord.js counts only the members it has cached against the user limit, and that includes the bot's own (possibly stale) seat while a
    // guest invited into the call is none: count the voice states other than the bot's. Someone with Move Members can join a full channel
    // (like discord.js decides). A full channel is retried: a seat frees up.
    if (channel.userLimit > 0 && channel.id !== currentChannelId) {
      let inside = 0;
      for (const vs of guild.voiceStates.cache.values()) if (vs.channelId === channel.id && vs.id !== b.user.id) inside++;
      if (inside >= channel.userLimit && !channel.permissionsFor(b.user)?.has('MoveMembers')) return { error: 'That voice channel is full (its user limit is reached) — pick another one, or give the bot Move Members.', permanent: false };
    }
    return { guild, channel };
  } catch (e) { return { error: joinErrorText(e), permanent: permanentError(e) }; }
}
// Can the bot connect to this channel at all (it can see it, has Connect, is not timed out), leaving the user limit out? This is what
// discord.js's own `joinable` decides before it adds the "full" rule (GuildChannel.viewable and BaseGuildVoiceChannel.joinable).
function canConnect(channel, b) {
  try {
    if (!channel.viewable) return false;
    const perms = channel.permissionsFor(b.user);
    if (!perms) return false;
    if (perms.has('Administrator', false)) return true; // (allows joining even when timed out)
    const me = channel.guild.members.me;
    return !!me && (me.communicationDisabledUntilTimestamp || 0) < Date.now() && perms.has('Connect', false);
  } catch { return false; }
}
// A configuration problem (the server, the channel or the permission is wrong) waits for the operator; anything else (the network,
// Discord) is retried.
function permanentError(e) {
  const raw = e?.message || String(e);
  const code = e?.code;
  return code === 10004 || code === 10003 || code === 50001 || code === 50013 || /unknown guild|unknown channel|missing access|missing permissions/i.test(raw);
}
function joinErrorText(e) {
  const raw = e?.message || String(e);
  const code = e?.code;
  if (code === 10004 || /unknown guild/i.test(raw)) return "Bot isn't in that server — invite it there, or pick a channel in a server the bot has joined.";
  if (code === 10003 || /unknown channel/i.test(raw)) return 'Channel not found — check the Channel ID.';
  if (code === 50001 || /missing access/i.test(raw)) return 'Missing access — give the bot View Channel + Connect on that channel.';
  if (code === 50013 || /missing permissions/i.test(raw)) return 'Missing permissions — the bot needs Connect on that voice channel.';
  return 'Join failed: ' + raw;
}

// The refusal of a USE goes on the status line for a while (REFUSAL_MS), then clears itself if nothing replaced it.
function refuse(text, what = 'USE') {
  rpc.error = text;
  refusalText = text;
  log(`${what} refused: ${text}`);
  if (refusalTimer) clearTimeout(refusalTimer);
  refusalTimer = setTimeout(() => {
    refusalTimer = null;
    if (refusalText && rpc.error === refusalText) { rpc.error = ''; schedulePush(); }
    refusalText = '';
  }, REFUSAL_MS);
  refusalTimer.unref();
  schedulePush();
}

// USE: while the bot is online the target is checked FIRST. A target that fails keeps the previous current channel, the voice connection
// and the roster, and says why in rpc.error; it is saved and joined only after it passes (GRN-204). Offline, the pick is saved as before
// (and the reason the bot is offline stays on the status line) and the same check runs when the bot logs in (joinCurrentChannel). The
// newest USE decides: a check that finishes after a newer USE began is dropped. A pick that cannot be saved is used all the same, with a
// sticky warning (GRN-68).
async function setCurrent(serverId, channelId) {
  const sId = String(serverId ?? '').replace(/\D/g, '');
  const cId = String(channelId ?? '').replace(/\D/g, '');
  const next = sId && cId ? { serverId: sId, channelId: cId } : null;
  const seq = ++useSeq;
  let checked = null;
  if (next && online()) {
    checked = await checkTarget(sId, cId);
    if (seq !== useSeq) return state.current;
    if (checked.error) { refuse(checked.error); return state.current; }
  }
  state.current = next;
  currentRefused = false;
  // The change is used whatever the write result (GRN-68): the save is started first (it is queued, so the order of saves is the order of
  // commands), and if it fails rpc.configWarning says the change is not kept after a restart.
  const saved = persist().catch((e) => log(`config not saved: ${e && e.code}`));
  if (next) wantVoice = true; // picking a channel means "be in voice"
  voiceParked = false;        // USE is the operator acting: a bot that was parked after a kick may rejoin (GRN-49)
  cancelVoiceRejoin();
  // If the bot is live, move it to the newly-selected channel (or leave voice).
  if (online()) {
    rpc.error = '';
    joinCurrentChannel(checked).catch((e) => log(`rejoin failed: ${e.message}`));
  }
  await saved;
  return state.current;
}

async function setSettings(updates) {
  if (!isObject(updates)) return false;
  state.settings = sanitizeSettings(state.settings, updates);
  await persist();
  return true;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// The config goes through the queue and the atomic write above. A failure rejects (the caller decides what to do) after it has put the fixed
// message in rpc.configWarning; when the config is read-only for the session the write is skipped, with a warning. A config that could not
// be used at startup (a copy was made and the bridge runs on its defaults) is not overwritten if somebody has edited it since: that is the
// operator fixing it, and the fix is loaded at the next start.
function persist() {
  return enqueueWrite(CONFIG_PATH, async () => {
    if (!configReadOnly && configSnapshot) {
      try {
        const st = await stat(CONFIG_PATH);
        if (st.size !== configSnapshot.size || st.mtimeMs !== configSnapshot.mtimeMs) { configReadOnly = true; setWarning('config-load', 'The saved config was edited while the bridge runs on its defaults: restart the bridge to load it. Nothing is saved until then.'); }
      } catch { /* gone: nothing to protect */ }
    }
    if (configReadOnly) { setWarning('config-write', 'The saved config is left as it is this session: the change is not kept after a restart.'); return; }
    try { await atomicWrite(CONFIG_PATH, JSON.stringify(state, null, 2)); clearWarning('config-write'); }
    catch (e) { setWarning('config-write', `Could not save discord-voice-config.json (${(e && e.code) || 'error'}): the change is not kept after a restart.`); throw e; }
  });
}

// The token file is never written from memory: the file as it is now is read, only `enabled` is set, and the whole object is written back (so
// botToken and every other field survive, bare big integers included). A file that cannot be parsed is not replaced, a file that the operator
// saved between the read and the write is read again and merged on top of (never overwritten with the older copy), and there is no in-place
// fallback: a failed write only means `enabled` is not kept, which is harmless, while a truncated token file is not.
function persistTokens() {
  return enqueueWrite(TOKENS_PATH, async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const t = await loadTokens(); // (a file that is missing or cannot be read has put its warning up)
      if (t.status !== 'ok') { log('discord-tokens.json was not updated: it is missing or cannot be read'); return; }
      try {
        await atomicWrite(TOKENS_PATH, JSON.stringify({ ...t.tokens, enabled: creds.enabled }, null, 2), {
          inPlace: false,
          precheck: async () => { try { return Buffer.compare(await readFile(TOKENS_PATH), t.raw) === 0; } catch { return false; } },
        });
        clearWarning('tokens-write');
        return;
      } catch (e) {
        if (e && e.code === 'ECHANGED') continue; // saved by the operator meanwhile: merge again on top of their version
        setWarning('tokens-write', `Could not save discord-tokens.json (${(e && e.code) || 'error'}): the change is not kept after a restart.`);
        throw e;
      }
    }
    setWarning('tokens-write', 'discord-tokens.json kept changing while it was being updated: the change is not kept after a restart.');
  });
}

// ── Operator commands (arrive over the bus; see dispatch() below) ────────────

// Operator clicked "Connect" — (re)start the bot with the FILE token. There is no token-over-the-bus path by design. The file is read again
// every time: a corrected token is adopted, an empty one or a deleted file forgets the token (a bot that is running with it is stopped), and
// a file that exists but cannot be parsed is reported, the token held in memory (if any) serving for this Connect (GRN-77, GRN-92). A Connect
// or Reset auth that comes while the file is being read wins over the one before it (tokenSeq).
let tokenSeq = 0;
async function connectRpc() {
  const my = ++tokenSeq;
  const t = await loadTokens();
  if (my !== tokenSeq) return;
  let note = '';
  if (t.status === 'ok') creds.botToken = String(t.tokens.botToken ?? '').trim();
  else if (t.status === 'missing') creds.botToken = '';
  else note = t.status === 'unreadable' ? TOKENS_LOCKED : TOKENS_BAD;
  if (!creds.botToken) {
    stopBot();
    rpc.error = note || NO_TOKEN;
    schedulePush();
    return;
  }
  creds.enabled = true;
  wantVoice = true;
  voiceParked = false; // Connect is the operator acting: a bot that was parked after a kick may rejoin
  loginStep = 0;
  rpc.error = note;
  const saved = persistTokens().catch((e) => log(`tokens not saved: ${e && e.code}`)); // (rpc.configWarning says so; the bot starts whatever the write result, GRN-68)
  stopBot();
  startBot();
  await saved;
}

// Gracefully leave the voice channel but stay logged in — proper voice
// disconnect (not a kick). Clears the intent (kept in memory only: a bridge restart wants voice again), cancels a pending rejoin,
// and USE/Connect brings it back. With no connection to close, a bot that Discord still shows in the call is told to leave (GRN-150).
function leaveVoice() {
  wantVoice = false;
  joinGen++; // a join that is still checking its target must not bring the bot back
  cancelVoiceRejoin();
  const hadConnection = !!voiceConn;
  const guildId = voiceConn ? voiceConn.joinConfig.guildId : (state.current && state.current.serverId);
  destroyVoice();
  if (!hadConnection && guildId) leaveGateway(guildId);
  voiceUsers = {};
  schedulePush();
}

// A gateway voice-state update with no channel takes the bot out of a call that Discord still shows it in (a leave that was lost, a
// session left over). Not members.me.voice.disconnect(): that is a REST edit that needs Move Members.
function leaveGateway(guildId) {
  try {
    const g = bot && bot.guilds.cache.get(guildId);
    const inCall = g && g.members.me && g.members.me.voice && g.members.me.voice.channelId;
    if (!inCall) return;
    // Only through a gateway that is up: @discordjs/ws holds a send until the shard is READY (not merely resumed), so one sent during an outage
    // would be released at some later re-identify. The resume and the re-identify both come back through reconcileVoice.
    if (!g.shard || g.shard.status !== Status.Ready) return;
    log(`voice: Discord has the bot in ${inCall} though it should be out: leaving`);
    g.shard.send({ op: 4, d: { guild_id: g.id, channel_id: null, self_mute: true, self_deaf: false } });
  } catch (e) { log(`voice: could not send the leave: ${e && e.message}`); }
}

// Reset auth: disable the bot and stop it. The token file is NOT blanked (a forged bus command must not be able to erase the token; deleting
// the file by hand forgets it): only `enabled` goes to false (GRN-18). The bot is stopped before the file is written, and whatever the write result (GRN-68).
async function resetAuth() {
  tokenSeq++; // a Connect that is still reading the token file gives way to this
  creds.enabled = false;
  stopBot();
  schedulePush();
  try { await persistTokens(); } catch (e) { log(`tokens not saved: ${e && e.code}`); }
}

// ── Bot lifecycle ────────────────────────────────────────────────────────────

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
  // Every continuation acts only while this client is the current one (GRN-20): a client that was replaced or stopped says nothing.
  const live = (fn) => (...a) => { if (bot !== client) return; fn(...a); };
  let everReady = false; // a shardReady before the first clientReady is the first login, not a recovery
  // discord.js ≥14.22 name — 'ready' is deprecated (removal in v15) and logs a
  // DeprecationWarning on every login.
  client.once('clientReady', live(() => { everReady = true; onBotReady().catch((e) => log(`ready handler: ${e.message}`)); }));
  client.on('voiceStateUpdate', onVoiceStateUpdate);
  client.on('raw', onRawPacket);
  client.on('error', (e) => log(`bot error: ${e.message}`));
  client.on('shardError', (e) => log(`gateway error: ${clean(e && e.message, 120)}`));
  // Recoverable gateway drop: discord.js resumes or re-identifies on its own. Show it, but leave `connected` alone: the voice socket is
  // separate and usually keeps delivering, and the roster overlay hides on !connected (GRN-51).
  client.on('shardReconnecting', live(() => { rpc.reconnecting = true; lastGatewayAt = Date.now(); schedulePush(); }));
  // Resumed: Discord replays what was missed, so only the voice link needs a look (no re-seed).
  client.on('shardResume', live(() => { rpc.connected = true; rpc.reconnecting = false; lastGatewayAt = Date.now(); reconcileVoice(false); schedulePush(); }));
  // Re-identified (a new session, nothing replayed): discord.js has rebuilt its cache from GUILD_CREATE, so rebuild the roster from it.
  client.on('shardReady', live(() => {
    if (!everReady) return; // the first login is not a recovery (and no earlier kick is a dropped session)
    lastGatewayAt = Date.now(); rpc.connected = true; rpc.reconnecting = false;
    // discord.js keeps a guild it had in its cache when a new session no longer lists it (the bot was removed during the outage; Discord sends
    // no delete for it): READY's list is the truth.
    const cur = state.current && state.current.serverId;
    if (cur && readyGuildIds && !readyGuildIds.has(cur) && bot.guilds.cache.has(cur)) { onGuildDelete(bot.guilds.cache.get(cur)); schedulePush(); return; }
    reconcileVoice(true); schedulePush();
  }));
  client.on('guildAvailable', live((g) => { if (everReady) onGuildAvailable(g); })); // (during the first login the join belongs to clientReady)
  client.on('guildDelete', live(onGuildDelete));
  // Fires only for the close codes discord.js will not reconnect after (4004 the token was rejected, intents, sharding): stop, say why.
  client.on('shardDisconnect', live((ev) => {
    const code = ev && ev.code;
    const msg = code === 4004
      ? 'Discord rejected the bot token (4004) — reset it in the Developer Portal, put the new one in sidecar/discord-tokens.json, then press Connect.'
      : `Discord closed the bot's connection for good (code ${code}) — press Connect to start it again.`;
    log(msg);
    stopBot();
    rpc.error = msg;
    schedulePush();
  }));
  client.login(creds.botToken).then(() => {
    login.settled = true;
    if (login.destroyWanted) destroyClient(client); // it was stopped while it dialed: now that the login is over, close it
  }, (e) => {
    login.settled = true;
    if (login.destroyWanted) destroyClient(client);
    // A login that was replaced or stopped meanwhile says nothing about the bot that is running now (GRN-130, GRN-20).
    if (bot !== client) return;
    stopBot();
    // A rejected token is a real failure: say so and wait for the operator. Anything else (Discord or the network is down) is retried
    // with a capped backoff (GRN-52).
    const fatal = isAuthFailure(e);
    const delay = !fatal && creds.enabled && creds.botToken && !stopping ? Math.min(TIMING.loginStartMs * 2 ** loginStep++, TIMING.loginCapMs) : 0;
    rpc.error = 'Bot login failed: ' + clean(e?.message || e, 200) + (fatal ? ' — fix the token, then press Connect.' : delay ? ` — retrying in ${Math.max(1, Math.round(delay / 1000))} s` : '');
    log(rpc.error);
    if (delay) {
      loginRetryTimer = setTimeout(() => { loginRetryTimer = null; if (creds.enabled && creds.botToken && !bot && !stopping) startBot(); }, delay);
      loginRetryTimer.unref();
    }
    schedulePush();
  });
}

// A token Discord refused, or intents it will not grant: retrying changes nothing.
function isAuthFailure(e) {
  return e?.status === 401 || e?.code === 'TokenInvalid' || e?.code === 'DisallowedIntents' || /invalid token|disallowed intents|\b401\b/i.test(String(e?.message || ''));
}
function clearLoginRetry() { if (loginRetryTimer) { clearTimeout(loginRetryTimer); loginRetryTimer = null; } }

// The gateway shards of a discord.js client (@discordjs/ws 1.2.3 keeps them at client.ws._ws.strategy.shards, a Map).
function gatewayShards(b) {
  try {
    const m = b.ws && b.ws._ws && b.ws._ws.strategy && b.ws._ws.strategy.shards;
    return m && typeof m.values === 'function' ? [...m.values()] : [];
  } catch { return []; }
}
// Destroying a client is not the end of its gateway: a shard that is re-dialing when destroy() runs has its error handler removed
// (a dial that fails afterwards is an uncaught 'error', GRN-76) and may still finish its connection and send IDENTIFY or RESUME with
// the token (a session nobody owns). So the sockets get a quiet error listener first, and the shard is closed again for good the
// moment it says hello, ready or resumed. The destroy itself stays guarded.
function destroyClient(b) {
  const shards = gatewayShards(b);
  for (const sh of shards) {
    try { if (sh.connection && typeof sh.connection.on === 'function') sh.connection.on('error', () => {}); } catch { /* gone */ }
  }
  try { b.destroy(); } catch { /* already gone */ }
  for (const sh of shards) {
    const again = () => { try { sh.destroy({ code: 1000, reason: 'bridge stopped' }); } catch { /* gone */ } };
    try {
      if (sh.connection && typeof sh.connection.on === 'function') sh.connection.on('error', () => {});
      for (const ev of ['hello', 'ready', 'resumed']) sh.on(ev, again);
      sh.on('error', () => {});
    } catch { /* an unknown shard shape: nothing more to do */ }
  }
}

function stopBot() {
  joinGen++;
  readyGuildIds = null;
  currentRefused = false; // nothing is checked while the bot is out; the next login checks the saved pick again
  cancelVoiceRejoin();    // the exit path (S12) comes through here: no rejoin or login timer outlives the bot
  clearLoginRetry();
  rpc.reconnecting = false;
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
  rpc.reconnecting = false;
  rpc.error = '';
  loginStep = 0; // a login that works resets the retry backoff
  log(`Bot logged in as ${bot?.user?.tag || '?'}`);
  if (wantVoice) await joinCurrentChannel();
  else { reconcileVoice(false); schedulePush(); }
}

// ── Voice channel join + roster ─────────────────────────────────────────────

function destroyVoice() {
  if (voiceConn) {
    const c = voiceConn; voiceConn = null;
    clearVoiceWatch(c);
    if (c.state.status !== VoiceConnectionStatus.Destroyed) { try { c.destroy(); } catch { /* already gone */ } }
  }
  currentChannelId = null;
  currentUnreadable = false;
  rpc.hostInChannel = false;
  voiceUsers = {}; // membership is only meaningful while the bot is in the channel
  speakingSince.clear();
}

// ── Keeping the bot in its channel (GRN-49, 141, 53, 150, 51, 109) ───────────
// The intended target is state.current while wantVoice is true (USE and Connect set it, Leave clears it). Every path that acts on it
// goes through voiceWanted(): a parked bridge (Discord removed the bot), a saved channel that failed its check (currentRefused) and a
// stopping bridge are left alone. Rejoins come from a backoff timer, from the gateway coming back, and from a server becoming available.

const voiceDown = () => !voiceConn || voiceConn.state.status === VoiceConnectionStatus.Disconnected || voiceConn.state.status === VoiceConnectionStatus.Destroyed;
const voiceWanted = () => !!(bot && !stopping && wantVoice && state.current && state.current.channelId && !currentRefused && !voiceParked);

function cancelVoiceRejoin() {
  if (rejoinTimer) { clearTimeout(rejoinTimer); rejoinTimer = null; }
  rejoinStep = 0;
}

function scheduleVoiceRejoin() {
  if (rejoinTimer || !voiceWanted()) return;
  const list = TIMING.backoffMs;
  const delay = list[Math.min(rejoinStep++, list.length - 1)];
  log(`voice: rejoin in ${delay}ms`);
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    if (!voiceWanted() || !voiceDown()) return; // an attempt is already running, or the operator decided otherwise
    joinCurrentChannel().catch((e) => log(`voice rejoin failed: ${e.message}`));
  }, delay);
  rejoinTimer.unref();
}

// The connection is gone and the library will not bring it back: drop it, and rejoin after the backoff unless Discord removed the bot.
function onVoiceLost(conn, park, detail, neverReady) {
  if (voiceConn !== conn) return;
  destroyVoice();
  voiceParked = park;
  rpc.error = park
    ? `Removed from voice (${detail}) — press USE to rejoin.`
    : 'Voice connection lost, rejoining…' + (neverReady ? ' If it keeps failing: check that the bot has View Channel + Connect on that channel and that the channel has room, or that Discord is not having an outage.' : '');
  log(`${rpc.error} [${detail}]`);
  schedulePush();
  if (!park) scheduleVoiceRejoin();
}

// One stall watchdog per connection. Outside Ready for stallWarnMs (a connection that has been Ready before): hostInChannel false and
// "reconnecting"; a connection that never gets Ready only warns after notReadyMs (GRN-53) and is never destroyed for it; outside Ready for
// stallLostMs either way: lost (onVoiceLost). The clocks start when the connection leaves Ready and stop when it is Ready or Destroyed.
function watchVoice(conn) {
  const w = { warn: null, slow: null, lost: null, everReady: false, out: false };
  voiceWatch.set(conn, w);
  const stop = () => { for (const k of ['warn', 'slow', 'lost']) if (w[k]) { clearTimeout(w[k]); w[k] = null; } w.out = false; };
  w.stop = stop;
  const outside = () => {
    if (w.out) return;
    w.out = true;
    if (TIMING.stallWarnMs && w.everReady) {
      w.warn = setTimeout(() => { w.warn = null; if (voiceConn !== conn) return; rpc.hostInChannel = false; rpc.error = 'Voice connection lost, reconnecting…'; schedulePush(); }, TIMING.stallWarnMs);
    }
    if (TIMING.notReadyMs && !w.everReady) {
      w.slow = setTimeout(() => { w.slow = null; if (voiceConn !== conn) return; rpc.error = `Voice connection not ready after ${Math.max(1, Math.round(TIMING.notReadyMs / 1000))} s, still retrying`; log(rpc.error); schedulePush(); }, TIMING.notReadyMs);
    }
    if (TIMING.stallLostMs) {
      w.lost = setTimeout(() => { w.lost = null; onVoiceLost(conn, false, w.everReady ? `stuck in ${conn.state.status}` : 'never became ready', !w.everReady); }, TIMING.stallLostMs);
    }
  };
  conn.on('stateChange', (_old, now) => {
    if (now.status === VoiceConnectionStatus.Ready) { w.everReady = true; stop(); }
    else if (now.status === VoiceConnectionStatus.Destroyed) stop();
    else if (voiceConn === conn) outside();
  });
  if (conn.state.status !== VoiceConnectionStatus.Ready) outside();
}
function clearVoiceWatch(conn) {
  const w = voiceWatch.get(conn);
  if (w) { w.stop(); voiceWatch.delete(conn); }
}

// The gateway came back (a resume, or a re-identify when `reidentified`), or the bot just logged in. discord.js rebuilt its cache after a
// re-identify, so the roster is rebuilt from it (speaking flags kept). The intended target is authoritative (GRN-150): a bot that should be
// out but that Discord still shows in the call is told to leave; one that should be in without a working connection joins at once; a
// connection that is Disconnected or Signalling is asked to rejoin (a join op sent into a dead gateway socket is lost).
function reconcileVoice(reidentified) {
  try {
    if (!bot || stopping) return;
    if (reidentified && currentChannelId) reseedCurrent();
    const intended = !!(wantVoice && state.current && state.current.channelId);
    const targetGuild = state.current && state.current.serverId;
    // A call the bridge put the bot in that it should not be in any more (Leave, a cleared channel, another server): a leave that was
    // refused during an outage is repeated here, for every server the bridge joined (not only the saved one).
    const out = new Set();
    for (const gid of joinedGuilds) if (!intended || gid !== targetGuild) out.add(gid);
    if (!intended && targetGuild) out.add(targetGuild);
    for (const gid of out) leaveGateway(gid);
    if (!intended) return;
    if (voiceParked || currentRefused) return;
    const status = voiceConn && voiceConn.state.status;
    if (!voiceConn || status === VoiceConnectionStatus.Destroyed) {
      cancelVoiceRejoin();
      joinCurrentChannel().catch((e) => log(`voice rejoin failed: ${e.message}`));
    } else if (status === VoiceConnectionStatus.Disconnected || status === VoiceConnectionStatus.Signalling) {
      // (to the CHOSEN channel: a bot that was dragged elsewhere goes back, like every other rebuilt connection)
      try { voiceConn.rejoin({ channelId: state.current.channelId }); } catch (e) { log(`voice rejoin failed: ${e.message}`); }
    }
  } catch (e) { log(`voice reconcile: ${e.message}`); }
}

// Rebuild the roster of the channel the bot is in from discord.js's cache, keeping the speaking flags.
function reseedCurrent() {
  const g = bot && state.current && bot.guilds.cache.get(state.current.serverId);
  const ch = g && currentChannelId && g.channels.cache.get(currentChannelId);
  if (ch && ch.isVoiceBased()) seedFromChannel(ch, true);
  else voiceUsers = {};
  schedulePush();
}

// A server that comes back (GRN-109): re-seed the roster if the bot is in a channel there, or join if it should be and is not.
function onGuildAvailable(g) {
  if (!state.current || g.id !== state.current.serverId) return;
  if (currentChannelId) reseedCurrent();
  else if (voiceWanted()) { cancelVoiceRejoin(); joinCurrentChannel().catch((e) => log(`voice rejoin failed: ${e.message}`)); }
}

// The bot was removed from the server (GRN-141): there is nothing to rejoin until the operator acts.
function onGuildDelete(g) {
  if (!state.current || g.id !== state.current.serverId || g.available === false) return;
  joinGen++;
  cancelVoiceRejoin();
  destroyVoice();
  voiceParked = true;
  rpc.error = 'Bot was removed from that server';
  log(rpc.error);
  schedulePush();
}

// `checked` is the result of checkTarget when the caller (USE) has already run it (and it is for the current channel); at login and on a
// rejoin it is run here. A newer join, a Leave or a stop that happens while this one is checking makes it do nothing more (joinGen). A
// target that fails its check for a configuration reason (wrong server, no such channel, a Stage, no permission) is marked currentRefused
// and waits for the operator; one that fails for another reason (Discord or the network) is retried with the backoff.
async function joinCurrentChannel(checked) {
  if (!bot) return;
  const gen = ++joinGen;
  const target = state.current; // { serverId, channelId } | null
  if (!target || !target.channelId) { currentRefused = false; destroyVoice(); schedulePush(); return; }
  try {
    const chk = checked && !checked.error && checked.channel.id === target.channelId && checked.guild.id === target.serverId ? checked : await checkTarget(target.serverId, target.channelId);
    if (gen !== joinGen) return;
    if (chk.error) { // (at login: nothing to keep; the error says why the saved channel cannot be watched)
      if (!currentChannelId) voiceUsers = {};
      rpc.error = chk.error;
      refusalText = '';
      log(rpc.error);
      if (chk.permanent) currentRefused = true; // stays on the status line for as long as the saved pick is refused
      else scheduleVoiceRejoin();
      schedulePush();
      return;
    }
    currentRefused = false;
    const { guild, channel } = chk;
    destroyVoice(); // only after the target has passed
    rpc.error = '';
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
    currentUnreadable = false;
    joinedGuilds.add(guild.id);

    conn.on('error', (e) => log(`voice error: ${e.message}`));
    watchVoice(conn);
    // The library hands 4014 on as a Disconnected state, but answers every other close code (4021 rate limited, 4022 call terminated
    // included) by signalling a rejoin at once. Discord says those two mean "do not reconnect": the library's entry point for a closed voice
    // socket is wrapped to catch them (the library registers `conn.onNetworkingClose` on each networking it creates) and park.
    const libraryClose = conn.onNetworkingClose;
    if (typeof libraryClose === 'function') {
      conn.onNetworkingClose = (code) => {
        if (code === 4021 || code === 4022) { setImmediate(() => onVoiceLost(conn, true, `voice close ${code}`, false)); return; }
        return libraryClose(code);
      };
    }
    // Disconnected: @discordjs/voice reconnects by itself within a few seconds when the bot was moved or the networking dropped; if it does
    // not, the reason decides. Discord's "do not reconnect" voice close codes (4014 removed from the call, 4021 rate limited, 4022 call
    // terminated) park the bridge, except a 4014 right after a gateway reconnect, which is a dropped session (GRN-49).
    const onDisconnected = async () => {
      const { reason, closeCode } = conn.state; // (a destroy() erases them)
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, TIMING.disconnectRaceMs),
          entersState(conn, VoiceConnectionStatus.Connecting, TIMING.disconnectRaceMs),
        ]);
        // Reconnecting: @discordjs/voice is handling it (the stall watchdog is the backstop).
      } catch {
        if (voiceConn !== conn) return;
        const closed = reason === VoiceConnectionDisconnectReason.WebSocketClose && PARK_CODES.has(closeCode);
        const sessionDrop = closeCode === 4014 && Date.now() - lastGatewayAt < TIMING.sessionDropMs;
        const w = voiceWatch.get(conn);
        const detail = closed ? `voice close ${closeCode}${sessionDrop ? ', gateway session dropped' : ''}` : (['WebSocketClose', 'AdapterUnavailable', 'EndpointRemoved', 'Manual'][reason] || String(reason));
        onVoiceLost(conn, closed && !sessionDrop, detail, !(w && w.everReady));
      }
    };
    conn.on(VoiceConnectionStatus.Disconnected, onDisconnected);
    // joinVoiceChannel hands back an already Disconnected connection when the gateway shard is not Ready (AdapterUnavailable): that event
    // fired before the listener existed.
    if (conn.state.status === VoiceConnectionStatus.Disconnected) onDisconnected();
    // The library destroyed it (the guild went away): the bookkeeping, without destroying it again.
    conn.on(VoiceConnectionStatus.Destroyed, () => {
      if (voiceConn !== conn) return;
      voiceConn = null; clearVoiceWatch(conn);
      currentChannelId = null; currentUnreadable = false; rpc.hostInChannel = false; voiceUsers = {}; speakingSince.clear();
      schedulePush();
    });

    attachReceiver(conn);
    schedulePush();
  } catch (e) {
    if (gen !== joinGen) return; // a newer join or a Leave took over: this one's failure is not news
    rpc.error = joinErrorText(e);
    log(rpc.error);
    if (permanentError(e)) currentRefused = true; else scheduleVoiceRejoin();
    schedulePush();
  }
}

// One idempotent Ready listener per connection (GRN-53): wire() runs on every Ready (the first one and after every live reconnect), the
// speaking listeners are attached once, and every write is guarded by voiceConn === conn. The not-ready warning and the give-up are the
// stall watchdog's (watchVoice); nothing here destroys a connection.
function attachReceiver(conn) {
  if (armed.has(conn)) return;
  armed.add(conn);
  const wire = () => {
    if (voiceConn !== conn) return;
    cancelVoiceRejoin(); // the backoff starts over
    rpc.hostInChannel = true;
    rpc.error = '';
    wiredAt = Date.now();
    if (!wired.has(conn)) {
      wired.add(conn);
      const speaking = conn.receiver.speaking;
      // Bound to THIS connection: after a move or a leave an event from the old one changes nothing (GRN-12).
      speaking.on('start', (userId) => { try { if (voiceConn !== conn) return; setSpeaking(userId, true); schedulePush(); } catch (e) { log(`speaking start: ${e.message}`); } });
      speaking.on('end', (userId) => { try { if (voiceConn !== conn) return; setSpeaking(userId, false); schedulePush(); } catch (e) { log(`speaking end: ${e.message}`); } });
      log(`Joined voice channel ${currentChannelId} (${Object.keys(voiceUsers).length} present)`);
    }
    reseedCurrent(); // the roster, rebuilt now that the connection is up (speaking flags kept)
  };
  conn.on(VoiceConnectionStatus.Ready, wire);
  if (conn.state.status === VoiceConnectionStatus.Ready) wire();
}

const guestRow = (username, avatarUrl, vs, prev) => ({ speaking: !!(prev && prev.speaking), username, avatarUrl, mute: !!(vs && vs.mute), deaf: !!(vs && vs.deaf) });
const userName = (u) => clean(u.globalName || u.username || '', 80);
function userAvatar(u) {
  try { return u.displayAvatarURL({ extension: 'png', size: 256 }); }
  catch { return buildAvatarUrl(u.id, u.avatar ?? null); }
}

// Rebuild the roster from discord.js's cache. `keep` carries the speaking flags of people who are still there.
function seedFromChannel(channel, keep = false) {
  const prev = keep ? voiceUsers : {};
  voiceUsers = {};
  const members = channel.members; // Collection<id, GuildMember> currently in voice
  if (members && typeof members.forEach === 'function') {
    for (const [, member] of members) upsertMember(member);
  }
  // A guest invited into the call is in discord.js's voice states but has no cached member, so channel.members leaves them out (GRN-210):
  // they are listed from the names seen on earlier frames, from the users discord.js knows, or looked up.
  const meId = bot && bot.user && bot.user.id;
  for (const vs of channel.guild.voiceStates.cache.values()) {
    if (vs.channelId !== channel.id || vs.member || vs.id === meId) continue;
    const seen = seenUsers.get(vs.id);
    const user = bot && bot.users.cache.get(vs.id);
    if ((seen && seen.bot) || (user && user.bot)) continue;
    if (seen) voiceUsers[vs.id] = guestRow(seen.username, seen.avatarUrl, vs);
    else if (user) voiceUsers[vs.id] = guestRow(userName(user), userAvatar(user), vs);
    else lookupGuest(vs.id, channel.guild.id); // nobody has said who this is: ask Discord; the row is added when it answers
  }
  if (keep) for (const id of Object.keys(voiceUsers)) if (prev[id] && prev[id].speaking) voiceUsers[id].speaking = true;
  for (const id of [...speakingSince.keys()]) if (!voiceUsers[id]) speakingSince.delete(id);
}

// Who is this user? (a guest who was already in the call when the bridge joined: no frame has told us). The row is added when Discord
// answers, if they are still in the working channel; a bot is never listed. If the lookup fails they are listed without a name (the
// overlay shows the id), since they are in the call.
async function lookupGuest(id, guildId) {
  if (looking.has(id) || looking.size >= 25) return;
  const b = bot;
  looking.add(id);
  let user = null;
  try { user = await b.users.fetch(id); } catch (e) { log(`user lookup ${id} failed: ${clean(e && e.message, 80)}`); }
  looking.delete(id);
  if (stopping || bot !== b || !currentChannelId) return;
  const vs = b.guilds.cache.get(guildId)?.voiceStates.cache.get(id);
  if (!vs || vs.channelId !== currentChannelId || vs.member) return; // gone, moved, or a cached member by now
  if (user && user.bot) { if (voiceUsers[id]) { delete voiceUsers[id]; schedulePush(); } return; }
  if (voiceUsers[id] && voiceUsers[id].username) return; // a frame named them meanwhile
  voiceUsers[id] = guestRow(user ? userName(user) : '', user ? userAvatar(user) : buildAvatarUrl(id, null), vs, voiceUsers[id]);
  schedulePush();
}

function onVoiceStateUpdate(oldState, newState) {
  try {
    if (!currentChannelId) return;
    // Departures first, by user id: a guest who was invited into the call has no cached member (GRN-210).
    const id = newState.id || oldState.id;
    // The bot itself: dragged to another channel in Discord while it has a connection, the roster follows it (GRN-50). state.current is not
    // changed (USE brings the bot back) and nothing is said on the status line. A null channel stays with the Disconnected handler.
    if (id && bot && bot.user && id === bot.user.id) {
      if (voiceConn && newState.channelId && oldState.channelId === currentChannelId && newState.channelId !== currentChannelId) {
        currentChannelId = newState.channelId;
        const ch = newState.channel;
        // A Stage has speakers and an audience that this bridge cannot read (GRN-80): the roster is empty there, and nobody in it is listed.
        currentUnreadable = !ch || !ch.isVoiceBased() || ch.type === ChannelType.GuildStageVoice;
        if (!currentUnreadable) seedFromChannel(ch, true); else { voiceUsers = {}; speakingSince.clear(); }
        schedulePush();
      }
      return;
    }
    if (currentUnreadable) return; // the bot was dragged into a channel the bridge cannot read (a Stage): nothing in it is listed
    if (newState.channelId !== currentChannelId) {
      if (id) speakingSince.delete(id);
      if (id && voiceUsers[id]) { delete voiceUsers[id]; schedulePush(); }
      return;
    }
    const member = newState.member || oldState.member;
    if (member) {
      if (member.user?.bot) return; // ignore bots (incl. ourselves)
      upsertMember(member); schedulePush();
      return;
    }
    // A guest invited into the call: discord.js keeps no member for them (no joined_at). The name came from the raw frame (onRawPacket ran
    // just before) and the flags are the voice state's own, so a mute or a new nickname shows. A frame that told us nothing about the
    // user adds nobody (never a nameless row, never the bot).
    const seen = id && seenUsers.get(id);
    if (!seen || seen.bot || (bot && bot.user && id === bot.user.id)) return;
    voiceUsers[id] = guestRow(seen.username, seen.avatarUrl, newState, voiceUsers[id]);
    schedulePush();
  } catch (e) { log(`voice state update: ${e.message}`); }
}

// A guest invited into the call has no joined_at, so discord.js does not keep them as a member: the raw VOICE_STATE_UPDATE is where
// their name and avatar are (GRN-210). It runs before discord.js handles the frame, so the name is on file when onVoiceStateUpdate (which
// adds, updates and removes the row in the order the frames arrive) and seedFromChannel (a join, a move, a login) need it.
function onRawPacket(packet) {
  try {
    if (packet && packet.t === 'READY') { // the servers this session lists (GRN-141)
      const gs = packet.d && packet.d.guilds;
      readyGuildIds = Array.isArray(gs) ? new Set(gs.map((x) => String(x && x.id))) : null;
      return;
    }
    if (!packet || packet.t !== 'VOICE_STATE_UPDATE') return;
    const d = packet.d;
    const u = d && d.member && d.member.user;
    if (!u || !u.id) return;
    const id = String(u.id);
    seenUsers.delete(id); // (re-inserted last: the oldest go first when the map is full)
    seenUsers.set(id, { bot: !!u.bot, username: clean(d.member.nick || u.global_name || u.username || '', 80), avatarUrl: buildAvatarUrl(id, u.avatar || null) });
    while (seenUsers.size > SEEN_USERS_MAX) seenUsers.delete(seenUsers.keys().next().value);
  } catch (e) { log(`raw voice state: ${e.message}`); }
}

function upsertMember(member) {
  const user = member.user;
  if (!user || user.bot) return;
  const id = user.id;
  const prev = voiceUsers[id] || {};
  let avatarUrl;
  // The member's own picture first (a per-server avatar), the account's after it.
  try { avatarUrl = member.displayAvatarURL({ extension: 'png', size: 256 }); }
  catch {
    try { avatarUrl = user.displayAvatarURL({ extension: 'png', size: 256 }); }
    catch { avatarUrl = buildAvatarUrl(id, user.avatar ?? null); }
  }
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
  if (!val) speakingSince.delete(id); // (even when the row is gone: a speaker who left mid-sentence must not look stuck when they come back)
  if (!id || !voiceUsers[id]) return; // only a member of the working channel has a speaking flag (GRN-12)
  voiceUsers[id].speaking = !!val;
  if (val) { lastSpeakStartAt = Date.now(); if (!speakingSince.has(id)) speakingSince.set(id, lastSpeakStartAt); }
  else speakingSince.delete(id);
}

// Speaking detection looks dead (GRN-174): the bot is in the channel, someone present is unmuted and undeafened, and no speaking start has
// arrived for several minutes; or a glow has stayed on for minutes with no end. A separate flag: the voice receive Discord uses is not
// documented, and a Discord change can silently stop it.
function speakingStale() {
  if (!rpc.hostInChannel) return false;
  const now = Date.now();
  if (TIMING.speakingStaleMs && Object.values(voiceUsers).some((u) => !u.mute && !u.deaf) && now - Math.max(lastSpeakStartAt, wiredAt) > TIMING.speakingStaleMs) return true;
  if (TIMING.stuckGlowMs) for (const [id, since] of speakingSince) if (voiceUsers[id] && voiceUsers[id].speaking && now - since > TIMING.stuckGlowMs) return true;
  return false;
}

// Test hook (GREENROOM_TEST_HOOKS=1, command `test-voice` with a JSON value): drives the REAL voice connection the way its networking would,
// since the mock Discord has no voice server. {do:'state',status} moves it through the library's own state setter, {do:'close',code}
// calls onNetworkingClose, {do:'speak',id,end} emits on its receiver's speaking map, {do:'keep'} remembers the connection and
// {do:'speak-old',id} emits on that one later, {do:'listeners'} logs how many speaking listeners the current one has.
function testVoice(o) {
  const c = voiceConn;
  switch (o && o.do) {
    case 'state': if (c) c.state = { ...c.state, status: String(o.status) }; break;
    case 'close': if (c) c.onNetworkingClose(Number(o.code)); break;
    case 'close-kept': if (testKeptConn) { log('test-close-kept: closing the kept connection'); testKeptConn.onNetworkingClose(Number(o.code)); } break;
    case 'speak': if (c) c.receiver.speaking.emit(o.end ? 'end' : 'start', String(o.id)); break;
    case 'keep': testKeptConn = c; break;
    case 'speak-old': if (testKeptConn) { log('test-speak-old: emitting on the kept connection'); testKeptConn.receiver.speaking.emit(o.end ? 'end' : 'start', String(o.id)); } break;
    case 'listeners': if (c) log(`test-listeners start=${c.receiver.speaking.listenerCount('start')} end=${c.receiver.speaking.listenerCount('end')}`); break;
    default: log('test-voice: unknown action');
  }
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
    sock.on('close', () => { if (sbWs === sock) sbWs = null; if (sbEverConnected) sbLost = true; armSbGoneTimer(); scheduleSbReconnect(); });
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
  } catch (e) {
    log(`could not connect to ${SB_WS_URL}: ${e && e.message}`);
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
  return state.settings.exitOnSbClose === true;
}

// SB's WS just dropped. If the operator opted in and we had actually been
// connected (so a never-yet-reached SB during dev doesn't quit us), start a
// grace countdown. A reconnect within the window clears it (see the open
// handler); if it fires, SB is gone for good — disconnect from voice and exit
// so the bot doesn't linger in the channel.
function armSbGoneTimer() {
  if (stopping || sbLastTry || !shouldExitOnSbClose() || !sbEverConnected || sbGoneTimer) return;
  log(`Streamer.bot connection lost — will leave voice and exit in ${SB_EXIT_GRACE_MS}ms if it doesn't return (exitOnSbClose).`);
  sbGoneTimer = setTimeout(() => {
    sbGoneTimer = null;
    if (sbOpen()) return; // came back in the meantime
    // One last attempt before giving up: a Streamer.bot that is back but not yet found keeps the bridge alive (GRN-180).
    log('Streamer.bot has not returned within the grace window — one last attempt.');
    if (sbReconnectTimer) { clearTimeout(sbReconnectTimer); sbReconnectTimer = null; }
    sbLastTry = true; // (the close of this attempt must not start a new countdown)
    connectSb();
    setTimeout(() => {
      sbLastTry = false;
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
  const parsed = (() => { try { return value ? parseJson(value) : null; } catch { return null; } })();
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
        if (TEST_HOOKS && command === 'test-block-log') { if (logWorker) logWorker.postMessage({ block: true }); return; }
        if (TEST_HOOKS && command === 'test-speaking') { setSpeaking(value, true); schedulePush(); return; }
        if (TEST_HOOKS && command === 'test-voice') { testVoice(parsed); return; }
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
    rpc: { enabled: creds.enabled, hasToken: !!creds.botToken, error: clean(rpc.error, 300), reconnecting: !!rpc.reconnecting, speakingStale: speakingStale(), configWarning: clean([...configWarnings.values()].join(' '), 400) },
    favorites: state.favorites.map((f) => ({ ...f })),
    current: state.current ? { ...state.current } : null,
    // The saved current channel failed its check at login (a Stage, a channel the bot cannot join, …), so it is not joined; false once the
    // pick changes (additive).
    currentRefused,
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
// The token is removed BEFORE the text is cut or cleaned, so a limit that falls inside it cannot leave a piece of it.
const redact = (s) => {
  const t = creds && creds.botToken;
  return t && String(t).length >= 8 ? String(s ?? '').split(String(t)).join('[bot token]') : String(s ?? '');
};
const clean = (s, n) => redact(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, n);
let logWorker = null;
try {
  logWorker = new Worker(
    "const { parentPort } = require('node:worker_threads'); const fs = require('node:fs');" +
    "parentPort.on('message', (m) => { if (typeof m === 'string') { try { fs.writeSync(1, m); } catch (e) {} }" +
    " else if (m && m.flush) { parentPort.postMessage(m.flush); }" +
    " else if (m && m.block) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); } });", // (m.block: a test hook that freezes the writer like a console in QuickEdit)
    { eval: true });
  logWorker.on('error', () => { logWorker = null; });
  logWorker.on('exit', () => { logWorker = null; }); // a worker that is gone: the lines go straight to the console
  logWorker.unref();
} catch { logWorker = null; }

function log(msg) {
  const line = `[${new Date().toISOString()}] [discord-bridge] ${clean(msg, 2000)}\n`;
  if (logWorker) { try { logWorker.postMessage(line); return; } catch { /* fall through */ } }
  try { writeSync(1, line); } catch { /* no console */ }
}
// Wait (at most `ms`) until the worker has written everything posted so far; resolves true if it did. A blocked console never answers
// (false): the caller goes on without it.
function flushLog(ms) {
  return new Promise((res) => {
    if (!logWorker) return res(true);
    const id = Math.random();
    const t = setTimeout(() => res(false), ms);
    const onMsg = (m) => { if (m === id) { clearTimeout(t); logWorker && logWorker.off('message', onMsg); res(true); } };
    try { logWorker.on('message', onMsg); logWorker.postMessage({ flush: id }); } catch { clearTimeout(t); res(true); }
  });
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
  } catch (e) { log(`shutdown: ${e && e.message}`); }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    // process.exit() waits for the log worker; a console that stopped draining (QuickEdit) never lets it go. If the worker does not
    // answer in 250 ms the process is ended outright: the final state has been sent by now.
    const die = (ok) => { if (!ok) { try { process.kill(process.pid, 'SIGKILL'); } catch { /* fall through to exit */ } } process.exit(code); };
    flushLog(250).then(die, () => die(false));
  };
  setTimeout(finish, 3500).unref?.();            // never later than 3.5 s (the wait for the writes below is part of it)
  // A save that is still running when the exit begins (a USE a moment ago) gets up to 2 s to land before the final push.
  Promise.race([Promise.all([...writeChains.values()]), sleep(2000)]).then(() => {
    pushFinal(() => setTimeout(finish, Math.max(0, 300 - (Date.now() - t0)))); // never sooner than 300 ms: the leave frames flush
  });
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
  setTimeout(() => s.destroy(), 1000).unref?.(); // an absolute lifetime too: a peer that keeps writing does not keep its socket
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
function readBanner(port, mayAskToQuit = true) {
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
        if (mayAskToQuit && cmpVersion(VERSION, b.version) > 0) { s.removeAllListeners('data'); end(b, `quit ${VERSION}`); } else end(b);
      } else end(null);
    });
  });
}

const listenGuard = () => new Promise((res) => {
  const server = createServer(guardConnection);
  server.once('error', (err) => res({ err }));
  try { server.listen(GUARD_PORT, '127.0.0.1', () => { server.removeAllListeners('error'); server.on('error', () => {}); res({ server }); }); }
  catch (err) { res({ err }); } // (a port number that is out of range throws instead of raising 'error')
});

async function acquireGuard() {
  let got = await listenGuard();
  if (got.server) { guardServer = got.server; return; }
  if (got.err.code !== 'EADDRINUSE') {
    // Never run without the guard: a second bridge on the same bot token would double-push and fight over voice.
    log(`guard port :${GUARD_PORT} cannot be used (${got.err.code || got.err.message}). The bridge will not run without its single-instance guard: choose another port with --guard-port= or GREENROOM_GUARD_PORT.`);
    await flushLog(300);
    process.exit(1);
  }
  let holder = await readBanner(GUARD_PORT);
  // A holder that is on its way out (a newer build asked it to quit, or the program ended) closes its sockets without a banner: before
  // calling the port foreign, look again, and take the port if it has been freed meanwhile.
  for (let i = 0; !holder && i < 4; i++) {
    await new Promise((r) => setTimeout(r, 300));
    got = await listenGuard();
    if (got.server) { guardServer = got.server; return; }
    holder = await readBanner(GUARD_PORT);
  }
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
    // Someone else took the port meanwhile (two newer builds started together): if that one is as new as this build, it stays; if it is
    // older, readBanner asks it to quit as well.
    const now = await readBanner(GUARD_PORT);
    if (now && now.pid !== holder.pid && cmpVersion(VERSION, now.version) <= 0) {
      log(`a Greenroom bridge (version ${now.version}, pid ${now.pid}) is already running and is the same version or newer than this one (${VERSION}) — exiting.`);
      await flushLog(300);
      process.exit(0);
    }
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
    // The way out first (the clearing state must not wait for a console), the stack through the log after it.
    rpc.error = 'Bridge crashed: ' + clean((err && err.message) || err, 300);
    shutdown(1, 'uncaught exception');
    log(`uncaught exception: ${(err && err.stack) || err}`);
    setTimeout(() => { try { process.kill(process.pid, 'SIGKILL'); } catch { /* fall through */ } process.exit(1); }, 2500).unref?.(); // belt and braces
  });
  log(`Greenroom Discord bridge ${VERSION} starting (config: ${CONFIG_PATH})`);
  try {
    const u = new URL(SB_WS_URL);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('the scheme must be ws:// or wss://');
  } catch (e) {
    log(`SB_WS_URL / --sb-ws-url "${clean(SB_WS_URL, 100)}" is not a valid ws:// URL (${e.message}): e.g. --sb-ws-url=ws://127.0.0.1:8080/`);
    await flushLog(300);
    process.exit(1);
  }
  await acquireGuard();
  await init();
  connectSb();
  heartbeatTimer = setInterval(schedulePush, HEARTBEAT_MS);
}

main().catch((e) => { rpc.error = 'Bridge failed to start: ' + ((e && e.message) || e); log(`startup failed: ${(e && e.stack) || e}`); shutdown(1, 'startup failed'); });
