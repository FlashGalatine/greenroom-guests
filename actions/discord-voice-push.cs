// Streamer.bot "Discord Voice Push" action — caches + broadcasts the voice roster.
//
// Called by the Discord bridge sidecar (sidecar/discord-bridge.mjs) with one
// argument, `payload`: the ENTIRE discordVoice state pre-serialized as a JSON object
// string (channelId/connected/hostInChannel/users/settings/rpc/favorites/current).
// This C# NEVER parses it — cache + wrap + broadcast only.
//
// HOW TO USE (docs/STREAMERBOT-SETUP.md has the full walkthrough):
//   1. Streamer.bot -> Actions -> add an action named EXACTLY "Discord Voice Push"
//      (the name matters: the sidecar does DoAction { name: "Discord Voice Push" }).
//   2. Add a sub-action: Core -> C# -> Execute C# Code. Paste EVERYTHING below and
//      click COMPILE — it must report success.
//
// State: ONE NON-persisted global, `discord.state` (persisted=false — speaking/
// presence state is live data; a stale roster must NOT replay after an SB restart.
// The sidecar re-pushes current state as soon as it reconnects).
//
// This action fires at up to ~10/s during speaking bursts (the sidecar coalesces at
// 100 ms) — it stays deliberately tiny: no logging on the hot path.
//
// NOTE: uses ONLY types in Streamer.bot's default C# reference set. Any exception is
// logged AND broadcast as { type:"discord:voice:error", message }.

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
                return Fail("Discord Voice Push called without a 'payload' argument");
            }
            payload = payload.Trim();
            if (!payload.StartsWith("{") || !payload.EndsWith("}"))
            {
                return Fail("Discord Voice Push payload must be a JSON object string");
            }

            CPH.SetGlobalVar("discord.state", payload, false); // false = non-persisted store
            CPH.WebsocketBroadcastJson("{\"type\":\"discord:voice:update\",\"discordVoice\":" + payload + "}");
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogWarn("[Discord Voice Push] ERROR: " + ex);
            CPH.WebsocketBroadcastJson("{\"type\":\"discord:voice:error\",\"message\":" + JsonStr(ex.Message) + "}");
            return false;
        }
    }

    bool Fail(string message)
    {
        CPH.LogWarn("[Discord Voice Push] " + message);
        CPH.WebsocketBroadcastJson("{\"type\":\"discord:voice:error\",\"message\":" + JsonStr(message) + "}");
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
