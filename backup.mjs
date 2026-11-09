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
// Usage (your REAL Streamer.bot must be running; the development mock keeps nothing worth backing up):
//   node backup.mjs [save [file]]    snapshot vdo.state → file (the verb is needed before a file name)
//                                    (default backups/vdo-state-<timestamp>.json; an explicit file that
//                                    already exists is refused unless --force)
//   node backup.mjs restore <file>   check a snapshot, show current vs new, and — only with --yes — save the
//                                    current state to backups/pre-restore-<timestamp>.json and push the
//                                    snapshot back into SB (persists), then confirm Streamer.bot took it
//   node backup.mjs list             list snapshots in backups/
//   node backup.mjs --help           this text
//   --url ws://host:port/            override the SB WebSocket (else SB_WS_URL /
//                                    SB_WS_PORT, default ws://127.0.0.1:8080/)
//   --yes                            restore: really replace the saved config
//   --force                          save: overwrite an existing file; restore: accept a raw payload that is not
//                                    a backup envelope, and restore even when the current config cannot be read
//                                    (then no copy of it can be saved first)
//
// Through npm the flags go after a `--`:  npm run backup -- --url ws://127.0.0.1:8081/
//                                        npm run backup:restore -- backups/<file> --yes
// (npm swallows a bare `--url`; this tool refuses to run when it sees that happen.)
// A relative <file> is looked up from where npm was run, and a bare name also in backups/.
// GREENROOM_BACKUP_DIR moves the snapshot folder (the tests use it).
//
// SECURITY: a snapshot contains your room PASSWORD (and resolved stream IDs).
// backups/ is gitignored — treat the files as secret.

import WebSocket from 'ws';
import { readFile, mkdir, readdir, stat, rename, rm, open } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = process.env.GREENROOM_BACKUP_DIR ? resolve(process.env.GREENROOM_BACKUP_DIR) : resolve(__dirname, 'backups');
const CONNECT_MS = 6000; // give up if SB isn't listening
const REPLY_MS = 5000;   // wait for a sync replay / push rebroadcast
const DEFAULT_VIEWFLAGS = '&solo&hidescreenshare&rounded=0&tallyoff&fadein&codec=h264&cleanish'; // the control page's default view flags
const SUPPORTED_SCHEMA = 2; // the newest vdo.state schemaVersion this tool knows (the control page's SCHEMA_VERSION)

function die(msg, code = 1) { console.error('backup: ' + msg); process.exit(code); }
const USAGE = `usage:
  node backup.mjs [save [file]] [--force]       snapshot vdo.state to a file (default backups/vdo-state-<time>.json)
  node backup.mjs restore <file> [--yes] [--force]   check a snapshot, show current vs new, and with --yes restore it
  node backup.mjs list                           list the snapshots in backups/
  options: --url ws://host:port/   (through npm: npm run backup -- --url ws://host:port/)`;
function usageDie(msg) { console.error('backup: ' + msg + '\n' + USAGE); process.exit(2); }

// ── Arguments (strict) ──────────────────────────────────────────────────────────────────────────
const rawArgv = process.argv.slice(2);
const positional = [];
let URL_ARG = process.env.SB_WS_URL || `ws://127.0.0.1:${process.env.SB_WS_PORT || 8080}/`;
let YES = false, FORCE = false;
for (let i = 0; i < rawArgv.length; i++) {
  const a = rawArgv[i];
  if (a === '--help' || a === '-h' || a === 'help') { console.log(USAGE); process.exit(0); }
  else if (a === '--yes') YES = true;
  else if (a === '--force') FORCE = true;
  else if (a === '--url') { const v = rawArgv[++i]; if (!v || v.startsWith('-')) usageDie('--url needs a value, e.g. --url ws://127.0.0.1:8080/'); URL_ARG = v; }
  else if (a.startsWith('--url=')) { URL_ARG = a.slice(6); if (!URL_ARG) usageDie('--url needs a value'); }
  else if (a.startsWith('-')) usageDie(`unknown option ${a}`);
  else positional.push(a);
}
// npm 7+ takes a bare `--url` for itself and exports it as npm_config_url, so the flag never reaches this script, and the URL
// that followed it arrives as a stray word. Say what happened before the word checks below complain about it.
if (process.env.npm_config_url !== undefined && positional[0] !== 'list') {
  die(`npm swallowed a --url (npm_config_url=${process.env.npm_config_url}), so this run would aim at the default Streamer.bot, not that one. Put the flags after a \`--\`:\n`
    + '  npm run backup -- --url ws://127.0.0.1:8081/\n  npm run backup:restore -- <file> --url ws://127.0.0.1:8081/ --yes', 2);
}
const VERBS = new Set(['save', 'restore', 'list']);
let cmd = 'save';
if (positional.length && VERBS.has(positional[0])) cmd = positional.shift();
else if (positional.length) usageDie(`"${positional[0]}" is not a command: write save, restore or list first (a file name goes after the command)`);
if (cmd === 'list' && positional.length) usageDie('list takes no arguments');
if (cmd === 'save' && positional.length > 1) usageDie('save takes at most one file');
if (cmd === 'restore' && positional.length !== 1) usageDie('restore takes exactly one file: node backup.mjs restore <file> --yes');
if (cmd === 'save' && positional[0] && /^wss?:\/\//i.test(positional[0])) usageDie(`"${positional[0]}" looks like a URL, not a file: put --url before the file or use --url=`);

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────
function tsName() {
  // Local time, filesystem-safe, to the millisecond: 2026-07-12T18-40-05-123
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const canon = (x) => (Array.isArray(x) ? x.map(canon) : isPlain(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const sameState = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// The vdo.state object inside a `vdoninja:update` frame, or null. Both wire shapes are read:
// the current escaped string field `vdoninjaJson`, and the nested `vdoninja` object an older
// "VDO Push" / "VDO Sync" paste still broadcasts (this tool is run BEFORE the actions are updated).
function stateOf(d) {
  if (!d || d.type !== 'vdoninja:update') return null;
  let v = d.vdoninja;
  if (typeof d.vdoninjaJson === 'string') { try { v = JSON.parse(d.vdoninjaJson); } catch { return null; } }
  return isPlain(v) ? v : null;
}

// One-line summary of a vdoninja payload for operator feedback.
function summarize(v, directory = v.directory) {
  const slots = Array.isArray(v.slots) ? v.slots.filter((s) => s && (s.label || s.streamID || s.discordUserId)).length : 0;
  const dir = Array.isArray(directory) ? directory.length : 0;
  return `room ${v.room ? `"${v.room}"` : '(unset)'}, ${slots} bound slot(s), ${dir} directory entr${dir === 1 ? 'y' : 'ies'}`;
}

// The page's own directory rules (control/directory-core.js sets globalThis.GRDir), so a restore pushes what the page would.
let GRDir = null;
function loadDirectoryCore() {
  if (GRDir) return GRDir;
  new Function(readFileSync(resolve(__dirname, 'control', 'directory-core.js'), 'utf8'))();
  GRDir = globalThis.GRDir;
  if (!GRDir || typeof GRDir.sanitizeDirectory !== 'function') die('control/directory-core.js did not load (is this the whole Greenroom folder?)');
  return GRDir;
}

// A minimal subscribed SB client: resolves once Subscribe is acked OK. `waitCustom`
// resolves with the first General.Custom `data` matching pred (or rejects on
// timeout); `doAction` fires and returns its request id; `waitAck` waits for that id's reply.
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
      wait(ackWaiters, CONNECT_MS, (m) => m.id === subId, 'Subscribe ack').then((ack) => {
        clearTimeout(timer);
        if (ack.status && ack.status !== 'ok') {
          rejectConn(new Error(`Streamer.bot refused the Subscribe (${ack.error || ack.status}). If its WebSocket Server has Authentication on and enforced, turn Enforce off: this tool does not authenticate.`));
          return;
        }
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

// Ask Streamer.bot for the saved config. Resolves { kind: 'state', state, oldWire } | { kind: 'empty' } | { kind: 'error', message }
// | { kind: 'silent' } (nothing came back). A refused or missing action is fatal, with the server's own words.
async function readCurrent(sb) {
  const replyP = sb.waitCustom((d) => stateOf(d) || (d && (d.type === 'vdo:sync:empty' || d.type === 'vdo:error')), REPLY_MS, 'vdoninja:update replay').catch(() => null);
  const id = sb.doAction('VDO Sync', { reason: 'backup' });
  const ack = await sb.waitAck(id, REPLY_MS, 'VDO Sync ack').catch(() => null);
  if (!ack) die('Streamer.bot did not acknowledge the "VDO Sync" action.');
  if (ack.status && ack.status !== 'ok') die(`Streamer.bot refused the "VDO Sync" action: ${ack.error || ack.status}. Is an action named exactly "VDO Sync" present (and compiled)?`);
  const d = await replyP;
  if (!d) return { kind: 'silent' };
  if (d.type === 'vdo:sync:empty') return { kind: 'empty' };
  if (d.type === 'vdo:error') return { kind: 'error', message: d.message || '(no message)' };
  return { kind: 'state', state: stateOf(d), oldWire: d.vdoninjaJson === undefined };
}

// A temp file next to the target, flushed, then renamed over it: a crash never leaves half a snapshot.
async function writeAtomic(out, text) {
  await mkdir(dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  try {
    const fh = await open(tmp, 'w');
    try { await fh.writeFile(text, 'utf-8'); await fh.sync(); } finally { await fh.close(); }
    await rename(tmp, out);
  } catch (e) { await rm(tmp, { force: true }).catch(() => {}); throw e; }
}
const envelopeText = (state) => JSON.stringify({ kind: 'greenroom-vdo-backup', savedAt: new Date().toISOString(), vdoninja: state }, null, 2) + '\n';

// ── save ────────────────────────────────────────────────────────────────────────────────────────
async function save(file) {
  const out = file ? resolveOut(file) : resolve(BACKUP_DIR, `vdo-state-${tsName()}.json`);
  if (file && existsSync(out) && !FORCE) die(`${out} already exists; pass --force to overwrite it (through npm: npm run backup -- ${file} --force).${process.env.npm_config_force === 'true' ? ' npm took a --force for itself: flags go after the --.' : ''}`);
  console.log(`target: ${URL_ARG}`);
  const sb = await connect(URL_ARG);
  try {
    const cur = await readCurrent(sb);
    if (cur.kind === 'empty') die('Streamer.bot has no vdo.state saved yet — nothing to back up. Open the control page and set a room or add a guest first (it pushes on the first edit).');
    if (cur.kind === 'error') {
      // Streamer.bot's own date parse can refuse to broadcast a state (an old VDO Sync pastes it into the frame as an object).
      const dateHint = /DateTime/i.test(cur.message)
        ? ' This is the old broadcast format failing on a date-shaped name in your saved config; the saved config itself is intact. Carry on with the update, then back up again afterwards (the new actions send it unchanged).'
        : '';
      die(`the "VDO Sync" action reported an error: ${cur.message}.${dateHint}`);
    }
    if (cur.kind === 'silent') die('Streamer.bot sent no vdo.state back. Either nothing is saved yet (open the control page and set a room or add a guest first; it pushes on the first edit), or the "VDO Sync" action is not answering (check that it exists and that its C# compiled).');
    await writeAtomic(out, envelopeText(cur.state));
    console.log(`saved ${out}`);
    console.log(`  ${summarize(cur.state)}`);
    console.log('  (contains the room password — keep this file private)');
    if (cur.oldWire) {
      console.log('  note: this copy came through the OLD broadcast format, in which Streamer.bot re-formats any guest label or name that looks like a date or time.');
      console.log('        If you have such names, take a fresh backup after re-pasting the three state actions: that one is exact.');
    }
  } finally { sb.close(); }
}

// ── restore ─────────────────────────────────────────────────────────────────────────────────────
function resolveOut(p) { return isAbsolute(p) ? p : resolve(process.env.INIT_CWD || process.cwd(), p); }
function resolveIn(p) {
  const direct = resolveOut(p);
  if (existsSync(direct) || isAbsolute(p)) return direct;
  // npm starts scripts in the package root but exports where you typed the command as INIT_CWD: a path relative to either works,
  // the README's backups/<file> form works from any folder, and a bare name is also looked up in the snapshot folder.
  const tries = [resolve(__dirname, p)];
  const m = /^backups[\\/](.+)$/.exec(p);
  if (m) tries.push(resolve(BACKUP_DIR, m[1]));
  if (!/[\\/]/.test(p)) tries.push(resolve(BACKUP_DIR, p));
  return tries.find((t) => existsSync(t)) || direct;
}

// Bytes → text: UTF-8 (BOM stripped), UTF-16 LE or BE by BOM (Notepad and PowerShell write these).
function decodeSnapshot(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder('utf-8').decode(buf.subarray(3));
  return new TextDecoder('utf-8').decode(buf);
}

// Check a snapshot the way the control page checks an import. Returns { payload } or { problem }.
function checkSnapshot(parsed) {
  if (!isPlain(parsed)) return { problem: 'that file is not a Greenroom vdo backup (expected a JSON object).' };
  let payload;
  if (parsed.kind === 'greenroom-vdo-backup') {
    payload = parsed.vdoninja;
  } else if ('kind' in parsed) {
    return { problem: `that is a different kind of file ("kind": ${JSON.stringify(parsed.kind)}), not a Greenroom config backup.` };
  } else if (FORCE) {
    payload = isPlain(parsed.vdoninja) ? parsed.vdoninja : parsed; // --force: a raw vdo.state payload, or an envelope without a kind
  } else {
    return { problem: 'that file is not a Greenroom vdo backup (no "kind": "greenroom-vdo-backup"). Pass --force if it really is a raw vdo.state payload.' };
  }
  if (!isPlain(payload)) return { problem: 'the backup holds no vdo.state object.' };
  if (typeof payload.room !== 'string') return { problem: 'the room in that file is not text, so it cannot be a Greenroom config.' };
  if (!Array.isArray(payload.slots)) return { problem: 'that file has no slots list — it does not look like a vdo.state snapshot.' };
  if (!Array.isArray(payload.directory)) return { problem: 'that file has no directory list — it does not look like a vdo.state snapshot.' };
  const sv = Number(payload.schemaVersion);
  if (Number.isFinite(sv) && sv > SUPPORTED_SCHEMA) return { problem: `that file comes from a newer Greenroom (schemaVersion ${sv}) than this tool understands (${SUPPORTED_SCHEMA}). Update Greenroom first.` };
  const badSlot = payload.slots.findIndex((x) => !isPlain(x));
  if (badSlot !== -1) return { problem: `slot entry ${badSlot + 1} is not an object, so the page would drop or mangle it. Fix the file.` };
  // A Discord ID is 17-19 digits: JSON.parse rounds it when it is written as a number, so the digits are already wrong.
  const asNumber = (list) => list.some((x) => isPlain(x) && typeof x.discordUserId === 'number');
  if (asNumber(payload.directory) || asNumber(payload.slots)) {
    return { problem: 'that file stores a Discord user ID as a number, which has already lost digits. Edit the file so each ID is in quotes ("discordUserId": "123..."), or save the snapshot again.' };
  }
  const dir = loadDirectoryCore().sanitizeDirectory(payload.directory);
  // A snapshot without viewFlags (older, or hand-made) would give the overlay no flags at all: restore the default ones.
  const withFlags = typeof payload.viewFlags === 'string' ? payload : { ...payload, viewFlags: DEFAULT_VIEWFLAGS };
  return { payload: { ...withFlags, directory: dir }, dropped: payload.directory.length - dir.length };
}

async function restore(file) {
  const path = resolveIn(file);
  let buf;
  try { buf = await readFile(path); } catch (e) { return die(`could not read ${path}: ${e.message}`); }
  let parsed;
  try { parsed = JSON.parse(decodeSnapshot(buf)); }
  catch (e) {
    const odd = (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) || buf.includes(0);
    // V8 quotes a piece of the text in "Unexpected token …, "<snippet>" is not valid JSON": it may hold the room password, so keep only the kind of error.
    const msg = String(e.message).replace(/^Unexpected token[\s\S]*is not valid JSON$/, 'an unexpected character (not valid JSON)').replace(/"[^"]*"/g, '"…"').replace(/'[^']*'/g, "'…'");
    return die(`could not parse ${path}: ${msg}${odd ? ' (the file looks like UTF-16 or has stray bytes: re-save it as UTF-8)' : ''}`);
  }
  const checked = checkSnapshot(parsed);
  if (checked.problem) return die(`${path}: ${checked.problem} Nothing was changed.`);
  // The file is pushed as a NEW write (control/vdo-rev.js): stamped with the time as its rev and this tool as its writer, so the pages
  // adopt it over what they hold (a file's own, older rev would be dropped as a stale replay), and with the slots' stream IDs blanked:
  // they were true when the file was saved, not now, and the designated director puts the live ones back within two polls.
  const { rev: _r, writer: _w, schemaVersion: _s, ...rest } = checked.payload;
  const payload = { ...rest, slots: checked.payload.slots.map((s) => ({ ...s, streamID: '' })), schemaVersion: SUPPORTED_SCHEMA, rev: Date.now(), writer: 'backup' };

  console.log(`target: ${URL_ARG}`);
  const sb = await connect(URL_ARG);
  try {
    const cur = await readCurrent(sb);
    const curLine = cur.kind === 'state' ? summarize(cur.state)
      : cur.kind === 'empty' ? 'nothing saved yet'
      : cur.kind === 'error' ? `unreadable (Streamer.bot reported: ${cur.message})`
      : 'no answer from VDO Sync';
    console.log(`  current: ${curLine}`);
    console.log(`  file:    ${summarize(payload)}${checked.dropped ? `  (${checked.dropped} directory entr${checked.dropped === 1 ? 'y' : 'ies'} dropped: no name, or no label and no Discord ID)` : ''}`);
    const unreadable = cur.kind === 'silent' || cur.kind === 'error';
    if (unreadable) {
      console.log('  NOTE: the current config cannot be read, so no copy of it can be saved before it is replaced.');
      if (!FORCE) {
        return die((cur.kind === 'silent'
          ? 'Streamer.bot sent nothing back for VDO Sync. Check that "VDO Sync" exists and compiled.'
          : `VDO Sync reported an error (${cur.message}).`)
          + ' Pass --force to restore anyway, without a copy of the current config. Nothing was changed.', 2);
      }
    }
    if (!YES) {
      console.log('  This would REPLACE the saved config with the file. Nothing was changed.');
      console.log('  Run again with --yes to do it:  node backup.mjs restore <file> --yes');
      console.log('  (through npm the flag goes after a --:  npm run backup:restore -- <file> --yes)');
      if (process.env.npm_config_yes === 'true') console.log('  npm took a --yes for itself (npm_config_yes is set), so it never reached this tool: write it after the --.');
      process.exit(2);
    }
    if (cur.kind === 'state') {
      const pre = resolve(BACKUP_DIR, `pre-restore-${tsName()}.json`);
      await writeAtomic(pre, envelopeText(cur.state));
      console.log(`  saved the current config first: ${pre}`);
      if (cur.oldWire) console.log('  (that copy came through the OLD broadcast format, in which Streamer.bot re-formats date-shaped guest names; it may not be exact)');
    } else console.log('  (no current config could be saved first)');

    // Arm both waiters BEFORE the push, so neither the ack nor the rebroadcast can be missed.
    const echoP = sb.waitCustom((d) => (stateOf(d) && sameState(stateOf(d), payload)) || (d && d.type === 'vdo:error'), REPLY_MS, 'the rebroadcast').catch(() => null);
    const id = sb.doAction('VDO Push', { payload: JSON.stringify(payload) });
    const ack = await sb.waitAck(id, REPLY_MS, 'VDO Push ack').catch(() => null);
    if (!ack) die('Streamer.bot did not acknowledge the VDO Push. The config was NOT confirmed restored.', 2);
    if (ack.status && ack.status !== 'ok') die(`Streamer.bot refused the VDO Push: ${ack.error || ack.status}. The config was NOT restored.`, 2);
    let seen = await echoP;
    if (seen && seen.type === 'vdo:error') {
      die(`the "VDO Push" action reported an error: ${seen.message || '(no message)'}. NOT confirmed: the config may or may not have been saved (an action older than the string-field ones saves first and then fails to broadcast it). Check the dock, or take a backup and compare.`, 2);
    }
    if (!seen) {
      // No matching rebroadcast: read it back instead.
      const again = await readCurrent(sb);
      if (again.kind === 'state' && sameState(again.state, payload)) seen = again;
    }
    if (!seen) {
      die('the push was acknowledged, but Streamer.bot did not confirm it: no matching rebroadcast and the saved config does not match the file. '
        + 'Check that the "VDO Push" action exists and compiled. (If your config has names that look like dates and the actions are not updated yet, Streamer.bot re-formats them in the old broadcast format.) NOT confirmed restored.', 2);
    }
    console.log(`restored ${path}`);
    console.log(`  Streamer.bot now holds: ${summarize(payload)}`);
    console.log('  Open overlays and control pages receive it as a broadcast; reload a control page that still shows the old config before you edit anything in it.');
  } finally { sb.close(); }
}

// ── list ────────────────────────────────────────────────────────────────────────────────────────
async function list() {
  const label = process.env.GREENROOM_BACKUP_DIR ? BACKUP_DIR.replace(/[\\/]+$/, '') : 'backups';
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
  for (const r of rows) console.log(`  ${label}/${r.n}  (${r.size} bytes)`);
}

// ── Entry ───────────────────────────────────────────────────────────────────────────────────────
try {
  if (cmd === 'save') await save(positional[0]);
  else if (cmd === 'restore') await restore(positional[0]);
  else if (cmd === 'list') await list();
  process.exit(0);
} catch (e) {
  die(e && e.message ? e.message : String(e));
}
