// Throwaway mock of Streamer.bot — lets all of Greenroom run with NO Streamer.bot
// install, for local development and the verify suites. It faithfully mimics the
// two SB surfaces Greenroom depends on:
//
//   • HTTP Server on :7478 (not SB's 7474) — SB Path->Folder file serving. Both the short and the
//     namespaced prefixes work (docs/STREAMERBOT-SETUP.md recommends the
//     `greenroom-*` ones for real SB, where sibling components may already claim
//     `overlay`/`shared`/`themes`):
//       /control/* or /greenroom-control/*  -> control/
//       /overlay/* or /greenroom-overlay/*  -> overlay/
//     Plus mock-only routes:
//       /mock/vdo-director.html -> the fake vdo.ninja director (offline auto-follow tests)
//       /mock/actions[?clear=1] -> ring buffer of every DoAction {t, name, args} received
//       /mock/state             -> the two caches, parsed
//       /mock/restart[?vdo=1]   -> clears the DISCORD cache only — simulates an SB
//                                  restart wiping the non-persisted `discord.state`
//                                  global while the persisted `vdo.state` survives;
//                                  ?vdo=1 clears vdo.state too (a wiped or fresh SB)
//       POST /mock/broadcast    -> broadcast the JSON body, as-is, as a General.Custom
//                                  `data` object (malformed-frame tests)
//       POST /mock/setcache     -> set the two caches to the raw strings in the JSON body
//                                  {vdo?, discord?} (null clears one): a corrupt saved state
//       /                       -> a landing page for quick manual testing
//
//     Test options (environment variables; everything is off by default except the Hello):
//       SYNC_DELAY_MS=<n>       VDO Sync broadcasts its replay n ms after the request
//                               (a slow first sync). The caches are read at request time.
//       SB_WIRE=object          the OLD action behaviour, kept so the pages' compatibility with an
//                               older actions paste stays under test. The state is broadcast as nested
//                               OBJECTS ({type:'vdoninja:update', vdoninja:{…}} and
//                               {type:'discord:voice:update', discordVoice:{…}}), cached BEFORE the
//                               broadcast, and run through an emulation of Streamer.bot's own JSON
//                               parse (Newtonsoft, default date handling): a date-shaped string is
//                               rewritten (ISO text normalised, an offset moved to the host's local
//                               time, /Date(ms)/ turned into ISO text) and one outside the DateTime
//                               range makes the broadcast throw, which the old actions answered with
//                               vdo:error / discord:voice:error. A Sync there has ONE try (vdo first).
//                               The default, and SB_WIRE=json, is the current behaviour below.
//       SB_EMPTY_MARKER=0|1     VDO Sync with an empty vdo.state broadcasts {type:'vdo:sync:empty'}.
//                               On by default; off in SB_WIRE=object mode, where the old action
//                               never sent it (set it explicitly to override either default).
//       SB_FILE_DELAY=<file>:<ms>[,<file>:<ms>]
//                               serve a file (by name, e.g. nameplate-shared.js) that many
//                               ms late, so a script lands after the page has connected
//       SB_PUSH_DELAY_MS=<n>    a VDO Push is acked at once but broadcast (and cached) n ms later, so a frame can arrive between a
//                               page's push and its echo
//       SB_SUBSCRIBE=none|error Subscribe is never answered, or answered {status:'error'}
//       SB_SUBSCRIBE_DELAY_MS=<n>  the Subscribe reply (ok or error) comes n ms late
//       SB_DOACTION=error       every DoAction is answered {status:'error'} and not run
//       SB_HELLO=none|plain|auth|real every connection gets a Hello (info.source 'mock') unless SB_HELLO=none; 'plain' is the
//                               same as the default, 'auth' adds an authentication block, 'real' sends the Hello of a real
//                               Streamer.bot (name 'Streamer.bot', info.source 'websocketServer') so the clients that refuse a mock can be tried
//       SB_PASSWORD=<text>      a test WebSocket password: every Hello carries a fresh salt and challenge, an Authenticate is checked
//                               (b64(sha256(b64(sha256(password + salt)) + challenge))), and, as with SB_HELLO=auth, a client that has not
//                               authenticated is refused (SB_AUTH=serve: served anyway, Enforce off)
//       SB_AUTHFAIL=close       after a REFUSED Authenticate, hang up on the client (default: keep the socket)
//       SB_AUTH_DROP=<n>        the next n Authenticate requests are met with a hang-up and no reply (/mock/mode?authdrop=<n> while running)
//       SB_AUTH_SILENT=1        Authenticate requests are never answered (/mock/mode?authsilent=1)
//       SB_AUTH=close|serve     with SB_HELLO=auth: close a client that sends any request, or serve
//                               requests anyway (Authentication on, Enforce off); default: refuse them
//       SB_SYNC_DROP=1          the first VDO Sync is acked but its replay is never broadcast
//       SB_PUSH=error|drop      VDO Push is acked status:'error' and not run, or acked ok but stores and broadcasts nothing
//       SB_MISSING=<a,b>        the named actions do not exist: acked status:'error' (so does any name outside the five)
//       The mode options above can also be changed while running (a value it does not know is a 400; missing= clears the list):
//       GET /mock/mode?subscribe=ok|none|error&doaction=ok|error&hello=none|plain|auth|real&auth=refuse|close|serve&password=<text>&push=ok|error|drop&missing=<names>   (hello=mock = the default)
//       GET /mock/dropall       close every WebSocket client (they reconnect)
//       GET /mock/drop?ms=<n>   close every WebSocket client AND refuse new connections (the upgrade is answered 503) for n ms, as a
//                               Streamer.bot that is down for a while is; pages see no 'open', then reconnect after their backoff
//       GET /mock/mode?rewrite=fffd   VDO Push text comes back (and is cached) with every lone surrogate replaced by U+FFFD, as
//                               Streamer.bot's own string handling does; rewrite= (empty) turns it off
//       SB_DATA=string          deliver General.Custom `data` as a JSON string, not an object
//       SB_DROP=1               accept each connection, greet it, answer no request, and close it ~100 ms later
//       GET /mock/conns[?clear=1] -> the WebSocket connect times, [{t}]
//
//   • WebSocket Server on :8084 (not SB's 8080) — speaks SB's envelope and implements the semantics of four of
//     the five Greenroom actions (mirroring the C# in actions/). Discord Bridge Start is NOT modelled: the mock
//     acks it like any known action and launches nothing, so the launch is only ever tested by verify [6b]:
//       VDO Push              broadcast {type:'vdoninja:update', vdoninjaJson:'<payload>'}, THEN
//                             cache args.payload as vdo.state (persisted analog)
//       Discord Voice Push    broadcast {type:'discord:voice:update', discordVoiceJson:'<payload>'},
//                             then cache as discord.state (non-persisted analog)
//       VDO Sync              replay both caches the same way (each replay is its own try, and the
//                             order is not promised); an empty vdo.state broadcasts
//                             {type:'vdo:sync:empty'}; an empty discord.state is skipped
//       Discord Voice Command broadcast {type:'discord:voice:command', command, value}
//                             (value stays a STRING, exactly like the C#)
//     A payload that is not ONE valid JSON object (no repeated key, nesting <= 32) is answered
//     with a vdo:error / discord:voice:error frame "payload rejected, NOT cached: …" and nothing
//     is cached, as in the C#; so is a missing payload. A cached state that is not valid JSON
//     (inject one with POST /mock/setcache) is reported by VDO Sync as "cached state is not valid
//     JSON - Import a backup or re-save" (for the Discord state: "the bridge replaces it with its
//     next push"), skipped, and KEPT; the other replay still runs.
//     On `Subscribe` it needs the general source and the Custom event (matched without regard to
//     case); anything else is acked but receives nothing.
//     Every connection is greeted with {request:'Hello', info:{name:'greenroom-mock', source:'mock'}}
//     (SB_HELLO=none removes it, =auth adds an authentication block), so a client can tell this is not Streamer.bot.
//     It refuses to start when either port is already taken, and prints one `[mock] READY http=<p> ws=<p>`
//     line once both listeners are up.
//     DoAction is ALWAYS acked {status:'ok'} — ok means the action STARTED, not that it
//     succeeded. An invalid argument or an exception inside a running action is reported by the
//     error frame above; an action that failed to COMPILE broadcasts nothing at all.
//
// This is a REFERENCE/TEST harness. The real thing is Streamer.bot itself (see
// docs/STREAMERBOT-SETUP.md) with the same wire shapes.

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { objectError, netTrim } from './tools/json-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTROL_DIR = resolve(__dirname, 'control');
const OVERLAY_DIR = resolve(__dirname, 'overlay');

// Deliberately NOT Streamer.bot's own 7474 / 8080, so `npm run mock` can never land on (or be mistaken for) a live install,
// and not the harnesses' ports either (verify 7475/8081, verify-render 7476/8082, shots 7477/8083).
const HTTP_PORT = Number(process.env.SB_HTTP_PORT) || 7478;
const WS_PORT = Number(process.env.SB_WS_PORT) || 8084;
const SYNC_DELAY_MS = Number(process.env.SYNC_DELAY_MS) || 0;
const WIRE_OBJECT = process.env.SB_WIRE === 'object'; // the old action behaviour (see the header)
const EMPTY_MARKER = process.env.SB_EMPTY_MARKER ? process.env.SB_EMPTY_MARKER === '1' : !WIRE_OBJECT;
// Mutable at run time (GET /mock/mode), so a test can flip a behaviour without respawning the mock.
const modes = {
  subscribe: process.env.SB_SUBSCRIBE || 'ok',
  doaction: process.env.SB_DOACTION === 'error' ? 'error' : 'ok',
  hello: process.env.SB_HELLO === 'auth' ? 'auth' : (process.env.SB_HELLO === 'plain' ? 'plain' : (process.env.SB_HELLO === 'none' ? 'none' : (process.env.SB_HELLO === 'real' ? 'real' : 'mock'))),
  auth: process.env.SB_AUTH === 'close' ? 'close' : (process.env.SB_AUTH === 'serve' ? 'serve' : 'refuse'),
  authdrop: process.env.SB_AUTH_DROP || '0', // the next n Authenticate requests are met with a hang-up and no reply (GET /mock/mode?authdrop=<n> sets it while running)
  authsilent: process.env.SB_AUTH_SILENT === '1' ? '1' : '0', // Authenticate requests are never answered
  authfail: process.env.SB_AUTHFAIL === 'close' ? 'close' : 'keep', // after a refused Authenticate: keep the socket, or hang up on the client
  password: process.env.SB_PASSWORD || '', // a WebSocket password (test password; GET /mock/mode?password= changes it): every Hello carries a fresh salt + challenge and Authenticate is checked
  push: process.env.SB_PUSH === 'error' || process.env.SB_PUSH === 'drop' ? process.env.SB_PUSH : 'ok', // VDO Push: ok | error (acked status:'error', not run) | drop (acked ok, stores and broadcasts nothing)
  missing: process.env.SB_MISSING || '', // comma-separated action names that do not exist: acked status:'error'
  rewrite: process.env.SB_REWRITE === 'fffd' ? 'fffd' : '', // VDO Push: '' (verbatim) | fffd (lone surrogates become U+FFFD, in the broadcast and in the cache)
};
let refuseUntil = 0; // /mock/drop: WebSocket connections are refused until this time
// The actions the real install has (an action that is not one of these, or is listed in `missing`, is answered 'not found').
const KNOWN_ACTIONS = new Set(['VDO Push', 'Discord Voice Push', 'VDO Sync', 'Discord Voice Command', 'Discord Bridge Start']);
const SUBSCRIBE_DELAY_MS = Number(process.env.SB_SUBSCRIBE_DELAY_MS) || 0;
const PUSH_DELAY_MS = Number(process.env.SB_PUSH_DELAY_MS) || 0;
let syncDropsLeft = process.env.SB_SYNC_DROP === '1' ? 1 : 0;
const DATA_STRING = process.env.SB_DATA === 'string';
const DROP = process.env.SB_DROP === '1';
const FILE_DELAY = Object.fromEntries((process.env.SB_FILE_DELAY || '').split(',').filter(Boolean)
  .map((p) => { const i = p.lastIndexOf(':'); return [p.slice(0, i), Number(p.slice(i + 1)) || 0]; }));
const connLog = []; // WebSocket connect times

// Refuse to start on a port something already holds, on loopback OR on all interfaces (a listener on 0.0.0.0 can sit under
// a loopback bind on Windows without raising an error, which would leave two servers answering one port).
// Loopback, every IPv4 interface, and the IPv6 wildcard and loopback (a dual-stack listener is how .NET and Node servers
// usually bind). A machine without IPv6 (EAFNOSUPPORT / EADDRNOTAVAIL) simply has nothing to collide with there.
async function portFree(port) {
  for (const host of ['127.0.0.1', '0.0.0.0', '::', '::1']) {
    const res = await new Promise((r) => { const t = createTcpServer(); t.once('error', (e) => r(e.code || 'ERR')); t.listen(port, host, () => t.close(() => r('ok'))); });
    if (res === 'ok' || res === 'EAFNOSUPPORT' || res === 'EADDRNOTAVAIL') continue;
    return false;
  }
  return true;
}
// SB_HTTP_PORT and SB_WS_PORT are also the names the real tools (the sidecar, backup.mjs) read to find a live Streamer.bot, so a
// shell that exports them for those would otherwise point the mock at the live ports. Streamer.bot's own are refused outright,
// before anything is bound.
if (!process.argv.includes('--allow-sb-ports')) {
  for (const [what, port, own] of [['HTTP', HTTP_PORT, 7474], ['WebSocket', WS_PORT, 8080]]) {
    if (port === own) {
      console.error(`[mock] the ${what} port ${port} is Streamer.bot's own. The mock will not use it. Choose another with SB_HTTP_PORT / SB_WS_PORT (or pass --allow-sb-ports if you really mean it).`);
      process.exit(1);
    }
  }
}
for (const [what, port] of [['HTTP', HTTP_PORT], ['WebSocket', WS_PORT]]) {
  if (!(await portFree(port))) {
    console.error(`[mock] ${what} port ${port} is already in use (a Streamer.bot, or another mock?). Not starting. Set SB_HTTP_PORT / SB_WS_PORT to free ports.`);
    process.exit(1);
  }
}
console.log('[mock] greenroom-mock: a MOCK of Streamer.bot for development and tests. It is not Streamer.bot and never talks to one.');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

// The two caches — raw pre-serialized JSON strings, exactly what the C# stores in
// its global vars. vdo = persisted analog, discord = non-persisted analog.
const caches = { vdo: null, discord: null };

// Every DoAction received, for verify assertions ({t, name, args}; capped ring).
const actionsLog = [];
const ACTIONS_CAP = 500;
function logAction(name, args) {
  actionsLog.push({ t: Date.now(), name, args });
  if (actionsLog.length > ACTIONS_CAP) actionsLog.splice(0, actionsLog.length - ACTIONS_CAP);
}

// SB's General.Custom envelope for a WebsocketBroadcastJson payload — data is an
// OBJECT (WebsocketBroadcastJson nests parsed JSON; plain WebsocketBroadcast would
// put a string there, which the shim also tolerates).
function customEvent(data) {
  return JSON.stringify({
    timeStamp: '1970-01-01T00:00:00.0000000',
    event: { source: 'General', type: 'Custom' },
    data: DATA_STRING ? JSON.stringify(data) : data,
  });
}

// ── Streamer.bot's own JSON parse, as the OLD actions met it (SB_WIRE=object only) ──────────────
// WebsocketBroadcastJson parses its argument with Newtonsoft's JObject.Parse (default date handling)
// and writes it back out. The effects below were checked against the real library (12.0.1, .NET
// Framework 4) for a table of about 60 label shapes; keys are never touched, only string VALUES, at
// any depth. This is NOT a full model of Newtonsoft's date grammar: it covers the shapes a guest
// label or Discord name plausibly has, and it is exact for dates in the last few decades (the
// host's time-zone rules before that differ between JavaScript and .NET).
//   2024-02-03T04:05:06.000Z      -> 2024-02-03T04:05:06Z        (fraction trimmed; none when zero)
//   2024-02-03T04:05:06+02:00     -> the host's local time with its own offset (…-05:00 on a UTC-5 host)
//   2024-02-03T04:05:06           -> unchanged (no zone)
//   2024-02-30T…, hour 25, a 60th second, a date-only value -> not a date, unchanged
//   /Date(1700000000000)/         -> 2023-11-14T22:13:20Z
//   a date outside 0001-01-01 … 9999-12-31 (a 24:00:00 that rolls past the end, a /Date(ms)/ out of
//   range) makes the whole parse THROW, so the broadcast never happens.
const NJ_MIN_MS = -62135596800000;
const NJ_MAX_MS = 253402300799999;
const NJ_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;
const NJ_MS = /^\/Date\((-?\d+)(?:([+-])(\d{4}))?\)\/$/;
const p2 = (n) => String(n).padStart(2, '0');
const njFrac = (digits) => { const t = (digits || '').replace(/0+$/, ''); return t ? '.' + t : ''; };
const njUnrepresentable = () => new RangeError('The added or subtracted value results in an un-representable DateTime.');

function njClock(d, get, digits) { // the date and time of day, from one family of Date getters
  const g = (n) => d[get + n]();
  return `${String(g('FullYear')).padStart(4, '0')}-${p2(g('Month') + 1)}-${p2(g('Date'))}T${p2(g('Hours'))}:${p2(g('Minutes'))}:${p2(g('Seconds'))}${njFrac(digits)}`;
}
function njLocal(ms, digits) { // an instant, as local time with the local offset (DateTimeKind.Local)
  const d = new Date(ms);
  // .NET applies today's zone rules to ancient dates; a JS Date would use the zone's 19th-century local mean time.
  const off = -(d.getUTCFullYear() < 1900 ? new Date(Date.UTC(2000, d.getUTCMonth(), d.getUTCDate())) : d).getTimezoneOffset();
  const tail = (off < 0 ? '-' : '+') + p2(Math.floor(Math.abs(off) / 60)) + ':' + p2(Math.abs(off) % 60);
  const local = ms + off * 60000; // a local time past either end of the DateTime range is clamped, not refused
  if (local < NJ_MIN_MS) return '0001-01-01T00:00:00' + tail;
  if (local > NJ_MAX_MS) return '9999-12-31T23:59:59.9999999' + tail;
  return njClock(new Date(local), 'getUTC', digits) + tail; // the local wall clock, read through the UTC getters
}

function njString(s) {
  let m = NJ_MS.exec(s);
  if (m) {
    const ms = Number(m[1]);
    if (ms < NJ_MIN_MS || ms > NJ_MAX_MS) throw njUnrepresentable();
    const digits = String(new Date(ms).getUTCMilliseconds()).padStart(3, '0');
    if (m[2]) return njLocal(ms, digits); // an offset marks the value Local (a bare -1234 is milliseconds)
    return njClock(new Date(ms), 'getUTC', digits) + 'Z';
  }
  m = NJ_ISO.exec(s);
  if (!m) return s;
  const [y, mo, da, h, mi, se] = m.slice(1, 7).map(Number);
  const digits = m[7] || '';
  const endOfDay = h === 24 && mi === 0 && se === 0 && /^0*$/.test(digits);
  if (y < 1 || mo < 1 || mo > 12 || mi > 59 || se > 59 || !(h <= 23 || endOfDay)) return s;
  const wall = new Date(0);
  wall.setUTCFullYear(y, mo - 1, da);
  if (wall.getUTCMonth() !== mo - 1 || wall.getUTCDate() !== da) return s; // not a calendar day
  wall.setUTCHours(h, mi, se, 0);                                          // 24:00:00 rolls into the next day
  const wallMs = wall.getTime();
  if (wallMs > NJ_MAX_MS) throw njUnrepresentable();
  const zone = m[8];
  if (!zone) return njClock(wall, 'getUTC', digits);
  if (zone === 'Z' || zone === 'z') return njClock(wall, 'getUTC', digits) + 'Z';
  const z = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
  const offMin = (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3] || 0));
  return njLocal(wallMs - offMin * 60000, digits);
}
function njWalk(v) {
  if (typeof v === 'string') return njString(v);
  if (Array.isArray(v)) return v.map(njWalk);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = njWalk(v[k]); return o; }
  return v;
}

// What one of the old actions broadcast: its payload text pasted straight into the frame, then
// parsed by Streamer.bot (a throw here is the broadcast failing).
function oldFrameData(type, field, payload) {
  let frame;
  try { frame = JSON.parse(`{"type":"${type}","${field}":${payload}}`); } catch (e) { throw new Error('Unexpected character encountered while parsing the broadcast: ' + e.message); }
  return njWalk(frame);
}

// The two pushed states. `update` is the frame type; the state travels in `jsonField` (an escaped
// string) or, in SB_WIRE=object mode, in `field` (a nested object).
const KINDS = {
  'VDO Push':           { key: 'vdo',     update: 'vdoninja:update',      field: 'vdoninja',     jsonField: 'vdoninjaJson',     err: 'vdo:error' },
  'Discord Voice Push': { key: 'discord', update: 'discord:voice:update', field: 'discordVoice', jsonField: 'discordVoiceJson', err: 'discord:voice:error' },
};
function updateData(kind, payload) {
  return WIRE_OBJECT ? oldFrameData(kind.update, kind.field, payload) : { type: kind.update, [kind.jsonField]: payload };
}
function emitError(kind, message) { broadcastRaw(customEvent({ type: kind.err, message })); }

// A push action. Returns nothing; it caches and broadcasts the way the C# of the matching mode does.
function push(name, args) {
  const kind = KINDS[name];
  let payload = args.payload;
  if (typeof payload !== 'string' || !payload) { console.log(`[mock] ${name}: no payload argument`); emitError(kind, `${name} called without a 'payload' argument`); return; }
  payload = netTrim(payload); // C# string.Trim(), which is not quite JavaScript's trim()
  if (modes.rewrite === 'fffd' && name === 'VDO Push') payload = payload.replace(/\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})|(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][c-fC-F][0-9a-fA-F]{2}/g, '\\ufffd');
  if (WIRE_OBJECT) {
    if (!payload.startsWith('{') || !payload.endsWith('}')) { console.log(`[mock] ${name}: payload is not a JSON object string`); emitError(kind, `${name} payload must be a JSON object string`); return; }
    caches[kind.key] = payload; // the old actions cached first…
    try { broadcastRaw(customEvent(updateData(kind, payload))); } // …so a broadcast that threw left the state behind
    catch (e) { console.log(`[mock] ${name}: broadcast failed (${e.message}) — cached anyway (old action)`); emitError(kind, e.message); }
    return;
  }
  const why = objectError(payload); // the strict check: one JSON object, no repeated key, nesting <= 32
  if (why) { console.log(`[mock] ${name}: payload rejected, NOT cached (${why})`); emitError(kind, `payload rejected, NOT cached: ${why}`); return; }
  const deliver = () => {
    broadcastRaw(customEvent(updateData(kind, payload))); // broadcast first, then cache
    caches[kind.key] = payload;
  };
  if (PUSH_DELAY_MS > 0 && name === 'VDO Push') setTimeout(deliver, PUSH_DELAY_MS); else deliver();
}

// The VDO Sync replay for a snapshot of the two caches. Returns how many blobs went out.
function syncReplay(snap) {
  let sent = 0;
  if (WIRE_OBJECT) {
    // The old action: one try around both replays, vdo first; any failure was reported as vdo:error.
    try {
      if (snap.vdo) { broadcastRaw(customEvent(updateData(KINDS['VDO Push'], snap.vdo))); sent++; }
      else if (EMPTY_MARKER) { broadcastRaw(customEvent({ type: 'vdo:sync:empty' })); sent++; }
      if (snap.discord) { broadcastRaw(customEvent(updateData(KINDS['Discord Voice Push'], snap.discord))); sent++; }
    } catch (e) { console.log(`[mock] VDO Sync: ${e.message}`); emitError(KINDS['VDO Push'], e.message); }
    return sent;
  }
  // Each replay is its own try, so one that fails never stops the other.
  for (const [name, text, marker] of [['VDO Push', snap.vdo, EMPTY_MARKER], ['Discord Voice Push', snap.discord, false]]) {
    const kind = KINDS[name];
    try {
      if (text && objectError(text)) { console.log(`[mock] VDO Sync: the cached ${kind.key} state is not valid JSON — reported, kept, not replayed`); emitError(kind, kind.key === 'vdo' ? 'cached state is not valid JSON - Import a backup or re-save' : 'cached state is not valid JSON - the bridge replaces it with its next push (restart the bridge to force one)'); }
      else if (text) { broadcastRaw(customEvent(updateData(kind, text))); sent++; }
      else if (marker) { broadcastRaw(customEvent({ type: 'vdo:sync:empty' })); sent++; }
    } catch (e) { console.log(`[mock] VDO Sync: ${e.message}`); emitError(kind, e.message); }
  }
  return sent;
}

// ── HTTP server (SB HTTP Server mimic) ───────────────────────────────────────

function safeResolve(base, rel) {
  const file = resolve(base, '.' + rel);
  return file === base || file.startsWith(base + '\\') || file.startsWith(base + '/') ? file : null;
}

async function serveFile(res, file) {
  try {
    const body = await readFile(file);
    const delay = FILE_DELAY[file.split(/[\\/]/).pop()] || 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

function landingHtml() {
  const link = (href, label) => `<li><a href="${href}" target="_blank">${label}</a></li>`;
  return `<!doctype html><meta charset="utf-8"><title>Greenroom — mock Streamer.bot</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#e6e6e6;background:#141414}
  h1{font-size:1.3rem} h2{font-size:1rem;margin:1.4rem 0 .3rem;color:#7ee787}
  a{color:#9ad}.dim{color:#888;font-size:.85em} ul{margin:.2rem 0;padding-left:1.2rem}
  code{background:#222;padding:.1em .4em;border-radius:4px}
</style>
<h1>Greenroom &mdash; mock Streamer.bot</h1>
<p class="dim">HTTP :${HTTP_PORT} (SB Path->Folder mimic) · WS :${WS_PORT} (SB WebSocket mimic)</p>
<h2>Overlays (open as OBS Browser Sources or tabs)</h2>
<ul>
${link(`/overlay/vdoninja-guest.html?slot=1&sbport=${WS_PORT}`, 'Guest slot 1')}
${link(`/overlay/nameplate.html?slot=1&sbport=${WS_PORT}`, 'Nameplate (slot 1, standalone)')}
${link(`/overlay/discord-roster.html?layout=row&sbport=${WS_PORT}`, 'Discord roster (row)')}
${link(`/overlay/discord-roster.html?layout=grid&sbport=${WS_PORT}`, 'Discord roster (grid)')}
</ul>
<h2>Control</h2>
<ul>
${link(`/control/control.html?sbport=${WS_PORT}`, 'Control page')}
${link(`/control/director-min.html?sbport=${WS_PORT}`, 'Director-min (1×1 source variant)')}
</ul>
<h2>Mock-only</h2>
<ul>
${link(`/mock/vdo-director.html`, 'Fake vdo.ninja director (scripted roster)')}
${link(`/mock/actions`, 'DoAction capture log')}
${link(`/mock/state`, 'Current caches')}
${link(`/mock/restart`, 'Simulate SB restart (clears discord cache only)')}
</ul>
<p class="dim">Drive Discord state with <code>npm run mock:bridge</code> (token-less fake sidecar over the real bus).</p>`;
}

const http = createServer((req, res) => {
  handleHttp(req, res).catch((e) => {
    console.error('[mock] HTTP handler error:', e && e.message);
    try { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); res.end('server error'); } catch {}
  });
});
async function handleHttp(req, res) {
  const url = req.url || '/';
  let path;
  try { path = decodeURIComponent(url.split('?')[0]); } catch { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad request'); return; }
  const rawQuery = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''; // a browser's query starts at the FIRST '?'
  const query = new URLSearchParams(rawQuery);

  if (path === '/mock/actions') {
    const body = JSON.stringify({ actions: actionsLog }, null, 1);
    if (query.get('clear') === '1') actionsLog.length = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }
  if (path === '/mock/mode') {
    // Every value is checked first, so a typo changes nothing and says so. `missing` takes any text; an empty one clears it.
    const ALLOWED = { subscribe: ['ok', 'none', 'error'], doaction: ['ok', 'error'], hello: ['none', 'plain', 'auth', 'mock', 'real'], auth: ['refuse', 'close', 'serve'], authfail: ['keep', 'close'], push: ['ok', 'error', 'drop'], rewrite: ['', 'fffd'] };
    for (const k of Object.keys(modes)) {
      if (query.has(k) && ALLOWED[k] && !ALLOWED[k].includes(query.get(k))) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `${k} must be one of ${ALLOWED[k].join(', ')}` }));
        return;
      }
    }
    for (const k of Object.keys(modes)) if (query.has(k)) modes[k] = query.get(k);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, modes }));
    return;
  }
  if (path === '/mock/dropall') {
    for (const c of clients) { try { c.close(); } catch {} }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (path === '/mock/drop') {
    const ms = Math.max(0, Math.min(60000, Number(query.get('ms')) || 0));
    refuseUntil = ms ? Date.now() + ms : 0;
    for (const c of clients) { try { c.terminate(); } catch {} }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, refusingForMs: ms }));
    return;
  }
  if (path === '/mock/conns') {
    const body = JSON.stringify({ conns: connLog });
    if (query.get('clear') === '1') connLog.length = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }
  if (path === '/mock/state') {
    const parseOr = (raw) => { if (raw == null) return null; try { return JSON.parse(raw); } catch { return { unparseable: raw }; } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ vdo: parseOr(caches.vdo), discord: parseOr(caches.discord) }, null, 1));
    return;
  }
  if (path === '/mock/restart') {
    // Simulates SB restarting: the persisted vdo.state global survives, the
    // non-persisted discord.state global is gone. (Connections are NOT dropped —
    // this models the global-store semantics, which is what VDO Sync replays.)
    caches.discord = null;
    const wipeVdo = query.get('vdo') === '1';
    if (wipeVdo) caches.vdo = null;
    console.log(`[mock] RESTART simulated — discord cache cleared, vdo cache ${wipeVdo ? 'cleared too' : 'kept'}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, kept: caches.vdo != null ? 'vdo' : null, cleared: wipeVdo ? 'vdo+discord' : 'discord' }));
    return;
  }
  if (path === '/mock/broadcast' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('body is not JSON'); return; }
      broadcastRaw(customEvent(data));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (path === '/mock/setcache' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let d;
      try { d = JSON.parse(body); } catch { res.writeHead(400); res.end('body is not JSON'); return; }
      if (!d || typeof d !== 'object' || Array.isArray(d)) { res.writeHead(400); res.end('body must be a JSON object'); return; }
      for (const k of ['vdo', 'discord']) if (k in d) caches[k] = typeof d[k] === 'string' ? d[k] : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (path === '/mock/vdo-director.html') {
    return serveFile(res, resolve(__dirname, 'mock-vdo-director.html'));
  }
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(landingHtml());
    return;
  }
  // The two SB HTTP maps — short prefixes plus the namespaced aliases the
  // real-SB docs recommend, so every documented URL also works against the mock.
  let file = null;
  if (path.startsWith('/greenroom-control/')) file = safeResolve(CONTROL_DIR, path.slice('/greenroom-control'.length));
  else if (path.startsWith('/greenroom-overlay/')) file = safeResolve(OVERLAY_DIR, path.slice('/greenroom-overlay'.length));
  else if (path.startsWith('/control/')) file = safeResolve(CONTROL_DIR, path.slice('/control'.length));
  else if (path.startsWith('/overlay/')) file = safeResolve(OVERLAY_DIR, path.slice('/overlay'.length));
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Map /greenroom-control/ (control/) or /greenroom-overlay/ (overlay/).');
    return;
  }
  // A page served from here must talk to THIS mock, never fall back to the default Streamer.bot port: with no ?sbport,
  // send the same URL back with it.
  if (extname(file).toLowerCase() === '.html' && !query.has('sbport')) {
    res.writeHead(302, { location: url.split('?')[0] + '?' + (rawQuery ? rawQuery + '&' : '') + 'sbport=' + WS_PORT });
    res.end();
    return;
  }
  return serveFile(res, file);
}

http.on('error', (err) => { console.error('[mock] HTTP error:', err.message); process.exit(1); });
let httpUp = false, wsUp = false;
// One marker, printed once, only after BOTH listeners are bound and never inside an error line: the harnesses wait for it.
const announceReady = () => { if (httpUp && wsUp) console.log(`[mock] READY http=${HTTP_PORT} ws=${WS_PORT}`); };
http.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[mock] HTTP  http://127.0.0.1:${HTTP_PORT}/  (landing page + /control/ + /overlay/)`);
  httpUp = true; announceReady();
});

// ── WebSocket server (SB WebSocket Server mimic) ─────────────────────────────

const wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT, verifyClient: (info, cb) => { if (Date.now() < refuseUntil) cb(false, 503, 'mock: down for a while'); else cb(true); } });
const clients = new Set();

function broadcastRaw(msg) {
  for (const ws of clients) { if (ws.subscribedCustom) { try { ws.send(msg); } catch {} } }
}

wss.on('error', (err) => { console.error('[mock] WS error:', err.message); process.exit(1); });
wss.on('connection', (ws) => {
  clients.add(ws);
  connLog.push({ t: Date.now() });
  ws.subscribedCustom = false; // only a correctly-subscribed client receives broadcasts
  if (DROP) { setTimeout(() => { try { ws.close(); } catch {} }, 100); }
  if (modes.hello !== 'none') {
    // The Hello every connection gets. info.source says this is a mock (the bridge guard and, later, the pages read it); an
    // authentication block rides along when SB_HELLO=auth, as it does in Streamer.bot when Authentication is on.
    const hello = modes.hello === 'real'
      // what Streamer.bot itself sends (info.source "websocketServer", not "mock"): a client that refuses mocks accepts this one
      ? { request: 'Hello', info: { instanceId: 'mock-instance', name: 'Streamer.bot', version: '0.2.5', os: 'windows', osVersion: '10.0.26300', source: 'websocketServer', session: 'mock-session', timestamp: new Date().toISOString() } }
      : { request: 'Hello', info: { name: 'greenroom-mock', source: 'mock', version: 'mock' } };
    if (modes.password) {
      // A real handshake (as in Streamer.bot with Authentication on): a fresh salt and challenge for this connection.
      ws.authSalt = randomBytes(12).toString('base64');
      ws.authChallenge = randomBytes(12).toString('base64');
      hello.authentication = { challenge: ws.authChallenge, salt: ws.authSalt };
    } else if (modes.hello === 'auth') hello.authentication = { challenge: 'mock-challenge', salt: 'mock-salt' };
    ws.send(JSON.stringify(hello));
  }
  ws.on('error', () => {}); // an abrupt close must never end the mock
  ws.on('message', (raw) => { try { onMessage(ws, raw); } catch (e) { console.log(`[mock] a frame was ignored after an error: ${e && e.message}`); } });
});
function onMessage(ws, raw) {
  {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    if (DROP) return;
    if (m.request === 'Authenticate') {
      // b64(sha256(b64(sha256(password + salt)) + challenge)), the documented Streamer.bot handshake. Never logged.
      if (Number(modes.authdrop) > 0) { modes.authdrop = String(Number(modes.authdrop) - 1); console.log('[mock] Authenticate DROPPED (authdrop): hung up with no reply'); try { ws.terminate(); } catch {} return; }
      if (modes.authsilent === '1') { console.log('[mock] Authenticate IGNORED (authsilent)'); return; }
      const b64sha = (t) => createHash('sha256').update(t).digest('base64');
      const want = modes.password && ws.authSalt ? b64sha(b64sha(modes.password + ws.authSalt) + ws.authChallenge) : null;
      if (want && m.authentication === want) { ws.authed = true; console.log('[mock] Authenticate OK'); ws.send(JSON.stringify({ status: 'ok', id: m.id })); }
      else {
        console.log('[mock] Authenticate REFUSED' + (want ? '' : ' (no password is set)'));
        ws.send(JSON.stringify({ status: 'error', id: m.id, error: 'mock: authentication failed' }));
        if (modes.authfail === 'close') setTimeout(() => { try { ws.close(); } catch {} }, 50);
      }
      return;
    }
    if ((modes.hello === 'auth' || modes.password) && modes.auth !== 'serve' && !ws.authed) {
      // Unauthenticated: a server that enforces authentication refuses (or, with auth=close, hangs up on) the request.
      if (modes.auth === 'close') { try { ws.close(); } catch {} }
      else ws.send(JSON.stringify({ status: 'error', id: m.id, error: 'mock: authentication required' }));
      return;
    }

    if (m.request === 'Subscribe') {
      // The documented request is {events:{general:['Custom']}} (a lowercase source key, while delivered events carry a
      // capitalized source 'General'). The mock matches the key and the type without regard to case, so a client that
      // writes either spelling is served; what it must still do is ask for the general source and the Custom event.
      const entry = Object.entries(m.events && typeof m.events === 'object' ? m.events : {}).find(([k]) => String(k).toLowerCase() === 'general');
      ws.subscribedCustom = !!entry && Array.isArray(entry[1]) && entry[1].some((t) => String(t).toLowerCase() === 'custom');
      console.log('[mock] Subscribe', ws.subscribedCustom ? 'OK (general.Custom)' : 'IGNORED (expected events.general:["Custom"])');
      if (modes.subscribe === 'none') return; // never answered
      const reply = modes.subscribe === 'error'
        ? { status: 'error', id: m.id, error: 'mock: subscribe refused' }
        // The documented flat reply: {status, id, events} (no 'result' wrapper).
        : { status: 'ok', id: m.id, events: m.events };
      const sendReply = () => { try { ws.send(JSON.stringify(reply)); } catch {} };
      if (SUBSCRIBE_DELAY_MS > 0) setTimeout(sendReply, SUBSCRIBE_DELAY_MS); else sendReply();
      return;
    }

    if (m.request === 'DoAction') {
      // Always ack ok — like real SB, ok means the action STARTED, not that it succeeded.
      // An invalid argument or an exception in a running action is reported by an error
      // broadcast; an action that failed to COMPILE broadcasts nothing at all.
      const name = (m.action && m.action.name) || '';
      const args = m.args && typeof m.args === 'object' && !Array.isArray(m.args) ? m.args : {};
      logAction(name, args);
      if (modes.doaction === 'error') { ws.send(JSON.stringify({ status: 'error', id: m.id, error: 'mock: action not found' })); return; }
      const missing = String(modes.missing || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!KNOWN_ACTIONS.has(name) || missing.includes(name)) { ws.send(JSON.stringify({ status: 'error', id: m.id, error: `mock: action not found: ${name}` })); return; }
      if (name === 'VDO Push' && modes.push === 'error') { ws.send(JSON.stringify({ status: 'error', id: m.id, error: 'mock: VDO Push refused' })); return; }
      ws.send(JSON.stringify({ id: m.id, status: 'ok' }));

      if (name === 'VDO Push') {
        if (modes.push === 'drop') { console.log('[mock] VDO Push → acked and dropped (push=drop)'); return; }
        push(name, args);
        console.log('[mock] VDO Push → handled');
        return;
      }
      if (name === 'Discord Voice Push') {
        push(name, args); // high-frequency: no per-push log
        return;
      }
      if (name === 'VDO Sync') {
        if (syncDropsLeft > 0) { syncDropsLeft--; console.log('[mock] VDO Sync → replay dropped (SB_SYNC_DROP)'); return; }
        // Read at request time, broadcast SYNC_DELAY_MS later (the real action reads,
        // then broadcasts; a delay models a slow first sync).
        const snap = { vdo: caches.vdo, discord: caches.discord };
        const replay = () => console.log(`[mock] VDO Sync → replayed ${syncReplay(snap)} cached blob(s)`);
        if (SYNC_DELAY_MS > 0) setTimeout(replay, SYNC_DELAY_MS); else replay();
        return;
      }
      if (name === 'Discord Voice Command') {
        const command = String(args.command ?? '');
        const value = String(args.value ?? '');
        if (!command) { console.log('[mock] Discord Voice Command with no command — ignored'); return; }
        broadcastRaw(customEvent({ type: 'discord:voice:command', command, value }));
        console.log(`[mock] Discord Voice Command → ${command}${value ? ' ' + value.slice(0, 60) : ''}`);
        return;
      }
      console.log(`[mock] DoAction for "${name}" — a known action the mock does not implement: acked, no effect`);
      return;
    }
  }
}
wss.on('connection', (ws) => { ws.on('close', () => clients.delete(ws)); });
wss.on('listening', () => { console.log(`[mock] WS    ws://127.0.0.1:${WS_PORT}  (Streamer.bot mock)`); wsUp = true; announceReady(); });
