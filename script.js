var hostname = "localhost";
var port = 8883;
var clientId = "Piano_" + Math.floor(Math.random() * 1000);

var mqttClient = new Paho.MQTT.Client(hostname, port, clientId);

mqttClient.connect({
    onSuccess: function() {
        console.log("Terhubung ke Broker via WebSocket!");
    }
});

// Tekan tuts (motor maju, tahan)
function TekanPress(nada) {
    var topic = "piano/" + nada + "/press";
    var message = new Paho.MQTT.Message(nada);
    message.destinationName = topic;
    mqttClient.send(message);
    console.log("PRESS: " + nada);
}

// Lepas tuts (motor mundur, kembali ke posisi awal)
function TekanRelease(nada) {
    var topic = "piano/" + nada + "/release";
    var message = new Paho.MQTT.Message(nada);
    message.destinationName = topic;
    mqttClient.send(message);
    console.log("RELEASE: " + nada);
}