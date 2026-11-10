// The rules for the bridge's saved settings and ids, in one place. Dependency-free and with no side effects: importing this file starts
// nothing (the bridge starts main() when it is imported), so the mock bridge (mock-discord-bridge.mjs) and the tests can use the very same rules.

// What the overlays and the control page read from `discordVoice.settings`. (There used to be a `height` here that nothing read.)
export const DEFAULT_SETTINGS = {
  streamerUserId: '',  // the streamer's Discord user id (digits), shown first in the roster
  avatarPx: 56,        // 24..128
  streamerPx: 72,      // 32..160
  accent: 'cyan',      // 'cyan' | 'magenta' | 'neon-green'
  scanlines: true,
  neonBlink: true,
  hideWhenAbsent: true,
  // Lifecycle (not a render setting): when true, the sidecar gracefully leaves the voice call and exits once Streamer.bot closes, so the
  // bot doesn't linger in the channel after you close SB. GREENROOM_EXIT_ON_SB_CLOSE / --exit-on-sb-close override it. Opt-in.
  exitOnSbClose: false,
};
export const ACCENTS = ['cyan', 'magenta', 'neon-green'];

// An integer clamped to a range; null, '', a boolean or anything that is not a number gives the fallback (Number(null) and Number(true)
// are 0 and 1, which would silently become a size).
export function clampInt(v, min, max, fallback) {
  // Only a number, or a string that is written as one (Number([]), Number(' ') and Number([100]) would be 0, 0 and 100).
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// Only the digits of an id (a pasted "<#123>" or a space gets cleaned); a number is read as the text it was written as.
export const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '');
// A Discord snowflake as it should be saved by hand: 17 to 20 digits, as text.
export const SNOWFLAKE_RE = /^\d{17,20}$/;
export const isSnowflake = (v, re = SNOWFLAKE_RE) => typeof v === 'string' && re.test(v);

// A name cut to n characters by code point, never in the middle of a surrogate pair (a lone surrogate comes back from Streamer.bot as U+FFFD).
export const cutName = (s, n) => Array.from(String(s ?? '')).slice(0, n).join('');

// JSON.parse that keeps a bare number written for an id as the text it was written as: an unquoted 18-digit id is not a safe integer and
// would lose its last digits. (Node 22 passes the source text to the reviver.)
const ID_KEYS = new Set(['serverId', 'channelId', 'streamerUserId']);
export function parseJson(text) {
  return JSON.parse(text, (key, value, ctx) => (typeof value === 'number' && ID_KEYS.has(key) && ctx && typeof ctx.source === 'string' ? ctx.source : value));
}

// Like parseJson, for a file that is written back (the token file): ANY integer that is not a safe integer keeps the digits it was written with
// (JSON.rawJSON), so rewriting the file does not change them.
export function parseJsonLossless(text) {
  return JSON.parse(text, (key, value, ctx) => (typeof value === 'number' && !Number.isSafeInteger(value) && ctx && typeof ctx.source === 'string' && /^-?\d+$/.test(ctx.source) ? JSON.rawJSON(ctx.source) : value));
}

// A favorite as it is saved: ids as digits that must look like a Discord id (`idRe`), the name cut by code point and given a fallback; null
// when it cannot be one. The one rule for favorite-add, favorite-update and (with the same id test) the saved config.
export function normalizeFavorite({ name, serverId, channelId }, idRe = SNOWFLAKE_RE) {
  const sId = digitsOnly(serverId), cId = digitsOnly(channelId);
  if (!idRe.test(sId) || !idRe.test(cId)) return null;
  return { name: cutName(name ?? '', 80) || `${sId.slice(-4)}/${cId.slice(-4)}`, serverId: sId, channelId: cId };
}

// Merge `updates` into `base`: only the known keys are copied, each by its own rule, and anything of the wrong type is ignored (the value in
// `base` stays). Used when the config is loaded and when set-settings arrives, so a hand-edited file and a forged bus command are held to the
// same rules.
export function sanitizeSettings(base, updates) {
  const out = { ...DEFAULT_SETTINGS };
  const src = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  const take = (u) => {
    if (!u || typeof u !== 'object' || Array.isArray(u)) return;
    if (u.streamerUserId !== undefined && (typeof u.streamerUserId === 'string' || typeof u.streamerUserId === 'number')) out.streamerUserId = digitsOnly(u.streamerUserId);
    if (u.avatarPx !== undefined) out.avatarPx = clampInt(u.avatarPx, 24, 128, out.avatarPx);
    if (u.streamerPx !== undefined) out.streamerPx = clampInt(u.streamerPx, 32, 160, out.streamerPx);
    if (typeof u.accent === 'string' && ACCENTS.includes(u.accent)) out.accent = u.accent;
    for (const k of ['scanlines', 'neonBlink', 'hideWhenAbsent', 'exitOnSbClose']) if (typeof u[k] === 'boolean') out[k] = u[k];
  };
  take(src);
  take(updates);
  return out;
}
