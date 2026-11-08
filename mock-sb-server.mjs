// Throwaway mock of Streamer.bot — lets all of Greenroom run with NO Streamer.bot
// install, for local development and the verify suites. It faithfully mimics the
// two SB surfaces Greenroom depends on:
//
//   • HTTP Server on :7474 — SB Path->Folder file serving. Both the short and the
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
//       /                       -> a landing page for quick manual testing
//
//     Test options (environment variables, all off by default):
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
//       SB_SUBSCRIBE=none|error Subscribe is never answered, or answered {status:'error'}
//       SB_SUBSCRIBE_DELAY_MS=<n>  the Subscribe reply (ok or error) comes n ms late
//       SB_DOACTION=error       every DoAction is answered {status:'error'} and not run
//       SB_HELLO=plain|auth     send a Hello frame on connect: plain, or carrying an authentication block
//       SB_AUTH=close|serve     with SB_HELLO=auth: close a client that sends any request, or serve
//                               requests anyway (Authentication on, Enforce off); default: refuse them
//       SB_SYNC_DROP=1          the first VDO Sync is acked but its replay is never broadcast
//       The four mode options above can also be changed while running:
//       GET /mock/mode?subscribe=ok|none|error&doaction=ok|error&hello=none|plain|auth&auth=refuse|close|serve
//       GET /mock/dropall       close every WebSocket client (they reconnect)
//       SB_DATA=string          deliver General.Custom `data` as a JSON string, not an object
//       SB_DROP=1               accept each connection and close it ~100 ms later, unanswered
//       GET /mock/conns[?clear=1] -> the WebSocket connect times, [{t}]
//
//   • WebSocket Server on :8080 — speaks SB's envelope and implements the FIVE
//     Greenroom action semantics (mirroring the C# in actions/):
//       VDO Push              broadcast {type:'vdoninja:update', vdoninjaJson:'<payload>'}, THEN
//                             cache args.payload as vdo.state (persisted analog)
//       Discord Voice Push    broadcast {type:'discord:voice:update', discordVoiceJson:'<payload>'},
//                             then cache as discord.state (non-persisted analog)
//       VDO Sync              replay both caches the same way (each replay is its own try, and the
//                             order is not promised); an empty vdo.state broadcasts
//                             {type:'vdo:sync:empty'}; an empty discord.state is skipped
//       Discord Voice Command broadcast {type:'discord:voice:command', command, value}
//                             (value stays a STRING, exactly like the C#)
//     A missing or non-object payload is answered with a vdo:error / discord:voice:error frame
//     and nothing is cached, as in the C#.
//     On `Subscribe` it enforces the real-SB lowercase `general` source key — a
//     wrong-case subscribe is acked but receives nothing, exactly like real SB.
//     DoAction is ALWAYS acked {status:'ok'} — ok means the action STARTED, not that it
//     succeeded. An invalid argument or an exception inside a running action is reported by the
//     error frame above; an action that failed to COMPILE broadcasts nothing at all.
//
// This is a REFERENCE/TEST harness. The real thing is Streamer.bot itself (see
// docs/STREAMERBOT-SETUP.md) with the same wire shapes.

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTROL_DIR = resolve(__dirname, 'control');
const OVERLAY_DIR = resolve(__dirname, 'overlay');

const HTTP_PORT = Number(process.env.SB_HTTP_PORT) || 7474; // SB HTTP Server default
const WS_PORT = Number(process.env.SB_WS_PORT) || 8080; // SB WebSocket Server default
const SYNC_DELAY_MS = Number(process.env.SYNC_DELAY_MS) || 0;
const WIRE_OBJECT = process.env.SB_WIRE === 'object'; // the old action behaviour (see the header)
const EMPTY_MARKER = process.env.SB_EMPTY_MARKER ? process.env.SB_EMPTY_MARKER === '1' : !WIRE_OBJECT;
// Mutable at run time (GET /mock/mode), so a test can flip a behaviour without respawning the mock.
const modes = {
  subscribe: process.env.SB_SUBSCRIBE || 'ok',
  doaction: process.env.SB_DOACTION === 'error' ? 'error' : 'ok',
  hello: process.env.SB_HELLO === 'auth' ? 'auth' : (process.env.SB_HELLO === 'plain' ? 'plain' : 'none'),
  auth: process.env.SB_AUTH === 'close' ? 'close' : (process.env.SB_AUTH === 'serve' ? 'serve' : 'refuse'),
};
const SUBSCRIBE_DELAY_MS = Number(process.env.SB_SUBSCRIBE_DELAY_MS) || 0;
let syncDropsLeft = process.env.SB_SYNC_DROP === '1' ? 1 : 0;
const DATA_STRING = process.env.SB_DATA === 'string';
const DROP = process.env.SB_DROP === '1';
const FILE_DELAY = Object.fromEntries((process.env.SB_FILE_DELAY || '').split(',').filter(Boolean)
  .map((p) => { const i = p.lastIndexOf(':'); return [p.slice(0, i), Number(p.slice(i + 1)) || 0]; }));
const connLog = []; // WebSocket connect times

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
// and writes it back out. These are the effects checked against the real library; keys are never
// touched, only string VALUES, at any depth:
//   2024-02-03T04:05:06.000Z      -> 2024-02-03T04:05:06Z        (fraction trimmed; none when zero)
//   2024-02-03T04:05:06+02:00     -> the host's local time with its own offset (…-05:00 on a UTC-5 host)
//   2024-02-03T04:05:06           -> unchanged (no zone)          2024-02-30T…, hour 25, a 60th second
//   /Date(1700000000000)/         -> 2023-11-14T22:13:20Z                           -> not a date, unchanged
//   a date outside 0001-01-01 … 9999-12-31 (a 24:00:00 that rolls past the end, a /Date(ms)/ out of
//   range) makes the whole parse THROW, so the broadcast never happens.
const NJ_MIN_MS = -62135596800000;
const NJ_MAX_MS = 253402300799999;
const NJ_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;
const NJ_MS = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/;
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
    if (/[+-]\d{4}\)\/$/.test(s)) return njLocal(ms, digits); // an offset marks the value Local
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
  payload = payload.trim();
  if (!payload.startsWith('{') || !payload.endsWith('}')) { console.log(`[mock] ${name}: payload is not a JSON object string`); emitError(kind, `${name} payload must be a JSON object string`); return; }
  if (WIRE_OBJECT) {
    caches[kind.key] = payload; // the old actions cached first…
    try { broadcastRaw(customEvent(updateData(kind, payload))); } // …so a broadcast that threw left the state behind
    catch (e) { console.log(`[mock] ${name}: broadcast failed (${e.message}) — cached anyway (old action)`); emitError(kind, e.message); }
    return;
  }
  broadcastRaw(customEvent(updateData(kind, payload))); // broadcast first, then cache
  caches[kind.key] = payload;
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
      if (text) { broadcastRaw(customEvent(updateData(kind, text))); sent++; }
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

const http = createServer(async (req, res) => {
  const url = req.url || '/';
  const path = decodeURIComponent(url.split('?')[0]);
  const query = new URLSearchParams(url.split('?')[1] || '');

  if (path === '/mock/actions') {
    const body = JSON.stringify({ actions: actionsLog }, null, 1);
    if (query.get('clear') === '1') actionsLog.length = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }
  if (path === '/mock/mode') {
    for (const k of Object.keys(modes)) if (query.get(k)) modes[k] = query.get(k);
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
  return serveFile(res, file);
});

http.on('error', (err) => { console.error('[mock] HTTP error:', err.message); process.exit(1); });
http.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[mock] HTTP  http://127.0.0.1:${HTTP_PORT}/  (landing page + /control/ + /overlay/)`);
});

// ── WebSocket server (SB WebSocket Server mimic) ─────────────────────────────

const wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT });
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
    // Streamer.bot's Hello; it carries an authentication block when Authentication is on.
    const hello = { request: 'Hello', info: { name: 'Streamer.bot', version: 'mock' } };
    if (modes.hello === 'auth') hello.authentication = { challenge: 'mock-challenge', salt: 'mock-salt' };
    ws.send(JSON.stringify(hello));
  }
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (DROP) return;
    if (modes.hello === 'auth' && modes.auth !== 'serve' && m.request !== 'Authenticate') {
      // Unauthenticated: a server that enforces authentication refuses (or, with auth=close, hangs up on) the request.
      if (modes.auth === 'close') { try { ws.close(); } catch {} }
      else ws.send(JSON.stringify({ status: 'error', id: m.id, error: 'mock: authentication required' }));
      return;
    }

    if (m.request === 'Subscribe') {
      // Real Streamer.bot uses a LOWERCASE source key ('general') in Subscribe, while
      // delivered events carry a capitalized source ('General'). Enforce that here so
      // a wrong-case subscribe gets nothing — exactly how real SB behaves.
      const gen = m.events && m.events.general;
      ws.subscribedCustom = Array.isArray(gen) && gen.includes('Custom');
      console.log('[mock] Subscribe', ws.subscribedCustom ? 'OK (general.Custom)' : 'IGNORED (expected lowercase events.general:["Custom"])');
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
      const args = m.args || {};
      logAction(name, args);
      if (modes.doaction === 'error') { ws.send(JSON.stringify({ status: 'error', id: m.id, error: 'mock: action not found' })); return; }
      ws.send(JSON.stringify({ id: m.id, status: 'ok' }));

      if (name === 'VDO Push') {
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
      console.log(`[mock] DoAction for unknown action "${name}" — acked, no effect`);
      return;
    }
  });
  ws.on('close', () => clients.delete(ws));
});
wss.on('listening', () => console.log(`[mock] WS    ws://127.0.0.1:${WS_PORT}  (Streamer.bot mock)`));
