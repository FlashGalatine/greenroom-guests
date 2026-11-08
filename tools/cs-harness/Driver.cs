// Line protocol driver for verify-cs.mjs. Reads commands on stdin, runs the REAL action source
// (compiled as shipped, in its own namespace) against the stub CPH, and answers on stdout.
//
//   RESET
//   ARG <name> <base64 utf8>            set an action argument
//   SETVAR <0|1> <name> <base64 utf8>   preset a global (1 = persisted store)
//   THROW <|first|all>                  make WebsocketBroadcastJson fail ("" = never)
//   NEWTONSOFT <0|1>                    parse + re-serialise frames like Streamer.bot (if built in)
//   RUN <vdo-push|vdo-sync|discord-voice-push>   -> RESULT true|false, FRAME.., VAR.., TRACE.., END
//   FUZZ <file>                         each line "<exp>\t<base64 payload>"; runs vdo-push; writes <file>.result
//   CAPS                                -> CAPS newtonsoft=<0|1>
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Harness;

public static class Driver
{
    static StubCPH C { get { return StubCPH.I; } }
    static string B64(string s) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(s ?? "")); }
    static string FromB64(string s) { return Encoding.UTF8.GetString(Convert.FromBase64String(s)); }

    static bool Run(string action)
    {
        switch (action)
        {
            case "vdo-push": return new Act_VdoPush.CPHInline().Execute();
            case "vdo-sync": return new Act_VdoSync.CPHInline().Execute();
            case "discord-voice-push": return new Act_DiscordVoicePush.CPHInline().Execute();
        }
        throw new ArgumentException("unknown action " + action);
    }

    public static int Main(string[] argv)
    {
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            string[] p = line.Split(new[] { ' ' }, 4);
            try
            {
                switch (p[0])
                {
                    case "RESET": C.Reset(); stdout.WriteLine("OK"); break;
                    case "ARG": C.Args[p[1]] = FromB64(p.Length > 2 ? p[2] : ""); stdout.WriteLine("OK"); break;
                    case "SETVAR": C.SetGlobalVar(p[2], FromB64(p.Length > 3 ? p[3] : ""), p[1] == "1"); C.Trace.Clear(); stdout.WriteLine("OK"); break;
                    case "THROW": C.ThrowOnBroadcast = p.Length > 1 ? p[1] : ""; stdout.WriteLine("OK"); break;
                    case "NEWTONSOFT": C.Reserialize = p[1] == "1"; stdout.WriteLine("OK"); break;
                    case "CAPS":
#if NEWTONSOFT
                        stdout.WriteLine("CAPS newtonsoft=1");
#else
                        stdout.WriteLine("CAPS newtonsoft=0");
#endif
                        break;
                    case "RUN":
                    {
                        C.Frames.Clear(); C.Trace.Clear();
                        bool ok;
                        try { ok = Run(p[1]); }
                        catch (Exception ex) { stdout.WriteLine("THREW " + ex.GetType().Name); ok = false; }
                        stdout.WriteLine("RESULT " + (ok ? "true" : "false"));
                        foreach (string f in C.Frames) stdout.WriteLine("FRAME " + B64(f));
                        foreach (KeyValuePair<string, object> kv in C.Persisted) stdout.WriteLine("VAR 1 " + kv.Key + " " + B64(kv.Value as string));
                        foreach (KeyValuePair<string, object> kv in C.Temp) stdout.WriteLine("VAR 0 " + kv.Key + " " + B64(kv.Value as string));
                        stdout.WriteLine("TRACE " + string.Join(",", C.Trace.ToArray()));
                        stdout.WriteLine("END");
                        break;
                    }
                    case "FUZZ":
                    {
                        var result = new StringBuilder();
                        int n = 0;
                        foreach (string l in File.ReadAllLines(p[1]))
                        {
                            if (l.Length == 0) continue;
                            string payload = FromB64(l.Split('\t')[1]);
                            C.Reset();
                            C.Args["payload"] = payload;
                            bool ok = Run("vdo-push");
                            result.Append(C.Persisted.ContainsKey("vdo.state") ? 'A' : 'R');
                            n++;
                        }
                        File.WriteAllText(p[1] + ".result", result.ToString());
                        stdout.WriteLine("FUZZED " + n);
                        break;
                    }
                    default: stdout.WriteLine("ERR unknown command " + p[0]); break;
                }
            }
            catch (Exception ex) { stdout.WriteLine("ERR " + ex.GetType().Name + ": " + ex.Message.Replace('\n', ' ')); }
        }
        return 0;
    }
}
