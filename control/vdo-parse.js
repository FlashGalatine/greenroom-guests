// Greenroom guestList parser — the ONE place that understands the shape of
// vdo.ninja's director `getGuestList` reply, and the rules for turning a roster
// into a slot's streamID. Both control pages (control.html, director-min.html) and
// verify.mjs load this, so a vdo.ninja shape change is a single-file repair, not a hunt.
//
// The reply shape (verified empirically against live rooms, NOT a versioned spec —
// treat defensively): { guestList: { "<n>": { streamID, label, ... }, ... }, cib }
//
// Rules:
//   • anything that isn't an object with an object `guestList` → []  (never throw)
//   • both `label` and `streamID` must be non-empty after String().trim() —
//     the director's OWN connection reports an empty label, which is how it gets
//     dropped from the roster (and an unlabeled guest can't be slot-bound anyway)
//   • duplicate labels are kept in the roster; resolveSlot() decides who a slot follows
//   • guestListOk() says whether a reply was RECOGNISED at all: a reply whose guestList
//     is not an object, or has entries but none with a streamID, is a shape change (or a
//     different page answering), never "the room is empty"

(function () {
  'use strict';

  function parseGuestList(data) {
    const out = [];
    if (!data || typeof data !== 'object') return out;
    const gl = data.guestList;
    if (!gl || typeof gl !== 'object') return out;
    for (const key of Object.keys(gl)) {
      const g = gl[key];
      if (!g || typeof g !== 'object') continue;
      const label = String(g.label ?? '').trim();
      const streamID = String(g.streamID ?? '').trim();
      if (!label || !streamID) continue;
      out.push({ label, streamID });
    }
    return out;
  }

  // Guests that are in the room with a stream but without a label (a guest who cancelled the name prompt). The director's own entry
  // (key '0', empty label) is not a guest.
  function countUnlabeled(data) {
    const gl = data && typeof data === 'object' ? data.guestList : null;
    if (!gl || typeof gl !== 'object' || Array.isArray(gl)) return 0;
    let n = 0;
    for (const key of Object.keys(gl)) {
      if (key === '0') continue;
      const g = gl[key];
      if (g && typeof g === 'object' && String(g.streamID ?? '').trim() && !String(g.label ?? '').trim()) n++;
    }
    return n;
  }

  // Was this reply in a shape we understand? An empty guestList ({}) is recognised: the room really may be empty.
  function guestListOk(data) {
    if (!data || typeof data !== 'object') return false;
    const gl = data.guestList;
    if (!gl || typeof gl !== 'object' || Array.isArray(gl)) return false;
    const keys = Object.keys(gl);
    if (!keys.length) return true;
    // At least one entry has a streamID AND a label property (the director's own entry has label: ''). A reply where only
    // one of the two was renamed would otherwise parse to an empty roster and read as "everyone left".
    return keys.some((k) => gl[k] && typeof gl[k] === 'object' && 'label' in gl[k] && String(gl[k].streamID ?? '').trim() !== '');
  }

  // Which live stream does a label follow? A unique label follows its (one) stream. A label shared by several guests
  // keeps the stream it already had if that is still in the room, else nobody (fail closed: anyone in the room can pick
  // a label, so a joiner must not take over a slot by choosing the same one). pinnedID, when given and still in the
  // room under that label, wins (reserved for a per-slot push-ID pin).
  function resolveSlot(roster, label, prevStreamID, pinnedID) {
    if (!label) return '';
    const matches = (roster || []).filter((g) => g && g.label === label);
    if (!matches.length) return '';
    if (pinnedID) return matches.some((g) => g.streamID === pinnedID) ? pinnedID : ''; // a pinned slot follows only that stream
    if (matches.length === 1) return matches[0].streamID;
    return matches.some((g) => g.streamID === prevStreamID) ? prevStreamID : '';
  }

  // The labels more than one live stream is using, as Map(label → [streamIDs]).
  function duplicateLabels(roster) {
    const by = new Map();
    for (const g of roster || []) { if (!by.has(g.label)) by.set(g.label, []); by.get(g.label).push(g.streamID); }
    for (const [k, v] of [...by]) if (v.length < 2) by.delete(k);
    return by;
  }

  // The streamID a slot should carry after a director reply. sess = { startedAt, seen: Set } belongs to one load of the
  // director iframe (the pages reset it whenever the iframe's src is set).
  //   • an empty label is never bound
  //   • a label the room reports now: its stream, and the label joins sess.seen
  //   • a label this load has SEEN and has now lost: blank at once (the guest left)
  //   • a label this load has not reported yet: keep the held stream while the load is younger than settleMs, so a cold
  //     director (an empty or partial first reply) cannot blank guests who are on air; after that it is blank
  function resolveSlotID(label, heldID, byLabel, sess, now, settleMs) {
    if (!label) return '';
    const live = byLabel && byLabel.get(label);
    if (live) { sess.seen.add(label); return live; }
    if (sess.seen.has(label)) return '';
    return (sess.startedAt == null || now - sess.startedAt < settleMs) ? String(heldID || '') : '';
  }

  // The whole rule in one place (what the pages call): which stream does this slot carry after a director reply?
  //   • no label: none; a pinned stream that is in the room under the label: that one
  //   • the stream the slot already holds is still among the guests using the label: it stays (a shared label stays with it)
  //   • the label is not in the room: seen this load and now lost → none at once; not reported yet → the held stream while
  //     the load is settling (sess.startedAt is set by the first recognised reply), else none
  //   • the label is in the room but only under OTHER streams: while the load is settling and the label has not been
  //     confirmed, the held stream stays (a newcomer reported first must not take a guest who is on air); after that a lone
  //     stream is followed (a rejoin under a new ID) and a shared label gives none (fail closed)
  function resolveStream(roster, label, heldID, pinnedID, sess, now, settleMs) {
    if (!label) return '';
    const held = String(heldID || '');
    const matches = (roster || []).filter((g) => g && g.label === label);
    const settling = sess.startedAt == null || now - sess.startedAt < settleMs;
    if (pinnedID) { // a pinned slot follows only that stream: an impostor under the same label is ignored
      if (matches.some((g) => g.streamID === pinnedID)) { sess.seen.add(label); return pinnedID; }
      return !sess.seen.has(label) && settling && held === pinnedID ? held : '';
    }
    if (held && matches.some((g) => g.streamID === held)) { sess.seen.add(label); return held; }
    if (!matches.length) return sess.seen.has(label) ? '' : (settling ? held : '');
    if (held && !sess.seen.has(label) && settling) return held;
    sess.seen.add(label);
    return matches.length === 1 ? matches[0].streamID : '';
  }

  globalThis.VdoParse = { parseGuestList, countUnlabeled, guestListOk, resolveSlot, resolveSlotID, resolveStream, duplicateLabels, SETTLE_MS: 10000 };
})();
