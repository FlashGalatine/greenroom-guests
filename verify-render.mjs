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
//   npm install --no-save playwright-core
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
function startChild(script, readyText, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [script], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SB_HTTP_PORT: String(opts.httpPort || HTTP_PORT), SB_WS_PORT: String(opts.wsPort || WS_PORT), ...(opts.env || {}) },
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
    mock = await startChild('mock-sb-server.mjs', '[mock] WS');
    console.log(`mock SB up (:${HTTP_PORT} HTTP, :${WS_PORT} WS)\n`);
    browser = await launch();
    prod = await producer();

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
        let m;
        try { m = await startChild('mock-sb-server.mjs', '[mock] WS', { httpPort, wsPort, env }); }
        catch (e) { lastErr = e; continue; }
        extra.push(m);
        const prod = await producer(wsPort);
        extraProds.push(prod);
        return { api: mockApi(httpPort), prod, proc: m, http: httpPort, ws: wsPort };
      }
      throw lastErr;
    };
    const pushesOf = (acts) => acts.filter((a) => a.name === 'VDO Push');
    const MSG_REPLACE = /has not returned your saved config/;

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
    const fresh = await startExtra({});
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

    // R7d: the empty-cache marker (a later action release broadcasts it) is read as "synced".
    const marker = await startExtra({ SB_EMPTY_MARKER: '1' });
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
    // R8a: state arriving as vdoninjaJson (an escaped string), as the actions will send it.
    const wire = await startExtra({ SB_WIRE: 'json' });
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
    await fresh.api.broadcast({ type: 'vdo:error', message: 'Streamer.bot could not parse the payload' });
    const namedPill = await wait(pgY, (n) => (document.getElementById('sbStatus')?.textContent || '').includes(n), DATE_LABEL, 4000);
    check('R8c: the vdo:error pill names the date-shaped directory entry', namedPill,
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
