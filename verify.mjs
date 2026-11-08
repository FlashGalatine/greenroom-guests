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
//
// It does NOT render pixels; verify-render.mjs does that in a real browser.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { readFile, rm, mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number(process.env.SB_HTTP_PORT) || 7475; // off the SB defaults so it coexists with a running SB
const WS_PORT = Number(process.env.SB_WS_PORT) || 8081;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const GUARD_BASE = Number(process.env.VERIFY_GUARD_BASE) || 7591; // the sidecars' single-instance guard ports: base, +1, +2 (outside the 749x block the components claim)
const WS_URL = `ws://127.0.0.1:${WS_PORT}/`;

let passed = 0, failed = 0;
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
function cleanEnv(extra = {}) {
  const env = {};
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
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
    { slot: 3, label: '', streamID: '', mirror: false, mode: 'discord', discordUserId: '110457699291906048' },
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
    { vdoLabel: '', discordUserId: '110457699291906048', displayName: 'Ashe of Outland', socials: [], auto: true },
  ],
  directoryAutoAdd: true,
  directoryIgnored: ['discord:200000000000000009', 'vdo:leavemealone'],
};

const DISCORD_PAYLOAD = {
  channelId: '1197596470245871696',
  connected: true,
  hostInChannel: true,
  users: {
    '110457699291906048': { speaking: false, username: 'Ashe', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png', mute: false, deaf: false },
    '200000000000000001': { speaking: true, username: 'Guest One', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/2.png', mute: true, deaf: false },
  },
  settings: { streamerUserId: '110457699291906048', avatarPx: 56, streamerPx: 72, height: 180, accent: 'cyan', scanlines: true, neonBlink: true, hideWhenAbsent: true },
  rpc: { enabled: true, hasToken: true, error: null },
  favorites: [{ id: 'fav1', name: 'NFC Commentary', serverId: '259501535484968970', channelId: '1197596470245871696' }],
  current: { serverId: '259501535484968970', channelId: '1197596470245871696' },
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
    check('slot 3 discord mode + discordUserId intact', v1.vdoninja.slots[2].mode === 'discord' && v1.vdoninja.slots[2].discordUserId === '110457699291906048');
    check('invite block carried (control-page rehydration source)', v1.vdoninja.invite && v1.vdoninja.invite.passwordMode === 'hash' && v1.vdoninja.enabled === true);
    check('directory carried (guest-directory/nameplate source)',
      Array.isArray(v1.vdoninja.directory) && v1.vdoninja.directory.length === 2
      && v1.vdoninja.directory[0].displayName === 'Alpha Prime'
      && v1.vdoninja.directory[0].socials[0].platform === 'twitch'
      && v1.vdoninja.directory[1].discordUserId === '110457699291906048');
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
    check('favorites + current carried', d1.discordVoice.favorites[0].name === 'NFC Commentary' && d1.discordVoice.current.channelId === '1197596470245871696');

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
        const bkRestore = await runNode(['backup.mjs', 'restore', bkFile, '--yes'], { SB_WS_PORT: String(objMock.wsPort), SB_WS_URL: objMock.url, GREENROOM_BACKUP_DIR: bkScratch });
        await rm(bkScratch, { recursive: true, force: true });
        check('backup restore works against the old object format (the snapshot is back in the cache)',
          bkRestore.code === 0 && /restored/.test(bkRestore.out) && (await stateOf(objMock)).vdo.room === 'testroom', bkRestore.out.trim().slice(0, 200));
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

    producer.doAction('Discord Voice Command', { command: 'set-settings', value: JSON.stringify({ accent: 'magenta' }) });
    check('set-settings round-trips (accent → magenta)', !!(await shimE.inbox.next(4000,
      (d) => byType('discord:voice:update')(d) && d.discordVoice.settings.accent === 'magenta',
      'set-settings state')));

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

    // ── 5b. Guest-directory core: sanitizers + the auto-populate rule ───────────
    // control/directory-core.js is the shared brain both control pages load, so it
    // gets unit-tested directly here (same trick as vdo-parse.js above).
    console.log('\n[5b] guest directory core: control/directory-core.js sanitizers + auto-populate');
    const dirCoreSrc = await readFile(resolve(__dirname, 'control', 'directory-core.js'), 'utf8');
    new Function(dirCoreSrc)();
    const D = globalThis.GRDir;

    const sanitized = D.sanitizeDirectory([
      { vdoLabel: '  ALPHA  ', discordUserId: '<@110457699291906048>', displayName: ' Alpha Prime ',
        socials: [{ platform: ' Twitch ', handle: ' AlphaPrimeTV ' }, { platform: '', handle: 'dropme' }], auto: 1 },
      { vdoLabel: 'NONAME', discordUserId: '', displayName: '   ' },     // no displayName → dropped
      { vdoLabel: '', discordUserId: '', displayName: 'No Keys' },       // no match key → dropped
      null,
    ]);
    check('sanitizeDirectory: trims, digit-strips ids, lowercases platforms, drops keyless/nameless',
      sanitized.length === 1 && sanitized[0].vdoLabel === 'ALPHA' && sanitized[0].discordUserId === '110457699291906048'
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

    const ign = D.sanitizeIgnored(['vdo:ALPHA', 'vdo:alpha', 'discord:110457699291906048', 'discord:nope', 'junk', '', null]);
    check('sanitizeIgnored: lowercases labels, dedupes, sorts, drops junk keys',
      JSON.stringify(ign) === JSON.stringify(['discord:110457699291906048', 'vdo:alpha']), JSON.stringify(ign));
    check('ignore keys are built the same way the pages match them',
      D.labelKey(' Alpha ') === 'vdo:alpha' && D.userKey('<@1104>') === 'discord:1104');

    const socialsRt = D.parseSocialsText('twitch AlphaPrimeTV\n  bluesky @alpha.bsky  \nnohandle\nwebsite my site.example');
    check('socials textarea grammar: first-space split, blank/handle-less lines dropped, spaces kept',
      socialsRt.length === 3 && socialsRt[1].handle === '@alpha.bsky' && socialsRt[2].handle === 'my site.example',
      JSON.stringify(socialsRt));
    check('socials round-trip text → objects → text',
      D.parseSocialsText(D.socialsToText(socialsRt)).length === 3);

    const AUTO_USERS = {
      '110457699291906048': { username: 'Ashe' },
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
    check('autoPopulate: a Discord name matching an existing entry fills that entry\'s id (no twin)',
      auto1.directory.filter((e) => e.displayName === 'Ashe of Outland').length === 1
      && auto1.directory.find((e) => e.displayName === 'Ashe of Outland').discordUserId === '110457699291906048');
    check('autoPopulate: reported changed=true and left the operator\'s names alone',
      auto1.changed === true && auto1.directory[0].displayName === 'Alpha Prime' && auto1.directory[0].auto === false);
    const auto2 = D.autoPopulate({ directory: auto1.directory, ignored: ['discord:200000000000000009', 'vdo:lurker'],
      labels: ['ALPHA', 'BRAVO'], users: AUTO_USERS });
    check('autoPopulate is a fixpoint: a second pass over the same room changes nothing',
      auto2.changed === false && JSON.stringify(auto2.directory) === JSON.stringify(auto1.directory));
    const auto3 = D.autoPopulate({ directory: autoBase, ignored: ['discord:200000000000000009', 'vdo:lurker'],
      labels: [' BRAVO ', 'LURKER', 'ALPHA'], users: AUTO_USERS });
    check('autoPopulate is order-independent (two director pages converge, no push ping-pong)',
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
    check('TRIPWIRE: control.html contains no botToken string (token never leaves the sidecar)', !/botToken/.test(ctrlBody));
    check('control.html: directory UI wired (directory-core.js, search, live-only, auto-add)',
      ctrlBody.includes('directory-core.js') && ctrlBody.includes('dirSearch')
      && ctrlBody.includes('dirLiveOnly') && ctrlBody.includes('dirAutoAdd') && ctrlBody.includes('GRDir.autoPopulate'));
    const minRes = await fetch(`${BASE}/control/director-min.html`);
    const minBody = await minRes.text();
    check('/control/director-min.html 200 + wired (VDO Push, vdo-parse.js)', minRes.status === 200 && minBody.includes("'VDO Push'") && minBody.includes('vdo-parse.js'));
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
    const bridgeSrc = await readFile(resolve(__dirname, 'sidecar', 'discord-bridge.mjs'), 'utf8');
    check('sidecar: subscribes with LOWERCASE general', bridgeSrc.includes("events: { general: ['Custom'] }"));
    check("sidecar: pushes via DoAction 'Discord Voice Push'", bridgeSrc.includes("name: 'Discord Voice Push'"));
    check('sidecar: consumes ONLY discord:voice:command (echo-loop guard)', bridgeSrc.includes("d.type !== 'discord:voice:command'"));
    check('sidecar: exit-on-SB-close wired (shouldExitOnSbClose + grace timer)',
      bridgeSrc.includes('shouldExitOnSbClose') && bridgeSrc.includes('SB_EXIT_GRACE_MS') && bridgeSrc.includes('armSbGoneTimer'));
    check('control.html: exit-on-SB-close toggle wired (exitOnSbClose set-setting)', ctrlBody.includes('exitOnSbClose'));
    check('control.html: config Export/Import wired (backup buttons + file input + envelope)',
      ctrlBody.includes('btnCfgExport') && ctrlBody.includes('cfgImportFile') && ctrlBody.includes('greenroom-vdo-backup'));

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

    producer.doAction('Discord Voice Command', { command: 'favorite-add', value: JSON.stringify({ name: 'Verify Fav', serverId: '123', channelId: '456' }) });
    const sFav = await shimF.inbox.next(4000,
      (d) => byType('discord:voice:update')(d) && (d.discordVoice.favorites || []).some((f) => f.name === 'Verify Fav'),
      'sidecar favorite-add echo');
    check('sidecar favorite-add round-trips + sanitizes', sFav.discordVoice.favorites.some((f) => f.name === 'Verify Fav' && f.channelId === '456'));

    producer.doAction('Discord Voice Command', { command: 'connect', value: '' });
    const sErr = await shimF.inbox.next(4000,
      (d) => byType('discord:voice:update')(d) && d.discordVoice.rpc && /no bot token/i.test(d.discordVoice.rpc.error || ''),
      'sidecar no-token error');
    check('connect without a token → visible file-onboarding error (token never on the bus)', !!sErr);

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
      const common = { SB_WS_URL: `ws://127.0.0.1:${EXIT_WS}/`, GREENROOM_SB_EXIT_GRACE_MS: '500' };
      onSc = await startChild('sidecar/discord-bridge.mjs', 'Connected to Streamer.bot', {
        ...common, GREENROOM_EXIT_ON_SB_CLOSE: '1', GREENROOM_GUARD_PORT: String(GUARD_BASE + 1),
        DISCORD_BRIDGE_CONFIG: onCfg, DISCORD_BRIDGE_TOKENS: onTok,
      });
      offSc = await startChild('sidecar/discord-bridge.mjs', 'Connected to Streamer.bot', {
        ...common, GREENROOM_GUARD_PORT: String(GUARD_BASE + 2), GREENROOM_EXIT_ON_SB_CLOSE: '0', // the feature is off, said explicitly
        DISCORD_BRIDGE_CONFIG: offCfg, DISCORD_BRIDGE_TOKENS: offTok,
      });
      exitMock.kill(); exitMock = null; // "close Streamer.bot"
      const onExited = await waitExit(onSc, 5000);
      check('exitOnSbClose ON: SB closes → sidecar disconnects from voice and exits within grace', onExited);
      await new Promise((r) => setTimeout(r, 500 + 300 + 700)); // the grace time, plus margin: the OFF sidecar must have had its full chance to leave
      check('exitOnSbClose OFF: SB closes → sidecar stays up (reconnect-forever)', offSc.exitCode === null);
    } finally {
      if (onSc) try { onSc.kill(); } catch {}
      if (offSc) try { offSc.kill(); } catch {}
      if (exitMock) try { exitMock.kill(); } catch {}
      await Promise.all([onCfg, onTok, offCfg, offTok].map((p) => rm(p, { force: true })));
    }

    } // end of the sidecar sections ([7], [8])

    // ── 9. config backup CLI: save + restore round-trip (backup.mjs vs the mock) ──
    // The shared mock still holds VDO_PAYLOAD from [2] (room 'testroom', 2 directory
    // entries). Snapshot it, mutate SB's vdo.state, restore the file, confirm revert.
    console.log('\n[9] config backup CLI: backup.mjs save + restore round-trip');
    const backupFile = resolve(__dirname, '.verify-backup.json');
    await rm(backupFile, { force: true });
    const bkDir = await mkdtemp(resolve(tmpdir(), 'greenroom-bk9-')); // restore's pre-restore snapshots go here, never into backups/
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
    check('the restored vdo.state deep-equals the fixture (room, the password "pw1", slots with their stream IDs, invite, directory as the page would sanitise it)',
      sameJson(afterState.vdo, { ...VDO_PAYLOAD, directory: D.sanitizeDirectory(VDO_PAYLOAD.directory) }), JSON.stringify(afterState.vdo).slice(0, 300));
    const preRestore = (await readdir(bkDir)).filter((n) => /^pre-restore-.*\.json$/.test(n));
    let preState = null; try { preState = JSON.parse(await readFile(resolve(bkDir, preRestore[0]), 'utf8')); } catch { /* left null */ }
    check('restore first wrote pre-restore-<time>.json (the state it was about to replace, room "CHANGED") into the snapshot folder, and nothing into backups/',
      preRestore.length === 1 && !!preState && preState.vdoninja && preState.vdoninja.room === 'CHANGED', JSON.stringify({ preRestore }));
    check('backup round-trip keeps the auto-add companions (autoAdd flag + ignore list)',
      afterState.vdo && afterState.vdo.directoryAutoAdd === true
      && Array.isArray(afterState.vdo.directoryIgnored) && afterState.vdo.directoryIgnored.includes('vdo:leavemealone'),
      JSON.stringify(afterState.vdo && afterState.vdo.directoryIgnored));

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
      const goodEnv = (m, extra = {}) => ({ SB_WS_URL: m.url, GREENROOM_BACKUP_DIR: bdir, ...extra });
      const bk = (m, args, extra = {}) => runNode(['backup.mjs', ...args], goodEnv(m, extra));
      const seedState = { ...VDO_PAYLOAD, room: 'liveroom' };
      const snapshot = (over = {}) => ({ kind: 'greenroom-vdo-backup', savedAt: '2026-01-01T00:00:00.000Z', vdoninja: { ...VDO_PAYLOAD, ...over } });
      const put = async (name, content) => { const p = resolve(bdir, name); await writeFile(p, content); return p; };
      // env: options for the mock at start; mode: a /mock/mode query applied AFTER the seeding push (so a push-refusing mock still holds a state)
      const fresh = async (env = {}, mode = '') => {
        const m = await startMockWith(env);
        const c = await rawClient(m.url);
        c.doAction('VDO Push', { payload: JSON.stringify(seedState) });
        await new Promise((r) => setTimeout(r, 300));
        if (mode) await fetch(m.base + '/mock/mode?' + mode).then((r) => r.arrayBuffer());
        await fetch(m.base + '/mock/actions?clear=1').then((r) => r.arrayBuffer());
        c.close();
        return m;
      };
      const actionsOf = async (m) => (await (await fetch(m.base + '/mock/actions')).json()).actions;
      const stateRoom = async (m) => ((await (await fetch(m.base + '/mock/state')).json()).vdo || {}).room;
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
          ['slots that are not a list', JSON.stringify(snapshot({ slots: 'x' })), ['--yes']],
          ['a Discord ID written as a number (its digits are already rounded)', '{"kind":"greenroom-vdo-backup","vdoninja":' + JSON.stringify({ ...VDO_PAYLOAD, directory: [] }).replace('"discordUserId":""', '"discordUserId":123456789012345678') + '}', ['--yes']],
          ['a slot entry that is not an object', JSON.stringify(snapshot({ slots: [null, ...VDO_PAYLOAD.slots.slice(1)] })), ['--yes']],
          ['a snapshot from a newer Greenroom', JSON.stringify(snapshot({ schemaVersion: 99 })), ['--yes']],
          ['a good snapshot, but no --yes', JSON.stringify(snapshot()), []],
        ];
        const failed = [];
        for (const [what, text, flags] of refusals) {
          const p = await put('refuse.json', text);
          const r = await bk(mA, ['restore', p, ...flags]);
          const pushes = (await actionsOf(mA)).filter((a) => a.name === 'VDO Push').length;
          if (!(r.code !== 0 && pushes === 0 && (await stateRoom(mA)) === 'liveroom')) failed.push(what + ' -> code ' + r.code + ', pushes ' + pushes);
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
          const r = await bk(m, ['restore', p, '--yes']);
          const pre = (await readdir(bdir)).filter((n) => /^pre-restore-.*\.json$/.test(n));
          check('a good restore prints the current and the new config, saves the old one first (pre-restore-<time>.json), pushes, and confirms',
            r.code === 0 && /current/i.test(r.out) && /liveroom/.test(r.out) && /file:/i.test(r.out) && pre.length >= 1 && /restored/.test(r.out) && (await stateRoom(m)) === 'testroom', JSON.stringify({ code: r.code, out: r.out.trim().slice(0, 400), pre }));
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
          check('--force overwrites; the file is written atomically (no .tmp- file is left), and the output warns that it holds the room password',
            s2.code === 0 && /"kind": "greenroom-vdo-backup"/.test(await readFile(out1, 'utf8')) && left.length === 0 && /password/i.test(s2.out), JSON.stringify({ code: s2.code, left, out: s2.out.slice(0, 300) }));
          const rel = await bk(m, ['restore', 'keep.json', '--yes'], { INIT_CWD: bdir });
          check('a relative file is resolved from where npm was run (INIT_CWD), and a bare name is also looked up in the snapshot folder', rel.code === 0, rel.out.trim().slice(0, 240));
          const bare = await bk(m, ['restore', 'keep.json', '--yes'], { INIT_CWD: tmpdir() });
          const lst = await bk(m, ['list']);
          check('…the snapshot-folder lookup works from anywhere, and list prints <folder>/<name> (backups/<name> by default)', bare.code === 0 && lst.out.includes(basename(bdir) + '/keep.json'), JSON.stringify({ bare: bare.code, list: lst.out.slice(0, 200) }));
        } finally { m.child.kill(); }
      }
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
  }

  console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
