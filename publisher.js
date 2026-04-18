const mqtt = require('mqtt');
const broker_address = 'mqtt://localhost:1883';
const client = mqtt.connect(broker_address);
let data = 0;

client.on('connect', function(){
    console.log("Terkoneksi dan mulai mengirim data ke " + broker_address);
    
    // Mengirim data angka yang bertambah setiap 1 detik (1000 milidetik)
    setInterval(function(){
        data++;
        let message = data.toString();
        let topic = "topik"; 
        
        client.publish(topic, message);
        console.log("Data terkirim: " + message);
    }, 1000); 
});