# Compiled Score Single-Push Implementation

## 1. Current System Overview

### Tech Stack

| Layer | Technology | File |
|---|---|---|
| Web UI | HTML + CSS + Paho.js (MQTT over WebSocket) | `public/index.html`, `public/script.js` |
| HTTP Server | Node.js built-in `http` | `src/server.js` |
| MQTT Broker | Aedes (TCP :1883, WebSocket :8883) | `src/broker.js` |
| NXT Bridge | Node.js + `serialport` + `mqtt` | `src/nxt_bridge.js` |
| Note Reader | Python + `music21` + `paho-mqtt` | `note-reader/main.py` |
| NXT Firmware | NXC (legacy mailbox protocol) | `firmware/NXT_Subscriber.nxc` |

### Current Data Flow

```
PDF score
  └─► Audiveris (OCR)
        └─► .mxl file
              └─► music21 (note-reader/main.py)
                    │   for each note:
                    │     time.sleep(inter-note gap)   ← timing lives here
                    │     client.publish("robot/nada", "DO")
                    │
                    ▼
              Aedes MQTT Broker (:1883 / :8883)
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
    src/nxt_bridge.js     public/script.js (browser)
    (subscribes to         (subscribes to
     robot/nada)            robot/nada + robot/strike)
          │
          │  NXT Direct Command over Bluetooth serial
          ▼
    NXT-1 / NXT-2 / NXT-3
          │
          └─► bridge publishes "robot/strike" → UI highlights key
```

### Current Mechanism — Per-Note MQTT Publishing

`note-reader/main.py` iterates over parsed notes in a loop:

```python
for n in notes:
    wait_time = (n.offset - last_offset) * 0.9
    if wait_time > 0:
        time.sleep(wait_time)          # (A) blocking sleep on sender side
    client.publish(MQTT_TOPIC, cmd)    # (B) single note string, e.g. "DO"
    last_offset = n.offset
```

`src/nxt_bridge.js` receives the note and fires the motor via two chained `setTimeout` calls:

```js
safeWrite(sp, makeRunPacket(...));          // press
setTimeout(() => {
    safeWrite(sp, makeRunPacket(..., -power)); // release
    setTimeout(() => {
        safeWrite(sp, makeStopPacket(...));    // stop
    }, HOLD_MS);
}, HOLD_MS);
```

### Problems with the Current Approach

1. **Network-added jitter** — each `client.publish` travels: Python → Aedes → Node.js bridge. Any TCP / WebSocket latency shifts when the motor fires relative to when `time.sleep` ended on the Python side.
2. **Lost messages break timing permanently** — if one MQTT message is dropped, the gap for that note is silently skipped; the sequence cannot recover its beat.
3. **No atomicity** — the full song is spread across dozens of individual messages. There is no way for the receiver to know the song has started, how many notes remain, or to buffer-ahead.
4. **Python process must stay alive for the whole song** — the sender is entangled with execution timing.
5. **Concurrency risk** — the bridge's `busyMotors` flag can cause a note to be skipped entirely if the previous note's `setTimeout` chain hasn't finished when the next MQTT message arrives (which is likely at high BPM).

---

## 2. Proposed Architecture — Compile & Single-Push

The core idea: **the Note Reader compiles the entire song into a single JSON payload (a "score packet") and publishes it once. The bridge owns all timing from that point on.**

```
PDF score
  └─► Audiveris (OCR)
        └─► .mxl file
              └─► music21 (note-reader/main.py)
                    │   compile ALL notes → one JSON array
                    │   client.publish("robot/score", json_payload)   ← single publish
                    │
                    ▼
              Aedes MQTT Broker (:1883 / :8883)
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
    src/nxt_bridge.js     public/script.js (browser)
    receives full score,   subscribes to
    schedules all         robot/strike + robot/score
    setTimeout chains     for UI feedback
    locally
          │
          │  NXT Direct Commands (Bluetooth serial)
          ▼
    NXT-1 / NXT-2 / NXT-3
```

### Score Packet — JSON Schema

```jsonc
// Topic: robot/score
{
  "title": "Balonku Ada Lima",
  "bpm": 120,
  "notes": [
    { "note": "DO",       "delay_ms": 0   },
    { "note": "DO",       "delay_ms": 500 },
    { "note": "RE",       "delay_ms": 500 },
    { "note": "MI",       "delay_ms": 500 },
    { "note": "DO",       "delay_ms": 500 },
    { "note": "MI",       "delay_ms": 750 },
    { "note": "RE",       "delay_ms": 1000 }
  ]
}
```

- `delay_ms` — the wait **before** striking this note (milliseconds from the previous strike).
- The first note always has `delay_ms: 0`.
- All timing is expressed in wall-clock milliseconds so the bridge needs no musical-theory knowledge.

---

## 3. Implementation Changes

### 3.1 `note-reader/main.py` — Compile, Don't Stream

**Replace** the real-time streaming loop with a compile step followed by a single publish.

```python
import json
import os
import glob
import subprocess
import time
import paho.mqtt.client as mqtt
from music21 import converter

AUDIVERIS_PATH = r"C:\Program Files\Audiveris\Audiveris.exe"
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PDF_FOLDER   = os.path.join(PROJECT_ROOT, "scores", "pdf")
MXL_FOLDER   = os.path.join(PROJECT_ROOT, "scores", "mxl")

MQTT_BROKER  = os.environ.get("MQTT_BROKER", "localhost")
MQTT_TOPIC   = "robot/score"          # ← new topic

TEMPO_SCALE  = 0.9                    # same fudge factor as before
QUARTER_MS   = 500                    # milliseconds per quarter note at 120 BPM
                                      # (override from score's MetronomeMark if present)

BASE_MAP = {
    'C': 'DO', 'D': 'RE', 'E': 'MI',
    'F': 'FA', 'G': 'SOL', 'A': 'LA', 'B': 'SI'
}

def get_latest_file(folder, extension):
    files = glob.glob(os.path.join(folder, f"*.{extension}"))
    return max(files, key=os.path.getmtime) if files else None

def process_pdf_to_mxl(pdf_path):
    base_name = os.path.splitext(os.path.basename(pdf_path))[0]
    for ext in ['.omr', '.mxl', '.txt']:
        old_f = os.path.join(MXL_FOLDER, base_name + ext)
        if os.path.exists(old_f):
            os.remove(old_f)
    command = [AUDIVERIS_PATH, "-batch", "-transcribe", "-export",
               "-output", MXL_FOLDER, pdf_path]
    subprocess.run(command, check=True)

def compile_score(mxl_path):
    """Parse MXL and return a list of {note, delay_ms} dicts."""
    score = converter.parse(mxl_path)

    # Try to read tempo from the score itself
    from music21 import tempo as m21tempo
    marks = score.flatten().getElementsByClass(m21tempo.MetronomeMark)
    bpm = marks[0].number if marks else 120.0
    quarter_ms = (60.0 / bpm) * 1000.0

    notes = score.parts[0].flatten().notes
    sequence = []
    last_offset = 0.0

    for n in notes:
        note_obj = n.sortAscending()[-1] if n.isChord else n
        step     = note_obj.pitch.step
        oct_asli = note_obj.pitch.octave

        if step == 'C':
            cmd = 'DO_TINGGI' if oct_asli >= 6 else 'DO'
        else:
            cmd = BASE_MAP.get(step)

        if not cmd:
            last_offset = n.offset
            continue

        gap_quarters = n.offset - last_offset
        delay_ms     = int(gap_quarters * quarter_ms * TEMPO_SCALE)
        sequence.append({"note": cmd, "delay_ms": max(delay_ms, 0)})
        last_offset = n.offset

    return bpm, sequence

def push_score(bpm, sequence, title="Untitled"):
    client = mqtt.Client()
    client.connect(MQTT_BROKER, 1883, 60)

    payload = json.dumps({
        "title": title,
        "bpm":   bpm,
        "notes": sequence
    })

    # qos=1 → broker acknowledges delivery; retain=False
    client.publish(MQTT_TOPIC, payload, qos=1)
    print(f"✅ Score published: {len(sequence)} notes at {bpm} BPM")
    client.disconnect()

if __name__ == "__main__":
    pdf = get_latest_file(PDF_FOLDER, "pdf")
    if pdf:
        process_pdf_to_mxl(pdf)
        time.sleep(2)
        mxl = get_latest_file(MXL_FOLDER, "mxl")
        if mxl:
            title = os.path.splitext(os.path.basename(mxl))[0]
            bpm, sequence = compile_score(mxl)
            push_score(bpm, sequence, title=title)
```

Key differences from the original:
- No `time.sleep` in the compile step — offsets are converted to milliseconds mathematically.
- One `client.publish` call instead of one per note.
- Uses MQTT QoS 1 so the broker acknowledges receipt before the Python process exits.

---

### 3.2 `src/nxt_bridge.js` — Local Sequencer

Subscribe to `robot/score` instead of (or in addition to) `robot/nada`. When the score arrives, schedule every motor command locally using a `setTimeout` chain. Network is only involved for the initial single delivery.

```js
const mqtt = require('mqtt');
const { SerialPort } = require('serialport');

const NXT_DEVICES = [
    { name: 'NXT-1', comPort: 'COM16' },
    { name: 'NXT-3', comPort: 'COM13' },
    { name: 'NXT-4', comPort: 'COM11' },
];

const NOTE_MAP = {
    'DO':       { nxt: 0, port: 0 }, 'RE':  { nxt: 0, port: 1 }, 'MI':  { nxt: 0, port: 2 },
    'FA':       { nxt: 1, port: 0 }, 'SOL': { nxt: 1, port: 1 }, 'LA':  { nxt: 1, port: 2 },
    'SI':       { nxt: 2, port: 0 }, 'DO_TINGGI': { nxt: 2, port: 1 },
};

const PRESS_POWER   = 80;
const HOLD_MS       = 200;
const PRESS_DEGREES = 45;

// ── Packet builders ──────────────────────────────────────────
function makeRunPacket(port, power, degrees = PRESS_DEGREES) {
    const powerByte = power < 0 ? (256 + power) : power;
    return Buffer.from([
        0x0C, 0x00, 0x80, 0x04, port, powerByte,
        0x01, 0x00, 0x00, 0x20,
        degrees & 0xFF, (degrees >> 8) & 0xFF,
        (degrees >> 16) & 0xFF, (degrees >> 24) & 0xFF,
    ]);
}

function makeStopPacket(port) {
    return Buffer.from([0x0C, 0x00, 0x80, 0x04, port, 0x00, 0x02,
                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

function safeWrite(sp, packet, label) {
    sp.write(packet, (err) => {
        if (err) console.error(`❌ Serial write error [${label}]:`, err.message);
    });
}

// ── Serial connections ────────────────────────────────────────
const serialPorts = NXT_DEVICES.map(dev => {
    const sp = new SerialPort({ path: dev.comPort, baudRate: 9600 });
    sp.on('open',  () => console.log(`✅ ${dev.name} connected on ${dev.comPort}`));
    sp.on('error', (err) => console.error(`❌ Serial [${dev.name}]:`, err.message));
    return sp;
});

// ── MQTT ──────────────────────────────────────────────────────
const BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const client = mqtt.connect(BROKER);

client.on('connect', () => {
    console.log('✅ Bridge active — waiting for score...');
    client.subscribe('robot/score');   // compiled score
    client.subscribe('robot/nada');    // keep for manual key presses from the UI
});

// ── Single-note strike (used by manual UI and by the sequencer) ──
function strikeNote(note) {
    const map = NOTE_MAP[note];
    if (!map) return;
    const sp = serialPorts[map.nxt];
    if (!sp || !sp.isOpen) return;

    console.log(`🎹 ${note} → ${NXT_DEVICES[map.nxt].name} motor ${map.port}`);
    safeWrite(sp, makeRunPacket(map.port, PRESS_POWER),  `${note} fwd`);
    client.publish('robot/strike', note);

    setTimeout(() => {
        safeWrite(sp, makeRunPacket(map.port, -PRESS_POWER), `${note} rev`);
        setTimeout(() => {
            safeWrite(sp, makeStopPacket(map.port), `${note} stop`);
        }, HOLD_MS);
    }, HOLD_MS);
}

// ── Score sequencer ───────────────────────────────────────────
let activeSequencer = [];   // holds timeout handles so a new score can cancel the current one

function cancelActiveSequence() {
    activeSequencer.forEach(clearTimeout);
    activeSequencer = [];
}

function playScore(scorePacket) {
    cancelActiveSequence();

    const { title, notes } = scorePacket;
    console.log(`🎼 Starting: "${title}" (${notes.length} notes)`);

    let elapsed = 0;
    notes.forEach(({ note, delay_ms }) => {
        elapsed += delay_ms;
        const handle = setTimeout(() => strikeNote(note), elapsed);
        activeSequencer.push(handle);
    });
}

// ── Message router ────────────────────────────────────────────
client.on('message', (topic, message) => {
    if (topic === 'robot/score') {
        try {
            const scorePacket = JSON.parse(message.toString());
            playScore(scorePacket);
        } catch (e) {
            console.error('❌ Invalid score packet:', e.message);
        }
    } else if (topic === 'robot/nada') {
        // Manual key press from the web UI — still supported
        strikeNote(message.toString());
    }
});
```

Key differences from the original:
- The bridge now **accumulates** all `setTimeout` handles relative to `t=0` (the moment the packet arrives). No per-note MQTT receive latency.
- A running sequence can be cancelled and replaced immediately when a new `robot/score` arrives.
- `robot/nada` still works so manual UI key presses are unaffected.

---

### 3.3 `public/script.js` — UI Feedback for Compiled Score

Add a handler for the new topic so the frontend can display the song title and animate keys as the bridge fires them (the bridge continues publishing `robot/strike`).

```js
// Add robot/score to the subscriptions in onConnected():
mqttClient.subscribe('robot/score');
mqttClient.subscribe(topicStrike);

// Extend onMessageArrived():
function onMessageArrived(message) {
    var note = message.payloadString;
    if (message.destinationName === 'robot/strike') {
        highlightKey(note);
        showNowPlaying(note);
        log('Motor hit: ' + note, 'received');
    } else if (message.destinationName === 'robot/score') {
        try {
            var score = JSON.parse(note);
            log('Score received: "' + score.title + '" — ' + score.notes.length + ' notes', 'system');
        } catch (e) {}
    } else {
        log('Command: ' + note, 'system');
    }
}
```

Optionally add a **"Send Score"** button to the UI that triggers a `robot/score` publish from the browser (for MXL files uploaded directly in-browser, future work).

---

## 4. MQTT Topic Map (Updated)

| Topic | Direction | QoS | Payload | Purpose |
|---|---|---|---|---|
| `robot/score` | Python → Bridge, Browser | 1 | JSON `ScorePacket` | Single compiled song push |
| `robot/nada` | Browser → Bridge | 0 | plain string e.g. `"DO"` | Manual key press |
| `robot/strike` | Bridge → Browser | 0 | plain string e.g. `"DO"` | Motor-fired confirmation for UI |

---

## 5. Timing Model Comparison

### Current (per-note streaming)

```
t=0    Python sleeps 0ms,    publishes "DO"
         → network RTT ~5ms
t=5    Bridge receives, fires motor
t=505  Python sleeps 500ms ends, publishes "RE"
         → network RTT ~8ms  (variable)
t=513  Bridge receives, fires motor   ← 8 ms late relative to ideal
```

### Proposed (single-push local sequencer)

```
t=0    Python publishes entire JSON (one round trip)
         → network RTT ~5ms
t=5    Bridge receives full score, schedules all setTimeout calls
t=5    setTimeout("DO",   0ms) fires immediately   → motor fires at t=5
t=505  setTimeout("RE", 500ms) fires               → motor fires at t=505  ✓
t=1005 setTimeout("MI", 500ms) fires               → motor fires at t=1005 ✓
```

All motor firings after the first are timed by the Node.js event loop on the bridge machine, not by the network. Jitter is reduced from O(network RTT per note) to O(event-loop tick resolution, ~1 ms).

---

## 6. Sequence Diagram

```
note-reader/main.py          Aedes Broker         src/nxt_bridge.js        NXT robots
        |                         |                        |                    |
        |-- compile entire MXL -->|                        |                    |
        |   (no sleep, just math) |                        |                    |
        |                         |                        |                    |
        |-- publish robot/score ->|                        |                    |
        |   (single message, QoS1)|                        |                    |
        |                         |-- deliver score ------>|                    |
        |<-- PUBACK --------------|                        |                    |
        |  (Python can exit now)  |   schedule N timeouts  |                    |
        |                         |                        |-- strike DO ------->|
        |                         |                        |-- publish strike -->|
        |                         |              (500ms)   |-- strike RE ------->|
        |                         |                        |-- publish strike -->|
        |                         |              (500ms)   |-- strike MI ------->|
        |                         |                        |-- publish strike -->|
```

---

## 7. File Change Summary

| File | Change |
|---|---|
| `note-reader/main.py` | Replace streaming loop with `compile_score()` + `push_score()` |
| `src/nxt_bridge.js` | Add `playScore()` sequencer, subscribe to `robot/score` |
| `public/script.js` | Subscribe to `robot/score`, log title in activity log |
| `public/index.html` | (Optional) Add "Send Score" button for browser-initiated playback |
| `src/broker.js` | No change needed |
| `src/server.js` | No change needed |
| `firmware/NXT_Subscriber.nxc` | No change — bridge still uses Direct Commands, not mailbox |

---

## 8. Considerations & Edge Cases

### Large Payloads
A typical 32-bar song at 120 BPM has ~100–200 notes. A JSON score packet is roughly 20–40 KB — well within MQTT's default 256 MB message limit and suitable for a local LAN.

### Song Interruption
Publish a new `robot/score` (or an empty `{"title":"","notes":[]}`) to cancel the current sequence. The bridge calls `cancelActiveSequence()` before starting the new one.

### Manual Key Presses During Playback
The bridge still subscribes to `robot/nada`. Manual presses are handled immediately via `strikeNote()` and do not interfere with the scheduled `setTimeout` chain.

### Python Process Lifetime
With QoS 1, the Python process only needs to stay alive long enough to receive the broker's PUBACK (typically < 100 ms on localhost). After that it can exit cleanly.

### Tempo Accuracy
`setTimeout` in Node.js has ~1 ms resolution under light load. At 120 BPM, a quarter note is 500 ms; 1 ms error is 0.2% — imperceptible. For very fast passages (>200 BPM, < 150 ms gaps) consider grouping simultaneous or near-simultaneous notes to the same `setTimeout` bucket.

### Simultaneous Notes (Chords)
The current `busyMotors` flag is removed in the new bridge because the sequencer schedules each note independently and the `HOLD_MS` window (200 ms) means a motor is free well before the next beat at moderate tempos. If chords are needed, notes with `delay_ms: 0` relative to each other can be fired in the same `setTimeout` callback.
