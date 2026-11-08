// Greenroom guest-directory core — the ONE place the control pages agree on what
// a directory entry is, how live guests turn into entries, and which auto-adds
// the operator has waved off. Loaded by control.html and director-min.html (and
// unit-tested by verify.mjs), so both pages auto-populate identically whether the
// operator has the editor open or only the 1×1 director source is running.
//
// Wire shape (docs/PROTOCOL.md) — the vdoninja payload's directory fields:
//   directory:          [ { vdoLabel, discordUserId, displayName, socials[], auto } ]
//   directoryAutoAdd:   bool  — auto-populate new guests (default ON)
//   directoryIgnored:   [ "vdo:<lowercased label>" | "discord:<snowflake>" ]
//
// `auto` marks a placeholder name the page invented from a live guest (the VDO
// label or the Discord username); any edit the operator makes to the entry clears
// the flag. `directoryIgnored` is the anti-resurrection list: removing an entry
// (or clearing one of its match keys) records the key so the next poll doesn't
// re-add the guest a second later.
//
// The sanitizers are duplicated in overlay/nameplate-shared.js (the overlays load
// that file instead of this one — different SB Path->Folder prefix). Both copies are
// SUPERSET-SAFE (unknown fields pass through after the known ones) and keep the same key
// order; verify.mjs checks that their lines and their behaviour are identical.
// They must stay IDEMPOTENT: sanitize(sanitize(x)) === sanitize(x), or the control
// pages' hydration baselines drift and every hydration triggers a spurious push.

(function () {
  'use strict';

  // Superset-safe: a field this version does not know passes through untouched, so a
  // newer page's extra fields survive an older page's push. Known keys always come
  // first, in wire order, then the unknown ones in the order they arrived.
  const DIR_KEYS = new Set(['vdoLabel', 'discordUserId', 'displayName', 'socials', 'auto']);
  const SOCIAL_KEYS = new Set(['platform', 'handle']);
  function extraFields(src, known) {
    const out = {};
    for (const k of Object.keys(src || {})) if (!known.has(k) && k !== '__proto__') out[k] = src[k];
    return out;
  }

  function sanitizeSocials(raw) {
    const out = [];
    if (!Array.isArray(raw)) return out;
    for (const s of raw) {
      if (!s || typeof s !== 'object') continue;
      const platform = String(s.platform ?? '').trim().toLowerCase();
      const handle = String(s.handle ?? '').trim();
      if (!platform || !handle) continue;
      out.push(Object.assign({ platform, handle }, extraFields(s, SOCIAL_KEYS)));
    }
    return out;
  }

  function sanitizeDirectory(raw) {
    const out = [];
    if (!Array.isArray(raw)) return out;
    for (const e of raw) {
      if (!e || typeof e !== 'object') continue;
      const vdoLabel = String(e.vdoLabel ?? '').trim();
      const discordUserId = String(e.discordUserId ?? '').replace(/\D/g, '');
      const displayName = String(e.displayName ?? '').trim();
      if (!displayName || (!vdoLabel && !discordUserId)) continue;
      out.push(Object.assign({ vdoLabel, discordUserId, displayName, socials: sanitizeSocials(e.socials), auto: !!e.auto }, extraFields(e, DIR_KEYS)));
    }
    return out;
  }

  // The socials textarea yields bare {platform, handle}; give each one back the unknown
  // fields (a url, say) of the previous social with the same platform and handle.
  function carrySocialExtras(prev, parsed) {
    const old = Array.isArray(prev) ? prev : [];
    return (parsed || []).map((s) => {
      const hit = old.find((o) => o && o.platform === s.platform && o.handle === s.handle);
      return hit ? Object.assign({}, s, extraFields(hit, SOCIAL_KEYS)) : s;
    });
  }

  // Ignore keys are sorted + deduped so the payload signature is stable no matter
  // in which order the operator dismissed things (push dedupe depends on it).
  function sanitizeIgnored(raw) {
    if (!Array.isArray(raw)) return [];
    const out = new Set();
    for (const k of raw) {
      const s = String(k ?? '').trim();
      if (/^vdo:.+/.test(s)) out.add('vdo:' + s.slice(4).toLowerCase());
      else if (/^discord:\d+$/.test(s)) out.add(s);
    }
    return [...out].sort();
  }

  const labelKey = (label) => 'vdo:' + String(label ?? '').trim().toLowerCase();
  const userKey = (id) => 'discord:' + String(id ?? '').replace(/\D/g, '');

  // Labels are stored as the operator typed them but matched case-insensitively
  // (vdo.ninja labels come back trimmed from the director enumeration).
  function findByLabel(dir, label) {
    const needle = String(label ?? '').trim().toLowerCase();
    if (!needle) return null;
    return (dir || []).find((e) => e && e.vdoLabel && String(e.vdoLabel).trim().toLowerCase() === needle) || null;
  }

  function findByUserId(dir, id) {
    const needle = String(id ?? '').replace(/\D/g, '');
    if (!needle) return null;
    return (dir || []).find((e) => e && String(e.discordUserId || '') === needle) || null;
  }

  // Textarea grammar — one social per line: "platform handle", split on the FIRST
  // space (the handle may itself contain spaces). Control-page only; the wire
  // always carries {platform, handle} objects.
  function parseSocialsText(text) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const t = line.trim();
      const sp = t.indexOf(' ');
      if (sp <= 0) continue;
      const platform = t.slice(0, sp).toLowerCase();
      const handle = t.slice(sp + 1).trim();
      if (handle) out.push({ platform, handle });
    }
    return out;
  }

  function socialsToText(socials) {
    return (socials || []).map((s) => s.platform + ' ' + s.handle).join('\n');
  }

  function eqCi(a, b) {
    return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  }

  // A guest controls their own label, and a label that looks like a timestamp is not
  // safe to carry in a payload Streamer.bot re-parses (the actions get their own fix in
  // a later release). Auto-add never copies one into a payload. Deliberately broad:
  // anything that starts like an ISO date-time or a /Date( value.
  const DATE_SHAPED = /^\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\/Date\()/i;
  function isDateShaped(s) { return DATE_SHAPED.test(String(s ?? '')); }

  // Turn "who is live right now" into directory entries.
  //   opts = { directory, ignored, labels: ['ALPHA'], users: { '<id>': {username} }, skip: ['vdo:alpha', 'discord:1'] }
  // `skip` lists keys the caller has already auto-added in this session: they are never appended again (a label that Streamer.bot
  // rewrites on the way back would otherwise look new on every pass). It does not stop a Discord id being filled into an entry.
  // Returns { directory, changed, added } — `directory` is a NEW array (entries
  // are only ever appended or key-filled, never renamed), `added` lists the keys
  // it created, for status text.
  //
  // Both control pages run this on the same inputs, so the result must not depend
  // on iteration order: candidates are sorted (labels case-insensitively, user ids
  // as strings) before anything is appended. Two directors that disagree on order
  // would push each other in circles.
  function autoPopulate(opts) {
    const o = opts || {};
    const dir = (Array.isArray(o.directory) ? o.directory : []).slice();
    const ignored = new Set(sanitizeIgnored(o.ignored));
    const skip = new Set(Array.isArray(o.skip) ? o.skip.map(String) : []);
    const added = [];
    let changed = false;

    const labels = [...new Set((Array.isArray(o.labels) ? o.labels : [])
      .map((l) => String(l ?? '').trim()).filter(Boolean))]
      .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));

    for (const label of labels) {
      const key = labelKey(label);
      if (isDateShaped(label) || ignored.has(key) || skip.has(key) || findByLabel(dir, label)) continue;
      dir.push({ vdoLabel: label, discordUserId: '', displayName: label, socials: [], auto: true });
      added.push(key);
      changed = true;
    }

    const users = (o.users && typeof o.users === 'object') ? o.users : {};
    for (const rawId of Object.keys(users).sort()) {
      const id = String(rawId).replace(/\D/g, '');
      if (!id) continue;
      const key = userKey(id);
      if (ignored.has(key) || findByUserId(dir, id)) continue;
      const u = users[rawId] || {};
      // A date-shaped Discord name is never copied into the directory (see isDateShaped);
      // the entry is named by the id, as for a user with no name.
      const username = isDateShaped(u.username) ? '' : String(u.username ?? '').trim();
      const name = username || id;
      // Same human, already in the book under a VDO label or that exact name →
      // fill in the Discord id instead of creating a twin. Clearing the id field
      // ignores it (control.html), so a wrong guess is one edit away from gone.
      const idx = dir.findIndex((e) => e && !e.discordUserId
        && (eqCi(e.displayName, username) || eqCi(e.vdoLabel, username)));
      if (idx >= 0) {
        dir[idx] = Object.assign({}, dir[idx], { discordUserId: id });
        changed = true;
      } else if (!skip.has(key)) {
        dir.push({ vdoLabel: '', discordUserId: id, displayName: name, socials: [], auto: true });
        added.push(key);
        changed = true;
      }
    }

    return { directory: dir, changed, added };
  }

  globalThis.GRDir = {
    sanitizeSocials, sanitizeDirectory, sanitizeIgnored,
    labelKey, userKey, findByLabel, findByUserId,
    parseSocialsText, socialsToText, autoPopulate, isDateShaped,
    extraFields, carrySocialExtras, DIR_KEYS, SOCIAL_KEYS,
  };
})();
