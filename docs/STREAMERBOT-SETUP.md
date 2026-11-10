# Greenroom — Streamer.bot setup

Verified pattern: Streamer.bot **1.0.4** on Windows. Total setup: two SB servers,
two HTTP path maps, five pasted actions (only one of which needs a References-tab
assembly), and — only if you use Discord slots/roster — one `npm install` and a
bot token file.

## 1. Streamer.bot servers

- **WebSocket Server** (Settings → WebSocket Server): enable on
  `127.0.0.1:8080`, **authentication OFF**. Everything in this repo assumes that
  (docs/PROTOCOL.md → Security posture).
- **HTTP Server** (Settings → HTTP Server): enable on `127.0.0.1:7474` and add
  two Path → Folder mappings:

  | Path | Folder |
  |---|---|
  | `greenroom-control` | `<this repo>\control` |
  | `greenroom-overlay` | `<this repo>\overlay` |

  The prefixes are namespaced on purpose: sibling components on the same SB may
  already claim the generic ones (SlowPan maps `overlay`, Tally maps `shared` +
  `themes`). Any prefix works — the pages load all their assets relatively —
  just keep your OBS URLs consistent with whatever you map.

  **Keep both servers on `127.0.0.1`.** While `greenroom-control` and
  `greenroom-overlay` are mapped, Streamer.bot's HTTP server and its WebSocket
  server (authentication off) must stay bound to loopback. On a network address
  they are reachable from every device that can see the PC, and a
  network-reachable Streamer.bot exposes more than Greenroom's pages. Moving
  `sidecar/discord-tokens.json` somewhere else does not change that, so don't
  rely on relocating files to keep them private.

  Serving over `http://127.0.0.1` is load-bearing twice: the embedded vdo.ninja
  WebRTC viewer renders **black** inside a `file://` page (non-secure context),
  and `file://` OBS sources ignore `?slot=`/`?sbport=` query params entirely.

## 2. The five actions

For each: **Actions → Add** with the EXACT name below (names are load-bearing —
the pages call `DoAction { name }`), then add sub-action **Core → C# → Execute
C# Code**, paste the whole file from `actions/`, and click **Compile** — it must
report success. *An ok ack only means the action started. An action that failed
to compile is silent (it acks ok and broadcasts nothing; the symptom is a blank or
stale overlay), so always click Compile and confirm it succeeds. An invalid
argument or a runtime exception inside a compiled state action (`VDO Push`, `VDO Sync`,
`Discord Voice Push`) is reported by an error broadcast, which the control page shows;
`Discord Bridge Start` only writes to Streamer.bot's log.*

| Action name | File | Notes |
|---|---|---|
| `VDO Push` | `actions/vdo-push.cs` | zero references |
| `Discord Voice Push` | `actions/discord-voice-push.cs` | zero references |
| `VDO Sync` | `actions/vdo-sync.cs` | zero references |
| `Discord Voice Command` | `actions/discord-voice-command.cs` | zero references |
| `Discord Bridge Start` *(optional)* | `actions/discord-bridge-start.cs` | **References step below** |

**Put the three state actions on their own blocking queue.** `VDO Push`,
`Discord Voice Push` and `VDO Sync` each read or write a saved state and broadcast it
(a push broadcasts, then saves; a sync reads, then broadcasts). On Streamer.bot's Default queue, which is non-blocking, actions
run concurrently, so a `VDO Sync` replay can land after a newer push and put
stale state back on the pages. Serialise the three:

1. Create a **new** Action Queue (for example `Greenroom State`) and tick
   **Blocking**. Never make the Default queue blocking: every other action you
   own runs on it.
2. Set the **Queue** of exactly `VDO Push`, `Discord Voice Push` and `VDO Sync` to
   the new queue. Leave `Discord Voice Command` and `Discord Bridge Start` on
   Default.
3. Restart Streamer.bot once and check that the queue is still **Blocking** and
   the three actions are still assigned to it.

The queue orders the actions; Greenroom's pages do not yet reject a stale
broadcast, so this queue is the only protection against that race today.

**Updating the three state actions: do it in this order.** The current `VDO Push`,
`VDO Sync` and `Discord Voice Push` broadcast the state as an escaped string field
(`vdoninjaJson`, `discordVoiceJson`) instead of a nested object, so a guest or Discord
name that looks like a timestamp can no longer be rewritten, or stop the broadcast,
inside Streamer.bot. The pages read both shapes (the control pages since 1.0.24, the
overlays since 1.0.29), which is why the order matters:

1. Run `npm run backup` while the **old actions are still in place** (it reads both
   shapes). Two caveats: if a guest label or name looks like a date or time, the old
   actions hand the backup a re-formatted copy (the tool says so when it happens), and if
   such a name makes the old `VDO Sync` fail, the backup stops with that error. Neither
   changes your saved config: carry on with steps 2 and 3, then take the backup again.
   That one is exact.
2. Update the **whole Greenroom folder** (or, at least, `control/`, `overlay/` and
   `backup.mjs`: an older `backup.mjs` cannot read the new frames and would say there is
   nothing to back up), then restart OBS or refresh **every** Greenroom browser source
   (guest slots, nameplates and the roster) and reload the dock, `director-min` and any
   control page you keep open in a browser tab, so every page loads code that
   understands the new frames.
3. **Only then** re-paste `VDO Push`, `VDO Sync` and `Discord Voice Push` into
   Streamer.bot and click **Compile** on each. No bridge restart is needed.

If the actions are re-pasted before the pages are updated, any overlay source (a guest
slot, a nameplate, the roster) still on code older than 1.0.29 shows nothing when the new
frames arrive, and a dock or `director-min` source older than 1.0.24 can overwrite
`vdo.state` with its defaults.

**Protect your saved config.** The room, slots and guest directory live only in
Streamer.bot's persisted `vdo.state`.
- Tick **Precompile on Application Start** on the Greenroom actions (the
  Execute C# Code sub-action). It narrows the window after Streamer.bot starts
  in which `VDO Sync` is not yet compiled and a page can come up showing
  defaults; it does not close that window.
- Take an **Export config** (control page) or `npm run backup` **before every
  Streamer.bot upgrade**, and keep the file private: it contains the room
  password.

**Discord Bridge Start extras** (skip for webcam-only setups):
1. Edit the `BUNDLE` const to your `…\Greenroom\sidecar` path.
2. Compiling as-is fails with `CS0246 'ProcessStartInfo'` / `CS0103 'Process'` —
   SB 1.0.4 doesn't reference `System.dll` by default. In the C# editor open the
   **References** tab (next to the Compiling Log) and add `System.dll` (browse to
   `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.dll` if needed). Compile → green.
3. Optional auto-start: in the action's **Triggers** box search "start" and add
   your SB version's application-started trigger.
4. `UseShellExecute = true` in that action is load-bearing: with `false` the node
   child inherits SB's listening sockets (WS :8080 / HTTP :7474), and after an
   unclean SB exit the orphaned child keeps those ports bound so SB can't restart
   its servers until the child is killed.

## 3. OBS sources

All **Browser Source → URL** (never "Local file"):

| Source | URL |
|---|---|
| Guest slot 1–4 | `http://127.0.0.1:7474/greenroom-overlay/vdoninja-guest.html?slot=1` (…`2`,`3`,`4`): use the control page's per-slot **Copy** buttons; a `?slot=` other than 1 to 4 shows nothing |
| Guest nameplate *(optional)* | `http://127.0.0.1:7474/greenroom-overlay/nameplate.html?slot=1` — freely positioned name + socials plate (e.g. under the cam frame). The slot overlay also has a built-in lower-third; `?nameplate=0` hides it (docs/THEMING.md) |
| Discord roster | `http://127.0.0.1:7474/greenroom-overlay/discord-roster.html?layout=row`: give the source room for your busiest call (about 90 px of width per member in a row at the default sizes, e.g. 1200 × 140 for 12 people; a grid wraps, so give it height). Members that do not fit are folded into a `+N` chip automatically, the streamer first; `?max=` caps it lower. If the Discord feed stops (the bridge died: three missed heartbeats) the roster hides as if nobody were there |
| Always-on director | `http://127.0.0.1:7474/greenroom-control/director-min.html` as a **1×1 px** source |

Every page fires the `VDO Sync` action on connect, so a source added mid-stream
paints immediately.

`?sbport=<n>` (a development knob: it points a page at a Streamer.bot WebSocket on
another port) accepts only a port number from 1 to 65535, and the host is always
`127.0.0.1`. Anything else (text, `0`, `65536`, an `@`) is refused: the page shows
"invalid ?sbport", does not connect, and does not fall back to 8080.

## 4. The control page + the director

`http://127.0.0.1:7474/greenroom-control/control.html` — open as a browser tab
or an OBS **Custom Browser Dock** (Docks → Custom Browser Docks…).

Auto-follow needs **one long-lived director** (it hosts the hidden
vdo.ninja director iframe that re-resolves labels → streamIDs every 2.5 s): the
`director-min.html` source when you use it, otherwise the dock's own hidden
director. A second director page, **including the Manage link** the invite builder
generates, does not own the room (Greenroom's own director page claims it first)
and has limited control; see "The Manage link" below.
Deployment options, best first:

1. **`control.html` as an OBS Custom Browser Dock** — the natural operator home,
   and **validated (2026-07-10, SB 1.0.4)**: the director iframe's WebRTC +
   postMessage enumeration runs fine in dock CEF, so the dock alone keeps
   auto-follow alive while you stream — no separate director source needed. This
   was the one open question a mock couldn't answer; it passed.
2. **1×1 OBS Browser Source running `director-min.html`** — the headless
   always-on alternative (browser sources are known-good CEF). Use it if you
   prefer to keep the director running without the dock open; open `control.html`
   only to edit, and **tick "director-min.html is my always-on director"** in the
   dock's Room & Director section (it is saved with the config). The dock then
   sends only your own edits (carrying the stream IDs Streamer.bot holds, not
   its own view of them) and leaves following the guests, and adding them to
   the directory, to director-min; it warns "director-min is designated but not
   correcting: is its OBS source visible?" if the saved stream IDs stay different
   from what its own director sees for about 30 s. **Never untick the shared
   "director enabled" box to free the room**: that blanks every slot. (Two
   directors at once only converge on the newer state; they do not protect an
   edit. An edit made just as a guest joins or a voice user appears may need
   redoing, or hide the director-min source while you edit.)
3. **A pinned browser tab** — last-resort fallback, no longer needed now that
   the dock is validated.

A director that has just (re)loaded keeps the stream of a label it has not
reported yet for about 10 s, so a director that starts cold does not blank guests
who are on air.

**The Manage link.** The invite builder's Manage link is a second vdo.ninja
director. Because Greenroom's own director page claims the room first, a Manage
page opened beside it does not own the room and has limited control. To use it as
the full director: close the dock and any director-min source, refresh the Manage
page so it claims the room, then reopen the dock and show the director-min source
again (each rejoins without control). Auto-follow pauses until they are back;
with the always-on box ticked the dock sends no roster pushes, so slots follow
guests again only once the director-min source is running. This has not been
checked against a live room yet.

**Nameplates & Guest Directory** auto-populates from whichever of those pages is
running (`director-min.html` does it too — the rule is shared in
`control/directory-core.js`): a new VDO label or voice-channel user is appended
with a placeholder name and an `auto` badge, so a mid-stream guest gets a
nameplate with nobody at the keyboard. Rename a row to make the name yours, `×` to
drop the guest for good (undo with **Un-ignore removed**), or untick **auto-add
guests** to stop inventing names at all — see docs/PROTOCOL.md for the
`directoryAutoAdd` / `directoryIgnored` wire fields.

Labels are matched ignoring case, `_` versus a space and vdo.ninja's HTML
escaping (`Guest_One` is `Guest One`), and two labels that differ only in case
can be two guests. A row you have **named yourself is never linked to a Discord
user by name** (Discord names are self-chosen): when a voice user has the same
name the row offers "link <name> (<id>)?" for you to accept or reject (with two
or more voice users of that name it offers nothing and says so: set the ID
yourself). Until you accept, that guest's roster chip shows the raw Discord name
and a discord-mode slot bound to them shows no plate. Hidden characters in a
label (a zero-width space, say) are ignored when labels are compared, so a
guest who adds one to the name of a guest you have named gets that guest's
plate; the lists spell such characters out as `<U+200B>` and mark two live
labels that are the same once case, spacing and hidden characters are ignored,
including the label pick of a guest slot. At most 50 auto-added entries are kept; at
the limit the dock says so (the ones for guests no longer in the room, and not
in a slot, make way first; entries you named never do).

## 5. The Discord bridge sidecar (optional)

Webcam-only users skip this whole section — nothing else depends on it.

1. `cd sidecar && npm install` (Node **≥ 22.12**; the only place the discord.js
   stack exists).
2. Create a bot at https://discord.com/developers/applications → Bot. It needs
   only the non-privileged **Guilds** + **Guild Voice States** intents (nothing
   to toggle for those) and, on the target channel, **View Channel + Connect**
   permissions. Invite it to your server.
3. Create `sidecar/discord-tokens.json` (gitignored):
   ```json
   { "botToken": "PASTE-TOKEN-HERE", "enabled": true }
   ```
   The token is file-only by design — the control page has no token field, and
   no bus command carries one. **Press Connect after editing the file**: Connect
   re-reads it every time (a corrected token is adopted, an empty one or a deleted
   file forgets the token). The launcher `start-discord-bridge.bat` installs what is missing or stale itself, but never under a bridge that is already running (close that one first). A file that exists but is not valid JSON is reported as
   that ("re-save it as UTF-8 (no BOM)"), never as missing, and is never overwritten.
4. Start the bridge: double-click `start-discord-bridge.bat` (visible log), or
   `npm run bridge` from the repo root, or the `Discord Bridge Start` action
   (hidden, auto-start). A second instance exits cleanly (single-instance guard
   on `:7495`); a **newer** build asks an older one to quit and takes over (stop an
   old bridge from before this release yourself first: it has no `quit` command).
   Options go on the command line, in an edited `.bat` or `npm run bridge -- …`:
   `--sb-ws-url=ws://127.0.0.1:8080/`, `--guard-port=7495`,
   `--exit-on-sb-close=1`; an argument wins over `SB_WS_URL`,
   `GREENROOM_GUARD_PORT` and `GREENROOM_EXIT_ON_SB_CLOSE`. The `Discord Bridge
   Start` action cannot set environment variables: do not launch the bridge with
   a "Run a Program" sub-action that sets some, or waits for exit.
5. In the control page: save a favorite (server ID / **regular voice channel (not a
   Stage)** ID), press **USE**, then **Connect**. The pill should go
   `in voice · N present`.
   The channel must be in a server the bot is in, and one the bot can join (View
   Channel + Connect, and room under its user limit). While the bot is online,
   **USE** checks that first: a channel that fails (wrong server, a text channel, a
   Stage, no View Channel + Connect, a full channel) shows the reason in the status
   line for about a minute and changes nothing: the bot stays in the channel it was
   in, with its roster. (Pressed before **Connect**, USE just saves the pick, and
   the same check runs when the bot logs in: a saved channel that fails it is not
   joined and its reason stays on the status line until you pick another channel.)
   Removing the favorite that is the current channel makes the bot leave it, unless
   another favorite names the same channel. Guests invited into a call (they are not
   server members) appear in the roster by their nickname or Discord name, with
   their mute and deafen state, and members show their per-server avatar.
   If someone drags the bot to another voice channel in Discord, the roster follows
   it for as long as that connection lasts (a Stage is not read: the roster is
   empty there); **USE** (or ACTIVE) brings it back to your chosen channel, and
   so does any rebuild of the connection (after a drop, or when the gateway resumes
   while it was waiting). If the bot's
   connection drops, the bridge rejoins by itself (after 2, 5, 15, then every 30
   seconds); if Discord removes the bot from the call, or the call ends, it stays
   out until you press **USE** or **Connect**. A login that fails because Discord or
   your network is down is retried (5 s, doubling to 5 minutes); a rejected token is
   not.

`sidecar/discord-voice-config.json` (favorites/current/settings) is seeded from
the tracked example on first run and owned by the sidecar thereafter.

**Auto-leave when you close Streamer.bot.** By default the bridge keeps running
(and the bot stays in the call) after SB closes — it reconnects the moment SB
returns. If you'd rather have the bot **hang up and the sidecar quit when you
close SB**, tick *"leave call & quit when Streamer.bot closes"* in the control
page's Discord Voice Bridge section (persists to `settings.exitOnSbClose`). When
enabled, losing SB's WebSocket for longer than the grace window
(`GREENROOM_SB_EXIT_GRACE_MS`, default 8000 ms) makes the bridge disconnect from
voice cleanly and exit; an SB **restart** reconnects inside the window (the bridge
retries about once a second meanwhile, and makes one last attempt when the window
ends) and cancels the shutdown. The env var `GREENROOM_EXIT_ON_SB_CLOSE=1` forces
it on (or `=0` off) regardless of the saved setting, and so does
`--exit-on-sb-close=1` / `=0` in an edited `.bat`. The bridge outlives
Streamer.bot on any SB exit when this is off: there may be no listener to see
in `netstat`, look for `node.exe` as a client of the SB port.

**How the bridge stops.** Every way out is one routine: it pushes a final state
(`stopped: true`, nobody in voice) to Streamer.bot, leaves the voice call once and
exits. That covers Ctrl+C, Ctrl+Break, closing its window, the `quit` command and
exit-on-close, and a crash (exit code 1, the error in the pushed `rpc.error`).
**Ending `node.exe` in Task Manager** (the hidden instance the SB action starts
included) cannot leave cleanly: the bot stays in the call until Discord times it
out, so use exit-on-close or the `quit` command for that setup (until the control
page has a Stop button, send it from a Streamer.bot action that runs `Discord Voice
Command` with `command` = `quit`). A rejected promise
is logged and the bridge keeps running. The bot token is never written to the log or to
`rpc.error`.

## 6. Live-validation results (2026-07-10, real Streamer.bot 1.0.4)

What the offline harness (64 protocol + 23 render checks) **cannot** prove was
exercised on a live rig. Outcomes, faithfully:

- [x] **Real SB wiring** — the four core actions compile and broadcast (verified
      by calling the push actions with no payload → their `vdo:error` /
      `discord:voice:error` shapes round-trip). After an SB **restart**, `VDO
      Sync` replayed the persisted `vdo.state` immediately (the room config
      survived). *Note:* the `discord.state` **non**-replay half stays
      offline-proven (`verify.mjs` [3] via `/mock/restart`) — live, the bridge's
      3 s reconnect re-pushed before the absence window could be captured.
- [x] **Real vdo.ninja** — live `getGuestList` parsed; slot labels resolved to
      live stream IDs; **auto-follow** confirmed (guest left → slot blanked;
      rejoined → slot re-acquired within a poll, no operator action). *Note:* an
      invite with `&sticky` returns the **same** stream ID on rejoin, so the
      overlay re-acquires it seamlessly; the **new-ID swap** path is the offline
      `verify-render` case (`aaa111 → blank → aaa333`) — together they cover both
      vdo.ninja modes. Actual video render in the slot is operator-observed in OBS.
      A `getGuestList` shape change is maintenance, not a kill — fix
      `control/vdo-parse.js`.
- [x] **Real bot** — token onboarding per §5 worked; voice join + E2EE handshake
      succeeded (`libsodium-wrappers` stack; bot reached `hostInChannel`); live
      speaking edges arrived from the channel and drove the glow. *Not separately
      exercised live:* mute/deaf **badge toggling** on a live state change
      (covered offline).
- [~] **Sustained rate** — the 100 ms coalesce **floor** held live (min
      inter-push gap ≥ 100 ms under solo speech). The ~10 DoActions/s
      rowdy-channel **ceiling** remains offline-only (the 20-user 100 ms burst in
      `verify-render` [R4]); a live multi-speaker stress test is still worthwhile.
- [x] **OBS dock CEF spike** — **PASSED.** The director iframe (WebRTC +
      postMessage) enumerates and pushes from inside a Custom Browser Dock, so
      the dock alone drives auto-follow (see §4).
- [ ] **Multi-director safety** — **not stress-tested live** (one long-lived
      director at a time; see §4). Tested on the mock only: two pages converge on the
      newer state (docs/PROTOCOL.md, Revisions). Still open: the hidden director +
      a human-operated director link in the same room simultaneously, and the
      Manage link opened before and after the dock.
- [x] **1×1 source pattern** — `director-min.html` validated offline
      (`verify-render` [R1]); live, the director ran from `control.html` / the
      dock. Confirm the standalone 1×1 source with the dock closed if you adopt
      that deployment.

## Troubleshooting

- **Overlay stays blank** → 90% one of: action name typo (must match exactly),
  C# not compiled (open the action, Compile), SB WS auth accidentally ON, or a
  consumer subscribing with capitalized `General` (use the shipped shim).
- **Guest slot black but the URL looks right** → the page was loaded as a
  `file://` Local-file source; use the `http://127.0.0.1:7474/...` URL field.
- **SB can't restart its WS/HTTP server after a crash** → an orphaned helper
  child is holding the sockets; kill stray `node.exe` (see §2 UseShellExecute).
- **Bridge exits immediately** → it says why in its log. Another program, or a
  Greenroom bridge older than this release (it sends no banner), holds the guard
  port `:7495` ("held by another program or by a Greenroom bridge older than this
  release"): check with `netstat -ano | findstr 7495`, end that `node.exe`, or set
  `--guard-port=` / `GREENROOM_GUARD_PORT`. A running bridge of the same or a newer
  version says so and exits; Node older than 22.12 says "Node >= 22.12 required".
- **The bridge window shows "Select" in its title and stops scrolling** → a click in
  the console window starts a text selection (QuickEdit) and Windows pauses the
  program that writes to it. The bridge writes its log from a worker thread, so its
  pushes and its exit are not held up (the log lines just stop until you press Esc). To avoid it, untick QuickEdit Mode in the
  window's Properties, use Windows Terminal, or start the bridge hidden with the
  `Discord Bridge Start` action.
- **`in voice` but no speaking glow** → the bot must join with `selfDeaf: false`
  (already the shipped default — check you didn't server-deafen the bot). Speaking
  detection uses Discord's voice receive, which Discord does not document: if the
  glow stops after a Discord update, run `npm update` in `sidecar/` and start the
  bridge again. The feed's `rpc.speakingStale` flags a long silence with people
  unmuted in the call.
- **"Removed from voice (…), press USE to rejoin" or "Voice connection not ready"
  in the middle of a stream** → Discord removed the bot from the call (or the call
  ended), or the voice connection could not start. Press **USE**/**ACTIVE** (or
  **Connect**) once Discord is reachable. "not ready after … still retrying" means
  the bridge is still trying; if it keeps failing, check the bot has View Channel +
  Connect on that channel and that the channel has room under its user limit, or
  that Discord is not having an outage.
- **"Bot login failed … retrying"** → Discord or your network is unreachable; the
  bridge retries on its own with a growing delay. A rejected token is not retried
  ("Bot login failed: An invalid token was provided. — fix the token, then press
  Connect." at login, or "Discord rejected the bot token (4004)" when Discord closes
  the session): reset it in the Developer Portal, put the new one in
  `sidecar/discord-tokens.json` and press **Connect**.
- **An unwanted name appeared on stream** → auto-add invented a placeholder from a
  guest's VDO label or Discord name. Rename that row (the `auto` badge clears), `×`
  it, or untick **auto-add guests** in the directory bar; **Clear auto-added**
  removes every placeholder at once.
- **A removed guest keeps coming back** → they're live and auto-add is on, and the
  ignore key is only recorded by the row's `×` (or by emptying its VDO label or
  Discord ID field). Emptying the *name* does not remove anyone: the old name
  comes back with a "use × to remove" hint, because only `×` removes an entry.
  **Un-ignore removed (N)** shows how many guests are currently suppressed.
- **"SB offline, changes will be sent on reconnect"** → Streamer.bot's WebSocket is
  unreachable and the page holds an edit (or a push that may not have arrived).
  Nothing is lost: when the connection returns the dock sends its own state
  instead of adopting the older saved one, and director-min re-pushes a
  difference in stream IDs after two polls.
- **"not confirmed by Streamer.bot: is VDO Push compiled?"** → a push was sent but
  never came back as a broadcast within about five seconds. Open the **VDO Push**
  action in Streamer.bot and compile it; the dock stays as you left it, but the
  overlays are not receiving it.
- **"director-min is designated but not correcting"** → "director-min.html is my
  always-on director" is ticked in the dock, but the saved stream IDs stay different
  from what the dock's own director sees. Make sure the director-min source is
  visible (not hidden in OBS) and its URL has the right `?sbport`, or untick the box.
- **A page says "reload this page"** → the saved config was written by a newer
  Greenroom than that page (`schemaVersion` 2 and above): reload it, and refresh
  the OBS sources so every page runs the same version.
- **Lost your room/slots/guest directory** (SB reinstall, wiped globals, moved
  machines) → the dock config lives only in SB's persisted `vdo.state`. Keep a
  file copy: the control page's **Export/Import config** buttons, or the CLI
  (`npm run backup` / `npm run backup:restore -- <file>`). See the README's
  **Backups** section. Snapshots include the room password — keep them private.
