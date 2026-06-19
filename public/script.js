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
  mqttClient.subscribe('session/status');
  mqttClient.subscribe('health/bridge');   // Industrial Monitor — health dashboard
  mqttClient.subscribe('health/server');
  setStatus(true);
  log('Connected to broker at ' + hostname + ':' + port, 'system');
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
  } else {
    log('Command: ' + payload, 'system');
  }
}

// ============================================================
// Send a note (called by the piano-key buttons)
// ============================================================
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

// ============================================================
// UI Helpers
// ============================================================
function highlightKey(note) {
  var keyEl = document.querySelector('.key[data-note="' + note + '"]');
  if (!keyEl) return;
  keyEl.classList.add('active');
  // Don't auto-remove if the physical keyboard key is currently held down
  var isHeld = Object.keys(heldKeys).some(function (k) {
    return heldKeys[k] && heldKeys[k].el === keyEl;
  });
  if (!isHeld) {
    setTimeout(function () { keyEl.classList.remove('active'); }, 350);
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

// heldKeys stores { el, interval } per active key
var heldKeys = {};

var HOLD_REPEAT_DELAY  = 500; // ms before repeat starts
var HOLD_REPEAT_RATE   = 300; // ms between repeated notes while held

document.addEventListener('keydown', function (e) {
  // Ignore when typing in an input / textarea
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  var key = e.key.toLowerCase();
  var note = KEY_MAP[key];
  if (!note || heldKeys[key]) return; // already handled

  var keyEl = document.querySelector('.key[data-note="' + note + '"]');

  // Visually activate immediately
  if (keyEl) keyEl.classList.add('active');

  // Send first note right away
  sendNote(note);

  // After initial delay, start repeating while held
  var timeout = setTimeout(function () {
    var interval = setInterval(function () {
      sendNote(note);
    }, HOLD_REPEAT_RATE);
    if (heldKeys[key]) heldKeys[key].interval = interval;
  }, HOLD_REPEAT_DELAY);

  heldKeys[key] = { el: keyEl, timeout: timeout, interval: null };
});

document.addEventListener('keyup', function (e) {
  var key = e.key.toLowerCase();
  var held = heldKeys[key];
  if (!held) return;

  clearTimeout(held.timeout);
  if (held.interval) clearInterval(held.interval);
  if (held.el) held.el.classList.remove('active');
  delete heldKeys[key];
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
//   3. Latency histogram        (robot/nada → robot/strike round-trip)
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
  var lat = { pending: {}, counts: [], last: null, min: null, max: null, sum: 0, n: 0 };
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
  function latCommand(note) {
    var q = lat.pending[note] || (lat.pending[note] = []);
    q.push(Date.now());
    if (q.length > 32) q.shift();  // drop stale unmatched commands (e.g. score-only runs)
  }
  function latStrike(note) {
    var q = lat.pending[note];
    if (!q || !q.length) return;   // a strike with no matching command (scheduled score) → no sample
    var dt = Date.now() - q.shift();
    lat.counts[latBucket(dt)]++;
    lat.last = dt;
    lat.min  = lat.min == null ? dt : Math.min(lat.min, dt);
    lat.max  = lat.max == null ? dt : Math.max(lat.max, dt);
    lat.sum += dt; lat.n++;
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
        latCommand(payload);
        break;
      case 'robot/strike':
        pulseFlow('strike');
        latStrike(payload);
        heatStrike(payload);
        break;
      case 'robot/touch':
        pulseFlow('touch');
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
