// ============================================================
// Dev launcher — starts the whole stack with one command:
//   npm run all   →  broker + server + bridge + note-reader
//
// Dependency-free. Broker comes up first; the others reconnect on their own,
// so exact ordering isn't critical. Ctrl+C stops everything (whole process
// trees, so a Python-spawned Audiveris is cleaned up too).
// ============================================================
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// label, color, command, args, and how long to wait before launching (ms)
const C = { reset: '\x1b[0m' };
const PROCS = [
  { name: 'broker',      color: '\x1b[35m', cmd: process.execPath, args: ['src/broker.js'],      delay: 0    },
  { name: 'server',      color: '\x1b[36m', cmd: process.execPath, args: ['src/server.js'],      delay: 800  },
  { name: 'bridge',      color: '\x1b[33m', cmd: process.execPath, args: ['src/nxt_bridge.js'],  delay: 800  },
  // -u: unbuffered, so Python logs stream live through the pipe instead of
  // block-buffering (which they do when stdout isn't a terminal).
  { name: 'note-reader', color: '\x1b[32m', cmd: 'python',         args: ['-u', 'note-reader/main.py'], delay: 1200 },
];

const children = [];
let shuttingDown = false;

function prefixWrite(name, color, stream, chunk) {
  const tag = `${color}[${name}]${C.reset} `;
  // Prefix every non-empty line so interleaved output stays readable.
  chunk.toString().split(/\r?\n/).forEach((line, i, arr) => {
    if (line === '' && i === arr.length - 1) return;  // trailing newline
    stream.write(tag + line + '\n');
  });
}

function launch(p) {
  const child = spawn(p.cmd, p.args, {
    cwd: ROOT,
    env: process.env,
    shell: false,
    windowsHide: true,
  });
  children.push({ name: p.name, child });

  child.stdout.on('data', (d) => prefixWrite(p.name, p.color, process.stdout, d));
  child.stderr.on('data', (d) => prefixWrite(p.name, p.color, process.stderr, d));

  child.on('error', (err) => {
    prefixWrite(p.name, p.color, process.stderr, `failed to start: ${err.message}`);
    if (p.name === 'note-reader' && err.code === 'ENOENT') {
      prefixWrite(p.name, p.color, process.stderr,
        "is 'python' on your PATH? Try 'py' or a full path if not.");
    }
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    prefixWrite(p.name, p.color, process.stdout,
      `exited (${signal || 'code ' + code}). Other processes keep running; Ctrl+C to stop all.`);
  });
}

function killChild(name, child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Kill the whole tree (e.g. Python → Audiveris) — SIGTERM won't reach it.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write('\n\x1b[31m[launcher]\x1b[0m stopping all processes...\n');
  children.forEach(({ name, child }) => killChild(name, child));
  setTimeout(() => process.exit(0), 800);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.stdout.write('\x1b[31m[launcher]\x1b[0m starting broker + server + bridge + note-reader (Ctrl+C to stop)\n');
PROCS.forEach((p) => setTimeout(() => launch(p), p.delay));
