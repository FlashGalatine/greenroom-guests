// Greenroom vdo.ninja URL helper — the ONE place the pages agree on how a vdo.ninja URL is put together: the guest view (the overlay),
// the hidden director (the dock and director-min) and the invite/manage links (the dock). Two byte-identical copies exist, overlay/
// vdo-url.js and control/vdo-url.js (the overlays and the control pages are served from different Streamer.bot folders); verify.mjs
// fails if they differ.
//
// What it guarantees:
//   - The room password reaches vdo.ninja encoded EXACTLY twice: vdo.ninja reads the query with URLSearchParams (one decode) and then
//     decodes the value again itself, so a password with %, &, # or a space only arrives intact that way. All builders go through
//     passwordQuery().
//   - effectivePassword(): '' / '0' / 'false' / 'off' (any case, trimmed) mean "no password" in vdo.ninja, so they are never sent.
//   - View flags are normalised ('&a&b=c', one leading '&') and sanitised: flags that could inject script or style into the viewer
//     (js, css, ...), take the page's invite, or change the room identity (view, room, password, hash, ...) are dropped, whatever the
//     saved config holds. Values are decoded once and encoded once, so the result is stable when sanitised again.
//   - A guest view is always solo unless the flags already ask for a scene.
(function () {
  'use strict';

  // '&a&b=c' from anything a person or an old config might hold: trimmed, any leading run of ? & # removed, one '&' put back.
  function normalizeFlags(raw) {
    const s = String(raw ?? '').trim().replace(/^[?&#\s]+/, '');
    return s ? '&' + s : '';
  }

  // Flags that load remote script, style or media into the viewer, send its events away, or take the invite (the exported "injection"
  // subset); and flags that name the stream, the room or the credentials the view uses (vdo.ninja reads several aliases of each, and
  // the first one found wins, so every alias is listed). Deployment settings that must match the guests' side (salt, token, wss, ...)
  // are NOT dropped: a self-hosted vdo.ninja needs them on the viewer too.
  const INJECTION = ['js', 'base64js', 'b64js', 'jsbase64', 'jsb64', 'css', 'base64css', 'b64css', 'cssbase64', 'cssb64', 'invite', 'i', 'code',
    'whepplay', 'whep', 'website', 'iframe', 'postapi', 'posturl', 'api', 'osc'];
  const IDENTITY = ['view', 'v', 'room', 'r', 'password', 'pw', 'p', 'hash', 'push', 'director', 'dir', 'id', 'permaid',
    'streamid', 'pull', 'roomid', 'pass', 'crc', 'check', 'preset'];
  const injectionSet = new Set(INJECTION);
  const dropSet = new Set(INJECTION.concat(IDENTITY));
  const isInjectionKey = (key) => injectionSet.has(String(key).toLowerCase());

  // Cut at the first '#', split on '&' and '?', keep only plain keys that are not in a dropped family, decode each value once and
  // encode it once. Returns { flags: '&a&b=c' | '', dropped: [key, ...] }. Idempotent.
  function sanitizeViewFlags(raw) {
    let s = String(raw ?? '');
    const hash = s.indexOf('#');
    const dropped = [];
    if (hash >= 0) {
      if (s.slice(hash + 1).trim()) dropped.push('#…'); // everything after a '#' is a fragment, not a flag: it is cut, and said so
      s = s.slice(0, hash);
    }
    const kept = [];
    for (const part of s.split(/[&?]/)) {
      const t = part.trim();
      if (!t) continue;
      const eq = t.indexOf('=');
      const key = eq < 0 ? t : t.slice(0, eq);
      if (!/^[A-Za-z0-9_-]+$/.test(key) || dropSet.has(key.toLowerCase())) { dropped.push(key.slice(0, 40)); continue; }
      if (eq < 0) { kept.push(key); continue; }
      let value = t.slice(eq + 1);
      try { value = decodeURIComponent(value); } catch (_) { /* a stray % stays as typed */ }
      try { kept.push(key + '=' + encodeURIComponent(value)); } catch (_) { dropped.push(key.slice(0, 40)); } // a lone surrogate cannot be encoded
    }
    return { flags: kept.length ? '&' + kept.join('&') : '', dropped };
  }

  // A guest view is solo unless the flags already hold solo or scene. vdo.ninja reads both names exactly (lower case), so 'Solo' does
  // not count and &solo is added.
  function ensureSolo(flags) {
    const keys = String(flags ?? '').split(/[&?]/).map((p) => p.trim().split('=')[0]);
    return keys.includes('solo') || keys.includes('scene') ? flags : flags + '&solo';
  }

  function effectivePassword(pw) {
    const t = String(pw ?? '').trim();
    return ['', '0', 'false', 'off'].includes(t.toLowerCase()) ? '' : t;
  }

  // '&password=<twice encoded>' or '' when there is no effective password.
  function passwordQuery(pw) {
    // (a lone UTF-16 surrogate cannot be encoded; it becomes U+FFFD, as it would on the way through Streamer.bot)
    const p = effectivePassword(pw).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
    return p ? '&password=' + encodeURIComponent(encodeURIComponent(p)) : '';
  }

  // The URL of one guest's solo view, as the overlay loads it: v = { room, password, viewFlags }.
  function buildViewUrl(v, streamID) {
    const cfg = v || {};
    let url = 'https://vdo.ninja/?view=' + encodeURIComponent(streamID);
    if (cfg.room) url += '&room=' + encodeURIComponent(cfg.room);
    url += passwordQuery(cfg.password);
    url += ensureSolo(sanitizeViewFlags(normalizeFlags(cfg.viewFlags)).flags);
    return url;
  }

  // The hidden, silent director: base is the director page (vdo.ninja, or the test mock).
  function buildDirectorUrl(base, room, password) {
    const sep = String(base).includes('?') ? '&' : '?';
    return base + sep + 'director=' + encodeURIComponent(room) + passwordQuery(password) + '&cleanish&novideo&noaudio';
  }

  // The room name vdo.ninja really joins: runs of anything that is not a word character become '_', at most 30 characters. Display
  // only: the pages keep the room as typed and build every URL from it (vdo.ninja applies the same rule on every page).
  function vdoRoomName(room) {
    const typed = String(room ?? '').trim();
    const effective = typed.replace(/[\W]+/g, '_').slice(0, 30);
    const onlyUnderscores = !!typed && /^_+$/.test(effective);
    const warnings = [];
    if (onlyUnderscores) warnings.push('only underscores: vdo.ninja joins the room "_", shared with every other name that collapses the same way');
    else if (typed && effective !== typed.replace(/ /g, '_')) warnings.push('differs from what you typed');
    if (typed.length > 30) warnings.push('longer than 30 characters: vdo.ninja cuts it');
    return { effective, warnings, onlyUnderscores };
  }

  globalThis.GRVdoUrl = {
    vdoRoomName, normalizeFlags, sanitizeViewFlags, isInjectionKey, ensureSolo, effectivePassword, passwordQuery, buildViewUrl, buildDirectorUrl,
    INJECTION, IDENTITY,
  };
})();
