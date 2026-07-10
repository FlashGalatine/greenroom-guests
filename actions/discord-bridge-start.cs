// Streamer.bot "Discord Bridge Start" action (OPTIONAL) — launches the Discord
// bridge sidecar hidden, so SB can auto-start it. Webcam-only setups skip this
// action entirely; you can also just double-click start-discord-bridge.bat instead.
//
// HOW TO USE (docs/STREAMERBOT-SETUP.md has the full walkthrough):
//   1. EDIT THE `BUNDLE` CONST BELOW to your Greenroom sidecar folder.
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
// orphaned bridge after an unclean SB exit keeps those ports bound and SB cannot
// restart its servers until the child is killed.
//
// Running it twice is harmless: the bridge binds a single-instance guard port
// (:7495) — a second instance logs and exits. Requires node.exe on PATH (Node >= 22.12).

using System;
using System.Diagnostics;

public class CPHInline
{
    // EDIT ME — absolute path to the Greenroom sidecar folder.
    const string BUNDLE = @"D:\StreamerGraphics\StreamerBotComponents\Greenroom\sidecar";

    public bool Execute()
    {
        try
        {
            var psi = new ProcessStartInfo();
            psi.FileName = "node";
            psi.Arguments = "discord-bridge.mjs";
            psi.WorkingDirectory = BUNDLE;
            psi.UseShellExecute = true; // do NOT inherit SB's listen sockets (see header)
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(psi);
            CPH.LogInfo("[Discord Bridge Start] launched node discord-bridge.mjs in " + BUNDLE);
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogWarn("[Discord Bridge Start] ERROR: " + ex.Message +
                " — is node on PATH, and is BUNDLE set to the sidecar folder?");
            return false;
        }
    }
}
