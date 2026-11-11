// Streamer.bot "VDO Push" action — caches + broadcasts the guest-dock state.
//
// Called by the Greenroom control pages (control.html / director-min.html) with one
// argument, `payload`: the ENTIRE vdoninja state pre-serialized as a JSON object
// string (room/password/viewFlags/slots incl. resolved streamIDs/invite). The state is
// broadcast as an escaped STRING field, {"type":"vdoninja:update","vdoninjaJson":"…"},
// never as a nested object: Streamer.bot parses a broadcast with Newtonsoft before it
// sends it, and text a guest controls (a guest label, a Discord name) must not pass
// through that parser or be re-formatted by it. The pages parse the string themselves.
// The payload is VALIDATED, never re-serialized: it must be one JSON object (RFC 8259,
// no repeated keys, nesting <= 32 deep) or it is refused with { type:"vdo:error", message:
// "payload rejected, NOT cached: …" }, neither broadcast nor cached. A valid payload is
// stored unchanged in a persisted global.
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
using System.Collections.Generic;
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
            string why = ObjectError(payload);
            if (why != null)
            {
                return Fail("payload rejected, NOT cached: " + why);
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
