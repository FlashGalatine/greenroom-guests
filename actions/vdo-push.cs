// Streamer.bot "VDO Push" action — caches + broadcasts the guest-dock state.
//
// Called by the Greenroom control pages (control.html / director-min.html) with one
// argument, `payload`: the ENTIRE vdoninja state pre-serialized as a JSON object
// string (room/password/viewFlags/slots incl. resolved streamIDs/invite). The state is
// broadcast as an escaped STRING field, {"type":"vdoninja:update","vdoninjaJson":"…"},
// never as a nested object: Streamer.bot parses a broadcast with Newtonsoft before it
// sends it, and text a guest controls (a guest label, a Discord name) must not pass
// through that parser or be re-formatted by it. The pages parse the string themselves.
// The payload is stored unchanged in a persisted global.
//
// HOW TO USE (docs/STREAMERBOT-SETUP.md has the full walkthrough):
//   1. Streamer.bot -> Actions -> add an action named EXACTLY "VDO Push"
//      (the name matters: the control pages DoAction { name: "VDO Push" }).
//   2. Add a sub-action: Core -> C# -> Execute C# Code. Paste EVERYTHING below and
//      click COMPILE — it must report success. A compile error means the action runs
//      but broadcasts nothing, which shows up as blank/stale overlays.
//   3. Put this action, "Discord Voice Push" and "VDO Sync" in ONE dedicated BLOCKING
//      action queue, e.g. 'Greenroom State' (setup doc, section 2; never the Default
//      queue), so a Sync replay cannot interleave with a push.
//
// State: ONE persisted global, `vdo.state` (persisted=true — the dock config must
// survive SB restarts). A replayed config keeps the streamIDs it was saved with until
// a director page re-resolves them (every 2.5 s while one is running), which beats a
// blank slot. The broadcast comes BEFORE the cache write: a broadcast that fails never
// leaves a state behind that no client has seen.
//
// NOTE: uses ONLY types in Streamer.bot's default C# reference set — JSON is
// hand-written (no Newtonsoft) and there is no System.Uri. Any exception is logged
// AND broadcast as { type:"vdo:error", message } so failures are visible, not silent.

using System;
using System.Text;

public class CPHInline
{
    public bool Execute()
    {
        try
        {
            string payload;
            if (!CPH.TryGetArg("payload", out payload) || string.IsNullOrEmpty(payload))
            {
                return Fail("VDO Push called without a 'payload' argument");
            }
            payload = payload.Trim();
            if (!payload.StartsWith("{") || !payload.EndsWith("}"))
            {
                return Fail("VDO Push payload must be a JSON object string");
            }

            CPH.WebsocketBroadcastJson("{\"type\":\"vdoninja:update\",\"vdoninjaJson\":" + JsonStr(payload) + "}");
            CPH.SetGlobalVar("vdo.state", payload, true); // true = persisted store
            CPH.LogInfo("[VDO Push] broadcast + cached (" + payload.Length + " bytes)");
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogWarn("[VDO Push] ERROR: " + ex);
            CPH.WebsocketBroadcastJson("{\"type\":\"vdo:error\",\"message\":" + JsonStr(ex.Message) + "}");
            return false;
        }
    }

    bool Fail(string message)
    {
        CPH.LogWarn("[VDO Push] " + message);
        CPH.WebsocketBroadcastJson("{\"type\":\"vdo:error\",\"message\":" + JsonStr(message) + "}");
        return false;
    }

    // Minimal, correct JSON string encoder (escapes quotes, backslashes, controls).
    static string JsonStr(string s)
    {
        if (s == null) return "\"\"";
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"':  sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
