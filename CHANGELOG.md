# Changelog

All notable changes to **Greenroom** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the patch number is
the number of commits on `main` before the release commit.

Nothing was released between the initial release and 1.0.13, so that release
collects every change in between. Commit hashes and landing dates are noted for
traceability. Each release is tagged `v<version>` on its Release commit; the
tags `v0.1.0` and `v1.0.13` were added afterwards, on those two commits.

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
