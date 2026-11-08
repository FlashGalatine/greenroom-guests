// Compile-and-run check of the C# actions (npm run verify:cs).
//
// verify.mjs can only grep the actions' source and run their JavaScript twins (the mock). This
// compiles the REAL action files, as shipped, with the .NET Framework C# compiler (csc.exe, present on
// any Windows PC with .NET Framework 4.x) and runs them against a stub of Streamer.bot's CPH:
//   1. every action compiles against mscorlib ONLY, a stricter set than Streamer.bot's default
//      references, so an action that compiles here compiles in Streamer.bot's editor;
//   2. what each action broadcasts and caches, and in what order, is checked frame by frame;
//   3. the push actions' strict JSON-object validator is fuzzed against JSON.parse.
// It skips (exit 0) when csc.exe is not found. Optional environment:
//   GREENROOM_CSC                  path to csc.exe
//   GREENROOM_NEWTONSOFT_DLL       Streamer.bot's Newtonsoft.Json.dll (from its install folder): frames are then
//                                  parsed and re-serialised the way Streamer.bot's WebsocketBroadcastJson does it
//   GREENROOM_PRIVATE_LABELS       a JSON file with an array of guest labels the maintainer keeps out of the repo
//                                  (the out-of-range values that make Newtonsoft throw); run through every path
// Never touches a Streamer.bot: the stub is the whole host.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fuzzRows } from './tools/cs-harness/fuzz.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const check = (n, ok, d) => { ok ? passed++ : failed++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d ? ' — ' + d : ''}`); };

const CSC = [process.env.GREENROOM_CSC, 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe']
  .filter(Boolean).find((p) => existsSync(p));
if (!CSC) {
  console.log('verify:cs skipped: csc.exe (the .NET Framework 4.x C# compiler) was not found. Set GREENROOM_CSC to its path to run it.');
  process.exit(0);
}
const NEWTONSOFT_DLL = process.env.GREENROOM_NEWTONSOFT_DLL && existsSync(process.env.GREENROOM_NEWTONSOFT_DLL) ? process.env.GREENROOM_NEWTONSOFT_DLL : '';
let PRIVATE_LABELS = [];
if (process.env.GREENROOM_PRIVATE_LABELS && existsSync(process.env.GREENROOM_PRIVATE_LABELS)) {
  try { PRIVATE_LABELS = JSON.parse(readFileSync(process.env.GREENROOM_PRIVATE_LABELS, 'utf8')).filter((x) => typeof x === 'string'); } catch {}
}

const ACTIONS = [['vdo-push', 'Act_VdoPush'], ['vdo-sync', 'Act_VdoSync'], ['discord-voice-push', 'Act_DiscordVoicePush']];
const HARNESS = resolve(__dirname, 'tools', 'cs-harness');
const tmp = mkdtempSync(join(tmpdir(), 'greenroom-cs-'));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const jp = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

// The action is a bare `public class CPHInline`; Streamer.bot injects `CPH`. Give each its own namespace and the stub's base.
function wrap(file, ns) {
  const src = readFileSync(resolve(__dirname, 'actions', file + '.cs'), 'utf8').replace(/\r\n/g, '\n');
  const i = src.indexOf('public class CPHInline');
  if (i < 0) throw new Error(file + ': no CPHInline class');
  const out = resolve(tmp, ns + '.cs');
  writeFileSync(out, src.slice(0, i) + `namespace ${ns}\n{\n` + src.slice(i).replace('public class CPHInline', 'public class CPHInline : Harness.CPHBase') + '\n}\n');
  return out;
}
function csc(args) {
  const r = spawnSync(CSC, ['/nologo', ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

let child, buf = '', waiter = null;
function sendRaw(line) { child.stdin.write(line + '\n'); }
function onData(d) {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (waiter) waiter(l); }
}
// Sends a command and collects reply lines up to its terminator (END for RUN, otherwise the single reply line).
function cmd(line, until) {
  return new Promise((res, rej) => {
    const lines = [];
    const timer = setTimeout(() => { waiter = null; rej(new Error('harness timeout on: ' + line.slice(0, 60))); }, 120000);
    waiter = (l) => {
      lines.push(l);
      if (until ? until(l) : true) { clearTimeout(timer); waiter = null; res(lines); }
    };
    sendRaw(line);
  });
}
// Runs one action and parses the reply.
async function run(action, { args = {}, vars = [], throwOn = '', newtonsoft = false } = {}) {
  await cmd('RESET');
  for (const [k, v] of Object.entries(args)) await cmd(`ARG ${k} ${b64(v)}`);
  for (const [persisted, name, v] of vars) await cmd(`SETVAR ${persisted ? 1 : 0} ${name} ${b64(v)}`);
  await cmd('THROW ' + throwOn);
  await cmd('NEWTONSOFT ' + (newtonsoft ? 1 : 0));
  const lines = await cmd('RUN ' + action, (l) => l === 'END');
  const r = { result: null, threw: null, frames: [], vars: {}, trace: [] };
  for (const l of lines) {
    if (l.startsWith('RESULT ')) r.result = l.slice(7) === 'true';
    else if (l.startsWith('THREW ')) r.threw = l.slice(6);
    else if (l.startsWith('FRAME ')) r.frames.push(unb64(l.slice(6)));
    else if (l.startsWith('VAR ')) { const [, p, name, v] = l.split(' '); r.vars[name] = unb64(v || ''); r.vars['@' + name] = p === '1'; }
    else if (l.startsWith('TRACE ')) r.trace = l.slice(6) ? l.slice(6).split(',') : [];
  }
  r.json = r.frames.map((f) => { try { return JSON.parse(f); } catch { return null; } });
  return r;
}
const orderOf = (trace, a, b) => trace.indexOf(a) >= 0 && trace.indexOf(b) >= 0 && trace.indexOf(a) < trace.indexOf(b);

const VDO = { enabled: true, room: 'testroom', password: 'p"w\\d', viewFlags: '&solo&cleanish',
  slots: [{ slot: 1, label: 'ALPHA', streamID: 'aaa111', mirror: false, mode: 'webcam', discordUserId: '' }],
  invite: { passwordMode: 'hash' }, directory: [{ vdoLabel: 'ALPHA', discordUserId: '', displayName: 'Alpha "the" Prime 😀\ttab</script>', socials: [{ platform: 'twitch', handle: 'AlphaTV' }] }],
  directoryAutoAdd: true, directoryIgnored: [] };
const DISC = { channelId: '222', connected: true, hostInChannel: true, users: { '111': { username: 'Ashe', speaking: true } }, settings: { accent: 'cyan' } };
const VDO_TXT = JSON.stringify(VDO), DISC_TXT = JSON.stringify(DISC);
// A date-shaped label that Newtonsoft would rewrite when it parses the frame (benign: it is only re-formatted).
const withLabel = (label) => JSON.stringify({ ...VDO, slots: [{ ...VDO.slots[0], label }], directory: [{ ...VDO.directory[0], vdoLabel: label, displayName: label }] });
const REWRITTEN_LABELS = ['2024-02-03T04:05:06.000Z', '2024-02-03T04:05:06+02:00', '/Date(1700000000000)/'];

async function main() {
  console.log('Greenroom — C# actions: compile and run\n');
  try {
    // ── 1. compile ────────────────────────────────────────────────────────────
    console.log('[1] compile: the shipped actions against mscorlib only, then with the harness');
    const wrapped = ACTIONS.map(([f, ns]) => wrap(f, ns));
    const dir = dirname(CSC);
    const stubOnly = csc(['/noconfig', '/nostdlib+', `/r:${join(dir, 'mscorlib.dll')}`, '/target:library', `/out:${join(tmp, 'actions-only.dll')}`, resolve(HARNESS, 'Stub.cs'), ...wrapped]);
    check('all three actions compile against mscorlib alone (a stricter set than Streamer.bot gives an Execute C# Code sub-action)', stubOnly.ok, stubOnly.out.slice(0, 600));
    const exe = join(tmp, 'harness.exe');
    const extra = NEWTONSOFT_DLL ? [`/r:${NEWTONSOFT_DLL}`, '/define:NEWTONSOFT'] : [];
    if (NEWTONSOFT_DLL) copyFileSync(NEWTONSOFT_DLL, join(tmp, 'Newtonsoft.Json.dll'));
    const build = csc(['/target:exe', `/out:${exe}`, ...extra, resolve(HARNESS, 'Stub.cs'), resolve(HARNESS, 'Driver.cs'), ...wrapped]);
    check('the run harness builds', build.ok, build.out.slice(0, 600));
    if (!stubOnly.ok || !build.ok) return;

    child = spawn(exe, [], { cwd: tmp, stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    const caps = (await cmd('CAPS'))[0];
    const hasNewtonsoft = /newtonsoft=1/.test(caps);
    console.log(`  (Newtonsoft round trip ${hasNewtonsoft ? 'ON' : 'off: set GREENROOM_NEWTONSOFT_DLL to enable'}; ${PRIVATE_LABELS.length} private label(s))`);

    // ── 2. VDO Push ─────────────────────────────────────────────────────────────
    console.log('\n[2] VDO Push: the state travels as an escaped string field, broadcast before it is cached');
    let r = await run('vdo-push', { args: { payload: VDO_TXT } });
    check('a valid payload: returns true, one frame, vdoninja:update with vdoninjaJson (a string) and no vdoninja object',
      r.result === true && r.frames.length === 1 && r.json[0] && r.json[0].type === 'vdoninja:update' && typeof r.json[0].vdoninjaJson === 'string' && !('vdoninja' in r.json[0]), JSON.stringify(r.frames).slice(0, 160));
    check('…the string field is byte-identical to the payload, and the payload is cached unchanged',
      !!r.json[0] && r.json[0].vdoninjaJson === VDO_TXT && r.vars['vdo.state'] === VDO_TXT && r.vars['@vdo.state'] === true);
    check('…the frame round-trips through a JSON parser to the same object (quotes, backslashes, tabs, emoji, </script>)',
      !!r.json[0] && JSON.stringify(jp(r.json[0].vdoninjaJson)) === JSON.stringify(VDO));
    check('…the broadcast happens BEFORE the cache write (a failed broadcast never persists state)', orderOf(r.trace, 'Broadcast', 'Set:vdo.state'), r.trace.join(','));
    r = await run('vdo-push', { args: { payload: VDO_TXT }, throwOn: 'first' });
    check('a broadcast that throws leaves vdo.state unset and reports the error', r.result === false && !('vdo.state' in r.vars) && r.json.some((j) => j && j.type === 'vdo:error'),
      `result=${r.result} vars=${Object.keys(r.vars)} frames=${r.frames.length}`);
    r = await run('vdo-push', { args: {} });
    check('no payload: returns false with a vdo:error frame and caches nothing', r.result === false && !('vdo.state' in r.vars) && r.json.some((j) => j && j.type === 'vdo:error'));
    if (hasNewtonsoft) {
      for (const label of REWRITTEN_LABELS) {
        const payload = withLabel(label);
        r = await run('vdo-push', { args: { payload }, newtonsoft: true });
        check(`through Newtonsoft's parse and re-serialise, a guest label of ${label} survives byte-identical`,
          r.result === true && r.json[0] && r.json[0].vdoninjaJson === payload && r.vars['vdo.state'] === payload, JSON.stringify(r.frames).slice(0, 200));
      }
      for (const label of PRIVATE_LABELS) {
        const payload = withLabel(label);
        r = await run('vdo-push', { args: { payload }, newtonsoft: true });
        check('a private out-of-range label does not make the broadcast throw: cached, byte-identical',
          r.result === true && !r.trace.some((t) => /newtonsoft-throws/.test(t)) && r.json[0] && r.json[0].vdoninjaJson === payload && r.vars['vdo.state'] === payload);
      }
    }

    // ── 3. Discord Voice Push ───────────────────────────────────────────────────
    console.log('\n[3] Discord Voice Push');
    r = await run('discord-voice-push', { args: { payload: DISC_TXT } });
    check('a valid payload: discord:voice:update with discordVoiceJson (a string, byte-identical) and no discordVoice object',
      r.result === true && r.frames.length === 1 && r.json[0] && r.json[0].type === 'discord:voice:update' && r.json[0].discordVoiceJson === DISC_TXT && !('discordVoice' in r.json[0]), JSON.stringify(r.frames).slice(0, 160));
    check('…cached in the NON-persisted store, after the broadcast', r.vars['discord.state'] === DISC_TXT && r.vars['@discord.state'] === false && orderOf(r.trace, 'Broadcast', 'Set:discord.state'), r.trace.join(','));
    r = await run('discord-voice-push', { args: { payload: DISC_TXT }, throwOn: 'first' });
    check('a broadcast that throws caches nothing and reports discord:voice:error', r.result === false && !('discord.state' in r.vars) && r.json.some((j) => j && j.type === 'discord:voice:error'));

    // ── 4. VDO Sync ─────────────────────────────────────────────────────────────
    console.log('\n[4] VDO Sync: each replay is its own try; an empty cache says so');
    r = await run('vdo-sync', { vars: [[true, 'vdo.state', VDO_TXT], [false, 'discord.state', DISC_TXT]] });
    const upd = r.json.find((j) => j && j.type === 'vdoninja:update'), dis = r.json.find((j) => j && j.type === 'discord:voice:update');
    check('both caches are replayed as string fields, byte-identical (in either order)',
      r.result === true && !!upd && upd.vdoninjaJson === VDO_TXT && !('vdoninja' in upd) && !!dis && dis.discordVoiceJson === DISC_TXT && !('discordVoice' in dis), JSON.stringify(r.frames).slice(0, 200));
    check('…and the caches are left exactly as they were', r.vars['vdo.state'] === VDO_TXT && r.vars['discord.state'] === DISC_TXT);
    r = await run('vdo-sync', { vars: [[false, 'discord.state', DISC_TXT]] });
    check('an empty vdo.state broadcasts {"type":"vdo:sync:empty"} (a fresh install is told so), and the Discord replay still goes out',
      r.json.some((j) => j && j.type === 'vdo:sync:empty') && r.json.some((j) => j && j.type === 'discord:voice:update'), JSON.stringify(r.frames).slice(0, 200));
    r = await run('vdo-sync', {});
    check('both caches empty: only the empty marker', r.result === true && r.frames.length === 1 && !!r.json[0] && r.json[0].type === 'vdo:sync:empty', JSON.stringify(r.frames));
    r = await run('vdo-sync', { vars: [[true, 'vdo.state', VDO_TXT], [false, 'discord.state', DISC_TXT]], throwOn: 'first' });
    check('one replay that fails does not stop the other (separate try blocks): the Discord replay is still sent',
      r.json.some((j) => j && j.type === 'discord:voice:update') && r.json.some((j) => j && j.type === 'vdo:error'), JSON.stringify(r.frames).slice(0, 220));
    if (hasNewtonsoft) {
      for (const label of REWRITTEN_LABELS) {
        const payload = withLabel(label);
        r = await run('vdo-sync', { vars: [[true, 'vdo.state', payload]], newtonsoft: true });
        check(`the replay of a cached label of ${label} survives Newtonsoft byte-identical (no rewrite, no echo loop)`,
          !!r.json[0] && r.json[0].vdoninjaJson === payload && r.vars['vdo.state'] === payload, JSON.stringify(r.frames).slice(0, 200));
      }
      for (const label of PRIVATE_LABELS) {
        const payload = withLabel(label);
        r = await run('vdo-sync', { vars: [[true, 'vdo.state', payload], [false, 'discord.state', DISC_TXT]], newtonsoft: true });
        check('a cached private out-of-range label is replayed (no throw) and the Discord replay still goes out',
          !r.trace.some((t) => /newtonsoft-throws/.test(t)) && r.json.some((j) => j && j.vdoninjaJson === payload) && r.json.some((j) => j && j.type === 'discord:voice:update'));
      }
    }

    // ── 5. the strict validator (GRN-07) ───────────────────────────────────────────
    console.log('\n[5] strict JSON-object validator in the push actions');
    const SPLICES = ['{not json}', '{"enabled":true,"room":"evil"},"type":"x"}', '{"enabled":true,"room":"evil"},"type":"x","pad":{}', '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '[1,2]', '"x"'];
    for (const [action, name, cache, errType] of [['vdo-push', 'VDO Push', 'vdo.state', 'vdo:error'], ['discord-voice-push', 'Discord Voice Push', 'discord.state', 'discord:voice:error']]) {
      for (const bad of SPLICES) {
        r = await run(action, { args: { payload: bad }, vars: [[action === 'vdo-push', cache, action === 'vdo-push' ? VDO_TXT : DISC_TXT]] });
        const prior = action === 'vdo-push' ? VDO_TXT : DISC_TXT;
        check(`${name}: rejects ${bad.length > 44 ? bad.slice(0, 44) + '…' : bad}: not cached (the earlier state stays), an error frame, no update frame`,
          r.result === false && r.vars[cache] === prior && r.json.some((j) => j && j.type === errType && /rejected, NOT cached/.test(j.message || ''))
          && !r.json.some((j) => j && /update$/.test(j.type || '')), JSON.stringify(r.frames).slice(0, 200));
      }
    }
    const rows = fuzzRows();
    const file = join(tmp, 'fuzz.tsv');
    writeFileSync(file, rows.map((x) => x.exp + '\t' + b64(x.s)).join('\n') + '\n');
    await cmd('FUZZ ' + file, (l) => /^FUZZED|^ERR/.test(l));
    const got = readFileSync(file + '.result', 'utf8');
    const mism = [];
    rows.forEach((x, i) => { if (got[i] !== x.exp) mism.push({ i, exp: x.exp, got: got[i], s: x.s.slice(0, 80) }); });
    check(`the validator agrees with JSON.parse (+ top-level object, no duplicate keys, depth 32) on ${rows.length} fuzz cases`, mism.length === 0,
      `${mism.length} mismatches, first: ${JSON.stringify(mism[0])}`);
    for (const label of ['\u0000', '\u001f', '\\u12G4']) {
      // sanity of the harness itself: a payload with a raw control character is invalid JSON
      r = await run('vdo-push', { args: { payload: `{"a":"x${label}y"}` } });
      check(`rejects a raw/invalid string escape (${JSON.stringify(label)})`, r.result === false && !('vdo.state' in r.vars));
    }
    r = await run('vdo-sync', { vars: [[true, 'vdo.state', SPLICES[1]], [false, 'discord.state', DISC_TXT]] });
    check('Sync with a corrupt cached vdo.state: vdo:error ("cached state is not valid JSON"), the cache is KEPT, the Discord replay still goes out',
      r.json.some((j) => j && j.type === 'vdo:error' && /not valid JSON/.test(j.message || '')) && r.vars['vdo.state'] === SPLICES[1] && r.json.some((j) => j && j.type === 'discord:voice:update'), JSON.stringify(r.frames).slice(0, 220));
    r = await run('vdo-sync', { vars: [[true, 'vdo.state', VDO_TXT], [false, 'discord.state', SPLICES[0]]] });
    check('Sync with a corrupt cached discord.state: discord:voice:error, the cache is KEPT, the vdo replay still goes out',
      r.json.some((j) => j && j.type === 'discord:voice:error' && /not valid JSON/.test(j.message || '')) && r.vars['discord.state'] === SPLICES[0] && r.json.some((j) => j && j.type === 'vdoninja:update')
      && !r.trace.some((t) => /^Unset:/.test(t)), JSON.stringify(r.frames).slice(0, 220));
  } finally {
    try { child && child.kill(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { try { child && child.kill(); } catch {} try { rmSync(tmp, { recursive: true, force: true }); } catch {} console.log('\n  ERROR ' + ((e && e.stack) || e)); process.exit(1); });
