const http = require('http');
const fs   = require('fs');
const path = require('path');
const mqtt = require('mqtt');

// Start the MQTT broker — exports the actual ports in use
const { broker_port: MQTT_TCP_PORT, websocket_port: MQTT_WS_PORT } = require('./broker');

const HOST = 'localhost';
const PORT = Number(process.env.HTTP_PORT || 8080);

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
};

// Ensure PUBLIC_DIR ends with sep so startsWith check is exact
const PUBLIC_DIR = path.join(__dirname, '..', 'public') + path.sep;

const server = http.createServer((req, res) => {
  // Strip query string and get the URL pathname
  const urlPath = req.url.split('?')[0];

  // Serve dynamic config so the frontend always uses the correct MQTT WS port
  if (urlPath === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(`window.MQTT_WS_PORT = ${MQTT_WS_PORT};`);
    return;
  }

  // FILE PATH CORRECTION ======================================================
  // Resolve to a filesystem path — use the raw urlPath for the root check
  // (path.normalize converts '/' to '\' on Windows, breaking the === '/' test)
  const resolved = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const filePath = path.join(PUBLIC_DIR, resolved);

  // Prevent directory traversal — filePath must stay inside PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`🌐 Web UI available at http://${HOST}:${PORT}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Session Logger — see docs/session-logging.md
//
// Subscribes to robot/touch events and writes them to a per-session JSONL file
// while a session is active. Sessions are controlled by the web UI via
// session/begin and session/end topics. The logger broadcasts the current
// state on retained topic session/status so a fresh browser tab sees it.
// ─────────────────────────────────────────────────────────────────────────────

const LOGS_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

let activeSession = null;   // { sessionId, filePath, startedTs } | null

function broadcastStatus(mqttClient) {
  const payload = activeSession
    ? JSON.stringify({ active: true, session_id: activeSession.sessionId, started_ts: activeSession.startedTs })
    : JSON.stringify({ active: false });
  mqttClient.publish('session/status', payload, { qos: 1, retain: true });
}

const logger = mqtt.connect(`mqtt://localhost:${MQTT_TCP_PORT}`, {
  clientId: 'session-logger-' + Math.random().toString(16).slice(2, 8),
  reconnectPeriod: 2000,
});

logger.on('connect', () => {
  console.log('📝 Session logger connected to local broker');
  logger.subscribe(['session/begin', 'session/end', 'robot/touch'], { qos: 1 });
  broadcastStatus(logger);  // clear any stale retained status from a previous run
});

logger.on('error', (err) => console.error('❌ Session logger MQTT error:', err.message));

logger.on('message', (topic, message) => {
  if (topic === 'session/begin') {
    let sessionId;
    try {
      sessionId = JSON.parse(message.toString()).session_id;
    } catch (e) {
      console.error('Invalid session/begin payload:', e.message);
      return;
    }
    if (!sessionId) return;
    if (activeSession) {
      console.log(`⚠️  Begin ignored — session ${activeSession.sessionId} already active`);
      broadcastStatus(logger);  // re-broadcast so any out-of-sync tabs converge
      return;
    }
    const filePath = path.join(LOGS_DIR, `session-${sessionId}.jsonl`);
    activeSession = { sessionId, filePath, startedTs: Date.now() };
    fs.appendFileSync(filePath, '');  // ensure the file exists, even with zero events
    console.log(`▶️  Session begin: ${sessionId} → ${filePath}`);
    broadcastStatus(logger);
    return;
  }

  if (topic === 'session/end') {
    if (!activeSession) {
      broadcastStatus(logger);
      return;
    }
    console.log(`⏹️  Session end: ${activeSession.sessionId}`);
    activeSession = null;
    broadcastStatus(logger);
    return;
  }

  if (topic === 'robot/touch') {
    if (!activeSession) return;
    let event;
    try {
      event = JSON.parse(message.toString());
    } catch (e) {
      return;
    }
    const line = JSON.stringify({
      ts:         event.ts || Date.now(),
      session_id: activeSession.sessionId,
      source:     'nxt_touch',
      note:       event.note,
      nxt:        event.nxt,
      port:       event.port,
    }) + '\n';
    fs.appendFile(activeSession.filePath, line, (err) => {
      if (err) console.error('Log append error:', err.message);
    });
  }
});
