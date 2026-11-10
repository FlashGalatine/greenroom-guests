// Greenroom Streamer.bot transport — loaded by every Greenroom overlay page
// (vdoninja-guest.html, nameplate.html, discord-roster.html). Raw browser WebSocket, no
// @streamerbot/client and no CDN dependency, so it works offline inside OBS's CEF.
//
// It subscribes to General.Custom events and re-emits every broadcast whose
// `data.type` is set as the same window `svc:message` CustomEvent the overlays
// consume — the render code doesn't know which transport delivered it. A state
// field may arrive as the object the overlays read (`vdoninja`, `discordVoice`) or as
// an escaped string beside it (`vdoninjaJson`, `discordVoiceJson`); the string form
// is parsed here, and a frame whose string does not parse to a plain object is dropped
// rather than dispatched (the overlays would read the missing object as "clear").
//
// The socket is opened only once the DOM is ready, so the overlays' end-of-body
// `svc:message` listeners exist before the first state replay arrives.
//
// Streamer.bot has no state-on-connect replay, so after the Subscribe is
// acknowledged we fire a DoAction naming the sync action ("VDO Sync"), which
// re-broadcasts both cached state blobs (vdoninja + discordVoice) — an overlay
// added mid-stream paints immediately instead of staying blank. If no vdoninja state
// has arrived 2.5 s later the request is repeated once.
//
// A non-ok reply to the Subscribe puts the overlay in its offline state and warns on the
// console; a refused sync request does the same until live frames arrive. A Hello frame that
// carries an authentication block is only a hint (Streamer.bot sends it whenever Authentication
// is on, and serves requests anyway unless Enforce is on): if requests are then refused, or the
// socket is closed, the warning names authentication as the likely cause. On close the window
// gets a `svc:disconnect` event so an overlay can drop live-only state.
//
// Config knobs (set before this script loads, or — only when served over http://
// — via URL query; file:// OBS sources cannot take query params):
//   window.__SB_WS_URL      — Streamer.bot WebSocket Server URL (default ws://127.0.0.1:8080/)
//   ?sbport=<n>             — the port (1-65535) of ws://127.0.0.1:<n>/  (http:// sources only);
//                             anything else is refused: no connection, offline state, console error
//   window.__SB_SYNC_ACTION — SB action to DoAction on connect (default 'VDO Sync'; '' to skip)
//   window.__SB_DEBUG / ?sbdebug=1 — log the connection + message flow to the console.

(function () {
  'use strict';

  // <sb-conn> — the connection helpers. The SAME text is in overlay/panel-client-sb.js,
  // control/control.html and control/director-min.html (they sit behind different Streamer.bot
  // folder maps and cannot share a file); verify.mjs fails if the three copies differ.
  const SB_DEFAULT_PORT = 8080;
  // ?sbport -> the WebSocket URL. Only a port can come from the page URL: the host is always
  // 127.0.0.1. Returns null when ?sbport is present but is not a whole number from 1 to 65535.
  function sbWsUrl(search) {
    const raw = new URLSearchParams(search).get('sbport');
    const u = new URL('ws://127.0.0.1:' + SB_DEFAULT_PORT + '/');
    if (raw === null) return u.href;
    if (!/^\d{1,5}$/.test(raw)) return null;
    const port = Number(raw);
    if (port < 1 || port > 65535) return null;
    u.port = String(port);
    return u.href;
  }
  // The ?sbport to copy into an OBS source URL: the validated port, or '' when absent or invalid.
  function sbPortParam(search) {
    const raw = new URLSearchParams(search).get('sbport');
    return raw !== null && sbWsUrl(search) !== null ? String(Number(raw)) : '';
  }
  // Reconnect delay: 1 s, then x1.5 up to 4 s. Call reset() only after a healthy session (a valid
  // Subscribe ack or a General.Custom message), not on open, so a server that accepts and then
  // drops still reaches the cap.
  function sbBackoff() {
    const BASE_MS = 1000, MAX_MS = 4000, FACTOR = 1.5;
    let delay = BASE_MS;
    return {
      next() { const d = delay; delay = Math.min(delay * FACTOR, MAX_MS); return d; },
      reset() { delay = BASE_MS; },
    };
  }
  // ?sbpass -> the Streamer.bot WebSocket password for Authentication ('' when absent). It lives in the page URL (OBS keeps it in the scene
  // collection) and nowhere else: it is never logged, sent on the bus, or copied into any address except an OBS source or dock URL.
  function sbPassParam(search) {
    const raw = new URLSearchParams(search).get('sbpass');
    return raw === null ? '' : raw;
  }
  // base64(sha256(text)) with subtle crypto (a page served from 127.0.0.1 is a secure context). Rejects where subtle crypto is missing.
  async function sbB64Sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    let bin = '';
    for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  // The value of an Authenticate request: b64(sha256(b64(sha256(password + salt)) + challenge)).
  async function sbAuthValue(password, salt, challenge) {
    return sbB64Sha256((await sbB64Sha256(password + salt)) + challenge);
  }
  // The authentication block of a Hello (salt and challenge), or null when there is none.
  function sbHelloAuth(m) {
    const a = m && m.authentication;
    return a && typeof a === 'object' && typeof a.salt === 'string' && typeof a.challenge === 'string' ? a : null;
  }
  const SB_HELLO_WAIT_MS = 1000; // how long a page waits for Streamer.bot's Hello before it carries on as it always has
  // </sb-conn>
  const WS_URL = window.__SB_WS_URL || sbWsUrl(location.search);
  const SYNC_ACTION = (typeof window.__SB_SYNC_ACTION === 'string')
    ? window.__SB_SYNC_ACTION
    : 'VDO Sync';
  const DEBUG = /[?&]sbdebug=1/.test(location.search) || !!window.__SB_DEBUG;
  const SYNC_FALLBACK_MS = 400; // sync anyway if the Subscribe is never answered
  const RESYNC_MS = 2500;       // one repeat if no vdoninja state has arrived by then
  const SB_PASS = sbPassParam(location.search);
  const MSG_AUTH = "SB auth enforced — turn Enforce off, or add ?sbpass=<password> to this source's address";
  const MSG_BADPASS = "SB password refused — check ?sbpass in this source's address";
  const MSG_NOCRYPTO = 'SB password cannot be used here: open the page via http://127.0.0.1 (subtle crypto is unavailable)';

  let ws = null;
  let msgId = 0;
  let reconnectTimer = null;
  const backoff = sbBackoff();

  function log(...args) { if (DEBUG) console.log('[panel-client-sb]', ...args); }
  function warn(...args) { console.warn('[panel-client-sb]', ...args); }

  function setOffline(isOffline) {
    if (document.body) document.body.classList.toggle('offline', isOffline);
    const root = document.querySelector('#stage, .panel');
    if (root) root.classList.toggle('offline', isOffline);
  }

  // State fields that may arrive as an escaped string: [string field, object field].
  const STATE_FIELDS = [['vdoninjaJson', 'vdoninja'], ['discordVoiceJson', 'discordVoice']];
  // The frame to dispatch, or null to drop it. A string field that is not a string, throws in
  // JSON.parse, or does not parse to a plain object drops the whole frame.
  function readFrame(d) {
    const out = {};
    for (const k of Object.keys(d)) if (k !== '__proto__') out[k] = d[k];
    for (const [jsonKey, objKey] of STATE_FIELDS) {
      if (!(jsonKey in out)) continue;
      let v = null;
      if (typeof out[jsonKey] === 'string') { try { v = JSON.parse(out[jsonKey]); } catch { v = null; } }
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        warn(d.type + ': ' + jsonKey + ' is not a JSON object — frame dropped');
        return null;
      }
      out[objKey] = v;
      delete out[jsonKey];
    }
    return out;
  }

  const refusal = (m) => String(m.error || m.message || m.status);
  const isRefusal = (m) => typeof m.status === 'string' && m.status !== 'ok';

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(connect, backoff.next());
  }

  function connect() {
    reconnectTimer = null;
    log('connecting to', WS_URL);
    let sock;
    try { sock = new WebSocket(WS_URL); }
    catch (err) {
      warn('cannot open', WS_URL, '—', String((err && err.message) || err));
      setOffline(true);
      scheduleReconnect();
      return;
    }
    ws = sock; // every handler below acts on its own socket, never on a later one

    let subId = null;
    let syncFired = false;
    let syncTimer = null;
    let resyncTimer = null;
    let sawVdo = false;
    let healthy = false;
    let subRefused = false;    // this socket's Subscribe was refused: nothing more is asked of it
    let authHello = false;     // this socket's Hello carried an authentication block
    let helloTimer = null;     // waiting for Streamer.bot's Hello
    let started = false;       // the session began: the Subscribe has gone out (or is not going to)
    let authId = null;         // the id of this socket's Authenticate request
    let authRefused = false;   // the Authenticate was refused: nothing more is asked of this socket
    let syncRefusedGrey = false; // greyed because the sync request was refused, until live frames arrive
    let syncRefused = false;     // the sync request was refused: asking again would only be refused again
    const syncIds = new Set();

    function send(obj) {
      if (sock.readyState !== WebSocket.OPEN) return false;
      sock.send(JSON.stringify(obj));
      return true;
    }

    function requestSync(reason) {
      const id = String(++msgId);
      if (send({ request: 'DoAction', id, action: { name: SYNC_ACTION }, args: { reason } })) syncIds.add(id);
    }

    function fireSync() {
      if (syncFired) return;
      syncFired = true;
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
      if (!SYNC_ACTION) return;
      log('requesting state via DoAction', JSON.stringify(SYNC_ACTION));
      requestSync('overlay-connect');
      // Second safeguard: one repeat if no vdoninja state has come back (a lost replay).
      resyncTimer = setTimeout(() => {
        resyncTimer = null;
        if (sawVdo || subRefused || syncRefused || ws !== sock) return;
        log('no vdoninja state yet — requesting it once more');
        requestSync('overlay-resync');
      }, RESYNC_MS);
    }

    // The session proper: the Subscribe, then (once it is acknowledged) the sync. It starts when Streamer.bot's Hello says nothing about a
    // password, when this page has no password to give, when Hello does not come within a second (as before), or after an Authenticate was
    // acknowledged ok.
    function startSession() {
      if (started || sock.readyState !== WebSocket.OPEN) return;
      started = true;
      if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
      // The event-SOURCE key is LOWERCASE ('general') in the Subscribe request,
      // even though delivered events carry a capitalized source ('General'). Per
      // https://docs.streamer.bot/api/websocket/requests
      subId = String(++msgId);
      send({ request: 'Subscribe', id: subId, events: { general: ['Custom'] } });
      log('sent Subscribe (id', subId + '); waiting for ack before sync');
      syncTimer = setTimeout(fireSync, SYNC_FALLBACK_MS);
    }

    // Streamer.bot's Authentication is on and this page has a password: answer the challenge (the password itself never leaves the page).
    function authenticate(block) {
      authId = String(++msgId);
      const id = authId;
      sbAuthValue(SB_PASS, block.salt, block.challenge).then((value) => {
        if (ws !== sock || started || authRefused) return;
        send({ request: 'Authenticate', id, authentication: value });
        log('sent Authenticate (id', id + ')');
      }, () => {
        if (ws !== sock) return;
        authRefused = true;
        warn(MSG_NOCRYPTO);
        setOffline(true);
      });
    }

    sock.onopen = () => {
      setOffline(false);
      // Streamer.bot greets every connection with a Hello; wait a second for it, then carry on as always (a server that says nothing).
      helloTimer = setTimeout(() => { helloTimer = null; startSession(); }, SB_HELLO_WAIT_MS);
    };

    sock.onmessage = (evt) => {
      let m;
      try { m = JSON.parse(evt.data); } catch { return; }
      if (!m || typeof m !== 'object') return;

      // Streamer.bot's Hello. An authentication block only means Authentication is switched on: with
      // Enforce off Streamer.bot still serves every request, so this is a hint, not a fault. If the
      // requests are then refused, or the socket is closed, it is the likely reason and is named.
      if (m.request === 'Hello') {
        authHello = !!(m.authentication && typeof m.authentication === 'object');
        if (authHello) log('Hello carries an authentication block');
        if (started || authId) return;
        if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
        const block = sbHelloAuth(m);
        if (block && SB_PASS) authenticate(block); // the session starts when the Authenticate is acknowledged
        else startSession(); // no password to give, or none asked for: as before (a refused Subscribe names authentication)
        return;
      }

      if (m.id && !m.event) {
        if (m.id === authId) {
          authId = null;
          if (isRefusal(m)) { authRefused = true; warn(MSG_BADPASS); setOffline(true); }
          else { log('Authenticate acknowledged'); startSession(); }
          return;
        }
        if (m.id === subId) {
          if (isRefusal(m)) {
            warn(authHello ? MSG_AUTH : 'Subscribe refused: ' + refusal(m));
            if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
            if (resyncTimer) { clearTimeout(resyncTimer); resyncTimer = null; }
            syncFired = true; // no sync without an accepted Subscribe
            subRefused = true;
            setOffline(true);
          } else {
            if (!m.status) log('Subscribe ack carried no status field');
            healthy = healthy || (backoff.reset(), true);
            fireSync();
          }
          return;
        }
        if (syncIds.has(m.id)) {
          syncIds.delete(m.id);
          // (a refusal of a sync request that arrives after the state has: moot, ignored)
          if (isRefusal(m) && !sawVdo) {
            // Authentication is the likely cause only while this socket has not been served: an accepted
            // Subscribe already shows Enforce is off, so a refusal after it is something else (a missing action).
            warn(authHello && !healthy ? MSG_AUTH : 'DoAction "' + SYNC_ACTION + '" refused: ' + refusal(m));
            // Greyed only until live frames show the subscription works (a missing action must not
            // leave a working overlay greyed out for the whole session), and not asked again.
            syncRefusedGrey = true;
            syncRefused = true;
            if (resyncTimer) { clearTimeout(resyncTimer); resyncTimer = null; }
            setOffline(true);
          }
          return;
        }
      }

      if (m.event && m.event.source === 'General' && m.event.type === 'Custom') {
        healthy = healthy || (backoff.reset(), true);
        if (syncRefusedGrey) { syncRefusedGrey = false; setOffline(false); }
        let d = m.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
        if (!d || typeof d !== 'object' || Array.isArray(d) || !d.type) { log('General.Custom with no data.type — ignored'); return; }
        const frame = readFrame(d);
        if (!frame) return;
        if (frame.type === 'vdoninja:update' || frame.type === 'vdo:sync:empty'
            || (frame.type === 'sync' && frame.vdoninja !== undefined)) {
          sawVdo = true;
          if (resyncTimer) { clearTimeout(resyncTimer); resyncTimer = null; }
        }
        log('General.Custom →', frame.type);
        window.dispatchEvent(new CustomEvent('svc:message', { detail: frame }));
        return;
      }

      log('other message:', m.request || m.status || (m.event && (m.event.source + '.' + m.event.type)) || '?');
    };

    sock.onclose = () => {
      // A close before the fallback timer must not leave a sync behind to fire later.
      if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
      if (resyncTimer) { clearTimeout(resyncTimer); resyncTimer = null; }
      syncFired = true;
      if (ws !== sock) return;
      if (authHello && !healthy) warn(MSG_AUTH); // hung up on after an authentication Hello
      setOffline(true);
      window.dispatchEvent(new CustomEvent('svc:disconnect'));
      log('connection closed; reconnecting');
      scheduleReconnect();
    };

    sock.onerror = () => {
      log('WebSocket error — is SB\'s WebSocket Server enabled on', WS_URL, 'with authentication OFF?');
    };
  }

  // Connect only once the DOM is ready: the overlays attach their `svc:message` listeners in an
  // end-of-body script, and a replay that arrives before that would be lost. setOffline(true) is
  // part of boot, so it can never run after (and undo) the socket's own setOffline(false).
  function boot() {
    setOffline(true);
    if (!WS_URL) {
      console.error('[panel-client-sb] invalid ?sbport ' + JSON.stringify(q.get('sbport'))
        + ': use a port number from 1 to 65535. Not connecting.');
      return;
    }
    connect();
  }
  const q = (() => { try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(''); } })();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
