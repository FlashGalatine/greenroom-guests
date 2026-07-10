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

// DoAction — ack {id, status:'ok'} means the action STARTED, not that it
// succeeded. A C# compile error still acks ok and broadcasts nothing; that is
// why the actions carry error broadcasts (see below).
{ "request": "DoAction", "id": "2", "action": { "name": "VDO Push" }, "args": { "payload": "{...}" } }
```

## Event envelope (what subscribed clients receive)

```jsonc
{
  "timeStamp": "…",
  "event": { "source": "General", "type": "Custom" },
  "data": { "type": "vdoninja:update", "vdoninja": { /* payload */ } }
}
```

`WebsocketBroadcastJson` nests `data` as an **object** (plain `WebsocketBroadcast`
would put a JSON **string** there — the transport shim tolerates both). Overlays
re-emit every `data` with a `.type` as a window `svc:message` CustomEvent.

## Actions and globals

| Action | Caller | args | Behavior |
|---|---|---|---|
| `VDO Push` | control pages | `payload` | `SetGlobalVar("vdo.state", payload, **true**)` → broadcast `{"type":"vdoninja:update","vdoninja":<payload>}` |
| `Discord Voice Push` | bridge sidecar | `payload` | `SetGlobalVar("discord.state", payload, **false**)` → broadcast `{"type":"discord:voice:update","discordVoice":<payload>}` |
| `VDO Sync` | every page on connect | `reason` | read both globals (same persistence flags) → re-broadcast each non-empty, vdo first |
| `Discord Voice Command` | control page | `command`, `value` | broadcast `{"type":"discord:voice:command","command":…,"value":…}` |
| `Discord Bridge Start` *(optional)* | SB startup trigger | — | `Process.Start` the sidecar hidden |

The C# **never parses JSON**. Push payloads are pre-serialized by the producers
and concatenated raw into the wrapper; the only C#-built JSON is the tiny command
broadcast and the error shapes.

**Persistence flags are semantic.** `vdo.state` is persisted (`true`) — the dock
config must survive SB restarts; a stale resolved streamID may replay for ≤2.5 s
until the director's next resolution corrects it, which beats a blank slot.
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
      "mode": "webcam", "discordUserId": "" },
    …
  ],
  "invite": { "passwordMode": "hash", "label": "", "push": "", "videoBitrate": "",
    "quality": "", "width": "", "height": "", "fps": "", "codec": "",
    "audioBitrate": "", "stereo": false, "noVideo": false, "noAudio": false,
    "capture": "", "broadcast": false, "meshcast": false, "autostart": false,
    "requireApproval": false, "roomCap": "", "extraFlags": "" }
}
```

- Slots bind guests by **label** (stable across rejoins); `streamID` is the
  volatile live resolution the director loop refreshes every 2.5 s.
- `label`, `enabled`, and `invite` exist so the persisted `vdo.state` doubles as
  the config store — the control page rehydrates from a `VDO Sync` replay and
  holds no authoritative state of its own. The guest overlay reads only
  `room`/`password`/`viewFlags`/`slots[].{streamID,mirror,mode,discordUserId}`
  and ignores the rest.

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
                "accent": "cyan", "scanlines": true, "neonBlink": true, "hideWhenAbsent": true },
  "rpc": { "enabled": true, "hasToken": true, "error": "" },
  "favorites": [ { "id": "…", "name": "Commentary", "serverId": "…", "channelId": "…" } ],
  "current": { "serverId": "…", "channelId": "…" } | null
}
```

- `users` is the original toolkit feed, unchanged — the guest overlay's discord
  mode and the roster overlay read only it (+ `settings`).
- `settings`/`rpc`/`favorites`/`current` are superset fields for the control
  page (status pill, favorites list) and the roster overlay's styling. The
  **token itself is never in any payload** — only `hasToken`.
- Pushed leading-edge with a 100 ms trailing coalesce: worst case ~10
  DoActions/s in a rowdy channel.

## Commands (`discord:voice:command`)

`value` is **always a plain string** on the wire; structured commands carry JSON
the control page pre-serialized and the sidecar `JSON.parse`s. Unknown commands
are logged and ignored (the mock bridge adds a test-only `mock-burst on|off`).

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

## Error broadcasts

Failures are visible, not silent: `{"type":"vdo:error","message":…}` from
`VDO Push`/`VDO Sync`, `{"type":"discord:voice:error","message":…}` from the
Discord actions. The control page surfaces them in its status pill.

## Security posture

Localhost-only, SB WS authentication assumed **off** (matching the prior PoCs).
The room password travels in `vdoninja:update` by necessity (overlays embed it in
view URLs) — same trust model as the toolkit it replaces. The Discord bot token
is **file-only** (`sidecar/discord-tokens.json`, gitignored) and has no bus
command that can read or write it. Do not expose SB's WS/HTTP beyond localhost
without adding SB's auth handshake to every client in this repo (unimplemented).
