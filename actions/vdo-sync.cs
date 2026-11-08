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
//   3. Put this action, "VDO Push" and "Discord Voice Push" in ONE dedicated BLOCKING
//      action queue, e.g. 'Greenroom State' (setup doc, section 2; never the Default
//      queue), so a replay cannot interleave with a push.
//
// Reads the two globals written by the push actions. The persistence flag selects
// WHICH store, so each read MUST mirror its writer:
//   vdo.state     — persisted     (true)  — written by "VDO Push"
//   discord.state — non-persisted (false) — written by "Discord Voice Push"
// Each blob is replayed as an escaped STRING field (vdoninjaJson / discordVoiceJson),
// exactly as the push actions broadcast it, so Streamer.bot's own JSON parse never
// sees or re-formats the text inside it. The two replays are independent (each has its
// own try), so a failure in one never stops the other, and the order is not promised.
// An empty vdo.state is announced as {"type":"vdo:sync:empty"}, so a page on a fresh
// install knows nothing is saved rather than waiting for a reply that never comes. An
// empty discord.state is skipped (a webcam-only setup never has one).

using System;
using System.Text;

public class CPHInline
{
    public bool Execute()
    {
        bool ok = true;
        int sent = 0;

        try
        {
            string vdo = CPH.GetGlobalVar<string>("vdo.state", true);      // persisted store
            if (!string.IsNullOrEmpty(vdo))
            {
                CPH.WebsocketBroadcastJson("{\"type\":\"vdoninja:update\",\"vdoninjaJson\":" + JsonStr(vdo) + "}");
            }
            else
            {
                CPH.WebsocketBroadcastJson("{\"type\":\"vdo:sync:empty\"}");
            }
            sent++;
        }
        catch (Exception ex)
        {
            ok = false;
            Report("vdo:error", ex);
        }

        try
        {
            string discord = CPH.GetGlobalVar<string>("discord.state", false); // non-persisted store
            if (!string.IsNullOrEmpty(discord))
            {
                CPH.WebsocketBroadcastJson("{\"type\":\"discord:voice:update\",\"discordVoiceJson\":" + JsonStr(discord) + "}");
                sent++;
            }
        }
        catch (Exception ex)
        {
            ok = false;
            Report("discord:voice:error", ex);
        }

        CPH.LogInfo("[VDO Sync] replayed " + sent + " blob(s)");
        return ok;
    }

    // Log it and tell the pages. The report is itself guarded: it must never end the action.
    void Report(string type, Exception ex)
    {
        CPH.LogWarn("[VDO Sync] ERROR: " + ex);
        try
        {
            CPH.WebsocketBroadcastJson("{\"type\":\"" + type + "\",\"message\":" + JsonStr(ex.Message) + "}");
        }
        catch (Exception)
        {
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
