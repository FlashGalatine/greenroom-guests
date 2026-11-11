# Greenroom — wire protocol

Everything rides Streamer.bot's WebSocket Server (default `ws://127.0.0.1:8080/`;
Authentication can be on, see the handshake below). Producers call SB **actions** via `DoAction`; the actions
cache state in SB **global variables** and re-broadcast wrapped payloads with
`CPH.WebsocketBroadcastJson`; consumers **Subscribe** to `General.Custom` events.
Streamer.bot is the entire bus — there is no other server.

## Requests

```jsonc
// Subscribe — lowercase 'general' is this project's convention for the event-source key, though delivered
// events carry a capitalized source 'General'. Streamer.bot 1.0.7 matches the key case-insensitively (any
// casing is accepted); events are delivered only to clients that subscribed, so a client that never
// subscribed receives nothing (a common blank-overlay cause). The mock lowercases keys (since Sprint 4a).
{ "request": "Subscribe", "id": "1", "events": { "general": ["Custom"] } }
// Streamer.bot's documented reply is flat: { "status": "ok", "id": "1", "events": {…} }
// (no "result" wrapper). Clients treat a `status` other than "ok" as a refusal: no
// VDO Sync, a visible status (control pill, director-min status, the overlay's offline
// class and a console warning). A reply with no `status` field is not read as a refusal.
// On connect Streamer.bot also sends { "request": "Hello", "info": {…}, "authentication": { "salt": …, "challenge": … } }
// (the authentication object only when Authentication is on). Every Greenroom client (the overlay shim, control.html,
// director-min.html, the Discord bridge and backup.mjs) waits about a second for the Hello. If it carries an authentication
// block and the client has a password, the client sends
//   { "request": "Authenticate", "id": …, "authentication": base64(sha256(base64(sha256(password + salt)) + challenge)) }
// and subscribes (and syncs) only after the ack says status "ok"; it does this again on every reconnect, and a refused password is a
// visible failure ("SB password refused …"), not a silent retry. With no authentication block, or with no password to give, it
// carries on as before (with Enforce off Streamer.bot serves every request anyway). If requests are then refused, or Streamer.bot
// hangs up before accepting one, the clients name the likely cause: "SB auth enforced — turn Enforce off, or add ?sbpass=…".
// Where the password comes from: pages read `?sbpass=<password>` from their own address, as URL-encoded text (an OBS source or dock URL: OBS
// keeps a source's in the scene collection and a dock's in its own settings; the control page's Copy and Open buttons carry it into the guest-slot and nameplate addresses, and it goes into
// no other address, bus message or console line a page prints); the bridge reads `sbPassword` from `sidecar/discord-tokens.json` (the bridge's only
// password store; `persistTokens` keeps every field of that file); `backup.mjs` reads `GREENROOM_SB_PASSWORD`, else the same field.
// The OBS log needs care: obs-browser writes a page's error-level console messages there with their source, and an error raised from a
// page's inline script has the page's address, `?sbpass` included, as its source. So every page opens its socket in a script file
// (`control/sb-socket.js`, `overlay/panel-client-sb.js`), and Chromium's own "WebSocket connection to … failed" errors name that file
// (tested in Chromium, not yet in a live OBS). Any other error raised from a page's inline script (an uncaught exception, say) would
// still name the address: remove `sbpass` from an OBS log before you share it.
// The Hello's `info.source` is "mock" for the development mock: the bridge refuses a peer that says so (unless GREENROOM_ALLOW_MOCK=1,
// for the tests) and acts on nothing before it has seen a genuine Hello; the control page shows a "MOCK Streamer.bot" banner; `backup.mjs`
// names the peer it reached.

// DoAction — an ack {id, status:'ok'} means only that the action STARTED, not that it
// succeeded. An invalid argument or a runtime exception inside a running state action is
// reported by an error broadcast (see "Error broadcasts" below; Discord Bridge Start only logs). An action whose C#
// failed to COMPILE is silent: it acks ok and broadcasts nothing (the symptom is a
// blank or stale overlay), so always click Compile and confirm it succeeds.
{ "request": "DoAction", "id": "2", "action": { "name": "VDO Push" }, "args": { "payload": "{...}" } }
```

## Event envelope (what subscribed clients receive)

```jsonc
{
  "timeStamp": "…",
  "event": { "source": "General", "type": "Custom" },
  "data": { "type": "vdoninja:update", "vdoninjaJson": "{\"enabled\":true,\"room\":\"myroom\", …}" }
}
```

The state travels as an **escaped string field** — `vdoninjaJson` for `vdoninja:update`,
`discordVoiceJson` for `discord:voice:update` — holding the producer's JSON text
byte for byte. Streamer.bot parses everything it broadcasts with Newtonsoft (default
date handling) before it sends it, so a state nested as an object would have every
date-shaped string in it re-formatted (a guest label like `2024-02-03T04:05:06.000Z`
comes back as `…06Z`, which no slot matches), and one outside the DateTime range would
make the whole broadcast throw. A string field is not parsed, so the text arrives
unchanged and the pages `JSON.parse` it themselves. The pages still also read the old
nested fields (`vdoninja`, `discordVoice`), which an actions paste from before the
string fields sends.

`WebsocketBroadcastJson` nests `data` as an **object** (plain `WebsocketBroadcast`
would put a JSON **string** there — the transport shim tolerates both). Overlays
re-emit every `data` with a `.type` as a window `svc:message` CustomEvent.

## Actions and globals

| Action | Caller | args | Behavior |
|---|---|---|---|
| `VDO Push` | control pages | `payload` | broadcast `{"type":"vdoninja:update","vdoninjaJson":"<payload, escaped>"}`, **then** `SetGlobalVar("vdo.state", payload, **true**)` |
| `Discord Voice Push` | bridge sidecar | `payload` | broadcast `{"type":"discord:voice:update","discordVoiceJson":"<payload, escaped>"}`, **then** `SetGlobalVar("discord.state", payload, **false**)` |
| `VDO Sync` | every page on connect | `reason` | read both globals (same persistence flags) → replay each non-empty one the same way, each replay in its own `try` (no order is promised). An empty `vdo.state` broadcasts `{"type":"vdo:sync:empty"}`; an empty `discord.state` is skipped |
| `Discord Voice Command` | control page | `command`, `value` | broadcast `{"type":"discord:voice:command","command":…,"value":…}` |
| `Discord Bridge Start` *(optional)* | SB startup trigger | — | `Process.Start` the sidecar hidden |

The C# **validates JSON but never re-serializes it**. Push payloads are pre-serialized
by the producers and only escaped into the string field. Before anything is
broadcast or cached, `VDO Push` and `Discord Voice Push` check the payload with a
strict, dependency-free RFC 8259 validator: it must be **one JSON object** with
nothing after it, no object may repeat a key (compared after decoding escapes), and
containers nest at most 32 deep. Anything else is refused with an error broadcast
(`payload rejected, NOT cached: <reason>`), so damaged text, such as a half-built
`{…},"type":"x"}`, never reaches the cache. `VDO Sync` applies the same check to each
cached blob before replaying it; an invalid one is reported (`cached state is not
valid JSON - …`, with the remedy that fits: Import a backup or re-save for `vdo.state`,
the bridge's next push for `discord.state`), not replayed, and **kept** (the action
never unsets a global). The only other C#-built JSON is the tiny command broadcast
and the error shapes. The broadcast comes **before** the cache write, so a broadcast
that fails (an exception in `WebsocketBroadcastJson`) never leaves a saved state
behind that no client has seen.

`{"type":"vdo:sync:empty"}` tells a page that `VDO Sync` ran and nothing is saved yet
(a fresh install), so it can stop waiting for a reply instead of guessing; the control
pages read it as "synced, with no config adopted".

**Persistence flags are semantic.** `vdo.state` is persisted (`true`) — the dock
config must survive SB restarts; a replayed config keeps the streamIDs it was saved
with until a director page re-resolves them (every 2.5 s while one is running), which
beats a blank slot.
`discord.state` is non-persisted (`false`) — stale speaking/presence state must
NOT replay after an SB restart; the sidecar re-pushes on reconnect.

## `vdoninja` payload (assembled only by the control pages)

```jsonc
{
  "enabled": true,
  "room": "myroom",
  "password": "…",                 // plaintext by necessity: view URLs embed it
  "viewFlags": "&solo&hidescreenshare&rounded=0&tallyoff&fadein&codec=h264&cleanish",
  "slots": [                        // always 4
    { "slot": 1, "label": "ALPHA", "streamID": "abc123", "mirror": false,
      "mode": "webcam", "discordUserId": "", "pushID": "" },   // pushID optional
    …
  ],
  "invite": { "passwordMode": "hash", "askName": true, "label": "", "push": "",
    "videoBitrate": "", "quality": "", "fps": "", "audioBitrate": "",
    "noVideo": false, "noAudio": false, "capture": "", "broadcast": false,
    "meshcast": false, "autostart": false, "extraFlags": "" },
  "directory": [                    // guest directory → nameplates (optional)
    { "vdoLabel": "John-T", "discordUserId": "",
      "displayName": "John the Tyrant", "auto": false,
      "socials": [ { "platform": "twitch", "handle": "SampleStreamer" } ] }
  ],
  "directoryAutoAdd": true,         // auto-populate new guests (absent → true)
  "directoryIgnored": [ "vdo:lurker", "discord:200000000000000009" ],
  "alwaysOnDirector": "director-min", // optional: director-min.html is the designated director
  "schemaVersion": 2,
  "rev": 1794249243633,             // per push, see "Revisions" below
  "writer": "w3f9c0a1d7b42e615"     // random per page load
}
```

- **Revisions: `schemaVersion`, `rev`, `writer` (`control/vdo-rev.js`).** Every
  push a control page really sends carries `schemaVersion: 2`, a `rev` and the
  page's `writer` id. `rev` is a whole number chosen when the push is sent:
  the larger of the clock (`Date.now()`), one more than the highest rev the page
  has received (its own echoes included) and one more than its own last rev; a
  push that could not be sent takes none. `writer` is random per page load and
  only breaks ties. A page that reads a `schemaVersion` higher than its own shows
  "reload this page" and pushes nothing (pages from before this scheme do that
  on `schemaVersion: 2`). Streamer.bot stores and replays the fields as part of
  the text: the actions neither read nor change them. **What a page does with an
  incoming `vdo.state`:** its **own** push (or an older one of its own) coming
  back is an echo and is never adopted, matched by `writer` and `rev`, never by
  the text, because Streamer.bot may rewrite the text (a lone surrogate comes back
  as U+FFFD); a `rev` **below the highest it has received** is dropped (a
  delayed `VDO Sync` replay of an older state, say); **equal** revs are broken by
  the writer id (the larger wins) so every page picks the same winner; so is a
  `rev` below a push of the page's own that is still on its way to Streamer.bot
  (that push runs after the frame); a higher `rev` is adopted; a payload with **no `rev`** (a page from before this scheme,
  a hand-made restore) is a legacy write: adopted, never dropped as rev 0, and
  the page's next push stamps a rev. Every comparison (is this a change worth a
  push, is this my echo) is made over the state **without** these three fields
  and with the keys sorted. This gives convergence, not protection of an edit: of
  two pushes sent in the same moment the later one Streamer.bot runs wins in the
  store even if its rev is lower, so an edit made just as a guest joins or a
  voice user appears may need redoing.
- **An edit made while Streamer.bot is unreachable** is kept. The dock says "SB
  offline, changes will be sent on reconnect"; when the connection is back and the
  replay of the saved state arrives (whatever it is, the dock's own last push
  included), the dock pushes its own state with a fresh rev instead of adopting
  the replay, unless the replay was saved by a newer Greenroom (`schemaVersion`
  above its own) or shows a write that Streamer.bot ran after the push that may
  have been lost. An edit that could not be sent before the first sync is dropped
  with the form when the saved config arrives. `director-min.html` has no flush of
  its own: having had something it could not send, it adopts the replay, takes
  the stream IDs the replay holds as its baseline, and re-pushes a difference in
  them once it has held for two polls (an entry it auto-added meanwhile is added
  again). A push whose echo does not come back within about five seconds is
  reported ("not confirmed by Streamer.bot: is VDO Push compiled?").
- **`alwaysOnDirector` (optional, `"director-min"` or absent).** The dock's
  "director-min.html is my always-on director" box. Ticked, director-min is the
  **designated director**: the dock sends only the operator's own edits (no
  follow pushes, no auto-add pushes), and those carry the stream IDs Streamer.bot
  holds, not the dock's own resolution of them; it shows "director-min is
  designated but not correcting" when its own director has seen different stream
  IDs than the saved ones for about 30 s with no correction arriving. Not ticked,
  the dock is the designated director. Only the designated director corrects
  stream IDs after adopting another writer's state: it takes its own re-assembly
  with the stream IDs the adopted state holds as its baseline, and when its roster
  differs from that in `slots[].streamID` alone for two polls in a row it sends
  ONE correction (at most one per 30 s per page, so two pages whose directors
  disagree cannot flip the slots every few seconds). A correction that only fills
  in stream IDs that were blank waits the two polls but not the 30 s: a guest just
  bound to a slot in the dock (which sends that slot with no stream ID beside a
  designated director-min) and the IDs a restore blanked. Going back and forth
  between two views always replaces or blanks an ID, so this is no flip. A
  correction that fills one slot while it also replaces or blanks another slot's
  stream ID still waits for the gap, so a bind made just as another guest drops
  or rejoins can take up to 30 s. A page
  that is not designated takes its own re-assembly as the baseline, so adopting alone never
  makes it push; the exceptions are a write by `backup.mjs restore` (writer
  `"backup"`: every director that follows the guests puts the live IDs back) and a `director-min` that
  had something it could not send. The fields travel inside `vdo.state`, so no
  action changes and nothing is re-pasted. Two docks both unticked are both
  designated: run one.

- Slots bind guests by **label** (stable across rejoins); `streamID` is the
  volatile live resolution the director loop refreshes every 2.5 s.
- **`slots[].pushID` (optional pin).** When present and non-empty, the slot follows
  only that stream (a guest's push ID is their `streamID` in the director's
  guest list) and ignores a different guest who picked the same label; if the
  pinned stream is not in the room the slot is empty. Absent or `""` means "follow
  the label". The control pages write it (the slot row's **pin** / **unpin**
  button); the overlay ignores it (it only reads `streamID`). A pin belongs to
  the guest it was made for, so changing the slot's label clears it.
- **`invite`** holds only options vdo.ninja applies on the guest's side: `askName`
  (default on: the guest link ends in a bare `&label`, so each guest is asked
  for a display name; absent reads as on), `fps` → `&maxframerate`, the bitrates
  → `&outboundvideobitrate` / `&outboundaudiobitrate`, `noVideo` / `noAudio` →
  `&videodevice=0` / `&audiodevice=0`. Older fields (width, height, codec,
  stereo, requireApproval, roomCap) are carried through but no longer used.
- **`viewFlags`** is the flag string the overlay puts on each slot's solo view address (default
  `&solo&hidescreenshare&rounded=0&tallyoff&fadein&codec=h264&cleanish`). The control pages and the overlay
  (`vdo-url.js`, an identical copy in each folder) read it the same way: the control page saves it with a missing
  leading `&` added; flags that load script or style, send events away, or name the room, the stream or the password
  (`js`, `css`, `invite`, `api`, `room`, `password`, `hash`, `view`, …) are dropped, and everything after a `#` is
  cut. The overlay, when it builds a slot's view address, also adds `&solo` unless `solo` or `scene` is already there
  (a view without either would show the whole room).
- `label`, `enabled`, and `invite` exist so the persisted `vdo.state` doubles as
  the config store — the control page rehydrates from a `VDO Sync` replay and
  holds no authoritative state of its own. The guest overlay reads only
  `room`/`password`/`viewFlags`/`slots[].{label,streamID,mirror,mode,discordUserId}`
  plus `directory`, and ignores the rest.
- **`directory` (guest directory → nameplates).** Each entry maps a guest to a
  preferred on-stream `displayName` + optional social handles. Match keys —
  either or both: `vdoLabel` (compared against `slots[].label`, stored as typed)
  and `discordUserId` (exact snowflake string, digits-only). **Labels are
  compared through one key** that both lookups (the control pages and the
  overlays) build the same way: vdo.ninja's HTML escaping is decoded (it escapes
  twice, `Tom &amp;amp; Jerry` is `Tom & Jerry`), `_` reads as a space, text is
  NFC-normalised, invisible characters (zero-width joiners and spaces, the soft
  hyphen) are dropped and whitespace is collapsed. Two labels are **exactly
  equal** when that key is equal and **equal ignoring case** when its lower-case
  form is. The key is used for comparing only: the label stays as typed, and a
  slot keeps the raw label it was picked from. When several entries match a
  label the lookup prefers the exact-case one, then a curated entry over an
  auto one, then the first in the array; labels that differ only in case can have
  separate entries. A Discord user id is matched on its digits, and a curated
  entry beats an auto one. Entries missing `displayName` or missing both keys are
  dropped by the assemblers' sanitizers. `socials[].platform` is lowercase
  (`twitch` `discord` `twitter` `bluesky` `youtube` `instagram` `tiktok`
  `website`; the short names `x` `yt` `ig` `bsky` `tt` are accepted; unknown → globe
  icon); `handle` is verbatim. In the dock's textarea a social is one line, the
  platform then the handle, split at the first whitespace (space, tab or NBSP). Consumers: the guest
  overlay's built-in lower-third, the standalone `nameplate.html?slot=N`
  source, and the roster overlay's chip-name override. A guest with **no
  matching entry gets no nameplate** (no raw-label fallback); a webcam slot's
  plate shows only while its label is resolved to a live `streamID`, a
  discord-mode slot's whenever a user is bound (mirroring the PFP placeholder).
  `director-min.html` carries `directory` (and the two fields below) through its
  re-assembled pushes untouched — verify.mjs tripwires this, since a page that
  dropped them would silently erase the directory on the next auto-follow push.
- **`directory[].auto`, `directoryAutoAdd`, `directoryIgnored` (auto-populate).**
  Both control pages run the same rule (`control/directory-core.js`) on every
  director poll and every `discord:voice:update`: a live VDO label or a
  voice-channel user with no directory entry gets one appended, named after them
  (the label / the Discord username) and flagged `auto: true` — so a guest who
  joins mid-stream has a nameplate without an operator present. `auto` means "this
  name is a placeholder"; the control page badges those rows and clears the flag
  the moment the operator edits any field of the entry. An `auto` entry that holds
  socials is not a placeholder (`GRDir.isPlaceholder`): auto-add never writes
  socials, so the operator put them there (releases before 1.0.49 kept the flag
  through a socials edit). Such an entry has no badge, is kept by
  **Clear auto-added**, and is never dropped at the cap or counted toward it; the
  linking below still reads its `auto` flag. A Discord user whose username equals an
  existing **auto** entry's `displayName` or `vdoLabel` fills that entry's empty
  `discordUserId` instead of creating a twin, and a guest who joined the voice
  channel first takes the label of their auto entry when they join the VDO room
  (merge in both directions, auto entries only). A **curated** entry is never
  linked by name: Discord names are self-chosen, so anyone can be called "Bob".
  The dock offers the link on the row ("link <name> (<id>)?"): accepting sets
  the `discordUserId`, rejecting adds `discord:<id>` to `directoryIgnored`; each
  button acts only on the Discord user it was drawn for, and when two or more
  Discord users have the name the row offers nothing and says so (set the ID by
  hand). Until the operator accepts, the guest's roster chip shows the raw
  Discord name and a discord-mode slot bound to them shows no plate.
  Placeholders are capped at 50: at the cap the first placeholder that is not in
  the room (by label, Discord ID or Discord name) and not in a slot is dropped to
  make room. Curated entries never are, and the dropped guest is added again if
  they come back. The dock names on its status line the guests its own pass
  removes (an Import's pass included); a removal made by `director-min.html` is
  not reported, and beside a designated director-min its poll often sees a new
  guest before the dock does. The dock says "auto-add limit reached" when
  someone could not be added. A Discord user with no name
  yet is added when the name arrives (never stored under the snowflake), and a
  label that draws nothing (zero-width characters, U+2800) is not added. A page appends a given label or voice
  user at most once per page session (so a label that Streamer.bot rewrites on the
  way back cannot make the pages push at each other); **Un-ignore removed**,
  **Clear auto-added** and an Import reset that in the dock, which adds whoever is
  live right away and sends them with the action's own push. `director-min.html`
  resets it for the guests an adopted state lacks when that state holds fewer
  auto entries or a shorter ignore list than its own book (what Clear auto-added,
  Un-ignore removed, `×`, an edit of an auto entry and an Import of a smaller book
  send; auto-add never lowers either, and a rewritten label changes neither), so
  with director-min designated a guest who comes back later is added again too.
  Adopting another page's state runs no auto-add of its own (the next poll or
  voice update does).
  `directoryAutoAdd: false` disables the whole pass (absent → **on**, so
  pre-upgrade `vdo.state` blobs opt in). `directoryIgnored` is the
  anti-resurrection list — sorted, deduped keys `vdo:<label key>` (the comparison
  key above, lower-cased, so `vdo:guest_one` and `vdo:guest one` are the same) /
  `discord:<snowflake>` that auto-add always skips; the control page adds a key
  when the operator removes an entry or clears one of its match keys, and its
  "Un-ignore removed" button empties the list. The pass is a **fixpoint** and
  **order-independent** (candidates are sorted before appending) — two director
  pages seeing the same room must produce byte-identical payloads, or their pushes
  would ping-pong forever.

## `discordVoice` payload (assembled only by the sidecar)

```jsonc
{
  "channelId": "…" | null,
  "connected": true,               // bot logged in to the gateway
  "hostInChannel": true,           // bot joined + receiving in the channel
  "users": {
    "<userId>": { "speaking": false, "username": "Ashe",
                  "avatarUrl": "https://cdn.discordapp.com/…", "mute": false, "deaf": false }
  },
  "settings": { "streamerUserId": "", "avatarPx": 56, "streamerPx": 72,
                "accent": "cyan", "scanlines": true, "neonBlink": true, "hideWhenAbsent": true,
                "exitOnSbClose": false },
  "rpc": { "enabled": true, "hasToken": true, "error": "",
           "reconnecting": false,   // the gateway is resuming or re-identifying (additive)
           "speakingStale": false,  // speaking detection looks dead (additive)
           "configWarning": "" },   // a problem with discord-voice-config.json / discord-tokens.json (additive, sticky)
  "favorites": [ { "id": "…", "name": "Commentary", "serverId": "…", "channelId": "…" } ],
  "current": { "serverId": "…", "channelId": "…" } | null,
  "currentRefused": false,        // the saved `current` failed its check (at login or a rejoin) for a configuration reason and is not joined (additive)
  "hb": 5000,                     // the bridge pushes at least every hb ms while it runs; 0 once it is stopping
  "stopped": false,               // true on the last frame a bridge sends before it exits
  "bridgeVersion": "1.0.63"       // the sidecar build that sent it
}
```

- `users[].username` is the person's **display name**: their server nickname, else their global name, else their
  account username; empty until the member is resolved.
- `users` is the original toolkit feed, unchanged — the guest overlay's discord
  mode and the roster overlay read only it (+ `settings`). It lists the members of
  the working channel and the **guests** invited into the call (Discord keeps no
  member for them, so the bridge names them from the voice-state frame, their
  nickname or Discord name, and keeps their `mute`/`deaf` current); bots are not
  listed.
- `settings`/`rpc`/`favorites`/`current` are superset fields for the control
  page (status pill, favorites list) and the roster overlay's styling. The
  **token itself is never in any payload** — only `hasToken`.
- `settings.exitOnSbClose` (default `false`) is a **sidecar lifecycle** flag, not
  a render setting (overlays ignore it): when `true`, the bridge gracefully leaves
  the voice call and exits once Streamer.bot's WebSocket stays down past a grace
  window (`GREENROOM_SB_EXIT_GRACE_MS`, default 8000 ms) — so the bot doesn't
  linger in the channel after you close SB. The env var
  `GREENROOM_EXIT_ON_SB_CLOSE=1/0` overrides the setting when set, and the argument
  `--exit-on-sb-close=1/0` overrides both. The grace window is never shorter than 1 s.
- `rpc.configWarning` is a sticky, fixed-words message about the files (never an error's own text: this goes to every bus client), and nothing else clears it: "The saved config could not be used (…): a copy was kept as discord-voice-config.json.corrupt-<time> and the bridge runs on its defaults" (a file that is not JSON, is `null`, is an array, or is locked; the copy is made before anything is written, and when even the copy fails the file is left alone and nothing is saved that session), or "Could not save discord-voice-config.json (EPERM): the change is not kept after a restart" (the changes are used all the same; the warning goes when a later write works). The bridge reads UTF-8 files (a BOM is stripped) and UTF-16 files that start with a BOM (UTF-16 without one is read as UTF-8, so it counts as not JSON). It writes through a temp file beside the real file (a symlink is followed) and a rename, so a crash or a lock does not leave half a file; if the rename keeps failing (the file is locked) the config is written in place, with the old bytes put back if that fails, and the token file is simply not updated (only `enabled` would change). Writes happen one at a time per file in the order commands arrived, and the exit waits up to 2 s for a write in flight. A rename gives the file the permissions of its folder (on Windows the folder's inherited ACL): a token file whose permissions were hardened by hand keeps them only where the system has file modes, so harden the folder instead. A config that was skipped, copied aside and left to the defaults is not overwritten by the bridge if somebody edits it meanwhile: the warning then asks for a restart. Favorites in the saved config that are skipped (a server or channel id that is not 17 to 20 digits) are listed in a warning and the file is kept as a `.corrupt-<time>` copy. Messages for the token file: "discord-tokens.json exists but is not valid JSON …", "discord-tokens.json could not be read (it is locked or access is denied) …", "Could not save discord-tokens.json (EPERM): the change is not kept after a restart." (also in `rpc.error` until the next login); a token file that goes missing is forgotten at the next Connect or restart, not while the bot runs. Hand-edited favorites need 17 to 20 digit server and channel ids as text (a bare number keeps its digits); the saved settings are held to the same rules as `set-settings`.
- Streamer.bot re-serialises broadcast text, and a lone surrogate in it (half of an emoji) comes back as U+FFFD, so a client must not recognise its own echo by byte equality (favorite names are cut by code point so the bridge never creates one).
- `rpc.reconnecting` is true while Discord's gateway is resuming or re-identifying
  (`connected` stays true: the roster overlay hides on `!connected`, and a resume
  replays what was missed). `rpc.speakingStale` is true when the bot is in the
  channel, someone present is unmuted and undeafened, and no speaking start has
  arrived for several minutes (or a glow has stayed on for minutes): speaking
  detection uses Discord's voice receive, which Discord does not document, and may
  need `npm update` in `sidecar/` after a Discord change. It is a separate flag, not
  an `rpc.error`. Both are additive.
- **Voice recovery.** A voice connection that drops is rejoined by the bridge with a
  backoff of 2, 5, 15 and 30 s, then every 30 s; after about 10 s outside Ready the
  payload says `hostInChannel: false` with "Voice connection lost, reconnecting…",
  and after about 30 s the connection is dropped (no channel, empty roster) and
  rebuilt. A removal by Discord (voice close code 4014, 4021 or 4022) **parks** the
  bridge ("Removed from voice (…), press USE to rejoin"): it waits for USE or
  Connect. The exception is a 4014 within 15 s of a gateway reconnect, which is a
  dropped session and is rejoined. Dragging the bot to another channel in Discord
  makes the roster follow it while the connection lasts (`channelId` changes, `current`
  does not; a Stage is not read, its roster is empty); USE brings it back, and so
  does any rebuild of the connection (a loss, a gateway resume that finds it
  waiting): the bridge always goes back to `current`. A login that fails is retried with a capped backoff (5 s, doubling, up to
  5 minutes) unless the token is rejected.
- `hb`, `stopped` and `bridgeVersion` are additive (a consumer that does not know
  them ignores them). The bridge pushes at least every `hb` ms (5000) even when
  nothing changed, so a consumer can tell a live bridge from one that died with
  its last state still in `discord.state`. A frame with `stopped: true` (and
  `hb: 0`, no users, offline) is the bridge's one last push before it exits: a
  signal, the `quit` command, Streamer.bot closing with exit-on-close on, or a
  crash (then `rpc.error` says "Bridge crashed: …"). The roster and the guest
  slot call the feed stale when three `hb` periods pass with no message (on the
  page's own monotonic clock): the roster then counts as nobody there and the
  glow goes out. They take `hb` only as a number (raised to 1000 ms if smaller,
  lowered to 60000 if larger; a payload without one is never stale), and an
  optional `age` (ms, a number on the message beside `discordVoice`: how old the
  push already was, held between 0 and three periods). Known limit: VDO Sync
  replays the cached last push as a plain update, which a page cannot tell from
  a live one, so a dead bridge's last state reappears for up to 15 s whenever a
  page connects, until a producer stamps `age` on the replay. The control
  page's Discord pill follows the same rules: "bridge: feed stale" after three
  missed periods, "bridge stopped" on a `stopped` frame, and a note when
  `bridgeVersion` is older than the sidecar shipped with the page or absent.
  It also shows `rpc.reconnecting`, a bot moved to another channel (`channelId`
  differs from `current.channelId`), `currentRefused`, `rpc.speakingStale` and
  `rpc.configWarning`, and sends only the settings keys the operator changed.
- Pushed leading-edge with a 100 ms trailing coalesce: worst case ~10
  DoActions/s in a rowdy channel.

## Commands (`discord:voice:command`)

`value` is **always a plain string** on the wire; structured commands carry JSON
the control page pre-serialized and the sidecar `JSON.parse`s. Unknown commands
are logged and ignored (the mock bridge adds a test-only `mock-burst on|off`). A
frame whose `command` is not a string, or whose `value` is neither a string nor
absent, is dropped (only the types are logged): anyone on the bus can send any JSON.

| command | value | effect |
|---|---|---|
| `connect` | — | (re)start the bot with the FILE token; visible error if none |
| `leave` | — | leave voice gracefully, stay logged in, clear the rejoin intent and cancel a pending rejoin (the intent is kept in memory only: a bridge restart wants voice again). With no connection to close, a bot that Discord still shows in the call is told to leave (a gateway voice-state update with no channel) |
| `reset-auth` | — | disable the bot (`enabled` false) and stop it. The token file is **not** blanked: a forged bus command must not be able to erase the token. Deleting `discord-tokens.json` by hand forgets it at the next **Connect** (or restart): Connect re-reads the file every time |
| `set-current` | `{"serverId","channelId"}` | watch this channel (joins/moves if live; empty ids leave). While the bot is online the target is checked first: a server the bot is in, a channel that exists, a **regular voice channel (not a Stage)** the bot can join (View Channel + Connect, room under the user limit; guests count). A target that fails is refused with a message in `rpc.error` (it clears itself after about a minute) and **changes nothing**: the current channel, the saved file, the voice connection and the roster stay. A pick that cannot be saved to the config file is used all the same (the bot moves), and the sticky `rpc.configWarning` says it is not kept after a restart. When USEs overlap, the newest decides. Offline, the pick is saved (the reason the bot is offline stays in `rpc.error`) and the same check runs when the bot logs in and at every rejoin: a saved channel that fails it for a configuration reason (no such server or channel, a Stage, no View Channel + Connect) is not joined, stays `current`, and the payload says `currentRefused: true` until the pick changes; a full channel or a network problem is retried instead |
| `favorite-add` | `{"name","serverId","channelId"}` | add favorite (a name is cut to 80 characters by code point; a favorite for a server and channel that already has one is not added again) |
| `favorite-update` | `{"id", …fields}` | edit favorite; a change that would leave it without a server or a channel is refused (`rpc.error`) and the favorite stays as it was |
| `favorite-remove` | `{"id"}` | remove favorite; removing the one that is the current channel clears the current channel and leaves voice (unless another favorite names the same channel) |
| `set-settings` | partial settings object | merge by the rules in `sidecar/settings.mjs` + persist: only the known keys are taken (`streamerUserId` as digits, `avatarPx` 24..128, `streamerPx` 32..160, `accent` one of cyan/magenta/neon-green, the four booleans only for a real true/false); a value of the wrong type (null, an empty string, a number for an enum) changes nothing. The old `height` setting is gone |
| `quit` | — | leave voice, send the clearing state and exit (code 0): the clean stop |

## Error broadcasts

Invalid arguments and runtime exceptions are visible, not silent:
`{"type":"vdo:error","message":…}` from `VDO Push`/`VDO Sync`,
`{"type":"discord:voice:error","message":…}` from the Discord actions
(`VDO Sync` reports a failed Discord replay as `discord:voice:error`). The control
page shows them on a dismissible line under its header (the whole message in the
line's title), not in the SB pill, which stays on the state of the socket. A
`vdo:error` goes away with the next good `vdoninja:update` and a
`discord:voice:error` with the next `discord:voice:update` (the bridge's heartbeat
does not clear a VDO error), and any of them after about 20 seconds. An error broadcast can only come from an action
that compiled: one that failed to compile is silent (see `DoAction` above), and
`Discord Bridge Start` broadcasts nothing at all, it only logs, so look in Streamer.bot's
log if the bridge does not come up.

## Security posture

Localhost-only. Streamer.bot's WebSocket Authentication can be off (the default) or on; with it on and **Enforce** on, an unauthenticated client is refused. Greenroom's clients authenticate (see the handshake above).
The room password travels in `vdoninja:update` by necessity (overlays embed it in
view URLs) — same trust model as the toolkit it replaces. The Discord bot token
is **file-only** (`sidecar/discord-tokens.json`, gitignored) and has no bus
command that can read or write it (`reset-auth` only turns `enabled` off; deleting the
file by hand forgets the token at the next Connect or restart). Bus commands can still stop and move the bot, so
SB's WebSocket and HTTP servers must stay localhost-only, whether Authentication is on or off.
With Authentication off, any page running in OBS (a browser source or dock) or in
a browser on the same PC can read the room password and drive Greenroom through
the WebSocket, so only load pages you trust. **Authentication plus Enforce**
(recommended once every Greenroom piece is updated) keeps everything that is not
given the password off the WebSocket. It does not keep out your own OBS sources
and docks, an unprompted route in, because they carry the password in their
address (`?sbpass=`; OBS stores it in the scene collection or its own settings).
It covers the WebSocket only. Streamer.bot's HTTP server, which serves Greenroom's
pages, has no password setting, and Streamer.bot documents a `DoAction` request on
it (`POST /DoAction` with an action's id or name and its args) that runs that
action. A run on Streamer.bot 1.0.7 on 2026-11-10 confirmed it: with Enforce on,
the request ran `VDO Sync` without the password. So a program on this PC, or a page that can send requests to that server,
can still run Greenroom's actions with Enforce on: `VDO Push` changes what the
guest slots and overlays show, and `Discord Voice Command` can make the bot leave
the call or quit. Keep both servers on 127.0.0.1 and load only pages you trust.
**Enforce**, not Authentication alone, is
what breaks a client that was not updated. The bridge's only password store is
`sidecar/discord-tokens.json` (`sbPassword`); the password is in no line Greenroom
prints or logs, no bus message and no payload (the OBS log is the exception to watch:
an uncaught error in a page's inline script would show the page's address there,
`?sbpass` included; see the handshake notes above), and a Hello that arrives
later than about a second after the connection is not waited for. The Authenticate itself is answered within five
seconds or the client reports it and retries; a refused password is retried only
every 30 seconds by a page (it cannot become right without a new address).
