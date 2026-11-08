// A listener that must never be spoken to. Point SB_WS_URL (or anything else that should not be used) at it, run a
// harness, and then look at the log: any line starting "FRAME" means something sent it data.
//
//   node tools/sentinel.mjs <port> [log-file]        (port 0 = pick a free one; the chosen port is printed as "PORT <n>")
//
// It is a WebSocket server on 127.0.0.1 that greets nobody and answers nothing. Every connection is logged ("CONNECT"),
// every frame received is logged ("FRAME <text>"), each line appended to the log file at once, so the log survives
// the process being killed. It never reads, sends or opens anything else. Stop it with Ctrl+C or by killing it.

import { WebSocketServer } from 'ws';
import { appendFileSync, writeFileSync } from 'node:fs';

const port = Number(process.argv[2]);
const logFile = process.argv[3] || '';
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('usage: node tools/sentinel.mjs <port> [log-file]');
  process.exit(2);
}
const log = (line) => { console.log(line); if (logFile) { try { appendFileSync(logFile, line + '\n'); } catch {} } };
if (logFile) writeFileSync(logFile, '');

const wss = new WebSocketServer({ host: '127.0.0.1', port });
wss.on('error', (e) => { console.error('sentinel: ' + e.message); process.exit(2); });
wss.on('listening', () => log(`PORT ${wss.address().port}`));
wss.on('connection', (ws) => {
  log('CONNECT');
  ws.on('message', (raw) => log('FRAME ' + raw.toString().slice(0, 200)));
  ws.on('error', () => {});
});
