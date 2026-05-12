const http = require('http');
const fs   = require('fs');
const path = require('path');

// Start the MQTT broker — exports the actual ports in use
const { websocket_port: MQTT_WS_PORT } = require('./broker');

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
