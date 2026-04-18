const mqtt = require('mqtt');
const { SerialPort } = require('serialport');

// 1. KONFIGURASI SEMUA NXT
//    Tambahkan entri baru untuk setiap NXT tambahan.
//    Cek COM port di Device Manager -> Ports (COM & LPT).
const NXT_DEVICES = [
    { name: 'NXT-1', comPort: 'COM9',  topic: 'robot/nxt1/nada' },
    { name: 'NXT-2', comPort: 'COM10', topic: 'robot/nxt2/nada' },
    // { name: 'NXT-3', comPort: 'COM11', topic: 'robot/nxt3/nada' },
];

// Paket Direct Command per nada (Mailbox 0)
const PACKETS = {
    'DO': Buffer.from([0x07, 0x00, 0x80, 0x09, 0x00, 0x03, 0x44, 0x4F, 0x00]),
    'RE': Buffer.from([0x07, 0x00, 0x80, 0x09, 0x00, 0x03, 0x52, 0x45, 0x00]),
    'MI': Buffer.from([0x07, 0x00, 0x80, 0x09, 0x00, 0x03, 0x4D, 0x49, 0x00]),
};

// 2. BUKA KONEKSI SERIAL KE SETIAP NXT
//    Map dari topic -> SerialPort instance
const portMap = new Map();

for (const device of NXT_DEVICES) {
    const port = new SerialPort({ path: device.comPort, baudRate: 9600, autoOpen: false });

    port.open((err) => {
        if (err) {
            console.error(`❌ Gagal membuka ${device.name} (${device.comPort}): ${err.message}`);
        } else {
            console.log(`✅ Terhubung ke ${device.name} (${device.comPort})`);
        }
    });

    port.on('error', (err) => {
        console.error(`❌ Error pada ${device.name}: ${err.message}`);
    });

    portMap.set(device.topic, { device, port });
}

// Kumpulkan semua topik individual + topik siaran ke semua robot
const allTopics = NXT_DEVICES.map(d => d.topic);
allTopics.push('robot/all/nada');

// 3. KONFIGURASI MQTT BROKER
const client = mqtt.connect('mqtt://localhost:1883');

client.on('connect', function () {
    console.log('✅ Bridge terhubung ke Broker MQTT');
    client.subscribe(allTopics, (err) => {
        if (err) console.error('Gagal subscribe:', err.message);
        else console.log('📡 Subscribe ke topik:', allTopics.join(', '));
    });
});

// 4. TERJEMAHKAN PESAN MQTT KE BAHASA MESIN NXT
client.on('message', function (topic, message) {
    const instruksi = message.toString();
    const packet = PACKETS[instruksi];

    if (!packet) {
        console.warn(`⚠️  Instruksi tidak dikenal: ${instruksi}`);
        return;
    }

    if (topic === 'robot/all/nada') {
        // Siaran ke semua NXT yang terhubung
        console.log(`\n--> [ALL] Instruksi: ${instruksi}`);
        for (const { device, port } of portMap.values()) {
            if (port.isOpen) {
                port.write(packet);
                console.log(`    [+] -> ${device.name}`);
            } else {
                console.warn(`    [!] ${device.name} tidak terhubung, dilewati.`);
            }
        }
    } else {
        // Kirim ke NXT spesifik
        const entry = portMap.get(topic);
        if (entry) {
            console.log(`\n--> [${entry.device.name}] Instruksi: ${instruksi}`);
            if (entry.port.isOpen) {
                entry.port.write(packet);
                console.log(`    [+] Berhasil dikirim.`);
            } else {
                console.warn(`    [!] ${entry.device.name} tidak terhubung.`);
            }
        }
    }
});