// A listener that must never be spoken to. Point SB_WS_URL (or anything else that should not be used) at it, run a
// harness, and then look at the log: any line starting "FRAME" or "ERROR" means something sent it data (ERROR: a frame the
// WebSocket layer rejected, which is still data). A bare "CONNECT" is a connection that sent nothing.
//
//   node tools/sentinel.mjs <port> [log-file]        (port 0 = pick a free one; the chosen port is printed as "PORT <n>")
//
// It is a WebSocket server on 127.0.0.1 that greets nobody and answers nothing. Every connection, frame and error is logged,
// each line appended to the log file at once, so the log survives the process being killed. When it is stopped with Ctrl+C
// (or a signal) it logs a final "VERDICT clean" or "VERDICT HIT" line and exits 1 on a hit. It never reads, sends or opens
// anything else.

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

let connections = 0, frames = 0, errors = 0;
const verdict = () => log(`VERDICT ${frames || errors ? 'HIT' : 'clean'} connections=${connections} frames=${frames} errors=${errors}`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { verdict(); process.exit(frames || errors ? 1 : 0); });

const wss = new WebSocketServer({ host: '127.0.0.1', port });
wss.on('error', (e) => { console.error('sentinel: ' + e.message); process.exit(2); });
wss.on('listening', () => log(`PORT ${wss.address().port}`));
wss.on('connection', (ws) => {
  connections++;
  log('CONNECT');
  ws.on('message', (raw) => { frames++; log('FRAME ' + raw.toString().replace(/\s+/g, ' ').slice(0, 200)); });
  ws.on('error', (e) => { errors++; log('ERROR ' + (e.code || e.message)); });
});
