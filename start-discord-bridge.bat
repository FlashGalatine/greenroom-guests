@echo off
rem Greenroom - Discord bridge launcher (visible log window; close it to stop).
rem The bridge can also be started hidden from Streamer.bot via the optional
rem "Discord Bridge Start" action (actions/discord-bridge-start.cs), or with
rem `npm run bridge` from the repo root. Running it twice is harmless - the
rem second instance sees the single-instance guard port and exits (a NEWER build replaces an
rem older one). Options can be added to the node line below: --sb-ws-url=ws://127.0.0.1:8080/
rem --guard-port=7495 --exit-on-sb-close=1 (an argument wins over the environment variable).
rem No %~dp0 (the folder of this file) inside a (...) block anywhere: a ")" in that path would end the block early.
cd /d "%~dp0sidecar"
if errorlevel 1 goto nocd
rem UTF-8 for the console, so the log's dashes and accents are not garbled
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 goto nonode
rem The dependencies are (re)installed when they are missing, when one of the three the bridge needs cannot be found, or when
rem package-lock.json is not the one the last good install used (a copy is kept inside node_modules after each good install).
set NEED_INSTALL=
if not exist node_modules set NEED_INSTALL=1
if not defined NEED_INSTALL node -e "for (const m of ['ws','discord.js','@discordjs/voice']) require.resolve(m)" >nul 2>nul || set NEED_INSTALL=1
if not defined NEED_INSTALL fc /b package-lock.json node_modules\.greenroom-package-lock.json >nul 2>nul || set NEED_INSTALL=1
if not defined NEED_INSTALL goto run
rem A bridge that is running has its packages loaded (Windows cannot delete a loaded native file, and npm would leave node_modules half
rem deleted): never install under a running bridge. guard-probe.mjs exits 0 when one answers on the guard port.
node guard-probe.mjs %* && goto running
echo Installing the discord.js stack into sidecar\node_modules ...
rem npm can fail with a negative exit code, which "if errorlevel 1" does not see: test the call itself.
call npm ci --no-fund || goto npmfail
copy /y package-lock.json node_modules\.greenroom-package-lock.json >nul
:run
echo Do not click in this window: a click starts a text selection that freezes the console (the title shows Select). Press Esc if it does.
node discord-bridge.mjs %*
pause
exit /b 0
:nocd
echo Could not open the sidecar folder next to this file: "%~dp0sidecar"
pause
exit /b 1
:nonode
echo Node.js not found on PATH. Install Node ^>= 22.12 from https://nodejs.org/
pause
exit /b 1
:running
echo A Greenroom bridge is running, and its packages need installing or updating first. Close the bridge's window (or send it the quit command), then start this again.
pause
exit /b 1
:npmfail
echo npm ci failed - see the output above.
pause
exit /b 1
