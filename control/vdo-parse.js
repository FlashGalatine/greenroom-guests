// Greenroom guestList parser — the ONE place that understands the shape of
// vdo.ninja's director `getGuestList` reply. Both control pages (control.html,
// director-min.html) and verify.mjs load this, so a vdo.ninja shape change is a
// single-file repair, not a hunt.
//
// The reply shape (verified empirically against live rooms, NOT a versioned spec —
// treat defensively): { guestList: { "<n>": { streamID, label, ... }, ... }, cib }
//
// Rules:
//   • anything that isn't an object with an object `guestList` → []  (never throw)
//   • both `label` and `streamID` must be non-empty after String().trim() —
//     the director's OWN connection reports an empty label, which is how it gets
//     dropped from the roster (and an unlabeled guest can't be slot-bound anyway)
//   • duplicate labels are kept as-is; the slot resolver's Map(label→streamID)
//     makes the last one win, matching the original ControlPanel behavior.

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

  globalThis.VdoParse = { parseGuestList };
})();
