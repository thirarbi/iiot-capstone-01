const mqtt = require('mqtt');
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

const PRESS_POWER = 75;    // How fast the motor turns
const HOLD_MS = 200;       // ms, delay for the motor turn go and back
const PRESS_DEGREES = 30;  // Limit of motor turn

// 2. FUNGSI PEMBUAT PAKET (NXT Direct Command)
function makeRunPacket(port, power, degrees = PRESS_DEGREES) {
    const powerByte = power < 0 ? (256 + power) : power;
    // Tacho limit (32-bit little-endian): NXT berhenti otomatis setelah `degrees` derajat
    return Buffer.from([
        0x0C, 0x00, 0x80, 0x04, port, powerByte,
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
    client.subscribe('robot/nada');   // manual key presses from the UI
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

// 5. FUNGSI PUKULAN TUNGGAL
function strikeNote(note) {
    const map = NOTE_MAP[note];
    if (!map) return;

    const sp = serialPorts[map.nxt];
    if (!sp || !sp.isOpen) return;

    console.log(`🎹 Playing: ${note} on ${NXT_DEVICES[map.nxt].name} Motor ${map.port}`);
    safeWrite(sp, makeRunPacket(map.port, PRESS_POWER), `${note} forward`);
    client.publish('robot/strike', note);

    setTimeout(() => {
        safeWrite(sp, makeRunPacket(map.port, -PRESS_POWER), `${note} reverse`);
        setTimeout(() => {
            safeWrite(sp, makeStopPacket(map.port), `${note} stop`);
        }, HOLD_MS);
    }, HOLD_MS);
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
        // Tombol manual dari Web UI — tetap didukung
        strikeNote(message.toString());
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
    
    // Motor TIDAK lagi aktuasi otomatis dari tombol fisik (dimatikan)
    // strikeNote(mapping.note);
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
            handleSensorFrame(frame, nxtIdx);
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