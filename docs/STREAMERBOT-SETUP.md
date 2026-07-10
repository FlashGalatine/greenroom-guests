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

  Serving over `http://127.0.0.1` is load-bearing twice: the embedded vdo.ninja
  WebRTC viewer renders **black** inside a `file://` page (non-secure context),
  and `file://` OBS sources ignore `?slot=`/`?sbport=` query params entirely.

## 2. The five actions

For each: **Actions → Add** with the EXACT name below (names are load-bearing —
the pages call `DoAction { name }`), then add sub-action **Core → C# → Execute
C# Code**, paste the whole file from `actions/`, and click **Compile** — it must
report success. *A compile error still acks DoAction with ok and broadcasts
nothing; the symptom is a blank/stale overlay.*

| Action name | File | Notes |
|---|---|---|
| `VDO Push` | `actions/vdo-push.cs` | zero references |
| `Discord Voice Push` | `actions/discord-voice-push.cs` | zero references |
| `VDO Sync` | `actions/vdo-sync.cs` | zero references |
| `Discord Voice Command` | `actions/discord-voice-command.cs` | zero references |
| `Discord Bridge Start` *(optional)* | `actions/discord-bridge-start.cs` | **References step below** |

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
| Discord roster | `http://127.0.0.1:7474/greenroom-overlay/discord-roster.html?layout=row` |
| Always-on director | `http://127.0.0.1:7474/greenroom-control/director-min.html` as a **1×1 px** source |

Every page fires the `VDO Sync` action on connect, so a source added mid-stream
paints immediately.

## 4. The control page + the director

`http://127.0.0.1:7474/greenroom-control/control.html` — open as a browser tab
or an OBS **Custom Browser Dock** (Docks → Custom Browser Docks…).

Auto-follow needs **one director page open somewhere** (it hosts the hidden
vdo.ninja director iframe that re-resolves labels → streamIDs every 2.5 s).
Deployment options, best first:

1. **1×1 OBS Browser Source running `director-min.html`** — always-on, zero
   operator attention; browser sources are known-good CEF. Open `control.html`
   only to edit (a brief two-director overlap is fine — pushes converge).
2. **`control.html` as an OBS Custom Browser Dock** — the natural operator home.
   Whether the director iframe's WebRTC + postMessage fully works in dock CEF is
   a standing live-validation item (below); if it does, the dock alone suffices.
3. **A pinned browser tab** — the known-working fallback.

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

## 6. Live-validation checklist

What the offline harness (63 protocol + 22 render checks) **cannot** prove —
tick these on the first real session:

- [ ] **Real SB 1.0.4 wiring**: all five actions compile; overlays paint from a
      `VDO Sync` replay after an SB restart (persisted `vdo.state` survives,
      `discord.state` doesn't).
- [ ] **Real vdo.ninja**: live `getGuestList` reply parses (a shape change is
      maintenance, not a kill — fix `control/vdo-parse.js`); the assembled
      `?view=` URL renders actual video in the guest slot; **auto-follow**: guest
      drops + rejoins → slot re-acquires within ~2.5 s.
- [ ] **Multi-director safety**: the hidden director + a human-operated director
      link in the same room simultaneously.
- [ ] **Real bot**: token onboarding per §5; DAVE/E2EE voice handshake succeeds
      (`libsodium-wrappers` stack); speaking events arrive from a live channel;
      the mute/deaf badges track real state changes.
- [ ] **Sustained rate**: ~10 `Discord Voice Push` DoActions/s during a rowdy
      conversation without SB action-queue lag (the mock proves the protocol,
      not SB's queue latency).
- [ ] **OBS dock CEF spike**: does the director iframe (WebRTC + postMessage)
      run inside a Custom Browser Dock? If yes → the dock alone keeps
      auto-follow alive; if no → stay on the 1×1 source pattern.
- [ ] **1×1 source pattern**: `director-min.html` as a browser source keeps
      resolving with the dock/tab closed.

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
