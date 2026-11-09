// Greenroom revision tracking — how a control page tells "my own push coming back" from "somebody else's state", and which of two
// states is the newer. Shared by control.html and director-min.html (both load it from this folder; verify.mjs runs it on its own).
//
// vdo.state carries three bookkeeping fields next to the config (docs/PROTOCOL.md):
//   schemaVersion  2: a page that reads a higher one shows "reload this page" and pushes nothing
//   rev            a number that grows with every push: max(Date.now(), highest rev received + 1, this page's last rev + 1), chosen
//                  only when the push is really sent (a push that could not be sent uses none)
//   writer         a random id per page load, so two pages that stamp the same rev can still be told apart
// A payload with no rev comes from a page older than this scheme (or a restore): it is a "legacy write", always adopted, never
// treated as rev 0. Every signature below is taken over the state WITHOUT these three fields (and with the keys sorted), so a
// dedupe still works when only the stamp differs and when Streamer.bot hands the text back in another key order.
//
// What receive() answers for a vdo.state this page has just been sent:
//   'echo'    this page's own push (or an older one of its own) coming back: never adopted. Matched by writer and rev, never by
//             the bytes, because Streamer.bot may rewrite the text (a lone surrogate comes back as U+FFFD)
//   'stale'   a rev below the highest this page has received: dropped (GRN-04). Equal revs are broken by the writer id (the
//             larger id wins) so that two pages pick the same winner
//   'newer'   a higher rev (or the winner of an equal one): adopt it
//   'same'    the very payload this page already holds (same rev, same writer): adopt it, it changes nothing
//   'legacy'  no rev: adopt it, and let the next push of this page stamp one
// This is convergence, not protection of an edit: of two pushes sent in the same window, the later one Streamer.bot runs wins in
// the store even if its rev is lower.

(function () {
  'use strict';
  const META = ['schemaVersion', 'rev', 'writer'];
  const SCHEMA_VERSION = 2;

  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function parse(p) {
    if (typeof p === 'string') { try { return JSON.parse(p); } catch (_) { return null; } }
    return p;
  }
  function withoutMeta(p) {
    const v = parse(p);
    if (!isObj(v)) return null;
    const o = {};
    for (const k of Object.keys(v)) if (!META.includes(k)) o[k] = v[k];
    return o;
  }
  // The signature of a state: '' when it is not an object.
  function sigOf(p) {
    const o = withoutMeta(p);
    return o ? canonical(o) : '';
  }
  // The rev of a payload (an object or its JSON text): a positive whole number, or 0 when there is none (a legacy write).
  function revOf(p) {
    const v = parse(p);
    const n = isObj(v) ? Number(v.rev) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  function writerOf(p) {
    const v = parse(p);
    return isObj(v) && typeof v.writer === 'string' ? v.writer : '';
  }
  // How two signatures differ: 'same', 'ids' (only slots[].streamID differ) or 'other'.
  function diffKind(sigA, sigB) {
    if (sigA === sigB) return 'same';
    const a = parse(sigA), b = parse(sigB);
    if (!isObj(a) || !isObj(b)) return 'other';
    const blank = (o) => Object.assign({}, o, { slots: Array.isArray(o.slots) ? o.slots.map((s) => (isObj(s) ? Object.assign({}, s, { streamID: '' }) : s)) : o.slots });
    return canonical(blank(a)) === canonical(blank(b)) ? 'ids' : 'other';
  }
  function newWriterId() {
    try {
      const a = new Uint32Array(2);
      globalThis.crypto.getRandomValues(a);
      return 'w' + a[0].toString(16).padStart(8, '0') + a[1].toString(16).padStart(8, '0');
    } catch (_) {
      return 'w' + Math.random().toString(16).slice(2, 10).padEnd(8, '0') + Date.now().toString(16).slice(-8).padStart(8, '0');
    }
  }

  // o: { now() → ms, writer }
  function create(o) {
    const opts = o || {};
    const now = opts.now || (() => Date.now());
    const writer = opts.writer || newWriterId();
    let highest = 0;         // the highest rev received from Streamer.bot, this page's own echoes included
    let highestWriter = '';  // who wrote it
    let lastSent = 0;        // the rev of the last push this page really sent
    let inflight = [];       // [{ rev, at }]: pushes sent and not yet seen coming back

    return {
      writer,
      get highest() { return highest; },
      get highestWriter() { return highestWriter; },
      get lastSent() { return lastSent; },
      get inflight() { return inflight.slice(); },
      // The rev for a push about to be sent. Nothing is recorded until sent() says it went out.
      nextRev() { return Math.max(now(), highest + 1, lastSent + 1); },
      // The text to send for a state: the state with its bookkeeping fields. Returns { rev, text }.
      stamp(state) {
        const rev = this.nextRev();
        const body = Object.assign({}, withoutMeta(state), { schemaVersion: SCHEMA_VERSION, rev, writer });
        return { rev, text: JSON.stringify(body) };
      },
      // The push with this rev was really sent (the socket took it).
      sent(rev) {
        lastSent = Math.max(lastSent, rev);
        inflight.push({ rev, at: now() });
      },
      // Streamer.bot refused it: it is not in flight any more (and never will be).
      refused(rev) { inflight = inflight.filter((e) => e.rev !== rev); },
      // The oldest push still waiting to come back, in ms (0 when none).
      oldestPendingMs() { return inflight.length ? now() - Math.min(...inflight.map((e) => e.at)) : 0; },
      pending(rev) { return inflight.some((e) => e.rev === rev); },
      // A vdo.state arrived (the parsed object). Updates what this page has seen and says what to do with it.
      receive(v) {
        const rev = revOf(v);
        if (!rev) return { kind: 'legacy', rev: 0, writer: '' };
        const w = writerOf(v);
        if (w === writer && rev <= lastSent) { // this page's own push, or an older one of its own: it already holds that
          inflight = inflight.filter((e) => e.rev > rev);
          if (rev > highest || (rev === highest && w > highestWriter)) { highest = rev; highestWriter = w; }
          return { kind: 'echo', rev, writer: w };
        }
        if (rev < highest) return { kind: 'stale', rev, writer: w };
        if (rev === highest) {
          if (w === highestWriter) return { kind: 'same', rev, writer: w };
          if (w < highestWriter) return { kind: 'stale', rev, writer: w };
        }
        highest = rev; highestWriter = w;
        return { kind: 'newer', rev, writer: w };
      },
    };
  }

  globalThis.GRRev = { create, sigOf, revOf, writerOf, diffKind, canonical, META, SCHEMA_VERSION };
})();
