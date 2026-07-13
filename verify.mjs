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
//       BOTH caches vdo-first; after /mock/restart (SB restart analog) VDO Sync
//       replays ONLY the persisted vdoninja blob.
//   [4] command bus — mock-discord-bridge.mjs consumes discord:voice:command
//       broadcasts and echoes state changes back through the REAL bus path.
//   [5] defensive parser — control/vdo-parse.js never throws on malformed guestLists.
//   [6] HTTP + tripwires — SB-style Path->Folder serving, load-bearing strings in
//       every wired file (incl. the nameplate surfaces + the director-min
//       directory strip-guard), and control.html must NOT contain "botToken".
//
// It does NOT render pixels; verify-render.mjs does that in a real browser.

import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number(process.env.SB_HTTP_PORT) || 7475; // off the SB defaults so it coexists with a running SB
const WS_PORT = Number(process.env.SB_WS_PORT) || 8081;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
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

function startChild(script, readyText, extraEnv = {}) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [script], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SB_HTTP_PORT: String(HTTP_PORT), SB_WS_PORT: String(WS_PORT), ...extraEnv },
    });
    let out = '';
    const timer = setTimeout(() => rej(new Error(`${script} did not start in 8s\n` + out)), 8000);
    const onData = (d) => { out += d; if (out.includes(readyText)) { clearTimeout(timer); res(child); } };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (code) rej(new Error(`${script} exited ${code}\n` + out)); });
  });
}

const startMock = () => startChild('mock-sb-server.mjs', '[mock] WS');

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
function rawClient() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS_URL);
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
    { vdoLabel: '', discordUserId: '110457699291906048', displayName: 'Ashe of Outland', socials: [] },
  ],
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

async function main() {
  console.log('Greenroom — Streamer.bot seam verification\n');
  let mock;
  let bridge;
  let sidecar;
  try {
    mock = await startMock();
    console.log(`mock SB up (:${HTTP_PORT} HTTP, :${WS_PORT} WS)\n`);

    // ── 1. Transport: ack shapes, sync-on-connect, silence on empty caches ──────
    console.log('[1] transport: overlay/panel-client-sb.js against the mock WS');
    const probe = await rawClient();
    const subAck = await probe.acks.next(3000, (m) => String(m.id).startsWith('sub'), 'Subscribe ack');
    check('Subscribe ack {id, status:ok, result}', subAck.status === 'ok' && !!subAck.result, JSON.stringify(subAck));
    probe.doAction('VDO Sync', { reason: 'probe' });
    const daAck = await probe.acks.next(3000, (m) => String(m.id).startsWith('req'), 'DoAction ack');
    check('DoAction ack {id, status:ok}', daAck.status === 'ok');
    check('empty caches → sync replays nothing', await rejects(probe.events.next(700, () => true, 'unexpected event')));

    const shimA = await runShim();
    check('shim: silence on empty caches (no svc:message)', await rejects(shimA.inbox.next(900, () => true, 'unexpected svc:message')));
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
    check('room/password/viewFlags carried', v1.vdoninja.room === 'testroom' && v1.vdoninja.password === 'pw1' && v1.vdoninja.viewFlags.includes('&solo'));
    check('slot 1 label+streamID intact (superset field `label`)', v1.vdoninja.slots[0].label === 'ALPHA' && v1.vdoninja.slots[0].streamID === 'aaa111');
    check('slot 3 discord mode + discordUserId intact', v1.vdoninja.slots[2].mode === 'discord' && v1.vdoninja.slots[2].discordUserId === '110457699291906048');
    check('invite block carried (control-page rehydration source)', v1.vdoninja.invite && v1.vdoninja.invite.passwordMode === 'hash' && v1.vdoninja.enabled === true);
    check('directory carried (guest-directory/nameplate source)',
      Array.isArray(v1.vdoninja.directory) && v1.vdoninja.directory.length === 2
      && v1.vdoninja.directory[0].displayName === 'Alpha Prime'
      && v1.vdoninja.directory[0].socials[0].platform === 'twitch'
      && v1.vdoninja.directory[1].discordUserId === '110457699291906048');

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
    check('users map intact (2 users, mute flag)', Object.keys(d1.discordVoice.users).length === 2 && d1.discordVoice.users['200000000000000001'].mute === true);
    check('settings block carried (roster overlay input)', d1.discordVoice.settings && d1.discordVoice.settings.accent === 'cyan' && d1.discordVoice.settings.hideWhenAbsent === true);
    check('rpc block carried (control-page status source)', d1.discordVoice.rpc && d1.discordVoice.rpc.hasToken === true);
    check('favorites + current carried', d1.discordVoice.favorites[0].name === 'NFC Commentary' && d1.discordVoice.current.channelId === '1197596470245871696');

    const shimC = await runShim();
    await shimC.inbox.next(4000, byType('vdoninja:update'), 'replay vdoninja:update');
    await shimC.inbox.next(4000, byType('discord:voice:update'), 'replay discord:voice:update');
    check('late joiner: VDO Sync replays BOTH caches, vdo first',
      shimC.types[0] === 'vdoninja:update' && shimC.types[1] === 'discord:voice:update', shimC.types.join(', '));

    await fetch(`${BASE}/mock/restart`);
    const shimD = await runShim();
    const v3 = await shimD.inbox.next(4000, byType('vdoninja:update'), 'post-restart vdoninja:update');
    check('after SB restart analog: persisted vdo.state still replays', v3.vdoninja.room === 'testroom');
    check('after SB restart analog: non-persisted discord.state does NOT replay',
      await rejects(shimD.inbox.next(700, byType('discord:voice:update'), 'stale discord replay')));

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
    const minRes = await fetch(`${BASE}/control/director-min.html`);
    const minBody = await minRes.text();
    check('/control/director-min.html 200 + wired (VDO Push, vdo-parse.js)', minRes.status === 200 && minBody.includes("'VDO Push'") && minBody.includes('vdo-parse.js'));
    check('TRIPWIRE: director-min carries the directory through its pushes (strip guard)', minBody.includes('directory:'));
    const mockDirRes = await fetch(`${BASE}/mock/vdo-director.html`);
    check('/mock/vdo-director.html 200 + speaks getGuestList', mockDirRes.status === 200 && (await mockDirRes.text()).includes('getGuestList'));
    const nsCtrl = await fetch(`${BASE}/greenroom-control/control.html`);
    await nsCtrl.arrayBuffer();
    const nsOv = await fetch(`${BASE}/greenroom-overlay/vdoninja-guest.html`);
    await nsOv.arrayBuffer();
    check('namespaced aliases serve too (/greenroom-control/, /greenroom-overlay/ — the real-SB map names)',
      nsCtrl.status === 200 && nsOv.status === 200);

    // C# ↔ mock parity greps: the .cs files must carry the exact contract strings
    // the mock (and the producers) rely on. A drift here is a live-only bug.
    const cs = async (f) => readFile(resolve(__dirname, 'actions', f), 'utf8');
    const vdoPush = await cs('vdo-push.cs');
    check('vdo-push.cs: persisted SetGlobalVar("vdo.state", payload, true)', vdoPush.includes('SetGlobalVar("vdo.state", payload, true)'));
    check('vdo-push.cs: raw-concat wrapper {"type":"vdoninja:update","vdoninja":...}', vdoPush.includes('\\"vdoninja\\":" + payload'));
    const dPush = await cs('discord-voice-push.cs');
    check('discord-voice-push.cs: NON-persisted SetGlobalVar("discord.state", payload, false)', dPush.includes('SetGlobalVar("discord.state", payload, false)'));
    const sync = await cs('vdo-sync.cs');
    check('vdo-sync.cs: reads mirror the writers\' persistence flags',
      sync.includes('GetGlobalVar<string>("vdo.state", true)') && sync.includes('GetGlobalVar<string>("discord.state", false)'));
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

    // ── 7. The REAL sidecar, token-less, over the real bus ──────────────────────
    // Proves discord-bridge.mjs's whole bus layer (subscribe, initial push, command
    // dispatch, config persistence, the no-token error path) with no Discord token
    // and no network. The mock bridge is killed first so command consumers don't
    // compete. Scratch config/token paths keep sidecar/ untouched.
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
      GREENROOM_GUARD_PORT: '7497',
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
    const EXIT_WS = 8082, EXIT_HTTP = 7476;
    const onCfg = resolve(__dirname, '.verify-exit-on-config.json');
    const onTok = resolve(__dirname, '.verify-exit-on-tokens.json');
    const offCfg = resolve(__dirname, '.verify-exit-off-config.json');
    const offTok = resolve(__dirname, '.verify-exit-off-tokens.json');
    let exitMock, onSc, offSc;
    try {
      await Promise.all([onCfg, onTok, offCfg, offTok].map((p) => rm(p, { force: true })));
      exitMock = await startChild('mock-sb-server.mjs', '[mock] WS', { SB_HTTP_PORT: String(EXIT_HTTP), SB_WS_PORT: String(EXIT_WS) });
      const common = { SB_WS_URL: `ws://127.0.0.1:${EXIT_WS}/`, GREENROOM_SB_EXIT_GRACE_MS: '500' };
      onSc = await startChild('sidecar/discord-bridge.mjs', 'Connected to Streamer.bot', {
        ...common, GREENROOM_EXIT_ON_SB_CLOSE: '1', GREENROOM_GUARD_PORT: '7498',
        DISCORD_BRIDGE_CONFIG: onCfg, DISCORD_BRIDGE_TOKENS: onTok,
      });
      offSc = await startChild('sidecar/discord-bridge.mjs', 'Connected to Streamer.bot', {
        ...common, GREENROOM_GUARD_PORT: '7499', // GREENROOM_EXIT_ON_SB_CLOSE unset → feature off
        DISCORD_BRIDGE_CONFIG: offCfg, DISCORD_BRIDGE_TOKENS: offTok,
      });
      exitMock.kill(); exitMock = null; // "close Streamer.bot"
      const onExited = await waitExit(onSc, 5000);
      check('exitOnSbClose ON: SB closes → sidecar disconnects from voice and exits within grace', onExited);
      check('exitOnSbClose OFF (default): SB closes → sidecar stays up (reconnect-forever)', offSc.exitCode === null);
    } finally {
      if (onSc) try { onSc.kill(); } catch {}
      if (offSc) try { offSc.kill(); } catch {}
      if (exitMock) try { exitMock.kill(); } catch {}
      await Promise.all([onCfg, onTok, offCfg, offTok].map((p) => rm(p, { force: true })));
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
  }

  console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
