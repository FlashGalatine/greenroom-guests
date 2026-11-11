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
// Each cached blob is checked with the push actions' strict JSON validator before it is
// replayed. An invalid cache is reported ({ type:"vdo:error" } or "discord:voice:error",
// "cached state is not valid JSON - …" with the remedy that fits: Import a backup or re-save
// for the persisted vdo.state, the bridge's next push for the non-persisted discord.state),
// not replayed, and KEPT: the action never unsets a global.

using System;
using System.Collections.Generic;
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
            string vdoWhy = string.IsNullOrEmpty(vdo) ? null : ObjectError(vdo);
            if (string.IsNullOrEmpty(vdo))
            {
                CPH.WebsocketBroadcastJson("{\"type\":\"vdo:sync:empty\"}");
                sent++;
            }
            else if (vdoWhy == null)
            {
                CPH.WebsocketBroadcastJson("{\"type\":\"vdoninja:update\",\"vdoninjaJson\":" + JsonStr(vdo) + "}");
                sent++;
            }
            else
            {
                ok = false;
                Invalid("vdo:error", "vdo.state", vdoWhy, "cached state is not valid JSON - Import a backup or re-save");
            }
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
                string discordWhy = ObjectError(discord);
                if (discordWhy == null)
                {
                    CPH.WebsocketBroadcastJson("{\"type\":\"discord:voice:update\",\"discordVoiceJson\":" + JsonStr(discord) + "}");
                    sent++;
                }
                else
                {
                    ok = false;
                    Invalid("discord:voice:error", "discord.state", discordWhy, "cached state is not valid JSON - the bridge replaces it with its next push (restart the bridge to force one)");
                }
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
        Send(type, ex.Message);
    }

    // A cached blob that is not a valid JSON object: say so, replay nothing, leave the global alone.
    void Invalid(string type, string name, string why, string message)
    {
        CPH.LogWarn("[VDO Sync] " + name + " is not valid JSON (" + why + "); not replayed, and kept as it is");
        Send(type, message);
    }

    void Send(string type, string message)
    {
        try
        {
            CPH.WebsocketBroadcastJson("{\"type\":\"" + type + "\",\"message\":" + JsonStr(message) + "}");
        }
        catch (Exception)
        {
        }
    }

    // ── Strict JSON check (RFC 8259), mscorlib only ─────────────────────────────────────────
    // The text must be ONE JSON object with nothing after it, no object repeating a key (compared
    // after decoding escapes), and containers nested at most 32 deep (the top-level object is 1).
    // It is parsed with an explicit stack, not recursion, so hostile nesting cannot overflow the
    // stack. Returns null when the text is acceptable, else a short reason. This is what keeps a
    // brace-wrapped splice such as {...},"type":"x"} and plain garbage out of the cache.
    static string ObjectError(string s)
    {
        if (s == null) return "empty";
        var stack = new List<Dictionary<string, bool>>(); // one per open container: its keys, or null for an array
        int i = 0;
        SkipWs(s, ref i);
        if (i >= s.Length || s[i] != '{') return "not a JSON object";
        bool wantValue = true; // true: a value starts here; false: a value has just ended
        while (true)
        {
            SkipWs(s, ref i);
            if (wantValue)
            {
                if (i >= s.Length) return "unexpected end";
                char c = s[i];
                if (c == '{' || c == '[')
                {
                    if (stack.Count >= 32) return "nested too deep";
                    bool isObj = c == '{';
                    i++;
                    SkipWs(s, ref i);
                    if (i < s.Length && s[i] == (isObj ? '}' : ']')) { i++; wantValue = false; continue; } // empty container
                    stack.Add(isObj ? new Dictionary<string, bool>() : null);
                    if (isObj)
                    {
                        string ke = ReadKey(s, ref i, stack[stack.Count - 1]);
                        if (ke != null) return ke;
                    }
                    continue; // the member's value, or the first element, comes next
                }
                string ve = ReadScalar(s, ref i);
                if (ve != null) return ve;
                wantValue = false;
                continue;
            }
            // a value has just ended: ',' for the next member or element, or the innermost container's closer
            if (stack.Count == 0) return i == s.Length ? null : "unexpected data after the object at " + i;
            Dictionary<string, bool> top = stack[stack.Count - 1];
            char d = i < s.Length ? s[i] : '\0';
            if (d == ',')
            {
                i++;
                if (top != null)
                {
                    string ke = ReadKey(s, ref i, top);
                    if (ke != null) return ke;
                }
                wantValue = true;
                continue;
            }
            char close = top != null ? '}' : ']';
            if (d == close) { stack.RemoveAt(stack.Count - 1); i++; continue; }
            return "expected ',' or '" + close + "' at " + i;
        }
    }

    static void SkipWs(string s, ref int i)
    {
        while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
    }

    // "key" ':' — records the decoded key and refuses a repeat.
    static string ReadKey(string s, ref int i, Dictionary<string, bool> keys)
    {
        SkipWs(s, ref i);
        int start = i;
        string e = ReadString(s, ref i);
        if (e != null) return e;
        string key = DecodeKey(s, start, i);
        if (keys.ContainsKey(key)) return "duplicate key \"" + (key.Length > 40 ? key.Substring(0, 40) + "..." : key) + "\"";
        keys[key] = true;
        SkipWs(s, ref i);
        if (i >= s.Length || s[i] != ':') return "expected ':' at " + i;
        i++;
        return null;
    }

    static string ReadScalar(string s, ref int i)
    {
        char c = s[i];
        if (c == '"') return ReadString(s, ref i);
        if (c == 't') return ReadWord(s, ref i, "true");
        if (c == 'f') return ReadWord(s, ref i, "false");
        if (c == 'n') return ReadWord(s, ref i, "null");
        if (c == '-' || (c >= '0' && c <= '9')) return ReadNumber(s, ref i);
        return "unexpected '" + c + "' at " + i;
    }

    static string ReadString(string s, ref int i)
    {
        if (i >= s.Length || s[i] != '"') return "expected a string at " + i;
        i++;
        while (i < s.Length)
        {
            char c = s[i++];
            if (c == '"') return null;
            if (c < ' ') return "raw control character in a string at " + (i - 1);
            if (c != '\\') continue;
            if (i >= s.Length) break;
            char x = s[i++];
            if (x == 'u')
            {
                for (int k = 0; k < 4; k++, i++)
                {
                    char h = i < s.Length ? s[i] : '\0';
                    if (!((h >= '0' && h <= '9') || (h >= 'a' && h <= 'f') || (h >= 'A' && h <= 'F'))) return "bad \\u escape at " + i;
                }
            }
            else if ("\"\\/bfnrt".IndexOf(x) < 0) return "bad escape at " + (i - 1);
        }
        return "unterminated string";
    }

    // The text of a string token already accepted by ReadString (s[start..end), quotes included), escapes decoded.
    static string DecodeKey(string s, int start, int end)
    {
        var sb = new StringBuilder(end - start);
        for (int k = start + 1; k < end - 1; k++)
        {
            char c = s[k];
            if (c != '\\') { sb.Append(c); continue; }
            char x = s[++k];
            switch (x)
            {
                case 'b': sb.Append('\b'); break;
                case 'f': sb.Append('\f'); break;
                case 'n': sb.Append('\n'); break;
                case 'r': sb.Append('\r'); break;
                case 't': sb.Append('\t'); break;
                case 'u': sb.Append((char)Convert.ToInt32(s.Substring(k + 1, 4), 16)); k += 4; break;
                default: sb.Append(x); break; // " \ /
            }
        }
        return sb.ToString();
    }

    static string ReadWord(string s, ref int i, string word)
    {
        if (i + word.Length > s.Length || string.CompareOrdinal(s, i, word, 0, word.Length) != 0) return "bad literal at " + i;
        i += word.Length;
        return null;
    }

    static string ReadNumber(string s, ref int i)
    {
        int start = i;
        if (s[i] == '-') i++;
        if (i < s.Length && s[i] == '0') i++;
        else if (i < s.Length && s[i] >= '1' && s[i] <= '9') { while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++; }
        else return "bad number at " + start;
        if (i < s.Length && s[i] == '.')
        {
            i++;
            int d = i;
            while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++;
            if (i == d) return "bad number at " + start;
        }
        if (i < s.Length && (s[i] == 'e' || s[i] == 'E'))
        {
            i++;
            if (i < s.Length && (s[i] == '+' || s[i] == '-')) i++;
            int d = i;
            while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++;
            if (i == d) return "bad number at " + start;
        }
        return null;
    }
    // ── end of the strict JSON check ────────────────────────────────────────────────

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
