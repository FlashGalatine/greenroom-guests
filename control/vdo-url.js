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

  // Families of flags that load remote script or style into the viewer, take the invite, or name the room the view joins.
  const INJECTION = ['js', 'base64js', 'b64js', 'jsbase64', 'jsb64', 'css', 'base64css', 'b64css', 'cssbase64', 'cssb64', 'invite', 'i', 'code'];
  const IDENTITY = ['view', 'v', 'room', 'r', 'password', 'pw', 'p', 'hash', 'push', 'director', 'dir', 'id', 'permaid'];
  const injectionSet = new Set(INJECTION);
  const dropSet = new Set(INJECTION.concat(IDENTITY));
  const isInjectionKey = (key) => injectionSet.has(String(key).toLowerCase());

  // Cut at the first '#', split on '&' and '?', keep only plain keys that are not in a dropped family, decode each value once and
  // encode it once. Returns { flags: '&a&b=c' | '', dropped: [key, ...] }. Idempotent.
  function sanitizeViewFlags(raw) {
    let s = String(raw ?? '');
    const hash = s.indexOf('#');
    if (hash >= 0) s = s.slice(0, hash);
    const kept = [];
    const dropped = [];
    for (const part of s.split(/[&?]/)) {
      const t = part.trim();
      if (!t) continue;
      const eq = t.indexOf('=');
      const key = eq < 0 ? t : t.slice(0, eq);
      if (!/^[A-Za-z0-9_-]+$/.test(key) || dropSet.has(key.toLowerCase())) { dropped.push(key.slice(0, 40)); continue; }
      if (eq < 0) { kept.push(key); continue; }
      let value = t.slice(eq + 1);
      try { value = decodeURIComponent(value); } catch (_) { /* a stray % stays as typed */ }
      kept.push(key + '=' + encodeURIComponent(value));
    }
    return { flags: kept.length ? '&' + kept.join('&') : '', dropped };
  }

  // The flag keys in a normalised flags string, lower case.
  function flagKeys(flags) {
    return String(flags ?? '').split(/[&?]/).map((p) => p.trim().split('=')[0].toLowerCase()).filter(Boolean);
  }

  // A guest view is solo unless the flags already hold solo or scene.
  function ensureSolo(flags) {
    const keys = flagKeys(flags);
    return keys.includes('solo') || keys.includes('scene') ? flags : flags + '&solo';
  }

  function effectivePassword(pw) {
    const t = String(pw ?? '').trim();
    return ['', '0', 'false', 'off'].includes(t.toLowerCase()) ? '' : t;
  }

  // '&password=<twice encoded>' or '' when there is no effective password.
  function passwordQuery(pw) {
    const p = effectivePassword(pw);
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

  globalThis.GRVdoUrl = {
    normalizeFlags, sanitizeViewFlags, isInjectionKey, ensureSolo, effectivePassword, passwordQuery, buildViewUrl, buildDirectorUrl,
    INJECTION, IDENTITY,
  };
})();
