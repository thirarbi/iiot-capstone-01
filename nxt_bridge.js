const mqtt = require('mqtt');
const { SerialPort } = require('serialport');

// ============================================================
// 1. KONFIGURASI NXT MODULES
//    NXT-1 mengontrol tuts DO (A), RE (B), MI (C)
//    NXT-2 mengontrol tuts FA (A), SOL (B), LA  (C)
//    Sesuaikan COM port dengan Device Manager kamu
// ============================================================
const NXT_DEVICES = [
    { name: 'NXT-1', comPort: 'COM13'  },
    { name: 'NXT-2', comPort: 'COM14' },
];

// Pemetaan nada piano → indeks NXT (0-based) dan port motor
// Port: 0x00=A, 0x01=B, 0x02=C
const NOTE_MAP = {
    'DO':  { nxt: 0, port: 0x00 },  // NXT-1, Motor A
    'RE':  { nxt: 0, port: 0x01 },  // NXT-1, Motor B
    'MI':  { nxt: 0, port: 0x02 },  // NXT-1, Motor C
    'FA':  { nxt: 1, port: 0x00 },  // NXT-2, Motor A
    'SOL': { nxt: 1, port: 0x01 },  // NXT-2, Motor B
    'LA':  { nxt: 1, port: 0x02 },  // NXT-2, Motor C
};

// Konfigurasi gerakan motor
const PRESS_POWER    = 75;    // Daya motor (0–100)
const MIN_HOLD_MS    = 150;   // Pergerakan maju MINIMUM (ms) — tuts selalu mencapai posisi minimum meski dilepas cepat
const MAX_HOLD_MS    = 800;   // Pergerakan maju MAKSIMUM (ms) — cegah motor melewati batas fisik
const STOP_SETTLE_MS = 60;    // Jeda setelah stop sebelum reverse, agar motor benar-benar berhenti

// Simpan timestamp saat setiap nada ditekan
const pressTimestamps = {};

// ============================================================
// 2. Helpers: NXT Direct Command SET_OUTPUT_STATE
//    Referensi: Appendix 2 - LEGO MINDSTORMS NXT Communication Protocol
// ============================================================

// Jalankan motor terus-menerus (tacho limit = 0 → sampai dihentikan)
function makeRunPacket(port, power) {
    const powerByte = power < 0 ? (256 + power) : power;
    return Buffer.from([
        0x0C, 0x00,    // packet length
        0x80,          // direct command, no response
        0x04,          // SET_OUTPUT_STATE
        port,          // output port: 0=A, 1=B, 2=C
        powerByte,     // power (-100..100)
        0x01,          // mode: MOTORON (tanpa BRAKE agar bebas berputar)
        0x00,          // regulation: IDLE
        0x00,          // turn ratio
        0x20,          // run state: RUNNING
        0x00, 0x00, 0x00, 0x00,  // tacho limit = 0 (jalan terus)
    ]);
}

// Hentikan motor dan tahan posisi (BRAKE)
function makeStopPacket(port) {
    return Buffer.from([
        0x0C, 0x00,
        0x80,
        0x04,
        port,
        0x00,          // power = 0
        0x02,          // mode: BRAKE
        0x00,
        0x00,
        0x00,          // run state: IDLE
        0x00, 0x00, 0x00, 0x00,
    ]);
}

// ============================================================
// 3. BUKA KONEKSI SERIAL KE SETIAP NXT
// ============================================================
const serialPorts = NXT_DEVICES.map((device) => {
    const sp = new SerialPort({ path: device.comPort, baudRate: 9600, autoOpen: false });

    sp.open((err) => {
        if (err) {
            console.error(`❌ Gagal membuka ${device.name} (${device.comPort}): ${err.message}`);
        } else {
            console.log(`✅ Terhubung ke ${device.name} (${device.comPort})`);
        }
    });

    sp.on('error', (err) => {
        console.error(`❌ Error pada ${device.name}: ${err.message}`);
    });

    return sp;
});

// ============================================================
// 4. KONFIGURASI MQTT
//    Setiap nada punya dua topik: piano/NOTE/press dan piano/NOTE/release
// ============================================================
const allTopics = Object.keys(NOTE_MAP).flatMap(note => [
    `piano/${note}/press`,
    `piano/${note}/release`,
]);
const client = mqtt.connect('mqtt://localhost:1883');

client.on('connect', function () {
    console.log('✅ Bridge terhubung ke Broker MQTT');
    client.subscribe(allTopics, (err) => {
        if (!err) console.log('📡 Subscribe ke topik:', allTopics.join(', '));
        else console.error('Gagal subscribe:', err.message);
    });
});

// ============================================================
// 5. TEKAN DAN LEPAS TUTS MOTOR
//    press   → motor berputar bebas maju selama tombol ditahan
//    release → stop motor, lalu mundur selama durasi yang sama (capped MAX_HOLD_MS)
// ============================================================
client.on('message', function (topic, _message) {
    const parts  = topic.split('/');  // ['piano', NOTE, 'press'|'release']
    const note   = parts[1];
    const action = parts[2];

    const mapping = NOTE_MAP[note];
    if (!mapping) return;

    const sp        = serialPorts[mapping.nxt];
    const nxtName   = NXT_DEVICES[mapping.nxt].name;
    const portLabel = ['A', 'B', 'C'][mapping.port];

    if (!sp.isOpen) {
        console.warn(`⚠️  ${nxtName} tidak terhubung — nada ${note} dilewati.`);
        return;
    }

    if (action === 'press') {
        pressTimestamps[note] = Date.now();
        console.log(`🎹 [${nxtName} Motor ${portLabel}] TEKAN: ${note}`);
        // Jalankan motor maju terus-menerus hingga tombol dilepas
        sp.write(makeRunPacket(mapping.port, PRESS_POWER), (err) => {
            if (err) console.error(`❌ Gagal kirim RUN ke ${nxtName}:`, err.message);
        });

    } else if (action === 'release') {
        // Hitung durasi tahan, lalu clamp ke [MIN_HOLD_MS, MAX_HOLD_MS]
        const raw  = Date.now() - (pressTimestamps[note] || 0);
        const held = Math.min(Math.max(raw, MIN_HOLD_MS), MAX_HOLD_MS);
        delete pressTimestamps[note];
        console.log(`🎹 [${nxtName} Motor ${portLabel}] LEPAS: ${note} — raw ${raw}ms → clamp ${held}ms`);

        // Langkah 1: stop motor segera
        sp.write(makeStopPacket(mapping.port), (err) => {
            if (err) { console.error(`❌ Gagal kirim STOP ke ${nxtName}:`, err.message); return; }

            // Langkah 2: tunggu motor benar-benar berhenti, lalu jalankan mundur
            setTimeout(() => {
                sp.write(makeRunPacket(mapping.port, -PRESS_POWER), (err) => {
                    if (err) { console.error(`❌ Gagal kirim REVERSE ke ${nxtName}:`, err.message); return; }

                    // Langkah 3: setelah durasi yang sama, stop motor di posisi asal
                    setTimeout(() => {
                        sp.write(makeStopPacket(mapping.port), (err) => {
                            if (err) console.error(`❌ Gagal kirim STOP AKHIR ke ${nxtName}:`, err.message);
                        });
                    }, held);
                });
            }, STOP_SETTLE_MS);
        });
    }
});