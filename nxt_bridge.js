const { SerialPort } = require('serialport');
const mqtt = require('mqtt');

// Update IP Broker sesuai ZBook kamu
const client = mqtt.connect('mqtt://10.213.106.37');

// 1. KONFIGURASI 3 NXT (Pastikan COM Port ini sesuai Device Manager)
const NXT_DEVICES = [
    { name: 'NXT-1', comPort: 'COM13', port: null, connected: false }, // DO, RE, MI
    { name: 'NXT-2', comPort: 'COM16', port: null, connected: false }, // FA, SOL, LA
    { name: 'NXT-3', comPort: 'COM11', port: null, connected: false }  // SI, DO_TINGGI
];

// 2. MAPPING NADA KE PERANGKAT
const NOTE_MAP = {
    'DO': { nxt: 0, port: 0 }, 'RE': { nxt: 0, port: 1 }, 'MI': { nxt: 0, port: 2 },
    'FA': { nxt: 1, port: 0 }, 'SOL': { nxt: 1, port: 1 }, 'LA': { nxt: 1, port: 2 },
    'SI': { nxt: 2, port: 0 }, 'DO_TINGGI': { nxt: 2, port: 1 }
};

const PRESS_POWER = 80;

// Hubungkan semua robot
NXT_DEVICES.forEach((device, index) => {
    device.port = new SerialPort({ path: device.comPort, baudRate: 9600 }, (err) => {
        if (err) {
            console.log(`❌ ${device.name} Gagal Konek di ${device.comPort}: ${err.message}`);
        } else {
            device.connected = true;
            console.log(`✅ ${device.name} Terhubung di ${device.comPort}`);
        }
    });
});

// Fungsi pembuat paket perintah motor NXT
function makerRunPacket(port, power) {
    const pByte = power < 0 ? (256 + power) : power;
    return Buffer.from([
        0x0C, 0x00, 0x80, 0x04, port, pByte, 0x01, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00
    ]);
}

// ---------------------------------------------------------
// LOGIKA UTAMA: MENERIMA PLAYLIST & SINKRONISASI
// ---------------------------------------------------------

client.on('connect', () => {
    client.subscribe('robot/playlist');
    console.log("🚀 Bridge Siap! Menunggu 'Playlist' dari Python...");
});

client.on('message', async (topic, message) => {
    if (topic === 'robot/playlist') {
        try {
            const playlist = JSON.parse(message.toString());
            console.log(`🎵 Menerima Lagu: ${playlist.length} nada. Siap-siap...`);
            
            // Beri jeda 1 detik sebelum mulai (biar sistem napas)
            await new Promise(res => setTimeout(res, 1000));
            
            await playConcert(playlist);
        } catch (e) {
            console.log("❌ Error Parsing Playlist JSON!");
        }
    }
});

async function playConcert(playlist) {
    console.log("🎬 --- KONSER DIMULAI ---");

    for (let i = 0; i < playlist.length; i++) {
        const item = playlist[i];
        const target = NOTE_MAP[item.note];

        if (target) {
            const nxt = NXT_DEVICES[target.nxt];

            // 1. SINYAL GO KE ROBOT (FISIK)
            // Kita jalankan duluan karena motor ada delay mekanik
            if (nxt && nxt.connected) {
                nxt.port.write(makerRunPacket(target.port, PRESS_POWER));
                
                // Lepas tuts setelah 200ms
                setTimeout(() => {
                    if (nxt.connected) nxt.port.write(makerRunPacket(target.port, 0));
                }, 200);
            }

            // 2. SINYAL GO KE UI (VIRTUAL)
            // Dikirim hampir bersamaan dengan perintah motor
            client.publish('ui/status', JSON.stringify({
                event: "GO",
                note: item.note,
                index: i,
                duration: item.duration
            }));

            console.log(`🔨 [${i+1}/${playlist.length}] Pukul: ${item.note}`);

            // Tunggu durasi nada sesuai array sebelum lanjut ke nada berikutnya
            await new Promise(resolve => setTimeout(resolve, item.duration));
        }
    }

    console.log("🏁 KONSER SELESAI!");
    client.publish('ui/status', JSON.stringify({ event: "FINISHED" }));
}