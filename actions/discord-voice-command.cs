// Streamer.bot "Discord Voice Command" action — the control page -> sidecar half of
// the two-way bus. The control page calls DoAction with args { command, value }; this
// broadcasts { type:"discord:voice:command", command, value } and the Discord bridge
// sidecar (a subscribed WS client like any overlay) consumes it.
//
// HOW TO USE (docs/STREAMERBOT-SETUP.md has the full walkthrough):
//   1. Streamer.bot -> Actions -> add an action named EXACTLY "Discord Voice Command"
//      (the name matters: control.html does DoAction { name: "Discord Voice Command" }).
//   2. Add a sub-action: Core -> C# -> Execute C# Code. Paste EVERYTHING below and
//      click COMPILE — it must report success.
//
// Commands (docs/PROTOCOL.md): connect | leave | reset-auth | set-current |
// favorite-add | favorite-update | favorite-remove | set-settings. `value` is ALWAYS
// a plain string on the wire — structured values are JSON strings the sidecar
// JSON.parses. This C# just escapes it as a string; it never parses anything.
// The bot token NEVER travels this bus (file-only, sidecar/discord-tokens.json).

using System;
using System.Text;

public class CPHInline
{
    public bool Execute()
    {
        try
        {
            string command;
            if (!CPH.TryGetArg("command", out command) || string.IsNullOrEmpty(command))
            {
                CPH.LogWarn("[Discord Voice Command] called without a 'command' argument");
                CPH.WebsocketBroadcastJson("{\"type\":\"discord:voice:error\",\"message\":\"Discord Voice Command called without a command argument\"}");
                return false;
            }
            string value;
            if (!CPH.TryGetArg("value", out value) || value == null) value = "";

            CPH.WebsocketBroadcastJson(
                "{\"type\":\"discord:voice:command\",\"command\":" + JsonStr(command) +
                ",\"value\":" + JsonStr(value) + "}");
            CPH.LogInfo("[Discord Voice Command] " + command);
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogWarn("[Discord Voice Command] ERROR: " + ex);
            CPH.WebsocketBroadcastJson("{\"type\":\"discord:voice:error\",\"message\":" + JsonStr(ex.Message) + "}");
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
