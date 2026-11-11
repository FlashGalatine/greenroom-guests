// Does a Greenroom bridge answer on the single-instance guard port? Exits 0 if one does, 1 if nothing does. start-discord-bridge.bat runs it before it
// installs packages, because a running bridge has its packages loaded and an install under it would leave node_modules half deleted.
// Arguments are the launcher's own: --guard-port=N wins over GREENROOM_GUARD_PORT, the default is 7495. It only reads the banner (it sends nothing).
import { connect } from 'node:net';

const arg = process.argv.slice(2).map((a) => /^--guard-port=(\d+)$/.exec(a)).find(Boolean);
const port = Number(arg ? arg[1] : process.env.GREENROOM_GUARD_PORT) || 7495;
const s = connect(port, '127.0.0.1');
let buf = '';
const done = (code) => { try { s.destroy(); } catch { /* gone */ } process.exit(code); };
setTimeout(() => done(1), 700);
s.setEncoding('utf8');
s.on('error', () => done(1));
s.on('data', (d) => {
  buf += d;
  const nl = buf.indexOf('\n');
  if (nl < 0 && buf.length < 300) return;
  try { const b = JSON.parse(buf.slice(0, nl < 0 ? buf.length : nl)); done(b && b.name === 'greenroom-bridge' ? 0 : 1); } catch { done(1); }
});
