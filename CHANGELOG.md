# Changelog

All notable changes to **Greenroom** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Nothing has been tagged since the initial release, so every change that landed
afterwards sits under **Unreleased**. Commit hashes and landing dates are noted
for traceability.

## [Unreleased]

### Added

- **Searchable, collapsible guest directory with auto-populate.** The directory
  was a flat list of six controls per guest — unusable past ~10 entries, and
  every name had to be typed before a nameplate could appear. Rows are now
  collapsed summaries (live dot · display name · match keys · socials count)
  that expand into the full editor, above a bar with search, "live only",
  "auto-add guests", a count pill and **+ Add guest**. Search matches the
  on-stream name, VDO label, Discord ID, the guest's live Discord username and
  their social handles. New shared `control/directory-core.js` owns the
  sanitizers plus `autoPopulate()` and is loaded by **both** control pages, so
  `director-min.html` — the 1×1 always-on source — fills the directory in with
  no operator present. New wire fields: `auto`, `directoryAutoAdd`,
  `directoryIgnored`. `verify` 105/105, `verify:render` 44/44.
  (`5220f8d`, 2026-07-24)
- **Config backup — snapshot / restore the SB `vdo.state`.** The dock config
  (room, password, slots, invite, guest directory / nameplates) lived only in
  Streamer.bot's persisted global with no file copy. Two routes now, both
  round-tripping through `VDO Sync` / `VDO Push` so a restore persists exactly
  like an operator edit: **Export config / Import config** buttons on the
  control page, and a CLI `backup.mjs` (`npm run backup`, `backup:list`,
  `backup:restore`). Snapshots contain the room password, so `backups/` is
  gitignored. `verify` 81/81. (`73a84fe`, 2026-07-12)
- **Opt-in "leave call & quit when Streamer.bot closes"** for the Discord
  bridge. The sidecar is launched detached by SB, so closing Streamer.bot left
  the bot parked in the voice channel until manually booted. When enabled,
  losing SB's WebSocket past a grace window makes the bridge do a proper voice
  disconnect + gateway logout and exit; an SB restart inside the window cancels
  the shutdown. Default stays reconnect-forever. Set via
  `settings.exitOnSbClose` (control-page checkbox) or the
  `GREENROOM_EXIT_ON_SB_CLOSE` env override (env wins), with
  `GREENROOM_SB_EXIT_GRACE_MS` (default 8000). `verify` 74/74.
  (`c25a0b4`, 2026-07-12)
- **Guest directory + nameplates** — on-stream names and socials for matched
  guests. A new top-level `directory` key in the VDO payload (zero C# changes —
  it rides the persisted superset config store) maps a VDO.ninja label and/or
  Discord user ID to a display name and social handles, edited in the new
  "Nameplates & Guest Directory" control-page section. Rendered on three
  surfaces: a lower third inside `vdoninja-guest.html` (`?nameplate=0` to
  hide), the new standalone `nameplate.html?slot=N` source, and a chip-name
  override in the roster overlay. No directory entry → no nameplate. Themed
  with `--np-*` CSS variables. `verify` 70, `verify:render` 32.
  (`9784963`, 2026-07-11)
- **Per-slot Copy / Open buttons** for each guest's OBS Browser Source URL, so
  the operator never hand-types `vdoninja-guest.html?slot=N`. The URL is derived
  from where the control page is served (same origin, sibling overlay map,
  carrying `?sbport` in dev) rather than hardcoded, so it tracks whatever HTTP
  prefix was mapped. (`38dadf4`, 2026-07-10)

### Changed

- **SB HTTP prefixes namespaced to `greenroom-control` / `greenroom-overlay`.**
  A live probe of the resident Streamer.bot found the generic `overlay` prefix
  already claimed by SlowPan (and `shared` / `themes` by Tally). The docs now
  recommend collision-proof namespaced maps; the mock serves both spellings so
  every documented URL still works against it. (`9283e58`, 2026-07-10)
- Sidecar uses `clientReady` instead of the deprecated `ready` event
  (discord.js ≥ 14.22), silencing the warning on every login and future-proofing
  for v15. (`0943e3e`, 2026-07-10)

### Documentation

- README: clone / Download-ZIP as the first setup step. (`b5edab6`, 2026-07-21)
- Standardized attribution, Author & support block and dependency credits ahead
  of publishing. (`6011f8c` / `b1977bf`, 2026-07-20)
- **Live-validation results recorded (Streamer.bot 1.0.4, 2026-07-10).** All
  eight checklist items exercised on a real rig, no code changes needed. The
  headline: the OBS **Custom Browser Dock** CEF spike passed — the director
  iframe enumerates and pushes from inside the dock, so the dock alone drives
  auto-follow and the pinned-tab fallback is retired. Also confirmed: real-room
  drop/rejoin auto-follow (with the `&sticky` same-ID nuance), live Discord
  speaking events, token / E2EE onboarding, persisted `vdo.state` surviving an
  SB restart, and the 100 ms coalesce floor. Carried forward as open:
  multi-director safety. (`e27c437`, 2026-07-10)

## [0.1.0] — 2026-07-10

Initial release — VDO.ninja guest dock + Discord voice roster for Streamer.bot.
(`98ae50d`)

### Added

- **Four-slot VDO.ninja guest dock.** Streamer.bot's WebSocket is the whole
  two-way bus and its HTTP server serves everything; five pasted zero/one-
  reference C# actions cache and rebroadcast state (`vdo.state` persisted,
  `discord.state` deliberately not).
- **Auto-follow on rejoin** — label → streamID re-resolution every 2.5 s, run
  from the control pages. `director-min.html` is the always-on 1×1-source
  variant.
- **Standalone Discord voice-roster overlay** (new alongside the port) with
  mute / deaf badges, streamer-first ordering and CSS-variable theming.
- Optional `discord.js` bridge sidecar — the only process in the component.
  Its token is file-only and never travels the bus.

Verified offline: `verify` 63/63 (transport, push round-trips, SB-restart
persistence semantics, command bus, token-less real sidecar, malformed
`guestList` parsing, tripwires) and `verify:render` 22/22 (rejoin swap through
a scripted fake director, PFP glow, roster badges, 20-user 100 ms burst,
control page).

[Unreleased]: https://github.com/FlashGalatine/greenroom-guests/compare/98ae50d...main
