// Streamer.bot "VDO Push" action — caches + broadcasts the guest-dock state.
//
// Called by the Greenroom control pages (control.html / director-min.html) with one
// argument, `payload`: the ENTIRE vdoninja state pre-serialized as a JSON object
// string (room/password/viewFlags/slots incl. resolved streamIDs/invite). This C#
// NEVER parses it — it stores the string in a persisted global and concatenates it
// raw into the broadcast wrapper. Producers own the JSON; C# owns cache + wrap.
//
// HOW TO USE (docs/STREAMERBOT-SETUP.md has the full walkthrough):
//   1. Streamer.bot -> Actions -> add an action named EXACTLY "VDO Push"
//      (the name matters: the control pages DoAction { name: "VDO Push" }).
//   2. Add a sub-action: Core -> C# -> Execute C# Code. Paste EVERYTHING below and
//      click COMPILE — it must report success. A compile error means the action runs
//      but broadcasts nothing, which shows up as blank/stale overlays.
//
// State: ONE persisted global, `vdo.state` (persisted=true — the dock config must
// survive SB restarts; a stale resolved streamID may replay for ≤2.5s until the
// director's next resolution corrects it, which beats a blank slot).
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

            CPH.SetGlobalVar("vdo.state", payload, true); // true = persisted store
            CPH.WebsocketBroadcastJson("{\"type\":\"vdoninja:update\",\"vdoninja\":" + payload + "}");
            CPH.LogInfo("[VDO Push] cached + broadcast (" + payload.Length + " bytes)");
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
