// Greenroom guest-directory core — the ONE place the control pages agree on what
// a directory entry is, how live guests turn into entries, and which auto-adds
// the operator has waved off. Loaded by control.html and director-min.html (and
// unit-tested by verify.mjs), so both pages auto-populate identically whether the
// operator has the editor open or only the 1×1 director source is running.
//
// Wire shape (docs/PROTOCOL.md) — the vdoninja payload's directory fields:
//   directory:          [ { vdoLabel, discordUserId, displayName, socials[], auto } ]
//   directoryAutoAdd:   bool  — auto-populate new guests (default ON)
//   directoryIgnored:   [ "vdo:<label key>" | "discord:<snowflake>" ]   (the label key is fold(label): see the identity block)
//
// `auto` marks a placeholder name the page invented from a live guest (the VDO
// label or the Discord username); any edit the operator makes to the entry clears
// the flag (an auto entry that holds socials is the operator's all the same: see
// isPlaceholder). `directoryIgnored` is the anti-resurrection list: removing an entry
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
      if (/^vdo:.+/.test(s)) { const f = fold(s.slice(4)); if (f) out.add('vdo:' + f); } // the same key labelKey builds, so old-format keys still match
      else if (/^discord:\d+$/.test(s)) out.add(s);
    }
    return [...out].sort();
  }

  // <guest-identity>
  // The comparison key for guest labels and the lookups built on it. IDENTICAL in control/directory-core.js and
  // overlay/nameplate-shared.js (verify.mjs compares the two blocks and runs both over the same vectors).
  //
  // A label is normalised ONLY into a key; the raw label stays the slot key and is what is stored. canon() decodes vdo.ninja's HTML
  // escaping (it escapes twice: "Tom &amp;amp; Jerry"), reads '_' as a space, applies NFC, drops invisible characters (zero-width
  // joiners and spaces, the soft hyphen, ...) and collapses whitespace; it repeats until the text is stable (at most 10 passes, on
  // the first 400 characters), so canon(canon(x)) === canon(x). fold() also folds case, and canonises once more afterwards: a
  // lower-cased text can be longer (U+0130 becomes two characters) and so fold(fold(x)) === fold(x) as well. Two labels are
  // "exactly equal" when their canons are equal. A label made only of invisible characters has an empty canon: it matches an entry
  // whose label is the same raw text, and nothing else.
  function decodeHtml(s) {
    let t = String(s ?? '').slice(0, 400);
    for (let i = 0; i < 10; i++) {
      const d = t.replace(/&(lt|gt|quot|#39|#x27|apos);/gi, (m, n) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", apos: "'" }[n.toLowerCase()])).replace(/&amp;/gi, '&');
      if (d === t) break;
      t = d;
    }
    return t;
  }
  function canon(s) {
    let t = String(s ?? '').slice(0, 400);
    for (let i = 0; i < 10; i++) {
      const d = decodeHtml(t).replace(/_/g, ' ').normalize('NFC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').replace(/\s+/g, ' ').trim();
      if (d === t) break;
      t = d;
    }
    return t;
  }
  function fold(s) { return canon(canon(s).toLowerCase()); }
  // Does the label draw anything? (U+2800, the Braille blank, is not whitespace but shows nothing.)
  function hasGlyph(s) { return /[^\s⠀ㅤᅟᅠ]/u.test(canon(s)); }

  // Which directory entry stands for this live label? Collect every entry whose key matches, then prefer an exact-case match (equal
  // canon), then a curated entry over an auto one, then the first in array order.
  function findByLabel(dir, label) {
    const c = canon(label);
    if (!c) {
      const raw = String(label ?? '').trim();
      if (!raw) return null;
      let same = null;
      for (const e of Array.isArray(dir) ? dir : []) {
        if (!e || !e.vdoLabel || String(e.vdoLabel).trim() !== raw) continue;
        if (!same || (same.auto && !e.auto)) same = e;
      }
      return same;
    }
    const f = fold(c);
    let hit = null;
    let hitRank = 99;
    for (const e of Array.isArray(dir) ? dir : []) {
      if (!e || !e.vdoLabel) continue;
      const ec = canon(e.vdoLabel);
      if (fold(ec) !== f) continue;
      const rank = (ec === c ? 0 : 2) + (e.auto ? 1 : 0);
      if (rank < hitRank) { hit = e; hitRank = rank; }
    }
    return hit;
  }

  // Which entry stands for this Discord user? Digits only; a curated entry beats an auto one, then array order.
  function findByUserId(dir, id) {
    const needle = String(id ?? '').replace(/\D/g, '');
    if (!needle) return null;
    let hit = null;
    for (const e of Array.isArray(dir) ? dir : []) {
      if (!e || String(e.discordUserId || '').replace(/\D/g, '') !== needle) continue;
      if (!hit || (hit.auto && !e.auto)) hit = e;
    }
    return hit;
  }
  // </guest-identity>

  const labelKey = (label) => 'vdo:' + fold(label); // the ignore key: case does not matter
  // The per-session "already auto-added" key keeps case: labels that differ only in case are separate guests, and adding one must not skip the other.
  const labelExactKey = (label) => 'vdo:' + canon(label);
  const userKey = (id) => 'discord:' + String(id ?? '').replace(/\D/g, '');

  // Textarea grammar — one social per line: "platform handle", split on the FIRST
  // whitespace (a space, tab or NBSP; the handle may itself contain spaces). Control-page only; the wire
  // always carries {platform, handle} objects.
  function parseSocialsText(text) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const t = line.trim();
      const sp = t.search(/\s/);
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

  // A guest controls their own label, and a label that looks like a timestamp is not
  // safe to carry in a payload Streamer.bot re-parses (the actions get their own fix in
  // a later release). Auto-add never copies one into a payload. Deliberately broad:
  // anything that starts like an ISO date-time or a /Date( value.
  const DATE_SHAPED = /^\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\/Date\()/i;
  function isDateShaped(s) { return DATE_SHAPED.test(String(s ?? '')); }

  // Turn "who is live right now" into directory entries.
  //   opts = { directory, ignored, labels: ['ALPHA'], users: { '<id>': {username} }, skip: ['vdo:alpha', 'discord:1'],
  //            boundLabels: ['ALPHA'], boundUsers: ['<id>'] }
  // `skip` lists keys (labelExactKey / userKey) the caller has already auto-added in this session: they are never appended again (a label that Streamer.bot
  // rewrites on the way back would otherwise look new on every pass). `boundLabels` / `boundUsers` name the guests that sit in a slot:
  // an auto entry for one of them is never evicted.
  //
  // Returns { directory, changed, added, linked, labeled, suggested, skipped, evicted, appended }. Every change to the input list is
  // reported, so a caller that keeps its own live list can apply the changes to it instead of replacing it. `index` is always the
  // entry's position in the INPUT list; a link or a label that lands on an entry appended in this same pass is set on that entry
  // itself and is in none of the lists below.
  //   directory  a NEW array: the input with the changes below applied (evicted entries gone, appended ones at the end)
  //   added      the keys of the entries it appended (for status text)
  //   linked     [{ index, id, username, name }] a Discord id filled into an AUTO entry whose name matched
  //   labeled    [{ index, label }] a VDO label filled into an AUTO entry that the guest's Discord name had created first
  //   suggested  [{ index, id, username }] a CURATED entry whose name matches a Discord user: never linked silently (anyone can pick
  //              a Discord name), only offered to the operator; it changes nothing, so the pass stays a fixpoint
  //   skipped    how many new entries were not added because AUTO_MAX placeholders exist and none could be evicted
  //   evicted    input indices of the placeholders dropped to make room (only entries absent from the room and bound to no slot)
  //   appended   the new entry objects
  //
  // Both control pages run this on the same inputs, so the result must not depend on iteration order: labels are sorted (by key, then
  // exact case, then raw text; of several raw texts with one canon the smallest is used) and user ids as strings before anything is
  // appended.
  const AUTO_MAX = 50;
  // A placeholder is an auto entry that still holds only what auto-add put there. Auto-add never writes socials, so an auto entry with
  // socials is the operator's: 1.0.13 cleared the flag only on a rename and kept it through a socials edit, and nothing migrates it. Such
  // an entry is treated as curated wherever the dock and the cap ask "is this a placeholder?": it is never evicted, does not count toward
  // AUTO_MAX, has no "auto" badge and is kept by "Clear auto-added". (A 1.0.13 edit of only the label or the Discord ID cannot be told
  // apart from what auto-add itself fills in, so such a row stays a placeholder.)
  function isPlaceholder(e) { return !!(e && e.auto && !(Array.isArray(e.socials) && e.socials.length)); }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  function autoPopulate(opts) {
    const o = opts || {};
    const dir = (Array.isArray(o.directory) ? o.directory : []).slice();
    const orig = dir.map((e, i) => i); // each entry's index in the input (-1 once appended here)
    const ignored = new Set(sanitizeIgnored(o.ignored));
    const skip = new Set(Array.isArray(o.skip) ? o.skip.map(String) : []);
    const digits = (x) => String(x ?? '').replace(/\D/g, '');
    const boundLabels = new Set((Array.isArray(o.boundLabels) ? o.boundLabels : []).map(fold).filter(Boolean));
    const boundUsers = new Set((Array.isArray(o.boundUsers) ? o.boundUsers : []).map(digits).filter(Boolean));
    const added = [];
    const linked = [];
    const labeled = [];
    const suggested = [];
    const evicted = [];
    const appended = [];
    let skipped = 0;
    let changed = false;

    // Live labels: unique by exact key (labels that differ only in case stay separate guests), in a fixed order.
    const byCanon = new Map();
    for (const x of Array.isArray(o.labels) ? o.labels : []) {
      const l = String(x ?? '').trim();
      const c = l && canon(l);
      if (!c) continue;
      const prev = byCanon.get(c);
      if (prev === undefined || cmp(l, prev) < 0) byCanon.set(c, l);
    }
    const labels = [...byCanon.values()].sort((a, b) => cmp(fold(a), fold(b)) || cmp(canon(a), canon(b)) || cmp(a, b));
    const foldCount = new Map();
    for (const l of labels) foldCount.set(fold(l), (foldCount.get(fold(l)) || 0) + 1);
    const users = (o.users && typeof o.users === 'object') ? o.users : {};
    const liveUsers = new Set(Object.keys(users).map(digits).filter(Boolean));

    // A Discord user in the channel counts for an entry without an id too when the name is the entry's: the user pass below will link
    // them, so the entry must not be evicted first and then made again.
    const liveNames = new Set();
    for (const rawId of Object.keys(users)) {
      const n = String((users[rawId] || {}).username ?? '').trim();
      if (n && !isDateShaped(n)) liveNames.add(fold(n));
    }
    const isLive = (e) => (e.vdoLabel && foldCount.has(fold(e.vdoLabel))) || (e.discordUserId && liveUsers.has(digits(e.discordUserId)))
      || (!e.discordUserId && (liveNames.has(fold(e.displayName)) || (e.vdoLabel && liveNames.has(fold(e.vdoLabel)))));
    const isBound = (e) => (e.vdoLabel && boundLabels.has(fold(e.vdoLabel))) || (e.discordUserId && boundUsers.has(digits(e.discordUserId)));
    // Room for one more auto entry? At AUTO_MAX placeholders, drop the first placeholder that is not in the room and not in a slot; else
    // skip. An auto entry that holds socials is not a placeholder (see isPlaceholder): it neither counts nor makes way.
    const room = () => {
      if (dir.reduce((n, e) => n + (isPlaceholder(e) ? 1 : 0), 0) < AUTO_MAX) return true;
      const i = dir.findIndex((e, k) => isPlaceholder(e) && orig[k] >= 0 && !isLive(e) && !isBound(e));
      if (i < 0) { skipped++; return false; }
      evicted.push(orig[i]);
      dir.splice(i, 1);
      orig.splice(i, 1);
      changed = true;
      return true;
    };

    for (const label of labels) {
      const key = labelKey(label);
      const c = canon(label);
      if (!hasGlyph(label) || isDateShaped(label) || ignored.has(key) || skip.has(labelExactKey(label))) continue;
      if (dir.some((e) => e && e.vdoLabel && canon(e.vdoLabel) === c)) continue; // an entry already has exactly this label
      // matched ignoring case, and no other live label collides with it by case: the same guest
      if (foldCount.get(fold(label)) === 1 && dir.some((e) => e && e.vdoLabel && fold(e.vdoLabel) === fold(label))) continue;
      // the guest came into the voice channel first: their auto entry takes the label (never a curated one)
      const mi = dir.findIndex((e) => e && !e.vdoLabel && e.auto && fold(e.displayName) === fold(label));
      if (mi >= 0) {
        if (orig[mi] >= 0) { dir[mi] = Object.assign({}, dir[mi], { vdoLabel: label }); labeled.push({ index: orig[mi], label }); } else dir[mi].vdoLabel = label;
        changed = true;
        continue;
      }
      if (!room()) continue;
      const entry = { vdoLabel: label, discordUserId: '', displayName: decodeHtml(label).trim() || label, socials: [], auto: true };
      dir.push(entry);
      orig.push(-1);
      appended.push(entry);
      added.push(key);
      changed = true;
    }

    for (const rawId of Object.keys(users).sort()) {
      const id = digits(rawId);
      if (!id) continue;
      const key = userKey(id);
      if (ignored.has(key) || findByUserId(dir, id)) continue;
      const u = users[rawId] || {};
      const rawName = String(u.username ?? '').trim();
      if (!rawName) continue; // no name yet: the entry is added when the name arrives, not named after the snowflake
      // A date-shaped Discord name is never copied into the directory (see isDateShaped); the entry is named by the id.
      const username = isDateShaped(rawName) ? '' : rawName;
      // Same human, already in the book under a VDO label or this exact name? An AUTO entry takes the id silently. A CURATED entry
      // never does (a Discord name is self-chosen, anyone can pick "Bob"): it is only offered the link, and no twin is made.
      const nameKey = fold(username);
      const nameHits = nameKey ? dir.map((e, k) => (e && !e.discordUserId && (fold(e.displayName) === nameKey || fold(e.vdoLabel) === nameKey) ? k : -1)).filter((k) => k >= 0) : [];
      if (nameHits.length) {
        const idx = nameHits.find((k) => dir[k].auto);
        if (idx !== undefined) {
          const e = dir[idx];
          if (orig[idx] >= 0) { dir[idx] = Object.assign({}, e, { discordUserId: id }); linked.push({ index: orig[idx], id, username, name: e.displayName }); } else e.discordUserId = id;
          changed = true;
        } else {
          suggested.push({ index: orig[nameHits[0]], id, username });
        }
        continue;
      }
      if (skip.has(key)) continue;
      if (!room()) continue;
      const entry = { vdoLabel: '', discordUserId: id, displayName: username || id, socials: [], auto: true };
      dir.push(entry);
      orig.push(-1);
      appended.push(entry);
      added.push(key);
      changed = true;
    }

    return { directory: dir, changed, added, linked, labeled, suggested, skipped, evicted, appended };
  }

  globalThis.GRDir = {
    sanitizeSocials, sanitizeDirectory, sanitizeIgnored,
    labelKey, labelExactKey, userKey, findByLabel, findByUserId, canon, fold, hasGlyph, decodeHtml, AUTO_MAX, isPlaceholder,
    parseSocialsText, socialsToText, autoPopulate, isDateShaped,
    extraFields, carrySocialExtras, DIR_KEYS, SOCIAL_KEYS,
  };
})();
