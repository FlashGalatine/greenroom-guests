// Streamer.bot "VDO Sync" action — replays both cached state blobs to all
// subscribed WebSocket clients. Streamer.bot has no state-on-connect replay; every
// Greenroom page (guest slots, roster overlay, control pages) fires this via
// DoAction as soon as its Subscribe is acknowledged, so a source added mid-stream
// paints immediately instead of staying blank.
//
// HOW TO USE (docs/STREAMERBOT-SETUP.md has the full walkthrough):
//   1. Streamer.bot -> Actions -> add an action named EXACTLY "VDO Sync"
//      (the name matters: overlay/panel-client-sb.js defaults __SB_SYNC_ACTION to it).
//   2. Add a sub-action: Core -> C# -> Execute C# Code. Paste EVERYTHING below and
//      click COMPILE — it must report success.
//
// Reads the two globals written by the push actions. The persistence flag selects
// WHICH store, so each read MUST mirror its writer:
//   vdo.state     — persisted     (true)  — written by "VDO Push"
//   discord.state — non-persisted (false) — written by "Discord Voice Push"
// Empty caches are skipped (a webcam-only setup never has discord.state). Order:
// vdo first, so a guest slot in discord mode knows its slot binding before the
// roster arrives.

using System;
using System.Text;

public class CPHInline
{
    public bool Execute()
    {
        try
        {
            string vdo = CPH.GetGlobalVar<string>("vdo.state", true);      // persisted store
            string discord = CPH.GetGlobalVar<string>("discord.state", false); // non-persisted store

            int sent = 0;
            if (!string.IsNullOrEmpty(vdo))
            {
                CPH.WebsocketBroadcastJson("{\"type\":\"vdoninja:update\",\"vdoninja\":" + vdo + "}");
                sent++;
            }
            if (!string.IsNullOrEmpty(discord))
            {
                CPH.WebsocketBroadcastJson("{\"type\":\"discord:voice:update\",\"discordVoice\":" + discord + "}");
                sent++;
            }
            CPH.LogInfo("[VDO Sync] replayed " + sent + " cached blob(s)");
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogWarn("[VDO Sync] ERROR: " + ex);
            CPH.WebsocketBroadcastJson("{\"type\":\"vdo:error\",\"message\":" + JsonStr(ex.Message) + "}");
            return false;
        }
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
