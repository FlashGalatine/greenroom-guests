// Screenshot generator for docs/ — spawns the mock SB server, stages a lively
// state (3-user voice channel, one speaking, favorites, a bound guest slot), and
// captures the roster overlay (row + grid) and the control page at 2× scale.
// Run: npm run shots   (requires playwright-core: npm install --no-save playwright-core)

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DOCS = resolve(ROOT, 'docs');
const HTTP_PORT = Number(process.env.SB_HTTP_PORT) || 7477;
const WS_PORT = Number(process.env.SB_WS_PORT) || 8083;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

const STREAMER = '110457699291906048';
const embed = (n) => `https://cdn.discordapp.com/embed/avatars/${n}.png`;

function startMock() {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['mock-sb-server.mjs'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SB_HTTP_PORT: String(HTTP_PORT), SB_WS_PORT: String(WS_PORT) },
    });
    let out = '';
    const t = setTimeout(() => rej(new Error('mock no start\n' + out)), 8000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; if (out.includes('[mock] WS')) { clearTimeout(t); res(child); } });
    child.stderr.on('data', () => {});
  });
}

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

async function main() {
  let mock, browser, prod;
  try {
    mock = await startMock();
    browser = await (async () => {
      for (const ch of ['msedge', 'chrome']) { try { return await chromium.launch({ channel: ch, headless: true }); } catch {} }
      return chromium.launch({ headless: true });
    })();
    prod = await producer();

    prod.doAction('VDO Push', { payload: JSON.stringify({
      enabled: true, room: 'greenroom-demo', password: 'demo',
      viewFlags: '&solo&hidescreenshare&rounded=0&tallyoff&fadein&codec=h264&cleanish',
      slots: [
        { slot: 1, label: 'ALPHA', streamID: 'demo0001', mirror: false, mode: 'webcam', discordUserId: '' },
        { slot: 2, label: 'BRAVO', streamID: 'demo0002', mirror: true, mode: 'webcam', discordUserId: '' },
        { slot: 3, label: '', streamID: '', mirror: false, mode: 'discord', discordUserId: STREAMER },
        { slot: 4, label: '', streamID: '', mirror: false, mode: 'webcam', discordUserId: '' },
      ],
      invite: { passwordMode: 'hash' },
    }) });
    prod.doAction('Discord Voice Push', { payload: JSON.stringify({
      channelId: '222', connected: true, hostInChannel: true,
      users: {
        [STREAMER]: { speaking: true, username: 'Ashe', avatarUrl: embed(1), mute: false, deaf: false },
        '200000000000000001': { speaking: false, username: 'Guest One', avatarUrl: embed(2), mute: true, deaf: false },
        '200000000000000002': { speaking: false, username: 'Guest Two', avatarUrl: embed(3), mute: false, deaf: true },
      },
      settings: { streamerUserId: STREAMER, avatarPx: 56, streamerPx: 72, accent: 'cyan', scanlines: true, neonBlink: true, hideWhenAbsent: true },
      rpc: { enabled: true, hasToken: true, error: null },
      favorites: [
        { id: 'f1', name: 'Commentary', serverId: '259501535484968970', channelId: '222' },
        { id: 'f2', name: 'Lobby Night', serverId: '259501535484968970', channelId: '333' },
      ],
      current: { serverId: '259501535484968970', channelId: '222' },
    }) });

    const shoot = async (url, viewport, file, settleMs = 1200, fullPage = false) => {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
      await page.route(/vdo\.ninja/, (r) => r.abort()); // keep shots offline (avatars still load from Discord CDN)
      await page.goto(url, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await new Promise((r) => setTimeout(r, settleMs));
      await page.screenshot({ path: resolve(DOCS, file), fullPage });
      await page.close();
      console.log('  docs/' + file);
    };

    await shoot(`${BASE}/overlay/discord-roster.html?layout=row&sbport=${WS_PORT}`, { width: 460, height: 150 }, 'roster-row.png');
    await shoot(`${BASE}/overlay/discord-roster.html?layout=grid&theme=plain&sbport=${WS_PORT}`, { width: 340, height: 240 }, 'roster-grid-plain.png');
    await shoot(`${BASE}/control/control.html?sbport=${WS_PORT}`, { width: 920, height: 1200 }, 'control-page.png', 1600, true);
  } finally {
    if (prod) prod.close();
    if (browser) { try { await browser.close(); } catch {} }
    if (mock) mock.kill();
  }
}

main();
