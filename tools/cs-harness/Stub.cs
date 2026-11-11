// Stand-in for Streamer.bot's C# host, used by verify-cs.mjs. Compiles against mscorlib ONLY, which is
// stricter than the reference set Streamer.bot gives an Execute C# Code sub-action, so an action that
// compiles here compiles there. Define NEWTONSOFT (and reference Newtonsoft.Json.dll) to make
// WebsocketBroadcastJson parse and re-serialise every frame the way Streamer.bot does.
using System;
using System.Collections.Generic;
#if NEWTONSOFT
using Newtonsoft.Json.Linq;
#endif

namespace Harness
{
    public class StubCPH
    {
        public static StubCPH I = new StubCPH();

        public Dictionary<string, object> Args = new Dictionary<string, object>();
        public Dictionary<string, object> Persisted = new Dictionary<string, object>();
        public Dictionary<string, object> Temp = new Dictionary<string, object>();
        public List<string> Frames = new List<string>();   // what reached the WebSocket clients
        public List<string> Trace = new List<string>();    // every CPH call, in order

        // "" = never fails; "first" = the first broadcast throws; "all" = every broadcast throws;
        // "type:<frame type>" = a broadcast whose frame has that "type" throws.
        public string ThrowOnBroadcast = "";
        public bool Reserialize;     // (NEWTONSOFT builds only) parse + re-serialise like Streamer.bot
        int broadcasts;

        public void Reset()
        {
            Args.Clear(); Persisted.Clear(); Temp.Clear(); Frames.Clear(); Trace.Clear();
            ThrowOnBroadcast = ""; Reserialize = false; broadcasts = 0;
        }

        public bool TryGetArg<T>(string name, out T value)
        {
            object o;
            if (Args.TryGetValue(name, out o) && o is T) { value = (T)o; return true; }
            value = default(T);
            return false;
        }

        public T GetGlobalVar<T>(string name, bool persisted)
        {
            object o;
            Dictionary<string, object> d = persisted ? Persisted : Temp;
            return d.TryGetValue(name, out o) && o is T ? (T)o : default(T);
        }

        public void SetGlobalVar(string name, object value, bool persisted)
        {
            (persisted ? Persisted : Temp)[name] = value;
            Trace.Add("Set:" + name);
        }

        public void UnsetGlobalVar(string name, bool persisted)
        {
            (persisted ? Persisted : Temp).Remove(name);
            Trace.Add("Unset:" + name);
        }

        public void WebsocketBroadcastJson(string data)
        {
            broadcasts++;
            Trace.Add("Broadcast");
            bool byType = ThrowOnBroadcast.StartsWith("type:") && data.Contains("\"type\":\"" + ThrowOnBroadcast.Substring(5) + "\"");
            if (ThrowOnBroadcast == "all" || (ThrowOnBroadcast == "first" && broadcasts == 1) || byType)
            {
                Trace.Add("Broadcast-throws");
                throw new InvalidOperationException("stub: broadcast failed");
            }
#if NEWTONSOFT
            if (Reserialize)
            {
                try { data = JObject.Parse(data).ToString(Newtonsoft.Json.Formatting.None); }
                catch (Exception ex) { Trace.Add("Broadcast-newtonsoft-throws:" + ex.GetType().Name); throw; }
            }
#endif
            Frames.Add(data);
        }

        public void LogInfo(string s) { Trace.Add("LogInfo"); }
        public void LogWarn(string s) { Trace.Add("LogWarn"); }
    }

    // What Streamer.bot injects into a pasted action: a CPH proxy.
    public class CPHBase { public StubCPH CPH { get { return StubCPH.I; } } }
}
