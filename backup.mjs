// Greenroom config backup — snapshot / restore the Streamer.bot `vdo.state` global
// to a JSON file. That global is the ENTIRE guest-dock config (room, password,
// viewFlags, slots, invite, and the guest **directory** / nameplates) and it
// otherwise lives only inside Streamer.bot's persisted store. This talks the same
// SB WebSocket the control page does (VDO Sync to read, VDO Push to write), so a
// restore persists exactly as an operator edit would.
//
// The Discord bot's favorites/settings are already file-based
// (sidecar/discord-voice-config.json — copy that file to back those up). The live
// voice roster (`discord.state`) is deliberately non-persisted and not snapshotted.
//
// Usage (Streamer.bot — or `npm start`'s mock — must be running):
//   node backup.mjs [save] [file]    snapshot vdo.state → file
//                                    (default backups/vdo-state-<timestamp>.json)
//   node backup.mjs restore <file>   push a snapshot back into SB (persists)
//   node backup.mjs list             list snapshots in backups/
//   --url ws://host:port/            override the SB WebSocket (else SB_WS_URL /
//                                    SB_WS_PORT, default ws://127.0.0.1:8080/)
//
// SECURITY: a snapshot contains your room PASSWORD (and resolved stream IDs).
// backups/ is gitignored — treat the files as secret.

import WebSocket from 'ws';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = resolve(__dirname, 'backups');
const CONNECT_MS = 6000; // give up if SB isn't listening
const REPLY_MS = 5000;   // wait for a sync replay / push rebroadcast

function die(msg) { console.error('backup: ' + msg); process.exit(1); }
function abs(p) { return isAbsolute(p) ? p : resolve(process.cwd(), p); }

function tsName() {
  // Local-time, filesystem-safe: vdo-state-2026-07-12T18-40-05.json
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `vdo-state-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.json`;
}

// One-line summary of a vdoninja payload for operator feedback.
function summarize(v) {
  const slots = Array.isArray(v.slots) ? v.slots.filter((s) => s && (s.label || s.streamID || s.discordUserId)).length : 0;
  const dir = Array.isArray(v.directory) ? v.directory.length : 0;
  return `room ${v.room ? `"${v.room}"` : '(unset)'}, ${slots} bound slot(s), ${dir} directory entr${dir === 1 ? 'y' : 'ies'}`;
}

// A minimal subscribed SB client: resolves once Subscribe is acked. `waitCustom`
// resolves with the first General.Custom `data` matching pred (or rejects on
// timeout); `doAction` fires and returns its request id.
function connect(url) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(url);
    let idN = 0;
    const customWaiters = [];
    const ackWaiters = [];
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} rejectConn(new Error(`could not reach Streamer.bot at ${url} — is its WebSocket Server on (auth off)?`)); }, CONNECT_MS);

    function pump(waiters, item) {
      const i = waiters.findIndex((w) => w.pred(item));
      if (i !== -1) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(item); }
    }

    ws.on('error', (e) => { clearTimeout(timer); rejectConn(e); });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m && m.id && !m.event) { pump(ackWaiters, m); return; }
      if (m && m.event && m.event.source === 'General' && m.event.type === 'Custom') {
        let d = m.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
        if (d && typeof d === 'object') pump(customWaiters, d);
      }
    });
    ws.on('open', () => {
      const subId = 'sub' + (++idN);
      ws.send(JSON.stringify({ request: 'Subscribe', id: subId, events: { general: ['Custom'] } }));
      // Lowercase `general` — the SB Subscribe case gotcha (a capitalized key acks but receives nothing).
      const wait = (waiters, ms, pred, what) => new Promise((res, rej) => {
        const w = { pred, resolve: res, timer: null };
        w.timer = setTimeout(() => { const i = waiters.indexOf(w); if (i !== -1) waiters.splice(i, 1); rej(new Error('timeout waiting for ' + what)); }, ms);
        waiters.push(w);
      });
      wait(ackWaiters, CONNECT_MS, (m) => m.id === subId, 'Subscribe ack').then(() => {
        clearTimeout(timer);
        resolveConn({
          waitCustom: (pred, ms, what) => wait(customWaiters, ms, pred, what),
          doAction(name, args) { const id = 'req' + (++idN); ws.send(JSON.stringify({ request: 'DoAction', id, action: { name }, args })); return id; },
          waitAck: (id, ms, what) => wait(ackWaiters, ms, (m) => m.id === id, what),
          close() { try { ws.close(); } catch {} },
        });
      }).catch(rejectConn);
    });
  });
}

async function save(file) {
  const out = file ? abs(file) : resolve(BACKUP_DIR, tsName());
  const sb = await connect(URL_ARG);
  try {
    sb.doAction('VDO Sync', { reason: 'backup' });
    let data;
    try {
      data = await sb.waitCustom((d) => d.type === 'vdoninja:update' && d.vdoninja && typeof d.vdoninja === 'object', REPLY_MS, 'vdoninja:update replay');
    } catch {
      die('Streamer.bot returned no vdo.state — nothing to back up yet. Open the control page and set a room / add a guest first (it pushes on the first edit).');
    }
    const payload = data.vdoninja;
    const envelope = { kind: 'greenroom-vdo-backup', savedAt: new Date().toISOString(), vdoninja: payload };
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(envelope, null, 2) + '\n', 'utf-8');
    console.log(`saved ${out}`);
    console.log(`  ${summarize(payload)}`);
  } finally { sb.close(); }
}

async function restore(file) {
  if (!file) die('restore needs a file: node backup.mjs restore <file>');
  let parsed;
  try { parsed = JSON.parse(await readFile(abs(file), 'utf-8')); }
  catch (e) { return die(`could not read/parse ${file}: ${e.message}`); }
  // Accept either a backup envelope (has .vdoninja) or a raw vdoninja payload.
  const payload = parsed && typeof parsed.vdoninja === 'object' && parsed.vdoninja ? parsed.vdoninja : parsed;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) die('that file is not a Greenroom vdo backup (expected a JSON object).');
  if (!Array.isArray(payload.slots) && !Array.isArray(payload.directory) && !('room' in payload)) {
    die('that file has no slots/directory/room — it does not look like a vdo.state snapshot. Refusing to push it.');
  }
  const sb = await connect(URL_ARG);
  try {
    const id = sb.doAction('VDO Push', { payload: JSON.stringify(payload) });
    await sb.waitAck(id, REPLY_MS, 'VDO Push ack').catch(() => die('Streamer.bot did not ack the push.'));
    // Confirm SB actually stored + rebroadcast it (ack alone only means "started").
    try {
      await sb.waitCustom((d) => d.type === 'vdoninja:update' && d.vdoninja && typeof d.vdoninja === 'object', REPLY_MS, 'rebroadcast');
      console.log(`restored ${abs(file)}`);
      console.log(`  → VDO Push: SB vdo.state updated + rebroadcast (${summarize(payload)})`);
    } catch {
      console.log(`sent ${abs(file)} (VDO Push acked), but no rebroadcast was observed — check the "VDO Push" action compiled in SB.`);
    }
    console.log('  Open control pages/overlays will repaint; new sources hydrate via VDO Sync.');
  } finally { sb.close(); }
}

async function list() {
  let names;
  try { names = (await readdir(BACKUP_DIR)).filter((n) => n.endsWith('.json')); }
  catch { console.log(`no backups yet (${BACKUP_DIR} is empty or missing) — run "npm run backup".`); return; }
  if (!names.length) { console.log(`no backups yet in ${BACKUP_DIR} — run "npm run backup".`); return; }
  const rows = await Promise.all(names.map(async (n) => {
    const s = await stat(resolve(BACKUP_DIR, n));
    return { n, size: s.size, mtime: s.mtimeMs };
  }));
  rows.sort((a, b) => b.mtime - a.mtime);
  console.log(`${rows.length} backup(s) in ${BACKUP_DIR}:`);
  for (const r of rows) console.log(`  ${r.n}  (${r.size} bytes)`);
}

// ── Entry ───────────────────────────────────────────────────────────────────
const rawArgv = process.argv.slice(2);
const positional = [];
let URL_ARG = process.env.SB_WS_URL || `ws://127.0.0.1:${process.env.SB_WS_PORT || 8080}/`;
for (let i = 0; i < rawArgv.length; i++) {
  const a = rawArgv[i];
  if (a === '--url') URL_ARG = rawArgv[++i];
  else if (a.startsWith('--url=')) URL_ARG = a.slice(6);
  else positional.push(a);
}

const cmd = positional[0] && ['save', 'restore', 'list'].includes(positional[0]) ? positional.shift() : 'save';
try {
  if (cmd === 'save') await save(positional[0]);
  else if (cmd === 'restore') await restore(positional[0]);
  else if (cmd === 'list') await list();
  process.exit(0);
} catch (e) {
  die(e && e.message ? e.message : String(e));
}
