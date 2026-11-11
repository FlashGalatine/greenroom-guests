# Greenroom — Streamer.bot setup

Verified pattern: Streamer.bot **1.0.4** on Windows ("Tested versions" in §6 says what has and has not been run on newer ones).
Setup, in order: two Streamer.bot servers and two HTTP path maps (§1); four pasted actions, plus an
optional fifth that needs one References-tab assembly, three of them on their own blocking queue (§2); the OBS sources (§3); then the
**first run** of the control page (§4): room and password, Save, director on, invite, bind the slots.
Only if you use Discord slots or the roster: one `npm install` and a bot token file (§5). Updating an
existing install is in the README ("Updating").

## 1. Streamer.bot servers

- **WebSocket Server** (Servers/Clients → WebSocket Server): enable on
  `127.0.0.1:8080`. **Authentication OFF** is the default and what the steps below
  assume; once every Greenroom piece is updated you can turn Authentication plus
  Enforce on ("Optional: Streamer.bot Authentication" below; docs/PROTOCOL.md →
  Security posture).
- **HTTP Server** (Servers/Clients → HTTP Server): enable on `127.0.0.1:7474` and add
  two Path → Folder mappings:

  | Path | Folder |
  |---|---|
  | `greenroom-control` | `<this repo>\control` |
  | `greenroom-overlay` | `<this repo>\overlay` |

  The prefixes are namespaced on purpose: sibling components on the same SB may
  already claim the generic ones (SlowPan maps `overlay`, Tally maps `shared` +
  `themes`). Any prefix works — the pages load all their assets relatively —
  just keep your OBS URLs consistent with whatever you map.

  The control page's **Copy** and **Open** buttons build the overlay addresses
  from where the control page itself was opened: `<name>-control` becomes
  `<name>-overlay`, and `control` becomes `overlay` (case does not matter, and
  the case you used is kept). If your two prefixes do not pair up like that,
  the buttons assume `greenroom-overlay` and the page says so under the guest
  slots. (A control prefix that ends in `-control` is always taken to pair with
  `-overlay`; the page cannot know if your overlay folder is mapped under another
  name.) Open the control page with `?overlay=<your overlay prefix>` (one name,
  no slashes) to tell it, in either case. A control page opened under a LAN name builds
  `127.0.0.1` addresses, because the OBS that uses them runs on this PC.

  **Keep both servers on `127.0.0.1`.** While `greenroom-control` and
  `greenroom-overlay` are mapped, Streamer.bot's HTTP server and its WebSocket
  server must stay bound to loopback (with Authentication on too). On a network address
  they are reachable from every device that can see the PC, and a
  network-reachable Streamer.bot exposes more than Greenroom's pages. Moving
  `sidecar/discord-tokens.json` somewhere else does not change that, so don't
  rely on relocating files to keep them private.

  Serving over `http://127.0.0.1` is load-bearing twice: the embedded vdo.ninja
  WebRTC viewer renders **black** inside a `file://` page (non-secure context),
  and `file://` OBS sources ignore `?slot=`/`?sbport=` query params entirely.

  **Ports and addresses.** Everything assumes the WebSocket on `127.0.0.1:8080` and the HTTP
  server on `127.0.0.1:7474`. If yours are elsewhere:

  - Add `?sbport=<WebSocket port>` to `control.html`, `director-min.html` and every overlay
    address (`&sbport=` after an existing `?`). The control page's Copy and Open buttons
    carry it for the addresses they build **only when the control page itself was opened
    with it**; the roster and director-min addresses you add by hand.
  - Give the bridge the address on its command line: start the `.bat` with it
    (`start-discord-bridge.bat --sb-ws-url=ws://127.0.0.1:<port>/`: the `.bat` passes its arguments to both of its
    `node` lines), or put it in `psi.Arguments` of `Discord Bridge Start`
    (`psi.Arguments = "discord-bridge.mjs --sb-ws-url=ws://127.0.0.1:<port>/";`).
    `SB_WS_URL` and `SB_WS_PORT` still work from a console, or as a Windows user variable plus
    a Streamer.bot restart (which survives an update, unlike an edit of the `.bat` or the action).
    **Do not call `Environment.SetEnvironmentVariable` inside the action**: that changes Streamer.bot's own
    environment for every program it starts afterwards.
  - Two more settings: the single-instance guard port (`--guard-port=` on the same command line, or
    `GREENROOM_GUARD_PORT`, default 7495), and how long the bridge waits for Streamer.bot to come back before it
    leaves voice and exits when exit-on-close is on (`GREENROOM_SB_EXIT_GRACE_MS`, default 8000 ms, never less
    than 1000): that one is an environment variable only (a console, or a Windows user variable plus a
    Streamer.bot restart).
  - **Open the pages as `http://127.0.0.1:<port>/…` (or `http://localhost:<port>/…`), never by
    LAN address or computer name.** Those are not secure contexts: vdo.ninja refuses an insecure
    parent page, so the director does not start (the pill says "director: needs a secure page
    (open via 127.0.0.1)"), and the password-hash invite needs the browser's crypto, which an
    insecure page does not have.

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

The queue orders the actions. The control pages drop a state older than the one they hold (the revision stamps,
since 1.0.63), but the overlays do not, so this queue is what protects them from a stale replay.

**Updating the three state actions: do it in this order.** The current `VDO Push`,
`VDO Sync` and `Discord Voice Push` broadcast the state as an escaped string field
(`vdoninjaJson`, `discordVoiceJson`) instead of a nested object, so a guest or Discord
name that looks like a timestamp can no longer be rewritten, or stop the broadcast,
inside Streamer.bot. The pages read both shapes (the control pages since 1.0.24, the
overlays since 1.0.29), which is why the order matters:

1. Run `npm run backup` while the **old actions are still in place** (it reads both
   shapes; the backup CLI needs Node 22.12+ and a one-time `npm install --omit=dev` in the Greenroom folder). Two caveats: if a guest label or name looks like a date or time, the old
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
  password. Inside an OBS dock the download may save silently or not at all: copy the text from the box the
  page shows. Updating Greenroom itself: the README's **Updating** section.

**Discord Bridge Start extras** (skip for webcam-only setups):
1. Edit the `BUNDLE` const (it reads `C:\path\to\greenroom-guests\sidecar` until you do, and the
   action then logs "BUNDLE is still the placeholder" and starts nothing) to your
   `…\greenroom-guests\sidecar` path. **Change only that line.** `BUNDLE_PLACEHOLDER`, two lines below it,
   must keep its original text: the action treats a `BUNDLE` equal to it as not set, so a find-and-replace that puts
   your path on both lines gives "BUNDLE is still the placeholder" although the path is right. The action checks that the folder exists, holds
   `discord-bridge.mjs` and has `node_modules`, and logs which one is wrong; it finds
   Node as Windows finds it (Streamer.bot's own PATH first); only if `node` is not found
   there does it look for `node.exe` in the Node.js registry key, `%ProgramFiles%\nodejs`
   and the freshly read Machine and User PATH. It then waits two seconds and reports a
   bridge that exits in that time with its exit code ("bridge already running" for a
   clean exit 0: one of the same or a newer version holds the guard). A refusal that
   takes longer, such as the guard port held by another program or by an older bridge,
   is logged by the bridge itself in its hidden window after about five seconds: the
   action says "launched", so if no bridge appears run `start-discord-bridge.bat` to see why.
2. Compiling as-is fails with `CS0234 'ComponentModel'` / `CS0246 'Process'` (or
   `'ProcessStartInfo'`) — SB 1.0.4 doesn't reference `System.dll` by default. In the C# editor open the
   **References** tab (next to the Compiling Log) and add `System.dll` (browse to
   `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.dll` if needed). Compile → green.
3. Optional auto-start: in the action's **Triggers** box search "start" and add
   your SB version's application-started trigger.
4. `UseShellExecute = true` in that action is load-bearing: with `false` the node
   child inherits SB's listening sockets (WS :8080 / HTTP :7474), and after any SB
   exit that does not close the bridge (a normal close too, unless exit-on-SB-close is
   on, as well as a crash or a kill) the child keeps those ports bound so SB can't
   restart its servers until the child is killed. For the same reason do not start the
   bridge with a "Run a Program" sub-action that sets environment variables or waits
   for the program to exit.

## 3. OBS sources

All **Browser Source → URL** (never "Local file"):

| Source | URL |
|---|---|
| Guest slot 1–4 | `http://127.0.0.1:7474/greenroom-overlay/vdoninja-guest.html?slot=1` (…`2`,`3`,`4`): use the control page's per-slot **Copy** buttons; a `?slot=` other than 1 to 4 shows nothing |
| Guest nameplate *(optional)* | `http://127.0.0.1:7474/greenroom-overlay/nameplate.html?slot=1` — freely positioned name + socials plate (e.g. under the cam frame). The slot overlay also has a built-in lower-third; `?nameplate=0` hides it (docs/THEMING.md) |
| Discord roster | `http://127.0.0.1:7474/greenroom-overlay/discord-roster.html?layout=row`: give the source room for your busiest call (a member takes up to about 120 px of width in a row at the default sizes with names showing, about 86 px with `?labels=0`; so 1450 × 140 holds 12 people with the longest names; a grid wraps, so give it height). Members that do not fit are folded into a `+N` chip automatically, the streamer first; `?max=` caps it lower. If the Discord feed stops (the bridge died: three missed heartbeats, about 15 seconds) the roster hides as if nobody were there. It can come back for up to 15 seconds each time another source or a dock page connects, because VDO Sync replays the last push, which looks fresh to the page: a known limit until the replay carries its age |
| Always-on director | `http://127.0.0.1:7474/greenroom-control/director-min.html` as a **1×1 px** source in a scene that is **always shown** (§4): OBS may suspend a source that is not shown |

Every page fires the `VDO Sync` action on connect, so a source added mid-stream
paints immediately.

**Start Streamer.bot (its HTTP and WebSocket servers) before OBS.** A source or dock that loads
while the HTTP server is down does not show the page. A source may stay blank for a long time (it retries
with growing delays, and not while it is hidden): use **Refresh cache of current page**; for a dock click
**Retry** on its "failed to load" page.

**Audio (the four guest-slot sources only).** In each guest-slot source's properties tick
**Control audio via OBS**, so the guest has a meter and a fader of their own in the mixer. To hear
guests yourself, set that source's **Audio Monitoring** (Advanced Audio Properties) to **Monitor and
Output** on a device that **Desktop Audio does not capture** (headphones on a second output):
monitoring into a device that Desktop Audio records puts the guest on stream twice. The
nameplate, roster and director-min sources carry no audio.

**One source per slot.** Add each guest-slot source once and reuse it in other scenes with **Add
Existing** or **Paste (Reference)**, never with a new source or **Paste (Duplicate)**: every copy
is one more viewer of that guest, and the guest's PC sends one more full video stream for it. A
different look in another scene is a `nameplate.html?slot=N` source (it carries no video). The
control page's per-slot **Open** button (the preview) costs one more stream while it is open.

`?sbport=<n>` (a development knob: it points a page at a Streamer.bot WebSocket on
another port) accepts only a port number from 1 to 65535, and the host is always
`127.0.0.1`. Anything else (text, `0`, `65536`, an `@`) is refused: the page shows
"invalid ?sbport", does not connect, and does not fall back to 8080.

## 4. The control page + the director

`http://127.0.0.1:7474/greenroom-control/control.html` — open as a browser tab
or an OBS **Custom Browser Dock** (Docks → Custom Browser Docks…).

### First run (a fresh install, once)

1. Open `control.html`. With `VDO Sync` compiled, a fresh install shows no warning: the action tells the page that
   nothing is saved yet and the page pushes nothing on its own until you save. If the page instead says "No saved
   config has come back from Streamer.bot: this is a fresh install, or VDO Sync is missing or not compiled", `VDO Sync`
   did not answer: open the action and **Compile** it. If you had a config before, wait about 15 seconds or reload the
   page: the saved config comes back by itself once `VDO Sync` answers. **Import** a backup only if it still does not
   (a Streamer.bot reinstall or wiped globals).
2. Type the **Room** and the **Password** and press **Save**. It goes straight through. Only when `VDO Sync` has not
   answered does Save ask first ("Streamer.bot has not returned your saved config; saving now replaces it"): then do
   **not** confirm unless you are sure nothing is saved; fix `VDO Sync` first.
3. Tick **director enabled**. The pill goes `director: connecting…` and then `director: connected · N guests`.
   `director: idle` means no room is set or the box is not ticked. `director-min.html` says `no saved config yet`
   until a config has been saved once (and `connected to SB — waiting for state` while Streamer.bot has not answered).
4. Under **Invite & Director Links** copy the guest link and send it. The default link makes vdo.ninja ask each
   guest for a **display name** (a bare `&label`); a guest who cancels that prompt arrives without a label and
   cannot be bound to a slot (the pill counts them as `unlabeled`). A label typed in the builder wins, for a link
   meant for one guest.
5. When a guest is live, pick them in a **Guest Slot** dropdown, one slot at a time; the slot's overlay source
   (§3) shows them. Bind a guest once: from then on the slot follows that label when the guest leaves and
   comes back.

What the invite options do ("Invite & Director Links"):

- **password mode** — *hash (private)*: the link carries vdo.ninja's own 4-character check of the password
  (`&hash=`), which is **not** the password: each guest is still asked to type it, so use a long room name and a
  long password. *plaintext*: the link carries `&password=…`. *none*: the link carries a bare
  `&password`, so vdo.ninja asks the guest to type it (send it separately); a hash link that cannot be
  computed falls back to the same bare `&password`.
- **fps**, **video bitrate**, **audio bitrate** cap what the guest *sends* (`&maxframerate`,
  `&outboundvideobitrate`, `&outboundaudiobitrate`); **guest sends no video / no audio** stops the guest sending
  one of them. There is no width or height option, no codec, no require-approval and no room cap on the guest
  link: vdo.ninja has no sender-side flag for them.
- **viewFlags** (Room & Director) are the flags Greenroom puts on the view address of each slot. The default is
  `&solo&hidescreenshare&rounded=0&tallyoff&fadein&codec=h264&cleanish` (**reset to default** puts it back). A
  leading `&` is added when you leave it off, flags that load script or style, send events away, or name the room,
  stream or password are dropped (with a warning under the field), and the overlay adds `&solo` to each slot's view
  address unless the flags already hold `solo` or `scene` (a view without either would show the whole room).

Auto-follow needs **one long-lived director** (it hosts the hidden
vdo.ninja director iframe that re-resolves labels → streamIDs every 2.5 s): the
`director-min.html` source when you use it, otherwise the dock's own hidden
director. A second director page, **including the Manage link** the invite builder
generates, does not own the room (Greenroom's own director page claims it first)
and has limited control; see "The Manage link" below.
Deployment options, best first:

1. **1×1 OBS Browser Source running `director-min.html`, in a scene that is always shown** —
   recommended: the director keeps running whether or not the dock is open, and a source that loaded while Streamer.bot
   was down needs only **Refresh cache of current page** (a dock needs **Retry**). Not yet confirmed live (§6). **Keep it shown whenever slots are live**: OBS
   may suspend a source that is not shown, and auto-follow then stops following. Open `control.html` (the
   dock) only to edit, and **tick "director-min.html is my always-on director"** in the
   dock's Room & Director section (it is saved with the config): the dock still connects its own hidden director, but only
   director-min follows guests and pushes; the dock is for editing. The dock then
   sends only your own edits (carrying the stream IDs Streamer.bot holds, not
   its own view of them) and leaves following the guests, and adding them to
   the directory, to director-min; it warns "director-min is designated but not
   correcting: is its OBS source visible?" if the saved stream IDs stay different
   from what its own director sees for about 30 s. **Never untick the shared
   "director enabled" box to free the room**: that blanks every slot. (Two
   directors at once only converge on the newer state; they do not protect an
   edit. An edit made just as a guest joins or a voice user appears may need
   redoing, or hide the director-min source while you edit.)
2. **`control.html` as an OBS Custom Browser Dock, without director-min** — the dock's own hidden director is
   then the one director. **Validated (2026-07-10, SB 1.0.4)**: the director iframe's WebRTC +
   postMessage enumeration runs fine in dock CEF, so the dock alone keeps auto-follow alive while you
   stream. The dock must stay open, and if Streamer.bot was not up when OBS started it waits on its "failed to load"
   page until you click **Retry**.
3. **A pinned browser tab** — last-resort fallback.

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
including the label pick of a guest slot. At most 50 auto-added placeholders (rows
with the `auto` badge) are kept. At the limit the ones for guests no longer in the
room, and not in a slot, make way. The dock names the guests its own pass
removes, an Import's included; a removal made by director-min is not reported
anywhere, and with director-min designated it often sees a new guest first. When
none can make way, the dock says the limit is reached. Entries you named or edited
never make way, and neither does a row that holds socials. A row from before
1.0.49 where you set only the label or the Discord ID still shows the badge and
can make way: rename it to keep it.

## 5. The Discord bridge sidecar (optional)

Webcam-only users skip this whole section — nothing else depends on it.

1. `cd sidecar && npm install` (Node **≥ 22.12**; the only place the discord.js
   stack exists). If you start the bridge with the `Discord Bridge Start` action,
   **restart Streamer.bot after installing Node**: it reads its PATH only when it
   starts (the action also looks in the registry, Program Files and the saved
   Machine and User PATH; a version manager that changes PATH only per shell, such
   as fnm, is not covered: restart Streamer.bot or use the `.bat`).
2. Create a bot at https://discord.com/developers/applications → Bot. It needs
   only the non-privileged **Guilds** + **Guild Voice States** intents (nothing
   to toggle for those) and, on the target channel, **View Channel + Connect**
   permissions. **Invite it to your server**: in the Developer Portal open your
   application → **OAuth2** → **URL Generator**, tick the `bot` scope and the permissions
   **View Channels** and **Connect**, open the link it generates and pick the server.
   For the ids you will paste into the control page, turn on **Developer Mode** (Discord →
   User Settings → Advanced), then right-click a server, a voice channel or yourself →
   **Copy Server ID** / **Copy Channel ID** / **Copy User ID**.
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
5. In the control page: put **your own Discord user ID** in the streamer id box (the roster
   shows you first and `hideWhenAbsent` follows you), save a favorite (server ID / **regular
   voice channel (not a Stage)** ID), press **USE**, then **Connect**. The pill should go
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

   What the Discord panel shows and does (control page): the pill names the channel
   the bot watches and says `moved in Discord` (amber) when it was dragged elsewhere,
   `reconnecting to Discord…`, `the saved channel is not joined` (a saved channel
   that fails its check), `bridge: feed stale` when three heartbeats pass with no
   message (the sidecar is not running, or points at another Streamer.bot port) and
   `bridge stopped` after a clean stop. Lines under it show the sticky file warning
   (a config that could not be used or saved), `speaking detection may have
   stopped` (run `npm update` in `sidecar/`), and a note when the bridge is older
   than the page. **Clear channel** makes the bot leave and watch nothing; **Stop
   bridge** makes the sidecar leave the call and exit (start it again with the
   `.bat`); **Disable bot** stops the bot without deleting the token file.
   The size, colour and tick-box settings stay greyed out until the bridge has
   reported its settings, and only the setting you changed is sent. **Save
   favorite** takes a `discord.com/channels/<server>/<channel>` link pasted into
   the Server ID box, or two ids of 17 to 20 digits; after **LOAD** the button
   reads `Update "<name>"` and edits that favorite (**New instead** leaves that
   mode, and so does **USE**); the name is cleared once the list shows the
   favorite, and a hint says so if it never does. A channel that is already saved
   keeps its first name (the page says so). A setting you change while
   Streamer.bot is unreachable is sent when it is back.

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
out, so use exit-on-close or the `quit` command for that setup: press **Stop bridge** in the
control page's Discord section (it sends `quit`), or run `Discord Voice Command` with
`command` = `quit` from a Streamer.bot action. A bridge from before the release that
added `quit` has no such command: end that one yourself, once. A rejected promise
is logged and the bridge keeps running. The bot token is never written to the log or to
`rpc.error`.

## 6. Live-validation results (2026-07-10, real Streamer.bot 1.0.4)

**Tested versions.** Everything below was run on **Streamer.bot 1.0.4** on 2026-07-10, with the first release (Greenroom
0.1.0). The offline suites cover what changed since (the escaped-string broadcast format, the authentication handshake, the
action pre-flights), but the checklist has not been run on a later release (a partial run of 1.0.104 is listed at
the end of this section). The action names and
the `CPH` calls the actions use were checked by name against **1.0.7**, and the offline suites do not depend on the
Streamer.bot version, but this checklist has **not been run again** on 1.0.7 or on later 1.0.x, nor on OBS 33.0.1
and its embedded browser (the dock checks in particular). Streamer.bot 1.1.x (argument isolation) has not
been validated either. When the checklist is re-run, write the Streamer.bot, OBS and
browser (CEF) versions and the date here and in the README.

What the offline harness **cannot** prove (at that date it was 64 protocol + 23 render checks; the suites are far larger now, and the
counts of each release are in the CHANGELOG) was
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
      inter-push gap ≥ 100 ms under solo speech). That floor is what holds the ceiling: the bridge
      sends at most about 10 `DoAction`s a second by construction. What was **not** exercised live is
      Streamer.bot's action queue, the C# run time and the overlays under a rowdy multi-speaker feed. `verify-render`
      [R4] is a render test of a synthetic 20-user, 10 Hz feed through the mock bridge and the mock Streamer.bot,
      not a throughput test; a live multi-speaker stress test is still open.
- [x] **OBS dock CEF spike** — **PASSED.** The director iframe (WebRTC +
      postMessage) enumerates and pushes from inside a Custom Browser Dock, so
      the dock alone drives auto-follow (see §4).
- [ ] **Multi-director safety** — **not stress-tested live** (one long-lived
      director at a time; see §4). Tested on the mock only: two pages converge on the
      newer state (docs/PROTOCOL.md, Revisions). Still open: the hidden director +
      a human-operated director link in the same room simultaneously, and the
      Manage link opened before and after the dock.
- [~] **1×1 source pattern** — `director-min.html` validated **offline only**
      (`verify-render` [R1]); live, the director ran from `control.html` / the
      dock. Confirm the standalone 1×1 source (in a scene that is always shown) with the dock closed.
- [ ] **Guest audio** — *not yet checked live.* Each live guest moves its own meter in the OBS mixer
      (**Control audio via OBS** ticked on the four slot sources, §3), and a test recording has the guests' audio.
- [~] **`?sbpass` and the OBS log** — *looked at on 2026-11-10, not settled* (tested in Chromium only). The OBS 33.0.1
      logs of sessions in which Streamer.bot was down for a while hold neither a password nor `sbpass`, but they hold
      no failed-connection line from any browser source either, so whether such a line names `sb-socket.js` was not
      seen, and it was not confirmed that `sbpass` was on the source address while Streamer.bot was down. To settle
      it: with `&sbpass=` on the director-min source, start OBS while Streamer.bot is closed, then search the
      current OBS log for the password.

**Partial run, 2026-11-10.** Greenroom **1.0.104**, Streamer.bot **1.0.7**, OBS **33.0.1** (CEF 150), on a spare
Streamer.bot install with a real vdo.ninja room and a real bot; observed by the operator. This is not a re-run of
the checklist above; only these items were run:

- [x] Guest video in the slot sources, with `director-min.html` designated as the always-on director and the dock open.
- [x] Two guests bound a few seconds apart were each on screen within about 5 seconds (the fill-in correction
      does not wait for the 30 s gap).
- [x] **Clear auto-added** and **Un-ignore removed** beside the designated director-min: the live guests were in
      the saved state again after a dock reload.
- [x] A bridge started on a config that was not valid JSON kept a copy, and two saves in a row (a favorite, then
      a setting) both reached the file with no "edited while" warning.
- [x] The 1.0.104 bridge, launched by `Discord Bridge Start`, joined a voice channel.
- [x] **HTTP `DoAction` with Authentication and Enforce on**: `POST /DoAction` naming `VDO Sync`, sent with no
      password, returned 204 and the action ran, while clients without the password were being refused on the
      WebSocket.
- Found on the way: an overlay outside Greenroom that read the nested `vdoninja` object showed no names or
  socials until it read `vdoninjaJson` (README → Updating, step 5).
- Not run: old auto-added rows that hold socials, the 50-entry limit, guest audio, and the rest of the checklist.

## Optional: Streamer.bot Authentication

Do this only after **every** piece is updated (the overlay folder, the control folder,
`sidecar/`, `backup.mjs`): a piece that is not updated cannot answer the password, and
**Enforce** (not Authentication alone) is what refuses it.

Authentication covers the WebSocket only. The HTTP server (§1) has no password setting,
and Streamer.bot documents a `DoAction` request on it that runs an action by its name
(confirmed on Streamer.bot 1.0.7, §6), so a program on this PC, or a page that can send requests to `127.0.0.1:7474`, can
still run Greenroom's actions with Enforce on. Keep both servers on `127.0.0.1` and
load only pages you trust (README → Security posture).

1. In Streamer.bot (Servers/Clients → WebSocket Server) set a password.
2. Add `sbpass=<password>` by hand to the dock URL (the control page), the
   director-min source and the roster source: write `?sbpass=...` when the address
   has no `?` yet (`http://127.0.0.1:7474/greenroom-control/control.html?sbpass=...`)
   and `&sbpass=...` after an existing `?sbport=...`. **Percent-encode the password**:
   a page reads it as URL text, so `+` becomes a space, `&` ends it and `#` cuts it
   off (write `%2B`, `%26`, `%23`, `%25` and `%20` for `+ & # %` and a space, or
   use a password of letters and digits). Then re-copy the guest-slot and nameplate
   addresses from the control page: its Copy and Open buttons carry `sbpass` (already
   encoded) once the control page itself was opened with it. OBS keeps a source's
   address in the scene collection and a dock's in its own settings (the custom
   browser docks list), so the password is in both, and the **Open** buttons (and a control page opened in a
   browser tab) put the address in that browser's history too; that is the accepted cost (and
   the reason the password is never on the bus or in a line Greenroom prints or logs). OBS's
   own log can still show a page's address: the pages are built so that a failed connection
   to Streamer.bot names a script file instead, but an unexpected script error on a page
   would name the address, `sbpass` included, so remove it from an OBS log before you post
   the log anywhere. A page that gets no
   greeting from Streamer.bot within about a second carries on without a password.
3. Put `"sbPassword": "<password>"` into `sidecar/discord-tokens.json` (next to
   `botToken`; it is the only place the bridge reads it from, since `Discord Bridge Start`
   cannot pass an environment variable to node) and restart the bridge.
4. For `backup.mjs`, set `GREENROOM_SB_PASSWORD` (or rely on the same field).
5. Turn on Authentication, then Enforce. Check that the control page's SB pill says
   connected, the roster shows, and the bridge's console says "Streamer.bot accepted
   the password". The bridge acts only after a genuine Streamer.bot Hello; a peer that
   says it is the Greenroom mock is refused ("GREENROOM_ALLOW_MOCK=1" is for the
   tests), and so is silence.

If a page says "SB password refused", the `?sbpass` is wrong; if it says "SB auth
enforced", it has none.

## Troubleshooting

- **Overlay stays blank** → 90% one of: nothing saved yet (a fresh install: do the **First run** in §4;
  the pill says `director: idle` until a room is set and the box ticked), action name typo (must match
  exactly), C# not compiled (open the action, Compile), or SB WS Authentication with Enforce ON and
  no `?sbpass=` on the source (the console says "SB auth enforced").
- **A dock says "failed to load"**, or a source stays blank after OBS started before Streamer.bot → Streamer.bot's HTTP
  server was not up when OBS loaded it: start Streamer.bot first, then click **Retry** on the dock, or use
  **Refresh cache of current page** on the source.
- **"director: not responding"** (after about 8 seconds), then "…· check the room, the password and that vdo.ninja is
  reachable" (after about 15), then "director: not responding, retrying" → the hidden director is getting no reply
  from vdo.ninja: check the room name, the password, and that vdo.ninja is reachable from this PC. Auto-follow is
  paused until the director answers. (`director-min.html` says "still connecting… check the room, the password and that
  vdo.ninja is reachable".)
- **A slot is empty but its nameplate shows** → refresh that guest-slot browser source (right-click →
  **Refresh cache of current page**).
- **The slots stop following guests while the director-min source is hidden** → OBS may suspend a source that is not
  shown. Keep the director-min source in a scene that is always shown (§4).
- **I hear guests but viewers don't** → the guest-slot source must have **Control audio via OBS** ticked
  (it is off by default), so the guest has its own mixer track and meter. If you hear the guest only because
  OBS monitors it, check that **Audio Monitoring** is **Monitor and Output** (**Monitor Only** keeps the guest
  off the stream) on a device that Desktop Audio does not capture, that the guest's meter moves, and that
  the source is not muted in the mixer. A test recording settles it.
- **Guest slot black but the URL looks right** → the page was loaded as a
  `file://` Local-file source; use the `http://127.0.0.1:7474/...` URL field.
- **SB can't restart its WS/HTTP server after a crash** → an orphaned helper
  child is holding the sockets; kill stray `node.exe` (see §2 UseShellExecute).
- **`Discord Bridge Start` logs a warning and no bridge appears** → the log line says which: `BUNDLE is still the placeholder` or `BUNDLE does not exist` (edit the `BUNDLE` const and compile again), `discord-bridge.mjs is not in …` (BUNDLE is not the sidecar folder), `node_modules is missing` (run `npm install` in `sidecar/` or run `start-discord-bridge.bat` once), `node was not found` (restart Streamer.bot after installing Node, or use the .bat), `bridge exited with code N` (run `start-discord-bridge.bat` to see the error). An older copy of the action logs `launched` in the first three cases and starts nothing: re-paste it.
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
  (`npm run backup` / `npm run backup:restore -- backups/<file>`). See the README's
  **Backups** section. Snapshots include the room password — keep them private.
