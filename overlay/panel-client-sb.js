// Greenroom Streamer.bot transport — loaded by every Greenroom overlay page
// (vdoninja-guest.html, discord-roster.html). Raw browser WebSocket, no
// @streamerbot/client and no CDN dependency, so it works offline inside OBS's CEF.
//
// It subscribes to General.Custom events and re-emits every broadcast whose
// `data.type` is set as the same window `svc:message` CustomEvent the overlays
// consume — the render code doesn't know which transport delivered it.
//
// Streamer.bot has no state-on-connect replay, so after the Subscribe is
// acknowledged we fire a DoAction naming the sync action ("VDO Sync"), which
// re-broadcasts both cached state blobs (vdoninja + discordVoice) — an overlay
// added mid-stream paints immediately instead of staying blank.
//
// Config knobs (set before this script loads, or — only when served over http://
// — via URL query; file:// OBS sources cannot take query params):
//   window.__SB_WS_URL      — Streamer.bot WebSocket Server URL (default ws://127.0.0.1:8080/)
//   ?sbport=<n>             — shorthand for ws://127.0.0.1:<n>/  (http:// sources only)
//   window.__SB_SYNC_ACTION — SB action to DoAction on connect (default 'VDO Sync'; '' to skip)
//   window.__SB_DEBUG / ?sbdebug=1 — log the connection + message flow to the console.

(function () {
  'use strict';

  const q = (() => { try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(''); } })();
  const WS_URL = window.__SB_WS_URL
    || (q.get('sbport') ? `ws://127.0.0.1:${q.get('sbport')}/` : 'ws://127.0.0.1:8080/');
  const SYNC_ACTION = (typeof window.__SB_SYNC_ACTION === 'string')
    ? window.__SB_SYNC_ACTION
    : 'VDO Sync';
  const DEBUG = /[?&]sbdebug=1/.test(location.search) || !!window.__SB_DEBUG;
  const RECONNECT_BASE_MS = 2000;
  const RECONNECT_MAX_MS = 15000;
  const SYNC_FALLBACK_MS = 400;

  let ws = null;
  let reconnectDelay = RECONNECT_BASE_MS;
  let msgId = 0;

  function log(...args) { if (DEBUG) console.log('[panel-client-sb]', ...args); }

  function setOffline(isOffline) {
    if (document.body) document.body.classList.toggle('offline', isOffline);
    const root = document.querySelector('#stage, .panel');
    if (root) root.classList.toggle('offline', isOffline);
  }

  function connect() {
    log('connecting to', WS_URL);
    ws = new WebSocket(WS_URL);

    let subId = null;
    let syncFired = false;
    let syncTimer = null;

    function fireSync() {
      if (syncFired) return;
      syncFired = true;
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
      if (!SYNC_ACTION) return;
      log('requesting state via DoAction', JSON.stringify(SYNC_ACTION));
      ws.send(JSON.stringify({
        request: 'DoAction',
        id: String(++msgId),
        action: { name: SYNC_ACTION },
        args: { reason: 'overlay-connect' },
      }));
    }

    ws.onopen = () => {
      reconnectDelay = RECONNECT_BASE_MS;
      setOffline(false);

      // The event-SOURCE key is LOWERCASE ('general') in the Subscribe request,
      // even though delivered events carry a capitalized source ('General'). Per
      // https://docs.streamer.bot/api/websocket/requests
      subId = String(++msgId);
      ws.send(JSON.stringify({ request: 'Subscribe', id: subId, events: { general: ['Custom'] } }));
      log('sent Subscribe (id', subId + '); waiting for ack before sync');
      syncTimer = setTimeout(fireSync, SYNC_FALLBACK_MS);
    };

    ws.onmessage = (evt) => {
      let m;
      try { m = JSON.parse(evt.data); } catch { return; }

      if (m && m.id && m.id === subId && !m.event) {
        log('Subscribe ack:', m.status || '(no status field)');
        fireSync();
        return;
      }

      if (m && m.event && m.event.source === 'General' && m.event.type === 'Custom') {
        let d = m.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch { /* leave as string */ } }
        if (!d || typeof d !== 'object' || !d.type) { log('General.Custom with no data.type — ignored'); return; }
        log('General.Custom →', d.type);
        window.dispatchEvent(new CustomEvent('svc:message', { detail: d }));
        return;
      }

      log('other message:', (m && (m.request || m.status || (m.event && (m.event.source + '.' + m.event.type)))) || '?');
    };

    ws.onclose = () => {
      setOffline(true);
      log('connection closed; reconnecting');
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS);
        connect();
      }, reconnectDelay);
    };

    ws.onerror = () => {
      log('WebSocket error — is SB\'s WebSocket Server enabled on', WS_URL, 'with authentication OFF?');
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setOffline(true));
  } else {
    setOffline(true);
  }
  connect();
})();
