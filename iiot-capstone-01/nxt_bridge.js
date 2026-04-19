const mqtt = require('mqtt');
const { SerialPort } = require('serialport');

// 1. KONFIGURASI 3 NXT (Update COM Port Julian)
const NXT_DEVICES = [
    { name: 'NXT-1', comPort: 'COM16' }, // DO, RE, MI
    { name: 'NXT-2', comPort: 'COM13' }, // FA, SOL, LA
    { name: 'NXT-3', comPort: 'COM11' }, // SI, DO_TINGGI
];

// Pemetaan nada ke Robot dan Port Motor (0=A, 1=B, 2=C)
const NOTE_MAP = {
    'DO': { nxt: 0, port: 0 }, 'RE': { nxt: 0, port: 1 }, 'MI': { nxt: 0, port: 2 },
    'FA': { nxt: 1, port: 0 }, 'SOL': { nxt: 1, port: 1 }, 'LA': { nxt: 1, port: 2 },
    'SI': { nxt: 2, port: 0 }, 'DO_TINGGI': { nxt: 2, port: 1 }
};

const PRESS_POWER = 80;    // Kekuatan pukul
const HOLD_MS = 200;       // Durasi tuts ditekan (ms)

// 2. FUNGSI PEMBUAT PAKET (NXT Direct Command)
function makeRunPacket(port, power) {
    const powerByte = power < 0 ? (256 + power) : power;
    return Buffer.from([0x0C, 0x00, 0x80, 0x04, port, powerByte, 0x01, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00]);
}

function makeStopPacket(port) {
    return Buffer.from([0x0C, 0x00, 0x80, 0x04, port, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

// 3. KONEKSI SERIAL
const serialPorts = NXT_DEVICES.map(dev => {
    const sp = new SerialPort({ path: dev.comPort, baudRate: 9600 });
    sp.on('open', () => console.log(`✅ ${dev.name} Terhubung di ${dev.comPort}`));
    return sp;
});

// 4. KONEKSI MQTT (IP Lokal Julian)
const client = mqtt.connect('mqtt://10.213.106.37:1883');
client.on('connect', () => {
    console.log('✅ Bridge Aktif - Menunggu Nada dari Python...');
    client.subscribe('robot/nada');
});

// 5. LOGIKA PUKULAN OTOMATIS
client.on('message', (topic, message) => {
    const note = message.toString();
    const map = NOTE_MAP[note];
    if (!map) return;

    const sp = serialPorts[map.nxt];
    if (!sp.isOpen) return;

    console.log(`🎹 Playing: ${note} on ${NXT_DEVICES[map.nxt].name} Motor ${map.port}`);

    // Gerakan: Maju -> Tunggu -> Mundur -> Stop
    sp.write(makeRunPacket(map.port, PRESS_POWER)); // Maju (Pukul)
    
    setTimeout(() => {
        sp.write(makeRunPacket(map.port, -PRESS_POWER)); // Mundur (Angkat)
        
        setTimeout(() => {
            sp.write(makeStopPacket(map.port)); // Stop di posisi awal
        }, HOLD_MS);
        
    }, HOLD_MS);
});