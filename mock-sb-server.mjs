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
//       /mock/restart           -> clears the DISCORD cache only — simulates an SB
//                                  restart wiping the non-persisted `discord.state`
//                                  global while the persisted `vdo.state` survives
//       /                       -> a landing page for quick manual testing
//
//   • WebSocket Server on :8080 — speaks SB's envelope and implements the FIVE
//     Greenroom action semantics (mirroring the C# in actions/):
//       VDO Push              cache args.payload as vdo.state (persisted analog);
//                             broadcast {type:'vdoninja:update', vdoninja:<payload>}
//       Discord Voice Push    cache as discord.state (non-persisted analog);
//                             broadcast {type:'discord:voice:update', discordVoice:<payload>}
//       VDO Sync              re-broadcast both non-empty caches, vdo first
//       Discord Voice Command broadcast {type:'discord:voice:command', command, value}
//                             (value stays a STRING, exactly like the C#)
//     On `Subscribe` it enforces the real-SB lowercase `general` source key — a
//     wrong-case subscribe is acked but receives nothing, exactly like real SB.
//     DoAction is ALWAYS acked {status:'ok'} — ok means started, not succeeded.
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
    data,
  });
}

function parsePayload(name, raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    console.log(`[mock] ${name}: missing/empty payload arg — ignored`);
    return null;
  }
  try { return JSON.parse(raw); } catch {
    console.log(`[mock] ${name}: payload is not valid JSON — cached but NOT broadcast (real SB would emit an unparseable frame)`);
    return null;
  }
}

function wrapVdo(parsed) { return customEvent({ type: 'vdoninja:update', vdoninja: parsed }); }
function wrapDiscord(parsed) { return customEvent({ type: 'discord:voice:update', discordVoice: parsed }); }

// ── HTTP server (SB HTTP Server mimic) ───────────────────────────────────────

function safeResolve(base, rel) {
  const file = resolve(base, '.' + rel);
  return file === base || file.startsWith(base + '\\') || file.startsWith(base + '/') ? file : null;
}

async function serveFile(res, file) {
  try {
    const body = await readFile(file);
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
    console.log('[mock] RESTART simulated — discord cache cleared, vdo cache kept');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, kept: caches.vdo != null ? 'vdo' : null, cleared: 'discord' }));
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
  ws.subscribedCustom = false; // only a correctly-subscribed client receives broadcasts
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.request === 'Subscribe') {
      // Real Streamer.bot uses a LOWERCASE source key ('general') in Subscribe, while
      // delivered events carry a capitalized source ('General'). Enforce that here so
      // a wrong-case subscribe gets nothing — exactly how real SB behaves.
      const gen = m.events && m.events.general;
      ws.subscribedCustom = Array.isArray(gen) && gen.includes('Custom');
      console.log('[mock] Subscribe', ws.subscribedCustom ? 'OK (general.Custom)' : 'IGNORED (expected lowercase events.general:["Custom"])');
      ws.send(JSON.stringify({ id: m.id, status: 'ok', result: { events: m.events } }));
      return;
    }

    if (m.request === 'DoAction') {
      // Always ack ok — like real SB, ok means the action STARTED, not that it
      // succeeded. (A C# compile failure in real SB also acks ok and broadcasts
      // nothing; that is why the actions carry error broadcasts.)
      ws.send(JSON.stringify({ id: m.id, status: 'ok' }));
      const name = (m.action && m.action.name) || '';
      const args = m.args || {};
      logAction(name, args);

      if (name === 'VDO Push') {
        const parsed = parsePayload(name, args.payload);
        if (typeof args.payload === 'string' && args.payload.trim()) caches.vdo = args.payload;
        if (parsed) { broadcastRaw(wrapVdo(parsed)); console.log('[mock] VDO Push → cached (persisted analog) + broadcast'); }
        return;
      }
      if (name === 'Discord Voice Push') {
        const parsed = parsePayload(name, args.payload);
        if (typeof args.payload === 'string' && args.payload.trim()) caches.discord = args.payload;
        if (parsed) broadcastRaw(wrapDiscord(parsed)); // high-frequency: no per-push log
        return;
      }
      if (name === 'VDO Sync') {
        let sent = 0;
        if (caches.vdo) { const p = parsePayload(name, caches.vdo); if (p) { broadcastRaw(wrapVdo(p)); sent++; } }
        if (caches.discord) { const p = parsePayload(name, caches.discord); if (p) { broadcastRaw(wrapDiscord(p)); sent++; } }
        console.log(`[mock] VDO Sync → replayed ${sent} cached blob(s)`);
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
