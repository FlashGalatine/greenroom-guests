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
| Guest slot 1–4 | `http://127.0.0.1:7474/greenroom-overlay/vdoninja-guest.html?slot=1` (…`2`,`3`,`4`) |
| Guest nameplate *(optional)* | `http://127.0.0.1:7474/greenroom-overlay/nameplate.html?slot=1` — freely positioned name + socials plate (e.g. under the cam frame). The slot overlay also has a built-in lower-third; `?nameplate=0` hides it (docs/THEMING.md) |
| Discord roster | `http://127.0.0.1:7474/greenroom-overlay/discord-roster.html?layout=row` |
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

Auto-follow needs **one director page open somewhere** (it hosts the hidden
vdo.ninja director iframe that re-resolves labels → streamIDs every 2.5 s).
Deployment options, best first:

1. **`control.html` as an OBS Custom Browser Dock** — the natural operator home,
   and **validated (2026-07-10, SB 1.0.4)**: the director iframe's WebRTC +
   postMessage enumeration runs fine in dock CEF, so the dock alone keeps
   auto-follow alive while you stream — no separate director source needed. This
   was the one open question a mock couldn't answer; it passed.
2. **1×1 OBS Browser Source running `director-min.html`** — the headless
   always-on alternative (browser sources are known-good CEF). Use it if you
   prefer to keep the director running without the dock open; open `control.html`
   only to edit (a brief two-director overlap is fine — pushes converge).
3. **A pinned browser tab** — last-resort fallback, no longer needed now that
   the dock is validated.

**Nameplates & Guest Directory** auto-populates from whichever of those pages is
running (`director-min.html` does it too — the rule is shared in
`control/directory-core.js`): a new VDO label or voice-channel user is appended
with a placeholder name and an `auto` badge, so a mid-stream guest gets a
nameplate with nobody at the keyboard. Rename a row to make the name yours, `×` to
drop the guest for good (undo with **Un-ignore removed**), or untick **auto-add
guests** to stop inventing names at all — see docs/PROTOCOL.md for the
`directoryAutoAdd` / `directoryIgnored` wire fields.

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
   no bus command carries one.
4. Start the bridge: double-click `start-discord-bridge.bat` (visible log), or
   `npm run bridge` from the repo root, or the `Discord Bridge Start` action
   (hidden, auto-start). A second instance exits cleanly (single-instance guard
   on `:7495`).
5. In the control page: save a favorite (server ID / voice channel ID), press
   **USE**, then **Connect**. The pill should go `in voice · N present`.

`sidecar/discord-voice-config.json` (favorites/current/settings) is seeded from
the tracked example on first run and owned by the sidecar thereafter.

**Auto-leave when you close Streamer.bot.** By default the bridge keeps running
(and the bot stays in the call) after SB closes — it reconnects the moment SB
returns. If you'd rather have the bot **hang up and the sidecar quit when you
close SB**, tick *"leave call & quit when Streamer.bot closes"* in the control
page's Discord Voice Bridge section (persists to `settings.exitOnSbClose`). When
enabled, losing SB's WebSocket for longer than the grace window
(`GREENROOM_SB_EXIT_GRACE_MS`, default 8000 ms) makes the bridge disconnect from
voice cleanly and exit; an SB **restart** reconnects inside the window and
cancels the shutdown. The env var `GREENROOM_EXIT_ON_SB_CLOSE=1` forces it on (or
`=0` off) regardless of the saved setting — handy for the `Discord Bridge Start`
action or the `.bat`.

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
- [ ] **Multi-director safety** — **not stress-tested** (one director page at a
      time). Still open: the hidden director + a human-operated director link in
      the same room simultaneously.
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
- **Bridge exits immediately** → another instance is already running (guard port
  `:7495`), or Node < 22.12.
- **`in voice` but no speaking glow** → the bot must join with `selfDeaf: false`
  (already the shipped default — check you didn't server-deafen the bot).
- **An unwanted name appeared on stream** → auto-add invented a placeholder from a
  guest's VDO label or Discord name. Rename that row (the `auto` badge clears), `×`
  it, or untick **auto-add guests** in the directory bar; **Clear auto-added**
  removes every placeholder at once.
- **A removed guest keeps coming back** → they're live and auto-add is on, and the
  ignore key is only recorded by the row's `×` (or by emptying its VDO label or
  Discord ID field). Emptying the *name* does not remove anyone: the old name
  comes back with a "use × to remove" hint, because only `×` removes an entry.
  **Un-ignore removed (N)** shows how many guests are currently suppressed.
- **Lost your room/slots/guest directory** (SB reinstall, wiped globals, moved
  machines) → the dock config lives only in SB's persisted `vdo.state`. Keep a
  file copy: the control page's **Export/Import config** buttons, or the CLI
  (`npm run backup` / `npm run backup:restore -- <file>`). See the README's
  **Backups** section. Snapshots include the room password — keep them private.
