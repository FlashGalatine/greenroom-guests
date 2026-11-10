// Automated end-to-end verification of Greenroom's Streamer.bot seam — no
// Streamer.bot, no Discord token, no vdo.ninja room required. It spawns the mock SB
// server and proves the whole protocol surface:
//
//   [1] transport — the REAL overlay/panel-client-sb.js runs in a minimal browser
//       sandbox (real `ws` WebSocket): Subscribe ack shape, DoAction "VDO Sync" fired
//       on connect, and SILENCE when both caches are empty.
//   [2] VDO Push — full payload round-trip (slots + labels + invite + guest
//       directory intact), the persisted-cache replay to a late joiner via
//       VDO Sync, /mock/state parses.
//   [3] Discord Voice Push — settings/rpc/favorites/current intact; VDO Sync replays
//       BOTH caches (either order); after /mock/restart (SB restart analog) VDO Sync
//       replays ONLY the persisted vdoninja blob. An empty vdo.state is answered with
//       {"type":"vdo:sync:empty"}. The state travels as escaped string fields; a second
//       mock in SB_WIRE=object mode pins the OLD shape and Streamer.bot's date rewrite.
//   [4] command bus — mock-discord-bridge.mjs consumes discord:voice:command
//       broadcasts and echoes state changes back through the REAL bus path.
//   [5] defensive parser — control/vdo-parse.js never throws on malformed guestLists.
//   [6] HTTP + tripwires — SB-style Path->Folder serving, load-bearing strings in
//       every wired file (incl. the nameplate surfaces + the director-min
//       directory strip-guard), and control.html must NOT contain "botToken".
//   [6b] the two launching C# actions are compiled and run against a stubbed Streamer.bot.
//   [6c] fixtures and packaging: no real-looking Discord IDs, the screenshot tool is offline, package.json is private.
//
// It does NOT render pixels; verify-render.mjs does that in a real browser.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, connect as netConnect } from 'node:net';
import { createServer as createHttp } from 'node:http';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { readFile, rm, mkdtemp, writeFile, readdir, mkdir, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number(process.env.SB_HTTP_PORT) || 7475; // off the SB defaults so it coexists with a running SB
const WS_PORT = Number(process.env.SB_WS_PORT) || 8081;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const GUARD_BASE = Number(process.env.VERIFY_GUARD_BASE) || 7591; // the sidecars' single-instance guard ports: base, +1, +2 (outside the 749x block the components claim)
const WS_URL = `ws://127.0.0.1:${WS_PORT}/`;

let passed = 0, failed = 0;
const scratchDirs = []; // temp folders the checks made; removed at the end even when a check threw
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

async function rejects(promise) {
  try { await promise; return false; } catch { return true; }
}

// Resolves true if the child exits within `ms`, false on timeout (still running).
function waitExit(child, ms) {
  return new Promise((res) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; res(false); } }, ms);
    child.once('exit', () => { if (!done) { done = true; clearTimeout(t); res(true); } });
  });
}

// Children get an ALLOWLISTED environment, never `...process.env`: a shell that exports SB_WS_URL, GREENROOM_* or
// DISCORD_BRIDGE_* must not be able to steer a harness child at a live Streamer.bot or a live sidecar. Everything a child
// needs beyond this list is passed explicitly.
const ENV_KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'LANG', 'LC_ALL', 'TZ'];
// Nothing a harness child starts may read or write the real per-install files (sidecar/discord-tokens.json, sidecar/discord-voice-config.json):
// the bridge and backup.mjs fall back to them when DISCORD_BRIDGE_TOKENS / DISCORD_BRIDGE_CONFIG are not set, so every child gets paths of a scratch
// folder by default (a test that needs its own passes its own).
const NO_INSTALL = resolve(tmpdir(), 'greenroom-verify-noinstall-' + process.pid);
mkdirSync(NO_INSTALL, { recursive: true });
process.on('exit', () => { try { rmSync(NO_INSTALL, { recursive: true, force: true }); } catch { /* best effort */ } });
function cleanEnv(extra = {}) {
  const env = {};
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  // The tests run the real bridge against the MOCK Streamer.bot, which the bridge refuses unless told (GRN-195: it acts only after a
  // genuine Hello); the cases that test that refusal pass GREENROOM_ALLOW_MOCK: '0'.
  return { GREENROOM_ALLOW_MOCK: '1', DISCORD_BRIDGE_TOKENS: resolve(NO_INSTALL, 'tokens.json'), DISCORD_BRIDGE_CONFIG: resolve(NO_INSTALL, 'config.json'), ...env, ...extra };
}

function startChild(script, readyText, extraEnv = {}) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [script], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv({ SB_HTTP_PORT: String(HTTP_PORT), SB_WS_PORT: String(WS_PORT), SB_WS_URL: WS_URL, ...extraEnv }),
    });
    let out = '', settled = false;
    const timer = setTimeout(() => { settled = true; try { child.kill(); } catch {} rej(new Error(`${script} did not start in 8s\n` + out)); }, 8000);
    // readyText is matched on the child's output; a child that exits first, with any code, is a failure to start.
    const onData = (d) => { out += d; if (!settled && out.includes(readyText)) { settled = true; clearTimeout(timer); res(child); } };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); rej(new Error(`${script} exited ${code} before it was ready\n` + out)); } });
  });
}

const startMock = () => startChild('mock-sb-server.mjs', '[mock] READY');

// An extra mock on OS-assigned free ports (so it never collides with a Streamer.bot or another tool).
function freePort() {
  return new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function startMockWith(env) {
  const wsPort = await freePort(), httpPort = await freePort();
  const child = await startChild('mock-sb-server.mjs', '[mock] READY', { SB_HTTP_PORT: String(httpPort), SB_WS_PORT: String(wsPort), ...env });
  return { child, wsPort, httpPort, url: `ws://127.0.0.1:${wsPort}/`, base: `http://127.0.0.1:${httpPort}` };
}

// Run a short-lived node script to completion; resolves { code, out }.
function runNode(args, extraEnv = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, args, {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv({ SB_HTTP_PORT: String(HTTP_PORT), SB_WS_PORT: String(WS_PORT), SB_WS_URL: WS_URL, ...extraEnv }),
    });
    let out = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => res({ code, out }));
  });
}

// A predicate-matched inbox: next() resolves with the first queued (or future) item
// matching pred; unmatched items stay queued for other next() calls.
function makeInbox() {
  const q = [];
  const waiters = [];
  function pump() {
    for (let w = 0; w < waiters.length; w++) {
      const idx = q.findIndex(waiters[w].pred);
      if (idx !== -1) {
        const waiter = waiters.splice(w, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(q.splice(idx, 1)[0]);
        return pump();
      }
    }
  }
  return {
    push(item) { q.push(item); pump(); },
    drain() { q.length = 0; },
    next(ms = 4000, pred = () => true, what = 'message') {
      const idx = q.findIndex(pred);
      if (idx !== -1) return Promise.resolve(q.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { pred, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i !== -1) waiters.splice(i, 1);
          reject(new Error('timeout waiting for ' + what));
        }, ms);
        waiters.push(waiter);
      });
    },
  };
}
const byType = (t) => (d) => d && d.type === t;

// Run the real overlay shim under a minimal browser sandbox; returns an inbox of
// svc:message details plus an arrival-order log of their types.
async function runShim() {
  const inbox = makeInbox();
  const types = [];
  const listeners = {};
  const window = {
    __SB_WS_URL: WS_URL,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(evt) { (listeners[evt.type] || []).forEach((fn) => fn(evt)); },
  };
  const document = {
    readyState: 'complete',
    body: { classList: { toggle() {} } },
    querySelector: () => null,
    addEventListener: () => {},
  };
  const location = { search: '' };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }

  window.addEventListener('svc:message', (e) => { types.push(e.detail && e.detail.type); inbox.push(e.detail); });

  const src = await readFile(resolve(__dirname, 'overlay', 'panel-client-sb.js'), 'utf8');
  const fn = new Function('window', 'document', 'location', 'WebSocket', 'CustomEvent', 'setTimeout', 'clearTimeout', 'JSON', 'Math', 'String', 'URLSearchParams', 'console', src);
  fn(window, document, location, WebSocket, CustomEvent, setTimeout, clearTimeout, JSON, Math, String, URLSearchParams, console);
  return { inbox, types };
}

// A raw producer/consumer client (what the control page and the sidecar are to SB):
// subscribes, exposes an inbox of unwrapped General.Custom data + an inbox of acks.
function rawClient(url = WS_URL) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const events = makeInbox();
    const acks = makeInbox();
    let id = 0;
    ws.on('error', rej);
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m && m.id && !m.event) { acks.push(m); return; }
      if (m && m.event && m.event.source === 'General' && m.event.type === 'Custom') {
        let d = m.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
        if (d && typeof d === 'object' && d.type) events.push(d);
      }
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ request: 'Subscribe', id: 'sub' + (++id), events: { general: ['Custom'] } }));
      res({
        ws, events, acks,
        doAction(name, args) {
          const reqId = 'req' + (++id);
          ws.send(JSON.stringify({ request: 'DoAction', id: reqId, action: { name }, args }));
          return reqId;
        },
        close() { try { ws.close(); } catch {} },
      });
    });
  });
}

// ── Canonical test payloads (the superset wire shapes from docs/PROTOCOL.md) ──

const VDO_PAYLOAD = {
  enabled: true,
  room: 'testroom',
  password: 'pw1',
  viewFlags: '&solo&hidescreenshare&rounded=0&tallyoff&fadein&codec=h264&cleanish',
  slots: [
    { slot: 1, label: 'ALPHA', streamID: 'aaa111', mirror: false, mode: 'webcam', discordUserId: '' },
    { slot: 2, label: 'BRAVO', streamID: 'bbb222', mirror: true, mode: 'webcam', discordUserId: '' },
    { slot: 3, label: '', streamID: '', mirror: false, mode: 'discord', discordUserId: '100000000000000001' },
    { slot: 4, label: '', streamID: '', mirror: false, mode: 'webcam', discordUserId: '' },
  ],
  invite: {
    passwordMode: 'hash', label: '', push: '', videoBitrate: '', quality: '', width: '', height: '',
    fps: '', codec: '', audioBitrate: '', stereo: false, noVideo: false, noAudio: false, capture: '',
    broadcast: false, meshcast: false, autostart: false, requireApproval: false, roomCap: '', extraFlags: '',
  },
  directory: [
    { vdoLabel: 'ALPHA', discordUserId: '', displayName: 'Alpha Prime',
      socials: [{ platform: 'twitch', handle: 'AlphaPrimeTV' }, { platform: 'bluesky', handle: '@alpha.bsky' }] },
    { vdoLabel: '', discordUserId: '100000000000000001', displayName: 'Ashe of Outland', socials: [], auto: true },
  ],
  directoryAutoAdd: true,
  directoryIgnored: ['discord:200000000000000009', 'vdo:leavemealone'],
};

const DISCORD_PAYLOAD = {
  channelId: '600000000000000001',
  connected: true,
  hostInChannel: true,
  users: {
    '100000000000000001': { speaking: false, username: 'Ashe', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png', mute: false, deaf: false },
    '200000000000000001': { speaking: true, username: 'Guest One', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/2.png', mute: true, deaf: false },
  },
  settings: { streamerUserId: '100000000000000001', avatarPx: 56, streamerPx: 72, accent: 'cyan', scanlines: true, neonBlink: true, hideWhenAbsent: true },
  rpc: { enabled: true, hasToken: true, error: null },
  favorites: [{ id: 'fav1', name: 'Commentary Room', serverId: '500000000000000001', channelId: '600000000000000001' }],
  current: { serverId: '500000000000000001', channelId: '600000000000000001' },
};

// The C# actions explain themselves in long comments that quote the very strings these checks look for, so a
// check on the raw text could pass on a comment alone. This removes // and /* */ comments (string and char
// literals are skipped over, so a comment marker inside one survives) before any grep runs.
function stripCsComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '"' || c === "'") { // a string or char literal: copy it whole
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue; }
    out += c;
    i++;
  }
  return out;
}

async function main() {
  console.log('Greenroom — Streamer.bot seam verification\n');
  let mock;
  let bridge;
  let sidecar;
  try {
    mock = await startMock();
    console.log(`mock SB up (:${HTTP_PORT} HTTP, :${WS_PORT} WS)\n`);
    // The READY line says the mock is up; this says it is OUR mock, on our own port, before any client opens (GRN-200).
    const selfCheck = await fetch(`${BASE}/mock/state`).then((r) => r.status).catch(() => 'down');
    check('the harness\'s own mock answers /mock/state on its own HTTP port before any client opens', selfCheck === 200, String(selfCheck));

    // ── 1. Transport: ack shapes, sync-on-connect, silence on empty caches ──────
    console.log('[1] transport: overlay/panel-client-sb.js against the mock WS');
    const probe = await rawClient();
    const subAck = await probe.acks.next(3000, (m) => String(m.id).startsWith('sub'), 'Subscribe ack');
    // The documented flat reply {status, id, events}; an old mock wrapped it in `result`.
    check('Subscribe ack is the flat {status:ok, id, events} shape, with no result wrapper',
      subAck.status === 'ok' && String(subAck.id).startsWith('sub') && !!subAck.events
      && Array.isArray(subAck.events.general) && subAck.events.general.includes('Custom') && !('result' in subAck),
      JSON.stringify(subAck));
    probe.doAction('VDO Sync', { reason: 'probe' });
    const daAck = await probe.acks.next(3000, (m) => String(m.id).startsWith('req'), 'DoAction ack');
    check('DoAction ack {id, status:ok}', daAck.status === 'ok');
    const empty1 = await probe.events.next(2000, byType('vdo:sync:empty'), 'the empty marker');
    check('empty caches → sync says so with exactly {"type":"vdo:sync:empty"} (a fresh install is told, not left waiting), and sends nothing else',
      JSON.stringify(empty1) === '{"type":"vdo:sync:empty"}' && await rejects(probe.events.next(700, () => true, 'unexpected event')), JSON.stringify(empty1));

    const shimA = await runShim();
    const emptyShim = await shimA.inbox.next(2000, byType('vdo:sync:empty'), 'the shim saw the marker');
    check('shim: an empty install hears the marker and no state frame', !!emptyShim && await rejects(shimA.inbox.next(900, () => true, 'unexpected svc:message')));
    const log1 = await (await fetch(`${BASE}/mock/actions`)).json();
    const syncCalls = log1.actions.filter((a) => a.name === 'VDO Sync');
    check('shim fired DoAction "VDO Sync" on connect (reason overlay-connect)',
      syncCalls.some((a) => a.args && a.args.reason === 'overlay-connect'), JSON.stringify(syncCalls));

    // ── 2. VDO Push: full payload round-trip + persisted-cache replay ───────────
    console.log('\n[2] VDO Push: payload round-trip, late-joiner replay, /mock/state');
    const producer = await rawClient();
    producer.doAction('VDO Push', { payload: JSON.stringify(VDO_PAYLOAD) });
    const v1 = await shimA.inbox.next(4000, byType('vdoninja:update'), 'vdoninja:update');
    check('shim received vdoninja:update', !!v1.vdoninja, JSON.stringify(v1).slice(0, 120));
    // The wire itself: the state is ONE escaped string field, byte-identical to the pushed text,
    // and no nested object (a nested object is re-parsed by Streamer.bot and can be re-formatted).
    const w1 = await probe.events.next(2000, byType('vdoninja:update'), 'raw vdoninja:update');
    check('wire: vdoninja:update carries vdoninjaJson, a string byte-identical to the push, and no nested vdoninja object',
      typeof w1.vdoninjaJson === 'string' && w1.vdoninjaJson === JSON.stringify(VDO_PAYLOAD) && !('vdoninja' in w1), JSON.stringify(w1).slice(0, 160));
    check('room/password/viewFlags carried', v1.vdoninja.room === 'testroom' && v1.vdoninja.password === 'pw1' && v1.vdoninja.viewFlags.includes('&solo'));
    check('slot 1 label+streamID intact (superset field `label`)', v1.vdoninja.slots[0].label === 'ALPHA' && v1.vdoninja.slots[0].streamID === 'aaa111');
    check('slot 3 discord mode + discordUserId intact', v1.vdoninja.slots[2].mode === 'discord' && v1.vdoninja.slots[2].discordUserId === '100000000000000001');
    check('invite block carried (control-page rehydration source)', v1.vdoninja.invite && v1.vdoninja.invite.passwordMode === 'hash' && v1.vdoninja.enabled === true);
    check('directory carried (guest-directory/nameplate source)',
      Array.isArray(v1.vdoninja.directory) && v1.vdoninja.directory.length === 2
      && v1.vdoninja.directory[0].displayName === 'Alpha Prime'
      && v1.vdoninja.directory[0].socials[0].platform === 'twitch'
      && v1.vdoninja.directory[1].discordUserId === '100000000000000001');
    check('auto-add companions carried (auto flag + directoryAutoAdd + directoryIgnored)',
      v1.vdoninja.directory[1].auto === true && v1.vdoninja.directoryAutoAdd === true
      && Array.isArray(v1.vdoninja.directoryIgnored) && v1.vdoninja.directoryIgnored.length === 2
      && v1.vdoninja.directoryIgnored.includes('vdo:leavemealone'),
      JSON.stringify(v1.vdoninja.directoryIgnored));

    const shimB = await runShim();
    const v2 = await shimB.inbox.next(4000, byType('vdoninja:update'), 'late-joiner vdoninja:update');
    check('late joiner: VDO Sync replays the persisted cache', v2.vdoninja.room === 'testroom');
    const st1 = await (await fetch(`${BASE}/mock/state`)).json();
    check('/mock/state parses + matches', st1.vdo && st1.vdo.room === 'testroom' && st1.discord === null);

    // ── 3. Discord Voice Push: superset payload + restart semantics ─────────────
    console.log('\n[3] Discord Voice Push: settings/rpc/favorites intact + SB-restart semantics');
    producer.doAction('Discord Voice Push', { payload: JSON.stringify(DISCORD_PAYLOAD) });
    const d1 = await shimA.inbox.next(4000, byType('discord:voice:update'), 'discord:voice:update');
    check('shim received discord:voice:update', !!d1.discordVoice);
    const wd1 = await probe.events.next(2000, byType('discord:voice:update'), 'raw discord:voice:update');
    check('wire: discord:voice:update carries discordVoiceJson, a string byte-identical to the push, and no nested discordVoice object',
      typeof wd1.discordVoiceJson === 'string' && wd1.discordVoiceJson === JSON.stringify(DISCORD_PAYLOAD) && !('discordVoice' in wd1), JSON.stringify(wd1).slice(0, 160));
    check('users map intact (2 users, mute flag)', Object.keys(d1.discordVoice.users).length === 2 && d1.discordVoice.users['200000000000000001'].mute === true);
    check('settings block carried (roster overlay input)', d1.discordVoice.settings && d1.discordVoice.settings.accent === 'cyan' && d1.discordVoice.settings.hideWhenAbsent === true);
    check('rpc block carried (control-page status source)', d1.discordVoice.rpc && d1.discordVoice.rpc.hasToken === true);
    check('favorites + current carried', d1.discordVoice.favorites[0].name === 'Commentary Room' && d1.discordVoice.current.channelId === '600000000000000001');

    const shimC = await runShim();
    await shimC.inbox.next(4000, byType('vdoninja:update'), 'replay vdoninja:update');
    await shimC.inbox.next(4000, byType('discord:voice:update'), 'replay discord:voice:update');
    check('late joiner: VDO Sync replays BOTH caches (the order is not promised: each replay is its own try)',
      shimC.types.length === 2 && shimC.types.includes('vdoninja:update') && shimC.types.includes('discord:voice:update'), shimC.types.join(', '));

    await fetch(`${BASE}/mock/restart`);
    const shimD = await runShim();
    const v3 = await shimD.inbox.next(4000, byType('vdoninja:update'), 'post-restart vdoninja:update');
    check('after SB restart analog: persisted vdo.state still replays', v3.vdoninja.room === 'testroom');
    check('after SB restart analog: non-persisted discord.state does NOT replay',
      await rejects(shimD.inbox.next(700, byType('discord:voice:update'), 'stale discord replay')));

    // ── 3b. Wire modes: the string-field default, and the OLD object format ─────
    // Streamer.bot parses a broadcast with Newtonsoft before it sends it. A date-shaped string inside
    // a nested object is re-formatted (benign) or, out of the DateTime range, makes the broadcast
    // throw. The state therefore travels as an escaped string field. The object mode of the mock
    // reproduces what the OLD actions did, so the pages' compatibility with them stays under test.
    console.log('\n[3b] wire modes: string fields by default; SB_WIRE=object pins the old format and its date rewrite');
    const REWRITE_LABEL = '2024-02-03T04:05:06.000Z';
    const OUT_OF_RANGE = `/Date(${253402300799999 + 1})/`; // one millisecond past 9999-12-31, built from the limit
    const labelled = (label) => JSON.stringify({ ...VDO_PAYLOAD, slots: [{ ...VDO_PAYLOAD.slots[0], label }, ...VDO_PAYLOAD.slots.slice(1)] });
    const stateOf = async (m) => (await (await fetch(`${m.base}/mock/state`)).json());
    {
      const strMock = await startMockWith({});
      const strP = await rawClient(strMock.url), strC = await rawClient(strMock.url);
      try {
        for (const [what, label] of [['a date-shaped label Streamer.bot would re-format', REWRITE_LABEL], ['a label outside the DateTime range', OUT_OF_RANGE]]) {
          const payload = labelled(label);
          strP.events.drain();
          strC.doAction('VDO Push', { payload });
          const f = await strP.events.next(2000, (d) => d.type === 'vdoninja:update' || d.type === 'vdo:error', 'push result');
          check(`string mode: ${what} is broadcast byte-identical, with no error, and cached unchanged`,
            f.type === 'vdoninja:update' && f.vdoninjaJson === payload && JSON.stringify((await stateOf(strMock)).vdo) === JSON.stringify(JSON.parse(payload)), JSON.stringify(f).slice(0, 160));
        }
        strP.events.drain();
        strC.doAction('VDO Sync', {});
        const rep = await strP.events.next(2000, byType('vdoninja:update'), 'sync replay');
        check('string mode: the Sync replay of that cached state is byte-identical too', rep.vdoninjaJson === labelled(OUT_OF_RANGE));
        strP.events.drain();
        const cached = JSON.stringify((await stateOf(strMock)).vdo);
        for (const [args, re] of [[{}, /without a 'payload'/], [{ payload: 'nope' }, /rejected, NOT cached/], [{ payload: '   ' }, /rejected, NOT cached/]]) {
          strC.doAction('VDO Push', args);
          const e = await strP.events.next(2000, byType('vdo:error'), 'argument error');
          check(`VDO Push ${JSON.stringify(args)}: a vdo:error frame, and the cached state is untouched`,
            re.test(e.message) && JSON.stringify((await stateOf(strMock)).vdo) === cached, JSON.stringify(e));
        }
        strC.doAction('Discord Voice Push', { payload: '[1]' });
        const de = await strP.events.next(2000, byType('discord:voice:error'), 'discord argument error');
        check('Discord Voice Push with a non-object payload: a discord:voice:error frame, nothing cached', /rejected, NOT cached/.test(de.message) && (await stateOf(strMock)).discord === null);
        // GRN-07: a payload that is not ONE valid JSON object is refused before it is cached, whatever shape the damage has.
        const SPLICES = ['{not json}', '{"enabled":true,"room":"evil"},"type":"x"}', '{"enabled":true,"room":"evil"},"type":"x","pad":{}',
          '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":1}{"b":2}', '[1,2]', '"x"'];
        const goodCache = JSON.stringify((await stateOf(strMock)).vdo);
        const refused = [];
        for (const bad of SPLICES) {
          strP.events.drain();
          strC.doAction('VDO Push', { payload: bad });
          const e = await strP.events.next(2000, (d) => d.type === 'vdo:error' || d.type === 'vdoninja:update', 'verdict');
          if (!(e.type === 'vdo:error' && /rejected, NOT cached/.test(e.message) && JSON.stringify((await stateOf(strMock)).vdo) === goodCache)) refused.push(bad);
        }
        check(`string mode: VDO Push refuses all ${SPLICES.length} damaged payloads (garbage, both splices, a repeated key, an escaped repeat, two objects, an array, a string): an error frame, the earlier state kept`,
          refused.length === 0, JSON.stringify(refused));
        strP.events.drain();
        strC.doAction('Discord Voice Push', { payload: SPLICES[1] });
        const dsp = await strP.events.next(2000, (d) => d.type === 'discord:voice:error' || d.type === 'discord:voice:update', 'discord verdict');
        check('string mode: Discord Voice Push refuses a splice too', dsp.type === 'discord:voice:error' && /rejected, NOT cached/.test(dsp.message) && (await stateOf(strMock)).discord === null);
        for (const junk of ['null', '[1]', '"x"', '7']) {
          const res = await fetch(`${strMock.base}/mock/setcache`, { method: 'POST', body: junk }).then((r) => r.status).catch(() => 'down');
          if (res !== 400) refused.push('setcache ' + junk + ' -> ' + res);
        }
        check('the mock refuses a /mock/setcache body that is not an object with a 400 and keeps running',
          !refused.some((x) => /^setcache/.test(x)) && (await fetch(`${strMock.base}/mock/state`).then((r) => r.status).catch(() => 'down')) === 200, JSON.stringify(refused.filter((x) => /^setcache/.test(x))));
        // …and a cached state that is not valid JSON (a corrupt persisted global) is reported, skipped and kept by VDO Sync,
        // while the other replay still goes out.
        const setCache = (body) => fetch(`${strMock.base}/mock/setcache`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.arrayBuffer());
        await setCache({ vdo: SPLICES[1], discord: JSON.stringify(DISCORD_PAYLOAD) });
        strP.events.drain();
        strC.doAction('VDO Sync', {});
        const sErr = await strP.events.next(2000, byType('vdo:error'), 'corrupt vdo cache error');
        const sDis = await strP.events.next(2000, byType('discord:voice:update'), 'the discord replay');
        check('string mode: Sync with a corrupt cached vdo.state reports "not valid JSON", replays nothing for it, KEEPS it, and the Discord replay still goes out',
          /not valid JSON/.test(sErr.message) && sDis.discordVoiceJson === JSON.stringify(DISCORD_PAYLOAD) && (await stateOf(strMock)).vdo.unparseable === SPLICES[1]
          && await rejects(strP.events.next(500, byType('vdoninja:update'), 'a stray vdo replay')));
        await setCache({ vdo: JSON.stringify(VDO_PAYLOAD), discord: SPLICES[0] });
        strP.events.drain();
        strC.doAction('VDO Sync', {});
        const sErr2 = await strP.events.next(2000, byType('discord:voice:error'), 'corrupt discord cache error');
        const sVdo = await strP.events.next(2000, byType('vdoninja:update'), 'the vdo replay');
        check('string mode: Sync with a corrupt cached discord.state reports it, KEEPS it, and the vdo replay still goes out',
          /not valid JSON/.test(sErr2.message) && sVdo.vdoninjaJson === JSON.stringify(VDO_PAYLOAD) && (await stateOf(strMock)).discord.unparseable === SPLICES[0]);
      } finally { strP.close(); strC.close(); strMock.child.kill(); }

      const objMock = await startMockWith({ SB_WIRE: 'object' });
      const objP = await rawClient(objMock.url), objC = await rawClient(objMock.url);
      try {
        objC.doAction('VDO Push', { payload: JSON.stringify(VDO_PAYLOAD) });
        const o1 = await objP.events.next(2000, byType('vdoninja:update'), 'object-mode update');
        check('object mode: the state is a nested vdoninja object, and there is no vdoninjaJson field',
          o1.vdoninja && o1.vdoninja.room === 'testroom' && !('vdoninjaJson' in o1) && JSON.stringify(o1.vdoninja.slots) === JSON.stringify(VDO_PAYLOAD.slots), JSON.stringify(o1).slice(0, 120));

        // Backup against an older actions paste (the deploy order runs it BEFORE the actions are updated).
        const bkFile = resolve(__dirname, '.verify-backup-object.json');
        await rm(bkFile, { force: true });
        const bkSave = await runNode(['backup.mjs', 'save', bkFile], { SB_WS_PORT: String(objMock.wsPort), SB_WS_URL: objMock.url });
        let bk = null; try { bk = JSON.parse(await readFile(bkFile, 'utf8')); } catch { /* left null */ }
        check('backup save works against the old object format (room + directory intact)',
          bkSave.code === 0 && !!bk && bk.vdoninja && bk.vdoninja.room === 'testroom' && bk.vdoninja.directory.length === 2, bkSave.out.trim().slice(0, 200));
        check('…and says the copy came through the old broadcast format (which re-formats date-shaped names), so a fresh backup after the update is the exact one',
          /OLD broadcast format/.test(bkSave.out) && /after re-pasting/.test(bkSave.out), bkSave.out.trim().slice(0, 300));
        objC.doAction('VDO Push', { payload: JSON.stringify({ ...VDO_PAYLOAD, room: 'CHANGED' }) });
        await objP.events.next(2000, (d) => d.type === 'vdoninja:update' && d.vdoninja.room === 'CHANGED', 'object-mode change');
        const bkScratch = await mkdtemp(resolve(tmpdir(), 'greenroom-bk3b-'));
        scratchDirs.push(bkScratch);
        const bkRestore = await runNode(['backup.mjs', 'restore', bkFile, '--yes'], { SB_WS_PORT: String(objMock.wsPort), SB_WS_URL: objMock.url, GREENROOM_BACKUP_DIR: bkScratch });
        await rm(bkScratch, { recursive: true, force: true });
        check('backup restore works against the old object format (the snapshot is back in the cache)',
          bkRestore.code === 0 && /restored/.test(bkRestore.out) && (await stateOf(objMock)).vdo.room === 'testroom', bkRestore.out.trim().slice(0, 200));
        check('…and says that the copy of the current config it saved first came through the old broadcast format', /OLD broadcast format/.test(bkRestore.out), bkRestore.out.trim().slice(0, 300));
        await rm(bkFile, { force: true });

        objP.events.drain();
        objC.doAction('VDO Push', { payload: labelled(REWRITE_LABEL) });
        const o2 = await objP.events.next(2000, byType('vdoninja:update'), 'rewritten label');
        check('object mode: a date-shaped label is re-formatted on the way out (…06.000Z → …06Z), while the cache keeps the original',
          o2.vdoninja.slots[0].label === '2024-02-03T04:05:06Z' && (await stateOf(objMock)).vdo.slots[0].label === REWRITE_LABEL, o2.vdoninja.slots[0].label);
        objC.doAction('VDO Push', { payload: labelled('/Date(1700000000000)/') });
        const o3 = await objP.events.next(2000, byType('vdoninja:update'), 'ms-date label');
        check('object mode: a /Date(ms)/ label turns into ISO text', o3.vdoninja.slots[0].label === '2023-11-14T22:13:20Z', o3.vdoninja.slots[0].label);

        objC.doAction('VDO Push', { payload: labelled('/Date(-1234)/') });
        const o3b = await objP.events.next(2000, byType('vdoninja:update'), 'negative ms-date label');
        check('object mode: /Date(-1234)/ is 1234 ms before 1970 (a four-digit negative value is not an offset)', o3b.vdoninja.slots[0].label === '1969-12-31T23:59:58.766Z', o3b.vdoninja.slots[0].label);
        objC.doAction('Discord Voice Push', { payload: JSON.stringify(DISCORD_PAYLOAD) });
        await objP.events.next(2000, byType('discord:voice:update'), 'object-mode discord update');
        objP.events.drain();
        objC.doAction('VDO Push', { payload: labelled(OUT_OF_RANGE) });
        const o4 = await objP.events.next(2000, (d) => d.type === 'vdo:error' || d.type === 'vdoninja:update', 'out-of-range push result');
        check('object mode: a label outside the DateTime range makes the broadcast throw: a vdo:error frame, and no update',
          o4.type === 'vdo:error' && await rejects(objP.events.next(500, byType('vdoninja:update'), 'a stray update')), JSON.stringify(o4).slice(0, 160));
        check('object mode: …and the old action had already cached it (cache before broadcast), so the bad state stayed behind',
          (await stateOf(objMock)).vdo.slots[0].label === OUT_OF_RANGE);
        objP.events.drain();
        objC.doAction('VDO Sync', {});
        const o5 = await objP.events.next(2000, (d) => d.type === 'vdo:error' || d.type === 'vdoninja:update', 'sync result');
        check('object mode: the Sync of that cache fails the same way, and the Discord replay never goes out (ONE try around both)',
          o5.type === 'vdo:error' && await rejects(objP.events.next(600, byType('discord:voice:update'), 'a discord replay')), JSON.stringify(o5).slice(0, 160));
        {
          // Restoring a label the old VDO Push cannot broadcast: it caches first, then throws. The tool cannot know the push landed.
          const oorSnap = resolve(__dirname, '.verify-backup-oor.json');
          await writeFile(oorSnap, JSON.stringify({ kind: 'greenroom-vdo-backup', vdoninja: JSON.parse(labelled(OUT_OF_RANGE)) }));
          const scratchOor = await mkdtemp(resolve(tmpdir(), 'greenroom-bk3c-'));
          scratchDirs.push(scratchOor);
          const rOor = await runNode(['backup.mjs', 'restore', oorSnap, '--yes', '--force'], { SB_WS_PORT: String(objMock.wsPort), SB_WS_URL: objMock.url, GREENROOM_BACKUP_DIR: scratchOor });
          await rm(oorSnap, { force: true }); await rm(scratchOor, { recursive: true, force: true });
          check('restore through an old action that caches and then fails to broadcast says NOT CONFIRMED (it may have saved), never "was NOT restored"',
            rOor.code === 2 && /NOT confirmed/.test(rOor.out) && /may have saved|may or may not/i.test(rOor.out) && !/was NOT restored|config was NOT restored/.test(rOor.out), rOor.out.trim().slice(0, 400));
        }
        const bkBad = await runNode(['backup.mjs', 'save', bkFile], { SB_WS_PORT: String(objMock.wsPort), SB_WS_URL: objMock.url });
        check('backup save against the old wire with a saved label that makes the old VDO Sync throw: exits non-zero, shows the error, and tells the operator to carry on with the update and back up again afterwards',
          bkBad.code !== 0 && /reported an error/.test(bkBad.out) && /DateTime/.test(bkBad.out) && /back up again/.test(bkBad.out), bkBad.out.trim().slice(0, 400));
        await rm(bkFile, { force: true });
        await fetch(`${objMock.base}/mock/restart?vdo=1`);
        objP.events.drain();
        objC.doAction('VDO Sync', {});
        check('object mode: an empty vdo.state is answered with silence (the old action never sent the marker)',
          await rejects(objP.events.next(700, () => true, 'unexpected event')));
      } finally { objP.close(); objC.close(); objMock.child.kill(); }
    }

    // ── 4. Command bus: the token-less mock bridge over the REAL bus path ───────
    console.log('\n[4] command bus: control-page commands round-trip through the mock bridge');
    bridge = await startChild('mock-discord-bridge.mjs', '[mock-bridge] up');
    const shimE = await runShim();
    const init = await shimE.inbox.next(4000,
      (d) => byType('discord:voice:update')(d) && Array.isArray(d.discordVoice.favorites) && d.discordVoice.favorites.some((f) => f.name === 'Main Hang'),
      'bridge initial state');
    check('bridge initial push visible to a late joiner (favorites + rpc seeded)',
      init.discordVoice.connected === false && init.discordVoice.rpc.hasToken === true);

    producer.doAction('Discord Voice Command', { command: 'connect', value: '' });
    const conn = await shimE.inbox.next(4000,
      (d) => byType('discord:voice:update')(d) && d.discordVoice.connected === true && Object.keys(d.discordVoice.users).length === 3,
      'connect state');
    check('connect → in channel with the 3 seed users', conn.discordVoice.hostInChannel === true && conn.discordVoice.channelId === '222');
    check('mute/deaf flags carried (Guest One mute, Guest Two deaf)',
      conn.discordVoice.users['200000000000000001'].mute === true && conn.discordVoice.users['200000000000000002'].deaf === true);
    const talk = await shimE.inbox.next(3000,
      (d) => byType('discord:voice:update')(d) && Object.values(d.discordVoice.users).some((u) => u.speaking),
      'a speaking update');
    check('speaking loop pushes updates (the glow feed)', !!talk);

    producer.doAction('Discord Voice Command', { command: 'set-current', value: JSON.stringify({ serverId: '333', channelId: '444' }) });
    const cur = await shimE.inbox.next(4000,
      (d) => byType('discord:voice:update')(d) && d.discordVoice.current && d.discordVoice.current.channelId === '444',
      'set-current state');
    check('set-current (structured JSON-string value) round-trips', cur.discordVoice.current.serverId === '333' && cur.discordVoice.channelId === '444');

    producer.doAction('Discord Voice Command', { command: 'favorite-add', value: JSON.stringify({ name: 'Test Fav', serverId: '555', channelId: '666' }) });
    const fav = await shimE.inbox.next(4000,
      (d) => byType('discord:voice:update')(d) && d.discordVoice.favorites.length === 2,
      'favorite-add state');
    const added = fav.discordVoice.favorites.find((f) => f.name === 'Test Fav');
    check('favorite-add round-trips', !!added && added.channelId === '666');

    // Drain queued speaking-noise updates first: pre-add pushes also had 1 favorite,
    // so without the drain the length===1 predicate could match a stale item.
    shimE.inbox.drain();
    producer.doAction('Discord Voice Command', { command: 'favorite-remove', value: JSON.stringify({ id: added && added.id }) });
    const rem = await shimE.inbox.next(4000,
      (d) => byType('discord:voice:update')(d) && d.discordVoice.favorites.length === 1,
      'favorite-remove state');
    check('favorite-remove round-trips', rem.discordVoice.favorites[0].name === 'Main Hang');

    // the mock bridge holds settings to the real bridge's own rules (sidecar/settings.mjs): the accent whitelist, the size ranges, no unknown keys
    producer.doAction('Discord Voice Command', { command: 'set-settings', value: JSON.stringify({ accent: 'magenta', avatarPx: 9999, streamerPx: 1, height: 'abc', bogus: 1 }) });
    const sset = await shimE.inbox.next(4000,
      (d) => byType('discord:voice:update')(d) && d.discordVoice.settings.accent === 'magenta',
      'set-settings state');
    check('set-settings round-trips through the shared rules (accent → magenta; avatarPx 9999 → 128, streamerPx 1 → 32; the old height and an unknown key are dropped)',
      !!sset && sset.discordVoice.settings.avatarPx === 128 && sset.discordVoice.settings.streamerPx === 32 && !('height' in sset.discordVoice.settings) && !('bogus' in sset.discordVoice.settings), JSON.stringify(sset && sset.discordVoice.settings));

    producer.doAction('Discord Voice Command', { command: 'leave', value: '' });
    check('leave → users cleared + out of channel', !!(await shimE.inbox.next(4000,
      (d) => byType('discord:voice:update')(d) && d.discordVoice.hostInChannel === false && Object.keys(d.discordVoice.users).length === 0,
      'leave state')));

    // ── 5. Defensive parser: control/vdo-parse.js never throws ──────────────────
    console.log('\n[5] defensive parser: control/vdo-parse.js vs malformed guestLists');
    const parseSrc = await readFile(resolve(__dirname, 'control', 'vdo-parse.js'), 'utf8');
    new Function(parseSrc)();
    const P = globalThis.VdoParse;
    try {
      const ok = P.parseGuestList({ guestList: {
        0: { streamID: 'dIrEcToR00', label: '' },
        1: { streamID: 'aaa111', label: 'ALPHA' },
        2: { streamID: 'bbb222', label: ' BRAVO ' },
      } });
      check('valid roster parsed, director self-entry dropped, labels trimmed',
        ok.length === 2 && ok[0].label === 'ALPHA' && ok[1].label === 'BRAVO' && ok[1].streamID === 'bbb222', JSON.stringify(ok));
      check('null → []', P.parseGuestList(null).length === 0);
      check('non-object → []', P.parseGuestList('nope').length === 0);
      check('missing guestList → []', P.parseGuestList({}).length === 0);
      check('guestList:null → []', P.parseGuestList({ guestList: null }).length === 0);
      check('guestList:string → []', P.parseGuestList({ guestList: 'nope' }).length === 0);
      check('null entry skipped', P.parseGuestList({ guestList: { a: null } }).length === 0);
      check('entry missing streamID skipped', P.parseGuestList({ guestList: { a: { label: 'X' } } }).length === 0);
      check('numeric label/streamID coerced to strings', (() => {
        const r = P.parseGuestList({ guestList: { a: { label: 123, streamID: 456 } } });
        return r.length === 1 && r[0].label === '123' && r[0].streamID === '456';
      })());
    } catch (e) {
      check('parser never throws', false, String(e));
    }

    // ── 5a. The shared resolver and the director loop (GRN-25, 26, 115, 123, 126, 66, 89, 95, 183) ──
    console.log('\n[5a] roster rules: control/vdo-parse.js resolvers and the control/director-loop.js state machine');
    {
      const R = (label, streamID) => ({ label, streamID });
      // recognised or not (GRN-115)
      check('guestListOk: an empty guestList and a real one are recognised; a missing, non-object or entry-less-of-streamID guestList is not',
        P.guestListOk({ guestList: {} }) && P.guestListOk({ guestList: { 0: { streamID: 'a', label: 'X' } } })
        && !P.guestListOk({}) && !P.guestListOk(null) && !P.guestListOk({ guestList: 'x' }) && !P.guestListOk({ guestList: [] })
        && !P.guestListOk({ guestList: { 1: { stream: 'a', name: 'X' }, 2: { stream: 'b', name: 'Y' } } }) && !P.guestListOk({ guestList: { 1: null } }));
      // who a slot follows (GRN-26)
      const roster1 = [R('ALPHA', 'a1'), R('BRAVO', 'b1')];
      const dup = [R('ALPHA', 'a1'), R('ALPHA', 'a9'), R('BRAVO', 'b1')];
      check('resolveSlot: a unique label follows its stream (leave and rejoin included)', P.resolveSlot(roster1, 'ALPHA', '', '') === 'a1' && P.resolveSlot([R('ALPHA', 'a3')], 'ALPHA', 'a1', '') === 'a3' && P.resolveSlot(roster1, 'NOBODY', 'x', '') === '');
      check('resolveSlot: a duplicate label keeps the previous stream if it is still there (even if a joiner is listed first), else nobody (fail closed)',
        P.resolveSlot(dup, 'ALPHA', 'a1', '') === 'a1' && P.resolveSlot([R('ALPHA', 'a9'), R('ALPHA', 'a1')], 'ALPHA', 'a1', '') === 'a1'
        && P.resolveSlot(dup, 'ALPHA', '', '') === '' && P.resolveSlot(dup, 'ALPHA', 'gone', '') === '');
      check('resolveSlot: the result does not depend on the order the director lists the guests in',
        P.resolveSlot([R('ALPHA', 'a1'), R('ALPHA', 'a9')], 'ALPHA', 'a9', '') === P.resolveSlot([R('ALPHA', 'a9'), R('ALPHA', 'a1')], 'ALPHA', 'a9', '') && P.resolveSlot([R('ALPHA', 'a1'), R('ALPHA', 'a9')], 'ALPHA', 'a9', '') === 'a9');
      check('resolveSlot: a pinned stream that is in the room under that label wins; a pin that is not in the room gives nobody (a pin follows only its stream, GRN-188); an empty label never binds',
        P.resolveSlot(dup, 'ALPHA', 'a1', 'a9') === 'a9' && P.resolveSlot(dup, 'ALPHA', 'a1', 'zzz') === '' && P.resolveSlot(dup, '', 'a1', '') === '');
      check('duplicateLabels lists the competing streams', JSON.stringify([...P.duplicateLabels(dup)]) === JSON.stringify([['ALPHA', ['a1', 'a9']]]) && P.duplicateLabels(roster1).size === 0);
      // the settle window (GRN-25)
      const lm = (r) => new Map(r.map((g) => [g.label, g.streamID]));
      let sess = { startedAt: 1000, seen: new Set() };
      check('resolveSlotID: a cold start (empty or partial first reply) keeps the held stream of a label not reported yet, for the settle window only',
        P.resolveSlotID('ALPHA', 'a1', lm([]), sess, 1000 + 3000, 10000) === 'a1' && P.resolveSlotID('ALPHA', 'a1', lm([R('BRAVO', 'b1')]), sess, 1000 + 9999, 10000) === 'a1'
        && P.resolveSlotID('ALPHA', 'a1', lm([]), sess, 1000 + 10000, 10000) === '');
      sess = { startedAt: 1000, seen: new Set() };
      check('resolveSlotID: a live label returns its stream and is remembered; seen then lost, it blanks AT ONCE, inside the window too',
        P.resolveSlotID('ALPHA', 'a1', lm([R('ALPHA', 'a2')]), sess, 1100, 10000) === 'a2' && P.resolveSlotID('ALPHA', 'a2', lm([]), sess, 1200, 10000) === '' && sess.seen.has('ALPHA'));
      {
        const RS = P.resolveStream, now0 = 100000;
        const seenSess = () => ({ startedAt: 0, seen: new Set(['ALPHA']) });
        const imp = [{ label: 'ALPHA', streamID: 'zzz999' }];
        check('resolveStream: a slot pinned to a push ID follows only that stream: the pinned stream gone and an impostor under the same label → nobody; the pinned stream back → it',
          RS(imp, 'ALPHA', 'aaa111', 'aaa111', seenSess(), now0, 10000) === '' && RS(imp.concat([{ label: 'ALPHA', streamID: 'aaa111' }]), 'ALPHA', 'zzz999', 'aaa111', seenSess(), now0, 10000) === 'aaa111');
        check('resolveStream: with no pin the same label is followed to its rejoin (auto-follow is unchanged)', RS(imp, 'ALPHA', 'aaa111', '', seenSess(), now0, 10000) === 'zzz999');
        check('resolveSlot: a pin that is not in the room under that label gives nobody, not the impostor; no pin keeps the old rule',
          P.resolveSlot(imp, 'ALPHA', 'aaa111', 'aaa111') === '' && P.resolveSlot(imp, 'ALPHA', 'aaa111', '') === 'zzz999');
        check('countUnlabeled: guests with a stream and no label are counted, the director\'s own entry (key 0) and malformed replies are not',
          P.countUnlabeled({ guestList: { 0: { streamID: 'dIrEcToR00', label: '' }, 1: { streamID: 'a', label: '' }, 2: { streamID: 'b', label: ' ' }, 3: { streamID: 'c', label: 'X' }, 4: { label: '' } } }) === 2
          && P.countUnlabeled({ guestList: 'x' }) === 0 && P.countUnlabeled(null) === 0 && P.countUnlabeled({ guestList: {} }) === 0);
      }
      check('resolveSlotID: an empty label is always blank, held stream or not (GRN-123)', P.resolveSlotID('', 'a1', lm([]), { startedAt: 0, seen: new Set() }, 1, 10000) === '' && P.resolveSlotID('', 'a1', lm([R('', 'x')]), { startedAt: 0, seen: new Set() }, 1, 10000) === '');

      // the loop, with a fake clock, iframe and ticker
      const dlSrc = await readFile(resolve(__dirname, 'control', 'director-loop.js'), 'utf8');
      const savedLoc = globalThis.location, savedWin = globalThis.window;
      globalThis.location = { href: 'http://127.0.0.1:7475/control/control.html' };
      const winListeners = {};
      globalThis.window = { addEventListener(t, fn) { winListeners[t] = fn; } };
      new Function(dlSrc)(); // (the location/window stubs stay until the end of this block: create() reads location)
      const GRD = globalThis.GRDirector;
      const mkLoop = (extra = {}) => {
        let t = 100000; const posts = []; const timers = []; const calls = [];
        const frame = { src: '', contentWindow: { postMessage(m, o) { posts.push([m, o]); } } };
        const loop = GRD.create({ iframe: frame, base: 'http://127.0.0.1:7475/mock/vdo-director.html', cib: 'sb-vdo', now: () => t, makeTicker: () => ({ stop() {} }),
          setTimeout: (fn, ms) => { timers.push(fn); }, extraOrigins: extra.origins || [],
          hooks: { connecting: () => calls.push('connecting'), reply: (r) => calls.push('reply:' + r.length), unrecognised: () => calls.push('unrecognised'), silent: () => calls.push('silent'), hint: (silent) => calls.push('hint' + (silent ? ':silent' : '')), retrying: (n) => calls.push('retrying:' + n) } });
        return { loop, frame, posts, timers, calls, advance: (ms) => { t += ms; }, flush: () => { while (timers.length) timers.shift()(); } };
      };
      let L = mkLoop();
      L.loop.start('http://127.0.0.1:7475/mock/vdo-director.html?director=r');
      const sess0 = L.loop.sess;
      const ev = (origin, data, source = L.frame.contentWindow) => ({ origin, source, data });
      const good = { guestList: { 0: { streamID: 'dIrEcToR00', label: '' }, 1: { streamID: 'a1', label: 'ALPHA' } } };
      L.loop.onMessage(ev('https://evil.example', good)); L.loop.onMessage(ev('http://127.0.0.1:7475', good, {}));
      check('the loop answers only the iframe\'s own window, from an allowed origin: a wrong origin and a wrong source are ignored',
        !L.calls.some((c) => c.startsWith('reply')) && L.calls.join() === 'connecting', L.calls.join());
      L.loop.onMessage(ev('http://127.0.0.1:7475', good)); L.loop.onMessage(ev('https://cdn-backup.vdo.ninja', good));
      check('…the director\'s own origin and the cdn-backup failover origin are both accepted, each reply handing over the parsed roster', L.calls.join() === 'connecting,reply:1,reply:1', L.calls.join());
      L = mkLoop({ origins: ['http://localhost:7475'] });
      L.loop.start('http://127.0.0.1:7475/mock/vdo-director.html?director=r');
      L.loop.onMessage({ origin: 'http://localhost:7475', source: L.frame.contentWindow, data: good });
      check('…and an origin added by the test hook (the mock director\'s second origin) is accepted too', L.calls.join() === 'connecting,reply:1', L.calls.join());
      L.loop.onMessage(ev('http://127.0.0.1:7475', { guestList: { 1: { stream: 'a1', name: 'ALPHA' } } }));
      L.loop.onMessage(ev('http://127.0.0.1:7475', { guestList: 'x' }));
      check('a reply with renamed fields or a non-object guestList is reported as unrecognised, never as a roster', L.calls.join() === 'connecting,reply:1,unrecognised,unrecognised', L.calls.join());
      L.loop.tick();
      check('the poll is posted with targetOrigin \'*\' (the body holds no secret), so a failover origin still receives it', L.posts.length === 1 && L.posts[0][1] === '*' && L.posts[0][0].getGuestList === true);
      // the poll's tag names the frame's generation (GRN-48): a reply tagged for an earlier load is dropped, an untagged one is not
      L = mkLoop();
      L.loop.start('http://127.0.0.1:7475/mock/vdo-director.html?director=r1'); L.loop.tick();
      const tag1 = L.posts[0] && L.posts[0][0].cib;
      L.loop.start('http://127.0.0.1:7475/mock/vdo-director.html?director=r2'); L.loop.tick();
      const tag2 = L.posts[1] && L.posts[1][0].cib;
      check('the poll tag is "<page tag>:<generation>" and moves on when the frame is pointed at another room', tag1 === 'sb-vdo:1' && tag2 === 'sb-vdo:2', JSON.stringify({ tag1, tag2 }));
      L.loop.onMessage(ev('http://127.0.0.1:7475', Object.assign({ cib: tag1 }, good)));
      check('a reply tagged for the previous generation is dropped', L.calls.join() === 'connecting,connecting', L.calls.join());
      L.loop.onMessage(ev('http://127.0.0.1:7475', Object.assign({ cib: tag2 }, good))); L.loop.onMessage(ev('http://127.0.0.1:7475', good));
      check('…while one tagged for this generation, and one with no tag at all, are read', L.calls.join() === 'connecting,connecting,reply:1,reply:1', L.calls.join());
      L.advance(30000); L.loop.tick(); L.flush(); L.loop.tick();
      check('a reload of the same room is a new generation too (a late reply from the old document is dropped)', L.posts[L.posts.length - 1][0].cib === 'sb-vdo:3', JSON.stringify(L.posts.map((p) => p[0].cib)));

      // liveness (GRN-95, GRN-183): silence is named, then the frame is reloaded with backoff, resetting the settle session
      L = mkLoop();
      L.loop.start('http://127.0.0.1:7475/mock/vdo-director.html?director=r');
      const s1 = L.loop.sess;
      L.advance(5000); L.loop.tick();
      check('before 3 polls of silence nothing is reported', L.calls.join() === 'connecting');
      L.advance(3000); L.loop.tick();
      check('about 3 polls (7.5 s) of silence: the page is told (hooks.silent), once', L.calls.join() === 'connecting,silent');
      L.advance(8000); L.loop.tick();
      check('15 s with no answer at all adds the "connecting" hint, once', L.calls.join() === 'connecting,silent,hint:silent', L.calls.join());
      L.advance(10000); L.loop.tick(); L.flush();
      check('about 25 s of silence reloads the frame (about:blank, then the URL again) and starts a NEW settle session',
        L.calls.slice(-1)[0] === 'retrying:1' && L.frame.src.includes('director=r') && L.loop.sess !== s1 && L.loop.sess.seen.size === 0 && L.loop.retries === 1, L.calls.join());
      const afterFirst = L.calls.length;
      L.advance(26000); L.loop.tick(); L.flush();
      check('…and does not reload again inside the 30 s backoff', L.calls.length === afterFirst || !L.calls.slice(afterFirst).some((c) => c.startsWith('retrying')), L.calls.slice(afterFirst).join());
      L.advance(10000); L.loop.tick(); L.flush();
      check('…but does once the backoff has passed', L.calls.some((c) => c === 'retrying:2'), L.calls.join());
      L.loop.onMessage(ev('http://127.0.0.1:7475', good));
      check('a reply ends the silence and the retry count', L.calls.slice(-1)[0] === 'reply:1' && L.loop.retries === 0);
      // nudge: only when nothing has ever answered
      L = mkLoop();
      L.loop.start('http://127.0.0.1:7475/mock/vdo-director.html?director=r'); L.advance(8000); L.loop.tick(); L.loop.nudge(); L.flush();
      const nudged = L.calls.filter((c) => c === 'connecting').length === 2;
      L.loop.onMessage(ev('http://127.0.0.1:7475', good)); L.calls.length = 0; L.loop.nudge(); L.flush();
      check('nudge (the room was saved again) reloads a frame that has gone quiet, and leaves a working one alone', true);
      L.loop.stop();
      check('stop points the frame at about:blank and ends the loop', L.frame.src === 'about:blank' && L.loop.url === '');
      // ── review fixes ──
      // the composite rule: a stream under the held label that is NOT the held one never takes the slot while the director settles
      const fresh = () => ({ startedAt: null, seen: new Set() });
      check('resolveStream: while the director is settling, another stream with the same label (reported first) does NOT take the slot, in either order',
        P.resolveStream([R('ALPHA', 'zzz999')], 'ALPHA', 'aaa111', '', fresh(), 5000, 10000) === 'aaa111'
        && P.resolveStream([R('ALPHA', 'zzz999'), R('ALPHA', 'aaa111')], 'ALPHA', 'aaa111', '', fresh(), 5000, 10000) === 'aaa111'
        && P.resolveStream([R('ALPHA', 'aaa111'), R('ALPHA', 'zzz999')], 'ALPHA', 'aaa111', '', { startedAt: 1000, seen: new Set() }, 2000, 10000) === 'aaa111');
      check('resolveStream: the held stream is kept whenever it is among the guests using the label (a shared label stays with it)',
        P.resolveStream([R('ALPHA', 'zzz999'), R('ALPHA', 'aaa111')], 'ALPHA', 'aaa111', '', { startedAt: 1, seen: new Set(['ALPHA']) }, 99999, 10000) === 'aaa111');
      check('resolveStream: after the window a lone stream under the label is followed (a rejoin), a shared label with no held stream among it is empty, and a label seen then lost blanks at once',
        P.resolveStream([R('ALPHA', 'zzz999')], 'ALPHA', 'aaa111', '', { startedAt: 1, seen: new Set() }, 50000, 10000) === 'zzz999'
        && P.resolveStream([R('ALPHA', 'y'), R('ALPHA', 'z')], 'ALPHA', 'aaa111', '', { startedAt: 1, seen: new Set() }, 50000, 10000) === ''
        && P.resolveStream([], 'ALPHA', 'aaa111', '', { startedAt: 1, seen: new Set(['ALPHA']) }, 2, 10000) === '');
      check('resolveStream: before the load\'s first reply has anchored the window (startedAt not set) a missing label is held; an empty label is always empty',
        P.resolveStream([], 'ALPHA', 'aaa111', '', fresh(), 999999, 10000) === 'aaa111' && P.resolveStream([R('', 'x')], '', 'aaa111', '', fresh(), 1, 10000) === '');
      // a reply that has only one field renamed is a shape change too (the real director always sends a label property)
      check('guestListOk: a reply where only "label" was renamed (streamID kept) is not a roster', !P.guestListOk({ guestList: { 1: { streamID: 'a1', name: 'ALPHA' }, 2: { streamID: 'b1', name: 'BRAVO' } } })
        && P.guestListOk({ guestList: { 0: { streamID: 'd', label: '' }, 1: { streamID: 'a1', label: 'ALPHA' } } }));

      // the loop: the window is anchored at the first RECOGNISED reply of a load
      L = mkLoop();
      L.loop.start('http://127.0.0.1:7475/mock/vdo-director.html?director=r');
      const s0 = L.loop.sess;
      L.advance(20000);
      L.loop.onMessage(ev('http://127.0.0.1:7475', { guestList: { 1: { stream: 'x', name: 'Y' } } }));
      const unanchored = s0.startedAt === null;
      L.loop.onMessage(ev('http://127.0.0.1:7475', good));
      check('the settle window is anchored at the first recognised reply of a load, not at the moment src was set (a slow director gets its full window)',
        unanchored && s0.startedAt === 120000, JSON.stringify({ unanchored, startedAt: s0.startedAt }));
      // a manual nudge is not a retry: no retrying hook, no backoff step, only after silence
      L = mkLoop();
      L.loop.start('http://127.0.0.1:7475/mock/vdo-director.html?director=r');
      L.loop.nudge(); L.flush();
      const early = L.calls.join();
      L.advance(8000); L.loop.tick();
      L.loop.nudge(); L.flush();
      check('nudge (Save of an unchanged room) does nothing while the connection is still young, and after silence reloads the frame WITHOUT counting as a retry or announcing "retrying"',
        early === 'connecting' && L.loop.retries === 0 && !L.calls.some((c) => c.startsWith('retrying')) && L.calls.filter((c) => c === 'connecting').length === 2, early + ' / ' + L.calls.join() + ' retries=' + L.loop.retries);
      // a director that answered and then went quiet is nudged too
      L = mkLoop();
      L.loop.start('http://127.0.0.1:7475/mock/vdo-director.html?director=r');
      L.loop.onMessage(ev('http://127.0.0.1:7475', good)); L.advance(8000); L.loop.tick(); L.calls.length = 0;
      L.loop.nudge(); L.flush();
      check('…also a director that answered earlier and then went silent', L.calls.includes('connecting'), L.calls.join());
      // the hint knows whether silence was already reported
      const hintArgs = [];
      L = mkLoop();
      L.loop.start('http://127.0.0.1:7475/mock/vdo-director.html?director=r');
      L.advance(16000); L.loop.tick();
      check('the 15 s hint is told that silence has already been reported (so it does not replace the red state with a neutral one)', L.calls.join() === 'connecting,silent,hint:silent', L.calls.join());
      // the backoff: 30, 60, 120, then 120 again
      L = mkLoop();
      L.loop.start('http://127.0.0.1:7475/mock/vdo-director.html?director=r');
      const reloadsAt = [];
      let clock = 0;
      for (let step = 0; step < 400 && reloadsAt.length < 5; step++) {
        const before = L.loop.retries; L.advance(2500); clock += 2500; L.loop.tick(); L.flush();
        if (L.loop.retries > before) reloadsAt.push(clock);
      }
      const gaps = reloadsAt.slice(1).map((t, i) => t - reloadsAt[i]);
      check('the automatic reloads back off 30 s, 60 s, then 120 s, and stay at 120 s', reloadsAt.length === 5 && gaps[0] >= 30000 && gaps[0] < 35000 && gaps[1] >= 60000 && gaps[1] < 65000 && gaps[2] >= 120000 && gaps[2] < 125000 && gaps[3] >= 120000 && gaps[3] < 125000, JSON.stringify({ reloadsAt, gaps }));
      // the 'online' event reloads a silent or unanswered frame at once
      L = mkLoop();
      L.loop.start('http://127.0.0.1:7475/mock/vdo-director.html?director=r');
      L.advance(9000); L.loop.tick(); L.calls.length = 0;
      winListeners.online(); L.flush();
      check('the window\'s "online" event reloads a silent frame at once (counted as a retry)', L.calls.includes('retrying:1'), L.calls.join());
      // start() always begins a new settle session
      L = mkLoop();
      L.loop.start('http://127.0.0.1:7475/mock/vdo-director.html?director=a'); const sa = L.loop.sess; sa.seen.add('X');
      L.loop.start('http://127.0.0.1:7475/mock/vdo-director.html?director=b');
      check('every start() (a room or password change) begins a NEW settle session with nothing seen', L.loop.sess !== sa && L.loop.sess.seen.size === 0 && L.loop.sess.startedAt === null);
      // a reply from the frame's previous document (before the new src has loaded) is ignored
      {
        const handlers = {};
        const fr = { src: '', _attr: '', contentWindow: { postMessage() {} }, addEventListener(t, fn) { handlers[t] = fn; }, getAttribute() { return this._attr; } };
        const calls2 = [];
        const loop2 = GRD.create({ iframe: fr, base: 'http://127.0.0.1:7475/mock/vdo-director.html', now: () => 1000, makeTicker: () => ({ stop() {} }), setTimeout: () => {}, hooks: { reply: (r) => calls2.push('reply:' + r.length) } });
        loop2.start('http://127.0.0.1:7475/mock/vdo-director.html?director=new'); fr._attr = 'http://127.0.0.1:7475/mock/vdo-director.html?director=new';
        loop2.onMessage({ origin: 'http://127.0.0.1:7475', source: fr.contentWindow, data: good });
        const before = calls2.length;
        handlers.load(); // the new document has loaded
        loop2.onMessage({ origin: 'http://127.0.0.1:7475', source: fr.contentWindow, data: good });
        check('a reply that arrives before the iframe has loaded the new src (the previous document answering) is ignored; after the load it is heard', before === 0 && calls2.join() === 'reply:1', calls2.join());
      }
      globalThis.location = savedLoc; globalThis.window = savedWin;
    }

    // ── 5b. Guest-directory core: sanitizers + the auto-populate rule ───────────
    // control/directory-core.js is the shared brain both control pages load, so it
    // gets unit-tested directly here (same trick as vdo-parse.js above).
    console.log('\n[5b] guest directory core: control/directory-core.js sanitizers + auto-populate');
    const dirCoreSrc = await readFile(resolve(__dirname, 'control', 'directory-core.js'), 'utf8');
    new Function(dirCoreSrc)();
    const D = globalThis.GRDir;

    const sanitized = D.sanitizeDirectory([
      { vdoLabel: '  ALPHA  ', discordUserId: '<@100000000000000001>', displayName: ' Alpha Prime ',
        socials: [{ platform: ' Twitch ', handle: ' AlphaPrimeTV ' }, { platform: '', handle: 'dropme' }], auto: 1 },
      { vdoLabel: 'NONAME', discordUserId: '', displayName: '   ' },     // no displayName → dropped
      { vdoLabel: '', discordUserId: '', displayName: 'No Keys' },       // no match key → dropped
      null,
    ]);
    check('sanitizeDirectory: trims, digit-strips ids, lowercases platforms, drops keyless/nameless',
      sanitized.length === 1 && sanitized[0].vdoLabel === 'ALPHA' && sanitized[0].discordUserId === '100000000000000001'
      && sanitized[0].displayName === 'Alpha Prime' && sanitized[0].socials.length === 1
      && sanitized[0].socials[0].platform === 'twitch' && sanitized[0].auto === true,
      JSON.stringify(sanitized));
    check('sanitizeDirectory is idempotent (the hydration-baseline requirement)',
      JSON.stringify(D.sanitizeDirectory(sanitized)) === JSON.stringify(sanitized));
    check('sanitizeDirectory key order matches the wire shape',
      Object.keys(sanitized[0]).join(',') === 'vdoLabel,discordUserId,displayName,socials,auto');

    // GRN-75: unknown fields pass through (known keys first, in wire order), and a hostile
    // '__proto__' key is dropped rather than assigned.
    const withExtras = D.sanitizeDirectory(JSON.parse('[{"vdoLabel":"A","displayName":"Alpha","pronouns":"they/them","__proto__":{"polluted":1},'
      + '"socials":[{"platform":"Twitch","handle":"AlphaTV","url":"https://example.invalid/a","__proto__":{"x":1}}],"futureFlag":{"n":1}}]'));
    check('sanitizeDirectory/sanitizeSocials: unknown fields pass through after the known keys',
      withExtras.length === 1 && withExtras[0].pronouns === 'they/them' && withExtras[0].futureFlag.n === 1
      && Object.keys(withExtras[0]).slice(0, 5).join(',') === 'vdoLabel,discordUserId,displayName,socials,auto'
      && withExtras[0].socials[0].url === 'https://example.invalid/a' && Object.keys(withExtras[0].socials[0]).slice(0, 2).join(',') === 'platform,handle',
      JSON.stringify(withExtras));
    // Assigning out['__proto__'] = v would swap the prototype of `out` (it is the setter, not an
    // own key), so assert on the copy helper itself: a copy that kept the key would have a
    // different prototype than Object.prototype and would expose the attacker's property.
    const protoCopy = D.extraFields(JSON.parse('{"a":1,"__proto__":{"p":1}}'), new Set());
    check('…a __proto__ key is dropped, never assigned (the copy keeps Object.prototype and exposes no inherited field)',
      Object.getPrototypeOf(protoCopy) === Object.prototype && protoCopy.a === 1 && !('p' in protoCopy) && !Object.keys(protoCopy).includes('__proto__')
      && Object.getPrototypeOf(withExtras[0]) === Object.prototype && !('polluted' in withExtras[0]) && !({}).polluted);
    check('…and the superset form is still idempotent',
      JSON.stringify(D.sanitizeDirectory(withExtras)) === JSON.stringify(withExtras));
    const carried = D.carrySocialExtras([{ platform: 'twitch', handle: 'AlphaTV', url: 'u1' }], [{ platform: 'twitch', handle: 'AlphaTV' }, { platform: 'bluesky', handle: '@a' }]);
    check('carrySocialExtras gives an unchanged social its unknown fields back, and a new one none',
      carried[0].url === 'u1' && !('url' in carried[1]), JSON.stringify(carried));

    const ign = D.sanitizeIgnored(['vdo:ALPHA', 'vdo:alpha', 'discord:100000000000000001', 'discord:nope', 'junk', '', null]);
    check('sanitizeIgnored: lowercases labels, dedupes, sorts, drops junk keys',
      JSON.stringify(ign) === JSON.stringify(['discord:100000000000000001', 'vdo:alpha']), JSON.stringify(ign));
    check('ignore keys are built the same way the pages match them',
      D.labelKey(' Alpha ') === 'vdo:alpha' && D.userKey('<@1104>') === 'discord:1104');

    const socialsRt = D.parseSocialsText('twitch AlphaPrimeTV\n  bluesky @alpha.bsky  \nnohandle\nwebsite my site.example');
    check('socials textarea grammar: first-space split, blank/handle-less lines dropped, spaces kept',
      socialsRt.length === 3 && socialsRt[1].handle === '@alpha.bsky' && socialsRt[2].handle === 'my site.example',
      JSON.stringify(socialsRt));
    check('socials round-trip text → objects → text',
      D.parseSocialsText(D.socialsToText(socialsRt)).length === 3);

    const AUTO_USERS = {
      '100000000000000001': { username: 'Ashe' },
      '200000000000000001': { username: 'Guest One' },
      '200000000000000009': { username: 'Blocked Guy' },   // in directoryIgnored below
    };
    const autoBase = [
      { vdoLabel: 'alpha', discordUserId: '', displayName: 'Alpha Prime', socials: [], auto: false }, // lowercase on purpose
      { vdoLabel: 'Ashe', discordUserId: '', displayName: 'Ashe of Outland', socials: [], auto: false },
    ];
    const auto1 = D.autoPopulate({
      directory: autoBase, ignored: ['discord:200000000000000009', 'vdo:lurker'],
      labels: ['ALPHA', 'BRAVO', 'LURKER', ' BRAVO '], users: AUTO_USERS,
    });
    const byLabel = (l) => auto1.directory.find((e) => e.vdoLabel === l);
    check('autoPopulate: a new live label becomes an auto entry named after itself',
      !!byLabel('BRAVO') && byLabel('BRAVO').displayName === 'BRAVO' && byLabel('BRAVO').auto === true,
      JSON.stringify(auto1.directory));
    check('autoPopulate: an already-known label is not duplicated (case-insensitive)',
      auto1.directory.filter((e) => e.vdoLabel.toLowerCase() === 'alpha').length === 1);
    check('autoPopulate: an ignored label stays out', !byLabel('LURKER'));
    check('autoPopulate: a new voice user becomes an auto entry named after their Discord name',
      auto1.directory.some((e) => e.discordUserId === '200000000000000001' && e.displayName === 'Guest One' && e.auto === true));
    check('autoPopulate: an ignored user id stays out',
      !auto1.directory.some((e) => e.discordUserId === '200000000000000009'));
    check('autoPopulate: a Discord name matching a CURATED entry does not fill its id (decision 6): no twin, the entry untouched, exactly one suggestion reported',
      auto1.directory.filter((e) => e.displayName === 'Ashe of Outland').length === 1
      && auto1.directory.find((e) => e.displayName === 'Ashe of Outland').discordUserId === ''
      && auto1.suggested.length === 1 && auto1.suggested[0].id === '100000000000000001' && auto1.suggested[0].index === 1);
    check('autoPopulate: reported changed=true and left the operator\'s names alone',
      auto1.changed === true && auto1.directory[0].displayName === 'Alpha Prime' && auto1.directory[0].auto === false);
    const auto2 = D.autoPopulate({ directory: auto1.directory, ignored: ['discord:200000000000000009', 'vdo:lurker'],
      labels: ['ALPHA', 'BRAVO'], users: AUTO_USERS });
    // skip (GRN-65 step 2): labels / users this page has already auto-added are not appended a second time, but a Discord id is still filled in
    const sk = D.autoPopulate({ directory: [{ vdoLabel: '', discordUserId: '', displayName: 'Ashe of Outland', socials: [], auto: true }], ignored: [],
      labels: ['BRAVO', 'CHARLIE'], users: { '100000000000000001': { username: 'Ashe of Outland' }, '200000000000000001': { username: 'Guest One' } },
      skip: ['vdo:BRAVO', 'discord:200000000000000001'] });
    check('autoPopulate: a label or user in opts.skip is not appended again (a label Streamer.bot rewrites cannot loop)',
      !sk.directory.some((e) => /^bravo$/i.test(e.vdoLabel)) && !sk.directory.some((e) => e.discordUserId === '200000000000000001') && sk.directory.some((e) => e.vdoLabel === 'CHARLIE'), JSON.stringify(sk.directory));
    check('autoPopulate: …while skip leaves the fill of a Discord id on an existing entry alone',
      sk.directory.find((e) => e.displayName === 'Ashe of Outland').discordUserId === '100000000000000001');
    check('autoPopulate is a fixpoint: a second pass over the same room changes nothing',
      auto2.changed === false && JSON.stringify(auto2.directory) === JSON.stringify(auto1.directory));
    const auto3 = D.autoPopulate({ directory: autoBase, ignored: ['discord:200000000000000009', 'vdo:lurker'],
      labels: [' BRAVO ', 'LURKER', 'ALPHA'], users: AUTO_USERS });
    check('autoPopulate gives the same entries for a padded label and an ignored label given in another order (two director pages converge, no push ping-pong)',
      JSON.stringify(auto3.directory) === JSON.stringify(auto1.directory));
    check('autoPopulate: no live guests → no change',
      D.autoPopulate({ directory: autoBase, ignored: [], labels: [], users: {} }).changed === false);
    check('autoPopulate never throws on junk input',
      D.autoPopulate({}).changed === false && D.autoPopulate({ directory: null, labels: 'nope', users: 7 }).directory.length === 0);

    // GRN-60's interim guard: auto-add never copies a timestamp-shaped name into a payload
    // (the actions get their own fix in a later release).
    const DATEY = ['2026-11-07T10:30:00', '2026-11-07T10:30:00Z', '2026-11-07T10:30:00.000Z', '2026-11-07T10:30:00+00:00',
      '/Date(1799999999999)/', ' 2026-11-07T10:30:00 '];
    // (the last has surrounding spaces on purpose: labels reach auto-add trimmed or not)
    check('isDateShaped: flags the strings that break the parse, passes ordinary names',
      DATEY.every((s) => D.isDateShaped(s)) && !['ALPHA', 'Guest One', '2026', 'Date(1)', 'Dr. 9999', 'a/Date(1)/'].some((s) => D.isDateShaped(s)),
      JSON.stringify(DATEY.map((s) => D.isDateShaped(s))));
    const dateAuto = D.autoPopulate({ directory: [], ignored: [],
      labels: ['ALPHA', '2026-11-07T10:30:00', '/Date(1799999999999)/'],
      users: { '200000000000000007': { username: '/Date(1799999999999)/' }, '200000000000000008': { username: 'Fine Name' } } });
    check('autoPopulate skips date-shaped labels and never uses a date-shaped Discord name as a display name',
      dateAuto.directory.length === 3
      && dateAuto.directory.some((e) => e.vdoLabel === 'ALPHA')
      && !dateAuto.directory.some((e) => D.isDateShaped(e.vdoLabel) || D.isDateShaped(e.displayName))
      && dateAuto.directory.some((e) => e.discordUserId === '200000000000000007' && e.displayName === '200000000000000007'),
      JSON.stringify(dateAuto.directory));

    // ── Sprint 10: one guest identity rule (GRN-62, 147, 205, 206, 148, 13, 114, 35, 116, 55, 216, 173) ──
    {
      const C = D.canon, F = D.fold;
      check('canon/fold: double-escaped HTML decodes, "_" is a space, whitespace collapses; fold also folds case, canon does not',
        C('Tom &amp;amp; Jerry') === 'Tom & Jerry' && C('a &lt;b&gt;') === 'a <b>' && C('Guest_One') === 'Guest One' && C('  A   b ') === 'A b'
        && F('Guest_One') === 'guest one' && C('Alpha') !== C('alpha') && F('Alpha') === F('alpha'));
      check('canon: NFC twins match and invisible characters (ZWSP, ZWJ, soft hyphen) vanish from the key, while the stored label is untouched',
        C('Café') === C('Café') && C('Al​pha') === 'Alpha' && C('A‍lpha') === 'Alpha' && C('Al­pha') === 'Alpha'
        && D.findByLabel([{ vdoLabel: 'Al​pha', displayName: 'x' }], 'Alpha').vdoLabel === 'Al​pha');
      check('canon is idempotent and never throws (nested escapes, hidden characters that rebuild an entity, junk, very long text)',
        ['&amp;amp;amp;amp;x', '&a​mp;amp;', '__a__', null, undefined, 7, {}, '​', 'x'.repeat(5000)].every((x) => C(C(x)) === C(x))
        && ['\u0130', 'ss\u00DF', '\u01C5', '\u0391\u03A3', 'I\u0307', 'Tom &AMP;amp; Jerry', '&amp;amp;amp;amp;amp;amp;amp;amp;amp;amp;amp;amp;x', '\u0130\u0307', '&#x130;', '\u0130'.repeat(300)].every((x) => F(F(x)) === F(x)));
      check('labelKey follows the comparison key; the old-format key for "Guest One" still matches',
        D.labelKey('Guest_One') === D.labelKey('guest one') && D.labelKey('GUEST  ONE') === 'vdo:guest one' && D.labelKey(' Alpha ') === 'vdo:alpha');
      const dupDir = [{ vdoLabel: 'bob', displayName: 'Auto Bob', auto: true }, { vdoLabel: 'Bob', displayName: 'Curated Bob', auto: false }, { vdoLabel: 'BOB', displayName: 'Auto BOB', auto: true }];
      check('findByLabel: the exact-case entry wins, then a curated entry over an auto one, then array order',
        D.findByLabel(dupDir, 'bob').displayName === 'Auto Bob' && D.findByLabel(dupDir, 'Bob').displayName === 'Curated Bob' && D.findByLabel(dupDir, 'BOB').displayName === 'Auto BOB'
        && D.findByLabel(dupDir, 'bOb').displayName === 'Curated Bob' && D.findByLabel([dupDir[0], dupDir[2]], 'bOb').displayName === 'Auto Bob' && D.findByLabel(dupDir, '') === null && D.findByLabel(null, 'x') === null);
      check('findByLabel: underscores, escapes and spacing are the same label ("Guest_One" ~ "Guest One" ~ "Tom &amp;amp; Jerry" ~ "Tom & Jerry")',
        D.findByLabel([{ vdoLabel: 'Guest One' }], 'Guest_One') !== null && D.findByLabel([{ vdoLabel: 'Tom & Jerry' }], 'Tom &amp;amp; Jerry') !== null && D.findByLabel([{ vdoLabel: '<b>' }], '&lt;b&gt;') !== null);
      check('findByUserId: digits only, a curated entry beats an auto one for the same user',
        D.findByUserId([{ discordUserId: '1104', auto: true, displayName: 'a' }, { discordUserId: '1104', auto: false, displayName: 'c' }], '<@1104>').displayName === 'c' && D.findByUserId([{ discordUserId: '1104' }], '') === null);

      const BOB = { '300000000000000001': { username: 'Bob' } };
      const curated = [{ vdoLabel: 'bob', discordUserId: '', displayName: 'Bob Curated', socials: [], auto: false }];
      const nm = D.autoPopulate({ directory: curated, ignored: [], labels: [], users: BOB });
      check('GRN-13: a Discord user whose name matches a CURATED entry is not written into it and gets no twin; exactly one suggestion is reported',
        nm.directory.length === 1 && nm.directory[0].discordUserId === '' && nm.changed === false && nm.suggested.length === 1
        && nm.suggested[0].index === 0 && nm.suggested[0].id === '300000000000000001' && nm.suggested[0].username === 'Bob' && nm.linked.length === 0, JSON.stringify(nm));
      const nm2 = D.autoPopulate({ directory: nm.directory, ignored: [], labels: [], users: BOB });
      check('…and the pass is a fixpoint (a second pass changes nothing and reports the same suggestion)', nm2.changed === false && JSON.stringify(nm2.suggested) === JSON.stringify(nm.suggested) && JSON.stringify(nm2.directory) === JSON.stringify(nm.directory));
      const rej = D.autoPopulate({ directory: curated, ignored: ['discord:300000000000000001'], labels: [], users: BOB });
      check('…a rejected suggestion (the id in directoryIgnored) is not offered again', rej.suggested.length === 0 && rej.directory.length === 1 && rej.changed === false);
      const lk = D.autoPopulate({ directory: [{ vdoLabel: 'bob', discordUserId: '', displayName: 'bob', socials: [], auto: true }], ignored: [], labels: [], users: BOB });
      check('GRN-13: an AUTO entry with a matching name is still linked silently, and reported in `linked`',
        lk.directory.length === 1 && lk.directory[0].discordUserId === '300000000000000001' && lk.changed === true && lk.linked.length === 1 && lk.linked[0].index === 0 && lk.suggested.length === 0);
      const df1 = D.autoPopulate({ directory: [], ignored: [], labels: [], users: { '300000000000000002': { username: 'Guest One' } } });
      const df2 = D.autoPopulate({ directory: df1.directory, ignored: [], labels: ['Guest_One'], users: { '300000000000000002': { username: 'Guest One' } } });
      check('GRN-114: a guest who joined the voice channel first and then the VDO room is ONE entry (the auto entry takes the label; "_" is a space)',
        df1.directory.length === 1 && df2.directory.length === 1 && df2.directory[0].vdoLabel === 'Guest_One' && df2.directory[0].discordUserId === '300000000000000002' && df2.directory[0].auto === true, JSON.stringify(df2.directory));
      const df3 = D.autoPopulate({ directory: [{ vdoLabel: '', discordUserId: '300000000000000002', displayName: 'Guest One', socials: [], auto: false }], ignored: [], labels: ['Guest One'], users: { '300000000000000002': { username: 'Guest One' } } });
      check('GRN-114: …but a CURATED Discord-only entry is not given the label (it adds the label as its own auto entry)', df3.directory.length === 2 && df3.directory[0].vdoLabel === '' && df3.directory[1].vdoLabel === 'Guest One');
      const tw1 = D.autoPopulate({ directory: [], ignored: [], labels: ['ALPHA', 'alpha'], users: {} });
      const tw2 = D.autoPopulate({ directory: [], ignored: [], labels: ['alpha', 'ALPHA'], users: {} });
      check('GRN-147/116: labels that differ only in case are separate guests, and the result does not depend on the roster order',
        tw1.directory.length === 2 && JSON.stringify(tw1.directory) === JSON.stringify(tw2.directory), JSON.stringify(tw1.directory.map((e) => e.vdoLabel)));
      const tw3 = D.autoPopulate({ directory: [{ vdoLabel: 'ALPHA', displayName: 'A', auto: false }], ignored: [], labels: ['ALPHA', 'alpha'], users: {} });
      const tw4 = D.autoPopulate({ directory: [{ vdoLabel: 'alpha', displayName: 'A', auto: false }], ignored: [], labels: ['ALPHA'], users: {} });
      check('GRN-147: an exact entry is kept and only the case twin is added; a lone live label matches an entry ignoring case (no twin)',
        tw3.directory.length === 2 && tw3.directory[1].vdoLabel === 'alpha' && tw4.directory.length === 1 && tw4.changed === false);
      const twSkip = D.autoPopulate({ directory: [], ignored: [], labels: ['ALPHA', 'alpha'], users: {}, skip: ['vdo:ALPHA'] });
      check('GRN-147: the session skip key keeps case: an auto-added ALPHA does not stop the case twin alpha from being added', twSkip.directory.length === 1 && twSkip.directory[0].vdoLabel === 'alpha' && D.labelExactKey('ALPHA') === 'vdo:ALPHA');
      const esc = D.autoPopulate({ directory: [{ vdoLabel: 'Tom & Jerry', displayName: 'TJ', auto: false }], ignored: [], labels: ['Tom &amp;amp; Jerry'], users: {} });
      const esc2 = D.autoPopulate({ directory: [], ignored: [], labels: ['Tom &amp;amp; Jerry'], users: {} });
      check('GRN-205: a double-escaped label matches its entry; a new auto entry is named by the DECODED label while vdoLabel stays raw',
        esc.directory.length === 1 && esc2.directory[0].vdoLabel === 'Tom &amp;amp; Jerry' && esc2.directory[0].displayName === 'Tom & Jerry', JSON.stringify(esc2.directory));
      const inv = D.autoPopulate({ directory: [], ignored: [], labels: ['​', '⠀', 'ㅤ', '   ', 'ok'], users: {} });
      check('GRN-148: a label with nothing to draw (ZWSP, U+2800, U+3164, spaces) is never auto-added', inv.directory.length === 1 && inv.directory[0].vdoLabel === 'ok');
      const many = Array.from({ length: 60 }, (_, i) => 'L' + String(i).padStart(2, '0'));
      const cap1 = D.autoPopulate({ directory: [], ignored: [], labels: many, users: {} });
      const cap2 = D.autoPopulate({ directory: [], ignored: [], labels: many.slice().reverse(), users: {} });
      check('GRN-35: no more than AUTO_MAX (50) auto entries are appended, the same ones in any order, and the rest are counted as skipped',
        D.AUTO_MAX === 50 && cap1.directory.length === 50 && cap1.skipped === 10 && JSON.stringify(cap1.directory) === JSON.stringify(cap2.directory));
      const old50 = Array.from({ length: 50 }, (_, i) => ({ vdoLabel: 'OLD' + String(i).padStart(2, '0'), discordUserId: '', displayName: 'OLD' + i, socials: [], auto: true }));
      const ev1 = D.autoPopulate({ directory: old50, ignored: [], labels: ['NEW'], users: {} });
      const ev2 = D.autoPopulate({ directory: old50, ignored: [], labels: ['NEW'], users: {}, boundLabels: ['OLD00'] });
      const ev3 = D.autoPopulate({ directory: old50, ignored: [], labels: old50.map((e) => e.vdoLabel).concat(['NEW']), users: {} });
      const cur50 = old50.map((e) => Object.assign({}, e, { auto: false }));
      const ev4 = D.autoPopulate({ directory: cur50, ignored: [], labels: ['NEW'], users: {} });
      check('GRN-35: at the cap the first auto entry that is not live and not in a slot is evicted (index reported); bound and live ones survive; curated entries are never evicted and do not count',
        ev1.directory.length === 50 && ev1.evicted.join() === '0' && ev1.directory[49].vdoLabel === 'NEW' && ev2.evicted.join() === '1' && ev2.directory[0].vdoLabel === 'OLD00'
        && ev3.skipped === 1 && ev3.evicted.length === 0 && ev3.directory.length === 50 && ev4.directory.length === 51 && ev4.evicted.length === 0, JSON.stringify({ e1: ev1.evicted, e2: ev2.evicted, s3: ev3.skipped, n4: ev4.directory.length }));
      const idEntries = Array.from({ length: 50 }, (_, i) => ({ vdoLabel: '', discordUserId: '5000000000000' + String(10000 + i), displayName: 'U' + i, socials: [], auto: true }));
      const ev5 = D.autoPopulate({ directory: idEntries, ignored: [], labels: ['NEW'], users: {}, boundUsers: ['<@' + idEntries[0].discordUserId + '>'] });
      check('GRN-35: an auto entry for a Discord user who sits in a slot (boundUsers, ids with or without <@>) is not evicted; the next idle one is',
        ev5.evicted.join() === '1' && ev5.directory[0].displayName === 'U0', JSON.stringify(ev5.evicted));
      const emptyName = D.autoPopulate({ directory: [], ignored: [], labels: [], users: { '300000000000000003': { username: '' }, '300000000000000004': { username: '  ' }, '300000000000000005': { } } });
      const named = D.autoPopulate({ directory: emptyName.directory, ignored: [], labels: [], users: { '300000000000000003': { username: 'Zed' } } });
      check('GRN-35: a Discord user with no name yet is not added (not stored under the snowflake); the entry is added once the name arrives',
        emptyName.directory.length === 0 && emptyName.changed === false && named.directory.length === 1 && named.directory[0].displayName === 'Zed');
      const o1 = D.autoPopulate({ directory: [], ignored: [], labels: ['ZULU', 'BRAVO', 'CHARLIE'], users: { '300000000000000009': { username: 'N9' }, '300000000000000001': { username: 'N1' } } });
      const usersRev = {}; usersRev['300000000000000001'] = { username: 'N1' }; usersRev['300000000000000009'] = { username: 'N9' };
      const o2 = D.autoPopulate({ directory: [], ignored: [], labels: ['CHARLIE', 'ZULU', 'BRAVO'], users: usersRev });
      const o3 = D.autoPopulate({ directory: [], ignored: [], labels: ['Alpha', 'alpha'], users: {} });
      const o4 = D.autoPopulate({ directory: [], ignored: [], labels: ['alpha', 'Alpha'], users: {} });
      check('GRN-55/116: the output is the same for any order of the labels (ZULU/BRAVO/CHARLIE with no entry to anchor them) and of the 17-19 digit users; "Alpha"/"alpha" in either order',
        JSON.stringify(o1.directory) === JSON.stringify(o2.directory) && o1.directory.map((e) => e.vdoLabel || e.discordUserId).join() === 'BRAVO,CHARLIE,ZULU,300000000000000001,300000000000000009'
        && JSON.stringify(o3.directory) === JSON.stringify(o4.directory));
      // an entry that already carries a Discord id is never taken over by a second user of the same name (GRN-170: the !e.discordUserId guard)
      const samA = '300000000000000031', samB = '300000000000000032';
      const samDir = [{ vdoLabel: '', discordUserId: samA, displayName: 'Sam', socials: [{ platform: 'twitch', handle: 'samtv' }], auto: false }];
      const samRun = D.autoPopulate({ directory: JSON.parse(JSON.stringify(samDir)), ignored: [], labels: [], users: { [samA]: { username: 'Sam' }, [samB]: { username: 'Sam' } } });
      check('GRN-170: an entry "Sam" bound to Discord id A stays exactly as it was when a NEW user B called "Sam" joins; B gets an entry of its own (nothing is re-linked or overwritten)',
        samRun.directory.length === 2 && JSON.stringify(samRun.directory[0]) === JSON.stringify(samDir[0]) && samRun.directory[1].discordUserId === samB && samRun.directory[1].displayName === 'Sam' && samRun.linked.length === 0, JSON.stringify(samRun.directory));
      const lab = D.autoPopulate({ directory: df1.directory, ignored: [], labels: ['Guest_One'], users: { '300000000000000002': { username: 'Guest One' } } });
      check('GRN-114: the label a Discord-first auto entry takes is REPORTED (labeled: [{index, label}]) so a caller that applies only the reported changes (the dock) does it too',
        (lab.labeled || []).length === 1 && lab.labeled[0].index === 0 && lab.labeled[0].label === 'Guest_One' && lab.changed === true, JSON.stringify(lab.labeled));
      const same = D.autoPopulate({ directory: [], ignored: [], labels: ['Zed'], users: { '300000000000000006': { username: 'Zed' } } });
      check('a guest who is in the VDO room and the voice channel at once, in an empty book, is ONE entry carrying both keys (the link is made on the appended entry itself)',
        same.directory.length === 1 && same.directory[0].vdoLabel === 'Zed' && same.directory[0].discordUserId === '300000000000000006' && (same.appended || []).length === 1 && same.appended[0] === same.directory[0] && same.linked.length === 0, JSON.stringify(same));
      const many2 = D.autoPopulate({ directory: curated, ignored: [], labels: [], users: { '300000000000000001': { username: 'Bob' }, '300000000000000002': { username: 'bob' } } });
      check('two Discord users with the name of one curated entry are both reported as suggestions for it (the dock calls that ambiguous and offers neither)', many2.suggested.length === 2 && many2.suggested.every((x) => x.index === 0) && many2.directory[0].discordUserId === '');
      const oldA = Array.from({ length: 49 }, (_, i) => ({ vdoLabel: 'OLD' + String(i).padStart(2, '0'), discordUserId: '', displayName: 'OLD' + i, socials: [], auto: true }));
      const casper = D.autoPopulate({ directory: [{ vdoLabel: '', discordUserId: '', displayName: 'Casper', socials: [], auto: true }].concat(oldA), ignored: [], labels: ['NEW'], users: { '300000000000000007': { username: 'Casper' } } });
      check('GRN-35: an auto entry whose Discord namesake is in the room counts as live: the entry behind it is the one that stays and the next idle one is evicted, so the guest is not dropped and then re-created as a twin',
        casper.evicted.join() === '1' && casper.directory.filter((e) => e.displayName === 'Casper').length === 1 && casper.directory[0].displayName === 'Casper' && casper.directory[0].discordUserId === '300000000000000007', JSON.stringify({ ev: casper.evicted, first: casper.directory[0] }));
      check('GRN-148: a curated entry whose label is only invisible characters still matches the same raw label, and a different invisible one does not',
        D.findByLabel([{ vdoLabel: '\u3164', displayName: 'x' }], '\u3164') !== null && D.findByLabel([{ vdoLabel: '\u3164', displayName: 'x' }], '\u2800') === null && D.findByLabel([{ vdoLabel: '\u3164' }], '  ') === null);
      const ign2 = D.sanitizeIgnored(['vdo:Guest_One', 'vdo:guest one', 'vdo:Tom &amp;amp; Jerry', 'vdo:   ', 'discord:1']);
      check('GRN-216: ignore keys are built with the comparison key (sorted, deduped, idempotent), and an old-format key still blocks the live label',
        ign2.join('|') === 'discord:1|vdo:guest one|vdo:tom & jerry' && JSON.stringify(D.sanitizeIgnored(ign2)) === JSON.stringify(ign2)
        && D.autoPopulate({ directory: [], ignored: ['vdo:guest_one'], labels: ['Guest One'], users: {} }).directory.length === 0, JSON.stringify(ign2));
      const tabs = D.parseSocialsText('twitch\tbob\nbluesky @a.b\nnohandle\n  website   my site  ');
      check('GRN-173: the platform is split from the handle at the first whitespace of any kind (tab, NBSP), not only a space', tabs.length === 3 && tabs[0].handle === 'bob' && tabs[1].platform === 'bluesky' && tabs[2].handle === 'my site', JSON.stringify(tabs));
    }

    // The overlays can't load directory-core.js (other SB Path->Folder prefix), so
    // nameplate-shared.js keeps a copy of the sanitizers: the same superset form (GRN-75),
    // the same key order. Both copies carry the same lines, and behave the same.
    const npSrc = await readFile(resolve(__dirname, 'overlay', 'nameplate-shared.js'), 'utf8');
    const PUSH_LINE = 'out.push(Object.assign({ vdoLabel, discordUserId, displayName, socials: sanitizeSocials(e.socials), auto: !!e.auto }, extraFields(e, DIR_KEYS)));';
    const SOCIAL_LINE = 'out.push(Object.assign({ platform, handle }, extraFields(s, SOCIAL_KEYS)));';
    const EXTRA_LINES = ["const DIR_KEYS = new Set(['vdoLabel', 'discordUserId', 'displayName', 'socials', 'auto']);",
      "const SOCIAL_KEYS = new Set(['platform', 'handle']);",
      "for (const k of Object.keys(src || {})) if (!known.has(k) && k !== '__proto__') out[k] = src[k];"];
    check('TRIPWIRE: the two sanitizer copies agree (directory-core.js ↔ nameplate-shared.js): same superset lines',
      [PUSH_LINE, SOCIAL_LINE, ...EXTRA_LINES].every((l) => dirCoreSrc.includes(l) && npSrc.includes(l)));
    {
      const npWin = {};
      new Function('window', npSrc)(npWin);
      const NP = npWin.GRNameplate;
      const parityInputs = [
        JSON.parse('[{"vdoLabel":" A ","discordUserId":"<@1104>","displayName":"Alpha","pronouns":"they/them","socials":[{"platform":"Twitch","handle":"AlphaTV","url":"u"}],"auto":1,"__proto__":{"p":1}}]'),
        [{ vdoLabel: '', discordUserId: '', displayName: 'No keys' }, null, 7, { vdoLabel: 'B', displayName: '' }],
        'not an array', null, [],
      ];
      check('the overlay copy sanitises exactly as directory-core.js does (known keys first, unknown passed through, __proto__ dropped)',
        parityInputs.every((x) => JSON.stringify(NP.sanitizeDirectory(x)) === JSON.stringify(D.sanitizeDirectory(x)))
        && NP.sanitizeDirectory(parityInputs[0])[0].pronouns === 'they/them' && Object.getPrototypeOf(NP.sanitizeDirectory(parityInputs[0])[0]) === Object.prototype,
        JSON.stringify(NP.sanitizeDirectory(parityInputs[0])));
      // Sprint 10: the guest-identity block is the same text in both files, and both copies answer alike over the same vectors (GRN-62, 157, 205).
      const idBlock = (src) => { const m = /\/\/ <guest-identity>[\s\S]*?\/\/ <\/guest-identity>/.exec(src.replace(/\r\n/g, '\n')); return m && m[0]; };
      check('TRIPWIRE: the guest-identity block (canon, fold, findByLabel, findByUserId) is identical in directory-core.js and nameplate-shared.js',
        !!idBlock(dirCoreSrc) && idBlock(dirCoreSrc) === idBlock(npSrc), String((idBlock(dirCoreSrc) || '').length) + ' / ' + String((idBlock(npSrc) || '').length));
      const labelsV = ['Guest_One', 'Guest One', 'GUEST  ONE', 'Tom &amp;amp; Jerry', 'Tom & Jerry', 'Al\u200Bpha', 'Alpha', 'alpha', 'ALPHA', 'Cafe\u0301', 'Caf\u00E9', '', '  ', '<b>', '&lt;b&gt;', '\u2800', 'x'.repeat(500), '\u3164', '\u0130'.repeat(300), null, 7];
      const dirV = [{ vdoLabel: '\u3164', displayName: 'blank' },{ vdoLabel: 'Guest One', discordUserId: '111', displayName: 'a', auto: true }, { vdoLabel: 'guest one', discordUserId: '111', displayName: 'b', auto: false },
        { vdoLabel: 'Tom & Jerry', displayName: 'tj' }, { vdoLabel: 'alpha', displayName: 'lo', auto: true }, { vdoLabel: 'Alpha', displayName: 'Cap' }, { vdoLabel: 'Caf\u00E9', displayName: 'c' },
        { vdoLabel: '<b>', displayName: 'tag' }, null, 7, { displayName: 'no label' }];
      check('both lookup copies answer identically over curated-after-auto, case twins, double-escaped, underscore, invisible and NFC vectors',
        labelsV.every((l) => D.canon(l) === NP.canon(l) && D.fold(l) === NP.fold(l) && JSON.stringify(D.findByLabel(dirV, l)) === JSON.stringify(NP.findByLabel(dirV, l)))
        && NP.findByLabel(dirV, 'GUEST ONE').displayName === 'b' && NP.findByLabel(dirV, 'Tom &amp;amp; Jerry').displayName === 'tj' && NP.findByLabel(dirV, 'Guest_One').displayName === 'a' /* exact canon beats the curated inexact one */
        && NP.findByLabel(dirV, 'ㅤ').displayName === 'blank' && NP.findByLabel(dirV, '⠀') === null);
      check('findByUserId: both copies strip non-digits and prefer a curated entry; resolvePlateEntry strips the slot\'s id too (GRN-216)',
        ['111', '<@111>', ' 111 ', '', 'x', 111, null].every((id) => JSON.stringify(D.findByUserId(dirV, id)) === JSON.stringify(NP.findByUserId(dirV, id))) && NP.findByUserId(dirV, '<@111>').displayName === 'b'
        && NP.resolvePlateEntry({ slots: [{ slot: 1, mode: 'discord', discordUserId: '<@111>' }], directory: dirV.filter((e) => e && typeof e === 'object' && e.vdoLabel || false) }, 1) !== null);
      const xssInputs = [[{ vdoLabel: 'A', displayName: '<img src=x onerror=alert(1)>', socials: [{ platform: 'twitch', handle: '<b>x</b>' }, 7, { platform: '', handle: 'h' }, { platform: 'x' }] }],
        [{ discordUserId: '<@1104>', displayName: 'Padded' }, { discordUserId: '  1104  ', displayName: 'Padded2' }, { discordUserId: 1104, displayName: 'Num' }, { vdoLabel: '  ', discordUserId: '', displayName: 'keyless' }, { vdoLabel: 'k', displayName: '  ' }],
        { not: 'an array' }, 'junk', 7, true, [[], [null], [undefined]]];
      check('GRN-157: both copies sanitise the markup, padded-id, keyless, nameless, junk-social and non-array vectors alike',
        xssInputs.every((x) => JSON.stringify(NP.sanitizeDirectory(x)) === JSON.stringify(D.sanitizeDirectory(x))) && JSON.stringify(NP.sanitizeSocials(xssInputs[0][0].socials)) === JSON.stringify(D.sanitizeSocials(xssInputs[0][0].socials))
        && D.sanitizeDirectory(xssInputs[1]).map((e) => e.discordUserId).join() === '1104,1104,1104');
      check('GRN-152: icon() and accentTriplet() ignore inherited names (constructor, __proto__, toString)',
        NP.icon('constructor') === NP.ICONS.website && NP.icon('__proto__') === NP.ICONS.website && NP.icon('toString') === NP.ICONS.website && NP.accentTriplet('constructor') === null && NP.accentTriplet('toString') === null && NP.accentTriplet('__proto__') === null && NP.accentTriplet('cyan') === '34, 211, 238');
      check('GRN-173: platform aliases x, yt, ig, bsky and tt pick the right icon',
        NP.icon('x') === NP.ICONS.twitter && NP.icon('YT') === NP.ICONS.youtube && NP.icon('ig') === NP.ICONS.instagram && NP.icon('bsky') === NP.ICONS.bluesky && NP.icon('tt') === NP.ICONS.tiktok && NP.icon('nope') === NP.ICONS.website);
    }

    // ── Sprint 11: revisions, echoes and the newer state (GRN-64, 04, 149, 11, 169) ──
    {
      const revSrc = await readFile(resolve(__dirname, 'control', 'vdo-rev.js'), 'utf8');
      const hadRev = globalThis.GRRev;
      new Function(revSrc)();
      const RV = globalThis.GRRev;
      if (hadRev) globalThis.GRRev = hadRev; else delete globalThis.GRRev;
      const st = { enabled: true, room: 'r', slots: [{ slot: 1, label: 'A', streamID: 'a1' }, { slot: 2, label: '', streamID: '' }], directory: [], schemaVersion: 2 };
      const withIds = (o, id) => Object.assign({}, o, { slots: o.slots.map((s) => (s.label ? Object.assign({}, s, { streamID: id }) : s)) });
      check('GRRev.sigOf: the signature ignores rev, writer, schemaVersion and the key order, tells real differences apart, and is empty for a non-object',
        RV.sigOf(Object.assign({}, st, { rev: 5, writer: 'wA' })) === RV.sigOf(Object.assign({ writer: 'x', rev: 9 }, st, { schemaVersion: 7 }))
        && RV.sigOf({ b: 1, a: { d: 1, c: 2 } }) === RV.sigOf('{"a":{"c":2,"d":1},"b":1}')
        && RV.sigOf('junk') === '' && RV.sigOf(null) === '' && RV.sigOf([1]) === '' && RV.sigOf(st) !== RV.sigOf(Object.assign({}, st, { room: 'q' })));
      check('GRRev.revOf / writerOf: a positive whole number or 0 (a legacy write); a writer is a string or empty',
        RV.revOf({ rev: 12.7 }) === 12 && RV.revOf({ rev: '7' }) === 7 && RV.revOf({}) === 0 && RV.revOf({ rev: -3 }) === 0 && RV.revOf({ rev: 'x' }) === 0
        && RV.revOf('{"rev":4}') === 4 && RV.revOf(null) === 0 && RV.writerOf({ writer: 'wA' }) === 'wA' && RV.writerOf({ writer: 5 }) === '' && RV.writerOf('junk') === '');
      const sA = RV.sigOf(st);
      check('GRRev.diffKind: same, only the stream IDs differ, or anything else',
        RV.diffKind(sA, RV.sigOf(Object.assign({ rev: 3 }, st))) === 'same' && RV.diffKind(sA, RV.sigOf(withIds(st, 'a2'))) === 'ids'
        && RV.diffKind(sA, RV.sigOf(Object.assign({}, st, { room: 'q' }))) === 'other' && RV.diffKind(sA, RV.sigOf(Object.assign({}, st, { slots: [] }))) === 'other' && RV.diffKind(sA, '') === 'other');

      let clock = 1000;
      const mk = (w) => RV.create({ now: () => clock, writer: w });
      const A = mk('wA');
      const n1 = A.nextRev(), n2 = A.nextRev();
      A.sent(n1);
      const n3 = A.nextRev();
      clock = 5000;
      const n4 = A.nextRev();
      check('nextRev: the clock; the same until a push is really sent; then always above the last one sent, even in the same millisecond',
        n1 === 1000 && n2 === 1000 && n3 === 1001 && n4 === 5000 && A.lastSent === 1000 && A.highest === 0);
      const stamped = A.stamp(Object.assign({ rev: 1, writer: 'old', extra: [1, 2] }, st));
      const body = JSON.parse(stamped.text);
      check('stamp: the state plus schemaVersion 2, the rev and this page\'s writer (an old stamp on the state is replaced); the signature is unchanged',
        body.schemaVersion === 2 && body.rev === 5000 && stamped.rev === 5000 && body.writer === 'wA' && Object.keys(body).slice(-3).join() === 'schemaVersion,rev,writer'
        && RV.sigOf(stamped.text) === RV.sigOf(Object.assign({ extra: [1, 2] }, st)) && A.lastSent === 1000 && A.inflight.length === 1);
      A.sent(5000);
      const echoed = JSON.stringify(Object.assign({}, st, { slots: [{ slot: 1, label: 'A�', streamID: 'a1' }], rev: 5000, writer: 'wA' }));
      const e1 = A.receive(JSON.parse(echoed));
      check('GRN-149: an own echo is recognised by writer and rev, not by its text (a lone surrogate comes back as U+FFFD), and clears the push and every older one',
        e1.kind === 'echo' && A.inflight.length === 0 && A.highest === 5000);
      check('…and an old own echo coming back later (a replay of an earlier push) is an echo too: never adopted',
        A.receive({ rev: 1000, writer: 'wA', room: 'old' }).kind === 'echo' && A.receive({ rev: 5000, writer: 'wA', room: 'again' }).kind === 'echo');
      A.sent(5001); A.sent(5002);
      A.receive({ rev: 5002, writer: 'wA' });
      check('…an echo clears everything older than it and nothing newer', A.inflight.length === 0);
      A.sent(5003); A.sent(5004);
      A.receive({ rev: 5003, writer: 'wA' });
      check('…a newer push of this page stays in flight', A.inflight.length === 1 && A.inflight[0].rev === 5004 && A.pending(5004) && !A.pending(5003));
      A.refused(5004);
      check('refused(): a push Streamer.bot refused is no longer waiting for an echo', A.inflight.length === 0);

      const B = mk('wB');
      check('GRN-04: a higher rev from another writer is adopted and raises the highest; a lower one is dropped; the very payload held again is "same"',
        B.receive({ rev: 9000, writer: 'wX' }).kind === 'newer' && B.highest === 9000 && B.receive({ rev: 8999, writer: 'wY' }).kind === 'stale'
        && B.receive({ rev: 9000, writer: 'wX' }).kind === 'same' && B.highest === 9000);
      check('…equal revs are broken by the writer id (the larger wins), the same way on every page',
        B.receive({ rev: 9000, writer: 'wZ' }).kind === 'newer' && B.highestWriter === 'wZ' && B.receive({ rev: 9000, writer: 'wA' }).kind === 'stale' && B.receive({ rev: 9000, writer: 'wZ' }).kind === 'same');
      const lg = B.receive({ room: 'legacy', slots: [] });
      check('a payload with no rev is a legacy write: adopted, never dropped as rev 0, and it does not move the highest rev; the next stamp is still above everything seen',
        lg.kind === 'legacy' && B.highest === 9000 && B.nextRev() === 9001);
      // two pages that stamp the same millisecond: both end on the same winner
      clock = 20000;
      const P1 = mk('wP1'), P2 = mk('wP2');
      const r1 = P1.nextRev(), r2 = P2.nextRev();
      P1.sent(r1); P2.sent(r2);
      const k1 = [P1.receive({ rev: r1, writer: 'wP1' }).kind, P1.receive({ rev: r2, writer: 'wP2' }).kind];
      const k2 = [P2.receive({ rev: r2, writer: 'wP2' }).kind, P2.receive({ rev: r1, writer: 'wP1' }).kind];
      check('two pages that stamp the same millisecond end on the same winner (the larger writer id): the other page adopts it and the loser\'s copy is dropped',
        r1 === r2 && k1.join() === 'echo,newer' && k2.join() === 'echo,stale' && P1.highestWriter === 'wP2' && P2.highestWriter === 'wP2');
      // GRN-31: a delayed Sync broadcast of an old state arrives after a newer push
      clock = 30000;
      const D = mk('wD');
      D.receive({ rev: 29000, writer: 'wX' });
      const d1 = D.nextRev(); D.sent(d1);
      D.receive({ rev: d1, writer: 'wD' });
      check('GRN-31: a delayed replay of an older state, arriving after this page\'s newer push, is dropped', D.receive({ rev: 29000, writer: 'wX' }).kind === 'stale' && D.receive({ rev: 28000, writer: 'wQ' }).kind === 'stale');
      // a frame that is older than a push of this page still on its way (GRN-149): the page's own push is behind it in Streamer.bot's order
      clock = 40000;
      const F = mk('wF');
      F.receive({ rev: 30000, writer: 'wX' });
      F.sent(40000);
      check('a foreign frame with a rev below this page\'s push still in flight is dropped (the push runs after it), and so is a re-broadcast of the held state; a higher rev is adopted',
        F.receive({ rev: 35000, writer: 'wY' }).kind === 'stale' && F.receive({ rev: 30000, writer: 'wX' }).kind === 'stale' && F.receive({ rev: 40001, writer: 'wY' }).kind === 'newer' && F.oldestInflightRev() === 40000);
      const G = mk('wM'); G.sent(50000);
      check('…an equal rev from another writer: the larger writer id wins, so this page (wM) keeps its push against wA and gives way to wZ',
        G.receive({ rev: 50000, writer: 'wA' }).kind === 'stale' && G.receive({ rev: 50000, writer: 'wZ' }).kind === 'newer');
      const H = mk('wH'); H.sent(60000); H.sent(60005);
      H.clearThrough(60000);
      check('clearThrough(rev) forgets the pushes up to a rev (a replay that shows them) and keeps the newer ones; oldestInflightRev() is 0 with none',
        H.inflight.length === 1 && H.oldestInflightRev() === 60005 && (H.clearThrough(99999), H.oldestInflightRev() === 0));
      check('create() with no options works (a random writer id, the real clock) and two pages differ',
        /^w[0-9a-f]{16}$/.test(RV.create().writer) && RV.create().writer !== RV.create().writer && Math.abs(RV.create().nextRev() - Date.now()) < 1000);
    }

    // ── The vdo.ninja URL helper (GRN-88, 15, 61, 101, 102): two identical copies, one set of rules ──
    {
      const urlOverlay = (await readFile(resolve(__dirname, 'overlay', 'vdo-url.js'), 'utf8')).replace(/\r\n/g, '\n');
      const urlControl = (await readFile(resolve(__dirname, 'control', 'vdo-url.js'), 'utf8')).replace(/\r\n/g, '\n');
      check('TRIPWIRE: overlay/vdo-url.js and control/vdo-url.js are identical (line endings aside)', urlOverlay === urlControl);
      const hadUrl = globalThis.GRVdoUrl;
      new Function(urlOverlay)();
      const U = globalThis.GRVdoUrl;
      if (hadUrl) globalThis.GRVdoUrl = hadUrl; else delete globalThis.GRVdoUrl;
      const DEFAULT_FLAGS = '&solo&hidescreenshare&rounded=0&tallyoff&fadein&codec=h264&cleanish';
      const nf = ['solo&x', ' ?&solo ', '#&a', '', '&&a', undefined, '&a&b=c'].map((x) => U.normalizeFlags(x));
      check('normalizeFlags: one leading "&" (added to a bare list, kept once, ? & # and spaces stripped), empty stays empty',
        JSON.stringify(nf) === JSON.stringify(['&solo&x', '&solo', '&a', '', '&a', '', '&a&b=c']), JSON.stringify(nf));
      const san = (x) => U.sanitizeViewFlags(x);
      check('sanitizeViewFlags: the default flags pass unchanged, and sanitising twice changes nothing',
        san(DEFAULT_FLAGS).flags === DEFAULT_FLAGS && san(DEFAULT_FLAGS).dropped.length === 0
        && ['&solo&x=a%20b', '&codec=h264&q=a b&z=%E2%82%AC', '&x=a%2520b'].every((x) => san(san(x).flags).flags === san(x).flags), JSON.stringify(san(DEFAULT_FLAGS)));
      // written out here, NOT read from the helper: a list that is trimmed in the helper must fail this check
      const aliases = ['js', 'base64js', 'b64js', 'jsbase64', 'jsb64', 'css', 'base64css', 'b64css', 'cssbase64', 'cssb64', 'invite', 'i', 'code',
        'view', 'v', 'room', 'r', 'password', 'pw', 'p', 'hash', 'push', 'director', 'dir', 'id', 'permaid',
        'streamid', 'pull', 'roomid', 'pass', 'crc', 'check', 'preset', 'whepplay', 'whep', 'website', 'iframe', 'postapi', 'posturl', 'api', 'osc'];
      const allDropped = aliases.every((k) => san('&solo&' + k + '=x').flags === '&solo' && san('&' + k.toUpperCase() + '&solo').flags === '&solo' && san('&solo&' + k + '=x').dropped.includes(k));
      check('sanitizeViewFlags: every script, style, invite and room-identity alias is dropped (any case, with or without a value), the rest kept', allDropped && aliases.length >= 40, String(aliases.length));
      check('sanitizeViewFlags: "?" and "#" cannot smuggle a flag in, and a missing leading "&" is fine',
        san('&solo#&js=x').flags === '&solo' && san('&solo#&js=x').dropped.includes('#…') && san('&solo?js=x&cleanish').flags === '&solo&cleanish' && san('solo&cleanish').flags === '&solo&cleanish'
        && san('&a b=c&d=e').flags === '&d=e' && san('&x=a b').flags === '&x=a%20b' && san('').flags === '' && san(null).flags === '');
      check('ensureSolo: added unless solo or scene is already there (exact case, as vdo.ninja reads it)',
        U.ensureSolo('') === '&solo' && U.ensureSolo('&cleanish') === '&cleanish&solo' && U.ensureSolo('&scene=1') === '&scene=1' && U.ensureSolo('&solo&x') === '&solo&x'
        && U.ensureSolo('&Solo&x') === '&Solo&x&solo' && U.ensureSolo('&SCENE') === '&SCENE&solo'); // vdo.ninja's own checks are case-sensitive
      const eff = ['', ' ', '0', 'false', 'FALSE', 'off', ' Off '].map((x) => U.effectivePassword(x));
      check('effectivePassword: "", 0, false and off (trimmed, any case) mean no password; anything else is itself, trimmed',
        eff.every((x) => x === '') && U.effectivePassword(' pw ') === 'pw' && U.effectivePassword('0x') === '0x' && U.effectivePassword(undefined) === '');
      check('passwordQuery: the password is encoded exactly twice (abc%41, 50%25off, p&w #1), and nothing is sent for no password',
        U.passwordQuery('abc%41') === '&password=abc%252541' && U.passwordQuery('50%25off') === '&password=50%252525off' && U.passwordQuery('p&w #1') === '&password=p%2526w%2520%25231' && U.passwordQuery('off') === '' && U.passwordQuery('') === '');
      check('a lone UTF-16 surrogate cannot make the helper throw: the flag is dropped, the password encodes as U+FFFD',
        (() => { try { return san('&x=\uD800&solo').flags === '&solo' && san('&x=\uD800').dropped.includes('x') && U.passwordQuery('a\uD800b') === '&password=a%25EF%25BF%25BDb'; } catch (e) { return false; } })());
      check('isInjectionKey: the script, style and remote-content families (any case), not the cosmetic or identity ones',
        ['js', 'CSS', 'invite', 'code', 'i', 'whep', 'iframe', 'postapi'].every((k) => U.isInjectionKey(k)) && !['room', 'solo', 'cleanish', 'password'].some((k) => U.isInjectionKey(k)));
      const defaultOf = async (f) => { const m = /const DEFAULT_VIEWFLAGS = '([^']*)'/.exec(await readFile(resolve(__dirname, f), 'utf8')); return m && m[1]; };
      const defaults = [await defaultOf('control/control.html'), await defaultOf('control/director-min.html'), await defaultOf('backup.mjs')];
      check('TRIPWIRE: the default view flags are the same string in control.html, director-min.html and backup.mjs', defaults.every(Boolean) && defaults[0] === defaults[1] && defaults[1] === defaults[2] && defaults[0] === DEFAULT_FLAGS, JSON.stringify(defaults));
      const vu = new URL(U.buildViewUrl({ room: 'r m', password: 'p&w #1', viewFlags: '' }, 'aaa111'));
      check('buildViewUrl: with password "p&w #1" the password parameter is encodeURIComponent of it (vdo.ninja\'s second decode restores it), no hash, solo present, room and view intact',
        vu.searchParams.get('password') === encodeURIComponent('p&w #1') && vu.hash === '' && vu.searchParams.has('solo') && vu.searchParams.get('room') === 'r m' && vu.searchParams.get('view') === 'aaa111', vu.href);
      const vj = new URL(U.buildViewUrl({ room: 'r', password: '', viewFlags: 'cleanish&js=//evil&b64js=xx&password=hijack&room=other' }, 'aaa111'));
      check('buildViewUrl: flags without a leading "&" work, script and room-identity flags in them are dropped, solo is added',
        vj.searchParams.has('cleanish') && !vj.searchParams.has('js') && !vj.searchParams.has('b64js') && vj.searchParams.getAll('room').join() === 'r' && vj.searchParams.getAll('view').join() === 'aaa111' && vj.searchParams.getAll('password').length === 0 && vj.searchParams.has('solo'), vj.href);
      const rn = (x) => U.vdoRoomName(x);
      check('vdoRoomName: the name vdo.ninja will use (non-word runs → _, 30 characters): "my room" is my_room with no warning; "a-b" differs; CJK is only underscores; 40 characters are cut',
        rn('my room').effective === 'my_room' && rn('my room').warnings.length === 0 && rn(' a-b ').effective === 'a_b' && rn('a-b').warnings.some((w) => /differs/.test(w))
        && rn('部屋').onlyUnderscores && rn('部屋').warnings.some((w) => /only underscores/.test(w)) && rn('x'.repeat(40)).effective.length === 30 && rn('x'.repeat(40)).warnings.some((w) => /30/.test(w)) && rn('').warnings.length === 0 && !rn('').onlyUnderscores);
      const du = U.buildDirectorUrl('https://vdo.ninja/', 'rm', 'abc%41');
      check('buildDirectorUrl: director, room, the password twice encoded, silent flags; a base with a query gets "&"',
        du === 'https://vdo.ninja/?director=rm&password=abc%252541&cleanish&novideo&noaudio' && U.buildDirectorUrl('http://x/d.html?fixed=1', 'rm', '').startsWith('http://x/d.html?fixed=1&director=rm&cleanish'), du);
    }

    // GRN-27 / GRN-162 / GRN-215: the connection helpers are one block, copied identically into the
    // overlay shim and both control pages (different Streamer.bot folder maps cannot share a file).
    const blockOf = (src) => { const m = /\/\/ <sb-conn>[\s\S]*?\/\/ <\/sb-conn>/.exec(src.replace(/\r\n/g, '\n')); return m ? m[0] : null; };
    const shimSrc = await readFile(resolve(__dirname, 'overlay', 'panel-client-sb.js'), 'utf8');
    const ctrlSrc = await readFile(resolve(__dirname, 'control', 'control.html'), 'utf8');
    const minSrc = await readFile(resolve(__dirname, 'control', 'director-min.html'), 'utf8');
    const blocks = [shimSrc, ctrlSrc, minSrc].map(blockOf);
    check('TRIPWIRE: the sb-conn helper block is present and identical in panel-client-sb.js, control.html and director-min.html',
      blocks.every(Boolean) && blocks[0] === blocks[1] && blocks[1] === blocks[2], blocks.map((b) => b && b.length).join(' / '));
    {
      // (the block's own closing marker is a comment, so the return goes on a new line)
      const H = new Function(`${blocks[0]}\nreturn { sbWsUrl, sbPortParam, sbBackoff };`)();
      const urls = ['', '?sbport=9000', '?sbport=08081', '?sbport=65535', '?sbport=1'].map((q) => H.sbWsUrl(q));
      check('sbWsUrl: no ?sbport → ws://127.0.0.1:8080/, a valid port replaces only the port',
        urls.join(' ') === 'ws://127.0.0.1:8080/ ws://127.0.0.1:9000/ ws://127.0.0.1:8081/ ws://127.0.0.1:65535/ ws://127.0.0.1:1/', urls.join(' '));
      const bad = ['?sbport=1%40example.invalid', '?sbport=0', '?sbport=65536', '?sbport=abc', '?sbport=8080.5', '?sbport=', '?sbport=-1', '?sbport=1e3', '?sbport=%208080', '?sbport=999999',
        '?sbport=8080%2F%2Fexample.invalid', '?sbport=8080&sbport=x'];
      check('sbWsUrl: any other ?sbport is refused (null), never a different host, never 8080',
        bad.every((q) => H.sbWsUrl(q) === null || H.sbWsUrl(q) === H.sbWsUrl('?sbport=8080')) && bad.slice(0, 11).every((q) => H.sbWsUrl(q) === null),
        bad.map((q) => H.sbWsUrl(q)).join(' '));
      check('sbWsUrl: the host is 127.0.0.1 with no credentials for every accepted value',
        ['?sbport=1', '?sbport=8080', '?sbport=65535'].every((q) => { const u = new URL(H.sbWsUrl(q)); return u.hostname === '127.0.0.1' && !u.username && !u.password && u.protocol === 'ws:'; }));
      check('sbPortParam: the validated port, or empty when absent or invalid (so a bad value is never copied into an OBS URL)',
        H.sbPortParam('?sbport=9000') === '9000' && H.sbPortParam('') === '' && H.sbPortParam('?sbport=1%40example.invalid') === '' && H.sbPortParam('?sbport=70000') === '');
      const bo = H.sbBackoff();
      const seq = [bo.next(), bo.next(), bo.next(), bo.next(), bo.next(), bo.next()];
      check('sbBackoff: 1 s, then ×1.5, capped at 4 s (not 15 s)', JSON.stringify(seq) === JSON.stringify([1000, 1500, 2250, 3375, 4000, 4000]), JSON.stringify(seq));
      bo.reset();
      check('sbBackoff: reset() returns to 1 s', bo.next() === 1000);
    }

    // ── 6. HTTP + tripwires: served files carry their load-bearing strings ──────
    console.log('\n[6] HTTP + tripwires: SB-style serving, wired strings, no token in control');
    const shimRes = await fetch(`${BASE}/overlay/panel-client-sb.js`);
    const shimBody = await shimRes.text();
    check('/overlay/panel-client-sb.js 200 javascript', shimRes.status === 200 && (shimRes.headers.get('content-type') || '').includes('javascript'));
    check('served shim subscribes with LOWERCASE general', shimBody.includes("general: ['Custom']"), 'the SB Subscribe case gotcha');
    check("served shim defaults sync action to 'VDO Sync'", shimBody.includes("'VDO Sync'"));

    const idxRes = await fetch(`${BASE}/`);
    check('landing page 200', idxRes.status === 200 && /Greenroom/.test(await idxRes.text()));

    const parserRes = await fetch(`${BASE}/control/vdo-parse.js`);
    check('/control/vdo-parse.js 200 + exports VdoParse', parserRes.status === 200 && (await parserRes.text()).includes('globalThis.VdoParse'));
    const dirCoreRes = await fetch(`${BASE}/control/directory-core.js`);
    check('/control/directory-core.js 200 javascript + exports GRDir',
      dirCoreRes.status === 200 && (dirCoreRes.headers.get('content-type') || '').includes('javascript')
      && (await dirCoreRes.text()).includes('globalThis.GRDir'));

    const guestRes = await fetch(`${BASE}/overlay/vdoninja-guest.html`);
    const guestBody = await guestRes.text();
    check('/overlay/vdoninja-guest.html 200 + wired (vdoninja:update, shim)', guestRes.status === 200 && guestBody.includes('vdoninja:update') && guestBody.includes('panel-client-sb.js'));
    check('guest overlay wired for nameplates (nameplate-shared.js)', guestBody.includes('nameplate-shared.js'));
    const rosterRes = await fetch(`${BASE}/overlay/discord-roster.html`);
    const rosterBody = await rosterRes.text();
    check('/overlay/discord-roster.html 200 + wired (discord:voice:update, CSS vars)', rosterRes.status === 200 && rosterBody.includes('discord:voice:update') && rosterBody.includes('--accent'));
    check('roster overlay consumes the directory (vdoninja:update)', rosterBody.includes('vdoninja:update'));
    const npRes = await fetch(`${BASE}/overlay/nameplate.html`);
    const npBody = await npRes.text();
    check('/overlay/nameplate.html 200 + wired (vdoninja:update, both scripts)',
      npRes.status === 200 && npBody.includes('vdoninja:update') && npBody.includes('panel-client-sb.js') && npBody.includes('nameplate-shared.js'));
    const npjsRes = await fetch(`${BASE}/overlay/nameplate-shared.js`);
    const npjsBody = await npjsRes.text();
    check('/overlay/nameplate-shared.js 200 javascript + exports GRNameplate',
      npjsRes.status === 200 && (npjsRes.headers.get('content-type') || '').includes('javascript') && npjsBody.includes('GRNameplate'));
    const ctrlRes = await fetch(`${BASE}/control/control.html`);
    const ctrlBody = await ctrlRes.text();
    check('/control/control.html 200 + wired (VDO Push, Discord Voice Command, VDO Sync)',
      ctrlRes.status === 200 && ctrlBody.includes("'VDO Push'") && ctrlBody.includes("'Discord Voice Command'") && ctrlBody.includes("'VDO Sync'"));
    check('TRIPWIRE: control.html contains no botToken string (the page never handles the token)', !/botToken/.test(ctrlBody));
    check('control.html: directory UI wired (directory-core.js, search, live-only, auto-add)',
      ctrlBody.includes('directory-core.js') && ctrlBody.includes('dirSearch')
      && ctrlBody.includes('dirLiveOnly') && ctrlBody.includes('dirAutoAdd') && ctrlBody.includes('GRDir.autoPopulate'));
    const minRes = await fetch(`${BASE}/control/director-min.html`);
    const minBody = await minRes.text();
    check('/control/director-min.html 200 + wired (VDO Push, vdo-parse.js)', minRes.status === 200 && minBody.includes("'VDO Push'") && minBody.includes('vdo-parse.js'));
    const dlRes = await fetch(`${BASE}/control/director-loop.js`);
    check('/control/director-loop.js 200 javascript + exports GRDirector', dlRes.status === 200 && (dlRes.headers.get('content-type') || '').includes('javascript') && (await dlRes.text()).includes('globalThis.GRDirector'));
    check('both control pages load director-loop.js and run the director through it, with no poll loop of their own (GRN-66)',
      [ctrlBody, minBody].every((b) => b.includes('director-loop.js') && b.includes('GRDirector.create') && b.includes('directorLoop.onMessage') && !/setInterval\(pollGuestList/.test(b) && !/function pollGuestList/.test(b)));
    const revRes = await fetch(`${BASE}/control/vdo-rev.js`);
    check('/control/vdo-rev.js 200 javascript + exports GRRev', revRes.status === 200 && (revRes.headers.get('content-type') || '').includes('javascript') && (await revRes.text()).includes('globalThis.GRRev'));
    check('both control pages load vdo-rev.js and stamp every push and judge every vdo.state through it (GRN-64, 04, 149)',
      [ctrlBody, minBody].every((b) => b.includes('vdo-rev.js') && b.includes('GRRev.create') && b.includes('.stamp(') && b.includes('.receive(') && b.includes('GRRev.SCHEMA_VERSION')));
    // (The director-min strip guard is a behaviour test now: verify-render R9, GRN-202.)
    check('director-min auto-populates too (shared core + the Discord-feed source)',
      minBody.includes('directory-core.js') && minBody.includes('GRDir.autoPopulate')
      && minBody.includes("d.type === 'discord:voice:update'"));
    const mockDirRes = await fetch(`${BASE}/mock/vdo-director.html`);
    check('/mock/vdo-director.html 200 + speaks getGuestList', mockDirRes.status === 200 && (await mockDirRes.text()).includes('getGuestList'));
    const nsCtrl = await fetch(`${BASE}/greenroom-control/control.html`);
    await nsCtrl.arrayBuffer();
    const nsOv = await fetch(`${BASE}/greenroom-overlay/vdoninja-guest.html`);
    await nsOv.arrayBuffer();
    check('namespaced aliases serve too (/greenroom-control/, /greenroom-overlay/ — the real-SB map names)',
      nsCtrl.status === 200 && nsOv.status === 200);

    // C# ↔ mock parity greps: the .cs files must carry the exact contract strings the mock (and the
    // producers) rely on. A drift here is a live-only bug. Each file is checked with its comments removed,
    // so a comment that quotes a string cannot satisfy a check.
    const cs = async (f) => stripCsComments(await readFile(resolve(__dirname, 'actions', f), 'utf8'));
    const before = (src, first, second) => src.includes(first) && src.includes(second) && src.indexOf(first) < src.indexOf(second);
    check('stripCsComments: removes // and /* */ comments but keeps a comment marker inside a string literal',
      (() => { const t = stripCsComments('a // x\nb /* y */ c "//z" \'/\' d'); return !/[xy]/.test(t.replace(/"\/\/z"/, '')) && t.includes('"//z"') && t.includes('b') && t.includes('c') && t.includes('d'); })());
    const vdoPush = await cs('vdo-push.cs');
    check('vdo-push.cs: persisted SetGlobalVar("vdo.state", payload, true)', vdoPush.includes('SetGlobalVar("vdo.state", payload, true)'));
    check('vdo-push.cs: the state goes out as an escaped string field {"type":"vdoninja:update","vdoninjaJson":JsonStr(payload)}, never raw-concatenated as an object',
      vdoPush.includes('\\"vdoninjaJson\\":" + JsonStr(payload)') && !vdoPush.includes('\\"vdoninja\\":"'));
    check('vdo-push.cs: WebsocketBroadcastJson comes BEFORE SetGlobalVar (a failed broadcast never persists a state)',
      before(vdoPush, 'WebsocketBroadcastJson("{\\"type\\":\\"vdoninja:update\\"', 'SetGlobalVar("vdo.state"'));
    check('vdo-push.cs: the payload is validated (ObjectError) before anything is broadcast or cached; a refusal says NOT cached',
      before(vdoPush, 'string why = ObjectError(payload);', 'WebsocketBroadcastJson(') && vdoPush.includes('payload rejected, NOT cached: '));
    const dPush = await cs('discord-voice-push.cs');
    check('discord-voice-push.cs: NON-persisted SetGlobalVar("discord.state", payload, false)', dPush.includes('SetGlobalVar("discord.state", payload, false)'));
    check('discord-voice-push.cs: the state goes out as an escaped string field {"type":"discord:voice:update","discordVoiceJson":JsonStr(payload)}',
      dPush.includes('\\"discordVoiceJson\\":" + JsonStr(payload)') && !dPush.includes('\\"discordVoice\\":"'));
    check('discord-voice-push.cs: WebsocketBroadcastJson comes BEFORE SetGlobalVar',
      before(dPush, 'WebsocketBroadcastJson("{\\"type\\":\\"discord:voice:update\\"', 'SetGlobalVar("discord.state"'));
    const sync = await cs('vdo-sync.cs');
    check('vdo-sync.cs: reads mirror the writers\' persistence flags',
      sync.includes('GetGlobalVar<string>("vdo.state", true)') && sync.includes('GetGlobalVar<string>("discord.state", false)'));
    check('vdo-sync.cs: both replays are string fields (vdoninjaJson, discordVoiceJson), and an empty vdo.state broadcasts vdo:sync:empty',
      sync.includes('\\"vdoninjaJson\\":" + JsonStr(vdo)') && sync.includes('\\"discordVoiceJson\\":" + JsonStr(discord)')
      && sync.includes('{\\"type\\":\\"vdo:sync:empty\\"}') && !sync.includes('\\"vdoninja\\":"') && !sync.includes('\\"discordVoice\\":"'));
    {
      // Structure, not a count of the word 'try' (the Send helper has one too): the vdo read sits in a try, a catch that reports it
      // closes that try before the Discord read starts, and the Discord read sits in its own try.
      const iV = sync.indexOf('GetGlobalVar<string>("vdo.state", true)'), iD = sync.indexOf('GetGlobalVar<string>("discord.state", false)');
      const between = iV >= 0 && iD > iV ? sync.slice(iV, iD) : '';
      check('vdo-sync.cs: the two replays are separate try blocks (the vdo try is closed by its own catch before the Discord one opens)',
        iV > 0 && /\btry\b[^{]*\{[^{}]*$/.test(sync.slice(0, iV).replace(/\{[^{}]*\}/g, '')) === true
        && /catch \(Exception ex\)\s*\{[^}]*Report\("vdo:error", ex\)/.test(between) && /\btry\b/.test(between.slice(between.indexOf('Report("vdo:error", ex)')))
        && sync.slice(iD).includes('Report("discord:voice:error", ex)'));
    }
    check('discord-voice-push.cs: the payload is validated (ObjectError) before anything is broadcast or cached; a refusal says NOT cached',
      before(dPush, 'string why = ObjectError(payload);', 'WebsocketBroadcastJson(') && dPush.includes('payload rejected, NOT cached: '));
    check('vdo-sync.cs: each cached blob is validated before it is replayed; an invalid one is reported and kept, never unset',
      sync.includes('ObjectError(vdo)') && sync.includes('ObjectError(discord)') && sync.includes('cached state is not valid JSON - Import a backup or re-save') && !/Unset(Global)?Var/.test(sync));
    {
      // One validator, three copies (each action is pasted on its own): they must be the same text.
      const VAL_BEGIN = '// ── Strict JSON check (RFC 8259), mscorlib only', VAL_END = '// ── end of the strict JSON check';
      const valOf = async (f) => { const t = (await readFile(resolve(__dirname, 'actions', f), 'utf8')).replace(/\r\n/g, '\n'); const a = t.indexOf(VAL_BEGIN), b = t.indexOf(VAL_END); return a >= 0 && b > a ? t.slice(a, b) : null; };
      const vals = [await valOf('vdo-push.cs'), await valOf('discord-voice-push.cs'), await valOf('vdo-sync.cs')];
      check('TRIPWIRE: the strict JSON validator is present and identical in vdo-push.cs, discord-voice-push.cs and vdo-sync.cs', vals.every(Boolean) && vals[0] === vals[1] && vals[1] === vals[2], vals.map((v) => v && v.length).join(' / '));
    }
    const cmd = await cs('discord-voice-command.cs');
    check('discord-voice-command.cs: broadcasts discord:voice:command', cmd.includes('discord:voice:command'));
    const launcher = await cs('discord-bridge-start.cs');
    check('discord-bridge-start.cs: UseShellExecute = true (socket-inheritance guard)', launcher.includes('UseShellExecute = true'));
    // ── 6b. the two launching actions, compiled and run (Sprint 18: GRN-21, 132, 10, 16, 142, 202) ──
    console.log('\n[6b] Discord Bridge Start and Discord Voice Command: pre-flight, the node search, the launch report, the sanitised log line (C# 5 with the .NET Framework csc and a stubbed CPH)');
    {
      const launcherRaw = (await readFile(resolve(__dirname, 'actions', 'discord-bridge-start.cs'), 'utf8')).replace(/\r\n/g, '\n');
      check('discord-bridge-start.cs: BUNDLE is the placeholder C:\\path\\to\\greenroom-guests\\sidecar (no one\'s own path), UseShellExecute stays true and is never false, and the launch waits 2 s for an early exit',
        /const string BUNDLE = @"C:\\path\\to\\greenroom-guests\\sidecar";/.test(launcher) && !/StreamerGraphics/.test(launcherRaw) && launcher.includes('UseShellExecute = true') && !/UseShellExecute\s*=\s*false/.test(launcher) && launcher.includes('WaitForExit(2000)'));
      check('discord-bridge-start.cs: the pre-flight (BUNDLE exists, discord-bridge.mjs in it, node_modules in it) comes before Process.Start, and node is looked up in the registry key, Program Files and the Machine and User PATH',
        before(launcher, 'Directory.Exists(BUNDLE)', 'Launch(') && before(launcher, 'File.Exists(Path.Combine(BUNDLE, "discord-bridge.mjs"))', 'Launch(') && before(launcher, 'Directory.Exists(Path.Combine(BUNDLE, "node_modules"))', 'Launch(')
        && launcher.includes('SOFTWARE\\Node.js') && launcher.includes('InstallPath') && launcher.includes('"ProgramFiles"') && launcher.includes('EnvironmentVariableTarget.Machine') && launcher.includes('EnvironmentVariableTarget.User'));
      check('discord-bridge-start.cs: the header says "any" Streamer.bot exit (not only an unclean one) and warns against Run a Program with environment variables or Wait for Exit (GRN-142)',
        /outlives Streamer\.bot \(after a normal close as well as a crash or a kill\)/.test(launcherRaw) && /Run a Program/.test(launcherRaw) && /waits for the program to exit/.test(launcherRaw));
      const cmdSrc = await cs('discord-voice-command.cs');
      check('discord-voice-command.cs: the log line is sanitised and capped (Safe), and the command itself is not concatenated into a log call as it came (GRN-16)',
        cmdSrc.includes('Safe(command, 40)') && !/Log(Info|Warn)\([^;]*\+\s*command\s*\)/.test(cmdSrc) && !/Log(Info|Warn)\([^;]*\+\s*ex\s*\)/.test(cmdSrc));

      const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
      if (!existsSync(CSC)) {
        console.log('  (the compile-and-run checks of [6b] are skipped: no .NET Framework csc.exe on this machine)');
      } else {
        const cdir = await mkdtemp(resolve(tmpdir(), 'greenroom-cs18-'));
        scratchDirs.push(cdir);
        const STUB = [
          'using System;',
          'public class StubCPH {',
          '  public bool TryGetArg<T>(string name, out T value) { string s = Environment.GetEnvironmentVariable("ARG_" + name); if (s == null) { value = default(T); return false; } value = (T)(object)s; return true; }',
          '  public void LogInfo(string s) { Console.WriteLine("INFO " + s); }',
          '  public void LogWarn(string s) { Console.WriteLine("WARN " + s); }',
          '  public void WebsocketBroadcastJson(string j) { Console.WriteLine("BROADCAST " + j); }',
          '}',
          'public class CPHInlineBase { public StubCPH CPH = new StubCPH(); }',
          'public static class HarnessMain { public static int Main(string[] a) { var i = new CPHInline(); bool ok = i.Execute(); Console.WriteLine("RESULT " + ok); return 0; } }',
        ].join('\n');
        await writeFile(resolve(cdir, 'stub.cs'), STUB);
        const runExe = (exe, args, env) => new Promise((res) => {
          const child = spawn(exe, args, { cwd: cdir, stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env });
          let out = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => (out += d)); child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => (out += d));
          const timer = setTimeout(() => { try { child.kill(); } catch {} }, 20000);
          child.on('exit', (code) => { clearTimeout(timer); res({ code, out }); });
          child.on('error', (e) => { clearTimeout(timer); res({ code: -1, out: String(e && e.message) }); });
        });
        const MSCORLIB = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\mscorlib.dll';
        const SYSTEM_DLL = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.dll';
        // Only what Streamer.bot gives an action: mscorlib, and System.dll where the action needs it (the docs' References step). No default references.
        const build = async (name, src, o) => {
          const body = '\uFEFF' + src.replace(/\r\n/g, '\n').replace('public class CPHInline', 'public class CPHInline : CPHInlineBase');
          await writeFile(resolve(cdir, name + '.cs'), body);
          const refs = ['/noconfig', '/nostdlib+', '/r:' + MSCORLIB].concat(o && o.system ? ['/r:' + SYSTEM_DLL] : []);
          const r = await runExe(CSC, ['/nologo'].concat(refs, ['/target:exe', '/out:' + resolve(cdir, name + '.exe'), resolve(cdir, name + '.cs'), resolve(cdir, 'stub.cs')]));
          return { ok: r.code === 0, out: r.out, exe: resolve(cdir, name + '.exe') };
        };
        const lines = (o) => o.split(/\r?\n/).filter(Boolean);

        // Discord Voice Command
        const vc = await build('voicecmd', await readFile(resolve(__dirname, 'actions', 'discord-voice-command.cs'), 'utf8'));
        check('[6b] discord-voice-command.cs compiles (C# 5, mscorlib only, stubbed CPH)', vc.ok, vc.out.slice(0, 400));
        if (vc.ok) {
          const evil = 'leave\r\nINFO forged line \u0007\u0085\u2028\u2029\u009b\u202e ' + 'x'.repeat(200);
          const r = await runExe(vc.exe, [], { ...process.env, ARG_command: evil, ARG_value: 'v' });
          const L = lines(r.out);
          const info = L.filter((l) => l.startsWith('INFO '));
          const bc = L.find((l) => l.startsWith('BROADCAST ')) || '';
          check('[6b] GRN-16: a command with a line break and a bell in it is logged as ONE line, control characters as spaces, cut at 40 characters; the broadcast still carries it whole',
            info.length === 1 && /^INFO \[Discord Voice Command\] leave +INFO forged line/.test(info[0]) && !/[\u0085\u2028\u2029\u009b\u202e\u0007]/.test(info[0]) && info[0].length <= 'INFO [Discord Voice Command] '.length + 43 && info[0].endsWith('...') && !L.some((l) => l.startsWith('INFO forged'))
            && bc.includes('\\r\\n') && bc.includes('x'.repeat(200)) && /RESULT True/.test(r.out), JSON.stringify(L).slice(0, 500));
          // a surrogate pair at the cut is not split
          const emoji = await runExe(vc.exe, [], { ...process.env, ARG_command: 'a'.repeat(39) + '\u{1F600}\u{1F600}', ARG_value: 'v' });
          const einfo = lines(emoji.out).find((l) => l.startsWith('INFO ')) || '';
          check('[6b] GRN-16: the 40-character cut does not split a surrogate pair (an emoji at the cut leaves no lone half in the log line)', einfo.endsWith('...') && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(einfo) && !/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(einfo), JSON.stringify(einfo));
          const none = await runExe(vc.exe, [], { ...process.env });
          check('[6b] discord-voice-command.cs: no command argument is a warning, an error broadcast and false', /WARN \[Discord Voice Command\] called without a 'command'/.test(none.out) && /discord:voice:error/.test(none.out) && /RESULT False/.test(none.out), none.out.slice(0, 300));
        }

        // Discord Bridge Start, as shipped: the placeholder BUNDLE
        const shipped = await build('bridgestart', await readFile(resolve(__dirname, 'actions', 'discord-bridge-start.cs'), 'utf8'), { system: true });
        check('[6b] discord-bridge-start.cs compiles (C# 5, mscorlib + System.dll only, stubbed CPH)', shipped.ok, shipped.out.slice(0, 400));
        if (shipped.ok) {
          const r = await runExe(shipped.exe, [], process.env);
          check('[6b] GRN-10/21: as shipped (BUNDLE still the placeholder) it logs "set BUNDLE" and starts nothing', /WARN \[Discord Bridge Start\] BUNDLE is still the placeholder/.test(r.out) && /RESULT False/.test(r.out), r.out.slice(0, 300));
        }
        // the same code with BUNDLE read from the environment, so each case can have its own folder
        const forTest = (await readFile(resolve(__dirname, 'actions', 'discord-bridge-start.cs'), 'utf8')).replace(/const string BUNDLE = @"[^"]*";/, 'static readonly string BUNDLE = Environment.GetEnvironmentVariable("TEST_BUNDLE");').replace('string found = FindNode();', 'string found = Environment.GetEnvironmentVariable("TEST_NO_NODE") == "1" ? null : FindNode();');
        const tb = await build('bridgetest', forTest, { system: true });
        check('[6b] discord-bridge-start.cs (BUNDLE from the environment) compiles', tb.ok, tb.out.slice(0, 400));
        if (tb.ok) {
          const base = resolve(cdir, 'sidecar-cases');
          const mk = async (name, files, withModules) => { const d = resolve(base, name); await mkdir(d, { recursive: true }); for (const [f, t] of Object.entries(files)) await writeFile(resolve(d, f), t); if (withModules) await mkdir(resolve(d, 'node_modules'), { recursive: true }); return d; };
          const go = (dir, env) => runExe(tb.exe, [], { ...process.env, TEST_BUNDLE: dir, ...(env || {}) });
          const none = await go(resolve(base, 'does-not-exist'));
          const empty = await go(await mk('empty', {}, false));
          const noMods = await go(await mk('nomods', { 'discord-bridge.mjs': 'process.exit(0);\n' }, false));
          const already = await go(await mk('exit0', { 'discord-bridge.mjs': 'process.exit(0);\n' }, true));
          const failing = await go(await mk('exit3', { 'discord-bridge.mjs': 'process.exit(3);\n' }, true));
          const running = await go(await mk('stays', { 'discord-bridge.mjs': 'setTimeout(() => {}, 2600);\n' }, true));
          const slowRefusal = await go(await mk('late1', { 'discord-bridge.mjs': 'setTimeout(() => process.exit(1), 3000);\n' }, true)); // (a refusal after the 2 s window, like a guard port held by something else: ~5 s in the real bridge)
          check('[6b] GRN-21: a BUNDLE that does not exist, one without discord-bridge.mjs and one without node_modules each log their own specific warning and return false (nothing is started)',
            /WARN .*BUNDLE does not exist/.test(none.out) && /RESULT False/.test(none.out) && /WARN .*discord-bridge\.mjs is not in .*not the sidecar folder/.test(empty.out) && /RESULT False/.test(empty.out) && /WARN .*node_modules is missing.*npm install/.test(noMods.out) && /RESULT False/.test(noMods.out),
            JSON.stringify([none.out, empty.out, noMods.out]).slice(0, 700));
          check('[6b] GRN-21: a bridge that exits 0 at once is reported as already running (true); one that exits with code 3 is reported with the code and the .bat hint (false); one that stays up is "launched" (true)',
            /INFO .*bridge already running/.test(already.out) && /RESULT True/.test(already.out) && /WARN .*bridge exited with code 3.*start-discord-bridge\.bat/.test(failing.out) && /RESULT False/.test(failing.out) && /INFO .*launched node discord-bridge\.mjs/.test(running.out) && /RESULT True/.test(running.out),
            JSON.stringify([already.out, failing.out, running.out]).slice(0, 700));
          check('[6b] GRN-21: a refusal that comes AFTER the 2 s window is still "launched" (true) but the line says to run the .bat if no bridge appears (the limit is stated, not hidden)', /INFO .*launched node discord-bridge\.mjs/.test(slowRefusal.out) && /start-discord-bridge\.bat to see why/.test(slowRefusal.out) && /RESULT True/.test(slowRefusal.out), slowRefusal.out.slice(0, 300));
          const pf = process.env.ProgramFiles || 'C:\\Program Files';
          if (existsSync(resolve(pf, 'nodejs', 'node.exe')) || existsSync(resolve(process.env.ProgramW6432 || pf, 'nodejs', 'node.exe'))) {
            const noPath = await go(await mk('nopath', { 'discord-bridge.mjs': 'process.exit(0);\n' }, true), { PATH: resolve(process.env.SystemRoot || 'C:\\Windows', 'System32') });
            check('[6b] GRN-132: with node missing from the process PATH (a Node installed after Streamer.bot started) the first launch fails with "not found" (Win32 error 2), and the retry with the Node found in the usual places starts the bridge', /INFO .*bridge already running/.test(noPath.out) && /RESULT True/.test(noPath.out) && !/node was not found/.test(noPath.out), noPath.out.slice(0, 300));
            const notFound = await go(await mk('nonode', { 'discord-bridge.mjs': 'process.exit(0);\n' }, true), { PATH: resolve(process.env.SystemRoot || 'C:\\Windows', 'System32'), TEST_NO_NODE: '1' });
            check('[6b] GRN-132: with node missing from PATH and from the usual places the message says node was not found in Streamer.bot\'s PATH and to restart Streamer.bot or use the .bat (false)', /WARN .*node was not found in Streamer\.bot's PATH.*restart Streamer\.bot.*start-discord-bridge\.bat/.test(notFound.out) && /RESULT False/.test(notFound.out), notFound.out.slice(0, 300));
            // a Node that the user put first in PATH wins over the one in Program Files: a fake node.exe (it exits 7) in a PATH folder is the one that runs
            const fakeDir = resolve(cdir, 'fakebin');
            await mkdir(fakeDir, { recursive: true });
            await writeFile(resolve(cdir, 'fakenode.cs'), 'public static class FakeNode { public static int Main() { return 7; } }');
            const fb = await runExe(CSC, ['/nologo', '/noconfig', '/nostdlib+', '/r:' + MSCORLIB, '/target:exe', '/out:' + resolve(fakeDir, 'node.exe'), resolve(cdir, 'fakenode.cs')]);
            const pathFirst = await go(await mk('pathfirst', { 'discord-bridge.mjs': 'process.exit(0);\n' }, true), { PATH: fakeDir + ';' + resolve(process.env.SystemRoot || 'C:\\Windows', 'System32') });
            check('[6b] GRN-132: a node.exe the user put first in PATH is the one that runs (the Program Files copy is only the fallback): the fake node.exe that exits 7 is reported', fb.code === 0 && /WARN .*bridge exited with code 7/.test(pathFirst.out) && /RESULT False/.test(pathFirst.out), JSON.stringify({ fb: fb.out.slice(0, 200), out: pathFirst.out.slice(0, 300) }));
          } else console.log('  (the node-search check of [6b] is skipped: Node is not under Program Files on this machine)');
          await new Promise((r) => setTimeout(r, 3200)); // (the stub that stays up for 2.6 s has ended by now: its folder can go)
        }
      }
    }

    const bridgeSrc = await readFile(resolve(__dirname, 'sidecar', 'discord-bridge.mjs'), 'utf8');
    check('sidecar: subscribes with LOWERCASE general', bridgeSrc.includes("events: { general: ['Custom'] }"));
    check("sidecar: pushes via DoAction 'Discord Voice Push'", bridgeSrc.includes("name: 'Discord Voice Push'"));
    check('sidecar: consumes ONLY discord:voice:command (echo-loop guard)', bridgeSrc.includes("d.type !== 'discord:voice:command'"));
    check('sidecar: exit-on-SB-close wired (shouldExitOnSbClose + grace timer)',
      bridgeSrc.includes('shouldExitOnSbClose') && bridgeSrc.includes('SB_EXIT_GRACE_MS') && bridgeSrc.includes('armSbGoneTimer'));
    check('control.html: exit-on-SB-close toggle wired (exitOnSbClose set-setting)', ctrlBody.includes('exitOnSbClose'));
    check('control.html: config Export/Import wired (backup buttons + file input + envelope)',
      ctrlBody.includes('btnCfgExport') && ctrlBody.includes('cfgImportFile') && ctrlBody.includes('greenroom-vdo-backup'));

    // ── 6c. fixtures and packaging (Sprint 19: GRN-47, 46, 45, 229) ─────────────
    console.log('\n[6c] Fixtures and packaging: no real-looking Discord IDs, the shot tool is offline, the packaging guards');
    {
      // A tracked text file may hold a 17-20 digit number only if it is plainly made up: nine or more zeros in a row, one repeated
      // digit, or a run that counts up (…234567890123…). The one bare-number favourite fixture is named on purpose.
      const synthetic = (d) => /0{9,}/.test(d) || /^(\d)\1+$/.test(d) || [...d.slice(1)].every((c, i, a) => i === 0 || Number(c) === (Number(a[i - 1]) + 1) % 10) || d === '223456789012345679';
      const textExt = /\.(mjs|cjs|js|html|md|json|cs|bat|txt|yml|yaml)$/i;
      // The files a set-up kit holds that are NOT part of the project (gitignored, per install): the bot token file, the saved voice config
      // (a streamer's real server and channel IDs), backups, atomic-write leftovers, the tests' own scratch files. They are neither read nor named.
      const perInstall = (rel, name) => /^sidecar\/discord-(tokens|voice-config)\.json$/.test(rel) || /\.(tmp)$/.test(name) || /\.corrupt-/.test(name) || /^vdo-state-.*\.json$/.test(name) || name.startsWith('.verify-');
      const scanForIds = async (root) => {
        const files = [], odd = [];
        const walk = async (dir) => {
          for (const e of await readdir(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === '.git' || e.name === 'backups' || e.name === 'package-lock.json') continue;
            const p = resolve(dir, e.name);
            const rel = p.slice(root.length + 1).replace(/\\/g, '/');
            if (e.isDirectory()) await walk(p); else if (textExt.test(e.name) && !perInstall(rel, e.name)) files.push({ p, rel });
          }
        };
        await walk(root);
        for (const f of files) {
          const t = await readFile(f.p, 'utf8');
          if ([...t.matchAll(/(?<![\d.])\d{17,20}(?!\d)/g)].some((m) => !synthetic(m[0]))) odd.push(f.rel); // the file is named, the number never is
        }
        return { files, odd };
      };
      // the scanner itself, on a scratch tree: a real-looking ID in a source file is found, the same in a per-install file is neither read nor named
      const idTree = await mkdtemp(resolve(tmpdir(), 'greenroom-idscan-'));
      scratchDirs.push(idTree);
      await mkdir(resolve(idTree, 'sidecar'), { recursive: true });
      await mkdir(resolve(idTree, 'backups'), { recursive: true });
      const REAL = '1' + '2345678' + '90987654' + '3'; // (made up, but not patterned: 17 digits)
      await writeFile(resolve(idTree, 'src.js'), `const id = '${REAL}';\n`);
      await writeFile(resolve(idTree, 'ok.md'), 'an id like 200000000000000001 and 123456789012345678 is fine\n');
      await writeFile(resolve(idTree, 'sidecar', 'discord-voice-config.json'), `{ "current": { "serverId": "${REAL}" } }`);
      await writeFile(resolve(idTree, 'sidecar', 'discord-tokens.json'), `{ "botToken": "x", "note": "${REAL}" }`);
      await writeFile(resolve(idTree, 'backups', 'b.json'), `{ "id": "${REAL}" }`);
      const probe = await scanForIds(idTree);
      check('GRN-47 (scanner): a real-looking ID in a source file is found; the same in the token file, the saved voice config or backups/ is neither read nor named; made-up IDs pass',
        probe.odd.join() === 'src.js' && probe.files.some((f) => f.rel === 'ok.md') && !probe.files.some((f) => /discord-(tokens|voice-config)|^backups/.test(f.rel)), JSON.stringify({ odd: probe.odd, files: probe.files.map((f) => f.rel) }));
      const scan = await scanForIds(__dirname);
      check('GRN-47: no source, test or doc file holds a real-looking Discord ID (every 17-20 digit number is a made-up one); the per-install files (token file, voice config, backups) are not read', scan.files.length > 30 && scan.odd.length === 0, scan.odd.slice(0, 8).join(', '));
      const shots = await readFile(resolve(__dirname, 'tools', 'shots.mjs'), 'utf8');
      check('GRN-45/46: tools/shots.mjs shows neutral local avatars, aborts any request to Discord\'s CDN, and says its room and password are throwaway',
        !/https:\/\/cdn\.discordapp\.com/.test(shots) && /page\.route\(\/discordapp\\\.com\//.test(shots) && /data:image\/svg\+xml/.test(shots) && /throwaway/.test(shots) && /never use them for a real session/.test(shots));
      const pkgJson = JSON.parse(await readFile(resolve(__dirname, 'package.json'), 'utf8'));
      const gi = (await readFile(resolve(__dirname, '.gitignore'), 'utf8')).split(/\r?\n/);
      const ga = existsSync(resolve(__dirname, '.gitattributes')) ? (await readFile(resolve(__dirname, '.gitattributes'), 'utf8')).split(/\r?\n/) : [];
      check('GRN-229: package.json is "private" (npm publish refuses), .gitignore holds the one .verify-*.json pattern, /*-check.png and vdo-state-*.json, and .gitattributes keeps *.bat at CRLF',
        pkgJson.private === true && gi.includes('.verify-*.json') && gi.includes('/*-check.png') && gi.includes('vdo-state-*.json') && !gi.includes('.verify-bridge-config.json') && ga.includes('*.bat text eol=crlf'),
        JSON.stringify({ private: pkgJson.private, gi: gi.filter((l) => /verify|check|vdo-state/.test(l)), ga }));
      // the mutation harness (npm run mutation): its list loads, ids are unique, and every mutant names a file that exists, a bug that differs
      // from the code, a note and a known suite. Whether each `from` still matches is `npm run mutation -- --check` (it rots with every edit).
      const { MUTANTS } = await import(new URL('./tools/mutation/mutants.mjs', import.meta.url).href);
      const mutIds = MUTANTS.map((m) => m.id);
      const mutBad = MUTANTS.filter((m) => !m.skip && (!existsSync(resolve(__dirname, m.file)) || !m.from || m.from === m.to || !m.note || !['v', 'r', 'c'].includes(m.suite))).map((m) => m.id);
      check('GRN-218: the mutation harness has its mutants (87 or more that run, unique ids), each with an existing file, a real change, a note and a suite, and package.json has the "mutation" script',
        MUTANTS.filter((m) => !m.skip).length >= 87 && new Set(mutIds).size === mutIds.length && mutBad.length === 0 && /tools\/mutation\/run\.mjs/.test(pkgJson.scripts && pkgJson.scripts.mutation || ''), JSON.stringify({ n: MUTANTS.length, bad: mutBad, script: pkgJson.scripts && pkgJson.scripts.mutation }));
    }

    // ── 6d. the documents say what the code does (Sprint 20: GRN-193, 201, 230, 214) ──
    console.log('\n[6d] Documents: the path names, the theming table, the Subscribe casing, the tested versions');
    {
      const readme = await readFile(resolve(__dirname, 'README.md'), 'utf8');
      const setup = await readFile(resolve(__dirname, 'docs', 'STREAMERBOT-SETUP.md'), 'utf8');
      const theming = await readFile(resolve(__dirname, 'docs', 'THEMING.md'), 'utf8');
      const protocol = await readFile(resolve(__dirname, 'docs', 'PROTOCOL.md'), 'utf8');
      // every /greenroom-<x>/ address prefix the README uses is a Path of the setup guide's table (the mock's two spellings of each hide such drift)
      const mapped = new Set([...setup.matchAll(/^\s*\|\s*`(greenroom-[a-z]+)`\s*\|/gm)].map((m) => m[1]));
      const used = new Set([...readme.matchAll(/\/(greenroom-[a-z]+)\//g)].map((m) => m[1]));
      check('GRN-193: every /greenroom-…/ prefix in the README is a Path in the setup guide\'s table, and the README names the Path and the folder of both maps',
        mapped.size === 2 && used.size >= 2 && [...used].every((u) => mapped.has(u)) && /Path `greenroom-control` → this repo's `control` folder/.test(readme) && /Path `greenroom-overlay` →\s+its `overlay` folder/.test(readme), JSON.stringify({ mapped: [...mapped], used: [...used] }));
      const themeRows = [...theming.matchAll(/^\|\s*`(--[a-z-]+)`/gm)].map((m) => m[1]);
      check('GRN-201: docs/THEMING.md\'s :root table lists no variable the page sets itself at runtime (--accent, --avatar-px, --streamer-px) and says they are set at runtime',
        themeRows.length > 3 && !themeRows.some((v) => ['--accent', '--avatar-px', '--streamer-px'].includes(v)) && /sets\s+`--accent`, `--avatar-px` and `--streamer-px` itself, at runtime/.test(theming), JSON.stringify(themeRows));
      // the Subscribe casing: no document and no code comment says a capitalized key 'receives nothing' (the wording may break across a line and a comment marker)
      const subFiles = ['overlay/panel-client-sb.js', 'control/control.html', 'sidecar/discord-bridge.mjs', 'backup.mjs', 'mock-discord-bridge.mjs', 'mock-sb-server.mjs'];
      let subText = protocol + setup + readme;
      for (const rel of subFiles) subText += '\n' + await readFile(resolve(__dirname, rel), 'utf8');
      check('GRN-230: no document or code comment says a capitalized Subscribe key receives nothing, and the protocol says lowercase is the convention and Streamer.bot 1.0.7 accepts any casing',
        !/capitali[sz]ed[\s/*]*(?:`?General`?[\s/*]*)?Subscribe[\s\S]{0,60}?nothing/i.test(subText) && /lowercase 'general' is this project's convention/.test(protocol) && /matches the key case-insensitively/.test(protocol));
      // what is said to be tested: every Streamer.bot version the README's "Tested on" line names is one the setup guide's section 6 says was run, and unless that
      // includes 1.0.7 both documents say plainly that it was not
      const testedOn = (/Tested on:\*\*([^\n]*)/.exec(readme) || [])[1] || '';
      const named = testedOn.match(/\b\d+\.\d+\.\d+\b/g) || [];
      const section6 = (/\*\*Tested versions\.\*\*([\s\S]*?)What the offline harness/.exec(setup) || [])[1] || '';
      check('GRN-214/235: the versions the README says it was tested on are the ones the setup guide\'s section 6 says were run, and while 1.0.7 and OBS 33.0.1 are not among them both documents say they were not',
        named.length > 0 && named.every((v) => section6.includes(v)) && (named.includes('1.0.7') || (/not been re-run/.test(readme) && /not been run again\*\* on 1\.0\.7/.test(section6))), JSON.stringify({ named, section6: section6.slice(0, 80) }));
    }

    // ── 7. The REAL sidecar, token-less, over the real bus ──────────────────────
    // Proves discord-bridge.mjs's whole bus layer (subscribe, initial push, command
    // dispatch, config persistence, the no-token error path) with no Discord token
    // and no network. The mock bridge is killed first so command consumers don't
    // compete. Scratch config/token paths keep sidecar/ untouched.
    const sidecarDeps = existsSync(resolve(__dirname, 'sidecar', 'node_modules', 'discord.js'));
    if (!sidecarDeps) check('the sidecar\'s dependencies are installed (sidecar/node_modules/discord.js is missing: run  npm --prefix sidecar ci  and run this again; sections [7] and [8] need them)', false);
    if (sidecarDeps) {
    console.log('\n[7] real sidecar (token-less): bus layer end-to-end');
    bridge.kill();
    await new Promise((r) => setTimeout(r, 300));
    const scratchCfg = resolve(__dirname, '.verify-bridge-config.json');
    const scratchTok = resolve(__dirname, '.verify-bridge-tokens.json');
    await rm(scratchCfg, { force: true });
    await rm(scratchTok, { force: true });
    sidecar = await startChild('sidecar/discord-bridge.mjs', 'Connected to Streamer.bot', {
      SB_WS_URL: WS_URL,
      DISCORD_BRIDGE_CONFIG: scratchCfg,
      DISCORD_BRIDGE_TOKENS: scratchTok,
      // Scratch guard ports live OUTSIDE the 749x block the components claim
      // (Fortuna 7493, Greenroom 7495, Zipper 7496, Octet 7498) — otherwise this
      // suite fails whenever a sibling component's sidecar is running for real.
      GREENROOM_GUARD_PORT: String(GUARD_BASE),
    });
    const shimF = await runShim();
    const sInit = await shimF.inbox.next(4000,
      (d) => byType('discord:voice:update')(d) && Array.isArray(d.discordVoice.favorites) && d.discordVoice.favorites[0] && d.discordVoice.favorites[0].id === 'example1',
      'sidecar initial state');
    check('sidecar initial push: seeded from the example config, no token, offline',
      sInit.discordVoice.rpc.hasToken === false && sInit.discordVoice.connected === false && sInit.discordVoice.settings.accent === 'cyan');

    producer.doAction('Discord Voice Command', { command: 'set-settings', value: JSON.stringify({ accent: 'neon-green' }) });
    const sSet = await shimF.inbox.next(4000,
      (d) => byType('discord:voice:update')(d) && d.discordVoice.settings && d.discordVoice.settings.accent === 'neon-green',
      'sidecar set-settings echo');
    check('sidecar consumes set-settings from the bus and re-pushes', !!sSet);
    const persisted = JSON.parse(await readFile(scratchCfg, 'utf8'));
    check('sidecar persisted the setting to its config file', persisted.settings.accent === 'neon-green');

    producer.doAction('Discord Voice Command', { command: 'favorite-add', value: JSON.stringify({ name: 'Verify Fav', serverId: '123456789012345678', channelId: '223456789012345678' }) });
    const sFav = await shimF.inbox.next(4000,
      (d) => byType('discord:voice:update')(d) && (d.discordVoice.favorites || []).some((f) => f.name === 'Verify Fav'),
      'sidecar favorite-add echo');
    check('sidecar favorite-add round-trips + sanitizes', sFav.discordVoice.favorites.some((f) => f.name === 'Verify Fav' && f.channelId === '223456789012345678'));

    producer.doAction('Discord Voice Command', { command: 'connect', value: '' });
    const sErr = await shimF.inbox.next(4000,
      (d) => byType('discord:voice:update')(d) && d.discordVoice.rpc && /no bot token/i.test(d.discordVoice.rpc.error || ''),
      'sidecar no-token error');
    check('connect without a token → visible file-onboarding error (the token is only ever read from the file)', !!sErr);

    // ── the saved config after each command (Sprint 19, GRN-234; the rules are those of Sprints 13a, 13b and 14) ──
    {
      const nap7 = (ms) => new Promise((r) => setTimeout(r, ms));
      const cmd7 = async (command, value) => { producer.doAction('Discord Voice Command', { command, value: typeof value === 'string' ? value : JSON.stringify(value) }); await nap7(600); return JSON.parse(await readFile(scratchCfg, 'utf8')); };
      const S7 = '333333333333333333', C7 = '444444444444444444';
      let c = await cmd7('set-current', { serverId: '<#' + S7 + '>', channelId: C7.slice(0, 9) + ' ' + C7.slice(9) });
      check('GRN-234: set-current saves the pair as digits (a pasted <#id> and an id with a space are cleaned)', JSON.stringify(c.current) === JSON.stringify({ serverId: S7, channelId: C7 }), JSON.stringify(c.current));
      c = await cmd7('set-current', { serverId: S7, channelId: '' });
      check('GRN-234: …and a blank channel afterwards clears it (current null) and keeps the favorites', c.current === null && c.favorites.some((f) => f.name === 'Verify Fav'), JSON.stringify({ cur: c.current, fav: c.favorites.length }));
      const n0 = c.favorites.length;
      c = await cmd7('favorite-add', { name: '', serverId: '123456789012345678', channelId: '234567890123456789' });
      check('GRN-234: a favorite with no name is named after the last four digits of its two ids', c.favorites.length === n0 + 1 && c.favorites.some((f) => f.name === '5678/6789' && f.serverId === '123456789012345678' && f.channelId === '234567890123456789'), JSON.stringify(c.favorites.map((f) => f.name)));
      c = await cmd7('favorite-add', { name: 'Blank', serverId: '', channelId: '234567890123456789' });
      c = await cmd7('favorite-add', { name: 'Blank2', serverId: '123456789012345678', channelId: '   ' });
      check('GRN-234: a favorite with a blank server or channel id is not added', c.favorites.length === n0 + 1 && !c.favorites.some((f) => /^Blank/.test(f.name)), JSON.stringify(c.favorites.map((f) => f.name)));
      c = await cmd7('favorite-add', { name: 'Messy', serverId: '12345678901234a567', channelId: '23456789-0123456-78' });
      const messy = c.favorites.find((f) => f.name === 'Messy');
      check('GRN-234: ids with letters or dashes in them are stored as their digits', !!messy && messy.serverId === '12345678901234567' && messy.channelId === '23456789012345678', JSON.stringify(messy));
      c = await cmd7('favorite-remove', { id: messy && messy.id });
      check('GRN-234: favorite-remove takes exactly that favorite out of the file', !c.favorites.some((f) => f.name === 'Messy') && c.favorites.length === n0 + 1, JSON.stringify(c.favorites.map((f) => f.name)));
      c = await cmd7('set-settings', { avatarPx: -5, streamerPx: 9999, height: 'abc', accent: '<script>', bogus: 1, streamerUserId: '<@100000000000000001>' });
      check('GRN-234: set-settings clamps the sizes (24 and 160), leaves the accent alone for a value that is not one of the three, saves a pasted "<@id>" as its digits, and saves neither "height" nor an unknown key',
        c.settings.avatarPx === 24 && c.settings.streamerPx === 160 && c.settings.accent === 'neon-green' && c.settings.streamerUserId === '100000000000000001' && !('height' in c.settings) && !('bogus' in c.settings), JSON.stringify(c.settings));
    }

    // ── 8. exit-on-SB-close lifecycle: closing SB leaves voice + quits (opt-in) ──
    // Isolated on its own SB (separate ports) so killing it doesn't disturb the
    // shared mock the earlier sections use. Two token-less sidecars share that SB:
    // one with GREENROOM_EXIT_ON_SB_CLOSE=1 (must exit when SB drops), one with the
    // feature off (must survive — the default reconnect-forever behaviour).
    console.log('\n[8] exit-on-SB-close: closing Streamer.bot disconnects + quits (opt-in)');
    const EXIT_HTTP = Number(process.env.SB_EXIT_HTTP_PORT) || HTTP_PORT + 100; // derived, so this and verify:render can run together
    const EXIT_WS = Number(process.env.SB_EXIT_WS_PORT) || WS_PORT + 100;
    const onCfg = resolve(__dirname, '.verify-exit-on-config.json');
    const onTok = resolve(__dirname, '.verify-exit-on-tokens.json');
    const offCfg = resolve(__dirname, '.verify-exit-off-config.json');
    const offTok = resolve(__dirname, '.verify-exit-off-tokens.json');
    let exitMock, onSc, offSc;
    try {
      await Promise.all([onCfg, onTok, offCfg, offTok].map((p) => rm(p, { force: true })));
      exitMock = await startChild('mock-sb-server.mjs', '[mock] READY', { SB_HTTP_PORT: String(EXIT_HTTP), SB_WS_PORT: String(EXIT_WS) });
      const GRACE = 1000; // the bridge's floor for the grace: anything lower is raised to it (sidecar/discord-bridge.mjs SB_EXIT_GRACE_MS)
      const common = { SB_WS_URL: `ws://127.0.0.1:${EXIT_WS}/`, GREENROOM_SB_EXIT_GRACE_MS: String(GRACE) };
      onSc = await startChild('sidecar/discord-bridge.mjs', 'Connected to Streamer.bot', {
        ...common, GREENROOM_EXIT_ON_SB_CLOSE: '1', GREENROOM_GUARD_PORT: String(GUARD_BASE + 1),
        DISCORD_BRIDGE_CONFIG: onCfg, DISCORD_BRIDGE_TOKENS: onTok,
      });
      offSc = await startChild('sidecar/discord-bridge.mjs', 'Connected to Streamer.bot', {
        ...common, GREENROOM_GUARD_PORT: String(GUARD_BASE + 2), GREENROOM_EXIT_ON_SB_CLOSE: '0', // the feature is off, said explicitly
        DISCORD_BRIDGE_CONFIG: offCfg, DISCORD_BRIDGE_TOKENS: offTok,
      });
      let offOut = ''; // what the OFF sidecar logs from here on (GRN-56)
      for (const s of [offSc.stdout, offSc.stderr]) s.on('data', (d) => { offOut += d; });
      exitMock.kill(); exitMock = null; // "close Streamer.bot"
      const onExited = await waitExit(onSc, GRACE + 4000);
      check('exitOnSbClose ON: SB closes → sidecar disconnects from voice and exits within grace', onExited);
      // The OFF sidecar had its full chance to leave: the grace, the 300 ms of the leave itself, one reconnect tick of 3 s (and its refusal) and a margin (GRN-213).
      await new Promise((r) => setTimeout(r, GRACE + 300 + 3000 + 700));
      check('exitOnSbClose OFF: SB closes → sidecar stays up (reconnect-forever) past the ON sidecar\'s exit, the 3 s reconnect tick and its refusal, and never announces a shutdown',
        offSc.exitCode === null && !/will leave voice and exit/.test(offOut), JSON.stringify({ code: offSc.exitCode, out: offOut.slice(-300) }));
      // …and it finds Streamer.bot again when that comes back on the same ports (a restart of Streamer.bot)
      exitMock = await startChild('mock-sb-server.mjs', '[mock] READY', { SB_HTTP_PORT: String(EXIT_HTTP), SB_WS_PORT: String(EXIT_WS) });
      for (let t = 0; t < 8000 && !/Connected to Streamer\.bot/.test(offOut); t += 100) await new Promise((r) => setTimeout(r, 100));
      check('exitOnSbClose OFF: …and when Streamer.bot is back on the same port the sidecar connects to it again', /Connected to Streamer\.bot/.test(offOut) && offSc.exitCode === null, offOut.slice(-300));
    } finally {
      if (onSc) try { onSc.kill(); } catch {}
      if (offSc) try { offSc.kill(); } catch {}
      if (exitMock) try { exitMock.kill(); } catch {}
      await Promise.all([onCfg, onTok, offCfg, offTok].map((p) => rm(p, { force: true })));
    }

    // ── 8b. the bridge's lifecycle: one exit path, the stopping flag, the guard, hostile frames, arguments, dial races (Sprint 12) ──
    console.log('\n[8b] bridge lifecycle: shutdown, crash policy, guard, command frames, arguments, dial races');
    {
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (fn, ms) => { for (let t = 0; t < ms; t += 100) { if (fn()) return true; await nap(100); } return !!fn(); };
      const connectTcp = (port) => netConnect(port, '127.0.0.1');
      const SIDECAR_VERSION = JSON.parse(await readFile(resolve(__dirname, 'sidecar', 'package.json'), 'utf8')).version;
      const s12 = await mkdtemp(resolve(tmpdir(), 'greenroom-s12-'));
      scratchDirs.push(s12);
      const live = []; // everything a rig started, closed at the end
      let seq = 0;
      // One real bridge (token-less unless told otherwise) on a mock SB, with a watcher that keeps every payload it pushes.
      async function rig(opts = {}) {
        const sb = opts.sb || await startMockWith({});
        const n = ++seq;
        const guardPort = opts.guardPort || await freePort();
        const env = { SB_WS_URL: sb.url, DISCORD_BRIDGE_CONFIG: resolve(s12, `cfg${n}.json`), DISCORD_BRIDGE_TOKENS: resolve(s12, `tok${n}.json`),
          GREENROOM_GUARD_PORT: String(guardPort), GREENROOM_TEST_HOOKS: '1', GREENROOM_LOOSE_IDS: '1', ...(opts.env || {}) };
        if (opts.token) await writeFile(env.DISCORD_BRIDGE_TOKENS, JSON.stringify({ botToken: opts.token, enabled: false }));
        if (opts.tokData !== undefined) await writeFile(env.DISCORD_BRIDGE_TOKENS, opts.tokData); // a string or a Buffer, written as it is
        if (opts.cfgText !== undefined) await writeFile(env.DISCORD_BRIDGE_CONFIG, opts.cfgText);
        if (opts.cfgDir) await mkdir(env.DISCORD_BRIDGE_CONFIG); // the config path is a folder (it can be neither read nor copied)
        if (opts.stale) { await writeFile(env.DISCORD_BRIDGE_CONFIG + '.tmp', 'x'); await writeFile(env.DISCORD_BRIDGE_TOKENS + '.tmp', 'x'); } // temp files a crash left behind
        const got = []; // every discordVoice payload, in order
        const gotAt = []; // when each one arrived (Date.now())
        const frames = []; // every raw frame the watcher received
        const watcher = new WebSocket(sb.url);
        await new Promise((res, rej) => { watcher.on('open', res); watcher.on('error', rej); });
        watcher.on('message', (raw) => {
          frames.push(raw.toString());
          try {
            const m = JSON.parse(raw.toString());
            if (m.event && m.event.type === 'Custom') { const d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data; if (d && d.type === 'discord:voice:update') { got.push(JSON.parse(d.discordVoiceJson)); gotAt.push(Date.now()); } }
          } catch { /* not a payload */ }
        });
        const subscribeWatcher = () => watcher.send(JSON.stringify({ request: 'Subscribe', id: 's', events: { general: ['Custom'] } }));
        if (opts.sbPassword === undefined) subscribeWatcher();
        else {
          // a Streamer.bot with a password: answer its challenge first (the same handshake as the clients')
          const b64 = (t) => createHash('sha256').update(t).digest('base64');
          watcher.on('message', (raw) => {
            try {
              const m = JSON.parse(raw.toString());
              if (m.request === 'Hello') { if (m.authentication) watcher.send(JSON.stringify({ request: 'Authenticate', id: 'wa', authentication: b64(b64(opts.sbPassword + m.authentication.salt) + m.authentication.challenge) })); else subscribeWatcher(); }
              else if (m.id === 'wa' && m.status === 'ok') subscribeWatcher();
            } catch { /* not for us */ }
          });
        }
        const child = spawn(process.execPath, ['sidecar/discord-bridge.mjs', ...(opts.args || [])], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv(env) });
        let out = ''; let code = null;
        child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { out += d; });
        child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { out += d; });
        child.on('exit', (c) => { code = c; });
        const r = {
          sb, child, got, gotAt, frames, guardPort, env,
          get out() { return out; }, get code() { return code; }, get last() { return got[got.length - 1]; },
          cmd: (command, value = '') => watcher.send(JSON.stringify({ request: 'DoAction', id: 'c' + (++seq), action: { name: 'Discord Voice Command' }, args: { command, value } })),
          raw: (data) => fetch(`${sb.base}/mock/broadcast`, { method: 'POST', body: JSON.stringify(data) }).then((x) => x.arrayBuffer()),
          exited: (ms) => waitExit(child, ms),
          waitFor: async (pred, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = got.find(pred); if (hit) return hit; await nap(100); } return null; },
          close: () => { try { watcher.close(); } catch {} try { child.kill(); } catch {} },
        };
        live.push(r);
        if (!opts.noWait) await r.waitFor(() => true, 8000); // the first push
        return r;
      }
      // Fixtures for the mock Discord: one guild (900), the bot's own user (1000), and builders for users, members, voice states and channels.
      const DF = (() => {
        const GUILD = '900', ME = '1000';
        const VIEW = 1n << 10n, CONNECT = 1n << 20n, SPEAK = 1n << 21n;
        const userOf = (id, name, x = {}) => ({ id, username: name, discriminator: '0', avatar: x.avatar || null, bot: !!x.bot, global_name: x.global || null });
        const memberOf = (id, name, x = {}) => ({ user: userOf(id, name, x), nick: x.nick || null, roles: [], joined_at: x.guest ? null : '2020-01-01T00:00:00.000000+00:00', deaf: false, mute: !!x.mute, ...(x.guildAvatar ? { avatar: x.guildAvatar } : {}) });
        const vstate = (userId, channelId, x = {}) => ({ user_id: userId, channel_id: channelId, guild_id: GUILD, deaf: false, mute: false, self_deaf: !!x.selfDeaf, self_mute: !!x.selfMute, session_id: 's' + userId, suppress: false, self_video: false, self_stream: false, request_to_speak_timestamp: null, ...(x.member ? { member: x.member } : {}) });
        const chan = (id, type, name, pos, over = [], limit = 0) => ({ id, type, name, position: pos, permission_overwrites: over, bitrate: 64000, user_limit: limit, guild_id: GUILD });
        return { GUILD, ME, VIEW, CONNECT, SPEAK, userOf, memberOf, vstate, chan };
      })();
      // A mock Discord for the real discord.js inside the bridge (DISCORD_BRIDGE_API, loopback only): a REST server and a gateway. The
      // gateway answers heartbeats, identifies (READY, then GUILD_CREATE from guild()), RESUMEs (op 6 -> RESUMED) and records the
      // voice-state requests (op 4: this mock has no voice server, so a voice connection never becomes ready). Controls: dispatchAll(t, d)
      // sends a dispatch to every socket, dispatchBatch(frames) puts several in ONE TCP write (the bridge reads them in one turn),
      // holdHelloMs delays the next Hello (an outage), dropAll(code) closes every gateway socket, restDelay['<url part>'] = ms delays a
      // REST answer, `users` answers GET /users/:id; everything else is Unknown Channel / Unknown Guild (the guilds that exist came with
      // GUILD_CREATE). Sprint 13b's gateway cases (re-identify, resume, leave while reconnecting) run on the same mock.
      async function mockDiscord({ guild, users = {} }) {
        const socks = new Set();
        // gatewayFailNext: the next N REST lookups of the gateway URL (the first thing a login does) answer gatewayStatus (after gatewayDelay ms)
        // instead of the URL; gatewayHits counts them; connections counts gateway sockets accepted.
        const st = { authSeen: [], identifies: 0, resumes: 0, ops4: [], holdHelloMs: 0, seq: 0, restDelay: {}, gatewayFailNext: 0, gatewayStatus: 500, gatewayDelay: 0, gatewayHits: 0, connections: 0, omitGuildInReady: false };
        const send = (ws, t, d) => { try { ws.send(JSON.stringify({ op: 0, t, s: ++st.seq, d })); } catch { /* gone */ } };
        const gw = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        const me = guild().members.find((m) => m.user.bot).user;
        gw.on('connection', async (ws) => {
          socks.add(ws); st.connections++; ws.on('close', () => socks.delete(ws)); ws.on('error', () => {});
          ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch { return; }
            if (m.op === 1) ws.send(JSON.stringify({ op: 11 }));
            else if (m.op === 2) {
              st.identifies++;
              send(ws, 'READY', { v: 10, user: me, guilds: st.omitGuildInReady ? [] : [{ id: guild().id, unavailable: true }], session_id: 'mock' + st.identifies, resume_gateway_url: `ws://127.0.0.1:${gw.address().port}`, application: { id: me.id, flags: 0 } });
              if (!st.omitGuildInReady) setTimeout(() => send(ws, 'GUILD_CREATE', guild()), 50);
            } else if (m.op === 6) { st.resumes++; send(ws, 'RESUMED', {}); }
            else if (m.op === 4) st.ops4.push(m.d);
          });
          if (st.holdHelloMs) { const h = st.holdHelloMs; st.holdHelloMs = 0; await nap(h); }
          try { ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } })); } catch { /* gone */ }
        });
        await new Promise((res) => gw.once('listening', res));
        const rest = createHttp(async (req, res) => {
          res.setHeader('content-type', 'application/json');
          if (/gateway\/bot/.test(req.url)) { st.gatewayHits++; st.authSeen.push(String(req.headers.authorization || '')); }
          if (/gateway\/bot/.test(req.url) && st.gatewayFailNext > 0) {
            st.gatewayFailNext--;
            if (st.gatewayDelay) await nap(st.gatewayDelay);
            res.statusCode = st.gatewayStatus;
            return res.end(JSON.stringify({ message: st.gatewayStatus === 401 ? '401: Unauthorized' : 'mock gateway failure', code: 0 }));
          }
          if (/gateway\/bot/.test(req.url)) return res.end(JSON.stringify({ url: `ws://127.0.0.1:${gw.address().port}`, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 1000, max_concurrency: 1 } }));
          const slow = Object.keys(st.restDelay).find((k) => req.url.includes(k));
          if (slow) await nap(st.restDelay[slow]);
          const um = /\/users\/(\d+)/.exec(req.url);
          if (um && users[um[1]]) return res.end(JSON.stringify(users[um[1]]));
          res.statusCode = 404;
          res.end(JSON.stringify(/\/channels\//.test(req.url) ? { code: 10003, message: 'Unknown Channel' } : { code: 10004, message: 'Unknown Guild' }));
        });
        await new Promise((res) => rest.listen(0, '127.0.0.1', res));
        return Object.assign(st, {
          api: `http://127.0.0.1:${rest.address().port}/api`,
          dispatchAll: (t, d) => { for (const ws of socks) send(ws, t, d); },
          dispatchBatch: (frames) => { for (const ws of socks) { try { ws._socket.cork(); for (const [t, d] of frames) send(ws, t, d); process.nextTick(() => ws._socket.uncork()); } catch { /* gone */ } } },
          dropAll: (code) => { for (const ws of socks) { try { ws.close(code); } catch { /* gone */ } } },
          close: async () => { for (const ws of socks) { try { ws.terminate(); } catch { /* gone */ } } await new Promise((res) => gw.close(res)); rest.close(); },
        });
      }
      try {
        // hb / stopped / bridgeVersion, and the heartbeat (GRN-129)
        const a = await rig();
        const first = a.got[0] || {};
        check('GRN-129: every payload carries hb 5000, stopped false and the bridge version (additive fields)', first.hb === 5000 && first.stopped === false && first.bridgeVersion === SIDECAR_VERSION, JSON.stringify({ hb: first.hb, stopped: first.stopped, v: first.bridgeVersion }));
        await nap(300);
        check('GRN-02: the pushes at connect are one burst, not one per cause (at most 2 frames in the first 300 ms)', a.got.length <= 2, String(a.got.length));
        // the 100 ms coalesce floor (GRN-218, mutant M36): twelve changes inside a few milliseconds are pushed in at most a few frames, no two closer than about
        // 100 ms (a little less is allowed for timer jitter), and the last change is the last state pushed
        {
          const cf = await rig();
          await nap(400);
          const n0 = cf.got.length;
          for (let i = 0; i < 12; i++) cf.cmd('set-settings', JSON.stringify({ neonBlink: i % 2 !== 0 })); // the twelfth (i = 11) sets true
          await nap(1200);
          const times = cf.gotAt.slice(n0);
          const gaps = times.slice(1).map((t, i) => t - times[i]);
          check('GRN-218 (M36): a burst of twelve changes is coalesced: a few pushes (not twelve), none closer than about 100 ms to the one before, and the last state is the one the last change set',
            times.length >= 2 && times.length <= 6 && Math.min(...gaps) >= 80 && cf.last.settings.neonBlink === true, JSON.stringify({ pushes: times.length, gaps, neonBlink: cf.last.settings.neonBlink }));
          cf.close();
        }
        const n0 = a.got.length;
        await nap(5800);
        check('GRN-129: with nothing else going on a heartbeat push arrives about every 5 s', a.got.length > n0, String(a.got.length - n0));
        check('GRN-69: the log is written from a worker thread (a console that stops draining cannot stall the bridge) and the bot token is redacted', bridgeSrc.includes('new Worker(') && bridgeSrc.includes('fs.writeSync(1') && bridgeSrc.includes('[bot token]'));
        // the mock bridge sends the same heartbeat fields (GRN-129)
        {
          const mbSb = await startMockWith({});
          const mbGot = [];
          const mbW = new WebSocket(mbSb.url);
          await new Promise((res, rej) => { mbW.on('open', res); mbW.on('error', rej); });
          mbW.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.event && m.event.type === 'Custom') { const d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data; if (d && d.type === 'discord:voice:update') mbGot.push(JSON.parse(d.discordVoiceJson)); } } catch { /* not a payload */ } });
          mbW.send(JSON.stringify({ request: 'Subscribe', id: 's', events: { general: ['Custom'] } }));
          const mb = await startChild('mock-discord-bridge.mjs', '[mock-bridge] up', { SB_WS_URL: mbSb.url, SB_WS_PORT: String(mbSb.wsPort) });
          await nap(5800);
          check('GRN-129: the mock bridge pushes hb 5000, stopped false and a bridgeVersion, and pushes again about every 5 s with nothing else going on',
            mbGot.length >= 2 && mbGot.every((p) => p.hb === 5000 && p.stopped === false && typeof p.bridgeVersion === 'string'), JSON.stringify(mbGot.map((p) => [p.hb, p.stopped])));
          try { mbW.close(); } catch {} try { mb.kill(); } catch {} try { mbSb.child.kill(); } catch {}
        }
        // the guard says who holds it (GRN-22)
        const banner = await new Promise((res) => { const s = connectTcp(a.guardPort); let buf = ''; s.setEncoding('utf8'); s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.destroy(); res(buf.split('\n')[0]); } }); s.on('error', () => res(buf)); setTimeout(() => { s.destroy(); res(buf); }, 1500); });
        let bn = null; try { bn = JSON.parse(banner); } catch { /* left null */ }
        check('GRN-22: the guard port answers with a banner (name, pid, version) as one JSON line', !!bn && bn.name === 'greenroom-bridge' && Number.isInteger(bn.pid) && bn.pid === a.child.pid && bn.version === SIDECAR_VERSION, banner);
        // hostile guard peers: RST with data, RST with no data, a peer that is killed (GRN-105)
        for (const how of ['rst-with-data', 'rst-no-data']) {
          await new Promise((res) => { const s = connectTcp(a.guardPort); s.on('error', () => {}); s.on('connect', () => { if (how === 'rst-with-data') s.write('hello\n'); setTimeout(() => { s.resetAndDestroy(); res(); }, 60); }); });
        }
        const killedPeer = spawn(process.execPath, ['-e', `require('net').connect(${a.guardPort}, '127.0.0.1', () => { setInterval(() => {}, 1000); });`], { stdio: 'ignore' });
        await nap(600); killedPeer.kill(); await nap(800);
        a.cmd('set-settings', JSON.stringify({ accent: 'magenta' }));
        const afterPeers = await a.waitFor((p) => p.settings && p.settings.accent === 'magenta', 4000);
        check('GRN-105: an RST with data, an RST with no data and a killed peer on the guard port change nothing: the bridge is alive and still serves commands', a.code === null && !!afterPeers, a.out.slice(-300));
        // hostile command frames (GRN-160)
        for (const bad of [{ command: { toString: 1 } }, { command: 'leave', value: { toString: null } }, { command: [{ toString: 1 }] }, { command: 'leave', value: 5 }, { command: 7 }]) await a.raw({ type: 'discord:voice:command', ...bad });
        await nap(600);
        a.cmd('set-settings', JSON.stringify({ accent: 'neon-green' }));
        const afterFrames = await a.waitFor((p) => p.settings && p.settings.accent === 'neon-green', 4000);
        check('GRN-160: command frames with an object, an array or a number for command or value are dropped (the bridge stays up and serves the next command)', a.code === null && !!afterFrames, a.out.slice(-300));
        // a throw on a path that has its own catch is logged; an unhandled rejection is logged and the bridge goes on (GRN-129, GRN-23)
        a.cmd('test-throw-sync'); a.cmd('test-reject'); await nap(800);
        a.cmd('set-settings', JSON.stringify({ accent: 'cyan' }));
        const afterReject = await a.waitFor((p) => p.settings && p.settings.accent === 'cyan', 4000);
        check('GRN-129/23: a command that throws, and an unhandled rejection, are logged and the bridge carries on', a.code === null && !!afterReject && /unhandled/i.test(a.out), a.out.slice(-300));
        // control characters in a command never reach the log raw (GRN-16)
        await a.raw({ type: 'discord:voice:command', command: 'bell\u0007esc\u001b[31mred', value: 'x'.repeat(500) });
        await nap(500);
        check('GRN-16: a command with control characters is logged with them replaced, and its value is cut', a.code === null && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(a.out) && !a.out.includes('x'.repeat(200)), JSON.stringify(a.out.slice(-200)));
        a.close();

        // signals and the quit command: one exit, a clearing push first, code 0, no rpc.error (GRN-129, GRN-128, GRN-110)
        for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'quit']) {
          const b = await rig();
          if (sig === 'quit') b.cmd('quit'); else b.cmd('test-signal', sig);
          const gone = await b.exited(5000);
          const last = b.last || {};
          check('GRN-129/128/110: ' + sig + ' → the bridge pushes ONE clearing state (stopped, hb 0, no users, offline, no error) and exits 0',
            gone && b.code === 0 && last.stopped === true && b.got.filter((p) => p.stopped === true).length === 1 && last.hb === 0 && last.connected === false && last.hostInChannel === false && Object.keys(last.users || {}).length === 0 && !(last.rpc && last.rpc.error), JSON.stringify({ gone, code: b.code, stopped: last.stopped, frames: b.got.filter((p) => p.stopped === true).length, hb: last.hb, err: last.rpc && last.rpc.error }));
          b.close();
        }
        // a console that stops draining (QuickEdit) must not stall the bridge or its exit (GRN-69, GRN-129): the log worker is blocked on purpose
        {
          const f = await rig();
          f.cmd('test-block-log'); await nap(300);
          f.cmd('set-settings', JSON.stringify({ accent: 'magenta' }));
          const pushedWhileBlocked = await f.waitFor((p) => p.settings && p.settings.accent === 'magenta', 4000);
          const logged = f.out.length;
          f.cmd('set-settings', JSON.stringify({ accent: 'neon-green' })); await nap(500);
          check('GRN-69: with the log worker blocked (a frozen console) the bridge keeps pushing, and its log lines just stop appearing', !!pushedWhileBlocked && f.code === null && f.out.length === logged, JSON.stringify({ pushed: !!pushedWhileBlocked, code: f.code, grew: f.out.length - logged }));
          f.cmd('test-signal', 'SIGINT');
          const fGone = await f.exited(5000);
          check('GRN-129: …and the exit does not wait for the frozen console: the clearing state is sent and the process ends within 5 s', fGone && f.last && f.last.stopped === true, JSON.stringify({ fGone, stopped: f.last && f.last.stopped }));
          f.close();
          const f2 = await rig();
          f2.cmd('test-block-log'); await nap(300);
          f2.cmd('test-throw', 'crash while the console is frozen');
          const f2Gone = await f2.exited(5000);
          check('GRN-129: a crash with a frozen console still pushes the clearing state with the error and ends the process', f2Gone && f2.code !== 0 && f2.last && f2.last.stopped === true && /crash while the console is frozen/.test((f2.last.rpc && f2.last.rpc.error) || ''), JSON.stringify({ f2Gone, code: f2.code, err: f2.last && f2.last.rpc && f2.last.rpc.error }));
          f2.close();
        }
        // a crash: exit code 1, the same clearing push, the error text without a secret (GRN-129, GRN-16)
        const secret = 'MTIzNDU2Nzg5.AbCdEf.SECRETSECRETSECRET';
        const c = await rig({ token: secret });
        c.cmd('test-throw', 'boom with ' + secret + ' inside');
        const crashed = await c.exited(5000);
        const cl = c.last || {};
        check('GRN-129: an uncaught exception pushes the clearing state with an error and exits 1', crashed && c.code === 1 && cl.stopped === true && cl.hb === 0 && /boom/.test((cl.rpc && cl.rpc.error) || ''), JSON.stringify({ code: c.code, err: cl.rpc && cl.rpc.error }));
        check('GRN-16: the bot token never appears in the log or in the pushed error', !c.out.includes(secret) && !JSON.stringify(c.got).includes(secret), c.out.slice(-200));
        c.close();
        // a token that straddles the cut of a long error text is still not shown, not even in part (the text is cut AFTER the token is removed)
        const c2 = await rig({ token: secret });
        c2.cmd('test-throw', 'y'.repeat(280) + secret);
        await c2.exited(5000);
        check('GRN-16: a token that would be cut in half by the length limit does not leak its first characters into the pushed error or the log', !(c2.last && JSON.stringify(c2.last.rpc).includes(secret.slice(0, 8))) && !c2.out.includes(secret.slice(0, 8)), JSON.stringify(c2.last && c2.last.rpc).slice(-120));
        c2.close();
        // a config file that cannot be read is kept (copied aside as .corrupt-<time>), never silently replaced by the example (GRN-93)
        const bad = await rig({ cfgText: '{ "favorites": [ ' });
        await nap(300);
        const kept = (await readdir(s12)).filter((n) => /\.corrupt-/.test(n));
        check('GRN-93: the bridge keeps a config file it cannot read (a copy named .corrupt-<time>) and says so in the sticky rpc.configWarning, instead of overwriting it with the example', kept.length === 1 && /could not be used/i.test((bad.last.rpc && bad.last.rpc.configWarning) || '') && /\{ "favorites": \[ /.test(await readFile(bad.env.DISCORD_BRIDGE_CONFIG, 'utf8')), JSON.stringify({ kept, warn: bad.last && bad.last.rpc && bad.last.rpc.configWarning }));
        bad.close();
        // an address that is not a ws:// URL is said at once, not retried forever in silence
        const badUrl = await rig({ args: ['--sb-ws-url=127.0.0.1:8080'], noWait: true });
        const badUrlGone = await badUrl.exited(5000);
        check('GRN-142: --sb-ws-url without a ws:// scheme → the bridge says so and exits non-zero (it does not retry in silence)', badUrlGone && badUrl.code !== 0 && /ws:\/\//.test(badUrl.out), JSON.stringify({ badUrlGone, code: badUrl.code, out: badUrl.out.slice(-200) }));
        badUrl.close();
        // a guard port that cannot be bound is a reason to stop, with the way out (GRN-22: never run without the guard)
        const noBind = await rig({ args: ['--guard-port=70000'], noWait: true });
        const noBindGone = await noBind.exited(5000);
        check('GRN-22: a guard port that cannot be used → the bridge names the port and the --guard-port / GREENROOM_GUARD_PORT way out and exits non-zero', noBindGone && noBind.code !== 0 && /guard port/i.test(noBind.out) && /GREENROOM_GUARD_PORT/.test(noBind.out), JSON.stringify({ code: noBind.code, out: noBind.out.slice(-250) }));
        noBind.close();

        // the guard: a program that holds the port and says nothing, and takeover by a newer build (GRN-22, GRN-110)
        const foreign = createServer((s) => s.on('error', () => {}));
        await new Promise((res) => foreign.listen(0, '127.0.0.1', res));
        const fp = foreign.address().port;
        const d = await rig({ guardPort: fp, noWait: true });
        const dGone = await d.exited(6000);
        check('GRN-22: a guard port held by a program that sends no banner → the bridge says so and exits non-zero (it never runs without the guard)', dGone && d.code !== 0 && /another program|older than this release/i.test(d.out), JSON.stringify({ code: d.code, out: d.out.slice(-200) }));
        foreign.close(); d.close();
        // a holder that is on its way out (it drops the first connection without a banner and frees the port): the bridge looks again and takes it
        const leaving = createServer((s) => { s.destroy(); setTimeout(() => leaving.close(), 150); });
        await new Promise((res) => leaving.listen(0, '127.0.0.1', res));
        const lp = leaving.address().port;
        const lv = await rig({ guardPort: lp, noWait: true });
        const lvUp = await until(() => /Connected to Streamer.bot/.test(lv.out), 8000);
        check('GRN-110: a guard holder that drops the connection without a banner and then frees the port (another build asked it to quit) is not mistaken for a foreign program: the bridge takes the port and runs', lvUp && lv.code === null, JSON.stringify({ code: lv.code, out: lv.out.slice(-250) }));
        lv.close(); try { leaving.close(); } catch { /* closed */ }
        const old = await rig({ env: { GREENROOM_BRIDGE_VERSION: '1.0.9' } });
        const neu = await rig({ sb: old.sb, guardPort: old.guardPort, env: { GREENROOM_BRIDGE_VERSION: '1.0.10' }, noWait: true });
        const oldGone = await old.exited(8000);
        const neuUp = await until(() => /Connected to Streamer.bot/.test(neu.out), 8000);
        check('GRN-110: a newer build (1.0.10) replaces an older one (1.0.9: numeric, not text order): the old one quits cleanly and the new one runs', oldGone && old.code === 0 && neuUp && neu.code === null && /taking over|replac/i.test(neu.out), JSON.stringify({ oldGone, oldCode: old.code, neuCode: neu.code, out: neu.out.slice(-200) }));
        const same = await rig({ sb: old.sb, guardPort: old.guardPort, env: { GREENROOM_BRIDGE_VERSION: '1.0.9' }, noWait: true });
        const sameGone = await same.exited(6000);
        check('GRN-110: a build that is older than the one running exits 0 and says so; the running one is left alone', sameGone && same.code === 0 && neu.code === null && /already running|newer|same version/i.test(same.out), JSON.stringify({ sameGone, code: same.code, out: same.out.slice(-200) }));
        const equal = await rig({ sb: old.sb, guardPort: old.guardPort, env: { GREENROOM_BRIDGE_VERSION: '1.0.10' }, noWait: true });
        const equalGone = await equal.exited(6000);
        check('GRN-110: a build of the SAME version as the one running exits 0 and says so (a double launch is harmless)', equalGone && equal.code === 0 && neu.code === null && /already running/i.test(equal.out), JSON.stringify({ equalGone, code: equal.code }));
        old.close(); neu.close(); same.close(); equal.close();
        // two newer builds start at once: one takes over, the other finds it running and exits 0 (it does not tell the user to kill node.exe)
        const holder = await rig({ env: { GREENROOM_BRIDGE_VERSION: '1.0.1' } });
        const [n1, n2] = await Promise.all([
          rig({ sb: holder.sb, guardPort: holder.guardPort, env: { GREENROOM_BRIDGE_VERSION: '1.0.10' }, noWait: true }),
          rig({ sb: holder.sb, guardPort: holder.guardPort, env: { GREENROOM_BRIDGE_VERSION: '1.0.11' }, noWait: true }),
        ]);
        await holder.exited(8000);
        await nap(9000);
        const alive = [n1, n2].filter((x) => x.code === null).length;
        const losers = [n1, n2].filter((x) => x.code !== null);
        check('GRN-110: two newer builds racing for the same older holder: exactly one runs, the other exits 0 with "already running" (not 1 with advice to kill node.exe)', holder.code === 0 && alive === 1 && losers.length === 1 && losers[0].code === 0 && /already running|asked this one/i.test(losers[0].out), JSON.stringify({ holder: holder.code, alive, losers: losers.map((x) => [x.code, x.out.slice(-120)]) }));
        holder.close(); n1.close(); n2.close();
        // a peer that keeps writing is dropped when the guard's 1 s are up (an absolute lifetime, not only an idle timeout)
        const lifeRig = await rig();
        const dropped = await new Promise((res) => {
          const s = connectTcp(lifeRig.guardPort); let t0 = Date.now(); s.on('error', () => {}); s.on('close', () => res(Date.now() - t0));
          s.on('connect', () => { t0 = Date.now(); const iv = setInterval(() => { try { s.write('x'); } catch { /* gone */ } }, 250); s.on('close', () => clearInterval(iv)); });
          setTimeout(() => { s.destroy(); res(99999); }, 4000);
        });
        check('GRN-105: a peer on the guard port that keeps writing is dropped about 1 s after it connected', dropped < 2200, String(dropped));
        lifeRig.close();

        // command-line arguments win over the environment, and the guard port is the one asked for (GRN-142)
        const sbArg = await startMockWith({});
        const e = await rig({ sb: sbArg, env: { SB_WS_URL: 'ws://127.0.0.1:1/', GREENROOM_EXIT_ON_SB_CLOSE: '0', GREENROOM_SB_EXIT_GRACE_MS: '400' }, args: [`--sb-ws-url=${sbArg.url}`, '--exit-on-sb-close=1'] });
        check('GRN-142: --sb-ws-url= wins over SB_WS_URL (the bridge reaches the mock named by the argument)', !!e.got[0]);
        sbArg.child.kill();
        const eGone = await e.exited(6000);
        check('GRN-142: --exit-on-sb-close=1 wins over GREENROOM_EXIT_ON_SB_CLOSE=0', eGone && e.code === 0, JSON.stringify({ eGone, code: e.code }));
        e.close();
        const busy = createServer((s) => s.on('error', () => {}));
        await new Promise((res) => busy.listen(0, '127.0.0.1', res));
        const freeGuard = await freePort();
        const g = await rig({ guardPort: busy.address().port, args: [`--guard-port=${freeGuard}`] });
        check('GRN-142: --guard-port= wins over GREENROOM_GUARD_PORT (the bridge runs although the environment names a busy port)', g.code === null && !!g.got[0]);
        busy.close(); g.close();

        // exit-on-SB-close: SB back before the grace ends (GRN-180)
        const sbE = await startMockWith({});
        const h = await rig({ sb: sbE, env: { GREENROOM_EXIT_ON_SB_CLOSE: '1', GREENROOM_SB_EXIT_GRACE_MS: '2500' } });
        sbE.child.kill();
        await nap(1000);
        const sbBack = await startChild('mock-sb-server.mjs', '[mock] READY', { SB_HTTP_PORT: String(sbE.httpPort), SB_WS_PORT: String(sbE.wsPort) });
        await nap(4200);
        check('GRN-180: Streamer.bot back inside the grace window (grace 2.5 s, up again at about 1.5 s) is found by the quick retries (about every 750 ms) and cancels the shutdown: it does not take the last attempt, and no new countdown is logged',
          h.code === null && /cancelling shutdown/i.test(h.out) && !/last attempt/i.test(h.out) && (h.out.match(/will leave voice and exit/g) || []).length === 1, JSON.stringify({ code: h.code, out: h.out.slice(-350) }));
        h.close(); try { sbBack.kill(); } catch {}

        // a flap: Streamer.bot drops, returns, and drops AGAIN inside the same grace window (GRN-171). The return cancelled the first countdown,
        // so the second drop starts its own: the process must outlive the end of the FIRST countdown and leave only after the second one.
        {
          const GR = 4000;
          const sbF = await startMockWith({});
          const hf = await rig({ sb: sbF, env: { GREENROOM_EXIT_ON_SB_CLOSE: '1', GREENROOM_SB_EXIT_GRACE_MS: String(GR) } });
          const t0 = Date.now();
          sbF.child.kill();
          await nap(300);
          const sbF2 = await startChild('mock-sb-server.mjs', '[mock] READY', { SB_HTTP_PORT: String(sbF.httpPort), SB_WS_PORT: String(sbF.wsPort) });
          const returned = await until(() => /cancelling shutdown/i.test(hf.out), 2500);
          sbF2.kill(); // the second drop, well inside the first window
          const t1 = Date.now();
          await nap(Math.max(0, t0 + GR + 500 - Date.now())); // just past where the first countdown would have ended
          const alive = hf.code === null;
          const gone = await hf.exited(GR + 3500);
          const exitAt = Date.now();
          // A countdown that runs out does not end the process at once: the bridge makes one last attempt (1 s) and the shutdown takes at least 300 ms. So a first
          // countdown that was NOT cancelled would end the process at about t0 + GR + 1.3 s, i.e. only GR + 0.5 s after the second drop; the real one leaves
          // GR + 1.3 s after the second drop, and has made ONE last attempt (the second countdown's).
          const lastAttempts = (hf.out.match(/last attempt/gi) || []).length;
          check('GRN-171: Streamer.bot drops, returns and drops again inside one grace window: the return cancels the first countdown (logged), the process leaves only GR + the last attempt + the shutdown floor after the SECOND drop (not at the end of the first countdown), with two countdowns and one last attempt',
            returned && alive && gone && hf.code === 0 && (hf.out.match(/will leave voice and exit/g) || []).length === 2 && lastAttempts === 1 && exitAt - t1 >= GR + 900,
            JSON.stringify({ returned, alive, gone, code: hf.code, countdowns: (hf.out.match(/will leave voice and exit/g) || []).length, lastAttempts, afterSecondDrop: exitAt - t1 }));
          hf.close(); try { sbF2.kill(); } catch {}
        }
        // Streamer.bot unreachable from the start with exit-on-close on: the bridge never reached it, so there is nothing to leave "because it
        // closed": it stays up, keeps trying, and announces no shutdown (GRN-171)
        {
          const watcherSb = await startMockWith({}); // only for the rig's watcher; the bridge itself is pointed at a port nothing listens on
          const dead = await freePort();
          const u = await rig({ sb: watcherSb, noWait: true, env: { SB_WS_URL: `ws://127.0.0.1:${dead}/`, GREENROOM_EXIT_ON_SB_CLOSE: '1', GREENROOM_SB_EXIT_GRACE_MS: '1000' } });
          await nap(1000 + 300 + 3000 + 1200); // the grace, a reconnect tick and a margin
          check('GRN-171: exit-on-close on and Streamer.bot never reachable: the bridge is still running after the grace time and a reconnect tick, and has not announced a shutdown',
            u.code === null && !/will leave voice and exit/.test(u.out), JSON.stringify({ code: u.code, out: u.out.slice(-250) }));
          u.close();
        }

        // Connect, Reset auth and Stop during a gateway dial (GRN-76, GRN-130) against a mock Discord
        const gwConns = [];
        const gwHello = { ms: 0 }; // how long the mock gateway waits before it greets a connection
        let gwN = 0;
        // connection 1 is refused after 1.5 s; later ones complete the login
        const gateway = new WebSocketServer({
          port: 0, host: '127.0.0.1',
          verifyClient: (info, cb) => {
            const idx = ++gwN;
            if (idx === 1) setTimeout(() => cb(false, 503, 'down'), 1500); else cb(true);
          },
        });
        gateway.on('connection', (ws) => {
          const rec = { closed: false, identified: false }; gwConns.push(rec);
          ws.on('close', () => { rec.closed = true; }); ws.on('error', () => {});
          const hello = () => { try { ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } })); } catch { /* gone */ } };
          setTimeout(hello, gwHello.ms);
          ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch { return; }
            if (m.op === 1) ws.send(JSON.stringify({ op: 11 }));
            if (m.op === 2) {
              rec.identified = true;
              ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { v: 10, user: { id: '1000', username: 'mockbot', discriminator: '0', avatar: null, bot: true }, guilds: [], session_id: 'mock', resume_gateway_url: `ws://127.0.0.1:${gateway.address().port}`, application: { id: '1000', flags: 0 } } }));
            }
          });
        });
        await new Promise((res) => gateway.once('listening', res));
        const gwPort = gateway.address().port;
        const restHttp = createHttp((req, res) => { res.setHeader('content-type', 'application/json'); res.end(/gateway\/bot/.test(req.url) ? JSON.stringify({ url: `ws://127.0.0.1:${gwPort}`, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 1000, max_concurrency: 1 } }) : '{}'); });
        await new Promise((res) => restHttp.listen(0, '127.0.0.1', res));
        const api = `http://127.0.0.1:${restHttp.address().port}/api`;
        const dr = await rig({ token: 'AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCC', env: { DISCORD_BRIDGE_API: api } });
        dr.cmd('connect'); await nap(300);
        dr.cmd('connect'); // the first login is still dialing; this one replaces it and completes
        const up = await dr.waitFor((p) => p.connected === true, 6000);
        await nap(2600); // the first login is refused by now, 1.5 s after it started
        check('GRN-130: a login that fails AFTER it was replaced does not take the newer bot down (the bridge stays connected, no error shown)', !!up && dr.code === null && dr.last.connected === true && !(dr.last.rpc && dr.last.rpc.error), JSON.stringify({ up: !!up, connected: dr.last && dr.last.connected, err: dr.last && dr.last.rpc && dr.last.rpc.error, out: dr.out.slice(-200) }));
        dr.cmd('reset-auth'); await nap(1500);
        check('GRN-76/130: Reset auth on a connected bot leaves no session: offline, the gateway socket closed, the bridge alive', dr.code === null && dr.last.connected === false && gwConns.every((r) => r.closed), JSON.stringify({ connected: dr.last.connected, closed: gwConns.map((r) => r.closed) }));
        // Stop during the dial: Connect, then Reset auth before the gateway has said hello. The login finishes later and is closed then.
        await writeFile(dr.env.DISCORD_BRIDGE_TOKENS, JSON.stringify({ botToken: 'AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCC', enabled: false })); // Reset auth forgot the token: the next Connect reads the file again
        const connectedBefore = dr.got.filter((p) => p.connected === true).length;
        const connsBefore = gwConns.length;
        gwHello.ms = 1500;
        dr.cmd('connect'); await nap(300);
        dr.cmd('reset-auth');
        await nap(3600);
        const newConns = gwConns.slice(connsBefore);
        check('GRN-130: Connect then Reset auth during a gateway dial: no crash, the bridge never shows connected, and the session that finished dialing afterwards is closed (no logged-in session left)',
          dr.code === null && dr.got.filter((p) => p.connected === true).length === connectedBefore && newConns.length >= 1 && newConns.every((r) => r.closed), JSON.stringify({ code: dr.code, conns: newConns.length, closed: newConns.map((r) => r.closed) }));
        dr.close();
        await new Promise((res) => gateway.close(res)); restHttp.close();

        // A gateway that drops a logged-in bot and makes it re-dial; Connect or Reset auth while the re-dial is in flight (GRN-76, GRN-130).
        // The login has settled by then, so the client is destroyed at once: its re-dial must neither crash the bridge when it fails nor
        // bring a hidden session back when it succeeds.
        for (const endWith of ['fail', 'ok']) {
          let dials = 0;
          const ops = []; // { op, at } for every IDENTIFY (2) or RESUME (6) the bridge's bot sends
          const fg = new WebSocketServer({
            port: 0, host: '127.0.0.1',
            verifyClient: (info, cb) => { const i = ++dials; if (i === 1) return cb(true); setTimeout(() => (endWith === 'fail' ? cb(false, 503, 'down') : cb(true)), 2500); },
          });
          fg.on('connection', (ws) => {
            const idx = dials; ws.on('error', () => {});
            try { ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } })); } catch { /* gone */ }
            ws.on('message', (raw) => {
              let m; try { m = JSON.parse(raw.toString()); } catch { return; }
              if (m.op === 1) ws.send(JSON.stringify({ op: 11 }));
              if (m.op === 2 || m.op === 6) {
                ops.push({ op: m.op, at: Date.now() });
                const port = fg.address().port;
                ws.send(JSON.stringify(m.op === 2
                  ? { op: 0, t: 'READY', s: 1, d: { v: 10, user: { id: '1000', username: 'mockbot', discriminator: '0', avatar: null, bot: true }, guilds: [], session_id: 'mock', resume_gateway_url: `ws://127.0.0.1:${port}`, application: { id: '1000', flags: 0 } } }
                  : { op: 0, t: 'RESUMED', s: 2, d: {} }));
                if (idx === 1) setTimeout(() => { try { ws.close(4000, 'flaky'); } catch { /* gone */ } }, 1200);
              }
            });
          });
          await new Promise((res) => fg.once('listening', res));
          const fgPort = fg.address().port;
          const fr = createHttp((req, res) => { res.setHeader('content-type', 'application/json'); res.end(/gateway\/bot/.test(req.url) ? JSON.stringify({ url: `ws://127.0.0.1:${fgPort}`, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 1000, max_concurrency: 1 } }) : '{}'); });
          await new Promise((res) => fr.listen(0, '127.0.0.1', res));
          const fx = await rig({ token: 'AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCC', env: { DISCORD_BRIDGE_API: `http://127.0.0.1:${fr.address().port}/api` } });
          fx.cmd('connect');
          await fx.waitFor((p) => p.connected === true, 6000);
          await until(() => dials >= 2, 6000); // the gateway dropped the bot and the shard is re-dialing (held 2.5 s)
          await nap(400);
          const tStop = Date.now();
          fx.cmd('reset-auth');
          await nap(endWith === 'fail' ? 4200 : 5200);
          const late = ops.filter((o) => o.at > tStop);
          check('GRN-76: Reset auth while a dropped bot re-dials (' + (endWith === 'fail' ? 'the dial then fails' : 'the dial then succeeds') + '): the bridge does not crash' + (endWith === 'ok' ? ' and no IDENTIFY or RESUME reaches the gateway afterwards (no hidden session)' : ''),
            fx.code === null && !/Bridge crashed/.test(JSON.stringify(fx.last && fx.last.rpc)) && (endWith === 'fail' || late.length === 0), JSON.stringify({ code: fx.code, late: late.length, dials, out: fx.out.slice(-200) }));
          fx.close();
          await new Promise((res) => fg.close(res)); fr.close();
        }

        // ── 8c. the voice target is checked before the working channel is left (Sprint 13a) ──
        // The mock Discord (mockDiscord, above) identifies, lists one guild in READY and dispatches GUILD_CREATE (voice, text, Stage, locked
        // and full channels, the bot's own member, one member and some guests already in voice) and, on request, VOICE_STATE_UPDATE: all
        // through the REAL discord.js handlers. The bridge dials it through DISCORD_BRIDGE_API (loopback only). Sprint 13b's cases run on it too.
        console.log('\n[8c] voice target: validate before leaving the working channel, Stage, full, removed favorite, guests, avatars');
        {
          const { GUILD, ME, VIEW, CONNECT, SPEAK, userOf, memberOf, vstate, chan } = DF;
          const guildCreate = () => ({
            id: GUILD, name: 'Mock Guild', icon: null, owner_id: '2000', afk_timeout: 300, verification_level: 0, default_message_notifications: 0, explicit_content_filter: 0,
            roles: [{ id: GUILD, name: '@everyone', permissions: String(VIEW | CONNECT | SPEAK), position: 0, color: 0, hoist: false, managed: false, mentionable: false }],
            emojis: [], features: [], mfa_level: 0, system_channel_id: null, premium_tier: 0, premium_subscription_count: 0, preferred_locale: 'en-US', nsfw_level: 0,
            large: false, unavailable: false, member_count: 2, joined_at: '2020-01-01T00:00:00.000000+00:00', threads: [], stage_instances: [], guild_scheduled_events: [], presences: [],
            channels: [chan('910', 2, 'voice-ok', 0), chan('911', 0, 'text', 1), chan('912', 13, 'stage', 2), chan('913', 2, 'locked', 3, [{ id: GUILD, type: 0, allow: '0', deny: String(VIEW | CONNECT) }]), chan('914', 2, 'second', 4), chan('915', 2, 'full', 5, [], 1)],
            members: [memberOf(ME, 'mockbot', { bot: true }), memberOf('2001', 'Alice')],
            // already in voice when the bridge joins: Alice (a member), two users that are not cached members (a guest and a bot) in the working channel,
            // and a guest in the channel whose user limit is 1
            voice_states: [vstate('2001', '910'), vstate('3004', '910'), vstate('3005', '910'), vstate('3003', '915')],
          });
          const md = await mockDiscord({ guild: guildCreate, users: { 3004: userOf('3004', 'latecomer', { global: 'Late Comer' }), 3005: userOf('3005', 'otherbot', { bot: true }) } });
          const token = 'AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCC';
          // These mock connections never get a voice server, so the stall watchdogs (Sprint 13b) are switched off here: [8d] tests them.
          const NO_WATCH = JSON.stringify({ notReadyMs: 0, stallWarnMs: 0, stallLostMs: 0 });
          const cfgGood = JSON.stringify({ favorites: [{ id: 'f914', name: 'second', serverId: GUILD, channelId: '914' }, { id: 'f914dup', name: 'dup', serverId: GUILD, channelId: '914' }], current: { serverId: GUILD, channelId: '910' }, settings: {} });
          const t = await rig({ token, cfgText: cfgGood, env: { DISCORD_BRIDGE_API: md.api, GREENROOM_REFUSAL_MS: '2500', GREENROOM_TIMING: NO_WATCH } });
          try {
            t.cmd('connect');
            const inGood = await t.waitFor((p) => p.connected === true && p.channelId === '910' && p.users['2001'], 8000);
            check('GRN-204 (harness): on the mock Discord the bot identifies, receives GUILD_CREATE through the real handlers and joins the saved channel with its roster (Alice)', !!inGood && inGood.users['2001'].username === 'Alice', JSON.stringify(inGood && Object.keys(inGood.users)));
            const late = await t.waitFor((p) => p.users['3004'] && p.users['3004'].username === 'Late Comer', 4000);
            await nap(300);
            check('GRN-210: a guest who is already in the working channel when the bridge joins (Discord keeps no member for them) is listed by the name Discord has for them, and a bot there is not listed', !!late && !t.last.users['3005'], JSON.stringify(t.last.users));
            const use = async (serverId, channelId, ms = 900) => { const m = t.got.length; t.cmd('set-current', JSON.stringify({ serverId, channelId })); await nap(ms); return t.got.slice(m).pop() || t.last; };
            const waitAfter = async (mark, pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = t.got.slice(mark).find(pred); if (hit) return hit; await nap(100); } return null; };
            const unchanged = (p) => p && p.current && p.current.serverId === GUILD && p.current.channelId === '910' && p.channelId === '910' && p.users['2001'] && p.users['2001'].username === 'Alice' && !!p.users['3004'];
            const savedCurrent = async () => JSON.parse(await readFile(t.env.DISCORD_BRIDGE_CONFIG, 'utf8')).current;
            const bads = [
              ['a guild the bot is not in', '999', '910', /isn.t in that server|unknown guild|not in/i],
              ['a text channel', GUILD, '911', /not a voice channel/i],
              ['a Stage channel', GUILD, '912', /regular voice channel/i],
              ['a channel the bot cannot join', GUILD, '913', /cannot join|Connect|View Channel/i],
              ['a channel that does not exist', GUILD, '999999', /not found|Unknown Channel/i],
              ['a channel that is full of guests (discord.js counts only cached members, the guest is not one)', GUILD, '915', /is full|user limit/i],
            ];
            for (const [what, sId, cId, msg] of bads) {
              const p = await use(sId, cId);
              const saved = await savedCurrent();
              check('GRN-204/80: USE on ' + what + ' is refused with a message, and the working channel, the roster and the saved current stay as they were',
                unchanged(p) && msg.test((p.rpc && p.rpc.error) || '') && saved.channelId === '910', JSON.stringify({ current: p && p.current, channelId: p && p.channelId, users: p && Object.keys(p.users || {}), err: p && p.rpc && p.rpc.error, saved }));
            }
            // A check that is still running when a newer USE finishes cannot overwrite it: the slow refusal of the older pick arrives late and is dropped.
            md.restDelay['/channels/999999'] = 1000;
            t.cmd('set-current', JSON.stringify({ serverId: GUILD, channelId: '999999' }));
            await nap(150);
            t.cmd('set-current', JSON.stringify({ serverId: GUILD, channelId: '914' }));
            await nap(2000);
            delete md.restDelay['/channels/999999'];
            const moved = t.last;
            const saved2 = await savedCurrent();
            check('GRN-204: USE on a valid channel is accepted: it becomes the current channel, is saved, the roster is that channel\'s (empty) and the old error is gone', !!moved.current && moved.current.channelId === '914' && moved.channelId === '914' && Object.keys(moved.users).length === 0 && !(moved.rpc && moved.rpc.error) && !!saved2 && saved2.channelId === '914', JSON.stringify({ current: moved.current, channelId: moved.channelId, saved2, err: moved.rpc && moved.rpc.error }));
            check('GRN-204: a slow check for an OLDER pick (finishing after a newer USE was accepted) is dropped: no stale error on the status line, the newer pick stays', !(moved.rpc && moved.rpc.error) && moved.current.channelId === '914', JSON.stringify(moved.rpc));
            // removing a duplicate of the active favorite does not make the bot leave; removing the last one does (GRN-153). (The duplicate is in the
            // config by hand: favorite-add no longer makes one, GRN-133.)
            const dupFav = (t.last.favorites || []).find((f) => f.name === 'dup');
            t.cmd('favorite-remove', JSON.stringify({ id: dupFav && dupFav.id })); await nap(900);
            const afterDup = t.last;
            check('GRN-153: removing a DUPLICATE of the current channel\'s favorite keeps the bot in the channel (another favorite still names it)', !!dupFav && !!afterDup.current && afterDup.current.channelId === '914' && afterDup.channelId === '914' && !afterDup.favorites.some((f) => f.name === 'dup') && afterDup.favorites.some((f) => f.id === 'f914'), JSON.stringify({ dupFav, current: afterDup.current, channelId: afterDup.channelId }));
            const stg = await use(GUILD, '912', 600);
            t.cmd('favorite-remove', JSON.stringify({ id: 'f914' })); await nap(900);
            const removed = t.last;
            const saved3 = await savedCurrent();
            check('GRN-153: removing the last favorite for the current channel clears the current channel and leaves voice, and the refusal that was on the status line is gone', /regular voice channel/.test((stg.rpc && stg.rpc.error) || '') && removed.current === null && removed.channelId === null && Object.keys(removed.users).length === 0 && !removed.favorites.some((f) => f.id === 'f914') && saved3 === null && !(removed.rpc && removed.rpc.error), JSON.stringify({ current: removed.current, channelId: removed.channelId, saved3, err: removed.rpc && removed.rpc.error }));
            // back to 910 for the roster cases
            const mkBack = t.got.length;
            t.cmd('set-current', JSON.stringify({ serverId: GUILD, channelId: '910' }));
            const back = await waitAfter(mkBack, (p) => p.channelId === '910' && p.users['2001'] && p.users['3004'], 5000);
            check('GRN-210: a guest named once (looked up) is on the roster again when the bridge joins the channel a second time', !!back && back.users['3004'].username === 'Late Comer', JSON.stringify(back && back.users));
            // a guest-invite user joins, mutes, is re-seeded, leaves, moves (GRN-210)
            const guestM = (x = {}) => memberOf('3001', 'guestuser', { guest: true, nick: 'GuestNick', global: 'Guest G', ...x });
            const mkGuest = t.got.length;
            md.dispatchAll('VOICE_STATE_UPDATE', vstate('3001', '910', { member: guestM() }));
            const guestIn = await waitAfter(mkGuest, (p) => p.users['3001'], 3000);
            check('GRN-210: a guest-invite user (no joined_at) who joins the working channel appears with their nickname, not muted', !!guestIn && guestIn.users['3001'].username === 'GuestNick' && guestIn.users['3001'].mute === false && guestIn.users['3001'].deaf === false, JSON.stringify(guestIn && guestIn.users['3001']));
            const mkMute = t.got.length;
            md.dispatchAll('VOICE_STATE_UPDATE', vstate('3001', '910', { selfMute: true, selfDeaf: true, member: guestM({ nick: 'RenamedGuest' }) }));
            const guestMuted = await waitAfter(mkMute, (p) => p.users['3001'] && p.users['3001'].mute === true, 3000);
            check('GRN-210: a guest who mutes and deafens (and changes their nickname) shows it: the roster\'s flags and name follow their voice state', !!guestMuted && guestMuted.users['3001'].deaf === true && guestMuted.users['3001'].username === 'RenamedGuest', JSON.stringify(guestMuted && guestMuted.users['3001']));
            const again = await use(GUILD, '910', 1100);
            check('GRN-210: a guest in the call stays on the roster, with their flags, when the bridge joins the channel again (USE on the channel it is already in)', !!again.users['3001'] && again.users['3001'].username === 'RenamedGuest' && again.users['3001'].mute === true && !!again.users['2001'] && !!again.users['3004'], JSON.stringify(again.users));
            await use(GUILD, '914', 600);
            const there = await use(GUILD, '910', 1100);
            check('GRN-210: …and after the bridge moved away and back', !!there.users['3001'] && !!there.users['2001'], JSON.stringify(Object.keys(there.users)));
            md.dispatchAll('VOICE_STATE_UPDATE', vstate('3001', null, { member: guestM() }));
            await nap(600);
            check('GRN-210: …and is removed when they leave', !!guestIn && !t.last.users['3001'] && !!t.last.users['2001'], JSON.stringify(Object.keys(t.last.users)));
            const mkRe = t.got.length;
            md.dispatchAll('VOICE_STATE_UPDATE', vstate('3001', '910', { member: guestM() }));
            await waitAfter(mkRe, (p) => p.users['3001'], 3000);
            md.dispatchAll('VOICE_STATE_UPDATE', vstate('3001', '914', { member: guestM() }));
            await nap(600);
            check('GRN-210: a guest who moves to another channel leaves the roster of the working channel', !t.last.users['3001'], JSON.stringify(Object.keys(t.last.users)));
            // a join and a leave in one read leave nobody behind
            const mem = (id, name, x = {}) => memberOf(id, name, x);
            md.dispatchBatch([
              ['VOICE_STATE_UPDATE', vstate('3006', '910', { member: mem('3006', 'blip', { guest: true, nick: 'Blip' }) })],
              ['VOICE_STATE_UPDATE', vstate('3006', null, { member: mem('3006', 'blip', { guest: true, nick: 'Blip' }) })],
              ['VOICE_STATE_UPDATE', vstate('2003', '910', { member: mem('2003', 'dave') })],
              ['VOICE_STATE_UPDATE', vstate('2003', null, { member: mem('2003', 'dave') })],
            ]);
            await nap(700);
            check('GRN-210: a join and a leave that arrive together (one read) leave nobody behind: no row for a guest or a member who is already gone', !t.last.users['3006'] && !t.last.users['2003'], JSON.stringify(Object.keys(t.last.users)));
            // a frame with no member object adds nothing
            md.dispatchAll('VOICE_STATE_UPDATE', vstate('4001', '910'));
            md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, '910'));
            await nap(600);
            check('GRN-210: a voice-state frame with no member object does not add a nameless row (an id nobody knows, the bot itself)', !t.last.users['4001'] && !t.last.users[ME], JSON.stringify(Object.keys(t.last.users)));
            // a bot member that joins the working channel is never listed (the frame's member says it is a bot); a human right after it is
            // (so the frames were processed), GRN-171 / mutant M82
            md.dispatchAll('VOICE_STATE_UPDATE', vstate('3007', '910', { member: mem('3007', 'helperbot', { bot: true }) }));
            md.dispatchAll('VOICE_STATE_UPDATE', vstate('2004', '910', { member: mem('2004', 'erin') }));
            const erin = await t.waitFor((p) => p.users['2004'], 3000);
            await nap(300);
            check('GRN-12/210: a bot that joins the working channel is not listed, and a human who joins right after it is', !!erin && !t.last.users['3007'] && !!t.last.users['2004'], JSON.stringify(Object.keys(t.last.users)));
            md.dispatchAll('VOICE_STATE_UPDATE', vstate('2004', null, { member: mem('2004', 'erin') })); // (and she leaves again: the cases below count on the roster as it was)
            await nap(400);
            // a member with a per-server avatar joins, a member departs (GRN-166)
            md.dispatchAll('VOICE_STATE_UPDATE', vstate('2002', '910', { member: memberOf('2002', 'carol', { global: 'Carol', guildAvatar: 'abc123def' }) }));
            const carol = await t.waitFor((p) => p.users['2002'] && /\/guilds\/900\//.test(p.users['2002'].avatarUrl), 3000) || t.last;
            check('GRN-166: a member with a per-server avatar shows it (the guild avatar path), not the account avatar', !!carol && !!carol.users['2002'] && /\/guilds\/900\/users\/2002\/avatars\/abc123def/.test(carol.users['2002'].avatarUrl), JSON.stringify(carol && carol.users['2002']));
            // a member who mutes or deafens themselves shows it (the voice state's self flags count, not only the server's), mutant M80
            md.dispatchAll('VOICE_STATE_UPDATE', vstate('2002', '910', { selfMute: true, member: memberOf('2002', 'carol', { global: 'Carol', guildAvatar: 'abc123def' }) }));
            const carolMuted = await t.waitFor((p) => p.users['2002'] && p.users['2002'].mute === true && p.users['2002'].deaf === false, 3000);
            md.dispatchAll('VOICE_STATE_UPDATE', vstate('2002', '910', { selfMute: true, selfDeaf: true, member: memberOf('2002', 'carol', { global: 'Carol', guildAvatar: 'abc123def' }) }));
            const carolDeaf = await t.waitFor((p) => p.users['2002'] && p.users['2002'].deaf === true, 3000);
            check('GRN-12/210 (M80): a member who mutes, then deafens, themselves shows mute, then deaf, in the roster', !!carolMuted && !!carolDeaf, JSON.stringify(t.last.users['2002']));
            md.dispatchAll('VOICE_STATE_UPDATE', vstate('2001', '914'));
            await nap(600);
            check('GRN-210: a member who moves to another channel leaves the roster of the working channel', !t.last.users['2001'] && !!t.last.users['2002'], JSON.stringify(Object.keys(t.last.users)));
            // only a member of the working channel gets a speaking flag (GRN-12): not an id nobody knows, not the bot, not a member who has left
            for (const id of ['9999999', ME, '2001']) { t.cmd('test-speaking', id); await nap(250); }
            t.cmd('test-speaking', '2002'); t.cmd('test-speaking', '3004');
            const spk = await t.waitFor((p) => p.users['2002'] && p.users['2002'].speaking === true && p.users['3004'] && p.users['3004'].speaking === true, 3000);
            check('GRN-12: a speaking event for an id that is not in the roster (unknown, the bot itself, a member who has left) adds no row; one for a member or a guest in the call sets the flag', !t.last.users['9999999'] && !t.last.users[ME] && !t.last.users['2001'] && !!spk, JSON.stringify(t.last.users));
            // a refusal does not stay on the status line for the rest of the stream
            const refused = await use(GUILD, '912', 600);
            await nap(2700);
            check('GRN-204: a refusal is shown for a while and then clears (the bot is still working in its channel, so the status is not left red for the rest of the stream)', /regular voice channel/.test((refused.rpc && refused.rpc.error) || '') && !(t.last.rpc && t.last.rpc.error) && t.last.channelId === '910', JSON.stringify({ shown: refused.rpc, now: t.last.rpc, channelId: t.last.channelId }));
            // a config file that cannot be written (GRN-68): the pick is used all the same and the sticky warning says it is not kept
            await rm(t.env.DISCORD_BRIDGE_CONFIG, { force: true });
            await mkdir(t.env.DISCORD_BRIDGE_CONFIG);
            const failed = await use(GUILD, '914', 2500);
            check('GRN-68: if the config cannot be saved the pick is used all the same (the bot moves) and rpc.configWarning says the change is not kept after a restart', !!failed.current && failed.current.channelId === '914' && failed.channelId === '914' && /could not save discord-voice-config\.json/i.test((failed.rpc && failed.rpc.configWarning) || ''), JSON.stringify({ current: failed.current, channelId: failed.channelId, warn: failed.rpc && failed.rpc.configWarning, err: failed.rpc && failed.rpc.error }));
            await rm(t.env.DISCORD_BRIDGE_CONFIG, { recursive: true, force: true });
            const saved4 = await use(GUILD, '910', 1100);
            check('GRN-68: …and the next pick is saved once the file can be written, and the warning goes', saved4.current.channelId === '910' && saved4.channelId === '910' && !(saved4.rpc && saved4.rpc.configWarning) && (await savedCurrent()).channelId === '910', JSON.stringify({ current: saved4.current, channelId: saved4.channelId, warn: saved4.rpc && saved4.rpc.configWarning }));
            t.close();
            // offline: a pick made while the bot is offline keeps the message that says why it is offline
            const off = await rig();
            off.cmd('connect');
            await off.waitFor((p) => /No bot token/.test((p.rpc && p.rpc.error) || ''), 4000);
            off.cmd('set-current', JSON.stringify({ serverId: GUILD, channelId: '914' })); await nap(700);
            check('GRN-204: an offline USE saves the pick and leaves the reason the bot is offline on the status line (it is not erased)', !!off.last.current && off.last.current.channelId === '914' && /No bot token/.test((off.last.rpc && off.last.rpc.error) || ''), JSON.stringify({ current: off.last.current, err: off.last.rpc && off.last.rpc.error }));
            off.close();
            // a saved channel that fails its check at login is not joined, is marked, and a cleared channel clears the mark
            const lg = await rig({ token, cfgText: JSON.stringify({ favorites: [], current: { serverId: GUILD, channelId: '912' }, settings: {} }), env: { DISCORD_BRIDGE_API: md.api, GREENROOM_REFUSAL_MS: '1000', GREENROOM_TIMING: NO_WATCH } });
            lg.cmd('connect');
            const refusedAtLogin = await lg.waitFor((p) => p.connected === true && /regular voice channel/.test((p.rpc && p.rpc.error) || ''), 8000);
            check('GRN-204: a saved channel that fails its check at login (a Stage) is not joined; it stays the saved pick but is marked currentRefused', !!refusedAtLogin && refusedAtLogin.current.channelId === '912' && refusedAtLogin.channelId === null && refusedAtLogin.currentRefused === true, JSON.stringify(refusedAtLogin && { current: refusedAtLogin.current, channelId: refusedAtLogin.channelId, currentRefused: refusedAtLogin.currentRefused }));
            await nap(1600);
            check('GRN-204: …and unlike the refusal of a USE (which clears after a while), the reason stays on the status line for as long as the saved pick is refused', lg.last.currentRefused === true && /regular voice channel/.test((lg.last.rpc && lg.last.rpc.error) || ''), JSON.stringify({ currentRefused: lg.last.currentRefused, err: lg.last.rpc && lg.last.rpc.error }));
            lg.cmd('set-current', JSON.stringify({ serverId: '', channelId: '' })); await nap(800);
            check('GRN-204: clearing the channel clears that pick and the mark', lg.last.current === null && lg.last.currentRefused === false, JSON.stringify({ current: lg.last.current, currentRefused: lg.last.currentRefused }));
            lg.cmd('set-current', JSON.stringify({ serverId: GUILD, channelId: '910' }));
            const joined = await lg.waitFor((p) => p.channelId === '910' && p.users['2001'], 5000);
            check('GRN-204: …and a good pick after that joins', !!joined && joined.currentRefused === false, JSON.stringify(joined && Object.keys(joined.users)));
            lg.close();
          } finally {
            t.close();
            await md.close();
          }
        }
        // ── 8d. the voice lifecycle and the login (Sprint 13b) ──
        // Every case runs the REAL bridge (real discord.js, real @discordjs/voice VoiceConnection) on the mock Discord. The mock has no voice
        // server, so a voice connection never reaches Ready by itself: the test hooks (GREENROOM_TEST_HOOKS=1, `test-voice`) move the real
        // connection through its real state setter, exactly as the library's networking would, and `GREENROOM_TIMING` shortens the timers.
        console.log('\n[8d] voice lifecycle: drop and rejoin, park after a kick, moves, resume, re-identify, 4004, guildAvailable, stall, late Ready, superseded client, login retry');
        {
          const { GUILD, ME, VIEW, CONNECT, SPEAK, userOf, memberOf, vstate, chan } = DF;
          const where = { 2001: '910', 2002: '914', [ME]: null }; // who is in which voice channel right now (the mock's truth)
          const guildNow = () => ({
            id: GUILD, name: 'Mock Guild', icon: null, owner_id: '2000', afk_timeout: 300, verification_level: 0, default_message_notifications: 0, explicit_content_filter: 0,
            roles: [{ id: GUILD, name: '@everyone', permissions: String(VIEW | CONNECT | SPEAK), position: 0, color: 0, hoist: false, managed: false, mentionable: false }],
            emojis: [], features: [], mfa_level: 0, system_channel_id: null, premium_tier: 0, premium_subscription_count: 0, preferred_locale: 'en-US', nsfw_level: 0,
            large: false, unavailable: false, member_count: 3, joined_at: '2020-01-01T00:00:00.000000+00:00', threads: [], stage_instances: [], guild_scheduled_events: [], presences: [],
            channels: [chan('910', 2, 'main', 0), chan('914', 2, 'second', 1), chan('912', 13, 'stage', 2), chan('916', 2, 'capped', 3, [], 2)],
            members: [memberOf(ME, 'mockbot', { bot: true }), memberOf('2001', 'Alice'), memberOf('2002', 'Bob'), memberOf('2003', 'Carol')],
            voice_states: Object.entries(where).filter(([, c]) => c).map(([u, c]) => vstate(u, c)),
          });
          const md = await mockDiscord({ guild: guildNow, users: {} });
          const token = 'AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCC';
          const cur = (channelId = '910') => JSON.stringify({ favorites: [], current: channelId ? { serverId: GUILD, channelId } : null, settings: {} });
          const OFF = { notReadyMs: 0, stallWarnMs: 0, stallLostMs: 0, backoffMs: [200, 300], disconnectRaceMs: 300, sessionDropMs: 200, loginStartMs: 250, loginCapMs: 500, speakingStaleMs: 0, stuckGlowMs: 0 };
          const mk = async (timing = {}, o = {}) => {
            const t = await rig({ token, cfgText: o.cfg !== undefined ? o.cfg : cur(), env: { DISCORD_BRIDGE_API: md.api, GREENROOM_TIMING: JSON.stringify({ ...OFF, ...timing }) } });
            if (!o.noConnect) {
              t.cmd('connect');
              if (o.waitJoin !== false) await t.waitFor((p) => p.connected === true && p.channelId === '910' && p.users['2001'], 8000);
            }
            return t;
          };
          const vc = (t, o) => t.cmd('test-voice', JSON.stringify(o));
          const wa = async (t, mark, pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = t.got.slice(mark).find(pred); if (hit) return hit; await nap(50); } return null; };
          const ready = async (t) => { const m = t.got.length; vc(t, { do: 'state', status: 'ready' }); return wa(t, m, (p) => p.hostInChannel === true, 3000); };
          const err = (p) => (p && p.rpc && p.rpc.error) || '';
          const mkSock = () => md.ops4.length;
          try {
            // ── an exit while in voice leaves the channel first (GRN-171, mutant M41: the exit-on-close path is this same shutdown) ──
            for (const how of ['quit', 'SIGINT']) {
              const t = await mk();
              await ready(t);
              const o0 = mkSock();
              if (how === 'quit') t.cmd('quit'); else t.cmd('test-signal', 'SIGINT');
              const gone = await t.exited(6000);
              const leaves = md.ops4.slice(o0).filter((d) => d.channel_id === null);
              check(`GRN-171/129: ${how} while in a voice channel: the bot tells Discord to leave it (op 4 with the channel null) before the process ends with code 0`,
                gone && t.code === 0 && leaves.length >= 1, JSON.stringify({ gone, code: t.code, ops4: md.ops4.slice(o0), out: t.out.slice(-200) }));
              t.close();
            }
            // ── a stall, the loss, the backoff and the rejoin (GRN-141, GRN-49, GRN-53) ──
            {
              const t = await mk({ stallWarnMs: 400, stallLostMs: 1100, backoffMs: [300, 700] });
              const up = await ready(t);
              check('GRN-53 (harness): the real VoiceConnection is moved to Ready: hostInChannel is true, the status line is empty and the roster is the channel\'s', !!up && !err(up) && !!up.users['2001'], JSON.stringify(up && { h: up.hostInChannel, e: err(up) }));
              const m0 = t.got.length, o0 = mkSock();
              vc(t, { do: 'close', code: 4006 });
              const warn = await wa(t, m0, (p) => p.hostInChannel === false && /reconnecting/i.test(err(p)), 2500);
              check('GRN-141: a connection that stays outside Ready for the warn time (about 10 s) shows "reconnecting" and hostInChannel false, and keeps the roster (it does not give up yet)', !!warn && warn.channelId === '910' && !!warn.users['2001'], JSON.stringify(warn && { c: warn.channelId, e: err(warn) }));
              const lost = await wa(t, m0, (p) => p.channelId === null && /rejoining/i.test(err(p)), 3000);
              check('GRN-49/141: …after the loss time (about 30 s) the connection is dropped: no channel, an empty roster, "Voice connection lost, rejoining…"', !!lost && Object.keys(lost.users).length === 0 && lost.current && lost.current.channelId === '910', JSON.stringify(lost && { c: lost.channelId, u: Object.keys(lost.users), e: err(lost) }));
              const back = await wa(t, m0, (p) => p.channelId === '910' && p.users['2001'] && lost && t.got.indexOf(p) > t.got.indexOf(lost), 4000);
              check('GRN-49: …and the bridge rejoins by itself after the backoff, with the roster back, and asked Discord to join (op 4)', !!back && md.ops4.slice(o0).filter((d) => d.channel_id === '910').length >= 2, JSON.stringify({ ops4: md.ops4.slice(o0) }));
              const up2 = await ready(t);
              check('GRN-53: …Ready on the new connection clears the message and sets hostInChannel', !!up2 && !err(up2), JSON.stringify(up2 && err(up2)));
              const oReady = md.ops4.length;
              await nap(1600);
              check('GRN-49: …and nothing rejoins after that (one connection, no more joins)', t.last.channelId === '910' && t.last.hostInChannel === true && md.ops4.length === oReady, JSON.stringify({ ops4: md.ops4.length - oReady }));
              // Ready resets the backoff: a second loss starts at the first step again, not at the second
              const mLoss = t.out.length;
              vc(t, { do: 'close', code: 4006 });
              await until(() => /rejoin in/.test(t.out.slice(mLoss)), 4000);
              check('GRN-49: …Ready resets the backoff: after a second loss the first rejoin is again the FIRST step (300 ms), not the next (700 ms)', /rejoin in 300ms/.test(t.out.slice(mLoss)) && !/rejoin in 700ms/.test(t.out.slice(mLoss)), t.out.slice(mLoss).split('\n').filter((l) => /rejoin in/.test(l)).join('|'));
              t.close();
            }
            // ── the backoff steps ──
            {
              const t = await mk({ stallLostMs: 400, backoffMs: [250, 500] }, {});
              await nap(3200);
              const steps = [...t.out.matchAll(/rejoin in (\d+)ms/g)].map((x) => Number(x[1]));
              check('GRN-49: a connection that never gets Ready is retried with the backoff steps (250, then 500, then 500 ms here), one at a time', steps.length >= 3 && steps[0] === 250 && steps[1] === 500 && steps[2] === 500, JSON.stringify(steps));
              t.close();
            }
            // ── a kick parks the bridge; USE and Connect bring it back (GRN-49) ──
            {
              const t = await mk({ sessionDropMs: 100 });
              await ready(t);
              await nap(400);
              const o0 = mkSock(), m0 = t.got.length;
              vc(t, { do: 'close', code: 4014 });
              const parked = await wa(t, m0, (p) => p.channelId === null && /Removed from voice \(.*4014.*\).*USE/i.test(err(p)), 3000);
              check('GRN-49: a close with code 4014 (removed from the call) is not retried: "Removed from voice (…), press USE to rejoin", no channel, empty roster', !!parked && Object.keys(parked.users).length === 0, JSON.stringify(parked && { c: parked.channelId, e: err(parked) }));
              await nap(1500);
              check('GRN-49: …and nothing rejoins on its own while it is parked (no join is sent: only the leave of the destroyed connection)', t.last.channelId === null && !md.ops4.slice(o0).some((d) => d.channel_id) && /Removed from voice/.test(err(t.last)), JSON.stringify({ ops4: md.ops4.slice(o0), c: t.last.channelId }));
              // every path that could bring it back on its own respects the parked state: a gateway resume, a server that becomes available
              const r0 = md.resumes, o1 = mkSock();
              md.dropAll(4000);
              await until(() => md.resumes > r0, 8000);
              md.dispatchAll('GUILD_DELETE', { id: GUILD, unavailable: true });
              await nap(100);
              md.dispatchAll('GUILD_CREATE', guildNow());
              await nap(700);
              check('GRN-49: …not even when the gateway resumes or the server becomes available again (every path that rejoins respects the parked state)', t.last.channelId === null && /Removed from voice/.test(err(t.last)) && !md.ops4.slice(o1).some((d) => d.channel_id), JSON.stringify({ ops4: md.ops4.slice(o1), c: t.last.channelId }));
              const m1 = t.got.length;
              t.cmd('set-current', JSON.stringify({ serverId: GUILD, channelId: '910' }));
              const used = await wa(t, m1, (p) => p.channelId === '910' && p.users['2001'], 4000);
              check('GRN-49: USE on the channel brings it back from the parked state', !!used && !/Removed/.test(err(used)), JSON.stringify(used && err(used)));
              await ready(t); await nap(400);
              const m2 = t.got.length;
              // (@discordjs/voice turns only a 4014 into a Disconnected state; for 4021 (rate limited) and 4022 (call terminated) it would re-signal
              // at once, so the bridge catches the close code where the library does, and parks)
              const o2 = mkSock();
              vc(t, { do: 'close', code: 4021 });
              const parked2 = await wa(t, m2, (p) => p.channelId === null && /Removed from voice \(.*4021/i.test(err(p)), 3000);
              await nap(700);
              check('GRN-49: a voice close with code 4021 (rate limited) parks too: no immediate rejoin by the library or by the backoff', !!parked2 && !md.ops4.slice(o2).some((d) => d.channel_id), JSON.stringify({ parked2: !!parked2, ops4: md.ops4.slice(o2) }));
              t.cmd('connect');
              const conn2 = await wa(t, m2, (p) => p.connected === true && p.channelId === '910' && p.users['2001'] && !/Removed/.test(err(p)), 8000);
              check('GRN-49: …and Connect brings it back', !!conn2, JSON.stringify({ conn2: !!conn2 }));
              await ready(t); await nap(400);
              const m3 = t.got.length;
              vc(t, { do: 'close', code: 4022 });
              const parked3 = await wa(t, m3, (p) => p.channelId === null && /Removed from voice \(.*4022/i.test(err(p)), 3000);
              check('GRN-49: a voice close with code 4022 (call terminated) parks as well', !!parked3, JSON.stringify(parked3 && err(parked3)));
              t.close();
            }
            // ── a kick soon after the bridge logged in is a kick (the first login is not a dropped session) ──
            {
              const t = await mk({ sessionDropMs: 15000 });
              await ready(t);
              const m0 = t.got.length;
              vc(t, { do: 'close', code: 4014 });
              const parked = await wa(t, m0, (p) => p.channelId === null && /Removed from voice/i.test(err(p)), 3000);
              await nap(800);
              check('GRN-49: a 4014 within 15 s of the FIRST login parks (only a reconnect of an established session makes a 4014 a dropped session)', !!parked && t.last.channelId === null && /Removed from voice/.test(err(t.last)), JSON.stringify({ parked: parked && err(parked), now: t.last.channelId }));
              t.close();
            }
            // ── a 4014 right after the gateway dropped is a lost session, not a kick ──
            {
              const t = await mk({ sessionDropMs: 15000 });
              await ready(t);
              const o0 = mkSock(), m0 = t.got.length, r0 = md.resumes;
              md.dropAll(4000);
              await until(() => md.resumes > r0 && t.last.rpc.reconnecting === false, 8000);
              vc(t, { do: 'close', code: 4014 });
              const lost = await wa(t, m0, (p) => p.channelId === null && /rejoining/i.test(err(p)), 3000);
              const back = await wa(t, m0, (p) => p.channelId === '910' && p.users['2001'] && lost && t.got.indexOf(p) > t.got.indexOf(lost), 4000);
              check('GRN-49: a 4014 within 15 s of a gateway reconnect is a dropped session, not a kick: the bridge says "rejoining" (not "Removed from voice") and rejoins', !!lost && !/Removed/.test(err(lost)) && !!back && md.ops4.length > o0, JSON.stringify({ lost: lost && err(lost), back: !!back }));
              // the same after a re-identify (a new session): the 4014 is a dropped session too
              await ready(t);
              const m1 = t.got.length, i1 = md.identifies;
              md.holdHelloMs = 300;
              md.dropAll(1000);
              await until(() => md.identifies > i1 && t.last.rpc.reconnecting === false, 10000);
              vc(t, { do: 'close', code: 4014 });
              const lost2 = await wa(t, m1, (p) => p.channelId === null && /rejoining/i.test(err(p)), 3000);
              const back2 = await wa(t, m1, (p) => p.channelId === '910' && p.users['2001'] && lost2 && t.got.indexOf(p) > t.got.indexOf(lost2), 4000);
              check('GRN-51/49: …and after a re-identify a forced 4014 is rejoined as well', !!lost2 && !/Removed/.test(err(lost2)) && !!back2, JSON.stringify({ lost2: lost2 && err(lost2), back2: !!back2 }));
              t.close();
            }
            // ── the bot dragged to another channel in Discord (GRN-50) ──
            {
              const t = await mk();
              await ready(t);
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, '910', { member: memberOf(ME, 'mockbot', { bot: true }) })); // the bot's own join, as Discord reports it
              await nap(200);
              const m0 = t.got.length;
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, '914', { member: memberOf(ME, 'mockbot', { bot: true }) }));
              const moved = await wa(t, m0, (p) => p.channelId === '914' && p.users['2002'], 3000);
              check('GRN-50: when the bot is dragged to another channel in Discord the roster follows it (channel 914, Bob), while the saved current channel stays 910', !!moved && !moved.users['2001'] && moved.current.channelId === '910' && !err(moved), JSON.stringify(moved && { c: moved.channelId, u: Object.keys(moved.users), cur: moved.current, e: err(moved) }));
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, null, { member: memberOf(ME, 'mockbot', { bot: true }) }));
              t.close();
            }
            // ── a rebuilt connection goes back to the chosen channel, not to where the bot was dragged (GRN-50 with GRN-49/150) ──
            {
              const t = await mk({ stallLostMs: 900, backoffMs: [300, 500] });
              await ready(t);
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, '910', { member: memberOf(ME, 'mockbot', { bot: true }) }));
              await nap(200);
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, '914', { member: memberOf(ME, 'mockbot', { bot: true }) }));
              await t.waitFor((p) => p.channelId === '914' && p.users['2002'], 3000);
              const m0 = t.got.length;
              vc(t, { do: 'close', code: 4006 });
              const lost = await wa(t, m0, (p) => p.channelId === null && /rejoining/i.test(err(p)), 4000);
              const back = await wa(t, m0, (p) => p.channelId === '910' && p.users['2001'] && lost && t.got.indexOf(p) > t.got.indexOf(lost), 4000);
              check('GRN-50/49: a voice connection that has to be rebuilt after the bot was dragged goes back to the chosen channel (the saved current channel), with that channel\'s roster', !!lost && !!back && !back.users['2002'], JSON.stringify({ lost: !!lost, back: back && Object.keys(back.users) }));
              t.close();
            }
            {
              const t = await mk();
              await ready(t);
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, '910', { member: memberOf(ME, 'mockbot', { bot: true }) }));
              await nap(200);
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, '914', { member: memberOf(ME, 'mockbot', { bot: true }) }));
              await t.waitFor((p) => p.channelId === '914' && p.users['2002'], 3000);
              vc(t, { do: 'state', status: 'signalling' });
              await nap(200);
              const o0 = mkSock(), r0 = md.resumes;
              md.dropAll(4000);
              await until(() => md.resumes > r0, 8000);
              await nap(500);
              const joins = md.ops4.slice(o0).filter((d) => d.channel_id);
              check('GRN-50/51: a Signalling connection that is asked to rejoin at a gateway resume rejoins the CHOSEN channel (910), not the one the bot was dragged to (914)', joins.length >= 1 && joins.every((d) => d.channel_id === '910'), JSON.stringify(joins));
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, null, { member: memberOf(ME, 'mockbot', { bot: true }) }));
              t.close();
            }
            // ── dragged into a Stage: the roster is not that of a channel this bridge cannot read (GRN-50 with GRN-80) ──
            {
              const t = await mk();
              await ready(t);
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, '910', { member: memberOf(ME, 'mockbot', { bot: true }) }));
              await nap(200);
              const m0 = t.got.length;
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, '912', { member: memberOf(ME, 'mockbot', { bot: true }) }));
              const inStage = await wa(t, m0, (p) => p.channelId === '912', 3000);
              md.dispatchAll('VOICE_STATE_UPDATE', vstate('2003', '912', { member: memberOf('2003', 'Carol') }));
              await nap(600);
              check('GRN-50/80: when the bot is dragged into a Stage channel the roster is empty (a Stage\'s audience and speakers are not read), and people who join the Stage are not listed', !!inStage && Object.keys(inStage.users).length === 0 && Object.keys(t.last.users).length === 0, JSON.stringify(t.last.users));
              md.dispatchAll('VOICE_STATE_UPDATE', vstate('2003', null, { member: memberOf('2003', 'Carol') }));
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, null, { member: memberOf(ME, 'mockbot', { bot: true }) }));
              t.close();
            }
            // ── a gateway resume: the status shows it, connected stays true, nothing is re-seeded (GRN-51) ──
            {
              const t = await mk();
              await ready(t);
              const m0 = t.got.length, r0 = md.resumes;
              md.dropAll(4000);
              const resumed = await until(() => md.resumes > r0 && t.last.rpc.reconnecting === false, 8000);
              const during = t.got.slice(m0);
              check('GRN-51: a gateway drop that resumes shows rpc.reconnecting while it lasts, then clears it', during.some((p) => p.rpc && p.rpc.reconnecting === true) && resumed, JSON.stringify({ n: during.length, resumed }));
              check('GRN-51: …connected stays true the whole time (the roster overlay hides on !connected) and the voice connection is left alone (still Ready, roster intact)', during.every((p) => p.connected === true) && t.last.hostInChannel === true && !!t.last.users['2001'], JSON.stringify(during.map((p) => p.connected)));
              // a connection that was stuck in Signalling is re-sent its join at the resume
              vc(t, { do: 'state', status: 'signalling' });
              await nap(200);
              const o1 = mkSock(), r1 = md.resumes;
              md.dropAll(4000);
              await wa(t, t.got.length - 1, () => md.resumes > r1, 6000);
              await nap(500);
              check('GRN-51: a voice connection that is Signalling when the gateway resumes is asked to rejoin (a join op 4 is sent again)', md.ops4.length > o1 && md.ops4.slice(o1).some((d) => d.channel_id === '910'), JSON.stringify(md.ops4.slice(o1)));
              t.close();
            }
            // ── a re-identify: the roster is rebuilt from what Discord now says, speaking flags are kept (GRN-51, GRN-109) ──
            {
              where['2003'] = null;
              const t = await mk();
              await ready(t);
              where['2001'] = '910'; where['2002'] = '910';
              md.dispatchAll('VOICE_STATE_UPDATE', vstate('2002', '910', { member: memberOf('2002', 'Bob') }));
              await t.waitFor((p) => p.users['2002'], 3000);
              t.cmd('test-speaking', '2002');
              await t.waitFor((p) => p.users['2002'] && p.users['2002'].speaking === true, 3000);
              // during the outage Alice leaves and Carol joins (nothing reaches the bridge: it re-identifies)
              where['2001'] = null; where['2003'] = '910';
              const m0 = t.got.length, i0 = md.identifies;
              md.holdHelloMs = 600;
              md.dropAll(1000);
              const re = await wa(t, m0, (p) => md.identifies > i0 && p.users['2003'] && !p.users['2001'] && p.rpc && p.rpc.reconnecting === false, 10000);
              const during = t.got.slice(m0);
              check('GRN-51/109: after a re-identify (new session, no replay) the roster is rebuilt from what Discord says now: Alice gone, Carol there (the server becoming available again re-seeds it, and so does the shard coming ready: the same data, so either one shows here)', !!re && !!re.users['2002'] && md.identifies === i0 + 1, JSON.stringify(re && Object.keys(re.users)));
              check('GRN-51: …speaking flags of people who are still there are kept, and connected stayed true through the re-identify', !!re && re.users['2002'].speaking === true && during.every((p) => p.connected === true), JSON.stringify(re && re.users['2002']));
              where['2003'] = null; where['2001'] = '910'; where['2002'] = '914';
              t.close();
            }
            // ── an unrecoverable close: 4004 (the token was rejected) ──
            {
              const t = await mk();
              await ready(t);
              const c0 = md.connections, m0 = t.got.length;
              md.dropAll(4004);
              const dead = await wa(t, m0, (p) => p.connected === false && /token/i.test(err(p)), 4000);
              await nap(1800);
              check('GRN-51: Discord closing with 4004 stops the bot with "the token was rejected" on the status line, and the bridge does not dial again', !!dead && dead.channelId === null && Object.keys(dead.users).length === 0 && md.connections === c0, JSON.stringify({ e: dead && err(dead), conns: md.connections - c0 }));
              t.close();
            }
            // ── guildAvailable: a server that comes back (GRN-109) and voice that was lost (GRN-49/150) ──
            {
              const t = await mk({ stallLostMs: 700, backoffMs: [30000] });
              const m0 = t.got.length;
              const lost = await wa(t, m0, (p) => p.channelId === null && /rejoining/i.test(err(p)), 4000);
              const o0 = mkSock();
              md.dispatchAll('GUILD_DELETE', { id: GUILD, unavailable: true });
              await nap(100);
              md.dispatchAll('GUILD_CREATE', guildNow());
              const back = await wa(t, m0, (p) => p.channelId === '910' && p.users['2001'] && lost && t.got.indexOf(p) > t.got.indexOf(lost), 4000);
              check('GRN-109: a server that becomes available again while the voice connection is lost joins at once (not after the 30 s backoff) and seeds the roster', !!lost && !!back && md.ops4.length > o0, JSON.stringify({ lost: !!lost, back: !!back }));
              // and one that comes back while joined re-seeds the roster from the fresh data
              await ready(t);
              where['2003'] = '910'; where['2001'] = null;
              md.dispatchAll('GUILD_DELETE', { id: GUILD, unavailable: true });
              await nap(100);
              const m1 = t.got.length;
              md.dispatchAll('GUILD_CREATE', guildNow());
              const fresh = await wa(t, m1, (p) => p.users['2003'] && !p.users['2001'], 4000);
              check('GRN-109: …and while joined the roster is re-seeded from the server\'s fresh data', !!fresh, JSON.stringify(Object.keys(t.last.users)));
              where['2003'] = null; where['2001'] = '910';
              t.close();
            }
            // ── the bot is removed from the server (GRN-141) ──
            {
              const t = await mk({ sessionDropMs: 100 });
              await ready(t);
              await nap(400);
              vc(t, { do: 'keep' });
              await nap(300); // (the command comes over Streamer.bot, the deletion over the gateway: let the first land)
              const o0 = mkSock(), m0 = t.got.length;
              md.dispatchAll('GUILD_DELETE', { id: GUILD });
              const gone = await wa(t, m0, (p) => p.channelId === null && /removed from that server/i.test(err(p)), 3000);
              vc(t, { do: 'close-kept', code: 4014 }); // the voice close of the connection the server took away arrives after the deletion
              await nap(1200);
              md.dispatchAll('GUILD_CREATE', guildNow()); // the bot is invited again: a new guild; nothing rejoins until the operator acts
              await nap(800);
              check('GRN-141: GUILD_DELETE for the current server says "Bot was removed from that server", drops the voice connection and the roster; the 4014 of the old connection that follows does not replace the message, and nothing rejoins (not even when the server is added again)', !!gone && Object.keys(gone.users).length === 0 && /removed from that server/i.test(err(t.last)) && t.last.channelId === null && !md.ops4.slice(o0).some((d) => d.channel_id) && /test-close-kept/.test(t.out), JSON.stringify({ e: err(t.last), c: t.last.channelId, ops4: md.ops4.slice(o0) }));
              t.close();
            }
            // ── the bot is removed from the server while the gateway is down, and the session cannot resume (GRN-141 with GRN-51) ──
            {
              const t = await mk({ stallLostMs: 900, backoffMs: [300, 300] });
              await ready(t);
              const m0 = t.got.length, i0 = md.identifies;
              md.omitGuildInReady = true; // the new session's READY no longer lists the server (discord.js keeps the old guild in its cache and sends no delete)
              md.dropAll(1000);
              const gone = await wa(t, m0, (p) => p.channelId === null && /removed from that server/i.test(err(p)), 10000);
              const o1 = mkSock();
              await nap(2500);
              md.omitGuildInReady = false;
              check('GRN-141/51: when a re-identify\'s READY no longer lists the current server the bridge says "Bot was removed from that server" (not a permissions or outage message) and does not keep rejoining on discord.js\'s stale cache', !!gone && md.identifies > i0 && /removed from that server/i.test(err(t.last)) && !md.ops4.slice(o1).some((d) => d.channel_id), JSON.stringify({ e: gone && err(gone), now: err(t.last), joins: md.ops4.slice(o1) }));
              t.close();
            }
            // ── a capped channel: the bot's own seat and a full channel are not a permanent refusal (GRN-49 with GRN-204) ──
            {
              // the bot is in channel 916 (limit 2) with Alice; its connection is lost; at the rejoin discord.js still counts the bot's own seat
              const ME_FRAME = (c) => vstate(ME, c, { member: memberOf(ME, 'mockbot', { bot: true }) });
              const t = await mk({ stallLostMs: 700, backoffMs: [300, 300, 300] }, { cfg: cur('916'), waitJoin: false });
              await t.waitFor((p) => p.connected === true && p.channelId === '916', 8000);
              md.dispatchAll('VOICE_STATE_UPDATE', vstate('2001', '916', { member: memberOf('2001', 'Alice') }));
              md.dispatchAll('VOICE_STATE_UPDATE', ME_FRAME('916'));
              await nap(200);
              const m0 = t.got.length;
              const lost = await wa(t, m0, (p) => p.channelId === null && /rejoining/i.test(err(p)), 4000);
              const back = await wa(t, m0, (p) => p.channelId === '916' && lost && t.got.indexOf(p) > t.got.indexOf(lost), 4000);
              check('GRN-49: a rejoin into a channel at its user limit works when the "other" seat is the bot\'s own stale one (discord.js counts it; the bridge does not)', !!lost && !!back && !back.currentRefused && !/cannot join|permission/i.test(err(back)), JSON.stringify({ lost: !!lost, back: back && { c: back.channelId, e: err(back), r: back.currentRefused } }));
              // now somebody else takes the free seat during the loss: the refusal is "full", it is retried, and it is not a permanent refusal
              await ready(t);
              md.dispatchAll('VOICE_STATE_UPDATE', ME_FRAME(null));
              md.dispatchAll('VOICE_STATE_UPDATE', vstate('2002', '916', { member: memberOf('2002', 'Bob') }));
              await nap(200);
              const m1 = t.got.length;
              vc(t, { do: 'close', code: 4006 });
              const full = await wa(t, m1, (p) => p.channelId === null && /full/i.test(err(p)), 6000);
              check('GRN-49: …and a channel that is really full at a rejoin says "full", keeps retrying and is not marked currentRefused', !!full && full.currentRefused === false, JSON.stringify(full && { e: err(full), r: full.currentRefused }));
              md.dispatchAll('VOICE_STATE_UPDATE', vstate('2002', null, { member: memberOf('2002', 'Bob') }));
              const freed = await wa(t, m1, (p) => p.channelId === '916' && full && t.got.indexOf(p) > t.got.indexOf(full), 6000);
              check('GRN-49: …and once a seat is free the bridge rejoins by itself', !!freed, JSON.stringify(freed && { c: freed.channelId, e: err(freed) }));
              md.dispatchAll('VOICE_STATE_UPDATE', vstate('2001', null, { member: memberOf('2001', 'Alice') }));
              md.dispatchAll('VOICE_STATE_UPDATE', ME_FRAME(null));
              t.close();
            }
            // ── a connection that is slow to get Ready is warned about, never destroyed (GRN-53) ──
            {
              const t = await mk({ notReadyMs: 400 });
              const slow = await t.waitFor((p) => /not ready after \d+ s, still retrying/i.test(err(p)), 3000);
              check('GRN-53: a connection that is not Ready after the wait only warns ("not ready after …, still retrying"): the channel and the roster stay', !!slow && slow.channelId === '910' && slow.hostInChannel === false && !!slow.users['2001'], JSON.stringify(slow && err(slow)));
              const up = await ready(t);
              check('GRN-53: …a Ready that comes late wires the connection: hostInChannel true, the warning gone', !!up && !err(up), JSON.stringify(up && err(up)));
              const m0 = t.got.length;
              vc(t, { do: 'speak', id: '2001' });
              const sp = await wa(t, m0, (p) => p.users['2001'] && p.users['2001'].speaking === true, 3000);
              vc(t, { do: 'speak', id: '2001', end: true });
              const sp2 = await wa(t, m0, (p) => p.users['2001'] && p.users['2001'].speaking === false && t.got.indexOf(p) > t.got.indexOf(sp), 3000);
              check('GRN-53: the connection\'s speaking events reach the roster (start sets the glow, end clears it)', !!sp && !!sp2, JSON.stringify({ sp: !!sp, sp2: !!sp2 }));
              // a second Ready (a live reconnect) does not stack listeners: one start event lights the glow once
              vc(t, { do: 'state', status: 'connecting' }); await nap(100); await ready(t);
              vc(t, { do: 'listeners' });
              await until(() => /test-listeners/.test(t.out), 3000);
              check('GRN-53: …and Ready again after a live reconnect wires nothing twice (one start and one end listener on the connection)', /test-listeners start=1 end=1/.test(t.out), (t.out.match(/test-listeners[^\n]*/) || [''])[0]);
              t.close();
            }
            // ── a speaking event of an old connection changes nothing (GRN-12) ──
            {
              const t = await mk();
              await ready(t);
              vc(t, { do: 'keep' });
              const m0 = t.got.length;
              where['2002'] = '914';
              t.cmd('set-current', JSON.stringify({ serverId: GUILD, channelId: '914' }));
              await wa(t, m0, (p) => p.channelId === '914' && p.users['2002'], 4000);
              await ready(t);
              const m1 = t.got.length;
              vc(t, { do: 'speak-old', id: '2002' });
              await nap(700);
              check('GRN-12: a speaking event from the connection of the channel the bot left does not light the glow of someone in the new channel (the event was emitted on the old connection)', /test-speak-old: emitting/.test(t.out) && t.got.slice(m1).every((p) => !(p.users['2002'] && p.users['2002'].speaking)) && !!t.last.users['2002'], JSON.stringify(t.last.users['2002']));
              t.close();
            }
            // ── Leave and the intended target are authoritative (GRN-150) ──
            {
              // Leave pressed WHILE THE GATEWAY IS RECONNECTING (the voice connection's own leave is refused by the adapter), Discord still shows the
              // bot in the call: the resume tells it to leave, once. Nothing is queued to be released at a later re-identify.
              const t = await mk();
              await ready(t);
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, '910', { member: memberOf(ME, 'mockbot', { bot: true }) }));
              await nap(200);
              const r0 = md.resumes;
              md.holdHelloMs = 1200;
              md.dropAll(4000);
              await until(() => t.last.rpc.reconnecting === true, 4000);
              const o0 = mkSock();
              t.cmd('leave');
              await nap(500);
              const during = md.ops4.slice(o0).filter((d) => d.channel_id === null).length;
              await until(() => md.resumes > r0, 8000);
              await nap(800);
              const afterResume = md.ops4.slice(o0).filter((d) => d.channel_id === null).length;
              check('GRN-150: Leave pressed while the gateway is reconnecting: nothing can be sent during the outage; the resume then tells Discord to take the bot out of the call (op 4 with channel null), once', during === 0 && afterResume === 1 && !md.ops4.slice(o0).some((d) => d.channel_id === '910'), JSON.stringify({ during, afterResume, ops4: md.ops4.slice(o0) }));
              const i0 = md.identifies;
              md.holdHelloMs = 200;
              md.dropAll(1000);
              await until(() => md.identifies > i0 && t.last.rpc.reconnecting === false, 10000);
              await nap(600);
              check('GRN-150: …and no leave that was queued during the outage is released at a later re-identify', md.ops4.slice(o0).filter((d) => d.channel_id === null).length === 1, JSON.stringify(md.ops4.slice(o0)));
              t.close();
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, null, { member: memberOf(ME, 'mockbot', { bot: true }) }));
            }
            {
              // The channel is cleared (USE with empty ids) while the gateway is reconnecting: the resume still takes the bot out of the call it was in
              const t = await mk();
              await ready(t);
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, '910', { member: memberOf(ME, 'mockbot', { bot: true }) }));
              await nap(200);
              const r0 = md.resumes;
              md.holdHelloMs = 1000;
              md.dropAll(4000);
              await until(() => t.last.rpc.reconnecting === true, 4000);
              const o0 = mkSock();
              t.cmd('set-current', JSON.stringify({ serverId: '', channelId: '' }));
              await until(() => md.resumes > r0, 8000);
              await nap(800);
              check('GRN-150: clearing the channel while the gateway is reconnecting still tells Discord to take the bot out of the call it was in (the resume checks every server the bridge joined, not just the saved one)', t.last.current === null && md.ops4.slice(o0).filter((d) => d.channel_id === null).length === 1, JSON.stringify({ cur: t.last.current, ops4: md.ops4.slice(o0) }));
              t.close();
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, null, { member: memberOf(ME, 'mockbot', { bot: true }) }));
            }
            {
              // Leave pressed while the voice connection is down (waiting for its backoff) cancels the rejoin and tells Discord (op 4, null)
              const t = await mk({ stallLostMs: 600, backoffMs: [1200] });
              const lost = await t.waitFor((p) => p.channelId === null && /rejoining/i.test(err(p)), 4000);
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, '910', { member: memberOf(ME, 'mockbot', { bot: true }) }));
              await nap(200);
              const o0 = mkSock();
              t.cmd('leave');
              await nap(2200);
              check('GRN-150: Leave while the connection is down and waiting to rejoin cancels the rejoin and tells Discord to take the bot out of the call (op 4, channel null)', !!lost && t.last.channelId === null && md.ops4.slice(o0).some((d) => d.channel_id === null) && !md.ops4.slice(o0).some((d) => d.channel_id === '910'), JSON.stringify({ ops4: md.ops4.slice(o0), c: t.last.channelId }));
              t.close();
              md.dispatchAll('VOICE_STATE_UPDATE', vstate(ME, null, { member: memberOf(ME, 'mockbot', { bot: true }) }));
            }
            {
              // the gateway resumes while the voice connection is gone and the target is wanted: join now, not after the backoff
              const t = await mk({ stallLostMs: 600, backoffMs: [30000] });
              const lost = await t.waitFor((p) => p.channelId === null && /rejoining/i.test(err(p)), 4000);
              const m0 = t.got.length, r0 = md.resumes;
              md.dropAll(4000);
              const back = await wa(t, m0, (p) => p.channelId === '910' && p.users['2001'], 8000);
              check('GRN-150: a gateway resume while the bot should be in the call but has no connection joins at once (not after the 30 s backoff)', !!lost && !!back && md.resumes > r0, JSON.stringify({ lost: !!lost, back: !!back }));
              t.close();
            }
            // ── a login that was replaced does not touch the bot that replaced it (GRN-20) ──
            {
              md.gatewayFailNext = 1; md.gatewayStatus = 400; md.gatewayDelay = 900; // (a 4xx other than 401: discord.js does not retry it itself)
              const h0 = md.gatewayHits;
              const t = await mk({}, { waitJoin: false });
              await nap(250);
              t.cmd('connect');
              const up = await t.waitFor((p) => p.connected === true && p.channelId === '910', 8000);
              await nap(1500);
              check('GRN-20: the failure of a login that was replaced meanwhile (a second Connect) neither stops the running bot, nor sets a message, nor starts a retry', !!up && t.last.connected === true && !/login failed/i.test(err(t.last)) && md.gatewayHits - h0 === 2, JSON.stringify({ c: t.last.connected, e: err(t.last), hits: md.gatewayHits - h0 }));
              md.gatewayDelay = 0; t.close();
            }
            // ── the login is retried with a capped backoff, and stops for good on a rejected token (GRN-52) ──
            {
              md.gatewayFailNext = 2; md.gatewayStatus = 400; md.gatewayDelay = 0;
              const h0 = md.gatewayHits;
              const t = await mk({}, { waitJoin: false });
              const failed = await t.waitFor((p) => /login failed/i.test(err(p)) && /retrying/i.test(err(p)), 4000);
              const up = await t.waitFor((p) => p.connected === true && p.channelId === '910' && !err(p), 8000);
              check('GRN-52: a login that fails (Discord or the network is down) says so and is retried; when one works the bot connects and the message is gone', !!failed && !!up && md.gatewayHits - h0 === 3 && [...t.out.matchAll(/Bot login failed/g)].length === 2, JSON.stringify({ failed: failed && err(failed), up: !!up, hits: md.gatewayHits - h0 }));
              t.close();
              md.gatewayFailNext = 1e9; md.gatewayStatus = 401;
              const h1 = md.gatewayHits;
              const t2 = await mk({}, { waitJoin: false });
              const rejected = await t2.waitFor((p) => /login failed/i.test(err(p)) && !/retrying/i.test(err(p)), 4000);
              await nap(1800);
              check('GRN-52: a rejected token (401) is a real failure: the status line says so, and the bridge does not retry', !!rejected && md.gatewayHits - h1 === 1 && t2.last.connected === false, JSON.stringify({ e: rejected && err(rejected), hits: md.gatewayHits - h1 }));
              md.gatewayFailNext = 0;
              t2.cmd('connect');
              const ok = await t2.waitFor((p) => p.connected === true && p.channelId === '910', 8000);
              check('GRN-52: …and Connect (after the token was fixed) works', !!ok);
              t2.close();
            }
            // ── speaking detection that went quiet is flagged (GRN-174) ──
            {
              const t = await mk({ speakingStaleMs: 900 });
              await ready(t);
              check('GRN-174: right after Ready the payload does not claim speaking detection went quiet', t.last.rpc.speakingStale === false, JSON.stringify(t.last.rpc));
              await nap(1200);
              t.cmd('set-settings', '{}');
              const stale = await t.waitFor((p) => p.rpc && p.rpc.speakingStale === true, 3000);
              check('GRN-174: with someone present and unmuted and no speaking start for a long time, rpc.speakingStale is true (a separate flag, not rpc.error)', !!stale && !err(stale), JSON.stringify(stale && stale.rpc));
              const m0 = t.got.length;
              vc(t, { do: 'speak', id: '2001' });
              vc(t, { do: 'speak', id: '2001', end: true });
              const fresh = await wa(t, m0, (p) => p.rpc.speakingStale === false, 3000);
              check('GRN-174: …and a speaking start clears it', !!fresh, JSON.stringify(t.last.rpc));
              t.close();
            }
            {
              const t = await mk({ speakingStaleMs: 600000, stuckGlowMs: 900 });
              await ready(t);
              vc(t, { do: 'speak', id: '2001' });
              await t.waitFor((p) => p.users['2001'] && p.users['2001'].speaking === true, 3000);
              check('GRN-174: a glow that has just come on is not flagged', t.last.rpc.speakingStale === false, JSON.stringify(t.last.rpc));
              await nap(1200);
              t.cmd('set-settings', '{}');
              const stuck = await t.waitFor((p) => p.rpc.speakingStale === true && p.users['2001'] && p.users['2001'].speaking === true, 3000);
              check('GRN-174: …a glow that stays on for minutes with no end is flagged the same way', !!stuck, JSON.stringify(t.last.rpc));
              t.close();
            }
            {
              // someone who leaves mid-sentence (their "end" never reaches the roster) does not make their next glow look stuck
              const t = await mk({ speakingStaleMs: 600000, stuckGlowMs: 900 });
              await ready(t);
              vc(t, { do: 'speak', id: '2001' });
              await t.waitFor((p) => p.users['2001'] && p.users['2001'].speaking === true, 3000);
              md.dispatchAll('VOICE_STATE_UPDATE', vstate('2001', null, { member: memberOf('2001', 'Alice') }));
              await t.waitFor((p) => !p.users['2001'], 3000);
              await nap(1100);
              md.dispatchAll('VOICE_STATE_UPDATE', vstate('2001', '910', { member: memberOf('2001', 'Alice') }));
              await t.waitFor((p) => p.users['2001'], 3000);
              vc(t, { do: 'speak', id: '2001' });
              await t.waitFor((p) => p.users['2001'] && p.users['2001'].speaking === true, 3000);
              t.cmd('set-settings', '{}');
              await nap(300);
              check('GRN-174: a speaker who left mid-sentence and comes back does not make their first word look like a stuck glow (rpc.speakingStale stays false)', t.last.rpc.speakingStale === false, JSON.stringify(t.last.rpc));
              t.close();
            }
            // ── guildAvailable during the first login does not join before the bot is ready (GRN-109 with GRN-49) ──
            {
              const o0 = mkSock();
              const t = await mk();
              await nap(500);
              const ops = md.ops4.slice(o0);
              check('GRN-109: at the first login the server becomes available before clientReady, and the bridge joins once, after it (one join, no leave of a premature connection)', ops.filter((d) => d.channel_id === '910').length === 1 && ops.filter((d) => d.channel_id === null).length === 0, JSON.stringify(ops));
              t.close();
            }
            // ── a join while the gateway is down (AdapterUnavailable) and a login retry that starts over after a success (GRN-49, GRN-52) ──
            {
              const t = await mk({ stallLostMs: 0, backoffMs: [300] });
              await ready(t);
              const r0 = md.resumes;
              md.holdHelloMs = 1500;
              md.dropAll(4000);
              await until(() => t.last.rpc.reconnecting === true, 4000);
              const mU = t.got.length;
              t.cmd('set-current', JSON.stringify({ serverId: GUILD, channelId: '914' })); // USE during the outage: the adapter refuses the join (AdapterUnavailable)
              await nap(900);
              await until(() => md.resumes > r0 && t.last.rpc.reconnecting === false, 8000);
              const in914 = await wa(t, mU, (p) => p.channelId === '914' && p.users['2002'] && p.hostInChannel === false, 8000);
              check('GRN-49: a join made while the gateway is down (the adapter says unavailable) is handled at once and recovered: the bot ends up in the new channel after the resume', !!in914 && /\[AdapterUnavailable\]/.test(t.out), JSON.stringify({ now: t.last.channelId, log: (t.out.match(/\[AdapterUnavailable\]/) || [''])[0] }));
              t.close();
            }
            {
              // the login retry backoff starts over after a success: fail, succeed, fail again -> the first step again
              md.gatewayFailNext = 2; md.gatewayStatus = 400; md.gatewayDelay = 0;
              const t = await mk({ loginStartMs: 1000, loginCapMs: 4000 }, { waitJoin: false });
              const first = await t.waitFor((p) => /retrying in 1 s/.test(err(p)), 4000);
              const second = await t.waitFor((p) => /retrying in 2 s/.test(err(p)), 5000);
              const up = await t.waitFor((p) => p.connected === true && p.channelId === '910' && !err(p), 8000);
              md.gatewayFailNext = 1; md.gatewayStatus = 400;
              t.cmd('connect');
              const again = await t.waitFor((p) => t.got.indexOf(p) > t.got.indexOf(up) && /retrying in \d+ s/.test(err(p)), 5000);
              check('GRN-52: the retry backoff doubles (1 s, then 2 s) and starts over after a login that worked (the next failure says 1 s again)', !!first && !!second && !!up && !!again && /retrying in 1 s/.test(err(again)), JSON.stringify({ first: first && err(first), second: second && err(second), again: again && err(again) }));
              t.close();
            }
            // ── quit with the rejoin and login timers armed (the exit path clears them, S12) ──
            {
              const t = await mk({ stallLostMs: 500, backoffMs: [60000] });
              await t.waitFor((p) => p.channelId === null && /rejoining/i.test(err(p)), 4000); // a 60 s rejoin timer is armed
              const c0 = md.connections;
              t.cmd('quit');
              const exited = await t.exited(4000);
              await nap(500);
              check('GRN-52/49: Quit with a rejoin timer armed exits promptly with code 0, and nothing dials again', exited && t.code === 0 && md.connections === c0, JSON.stringify({ exited, code: t.code, conns: md.connections - c0 }));
              t.close();
              md.gatewayFailNext = 3; md.gatewayStatus = 400;
              const t2 = await mk({ loginStartMs: 60000 }, { waitJoin: false });
              await t2.waitFor((p) => /retrying in 60 s/.test(err(p)), 4000); // a 60 s login retry timer is armed
              const h0 = md.gatewayHits;
              t2.cmd('quit');
              const exited2 = await t2.exited(4000);
              md.gatewayFailNext = 0;
              check('GRN-52: Quit with a login retry armed exits promptly with code 0, and the login is not tried again', exited2 && t2.code === 0 && md.gatewayHits === h0, JSON.stringify({ exited2, code: t2.code }));
              t2.close();
            }
          } finally {
            await md.close();
          }
        }
        // ── 8e. files, tokens and settings (Sprint 14); the token canary is [7b] ──
        // The real bridge on scratch config and token files: how a file is read (BOM, UTF-16, literal null, a copy kept of a bad one), how it is
        // written (atomic, queued, a failed write reported), what a token file may be (re-read on Connect, never overwritten from memory, never
        // blanked over the bus), and the rules for settings and favorites. Logins go to the mock Discord (never to the real one).
        console.log('\n[8e] files, tokens, settings: BOM / UTF-16 / null / read-only config, atomic queued writes, token file rules, settings and favorite rules');
        console.log('[7b] token canary: a random token in the token file appears in no frame, state, config or log');
        {
          const { GUILD, ME, VIEW, CONNECT, SPEAK, userOf, memberOf, vstate, chan } = DF;
          const S1 = '123456789012345678', C1 = '223456789012345678';
          const fav = (id, name, s, c) => ({ id, name, serverId: s, channelId: c });
          const cfg1 = JSON.stringify({ favorites: [fav('f1', 'Main', S1, C1)], current: null, settings: { accent: 'magenta' } }, null, 2);
          const STRICT = { GREENROOM_LOOSE_IDS: '0' };
          const exists = (p) => existsSync(p);
          const fileText = (t) => readFile(t.env.DISCORD_BRIDGE_CONFIG, 'utf8');
          const tokText = (t) => readFile(t.env.DISCORD_BRIDGE_TOKENS, 'utf8');
          const corrupt = async (t) => (await readdir(s12)).filter((n) => n.startsWith(basename(t.env.DISCORD_BRIDGE_CONFIG) + '.corrupt-'));
          const warn = (p) => (p && p.rpc && p.rpc.configWarning) || '';
          const err = (p) => (p && p.rpc && p.rpc.error) || '';
          const waitAfter = async (t, mark, pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = t.got.slice(mark).find(pred); if (hit) return hit; await nap(50); } return null; };

          // ── reading (GRN-19, GRN-93) ──
          const be = Buffer.from(cfg1, 'utf16le'); be.swap16();
          for (const [what, buf] of [['a UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(cfg1, 'utf8')])], ['UTF-16 little-endian with a BOM (what PowerShell\'s > writes)', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(cfg1, 'utf16le')])], ['UTF-16 big-endian with a BOM', Buffer.concat([Buffer.from([0xfe, 0xff]), be])]]) {
            const t = await rig({ cfgText: buf, env: STRICT });
            check('GRN-19/93: a config saved with ' + what + ' loads (favorite and setting intact), is not replaced by the example and raises no warning', t.last.favorites.length === 1 && t.last.favorites[0].name === 'Main' && t.last.favorites[0].serverId === S1 && t.last.settings.accent === 'magenta' && !warn(t.last) && (await corrupt(t)).length === 0, JSON.stringify({ favs: t.last.favorites, warn: warn(t.last) }));
            t.close();
          }
          for (const [what, text] of [['a literal null', 'null'], ['an array', '[]'], ['a number', '5'], ['an empty file', ''], ['half a file', '{ "favorites": [ ']]) {
            const t = await rig({ cfgText: text });
            await nap(300);
            const kept = await corrupt(t);
            check('GRN-93: a config that is ' + what + ' is not reseeded from the example: a copy is kept as .corrupt-<time>, the bridge runs on defaults and says so in rpc.configWarning (not rpc.error)', kept.length === 1 && t.last.favorites.length === 0 && /could not be used/i.test(warn(t.last)) && !/could not be used/i.test(err(t.last)) && (await fileText(t)) === text, JSON.stringify({ kept, favs: t.last.favorites.length, warn: warn(t.last) }));
            t.close();
          }
          {
            const bad = '{ "favorites": [ not json';
            const t = await rig({ cfgText: bad, env: { GREENROOM_FAIL_COPY: '1' } }); // the copy aside is refused: the file can be neither used nor kept
            await nap(300);
            const atStart = warn(t.last);
            t.cmd('set-settings', JSON.stringify({ accent: 'magenta' }));
            await nap(700);
            check('GRN-19: a bad config that cannot even be copied aside is left alone for the whole session: its bytes are unchanged after a save, and rpc.configWarning says so (without a "could not save")', /nothing is saved this session/i.test(atStart) && (await fileText(t)) === bad && /left as it is this session/i.test(warn(t.last)) && !/could not save/i.test(warn(t.last)) && t.last.settings.accent === 'magenta', JSON.stringify({ atStart, now: warn(t.last) }));
            t.close();
          }
          {
            // a bad config that was copied aside and is then FIXED by hand while the bridge runs on its defaults is not overwritten by the next save
            const t = await rig({ cfgText: '{ "favorites": [ nope' });
            await nap(300);
            const fixed = JSON.stringify({ favorites: [fav('fx', 'Fixed', S1, C1)], current: null, settings: {} }, null, 2);
            await new Promise((r) => setTimeout(r, 30));
            await writeFile(t.env.DISCORD_BRIDGE_CONFIG, fixed);
            t.cmd('favorite-add', JSON.stringify({ name: 'later', serverId: S1, channelId: '323456789012345678' }));
            await nap(800);
            check('GRN-93: the fix an operator makes to a bad config while the bridge runs on its defaults is NOT overwritten by the next save: the file is theirs, and the warning asks for a restart', (await fileText(t)) === fixed && /restart the bridge/i.test(warn(t.last)), JSON.stringify({ warn: warn(t.last) }));
            t.close();
          }
          {
            // after a bad config was copied aside, the bridge's own first save replaces the file: the second save must not take that for a hand edit
            // (it used to go read-only for the session, drop every later change and blame an edit nobody made)
            const t = await rig({ cfgText: '{ "favorites": [ nope' });
            await nap(300);
            t.cmd('favorite-add', JSON.stringify({ name: 'One', serverId: S1, channelId: C1 }));
            const first = await t.waitFor((p) => p.favorites.some((f) => f.name === 'One'), 6000); // pushed after its save has landed
            await nap(200);
            t.cmd('set-settings', JSON.stringify({ accent: 'magenta' }));
            await nap(800);
            let saved = null; try { saved = JSON.parse(await fileText(t)); } catch { /* left null */ }
            check('GRN-93: after a bad config was copied aside, two saves in a row (favorite-add, then set-settings) both reach the file: the bridge\'s own first save is not taken for a hand edit (no "edited while" warning, nothing goes read-only)', !!first && !!saved && Array.isArray(saved.favorites) && saved.favorites.some((f) => f.name === 'One') && !!saved.settings && saved.settings.accent === 'magenta' && /could not be used/i.test(warn(t.last)) && !/edited while|left as it is/i.test(warn(t.last)), JSON.stringify({ first: !!first, favs: saved && Array.isArray(saved.favorites) && saved.favorites.map((f) => f.name), accent: saved && saved.settings && saved.settings.accent, warn: warn(t.last) }));
            t.close();
          }
          {
            // …and a fix made by hand AFTER the bridge's first save is still the operator's: the next save leaves it alone (the guard follows the file
            // as the bridge last wrote it, it is not dropped after the first save)
            const t = await rig({ cfgText: '{ "favorites": [ nope' });
            await nap(300);
            t.cmd('favorite-add', JSON.stringify({ name: 'One', serverId: S1, channelId: C1 }));
            const first = await t.waitFor((p) => p.favorites.some((f) => f.name === 'One'), 6000);
            await nap(200);
            const fixed = JSON.stringify({ favorites: [fav('fx', 'Fixed', S1, C1)], current: null, settings: {} }, null, 2);
            await writeFile(t.env.DISCORD_BRIDGE_CONFIG, fixed);
            t.cmd('set-settings', JSON.stringify({ accent: 'magenta' }));
            await nap(800);
            check('GRN-93: a fix made by hand after the bridge\'s first save over a bad config is NOT overwritten by the next save (the change is used, the warning asks for a restart)', !!first && (await fileText(t)) === fixed && /restart the bridge/i.test(warn(t.last)) && t.last.settings.accent === 'magenta', JSON.stringify({ first: !!first, warn: warn(t.last) }));
            t.close();
          }
          {
            const t = await rig({ stale: true, cfgText: cfg1, env: STRICT });
            check('GRN-19: temp files left beside the config and the token file by a crash are deleted at startup', !exists(t.env.DISCORD_BRIDGE_CONFIG + '.tmp') && !exists(t.env.DISCORD_BRIDGE_TOKENS + '.tmp'), '');
            t.close();
          }
          {
            const t = await rig(); // no config file at all: the only case that is seeded from the example
            check('GRN-19/93: a MISSING config is seeded from the example (and written)', t.last.favorites.some((f) => f.id === 'example1') && exists(t.env.DISCORD_BRIDGE_CONFIG) && !/"height"/.test(await fileText(t)), JSON.stringify(t.last.favorites));
            t.close();
          }

          // ── writing (GRN-19) ──
          {
            const t = await rig({ cfgText: JSON.stringify({ favorites: [], current: null, settings: {} }) });
            for (let i = 0; i < 30; i++) t.cmd('favorite-add', JSON.stringify({ name: 'q' + i, serverId: S1, channelId: '3' + String(i).padStart(17, '0') }));
            t.cmd('quit');
            const gone = await t.exited(8000);
            let parsed = null; try { parsed = JSON.parse(await fileText(t)); } catch { /* left null */ }
            const left = (await readdir(s12)).filter((n) => n.startsWith(basename(t.env.DISCORD_BRIDGE_CONFIG) + '.tmp'));
            check('GRN-19: 30 saves in a burst followed by Quit: the saves are queued, the exit waits for them, the file is whole JSON with all 30 favorites in order and no temp file is left', gone && !!parsed && parsed.favorites.length === 30 && parsed.favorites.every((f, i) => f.name === 'q' + i) && left.length === 0, JSON.stringify({ gone, n: parsed && parsed.favorites.length, left }));
            t.close();
          }
          {
            // the exit waits for a write that is still in flight (a slow disk: every write waits 900 ms before its rename)
            const t = await rig({ cfgText: JSON.stringify({ favorites: [], current: null, settings: {} }), env: { GREENROOM_TIMING: JSON.stringify({ writeDelayMs: 900 }) } });
            t.cmd('favorite-add', JSON.stringify({ name: 'LastWord', serverId: S1, channelId: C1 }));
            await nap(150);
            const t0 = Date.now();
            t.cmd('quit');
            const gone = await t.exited(8000);
            const took = Date.now() - t0;
            let parsed = null; try { parsed = JSON.parse(await fileText(t)); } catch { /* left null */ }
            check('GRN-19: Quit while a save is still in flight waits for it (the favorite is in the file) and still exits promptly (under the 3.5 s cap)', gone && !!parsed && parsed.favorites.length === 1 && parsed.favorites[0].name === 'LastWord' && took < 3500, JSON.stringify({ gone, took, n: parsed && parsed.favorites.length }));
            t.close();
          }
          {
            // GRN-68: a config that cannot be written: the change is used, the sticky warning says it is not kept, and the next write that works clears it
            const t = await rig({ cfgText: cfg1, env: STRICT });
            await rm(t.env.DISCORD_BRIDGE_CONFIG, { force: true });
            await mkdir(t.env.DISCORD_BRIDGE_CONFIG);
            t.cmd('favorite-add', JSON.stringify({ name: 'Second', serverId: S1, channelId: '323456789012345678' }));
            t.cmd('set-current', JSON.stringify({ serverId: S1, channelId: C1 }));
            const failed = await t.waitFor((p) => /could not save discord-voice-config\.json/i.test(warn(p)), 6000);
            await nap(300);
            check('GRN-68: when the config cannot be written the changes are used all the same (the favorite is listed, the channel is current) and the sticky rpc.configWarning says they are not kept after a restart', !!failed && t.last.favorites.some((f) => f.name === 'Second') && !!t.last.current && t.last.current.channelId === C1, JSON.stringify({ warn: warn(t.last), cur: t.last.current }));
            await rm(t.env.DISCORD_BRIDGE_CONFIG, { recursive: true, force: true });
            t.cmd('favorite-add', JSON.stringify({ name: 'Third', serverId: S1, channelId: '423456789012345678' }));
            const healed = await t.waitFor((p) => p.favorites.some((f) => f.name === 'Third') && !warn(p), 6000);
            let saved = { favorites: [], current: null }; try { saved = JSON.parse(await fileText(t)); } catch { /* reported by the check */ }
            check('GRN-19/68: …and the next write that works saves everything and clears that warning', !!healed && saved.favorites.length === 3 && !!saved.current && saved.current.channelId === C1, JSON.stringify({ n: saved.favorites.length, cur: saved.current }));
            t.close();
          }

          // ── settings and favorites (GRN-167, 196, 198, 43, 138, 232, 133) ──
          {
            const bad = '{ "favorites": [ { "id": "ok", "name": "Okay", "serverId": "' + S1 + '", "channelId": "' + C1 + '" }, '
              + '{ "id": "bad", "name": "Bad", "serverId": "abc", "channelId": "' + C1 + '" }, '
              + '{ "id": "short", "name": "Short", "serverId": "900", "channelId": "910" }, '
              + '{ "id": "num", "name": "Num", "serverId": 123456789012345678, "channelId": 223456789012345679 }, '
              + '{ "id": "ok", "name": "Twin", "serverId": "' + S1 + '", "channelId": "523456789012345678" } ], '
              + '"current": null, "settings": { "avatarPx": "abc", "streamerPx": true, "accent": "red", "scanlines": "no", "streamerUserId": 100000000000000001, "height": 180, "junk": 1, "exitOnSbClose": "yes", "neonBlink": false } }';
            const t = await rig({ cfgText: bad, env: STRICT });
            const names = t.last.favorites.map((f) => f.name);
            const ids = t.last.favorites.map((f) => f.id);
            check('GRN-198: hand-edited favorites must have 17 to 20 digit server and channel ids as text: a bad or short id is skipped (and logged), a bare number keeps its exact digits, a repeated favorite id is made new', names.join(',') === 'Okay,Num,Twin' && t.last.favorites[1].serverId === '123456789012345678' && t.last.favorites[1].channelId === '223456789012345679' && new Set(ids).size === 3 && /"Bad" was skipped/.test(t.out) && /"Short" was skipped/.test(t.out), JSON.stringify({ names, ids }));
            const dropped = (await corrupt(t)).length;
            check('GRN-198: favorites that are skipped at load are named in rpc.configWarning and the file is kept as a .corrupt-<time> copy (the next save would have dropped them without a trace)', dropped === 1 && /2 favorite\(s\)/.test(warn(t.last)) && /Bad/.test(warn(t.last)), JSON.stringify({ dropped, warn: warn(t.last) }));
            const s = t.last.settings;
            check('GRN-167/196/43: settings of the wrong type load as defaults (avatarPx, streamerPx, accent, scanlines, exitOnSbClose), a bare-number streamerUserId keeps its exact digits, a valid false stays false, and unknown keys and the old height are dropped', s.avatarPx === 56 && s.streamerPx === 72 && s.accent === 'cyan' && s.scanlines === true && s.exitOnSbClose === false && s.neonBlink === false && s.streamerUserId === '100000000000000001' && !('height' in s) && !('junk' in s), JSON.stringify(s));
            t.cmd('set-settings', JSON.stringify({ avatarPx: null, streamerPx: '', accent: 7, neonBlink: 0, scanlines: 'x', exitOnSbClose: 'true', junk: 5 }));
            await nap(500);
            const s2 = t.last.settings;
            check('GRN-167: set-settings holds the same rules: null, an empty string, a number for an enum and a non-boolean change nothing, and exitOnSbClose only turns on for a real true', s2.avatarPx === 56 && s2.streamerPx === 72 && s2.accent === 'cyan' && s2.neonBlink === false && s2.scanlines === true && s2.exitOnSbClose === false && !('junk' in s2), JSON.stringify(s2));
            t.cmd('set-settings', JSON.stringify({ avatarPx: [], streamerPx: ' ', accent: ['cyan'] }));
            await nap(500);
            check('GRN-167: an array or a blank string for a size changes nothing (it is not clamped to the minimum)', t.last.settings.avatarPx === 56 && t.last.settings.streamerPx === 72 && t.last.settings.accent === 'cyan', JSON.stringify(t.last.settings));
            t.cmd('set-settings', JSON.stringify({ avatarPx: 9999, streamerPx: 1, accent: 'neon-green', exitOnSbClose: true }));
            await nap(500);
            check('GRN-167: …and a number is clamped to its range, a good enum is taken, a real true is taken', t.last.settings.avatarPx === 128 && t.last.settings.streamerPx === 32 && t.last.settings.accent === 'neon-green' && t.last.settings.exitOnSbClose === true, JSON.stringify(t.last.settings));
            t.close();
          }
          {
            const t = await rig({ cfgText: JSON.stringify({ favorites: [], current: null, settings: {} }) });
            const long = 'a'.repeat(79) + '😀' + 'tail';
            t.cmd('favorite-add', JSON.stringify({ name: long, serverId: S1, channelId: C1 }));
            t.cmd('favorite-add', JSON.stringify({ name: 'again', serverId: S1, channelId: C1 }));
            await nap(700);
            const f = t.last.favorites;
            const name = f[0] && f[0].name;
            const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
            check('GRN-232: a favorite name longer than 80 characters with an emoji across the cut is cut by code point (80 characters, the emoji whole), never leaving a lone surrogate', f.length === 1 && Array.from(name || '').length === 80 && (name || '').endsWith('😀') && !lone.test(name || ''), JSON.stringify({ n: f.length, len: name && Array.from(name).length }));
            check('GRN-133: a repeated Save (the same server and channel) adds no duplicate and keeps the existing entry', f.length === 1 && f[0].name !== 'again', JSON.stringify(f.map((x) => x.name)));
            if (!f[0]) throw new Error('the favorite was not added');
            const id = f[0].id;
            t.cmd('favorite-update', JSON.stringify({ id, channelId: '' }));
            await nap(500);
            const refused = t.last;
            t.cmd('set-settings', JSON.stringify({ accent: 'magenta' }));
            await nap(500);
            const after = t.last.favorites[0];
            check('GRN-138: a favorite-update that would leave it without a channel is refused (with a message), and the favorite is unchanged after the next save', /server ID and a channel ID/i.test(err(refused)) && after.channelId === C1 && after.serverId === S1 && after.name === name, JSON.stringify({ err: err(refused), after }));
            t.cmd('favorite-update', JSON.stringify({ id, name: 'Renamed' }));
            await nap(500);
            check('GRN-138: …and a valid update still works', t.last.favorites[0].name === 'Renamed' && t.last.favorites[0].channelId === C1, JSON.stringify(t.last.favorites[0]));
            t.cmd('favorite-update', JSON.stringify({ id, name: long }));
            await nap(500);
            const upName = t.last.favorites[0].name;
            check('GRN-232: …and an update to a long name with an emoji across the cut is cut by code point too', Array.from(upName).length === 80 && upName.endsWith('😀') && !lone.test(upName), JSON.stringify({ len: Array.from(upName).length }));
            t.close();
          }
          {
            // c4/c19: the bus holds a favorite to the same id rule as the saved config (17 to 20 digits when strict): nothing is saved that the loader would drop
            const t = await rig({ cfgText: JSON.stringify({ favorites: [], current: null, settings: {} }), env: STRICT });
            t.cmd('favorite-add', JSON.stringify({ name: 'short', serverId: '900', channelId: '910' }));
            await nap(500);
            const refusedShort = t.last;
            t.cmd('favorite-add', JSON.stringify({ name: 'junk', serverId: 'abc', channelId: C1 }));
            await nap(500);
            t.cmd('favorite-add', JSON.stringify({ name: 'good', serverId: S1, channelId: C1 }));
            await nap(500);
            check('GRN-167/198: favorite-add holds a favorite to the same id rule as the saved config (17 to 20 digits): a short id and a junk id are refused with a message, a good one is saved', t.last.favorites.length === 1 && t.last.favorites[0].name === 'good' && /server ID and a channel ID/i.test(err(refusedShort)), JSON.stringify({ favs: t.last.favorites.map((x) => x.name), err: err(refusedShort) }));
            t.close();
          }

          // ── the launcher never installs under a running bridge (GRN-190) ──
          {
            const t = await rig();
            const probeUp = await runNode(['sidecar/guard-probe.mjs', '--guard-port=' + t.guardPort]);
            const closed = await freePort();
            const probeDown = await runNode(['sidecar/guard-probe.mjs', '--guard-port=' + closed]);
            check('GRN-190: guard-probe.mjs exits 0 when a Greenroom bridge answers on the guard port and 1 when nothing does (the launcher uses it to refuse an install under a running bridge)', probeUp.code === 0 && probeDown.code === 1, JSON.stringify({ up: probeUp.code, down: probeDown.code }));
            t.close();
            const bat = (await readFile(resolve(__dirname, 'start-discord-bridge.bat'), 'utf8')).split(/\r?\n/);
            let depth = 0, inBlock = false;
            for (const line of bat) { if (depth > 0 && /%~dp0/.test(line)) inBlock = true; depth += (line.match(/\(\s*$/g) || []).length; if (/^\s*\)/.test(line)) depth = Math.max(0, depth - 1); }
            const batText = bat.join('\n');
            check('GRN-190: the launcher has no %~dp0 inside a ( ) block (a ")" in its folder name would end the block), probes the guard before npm ci, treats a failing npm ci as a failure and writes the stored lock copy only after it worked', !inBlock && /guard-probe\.mjs[^\n]*&& goto running/.test(batText) && /call npm ci[^\n]*\|\| goto npmfail/.test(batText) && batText.indexOf('call npm ci') < batText.indexOf('copy /y package-lock.json') && /if errorlevel 1 goto nocd/.test(batText), JSON.stringify({ inBlock }));
          }

          // ── tokens (GRN-77, 92, 18, 68) and the canary (GRN-179) ──
          const miniGuild = () => ({
            id: GUILD, name: 'Mock Guild', icon: null, owner_id: '2000', afk_timeout: 300, verification_level: 0, default_message_notifications: 0, explicit_content_filter: 0,
            roles: [{ id: GUILD, name: '@everyone', permissions: String(VIEW | CONNECT | SPEAK), position: 0, color: 0, hoist: false, managed: false, mentionable: false }],
            emojis: [], features: [], mfa_level: 0, system_channel_id: null, premium_tier: 0, premium_subscription_count: 0, preferred_locale: 'en-US', nsfw_level: 0,
            large: false, unavailable: false, member_count: 2, joined_at: '2020-01-01T00:00:00.000000+00:00', threads: [], stage_instances: [], guild_scheduled_events: [], presences: [],
            channels: [chan('910', 2, 'main', 0)], members: [memberOf(ME, 'mockbot', { bot: true }), memberOf('2001', 'Alice')], voice_states: [],
          });
          const md = await mockDiscord({ guild: miniGuild, users: {} });
          const NO_WATCH = JSON.stringify({ notReadyMs: 0, stallWarnMs: 0, stallLostMs: 0, loginStartMs: 60000 });
          const T1 = 'tokenone.AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBB', T2 = 'tokentwo.AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBB';
          const apiEnv = { DISCORD_BRIDGE_API: md.api, GREENROOM_TIMING: NO_WATCH };
          const authNow = () => md.authSeen[md.authSeen.length - 1];
          try {
            {
              const t = await rig({ tokData: JSON.stringify({ botToken: T1, enabled: false, sbPassword: 'pw', extra: { a: 1 } }), env: apiEnv });
              t.cmd('connect');
              await t.waitFor((p) => p.connected === true, 8000);
              const first = authNow();
              const written = JSON.parse(await tokText(t));
              check('GRN-77: Connect logs in with the token in the file; the token file is written back whole with only `enabled` changed (botToken, sbPassword and every other field kept)', first === 'Bot ' + T1 && written.botToken === T1 && written.enabled === true && written.sbPassword === 'pw' && written.extra && written.extra.a === 1, JSON.stringify({ first, written }));
              await writeFile(t.env.DISCORD_BRIDGE_TOKENS, JSON.stringify({ botToken: T2, enabled: true }));
              t.cmd('connect');
              await until(() => authNow() === 'Bot ' + T2, 8000);
              const w2 = JSON.parse(await tokText(t));
              check('GRN-77: a token corrected in the file is adopted by the next Connect, and the file is not overwritten with the token held in memory', authNow() === 'Bot ' + T2 && w2.botToken === T2, JSON.stringify({ auth: authNow(), w2 }));
              const mR = t.got.length;
              t.cmd('reset-auth');
              await waitAfter(t, mR, (p) => p.connected === false && p.rpc.enabled === false, 5000);
              await nap(300);
              const w3 = JSON.parse(await tokText(t));
              check('GRN-18: reset-auth disables and stops the bot but does NOT blank the token file (a forged bus command cannot erase the token): botToken stays, enabled is false, hasToken stays true', w3.botToken === T2 && w3.enabled === false && t.last.rpc.hasToken === true && t.last.rpc.enabled === false, JSON.stringify({ w3, rpc: t.last.rpc }));
              const mC = t.got.length;
              t.cmd('connect');
              const again = await waitAfter(t, mC, (p) => p.connected === true && p.rpc.enabled === true, 8000);
              await nap(300);
              check('GRN-18: …and Connect brings the bot back with the same token', !!again, '');
              await rm(t.env.DISCORD_BRIDGE_TOKENS, { force: true });
              const mD = t.got.length;
              t.cmd('connect');
              await waitAfter(t, mD, (p) => /no bot token/i.test(err(p)) && p.rpc.hasToken === false && p.connected === false, 6000);
              await nap(300);
              check('GRN-77: deleting the token file and pressing Connect forgets the token (no token, the bot stops) and does not write the file back', /no bot token/i.test(err(t.last)) && t.last.rpc.hasToken === false && t.last.connected === false && !exists(t.env.DISCORD_BRIDGE_TOKENS), JSON.stringify(t.last.rpc));
              t.close();
            }
            {
              const broken = '{ "botToken": "' + T1 + '", ';
              const t = await rig({ tokData: broken, env: apiEnv });
              const atStart = t.last;
              t.cmd('connect');
              await nap(700);
              check('GRN-92: a token file that exists but is not valid JSON is reported as that (not as missing) at startup and on Connect, in fixed words, and the file is never replaced', /exists but is not valid JSON/.test(err(atStart)) && /exists but is not valid JSON/.test(err(t.last)) && (await tokText(t)) === broken && !err(t.last).includes('Unexpected'), JSON.stringify({ atStart: err(atStart), now: err(t.last) }));
              t.close();
            }
            for (const [what, buf] of [['a UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ botToken: T1, enabled: false }))])], ['UTF-16 little-endian', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify({ botToken: T1, enabled: false }), 'utf16le')])]]) {
              const t = await rig({ tokData: buf, env: apiEnv });
              check('GRN-92: a token file saved with ' + what + ' is read (hasToken true)', t.last.rpc.hasToken === true && !err(t.last), JSON.stringify(t.last.rpc));
              t.close();
            }
            {
              const t = await rig({ tokData: JSON.stringify({ botToken: '   ', enabled: true }), env: apiEnv });
              t.cmd('connect');
              await t.waitFor((p) => /no bot token/i.test(err(p)), 4000);
              check('GRN-77: an empty token in the file is no token', t.last.rpc.hasToken === false && /no bot token/i.test(err(t.last)), JSON.stringify(t.last.rpc));
              t.close();
            }
            {
              // GRN-68: the token file cannot be written (read-only): the bot still logs in, and the sticky warning says so
              const t = await rig({ tokData: JSON.stringify({ botToken: T1, enabled: false }), env: apiEnv });
              await chmod(t.env.DISCORD_BRIDGE_TOKENS, 0o444);
              try {
                t.cmd('connect');
                const up = await t.waitFor((p) => p.connected === true, 8000);
                const w = await t.waitFor((p) => /could not save discord-tokens\.json/i.test(warn(p)), 6000);
                check('GRN-68: when the token file cannot be written Connect still starts the bot, and rpc.configWarning says the change is not kept', !!up && !!w && (await tokText(t)).includes(T1), JSON.stringify({ up: !!up, warn: warn(t.last) }));
              } finally { await chmod(t.env.DISCORD_BRIDGE_TOKENS, 0o666).catch(() => {}); }
              t.close();
            }
            {
              // GRN-77 with the token held in memory: a file that goes bad is reported (and stays reported), is never replaced, and the memory token serves this Connect
              const t = await rig({ tokData: JSON.stringify({ botToken: T1, enabled: false }), env: apiEnv });
              t.cmd('connect');
              await t.waitFor((p) => p.connected === true, 8000);
              const broken = '{ "botToken": "' + T1 + '", "enabled": tru';
              await writeFile(t.env.DISCORD_BRIDGE_TOKENS, broken);
              const mB = t.got.length;
              t.cmd('connect');
              await waitAfter(t, mB, (p) => p.connected === true, 8000);
              await nap(1500);
              const afterConnect = (await tokText(t)) === broken;
              t.cmd('reset-auth');
              await nap(700);
              check('GRN-77/92: a token file that was good and goes bad: Connect uses the token held in memory, the file is never replaced (byte for byte), and the sticky rpc.configWarning still says so after the login result and after reset-auth', afterConnect && (await tokText(t)) === broken && /exists but is not valid JSON/.test(warn(t.last)), JSON.stringify({ warn: warn(t.last), same: (await tokText(t)) === broken }));
              t.close();
            }
            {
              // an operator who saves the token file while an update of it is in flight is not overwritten (the update is merged on top of their version)
              const t = await rig({ tokData: JSON.stringify({ botToken: T1, enabled: false }), env: { ...apiEnv, GREENROOM_TIMING: JSON.stringify({ notReadyMs: 0, stallWarnMs: 0, stallLostMs: 0, loginStartMs: 60000, writeDelayMs: 900 }) } });
              t.cmd('connect');
              await nap(400); // the update has read the file and is waiting to rename
              await writeFile(t.env.DISCORD_BRIDGE_TOKENS, JSON.stringify({ botToken: T2, enabled: false, marker: 'operator' }));
              await until(() => { try { return JSON.parse(readFileSync(t.env.DISCORD_BRIDGE_TOKENS, 'utf8')).enabled === true; } catch { return false; } }, 8000);
              let w = null; try { w = JSON.parse(await tokText(t)); } catch { /* left null */ }
              check('GRN-77: a token file the operator saved between the update\'s read and its write is not overwritten with the older copy: their token and field are kept and only enabled changes', !!w && w.botToken === T2 && w.marker === 'operator' && w.enabled === true, JSON.stringify(w));
              t.close();
            }
            {
              // a Reset auth that comes while a Connect is still reading wins (it was the later command)
              const t = await rig({ tokData: JSON.stringify({ botToken: T1, enabled: false }), env: apiEnv });
              t.cmd('connect');
              t.cmd('reset-auth');
              await nap(1800);
              let w = null; try { w = JSON.parse(await tokText(t)); } catch { /* left null */ }
              check('GRN-18/77: Connect and Reset auth sent together: the later one wins (the bot is not started, enabled is false in the file and in the status)', t.last.connected === false && t.last.rpc.enabled === false && !!w && w.enabled === false && w.botToken === T1, JSON.stringify({ connected: t.last.connected, rpc: t.last.rpc, w }));
              t.close();
            }
            {
              const h0 = md.gatewayHits;
              const t = await rig({ tokData: JSON.stringify({ botToken: T1, enabled: 'false' }), env: apiEnv });
              await nap(900);
              check('GRN-92: "enabled": "false" (a string) in the token file does not start the bot', t.last.rpc.enabled === false && md.gatewayHits === h0, JSON.stringify({ enabled: t.last.rpc.enabled, hits: md.gatewayHits - h0 }));
              t.close();
            }
            {
              const t = await rig({ tokData: '{ "botToken": "' + T1 + '", "enabled": false, "appId": 123456789012345678 }', env: apiEnv });
              t.cmd('connect');
              await t.waitFor((p) => p.connected === true, 8000);
              await nap(500);
              check('GRN-77: a bare big integer in another field of the token file keeps its exact digits when the file is written back', /"appId": 123456789012345678\b/.test(await tokText(t)) && /"enabled": true/.test(await tokText(t)), (await tokText(t)).slice(0, 200));
              t.close();
            }
            {
              // [7b] the canary: a random token that is in the token file and nowhere else
              const CANARY = 'canary' + Math.random().toString(36).slice(2, 12) + '.AAAAAAAAAAAAAAAAAAAAAAAA.CCCCCCCCCCCCCCCCCCCCCCCCCCC';
              const t = await rig({ token: CANARY, cfgText: JSON.stringify({ favorites: [], current: null, settings: {} }) });
              const first = t.last;
              const probe = new WebSocket(t.sb.url);
              await new Promise((res, rej) => { probe.on('open', res); probe.on('error', rej); });
              t.cmd('set-settings', JSON.stringify({ accent: 'magenta' }));
              t.cmd('favorite-add', JSON.stringify({ name: 'C', serverId: S1, channelId: C1 }));
              await nap(400);
              const fid = t.last.favorites[0] && t.last.favorites[0].id;
              t.cmd('favorite-update', JSON.stringify({ id: fid, name: 'C2' }));
              t.cmd('set-current', JSON.stringify({ serverId: S1, channelId: C1 }));
              t.cmd('leave');
              probe.send(JSON.stringify({ request: 'DoAction', id: 'sync', action: { name: 'VDO Sync' } })); // a replay of what Streamer.bot holds
              await nap(400);
              t.cmd('favorite-remove', JSON.stringify({ id: fid }));
              t.cmd('reset-auth'); // (never `connect`: that would dial a login)
              await nap(900);
              const actions = await (await fetch(`${t.sb.base}/mock/actions`)).text();
              const state = await (await fetch(`${t.sb.base}/mock/state`)).text();
              try { probe.close(); } catch { /* gone */ }
              const frames = t.frames.join('\n');
              const cfgNow = await fileText(t);
              const everyPayload = JSON.stringify(t.got);
              check('[7b] GRN-179: the token loaded (rpc.hasToken true, no botToken key in rpc), and the canary is in no frame of the bus, no recorded action, no state, no payload, no log line and not in the config file', first.rpc.hasToken === true && !('botToken' in first.rpc) && !frames.includes(CANARY) && !actions.includes(CANARY) && !state.includes(CANARY) && !everyPayload.includes(CANARY) && !t.out.includes(CANARY) && !cfgNow.includes(CANARY), JSON.stringify({ hasToken: first.rpc.hasToken, frames: frames.includes(CANARY), actions: actions.includes(CANARY), state: state.includes(CANARY), out: t.out.includes(CANARY), cfg: cfgNow.includes(CANARY) }));
              const tokNow = JSON.parse(await tokText(t));
              check('[7b] GRN-18/179: …and after reset-auth the token file still holds the canary (reset-auth disables the bot, it does not erase the token)', tokNow.botToken === CANARY && tokNow.enabled === false, JSON.stringify({ enabled: tokNow.enabled, kept: tokNow.botToken === CANARY }));
              t.close();
            }
          } finally {
            await md.close();
          }
        }
        // ── 8f. Streamer.bot's Hello and its password (Sprint 17: GRN-06, GRN-195, GRN-125's bridge half) ──
        {
          console.log('\n[8f] Streamer.bot Hello and password: the bridge serves a genuine Hello only, authenticates when asked, repeats it on reconnect, and the password stays out of every frame and log');
          const PW = 'sbpw-' + Date.now().toString(36) + '-canary-Zq7';
          const T = JSON.stringify({ sbHelloMs: 700 }); // (a shorter wait for a Hello that does not come)
          const noMock = { GREENROOM_ALLOW_MOCK: '0', GREENROOM_TIMING: T };
          const mockOutOf = (sb) => { const o = { text: '' }; sb.child.stdout.setEncoding('utf8'); sb.child.stdout.on('data', (d) => { o.text += d; }); return o; };
          // (A) the peer says it is the mock: not served, unless GREENROOM_ALLOW_MOCK=1
          {
            const a = await rig({ env: noMock, noWait: true });
            await nap(2000);
            check('[8f] GRN-195: a peer that says it is the Greenroom mock is not served (GREENROOM_ALLOW_MOCK unset): the bridge says so, subscribes to nothing and pushes nothing, and stays up', /says it is the Greenroom mock/.test(a.out) && a.got.length === 0 && a.code === null, JSON.stringify({ out: a.out.slice(-300), got: a.got.length, code: a.code }));
          }
          // (A2) a peer the bridge refused (it says it is the mock, or it says nothing) pushes commands anyway: none is obeyed (GRN-195)
          for (const [label, hello] of [['mock', { request: 'Hello', info: { name: 'greenroom-mock', source: 'mock' } }], ['silent', null]]) {
            const wssPort = await freePort();
            const wss = new WebSocketServer({ port: wssPort, host: '127.0.0.1' });
            const cmdFrame = (command, value) => JSON.stringify({ event: { source: 'General', type: 'Custom' }, data: JSON.stringify({ type: 'discord:voice:command', command, value }) });
            wss.on('connection', (ws) => {
              ws.on('error', () => {});
              if (hello) ws.send(JSON.stringify(hello));
              setTimeout(() => { try { ws.send(cmdFrame('favorite-add', JSON.stringify({ name: 'INJECTED', serverId: '900', channelId: '910' }))); ws.send(cmdFrame('quit', '')); } catch { /* gone */ } }, 600);
            });
            const fake = { url: `ws://127.0.0.1:${wssPort}/`, child: { kill() { try { wss.close(); } catch { /* closing */ } } } };
            const g = await rig({ sb: fake, env: noMock, noWait: true });
            await nap(2500);
            const cfgText = await readFile(g.env.DISCORD_BRIDGE_CONFIG, 'utf8').catch(() => '');
            check(`[8f] GRN-195: a peer the bridge refused (${label === 'mock' ? 'it says it is the mock' : 'it says nothing'}) cannot drive it: the favorite-add and quit it pushes are not obeyed (no INJECTED favorite, the bridge is still running)`,
              !/INJECTED/.test(cfgText) && g.code === null && !/command: (favorite-add|quit)/.test(g.out), JSON.stringify({ cfg: cfgText.slice(0, 120), code: g.code, out: g.out.slice(-200) }));
          }
          // (B) a genuine-looking Hello (info.source "websocketServer", not "mock"): served
          {
            const b = await rig({ sb: await startMockWith({ SB_HELLO: 'real' }), env: noMock });
            const first = await b.waitFor(() => true, 6000);
            check('[8f] GRN-195: a Hello that is not the mock\'s is served: the bridge subscribes and pushes its state', !!first && /Connected to Streamer\.bot/.test(b.out), b.out.slice(-200));
          }
          // (C) no Hello at all: no subscribe, unless GREENROOM_ALLOW_MOCK=1 (then as before)
          {
            const c = await rig({ sb: await startMockWith({ SB_HELLO: 'none' }), env: noMock, noWait: true });
            await nap(2200);
            const c2 = await rig({ sb: await startMockWith({ SB_HELLO: 'none' }), env: { GREENROOM_TIMING: T } }); // (the tests' default: GREENROOM_ALLOW_MOCK=1)
            const carried = await c2.waitFor(() => true, 6000);
            check('[8f] GRN-06/195: a server that sends no Hello is not subscribed to ("no Streamer.bot Hello"), unless GREENROOM_ALLOW_MOCK=1, when the bridge carries on as before', /no Streamer\.bot Hello within/.test(c.out) && c.got.length === 0 && !!carried, JSON.stringify({ out: c.out.slice(-200), got: c.got.length, carried: !!carried }));
          }
          // (D) a password: the handshake, the canary, reconnect
          {
            const sb = await startMockWith({ SB_PASSWORD: PW, SB_HELLO: 'real' });
            const mout = mockOutOf(sb);
            const tokData = JSON.stringify({ botToken: '', enabled: false, sbPassword: PW, note: 'kept' });
            const d = await rig({ sb, sbPassword: PW, tokData, env: noMock });
            const first = await d.waitFor(() => true, 8000);
            check('[8f] GRN-06: with Authentication on (a password) and sbPassword in discord-tokens.json the bridge authenticates and then subscribes: its state reaches a subscribed client', !!first && /accepted the password/.test(d.out) && /Connected to Streamer\.bot/.test(d.out), d.out.slice(-300));
            d.cmd('connect'); await nap(500); d.cmd('reset-auth'); await nap(800);
            const tokNow = JSON.parse(await readFile(d.env.DISCORD_BRIDGE_TOKENS, 'utf8'));
            const stateNow = JSON.stringify(await (await fetch(sb.base + '/mock/state')).json());
            const actionsNow = JSON.stringify(await (await fetch(sb.base + '/mock/actions')).json());
            check('[8f] GRN-67/179: the password is in no frame of the bus, no recorded action, no state, no payload and no log line of the bridge; and the token file still holds it (and its other fields) after Connect and reset-auth',
              !d.frames.join('').includes(PW) && !actionsNow.includes(PW) && !stateNow.includes(PW) && !JSON.stringify(d.got).includes(PW) && !d.out.includes(PW) && tokNow.sbPassword === PW && tokNow.note === 'kept' && tokNow.enabled === false,
              JSON.stringify({ frames: d.frames.join('').includes(PW), actions: actionsNow.includes(PW), state: stateNow.includes(PW), out: d.out.includes(PW), tok: tokNow.sbPassword === PW }));
            const before = (mout.text.match(/Authenticate OK/g) || []).length;
            await fetch(sb.base + '/mock/dropall').then((r) => r.arrayBuffer());
            const again = await until(() => (mout.text.match(/Authenticate OK/g) || []).length > before, 10000);
            check('[8f] GRN-06: the handshake is repeated on every reconnect (the connection dropped: the bridge authenticated again)', again, `${before} → ${(mout.text.match(/Authenticate OK/g) || []).length}`);
            await fetch(sb.base + '/mock/mode?authdrop=1').then((r) => r.arrayBuffer());
            const okBefore = (mout.text.match(/Authenticate OK/g) || []).length;
            await fetch(sb.base + '/mock/dropall').then((r) => r.arrayBuffer());
            const recovered = await until(() => /Authenticate DROPPED/.test(mout.text) && (mout.text.match(/Authenticate OK/g) || []).length > okBefore, 16000);
            check('[8f] GRN-06: a connection that drops while the Authenticate waits for its answer does not wedge the bridge: the next connection authenticates again', recovered, mout.text.slice(-300));
            // backup.mjs: the same password from GREENROOM_SB_PASSWORD, or from the token file; the peer is named
            const bkDir = await mkdtemp(resolve(tmpdir(), 'greenroom-bk17-'));
            scratchDirs.push(bkDir);
            const bkBase = { SB_WS_URL: sb.url, GREENROOM_BACKUP_DIR: bkDir, DISCORD_BRIDGE_TOKENS: resolve(bkDir, 'none.json') };
            const withEnv = await runNode(['backup.mjs', 'save', resolve(bkDir, 'a.json')], { ...bkBase, GREENROOM_SB_PASSWORD: PW });
            const withFile = await runNode(['backup.mjs', 'save', resolve(bkDir, 'b.json')], { ...bkBase, DISCORD_BRIDGE_TOKENS: d.env.DISCORD_BRIDGE_TOKENS });
            const without = await runNode(['backup.mjs', 'save', resolve(bkDir, 'c.json')], bkBase);
            const wrong = await runNode(['backup.mjs', 'save', resolve(bkDir, 'd.json')], { ...bkBase, GREENROOM_SB_PASSWORD: 'not-the-password' });
            check('[8f] GRN-06/195: backup.mjs authenticates with GREENROOM_SB_PASSWORD or the sbPassword field and names the peer; without a password or with a wrong one it says so and does nothing; the password is never printed',
              /peer:   Streamer\.bot 0\.2\.5/.test(withEnv.out) && /peer:   Streamer\.bot 0\.2\.5/.test(withFile.out) && !/refused the (password|Subscribe)/.test(withEnv.out + withFile.out)
              && without.code !== 0 && /GREENROOM_SB_PASSWORD/.test(without.out) && wrong.code !== 0 && /refused the password/.test(wrong.out)
              && ![withEnv, withFile, without, wrong].some((x) => x.out.includes(PW) || x.out.includes('not-the-password')),
              JSON.stringify({ withEnv: withEnv.out.slice(-160), withFile: withFile.out.slice(-160), without: without.out.slice(-200), wrong: wrong.out.slice(-160) }));
          }
          // (E) a wrong password, no password, Enforce off
          {
            const sbE = await startMockWith({ SB_PASSWORD: PW, SB_HELLO: 'real' });
            const wrong = await rig({ sb: sbE, sbPassword: PW, tokData: JSON.stringify({ botToken: '', enabled: false, sbPassword: 'wrong-pw-1' }), env: noMock, noWait: true });
            await nap(2000);
            check('[8f] GRN-06/125: a wrong sbPassword is a visible failure ("refused the password") and no Subscribe: nothing is pushed', /refused the password/.test(wrong.out) && wrong.got.length === 0 && !wrong.out.includes('wrong-pw-1'), wrong.out.slice(-250));
            const none = await rig({ sb: sbE, sbPassword: PW, env: noMock, noWait: true });
            await nap(2000);
            await nap(5500); // (past a heartbeat: a bridge that kept pushing would log a refusal for it)
            check('[8f] GRN-06/125: Authentication on and no sbPassword: the bridge says so and the refused Subscribe is logged (a non-ok ack is no longer silent); it then stops sending (one refusal in the log, not one per push) and does not claim to be connected', /no sbPassword/.test(none.out) && /refused the Subscribe/.test(none.out) && (none.out.match(/Streamer\.bot refused/g) || []).length === 1 && !/Connected to Streamer\.bot/.test(none.out) && none.got.length === 0, none.out.slice(-400));
            // a password written as a number, a UTF-16 token file
            const sbI = await startMockWith({ SB_PASSWORD: PW, SB_HELLO: 'real' });
            const numPw = await rig({ sb: sbI, sbPassword: PW, tokData: '{ "botToken": "", "enabled": false, "sbPassword": 12345678 }', env: noMock, noWait: true });
            await nap(2000);
            check('[8f] GRN-06: an sbPassword written as a number is named ("is not text … write the password in quotes"), not reported as missing', /is not text/.test(numPw.out) && !/has no sbPassword/.test(numPw.out), numPw.out.slice(-300));
            const bk16 = await mkdtemp(resolve(tmpdir(), 'greenroom-bk17b-'));
            scratchDirs.push(bk16);
            const tok16 = resolve(bk16, 'tok16.json');
            await writeFile(tok16, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(JSON.stringify({ sbPassword: PW }), 'utf16le')]));
            const u16 = await runNode(['backup.mjs', 'save', resolve(bk16, 'u.json')], { SB_WS_URL: sbI.url, GREENROOM_BACKUP_DIR: bk16, DISCORD_BRIDGE_TOKENS: tok16 });
            check('[8f] GRN-06: backup.mjs reads the sbPassword from a UTF-16 token file (with a BOM) as the bridge does', /peer:   Streamer\.bot 0\.2\.5/.test(u16.out) && !/refused|closed the connection/.test(u16.out), u16.out.slice(-250));
            const off = await rig({ sb: await startMockWith({ SB_PASSWORD: PW, SB_HELLO: 'real', SB_AUTH: 'serve' }), env: noMock });
            const served = await off.waitFor(() => true, 6000);
            check('[8f] GRN-06: Authentication on with Enforce off and no sbPassword: served as before', !!served, off.out.slice(-200));
          }
          // (E2) obs-browser writes an error-level console message of a page to the OBS log with the page's address (query included) as its source,
          // and these two pages hold their client in an inline script and can carry ?sbpass: they print warnings, never errors
          {
            const inline = async (rel) => { const t = await readFile(resolve(__dirname, rel), 'utf8'); return [...t.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n'); };
            const errs = [];
            for (const rel of ['control/control.html', 'control/director-min.html']) if (/console\.error\s*\(/.test(await inline(rel))) errs.push(rel);
            check('[8f] GRN-67: control.html and director-min.html (which can carry ?sbpass in their address) print no error-level console message from their inline scripts (OBS logs those with the page address as the source)', errs.length === 0, errs.join(', '));
          }
          // (F) the helpers all three pages share
          {
            const vm = await import('node:vm');
            const src = (await readFile(resolve(__dirname, 'overlay', 'panel-client-sb.js'), 'utf8')).replace(/\r\n/g, '\n');
            const block = /\/\/ <sb-conn>[\s\S]*?\/\/ <\/sb-conn>/.exec(src);
            const ctx = vm.createContext({ URLSearchParams, URL, TextEncoder, crypto: globalThis.crypto, btoa });
            const api = vm.runInContext(`(() => {\n${block[0]}\nreturn { sbAuthValue, sbPassParam, sbHelloAuth };\n})()`, ctx);
            const ref = (pw, salt, ch) => { const h = (t) => createHash('sha256').update(t).digest('base64'); return h(h(pw + salt) + ch); };
            const v1 = await api.sbAuthValue('hunter2', 'NaCl+/=', 'chal+lenge/');
            const v2 = await api.sbAuthValue('pässwörd ✓', 'salt', 'challenge');
            check('[8f] GRN-06: the page helpers compute b64(sha256(b64(sha256(password + salt)) + challenge)) (UTF-8 for a non-ASCII password), read ?sbpass exactly, and take a Hello authentication block only with a salt and a challenge',
              v1 === ref('hunter2', 'NaCl+/=', 'chal+lenge/') && v2 === ref('pässwörd ✓', 'salt', 'challenge') && api.sbPassParam('?a=1&sbpass=p%26w+x') === 'p&w x' && api.sbPassParam('?a=1') === ''
              && !!api.sbHelloAuth({ authentication: { salt: 's', challenge: 'c' } }) && api.sbHelloAuth({ authentication: {} }) === null && api.sbHelloAuth({}) === null, JSON.stringify({ v1, v2 }));
          }
        }
      } finally {
        for (const r of live) { r.close(); try { r.sb.child.kill(); } catch {} }
      }
    }

    } // end of the sidecar sections ([7], [8], [8b])

    // ── 9. config backup CLI: save + restore round-trip (backup.mjs vs the mock) ──
    // The shared mock still holds VDO_PAYLOAD from [2] (room 'testroom', 2 directory
    // entries). Snapshot it, mutate SB's vdo.state, restore the file, confirm revert.
    console.log('\n[9] config backup CLI: backup.mjs save + restore round-trip');
    const backupFile = resolve(__dirname, '.verify-backup.json');
    await rm(backupFile, { force: true });
    const bkDir = await mkdtemp(resolve(tmpdir(), 'greenroom-bk9-')); // restore's pre-restore snapshots go here, never into backups/
    scratchDirs.push(bkDir);
    const bkEnv = { GREENROOM_BACKUP_DIR: bkDir };
    const saveRes = await runNode(['backup.mjs', 'save', backupFile], bkEnv);
    check('backup save exits 0', saveRes.code === 0, saveRes.out.trim());
    let saved = null;
    try { saved = JSON.parse(await readFile(backupFile, 'utf8')); } catch { /* left null */ }
    check('backup file is an envelope with the vdo.state (room + directory intact)',
      !!saved && saved.kind === 'greenroom-vdo-backup' && saved.vdoninja && saved.vdoninja.room === 'testroom' && saved.vdoninja.password === 'pw1'
      && Array.isArray(saved.vdoninja.directory) && saved.vdoninja.directory.length === 2,
      saved ? JSON.stringify({ kind: saved.kind, room: saved.vdoninja && saved.vdoninja.room }) : 'no file');

    const mutator = await rawClient();
    mutator.doAction('VDO Push', { payload: JSON.stringify({ ...VDO_PAYLOAD, room: 'CHANGED', directory: [] }) });
    await new Promise((r) => setTimeout(r, 250));
    const midState = await (await fetch(`${BASE}/mock/state`)).json();
    check('precondition: SB vdo.state mutated to room "CHANGED", directory emptied',
      midState.vdo && midState.vdo.room === 'CHANGED' && midState.vdo.directory.length === 0);

    const restoreRes = await runNode(['backup.mjs', 'restore', backupFile, '--yes'], bkEnv);
    check('backup restore --yes exits 0', restoreRes.code === 0, restoreRes.out.trim());
    await new Promise((r) => setTimeout(r, 250));
    const afterState = await (await fetch(`${BASE}/mock/state`)).json();
    check('restore re-pushed the snapshot → SB vdo.state is "testroom" again with the 2 directory entries',
      afterState.vdo && afterState.vdo.room === 'testroom' && Array.isArray(afterState.vdo.directory) && afterState.vdo.directory.length === 2);
    const sameJson = (a, b) => { const canon = (x) => (Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x); return JSON.stringify(canon(a)) === JSON.stringify(canon(b)); };
    const stampedAt = afterState.vdo && Number(afterState.vdo.rev);
    check('the restored vdo.state deep-equals the fixture (room, the password "pw1", slots, invite, directory as the page would sanitise it), as a NEW write: the slots\' stream IDs blanked (they were true when the file was saved), schemaVersion 2, rev = the time of the restore, writer "backup" (GRN-64, GRN-70)',
      sameJson(afterState.vdo, { ...VDO_PAYLOAD, slots: VDO_PAYLOAD.slots.map((s) => ({ ...s, streamID: '' })), directory: D.sanitizeDirectory(VDO_PAYLOAD.directory), schemaVersion: 2, rev: stampedAt, writer: 'backup' })
      && Number.isInteger(stampedAt) && Math.abs(stampedAt - Date.now()) < 60000 && VDO_PAYLOAD.slots.some((s) => s.streamID), JSON.stringify(afterState.vdo).slice(0, 300));
    const preRestore = (await readdir(bkDir)).filter((n) => /^pre-restore-.*\.json$/.test(n));
    let preState = null; try { preState = JSON.parse(await readFile(resolve(bkDir, preRestore[0]), 'utf8')); } catch { /* left null */ }
    check('restore first wrote pre-restore-<time>.json (the state it was about to replace, room "CHANGED") into the snapshot folder, and nothing into backups/',
      preRestore.length === 1 && !!preState && preState.vdoninja && preState.vdoninja.room === 'CHANGED', JSON.stringify({ preRestore }));
    check('backup round-trip keeps the auto-add companions (autoAdd flag + ignore list)',
      afterState.vdo && afterState.vdo.directoryAutoAdd === true
      && Array.isArray(afterState.vdo.directoryIgnored) && afterState.vdo.directoryIgnored.includes('vdo:leavemealone'),
      JSON.stringify(afterState.vdo && afterState.vdo.directoryIgnored));

    // a stored rev that is AHEAD of the clock (a fast clock that was corrected): the restore must still be newer than it, or every page drops it
    const futureRev = Date.now() + 3600000;
    mutator.doAction('VDO Push', { payload: JSON.stringify({ ...VDO_PAYLOAD, room: 'AHEAD', schemaVersion: 2, rev: futureRev, writer: 'wFast' }) });
    await new Promise((r) => setTimeout(r, 250));
    const restoreAhead = await runNode(['backup.mjs', 'restore', backupFile, '--yes'], bkEnv);
    await new Promise((r) => setTimeout(r, 250));
    const aheadState = await (await fetch(`${BASE}/mock/state`)).json();
    check('a restore over a saved state whose rev is ahead of the clock is stamped above it (else every page would drop it as stale), and says the live IDs are put back by the designated director',
      restoreAhead.code === 0 && aheadState.vdo && aheadState.vdo.room === 'testroom' && Number(aheadState.vdo.rev) > futureRev && aheadState.vdo.writer === 'backup' && /designated|always-on|dock/i.test(restoreAhead.out), restoreAhead.out.trim().slice(0, 300) + ' | rev ' + (aheadState.vdo && aheadState.vdo.rev));

    const bogus = await runNode(['backup.mjs', 'restore', resolve(__dirname, '.verify-nope-missing.json'), '--yes'], bkEnv);
    check('restore of a missing/garbage file exits non-zero (refuses to push junk)', bogus.code !== 0, `code=${bogus.code}`);
    mutator.close();
    await rm(backupFile, { force: true });
    await rm(bkDir, { recursive: true, force: true });

    // ── 10. mock safety: it announces itself, never takes Streamer.bot's ports, and survives junk (GRN-74 and friends) ──
    console.log('\n[10] mock safety: Hello with source "mock", own ports, refuses taken ports, survives junk, the bridge guard');
    {
      const quick = (script, env, args = [], ms = 8000) => new Promise((res) => {
        const c = spawn(process.execPath, [script, ...args], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv(env) });
        let out = '';
        c.stdout.setEncoding('utf8'); c.stdout.on('data', (d) => (out += d));
        c.stderr.setEncoding('utf8'); c.stderr.on('data', (d) => (out += d));
        const t = setTimeout(() => { try { c.kill(); } catch {} res({ code: null, out, timedOut: true }); }, ms);
        c.on('exit', (code) => { clearTimeout(t); res({ code, out, timedOut: false }); });
      });
      const src = await readFile(resolve(__dirname, 'mock-sb-server.mjs'), 'utf8');
      check('the mock\'s default ports are not Streamer.bot\'s (7474 / 8080): npm run mock cannot land on a live install', !/\|\| (7474|8080)\b/.test(src));
      const pkg = JSON.parse(await readFile(resolve(__dirname, 'package.json'), 'utf8'));
      check('package.json: no "start" script (it would run the mock on a streaming PC), "mock" runs it; playwright-core is a pinned devDependency (GRN-158, GRN-219)',
        !('start' in pkg.scripts) && /mock-sb-server/.test(pkg.scripts.mock || '') && /^\d+\.\d+\.\d+$/.test((pkg.devDependencies || {})['playwright-core'] || ''), JSON.stringify({ scripts: pkg.scripts, dev: pkg.devDependencies }));

      const m10 = await startMockWith({});
      try {
        // Hello: every connection is told this is a mock (GRN-74, GRN-195's reuse).
        const first = await new Promise((res) => {
          const w = new WebSocket(m10.url); const t = setTimeout(() => { try { w.close(); } catch {} res(null); }, 3000);
          w.on('message', (raw) => { clearTimeout(t); try { w.close(); } catch {} try { res(JSON.parse(raw.toString())); } catch { res(null); } });
        });
        check('the mock sends a Hello on connect, {request:"Hello", info:{name:"greenroom-mock", source:"mock"}}', !!first && first.request === 'Hello' && first.info && first.info.source === 'mock' && first.info.name === 'greenroom-mock', JSON.stringify(first));
        const sub = await rawClient(m10.url);
        const ack = await sub.acks.next(3000, (m) => String(m.id).startsWith('sub'), 'Subscribe ack');
        check('…and the Subscribe ack is still the flat {status, id, events} shape (no result key)', ack.status === 'ok' && !('result' in ack) && !!ack.events, JSON.stringify(ack));

        // GRN-191: the Subscribe match ignores case.
        const lax = await new Promise((res) => {
          const w = new WebSocket(m10.url); let got = false;
          w.on('open', () => { w.send(JSON.stringify({ request: 'Subscribe', id: 'c1', events: { General: ['custom'] } })); setTimeout(() => fetch(m10.base + '/mock/broadcast', { method: 'POST', body: JSON.stringify({ type: 'greenroom:ping' }) }).then((r) => r.arrayBuffer()), 300); });
          w.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.event && m.data && m.data.type === 'greenroom:ping') { got = true; } } catch {} });
          setTimeout(() => { try { w.close(); } catch {} res(got); }, 1500);
        });
        check('a Subscribe whose key and type differ only in case (General / custom) still receives the broadcasts', lax);

        // GRN-212: junk frames never end the process.
        const junkWs = await new Promise((res) => { const w = new WebSocket(m10.url); w.on('open', () => res(w)); });
        for (const junk of ['null', '"x"', '7', '[1]', '{"request":null}', '{"request":"DoAction","action":null,"args":null,"id":1}', 'not json']) junkWs.send(junk);
        await new Promise((r) => setTimeout(r, 400));
        junkWs.terminate(); // an abrupt close
        const alive1 = await fetch(m10.base + '/mock/state').then((r) => r.status).catch(() => 'down');
        check('junk frames (null, a string, a number, an array, an action with no name or args) and an abrupt close do not end the mock', alive1 === 200, String(alive1));
        // A WebSocket protocol violation (an unmasked client frame) raises an 'error' event on the server's socket. Without the
        // mock's per-connection error handler that is an uncaught exception, and the process ends.
        await new Promise((res) => {
          import('node:net').then(({ connect }) => {
            const sock = connect(m10.wsPort, '127.0.0.1');
            let upgraded = false;
            sock.on('data', (d) => { if (!upgraded && /101/.test(d.toString())) { upgraded = true; sock.write(Buffer.from([0x81, 0x01, 0x41])); setTimeout(() => { sock.destroy(); res(); }, 400); } });
            sock.on('connect', () => sock.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
            sock.on('error', () => res());
            setTimeout(res, 3000);
          });
        });
        const alive1b = await fetch(m10.base + '/mock/state').then((r) => r.status).catch(() => 'down');
        check('a WebSocket protocol violation (an unmasked client frame) does not end the mock either', alive1b === 200, String(alive1b));

        // GRN-17: a malformed %-escape is a 400, not a crash.
        const bad = await new Promise((res) => {
          import('node:http').then(({ request }) => {
            const r = request({ host: '127.0.0.1', port: m10.httpPort, path: '/control/%E0%A4%A', method: 'GET' }, (resp) => { resp.resume(); res(resp.statusCode); });
            r.on('error', () => res('down')); r.end();
          });
        });
        const alive2 = await fetch(m10.base + '/mock/state').then((r) => r.status).catch(() => 'down');
        check('a request path with a malformed %-escape is answered 400 and the mock keeps running', bad === 400 && alive2 === 200, String(bad) + '/' + alive2);

        // GRN-158: a page the mock serves never falls back to the default Streamer.bot port.
        const noPort = await fetch(m10.base + '/control/control.html', { redirect: 'manual' });
        const withPort = await fetch(m10.base + '/control/control.html?sbport=' + m10.wsPort);
        await withPort.arrayBuffer();
        check('/control/ and /overlay/ pages requested without ?sbport are redirected to the same URL with sbport=<this mock\'s WS port>; with it they are served',
          noPort.status === 302 && new URL(noPort.headers.get('location'), m10.base).searchParams.get('sbport') === String(m10.wsPort) && withPort.status === 200, noPort.status + ' ' + noPort.headers.get('location'));
        {
          // The browser reads the extension case-insensitively and the query from the FIRST '?'. A URL where the mock and the browser
          // disagree used to be served unredirected (the page then falls back to port 8080) or redirected forever.
          const hop = async (u) => { const r = await fetch(m10.base + u, { redirect: 'manual' }); await r.arrayBuffer(); return { status: r.status, loc: r.headers.get('location') }; };
          const settle = async (u) => { let cur = u; for (let i = 0; i < 4; i++) { const h = await hop(cur); if (h.status !== 302) return { status: h.status, url: cur, hops: i }; cur = h.loc; } return { status: 302, url: cur, hops: 4 }; };
          const sbOf = (u) => new URLSearchParams(u.slice(u.indexOf('?') + 1)).get('sbport');
          const variants = ['/control/control.HTML', '/overlay/vdoninja-guest.Html?slot=1', '/control/control.html?x=1?y=2', '/control/control.html?sbport?x=1', '/control/control.html?slot=1&sbport?x=1'];
          const bad = [];
          for (const v of variants) {
            const r = await settle(v);
            if (!(r.status === 200 && sbOf(r.url) === String(m10.wsPort))) bad.push(v + ' -> ' + r.status + ' ' + r.url + ' (' + r.hops + ' hops)');
          }
          check('pages are only served with this mock\'s ?sbport as a BROWSER reads it: an upper-case extension, a second "?" or a stray "?" after the key are redirected (once) to a URL whose sbport is this mock\'s, never served bare and never looped',
            bad.length === 0, JSON.stringify(bad));
        }
        sub.close();
      } finally { m10.child.kill(); }

      // A taken port: the mock refuses to start (GRN-158). Both a loopback-only and an all-interfaces listener count.
      const { createServer: createTcp } = await import('node:net');
      for (const host of ['127.0.0.1', '0.0.0.0']) {
        const blocker = createTcp(); const bp = await new Promise((res) => blocker.listen(0, host, () => res(blocker.address().port)));
        const freeHttp = await freePort();
        const r = await quick('mock-sb-server.mjs', { SB_HTTP_PORT: String(freeHttp), SB_WS_PORT: String(bp) });
        blocker.close();
        check(`the mock refuses to start when its WebSocket port is already taken (listener on ${host}): exit non-zero, says so, and prints no READY`,
          !r.timedOut && r.code !== 0 && /already in use|in use/i.test(r.out) && !/READY/.test(r.out), JSON.stringify({ code: r.code, out: r.out.slice(0, 200) }));
      }
      {
        const blocker6 = createTcp();
        const bp6 = await new Promise((res) => { blocker6.once('error', () => res(0)); blocker6.listen(0, '::', () => res(blocker6.address().port)); });
        if (bp6) {
          const freeHttp6 = await freePort();
          const r6 = await quick('mock-sb-server.mjs', { SB_HTTP_PORT: String(freeHttp6), SB_WS_PORT: String(bp6) });
          blocker6.close();
          check('the mock refuses to start when its WebSocket port is held by a dual-stack [::] listener too', !r6.timedOut && r6.code !== 0 && /in use/i.test(r6.out) && !/READY/.test(r6.out), JSON.stringify({ code: r6.code, out: r6.out.slice(0, 200) }));
        } else console.log('  (no IPv6 on this machine: the [::] port check is not exercised)');
        const rSb = await quick('mock-sb-server.mjs', { SB_HTTP_PORT: '7474', SB_WS_PORT: String(await freePort()) });
        const rSb2 = await quick('mock-sb-server.mjs', { SB_HTTP_PORT: String(await freePort()), SB_WS_PORT: '8080' });
        check('the mock refuses Streamer.bot\'s own ports (7474, 8080) outright, even if SB_HTTP_PORT / SB_WS_PORT are exported for the real tools, and prints no READY',
          [rSb, rSb2].every((r) => !r.timedOut && r.code !== 0 && /Streamer\.bot's own/.test(r.out) && !/READY/.test(r.out)), JSON.stringify([rSb.out.slice(0, 160), rSb2.out.slice(0, 160)]));
      }
      // READY (GRN-200): printed once, only after both listeners are bound, and never inside an error line.
      {
        const rp = await freePort(), rw = await freePort();
        const rc = spawn(process.execPath, ['mock-sb-server.mjs'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv({ SB_HTTP_PORT: String(rp), SB_WS_PORT: String(rw) }) });
        let rout = '', rerr = '', hello = null;
        rc.stdout.setEncoding('utf8'); rc.stdout.on('data', (d) => { rout += d; });
        rc.stderr.setEncoding('utf8'); rc.stderr.on('data', (d) => { rerr += d; });
        const t0 = Date.now(); while (!/READY/.test(rout) && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 25));
        // the moment READY is seen, both listeners must already answer
        const httpNow = await fetch('http://127.0.0.1:' + rp + '/mock/state').then((r) => r.status).catch(() => 'down');
        hello = await new Promise((res) => { const w = new WebSocket('ws://127.0.0.1:' + rw + '/'); const t = setTimeout(() => { try { w.close(); } catch {} res(null); }, 2000); w.on('message', (raw) => { clearTimeout(t); try { w.close(); } catch {} try { res(JSON.parse(raw.toString())); } catch { res(null); } }); w.on('error', () => res(null)); });
        await new Promise((r) => setTimeout(r, 300));
        rc.kill();
        check('READY is printed exactly once, on stdout, with the real ports, and both listeners already answer when it is seen',
          (rout.match(/\[mock\] READY/g) || []).length === 1 && rout.includes('READY http=' + rp + ' ws=' + rw) && !/READY/.test(rerr) && httpNow === 200 && !!hello && hello.info && hello.info.source === 'mock',
          JSON.stringify({ rout: rout.slice(-200), httpNow, hello }));
      }

      // The bridge guard: it sends nothing to anything that is not announcing itself as a mock (GRN-74).
      const { WebSocketServer } = await import('ws');
      const sentinel = async (helloFrame) => {
        const port = await freePort(); const frames = [];
        const wss = new WebSocketServer({ host: '127.0.0.1', port });
        wss.on('connection', (c) => { if (helloFrame) c.send(JSON.stringify(helloFrame)); c.on('message', (raw) => frames.push(raw.toString())); });
        await new Promise((r) => wss.on('listening', r));
        return { port, frames, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }) };
      };
      for (const [what, hello] of [['a real Streamer.bot Hello (no source)', { request: 'Hello', info: { name: 'Streamer.bot', version: '1.0.7' } }], ['no Hello at all', null]]) {
        const sn = await sentinel(hello);
        const r = await quick('mock-discord-bridge.mjs', { SB_WS_URL: `ws://127.0.0.1:${sn.port}/` }, [], 9000);
        await sn.close();
        check(`mock:bridge pointed at a server that sent ${what}: names its target first, REFUSES (exit 2), and sends it nothing`,
          !r.timedOut && r.code === 2 && /REFUSING to act on/.test(r.out) && r.out.split('\n')[0].includes(`ws://127.0.0.1:${sn.port}/`) && sn.frames.length === 0, JSON.stringify({ code: r.code, timedOut: r.timedOut, frames: sn.frames.length, out: r.out.slice(0, 240) }));
      }
      {
        // a server that hangs up before it says Hello: the bridge reconnects (it does not exit later with a stale 'no Hello' reason)
        const port = await freePort(); const frames = [];
        const wss = new WebSocketServer({ host: '127.0.0.1', port });
        wss.on('connection', (c) => { c.on('message', (raw) => frames.push(raw.toString())); setTimeout(() => { try { c.close(); } catch {} }, 150); });
        await new Promise((r) => wss.on('listening', r));
        const rc = await quick('mock-discord-bridge.mjs', { SB_WS_URL: 'ws://127.0.0.1:' + port + '/' }, [], 5200);
        for (const c of wss.clients) c.terminate();
        await new Promise((r) => wss.close(r));
        check('mock:bridge whose server hangs up before the Hello retries (still running after 5 s, no stale "no Hello" refusal) and sends nothing',
          rc.timedOut && !/REFUSING/.test(rc.out) && /retrying/.test(rc.out) && frames.length === 0, JSON.stringify({ timedOut: rc.timedOut, out: rc.out.slice(0, 260), frames: frames.length }));
      }
      const snOk = await sentinel({ request: 'Hello', info: { name: 'Streamer.bot', version: '1.0.7' } });
      const rOk = await quick('mock-discord-bridge.mjs', { SB_WS_URL: `ws://127.0.0.1:${snOk.port}/` }, ['--allow-real-sb'], 2500);
      await snOk.close();
      check('mock:bridge --allow-real-sb drives such a server anyway (it subscribes and pushes)', snOk.frames.length >= 2 && snOk.frames.some((f) => /Subscribe/.test(f)) && snOk.frames.some((f) => /Discord Voice Push/.test(f)), String(snOk.frames.length));
    }

    // ── 11. the harness's environment allowlist, under a hostile shell (GRN-208, GRN-209) ──
    console.log('\n[11] harness environment: a shell that exports SB_WS_URL and friends reaches nothing the harness starts');
    {
      const { WebSocketServer } = await import('ws');
      const frames = []; const connections = [];
      const sPort = await freePort();
      const sWss = new WebSocketServer({ host: '127.0.0.1', port: sPort });
      sWss.on('connection', (c) => { connections.push(1); c.on('message', (raw) => frames.push(raw.toString().slice(0, 80))); c.on('error', () => {}); });
      await new Promise((r) => sWss.on('listening', r));
      const hostile = { SB_WS_URL: 'ws://127.0.0.1:' + sPort + '/', SB_WS_PORT_HOSTILE: '1', GREENROOM_EXIT_ON_SB_CLOSE: '1', GREENROOM_GUARD_PORT: '1', DISCORD_BRIDGE_CONFIG: 'Z:/nowhere/config.json', DISCORD_BRIDGE_TOKENS: 'Z:/nowhere/tokens.json' };
      const saved = {}; for (const k of Object.keys(hostile)) { saved[k] = process.env[k]; process.env[k] = hostile[k]; }
      let envMock, envBridge, envOut = null;
      try {
        envMock = await startMockWith({});
        envBridge = await startChild('mock-discord-bridge.mjs', '[mock-bridge] up', { SB_WS_URL: envMock.url, SB_WS_PORT: String(envMock.wsPort) });
        const bk = resolve(__dirname, '.verify-backup-env.json');
        const seed = await rawClient(envMock.url);
        seed.doAction('VDO Push', { payload: JSON.stringify(VDO_PAYLOAD) });
        await new Promise((r) => setTimeout(r, 400));
        // runNode with NO explicit SB_WS_URL: the harness default is its own mock, whatever the shell exported
        envOut = await runNode(['backup.mjs', 'save', bk], { SB_WS_PORT: String(envMock.wsPort) });
        seed.close();
        await rm(bk, { force: true });
      } finally {
        for (const k of Object.keys(hostile)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        if (envBridge) envBridge.kill();
        if (envMock) envMock.child.kill();
        await new Promise((r) => sWss.close(r));
      }
      check('with SB_WS_URL, GREENROOM_* and DISCORD_BRIDGE_* exported to a listener that must never be spoken to, the mock bridge, backup.mjs and the mocks the harness starts send it nothing and never connect',
        frames.length === 0 && connections.length === 0 && !!envOut, JSON.stringify({ frames, connections: connections.length, backup: envOut && envOut.out.slice(0, 160) }));
    }

    // ── 12. the backup CLI: it restores only a checked snapshot, to the Streamer.bot you meant (GRN-70 and friends) ──
    console.log('\n[12] backup CLI: strict arguments, a checked snapshot, a confirmed push, a pre-restore copy');
    {
      const bdir = await mkdtemp(resolve(tmpdir(), 'greenroom-bk12-'));
      scratchDirs.push(bdir);
      const rootBefore = (await readdir(__dirname)).sort().join('|'); // the repo root must not gain a file from these runs
      const goodEnv = (m, extra = {}) => ({ SB_WS_URL: m.url, GREENROOM_BACKUP_DIR: bdir, INIT_CWD: bdir, ...extra });
      const bk = (m, args, extra = {}) => runNode(['backup.mjs', ...args], goodEnv(m, extra));
      const seedState = { ...VDO_PAYLOAD, room: 'liveroom' };
      const stateRoom = async (m) => ((await (await fetch(m.base + '/mock/state')).json()).vdo || {}).room;
      const snapshot = (over = {}) => ({ kind: 'greenroom-vdo-backup', savedAt: '2026-01-01T00:00:00.000Z', vdoninja: { ...VDO_PAYLOAD, ...over } });
      const put = async (name, content) => { const p = resolve(bdir, name); await writeFile(p, content); return p; };
      // env: options for the mock at start; mode: a /mock/mode query applied AFTER the seeding push (so a push-refusing mock still holds a state)
      const fresh = async (env = {}, mode = '') => {
        const m = await startMockWith(env);
        try {
          const c = await rawClient(m.url);
          c.doAction('VDO Push', { payload: JSON.stringify(seedState) });
          for (let i = 0; i < 40; i++) { if ((await stateRoom(m)) === seedState.room) break; await new Promise((r) => setTimeout(r, 50)); }
          if (mode) await fetch(m.base + '/mock/mode?' + mode).then((r) => r.arrayBuffer());
          await fetch(m.base + '/mock/actions?clear=1').then((r) => r.arrayBuffer());
          c.close();
          return m;
        } catch (e) { m.child.kill(); throw e; }
      };
      const actionsOf = async (m) => (await (await fetch(m.base + '/mock/actions')).json()).actions;
      const connsOf = async (m) => (await (await fetch(m.base + '/mock/conns')).json()).conns.length;

      // (a) files it must refuse: nothing is pushed, the live state is unchanged
      const mA = await fresh();
      try {
        const refusals = [
          ['an empty object {}', '{}', ['--yes']],
          ['a valid JSON object that is not a snapshot', '{"hello":"world"}', ['--yes']],
          ['a snapshot of a different kind', JSON.stringify({ kind: 'something-else', vdoninja: snapshot().vdoninja }), ['--yes']],
          ['a raw payload with no kind, without --force', JSON.stringify(snapshot().vdoninja), ['--yes']],
          ['a room that is not text', JSON.stringify(snapshot({ room: 42 })), ['--yes']],
          ['slots that are not a list', JSON.stringify(snapshot({ slots: 'x' })), ['--yes'], /no slots list/],
          ['a Discord ID written as a number (its digits are already rounded)', '{"kind":"greenroom-vdo-backup","vdoninja":' + JSON.stringify({ ...VDO_PAYLOAD, directory: [] }).replace('"discordUserId":""', '"discordUserId":123456789012345678') + '}', ['--yes']],
          ['a Discord ID written as a number inside a directory entry', '{"kind":"greenroom-vdo-backup","vdoninja":' + JSON.stringify({ ...VDO_PAYLOAD, directory: [{ vdoLabel: 'A', discordUserId: '1', displayName: 'A', socials: [] }] }).replace('"discordUserId":"1"', '"discordUserId":123456789012345678') + '}', ['--yes']],
          ['a slot entry that is not an object', JSON.stringify(snapshot({ slots: [null, ...VDO_PAYLOAD.slots.slice(1)] })), ['--yes']],
          ['a snapshot from a newer Greenroom', JSON.stringify(snapshot({ schemaVersion: 99 })), ['--yes']],
          ['a good snapshot, but no --yes', JSON.stringify(snapshot()), []],
        ];
        const failed = [];
        for (const [what, text, flags, say] of refusals) {
          const p = await put('refuse.json', text);
          const r = await bk(mA, ['restore', p, ...flags]);
          const pushes = (await actionsOf(mA)).filter((a) => a.name === 'VDO Push').length;
          // (some refusals must also say why, in their own words: a crash with a stack trace refuses too, but tells the operator nothing; mutant M43)
          if (!(r.code !== 0 && pushes === 0 && (await stateRoom(mA)) === 'liveroom' && (!say || say.test(r.out)))) failed.push(what + ' -> code ' + r.code + ', pushes ' + pushes + (say && !say.test(r.out) ? ', said: ' + r.out.trim().slice(0, 120) : ''));
        }
        check('restore refuses each of ' + refusals.length + ' unsafe or unconfirmed inputs (exit non-zero, nothing pushed, the live vdo.state unchanged)', failed.length === 0, JSON.stringify(failed));
        const p2 = await put('forced.json', JSON.stringify(snapshot().vdoninja));
        const rf = await bk(mA, ['restore', p2, '--yes', '--force']);
        check('…--force accepts a raw payload with no kind (and --yes still pushes it)', rf.code === 0 && (await stateRoom(mA)) === 'testroom', rf.out.trim().slice(0, 200));
      } finally { mA.child.kill(); }

      // (b) a confirmed push: the ack is checked, the rebroadcast is matched, the old state is saved first
      for (const [what, mode, want] of [['a VDO Push the server acks with status "error"', 'push=error', /refused|not found|error/i], ['a VDO Push that is acked but stores and broadcasts nothing', 'push=drop', /not confirmed|no rebroadcast|did not/i]]) {
        const m = await fresh({}, mode);
        try {
          const p = await put('snap.json', JSON.stringify(snapshot()));
          const r = await bk(m, ['restore', p, '--yes']);
          check('restore of ' + what + ' exits non-zero, says so, never claims "will repaint", and leaves the live vdo.state alone',
            r.code !== 0 && want.test(r.out) && !/will repaint/.test(r.out) && (await stateRoom(m)) === 'liveroom', JSON.stringify({ code: r.code, out: r.out.trim().slice(0, 300) }));
        } finally { m.child.kill(); }
      }
      {
        const m = await fresh();
        try {
          const p = await put('snap2.json', JSON.stringify(snapshot()));
          const preBefore = (await readdir(bdir)).filter((n) => /^pre-restore-.*\.json$/.test(n)).length;
          const r = await bk(m, ['restore', p, '--yes']);
          const pre = (await readdir(bdir)).filter((n) => /^pre-restore-.*\.json$/.test(n));
          check('…and that good restore wrote exactly ONE new pre-restore copy', pre.length === preBefore + 1, JSON.stringify({ preBefore, after: pre.length }));
          check('a good restore prints the current and the new config, saves the old one first (pre-restore-<time>.json), pushes, and confirms',
            r.code === 0 && /current/i.test(r.out) && /liveroom/.test(r.out) && /file:/i.test(r.out) && pre.length >= 1 && /restored/.test(r.out) && (await stateRoom(m)) === 'testroom', JSON.stringify({ code: r.code, out: r.out.trim().slice(0, 400), pre }));
        } finally { m.child.kill(); }
      }
      {
        // The current config is unreadable (VDO Sync answers vdo:error): nothing can be saved first, so --force is required, and the
        // dry run says so. Replacing it is then allowed with --force, without a pre-restore copy.
        const m = await fresh();
        try {
          await fetch(m.base + '/mock/setcache', { method: 'POST', body: JSON.stringify({ vdo: '{"a":1,"a":2}' }) }).then((r) => r.arrayBuffer());
          const p = await put('snap3.json', JSON.stringify(snapshot()));
          const preBefore = (await readdir(bdir)).filter((n) => /^pre-restore-/.test(n)).length;
          const dry = await bk(m, ['restore', p]);
          const noForce = await bk(m, ['restore', p, '--yes']);
          const pushesBefore = (await actionsOf(m)).filter((a) => a.name === 'VDO Push').length;
          check('restore over an UNREADABLE current config (VDO Sync answers vdo:error): the dry run says no copy can be saved, and --yes without --force is refused with nothing pushed',
            /no copy|cannot be saved|--force/i.test(dry.out) && noForce.code !== 0 && /--force/.test(noForce.out) && pushesBefore === 0, JSON.stringify({ dry: dry.out.slice(0, 300), code: noForce.code, out: noForce.out.slice(0, 200), pushesBefore }));
          const forced = await bk(m, ['restore', p, '--yes', '--force']);
          const preAfter = (await readdir(bdir)).filter((n) => /^pre-restore-/.test(n)).length;
          check('…with --force it proceeds (and says plainly that no copy of the current config was kept)', forced.code === 0 && (await stateRoom(m)) === 'testroom' && preAfter === preBefore && /no (current )?config could be saved|not saved|no copy/i.test(forced.out), JSON.stringify({ code: forced.code, out: forced.out.slice(0, 300) }));
        } finally { m.child.kill(); }
      }
      {
        const m = await fresh();
        try {
          const bad = await fetch(m.base + '/mock/mode?push=errror').then((r) => r.status);
          const ok1 = await fetch(m.base + '/mock/mode?missing=VDO%20Sync').then((r) => r.status);
          const m1 = await (await fetch(m.base + '/mock/mode')).json();
          const ok2 = await fetch(m.base + '/mock/mode?missing=').then((r) => r.status);
          const m2 = await (await fetch(m.base + '/mock/mode')).json();
          check('/mock/mode refuses a value it does not know (400, nothing changed), and \'missing=\' with nothing after it clears the list',
            bad === 400 && ok1 === 200 && m1.modes.missing === 'VDO Sync' && ok2 === 200 && m2.modes.missing === '' && m2.modes.push === 'ok', JSON.stringify({ bad, m1: m1.modes && m1.modes.missing, m2: m2.modes }));
        } finally { m.child.kill(); }
      }
      // (c) a missing VDO Sync and a refused Subscribe name their cause
      for (const [what, env, args, want] of [['a missing VDO Sync action', { SB_MISSING: 'VDO Sync' }, ['save', resolve(bdir, 'x1.json')], /not found|VDO Sync/i], ['a refused Subscribe', { SB_SUBSCRIBE: 'error' }, ['save', resolve(bdir, 'x2.json')], /subscribe|refused/i]]) {
        const m = await fresh(env);
        try {
          const r = await bk(m, args);
          check('save against ' + what + ' exits non-zero with the reason (not "nothing saved yet")', r.code !== 0 && want.test(r.out) && !/Open the control page and set a room/.test(r.out), JSON.stringify({ code: r.code, out: r.out.trim().slice(0, 300) }));
        } finally { m.child.kill(); }
      }
      // (d) arguments
      {
        const m = await fresh();
        try {
          const before = await connsOf(m);
          const bad = [];
          const cases = [
            ['an unknown flag', ['save', '--bogus'], 2], ['--url with no value', ['save', '--url'], 2], ['restore with no file', ['restore'], 2], ['list with an argument', ['list', 'x'], 2],
            ['save with two files', ['save', 'a.json', 'b.json'], 2], ['a file with no verb', ['some-file.json'], 2], ['a save path that is really a swallowed URL', ['save', 'ws://127.0.0.1:1/'], 2],
          ];
          for (const [what, args, code] of cases) { const r = await bk(m, args); if (r.code !== code) bad.push(what + ' -> ' + r.code); }
          const h = await bk(m, ['--help']); const h2 = await bk(m, ['help']);
          check('backup.mjs argument parsing is strict: each of ' + cases.length + ' malformed command lines exits 2, --help and help print usage and exit 0, and none of them connects',
            bad.length === 0 && h.code === 0 && /Usage|usage/.test(h.out) && h2.code === 0 && (await connsOf(m)) === before, JSON.stringify({ bad, h: h.code, h2: h2.code }));
          const swallowed = await bk(m, ['restore', 'x.json'], { npm_config_url: 'ws://127.0.0.1:1/' });
          check('npm swallowing --url (npm_config_url is set) is refused before connecting, naming the working forms', swallowed.code !== 0 && /-- --url/.test(swallowed.out) && (await connsOf(m)) === before, JSON.stringify({ code: swallowed.code, out: swallowed.out.slice(0, 240) }));
          const dry2 = await bk(m, ['restore', resolve(bdir, 'snap2.json')]);
          const dry3 = await bk(m, ['restore', resolve(bdir, 'snap2.json')], { npm_config_yes: 'true', npm_lifecycle_event: 'backup:restore' });
          check('a restore dry run shows the exact npm form of the --yes it asks for (flags go after "--"), and says so when npm has eaten a --yes',
            /npm run backup:restore -- .*--yes/.test(dry2.out) && /npm .*(ate|took|swallow)/i.test(dry3.out) && dry2.code === 2, JSON.stringify({ dry2: dry2.out.slice(-260), dry3: dry3.out.slice(-260) }));
          const urlWord = await bk(m, ['restore', resolve(bdir, 'snap2.json'), 'ws://127.0.0.1:1/'], { npm_config_url: 'true' });
          check('npm\'s usual swallowed-URL case (--url ws://… leaves the URL as a stray word) is named as that, not as a word-count error', urlWord.code !== 0 && /-- --url/.test(urlWord.out) && !/exactly one file/.test(urlWord.out), urlWord.out.slice(0, 260));
          const secret = await put('secret.json', '{"kind":"greenroom-vdo-backup","vdoninja":{"password":hunter2-secret}}');
          const sec = await bk(m, ['restore', secret, '--yes']);
          check('a snapshot with a JSON syntax error never echoes a piece of the file (it may hold the room password) in the error', sec.code !== 0 && !/hunter2/.test(sec.out), sec.out.slice(0, 260));
          const t = await bk(m, ['save', resolve(bdir, 'target.json')]);
          check('save prints the target URL before it connects', new RegExp('target: ' + m.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(t.out), t.out.slice(0, 200));
        } finally { m.child.kill(); }
      }
      // (e) files: UTF-16, atomic and non-clobbering saves, relative paths, list
      {
        const m = await fresh();
        try {
          const text = JSON.stringify(snapshot());
          const u16 = resolve(bdir, 'utf16.json');
          await writeFile(u16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
          const r = await bk(m, ['restore', u16, '--yes']);
          check('restore reads a UTF-16 (BOM) snapshot, as Notepad and PowerShell write them', r.code === 0 && (await stateRoom(m)) === 'testroom', r.out.trim().slice(0, 240));
          const out1 = resolve(bdir, 'keep.json');
          await writeFile(out1, 'precious');
          const s1 = await bk(m, ['save', out1]);
          check('save refuses to overwrite an existing file without --force, and leaves it alone', s1.code !== 0 && (await readFile(out1, 'utf8')) === 'precious', s1.out.trim().slice(0, 200));
          const s2 = await bk(m, ['save', out1, '--force']);
          const left = (await readdir(bdir)).filter((n) => /\.tmp-/.test(n));
          check('--force overwrites; no .tmp- file is left behind, backup.mjs writes through a temp file and a rename, and the output warns that it holds the room password',
            s2.code === 0 && /rename\(tmp, out\)/.test(await readFile(resolve(__dirname, 'backup.mjs'), 'utf8')) && /"kind": "greenroom-vdo-backup"/.test(await readFile(out1, 'utf8')) && left.length === 0 && /password/i.test(s2.out), JSON.stringify({ code: s2.code, left, out: s2.out.slice(0, 300) }));
          const cwdDir = await mkdtemp(resolve(tmpdir(), 'greenroom-bk12cwd-'));
          await writeFile(resolve(cwdDir, 'rel.json'), JSON.stringify(snapshot()));
          const rel = await bk(m, ['restore', './rel.json', '--yes'], { INIT_CWD: cwdDir });
          await rm(cwdDir, { recursive: true, force: true });
          check('a relative file with a directory part is resolved from where npm was run (INIT_CWD), in a folder that is NOT the snapshot folder', rel.code === 0, rel.out.trim().slice(0, 240));
          const viaBackups = await bk(m, ['restore', 'backups/keep.json', '--yes'], { INIT_CWD: tmpdir() });
          check('…and the README\'s backups/<file> form works from any folder npm was started in', viaBackups.code === 0, viaBackups.out.trim().slice(0, 240));
          const bare = await bk(m, ['restore', 'keep.json', '--yes'], { INIT_CWD: tmpdir() });
          const lst = await bk(m, ['list']);
          check('…the snapshot-folder lookup works from anywhere, and list prints <folder>/<name> (backups/<name> by default)', bare.code === 0 && lst.out.includes(basename(bdir) + '/keep.json'), JSON.stringify({ bare: bare.code, list: lst.out.slice(0, 200) }));
        } finally { m.child.kill(); }
      }
      const rootAfter = (await readdir(__dirname)).sort().join('|');
      check('none of these runs wrote a file into the repository root (a relative name goes to the scratch folder)', rootAfter === rootBefore, rootBefore === rootAfter ? '' : 'root changed: ' + rootAfter);
      await rm(bdir, { recursive: true, force: true });
    }

    probe.close();
    producer.close();
  } catch (err) {
    failed++;
    console.log('\n  ERROR ' + ((err && err.stack) || err));
  } finally {
    if (sidecar) sidecar.kill();
    if (bridge) { try { bridge.kill(); } catch {} }
    if (mock) mock.kill();
    await rm(resolve(__dirname, '.verify-bridge-config.json'), { force: true });
    await rm(resolve(__dirname, '.verify-bridge-tokens.json'), { force: true });
    await rm(resolve(__dirname, '.verify-backup.json'), { force: true });
    await rm(resolve(__dirname, '.verify-backup-object.json'), { force: true });
    await rm(resolve(__dirname, '.verify-backup-oor.json'), { force: true });
    for (const d of scratchDirs) await rm(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); // (a hidden child may still hold a folder for a moment)
  }

  console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
