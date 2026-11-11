// Mutation runner for the verify suites.  npm run mutation -- [--check] [--only=M01,M18] [--jobs=4] [--repeat=3] [--out=<file>] [--keep]
//
// Each mutant (tools/mutation/mutants.mjs) is one literal patch: `from` (a snippet that must occur exactly once in `file`) becomes `to`, a
// small bug. The runner applies it to a COPY of the repository (never to this checkout), runs the suites named by the mutant's `suite`
// ('v' = npm run verify; 'r' = verify:render, then verify if that passed; 'c' = verify:cs, then verify) and records:
//   KILLED    a suite printed a failing check (the first failing check is kept; `text: true` when it is a TRIPWIRE: a comparison of source text, not
//             behaviour; with --confirm=1 a kill is run a second time and must fail again, otherwise it is FLAKY)
//   SURVIVED  every suite passed with the bug in: a missing test, or an equivalent mutant (read `note`, then classify it by hand)
//   ERROR     a suite exited with a failure but never printed a failing check (it crashed or could not start): NOT a kill
//   SKIPPED   the C# suite did not run (no C# compiler on this machine): not a survival either
//   TIMEOUT   a suite did not finish in time
//   BADPATCH  `from` is not in the file exactly once: the code moved on, so the mutant has to be re-expressed
// A run stops at the first failing check (the rest of the suite cannot change the verdict) and the whole process tree is killed.
// Safety: the copies never hold the per-install files (the bot token, the saved voice config, backups, atomic-write leftovers), run on their own
// ports (never Streamer.bot's 7474/8080 or the bridge's 749x block) with an allowlisted environment, and link this checkout's node_modules;
// the mutated files exist only in the copies. Before a full run the suites are run once WITHOUT a mutant (the baseline): a suite that is not
// green on its own would turn every mutant into a "kill".
//
//   --check        only test that every patch applies and the mutated file still parses; runs nothing
//   --only=        run just these ids (comma separated)
//   --jobs=N       N copies in parallel (default 3); each one runs a suite at a time, so N verify runs (and N browsers) are alive at once. Several
//                  copies at once load the machine: a timing-sensitive check can fail under load, so read a kill by an unrelated check with suspicion
//                  and re-run it with fewer copies and --confirm=1
//   --repeat=N     run each chosen mutant N times (a repeatable kill needs N kills: `--only=M18 --repeat=5`)
//   --out=FILE     append one JSON line per result to FILE (default: <tmp>/greenroom-mutation/results.jsonl)
//   --skip=FILE    do not run the mutants that FILE (a results file of an earlier run) already settles (KILLED or SURVIVED)
//   --confirm=0    do not run a kill a second time (halves the cost of a kill)
//   --baseline=0|1 run the suites once without a mutant first (default: yes when more than five mutants are chosen); a red baseline stops the run
//   --port-base=N  the first port of the copies (default 24000; each copy uses a block of 300 from there): a second run at the same time needs its own
//   --keep         do not delete the copies afterwards

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { MUTANTS } from './mutants.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const a = argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`)); return a === undefined ? dflt : (a.includes('=') ? a.slice(a.indexOf('=') + 1) : true); };
const CHECK = !!opt('check', false);
const ONLY = String(opt('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const JOBS = Math.max(1, Number(opt('jobs', 3)) || 3);
const REPEAT = Math.max(1, Number(opt('repeat', 1)) || 1);
const KEEP = !!opt('keep', false);
const CONFIRM = String(opt('confirm', '1')) !== '0';
const SKIP_FILE = String(opt('skip', ''));
const PORT_BASE = Number(opt('port-base', 24000)) || 24000;
const WORK = mkdirSync(join(tmpdir(), 'greenroom-mutation'), { recursive: true }) || join(tmpdir(), 'greenroom-mutation');
const OUT = String(opt('out', join(WORK, 'results.jsonl')));
const TIMEOUT = { verify: 25 * 60_000, render: 60 * 60_000, cs: 5 * 60_000 };
// What a suite process may see of this shell (the same allowlist as verify.mjs): nothing exported there can steer it at a live Streamer.bot,
// a live bridge or a real token file.
const ENV_KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'LANG', 'LC_ALL', 'TZ', 'GREENROOM_CSC', 'GREENROOM_NEWTONSOFT_DLL'];
// The per-install files that must never be copied: the bot token, the saved voice config, the room-password snapshots, atomic-write leftovers.
const PER_INSTALL = /[\\/](sidecar[\\/]discord-(tokens|voice-config)\.json|vdo-state-[^\\/]*\.json|[^\\/]*\.tmp|[^\\/]*\.corrupt-[^\\/]*)$/;

const readText = (f) => readFileSync(f, 'utf8');
function apply(m, text) {
  const crlf = text.includes('\r\n');
  const norm = (s) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));
  const parts = text.split(norm(m.from));
  if (!m.from || parts.length !== 2) return { error: `BADPATCH (matches: ${parts.length - 1})` };
  if (m.from === m.to) return { error: 'NOOP' };
  return { text: parts.join(norm(m.to)) };
}
function parses(file, text) {
  try {
    if (/\.mjs$/.test(file)) { const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: text, encoding: 'utf8' }); return r.status === 0 ? null : (r.stderr || '').split('\n')[0]; }
    if (/\.js$/.test(file)) { new vm.Script(text); return null; }
    if (/\.html$/.test(file)) {
      for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) { if (/\bsrc\s*=/.test(m[1]) || /type\s*=\s*["']?(?!module|text\/javascript)/i.test(m[1])) continue; new vm.Script(m[2]); }
    }
    return null;
  } catch (e) { return String(e.message).slice(0, 160); }
}

const settled = new Set();
if (SKIP_FILE && existsSync(SKIP_FILE)) {
  for (const line of readText(SKIP_FILE).split('\n').filter(Boolean)) { try { const r = JSON.parse(line); if (r.status === 'KILLED' || r.status === 'SURVIVED') settled.add(r.id); } catch { /* a torn line */ } }
}
const todo = MUTANTS.filter((m) => !m.skip && (!ONLY.length || ONLY.includes(m.id)) && !settled.has(m.id));
if (CHECK) {
  let bad = 0;
  for (const m of todo) {
    const p = join(ROOT, m.file);
    if (!existsSync(p)) { console.log(m.id, 'BADPATCH file missing', m.file); bad++; continue; }
    const r = apply(m, readText(p));
    const syn = r.error ? null : parses(m.file, r.text);
    console.log(m.id, r.error || (syn ? 'SYNTAX ' + syn : 'ok'));
    if (r.error || syn) bad++;
  }
  console.log(bad ? `${bad} of ${todo.length} mutants need re-expressing` : `all ${todo.length} mutants apply`);
  process.exit(bad ? 1 : 0);
}

// ── copies ────────────────────────────────────────────────────────────────────
const SESSION = mkdtempSync(join(WORK, 'run-'));
const slots = [];
const portFree = (port) => new Promise((res) => { const s = createServer(); s.once('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))); });
async function makeSlot(k) {
  const base = PORT_BASE + k * 300; // HTTP, WS, +10 the guard ports, +100 and +101 the exit-on-close mock: nothing near 7474, 8080 or 749x
  for (const p of [base, base + 1, base + 10, base + 11, base + 12, base + 100, base + 101]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use (another run of this harness, or another program): pick another block with --port-base=<n>`);
  }
  const dir = join(SESSION, 'c' + k);
  cpSync(ROOT, dir, { recursive: true, filter: (p) => !/[\\/](node_modules|\.git|backups)([\\/]|$)/.test(p) && !/[\\/]\.verify-/.test(p) && !PER_INSTALL.test(p) });
  for (const nm of ['node_modules', join('sidecar', 'node_modules')]) if (existsSync(join(ROOT, nm))) symlinkSync(join(ROOT, nm), join(dir, nm), 'junction');
  const env = {};
  for (const key of ENV_KEEP) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { k, dir, env: { ...env, SB_HTTP_PORT: String(base), SB_WS_PORT: String(base + 1), VERIFY_GUARD_BASE: String(base + 10) } };
}
function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
}

// One suite run in a copy: resolves {code, fails, out, ms, timedOut}. Stops at the first failing check.
function runSuite(slot, script, kind) {
  return new Promise((res) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [script], { cwd: slot.dir, env: slot.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let out = '', buf = '', done = false;
    const fails = [];
    const finish = (code, timedOut) => { if (done) return; done = true; clearTimeout(timer); res({ code, fails, out: out.slice(-1500), ms: Date.now() - t0, timedOut: !!timedOut }); };
    const feed = (d) => {
      out += d; buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = /^\s+(FAIL|ERROR)\s+(.*)$/.exec(line);
        if (m) { fails.push(m[2].slice(0, 160)); killTree(child.pid); finish(1); return; }
      }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', feed); child.stderr.on('data', feed);
    child.on('exit', (code) => finish(code));
    const timer = setTimeout(() => { killTree(child.pid); finish(1, true); }, TIMEOUT[kind]);
  });
}
// The suite that is likelier to kill goes first (a page mutant: the render suite; a C# mutant: verify:cs, which takes seconds), so the long
// run is only paid when the short one does not settle it. The verdict (killed by something, or survived all) does not depend on the order.
const SUITES = { v: [['verify.mjs', 'verify']], r: [['verify-render.mjs', 'render'], ['verify.mjs', 'verify']], c: [['verify-cs.mjs', 'cs'], ['verify.mjs', 'verify']] };

async function oneRun(slot, m) {
  for (const [script, kind] of SUITES[m.suite || 'v']) {
    const r = await runSuite(slot, script, kind);
    if (r.timedOut) return { status: 'TIMEOUT', by: kind, fails: [], ms: r.ms };
    if (kind === 'cs' && r.code === 0 && /verify:cs skipped/i.test(r.out)) return { status: 'SKIPPED', by: kind, fails: [], detail: 'the C# compiler was not found, so the C# suite did not run' };
    if (r.code !== 0) {
      // only a printed failing check is a kill: a crash or a suite that could not start says nothing about the mutant
      if (!r.fails.length) return { status: 'ERROR', by: kind, fails: [], detail: (r.out.split('\n').filter(Boolean).slice(-1)[0] || 'exit ' + r.code).slice(0, 200), ms: r.ms };
      return { status: 'KILLED', by: kind, fails: r.fails, text: /^TRIPWIRE\b/.test(r.fails[0]), ms: r.ms };
    }
  }
  return { status: 'SURVIVED' };
}

async function worker(slot, queue) {
  for (;;) {
    const m = queue.shift();
    if (!m) return;
    const file = join(slot.dir, m.file);
    const pristine = readText(file); // the copy's own text (restored after every mutant), never this checkout's, which may have changed since
    const r = apply(m, pristine);
    let rec = { id: m.id, area: m.area, file: m.file, note: m.note, suite: m.suite || 'v' };
    if (r.error) rec = { ...rec, status: r.error.startsWith('BADPATCH') ? 'BADPATCH' : r.error, detail: r.error };
    else {
      writeFileSync(file, r.text);
      try {
        const t0 = Date.now();
        let run = await oneRun(slot, m);
        if (run.status === 'KILLED' && CONFIRM) {
          const again = await oneRun(slot, m); // a kill must reproduce
          run = again.status === 'KILLED' ? { ...run, confirmed: true } : { ...run, status: 'FLAKY', again: again.status };
        }
        rec = { ...rec, ...run, totalMs: Date.now() - t0 };
      } finally { writeFileSync(file, pristine); }
    }
    appendFileSync(OUT, JSON.stringify(rec) + '\n');
    console.log(`${m.id.padEnd(6)} ${rec.status.padEnd(9)} ${rec.by || ''} ${rec.text ? '[text] ' : ''}${(rec.fails || []).slice(0, 1).join('').slice(0, 100)}${rec.detail ? ' ' + rec.detail : ''}`);
  }
}

// The baseline: every suite the chosen mutants use, run once on an unmutated copy (in parallel on different copies). A red one stops the run.
async function baseline() {
  const need = [...new Set(todo.flatMap((m) => SUITES[m.suite || 'v']).map(([script, kind]) => script + '|' + kind))].map((x) => x.split('|'));
  console.log(`baseline: ${need.map((x) => x[1]).join(', ')} without a mutant`);
  let ok = true;
  for (let i = 0; i < need.length; i += slots.length) {
    const round = need.slice(i, i + slots.length);
    const results = await Promise.all(round.map(([script, kind], j) => runSuite(slots[j], script, kind).then((r) => ({ kind, r }))));
    for (const { kind, r } of results) {
      const good = !r.timedOut && r.code === 0 && !r.fails.length;
      appendFileSync(OUT, JSON.stringify({ id: 'BASELINE', suite: kind, status: good ? 'PASSED' : 'FAILED', fails: r.fails, ms: r.ms }) + '\n');
      console.log(`baseline ${kind}: ${good ? 'green' : 'NOT green: ' + (r.fails[0] || (r.timedOut ? 'timed out' : r.out.split('\n').filter(Boolean).slice(-1)[0] || 'exit ' + r.code))}`);
      if (!good) ok = false;
    }
  }
  return ok;
}

console.log(`mutation: ${todo.length} mutants x ${REPEAT}, up to ${Math.min(JOBS, todo.length * REPEAT)} copies, results -> ${OUT}`);
const queue = [];
for (let i = 0; i < REPEAT; i++) queue.push(...todo);
const n = Math.min(JOBS, queue.length);
let exitCode = 0;
try {
  for (let k = 0; k < n; k++) slots.push(await makeSlot(k));
  const wantBaseline = String(opt('baseline', todo.length > 5 ? '1' : '0')) !== '0';
  if (wantBaseline && !(await baseline())) { console.log('the baseline is not green: no mutant was run (a kill would mean nothing)'); exitCode = 2; }
  else await Promise.all(slots.map((s) => worker(s, queue)));
} finally {
  // best effort: a hidden child of a killed run may hold a folder for a moment; the results are already written, so a copy that cannot
  // be removed is reported (and can be deleted by hand), never an error
  if (!KEEP) { try { rmSync(SESSION, { recursive: true, force: true, maxRetries: 30, retryDelay: 300 }); } catch (e) { console.log(`left behind (remove it by hand): ${SESSION} (${e && e.code})`); } }
}
console.log('done');
process.exit(exitCode);
