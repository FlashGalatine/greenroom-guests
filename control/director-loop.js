// Greenroom director loop — the ONE place that talks to the hidden vdo.ninja director iframe, shared by control.html
// and director-min.html (both load it from this folder). It owns:
//   • the poll: a tick from a dedicated Web Worker (a hidden or throttled page keeps polling every 2.5 s; it falls back
//     to setInterval where Workers are unavailable), posted to the frame with targetOrigin '*' (the body holds no secret)
//   • who may answer: only the iframe's own window, from the director's origin, the cdn-backup failover origin, or an
//     origin a test adds (window.__VDO_DIRECTOR_EXTRA_ORIGINS)
//   • whether a reply is understood (VdoParse.guestListOk), so a renamed field never reads as "an empty room"
//   • liveness: after about 3 polls of silence it says so (hooks.silent: the page stops treating its roster as current,
//     keeping the last resolved stream IDs); after about 25 s it reloads the frame (via about:blank) with a 30 s, 60 s,
//     then 120 s backoff, and at once on the window's 'online' event; "connecting" gets a hint after 15 s
//   • the settle session (VdoParse.resolveSlotID): a fresh one every time the frame's src is set, reload included
// It never blanks a slot itself; the pages decide what a roster means.

(function () {
  'use strict';
  const BACKUP_ORIGIN = 'https://cdn-backup.vdo.ninja';

  // o: { iframe, base, cib, extraOrigins, now, pollMs, firstProbeMs, silentMs, retryAfterMs, backoffMs, hintMs,
  //      makeTicker(fn, ms) → { stop() }, setTimeout, hooks: { connecting, reply(roster, rawReply), unrecognised, silent, hint, retrying(n) } }
  function create(o) {
    const now = o.now || (() => Date.now());
    const T = Object.assign({}, o.timing); // a test shortens the clock with window.__VDO_DIRECTOR_TIMING = { silentMs, retryAfterMs, backoffMs, hintMs }
    const pollMs = o.pollMs || 2500;
    const silentMs = o.silentMs || T.silentMs || 3 * pollMs;
    const retryAfterMs = o.retryAfterMs || T.retryAfterMs || 25000;
    const backoffMs = o.backoffMs || T.backoffMs || [30000, 60000, 120000];
    const hintMs = o.hintMs || T.hintMs || 15000;
    const timeout = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const hooks = o.hooks || {};
    const origins = new Set([new URL(o.base, location.href).origin, BACKUP_ORIGIN, ...(o.extraOrigins || [])]);

    let url = '', ticker = null, srcSetAt = 0, lastReplyAt = 0, answered = false, retryN = 0, nextRetryAt = 0, hinted = false, wasSilent = false, started = false;
    let sess = freshSession();
    // startedAt stays null until the first RECOGNISED reply of this load: a director that is slow to answer still gets its whole
    // settle window, and an unrecognised reply does not start it.
    function freshSession() { return { startedAt: null, seen: new Set() }; }
    const hasLoadEvents = !!(o.iframe && typeof o.iframe.addEventListener === 'function');
    let loaded = !hasLoadEvents; // the iframe has loaded the CURRENT src (the previous document must not answer into the new session)

    function makeTicker(fn, ms) {
      if (o.makeTicker) return o.makeTicker(fn, ms);
      try {
        const src = `setInterval(function(){ postMessage(1); }, ${ms});`;
        const blobUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
        const w = new Worker(blobUrl);
        w.onmessage = () => fn();
        return { stop() { try { w.terminate(); } catch (_) {} try { URL.revokeObjectURL(blobUrl); } catch (_) {} } };
      } catch (_) {
        const id = setInterval(fn, ms);
        return { stop() { clearInterval(id); } };
      }
    }

    function post() {
      try {
        if (url && o.iframe && o.iframe.contentWindow) o.iframe.contentWindow.postMessage({ getGuestList: true, cib: o.cib || 'sb-vdo' }, '*');
      } catch (_) { /* iframe not ready yet */ }
    }

    // One tick: ask, then judge how long it has been quiet.
    function tick() {
      if (!url) return;
      post();
      const t = now();
      const since = t - Math.max(lastReplyAt, srcSetAt);
      if (since >= silentMs && !wasSilent) { wasSilent = true; if (hooks.silent) hooks.silent(); } // stays set until a reply
      if (!answered && !hinted && since >= hintMs) { hinted = true; if (hooks.hint) hooks.hint(wasSilent); }
      if (since >= retryAfterMs && t >= nextRetryAt) reload();
    }

    // manual: an operator's Save (nudge) reloads the frame without counting as a retry or moving the backoff along
    function reload(manual) {
      if (!url) return;
      if (!manual) {
        retryN++;
        nextRetryAt = now() + backoffMs[Math.min(retryN - 1, backoffMs.length - 1)];
      }
      sess = freshSession(); // a reloaded director's first (empty or partial) reply must not blank what was seen before
      srcSetAt = now();
      answered = false; // nothing has answered since the frame was pointed at the room again
      loaded = !hasLoadEvents;
      hinted = false;
      if (manual) { if (hooks.connecting) hooks.connecting(); } else if (hooks.retrying) hooks.retrying(retryN);
      const target = url;
      o.iframe.src = 'about:blank';
      timeout(() => { if (url === target) o.iframe.src = target; }, 50);
    }

    function onMessage(e) {
      if (!url || !o.iframe || e.source !== o.iframe.contentWindow || !origins.has(e.origin)) return;
      // contentWindow is the same object before and after a navigation, so "the iframe's own window" cannot tell the previous
      // document from the new one: ignore replies until the new src has loaded (or 5 s have passed, in case 'load' never fires).
      if (!loaded && now() - srcSetAt < 5000) return;
      const d = e.data;
      if (!d || typeof d !== 'object' || !('guestList' in d)) return;
      lastReplyAt = now(); answered = true;
      retryN = 0; nextRetryAt = 0; wasSilent = false;
      if (!VdoParse.guestListOk(d)) { if (hooks.unrecognised) hooks.unrecognised(d); return; }
      if (sess.startedAt === null) sess.startedAt = now(); // the settle window starts at the first recognised reply
      if (hooks.reply) hooks.reply(VdoParse.parseGuestList(d), d);
    }

    function start(u) {
      stop(true);
      url = u; srcSetAt = now(); lastReplyAt = 0; answered = false; retryN = 0; nextRetryAt = 0; hinted = false; wasSilent = false;
      sess = freshSession();
      loaded = !hasLoadEvents;
      o.iframe.src = u;
      if (hooks.connecting) hooks.connecting();
      ticker = makeTicker(tick, pollMs);
      timeout(tick, o.firstProbeMs || 1500); // the first probe, once the iframe has had time to connect
    }
    function stop(keepFrame) {
      if (ticker) { ticker.stop(); ticker = null; }
      url = '';
      if (!keepFrame) o.iframe.src = 'about:blank';
    }
    // The room was saved again with the same URL: if the frame has gone quiet (it never answered, or answered and then stopped),
    // look again now. A young connection is left alone, and this is not a retry (no backoff step, no "retrying").
    function nudge() { if (url && wasSilent) reload(true); }

    if (hasLoadEvents) {
      o.iframe.addEventListener('load', () => {
        // only the load of the CURRENT src counts (about:blank loads in between do not)
        const attr = typeof o.iframe.getAttribute === 'function' ? o.iframe.getAttribute('src') : url;
        if (url && attr === url) loaded = true;
      });
    }
    if (!started && typeof window !== 'undefined' && window.addEventListener) {
      started = true;
      window.addEventListener('online', () => { if (url && (wasSilent || !answered)) { nextRetryAt = 0; reload(); } });
    }

    return {
      start, stop, tick, nudge, onMessage,
      get sess() { return sess; },
      get url() { return url; },
      get lastReplyAt() { return lastReplyAt; },
      get retries() { return retryN; },
    };
  }

  globalThis.GRDirector = { create, BACKUP_ORIGIN };
})();
