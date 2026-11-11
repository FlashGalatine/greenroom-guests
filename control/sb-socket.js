// Greenroom: where control.html and director-min.html open their Streamer.bot WebSocket (both load it from this folder).
//
// Why this is a file of its own: when a connect fails (Streamer.bot not running yet, restarting, closed), Chromium logs
// "WebSocket connection to '…' failed" by itself, at error level, and gives as the message's source the script that
// constructed the socket. For a socket built in a page's inline script that source is the page's own address, query
// included, and both pages can carry ?sbpass=<password>; obs-browser writes error-level console messages to the OBS log
// with their source. Built here, the source is this file's address, which has no query. The overlays get the same from
// overlay/panel-client-sb.js. verify.mjs fails if a page that can carry ?sbpass constructs a WebSocket in an inline
// script, and verify-render R22l checks the source of the real message.

(function () {
  'use strict';
  // Throws as `new WebSocket` does (a bad address, say): the callers catch it.
  globalThis.sbOpenSocket = function sbOpenSocket(url) { return new WebSocket(url); };
})();
