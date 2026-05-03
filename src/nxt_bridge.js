const mqtt = require('mqtt');
const { SerialPort } = require('serialport');

// 1. KONFIGURASI 3 NXT (Update COM Port Julian)
const NXT_DEVICES = [
    { name: 'NXT-1', comPort: 'COM14' }, // DO, RE, MI
    { name: 'NXT-3', comPort: 'COM13' }, // FA, SOL, LA
    { name: 'NXT-4', comPort: 'COM16' }, // SI, DO_TINGGI
];

// Pemetaan nada ke Robot dan Port Motor (0=A, 1=B, 2=C)
const NOTE_MAP = {
    'DO': { nxt: 0, port: 0 }, 'RE': { nxt: 0, port: 1 }, 'MI': { nxt: 0, port: 2 },
    'FA': { nxt: 1, port: 0 }, 'SOL': { nxt: 1, port: 1 }, 'LA': { nxt: 1, port: 2 },
    'SI': { nxt: 2, port: 0 }, 'DO_TINGGI': { nxt: 2, port: 1 }
};

const PRESS_POWER = 80;    // Kekuatan pukul
const HOLD_MS = 200;       // Durasi tuts ditekan (ms)
const PRESS_DEGREES = 45;  // Batas rotasi per pukulan (derajat) — cegah over-rotate

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
const BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const client = mqtt.connect(BROKER);
client.on('connect', () => {
    console.log('✅ Bridge Aktif - Menunggu Score...');
    client.subscribe('robot/score');  // compiled full-song packet
    client.subscribe('robot/nada');   // manual key presses from the UI
});
client.on('error', (err) => console.error('❌ MQTT error:', err.message));

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