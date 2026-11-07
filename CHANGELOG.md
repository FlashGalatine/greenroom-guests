# Changelog

All notable changes to **Greenroom** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the patch number is
the number of commits on `main` before the release commit.

Nothing was released between the initial release and 1.0.13, so that release
collects every change in between. Commit hashes and landing dates are noted for
traceability. Each release is tagged `v<version>` on its Release commit; the
tags `v0.1.0` and `v1.0.13` were added afterwards, on those two commits.

## [1.0.29] — 2026-11-07

The overlays and control pages share one, more careful way of talking to Streamer.bot: they connect once the page is ready, check what Streamer.bot answers, reconnect quickly, and accept the string-field state frames a later action release will send. Nothing to re-paste: this release works with the actions you already have.

### Fixed

- **An overlay could come up blank, or stay greyed out.** The overlay opened its Streamer.bot socket while the page was still loading, so the first `VDO Sync` replay could arrive before the page was listening and be lost, and the "offline" grey could be applied after the socket had already connected. The socket is now opened once the page is ready, with one repeat of `VDO Sync` if no state has come back after 2.5 s.
- **The speaking glow no longer sticks.** When the socket closes (Streamer.bot quit or restarted), a Discord-mode guest slot clears its glow and keeps the avatar.
- **A guest slot survives odd state.** A `null` entry in the slot list no longer stops the guest overlay painting, and a frame carrying no state (a bare `{"type":"sync"}`) no longer blanks the slot.
- **`?sbport` is checked.** It accepts only a port number from 1 to 65535 and the host is always `127.0.0.1`. Anything else shows "invalid ?sbport" (on the dock pill, the `director-min` status or the overlay's offline state and console), does not connect and does not fall back to 8080; Save on such a page says so instead of asking to replace a saved config it cannot reach. The OBS source URLs the dock copies carry `?sbport` only when it is valid.
- **Replies are checked, not assumed.** A refused `Subscribe` or `DoAction` is now shown ("SB: Subscribe refused (…)", "SB: DoAction "VDO Sync" refused (…)") instead of looking like a healthy connection, and no `VDO Sync` is sent, nor any retry loop left running, after a refused `Subscribe`. These notices clear as soon as requests work again or the saved config arrives another way. A refused push is no longer remembered as sent: it is offered again (at most every 10 s, so a Streamer.bot that refuses everything is not hammered), and the dock says "Not accepted" until a retry is saved. A reply with no `status` field is still treated as accepted.
- **Authentication is named, but only when it matters.** Streamer.bot sends an authentication block in its Hello whenever Authentication is on, and serves requests anyway unless Enforce is on. Greenroom no longer reacts to the block alone; if requests are then refused, or Streamer.bot hangs up, the notice reads "SB auth enforced — turn Enforce off", and it goes away on the next healthy connection. A Streamer.bot that is simply not running shows "offline".
- **Reconnects are quicker and still back off.** One shared helper (1 s, growing to 4 s, instead of 2 s growing to 15 s) in the overlays, the dock and `director-min`. The delay is reset only after a healthy session, so a Streamer.bot that accepts and then drops no longer makes every client retry at the shortest delay.
- A socket that closes before its sync timer fires no longer leaves a sync behind.

### Added

- **The overlays read the string-field frames** (`vdoninjaJson`, `discordVoiceJson`) as well as the old object fields, ahead of the action release that sends them. A frame whose string does not parse to a plain object is dropped, never shown as "clear".
- The overlay shim dispatches a `svc:disconnect` event when the socket closes.
- The overlay's directory sanitiser passes unknown fields through, the same as the dock's, and `verify` now checks that the two copies, and the three copies of the connection helper, agree.
- Test support: the mock Streamer.bot can serve a file late, answer `Subscribe` with the documented flat shape (`{status, id, events}`) or an error, late or not at all, refuse `DoAction`, send a Hello (plain or with an authentication block, enforced or not), deliver `data` as a JSON string, drop a sync replay, accept-then-drop connections, and switch these behaviours while running; `verify-render` can run just the connection scenarios (`RENDER_ONLY=conn`) and fences the invalid-`?sbport` probes so they can never reach a real Streamer.bot. `verify` 118/118 and `verify:render` 172/172 cover the above.

**Deploy:** copy the `overlay/` and `control/` folders, refresh every Greenroom OBS browser source, and reload the dock and the `director-min` source. No action to re-paste, nothing to restart.

## [1.0.24] — 2026-11-07

The control pages no longer write built-in defaults over your saved config, and the dock's Export and Import are honest about what they do. Nothing to re-paste: this release works with the actions you already have.

### Fixed

- **A cold start or reload that missed the first `VDO Sync` could overwrite your saved config.** If Streamer.bot's reply was late or never came (a restart, an uncompiled `VDO Sync`), a 1.2 s timer let the control page treat its built-in defaults as real, and the next voice-feed auto-add or edit pushed them over the persisted `vdo.state`. Both control pages now wait for a real answer before they push anything on their own. `VDO Sync` is asked again after 2, 4 and 8 s, then every 15 s, and the dock says why it is waiting (after about 5 s it names both causes: a fresh install, or `VDO Sync` missing or not compiled). Anything you do before the answer arrives (Save, Import, a slot, directory, invite or director change) asks once ("Streamer.bot has not returned your saved config; saving now replaces it"); answer no and nothing is pushed. If the saved config arrives while that question is open, it wins and nothing is pushed over it. When it first arrives, the slot and directory panels are redrawn from it, so a leftover default row cannot be pushed by your next edit.
- **Save and Import now always push.** Save with no edit, and Import of the dock's own export, re-seed a wiped `vdo.state` instead of being skipped as "unchanged". The dock says "Sent to Streamer.bot" only when the push really left; with Streamer.bot unreachable it says "Not sent" and the next poll retries.
- **A frame with no usable state is dropped.** A `vdoninja:update` with no payload, an unparseable string, or something that is not a config can no longer mark a page synced, enable Export or trigger a push.
- **A change to one invite option no longer drops invite fields it does not know.**

### Added

- **The pages read the state from escaped string fields** (`vdoninjaJson`, `discordVoiceJson`) as well as the old object fields, ahead of a later action release that sends them.
- **Newer fields survive.** Both control pages pass fields they do not know through every push (top level, slots, directory entries and their socials, invite), and never copy `rev` or `writer`, which a later release reserves. They send `schemaVersion: 1`; a saved config with a higher version is shown but never pushed over, Export is disabled for it, and the page says "reload this page".
- **Export waits for your config and says what it saved.** The button stays disabled until a real config has reached the page (a fresh install can export after its first push). After a click the dock shows `Saved greenroom-vdo-<date>.json` and a one-line summary; inside an OBS dock it also shows the JSON in a box with a Copy button (OBS 33 may save the file silently, OBS 32 and older may not save it at all). The tooltip now says the file includes the room password.
- **Import checks what it is given.** It refuses a Discord ID written as a number (the digits are already rounded), a non-text room, a backup of a different kind and a backup from a newer Greenroom, and its confirm counts the guest entries that will survive and how many are dropped.
- **Auto-add skips names that look like timestamps**, and the error pill names such an entry. The actions get their own fix in a later release.
- Test support: the mock Streamer.bot can delay `VDO Sync`, clear `vdo.state`, send raw frames and use the string wire; `verify` and `verify:render` cover the above.

**Deploy:** copy the `control/` folder, reload the Greenroom dock and refresh the `director-min` source. No action to re-paste, nothing to restart. `verify` 110/110, `verify:render` 110/110.

## [1.0.17] — 2026-11-07

Documentation only: no code changed, so nothing to copy or re-paste.

### Documentation

- **Keep Streamer.bot's servers on `127.0.0.1`.** Setup section 1 now says the
  HTTP and WebSocket servers must stay on loopback while the Greenroom folders are
  mapped, and that moving `sidecar/discord-tokens.json` elsewhere does not change
  that.
- **Interim warning about the auth-off WebSocket.** The README and PROTOCOL
  security notes say that any page running in OBS (a browser source or dock) can
  read the room password and drive Greenroom until authentication is supported.
- **Blocking queue for the three state actions.** Setup section 2 adds the step:
  create a new blocking Action Queue and put `VDO Push`, `Discord Voice Push` and
  `VDO Sync` on it, never the Default queue.
- **Protect your saved config.** Setup section 2 also advises ticking
  *Precompile on Application Start* on the Greenroom actions and taking an Export
  or `npm run backup` before every Streamer.bot upgrade.
- **Tags and changelog links.** `v0.1.0` and `v1.0.13` tag the two earlier
  releases and every release from here on is tagged. The preamble states the
  version rule exactly and the compare links use the tags.

**Deploy:** nothing to copy, re-paste, restart or refresh. Streamers set up the
blocking queue themselves (setup section 2). `verify` 105/105, `verify:render`
44/44.

## [1.0.13] — 2026-07-29

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

[1.0.29]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.24...v1.0.29
[1.0.24]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.17...v1.0.24
[1.0.17]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.13...v1.0.17
[1.0.13]: https://github.com/FlashGalatine/greenroom-guests/compare/v0.1.0...v1.0.13
[0.1.0]: https://github.com/FlashGalatine/greenroom-guests/releases/tag/v0.1.0
