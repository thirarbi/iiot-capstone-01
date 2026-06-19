const mqtt = require('mqtt');
const fs   = require('fs');
const path = require('path');
const { SerialPort } = require('serialport');

// 1. KONFIGURASI 3 NXT (Update COM Port Julian)
const NXT_DEVICES = [
    { name: 'NXT-1', comPort: 'COM4' }, // DO, RE, MI
    { name: 'NXT-3', comPort: 'COM5' }, // FA, SOL, LA
    { name: 'NXT-4', comPort: 'COM12' }, // SI, DO_TINGGI
];

// Pemetaan nada ke Robot dan Port Motor (0=A, 1=B, 2=C)
const NOTE_MAP = {
    'DO': { nxt: 0, port: 0 }, 'RE': { nxt: 0, port: 1 }, 'MI': { nxt: 0, port: 2 },
    'FA': { nxt: 1, port: 0 }, 'SOL': { nxt: 1, port: 1 }, 'LA': { nxt: 1, port: 2 },
    'SI': { nxt: 2, port: 0 }, 'DO_TINGGI': { nxt: 2, port: 1 }
};

// ─────────────────────────────────────────────────────────────────────────────
// MOTOR TUNING — single source of truth for every motor's behaviour.
// Edit config/motors.json and save; this file is hot-reloaded live (no restart),
// so you can trial-and-error each motor straight from the manual Web UI keys.
// The SAME resolved settings drive both manual presses AND full songs played
// from note-reader/main.py (see docs/motor-tuning.md).
//
// BUILTIN_DEFAULTS are the original hard-coded values — used as-is when
// config/motors.json is missing or a key is left unset, so nothing changes
// until you deliberately override something.
// ─────────────────────────────────────────────────────────────────────────────
const BUILTIN_DEFAULTS = {
    power: 75,         // press speed / "rpm" (0..100) — was PRESS_POWER
    direction: 1,      // +1 normal, -1 flips a motor that's mounted/wired backwards
    pressDegrees: 30,  // MAX PRESS ROTATION — tacho limit the motor spins to press ("max spin") — was PRESS_DEGREES
    // MAX RETURN ROTATION (returnDegrees) is intentionally NOT listed here:
    // when it is left unset it falls back to that motor's effective pressDegrees
    // (see settingsFor), which is exactly the original behaviour. Set it in
    // config/motors.json only when the return should travel a different amount.
    pressSettleMs: 250,// how long the press is guaranteed to keep travelling toward pressDegrees before ANY retract is allowed. The press "wins": until it has reached its rotation the bridge ignores a release/lift so the motor never rolls back from a partial press. Raise if a motor still rolls back; lower for snappier taps.
    holdMs: 200,       // ms held at the press position after it settles, then retract→stop delay — was HOLD_MS
    reversePower: 75,  // retract speed (0..100)
    maxHoldMs: 5000,   // safety: auto-release a held motor after this long
};

const MOTOR_CONFIG_PATH = path.join(__dirname, '..', 'config', 'motors.json');
let motorConfig = { defaults: {}, motors: {} };

function loadMotorConfig() {
    try {
        motorConfig = JSON.parse(fs.readFileSync(MOTOR_CONFIG_PATH, 'utf8'));
        console.log('🎛️  Motor config loaded from config/motors.json');
    } catch (e) {
        console.warn('⚠️  Using built-in motor defaults (config/motors.json:', e.message + ')');
        motorConfig = { defaults: {}, motors: {} };
    }
}
loadMotorConfig();
// Hot-reload on save. watchFile polls, which survives editors that save via
// atomic rename (Windows-friendly) where fs.watch would lose its handle.
try {
    fs.watchFile(MOTOR_CONFIG_PATH, { interval: 800 }, loadMotorConfig);
} catch (e) {
    console.warn('⚠️  Motor config hot-reload unavailable:', e.message);
}

// Effective settings for a note: BUILTIN_DEFAULTS < file defaults < per-motor.
function settingsFor(note) {
    const s = Object.assign(
        {},
        BUILTIN_DEFAULTS,
        motorConfig.defaults || {},
        (motorConfig.motors && motorConfig.motors[note]) || {}
    );
    // Max return rotation mirrors max press rotation unless explicitly overridden,
    // so the return travels back exactly as far as the press went — the original
    // behaviour — until you deliberately tune returnDegrees for a motor.
    if (s.returnDegrees == null) s.returnDegrees = s.pressDegrees;
    return s;
}

function clampPower(p) {
    p = Math.round(Number(p) || 0);
    return Math.max(0, Math.min(100, p));
}
function dirSign(d) { return Number(d) < 0 ? -1 : 1; }

// Signed power bytes for a note, honouring its direction override.
function pressPowerFor(s)   { return  clampPower(s.power)        * dirSign(s.direction); }
function retractPowerFor(s) { return -clampPower(s.reversePower) * dirSign(s.direction); }

// 2. FUNGSI PEMBUAT PAKET (NXT Direct Command)
// wantReply=true → command type 0x00 (DIRECT COMMAND, REPLY REQUIRED): the NXT
// sends back a status telegram once it has received and accepted the command.
// We use that on the press stroke as a real strike confirmation. Default 0x80
// (no reply) keeps the retract/stop strokes quiet.
function makeRunPacket(port, power, degrees, wantReply = false) {
    const powerByte = power < 0 ? (256 + power) : power;
    const cmdType = wantReply ? 0x00 : 0x80;
    // Tacho limit (32-bit little-endian): NXT berhenti otomatis setelah `degrees` derajat
    return Buffer.from([
        0x0C, 0x00, cmdType, 0x04, port, powerByte,
        0x01, 0x00, 0x00, 0x20,
        degrees & 0xFF, (degrees >> 8) & 0xFF, (degrees >> 16) & 0xFF, (degrees >> 24) & 0xFF
    ]);
}

function makeStopPacket(port) {
    return Buffer.from([0x0C, 0x00, 0x80, 0x04, port, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

function safeWrite(sp, packet, label) {
    sp.write(packet, (err) => {
        if (err) console.error(`❌ Serial write error [${label}]:`, err.message);
    });
}

// 3. KONEKSI SERIAL
const serialPorts = NXT_DEVICES.map(dev => {
    const sp = new SerialPort({ path: dev.comPort, baudRate: 9600 });
    sp.on('open', () => console.log(`✅ ${dev.name} Terhubung di ${dev.comPort}`));
    sp.on('error', (err) => console.error(`❌ Serial error [${dev.name}]:`, err.message));
    return sp;
});

// 4. KONEKSI MQTT
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
const BROKER    = process.env.MQTT_BROKER || `mqtt://localhost:${MQTT_PORT}`;
const client = mqtt.connect(BROKER);
client.on('connect', () => {
    console.log('✅ Bridge Aktif - Menunggu Score...');
    client.subscribe('robot/score');  // compiled full-song packet
    client.subscribe('robot/nada');   // manual key tap (discrete click)
    client.subscribe('robot/hold');   // manual press-and-hold (press/release)
    client.subscribe('robot/stop');   // cancel sequence + halt all motors
    startHeartbeat();
});
client.on('error', (err) => console.error('❌ MQTT error:', err.message));

// Health heartbeat — retained so the Web UI's monitor sees current state on
// subscribe. Reports per-NXT serial-port liveness. See docs/visualizations.md.
const HEARTBEAT_MS = 3000;
let heartbeatTimer = null;
function publishHeartbeat() {
    const ports = NXT_DEVICES.map((dev, idx) => ({
        name: dev.name,
        path: dev.comPort,
        open: !!(serialPorts[idx] && serialPorts[idx].isOpen),
    }));
    client.publish('health/bridge', JSON.stringify({ ts: Date.now(), ports }), { retain: true });
}
function startHeartbeat() {
    if (heartbeatTimer) return;
    publishHeartbeat();
    heartbeatTimer = setInterval(publishHeartbeat, HEARTBEAT_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOSED-LOOP STRIKE CONFIRMATION
// The press stroke is sent with "reply required", so the NXT echoes back a
// status telegram when it has received and accepted the command. We treat THAT
// reply as the real strike marker — publishing robot/strike + the measured
// command→ack latency on robot/latency — instead of optimistically assuming the
// motor moved. This is what makes the latency panel and heatmap populate in
// BOTH delivery modes (compiled sends no per-note MQTT command, but every note
// still produces a real NXT reply).
//
// The SETOUTPUTSTATE reply carries no port number, so replies are matched to
// commands FIFO per NXT — the brick replies in the order it received them.
// ─────────────────────────────────────────────────────────────────────────────
const pendingStrikes = serialPorts.map(() => []);  // per-NXT FIFO of { note, port, ts }
const ACK_TIMEOUT_MS = 1200;  // no reply by now → assume lost (or no hardware)

function emitStrike(note, nxtIdx, port, latencyMs, confirmed) {
    client.publish('robot/strike', note);  // plain note — drives highlight/heatmap
    client.publish('robot/latency', JSON.stringify({
        note, nxt: nxtIdx, port, ms: latencyMs, confirmed,
    }));
}

// SETOUTPUTSTATE reply: [0]=0x02 reply, [1]=0x04 cmd echo, [2]=status (0=ok).
function handleMotorAck(frame, nxtIdx) {
    const status  = frame[2];
    const pending = pendingStrikes[nxtIdx].shift();
    if (!pending) return;                         // stray/duplicate reply
    const latency = Date.now() - pending.ts;
    if (status === 0x00) {
        emitStrike(pending.note, nxtIdx, pending.port, latency, true);
        console.log(`✅ ACK ${pending.note} on NXT-${nxtIdx} (${latency} ms)`);
    } else {
        console.warn(`⚠️  NXT-${nxtIdx} rejected ${pending.note} (status 0x${status.toString(16)})`);
    }
}

// If a reply never comes (lost telegram / no brick), don't let pending entries
// pile up and de-sync the FIFO — time them out and still emit the strike
// (flagged unconfirmed) so the UI reflects the attempt.
setInterval(() => {
    const now = Date.now();
    pendingStrikes.forEach((q, nxtIdx) => {
        while (q.length && now - q[0].ts > ACK_TIMEOUT_MS) {
            const p = q.shift();
            emitStrike(p.note, nxtIdx, p.port, now - p.ts, false);
        }
    });
}, 250);

// 5a. PUKULAN TUNGGAL (discrete click) — used by score playback, robot/nada,
// and the physical touch buttons. Press → let it reach its press rotation →
// dwell → retract → stop. Timing/power per-motor via settingsFor().
//
// The press OWNS the motor until it has reached pressDegrees: we never schedule
// the retract until at least pressSettleMs has elapsed, so a press that is slow
// to start still travels all the way out instead of being yanked back from a
// partial position. A re-tap while a press is still in progress is ignored.
function strikeNote(note) {
    const map = NOTE_MAP[note];
    if (!map) return;

    const sp = serialPorts[map.nxt];
    if (!sp || !sp.isOpen) return;

    let st = holdState.get(note);
    if (!st) { st = { held: false, physPressed: false }; holdState.set(note, st); }
    if (st.physPressed) return;   // a press already owns this motor — don't interrupt it

    const s = settingsFor(note);
    console.log(`🎹 Playing: ${note} on ${NXT_DEVICES[map.nxt].name} Motor ${map.port}`);
    st.physPressed = true;
    st.pressTs = Date.now();
    // Press with reply-required → robot/strike fires when the NXT confirms.
    pendingStrikes[map.nxt].push({ note, port: map.port, ts: Date.now() });
    safeWrite(sp, makeRunPacket(map.port, pressPowerFor(s), s.pressDegrees, true), `${note} forward`);

    // Hold the press until it has reached its press rotation (pressSettleMs),
    // dwell for holdMs, THEN retract (retractNote honours returnDegrees and
    // bails out if the note got grabbed-and-held in the meantime).
    const settle = Math.max(0, Number(s.pressSettleMs) || 0);
    clearTimeout(st.retractTimer);
    st.retractTimer = setTimeout(() => retractNote(note), settle + Number(s.holdMs || 0));
}

// 5b. PRESS-AND-HOLD — used by the manual Web UI keys via robot/hold.
// The motor presses ONCE and parks at the press position for as long as the
// key is held; it retracts only on release (or the maxHoldMs safety net).
// While `held`, repeat presses are ignored, so a held key stays put instead of
// oscillating in/out. A minimum press of `holdMs` is still guaranteed so a fast
// tap lands a full strike just like the original click did.
//
// State per note:
//   held       — the user is currently holding the key (intent)
//   physPressed— the motor is currently at/heading to the press position
//   pressTs    — when the current press started (for the min-press guarantee)
const holdState = new Map();

function holdPress(note) {
    const map = NOTE_MAP[note];
    if (!map) return;
    const sp = serialPorts[map.nxt];
    if (!sp || !sp.isOpen) return;

    let st = holdState.get(note);
    if (!st) { st = { held: false, physPressed: false }; holdState.set(note, st); }
    if (st.held) return;            // already held — ignore repeats, stay put

    clearTimeout(st.retractTimer);  // cancel a pending retract — we're holding again
    clearTimeout(st.safetyTimer);
    st.held = true;

    const s = settingsFor(note);
    // Only drive the motor forward if it isn't already at the press position
    // (re-grabbed during a retract delay → no second press packet, no over-rotation).
    if (!st.physPressed) {
        st.physPressed = true;
        st.pressTs = Date.now();
        console.log(`🎹 Hold: ${note} on ${NXT_DEVICES[map.nxt].name} Motor ${map.port}`);
        // Press with reply-required → robot/strike fires when the NXT confirms.
        pendingStrikes[map.nxt].push({ note, port: map.port, ts: Date.now() });
        safeWrite(sp, makeRunPacket(map.port, pressPowerFor(s), s.pressDegrees, true), `${note} press`);
    }

    // Never leave a motor pressed forever if a release event goes missing.
    st.safetyTimer = setTimeout(() => holdRelease(note), Math.max(500, Number(s.maxHoldMs) || 5000));
}

function holdRelease(note) {
    const st = holdState.get(note);
    if (!st || !st.held) return;
    st.held = false;
    clearTimeout(st.safetyTimer);

    const s = settingsFor(note);
    // Don't retract until the press has reached its press rotation. If the key
    // is lifted before pressSettleMs has elapsed, the press "wins": defer the
    // retract until the motor has had time to travel all the way out, so a quick
    // tap still strikes fully and never rolls back from a partial press.
    const elapsed = Date.now() - (st.pressTs || 0);
    const wait = Math.max(0, (Number(s.pressSettleMs) || 0) - elapsed);
    clearTimeout(st.retractTimer);
    st.retractTimer = setTimeout(() => retractNote(note), wait);
}

function retractNote(note) {
    const map = NOTE_MAP[note];
    const st  = holdState.get(note);
    if (!map || !st || st.held) return;   // re-grabbed before retract fired → abort
    st.physPressed = false;

    const sp = serialPorts[map.nxt];
    if (!sp || !sp.isOpen) return;

    const s = settingsFor(note);
    safeWrite(sp, makeRunPacket(map.port, retractPowerFor(s), s.returnDegrees), `${note} release`);
    st.stopTimer = setTimeout(() => safeWrite(sp, makeStopPacket(map.port), `${note} stop`), s.holdMs);
}

// 6. SEQUENCER — schedules all notes locally after a single score delivery
let activeSequencer = [];  // timeout handles; cleared when a new score arrives

function cancelActiveSequence() {
    activeSequencer.forEach(clearTimeout);
    activeSequencer = [];
}

function playScore(scorePacket) {
    cancelActiveSequence();
    const { title, notes } = scorePacket;
    console.log(`🎼 Memulai: "${title}" (${notes.length} nada)`);

    let elapsed = 0;
    notes.forEach(({ note, delay_ms }) => {
        elapsed += delay_ms;
        const handle = setTimeout(() => strikeNote(note), elapsed);
        activeSequencer.push(handle);
    });
}

// Stop everything: cancel a scheduled (compiled) song, drop any held notes,
// and brake every motor. Triggered by robot/stop (the UI Stop button).
function stopAllMotors() {
    cancelActiveSequence();
    pendingStrikes.forEach((q) => { q.length = 0; });  // drop unconfirmed strikes
    holdState.forEach((st) => {
        clearTimeout(st.retractTimer);
        clearTimeout(st.stopTimer);
        clearTimeout(st.safetyTimer);
        st.held = false;
        st.physPressed = false;
    });
    serialPorts.forEach((sp, nxtIdx) => {
        if (!sp || !sp.isOpen) return;
        [0, 1, 2].forEach((port) => safeWrite(sp, makeStopPacket(port), `stopAll NXT-${nxtIdx} p${port}`));
    });
    console.log('⏹️  STOP — sequence cancelled, all motors halted');
}

// 7. ROUTER PESAN
client.on('message', (topic, message) => {
    if (topic === 'robot/score') {
        try {
            const scorePacket = JSON.parse(message.toString());
            playScore(scorePacket);
        } catch (e) {
            console.error('❌ Score packet tidak valid:', e.message);
        }
    } else if (topic === 'robot/nada') {
        // Tombol manual dari Web UI — tetap didukung (discrete click)
        strikeNote(message.toString());
    } else if (topic === 'robot/hold') {
        // Press-and-hold dari Web UI: { note, action: "press" | "release" }
        try {
            const { note, action } = JSON.parse(message.toString());
            if (action === 'press')        holdPress(note);
            else if (action === 'release') holdRelease(note);
        } catch (e) {
            console.error('❌ robot/hold payload tidak valid:', e.message);
        }
    } else if (topic === 'robot/stop') {
        stopAllMotors();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. NXT TOUCH SENSOR INPUT — see docs/nxt-touch-input.md
//
// Touch sensors plug into NXT input ports (0–3 in protocol bytes,
// 1–4 on the brick). The bridge polls each configured sensor and publishes
// rising-edge press events to `robot/touch`.
// ─────────────────────────────────────────────────────────────────────────────

// Which input port on which NXT corresponds to which note.
// `port` here is the protocol byte (0 = input 1, 1 = input 2, ...).
const TOUCH_MAP = [
    { nxt: 0, port: 0, note: 'DO' },
    { nxt: 0, port: 1, note: 'RE' },
    { nxt: 0, port: 2, note: 'MI' },
    { nxt: 1, port: 0, note: 'FA' },
    { nxt: 1, port: 1, note: 'SOL' },
    { nxt: 1, port: 2, note: 'LA' },
    { nxt: 2, port: 0, note: 'SI' },
    { nxt: 2, port: 1, note: 'DO_TINGGI' },
];

const SENSOR_TYPE_SWITCH   = 0x01;
const SENSOR_MODE_BOOLEAN  = 0x20;
const POLL_INTERVAL_MS     = 150;   // per-sensor poll cadence

// SetInputMode (cmd 0x05) — no reply needed.
function makeSetInputModePacket(port, sensorType, sensorMode) {
    return Buffer.from([0x05, 0x00, 0x80, 0x05, port, sensorType, sensorMode]);
}

// GetInputValues (cmd 0x07) — reply REQUIRED (cmdType 0x00).
function makeGetInputValuesPacket(port) {
    return Buffer.from([0x03, 0x00, 0x00, 0x07, port]);
}

// last-known boolean state per `${nxt}:${port}` so we emit only rising edges
const lastTouchState = new Map();

// Per-NXT incoming-byte buffer for frame reassembly
const rxBuffers = serialPorts.map(() => Buffer.alloc(0));

function handleSensorFrame(frame, nxtIdx) {
    // GetInputValues reply payload (16 bytes after length prefix):
    //   [0]=0x02 reply, [1]=0x07 cmd echo, [2]=status, [3]=port,
    //   [4]=valid, [5]=calibrated, [6]=sensorType, [7]=sensorMode,
    //   [8..9]=raw, [10..11]=normalized, [12..13]=scaled, [14..15]=calibrated
    if (frame.length < 16)        return;
    if (frame[0] !== 0x02)        return;  // not a reply telegram
    if (frame[1] !== 0x07)        return;  // not GetInputValues
    if (frame[2] !== 0x00)        return;  // non-zero status
    if (frame[4] !== 0x01)        return;  // reading not valid

    const port    = frame[3];
    const scaled  = frame.readInt16LE(12);
    const pressed = scaled !== 0;

    const key       = `${nxtIdx}:${port}`;
    const wasPressed = lastTouchState.get(key) || false;
    lastTouchState.set(key, pressed);

    if (!pressed || wasPressed) return;  // rising edge only

    const mapping = TOUCH_MAP.find(t => t.nxt === nxtIdx && t.port === port);
    if (!mapping) return;

    const event = { note: mapping.note, nxt: nxtIdx, port, ts: Date.now() };
    
    // Tetap kirim data ke MQTT supaya Web UI menyala saat tombol fisik ditekan
    client.publish('robot/touch', JSON.stringify(event));

    // Tetap munculkan tulisan log di Terminal
    console.log(`👆 Touch: ${mapping.note} (NXT-${nxtIdx} port ${port})`);

    // Tombol fisik sekarang IKUT menggerakkan motor — strike yang sama (press →
    // settle → retract) seperti tombol Web UI, lewat logika press-settle bersama.
    strikeNote(mapping.note);
}

// Route a reassembled reply telegram by its command-echo byte.
//   0x07 → GetInputValues (touch sensor)   0x04 → SETOUTPUTSTATE (motor ack)
function handleFrame(frame, nxtIdx) {
    if (frame.length < 2 || frame[0] !== 0x02) return;
    if (frame[1] === 0x07)      handleSensorFrame(frame, nxtIdx);
    else if (frame[1] === 0x04) handleMotorAck(frame, nxtIdx);
}

function attachSensorReader(sp, nxtIdx) {
    sp.on('data', (chunk) => {
        rxBuffers[nxtIdx] = Buffer.concat([rxBuffers[nxtIdx], chunk]);

        // Drain as many complete frames as possible
        while (rxBuffers[nxtIdx].length >= 2) {
            const payloadLen = rxBuffers[nxtIdx].readUInt16LE(0);
            if (rxBuffers[nxtIdx].length < 2 + payloadLen) break;
            const frame = rxBuffers[nxtIdx].subarray(2, 2 + payloadLen);
            rxBuffers[nxtIdx] = rxBuffers[nxtIdx].subarray(2 + payloadLen);
            handleFrame(frame, nxtIdx);
        }
    });
}

function configureSensor(nxtIdx, port) {
    const sp = serialPorts[nxtIdx];
    if (!sp) return;
    const send = () => safeWrite(
        sp,
        makeSetInputModePacket(port, SENSOR_TYPE_SWITCH, SENSOR_MODE_BOOLEAN),
        `SetInputMode NXT-${nxtIdx} port ${port}`,
    );
    if (sp.isOpen) send();
    else sp.once('open', send);
}

function startTouchPolling() {
    // Attach one reader per NXT
    serialPorts.forEach((sp, idx) => attachSensorReader(sp, idx));

    // Tell each sensor what kind of sensor it is
    TOUCH_MAP.forEach(({ nxt, port }) => configureSensor(nxt, port));

    // Stagger initial polls across the cycle so we don't burst one NXT
    TOUCH_MAP.forEach(({ nxt, port }, idx) => {
        const stagger = Math.floor((POLL_INTERVAL_MS / TOUCH_MAP.length) * idx);
        setTimeout(() => {
            setInterval(() => {
                const sp = serialPorts[nxt];
                if (!sp || !sp.isOpen) return;
                safeWrite(
                    sp,
                    makeGetInputValuesPacket(port),
                    `GetInputValues NXT-${nxt} port ${port}`,
                );
            }, POLL_INTERVAL_MS);
        }, stagger);
    });

    console.log(`👆 Touch polling active (${TOUCH_MAP.length} sensors @ ${POLL_INTERVAL_MS}ms)`);
}

startTouchPolling();