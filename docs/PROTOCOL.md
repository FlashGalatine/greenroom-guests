# Greenroom — wire protocol

Everything rides Streamer.bot's WebSocket Server (default `ws://127.0.0.1:8080/`,
authentication **off**). Producers call SB **actions** via `DoAction`; the actions
cache state in SB **global variables** and re-broadcast wrapped payloads with
`CPH.WebsocketBroadcastJson`; consumers **Subscribe** to `General.Custom` events.
Streamer.bot is the entire bus — there is no other server.

## Requests

```jsonc
// Subscribe — the event-source key is LOWERCASE 'general' in the request, even
// though delivered events carry a capitalized source 'General'. A capitalized
// Subscribe is acked but receives NOTHING (the classic blank-overlay cause).
{ "request": "Subscribe", "id": "1", "events": { "general": ["Custom"] } }
// Streamer.bot's documented reply is flat: { "status": "ok", "id": "1", "events": {…} }
// (no "result" wrapper). Clients treat a `status` other than "ok" as a refusal: no
// VDO Sync, a visible status (control pill, director-min status, the overlay's offline
// class and a console warning). A reply with no `status` field is not read as a refusal.
// On connect Streamer.bot also sends { "request": "Hello", … }. An "authentication" object in it
// only means Authentication is switched on; with Enforce off Streamer.bot still serves every
// request. If this connection's requests are then refused, or Streamer.bot hangs up before
// accepting one, the clients name the likely cause: "SB auth enforced — turn Enforce off"
// (Greenroom does not authenticate). It clears on the next healthy connection.

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
      "socials": [ { "platform": "twitch", "handle": "TyrannyTimeTV" } ] }
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
  disagree cannot flip the slots every few seconds). A page that is not
  designated takes its own re-assembly as the baseline, so adopting alone never
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
- `label`, `enabled`, and `invite` exist so the persisted `vdo.state` doubles as
  the config store — the control page rehydrates from a `VDO Sync` replay and
  holds no authoritative state of its own. The guest overlay reads only
  `room`/`password`/`viewFlags`/`slots[].{streamID,mirror,mode,discordUserId}`
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
  the moment the operator edits any field of the entry. A Discord user whose username equals an
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
  Discord name and a discord-mode slot bound to them shows no plate. Auto
  entries are capped at 50: at the cap the first auto entry that is not in the
  room (by label, Discord ID or Discord name) and not in a slot is dropped to
  make room, curated entries never are, the dropped guest is added again if they
  come back, and the dock says "auto-add limit reached" when someone could not
  be added. A Discord user with no name
  yet is added when the name arrives (never stored under the snowflake), and a
  label that draws nothing (zero-width characters, U+2800) is not added. A page appends a given label or voice
  user at most once per page session (so a label that Streamer.bot rewrites on the
  way back cannot make the pages push at each other); **Un-ignore removed**,
  **Clear auto-added** and an Import reset that, and adopting another page's state
  runs no auto-add of its own (the next poll or voice update does).
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
  "channelId": "1197…" | null,
  "connected": true,               // bot logged in to the gateway
  "hostInChannel": true,           // bot joined + receiving in the channel
  "users": {
    "<userId>": { "speaking": false, "username": "Ashe",
                  "avatarUrl": "https://cdn.discordapp.com/…", "mute": false, "deaf": false }
  },
  "settings": { "streamerUserId": "", "avatarPx": 56, "streamerPx": 72, "height": 180,
                "accent": "cyan", "scanlines": true, "neonBlink": true, "hideWhenAbsent": true,
                "exitOnSbClose": false },
  "rpc": { "enabled": true, "hasToken": true, "error": "" },
  "favorites": [ { "id": "…", "name": "Commentary", "serverId": "…", "channelId": "…" } ],
  "current": { "serverId": "…", "channelId": "…" } | null,
  "hb": 5000,                     // the bridge pushes at least every hb ms while it runs; 0 once it is stopping
  "stopped": false,               // true on the last frame a bridge sends before it exits
  "bridgeVersion": "1.0.63"       // the sidecar build that sent it
}
```

- `users` is the original toolkit feed, unchanged — the guest overlay's discord
  mode and the roster overlay read only it (+ `settings`).
- `settings`/`rpc`/`favorites`/`current` are superset fields for the control
  page (status pill, favorites list) and the roster overlay's styling. The
  **token itself is never in any payload** — only `hasToken`.
- `settings.exitOnSbClose` (default `false`) is a **sidecar lifecycle** flag, not
  a render setting (overlays ignore it): when `true`, the bridge gracefully leaves
  the voice call and exits once Streamer.bot's WebSocket stays down past a grace
  window (`GREENROOM_SB_EXIT_GRACE_MS`, default 8000 ms) — so the bot doesn't
  linger in the channel after you close SB. The env var
  `GREENROOM_EXIT_ON_SB_CLOSE=1/0` overrides the setting when set.
- `hb`, `stopped` and `bridgeVersion` are additive (a consumer that does not know
  them ignores them). The bridge pushes at least every `hb` ms (5000) even when
  nothing changed, so a consumer can tell a live bridge from one that died with
  its last state still in `discord.state`. A frame with `stopped: true` (and
  `hb: 0`, no users, offline) is the bridge's one last push before it exits: a
  signal, the `quit` command, Streamer.bot closing with exit-on-close on, or a
  crash (then `rpc.error` says "Bridge crashed: …"). The overlays use them in
  Sprint 15, the control pill in Sprint 16.
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
| `leave` | — | leave voice gracefully, stay logged in, clear auto-rejoin intent |
| `reset-auth` | — | forget the saved token (file keeps `enabled`) |
| `set-current` | `{"serverId","channelId"}` | watch this channel (joins/moves if live) |
| `favorite-add` | `{"name","serverId","channelId"}` | add favorite |
| `favorite-update` | `{"id", …fields}` | edit favorite |
| `favorite-remove` | `{"id"}` | remove favorite |
| `set-settings` | partial settings object | merge + clamp + persist |
| `quit` | — | leave voice, send the clearing state and exit (code 0): the clean stop |

## Error broadcasts

Invalid arguments and runtime exceptions are visible, not silent:
`{"type":"vdo:error","message":…}` from `VDO Push`/`VDO Sync`,
`{"type":"discord:voice:error","message":…}` from the Discord actions
(`VDO Sync` reports a failed Discord replay as `discord:voice:error`). The control
page surfaces them in its status pill. An error broadcast can only come from an action
that compiled: one that failed to compile is silent (see `DoAction` above), and
`Discord Bridge Start` broadcasts nothing at all, it only logs, so look in Streamer.bot's
log if the bridge does not come up.

## Security posture

Localhost-only, SB WS authentication assumed **off** (matching the prior PoCs).
The room password travels in `vdoninja:update` by necessity (overlays embed it in
view URLs) — same trust model as the toolkit it replaces. The Discord bot token
is **file-only** (`sidecar/discord-tokens.json`, gitignored) and has no bus
command that can read or write it. Do not expose SB's WS/HTTP beyond localhost
without adding SB's auth handshake to every client in this repo (unimplemented).
Until it is implemented, any page running in OBS (a browser source or dock) or in
a browser on the same PC can read the room password and drive Greenroom through
the auth-off WebSocket, so only load pages you trust.
