// Greenroom nameplate helpers — loaded by the nameplate surfaces
// (vdoninja-guest.html lower-third, nameplate.html standalone source) and by
// discord-roster.html (directory lookup only). Plain IIFE, no dependencies, no
// CDN — works offline inside OBS's CEF, same as panel-client-sb.js.
//
// The "guest directory" is the vdoninja payload's top-level `directory` array
// (docs/PROTOCOL.md): entries mapping a VDO.ninja label and/or a Discord user id
// to a preferred on-stream displayName + optional social handles. No directory
// entry → no nameplate; there is deliberately no raw-label fallback.

window.GRNameplate = (function () {
  'use strict';

  // Platform icons — fill follows CSS `color` via currentColor. Unknown
  // platforms fall back to the `website` globe.
  const ICONS = {
    twitch: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.265 3 3 6.236v13.223h4.502V21.5h2.531l2.27-2.041h3.476L20.5 14.94V3H4.265zm1.49 1.5H19v9.69l-2.752 2.478h-4.253L9.726 18.89v-2.222H5.755V4.5zM10.478 7.5h1.49V12h-1.49zm4.273 0h1.49V12h-1.49z"/></svg>',
    discord: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.36-.76-.54-1.09-.01-.02-.04-.03-.07-.03-1.5.26-2.93.71-4.27 1.33-.01 0-.02.01-.03.02-2.72 4.07-3.47 8.03-3.1 11.95 0 .02.01.04.03.05 1.8 1.32 3.53 2.12 5.24 2.65.03.01.06 0 .07-.02.4-.55.76-1.13 1.07-1.74.02-.04 0-.08-.04-.09-.57-.22-1.11-.48-1.64-.78-.04-.02-.04-.08-.01-.11.11-.08.22-.17.33-.25.02-.02.05-.02.07-.01 3.44 1.57 7.15 1.57 10.55 0 .02-.01.05-.01.07.01.11.09.22.17.33.26.04.03.04.09-.01.11-.52.31-1.07.56-1.64.78-.04.01-.05.06-.04.09.32.61.68 1.19 1.07 1.74.02.03.05.03.07.02 1.72-.53 3.45-1.33 5.24-2.65.02-.01.03-.03.03-.05.44-4.53-.73-8.46-3.1-11.95-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.83 2.12-1.89 2.12z"/></svg>',
    twitter: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
    bluesky: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.5 1.613 1.5 5.147c0 .706.404 5.934.641 6.784.828 2.974 3.848 3.733 6.564 3.278-4.74.795-5.955 3.43-3.348 6.065 4.955 5.005 7.127-1.255 7.68-2.861.08-.232.117-.34.136-.245.553 1.606 2.724 7.866 7.68 2.861 2.607-2.634 1.392-5.27-3.348-6.065 2.716.455 5.736-.304 6.564-3.278.237-.85.64-6.078.64-6.784 0-3.534-1.065-4.203-3.7-2.352-2.753 1.942-5.712 5.88-6.799 7.995z"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.546 12 3.546 12 3.546s-7.505 0-9.377.504A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.504 9.376.504 9.376.504s7.505 0 9.377-.504a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.72 3.72 0 0 1-1.38-.9 3.72 3.72 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zM12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63a5.88 5.88 0 0 0-2.13 1.38A5.88 5.88 0 0 0 .63 4.14C.33 4.9.13 5.78.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91.31.8.72 1.48 1.38 2.13a5.88 5.88 0 0 0 2.13 1.38c.76.3 1.64.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56a5.88 5.88 0 0 0 2.13-1.38 5.88 5.88 0 0 0 1.38-2.13c.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91a5.88 5.88 0 0 0-1.38-2.13A5.88 5.88 0 0 0 19.86.63c-.76-.3-1.64-.5-2.91-.56C15.67.01 15.26 0 12 0zm0 5.84A6.16 6.16 0 1 0 18.16 12 6.16 6.16 0 0 0 12 5.84zm0 10.15A3.99 3.99 0 1 1 15.99 12 4 4 0 0 1 12 15.99zm7.85-10.4a1.44 1.44 0 1 1-1.44-1.44 1.44 1.44 0 0 1 1.44 1.44z"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/></svg>',
    website: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.9 5.7 3.9 9S14.5 18.4 12 21c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3z"/></svg>',
  };

  // Short names people type for a platform. Only own properties count: icon('constructor') must not return a function.
  const ICON_ALIASES = { x: 'twitter', yt: 'youtube', ig: 'instagram', bsky: 'bluesky', tt: 'tiktok' };
  function icon(platform) {
    let k = String(platform ?? '').toLowerCase();
    if (Object.hasOwn(ICON_ALIASES, k)) k = ICON_ALIASES[k];
    return Object.hasOwn(ICONS, k) ? ICONS[k] : ICONS.website;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  // ── Directory sanitizers ────────────────────────────────────────────────────
  // KEEP IN SYNC with the copy in control/directory-core.js (same semantics, same
  // key order, same superset form: unknown fields pass through after the known ones) —
  // the overlays can't load that file, it lives behind the other SB Path->Folder prefix.
  // verify.mjs checks the copies agree. Both must be idempotent: sanitize(sanitize(x)) ===
  // sanitize(x), or the control pages' hydration baselines would drift and
  // trigger spurious pushes. `auto` (a placeholder name the control page invented
  // from a live guest) is carried through for parity; no overlay reads it.
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

  // ── Lookup ──────────────────────────────────────────────────────────────────
  // KEEP IN SYNC with control/directory-core.js: the block below is the same text there (verify.mjs compares them).
  // <guest-identity>
  // The comparison key for guest labels and the lookups built on it. IDENTICAL in control/directory-core.js and
  // overlay/nameplate-shared.js (verify.mjs compares the two blocks and runs both over the same vectors).
  //
  // A label is normalised ONLY into a key; the raw label stays the slot key and is what is stored. canon() decodes vdo.ninja's HTML
  // escaping (it escapes twice: "Tom &amp;amp; Jerry"), reads '_' as a space, applies NFC, drops invisible characters (zero-width
  // joiners and spaces, the soft hyphen, ...) and collapses whitespace; it repeats until the text is stable (a few passes at most),
  // so canon(canon(x)) === canon(x). fold() also folds case. Two labels are "exactly equal" when their canons are equal.
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
  function fold(s) { return canon(s).toLowerCase(); }
  // Does the label draw anything? (U+2800, the Braille blank, is not whitespace but shows nothing.)
  function hasGlyph(s) { return /[^\s⠀ㅤᅟᅠ]/u.test(canon(s)); }

  // Which directory entry stands for this live label? Collect every entry whose key matches, then prefer an exact-case match (equal
  // canon), then a curated entry over an auto one, then the first in array order.
  function findByLabel(dir, label) {
    const c = canon(label);
    if (!c) return null;
    const f = c.toLowerCase();
    let hit = null;
    let hitRank = 99;
    for (const e of Array.isArray(dir) ? dir : []) {
      if (!e || !e.vdoLabel) continue;
      const ec = canon(e.vdoLabel);
      if (ec.toLowerCase() !== f) continue;
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

  // The single visibility rule shared by both nameplate surfaces. Needs only the
  // vdoninja payload (never discordVoice): a discord-mode plate mirrors the PFP
  // placeholder's own visibility (shows whenever a user is bound), a webcam
  // plate only shows while the slot's label is resolved to a live streamID.
  function resolvePlateEntry(vdo, slotNumber) {
    if (!vdo || typeof vdo !== 'object') return null;
    const slots = Array.isArray(vdo.slots) ? vdo.slots : [];
    const slot = slots.find((s) => s && Number(s.slot) === Number(slotNumber)) || null;
    if (!slot) return null;
    const dir = sanitizeDirectory(vdo.directory);
    if (slot.mode === 'discord') {
      const uid = String(slot.discordUserId ?? '').replace(/\D/g, '');
      return uid ? findByUserId(dir, uid) : null;
    }
    return slot.streamID ? findByLabel(dir, slot.label) : null;
  }

  // ── Accent grammar (same as discord-roster.html) ────────────────────────────
  const ACCENTS = { cyan: '34, 211, 238', magenta: '255, 0, 229', 'neon-green': '57, 255, 20' };
  function accentTriplet(name) {
    if (!name) return null;
    if (Object.hasOwn(ACCENTS, name)) return ACCENTS[name];
    return /^\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*$/.test(name) ? name : null;
  }

  // ── Rotator ─────────────────────────────────────────────────────────────────
  // Cycling fade/slide rotator: a single item renders static; multiple items
  // cycle show → hold displayMs → .rot-out (swapMs) → swap innerHTML → .rot-in.
  function makeRotator(el, renderItem, opts) {
    const displayMs = (opts && opts.displayMs) || 5000;
    const swapMs = (opts && opts.swapMs) || 240;
    let items = [];
    let idx = 0;
    let cycleTimer = null;
    let swapTimer = null;
    let inTimer = null;

    function show(i) {
      el.innerHTML = renderItem(items[i]);
      el.classList.remove('rot-out');
      el.classList.add('rot-in');
      if (inTimer) clearTimeout(inTimer);
      inTimer = setTimeout(() => el.classList.remove('rot-in'), 300);
    }

    function schedule() {
      if (cycleTimer) clearTimeout(cycleTimer);
      if (items.length > 1) cycleTimer = setTimeout(cycle, displayMs);
    }

    function cycle() {
      el.classList.add('rot-out');
      swapTimer = setTimeout(() => {
        idx = (idx + 1) % items.length;
        show(idx);
        schedule();
      }, swapMs);
    }

    function setItems(next) {
      items = Array.isArray(next) ? next.filter(Boolean) : [];
      if (cycleTimer) clearTimeout(cycleTimer);
      if (swapTimer) clearTimeout(swapTimer);
      idx = 0;
      if (items.length === 0) {
        el.innerHTML = '';
        el.classList.remove('rot-out', 'rot-in');
        return;
      }
      show(0);
      schedule();
    }

    return { setItems };
  }

  // Standard "icon + handle" renderer. Handle is HTML-escaped; platform is only
  // ever an ICONS key lookup.
  function socialSlide(s) {
    return icon(s.platform) + '<span class="np-handle">' + escapeHtml(s.handle) + '</span>';
  }

  // ── Plate CSS + builder ─────────────────────────────────────────────────────
  // Everything routes through var(--np-*, fallback), so pages re-skin by
  // declaring the variables (docs/THEMING.md) — or not at all.
  const PLATE_CSS =
    '.np-plate{display:inline-flex;flex-direction:column;gap:2px;' +
      'background:var(--np-bg, rgba(10,14,18,.72));' +
      'border-left:3px solid rgb(var(--np-accent, 34, 211, 238));' +
      'border-radius:var(--np-radius, 10px);padding:var(--np-pad, 8px 14px);' +
      "font-family:var(--np-name-font, 'Segoe UI', system-ui, sans-serif);max-width:100%}" +
    '.np-plate[hidden]{display:none}' +
    '.np-name{font-size:var(--np-name-size, 20px);font-weight:var(--np-name-weight, 700);' +
      'color:var(--np-name-color, #eef2f5);line-height:1.2;white-space:nowrap;' +
      'overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px rgba(0,0,0,.7)}' +
    '.np-plate.no-socials .np-socials{display:none}' +
    '.np-rot{display:inline-flex;align-items:center;gap:6px;' +
      'color:var(--np-handle-color, #b9c4cd);font-size:var(--np-handle-size, 13px);' +
      'transition:opacity .24s ease, transform .24s ease}' +
    '.np-rot svg{width:var(--np-icon-size, 15px);height:var(--np-icon-size, 15px);' +
      'color:rgb(var(--np-accent, 34, 211, 238));flex:none}' +
    '.np-handle{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.np-rot.rot-out{opacity:0;transform:translateY(4px)}' +
    '.np-rot.rot-in{animation:np-in .24s ease}' +
    '@keyframes np-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}';

  function injectCss() {
    if (document.getElementById('np-shared-css')) return;
    const style = document.createElement('style');
    style.id = 'np-shared-css';
    style.textContent = PLATE_CSS;
    document.head.appendChild(style);
  }

  // Builds a plate under `parent` and returns { root, setEntry }.
  // opts: { accent: 'R, G, B'|null, nameSizePx: int|0, displayMs?, swapMs? }.
  // setEntry(entry|null) is signature-deduped — the Discord voice feed re-renders
  // consumers up to ~10×/s and must not restart the rotator mid-cycle.
  function buildPlate(parent, opts) {
    const o = opts || {};
    const root = document.createElement('div');
    root.className = 'np-plate';
    root.hidden = true;
    if (o.accent) root.style.setProperty('--np-accent', o.accent);
    if (o.nameSizePx > 0) {
      root.style.setProperty('--np-name-size', o.nameSizePx + 'px');
      root.style.setProperty('--np-handle-size', Math.max(11, Math.round(o.nameSizePx * 0.65)) + 'px');
      root.style.setProperty('--np-icon-size', Math.max(12, Math.round(o.nameSizePx * 0.75)) + 'px');
    }

    const name = document.createElement('div');
    name.className = 'np-name';
    const socials = document.createElement('div');
    socials.className = 'np-socials';
    const rot = document.createElement('span');
    rot.className = 'np-rot';
    socials.appendChild(rot);
    root.appendChild(name);
    root.appendChild(socials);
    parent.appendChild(root);

    const rotator = makeRotator(rot, socialSlide, { displayMs: o.displayMs, swapMs: o.swapMs });
    let lastSig = '';

    function setEntry(entry) {
      const sig = entry ? JSON.stringify(entry) : '';
      if (sig === lastSig) return;
      lastSig = sig;
      if (!entry) {
        root.hidden = true;
        rotator.setItems([]);
        return;
      }
      name.textContent = entry.displayName; // textContent — XSS-safe
      name.title = entry.displayName;
      const list = Array.isArray(entry.socials) ? entry.socials : [];
      root.classList.toggle('no-socials', list.length === 0);
      rotator.setItems(list);
      root.hidden = false;
    }

    return { root, setEntry };
  }

  return {
    ICONS, icon, escapeHtml,
    sanitizeSocials, sanitizeDirectory,
    findByLabel, findByUserId, resolvePlateEntry, canon, fold, hasGlyph,
    ACCENTS, accentTriplet,
    makeRotator, socialSlide,
    injectCss, buildPlate,
  };
})();
