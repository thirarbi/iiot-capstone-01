const mqtt = require('mqtt');
const broker_address = 'mqtt://localhost:1883';

const client = mqtt.connect(broker_address);

client.on('connect', function () {
  console.log('connected');

  const topic = 'topik_teman';
  const message = 'pesan_dari_laptop_teman';

  client.publish(topic, message, function (err) {
    if (err) {
      console.log('gagal publish:', err.message);
    } else {
      console.log('publish berhasil');
    }

    setTimeout(() => {
      client.end();
    }, 1000);
  });
});