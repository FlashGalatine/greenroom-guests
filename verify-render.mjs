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
//        VDO Push, USE on a favorite fires set-current, live status pill.
//
// Requires a Chromium channel on the machine (system Edge/Chrome):
//   npm install --no-save playwright-core
// External hosts (vdo.ninja, Discord CDN) are route-blocked — we assert iframe/img
// URL assembly and classes, never remote content. Screenshots (gitignored):
// roster-check.png, control-check.png.

import { spawn } from 'node:child_process';
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

function startChild(script, readyText) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [script], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SB_HTTP_PORT: String(HTTP_PORT), SB_WS_PORT: String(WS_PORT) },
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
function producer() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/`);
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

const SEED_VDO = {
  enabled: true, room: 'testroom', password: 'pw1', viewFlags: VIEWFLAGS,
  slots: [slot(1, { label: 'ALPHA' }), slot(2, { label: 'BRAVO' }), slot(3), slot(4)],
  invite: { passwordMode: 'hash' },
};
const DISCORD_SLOT_VDO = {
  enabled: true, room: 'testroom', password: 'pw1', viewFlags: VIEWFLAGS,
  slots: [slot(1, { mode: 'discord', discordUserId: STREAMER }), slot(2, { label: 'BRAVO' }), slot(3), slot(4)],
  invite: { passwordMode: 'hash' },
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
  if (withDirectorHook) await page.addInitScript(`window.__VDO_DIRECTOR_URL = ${JSON.stringify(MOCK_DIRECTOR)};`);
  return page;
}

const wait = (page, fn, arg, ms) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);

async function main() {
  console.log('Greenroom — real-pixel render verification\n');
  let mock, bridge, browser, prod;
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

    const wentBlank = await wait(guestPage, () => (document.getElementById('frame')?.getAttribute('src') || '') === 'about:blank', null, 15000);
    check('ALPHA leaves → slot 1 blanks (no stale view URL)', wentBlank,
      await guestPage.evaluate(() => document.getElementById('frame')?.getAttribute('src')));

    const swapped = await wait(guestPage, () => (document.getElementById('frame')?.getAttribute('src') || '').includes('view=aaa333'), null, 20000);
    check('ALPHA REJOINS with a new streamID → slot 1 auto-follows to aaa333', swapped,
      await guestPage.evaluate(() => document.getElementById('frame')?.getAttribute('src')));

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
    const label = await rosterPage.evaluate(() => document.querySelector(`.member[data-uid="${'110457699291906048'}"] .name`)?.textContent);
    check("name labels render ('Ashe')", label === 'Ashe', label);
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

    await ctrlPage.screenshot({ path: resolve(__dirname, 'control-check.png'), fullPage: true });
    console.log('  screenshots → roster-check.png, control-check.png');
    await ctrlPage.close();
  } catch (err) {
    failed++;
    console.log('\n  ERROR ' + ((err && err.stack) || err));
  } finally {
    if (prod) prod.close();
    if (browser) { try { await browser.close(); } catch {} }
    if (bridge) bridge.kill();
    if (mock) mock.kill();
  }

  console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
