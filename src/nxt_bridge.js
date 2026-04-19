const mqtt = require('mqtt');
const { SerialPort } = require('serialport');

// 1. KONFIGURASI 3 NXT (Update COM Port Julian)
const NXT_DEVICES = [
    { name: 'NXT-1', comPort: 'COM16' }, // DO, RE, MI
    { name: 'NXT-3', comPort: 'COM13' }, // FA, SOL, LA
    { name: 'NXT-4', comPort: 'COM11' }, // SI, DO_TINGGI
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

// Per-motor busy flag: cegah overlap sequence pukulan pada motor yang sama
const busyMotors = {};

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
    console.log('✅ Bridge Aktif - Menunggu Nada dari Python...');
    client.subscribe('robot/nada');
});
client.on('error', (err) => console.error('❌ MQTT error:', err.message));

// 5. LOGIKA PUKULAN OTOMATIS
client.on('message', (topic, message) => {
    const note = message.toString();
    const map = NOTE_MAP[note];
    if (!map) return;

    const sp = serialPorts[map.nxt];
    if (!sp.isOpen) return;

    const motorKey = `${map.nxt}-${map.port}`;
    if (busyMotors[motorKey]) return; // motor sedang aktif, skip
    busyMotors[motorKey] = true;

    console.log(`🎹 Playing: ${note} on ${NXT_DEVICES[map.nxt].name} Motor ${map.port}`);

    // Gerakan: Maju -> Tunggu -> Mundur -> Stop
    safeWrite(sp, makeRunPacket(map.port, PRESS_POWER), `${note} forward`); // Maju (Pukul)

    // Notify frontend that this note was actually struck
    client.publish('robot/strike', note);

    setTimeout(() => {
        safeWrite(sp, makeRunPacket(map.port, -PRESS_POWER), `${note} reverse`); // Mundur (Angkat)

        setTimeout(() => {
            safeWrite(sp, makeStopPacket(map.port), `${note} stop`); // Stop di posisi awal
            busyMotors[motorKey] = false; // lepas flag, motor siap terima nada berikutnya
        }, HOLD_MS);

    }, HOLD_MS);
});