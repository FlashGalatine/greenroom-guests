# Changelog

All notable changes to **Greenroom** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the patch number is
the number of commits on `main` before the release commit.

Nothing was released between the initial release and 1.0.13, so that release
collects every change in between. Commit hashes and landing dates are noted for
traceability. Each release is tagged `v<version>` on its Release commit; the
tags `v0.1.0` and `v1.0.13` were added afterwards, on those two commits.

## [1.0.95] — 2026-11-10

Tests, tools and housekeeping, plus one small fix to the control page: the dock showed an empty amber bar under its header at all times since 1.0.81, and it does not any more. The tests now cover the gaps the 2026-11 test audit listed, and there is a harness that checks the tests themselves.

### Fixed

- **The control page no longer shows an empty amber bar at the top.** The action-error line (the one that appears when an action reports an error) was declared `display: flex`, which overrode its `hidden` attribute, so an empty bar with a × button was on screen from the first load (introduced in 1.0.81). The test that should have noticed (`R21i2`, "the line can be dismissed") asked only whether the attribute was set; it now asks whether the line is on screen, and a new check asserts there is no bar when there is no error. The documentation screenshot of the control page showed the bar, a note that the bridge reports no version, and a note that the room differs from what was typed: it is regenerated from a payload that carries the bridge version and a room name vdo.ninja does not rewrite.

### Added

- **A mutation harness (`npm run mutation`, `tools/mutation/`).** It injects one deliberate bug at a time into a copy of the repository (never this checkout, and the copy never holds the bot token, the saved voice config or backups), runs the test suites against the copy on ports of its own with an allowlisted environment, stops at the first failing check, and records whether the bug was *killed*, *survived*, *flaky*, an *error* (a crash is not a kill), *skipped* (no C# compiler) or timed out; a baseline run of the suites without a bug comes first. It carries the audit's 85 mutants re-expressed against the current code (87 that run). The first full run killed all but 4; because it ran 8 copies at once, kills by checks unrelated to the bug were re-run with confirmation. Result: 8 survivors are equivalent or redundant (a second gate stops the same thing), 8 were real and now have tests (the 100 ms coalesce floor; a flap that ends at the first countdown; the restore refusal message; the slot mirror flag; the default avatar number; a push that changes nothing not reloading the guest video; the Manage link's room encoding; a pasted `<@id>` in the streamer-id setting), and 5 are real and carried (director-min re-adopting its own echo, a nameplate that is set again restarting its rotator, an empty-socials plate keeping a blank row, the roster's overflow chip count missing from its signature, set-current not re-arming voice). The hydrate-timer mutant that survived the audit run (a first-ever run never leaves "VDO Sync has not answered") is killed by R7a, repeatably. The full run takes hours, so it is not part of `verify`; `npm run mutation -- --check` takes a second.
- **Behavioural checks** (`verify`): the saved config after each command (a blank channel clears `current`, a nameless favorite is named from its ids, ids with letters or dashes are stored as digits, blank ids are not added, `favorite-remove`, an out-of-range `set-settings` with an unknown key and a pasted `<@id>`); the exit-when-Streamer.bot-closes cases with the real grace floor, the output of the bridge that must stay up and its reconnect when Streamer.bot returns, a flap (drop, return, drop again inside one grace window), Streamer.bot never reachable at start, and `quit` and Ctrl+C while in voice sending the leave first; a user who shares a name with an entry that already has a Discord id; a bot joining the voice channel. (`verify:render`): the roster with the streamer's name sorting last, mixed-case names and the `?max=` chip, ticking "leave call & quit" sends exactly `{"exitOnSbClose":true}`, the Manage link's encoding, and the slot-2 nameplate check waiting for its payload instead of a fixed second.
- `verify` section [6c]: no source, test or document holds a real-looking Discord ID, the screenshot tool is offline, `package.json` is private, the mutation harness loads.

### Changed

- **The test fixtures hold made-up Discord IDs** (the earlier ones looked real; history is not rewritten). `docs/roster-row.png`, `docs/roster-grid-plain.png` and `docs/control-page.png` are regenerated with neutral avatars and nothing loaded from Discord. The examples use an invented handle.
- `package.json` is `"private": true` (npm will not publish it); `.gitattributes` keeps `start-discord-bridge.bat` at CRLF in every checkout, including a ZIP download; `.gitignore` covers `.verify-*.json`, `/*-check.png` and `vdo-state-*.json`.
- The mock bridge (`npm run mock:bridge`) takes its settings, id and favorite rules from `sidecar/settings.mjs`, the bridge's own, instead of a copy. The README says which of the C# actions are compiled by which suite and that the mock never launches the bridge.

**Deploy:** copy the `control/` folder and reload the dock (and any control page you keep open); nothing to re-paste or restart. **Not changed:** the bridge, the overlays, the actions. `verify` 558/558, `verify:render` 472/472.
## [1.0.87] — 2026-11-10

The optional `Discord Bridge Start` action checks what it is about to launch and says what is wrong, finds Node even when it was installed after Streamer.bot started, and reports a bridge that exits at once. `Discord Voice Command` no longer lets a command forge a log line. Only the two actions, the documents and the tests changed: the bridge, the pages and the other actions are untouched, so the sidecar version stays where it was (1.0.84).

### Fixed

- **`Discord Bridge Start` no longer says "launched" when nothing started.** Before it launches anything it checks that `BUNDLE` is set (it now reads `C:\path\to\greenroom-guests\sidecar` until you edit it, instead of the author's own folder, and says "BUNDLE is still the placeholder"), that the folder exists, that `discord-bridge.mjs` is in it and that `node_modules` is in it; each failure logs its own specific message (edit `BUNDLE`; not the sidecar folder; run `npm install` in `sidecar/` or run `start-discord-bridge.bat` once) and the action returns false. After the launch it waits two seconds: a bridge that exits with code 0 is reported as already running (the single-instance guard found one of the same or a newer version), any other exit code is logged with its number and the hint to run `start-discord-bridge.bat`, and one that is still running after two seconds is "launched". A refusal that takes longer than that (the guard port held by another program or by an older bridge) is logged by the bridge in its own hidden window, so the "launched" line says to run `start-discord-bridge.bat` if no bridge appears.
- **Node is found even if it was installed after Streamer.bot started.** The action starts `node` as Windows finds it (Streamer.bot's own PATH, so a Node you put first in PATH wins); only if that fails because `node.exe` is not found does it look in the Node.js registry key, in `Program Files\nodejs` and in the freshly read Machine and User PATH, and start the one it finds by its full path. "node was not found in Streamer.bot's PATH" now says to restart Streamer.bot or use the `.bat`, and a start that fails for another reason names the file it tried. nvm-windows, volta and fnm are not covered.
- **A command can no longer forge a log line.** `Discord Voice Command` logs the command with control characters (line breaks, the C1 range, the Unicode line and paragraph separators and the bidi controls) as spaces and cut at 40 characters without splitting an emoji, and an error as its type and a capped message; the broadcast still carries the command whole.
- The header comments are corrected: any Streamer.bot exit that does not close the bridge (a normal close too, not only a crash or a kill) leaves it running and holding the ports, and a "Run a Program" sub-action that sets environment variables or waits for the program to exit must not be used to start it. The compile error without `System.dll` is named as the editor shows it (`CS0234 'ComponentModel'` / `CS0246 'Process'`).

### Added

- Tests: `verify` section [6b] compiles both actions with the .NET Framework C# compiler (C# 5, with only the references Streamer.bot gives an action, against a stubbed Streamer.bot API) and runs them: the sanitised log line (line break, C1 and Unicode separators, an emoji at the cut), the unedited `BUNDLE`, a missing folder, `discord-bridge.mjs` and `node_modules`, a bridge that exits 0, exits 3, stays up and one that refuses after the two-second window, a `node.exe` placed first in PATH being the one that runs, and the node search with Node missing from `PATH` and missing everywhere; plus comment-stripped checks that `UseShellExecute` stays true. The compile-and-run checks are skipped on a machine without that compiler.

### Changed

- Documents: README (restart Streamer.bot after installing Node), `docs/STREAMERBOT-SETUP.md` (the `BUNDLE` placeholder, the pre-flight, the node search order and the two-second window in the Discord Bridge Start extras, the same advice in the sidecar section, and a troubleshooting entry that names each log line).

**Deploy:** this is the second action re-paste round, and only for people who use the Discord bridge: **re-paste `Discord Bridge Start` and `Discord Voice Command` into Streamer.bot and compile both** (the References step is unchanged: add `System.dll`). If the placeholder shows in the log, set `BUNDLE` to your `…\greenroom-guests\sidecar` folder. Nothing else to copy; the bridge, the pages and the other actions are unchanged, and nothing needs a restart. Without the Discord bridge you can skip this release. **Not yet checked live** (they need Streamer.bot's own C# editor and a real launch): compiling both actions in Streamer.bot 1.0.7, and the launch with a wrong `BUNDLE` and with Node missing from `PATH` there. `verify` 537/537, `verify:render` 463/463.
## [1.0.84] — 2026-11-10

Every Greenroom piece that talks to Streamer.bot can now authenticate to it, so Streamer.bot's WebSocket **Authentication plus Enforce** can be turned on, and the bridge checks who it is talking to. Authentication stays optional: with it off nothing changes. The sidecar version is now 1.0.84.

### Added

- **The password handshake in all five clients** (the overlay pages, the control page, director-min, the Discord bridge and `backup.mjs`). Each waits about a second for Streamer.bot's Hello. If the Hello asks for authentication and the client has a password, it answers the challenge and subscribes (and syncs) only after Streamer.bot says yes, again after every reconnect. A refused password is reported where you look: the control page's pill ("SB password refused"), director-min's line, the overlay's console and grey state, the bridge's log, `backup.mjs`'s message. With no password, or with Authentication off, nothing is different (a Streamer.bot that sends no Hello is served after the wait, as before).
- **Where the password goes.** Pages: add `&sbpass=<password>` to the address of the dock, the director-min source and the roster source by hand; the control page's **Copy** and **Open** buttons for the guest-slot and nameplate sources carry it once the control page itself was opened with it (OBS stores these addresses in the scene collection, so the password is in the scene collection; it is in no other address, log line or bus message). The bridge: `"sbPassword"` in `sidecar/discord-tokens.json`, the only place it keeps one (Connect and Disable bot leave the field alone). `backup.mjs`: `GREENROOM_SB_PASSWORD`, else that same field.
- **The bridge checks the peer.** It acts only after a genuine Streamer.bot Hello: a program that says it is the Greenroom mock (the development mock) is refused, and so is silence ("no Streamer.bot Hello"), unless `GREENROOM_ALLOW_MOCK=1` (for tests). A request Streamer.bot refuses is now logged. The control page shows a permanent **MOCK Streamer.bot** banner beside the SB pill when the peer is the mock, and `backup.mjs` prints the peer it reached.
- Tests: `verify` section [8f] (the bridge against a mock peer, a genuine Hello, no Hello, a password accepted, wrong, missing and with Enforce off; the password canary in no frame, action, state, payload or log, still in the token file after Connect and Disable bot; the handshake repeated after a dropped connection; `backup.mjs` with and without the password; the shared helpers) and `verify:render` section R22 (the pages with Enforce on, with no password and a wrong one, after a dropped connection, with Enforce off, with no Hello, the Copy addresses, the MOCK banner, nothing printed to a console). The mock Streamer.bot gained `SB_PASSWORD` and `SB_HELLO=real`.

### Changed

- **Documents.** README (Security posture), `docs/PROTOCOL.md` (the handshake and where each password lives) and `docs/STREAMERBOT-SETUP.md` (a new "Optional: Streamer.bot Authentication" section) now recommend Authentication plus Enforce once everything is updated, say that Enforce (not Authentication alone) is what refuses an un-updated piece, and name the OBS sources and docks as the route that carries the password.

**Deploy:** copy the `control/`, `overlay/` and `sidecar/` folders and `backup.mjs`; **restart the bridge** (Discord Bridge Start or `start-discord-bridge.bat`: the running bridge is asked to quit and the new one takes over); reload the dock and the director-min source and refresh every OBS source. Nothing to re-paste. **Only after everything is updated, optionally turn Authentication on:** set the Streamer.bot WebSocket password; add `&sbpass=<password>` to the dock URL, the director-min source and the roster source; re-copy the guest-slot and nameplate addresses from the control page (opened with `?sbpass=`); add `"sbPassword"` to `sidecar/discord-tokens.json` and restart the bridge; set `GREENROOM_SB_PASSWORD` for `backup.mjs` (or rely on the same field); then turn on Authentication and Enforce. **Not yet checked live** (they need a real Streamer.bot with Authentication and Enforce on, and a real bot token): the real Hello's exact shape against the mock's, and the whole chain on a real install. `verify` 520/520, `verify:render` 463/463.
## [1.0.81] — 2026-11-10

The control page's Discord panel sends only what you changed, waits for the bridge before it lets you edit, and shows what the bridge reports. Only the control page and the documents changed; the bridge and the actions are not touched, so the sidecar version stays where it was (1.0.75).

### Fixed

- **A setting edit no longer overwrites the others, or gets overwritten.** The size, colour and tick-box controls stay greyed out until the bridge has reported its settings, and each edit sends only the key you changed (one `set-settings` per 400 ms): a value you set by hand in the config file (an accent colour as `R,G,B`, `exitOnSbClose` as `1`) is no longer written back as something else. A value you just sent is not flipped back by the 120 ms voice feed; the bridge's echo, or 3 seconds, ends that. A size is held to its range (24–128 and 32–160) before it is sent, a blank size or a name typed into the streamer id box sends nothing and the box shows the bridge's value again (a name says why). An edit made while Streamer.bot is unreachable is kept, the SB pill says it will be sent on reconnect, and it goes out when the connection is back.
- **The status pill says what is going on.** It shows the channel the bot watches (`in voice · 3 present · Main Hang`), `moved in Discord · 3 present — USE returns the bot` in amber when someone dragged the bot elsewhere, `reconnecting to Discord…`, that the saved channel is not joined, `bridge stopped`, and `bridge: feed stale — is the sidecar running?` when three heartbeats pass with no message (a Streamer.bot that is itself down is not blamed on the sidecar). With no feed at all it asks whether the sidecar is running and pointed at this SB port. Long texts wrap instead of being cut, and at a 460 px dock nothing runs off the side.
- **Lines under the pill.** The sticky config warning (a config that could not be used or saved), `speaking detection may have stopped: run npm update in sidecar/`, and a note when the bridge is older than the sidecar this page shipped with or reports no version.
- **Favorites.** The list repaints after USE, LOAD and remove, and ACTIVE shows only while the bot is really in that channel. **Save favorite** takes a `discord.com/channels/…` link (also ptb, canary and discordapp.com) or two ids of 17–20 digits, and says so when they are wrong; after **LOAD** the button reads `Update "<name>"` (with **New instead** to leave that mode) so a Save cannot overwrite the loaded favorite by surprise; the name is cleared only when the list shows the favorite, and a hint says so if it never does; a channel that is already saved keeps its first name and the page says so.
- **Error messages have a line of their own.** An error an action reports shows under the header, dismissible, with the whole text on hover; the SB pill keeps saying `SB: connected` while the socket is up. A VDO error stays until a VDO update arrives (the bridge's heartbeat does not wipe it); a Discord error until the next Discord update; both after 20 seconds.
- **Overlay addresses.** The Copy and Open buttons compare the `-control` / `-overlay` prefixes without regard to case (and keep your case), accept `?overlay=<prefix>` to name the overlay mapping, build `127.0.0.1` addresses when the page was opened under a LAN name, and a note under the guest slots appears when the page had to assume `greenroom-overlay`.
- **Accessibility.** Slot controls, the three status pills, the directory's captions, the expand and remove buttons and the live dots have names, the expand button keeps the focus when its row is rebuilt, and placeholders are readable.

### Added

- **Stop bridge** (asks first; sends `quit`), **Clear channel** (the bot leaves and watches nothing until you press USE) and **Disable bot** (the old **Reset auth**, relabelled: it stops the bot and keeps the token file).
- Tests: `verify:render` section R21 (`RENDER_ONLY=discordctl`, 65 checks) against the real control page and the mock Streamer.bot: hydration, changed keys only, an edit racing the feed, the hold and its echo, an edit while offline, every pill state, favorites, Save favorite, the error line, labels, overlay addresses, and the 460 px dock.

### Changed

- Documents: `docs/STREAMERBOT-SETUP.md` (the overlay prefix rule and `?overlay=`, the Discord panel), `docs/PROTOCOL.md` (how the control page reads the payload; where errors show), `CHANGELOG.md` (an early line that claimed the Copy buttons follow any prefix).

**Deploy:** copy the `control/` folder and reload the dock (and the control browser source, if you use one). Nothing to re-paste; the bridge keeps running. The version note compares the bridge with sidecar 1.0.75, the version this page shipped with. **Known limit:** VDO Sync replays the last Discord push to every page that connects, so after the bridge has died the pill can read "in voice" for up to 15 seconds each time the dock reconnects; it turns to "feed stale" by itself. `verify` 503/503, `verify:render` 452/452.
## [1.0.78] — 2026-11-09

The Discord roster and the guest slot notice when the bridge has died, the roster folds members that do not fit into a "+N" chip, and the overlays stop trusting odd payloads. Only the overlay pages and the documents changed; the bridge and the actions are not touched, so the sidecar version stays where it was.

### Fixed

- **A dead bridge no longer leaves the roster on air.** The bridge pushes at least every `hb` milliseconds (5 s). When three of those go by with no message, the roster and the guest slot call the feed stale: the roster counts as nobody there (so `hideWhenAbsent` hides it) and the guest slot's speaking glow goes out; the next push brings both back. A payload without `hb` (a bridge older than Sprint 12, or one replayed push) is never stale. `hb` counts only as a number between 1 s and 60 s, and an optional `age` only between 0 and three periods. Time is measured on the page's monotonic clock, so a step of the system clock neither hides a live feed nor keeps a dead one on air.
- **A crowded roster folds instead of running off the source.** Members that do not fit the browser source become one "+N" chip, the streamer always first, with one console warning. The fit is measured once and kept: the speaking glow keeps pulsing, nothing is redrawn on each Discord update, and a failing avatar is not asked for again. A grid lower than one chip keeps the first row. The source also clips only its trailing end if anything ever overflows.
- **`hideWhenAbsent` follows the streamer.** With a streamer id set, the roster hides when only the streamer is not in the call. The payload is no longer trusted: a `streamerUserId` that is not a string of digits is ignored, entries of `users` that are not objects are skipped, a username that is a number is shown, and `avatarPx` and `streamerPx` are held to 24–128 and 32–160.
- **Long names stay inside the source.** The nameplate (and the guest slot's) now ellipsises a long display name and a long handle inside the source; a right-to-left name is cut at its end. The guest slot's own positioning rule no longer loses to the plate's width rule.
- **The guest slot's glow follows the blink setting** (`neonBlink`), like the roster's. A picture that fails to load shows the default avatar and is tried again a minute later, not on every update.
- **A wrong `?slot` shows nothing** in the nameplate and the guest slot (it used to quietly show slot 1) and warns in the console; `?sbdebug=1` also shows a hint on the page. Only `1` to `4`, written exactly, count; the control page's Copy buttons are now the documented way to get a slot's address.

### Changed

- **Documents.** `THIRD_PARTY_NOTICES.md` (new, at the repository root): the Boxicons 2.1.4 MIT notice for the TikTok and Twitch glyphs, and the Google Material Icons Apache-2.0 notice for the Discord glyph; a provenance comment above the glyph table says which glyphs have an unconfirmed source. README has a trademark and non-affiliation line. `docs/STREAMERBOT-SETUP.md` gives the roster's source size (a member takes up to about 120 px in a row with names showing, about 86 px with `?labels=0`; 1450 × 140 holds 12 people), points to the per-slot Copy buttons, and says what a stopped feed does. `docs/THEMING.md` describes the automatic fold, and `docs/PROTOCOL.md` the liveness rules.
- The mock bridge's 20-person burst now includes the streamer, as a real call does, so `hideWhenAbsent` does not hide it.

### Added

- Tests: `verify:render` section R20 (`RENDER_ONLY=liveness`, 30 checks): a killed bridge goes stale and a push brings it back; a payload without `hb` stays live a minute later; a step of the system clock changes nothing; bad `hb` and `age` values; a crowded row and grid fold into "+N" in one measurement, stay still on further pushes (no node added, the glow's animation keeps running, no avatar asked for twice) and keep the first row of a short strip; hardened payload shapes and the streamer's own size clamp; the streamer leaving; a long Latin and a long Arabic plate; a bad `?slot`; a steady glow with `neonBlink` off; the documented source size. The older R3, R4 and R18 checks now assert that the roster they read is on air.

**Deploy:** copy the `overlay/` folder (the roster, guest-slot and nameplate pages changed; `THIRD_PARTY_NOTICES.md` is new at the repository root) and refresh the roster, guest-slot and nameplate browser sources. The stale-feed check needs the bridge from Sprint 12 or later. Nothing to re-paste; the bridge keeps running. **Known limit:** the actions do not stamp the age of a replayed push yet, so a dead bridge's last roster comes back for up to 15 seconds whenever another source or the dock connects (VDO Sync replays it); it hides again by itself. `verify` 503/503, `verify:render` 387/387.
## [1.0.75] — 2026-11-09

The Discord bridge reads and writes its files safely, holds its settings to one set of rules, and its dependencies are refreshed. The sidecar version is now 1.0.75.

### Fixed

- **A bad config or token file is never silently replaced.** The bridge reads UTF-8 and UTF-16 files, with or without a BOM (what PowerShell's `>` writes); a config that is not JSON, is `null`, is an array or is locked is **not** reseeded from the example: a copy is kept as `discord-voice-config.json.corrupt-<time>`, the bridge runs on its defaults, and when even the copy fails the file is left alone for the whole session. Only a **missing** config is seeded from the example. Temp files left by a crash are deleted at startup. Hand-edited favorites need 17 to 20 digit server and channel ids (a bare number keeps its exact digits); a repeated favorite id is made new.
- **Saves are atomic and queued.** A config or token file is written to a temp file, flushed and renamed over the target (a few retries while something locks it, then a flushed in-place write), one at a time per file in the order commands arrived; the exit waits up to 2 seconds for a save in flight. A save that fails no longer stops the change: the pick, the favorite or the Connect is used all the same, and the status shows a sticky `rpc.configWarning` ("Could not save discord-voice-config.json (EPERM): the change is not kept after a restart") that goes when a later save works.
- **The token file follows the file.** **Connect** re-reads `discord-tokens.json` every time: a corrected token is adopted, an empty one or a deleted file forgets the token, and a file that exists but is not valid JSON is reported as that (in fixed words), never as missing. The bridge never writes a token from memory: it reads the file, sets only `enabled` and writes the whole object back (so every other field survives), and never replaces a file it cannot parse. **Reset auth** now disables and stops the bot but does **not** blank the token in the file, so a forged bus command cannot erase it (delete the file by hand to forget it). Press Connect after editing the token.
- **Writes cannot empty a file.** A temp file that cannot be written (a full disk) leaves the target alone; the in-place fallback is only for a rename that keeps failing, only for the config, and puts the old bytes back if it fails; the token file is never written in place. A token file the operator saves while an update of it is in flight is merged on top of, never overwritten with the older copy; a bare big integer in any field of it keeps its digits; a Connect that is still reading it gives way to a Reset auth sent after it; "enabled" counts only when it is true. A token file that is locked says so (not "not valid JSON"), and a bad or locked token file is a sticky warning that stays after the login.
- **A bad config you fix by hand is not overwritten.** If a config was copied aside and the bridge runs on its defaults, a fix you make to the file meanwhile is left alone by the next save (the warning says to stop the bridge first and restart it). Favorites that a restart skips (a server or channel id that is not 17 to 20 digits) are named in the warning and the file is kept as a copy; favorite-add and favorite-update hold a favorite to the same rule, so nothing is saved that the loader would drop.
- **Settings and favorites are held to one set of rules** (`sidecar/settings.mjs`, shared with the mock bridge later): only known keys are taken, a wrong type changes nothing (null, an empty string or a boolean is not a size), `exitOnSbClose` turns on only for a real true, a bare-number `streamerUserId` keeps its digits, and the unused `height` setting is gone. A favorite change that would leave it without a server or a channel is refused and says so; a repeated Save adds no duplicate; a name over 80 characters is cut by code point, never through an emoji.

### Changed

- **Dependencies refreshed** (`npm update` in `sidecar/`): discord.js 14.28.1, ws 8.22.2 and the fixed undici 6.29.1 (`npm audit` reports 0 vulnerabilities; the floor is now `^14.28.0` so an old lock cannot return). `start-discord-bridge.bat` now stops with a message if the folder is missing, checks that `ws`, `discord.js` and `@discordjs/voice` can be found, reinstalls with `npm ci` when they cannot or when `package-lock.json` changed since the last good install, and treats any failing exit code of npm as a failure. It never installs under a running bridge (a new file, `sidecar/guard-probe.mjs`, asks the guard port first: a running bridge has its packages loaded and an install under it would leave `node_modules` half deleted), and it works in a folder whose name contains a ")".
- Documented splits: the overlay half of the id and size rules (the roster overlay's `String(...).trim()` and px clamps) is Sprint 15 (GRN-140); the control page's half (GRN-112, the "Reset auth" button now labelled "Disable bot", the `rpc.configWarning` line) is Sprint 16.

### Added

- Tests: `verify` section [8e] (BOM, UTF-16, literal null, array, number, empty and half files, a config that is a folder, stale temp files, a missing config, a burst of saves followed by Quit, a failed write and its recovery, wrong-type settings at load and on the bus, bad, short, bare-number and repeated favorite ids, a name with an emoji across the cut, a repeated Save, a refused favorite update, a corrected token file, a deleted one, one that is not valid JSON, BOM and UTF-16 token files, an empty token, a read-only token file, reset-auth) and section [7b] (a random canary token in the token file appears in no frame, state, action, log or config, and survives reset-auth). The mock Discord records the token each login used; the labels that claimed a bus guarantee about the token are reworded.

**Deploy:** **stop the running bridge first** (close its window, or send `quit`), copy the `sidecar/` folder (it now has a new file, `settings.mjs`) and `start-discord-bridge.bat`, then run `npm --prefix sidecar ci` (or just start `start-discord-bridge.bat`, which now installs what is missing or stale) and start the bridge again. Nothing to re-paste; no page reload. The control page and the overlays are unchanged. **Not yet checked live** (they need a real bot token and a throwaway voice channel): one login, one voice join and speaking events with the refreshed discord.js stack. `verify` 503/503, `verify:render` 357/357.
## [1.0.72] — 2026-11-09

The Discord bridge keeps itself in its voice channel, and follows Discord when the connection drops, resumes or restarts. The sidecar version is now 1.0.72.

### Added

- **The bridge rejoins by itself.** When the bot's voice connection drops, the bridge rejoins after 2, 5, 15 and then every 30 seconds. After about 10 seconds outside "Ready" the feed says "Voice connection lost, reconnecting…" (`hostInChannel` false, the roster kept); after about 30 seconds the connection is dropped and rebuilt (no channel and an empty roster until it is back). A connection that is slow to start only warns ("not ready after 20 s, still retrying") and is never given up on for that alone.
- **Discord removing the bot is respected.** A removal from the call (voice close 4014), a rate limit (4021) or a call that ends (4022) stops the retries: the status says "Removed from voice (…), press USE to rejoin" and the bridge waits for **USE** or **Connect**. A 4014 within 15 seconds of a gateway reconnect is a dropped session, not a removal, and is rejoined. "Bot was removed from that server" does the same.
- **Dragging the bot to another voice channel in Discord** makes the roster follow it while that connection lasts (`current` stays your chosen channel; a Stage is not read). **USE** brings the bot back, and so does any rebuild of the connection: the bridge always returns to the channel you chose.
- **`rpc.reconnecting`** (the gateway is resuming or re-identifying; `connected` stays true, so the roster overlay no longer hides during a hiccup) and **`rpc.speakingStale`** (someone is unmuted in the call, but no speaking start has arrived for minutes, or a glow stayed on for minutes: speaking detection may need `npm update` in `sidecar/`). Both are additive and documented in docs/PROTOCOL.md; the control page shows them in Sprint 16.
- **The login is retried** when Discord or your network is down (5 seconds, doubling, up to 5 minutes), and stops for good on a rejected token ("Discord rejected the bot token", "fix the token, then press Connect").
- Tests: `verify` section [8d] runs the real bridge and real voice connections on the mock Discord: a stall and the loss, the rejoin and its backoff steps, a park after a removal and the ways back, a dropped session, a move, a resume, a re-identify, a rejected token, a server that comes back, a server that removes the bot, a late "Ready", a stale connection's speaking events, Leave while Discord still shows the bot in the call, a replaced login, the login retry and speaking staleness. The test hooks `test-voice` and `GREENROOM_TIMING` exist only with `GREENROOM_TEST_HOOKS=1`.

### Fixed

- **A gateway resume or re-identify no longer leaves a stale roster or a dead voice link.** After a resume, a voice connection that is waiting is asked to rejoin; after a re-identify (a new session, nothing replayed) the roster is rebuilt from what Discord says now, keeping who was speaking. The intended channel is authoritative: a bot that should be out but that Discord still shows in the call (a lost leave) is told to leave, and one that should be in with no working connection joins at once. A server that becomes available again re-seeds or joins.
- **Leave while the connection is down** cancels the pending rejoin and tells Discord to take the bot out of the call.
- **A rejected token (Discord's close code 4004)** and the other closes Discord will not reconnect after stop the bot with the reason on the status line and no endless retry; the dead "session invalidated" relaunch is gone.
- **A voice connection that was waiting 20 seconds no longer leaves the bot out for good** ("Voice connection not ready"): that was an error with no retry; it is now a warning, then a watchdog and a rejoin.
- **A channel with a user limit is no longer given up on.** A rejoin into a full channel is retried (a seat frees up), and the bot's own stale seat no longer counts against the limit; only a missing channel, a Stage or a missing permission waits for you.
- **A bot removed from the server while the connection to Discord was down** (an outage that ended in a new session) now says "Bot was removed from that server" instead of retrying for the rest of the stream.
- **A leave that Discord never received** (Leave, a cleared channel, another server, pressed during a gateway hiccup) is repeated when the gateway is back, once, for every server the bridge joined.
- A kick soon after the bridge logged in is a kick (it used to be rejoined as a "dropped session"), and a speaker who leaves mid-sentence no longer makes their next glow look stuck.
- A login or gateway event from a client that was replaced meanwhile can no longer touch the bot that replaced it.

**Deploy:** **stop the running bridge first** (close its window, or send `quit`), copy the `sidecar/` folder (and `mock-discord-bridge.mjs` if you use it) and start the bridge again with Discord Bridge Start or `start-discord-bridge.bat`; the guard asks an older bridge that is still running to quit and takes over. If the new bridge exits saying the guard port is held, end `node.exe` and start it again. Nothing to re-paste; no page reload. The control page and the overlays are unchanged. `verify` 456/456, `verify:render` 357/357.
## [1.0.69] — 2026-11-09

The Discord bridge now checks the channel you pick before it leaves the one it is in, and keeps guests invited into the call on the roster. The sidecar version is now 1.0.69.

### Fixed

- **A bad pick no longer drops the working channel.** USE (Set current) used to leave the old channel, forget the roster and save the new pick before anything was checked, so a Stage channel, a text channel, a channel the bot cannot join, a deleted channel or a server the bot is not in left the bot out of voice with an empty roster. While the bot is online the target is now checked first: a server the bot is in, a channel that exists, a regular voice channel the bot can join (View Channel and Connect, and room under the user limit: a guest in the call counts). A target that fails keeps the current channel, the voice connection, the roster and the saved pick, and says why on the status line ("That is a Stage channel — pick a regular voice channel instead", "Channel not found", "cannot join", "full", …). The message clears itself after about a minute, so the status does not stay red for the rest of the stream while the bot is working. When USEs overlap the newest one decides, and a pick that cannot be saved to the config file is not applied (the status says so).
- **Offline picks.** USE before Connect still just saves the pick, and it no longer erases the message that says why the bot is offline (a bad token, no token). The same check runs when the bot logs in: a saved channel that fails it is not joined, and the reason stays on the status line until the pick changes. The Discord feed says so with a new `currentRefused` field (additive; docs/PROTOCOL.md).
- **Stage channels are refused with a reason** instead of a join that never works. The setup guide now says "a regular voice channel (not a Stage)".
- **Removing the favorite that is the current channel clears it and leaves voice** (unless another favorite names the same channel). Before, the removed favorite stayed the working channel, and a restart or a `connect` joined it again.
- **Guests invited into the call stay on the roster.** A guest (Discord keeps no member for them) is now listed when the bridge joins, moves, re-joins or logs in, not only when they join while the bot is already there: by their nickname or Discord name (looked up when no earlier message named them), with their mute and deafen state following them. A join and a leave that arrive together leave nobody behind, and a message with no user in it adds nobody.
- **A bot or a departed user no longer gets a speaking flag**, and the speaking handlers of an old voice connection no longer touch the roster of the next one.
- **Members show their per-server avatar** (the picture they set for that server), with the global avatar as the fallback.
- **Departures are handled by user id before the member check**, so a user who left, or who is not cached, is removed from the roster.
- **Two commands that save at the same time can no longer garble the config file.** Writes happen one at a time.

### Added

- Tests: `verify` section [8c] extends the mock Discord (now a reusable `mockDiscord` helper with resume, voice-state requests, an outage switch, delayed answers and user lookups) with a gateway that identifies, lists a guild in READY and dispatches GUILD_CREATE (a voice, a text, a Stage, a locked and a full channel, the bot's own member, a member and some guests in voice) and VOICE_STATE_UPDATE through the real discord.js handlers. It drives the real bridge through USE on wrong-server, text, Stage, locked, missing and full targets, a slow older USE, a config file that cannot be written, an accepted USE, favorite removal (with a duplicate), guests joining, muting, re-joining, leaving and moving, a join and a leave in one read, frames with no user, a per-server avatar, the speaking flag, an offline USE and a refused saved channel at login. Test-only: `test-speaking <userId>` and `GREENROOM_REFUSAL_MS` (with `GREENROOM_TEST_HOOKS=1`).

**Deploy:** **stop the running bridge first** (close its window, or send `quit`), copy the `sidecar/` folder (and `mock-discord-bridge.mjs` if you use it) and start the bridge again with Discord Bridge Start or `start-discord-bridge.bat`. Nothing to re-paste; no page reload. The control page and the overlays are unchanged. `verify` 395/395, `verify:render` 357/357.
## [1.0.66] — 2026-11-09

The Discord bridge has one way out, a guard that says who holds it, and survives bad frames. The sidecar version is now 1.0.66.

### Added

- **Liveness fields on the Discord feed.** Every payload carries `hb` (5000: the bridge pushes at least every 5 seconds, so a consumer can tell a live bridge from a dead one), `stopped` (true on the last frame before the bridge exits) and `bridgeVersion` (additive; docs/PROTOCOL.md). The mock bridge sends the same. The overlays and the control pill that use them come in later releases.
- **A `quit` command** (the clean stop) and **command-line arguments**: `--sb-ws-url=`, `--guard-port=` and `--exit-on-sb-close=` win over `SB_WS_URL`, `GREENROOM_GUARD_PORT` and `GREENROOM_EXIT_ON_SB_CLOSE`; put them in an edited `start-discord-bridge.bat` (it passes its arguments on) or after `npm run bridge --`.
- Tests: `verify` section [8b] drives the real token-less bridge on mock Streamer.bots, and a mock Discord REST and gateway, through the shutdown paths, the crash policy, hostile command frames, the guard (a program that holds the port, a newer build, resets), arguments, the exit grace window and the login races. The bridge reads two test-only switches, `GREENROOM_TEST_HOOKS=1` (the `test-*` commands) and `DISCORD_BRIDGE_API` (a loopback address only).

### Fixed

- **Every way the bridge stops leaves a clean state.** Ctrl+C, Ctrl+Break, closing its window, `quit`, Streamer.bot closing (with that option on) and a crash all go through one routine: it pushes a last state (nobody in voice, `stopped`), leaves the voice call once and exits. Before, the last roster stayed in `discord.state` with nothing to say the bridge was gone. A crash exits with code 1 and puts the error in `rpc.error`; a rejected promise is logged and the bridge keeps running. (Ending `node.exe` in Task Manager cannot leave cleanly: use `quit` or exit-on-close for the hidden instance.)
- **A bad frame on the bus can no longer crash the bridge.** A command that is an object or an array, or a value that is not text (for example `{toString:1}`), is dropped and only its type is logged.
- **A console that stops draining no longer freezes the bridge.** The log is written from a worker thread (a click in the console window starts a selection and Windows pauses the writer); control characters are replaced, and the bot token is never written to the log or to `rpc.error`.
- **The single-instance guard says who holds it.** It sends a banner (name, pid, version). A program that holds the port without a banner, or a bridge older than this release, makes the bridge say so and exit instead of running without a guard; a newer build asks an older one to quit and takes over (versions are compared as numbers: 1.0.10 is newer than 1.0.9); a bridge of the same or a newer version is left alone. A reset or a killed peer on the guard port no longer crashes the bridge. The Node version is checked before discord.js loads.
- **Connect, Reset auth and Stop while the bot is still dialing the gateway.** A login that fails after it was replaced no longer stops the newer bot, and a client stopped mid-dial is closed once its login finishes, so no session is left behind.
- **Streamer.bot back inside the exit-on-close grace window keeps the bridge running**: the bridge retries about once a second while the countdown runs and makes one last attempt at the end. The connect push is one frame, and the connection to Streamer.bot has a handshake timeout.

**Deploy:** **stop the running bridge first**: close its window, or end `node.exe` and confirm it exited (the old build has no quit command). Copy the `sidecar/` folder (and `start-discord-bridge.bat` and `mock-discord-bridge.mjs` if you use them) and start the bridge again with Discord Bridge Start or `start-discord-bridge.bat`. If the new bridge exits at once saying the guard port is held, an old bridge is still running: end `node.exe` and start again. Nothing to re-paste; no page reload. `verify` 363/363, `verify:render` 357/357.

## [1.0.63] — 2026-11-09

The dock and `director-min` now tell their own pushes from someone else's by a revision number, the newer saved state wins, an edit made while Streamer.bot is unreachable is kept, and one director is the designated one.

### Added

- **Revisions on every push.** `vdo.state` carries `schemaVersion: 2`, a `rev` and a `writer` (a new file, `control/vdo-rev.js`, loaded by both pages). The rev is chosen when a push is really sent, the writer is random per page load. The actions are unchanged: the fields travel inside the saved state. See docs/PROTOCOL.md, "Revisions".
- **"director-min.html is my always-on director"** (Room & Director, saved with the config as `alwaysOnDirector`). Ticked, the dock sends only your own edits and leaves following the guests, and adding them to the directory, to the `director-min` source. The dock warns "director-min is designated but not correcting: is its OBS source visible?" if the saved stream IDs stay different from what its own director sees for about 30 seconds.
- Status messages: **"SB offline, changes will be sent on reconnect"**, **"not confirmed by Streamer.bot: is VDO Push compiled?"** (a push whose broadcast does not come back within about five seconds), and, when vdo.ninja says another director holds the room, "director: connected (not room owner, another director holds the room)" (information, not an error).
- Tests: `verify` gains the revision unit cases (stamping, echoes, the newer state, equal revs, legacy writes) and the restore stamp; `verify:render` has a new section R19 (every push stamped, an echo that Streamer.bot rewrote, an old own echo, the rev gate and legacy writes, a delayed replay after a newer push, an edit made while Streamer.bot is down, a stream ID that changed while it was down, the designation and the correction, a forged and a malformed director reply, "not room owner", an unconfirmed push, schemaVersion 3). `RENDER_ONLY=revision` runs it alone, `R19_ONLY=a,b` picks sections. The mock gains `/mock/drop?ms=N` and `rewrite=fffd`, the mock director `?notowner=1`.

### Fixed

- **A delayed replay can no longer undo your edit.** A replay of an older saved state (a slow `VDO Sync`, a reconnect) used to be adopted over a newer push; a state with a lower rev is now dropped, equal revs are broken by the writer id, and a state without a rev (a page from before this release, a hand-made file) is still adopted.
- **An own push coming back is recognised by rev, not by its text.** A name with a lone surrogate comes back from Streamer.bot with U+FFFD in it; it used to look like someone else's state. An older own push replayed later is no longer adopted either.
- **An edit made while Streamer.bot was down is kept.** The dock sends its own state, with a fresh rev, when the connection returns instead of adopting the older saved one (also when the replay is its own last push, and never over a config saved by a newer Greenroom); `director-min` adopts the replay and re-pushes a difference in stream IDs once it has held for two polls, and adds again a guest it had added meanwhile.
- **A replay between a push and its echo cannot undo the push.** A frame with a rev below a push of this page that is still on its way to Streamer.bot is dropped.
- **Stream IDs after a restore or after another page's push** are corrected: the designated director sends ONE correction once the same difference in stream IDs has held for two polls, and no more than one per 30 seconds per page (it used to leave the saved IDs as they were until something else changed). A dock beside a designated director-min shows and sends the stream IDs Streamer.bot holds, so its edits no longer carry a view that is a poll behind, and its "not correcting" warning is real. `npm run backup:restore` now pushes a new write (rev above the clock and above the rev already saved, writer "backup") with the slots' stream IDs blanked, since the ones in the file were true on the day it was saved; a running director (the dock, or the `director-min` source) puts the live ones back within a few seconds.
- **A box that has the focus follows the saved config** ("director enabled", "director-min.html is my always-on director").
- **A second director page** (the Manage link included) is documented as limited, with the steps to use it as the full director; the one-director rule is written in the setup guide, the README and both pages.

### Changed

- `schemaVersion` is now 2. A page from an earlier release that is still open shows "reload this page" and pushes nothing once a page from this release has saved the config. `backup.mjs` reads schemaVersion 2.

**Deploy:** copy the `control/` folder (a new file, `vdo-rev.js`) and `backup.mjs` (the old one refuses snapshots saved after this release). In one sitting reload the dock, refresh the `director-min` source and reload any other open `control.html`: a page from an earlier release left open stops pushing and shows "reload this page". **If you run the `director-min` source as your director, tick "director-min.html is my always-on director" in the dock.** Nothing to re-paste. The overlays and the sidecar are unchanged. `verify` 324/324, `verify:render` 357/357.

## [1.0.59] — 2026-11-09

Guests are matched to directory entries by one identity rule in every place that looks them up, and a stranger in the voice channel is never bound to an entry you named yourself.

### Fixed

- **A Discord user can no longer take over an entry you named.** Auto-add used to write a Discord user's ID into any entry whose name matched, so a stranger who called themselves "Bob" was bound to your curated "Bob" (and the plate and chip followed them). Now only an auto-added placeholder takes the ID silently. A row you named yourself shows **link Bob (id)?** with **link** and **not them**: link sets the ID, "not them" remembers the Discord user as ignored. Each button acts only on the Discord user it was drawn for (if the offer has changed, nothing is linked and the row is redrawn), and when two or more Discord users have the name the row offers nothing and says so. Until you accept, that guest's roster chip shows their Discord name and a discord-mode slot bound to them shows no plate.
- **One comparison rule for labels, everywhere.** The dock, `director-min`, the guest overlay's lower-third and the standalone nameplate now share the same lookup text (checked by `verify`): vdo.ninja's doubled HTML escaping is decoded (a guest called `Tom & Jerry` was shown as `Tom &amp;amp; Jerry` and never matched), `_` reads as a space (`Guest_One` is `Guest One`, including the live dot in the dock), invisible characters are ignored, and when several entries match the exact-case one wins, then one you named over an auto-added one. A new auto entry for an escaped label is named by the decoded label.
- **Labels that differ only in case are separate guests** (`ALPHA` and `alpha` get their own entries, and the dock says so under the directory), the same in any roster order. A lone `alpha` still matches your `ALPHA` entry.
- **No twin when a guest joins the voice channel first.** Their auto entry takes the label when they join the VDO room instead of a second entry being appended (this now also happens in the dock, which used to leave the entry without its label).
- **Labels that draw nothing** (zero-width characters, the Braille blank, the Hangul filler) are never auto-added, and the lists show invisible characters as `<U+200B>` (an emoji's own joiners, as in a family or a flag, stay as they are). The label pick of a guest slot now does the same and marks two live labels that are the same once case, spacing and hidden characters are ignored, so a guest who adds an invisible character to the name of a guest you have named can be told apart. A label made only of invisible characters matches an entry with the same text, and nothing else. A Discord user whose name has not arrived yet is added once it does, not named after their ID.
- **Auto entries are capped at 50.** At the limit the dock says "auto-add limit reached"; entries for guests who left, and are in no slot, make way first; entries you named are never dropped. An auto entry whose Discord namesake is in the channel counts as present, and a guest who was dropped and comes back is added again (both pages forget what they had added for them). Turning auto-add off clears the offers and the limit note.
- **Two rows with the same label or Discord ID are flagged** ("shared label", "shared Discord ID"). With **live only** ticked, a row that is waiting for a link answer stays in the list.
- **Socials:** a tab or a non-breaking space between the platform and the handle works, a line that cannot be read says so on the row ("1 line ignored - use "platform handle", e.g. twitch bob", with the list of platforms; the list is also the box's tooltip), and `x`, `yt`, `ig`, `bsky` and `tt` pick the right icon. Unknown platform names (and names like `constructor`) fall back to the globe.
- **The roster overlay orders chips by the name it shows** (a curated name beats the Discord name; an auto placeholder no longer freezes a renamed member's name).
- Ignore keys use the same comparison, so a removed guest saved under an old key (`vdo:guest_one`) is still not re-added.

### Added

- Tests: `verify` gains the identity vectors, `autoPopulate` cases (suggestions, linking, the merge, case twins, the cap and eviction, empty names, order independence) and the parity of the two lookup copies over the same inputs; `verify:render` has a new section R18 (the suggestion accept and reject, underscore and escaped labels, case twins, the nameplate's markup vectors, the cap, the socials hint, the roster order). `RENDER_ONLY=identity` runs it alone, `R18_ONLY=a,b` picks sections.

**Deploy:** copy the `control/` and `overlay/` folders. Reload the dock and `director-min`, and refresh the nameplate, guest-slot and roster sources together, so both lookup copies match. Nothing to re-paste. `verify` 302/302, `verify:render` 322/322.

## [1.0.55] — 2026-11-08

The invite builder now produces links whose options do what their labels say, each guest is asked for a name by default, and a slot can be pinned to one guest.

### Fixed

- **The default guest link makes each guest enter a display name.** It ends in a bare `&label`, so vdo.ninja asks every guest who opens it for a name, and they appear in the roster, the slot pickers, auto-add and the guest count. A new option, **ask each guest for a name**, is on by default (and on for a saved config that has no value for it); a label typed in the builder still wins for a single-guest link. The "No label: guests from this link can't be bound to a slot" warning now shows only when that option is off and the label is blank. A guest who cancels the prompt joins without a label, and the director pill now counts them ("2 guests · 1 unlabeled"; `director-min`'s status does too).
- **The guest link keeps only options vdo.ninja applies on the guest's side.** Frame rate is now the soft `&maxframerate` (the old `&fps`, like `&width` and `&height`, was a strict camera requirement that could stop a guest's camera from starting), the bitrates are `&outboundvideobitrate` / `&outboundaudiobitrate` (the old ones only changed what the guest *receives*), and **no video / no audio** are now `&videodevice=0` / `&audiodevice=0` and relabelled "guest sends no video / audio" (the old flags only stopped the guest from watching others: **if you had them ticked, new links now stop the guest sending**; a note shows until you change them). Width, height, codec, stereo, require approval and room cap are gone from the builder: the link either did nothing useful with them (stereo only turned off echo cancellation) or implied an access control it does not provide. A saved config that still holds them keeps them unused.
- **Numbers are checked.** A frame rate or bitrate that is not a whole number above zero (`29.97`, `1920x1080`, `30fps`, `0`) is left out of the link and the box is marked, instead of being quietly rewritten. Extra flags are cleaned up (a leading `?` or `&` and spaces removed, a `#` cuts the rest, each flag gets exactly one `&`) and script and style flags are dropped.
- **Links for several guests no longer share a label.** The label and push ID boxes say they belong to one guest, **new guest link** fills a unique label and a random push ID, and **Copy** empties both so the next link starts blank.
- **A slot can be pinned to one guest.** The slot row has a **pin** button that stores the guest's current push ID (`pushID`, optional, documented in PROTOCOL.md). A pin is offered once the director has reported the guest, and holds only while that guest keeps the same ID (give them a link with its own `&push`, e.g. from **new guest link**; otherwise a rejoin gets a new ID and the pinned slot shows "pinned: not in room" until you unpin). A pinned slot follows only that stream, so someone else who picks the same label cannot take it over, and **unpin** (or choosing another label) goes back to following the label. Unpinned slots follow their label as before. `director-min` honours pins too.
- **The room name vdo.ninja will use is shown under the Room box** (`vdo.ninja room: my_room`), with a warning when it differs from what you typed, when it is only underscores (a name written in a script vdo.ninja strips, such as `部屋`), or when it is longer than 30 characters. Save asks first when the name is only underscores and there is no password. This is display only: every link still uses the room as you typed it.
- The comment about the director's `&novideo&noaudio` no longer says it avoids a camera prompt.

### Added

- Tests: `verify` gains the pin (a pinned slot ignores a same-label impostor, an unpinned one keeps auto-follow), unlabeled-count and room-name checks; `verify:render` has a new section R17 (the default `&label`, sender-side flags, strict numbers, extra flags, per-guest links, the unlabeled pill, pins, the room name). `RENDER_ONLY=invite` runs it alone, `R17_ONLY=a,b` picks sections. The mock director takes `?unlabeled=N`.

**Also:** copying a link never asks a question or alerts, even on a page holding a newer config; a rejected number keeps its red mark when the builder is redrawn; the pill's full text is in its tooltip.

**Not in this release (tracked):** the checks in a throwaway vdo.ninja room (that a bare `&label` prompts the guest, that a guest who cancels shows as unlabeled, that an already-used push ID is rejected, that the room server does not count the overlay viewers) cannot be run offline; the README text for the removed options and GRN-187's mirror recheck against the captured vdo.ninja mirror ride the docs sprint. GRN-187's exact-link cases (the hash links for a spaced room and password and for `café`, the plaintext `a&b c` password, the capture flags) are in `verify:render` R17.

**Deploy:** copy the `control/` folder, reload the dock and refresh the `director-min` source (it honours slot pins), and copy fresh invite links for upcoming guests. Links already sent keep working. `verify` 266/266, `verify:render` 303/303.

## [1.0.52] — 2026-11-08

Every vdo.ninja address the kit builds (the guest views in OBS, the hidden director, the invite and manage links) now goes through one helper, so the room password and the view flags can no longer be handled differently in different places.

### Fixed

- **A room password with `%`, `&`, `#` or a space now reaches vdo.ninja intact.** vdo.ninja decodes the password twice, so it has to be encoded twice; the guest views, the hidden director on the dock and on `director-min`, and the plaintext invite and manage links each encoded it once, which put those guests and that director in a different room from the one the password protects. A password of `0`, `false` or `off` (which vdo.ninja treats as no password) is no longer sent at all, and the hash invite mode emits no hash for it.
- **View flags saved without a leading `&` (or with a leading `?`) no longer break the guest view address.** They used to be glued onto the password (`…password=abc` + `solo` became one word). They are now normalised to `&a&b=c` everywhere they are read.
- **A guest view is always solo unless the flags ask for a scene.** An empty or solo-less flags box used to show the whole room in the source.
- **The overlay drops flags that could load script, style or media into the viewer, send its events away, or change the stream or room,** whatever the saved state holds (an old page, a backup, an import): `js`, `base64js`, `css`, `invite`, `code`, `whep`, `website`, `postapi`, `api`, `view`, `streamid`, `room`, `password`, `pass`, `hash`, `crc`, `director`, `preset` and their aliases. Settings that must match the guests' side (`salt`, `token`, `wss`) are kept, because a self-hosted vdo.ninja needs them on the viewer too. The dock removes them when you press Save and says which it removed; a saved state that already contains them is kept as it is, with a warning under the box that the overlay ignores them (nothing is pushed by that on its own).
- **The invite builder's "none" password mode no longer issues a link into the wrong room.** When the room has a password, "none" (and the hash mode on a page where the hash cannot be computed) now produces a link with a bare `&password`, so vdo.ninja asks the guest to type it.
- **A guest-view source opened on a page that is not a secure origin** (a LAN name) no longer sits black: for a webcam slot with a guest it starts no viewer and shows how to open it via `http://127.0.0.1:<port>/` (a Discord-mode slot, which needs no vdo.ninja, shows nothing extra).
- **Saving a password that vdo.ninja reads as "no password"** (`off`, `0`, `false`) now trims it and warns under the box that none is sent; the invite builder says the guest is asked for the password in "none" mode. Save also names text it cuts after a `#`, and `director-min` keeps a director problem on screen instead of replacing it with the flags note.
- `director-min` reads a config with no `viewFlags` (and a partial `invite`) the same way the dock does, and `npm run backup:restore` fills the default view flags into a snapshot that lacks them.

### Added

- The flags box has a placeholder with the default flags and a **reset to default** button (press Save to keep it).
- Tests: `verify` gains the helper's unit checks (normalising, sanitising, the aliases, double encoding, the director and view URLs) and a tripwire that the two copies are identical; `verify:render` has a new section R16 (the exact overlay URL for a password like `p&w #1`, flags without `&`, dropped script flags, the four builders, the invite modes, Save and reset, the insecure source). `RENDER_ONLY=urls` runs it alone, `R16_ONLY=a,b` picks sections.

**Not in this release (tracked):** the guest-slot reload watchdog (GRN-97: the message a viewer page sends could not be confirmed offline, and a wrong guess would reload healthy views) and the extra guest-overlay pin checks of GRN-177 (mirror, avatar fallback, Copy URLs). The docs half rides the docs sprint.

**Deploy:** copy the `overlay/` and `control/` folders together (each gets a new `vdo-url.js`), then in one sitting reload the dock and the `director-min` source and refresh every guest-slot source. A partial update puts the director and the guests in different rooms (the old pages encode the password once). `verify` 261/261, `verify:render` 279/279.

## [1.0.49] — 2026-11-08

The guest directory in the dock now commits only what the operator changed. A row that is half-typed, a guest list another page just replaced, and the auto-add that runs on every poll can no longer overwrite each other.

### Fixed

- **Auto-add never works from half-edited rows.** It used to read the whole directory back from the screen, assign that to the saved config and push it, so a label you had just cleared (or a draft you were still typing) was pushed half-finished and could get an auto-added twin. Now it looks at the saved directory plus the keys each row on screen is showing, and applies only its own changes: a Discord ID filled into an existing entry, or a new placeholder at the end.
- **Auto-add no longer runs when another page's state is adopted** (on either page). The next poll or voice update does it. A label or voice user is also added only once per page session, so a label that Streamer.bot rewrites on the way back cannot loop.
- **An edit changes only the field you edited, on the entry you edited.** Rows are found by a stable id rather than by their position, so another page reordering or replacing the list while you type cannot send your edit to a different guest. If the guest was removed meanwhile, your edit brings it back. A voice user filled in by auto-add while the row had focus is not undone.
- **Emptying a display name does not remove the guest.** The old name comes back with a "use × to remove" hint; only `×` removes an entry (and so records the guest as not to be re-added). Emptying a VDO label or Discord ID field still records that key as ignored.
- **Editing any field of an auto-added entry makes it yours** (not only its name), and the "auto" badge and the "Clear auto-added (N)" count follow at once.
- **A draft ("+ Add guest") survives.** Another page's push no longer drops a half-filled row, and a draft with a name but no VDO label or Discord user yet is kept across a page reload (in this browser only; it never reaches Streamer.bot). Such a row says "not saved: add a VDO label or Discord user" and is counted as "N unsaved".
- **A row never edits a guest it cannot tell from its own.** If another page changed the guest while its row was open (re-labelled it, replaced the list), the edit goes to the same guest when it can be recognised (by label, Discord user or on-stream name); otherwise the row is reloaded with a note instead of writing onto someone else. A draft that reuses another guest's label stays a separate draft.
- **Import starts the auto-add count afresh,** so live guests missing from the imported file are added again by the next poll. The saved config arriving while you are typing a new guest no longer pops up the "has not returned your saved config" question.
- **The directory panel is no longer redrawn under your cursor.** A change that arrives while you are in a field is applied when you leave the editor; voice-membership changes update the live dots in place. Rows draw their label and Discord pick lists only when expanded.

### Docs

- The Troubleshooting line about blanking a guest's name now describes the restore.

### Added

- Tests: `verify` gains the `skip` option checks of `autoPopulate`; `verify:render` has a new directory section (R15: half-edited rows, drafts across a push and a reload, the restore, the auto flag, adoption without auto-add on both pages, in-place live dots). `RENDER_ONLY=directory` runs it alone, `R15_ONLY=a,b` picks sections.

**Deploy:** copy the `control/` folder, reload the dock and refresh the `director-min` source. Nothing to re-paste, nothing to restart. `verify` 247/247, `verify:render` 261/261.

## [1.0.46] — 2026-11-08

The dock and the `director-min` source now change only what the operator touched. Switching the director off, clearing or changing the room, editing one slot, typing a Room or Password, and copying a link each do exactly one thing, and none of them can write a stale screen over what another page just saved.

### Fixed

- **Switching the director off, clearing the room, or moving to another room sends ONE push, and it carries no live stream IDs.** Before, Save pushed first (with the old room's IDs) and then pushed again once the director stopped, so the overlays saw the cams for a moment. The director is now switched first and the push that follows is blank. This follows the config, not the director frame: a dock opened by LAN name (no secure context, so no director frame) and a backup Import while the director is off blank the IDs too, and an Import that switches a running director off is one push, not two. Moving to another room (or password) starts with empty IDs, so a stream from the old room is never shown under the new one.
- **`director-min` can no longer put the cams back on air after a disable.** Adopting the blank push used to re-resolve its own live roster into the config, and its next auto-add push (a Discord join, say) re-armed the cams even with the director off and `control.html` closed. A disabled config, or one with no room, now has no live streams on either page. A saved state that is switched off but still holds stream IDs (left by an older race) is blanked once by the first page that reads it.
- **A slot edit changes one field of one slot.** The slots panel used to re-read all four slots from the screen on every change. While a Discord ID was being typed the panel is not redrawn, so the screen could be behind what another page had just saved, and the edit wrote that stale text back over it. A change now patches the field that fired, and picking a different label empties that slot's stream until the director resolves it.
- **The panel is no longer frozen while a pick box has focus.** Only a Discord ID being typed holds a redraw back; it runs when the field is left (and waits while the operator is on a pick box, so a list they just opened is not snapped shut). A guest who joins now shows up in the pickers while a slot's box is focused, and the focused control keeps its focus across the redraw.
- **A committed pick or toggle no longer keeps the focus.** A stray key or a wheel turn on the label, mode or Discord-user box, or Space on Mirror, could swap, blank or flip the on-air slot; the control is released as soon as the change is made. The Copy and Open buttons are released after use too.
- **The "director enabled" box changes the director only.** It used to save the Room, Password and viewFlags text you were still typing as well. Those still need Save, and the "unsaved changes" badge says so.
- **Room, Password and viewFlags you have typed but not saved survive.** Another page's push used to overwrite the half-typed text. It is now kept, an "unsaved changes" badge shows and Save is outlined; a push that makes the saved value equal the text clears the mark, and otherwise only Save or Import clears it (so does the first saved config to arrive, except for the field you are typing in at that moment).
- **A Save or a tick you decline before the saved config has arrived changes nothing.** Before, the page kept the declined room and started its director in it once Streamer.bot reported an empty state.
- **The invite and manage links follow the saved room and password,** not the half-typed text, and say "unsaved: press Save" while either is unsaved. A link copied mid-edit used to name a room the director was not in.
- **Copy says what happened.** "Copied" shows only when the copy worked; otherwise "Copy failed — select & Ctrl+C" (a slot's Copy says "Copy failed") and the link stays selected. A double-clicked Copy no longer sticks on "Copied", and the button no longer keeps focus.
- **A reply from a director frame that has since been pointed elsewhere is dropped.** The poll carries the frame's generation (`sb-vdo:<n>` / `sb-vdo-min:<n>`) and a reply tagged for another one is ignored; a reply with no tag is still read.

### Added

- Tests: `verify` gains the poll-tag checks; `verify:render` has a new gestures section (R14: one push per gesture, a slot edit with focus in the panel, the heal, the disable-then-Discord-join case, an insecure dock, Import with the director off, typed fields, links, Copy, a poll in flight at an untick). `RENDER_ONLY=gestures` runs it alone, and `R14_ONLY=a,b` picks its sections.

**Deploy:** copy the `control/` folder, reload the dock and refresh the `director-min` source. Nothing to re-paste, nothing to restart. `verify` 245/245, `verify:render` 243/243.

## [1.0.43] — 2026-11-08

The dock and the `director-min` source no longer trust the vdo.ninja director's guest list when it is not real. A director that has just started, one that only knows some of the guests, one that has gone quiet, or one whose reply has changed shape can no longer blank a guest who is on air.

### Fixed

- **A cold or partial director no longer blanks guests on air.** After a reload, the director's first replies are often empty or incomplete. A slot whose guest the director has not reported yet now keeps its stream for the first 10 seconds after the director's first usable answer (a director that is slow to answer gets its full window); a guest the director reported and then lost still blanks at once. A different guest who uses the same label and is reported first does not take the slot. A `control.html` opened and closed a couple of seconds later while `director-min` runs no longer changes any stream ID.
- **A label two guests share can no longer be taken over.** Anyone in the room can choose any label. A slot whose label is used by several guests keeps the stream it already had while that stream is still there, and is empty when it is not (it never jumps to a joiner). The slot shows "2 streams!", with the competing streams in its tooltip.
- **A reply with a changed shape is not "an empty room".** If the director's answer has no usable `streamID` entries or its `guestList` is not an object, the pill says "director: reply unrecognised - check vdo.ninja version", nothing is pushed, and the resolved slots stay as they were.
- **A silent director is noticed and retried.** After about three polls without an answer the pill says "director: not responding" (and the last resolved stream IDs are kept, never blanked); after about 25 seconds the frame is reloaded, then again after 30, 60 and 120 seconds, and at once when the network comes back. Saving the room while the director is quiet looks again straight away, without counting as a retry. A slot relabelled while the director is quiet starts empty instead of keeping the previous guest's stream. "Connecting…" gains a hint after 15 seconds (check the room, the password and that vdo.ninja is reachable).
- **The poll no longer stops in a hidden page.** It is driven by a Web Worker, so a dock tab in the background keeps polling every 2.5 seconds.
- **Only the director can answer.** A reply is accepted only from the director frame itself, from vdo.ninja or its `cdn-backup` failover origin, and the poll is posted to the frame's real origin.
- **A page that is not a secure context does not start a director that vdo.ninja would refuse.** The pill and the banner say to open it via `http://127.0.0.1:<port>/`.
- An empty label never carries a stream ID, in either page.

### Added

- One shared director loop (`control/director-loop.js`) and the roster rules in `control/vdo-parse.js` are used by both pages, with unit checks for the state machine and the resolver. Test support: the mock director can start cold (`?coldstart=N`), report a guest late (`?late=LABEL:ms`), change its reply shape (`?renamed=1`) and answer from a second origin (`?failover=1`); `verify:render` has a new roster section (R13).

**Deploy:** copy the `control/` folder, reload the dock and refresh the `director-min` source. Nothing to re-paste, nothing to restart. `verify` 241/241, `verify:render` 205/205.

## [1.0.40] — 2026-11-08

The backup tool (`npm run backup`, `npm run backup:restore`) now restores only a snapshot it has checked, to the Streamer.bot you meant, and only when you say `--yes`. Nothing to copy into Streamer.bot, nothing to restart or refresh: pull or download, and read the new restore flags below.

### Fixed

- **A restore can no longer overwrite your saved config by accident.** `restore` checks the file the way the dock's Import does (a Greenroom snapshot, a text room, a slot list and a directory list, every slot an object, Discord IDs written in quotes, nothing from a newer Greenroom), passes the directory through the dock's own rules, shows the **current** and the **new** config side by side, and changes nothing unless you add `--yes`. With `--yes` it first saves the current config to `backups/pre-restore-<time>.json`.
- **An unreadable current config is never replaced by surprise.** If `VDO Sync` cannot show what is saved now (it answered with an error, or not at all), no copy of it can be made first, so `restore` refuses without `--force` and says why. If npm takes your `--yes` for itself (flags must come after a `--`), the dry run says so and shows the exact `npm run backup:restore -- <file> --yes` form.
- **A restore tells you whether it worked.** The tool listens for the answer before it pushes, treats a refused push, a push that Streamer.bot did not save, or one that was never rebroadcast as a failure (exit 2, with Streamer.bot's own words; when an old action may have saved the file before failing to broadcast it, it says "not confirmed", not "not restored"), and no longer prints "will repaint" when it does not know. A snapshot with a syntax error is reported without echoing any of it (it holds your room password).
- **Nothing is silently aimed at the wrong Streamer.bot.** npm swallows a bare `--url` for itself, so the tool never saw it and used the default; it now refuses to run when it sees that, and names the working form (`npm run backup -- --url ws://127.0.0.1:8081/`). The target is printed before it connects. Unknown flags, a missing `--url` value, extra file names and a file name with no command are errors (exit 2), and `--help` prints the usage.
- **Saves are safe.** A snapshot is written to a temporary file, flushed, then renamed; an explicit file that already exists is refused unless `--force`; the time in the default name has milliseconds; and the tool reminds you the file holds the room password. A refused `Subscribe` or a missing `VDO Sync` action now stops `save` with the reason instead of "nothing saved yet".
- **Files from Windows tools load.** A snapshot saved as UTF-16 (Notepad, PowerShell) is read; a relative path is resolved from where npm was run, and a bare name is also looked up in `backups/`; `list` shows `backups/<name>`.

### Added

- `--yes` and `--force`, and the snapshot folder can be moved with `GREENROOM_BACKUP_DIR` (the tests use it). The README gives the new commands, Node 22.12 or newer, and the one-time `npm install --omit=dev`.
- Test support: the mock Streamer.bot can answer `VDO Push` with an error or accept it and store nothing (`SB_PUSH=error|drop`), declare actions missing (`SB_MISSING`), and answers any unknown action with an error, as the real one does.

**Deploy:** none beyond updating the folder. Backups taken with an older tool still restore (add `--yes`). `verify` 203/203, `verify:render` 192/192.

## [1.0.37] — 2026-11-08

Developer tooling only: nothing to copy, re-paste, restart or refresh. The repo's own scripts can no longer write into a running Streamer.bot.

### Fixed

- **The mock Streamer.bot can no longer be mistaken for the real one.** It listens on :7478 (HTTP) and :8084 (WebSocket) instead of Streamer.bot's :7474 and :8080, refuses to start when either port is already taken (on loopback or on all interfaces), greets every connection with a Hello whose `info.source` is `mock`, and serves the control and overlay pages only with `?sbport`: a request without it is redirected to the same URL with this mock's port, so a page it serves never falls back to the default port. `npm run mock` replaces `npm start`.
- **`npm run mock:bridge` acts only on the mock.** It prints its target first, subscribes and pushes only after a Hello that says `source: "mock"`, and otherwise says why and exits without sending a byte. `--allow-real-sb` overrides that on purpose; the header says what it then does (the real sidecar also obeys the commands it sends, and its pushes overwrite the live roster).
- **The test scripts pass an allowlisted environment to everything they start.** An exported `SB_WS_URL` used to steer the mock bridge, and `backup.mjs`, at whatever it named. With a listener that must never be spoken to (`tools/sentinel.mjs`) in its place, the old `verify` sent it a `Subscribe` and a `Discord Voice Push`; `verify` and `verify:render` now send it nothing.
- **The mock survives bad input.** A frame that is not a JSON object, an action with no name or arguments, an abrupt close, and a request path with a malformed `%` escape (now a 400) no longer end the process. The mock matches `Subscribe`'s source and type without regard to case.
- **The test scripts wait for the right thing.** The mock prints one `[mock] READY http=<port> ws=<port>` line once both listeners are up, and the scripts wait for exactly that and fail if the child exits first. `verify`'s exit-on-close ports derive from its own (so it and `verify:render` can run together), its sidecar guard ports come from `VERIFY_GUARD_BASE`, the "off" sidecar is told its setting explicitly and given its full grace time, and a missing sidecar install is one clear failure instead of a stack trace.

### Changed

- `playwright-core` is now a pinned `devDependency`, so a plain `npm install` keeps it (the README no longer asks for `npm install --no-save`). The README says which install is which and how to drive a real Streamer.bot on purpose.

**Deploy:** none for a streamer. Developers: run `npm run mock` (new ports); `npm run mock:bridge -- --allow-real-sb` with `SB_WS_URL` set drives a real Streamer.bot. `verify` 175/175, `verify:render` 192/192.

## [1.0.34] — 2026-11-08

**Update in this order: back up, update the pages, then re-paste the actions.** Run `npm run backup` first, while the old actions are still in place. Update the whole Greenroom folder (the pages and `backup.mjs`), restart OBS or refresh every Greenroom source, and reload the dock, `director-min` and any control page open in a browser tab. Only then re-paste `VDO Push`, `VDO Sync` and `Discord Voice Push` into Streamer.bot and compile each. Re-pasting first has a price: a guest slot, nameplate or roster source still older than 1.0.29 shows nothing as soon as the new frames arrive, and a dock or `director-min` source older than 1.0.24 can overwrite your saved `vdo.state` with its defaults.

A guest or Discord user whose name looks like a timestamp can no longer break the overlays or damage your saved config. The three state actions now send the saved state as one escaped string, so Streamer.bot's own JSON parser never reads it.

### Fixed

- **A name that looks like a date no longer rewrites your guest labels or stops the broadcast.** Streamer.bot re-formatted date-shaped text inside the old nested state (a guest labelled `2024-02-03T04:05:06.000Z` came back as `…06Z`, so no slot matched the guest and the cam stayed blank, and the pages then pushed the rewritten label into your saved config), and for a value outside the date range it refused to broadcast at all (an "SB action error" on the dock, and a `director-min` showing no saved config). A guest could cause this just by choosing such a display name. The state now travels as `vdoninjaJson` and `discordVoiceJson`, unchanged. The pages read both the new and the old shape.
- **A failed broadcast no longer leaves a saved state behind.** `VDO Push` and `Discord Voice Push` broadcast first and save second, so a state no client has seen is never kept.
- **One failed `VDO Sync` replay no longer stops the other.** Each replay has its own `try`, and an error report that itself fails cannot end the action.
- **A fresh install is told so.** With nothing saved, `VDO Sync` answers `{"type":"vdo:sync:empty"}`, which the control pages (since 1.0.24) read as "synced, nothing saved" instead of waiting for a reply that never comes.
- **`npm run backup` reads both shapes** (it is run before the actions are re-pasted), says what a failing `VDO Sync` or `VDO Push` reported instead of suggesting an edit, and says when its copy came through the old format (which re-formats date-shaped names): take a fresh backup after the update.
- **The dock and `director-min` say the right thing.** The empty-state marker no longer cancels a Save you confirmed (the dock claimed "the saved config arrived"); a saved config Streamer.bot cannot read is called damaged, not "a fresh install"; and the "date-like text" hint appears only for Streamer.bot's own date failure, not for every error.
- **Comments and docs say what the code does.** The actions no longer claim "vdo first" or that a stale stream ID replays for at most 2.5 s, and point at the dedicated blocking `Greenroom State` queue. `PROTOCOL.md` and the setup guide now say that an ok ack only means the action started, that an invalid argument or an exception shows as an error broadcast, that an action that failed to compile is silent (so always click Compile), and that `Discord Bridge Start` only logs.

### Added

- **Damaged state is refused.** `VDO Push` and `Discord Voice Push` accept only one valid JSON object (no repeated key, nesting at most 32 deep) and answer anything else with `payload rejected, NOT cached`. `VDO Sync` checks each saved state before replaying it; an invalid one is reported ("cached state is not valid JSON - Import a backup or re-save"), not replayed, and kept, never deleted. This is a separate commit and can be taken out without touching the string-field change.
- **`npm run verify:cs`** compiles the three actions as shipped with the C# compiler that comes with .NET Framework 4 (against `mscorlib` only, which is stricter than Streamer.bot's editor) and runs them against a stub of Streamer.bot: every frame, the order of calls, and 26,036 fuzzed payloads against a plain JavaScript check. Set `GREENROOM_NEWTONSOFT_DLL` to Streamer.bot's `Newtonsoft.Json.dll` and it also parses each frame the way Streamer.bot does. It skips itself when no C# compiler is found.
- Test support: the mock Streamer.bot sends string fields by default, answers an empty `vdo.state` with the marker, and refuses damaged payloads. `SB_WIRE=object` keeps the old behaviour (nested objects, cache before broadcast, one `try` around Sync, and an emulation of Streamer.bot's date handling checked against the real library) so the pages' compatibility with an old paste stays tested. `verify` and `verify:render` cover the old and new wire, and a guest label shaped like a timestamp goes through the guest overlay, the dock and `director-min` together: green with string fields, red in object mode.

**Deploy:** back up, copy `control/` and `overlay/`, restart OBS, then re-paste and compile `VDO Push`, `VDO Sync` and `Discord Voice Push` (see the top of this entry). No bridge restart. `verify` 154/154, `verify:render` 192/192, `verify:cs` 57/57.

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
  carrying `?sbport` in dev) rather than hardcoded. It follows the
  `<name>-control` → `<name>-overlay` pairing of the two mappings (or
  `control` → `overlay`), not any prefix; see docs/STREAMERBOT-SETUP.md for the
  rule and the `?overlay=` override. (`38dadf4`, 2026-07-10)

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
- **Live-validation results recorded (Streamer.bot 1.0.4, 2026-07-10).** A
  seven-item checklist run on a real rig, no code changes needed: four confirmed
  live, one partial (the 100 ms coalesce floor held; the ~10 DoActions/s ceiling
  is offline-only), the 1×1 `director-min` source validated offline only, and
  multi-director safety left open. The
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

[1.0.95]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.87...v1.0.95
[1.0.87]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.84...v1.0.87
[1.0.84]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.81...v1.0.84
[1.0.81]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.78...v1.0.81
[1.0.78]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.75...v1.0.78
[1.0.75]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.72...v1.0.75
[1.0.72]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.69...v1.0.72
[1.0.69]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.66...v1.0.69
[1.0.66]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.63...v1.0.66
[1.0.63]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.59...v1.0.63
[1.0.59]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.55...v1.0.59
[1.0.55]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.52...v1.0.55
[1.0.52]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.49...v1.0.52
[1.0.49]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.46...v1.0.49
[1.0.46]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.43...v1.0.46
[1.0.43]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.40...v1.0.43
[1.0.40]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.37...v1.0.40
[1.0.37]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.34...v1.0.37
[1.0.34]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.29...v1.0.34
[1.0.29]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.24...v1.0.29
[1.0.24]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.17...v1.0.24
[1.0.17]: https://github.com/FlashGalatine/greenroom-guests/compare/v1.0.13...v1.0.17
[1.0.13]: https://github.com/FlashGalatine/greenroom-guests/compare/v0.1.0...v1.0.13
[0.1.0]: https://github.com/FlashGalatine/greenroom-guests/releases/tag/v0.1.0
