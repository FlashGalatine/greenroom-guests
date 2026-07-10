@echo off
rem Greenroom - Discord bridge launcher (visible log window; close it to stop).
rem The bridge can also be started hidden from Streamer.bot via the optional
rem "Discord Bridge Start" action (actions/discord-bridge-start.cs), or with
rem `npm run bridge` from the repo root. Running it twice is harmless - the
rem second instance sees the single-instance guard port and exits.
cd /d "%~dp0sidecar"
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
node discord-bridge.mjs
pause
