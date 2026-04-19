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
var port        = 8883;
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
  var note = message.payloadString;
  if (message.destinationName === topicStrike) {
    log('Motor hit: ' + note, 'received');
    highlightKey(note);
    showNowPlaying(note);
  } else {
    log('Command: ' + note, 'system');
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
  closeBtn.addEventListener('click', function () {
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
