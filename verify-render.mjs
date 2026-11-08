// Real-pixel verification — the render half that verify.mjs (protocol-only)
// deliberately skips. Runs the REAL pages in a real browser against the mock SB
// server, with the director iframe pointed at mock-vdo-director.html so the whole
// enumeration → resolution → push → overlay loop runs offline:
//
//   [R1] guest slot auto-follow: director-min.html hydrates from a seeded VDO Push,
//        polls the fake director, and the guest overlay's iframe swaps
//        view=aaa111 → about:blank (leave) → view=aaa333 (REJOIN with a new
//        streamID) with zero operator input. Every push must be sig-distinct.
//   [R2] discord-mode slot: PFP shows, .speaking glow toggles with the feed.
//   [R3] roster overlay: N avatars, streamer-first order, mute/deaf badges, name
//        labels (+ ?labels=0), hideWhenAbsent, grid layout.
//   [R4] 20-user burst @ 100 ms for 5 s (the doc-06 scale question): zero page
//        errors, member count stable, speaking classes actually mutate.
//   [R5] control.html: hydrates from the persisted cache, an edit fires a captured
//        VDO Push, USE on a favorite fires set-current, live status pill, and the
//        guest directory's collapsed rows / search filter / auto-populate loop
//        (live VDO label + voice user → placeholder entries, rename clears the
//        "auto" badge, remove records the ignore key and it stays gone).
//   [R6] nameplates: the standalone nameplate.html renders the directory entry
//        (name + socials), the rotator advances, an unmatched live guest stays
//        hidden, and ?nameplate=0 keeps the guest overlay plate-free. R1/R2 also
//        assert the guest overlay's built-in lower-third through the real
//        director loop (which doubles as the director-min strip-guard at runtime).
//
// Requires a Chromium channel on the machine (system Edge/Chrome):
//   npm install            (playwright-core is a pinned devDependency)
// External hosts (vdo.ninja, Discord CDN) are route-blocked — we assert iframe/img
// URL assembly and classes, never remote content. Screenshots (gitignored):
// roster-check.png, control-check.png, nameplate-check.png.

import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number(process.env.SB_HTTP_PORT) || 7476;
const WS_PORT = Number(process.env.SB_WS_PORT) || 8082;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const MOCK_DIRECTOR = `${BASE}/mock/vdo-director.html`;

let passed = 0, failed = 0;
const check = (n, ok, d) => { ok ? passed++ : failed++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d ? ' — ' + d : ''}`); };

// opts: { httpPort, wsPort, env } — extra mock instances (the R7 sync-guard
// scenarios) run on their own off-default ports with their own test options.
// Children get an ALLOWLISTED environment, never `...process.env`: a shell that exports SB_WS_URL, GREENROOM_* or
// DISCORD_BRIDGE_* must not be able to steer a harness child at a live Streamer.bot or a live sidecar. Everything a child
// needs beyond this list is passed explicitly.
const ENV_KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'LANG', 'LC_ALL', 'TZ'];
function cleanEnv(extra = {}) {
  const env = {};
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

function startChild(script, readyText, opts = {}) {
  return new Promise((res, rej) => {
    const wsPort = opts.wsPort || WS_PORT;
    const child = spawn(process.execPath, [script], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv({ SB_HTTP_PORT: String(opts.httpPort || HTTP_PORT), SB_WS_PORT: String(wsPort), SB_WS_URL: `ws://127.0.0.1:${wsPort}/`, ...(opts.env || {}) }),
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

async function launch() {
  for (const ch of ['msedge', 'chrome']) { try { return await chromium.launch({ channel: ch, headless: true }); } catch {} }
  return await chromium.launch({ headless: true });
}

// Pure producer: opens SB's WS and fires DoActions (what the control page and the
// sidecar are to SB). No subscribe — it never needs to hear anything back.
function producer(port = WS_PORT) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    let id = 0;
    ws.on('error', rej);
    ws.on('open', () => res({
      doAction(name, args) { ws.send(JSON.stringify({ request: 'DoAction', id: String(++id), action: { name }, args })); },
      close() { try { ws.close(); } catch {} },
    }));
  });
}

const VIEWFLAGS = '&solo&hidescreenshare&rounded=0&tallyoff&fadein&codec=h264&cleanish';
const STREAMER = '110457699291906048';
const slot = (n, extra) => Object.assign({ slot: n, label: '', streamID: '', mirror: false, mode: 'webcam', discordUserId: '' }, extra);

// Guest directory: 'alpha' is lowercase ON PURPOSE — the live label is 'ALPHA',
// proving the case-insensitive match. Guest One / BRAVO have no entry (the
// no-fallback rule).
const DIRECTORY = [
  { vdoLabel: 'alpha', discordUserId: '', displayName: 'Alpha Prime',
    socials: [{ platform: 'twitch', handle: 'AlphaPrimeTV' }, { platform: 'bluesky', handle: '@alpha.bsky' }] },
  { vdoLabel: '', discordUserId: STREAMER, displayName: 'Ashe of Outland',
    socials: [{ platform: 'twitch', handle: 'AsheTV' }] },
];
const SEED_VDO = {
  enabled: true, room: 'testroom', password: 'pw1', viewFlags: VIEWFLAGS,
  slots: [slot(1, { label: 'ALPHA' }), slot(2, { label: 'BRAVO' }), slot(3), slot(4)],
  invite: { passwordMode: 'hash' },
  directory: DIRECTORY,
};
const DISCORD_SLOT_VDO = {
  enabled: true, room: 'testroom', password: 'pw1', viewFlags: VIEWFLAGS,
  slots: [slot(1, { mode: 'discord', discordUserId: STREAMER }), slot(2, { label: 'BRAVO' }), slot(3), slot(4)],
  invite: { passwordMode: 'hash' },
  directory: DIRECTORY,
};
const embed = (n) => `https://cdn.discordapp.com/embed/avatars/${n}.png`;
const ROSTER_STATE = (patch) => JSON.stringify(Object.assign({
  channelId: '222', connected: true, hostInChannel: true,
  users: {
    [STREAMER]: { speaking: false, username: 'Ashe', avatarUrl: embed(1), mute: false, deaf: false },
    '200000000000000001': { speaking: false, username: 'Guest One', avatarUrl: embed(2), mute: true, deaf: false },
    '200000000000000002': { speaking: false, username: 'Guest Two', avatarUrl: embed(3), mute: false, deaf: true },
  },
  settings: { streamerUserId: STREAMER, avatarPx: 56, streamerPx: 72, accent: 'cyan', scanlines: true, neonBlink: true, hideWhenAbsent: true },
  rpc: { enabled: true, hasToken: true, error: null },
  favorites: [{ id: 'fav1', name: 'Main Hang', serverId: '111', channelId: '222' }],
  current: { serverId: '111', channelId: '222' },
}, patch || {}));

async function newPage(browser, viewport, withDirectorHook) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await page.route(/vdo\.ninja|discordapp\.com/, (r) => r.abort()); // offline-deterministic
  // withDirectorHook: true → the mock director on the main mock; a string → that URL
  if (withDirectorHook) await page.addInitScript(`window.__VDO_DIRECTOR_URL = ${JSON.stringify(typeof withDirectorHook === 'string' ? withDirectorHook : MOCK_DIRECTOR)};`);
  return page;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// One mock instance's HTTP surface (capture log, caches, restart, raw broadcast).
function mockApi(httpPort) {
  const u = (p) => `http://127.0.0.1:${httpPort}${p}`;
  return {
    base: u(''),
    actions: async () => (await (await fetch(u('/mock/actions'))).json()).actions,
    state: async () => (await fetch(u('/mock/state'))).json(),
    clear: () => fetch(u('/mock/actions?clear=1')).then((r) => r.arrayBuffer()),
    restart: (wipeVdo) => fetch(u('/mock/restart' + (wipeVdo ? '?vdo=1' : ''))).then((r) => r.arrayBuffer()),
    broadcast: (data) => fetch(u('/mock/broadcast'), { method: 'POST', body: JSON.stringify(data) }).then((r) => r.arrayBuffer()),
  };
}

const wait = (page, fn, arg, ms) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);

async function main() {
  console.log('Greenroom — real-pixel render verification\n');
  let mock, bridge, browser, prod;
  const extra = []; // the R7-R9 mock instances
  const extraProds = []; // their producers
  let scratch = null; // R9's temp dir (an exported config holds the room password)
  try {
    mock = await startChild('mock-sb-server.mjs', '[mock] READY');
    console.log(`mock SB up (:${HTTP_PORT} HTTP, :${WS_PORT} WS)\n`);
    browser = await launch();
    prod = await producer();

    // RENDER_ONLY=conn runs just the connection scenarios (R10+), skipping R1-R9.
    const ONLY = process.env.RENDER_ONLY || '';
    // RENDER_ONLY=labels runs just the guest-label scenarios (R11, R12); RENDER_ONLY=roster just R13.
    if (ONLY && ONLY !== 'conn' && ONLY !== 'labels' && ONLY !== 'roster') throw new Error(`RENDER_ONLY=${ONLY}: the supported values are 'conn', 'labels' and 'roster' (or leave it unset)`);
    // Free, OS-assigned ports: never a fixed one that another tool on the PC may hold.
    const freePort = () => new Promise((res, rej) => {
      const s = createNetServer();
      s.on('error', rej);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
    // A port can be taken between freePort() closing it and the mock binding it, so retry
    // with fresh ports; the two ports must also differ.
    const startExtra = async (env) => {
      let lastErr;
      for (let attempt = 0; attempt < 4; attempt++) {
        const httpPort = await freePort();
        let wsPort = await freePort();
        while (wsPort === httpPort) wsPort = await freePort();
        let m, prod;
        try {
          m = await startChild('mock-sb-server.mjs', '[mock] READY', { httpPort, wsPort, env });
          prod = await producer(wsPort);
        } catch (e) { lastErr = e; if (m) { try { m.kill(); } catch {} } continue; }
        extra.push(m);
        extraProds.push(prod);
        return { api: mockApi(httpPort), prod, proc: m, http: httpPort, ws: wsPort };
      }
      throw lastErr;
    };
    const pushesOf = (acts) => acts.filter((a) => a.name === 'VDO Push');
    const MSG_REPLACE = /has not returned your saved config/;

    if (!ONLY) {
    // ── R1: guest slot auto-follow through the REAL production loop ────────────
    console.log('[R1] guest slot: webcam URL assembly + leave + REJOIN swap (auto-follow)');
    const guestPage = await newPage(browser, { width: 640, height: 360 });
    await guestPage.goto(`${BASE}/overlay/vdoninja-guest.html?slot=1&sbport=${WS_PORT}`, { waitUntil: 'load' });

    prod.doAction('VDO Push', { payload: JSON.stringify(SEED_VDO) });
    await fetch(`${BASE}/mock/actions?clear=1`);

    const directorPage = await newPage(browser, { width: 400, height: 200 }, true);
    await directorPage.goto(`${BASE}/control/director-min.html?sbport=${WS_PORT}`, { waitUntil: 'load' });

    const gotAlpha = await wait(guestPage, () => {
      const src = document.getElementById('frame')?.getAttribute('src') || '';
      return src.includes('view=aaa111') && src.includes('room=testroom') && src.includes('password=pw1') && src.includes('&solo');
    }, null, 15000);
    check('slot 1 iframe assembles the ALPHA view URL (room+password+viewFlags)', gotAlpha,
      await guestPage.evaluate(() => document.getElementById('frame')?.getAttribute('src')));

    // The resolving push came from director-min's own re-assembly, so this also
    // proves it carries the directory through (the strip guard) at runtime.
    const plateShown = await wait(guestPage, () => {
      const p = document.querySelector('.np-plate');
      return p && !p.hidden && p.querySelector('.np-name')?.textContent === 'Alpha Prime'
        && (p.querySelector('.np-rot')?.textContent || '').includes('AlphaPrimeTV');
    }, null, 8000);
    check('lower-third renders from the directory (case-insensitive label match)', plateShown,
      await guestPage.evaluate(() => document.querySelector('.np-plate')?.outerHTML?.slice(0, 200)));

    const wentBlank = await wait(guestPage, () => (document.getElementById('frame')?.getAttribute('src') || '') === 'about:blank', null, 15000);
    check('ALPHA leaves → slot 1 blanks (no stale view URL)', wentBlank,
      await guestPage.evaluate(() => document.getElementById('frame')?.getAttribute('src')));
    const plateHid = await wait(guestPage, () => document.querySelector('.np-plate')?.hidden === true, null, 6000);
    check('guest left → nameplate hides with the slot', plateHid);

    const swapped = await wait(guestPage, () => (document.getElementById('frame')?.getAttribute('src') || '').includes('view=aaa333'), null, 20000);
    check('ALPHA REJOINS with a new streamID → slot 1 auto-follows to aaa333', swapped,
      await guestPage.evaluate(() => document.getElementById('frame')?.getAttribute('src')));
    const plateBack = await wait(guestPage, () => document.querySelector('.np-plate')?.hidden === false, null, 6000);
    check('rejoin → nameplate re-shows', plateBack);

    const log1 = await (await fetch(`${BASE}/mock/actions`)).json();
    const pushes = log1.actions.filter((a) => a.name === 'VDO Push').map((a) => a.args && a.args.payload);
    check('every director push is signature-distinct (dedupe holds at 2.5s polls)',
      pushes.length >= 2 && new Set(pushes).size === pushes.length, `${pushes.length} pushes, ${new Set(pushes).size} unique`);

    await directorPage.close(); // one-director rule: control.html takes over in R5

    // ── R2: discord-mode slot — PFP + speaking glow ─────────────────────────────
    console.log('\n[R2] guest slot: discord mode PFP + speaking glow toggle');
    prod.doAction('VDO Push', { payload: JSON.stringify(DISCORD_SLOT_VDO) });
    prod.doAction('Discord Voice Push', { payload: ROSTER_STATE() });
    const pfpShown = await wait(guestPage, () => {
      const d = document.getElementById('dpfp');
      const img = d && d.querySelector('img');
      return d && !d.hidden && img && (img.getAttribute('src') || '').includes('embed/avatars');
    }, null, 8000);
    check('discord mode: iframe blanked, PFP visible with avatar URL', pfpShown,
      await guestPage.evaluate(() => document.getElementById('dpfp')?.querySelector('img')?.getAttribute('src')));

    const discPlate = await wait(guestPage, () => {
      const p = document.querySelector('.np-plate');
      return p && !p.hidden && p.querySelector('.np-name')?.textContent === 'Ashe of Outland';
    }, null, 6000);
    check('discord-mode slot renders the directory nameplate (userId match)', discPlate);

    const talking = JSON.parse(ROSTER_STATE());
    talking.users[STREAMER].speaking = true;
    prod.doAction('Discord Voice Push', { payload: JSON.stringify(talking) });
    const glowOn = await wait(guestPage, () => document.getElementById('dpfp')?.classList.contains('speaking'), null, 6000);
    check('speaking=true → glow class ON', glowOn);
    prod.doAction('Discord Voice Push', { payload: ROSTER_STATE() });
    const glowOff = await wait(guestPage, () => !document.getElementById('dpfp')?.classList.contains('speaking'), null, 6000);
    check('speaking=false → glow class OFF', glowOff);
    await guestPage.close();

    // ── R3: roster overlay — order, badges, labels, hideWhenAbsent, grid ────────
    console.log('\n[R3] roster overlay: members, streamer-first, badges, labels, absent, grid');
    const rosterPage = await newPage(browser, { width: 900, height: 240 });
    await rosterPage.goto(`${BASE}/overlay/discord-roster.html?layout=row&sbport=${WS_PORT}`, { waitUntil: 'load' });
    prod.doAction('Discord Voice Push', { payload: ROSTER_STATE() });
    const members = await wait(rosterPage, () => document.querySelectorAll('#roster .member').length === 3, null, 8000);
    check('renders 3 members', members, await rosterPage.evaluate(() => document.querySelectorAll('#roster .member').length));
    const order = await rosterPage.evaluate(() => [...document.querySelectorAll('#roster .member')].map((m) => m.dataset.uid));
    check('streamer-first ordering', order[0] === STREAMER, order.join(','));
    const badges = await rosterPage.evaluate(() => ({
      mute: document.querySelector('.member[data-uid="200000000000000001"]')?.classList.contains('muted'),
      deaf: document.querySelector('.member[data-uid="200000000000000002"]')?.classList.contains('deafened'),
      muteBadgeShown: getComputedStyle(document.querySelector('.member[data-uid="200000000000000001"] .badge.mute')).display !== 'none',
      deafBadgeShown: getComputedStyle(document.querySelector('.member[data-uid="200000000000000002"] .badge.deaf')).display !== 'none',
    }));
    check('mute + deaf badges shown on the right members', badges.mute && badges.deaf && badges.muteBadgeShown && badges.deafBadgeShown, JSON.stringify(badges));
    // The sync replay carries DISCORD_SLOT_VDO.directory, so the streamer's chip
    // is labeled with the directory override, not the live Discord name.
    const label = await rosterPage.evaluate(() => document.querySelector(`.member[data-uid="${'110457699291906048'}"] .name`)?.textContent);
    check("directory override labels the streamer chip ('Ashe of Outland')", label === 'Ashe of Outland', label);
    const rawLabel = await rosterPage.evaluate(() => document.querySelector('.member[data-uid="200000000000000001"] .name')?.textContent);
    check("no directory entry → live username ('Guest One')", rawLabel === 'Guest One', rawLabel);
    await rosterPage.screenshot({ path: resolve(__dirname, 'roster-check.png') });

    const noLabels = await newPage(browser, { width: 900, height: 240 });
    await noLabels.goto(`${BASE}/overlay/discord-roster.html?labels=0&sbport=${WS_PORT}`, { waitUntil: 'load' });
    prod.doAction('VDO Sync', { reason: 'render-test' });
    const labelsOff = await wait(noLabels, () => document.querySelectorAll('#roster .member').length === 3
      && getComputedStyle(document.querySelector('.member .name')).display === 'none', null, 8000);
    check('?labels=0 hides names', labelsOff);
    await noLabels.close();

    prod.doAction('Discord Voice Push', { payload: ROSTER_STATE({ hostInChannel: false }) });
    const hidden = await wait(rosterPage, () => getComputedStyle(document.getElementById('stage')).display === 'none', null, 6000);
    check('hideWhenAbsent: streamer leaves → overlay hides', hidden);
    prod.doAction('Discord Voice Push', { payload: ROSTER_STATE() });

    const gridPage = await newPage(browser, { width: 640, height: 480 });
    await gridPage.goto(`${BASE}/overlay/discord-roster.html?layout=grid&labels=0&sbport=${WS_PORT}`, { waitUntil: 'load' });
    const gridOk = await wait(gridPage, () => document.getElementById('roster')?.classList.contains('layout-grid')
      && document.querySelectorAll('#roster .member').length === 3, null, 8000);
    check('?layout=grid renders the wrapping panel', gridOk);

    // ── R4: 20-user burst @100 ms — the doc-06 scale question, offline ──────────
    console.log('\n[R4] burst: 20 users, 100 ms speaking churn for 5 s');
    bridge = await startChild('mock-discord-bridge.mjs', '[mock-bridge] up');
    const pageErrors = [];
    gridPage.on('pageerror', (e) => pageErrors.push(String(e)));
    prod.doAction('Discord Voice Command', { command: 'mock-burst', value: 'on' });
    const burst20 = await wait(gridPage, () => document.querySelectorAll('#roster .member').length === 20, null, 8000);
    check('burst on → 20 members render', burst20, await gridPage.evaluate(() => document.querySelectorAll('#roster .member').length));

    const samples = [];
    for (let i = 0; i < 10; i++) {
      samples.push(await gridPage.evaluate(() => document.querySelectorAll('#roster .member.speaking').length));
      await new Promise((r) => setTimeout(r, 500));
    }
    check('speaking classes churn under load', new Set(samples).size > 1, samples.join(','));
    const still20 = await gridPage.evaluate(() => document.querySelectorAll('#roster .member').length);
    check('after 5 s @ ~10 pushes/s: no page errors, member count stable', pageErrors.length === 0 && still20 === 20,
      `${pageErrors.length} errors, ${still20} members: ${pageErrors[0] || ''}`);
    prod.doAction('Discord Voice Command', { command: 'mock-burst', value: 'off' });
    await gridPage.close();

    // ── R5: control page — hydrate, edit→push, USE favorite, status pill ────────
    console.log('\n[R5] control page: hydrate from cache, edit → VDO Push, USE → set-current');
    const ctrlPage = await newPage(browser, { width: 920, height: 1300 }, true);
    await ctrlPage.goto(`${BASE}/control/control.html?sbport=${WS_PORT}`, { waitUntil: 'load' });
    const hydrated = await wait(ctrlPage, () => document.getElementById('vdoRoom')?.value === 'testroom', null, 8000);
    check('hydrates room from the persisted vdo.state (VDO Sync replay)', hydrated,
      await ctrlPage.evaluate(() => document.getElementById('vdoRoom')?.value));

    const slotSrc = await ctrlPage.evaluate(() => {
      const b = document.querySelector('.vdo-slot-row[data-slot="2"] .vdo-src-copy');
      const a = document.querySelector('.vdo-slot-row[data-slot="2"] .vdo-src-open');
      return { url: b && b.dataset.url, href: a && a.getAttribute('href') };
    });
    check('each slot row exposes Copy + Open for its OBS Browser Source URL (?slot=N)',
      !!slotSrc.url && /vdoninja-guest\.html\?slot=2/.test(slotSrc.url) && slotSrc.href === slotSrc.url, JSON.stringify(slotSrc));

    await fetch(`${BASE}/mock/actions?clear=1`);
    await ctrlPage.fill('#vdoViewFlags', '&solo&render-test');
    await ctrlPage.click('#btnVdoSave');
    let editPushed = false;
    for (let i = 0; i < 20 && !editPushed; i++) {
      const log = await (await fetch(`${BASE}/mock/actions`)).json();
      editPushed = log.actions.some((a) => {
        if (a.name !== 'VDO Push' || !a.args?.payload) return false;
        try { return JSON.parse(a.args.payload).viewFlags === '&solo&render-test'; } catch { return false; }
      });
      if (!editPushed) await new Promise((r) => setTimeout(r, 250));
    }
    check('editing viewFlags + Save fires a captured VDO Push with the edit', editPushed);

    const pill = await wait(ctrlPage, () => (document.getElementById('dvoStatus')?.textContent || '').includes('in voice'), null, 8000);
    check("status pill shows 'in voice · N present' from the bridge feed", pill,
      await ctrlPage.evaluate(() => document.getElementById('dvoStatus')?.textContent));

    const favShown = await wait(ctrlPage, () => document.querySelectorAll('#dvoFavorites .dvo-fav-item').length >= 1, null, 8000);
    check('favorites render from the bridge feed', favShown);
    await fetch(`${BASE}/mock/actions?clear=1`);
    await ctrlPage.click('#dvoFavorites .dvo-fav-item button[data-action="use"]');
    let useSent = false;
    for (let i = 0; i < 20 && !useSent; i++) {
      const log = await (await fetch(`${BASE}/mock/actions`)).json();
      useSent = log.actions.some((a) => a.name === 'Discord Voice Command' && a.args?.command === 'set-current');
      if (!useSent) await new Promise((r) => setTimeout(r, 250));
    }
    check('USE on a favorite fires Discord Voice Command set-current', useSent);

    // ── R5b: guest directory — collapsed rows, search, auto-populate, ignore ────
    // Live inputs at this point: the mock director's room (ALPHA + BRAVO) and the
    // mock bridge's channel (Ashe + Guest One + Guest Two). The seeded directory
    // knows 'alpha' and Ashe's id, so BRAVO / Guest One / Guest Two are the guests
    // auto-add has to invent placeholder names for.
    console.log('\n[R5b] guest directory: collapsed rows, search, auto-populate, remove→ignored');
    ctrlPage.on('dialog', (d) => d.accept()); // remove/clear confirms

    // The newest VDO Push whose payload satisfies pred (the control page pushes
    // continuously, so we poll the captured action log).
    const pushedPayload = async (pred, tries = 32) => {
      for (let i = 0; i < tries; i++) {
        const log = await (await fetch(`${BASE}/mock/actions`)).json();
        const hit = log.actions.filter((a) => a.name === 'VDO Push' && a.args && a.args.payload)
          .map((a) => { try { return JSON.parse(a.args.payload); } catch { return null; } })
          .filter(Boolean).reverse().find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 250));
      }
      return null;
    };
    // Rows are keyed by their directory index (the inputs carry live values, not
    // value= attributes, so CSS can't match on the name).
    const rowByName = async (name) => {
      const idx = await ctrlPage.evaluate((n) => {
        const row = [...document.querySelectorAll('.vdo-dir-row')]
          .find((r) => r.querySelector('input.vdo-dir-display')?.value === n);
        return row ? row.dataset.idx : null;
      }, name);
      return idx === null ? null : `.vdo-dir-row[data-idx="${idx}"]`;
    };

    const autoRow = await wait(ctrlPage, () => {
      const rows = [...document.querySelectorAll('.vdo-dir-row')];
      const bravo = rows.find((r) => r.querySelector('input.vdo-dir-display')?.value === 'BRAVO');
      const guest = rows.find((r) => r.querySelector('input.vdo-dir-display')?.value === 'Guest One');
      return !!bravo && !!bravo.querySelector('.dir-badge') && !!guest;
    }, null, 15000);
    check('auto-add: live VDO label + voice user become "auto"-badged rows', autoRow,
      await ctrlPage.evaluate(() => [...document.querySelectorAll('.vdo-dir-row input.vdo-dir-display')].map((i) => i.value).join(' | ')));

    const autoPushed = await pushedPayload((p) => Array.isArray(p.directory)
      && p.directory.some((e) => e.vdoLabel === 'BRAVO' && e.displayName === 'BRAVO' && e.auto === true)
      && p.directoryAutoAdd === true);
    check('auto-add pushes the placeholder entry (auto:true) with directoryAutoAdd', !!autoPushed);

    const collapsed = await ctrlPage.evaluate(() => {
      const row = document.querySelector('.vdo-dir-row');
      return { body: getComputedStyle(row.querySelector('.dir-body')).display,
        meta: !!row.querySelector('.dir-meta')?.textContent, dot: !!row.querySelector('.dir-dot') };
    });
    check('rows render collapsed (summary + live dot, editor hidden)',
      collapsed.body === 'none' && collapsed.meta && collapsed.dot, JSON.stringify(collapsed));

    await ctrlPage.click('.vdo-dir-row .dir-toggle');
    const expanded = await wait(ctrlPage, () => {
      const row = document.querySelector('.vdo-dir-row.open');
      return row && getComputedStyle(row.querySelector('.dir-body')).display !== 'none'
        && !!row.querySelector('input.vdo-dir-label') && !!row.querySelector('textarea.vdo-dir-socials');
    }, null, 5000);
    check('clicking a row expands its editor (label + Discord + socials fields)', expanded);

    const totalRows = await ctrlPage.evaluate(() => document.querySelectorAll('.vdo-dir-row').length);
    await ctrlPage.fill('#dirSearch', 'bravo');
    const searched = await wait(ctrlPage, () => {
      const rows = [...document.querySelectorAll('.vdo-dir-row')];
      return rows.length === 1 && rows[0].querySelector('input.vdo-dir-display')?.value === 'BRAVO';
    }, null, 5000);
    check(`search "bravo" filters ${totalRows} rows down to the one match`, searched,
      await ctrlPage.evaluate(() => document.querySelectorAll('.vdo-dir-row').length));
    await ctrlPage.fill('#dirSearch', '110457699291906048'); // by Discord ID
    const searchedById = await wait(ctrlPage, () => {
      const rows = [...document.querySelectorAll('.vdo-dir-row')];
      return rows.length === 1 && rows[0].querySelector('input.vdo-dir-display')?.value === 'Ashe of Outland';
    }, null, 5000);
    check('search by Discord ID finds the mapped guest', searchedById);
    await ctrlPage.fill('#dirSearch', '');
    const restored = await wait(ctrlPage, (n) => document.querySelectorAll('.vdo-dir-row').length === n, totalRows, 5000);
    check('clearing the search restores every row (filtered entries were never lost)', restored,
      await ctrlPage.evaluate(() => document.querySelectorAll('.vdo-dir-row').length));

    // Renaming an auto entry is how the operator takes ownership of the name.
    await fetch(`${BASE}/mock/actions?clear=1`);
    const bravoRow = await rowByName('BRAVO');
    await ctrlPage.fill(`${bravoRow} input.vdo-dir-display`, 'Bravo the Brave');
    await ctrlPage.locator(`${bravoRow} input.vdo-dir-display`).blur();
    const renamePushed = await pushedPayload((p) => (p.directory || [])
      .some((e) => e.vdoLabel === 'BRAVO' && e.displayName === 'Bravo the Brave' && e.auto === false));
    check('renaming an auto entry clears the auto flag on the wire', !!renamePushed);
    const badgeGone = await wait(ctrlPage, () => {
      const rows = [...document.querySelectorAll('.vdo-dir-row')];
      const r = rows.find((x) => x.querySelector('input.vdo-dir-display')?.value === 'Bravo the Brave');
      return !!r && !r.querySelector('.dir-badge');
    }, null, 8000);
    check('the "auto" badge disappears once the name is the operator\'s', badgeGone);

    // Removing a guest records the ignore key — and BRAVO is STILL live, so the
    // next auto-add pass is what would resurrect them if the guard didn't work.
    await fetch(`${BASE}/mock/actions?clear=1`);
    await ctrlPage.click(`${await rowByName('Bravo the Brave')} .vdo-dir-remove`);
    const removePushed = await pushedPayload((p) => Array.isArray(p.directoryIgnored)
      && p.directoryIgnored.includes('vdo:bravo')
      && !(p.directory || []).some((e) => e.vdoLabel === 'BRAVO'));
    check('removing a guest pushes the ignore key and drops the entry', !!removePushed,
      JSON.stringify((await pushedPayload(() => true) || {}).directoryIgnored));
    await new Promise((r) => setTimeout(r, 4000)); // ≥ one director poll + one push
    const stayedGone = await ctrlPage.evaluate(() => ![...document.querySelectorAll('.vdo-dir-row input.vdo-dir-display')]
      .some((i) => i.value === 'BRAVO' || i.value === 'Bravo the Brave'));
    check('the removed guest is NOT auto-added again while still live (ignore list holds)', stayedGone);

    const untickPushed = await (async () => {
      await fetch(`${BASE}/mock/actions?clear=1`);
      await ctrlPage.uncheck('#dirAutoAdd');
      return pushedPayload((p) => p.directoryAutoAdd === false);
    })();
    check('unticking "auto-add guests" pushes directoryAutoAdd:false', !!untickPushed);
    await ctrlPage.check('#dirAutoAdd');

    await ctrlPage.screenshot({ path: resolve(__dirname, 'control-check.png'), fullPage: true });
    await ctrlPage.close();

    // ── R6: nameplates — standalone page, rotator, no-fallback, hide toggle ─────
    // Control page is closed → no director runs, so the pushed state is
    // deterministic (pre-resolved streamIDs).
    console.log('\n[R6] nameplates: standalone page, rotator, unmatched → hidden, ?nameplate=0');
    const NAMEPLATE_VDO = { ...SEED_VDO,
      slots: [slot(1, { label: 'ALPHA', streamID: 'aaa111' }), slot(2, { label: 'BRAVO', streamID: 'bbb222' }), slot(3), slot(4)] };
    prod.doAction('VDO Push', { payload: JSON.stringify(NAMEPLATE_VDO) });

    const npPage = await newPage(browser, { width: 420, height: 120 });
    await npPage.goto(`${BASE}/overlay/nameplate.html?slot=1&sbport=${WS_PORT}`, { waitUntil: 'load' });
    const npShown = await wait(npPage, () => {
      const p = document.querySelector('.np-plate');
      return p && !p.hidden && p.querySelector('.np-name')?.textContent === 'Alpha Prime'
        && (p.querySelector('.np-rot')?.textContent || '').includes('AlphaPrimeTV');
    }, null, 8000);
    check('standalone nameplate renders name + first social', npShown,
      await npPage.evaluate(() => document.querySelector('.np-plate')?.outerHTML?.slice(0, 200)));
    const rotated = await wait(npPage, () => (document.querySelector('.np-rot')?.textContent || '').includes('@alpha.bsky'), null, 9000);
    check('social rotator advances to the second handle (5 s cycle)', rotated);
    await npPage.screenshot({ path: resolve(__dirname, 'nameplate-check.png') });
    await npPage.close();

    const npPage2 = await newPage(browser, { width: 420, height: 120 });
    await npPage2.goto(`${BASE}/overlay/nameplate.html?slot=2&sbport=${WS_PORT}`, { waitUntil: 'load' });
    await wait(npPage2, () => !!document.querySelector('.np-plate'), null, 4000);
    await new Promise((r) => setTimeout(r, 1200)); // let the sync replay land
    const npHidden = await npPage2.evaluate(() => document.querySelector('.np-plate')?.hidden === true);
    check('live but unmatched guest (BRAVO) → standalone nameplate stays hidden (no fallback)', npHidden);
    await npPage2.close();

    const gp0 = await newPage(browser, { width: 640, height: 360 });
    await gp0.goto(`${BASE}/overlay/vdoninja-guest.html?slot=1&nameplate=0&sbport=${WS_PORT}`, { waitUntil: 'load' });
    const gp0Rendering = await wait(gp0, () => (document.getElementById('frame')?.getAttribute('src') || '').includes('view=aaa111'), null, 8000);
    const gp0NoPlate = await gp0.evaluate(() => !document.querySelector('.np-plate'));
    check('?nameplate=0 → guest overlay renders video with NO plate ever created', gp0Rendering && gp0NoPlate);
    await gp0.close();

    // ── R7: sync guard — nothing is pushed before Streamer.bot returns the saved config ──
    // GRN-24 + GRN-154. Each scenario runs against its own mock instance with a test
    // option (slow Sync, empty cache, the empty marker), so the main mock's seeded
    // state is untouched. Seeds are written by a producer, like a real earlier session.
    console.log('\n[R7] sync guard: no automatic push before Streamer.bot returns the saved config');
    const SEED_SAVED = { enabled: false, room: 'seededroom', password: 'pw-seed', viewFlags: VIEWFLAGS,
      slots: [slot(1, { label: 'ALPHA' }), slot(2), slot(3), slot(4)], invite: { passwordMode: 'hash' },
      directory: [{ vdoLabel: 'alpha', discordUserId: '', displayName: 'Alpha Prime', socials: [] }] };

    // R7a: control.html, the first Sync reply is 6 s late.
    const slow = await startExtra({ SYNC_DELAY_MS: '9000' });
    slow.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_SAVED) });
    await sleep(300); await slow.api.clear();
    const dlgA = [];
    const pgA = await newPage(browser, { width: 920, height: 1300 });
    pgA.on('dialog', (d) => { dlgA.push(d.message()); d.dismiss(); }); // the operator answers "no"
    await pgA.goto(`${slow.api.base}/control/control.html?sbport=${slow.ws}`, { waitUntil: 'load' });
    await sleep(500); // inside the 1.2 s hydrate window
    await pgA.fill('#vdoRoom', 'typed-too-early');
    await pgA.click('#btnVdoSave');
    await sleep(1500); // t ≈ 2 s: past the hydrate timer, still no Sync reply
    slow.prod.doAction('Discord Voice Push', { payload: ROSTER_STATE() }); // a voice feed before the Sync
    const dlgAfterSave = dlgA.length;
    await pgA.check('.vdo-slot-row[data-slot="2"] input.vdo-mirror-cb'); // a slot edit before the saved config arrives
    await sleep(1100); // t ≈ 3.1 s
    const actA = await slow.api.actions();
    const stA = await slow.api.state();
    check('R7a: no VDO Push before the first Sync reply, even with a Discord feed after the 1.2 s timer',
      pushesOf(actA).length === 0, `${pushesOf(actA).length} push(es)`);
    check('R7a: vdo.state still holds the saved config', !!stA.vdo && stA.vdo.room === 'seededroom', JSON.stringify(stA.vdo && stA.vdo.room));
    check('R7a: Save inside the 1.2 s window asks once, and declined pushes nothing',
      dlgAfterSave === 1 && MSG_REPLACE.test(dlgA[0] || '') && pushesOf(actA).length === 0, JSON.stringify(dlgA));
    check('R7a: a slot edit before the Sync reply asks too, and declined leaves vdo.state unchanged',
      dlgA.length === 2 && MSG_REPLACE.test(dlgA[1] || '') && pushesOf(actA).length === 0 && !!stA.vdo && stA.vdo.room === 'seededroom', JSON.stringify(dlgA));
    check('R7a: VDO Sync is re-fired with backoff while unanswered (2+ requests by 3 s)',
      actA.filter((a) => a.name === 'VDO Sync').length >= 2, `${actA.filter((a) => a.name === 'VDO Sync').length} Sync request(s)`);
    const syncTxt1 = await pgA.evaluate(() => document.getElementById('syncStatus')?.textContent || '');
    check("R7a: the page says 'VDO Sync has not answered' once the 1.2 s timer fires", /VDO Sync has not answered/i.test(syncTxt1), syncTxt1);
    await sleep(2300); // t ≈ 5.4 s
    const syncTxt2 = await pgA.evaluate(() => document.getElementById('syncStatus')?.textContent || '');
    check('R7a: after about 5 s the status names both causes (fresh install, or VDO Sync missing/not compiled)',
      /fresh install/i.test(syncTxt2) && /not compiled/i.test(syncTxt2), syncTxt2);
    const adopted = await wait(pgA, () => document.getElementById('vdoRoom')?.value === 'seededroom', null, 16000);
    check('R7a: the late Sync reply is adopted (the saved room replaces the defaults)', adopted,
      await pgA.evaluate(() => document.getElementById('vdoRoom')?.value));
    const syncHidden = await wait(pgA, () => { const e = document.getElementById('syncStatus'); return !!e && e.hidden; }, null, 4000);
    check('R7a: the not-synced status clears once the saved config arrives', syncHidden);
    // The slot panel still had focus (the declined edit) when the saved config arrived. It must be
    // redrawn from that config, or the next slot edit reads the stale default rows from the DOM and
    // pushes them over the saved slots with no warning.
    const slotLabels = await pgA.evaluate(() => [...document.querySelectorAll('.vdo-slot-row select.vdo-label-sel')].map((s) => s.value));
    check('R7a: the slot panel shows the adopted slots (slot 1 = ALPHA), not the defaults it had at focus', slotLabels[0] === 'ALPHA', JSON.stringify(slotLabels));
    await pgA.uncheck('.vdo-slot-row[data-slot="2"] input.vdo-mirror-cb');
    await sleep(900);
    const stA2 = await slow.api.state();
    check('R7a: after the saved config arrives, a slot edit keeps the saved slots (it does not push the stale default rows)',
      !!stA2.vdo && Array.isArray(stA2.vdo.slots) && stA2.vdo.slots[0].label === 'ALPHA' && stA2.vdo.slots[1].mirror === false,
      JSON.stringify(stA2.vdo && stA2.vdo.slots && stA2.vdo.slots.map((s) => s.label)));
    await pgA.close();
    slow.prod.close();

    // R7f: the saved config arrives WHILE the not-synced confirm is open. The confirm blocks the
    // page, so the reply waits in its queue; answering yes must not then push the defaults over it.
    const race = await startExtra({ SYNC_DELAY_MS: '3500' });
    race.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_SAVED) });
    await sleep(300); await race.api.clear();
    const pgF = await newPage(browser, { width: 920, height: 1300 });
    pgF.on('dialog', async (d) => { await sleep(2800); await d.accept(); }); // yes, but only after the reply has come in
    await pgF.goto(`${race.api.base}/control/control.html?sbport=${race.ws}`, { waitUntil: 'load' });
    await sleep(1500);
    await pgF.fill('#vdoRoom', 'typed-during-race');
    const clickF = pgF.click('#btnVdoSave'); // the dialog opens at about 1.6 s and is answered at about 4.4 s
    await sleep(5200);
    await clickF.catch(() => {});
    const stF = await race.api.state();
    const pushedF = pushesOf(await race.api.actions());
    check('R7f: a Sync reply that arrives while the confirm is open wins: nothing is pushed over the saved config',
      pushedF.length === 0 && !!stF.vdo && stF.vdo.room === 'seededroom', `${pushedF.length} push(es), room ${JSON.stringify(stF.vdo && stF.vdo.room)}`);
    check('R7f: …and the page shows the saved room and says why nothing was pushed',
      await pgF.evaluate(() => document.getElementById('vdoRoom')?.value === 'seededroom' && /arrived/i.test(document.getElementById('cfgStatus')?.textContent || '')),
      await pgF.evaluate(() => document.getElementById('cfgStatus')?.textContent));
    await pgF.close();

    // R7b: director-min.html against a slow first Sync (the same cases as R7a). Its own
    // mock instance: R7a's delayed Sync replays must not land on this page.
    const slowMin = await startExtra({ SYNC_DELAY_MS: '9000' });
    slowMin.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_SAVED) });
    await sleep(300); await slowMin.api.clear();
    const pgB = await newPage(browser, { width: 480, height: 120 });
    await pgB.goto(`${slowMin.api.base}/control/director-min.html?sbport=${slowMin.ws}`, { waitUntil: 'load' });
    await sleep(2000);
    slowMin.prod.doAction('Discord Voice Push', { payload: ROSTER_STATE() });
    await sleep(1100); // t ≈ 3.1 s
    const actB = await slowMin.api.actions();
    check('R7b: director-min pushes nothing before the first Sync reply', pushesOf(actB).length === 0, `${pushesOf(actB).length} push(es)`);
    check('R7b: director-min re-fires VDO Sync with backoff while unanswered (2+ requests by 3 s)',
      actB.filter((a) => a.name === 'VDO Sync').length >= 2, `${actB.filter((a) => a.name === 'VDO Sync').length} Sync request(s)`);
    await sleep(2300); // t ≈ 5.4 s
    const minTxt = await pgB.evaluate(() => document.getElementById('status')?.textContent || '');
    check('R7b: director-min status names both causes after about 5 s', /fresh install/i.test(minTxt) && /not compiled/i.test(minTxt), minTxt);
    await pgB.close();
    slowMin.prod.close();

    // R7c: a fresh install (empty cache, nothing ever replies). Save asks once, then pushes.
    // (SB_EMPTY_MARKER=0: the action paste is an OLDER one, which never says that vdo.state is empty.)
    const fresh = await startExtra({ SB_EMPTY_MARKER: '0' });
    const dlgC = [];
    const pgC = await newPage(browser, { width: 920, height: 1300 }, true);
    pgC.on('dialog', (d) => { dlgC.push(d.message()); d.accept(); });
    await pgC.goto(`${fresh.api.base}/control/control.html?sbport=${fresh.ws}`, { waitUntil: 'load' });
    await sleep(1800);
    await pgC.fill('#vdoRoom', 'fresh-room');
    await pgC.fill('#vdoPassword', 'pw-fresh');
    await pgC.check('#vdoEnabled'); // an operator change: it asks (and pushes on yes) by itself
    await pgC.click('#btnVdoSave');
    let freshPush = null;
    for (let i = 0; i < 20 && !freshPush; i++) {
      freshPush = pushesOf(await fresh.api.actions()).map((a) => { try { return JSON.parse(a.args.payload); } catch { return null; } })
        .filter(Boolean).find((p) => p.room === 'fresh-room' && p.password === 'pw-fresh');
      if (!freshPush) await sleep(250);
    }
    check('R7c: a fresh install can still save: the first Save asks, and on yes pushes the typed config',
      dlgC.length >= 1 && MSG_REPLACE.test(dlgC[0] || '') && !!freshPush, JSON.stringify(dlgC));
    const freshSynced = await wait(pgC, () => { const e = document.getElementById('syncStatus'); return !!e && e.hidden; }, null, 5000);
    check("R7c: the page's own echo of that push marks it synced (status clears)", freshSynced);
    await pgC.close();
    fresh.prod.close();

    // R7d: the empty-cache marker (the actions broadcast it, and the mock does by default) is read as "synced".
    const marker = await startExtra({});
    const dlgD = [];
    const pgD = await newPage(browser, { width: 920, height: 1300 });
    pgD.on('dialog', (d) => { dlgD.push(d.message()); d.accept(); });
    await pgD.goto(`${marker.api.base}/control/control.html?sbport=${marker.ws}`, { waitUntil: 'load' });
    const markerSynced = await wait(pgD, () => { const e = document.getElementById('syncStatus'); return !!e && e.hidden; }, null, 5000);
    check("R7d: {type:'vdo:sync:empty'} marks the page synced with no config adopted", markerSynced);
    await pgD.fill('#vdoRoom', 'marker-room');
    await pgD.click('#btnVdoSave');
    let markerPush = null;
    for (let i = 0; i < 20 && !markerPush; i++) {
      markerPush = pushesOf(await marker.api.actions()).map((a) => { try { return JSON.parse(a.args.payload); } catch { return null; } })
        .filter(Boolean).find((p) => p.room === 'marker-room');
      if (!markerPush) await sleep(250);
    }
    check('R7d: once synced by the marker, Save pushes without asking', !!markerPush && dlgD.length === 0, JSON.stringify(dlgD));
    await pgD.close();
    marker.prod.close();

    // R7e: a matching fixed-roster director → zero pushes over 4+ polls, on both pages.
    await fresh.api.restart(true);
    const FIXED_DIR = `${MOCK_DIRECTOR}?fixed=1`;
    const SEED_FIXED = { enabled: true, room: 'fixedroom', password: 'pw1', viewFlags: VIEWFLAGS,
      slots: [slot(1, { label: 'ALPHA', streamID: 'aaa111' }), slot(2, { label: 'BRAVO', streamID: 'bbb222' }), slot(3), slot(4)],
      invite: { passwordMode: 'hash' },
      directory: [{ vdoLabel: 'ALPHA', discordUserId: '', displayName: 'Alpha', socials: [] },
        { vdoLabel: 'BRAVO', discordUserId: '', displayName: 'Bravo', socials: [] }] };
    const fixedProd = await producer(fresh.ws);
    fixedProd.doAction('VDO Push', { payload: JSON.stringify(SEED_FIXED) });
    await sleep(300);
    // The capture log is cleared BEFORE each page loads, so a push on the very first poll counts, and
    // each half also asserts that the fixed director really answered (two guests seen).
    await fresh.api.clear();
    const pgE1 = await newPage(browser, { width: 920, height: 1300 }, FIXED_DIR);
    await pgE1.goto(`${fresh.api.base}/control/control.html?sbport=${fresh.ws}`, { waitUntil: 'load' });
    const sawRoster1 = await wait(pgE1, () => /connected · 2 guests/.test(document.getElementById('vdoStatus')?.textContent || ''), null, 12000);
    await sleep(9500); // first probe at 1.5 s, then every 2.5 s: 4+ polls
    const quietControl = pushesOf(await fresh.api.actions()).length;
    check('R7e: control.html saw the fixed roster (2 guests) and made 0 VDO Push over 4+ polls', sawRoster1 && quietControl === 0, `${quietControl} push(es), roster seen: ${sawRoster1}`);
    await pgE1.close();
    await fresh.api.clear();
    const pgE2 = await newPage(browser, { width: 480, height: 120 }, FIXED_DIR);
    await pgE2.goto(`${fresh.api.base}/control/director-min.html?sbport=${fresh.ws}`, { waitUntil: 'load' });
    const sawRoster2 = await wait(pgE2, () => /2 guest\(s\)/.test(document.getElementById('status')?.textContent || ''), null, 12000);
    await sleep(9500);
    const quietMin = pushesOf(await fresh.api.actions()).length;
    check('R7e: director-min saw the fixed roster (2 guests) and made 0 VDO Push over 4+ polls', sawRoster2 && quietMin === 0, `${quietMin} push(es), roster seen: ${sawRoster2}`);
    await pgE2.close();
    fixedProd.close();

    // ── R8: the reader half of the wire change (GRN-108) and the date-shaped guard ──
    console.log('\n[R8] frames: string-field state is read, unusable frames are dropped, errors name the entry');
    // R8a: state arriving as vdoninjaJson (an escaped string), as the actions send it.
    const wire = await startExtra({});
    wire.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_SAVED) });
    await sleep(300);
    const pgW = await newPage(browser, { width: 920, height: 1300 });
    await pgW.goto(`${wire.api.base}/control/control.html?sbport=${wire.ws}`, { waitUntil: 'load' });
    const wireAdopted = await wait(pgW, () => document.getElementById('vdoRoom')?.value === 'seededroom', null, 8000);
    check('R8a: control.html adopts a vdoninja:update that carries vdoninjaJson (string field)', wireAdopted,
      await pgW.evaluate(() => document.getElementById('vdoRoom')?.value));
    const wireSynced = await wait(pgW, () => { const e = document.getElementById('syncStatus'); return !!e && e.hidden; }, null, 3000);
    check('R8a: …and counts as synced', wireSynced);
    const pgWm = await newPage(browser, { width: 480, height: 120 });
    await pgWm.goto(`${wire.api.base}/control/director-min.html?sbport=${wire.ws}`, { waitUntil: 'load' });
    const wireMin = await wait(pgWm, () => /director disabled/.test(document.getElementById('status')?.textContent || ''), null, 8000);
    check('R8a: director-min adopts it too (the saved config is disabled, so it says so)', wireMin,
      await pgWm.evaluate(() => document.getElementById('status')?.textContent));
    const wireSeen = await wire.api.state();
    check('R8a: the pages pushed nothing and vdo.state is intact',
      !!wireSeen.vdo && wireSeen.vdo.room === 'seededroom' && pushesOf(await wire.api.actions()).length === 1);
    // A raw subscriber sees the frame exactly as a page does: the state is a string field, and
    // the object field is absent. (Without this the checks above could pass on the old shape.)
    const rawFrame = await new Promise((res) => {
      const w = new WebSocket(`ws://127.0.0.1:${wire.ws}/`);
      const timer = setTimeout(() => { try { w.close(); } catch {} res(null); }, 6000);
      w.on('open', () => {
        w.send(JSON.stringify({ request: 'Subscribe', id: 'raw1', events: { general: ['Custom'] } }));
        setTimeout(() => wire.prod.doAction('VDO Sync', { reason: 'raw-check' }), 300);
      });
      w.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.event && m.event.type === 'Custom' && m.data && m.data.type === 'vdoninja:update') { clearTimeout(timer); try { w.close(); } catch {} res(m.data); }
      });
    });
    check('R8a: the mock really sends the string shape (vdoninjaJson is a string, no vdoninja object)',
      !!rawFrame && typeof rawFrame.vdoninjaJson === 'string' && !('vdoninja' in rawFrame) && JSON.parse(rawFrame.vdoninjaJson).room === 'seededroom', JSON.stringify(rawFrame));
    await pgW.close(); await pgWm.close(); wire.prod.close();

    // R8d: the same pages against the OLD wire (a nested vdoninja object, as an actions paste from before
    // the string fields sends it). An update reaches the pages before the actions are re-pasted, so this
    // has to keep working; the mock's object mode also reproduces Streamer.bot's date rewrite.
    const objW = await startExtra({ SB_WIRE: 'object' });
    objW.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_SAVED) });
    await sleep(300);
    const pgObjC = await newPage(browser, { width: 920, height: 1300 });
    await pgObjC.goto(`${objW.api.base}/control/control.html?sbport=${objW.ws}`, { waitUntil: 'load' });
    check('R8d: control.html adopts a vdoninja:update that carries a nested vdoninja object (the old wire), and counts as synced',
      await wait(pgObjC, () => document.getElementById('vdoRoom')?.value === 'seededroom', null, 8000)
        && await wait(pgObjC, () => { const e = document.getElementById('syncStatus'); return !!e && e.hidden; }, null, 3000),
      await pgObjC.evaluate(() => document.getElementById('vdoRoom')?.value));
    const pgObjM = await newPage(browser, { width: 480, height: 120 });
    await pgObjM.goto(`${objW.api.base}/control/director-min.html?sbport=${objW.ws}`, { waitUntil: 'load' });
    check('R8d: director-min adopts it too', await wait(pgObjM, () => /director disabled/.test(document.getElementById('status')?.textContent || ''), null, 8000),
      await pgObjM.evaluate(() => document.getElementById('status')?.textContent));
    const objRaw = await new Promise((res) => {
      const w = new WebSocket(`ws://127.0.0.1:${objW.ws}/`);
      const timer = setTimeout(() => { try { w.close(); } catch {} res(null); }, 6000);
      w.on('open', () => {
        w.send(JSON.stringify({ request: 'Subscribe', id: 'raw2', events: { general: ['Custom'] } }));
        setTimeout(() => objW.prod.doAction('VDO Sync', { reason: 'raw-check' }), 300);
      });
      w.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.event && m.event.type === 'Custom' && m.data && m.data.type === 'vdoninja:update') { clearTimeout(timer); try { w.close(); } catch {} res(m.data); }
      });
    });
    check('R8d: the mock really sends the old shape (a vdoninja object, no vdoninjaJson), and the pages pushed nothing of their own',
      !!objRaw && typeof objRaw.vdoninja === 'object' && !('vdoninjaJson' in objRaw) && objRaw.vdoninja.room === 'seededroom'
      && pushesOf(await objW.api.actions()).length === 1, JSON.stringify(objRaw).slice(0, 120));
    await pgObjC.close(); await pgObjM.close(); objW.prod.close();

    // R8b: frames with no usable state never mark a page synced and never cause a push.
    await fresh.api.restart(true); // an empty vdo.state, no marker: nothing will ever answer the Sync
    const badProd = await producer(fresh.ws);
    const pgX = await newPage(browser, { width: 920, height: 1300 });
    await pgX.goto(`${fresh.api.base}/control/control.html?sbport=${fresh.ws}`, { waitUntil: 'load' });
    const pgXm = await newPage(browser, { width: 480, height: 120 });
    await pgXm.goto(`${fresh.api.base}/control/director-min.html?sbport=${fresh.ws}`, { waitUntil: 'load' });
    await sleep(1800); // subscribed
    await fresh.api.clear();
    const BAD_FRAMES = [
      { type: 'vdoninja:update' },
      { type: 'vdoninja:update', vdoninjaJson: '{not json' },
      { type: 'vdoninja:update', vdoninjaJson: '[1,2,3]' },
      { type: 'vdoninja:update', vdoninjaJson: 42 },
      { type: 'vdoninja:update', vdoninja: {} },
      { type: 'vdoninja:update', vdoninja: { hello: 1 } }, // an object, but not config-shaped
      { type: 'vdoninja:update', vdoninja: [1] },
      { type: 'discord:voice:update', discordVoiceJson: '{bad' },
    ];
    for (const f of BAD_FRAMES) await fresh.api.broadcast(f);
    badProd.doAction('Discord Voice Push', { payload: ROSTER_STATE() }); // a voice arrival after the junk
    await sleep(2500);
    const badActs = await fresh.api.actions();
    check('R8b: no VDO Push after payload-less / unparseable / non-object vdoninja frames and a Discord arrival (both pages)',
      pushesOf(badActs).length === 0, `${pushesOf(badActs).length} push(es)`);
    const stillUnsynced = await pgX.evaluate(() => { const e = document.getElementById('syncStatus'); return !!e && !e.hidden; });
    check('R8b: control.html is still not synced (junk frames never mark it synced)', stillUnsynced);
    check('R8b: …and Export stays disabled (a page showing defaults must not write them into a "backup")',
      await pgX.evaluate(() => document.getElementById('btnCfgExport').disabled === true));
    const minStill = await pgXm.evaluate(() => document.getElementById('status')?.textContent || '');
    check('R8b: director-min is still not synced', /VDO Sync has not answered|no saved config/.test(minStill), minStill);
    await pgX.close(); await pgXm.close(); badProd.close();

    // R8c: GRN-60's interim guard on the error pill: a vdo:error names the date-shaped entry.
    const DATE_LABEL = '2026-11-07T10:30:00';
    const dateProd = await producer(fresh.ws);
    dateProd.doAction('VDO Push', { payload: JSON.stringify({ ...SEED_SAVED,
      directory: [{ vdoLabel: DATE_LABEL, discordUserId: '', displayName: DATE_LABEL, socials: [] },
        { vdoLabel: 'alpha', discordUserId: '', displayName: 'Alpha Prime', socials: [] }] }) });
    await sleep(300);
    const pgY = await newPage(browser, { width: 920, height: 1300 });
    await pgY.goto(`${fresh.api.base}/control/control.html?sbport=${fresh.ws}`, { waitUntil: 'load' });
    await wait(pgY, () => document.getElementById('vdoRoom')?.value === 'seededroom', null, 8000);
    await fresh.api.broadcast({ type: 'vdo:error', message: 'payload rejected, NOT cached: not valid JSON' });
    await wait(pgY, () => /payload rejected/.test(document.getElementById('sbStatus')?.textContent || ''), null, 4000);
    check('R8c: an error that has nothing to do with dates (the new push check) is not blamed on a date-shaped entry',
      await pgY.evaluate(() => { const t = document.getElementById('sbStatus')?.textContent || ''; return /payload rejected/.test(t) && !/date-like/.test(t); }),
      await pgY.evaluate(() => document.getElementById('sbStatus')?.textContent));
    await fresh.api.broadcast({ type: 'vdo:error', message: 'The added or subtracted value results in an un-representable DateTime.' });
    const namedPill = await wait(pgY, (n) => (document.getElementById('sbStatus')?.textContent || '').includes(n), DATE_LABEL, 4000);
    check('R8c: Streamer.bot\'s own date failure (an old action paste) names the date-shaped directory entry', namedPill,
      await pgY.evaluate(() => document.getElementById('sbStatus')?.textContent));
    await pgY.close(); dateProd.close();

    // ── R9: Save/Import, Export and Import checks, unknown-field pass-through ──────────
    console.log('\n[R9] control page: Save/Import re-seed, Export gating + status, Import checks, pass-through');
    scratch = mkdtempSync(resolve(tmpdir(), 'greenroom-r9-'));
    const savedPayloads = (acts) => pushesOf(acts).map((a) => { try { return JSON.parse(a.args.payload); } catch { return null; } }).filter(Boolean);
    const waitState = async (api, pred, tries = 24) => {
      for (let i = 0; i < tries; i++) { const s = await api.state(); if (pred(s)) return s; await sleep(250); }
      return null;
    };

    // R9a: GRN-192 — Save with no edit, and Import of the page's own export, re-seed a wiped vdo.state.
    const seeded = await startExtra({});
    seeded.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_SAVED) });
    await sleep(300);
    const pgS = await newPage(browser, { width: 920, height: 1300 });
    pgS.on('dialog', (d) => d.accept());
    await pgS.goto(`${seeded.api.base}/control/control.html?sbport=${seeded.ws}`, { waitUntil: 'load' });
    await wait(pgS, () => document.getElementById('vdoRoom')?.value === 'seededroom', null, 8000);
    await sleep(600);
    await seeded.api.restart(true); // the persisted vdo.state is gone (a wiped or reinstalled Streamer.bot)
    await seeded.api.clear();
    await pgS.click('#btnVdoSave');
    const reseeded = await waitState(seeded.api, (s) => !!s.vdo && s.vdo.room === 'seededroom');
    check('R9a: Save with no edit re-seeds a wiped vdo.state (force skips only the identical-payload dedupe)', !!reseeded);
    const sentTxt = await pgS.evaluate(() => document.getElementById('cfgStatus')?.textContent || '');
    check("R9a: Save shows a visible 'Sent to Streamer.bot' status", /Sent to Streamer\.bot/i.test(sentTxt), sentTxt);
    const [dlSelf] = await Promise.all([pgS.waitForEvent('download', { timeout: 5000 }).catch(() => null), pgS.click('#btnCfgExport')]);
    const ownExport = resolve(scratch, 'own-export.json');
    if (dlSelf) await dlSelf.saveAs(ownExport);
    await seeded.api.restart(true);
    await seeded.api.clear();
    if (dlSelf) await pgS.setInputFiles('#cfgImportFile', ownExport);
    const reimported = await waitState(seeded.api, (s) => !!s.vdo && s.vdo.room === 'seededroom');
    check("R9a: Import of the page's own export re-seeds a wiped vdo.state", !!dlSelf && !!reimported);
    check("R9a: Import shows the 'Sent to Streamer.bot' status too",
      /Sent to Streamer\.bot/i.test(await pgS.evaluate(() => document.getElementById('cfgStatus')?.textContent || '')));
    await pgS.close();

    // R9b: GRN-143 — Import refuses what it cannot restore faithfully, and counts honestly.
    const dlgI = [];
    const pgI = await newPage(browser, { width: 920, height: 1300 });
    pgI.on('dialog', (d) => { dlgI.push({ type: d.type(), msg: d.message() }); d.dismiss(); });
    await pgI.goto(`${seeded.api.base}/control/control.html?sbport=${seeded.ws}`, { waitUntil: 'load' });
    await wait(pgI, () => document.getElementById('vdoRoom')?.value === 'seededroom', null, 8000);
    await seeded.api.clear();
    const importObj = async (obj) => {
      dlgI.length = 0;
      await pgI.setInputFiles('#cfgImportFile', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)) });
      await sleep(700);
      return dlgI.slice();
    };
    // A numeric ID is already rounded by JSON.parse (110457699291906048 → 110457699291906050).
    let r = await importObj('{"room":"r","directory":[{"vdoLabel":"A","discordUserId":110457699291906048,"displayName":"Alpha"}]}');
    check('R9b: a numeric discordUserId in a directory entry is rejected with a message (not coerced)',
      r.length === 1 && r[0].type === 'alert' && /Discord/i.test(r[0].msg) && /number/i.test(r[0].msg), JSON.stringify(r));
    r = await importObj('{"room":"r","slots":[{"slot":1,"label":"A","discordUserId":110457699291906048}]}');
    check('R9b: a numeric discordUserId in a slot is rejected too', r.length === 1 && r[0].type === 'alert' && /Discord/i.test(r[0].msg), JSON.stringify(r));
    r = await importObj({ room: 123, slots: [] });
    check('R9b: a non-string room is rejected', r.length === 1 && r[0].type === 'alert' && /room/i.test(r[0].msg), JSON.stringify(r));
    r = await importObj({ kind: 'some-other-backup', vdoninja: { room: 'r', slots: [] } });
    check('R9b: an envelope of a different kind is rejected', r.length === 1 && r[0].type === 'alert', JSON.stringify(r));
    r = await importObj({ room: 'r', directory: [
      { vdoLabel: 'A', displayName: 'Alpha' }, { vdoLabel: 'B', displayName: 'Bravo' }, { vdoLabel: 'C', displayName: '' }] });
    check('R9b: the confirm counts the entries that will survive sanitising, and says how many are dropped',
      r.length === 1 && r[0].type === 'confirm' && /2 guest entr/.test(r[0].msg) && /1\D{0,40}dropped|dropped\D{0,40}1/i.test(r[0].msg), JSON.stringify(r));
    r = await importObj({ schemaVersion: 2, room: 'r', slots: [] });
    check('R9b: a backup from a newer Greenroom (schemaVersion 2) is refused before the confirm, with a message',
      r.length === 1 && r[0].type === 'alert' && /newer/i.test(r[0].msg), JSON.stringify(r));
    check('R9b: none of those imports pushed anything', pushesOf(await seeded.api.actions()).length === 0);
    await pgI.close();

    // R9c: GRN-137 + GRN-136 + GRN-14 — Export waits for the config, then says what it saved.
    const slow2 = await startExtra({ SYNC_DELAY_MS: '4000' });
    slow2.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_SAVED) });
    await sleep(300);
    const pgX1 = await newPage(browser, { width: 920, height: 1300 });
    await pgX1.goto(`${slow2.api.base}/control/control.html?sbport=${slow2.ws}`, { waitUntil: 'load' });
    await sleep(1800);
    const exBefore = await pgX1.evaluate(() => { const b = document.getElementById('btnCfgExport'); return { disabled: b.disabled, title: b.title }; });
    check("R9c: Export is disabled before the saved config arrives, with a 'Waiting for the config' tooltip",
      exBefore.disabled === true && /Waiting for the config from Streamer\.bot/.test(exBefore.title), JSON.stringify(exBefore));
    const exAfter = await wait(pgX1, () => { const b = document.getElementById('btnCfgExport'); return !b.disabled && /password/i.test(b.title); }, null, 8000);
    check('R9c: …enabled once it arrives, and the tooltip says the file includes the room password (keep it private)', exAfter,
      await pgX1.evaluate(() => document.getElementById('btnCfgExport').title));
    const [dlX] = await Promise.all([pgX1.waitForEvent('download', { timeout: 5000 }).catch(() => null), pgX1.click('#btnCfgExport')]);
    check('R9c: Export downloads greenroom-vdo-YYYY-MM-DD.json', !!dlX && /^greenroom-vdo-\d{4}-\d{2}-\d{2}\.json$/.test(dlX.suggestedFilename()), dlX && dlX.suggestedFilename());
    const exTxt = await pgX1.evaluate(() => document.getElementById('cfgStatus')?.textContent || '');
    check("R9c: …and always shows 'Saved <file> …' plus a one-line summary of what it holds",
      /Saved greenroom-vdo-\d{4}-\d{2}-\d{2}\.json/.test(exTxt) && /room set, 1 bound slot/.test(exTxt) && /1 directory entry/.test(exTxt), exTxt);
    const noObs = await pgX1.evaluate(() => { const t = document.getElementById('cfgExportText'); return !t || t.hidden || !t.offsetParent; });
    check('R9c: outside OBS no paste-box is shown', noObs);
    await pgX1.close();
    const pgX2 = await newPage(browser, { width: 920, height: 1300 });
    await pgX2.addInitScript('window.obsstudio = { pluginVersion: "test" };'); // an OBS browser dock
    await pgX2.goto(`${slow2.api.base}/control/control.html?sbport=${slow2.ws}`, { waitUntil: 'load' });
    await wait(pgX2, () => !document.getElementById('btnCfgExport').disabled, null, 9000);
    await pgX2.click('#btnCfgExport');
    const obsBox = await wait(pgX2, () => { const t = document.getElementById('cfgExportText');
      return !!t && !!t.offsetParent && t.readOnly && t.value.includes('"kind": "greenroom-vdo-backup"') && !!document.getElementById('btnCfgExportCopy'); }, null, 3000);
    check('R9c: inside OBS the JSON is also shown in a read-only box with a Copy button', obsBox);
    const obsNote = await pgX2.evaluate(() => document.getElementById('cfgStatus')?.textContent || '');
    check('R9c: …and the status says the file may save silently (OBS 33) or not at all (OBS 32 and older)', /OBS 33/.test(obsNote) && /OBS 32/.test(obsNote), obsNote);
    await pgX2.close();
    // A fresh install (no reply, empty cache) can export after its first push.
    await fresh.api.restart(true);
    const pgX3 = await newPage(browser, { width: 920, height: 1300 });
    pgX3.on('dialog', (d) => d.accept());
    await pgX3.goto(`${fresh.api.base}/control/control.html?sbport=${fresh.ws}`, { waitUntil: 'load' });
    await sleep(1800);
    const freshDisabled = await pgX3.evaluate(() => document.getElementById('btnCfgExport').disabled);
    await pgX3.fill('#vdoRoom', 'export-room');
    await pgX3.click('#btnVdoSave');
    const freshEnabled = await wait(pgX3, () => !document.getElementById('btnCfgExport').disabled, null, 5000);
    check('R9c: a fresh install can export after its first push (Export is disabled until then)', freshDisabled === true && freshEnabled);
    await pgX3.close();

    // R9d: GRN-75 + GRN-202 — unknown fields survive both pages' pushes; rev/writer never do;
    // a higher schemaVersion stops them; director-min keeps the auto-add companions.
    const SEED_EXTRA = { enabled: true, room: 'extraroom', password: 'pw1', viewFlags: VIEWFLAGS, futureTop: { a: 1 }, rev: 99, writer: 'zzz',
      slots: [slot(1, { label: 'ALPHA', volume: 0.5 }), slot(2, { label: 'BRAVO' }), slot(3), slot(4)],
      invite: { passwordMode: 'hash', futureInvite: 'x' },
      directory: [{ vdoLabel: 'ALPHA', discordUserId: '', displayName: 'Alpha', pronouns: 'they/them',
        socials: [{ platform: 'twitch', handle: 'AlphaTV', url: 'https://example.invalid/a' }] },
      { vdoLabel: 'BRAVO', discordUserId: '', displayName: 'Bravo', socials: [] }] };
    const keeps = (p) => p && p.futureTop && p.futureTop.a === 1 && p.slots && p.slots[0] && p.slots[0].volume === 0.5
      && p.directory && p.directory[0] && p.directory[0].pronouns === 'they/them'
      && p.directory[0].socials && p.directory[0].socials[0] && p.directory[0].socials[0].url === 'https://example.invalid/a'
      && p.invite && p.invite.futureInvite === 'x';
    const noReserved = (p) => p && !('rev' in p) && !('writer' in p);
    const ext = await startExtra({});
    const reseed = async (obj) => { await ext.api.restart(true); ext.prod.doAction('VDO Push', { payload: JSON.stringify(obj) }); await sleep(300); await ext.api.clear(); };
    await reseed(SEED_EXTRA);
    const pgP = await newPage(browser, { width: 920, height: 1300 }, FIXED_DIR);
    await pgP.goto(`${ext.api.base}/control/control.html?sbport=${ext.ws}`, { waitUntil: 'load' });
    let resolvePush = null;
    for (let i = 0; i < 40 && !resolvePush; i++) { resolvePush = savedPayloads(await ext.api.actions()).find((p) => p.slots && p.slots[0] && p.slots[0].streamID === 'aaa111'); if (!resolvePush) await sleep(250); }
    check('R9d: control.html keeps unknown top-level, slot, directory, social and invite fields through a resolution push', !!keeps(resolvePush), JSON.stringify(resolvePush));
    check('R9d: …and never copies rev or writer', noReserved(resolvePush) && !!resolvePush);
    check('R9d: …and sends schemaVersion 1', !!resolvePush && resolvePush.schemaVersion === 1);
    await ext.api.clear();
    await pgP.fill('#vdoViewFlags', '&solo&edit-test');
    await pgP.click('#btnVdoSave');
    let editPush = null;
    for (let i = 0; i < 24 && !editPush; i++) { editPush = savedPayloads(await ext.api.actions()).find((p) => p.viewFlags === '&solo&edit-test'); if (!editPush) await sleep(250); }
    check('R9d: …and through an edit push (Save)', !!keeps(editPush) && noReserved(editPush), JSON.stringify(editPush));
    await ext.api.clear();
    await pgP.click('.vdo-dir-row .dir-toggle');
    await pgP.fill('.vdo-dir-row.open input.vdo-dir-display', 'Alpha Renamed');
    await pgP.locator('.vdo-dir-row.open input.vdo-dir-display').blur();
    let dirPush = null;
    for (let i = 0; i < 24 && !dirPush; i++) { dirPush = savedPayloads(await ext.api.actions()).find((p) => (p.directory || []).some((e) => e.displayName === 'Alpha Renamed')); if (!dirPush) await sleep(250); }
    check("R9d: …and through a directory edit (a row's pronouns and a social's url survive the editor)", !!keeps(dirPush), JSON.stringify(dirPush && dirPush.directory));
    await ext.api.clear();
    await pgP.check('#vdoInvStereo'); // an invite option: the builder rebuilds the invite from its fields
    let invPush = null;
    for (let i = 0; i < 24 && !invPush; i++) { invPush = savedPayloads(await ext.api.actions()).find((p) => p.invite && p.invite.stereo === true); if (!invPush) await sleep(250); }
    check('R9d: …and through an invite-option change (unknown invite fields survive the builder)',
      !!invPush && invPush.invite.futureInvite === 'x' && !!keeps(invPush), JSON.stringify(invPush && invPush.invite));
    await pgP.close();
    await reseed(SEED_EXTRA);
    const pgPm = await newPage(browser, { width: 480, height: 120 }, FIXED_DIR);
    await pgPm.goto(`${ext.api.base}/control/director-min.html?sbport=${ext.ws}`, { waitUntil: 'load' });
    let minPush = null;
    for (let i = 0; i < 40 && !minPush; i++) { minPush = savedPayloads(await ext.api.actions()).find((p) => p.slots && p.slots[0] && p.slots[0].streamID === 'aaa111'); if (!minPush) await sleep(250); }
    check('R9d: director-min keeps the same unknown fields through its resolution push, and not rev/writer',
      !!keeps(minPush) && noReserved(minPush) && minPush.schemaVersion === 1, JSON.stringify(minPush));
    await pgPm.close();

    // schemaVersion higher than the page knows: it adopts for display but stops pushing.
    await reseed({ ...SEED_EXTRA, schemaVersion: 2 });
    const dlgV = [];
    const pgV = await newPage(browser, { width: 920, height: 1300 }, FIXED_DIR);
    pgV.on('dialog', (d) => { dlgV.push(d.message()); d.accept(); });
    await pgV.goto(`${ext.api.base}/control/control.html?sbport=${ext.ws}`, { waitUntil: 'load' });
    const reloadTxt = await wait(pgV, () => /reload this page/i.test((document.getElementById('sbStatus')?.textContent || '') + (document.getElementById('syncStatus')?.textContent || '')), null, 8000);
    check("R9d: a higher schemaVersion makes control.html say 'reload this page'", reloadTxt);
    check('R9d: …and Export is disabled (it would write that newer config back stamped as version 1)',
      await pgV.evaluate(() => document.getElementById('btnCfgExport').disabled === true));
    await pgV.fill('#vdoViewFlags', '&solo&too-new');
    await pgV.click('#btnVdoSave');
    await sleep(3500); // a director poll or two as well
    check('R9d: …and it pushes nothing, not even on Save or from the director poll', pushesOf(await ext.api.actions()).length === 0, `${pushesOf(await ext.api.actions()).length} push(es)`);
    await pgV.close();
    await reseed({ ...SEED_EXTRA, schemaVersion: 2 });
    const pgVm = await newPage(browser, { width: 480, height: 120 }, FIXED_DIR);
    await pgVm.goto(`${ext.api.base}/control/director-min.html?sbport=${ext.ws}`, { waitUntil: 'load' });
    const reloadMin = await wait(pgVm, () => /reload this page/i.test(document.getElementById('status')?.textContent || ''), null, 8000);
    await sleep(3500);
    check("R9d: director-min says 'reload this page' and pushes nothing", reloadMin && pushesOf(await ext.api.actions()).length === 0);
    await pgVm.close();

    // GRN-202: director-min's pushes keep directoryAutoAdd:false and directoryIgnored (a behaviour test).
    const SEED_COMP = { ...SEED_EXTRA, futureTop: undefined, rev: undefined, writer: undefined, directoryAutoAdd: false, directoryIgnored: ['vdo:bravo'],
      slots: [slot(1, { label: 'ALPHA' }), slot(2), slot(3), slot(4)],
      directory: [{ vdoLabel: 'ALPHA', discordUserId: '', displayName: 'Alpha', socials: [] }] };
    await reseed(SEED_COMP);
    const pgC2 = await newPage(browser, { width: 480, height: 120 }, FIXED_DIR);
    await pgC2.goto(`${ext.api.base}/control/director-min.html?sbport=${ext.ws}`, { waitUntil: 'load' });
    const compPush = await (async () => { for (let i = 0; i < 40; i++) { const p = savedPayloads(await ext.api.actions()).find((q) => q.slots && q.slots[0] && q.slots[0].streamID === 'aaa111'); if (p) return p; await sleep(250); } return null; })();
    const compState = (await ext.api.state()).vdo;
    check('R9d/GRN-202: director-min pushes (ALPHA resolved) and vdo.state still holds directoryAutoAdd:false and the ignore key',
      !!compPush && compState && compState.directoryAutoAdd === false && JSON.stringify(compState.directoryIgnored) === JSON.stringify(['vdo:bravo']), JSON.stringify(compState));
    check('R9d/GRN-202: BRAVO (live, ignored, auto-add off) is not auto-added',
      !!compState && !(compState.directory || []).some((e) => e.vdoLabel === 'BRAVO'), JSON.stringify(compState && compState.directory));
    await pgC2.close();
    const pgC3 = await newPage(browser, { width: 480, height: 120 }, FIXED_DIR);
    await pgC3.goto(`${ext.api.base}/control/director-min.html?sbport=${ext.ws}`, { waitUntil: 'load' });
    await sleep(6000);
    const compState2 = (await ext.api.state()).vdo;
    check('R9d/GRN-202: a reloaded director-min still does not add BRAVO',
      !!compState2 && !(compState2.directory || []).some((e) => e.vdoLabel === 'BRAVO') && compState2.directoryAutoAdd === false, JSON.stringify(compState2 && compState2.directory));
    await pgC3.close();

    // R9e: a Save while Streamer.bot is unreachable must not claim it was sent.
    const offl = await startExtra({});
    offl.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_SAVED) });
    await sleep(300);
    const pgO = await newPage(browser, { width: 920, height: 1300 });
    pgO.on('dialog', (d) => d.accept());
    await pgO.goto(`${offl.api.base}/control/control.html?sbport=${offl.ws}`, { waitUntil: 'load' });
    await wait(pgO, () => document.getElementById('vdoRoom')?.value === 'seededroom', null, 8000);
    offl.proc.kill(); // Streamer.bot goes away
    await wait(pgO, () => /offline/i.test(document.getElementById('sbStatus')?.textContent || ''), null, 8000);
    await pgO.click('#btnVdoSave');
    await sleep(500);
    const offTxt = await pgO.evaluate(() => document.getElementById('cfgStatus')?.textContent || '');
    check('R9e: Save while Streamer.bot is unreachable says it was not sent, never "Sent to Streamer.bot"',
      !/Sent to Streamer\.bot/i.test(offTxt) && /not sent/i.test(offTxt), offTxt);
    await pgO.close();

    } // end of the R1-R9 block (skipped by RENDER_ONLY)

    // ── R10: the connection layer — DOM-ready connect, checked acks, ?sbport, backoff, string frames ──
    if (!ONLY || ONLY === 'conn') {
      console.log('\n[R10] connection: DOM-ready connect, checked acks, ?sbport, backoff, string-field frames');
      const SEED_CONN = { enabled: true, room: 'connroom', password: 'pw1', viewFlags: VIEWFLAGS,
        slots: [slot(1, { label: 'ALPHA', streamID: 'aaa111' }), slot(2, { label: 'BRAVO', streamID: 'bbb222' }), slot(3), slot(4)],
        invite: { passwordMode: 'hash' },
        directory: [{ vdoLabel: 'ALPHA', discordUserId: '', displayName: 'Alpha Prime', socials: [{ platform: 'twitch', handle: 'AlphaTV' }] },
          { vdoLabel: '', discordUserId: STREAMER, displayName: 'Ashe of Outland', socials: [] }] };
      const seedBoth = (x, vdo = SEED_CONN) => {
        x.prod.doAction('VDO Push', { payload: JSON.stringify(vdo) });
        x.prod.doAction('Discord Voice Push', { payload: ROSTER_STATE() });
        return sleep(300);
      };
      // What a page does, seen from outside: the sockets it opens, its console, its uncaught errors.
      const watchPage = (page) => {
        const w = { ws: [], console: [], errors: [] };
        page.on('websocket', (s) => w.ws.push(s.url()));
        page.on('console', (m) => w.console.push(`${m.type()}: ${m.text()}`));
        page.on('pageerror', (e) => w.errors.push(String((e && e.message) || e)));
        return w;
      };
      const guestPainted = () => (document.getElementById('frame')?.getAttribute('src') || '').includes('view=aaa111')
        && document.querySelector('.np-plate')?.hidden === false;
      const guestPaintedSrc = () => (document.getElementById('frame')?.getAttribute('src') || '').includes('view=aaa111');
      const guestUrl = (x, extra = '') => `${x.api.base}/overlay/vdoninja-guest.html?slot=1&sbport=${x.ws}${extra}`;

      // R10a: a script that lands after the page has connected (GRN-106, GRN-104). The delay is done by
      // the mock server, not by a Playwright route, which would bias the race.
      const lag100 = await startExtra({ SB_FILE_DELAY: 'nameplate-shared.js:100' });
      await seedBoth(lag100);
      const gA = await newPage(browser, { width: 640, height: 360 });
      await gA.goto(guestUrl(lag100), { waitUntil: 'load' });
      check('R10a: with nameplate-shared.js 100 ms late, the guest frame and nameplate still paint (the first replay is not lost)',
        await wait(gA, guestPainted, null, 6000), await gA.evaluate(() => document.getElementById('frame')?.getAttribute('src')));
      for (let i = 0; i < 3; i++) await gA.reload({ waitUntil: 'domcontentloaded' }); // reloads during a replay
      check('R10a: three quick reloads during replays still end painted', await wait(gA, guestPainted, null, 8000));
      await gA.close();
      const lag30 = await startExtra({ SB_FILE_DELAY: 'nameplate-shared.js:30' });
      await seedBoth(lag30);
      const rA = await newPage(browser, { width: 900, height: 200 });
      await rA.goto(`${lag30.api.base}/overlay/discord-roster.html?layout=row&sbport=${lag30.ws}`, { waitUntil: 'load' });
      check('R10a: with the script 30 ms late the roster is not left greyed out (body.offline is false) and is painted',
        await wait(rA, () => !document.body.classList.contains('offline') && document.querySelectorAll('#roster .member').length === 3, null, 6000),
        await rA.evaluate(() => `offline=${document.body.classList.contains('offline')} members=${document.querySelectorAll('#roster .member').length}`));
      await rA.close();
      const nA = await newPage(browser, { width: 420, height: 120 });
      await nA.goto(`${lag30.api.base}/overlay/nameplate.html?slot=1&sbport=${lag30.ws}`, { waitUntil: 'load' });
      check('R10a: …and the standalone nameplate is online and painted',
        await wait(nA, () => !document.body.classList.contains('offline') && document.querySelector('.np-plate')?.hidden === false
          && document.querySelector('.np-plate .np-name')?.textContent === 'Alpha Prime', null, 6000));
      await nA.close();

      // R10b: state frames as escaped string fields, unusable frames, and a null slot entry
      // (GRN-186, GRN-185). The mock's default wire delivers vdoninjaJson / discordVoiceJson.
      const wireS = await startExtra({});
      await seedBoth(wireS);
      const gB = await newPage(browser, { width: 640, height: 360 });
      await gB.goto(guestUrl(wireS), { waitUntil: 'load' });
      check('R10b: the guest overlay renders a vdoninjaJson string-field frame (frame + nameplate)', await wait(gB, guestPainted, null, 6000),
        await gB.evaluate(() => document.getElementById('frame')?.getAttribute('src')));
      const rB = await newPage(browser, { width: 900, height: 200 });
      await rB.goto(`${wireS.api.base}/overlay/discord-roster.html?layout=row&sbport=${wireS.ws}`, { waitUntil: 'load' });
      check('R10b: the roster renders discordVoiceJson and uses the directory name from vdoninjaJson',
        await wait(rB, () => document.querySelectorAll('#roster .member').length === 3
          && document.querySelector(`.member[data-uid="${'110457699291906048'}"] .name`)?.textContent === 'Ashe of Outland', null, 6000));
      const nB = await newPage(browser, { width: 420, height: 120 });
      await nB.goto(`${wireS.api.base}/overlay/nameplate.html?slot=1&sbport=${wireS.ws}`, { waitUntil: 'load' });
      check('R10b: the standalone nameplate renders a string-field frame',
        await wait(nB, () => document.querySelector('.np-plate')?.hidden === false && document.querySelector('.np-plate .np-name')?.textContent === 'Alpha Prime', null, 6000));
      const srcBefore = await gB.evaluate(() => document.getElementById('frame')?.getAttribute('src'));
      for (const f of [{ type: 'vdoninja:update', vdoninjaJson: '{not json' }, { type: 'vdoninja:update', vdoninjaJson: '[1,2]' },
        { type: 'vdoninja:update', vdoninjaJson: 42 }, { type: 'discord:voice:update', discordVoiceJson: '{bad' }, { type: 'sync' }]) {
        await wireS.api.broadcast(f);
      }
      await sleep(800);
      check('R10b: unparseable string fields and a field-less {type:"sync"} leave the guest frame and plate unchanged',
        (await gB.evaluate(() => document.getElementById('frame')?.getAttribute('src'))) === srcBefore && await gB.evaluate(guestPainted),
        await gB.evaluate(() => document.getElementById('frame')?.getAttribute('src')));
      check('R10b: …and the roster keeps its members and name',
        await rB.evaluate(() => document.querySelectorAll('#roster .member').length === 3
          && document.querySelector(`.member[data-uid="${'110457699291906048'}"] .name`)?.textContent === 'Ashe of Outland'));
      await gB.close(); await rB.close(); await nB.close();

      // The same overlays against the OLD wire (a nested vdoninja / discordVoice object, as an actions paste
      // from before the string fields sends it): updating the overlay folder first must not blank anything.
      const wireO = await startExtra({ SB_WIRE: 'object' });
      await seedBoth(wireO);
      const gO = await newPage(browser, { width: 640, height: 360 });
      await gO.goto(guestUrl(wireO), { waitUntil: 'load' });
      check('R10b: the guest overlay still renders a nested-object frame (the old wire): frame + nameplate', await wait(gO, guestPainted, null, 6000),
        await gO.evaluate(() => document.getElementById('frame')?.getAttribute('src')));
      const rO = await newPage(browser, { width: 900, height: 200 });
      await rO.goto(`${wireO.api.base}/overlay/discord-roster.html?layout=row&sbport=${wireO.ws}`, { waitUntil: 'load' });
      check('R10b: the roster still renders the old wire (members and the directory name)',
        await wait(rO, () => document.querySelectorAll('#roster .member').length === 3
          && document.querySelector(`.member[data-uid="${'110457699291906048'}"] .name`)?.textContent === 'Ashe of Outland', null, 6000));
      await gO.close(); await rO.close();
      const plain = await startExtra({});
      await seedBoth(plain, { ...SEED_CONN, slots: [null, slot(2, { label: 'BRAVO', streamID: 'bbb222' }), slot(3), slot(4)] });
      const gN = await newPage(browser, { width: 640, height: 360 });
      const wN = watchPage(gN);
      await gN.goto(`${plain.api.base}/overlay/vdoninja-guest.html?slot=2&sbport=${plain.ws}`, { waitUntil: 'load' });
      check('R10b: a null entry before the target slot does not break the guest overlay (slot 2 still renders)',
        await wait(gN, () => (document.getElementById('frame')?.getAttribute('src') || '').includes('view=bbb222'), null, 6000) && wN.errors.length === 0, JSON.stringify(wN.errors));
      await gN.close();

      // R10c: the speaking glow clears when the socket closes (GRN-139).
      const glow = await startExtra({});
      glow.prod.doAction('VDO Push', { payload: JSON.stringify({ ...SEED_CONN, slots: [slot(1, { mode: 'discord', discordUserId: STREAMER }), slot(2), slot(3), slot(4)] }) });
      glow.prod.doAction('Discord Voice Push', { payload: ROSTER_STATE({ users: { [STREAMER]: { speaking: true, username: 'Ashe', avatarUrl: embed(1), mute: false, deaf: false } } }) });
      await sleep(300);
      const gG = await newPage(browser, { width: 640, height: 360 });
      await gG.goto(guestUrl(glow), { waitUntil: 'load' });
      const glowOn = await wait(gG, () => document.getElementById('dpfp')?.classList.contains('speaking') === true, null, 6000);
      glow.proc.kill(); // Streamer.bot goes away while the guest is lit
      const glowOff = await wait(gG, () => { const d = document.getElementById('dpfp'); return !!d && !d.classList.contains('speaking') && !d.hidden; }, null, 6000);
      check('R10c: the speaking glow shows, then clears when the socket closes (the avatar stays)', glowOn && glowOff, `on=${glowOn} off=${glowOff}`);
      await gG.close();

      // R10d: acks and Hello (GRN-125, GRN-57). Delay between a page's WebSocket open and its VDO Sync.
      const syncDelay = async (x, path) => {
        await x.api.clear(); await fetch(`${x.api.base}/mock/conns?clear=1`).then((r) => r.arrayBuffer());
        const p = await newPage(browser, { width: 640, height: 360 });
        await p.goto(`${x.api.base}${path}`, { waitUntil: 'load' });
        await sleep(1600);
        const conns = (await (await fetch(`${x.api.base}/mock/conns`)).json()).conns;
        const sync = (await x.api.actions()).find((a) => a.name === 'VDO Sync');
        await p.close();
        return conns.length && sync ? sync.t - conns[0].t : null;
      };
      const pages = (x) => [['control', `/control/control.html?sbport=${x.ws}`], ['director-min', `/control/director-min.html?sbport=${x.ws}`], ['overlay', `/overlay/vdoninja-guest.html?slot=1&sbport=${x.ws}`]];
      const acked = await startExtra({});
      const noAck = await startExtra({ SB_SUBSCRIBE: 'none' });
      for (const [name, path] of pages(acked)) {
        const d = await syncDelay(acked, path);
        check(`R10d: ${name} fires VDO Sync as soon as the Subscribe is acknowledged (not on the 400 ms fallback)`, d !== null && d < 250, `${d} ms`);
      }
      for (const [name, path] of pages(noAck)) {
        const d = await syncDelay(noAck, path);
        check(`R10d: ${name} with no Subscribe ack falls back to VDO Sync after about 400 ms`, d !== null && d >= 330 && d < 1500, `${d} ms`);
      }
      // Refused Subscribe: reported on every client, and no sync is attempted.
      const refuse = await startExtra({ SB_SUBSCRIBE: 'error' });
      const cR = await newPage(browser, { width: 920, height: 900 });
      const dR = await newPage(browser, { width: 480, height: 120 });
      const oR = await newPage(browser, { width: 640, height: 360 });
      const wOR = watchPage(oR);
      await Promise.all([cR.goto(`${refuse.api.base}/control/control.html?sbport=${refuse.ws}`), dR.goto(`${refuse.api.base}/control/director-min.html?sbport=${refuse.ws}`),
        oR.goto(guestUrl(refuse))]);
      await sleep(1500);
      check('R10d: control.html reports a refused Subscribe in its pill', /Subscribe refused/i.test(await cR.evaluate(() => document.getElementById('sbStatus')?.textContent || '')),
        await cR.evaluate(() => document.getElementById('sbStatus')?.textContent));
      check('R10d: director-min reports it in its status', /Subscribe refused/i.test(await dR.evaluate(() => document.getElementById('status')?.textContent || '')));
      check('R10d: the overlay goes offline and warns on the console',
        await oR.evaluate(() => document.body.classList.contains('offline')) && wOR.console.some((c) => /^warn|^warning/.test(c) && /Subscribe refused/i.test(c)), JSON.stringify(wOR.console.slice(-3)));
      check('R10d: no VDO Sync is attempted after a refused Subscribe (all three clients, past the 400 ms fallback)',
        (await refuse.api.actions()).filter((a) => a.name === 'VDO Sync').length === 0);
      await cR.close(); await dR.close(); await oR.close();
      // A DoAction the server refuses (an action that does not exist) is reported too.
      const noAct = await startExtra({ SB_DOACTION: 'error' });
      const cD = await newPage(browser, { width: 920, height: 900 });
      const oD = await newPage(browser, { width: 640, height: 360 });
      const wOD = watchPage(oD);
      await Promise.all([cD.goto(`${noAct.api.base}/control/control.html?sbport=${noAct.ws}`), oD.goto(guestUrl(noAct))]);
      await sleep(1500);
      check('R10d: control.html reports a refused DoAction in its pill', /DoAction .*refused/i.test(await cD.evaluate(() => document.getElementById('sbStatus')?.textContent || '')),
        await cD.evaluate(() => document.getElementById('sbStatus')?.textContent));
      check('R10d: the overlay reports a refused VDO Sync (offline class and a console warning)',
        await oD.evaluate(() => document.body.classList.contains('offline')) && wOD.console.some((c) => /DoAction .*refused/i.test(c)), JSON.stringify(wOD.console.slice(-3)));
      await cD.close(); await oD.close();
      // Hello with an authentication block (SB's "Enforce authentication" is on).
      const authSb = await startExtra({ SB_HELLO: 'auth' });
      const cH = await newPage(browser, { width: 920, height: 900 });
      const dH = await newPage(browser, { width: 480, height: 120 });
      const oH = await newPage(browser, { width: 640, height: 360 });
      const wOH = watchPage(oH);
      await Promise.all([cH.goto(`${authSb.api.base}/control/control.html?sbport=${authSb.ws}`), dH.goto(`${authSb.api.base}/control/director-min.html?sbport=${authSb.ws}`), oH.goto(guestUrl(authSb))]);
      await sleep(1500);
      check("R10d: a Hello carrying authentication shows 'SB auth enforced — turn Enforce off' on control.html",
        /SB auth enforced — turn Enforce off/.test(await cH.evaluate(() => document.getElementById('sbStatus')?.textContent || '')));
      check('R10d: …on director-min', /SB auth enforced — turn Enforce off/.test(await dH.evaluate(() => document.getElementById('status')?.textContent || '')));
      check('R10d: …and on the overlay (offline class and a console warning)',
        await oH.evaluate(() => document.body.classList.contains('offline')) && wOH.console.some((c) => /SB auth enforced/.test(c)), JSON.stringify(wOH.console.slice(-3)));
      await cH.close(); await dH.close(); await oH.close();
      // The server closes any unauthenticated client: the message stays, nothing throws.
      const authClose = await startExtra({ SB_HELLO: 'auth', SB_AUTH: 'close' });
      const cC = await newPage(browser, { width: 920, height: 900 });
      const dC = await newPage(browser, { width: 480, height: 120 });
      const oC = await newPage(browser, { width: 640, height: 360 });
      const wCC = watchPage(cC);
      const wOC = watchPage(oC);
      await Promise.all([cC.goto(`${authClose.api.base}/control/control.html?sbport=${authClose.ws}`), dC.goto(`${authClose.api.base}/control/director-min.html?sbport=${authClose.ws}`), oC.goto(guestUrl(authClose))]);
      await sleep(6500); // past the 5 s "name the causes" timer
      check('R10d: when the server closes unauthenticated clients, the auth message stays on screen and nothing throws',
        /SB auth enforced/.test(await cC.evaluate(() => document.getElementById('sbStatus')?.textContent || '')) && wCC.errors.length === 0,
        await cC.evaluate(() => document.getElementById('sbStatus')?.textContent));
      check('R10d: …and control.html does not also blame VDO Sync or a fresh install (the sync line stays quiet)',
        await cC.evaluate(() => { const e = document.getElementById('syncStatus'); return !!e && e.hidden && !e.textContent; }), await cC.evaluate(() => document.getElementById('syncStatus')?.textContent));
      check('R10d: …director-min names authentication after the hang-up', /SB auth enforced/.test(await dC.evaluate(() => document.getElementById('status')?.textContent || '')));
      check('R10d: …and the overlay warns about it on the console and is offline',
        await oC.evaluate(() => document.body.classList.contains('offline')) && wOC.console.some((c) => /^warn/.test(c) && /SB auth enforced/.test(c)), JSON.stringify(wOC.console.slice(-3)));
      await cC.close(); await dC.close(); await oC.close();
      // Authentication on, Enforce off, but a DoAction refused for another reason (an action that was never
      // imported): the cause is the missing action, not authentication, and the page says so.
      const authAct = await startExtra({ SB_HELLO: 'auth', SB_AUTH: 'serve', SB_DOACTION: 'error' });
      const cA2 = await newPage(browser, { width: 920, height: 900 });
      const dA2 = await newPage(browser, { width: 480, height: 120 });
      const oA2 = await newPage(browser, { width: 640, height: 360 });
      const wOA2 = watchPage(oA2);
      await Promise.all([cA2.goto(`${authAct.api.base}/control/control.html?sbport=${authAct.ws}`), dA2.goto(`${authAct.api.base}/control/director-min.html?sbport=${authAct.ws}`), oA2.goto(guestUrl(authAct))]);
      await sleep(1500);
      const pillA2 = await cA2.evaluate(() => document.getElementById('sbStatus')?.textContent || '');
      const minA2 = await dA2.evaluate(() => document.getElementById('status')?.textContent || '');
      check('R10d: with Authentication on and Enforce off, a refused DoAction is blamed on the action, not on authentication (control pill, director-min, overlay console)',
        /DoAction .*refused/.test(pillA2) && !/auth/i.test(pillA2) && /DoAction .*refused/.test(minA2) && !/auth/i.test(minA2) && !wOA2.console.some((c) => /SB auth enforced/.test(c)),
        pillA2 + ' | ' + minA2 + ' | ' + JSON.stringify(wOA2.console.slice(-2)));
      await fetch(`${authAct.api.base}/mock/mode?doaction=ok`).then((r) => r.arrayBuffer());
      check('R10d: …and the notice clears once requests work again (it was not pinned as an authentication notice)',
        await wait(cA2, () => !/refused|auth/.test(document.getElementById('sbStatus')?.textContent || ''), null, 8000)
          && await wait(dA2, () => !/refused|auth/.test(document.getElementById('status')?.textContent || ''), null, 8000),
        await cA2.evaluate(() => document.getElementById('sbStatus')?.textContent) + ' | ' + await dA2.evaluate(() => document.getElementById('status')?.textContent));
      await cA2.close(); await dA2.close(); await oA2.close();

      // Review findings on the above. A Hello whose authentication block means nothing (Authentication on,
      // Enforce off: SB still serves every request) must not raise an alarm or grey the overlay.
      const authServe = await startExtra({ SB_HELLO: 'auth', SB_AUTH: 'serve' });
      await seedBoth(authServe);
      const cV = await newPage(browser, { width: 920, height: 900 });
      const dV = await newPage(browser, { width: 480, height: 120 });
      const oV = await newPage(browser, { width: 640, height: 360 });
      await Promise.all([cV.goto(`${authServe.api.base}/control/control.html?sbport=${authServe.ws}`), dV.goto(`${authServe.api.base}/control/director-min.html?sbport=${authServe.ws}`), oV.goto(guestUrl(authServe))]);
      const servedPainted = await wait(oV, guestPainted, null, 6000);
      await sleep(800);
      const pillV = await cV.evaluate(() => document.getElementById('sbStatus')?.textContent || '');
      check('R10d: a Hello with an authentication block that SB does not enforce raises no alarm: control pill stays "SB: connected"',
        /SB: connected/.test(pillV) && !/auth/i.test(pillV), pillV);
      check('R10d: …director-min shows no auth notice', !/auth enforced/i.test(await dV.evaluate(() => document.getElementById('status')?.textContent || '')));
      check('R10d: …and the overlay is not greyed out and paints the guest', servedPainted && await oV.evaluate(() => !document.body.classList.contains('offline')));
      await cV.close(); await dV.close(); await oV.close();
      // Enforce turned off while the pages are open: the notice goes away on the next healthy connection.
      const recov = await startExtra({ SB_HELLO: 'auth' });
      const cW = await newPage(browser, { width: 920, height: 900 });
      const dW = await newPage(browser, { width: 480, height: 120 });
      const oW = await newPage(browser, { width: 640, height: 360 });
      await Promise.all([cW.goto(`${recov.api.base}/control/control.html?sbport=${recov.ws}`), dW.goto(`${recov.api.base}/control/director-min.html?sbport=${recov.ws}`), oW.goto(guestUrl(recov))]);
      await sleep(1500);
      const noticeShown = /auth enforced/.test(await cW.evaluate(() => document.getElementById('sbStatus')?.textContent || ''));
      await fetch(`${recov.api.base}/mock/mode?hello=plain&auth=serve`).then((r) => r.arrayBuffer());
      await fetch(`${recov.api.base}/mock/dropall`).then((r) => r.arrayBuffer()); // SB restarts its WebSocket server
      const noticeGoneC = await wait(cW, () => /SB: connected/.test(document.getElementById('sbStatus')?.textContent || ''), null, 8000);
      const noticeGoneD = await wait(dW, () => !/auth enforced/.test(document.getElementById('status')?.textContent || ''), null, 8000);
      check('R10d: with Enforce turned off and a reconnect, control.html replaces the auth notice with "SB: connected"', noticeShown && noticeGoneC,
        await cW.evaluate(() => document.getElementById('sbStatus')?.textContent));
      check('R10d: …director-min drops the notice too, and the overlay is online', noticeGoneD && await wait(oW, () => !document.body.classList.contains('offline'), null, 6000));
      await cW.close(); await dW.close(); await oW.close();
      // The auth notice is about the connection that got the Hello; when Streamer.bot is simply not running
      // the pages say "offline", not "auth enforced".
      const authDown = await startExtra({ SB_HELLO: 'auth' });
      const cX = await newPage(browser, { width: 920, height: 900 });
      const dX = await newPage(browser, { width: 480, height: 120 });
      await Promise.all([cX.goto(`${authDown.api.base}/control/control.html?sbport=${authDown.ws}`), dX.goto(`${authDown.api.base}/control/director-min.html?sbport=${authDown.ws}`)]);
      await sleep(1500);
      authDown.proc.kill();
      check('R10d: when Streamer.bot then stops, control.html says offline (not "auth enforced")',
        await wait(cX, () => /offline/i.test(document.getElementById('sbStatus')?.textContent || '') && !/auth enforced/.test(document.getElementById('sbStatus')?.textContent || ''), null, 8000),
        await cX.evaluate(() => document.getElementById('sbStatus')?.textContent));
      check('R10d: …and so does director-min', await wait(dX, () => /offline/i.test(document.getElementById('status')?.textContent || '') && !/auth enforced/.test(document.getElementById('status')?.textContent || ''), null, 8000));
      await cX.close(); await dX.close();
      // A Subscribe refusal that arrives AFTER the 400 ms fallback has fired the sync: the page must not
      // keep re-asking (2/4/8 s loops, the overlay's 2.5 s repeat), and must not blame VDO Sync.
      const late = await startExtra({ SB_SUBSCRIBE: 'error', SB_SUBSCRIBE_DELAY_MS: '700' });
      const cL = await newPage(browser, { width: 920, height: 900 });
      const dL = await newPage(browser, { width: 480, height: 120 });
      const oL = await newPage(browser, { width: 640, height: 360 });
      await Promise.all([cL.goto(`${late.api.base}/control/control.html?sbport=${late.ws}`), dL.goto(`${late.api.base}/control/director-min.html?sbport=${late.ws}`), oL.goto(guestUrl(late))]);
      await sleep(6500);
      const lateSyncs = (await late.api.actions()).filter((a) => a.name === 'VDO Sync');
      check('R10d: after a late Subscribe refusal no page sends another VDO Sync (only the three 400 ms fallbacks happened)',
        lateSyncs.length <= 3 && !lateSyncs.some((a) => /retry|resync/.test((a.args && a.args.reason) || '')), JSON.stringify(lateSyncs.map((a) => a.args && a.args.reason)));
      const lateTxt = await cL.evaluate(() => { const e = document.getElementById('syncStatus'); return e ? (e.hidden ? '' : e.textContent) : 'MISSING'; });
      check('R10d: …and control.html says nothing about VDO Sync or a fresh install for a refused Subscribe (the sync line is quiet)', lateTxt === '', lateTxt);
      await cL.close(); await dL.close(); await oL.close();
      // A refused DoAction is a current fault, not a permanent one. It clears by either of two routes, each
      // tested alone: (a) a later request succeeds, (b) the saved config arrives another way.
      // (a) Unseeded, nothing ever syncs the pages: only an ok reply to their own VDO Sync retry can clear it.
      // (No empty marker either, as from an older actions paste: a marker would sync the pages.)
      const flipA = await startExtra({ SB_DOACTION: 'error', SB_EMPTY_MARKER: '0' });
      const cFa = await newPage(browser, { width: 920, height: 900 });
      const dFa = await newPage(browser, { width: 480, height: 120 });
      await Promise.all([cFa.goto(`${flipA.api.base}/control/control.html?sbport=${flipA.ws}`), dFa.goto(`${flipA.api.base}/control/director-min.html?sbport=${flipA.ws}`)]);
      await sleep(1500);
      const shownA = /DoAction .*refused/.test(await cFa.evaluate(() => document.getElementById('sbStatus')?.textContent || ''))
        && /DoAction .*refused/.test(await dFa.evaluate(() => document.getElementById('status')?.textContent || ''));
      await fetch(`${flipA.api.base}/mock/mode?doaction=ok`).then((r) => r.arrayBuffer()); // before their 2 s VDO Sync retries
      check('R10d: a refused DoAction clears on control.html when its next request (the VDO Sync retry) succeeds, with the page still unsynced',
        shownA && await wait(cFa, () => !/refused/.test(document.getElementById('sbStatus')?.textContent || ''), null, 8000)
          && await cFa.evaluate(() => !document.getElementById('syncStatus').hidden),
        await cFa.evaluate(() => document.getElementById('sbStatus')?.textContent));
      check('R10d: …and on director-min', await wait(dFa, () => !/refused/.test(document.getElementById('status')?.textContent || ''), null, 8000),
        await dFa.evaluate(() => document.getElementById('status')?.textContent));
      await cFa.close(); await dFa.close();
      // (b) The config arrives as a frame (another page pushed it): the refused sync no longer matters. Live frames
      // also bring a greyed overlay back, and a repeat of the refused sync must not grey it again.
      const flipB = await startExtra({ SB_DOACTION: 'error' });
      const cFb = await newPage(browser, { width: 920, height: 900 });
      const dFb = await newPage(browser, { width: 480, height: 120 });
      const oFb = await newPage(browser, { width: 640, height: 360 });
      await Promise.all([cFb.goto(`${flipB.api.base}/control/control.html?sbport=${flipB.ws}`), dFb.goto(`${flipB.api.base}/control/director-min.html?sbport=${flipB.ws}`), oFb.goto(guestUrl(flipB))]);
      await sleep(1500);
      const shownB = await oFb.evaluate(() => document.body.classList.contains('offline'));
      // A live frame that is not vdo state and that the control pages ignore (a voice update would make them
      // auto-add the voice users and push the directory, which this mock refuses: an honest, different notice).
      await flipB.api.broadcast({ type: 'greenroom:ping' });
      const backOnline = await wait(oFb, () => !document.body.classList.contains('offline'), null, 4000);
      await sleep(3500); // past the overlay's 2.5 s repeat of VDO Sync
      check('R10d: the overlay greyed by a refused sync comes back on a live frame, and the repeat of the refused sync does not grey it again',
        shownB && backOnline && await oFb.evaluate(() => !document.body.classList.contains('offline')));
      await flipB.api.broadcast({ type: 'vdoninja:update', vdoninja: SEED_CONN });
      check('R10d: …when the saved config arrives as a frame, the refused-DoAction notice clears on control.html and director-min, and the overlay paints',
        await wait(cFb, () => !/refused/.test(document.getElementById('sbStatus')?.textContent || ''), null, 5000)
          && await wait(dFb, () => !/refused/.test(document.getElementById('status')?.textContent || ''), null, 5000)
          && await wait(oFb, guestPaintedSrc, null, 5000));
      await cFb.close(); await dFb.close(); await oFb.close();
      // A push that SB refused is offered again, but at a bounded rate (not on every 2.5 s poll), and the page
      // says it was not accepted until a retry is saved. Both control pages, against a fixed roster.
      for (const kind of ['director-min', 'control']) {
        const rej = await startExtra({});
        const REJ_SEED = { ...SEED_CONN, slots: [slot(1, { label: 'ALPHA', streamID: '' }), slot(2, { label: 'BRAVO', streamID: '' }), slot(3), slot(4)] };
        rej.prod.doAction('VDO Push', { payload: JSON.stringify(REJ_SEED) });
        await sleep(300);
        const pj = await newPage(browser, kind === 'control' ? { width: 920, height: 900 } : { width: 480, height: 120 }, `${MOCK_DIRECTOR}?fixed=1`);
        await pj.goto(`${rej.api.base}/control/${kind}.html?sbport=${rej.ws}`, { waitUntil: 'load' });
        const adopted2 = await wait(pj, () => /room connroom/.test(document.getElementById('status')?.textContent || '') || document.getElementById('vdoRoom')?.value === 'connroom', null, 6000);
        await fetch(`${rej.api.base}/mock/mode?doaction=error`).then((r) => r.arrayBuffer()); // before its first poll
        await sleep(8000); // polls at about 1.5, 4, 6.5 s: only the first push may be sent
        const attempts = (await rej.api.actions()).filter((a) => a.name === 'VDO Push' && /"streamID":"aaa111"/.test((a.args && a.args.payload) || ''));
        const notAccepted = kind === 'control' ? /Not accepted/.test(await pj.evaluate(() => document.getElementById('cfgStatus')?.textContent || '')) : true;
        check(`R10d: ${kind}: while SB refuses every push it is offered at a bounded rate (1 attempt in 8 s, not one per poll)${kind === 'control' ? ' and the page says "Not accepted"' : ''}`,
          adopted2 && attempts.length === 1 && notAccepted, `${attempts.length} attempt(s), adopted=${adopted2}`);
        await fetch(`${rej.api.base}/mock/mode?doaction=ok`).then((r) => r.arrayBuffer());
        const resent = await (async () => { for (let i = 0; i < 64; i++) { const s = await rej.api.state(); if (s.vdo && s.vdo.slots && s.vdo.slots[0].streamID === 'aaa111') return true; await sleep(250); } return false; })();
        check(`R10d: ${kind}: once SB accepts requests again the refused push is sent again and saved`, resent);
        if (kind === 'control') {
          check('R10d: …and control.html drops the "Not accepted" line once it is saved', await wait(pj, () => !/Not accepted/.test(document.getElementById('cfgStatus')?.textContent || ''), null, 4000),
            await pj.evaluate(() => document.getElementById('cfgStatus')?.textContent));
        }
        await pj.close();
      }

      // R10e: ?sbport is a port number or nothing (GRN-27, GRN-100). A bad value never reaches a WebSocket.
      const BAD_PORTS = ['1%40example.invalid', '0', '65536', 'abc', '8080.5', ''];
      let sbOk = true; const sbDetail = [];
      for (const bad of BAD_PORTS) {
        const kinds = [['control', '/control/control.html', 'control'], ['director-min', '/control/director-min.html', 'min'], ['guest', '/overlay/vdoninja-guest.html?slot=1', 'overlay'],
          ['roster', '/overlay/discord-roster.html', 'overlay'], ['nameplate', '/overlay/nameplate.html?slot=1', 'overlay']];
        await Promise.all(kinds.map(async ([name, path, kind]) => {
          const p = await newPage(browser, { width: 700, height: 500 });
          const w = watchPage(p);
          // A fence: no WebSocket may open from these pages at all, so a regression can only fail the
          // test and never reach a real Streamer.bot on :8080 (an empty ?sbport once meant 8080).
          const fenced = [];
          await p.routeWebSocket(/.*/, (sock) => { fenced.push(sock.url()); sock.close(); });
          await p.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}sbport=${bad}`, { waitUntil: 'load' });
          await sleep(1300);
          const status = await p.evaluate(() => ({ pill: document.getElementById('sbStatus')?.textContent || '', min: document.getElementById('status')?.textContent || '', off: document.body.classList.contains('offline') }));
          const shown = kind === 'control' ? /invalid \?sbport/i.test(status.pill) : kind === 'min' ? /invalid \?sbport/i.test(status.min)
            : status.off && w.console.some((c) => /^error/.test(c) && /invalid \?sbport/i.test(c));
          if (w.ws.length !== 0 || fenced.length !== 0 || !shown) { sbOk = false; sbDetail.push(`${name} ?sbport=${bad}: ws=${JSON.stringify(w.ws.concat(fenced))} shown=${shown}`); }
          await p.close();
        }));
      }
      check('R10e: with an invalid ?sbport (a host-injection string, 0, 65536, text, a fraction, empty) none of the five pages opens any WebSocket, and each says so',
        sbOk, sbDetail.slice(0, 3).join(' | '));
      const goodWs = []; const pGood = await newPage(browser, { width: 920, height: 900 });
      pGood.on('websocket', (s) => goodWs.push(s.url()));
      // Both Copy buttons read the clipboard API at click time (the nameplate URL is not stored on the button),
      // so record what they write.
      const CLIP = 'Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { (window.__clip = window.__clip || []).push(String(t)); } } });';
      await pGood.addInitScript(CLIP);
      await pGood.goto(`${BASE}/control/control.html?sbport=${WS_PORT}`, { waitUntil: 'load' });
      await sleep(1000);
      check('R10e: a valid ?sbport still connects, to 127.0.0.1 on that port', goodWs.length >= 1 && goodWs.every((u) => u === `ws://127.0.0.1:${WS_PORT}/`), JSON.stringify(goodWs));
      const copyAll = async (p) => {
        for (const sel of ['.vdo-slot-row[data-slot="1"] .vdo-src-copy', '.np-src-copy[data-np-slot="1"]']) { await p.click(sel); await sleep(150); }
        return p.evaluate(() => (window.__clip || []).slice());
      };
      const clipsGood = await copyAll(pGood);
      check('R10e: a valid ?sbport is copied into both the guest and the nameplate OBS source URLs',
        clipsGood.length === 2 && clipsGood[0].includes(`vdoninja-guest.html?slot=1&sbport=${WS_PORT}`) && clipsGood[1].includes(`nameplate.html?slot=1&sbport=${WS_PORT}`), JSON.stringify(clipsGood));
      await pGood.close();
      const pBad = await newPage(browser, { width: 920, height: 900 });
      const badDialogs = [];
      pBad.on('dialog', (d) => { badDialogs.push(d.message()); d.accept(); });
      await pBad.routeWebSocket(/.*/, (sock) => sock.close()); // (fenced, as above)
      await pBad.addInitScript(CLIP);
      await pBad.goto(`${BASE}/control/control.html?sbport=1%40example.invalid`, { waitUntil: 'load' });
      await sleep(600);
      const clipsBad = await copyAll(pBad);
      // The plan's rule: a crafted value is never copied; the URL is the plain one (no sbport). A bad value never
      // reaches the page's own connection (above); the OBS URL is the same one a default-port streamer uses.
      check('R10e: with an invalid ?sbport the copied guest and nameplate URLs are the plain ones (no sbport, nothing crafted)',
        clipsBad.length === 2 && clipsBad.every((u) => !/sbport/i.test(u) && !u.includes('example.invalid')) && /vdoninja-guest\.html\?slot=1$/.test(clipsBad[0]) && /nameplate\.html\?slot=1$/.test(clipsBad[1]), JSON.stringify(clipsBad));
      await pBad.fill('#vdoRoom', 'x');
      await pBad.click('#btnVdoSave');
      await sleep(400);
      check('R10e: Save on a page with an invalid ?sbport does not ask to "replace" a config it cannot reach; it says the port is invalid',
        badDialogs.length === 0 && /invalid \?sbport/i.test(await pBad.evaluate(() => document.getElementById('cfgStatus')?.textContent || '')),
        JSON.stringify(badDialogs) + ' / ' + await pBad.evaluate(() => document.getElementById('cfgStatus')?.textContent));
      await pBad.close();

      // R10f: backoff. A server that accepts then drops must still reach the cap, and the cap is short
      // (GRN-162, GRN-215). Intervals between connects, with a server that closes each one after 100 ms.
      // Each gap is the reconnect delay plus the ~100 ms the mock keeps the socket: about 1.1, 1.6, 2.35, 3.5, then 4.1 s.
      // One page at a time: tabs that are not in front get their timers throttled, which stretches the gaps.
      const EXPECT = [1100, 1600, 2350, 3475, 4100];
      for (const [name, kind] of [['overlay shim', 'overlay'], ['control.html', 'control'], ['director-min', 'min']]) {
        const x = await startExtra({ SB_DROP: '1' });
        const url = kind === 'overlay' ? guestUrl(x) : `${x.api.base}/control/${kind === 'control' ? 'control' : 'director-min'}.html?sbport=${x.ws}`;
        await fetch(`${x.api.base}/mock/conns?clear=1`).then((r) => r.arrayBuffer()); // only the page's own connects count
        const fp = await newPage(browser, { width: 640, height: 360 });
        await fp.goto(url, { waitUntil: 'load' });
        // Poll until the sixth connect (nominally 12.6 s in; each gap may drift 450 ms), never a fixed sleep.
        let t = [];
        for (let i = 0; i < 80 && t.length < 6; i++) { await sleep(250); t = (await (await fetch(`${x.api.base}/mock/conns`)).json()).conns.map((c) => c.t); }
        await sleep(300);
        const gaps = t.slice(1).map((v, i) => v - t[i]);
        check(`R10f: ${name}: the reconnect delay grows (1 s, x1.5) across a server that accepts then drops, and stops near 4 s`,
          t.length >= 6 && EXPECT.every((e, i) => Math.abs(gaps[i] - e) <= 450) && Math.max(...gaps) <= 5500, JSON.stringify(gaps));
        await fp.close();
      }

      // R10h: the overlay's one-time repeat of VDO Sync (GRN-106's second safeguard).
      const dropSync = await startExtra({ SB_SYNC_DROP: '1' });
      await seedBoth(dropSync);
      await dropSync.api.clear();
      const gR = await newPage(browser, { width: 640, height: 360 });
      await gR.goto(guestUrl(dropSync), { waitUntil: 'load' });
      await sleep(4200);
      const rs = (await dropSync.api.actions()).filter((a) => a.name === 'VDO Sync');
      check('R10h: when the first sync replay is lost, the overlay repeats VDO Sync once after about 2.5 s and then paints',
        rs.length === 2 && rs[0].args.reason === 'overlay-connect' && rs[1].args.reason === 'overlay-resync' && rs[1].t - rs[0].t >= 2000 && rs[1].t - rs[0].t <= 3500 && await gR.evaluate(guestPainted),
        JSON.stringify(rs.map((a) => [a.args.reason, a.t - rs[0].t])));
      await gR.close();
      const okSync = await startExtra({});
      await seedBoth(okSync);
      await okSync.api.clear();
      const gK = await newPage(browser, { width: 640, height: 360 });
      await gK.goto(guestUrl(okSync), { waitUntil: 'load' });
      await sleep(4200);
      check('R10h: when state arrives, there is no repeat (exactly one VDO Sync in 4 s)', (await okSync.api.actions()).filter((a) => a.name === 'VDO Sync').length === 1);
      await gK.close();

      // R10g: General.Custom data delivered as a JSON string (SB's schema allows it).
      const strData = await startExtra({ SB_DATA: 'string' });
      await seedBoth(strData);
      const gS = await newPage(browser, { width: 640, height: 360 });
      await gS.goto(guestUrl(strData), { waitUntil: 'load' });
      const cS = await newPage(browser, { width: 920, height: 900 });
      await cS.goto(`${strData.api.base}/control/control.html?sbport=${strData.ws}`, { waitUntil: 'load' });
      check('R10g: with data as a JSON string the guest overlay renders', await wait(gS, guestPainted, null, 6000));
      check('R10g: …and control.html hydrates', await wait(cS, () => document.getElementById('vdoRoom')?.value === 'connroom', null, 6000));
      await gS.close(); await cS.close();
    }

    // ── R11: guest labels that look like timestamps (GRN-60, GRN-65) ───────────────────────
    // Streamer.bot parses a nested object it broadcasts and re-formats a date-shaped string in it, or throws on
    // one outside the DateTime range. The old actions nested the state, so a guest whose display name looked
    // like a timestamp changed the label every page matched on (a blank cam, or a loop of pushes) or stopped
    // the broadcast. The string fields keep the label byte-identical. Each label runs through the guest
    // overlay, control.html and director-min.html together, against a director that reports that label.
    if (!ONLY || ONLY === 'labels') {
      console.log('\n[R11] labels: a guest label that looks like a timestamp, through the real pages');
      const hostOffset = -new Date(2024, 1, 3).getTimezoneOffset(); // so the offset label is not already in host-local time
      const LIMIT_YEAR = 9999, LIMIT_MS = 253402300799999; // the last year and millisecond a DateTime holds
      const LABELS = [
        ['an ISO time with fractional zeros', '2024-02-03T04:05:06.000Z'],
        ['an ISO time with an offset', '2024-02-03T04:05:06' + (hostOffset === 120 ? '-11:00' : '+02:00')],
        ['a /Date(ms)/ value', '/Date(1700000000000)/'],
        ['a /Date(ms)/ value past the DateTime limit', `/Date(${LIMIT_MS + 1})/`],
        ['an end-of-day time past the DateTime limit', `${LIMIT_YEAR}-12-31T24:00:00`],
      ];
      const labelSeed = (label) => ({ enabled: true, room: 'labelroom', password: 'pw1', viewFlags: VIEWFLAGS,
        slots: [slot(1, { label }), slot(2), slot(3), slot(4)], invite: { passwordMode: 'hash' },
        directory: [{ vdoLabel: label, discordUserId: '', displayName: 'Guest', socials: [] }] });
      const observeLabel = async (wire, label) => {
        const x = await startExtra(wire === 'object' ? { SB_WIRE: 'object' } : {});
        x.prod.doAction('VDO Push', { payload: JSON.stringify(labelSeed(label)) });
        await sleep(300);
        await x.api.clear();
        const dir = `${x.api.base}/mock/vdo-director.html?fixed=1&label=${encodeURIComponent(label)}`;
        const guest = await newPage(browser, { width: 640, height: 360 });
        const ctl = await newPage(browser, { width: 920, height: 1300 }, dir);
        const min = await newPage(browser, { width: 480, height: 120 }, dir);
        const errors = [];
        for (const p of [guest, ctl, min]) p.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
        await Promise.all([
          guest.goto(`${x.api.base}/overlay/vdoninja-guest.html?slot=1&sbport=${x.ws}`),
          ctl.goto(`${x.api.base}/control/control.html?sbport=${x.ws}`),
          min.goto(`${x.api.base}/control/director-min.html?sbport=${x.ws}`),
        ]);
        await sleep(6000);
        const early = pushesOf(await x.api.actions()).length;
        await sleep(5000); // two more director polls
        const pushes = pushesOf(await x.api.actions());
        const state = await x.api.state();
        const seen = {
          painted: await guest.evaluate(() => (document.getElementById('frame')?.getAttribute('src') || '').includes('view=aaa111')),
          cachedLabel: state.vdo && state.vdo.slots && state.vdo.slots[0] && state.vdo.slots[0].label,
          pushes: pushes.length, late: pushes.length - early,
          pill: await ctl.evaluate(() => document.getElementById('sbStatus')?.textContent || ''),
          minStatus: await min.evaluate(() => document.getElementById('status')?.textContent || ''),
          errors,
        };
        await guest.close(); await ctl.close(); await min.close(); x.prod.close(); x.proc.kill();
        if (process.env.RENDER_VERBOSE) console.log(`    [${wire}] ${JSON.stringify(seen)}`);
        return seen;
      };
      for (const [what, label] of LABELS) {
        const good = await observeLabel('string', label);
        check(`R11 ${what}: with string fields the cam resolves, the cached label is byte-identical, nothing is pushed in the last 5 s and no error shows`,
          good.painted && good.cachedLabel === label && good.late === 0 && !/error/i.test(good.pill + ' ' + good.minStatus) && good.errors.length === 0, JSON.stringify(good));
        const bad = await observeLabel('object', label);
        check(`R11 ${what}: the old object format is red (the cam stays blank, and either the saved label was rewritten or an SB action error shows)`,
          !bad.painted && (bad.cachedLabel !== label || /error/i.test(bad.pill)), JSON.stringify(bad));
      }
    }

    // ── R12: the empty marker, and a saved config Streamer.bot cannot read ─────────────────────────────
    if (!ONLY || ONLY === 'labels') {
      console.log('\n[R12] sync messages: marker + confirm, error hints, a damaged saved config');
      // (a) A fresh install whose first VDO Sync is slow: the operator confirms the 'replace' prompt, and the empty marker
      // arrives while that prompt is open. The marker means nothing is saved, so the confirmed Save must still go out.
      const slowFresh = await startExtra({ SYNC_DELAY_MS: '2500' });
      const pgM = await newPage(browser, { width: 920, height: 1300 });
      let askedM = 0;
      pgM.on('dialog', async (d) => { askedM++; await sleep(3500); await d.accept(); });
      await pgM.goto(`${slowFresh.api.base}/control/control.html?sbport=${slowFresh.ws}`, { waitUntil: 'load' });
      await sleep(800);
      await pgM.fill('#vdoRoom', 'confirm-room');
      await pgM.click('#btnVdoSave');
      let pushedM = null;
      for (let i = 0; i < 30 && !pushedM; i++) {
        pushedM = pushesOf(await slowFresh.api.actions()).map((a) => { try { return JSON.parse(a.args.payload); } catch { return null; } }).filter(Boolean).find((p) => p.room === 'confirm-room');
        if (!pushedM) await sleep(250);
      }
      const statusM = await pgM.evaluate(() => document.getElementById('cfgStatus')?.textContent || '');
      check('R12: the operator confirmed a Save while the first VDO Sync was slow, the empty marker arrived meanwhile: the Save goes out, and the page does not claim a saved config arrived',
        askedM === 1 && !!pushedM && !/arrived/.test(statusM), JSON.stringify({ askedM, pushed: !!pushedM, statusM }));
      await pgM.close(); slowFresh.prod.close(); slowFresh.proc.kill();

      // (b) A saved vdo.state that is not valid JSON: VDO Sync reports it. The pages say that, not 'a fresh install'.
      const damaged = await startExtra({});
      await fetch(`${damaged.api.base}/mock/setcache`, { method: 'POST', body: JSON.stringify({ vdo: '{"enabled":true,"room":"evil"},"type":"x"}' }) }).then((r) => r.arrayBuffer());
      const pgDc = await newPage(browser, { width: 920, height: 1300 });
      const pgDm = await newPage(browser, { width: 480, height: 120 });
      await Promise.all([pgDc.goto(`${damaged.api.base}/control/control.html?sbport=${damaged.ws}`), pgDm.goto(`${damaged.api.base}/control/director-min.html?sbport=${damaged.ws}`)]);
      const dmgC = await wait(pgDc, () => { const e = document.getElementById('syncStatus'); return !!e && !e.hidden && /damaged/i.test(e.textContent); }, null, 9000);
      const dmgTxt = await pgDc.evaluate(() => document.getElementById('syncStatus')?.textContent || '');
      check('R12: control.html says the saved config is damaged (and gives the remedy), not "a fresh install"', dmgC && !/fresh install/.test(dmgTxt) && /Import a backup or re-save/.test(dmgTxt), dmgTxt);
      const dmgM = await wait(pgDm, () => /damaged/i.test(document.getElementById('status')?.textContent || ''), null, 9000);
      const dmgMtxt = await pgDm.evaluate(() => document.getElementById('status')?.textContent || '');
      check('R12: director-min says so too, and stays put past the 5 s "fresh install" message', dmgM && !/fresh install/.test(dmgMtxt), dmgMtxt);
      await sleep(5500);
      check('R12: …still true after the page has waited longer than the "names both causes" timer',
        /damaged/i.test(await pgDm.evaluate(() => document.getElementById('status')?.textContent || '')) && /damaged/i.test(await pgDc.evaluate(() => document.getElementById('syncStatus')?.textContent || '')));
      await pgDc.close(); await pgDm.close(); damaged.prod.close(); damaged.proc.kill();
    }

    // ── R13: the director's roster is trusted only when it is real (GRN-25, 26, 66, 89, 95, 115, 123, 126, 161, 183) ──
    if (!ONLY || ONLY === 'roster') {
      console.log('\n[R13] roster: a cold or partial director, an unrecognised reply, a failover origin, a silent director, duplicate labels');
      const SEED_R = { enabled: true, room: 'rosterroom', password: 'pw1', viewFlags: VIEWFLAGS,
        slots: [slot(1, { label: 'ALPHA', streamID: 'aaa111' }), slot(2, { label: 'BRAVO', streamID: 'bbb222' }), slot(3), slot(4)],
        invite: { passwordMode: 'hash' }, directory: [] };
      const pushPayloads = async (x) => pushesOf(await x.api.actions()).map((a) => { try { return JSON.parse(a.args.payload); } catch { return null; } }).filter(Boolean);
      const blankedBy = (payloads) => payloads.filter((p) => (p.slots[0] && p.slots[0].streamID === '') || (p.slots[1] && p.slots[1].streamID === ''));
      const mockDir = (x, q) => x.api.base + '/mock/vdo-director.html' + q;
      const frameOf = (page) => page.frames().find((f) => /vdo-director/.test(f.url()));
      const guestSrc = (page) => page.evaluate(() => document.getElementById('frame')?.getAttribute('src') || '');

      // (a) A cold start on a director-min reload: its first replies are empty, yet nothing on air goes blank.
      {
        const x = await startExtra({});
        x.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_R) });
        await sleep(300);
        await x.api.clear();
        const guest = await newPage(browser, { width: 640, height: 360 });
        await guest.goto(x.api.base + '/overlay/vdoninja-guest.html?slot=1&sbport=' + x.ws, { waitUntil: 'load' });
        await wait(guest, () => (document.getElementById('frame')?.getAttribute('src') || '').includes('view=aaa111'), null, 8000);
        const min = await newPage(browser, { width: 480, height: 120 }, mockDir(x, '?fixed=1&coldstart=3'));
        await min.goto(x.api.base + '/control/director-min.html?sbport=' + x.ws, { waitUntil: 'load' });
        let wentBlank = false;
        for (let i = 0; i < 40; i++) { if ((await guestSrc(guest)) === 'about:blank') wentBlank = true; await sleep(250); } // 10 s: the three empty replies, then the real roster
        const ps = await pushPayloads(x);
        const sawRoster = await wait(min, () => /2 guest/.test(document.getElementById('status')?.textContent || ''), null, 6000);
        check('R13a: director-min reloaded with resolved IDs and a cold director (3 empty replies): the guest slot never goes to about:blank, no push blanks a slot, and the real roster is then read',
          !wentBlank && blankedBy(ps).length === 0 && sawRoster, JSON.stringify({ wentBlank, blanked: blankedBy(ps).length, sawRoster }));
        await min.close(); await guest.close();
      }
      // (b) A partial roster blanks no label it has not reported (inside the settle window); control.html opened and closed
      // about 2.5 s later while director-min runs leaves the IDs intact.
      {
        const x = await startExtra({});
        x.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_R) });
        await sleep(300);
        await x.api.clear();
        const min = await newPage(browser, { width: 480, height: 120 }, mockDir(x, '?fixed=1&late=ALPHA:60000'));
        await min.goto(x.api.base + '/control/director-min.html?sbport=' + x.ws, { waitUntil: 'load' });
        await wait(min, () => /1 guest/.test(document.getElementById('status')?.textContent || ''), null, 8000); // only BRAVO has been reported
        const ctl = await newPage(browser, { width: 920, height: 1300 }, mockDir(x, '?coldstart=1'));
        await ctl.goto(x.api.base + '/control/control.html?sbport=' + x.ws, { waitUntil: 'load' });
        await sleep(2500);
        await ctl.close();
        await sleep(1500);
        const ps = await pushPayloads(x);
        const st = await x.api.state();
        check('R13b: a partial roster (ALPHA not yet reported) blanks neither ALPHA nor BRAVO, and a control.html opened and closed ~2.5 s later changes no stream ID in vdo.state',
          blankedBy(ps).length === 0 && st.vdo && st.vdo.slots[0].streamID === 'aaa111' && st.vdo.slots[1].streamID === 'bbb222', JSON.stringify({ blanked: blankedBy(ps).length, ids: st.vdo && st.vdo.slots.map((q) => q.streamID) }));
        await min.close();
      }
      // (c) An unrecognised reply (renamed fields) leaves resolved slots alone and says so; hasRoster does not flip.
      {
        const x = await startExtra({});
        x.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_R) });
        await sleep(300);
        await x.api.clear();
        const ctl = await newPage(browser, { width: 920, height: 1300 }, mockDir(x, '?renamed=1'));
        await ctl.goto(x.api.base + '/control/control.html?sbport=' + x.ws, { waitUntil: 'load' });
        const said = await wait(ctl, () => /reply unrecognised/.test(document.getElementById('vdoStatus')?.textContent || ''), null, 9000);
        await sleep(3000);
        const ps = await pushPayloads(x);
        const st = await x.api.state();
        check('R13c: a director reply with renamed fields is reported ("reply unrecognised"), pushes nothing, and leaves every resolved slot as it was',
          said && ps.length === 0 && st.vdo.slots[0].streamID === 'aaa111', JSON.stringify({ said, pushes: ps.length }));
        await ctl.close();
      }
      // (d) The failover origin: a director page that answers from another origin is heard once that origin is allowed.
      {
        const x = await startExtra({});
        x.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_R) });
        await sleep(300);
        const other = 'http://localhost:' + x.http;
        const dirUrl = mockDir(x, '?fixed=1&failover=1');
        const heard = async (allow) => {
          const p = await newPage(browser, { width: 920, height: 1300 }, dirUrl);
          if (allow) await p.addInitScript('window.__VDO_DIRECTOR_EXTRA_ORIGINS = ' + JSON.stringify([other]) + ';');
          await p.goto(x.api.base + '/control/control.html?sbport=' + x.ws, { waitUntil: 'load' });
          const ok = await wait(p, () => /connected · 2 guests/.test(document.getElementById('vdoStatus')?.textContent || ''), null, 9000);
          await p.close();
          return ok;
        };
        const without = await heard(false);
        const withIt = await heard(true);
        check('R13d: a reply from a second origin (the failover case) is ignored until that origin is allowed, then the pill reaches "connected"', !without && withIt, JSON.stringify({ without, withIt }));
      }
      // (e) A silent director: the first request fails, later ones work: the page says so, reloads the frame once, and reaches connected, never blanking a slot.
      {
        const x = await startExtra({});
        x.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_R) });
        await sleep(300);
        await x.api.clear();
        const p = await newPage(browser, { width: 920, height: 1300 }, mockDir(x, '?fixed=1'));
        await p.addInitScript('window.__VDO_DIRECTOR_TIMING = { silentMs: 2500, retryAfterMs: 4500, backoffMs: [4000, 8000], hintMs: 2000 };');
        let dirRequests = 0;
        await p.route(/\/mock\/vdo-director\.html/, (route) => { dirRequests++; if (dirRequests === 1) route.abort(); else route.continue(); });
        await p.goto(x.api.base + '/control/control.html?sbport=' + x.ws, { waitUntil: 'load' });
        const saidSilent = await wait(p, () => /not responding/.test(document.getElementById('vdoStatus')?.textContent || ''), null, 9000);
        const connected = await wait(p, () => /connected · 2 guests/.test(document.getElementById('vdoStatus')?.textContent || ''), null, 15000);
        const ps = await pushPayloads(x);
        check('R13e: a director whose first request fails: the pill says "not responding", the frame is reloaded (a second request), the pill reaches "connected", and no push blanks a slot',
          saidSilent && connected && dirRequests >= 2 && blankedBy(ps).length === 0, JSON.stringify({ saidSilent, connected, dirRequests, blanked: blankedBy(ps).length }));
        await p.close();
      }
      // (f) An empty label carries no stream; a label shared by two guests is sticky and fails closed (GRN-123, GRN-26, GRN-126).
      {
        const x = await startExtra({});
        x.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_R) });
        await sleep(300);
        const ctl = await newPage(browser, { width: 920, height: 1300 }, mockDir(x, '?fixed=1'));
        await ctl.goto(x.api.base + '/control/control.html?sbport=' + x.ws, { waitUntil: 'load' });
        await wait(ctl, () => /connected · 2 guests/.test(document.getElementById('vdoStatus')?.textContent || ''), null, 9000);
        const setRoster = async (gl) => { const f = frameOf(ctl); await f.evaluate((g) => window.__setRoster(g), gl); };
        const lastSlot = async (n) => { const ps = await pushPayloads(x); const q = await x.api.state(); return q.vdo && q.vdo.slots[n].streamID; };
        const D = { 0: { streamID: 'dIrEcToR00', label: '' } };
        await x.api.clear();
        await setRoster({ ...D, 1: { streamID: 'aaa111', label: 'ALPHA' }, 2: { streamID: 'zzz999', label: 'ALPHA' }, 3: { streamID: 'bbb222', label: 'BRAVO' } });
        await sleep(3500);
        const keepsPrev = (await lastSlot(0)) === 'aaa111';
        const warned = await ctl.evaluate(() => /2 streams!/.test(document.getElementById('vdoSlots')?.textContent || ''));
        await setRoster({ ...D, 1: { streamID: 'zzz999', label: 'ALPHA' }, 2: { streamID: 'yyy888', label: 'ALPHA' }, 3: { streamID: 'bbb222', label: 'BRAVO' } });
        await sleep(3500);
        const failsClosed = (await lastSlot(0)) === '';
        await setRoster({ ...D, 1: { streamID: 'aaa333', label: 'ALPHA' }, 3: { streamID: 'bbb222', label: 'BRAVO' } });
        await sleep(3500);
        const rejoins = (await lastSlot(0)) === 'aaa333';
        check('R13f: a label two guests share keeps the stream it had (and shows "2 streams!"), goes empty when that stream is not among them, and a unique label follows a rejoin',
          keepsPrev && warned && failsClosed && rejoins, JSON.stringify({ keepsPrev, warned, failsClosed, rejoins }));
        // clearing the label empties the slot: the persisted stream ID is '' and the overlay goes blank
        await ctl.selectOption('#vdoSlots .vdo-slot-row[data-slot="2"] .vdo-label-sel', '');
        await sleep(3500);
        check('R13g: choosing "none" for a slot persists an EMPTY stream ID for it (an empty label never keeps a stream)', (await lastSlot(1)) === '', String(await lastSlot(1)));
        await ctl.close();
      }
      // (g) An insecure page does not start a director that can never answer (GRN-161).
      {
        const x = await startExtra({});
        x.prod.doAction('VDO Push', { payload: JSON.stringify(SEED_R) });
        await sleep(300);
        const p = await newPage(browser, { width: 920, height: 1300 }, mockDir(x, '?fixed=1'));
        await p.addInitScript('Object.defineProperty(window, "isSecureContext", { value: false });');
        await p.goto(x.api.base + '/control/control.html?sbport=' + x.ws, { waitUntil: 'load' });
        await wait(p, () => document.getElementById('vdoRoom')?.value === 'rosterroom', null, 8000);
        await sleep(3500);
        const st = await p.evaluate(() => ({ pill: document.getElementById('vdoStatus')?.textContent || '', frame: document.getElementById('vdoDirector')?.getAttribute('src') || '', warn: !document.getElementById('cryptoWarn')?.hidden }));
        check('R13h: on a page that is not a secure context the director is NOT started (the frame stays blank, the pill says why) and the banner shows', /secure page/i.test(st.pill) && /about:blank|^$/.test(st.frame) && st.warn, JSON.stringify(st));
        await p.close();
      }
    }

    console.log('  screenshots → roster-check.png, control-check.png, nameplate-check.png');
  } catch (err) {
    failed++;
    console.log('\n  ERROR ' + ((err && err.stack) || err));
  } finally {
    if (prod) prod.close();
    if (browser) { try { await browser.close(); } catch {} }
    if (bridge) bridge.kill();
    if (mock) mock.kill();
    for (const p of extraProds) { try { p.close(); } catch {} }
    for (const m of extra) { try { m.kill(); } catch {} }
    if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch {} }
  }

  console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
