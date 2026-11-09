@echo off
rem Greenroom - Discord bridge launcher (visible log window; close it to stop).
rem The bridge can also be started hidden from Streamer.bot via the optional
rem "Discord Bridge Start" action (actions/discord-bridge-start.cs), or with
rem `npm run bridge` from the repo root. Running it twice is harmless - the
rem second instance sees the single-instance guard port and exits (a NEWER build replaces an
rem older one). Options can be added to the node line below: --sb-ws-url=ws://127.0.0.1:8080/
rem --guard-port=7495 --exit-on-sb-close=1 (an argument wins over the environment variable).
cd /d "%~dp0sidecar"
rem UTF-8 for the console, so the log's dashes and accents are not garbled
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found on PATH. Install Node ^>= 22.12 from https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing the discord.js stack into sidecar\node_modules ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed - see the output above.
    pause
    exit /b 1
  )
)
echo Do not click in this window: a click starts a text selection that freezes the console (the title shows Select). Press Esc if it does.
node discord-bridge.mjs %*
pause
