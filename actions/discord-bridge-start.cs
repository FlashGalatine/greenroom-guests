// Streamer.bot "Discord Bridge Start" action (OPTIONAL) — launches the Discord
// bridge sidecar hidden, so SB can auto-start it. Webcam-only setups skip this
// action entirely; you can also just double-click start-discord-bridge.bat instead.
//
// HOW TO USE (docs/STREAMERBOT-SETUP.md has the full walkthrough):
//   1. EDIT THE `BUNDLE` CONST BELOW to your Greenroom sidecar folder (until you do,
//      the action logs "set BUNDLE" and starts nothing).
//   2. Streamer.bot -> Actions -> add an action named "Discord Bridge Start";
//      sub-action Core -> C# -> Execute C# Code; paste everything below.
//   3. THE REFERENCES STEP (required): compiling as-is fails with
//        CS0246 'ProcessStartInfo' could not be found / CS0103 'Process' does not exist
//      because Streamer.bot 1.0.4 does not reference System.dll by default. Fix: in
//      the C# editor open the References tab (next to the Compiling Log) and add
//      System.dll (browse to C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.dll
//      if it wants a full path). Then Compile -> green.
//   4. Optional: in the action's Triggers box search "start" and add your SB
//      version's application-started trigger — SB then launches the bridge on every
//      start. No trigger? Run the action manually once per session.
//
// UseShellExecute = true is LOAD-BEARING: launching via the shell does NOT pass SB's
// open listening sockets (WS :8080 / HTTP :7474) to the node child. With false, an
// orphaned bridge after ANY Streamer.bot exit that does not close it (a crash, a kill,
// not only an unclean one) keeps those ports bound and SB cannot restart its servers
// until the child is killed. Because of it this action cannot set environment variables
// for node, and in the same way do NOT start the bridge with a "Run a Program"
// sub-action that sets some, or that waits for the program to exit.
//
// Before it starts anything it checks that BUNDLE is set and is the sidecar folder with
// its dependencies installed, and says so in the log if not. It finds node.exe itself
// (the Node.js registry key, then Program Files, then the Machine and User PATH), so a
// Node installed after Streamer.bot started is found; if node still cannot be found,
// restart Streamer.bot (it reads PATH once, when it starts) or use the .bat. It waits two
// seconds for the process: a bridge that exits at once is reported with its exit code.
//
// Running it twice is harmless: the bridge binds a single-instance guard port
// (:7495) — a second instance logs and exits 0 (reported here as "already running").
// Requires Node >= 22.12.

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32;

public class CPHInline
{
    // EDIT ME — absolute path to the Greenroom sidecar folder.
    const string BUNDLE = @"C:\path\to\greenroom-guests\sidecar";
    // What BUNDLE says until it has been edited.
    const string BUNDLE_PLACEHOLDER = @"C:\path\to\greenroom-guests\sidecar";

    public bool Execute()
    {
        try
        {
            // Pre-flight: say what is wrong instead of launching something that fails silently.
            if (string.Equals(BUNDLE.Trim().TrimEnd('\\'), BUNDLE_PLACEHOLDER, StringComparison.OrdinalIgnoreCase))
            {
                CPH.LogWarn("[Discord Bridge Start] BUNDLE is still the placeholder: set BUNDLE at the top of the action to your Greenroom sidecar folder (…\\greenroom-guests\\sidecar), then compile again");
                return false;
            }
            if (!Directory.Exists(BUNDLE))
            {
                CPH.LogWarn("[Discord Bridge Start] BUNDLE does not exist: " + BUNDLE + " — edit BUNDLE to your Greenroom sidecar folder");
                return false;
            }
            if (!File.Exists(Path.Combine(BUNDLE, "discord-bridge.mjs")))
            {
                CPH.LogWarn("[Discord Bridge Start] discord-bridge.mjs is not in " + BUNDLE + " — that is not the sidecar folder: edit BUNDLE to the sidecar folder inside greenroom-guests");
                return false;
            }
            if (!Directory.Exists(Path.Combine(BUNDLE, "node_modules")))
            {
                CPH.LogWarn("[Discord Bridge Start] node_modules is missing in " + BUNDLE + " — run 'npm install' in the sidecar folder once, or run start-discord-bridge.bat once, then try again");
                return false;
            }

            // node.exe: the full path when it can be found (a Node installed after Streamer.bot started is not on its PATH), else "node".
            string node = FindNode();
            Process p = null;
            try
            {
                p = Launch(node ?? "node");
            }
            catch (Win32Exception w)
            {
                if (w.NativeErrorCode != 2) throw;
                // not found: look again (Node may have been installed meanwhile), and retry with the full path if there is one now
                string again = FindNode();
                if (again == null) throw;
                p = Launch(again);
            }

            // A bridge that is going to refuse to start (a missing package, Node too old, the guard port held) exits within a moment.
            if (p != null && p.WaitForExit(2000))
            {
                int code = p.ExitCode;
                if (code == 0)
                {
                    CPH.LogInfo("[Discord Bridge Start] bridge already running (the single-instance guard found one of the same version): nothing launched");
                    return true;
                }
                CPH.LogWarn("[Discord Bridge Start] bridge exited with code " + code + " — run start-discord-bridge.bat to see the error");
                return false;
            }
            CPH.LogInfo("[Discord Bridge Start] launched node discord-bridge.mjs in " + BUNDLE);
            return true;
        }
        catch (Win32Exception w2)
        {
            CPH.LogWarn("[Discord Bridge Start] ERROR: " + (w2.NativeErrorCode == 2
                ? "node was not found in Streamer.bot's PATH or the usual Node.js places — if you installed Node after starting Streamer.bot, restart Streamer.bot, or start the bridge with start-discord-bridge.bat"
                : w2.Message));
            return false;
        }
        catch (Exception ex)
        {
            CPH.LogWarn("[Discord Bridge Start] ERROR: " + ex.Message +
                " — is BUNDLE set to the sidecar folder? (node not found: restart Streamer.bot after installing Node, or use start-discord-bridge.bat)");
            return false;
        }
    }

    // Starts node discord-bridge.mjs hidden. UseShellExecute stays true (see the header).
    static Process Launch(string fileName)
    {
        var psi = new ProcessStartInfo();
        psi.FileName = fileName;
        psi.Arguments = "discord-bridge.mjs";
        psi.WorkingDirectory = BUNDLE;
        psi.UseShellExecute = true; // do NOT inherit SB's listen sockets (see header)
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        return Process.Start(psi);
    }

    // Where a Node installation is: the installer's registry key, then Program Files, then the Machine and User PATH (read fresh, not
    // from Streamer.bot's own copy). nvm-windows, volta and fnm are not covered. Only reads the registry and the file system.
    static string FindNode()
    {
        foreach (RegistryView view in new RegistryView[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            try
            {
                using (RegistryKey hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                using (RegistryKey key = hklm.OpenSubKey(@"SOFTWARE\Node.js"))
                {
                    string dir = key == null ? null : key.GetValue("InstallPath") as string;
                    if (!string.IsNullOrEmpty(dir))
                    {
                        string exe = Path.Combine(dir, "node.exe");
                        if (File.Exists(exe)) return exe;
                    }
                }
            }
            catch (Exception) { /* no such key or view */ }
        }
        foreach (string root in new string[] { Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("ProgramW6432"), Environment.GetEnvironmentVariable("ProgramFiles(x86)") })
        {
            if (string.IsNullOrEmpty(root)) continue;
            string exe = Path.Combine(Path.Combine(root, "nodejs"), "node.exe");
            if (File.Exists(exe)) return exe;
        }
        foreach (EnvironmentVariableTarget scope in new EnvironmentVariableTarget[] { EnvironmentVariableTarget.Machine, EnvironmentVariableTarget.User })
        {
            string path = null;
            try { path = Environment.GetEnvironmentVariable("PATH", scope); } catch (Exception) { /* not readable */ }
            if (string.IsNullOrEmpty(path)) continue;
            foreach (string part in path.Split(';'))
            {
                string dir = part.Trim().Trim('"');
                if (dir.Length == 0) continue;
                try
                {
                    string exe = Path.Combine(Environment.ExpandEnvironmentVariables(dir), "node.exe");
                    if (File.Exists(exe)) return exe;
                }
                catch (Exception) { /* a bad entry in PATH */ }
            }
        }
        return null;
    }
}
