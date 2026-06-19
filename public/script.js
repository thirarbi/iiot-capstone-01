// ============================================================
// MQTT Configuration
// Uses the current page's hostname so it works on any machine.
// Override by setting window.MQTT_HOST before this script loads.
// ============================================================
// Use saved broker from settings, falling back to page hostname

var hostname = window.MQTT_HOST ||
               (typeof localStorage !== 'undefined' && localStorage.getItem('nxt_broker')) ||
               window.location.hostname ||
               'localhost';
var port     = window.MQTT_WS_PORT || 8883;
var topic       = 'robot/nada';
var topicStrike = 'robot/strike';

var mqttClient = createClient(hostname);
connect();

function createClient(host) {
  var id = 'PianoTiles_' + Math.random().toString(16).substr(2, 8);
  var c = new Paho.MQTT.Client(host, Number(port), id);
  c.onMessageArrived = onMessageArrived;
  c.onConnectionLost = onConnectionLost;
  return c;
}

function reconnectToBroker(newHost) {
  hostname = newHost;
  try { if (mqttClient.isConnected()) mqttClient.disconnect(); } catch (e) {}
  mqttClient = createClient(hostname);
  connect();
}

// ============================================================
// Connection Management
// ============================================================
function connect() {
  mqttClient.connect({
    onSuccess: onConnected,
    onFailure: onConnectionFailed
  });
}

function onConnected() {
  mqttClient.subscribe(topic);
  mqttClient.subscribe(topicStrike);
  mqttClient.subscribe('robot/score');
  mqttClient.subscribe('robot/touch');
  mqttClient.subscribe('robot/hold');      // manual press-and-hold (flow + latency)
  mqttClient.subscribe('robot/latency');   // bridge-measured NXT strike-confirm latency
  mqttClient.subscribe('convert/status');  // live PDF→OMR→main.py conversion progress
  mqttClient.subscribe('score/mode');      // retained delivery-mode selection
  mqttClient.subscribe('score/status');    // note-reader service state (idle/ready/playing)

  mqttClient.subscribe('session/status');
  mqttClient.subscribe('health/bridge');   // Industrial Monitor — health dashboard
  mqttClient.subscribe('health/server');
  setStatus(true);
  log('Connected to broker at ' + hostname + ':' + port, 'system');
  // Seed the retained mode so main.py reads the same value the UI shows,
  // even if the broker restarted and lost its retained state.
  publishScoreModeRetained(scoreMode);
}

function onConnectionFailed(err) {
  setStatus(false);
  log('Connection failed: ' + err.errorMessage, 'system');
  setTimeout(connect, 3000);
}

function onConnectionLost(resp) {
  setStatus(false);
  if (resp.errorCode !== 0) {
    log('Connection lost: ' + resp.errorMessage, 'system');
    setTimeout(connect, 3000);
  }
}

// ============================================================
// Incoming Messages
//  robot/nada   — a note command was published (log only)
//  robot/strike — the bridge confirmed the motor actually fired
//                 → triggers key highlight + Now Playing
// ============================================================

function onMessageArrived(message) {
  var payload = message.payloadString;
  // Feed every message to the Industrial Monitor (it decides relevance)
  Monitor.handleMessage(message.destinationName, payload);
  if (message.destinationName === topicStrike) {
    log('Motor hit: ' + payload, 'received');
    highlightKey(payload);
    showNowPlaying(payload);
  } else if (message.destinationName === 'robot/touch') {
    try {
      var ev = JSON.parse(payload);
      log('Touch: ' + ev.note + ' (NXT-' + ev.nxt + ' port ' + ev.port + ')', 'received');
      highlightKey(ev.note);
      showNowPlaying(ev.note);
    } catch (e) {}
  } else if (message.destinationName === 'session/status') {
    try {
      applySessionStatus(JSON.parse(payload));
    } catch (e) {}
  } else if (message.destinationName === 'robot/score') {
    try {
      var score = JSON.parse(payload);
      log('Score diterima: "' + score.title + '" \u2014 ' + score.notes.length + ' nada', 'system');
    } catch (e) {}
  } else if (message.destinationName === 'robot/hold') {
    // Already logged locally on press; Monitor.handleMessage drove the flow/latency.
  } else if (message.destinationName === 'robot/latency') {
    // Monitor.handleMessage recorded the sample; nothing to log per-note.
  } else if (message.destinationName === 'score/mode') {
    renderScoreMode(payload.replace(/"/g, '').trim());
  } else if (message.destinationName === 'score/status') {
    try { renderPlaybackStatus(JSON.parse(payload)); } catch (e) {}
  } else if (message.destinationName === 'convert/status') {
    try {
      var prog = JSON.parse(payload);
      if (prog.state === 'active') {
        var STAGE_LABELS = { src: 'PDF / Score', omr: 'Audiveris OMR', pub: 'main.py' };
        log('Converting: ' + (STAGE_LABELS[prog.stage] || prog.stage)
            + (prog.detail ? ' \u2014 ' + prog.detail : ''), 'system');
      }
    } catch (e) {}
  } else {
    log('Command: ' + payload, 'system');
  }
}

// ============================================================
// Manual input — press / hold / release
//   A key press holds the motor down for as long as the key (mouse or
//   keyboard) is held, and only retracts on release. The bridge receives
//   { note, action } on robot/hold and never re-strikes while held, so a
//   held key stays put instead of oscillating in and out.
//   sendNote() (robot/nada discrete click) is kept for compatibility.
// ============================================================
var manualHeld = {};  // note -> true while pressed

function publishHold(note, action) {
  if (!mqttClient.isConnected()) {
    log('Not connected to broker', 'system');
    return false;
  }
  var msg = new Paho.MQTT.Message(JSON.stringify({ note: note, action: action }));
  msg.destinationName = 'robot/hold';
  mqttClient.send(msg);
  return true;
}

function beginPress(note) {
  if (manualHeld[note]) return;            // already down — ignore key auto-repeat
  if (!publishHold(note, 'press')) return;
  manualHeld[note] = true;
  var keyEl = document.querySelector('.key[data-note="' + note + '"]');
  if (keyEl) keyEl.classList.add('active');
  log('Press: ' + note, 'sent');
}

function endPress(note) {
  if (!manualHeld[note]) return;
  manualHeld[note] = false;
  publishHold(note, 'release');
  var keyEl = document.querySelector('.key[data-note="' + note + '"]');
  if (keyEl) keyEl.classList.remove('active');
}

// Discrete single click (robot/nada) — retained for compatibility / external use
function sendNote(note) {
  if (!mqttClient.isConnected()) {
    log('Not connected to broker', 'system');
    return;
  }
  var message = new Paho.MQTT.Message(note);
  message.destinationName = topic;
  mqttClient.send(message);
  log('Sent: ' + note, 'sent');
}

// Wire the on-screen piano keys to press/release (mouse + touch)
document.querySelectorAll('.key').forEach(function (btn) {
  var note = btn.getAttribute('data-note');
  btn.addEventListener('mousedown',  function (e) { e.preventDefault(); beginPress(note); });
  btn.addEventListener('mouseup',    function ()  { endPress(note); });
  btn.addEventListener('mouseleave', function ()  { endPress(note); });
  btn.addEventListener('touchstart', function (e) { e.preventDefault(); beginPress(note); }, { passive: false });
  btn.addEventListener('touchend',   function (e) { e.preventDefault(); endPress(note); });
  btn.addEventListener('touchcancel',function ()  { endPress(note); });
});

// ============================================================
// UI Helpers
// ============================================================
function highlightKey(note) {
  var keyEl = document.querySelector('.key[data-note="' + note + '"]');
  if (!keyEl) return;
  keyEl.classList.add('active');
  // Don't auto-remove while the key is being held down (manual press-and-hold)
  if (!manualHeld[note]) {
    setTimeout(function () {
      if (!manualHeld[note]) keyEl.classList.remove('active');
    }, 350);
  }
}

function showNowPlaying(note) {
  var el = document.getElementById('nowPlaying');
  el.textContent = note;
  setTimeout(function () { el.textContent = '\u2014'; }, 800);
}

function setStatus(connected) {
  var el = document.getElementById('status');
  el.textContent = connected ? 'Connected' : 'Disconnected';
  el.className = 'status ' + (connected ? 'connected' : 'disconnected');
  Monitor.setConnection(connected);  // drives the health dashboard's broker/browser rows
}

function log(msg, type) {
  var logEl = document.getElementById('log');
  var entry = document.createElement('div');
  entry.className = type || '';
  var time = new Date().toLocaleTimeString();
  entry.textContent = '[' + time + '] ' + msg;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

// ============================================================
// Keyboard Input
// ============================================================
var KEY_MAP = {
  'a': 'DO',
  's': 'RE',
  'd': 'MI',
  'f': 'FA',
  'g': 'SOL',
  'h': 'LA',
  'j': 'SI',
  'k': 'DO_TINGGI'
};

document.addEventListener('keydown', function (e) {
  // Ignore when typing in an input / textarea
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.repeat) return;  // ignore OS auto-repeat — the motor is already held
  var note = KEY_MAP[e.key.toLowerCase()];
  if (!note) return;
  beginPress(note);
});

document.addEventListener('keyup', function (e) {
  var note = KEY_MAP[e.key.toLowerCase()];
  if (!note) return;
  endPress(note);
});

// If focus is lost while a key is held (alt-tab, etc.), release everything so
// no motor is left pressed.
window.addEventListener('blur', function () {
  Object.keys(manualHeld).forEach(function (note) {
    if (manualHeld[note]) endPress(note);
  });
});

// ============================================================
// Settings Panel
// ============================================================
function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  localStorage.setItem('nxt_theme', theme);
  document.querySelectorAll('input[name="theme"]').forEach(function (r) {
    r.checked = (r.value === theme);
  });
}

(function initSettings() {
  var panel    = document.getElementById('settings-panel');
  var openBtn  = document.getElementById('settings-btn');
  var closeBtn = document.getElementById('settings-close');

  // Restore saved theme
  var savedTheme  = (typeof localStorage !== 'undefined' && localStorage.getItem('nxt_theme')) || 'neon';
  var savedBroker = (typeof localStorage !== 'undefined' && localStorage.getItem('nxt_broker')) || '';
  applyTheme(savedTheme);
  if (savedBroker) document.getElementById('broker-input').value = savedBroker;

  // Toggle panel
  openBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    panel.classList.toggle('open');
  });
  closeBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    panel.classList.remove('open');
  });
  document.addEventListener('click', function (e) {
    if (!panel.contains(e.target) && e.target !== openBtn) {
      panel.classList.remove('open');
    }
  });

  // Theme radio buttons
  document.querySelectorAll('input[name="theme"]').forEach(function (radio) {
    radio.addEventListener('change', function () { applyTheme(this.value); });
  });

  // Broker apply
  document.getElementById('broker-apply').addEventListener('click', function () {
    var newHost = document.getElementById('broker-input').value.trim();
    if (!newHost) return;
    localStorage.setItem('nxt_broker', newHost);
    log('Reconnecting to broker at ' + newHost + '...', 'system');
    reconnectToBroker(newHost);
    panel.classList.remove('open');
  });
})();

// ============================================================
// Score delivery mode — see docs/score-delivery-modes.md
//   Picks how note-reader/main.py sends a song:
//     stream   — one note per read, in real time (per-note latency is visible)
//     compiled — send the whole score once, the NXT bridge plays it locally
//   Published retained on score/mode so main.py reads the current choice at
//   startup and any other tab stays in sync.
// ============================================================
var scoreMode = (typeof localStorage !== 'undefined' && localStorage.getItem('nxt_score_mode')) || 'compiled';

var MODE_HINTS = {
  stream:   'main.py streams each note live → watch the latency panel.',
  compiled: 'main.py sends the whole score once → near-zero per-note latency.'
};

function renderScoreMode(mode) {
  if (mode !== 'stream' && mode !== 'compiled') return;
  scoreMode = mode;
  if (typeof localStorage !== 'undefined') localStorage.setItem('nxt_score_mode', mode);
  document.querySelectorAll('.mode-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-mode') === mode);
  });
  var hint = document.getElementById('mode-hint');
  if (hint) hint.textContent = MODE_HINTS[mode] || '';
}

function publishScoreModeRetained(mode) {
  if (mode !== 'stream' && mode !== 'compiled') return false;
  if (!mqttClient.isConnected()) return false;
  var msg = new Paho.MQTT.Message(mode);
  msg.destinationName = 'score/mode';
  msg.qos = 1;
  msg.retained = true;   // so main.py sees it whenever it next runs
  mqttClient.send(msg);
  return true;
}

function setScoreMode(mode) {
  if (mode !== 'stream' && mode !== 'compiled') return;
  renderScoreMode(mode);
  if (publishScoreModeRetained(mode)) {
    log('Score send mode → ' + mode, 'system');
  } else {
    log('Not connected — mode saved, will publish on connect', 'system');
  }
}

document.querySelectorAll('.mode-btn').forEach(function (btn) {
  btn.addEventListener('click', function () { setScoreMode(btn.getAttribute('data-mode')); });
});
renderScoreMode(scoreMode);  // reflect saved choice until the retained value arrives

// ============================================================
// Playback control — drives the note-reader service
//   Convert once, then Play / Stop on demand (no Audiveris re-run between
//   plays). State comes back on retained score/status. See
//   docs/score-delivery-modes.md.
// ============================================================
var PB_LABELS = {
  idle:       'No score loaded',
  converting: 'Converting…',
  ready:      'Ready',
  playing:    'Playing…'
};

function renderPlaybackStatus(s) {
  s = s || {};
  var statusEl = document.getElementById('pb-status');
  var playBtn  = document.getElementById('btn-play');
  var convBtn  = document.getElementById('btn-convert');
  var stopBtn  = document.getElementById('btn-stop');
  if (!statusEl) return;

  var state = s.state || 'idle';
  var text  = PB_LABELS[state] || state;
  if (s.title)  text += ' · ' + s.title + (s.notes ? ' (' + s.notes + ' notes)' : '');
  if (s.error)  text += ' · ⚠ ' + s.error;
  statusEl.textContent = text;

  var converting = state === 'converting';
  var playing    = state === 'playing';
  if (convBtn) convBtn.disabled = converting || playing;
  if (playBtn) playBtn.disabled = converting || playing || !s.notes;
  if (stopBtn) stopBtn.disabled = !playing;
}

function publishCmd(topic, payload) {
  if (!mqttClient.isConnected()) { log('Not connected to broker', 'system'); return; }
  var msg = new Paho.MQTT.Message(payload || '');
  msg.destinationName = topic;
  msg.qos = 1;
  mqttClient.send(msg);
}

(function initPlayback() {
  var convBtn = document.getElementById('btn-convert');
  var playBtn = document.getElementById('btn-play');
  var stopBtn = document.getElementById('btn-stop');
  if (convBtn) convBtn.addEventListener('click', function () {
    publishCmd('score/convert', ''); log('Re-convert requested', 'sent');
  });
  if (playBtn) playBtn.addEventListener('click', function () {
    publishCmd('score/play', JSON.stringify({ mode: scoreMode }));
    log('Play (' + scoreMode + ')', 'sent');
  });
  if (stopBtn) stopBtn.addEventListener('click', function () {
    publishCmd('score/stop', ''); log('Stop requested', 'sent');
  });
  // Until the service publishes its retained status, assume it's offline and
  // disable the controls. They light up the moment a score/status arrives.
  if (convBtn) convBtn.disabled = true;
  if (playBtn) playBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = true;
})();

// ============================================================
// Session Recording — see docs/session-logging.md
// State is owned by the logger (server.js) and broadcast over
// retained topic session/status. We only render what we receive.
// ============================================================
var sessionActive = false;

function generateSessionId() {
  var d = new Date();
  var pad = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear()
       + pad(d.getMonth() + 1)
       + pad(d.getDate())
       + '-'
       + pad(d.getHours())
       + pad(d.getMinutes())
       + pad(d.getSeconds());
}

function applySessionStatus(status) {
  sessionActive = !!status.active;
  var btn   = document.getElementById('session-toggle');
  var label = document.getElementById('session-label');
  var info  = document.getElementById('session-info');
  if (!btn) return;
  btn.setAttribute('data-state', sessionActive ? 'active' : 'idle');
  label.textContent = sessionActive ? 'End Session' : 'Begin Session';
  if (sessionActive && status.session_id) {
    info.textContent = 'recording → session-' + status.session_id + '.jsonl';
    log('Session started: ' + status.session_id, 'system');
  } else if (!sessionActive) {
    if (info.textContent) log('Session ended', 'system');
    info.textContent = '';
  }
}

function toggleSession() {
  if (!mqttClient.isConnected()) {
    log('Not connected to broker', 'system');
    return;
  }
  var topic   = sessionActive ? 'session/end' : 'session/begin';
  var payload = JSON.stringify({
    session_id: sessionActive ? undefined : generateSessionId(),
  });
  var msg = new Paho.MQTT.Message(payload);
  msg.destinationName = topic;
  msg.qos = 1;
  mqttClient.send(msg);
}

// ============================================================
// Industrial Monitor — see docs/visualizations.md
// Four live views, all driven by the MQTT bus (no extra deps):
//   1. Live data-flow diagram  (robot/score · robot/nada · robot/strike · robot/touch)
//   3. Latency histogram        (robot/latency — NXT command→ack round-trip)
//   4. Per-NXT motor heatmap     (robot/strike, mapped via NOTE_MAP)
//   7. Health dashboard          (health/bridge · health/server · connection state)
// ============================================================
var Monitor = (function () {
  'use strict';

  // Mirror of NOTE_MAP / NXT_DEVICES in src/nxt_bridge.js — keep in sync.
  var NOTE_MAP = {
    DO:  { nxt: 0, port: 0 }, RE:  { nxt: 0, port: 1 }, MI: { nxt: 0, port: 2 },
    FA:  { nxt: 1, port: 0 }, SOL: { nxt: 1, port: 1 }, LA: { nxt: 1, port: 2 },
    SI:  { nxt: 2, port: 0 }, DO_TINGGI: { nxt: 2, port: 1 }
  };
  var NXT_NAMES  = ['NXT-1', 'NXT-3', 'NXT-4'];  // mirrors NXT_DEVICES order
  var PORT_NAMES = ['A', 'B', 'C'];              // motor ports 0/1/2
  var STALE_MS   = 8000;                          // heartbeat older than this → stale
  var SCORE_TTL  = 15000;                         // note-reader considered active within this

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---- 1. Data flow ----------------------------------------------------
  var FLOW_NODES = [
    { id: 'src',    label: 'PDF / Score' },
    { id: 'omr',    label: 'Audiveris OMR' },
    { id: 'pub',    label: 'main.py' },
    { id: 'broker', label: 'MQTT Broker' },
    { id: 'bridge', label: 'NXT Bridge' },
    { id: 'nxt',    label: 'NXT Robots' }
  ];
  // Each event animates a path of stages, in order, so a packet appears to flow.
  var FLOW_PATHS = {
    score:  ['src', 'omr', 'pub', 'broker', 'bridge', 'nxt'],
    nada:   ['ui', 'broker', 'bridge', 'nxt'],
    strike: ['bridge', 'nxt', 'ui'],
    touch:  ['nxt', 'bridge', 'broker', 'ui']
  };
  var FLOW_STEP = 130, FLOW_LINGER = 480;
  var nodeEls = {}, arrowEls = [], rowIndex = {};

  function buildFlow(container) {
    var wrap   = el('div');
    var row    = el('div', 'flow-row');
    FLOW_NODES.forEach(function (n, i) {
      rowIndex[n.id] = i;
      var node = el('div', 'flow-node', n.label);
      nodeEls[n.id] = node;
      row.appendChild(node);
      if (i < FLOW_NODES.length - 1) {
        var arrow = el('span', 'flow-arrow', '→');
        arrowEls[i] = arrow;
        row.appendChild(arrow);
      }
    });
    wrap.appendChild(row);

    var uiRow  = el('div', 'flow-ui');
    var uiNode = el('div', 'flow-node', 'Web UI');
    nodeEls.ui = uiNode;
    uiRow.appendChild(uiNode);
    uiRow.appendChild(el('span', 'flow-cap', '⇕ subscribe / publish via broker'));
    wrap.appendChild(uiRow);
    container.appendChild(wrap);
  }

  function lightNode(id, delay) {
    var node = nodeEls[id];
    if (!node) return;
    setTimeout(function () {
      node.classList.add('flow-on');
      setTimeout(function () { node.classList.remove('flow-on'); }, FLOW_LINGER);
    }, delay);
  }
  function lightArrow(idx, delay) {
    var a = arrowEls[idx];
    if (!a) return;
    setTimeout(function () {
      a.classList.add('flow-on');
      setTimeout(function () { a.classList.remove('flow-on'); }, FLOW_LINGER);
    }, delay);
  }
  // ---- Conversion progress (convert/status) ----------------------------
  // A persistent "processing" glow on whichever pipeline stage main.py says
  // is running right now (src → omr → pub), distinct from the transient
  // packet pulse above. Only one stage glows at a time.
  var processNode = null;
  function clearProcess() {
    if (processNode && nodeEls[processNode]) {
      nodeEls[processNode].classList.remove('flow-processing');
    }
    processNode = null;
  }
  function processFlow(stage, state) {
    clearProcess();
    if (state === 'active' && nodeEls[stage]) {
      nodeEls[stage].classList.add('flow-processing');
      processNode = stage;
    }
  }

  function pulseFlow(kind) {
    var path = FLOW_PATHS[kind];
    if (!path) return;
    for (var i = 0; i < path.length; i++) {
      lightNode(path[i], i * FLOW_STEP);
      if (i > 0) {
        var a = rowIndex[path[i - 1]], b = rowIndex[path[i]];
        if (a != null && b != null && Math.abs(a - b) === 1) {
          lightArrow(Math.min(a, b), (i - 0.5) * FLOW_STEP);
        }
      }
    }
  }

  // ---- 3. Latency histogram --------------------------------------------
  var LAT_BOUNDS = [50, 100, 150, 200, 300, 500];
  var LAT_LABELS = ['<50', '50-100', '100-150', '150-200', '200-300', '300-500', '>500'];
  var lat = { counts: [], last: null, min: null, max: null, sum: 0, n: 0 };
  var latBarEls = [], latStatEls = {};

  function buildLatency(container) {
    for (var i = 0; i < LAT_LABELS.length; i++) lat.counts[i] = 0;

    var stats = el('div', 'lat-stats');
    [['last', 'last'], ['avg', 'avg'], ['min', 'min'], ['max', 'max'], ['n', 'samples']].forEach(function (s) {
      var box = el('span');
      var val = el('b', null, '—');
      box.appendChild(val);
      box.appendChild(document.createTextNode(s[1]));
      latStatEls[s[0]] = val;
      stats.appendChild(box);
    });
    container.appendChild(stats);

    var bars = el('div', 'lat-bars');
    LAT_LABELS.forEach(function (label, i) {
      var wrap = el('div', 'lat-bar-wrap');
      var bar  = el('div', 'lat-bar');
      bar.title = label + ' ms';
      latBarEls[i] = bar;
      wrap.appendChild(bar);
      wrap.appendChild(el('div', 'lat-bar-label', label));
      bars.appendChild(wrap);
    });
    container.appendChild(bars);
  }

  function latBucket(ms) {
    for (var i = 0; i < LAT_BOUNDS.length; i++) if (ms < LAT_BOUNDS[i]) return i;
    return LAT_BOUNDS.length;
  }
  // Record a bridge-measured command→ack latency (robot/latency). Measured at
  // the bridge as time from sending the press to the NXT confirming receipt, so
  // it works the same in both delivery modes (compiled has no per-note MQTT
  // command to pair against on this side).
  function recordLatency(ms) {
    if (typeof ms !== 'number' || isNaN(ms) || ms < 0) return;
    lat.counts[latBucket(ms)]++;
    lat.last = ms;
    lat.min  = lat.min == null ? ms : Math.min(lat.min, ms);
    lat.max  = lat.max == null ? ms : Math.max(lat.max, ms);
    lat.sum += ms; lat.n++;
    renderLatency();
  }
  function renderLatency() {
    var max = 1;
    for (var i = 0; i < lat.counts.length; i++) max = Math.max(max, lat.counts[i]);
    for (var j = 0; j < latBarEls.length; j++) {
      latBarEls[j].style.height = (lat.counts[j] / max * 100) + '%';
      latBarEls[j].title = LAT_LABELS[j] + ' ms — ' + lat.counts[j];
    }
    latStatEls.last.textContent = lat.last == null ? '—' : lat.last + 'ms';
    latStatEls.avg.textContent  = lat.n ? Math.round(lat.sum / lat.n) + 'ms' : '—';
    latStatEls.min.textContent  = lat.min == null ? '—' : lat.min + 'ms';
    latStatEls.max.textContent  = lat.max == null ? '—' : lat.max + 'ms';
    latStatEls.n.textContent    = lat.n;
  }

  // ---- 4. Motor activity heatmap ---------------------------------------
  var heatCounts = {}, heatCells = {};

  function buildHeatmap(container) {
    var grid = el('div', 'heat-grid');
    grid.appendChild(el('div', 'heat-corner', ''));
    PORT_NAMES.forEach(function (p) { grid.appendChild(el('div', 'heat-head', 'Motor ' + p)); });

    for (var r = 0; r < NXT_NAMES.length; r++) {
      grid.appendChild(el('div', 'heat-rowlabel', NXT_NAMES[r]));
      for (var c = 0; c < PORT_NAMES.length; c++) {
        var note = noteAt(r, c);
        var cell = el('div', 'heat-cell' + (note ? '' : ' empty'));
        if (note) {
          cell.appendChild(el('div', 'hn', note === 'DO_TINGGI' ? "DO'" : note));
          var cnt = el('div', 'hc', '0');
          cell.appendChild(cnt);
          heatCells[note] = { cell: cell, count: cnt };
          heatCounts[note] = 0;
        } else {
          cell.appendChild(el('div', 'hn', '—'));
        }
        grid.appendChild(cell);
      }
    }
    container.appendChild(grid);
  }
  function noteAt(nxt, port) {
    for (var note in NOTE_MAP) {
      if (NOTE_MAP[note].nxt === nxt && NOTE_MAP[note].port === port) return note;
    }
    return null;
  }
  function heatStrike(note) {
    if (!heatCells[note]) return;
    heatCounts[note]++;
    var max = 1, k;
    for (k in heatCounts) max = Math.max(max, heatCounts[k]);
    for (k in heatCells) {
      heatCells[k].cell.style.setProperty('--i', (heatCounts[k] / max * 0.85).toFixed(3));
      heatCells[k].count.textContent = heatCounts[k];
    }
    var cell = heatCells[note].cell;
    cell.classList.add('hit');
    setTimeout(function () { cell.classList.remove('hit'); }, 400);
  }

  // ---- 7. Health dashboard ---------------------------------------------
  var health = {
    broker: false, ui: false,
    bridgeTs: 0, bridgePorts: null,
    serverTs: 0, scoreTs: 0
  };
  var healthEl = null;

  function ago(ts) {
    var s = Math.round((Date.now() - ts) / 1000);
    return s < 1 ? 'just now' : s + 's ago';
  }
  function row(name, dotCls, detail, ports) {
    var r = el('div', 'health-row');
    r.appendChild(el('span', 'health-dot ' + dotCls));
    r.appendChild(el('span', 'health-name', name));
    if (ports && ports.length) {
      var pc = el('div', 'health-ports');
      ports.forEach(function (p) {
        pc.appendChild(el('span', 'health-port ' + (p.open ? 'open' : 'closed'),
          (p.name || p.path) + (p.open ? ' ●' : ' ○')));
      });
      r.appendChild(pc);
    } else {
      r.appendChild(el('span', 'health-detail', detail));
    }
    return r;
  }
  function renderHealth() {
    if (!healthEl) return;
    var now = Date.now();
    healthEl.innerHTML = '';

    healthEl.appendChild(row('MQTT Broker', health.broker ? 'up' : 'down',
      health.broker ? 'connected' : 'unreachable'));

    // NXT Bridge — fresh heartbeat shows per-port serial state
    if (!health.bridgeTs) {
      healthEl.appendChild(row('NXT Bridge', 'down', 'no heartbeat'));
    } else if (now - health.bridgeTs > STALE_MS) {
      healthEl.appendChild(row('NXT Bridge', 'stale', 'last seen ' + ago(health.bridgeTs)));
    } else {
      healthEl.appendChild(row('NXT Bridge', 'up', '', health.bridgePorts));
    }

    // Session Logger (server.js)
    if (!health.serverTs) {
      healthEl.appendChild(row('Session Logger', 'down', 'no heartbeat'));
    } else if (now - health.serverTs > STALE_MS) {
      healthEl.appendChild(row('Session Logger', 'stale', 'last seen ' + ago(health.serverTs)));
    } else {
      healthEl.appendChild(row('Session Logger', 'up', 'logging ready'));
    }

    // Note Reader — transient; inferred from recent score pushes
    if (!health.scoreTs) {
      healthEl.appendChild(row('Note Reader', 'down', 'idle'));
    } else if (now - health.scoreTs < SCORE_TTL) {
      healthEl.appendChild(row('Note Reader', 'up', 'score pushed ' + ago(health.scoreTs)));
    } else {
      healthEl.appendChild(row('Note Reader', 'stale', 'idle (last ' + ago(health.scoreTs) + ')'));
    }

    healthEl.appendChild(row('This Browser', health.ui ? 'up' : 'down',
      health.ui ? 'subscribed' : 'offline'));
  }

  // ---- Public API ------------------------------------------------------
  function init() {
    var flowC = document.getElementById('flow');
    var latC  = document.getElementById('latency');
    var heatC = document.getElementById('heatmap');
    healthEl  = document.getElementById('health');
    if (flowC) buildFlow(flowC);
    if (latC)  { buildLatency(latC); renderLatency(); }
    if (heatC) buildHeatmap(heatC);
    renderHealth();
    setInterval(renderHealth, 1000);  // re-evaluate heartbeat freshness
  }

  function handleMessage(topic, payload) {
    switch (topic) {
      case 'robot/score':
        health.scoreTs = Date.now();
        pulseFlow('score');
        break;
      case 'robot/nada':
        pulseFlow('nada');
        break;
      case 'robot/hold':
        try {
          var h = JSON.parse(payload);
          if (h.action === 'press') pulseFlow('nada');
        } catch (e) {}
        break;
      case 'robot/strike':
        pulseFlow('strike');
        heatStrike(payload);
        break;
      case 'robot/latency':
        try { recordLatency(JSON.parse(payload).ms); } catch (e) {}
        break;
      case 'robot/touch':
        pulseFlow('touch');
        break;
      case 'convert/status':
        try {
          var p = JSON.parse(payload);
          processFlow(p.stage, p.state);
        } catch (e) {}
        break;
      case 'health/bridge':
        try {
          var b = JSON.parse(payload);
          health.bridgeTs = b.ts || Date.now();
          health.bridgePorts = b.ports || null;
        } catch (e) {}
        break;
      case 'health/server':
        try {
          health.serverTs = (JSON.parse(payload).ts) || Date.now();
        } catch (e) {}
        break;
    }
  }

  function setConnection(connected) {
    health.broker = !!connected;
    health.ui = !!connected;
    renderHealth();
  }

  return { init: init, handleMessage: handleMessage, setConnection: setConnection };
})();

Monitor.init();
