const mqtt = require('mqtt');
const { SerialPort } = require('serialport');

// Hubungkan 3 Port (Ganti COM sesuai hasil pairing di ZBook kamu)
const nxt1 = new SerialPort({ path: 'COM9', baudRate: 9600 });
const nxt2 = new SerialPort({ path: 'COM10', baudRate: 9600 });
const nxt3 = new SerialPort({ path: 'COM11', baudRate: 9600 });

// Koneksi ke Broker Aedes di port 1883
const client = mqtt.connect('mqtt://172.20.10.2:1883');

const map = {
    'DO': 0x31, 'RE': 0x32, 'MI': 0x33, // NXT 1 (Karakter '1','2','3')
    'FA': 0x34, 'SOL': 0x35, 'LA': 0x36, // NXT 2 (Karakter '4','5','6')
    'SI': 0x37, 'DO_TINGGI': 0x38        // NXT 3 (Karakter '7','8')
};

client.on('connect', () => {
    console.log('✅ Bridge terhubung ke Broker Aedes!');
    client.subscribe('robot/nada');
});

client.on('message', (topic, message) => {
    let msg = message.toString();
    let hexCode = map[msg];
    if (!hexCode) return;

    // Paket Direct Command untuk Mailbox 0
    const pkt = Buffer.from([0x06, 0x00, 0x80, 0x09, 0x00, 0x02, hexCode, 0x00]);

    if (hexCode <= 0x33) nxt1.write(pkt);
    else if (hexCode <= 0x36) nxt2.write(pkt);
    else nxt3.write(pkt);
    
    console.log(`[ROUTE] ${msg} sent to corresponding NXT unit.`);
});