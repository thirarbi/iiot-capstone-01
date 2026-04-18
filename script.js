var hostname = "localhost";
var port = 8883;
var clientId = "Web_" + Math.floor(Math.random() * 1000);

var mqttClient = new Paho.MQTT.Client(hostname, port, clientId);

mqttClient.connect({
    onSuccess: function() {
        console.log("Terhubung ke Broker via WebSocket!");
    }
});

// Kirim nada ke target tertentu: 'nxt1', 'nxt2', ..., atau 'all'
function KirimNada(nada, target) {
    var topic = "robot/" + target + "/nada";
    var message = new Paho.MQTT.Message(nada);
    message.destinationName = topic;
    mqttClient.send(message);
    console.log("Nada '" + nada + "' dikirim ke " + topic);
}